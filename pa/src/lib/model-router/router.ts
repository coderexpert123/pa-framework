// Router orchestration (spec 0.1.7 + stickiness, intent decision 19). Fail-open
// on ANY error: the whole body is wrapped; one warn on entry to the fail path;
// returns the baseline-safe 'fail-open' outcome. Shadow runs whenever the
// config block exists (spec 0.7) - `enabled` only gates the DECISION. Every
// early return ALSO writes its shadow line with the fail-open reason, so the
// would-have-been data accrues even on turns the router could not classify or
// resolve.

import { join } from 'node:path';
import type { CapabilityTier, EffortScore, ModelRouterConfig, ModelRouterPolicyRow } from '../../types.js';
import type { TypeSafeRequest, TypeSafeResult, AskOptions } from '../typesafe-client.js';
import { paHome } from '../../paths.js';
import { readTurnContext } from './context-reader.js';
import type { ContextStore } from './context-reader.js';
import { classifyNeeds } from './needs-classifier.js';
import type { ClassifiedTurn, ClassifiedTurnPlacement, InflightRunView, NeedsProfile, PlacementCandidateView } from './needs-classifier.js';
import { resolveFromTable, orderCandidateChain, TIER_ORDER } from './policy-table.js';
import { projectEffort } from './effort-projection.js';
import { appendShadowRecord } from './shadow.js';
import type { ShadowRecord } from './shadow.js';
import { getCachedAvailability } from './availability.js';
import { validateTable } from './metadata.js';
import { isPeakWindow, resolvePeakWindowUtc } from '../peak-window.js';
import type { CostTierConfig } from '../../types.js';

export interface RouteTurnInput {
  topicKey: string;
  store: ContextStore;
  threadId: string;
  conversationKey: string;
  text: string;
  textSource: 'ledger-request' | 'turn-text';
  topic?: { name?: string; description?: string };
  pinPresent: boolean;
  baselineWorker: string;
  config: ModelRouterConfig;
  costTier?: CostTierConfig;
  workerNames: string[];
  /** Placement candidate views (§3.1) — computed by the caller (bot main).
   *  When present, the ask gains the placement+target questions. */
  candidates?: PlacementCandidateView[];
  /** In-flight run views (§4.1) — when non-empty, the ask gains steer_wait. */
  currentInflight?: InflightRunView[];
  now: Date;
  readContext?: typeof readTurnContext;
  ask?: (req: TypeSafeRequest, opts: AskOptions) => Promise<TypeSafeResult>;
  /** Test/legacy seam; when absent the TTL-cached availability (§7) serves. */
  availability?: (worker: string) => Promise<boolean>;
  nowPeak?: (now: Date) => boolean;
}

export interface RouteTurnResult {
  tier?: CapabilityTier;
  score?: EffortScore;
  confidence?: number;
  chosen?: { worker: string; model?: string; effort?: string; outcome?: string };
  /** Decision 20: probability-ordered, availability-filtered at resolve time
   *  (sticky keep reorders to incumbent-first, never drops the rest). */
  chain?: Array<{ worker: string; p?: number }>;
  /** Decisions 22/23. `focus` is filled only for split targets that map to
   *  an existing candidate; `directive` is the deterministic I-2 composition. */
  placement?: { choice: 'direct' | 'current' | 'other' | 'new' | 'split2' | 'split3'; targets: string[]; focus: Array<{ conversationId: string; directive: string }> };
  /** Decision 24. */
  steerWait?: { inflight: boolean; decision?: 'steer' | 'wait' };
  outcome: 'routed' | 'fail-open';
  reason: string;
}

// Availability default (spec §7, decision 27): the TTL-cached reader — fleet
// member AND NOT manual_only auto-ineligible AND NOT cooling down, evaluated
// from ONE config parse + ONE cooldown snapshot per refresh window. Fault
// semantics unchanged (decision 2): a read fault records the worker
// unavailable, never guessed-available. runWithFailover's per-attempt checks
// stay uncached (correctness — the stale-probability guard).

function capStr(v: string | undefined, max: number): string {
  if (!v) return '';
  return v.length > max ? v.slice(0, max) : v;
}

// Table-vs-metadata validation warns ONCE per process (spec 0.1.8): the
// router runs per-turn, so the warn cannot ride the call path unguarded.
let tableWarned = false;

export async function routeTurn(input: RouteTurnInput): Promise<RouteTurnResult> {
  try {
    // 0. Policy-table sanity warns, first routed turn only; never throws.
    if (!tableWarned) {
      tableWarned = true;
      try {
        for (const issue of validateTable(input.config.table ?? [])) console.warn(issue);
      } catch {
        // validation is advisory — never blocks a routing decision
      }
    }

    // Shadow path is resolved once and shared by every return below —
    // each early return writes its own line with the fail-open reason.
    const shadowPath = input.config.shadow_path ?? join(paHome(), 'model-router-shadow.jsonl');
    const writeShadow = (
      reason: string,
      needs?: NeedsProfile,
      stickBreakReason?: ShadowRecord['stickBreakReason'],
      extras?: Pick<ShadowRecord, 'chain' | 'placement' | 'steerWait'>,
    ): void => {
      try {
        appendShadowRecord(shadowPath, {
          at: input.now.toISOString(),
          topicKey: input.topicKey,
          store: input.store,
          textSource: input.textSource,
          tier: needs?.tier,
          score: needs?.score,
          confidence: needs?.confidence,
          chosen: undefined,
          baseline: { worker: input.baselineWorker },
          pinPresent: input.pinPresent,
          disagreement: false,
          sticky: false, // fail-open records always resolve fresh — no keep
          stickBreakReason,
          ...extras,
          reason,
        });
      } catch {
        // never throws — a shadow hiccup must never break the fail-open path
      }
    };

    // 1. No table -> fail-open.
    if (!input.config.table || input.config.table.length === 0) {
      writeShadow('no-table');
      return { outcome: 'fail-open', reason: 'no-table' };
    }

    // §9.2 shadow additions builder — ids/enums/counts only, never turn text
    // or candidate content. `placement` rides only on a classified placement
    // answer; `steerWait.inflight` records that an in-flight view was offered
    // even when the ask failed open (the would-have-been data accrues).
    const hadInflight = (input.currentInflight?.length ?? 0) > 0;
    const shadowExtras = (
      classified?: ClassifiedTurn,
      chain?: Array<{ worker: string; p?: number }>,
    ): Pick<ShadowRecord, 'chain' | 'placement' | 'steerWait'> => {
      const extras: Pick<ShadowRecord, 'chain' | 'placement' | 'steerWait'> = {};
      const p = classified?.placement;
      if (p) {
        extras.placement = {
          choice: p.choice,
          targets: p.targets,
          candidates: input.candidates?.length,
          ...(p.truncated ? { truncated: true } : {}),
        };
      }
      if (hadInflight) {
        extras.steerWait = { inflight: true, ...(classified?.steerWait ? { decision: classified.steerWait } : {}) };
      }
      if (chain) extras.chain = chain;
      return extras;
    };

    // 2. Context digest (fail-open to empty; NEVER blocks). The same context
    // read also yields the incumbent worker (the `worker` field on the newest
    // archive turn for this thread) for conversation stickiness — undefined
    // on the voice-inbox store and on any read failure.
    let digest = '';
    let incumbentWorker: string | undefined;
    try {
      const reader = input.readContext ?? readTurnContext;
      const key = input.store === 'telegram' ? input.threadId : input.conversationKey;
      const ctx = reader(input.store, key, { context_max_chars: input.config.context_max_chars ?? 2000 });
      if (ctx && ctx.priorTurns.length) {
        digest = ctx.priorTurns.map((t) => capStr(t.text, 400)).join('\n');
      }
      incumbentWorker = ctx?.incumbentWorker;
    } catch {
      digest = '';
      incumbentWorker = undefined;
    }

    // 3. Classify — ONE ask (decision 26): tier+score plus the new
    // placement/target/steer_wait/chain questions in the SAME request when
    // their inputs are present. chainWorkers = the distinct table workers in
    // config order.
    const chainWorkers = Array.from(new Set(input.config.table.map((r) => r.worker)));
    const needs: ClassifiedTurn | undefined = await classifyNeeds({
      text: input.text,
      contextDigest: digest,
      topic: input.topic ?? {},
      caps: {
        state_max_chars: input.config.state_max_chars ?? 4000,
        topic_max_chars: input.config.topic_max_chars ?? 300,
      },
      candidates: input.candidates,
      currentInflight: input.currentInflight,
      chainWorkers,
      placement: {
        goal_chars: input.config.placement?.goal_chars,
        section_chars: input.config.placement?.section_chars,
      },
      ask: input.ask,
    });
    if (!needs) {
      writeShadow('classify-failed', undefined, undefined, shadowExtras(undefined));
      return { outcome: 'fail-open', reason: 'classify-failed' };
    }

    // 4. Availability for each DISTINCT worker in table rows — the TTL cache
    // serves unless the caller injected the test/legacy seam (§7).
    const distinct = Array.from(new Set(input.config.table.map((r) => r.worker)));
    const av = new Set<string>();
    for (const w of distinct) {
      if (input.availability) {
        if (await input.availability(w)) av.add(w);
      } else if (await getCachedAvailability(w, input.workerNames)) {
        av.add(w);
      }
    }

    // 5. Conversation stickiness (intent decision 19, `sticky` knob default
    // ON): while a thread's incumbent worker exists and stays inside its
    // capability envelope, KEEP it — a resumed worker session keeps its
    // prompt-cache prefix. Escapes are capability-UP only; there is no
    // downward path. Break order: unsatisfiable → unavailable → peak-zai-last.
    const zai = new Set(input.config.zai_workers ?? ['zclaude']);
    const peak = input.nowPeak
      ? input.nowPeak(input.now)
      : isPeakWindow(input.now, resolvePeakWindowUtc(input.costTier?.peak_window_utc));
    const satisfies = (row: ModelRouterPolicyRow): boolean =>
      TIER_ORDER[row.max_tier] >= TIER_ORDER[needs.tier] && row.max_score >= needs.score;

    let sticky = false;
    let stickBreakReason: ShadowRecord['stickBreakReason'];
    let chosenRow: ModelRouterPolicyRow | undefined;
    const stickyOn = input.config.sticky !== false;
    if (stickyOn && incumbentWorker !== undefined) {
      const incumbentRows = input.config.table.filter((row) => row.worker === incumbentWorker && satisfies(row));
      if (incumbentRows.length === 0) {
        stickBreakReason = 'unsatisfiable';
      } else if (!av.has(incumbentWorker)) {
        stickBreakReason = 'unavailable';
      } else if (
        peak &&
        zai.has(incumbentWorker) &&
        input.config.table.some((row) => row.worker !== incumbentWorker && !zai.has(row.worker) && satisfies(row))
      ) {
        // Peak-window z.ai-last (decision 10) outranks continuity. The escape
        // records even when the alternative cannot serve — normal resolve
        // then picks the incumbent again anyway; the break reason marks that
        // the keep was rejected by peak policy, not by the envelope.
        stickBreakReason = 'peak-zai-last';
      } else {
        // STICK: earliest satisfying incumbent row re-picks the model inside
        // that worker; effort still re-projects per turn below.
        sticky = true;
        chosenRow = incumbentRows[0];
      }
    }

    // 6. Table resolve on escape (or when sticky is off / no incumbent).
    // Decision 20: the chain is ordered by the ask's probabilities (satisfies
    // need → probability → rank tiebreak → z.ai-last at peak, grouped by
    // orderCandidateChain) and resolve scans THAT order for the first
    // AVAILABLE row — the chain is never pre-filtered to one.
    const orderedRows = orderCandidateChain(
      needs,
      input.config.table,
      needs.chainP ?? {},
      input.config.zai_workers ?? ['zclaude'],
      peak,
    );
    let chain: Array<{ worker: string; p?: number }> = orderedRows
      .filter((row) => av.has(row.worker))
      .map((row) => {
        const p = needs.chainP?.[row.worker];
        return p !== undefined ? { worker: row.worker, p } : { worker: row.worker };
      });
    if (sticky && incumbentWorker !== undefined) {
      // A sticky keep REORDERS the chain to put the incumbent first, never
      // drops the rest (§2.1).
      const first = chain.filter((e) => e.worker === incumbentWorker);
      const rest = chain.filter((e) => e.worker !== incumbentWorker);
      chain = [...first, ...rest];
    }
    if (!sticky) {
      chosenRow = resolveFromTable(needs, input.config.table, av, input.config.zai_workers ?? ['zclaude'], peak, orderedRows);
      if (!chosenRow) {
        writeShadow('nothing-available', needs, stickBreakReason, shadowExtras(needs, chain));
        return { outcome: 'fail-open', reason: 'nothing-available' };
      }
    }

    // 7. Effort projection.
    const proj = projectEffort(needs.score, chosenRow!.worker, input.config.effort_projection);
    const chosen = {
      worker: chosenRow!.worker,
      model: chosenRow!.model,
      effort: proj.applied ? proj.value : undefined,
      outcome: proj.applied ? 'applied' : proj.outcome,
    };
    const baseReason = sticky ? 'sticky-keep' : 'table-rank';
    // Placement degrade markers (§1.1 + adjudication 2026-09-19), mutually
    // exclusive by construction: '+invalid-target' = a target answer failed
    // VALIDATION; '+absent-placement' = the placement CHOICE was
    // absent/garbage — a COMPLETENESS failure decision 17(c) exists to make
    // countable in the flip review. The shadow reason keeps the resolve
    // outcome AND the degrade class.
    const degrade =
      needs.placement?.absentChoice ? '+absent-placement'
      : needs.placement?.invalidTarget ? '+invalid-target'
      : '';
    const reason = `${baseReason}${degrade}`;

    // Placement result (decisions 22/23). `focus` is filled only for split
    // targets that map to an existing candidate; the directive is the
    // deterministic I-2 composition (title — the model never authors goals).
    const placement = needs.placement
      ? {
          choice: needs.placement.choice,
          targets: needs.placement.targets,
          focus:
            needs.placement.choice === 'split2' || needs.placement.choice === 'split3'
              ? needs.placement.targets
                  .map((t) => input.candidates?.find((c) => c.id === t))
                  .filter((c): c is PlacementCandidateView => !!c)
                  .map((c) => ({
                    conversationId: c.id,
                    directive: `Focus on the part belonging to "${c.goal}". The whole message is delivered for context.`,
                  }))
              : [],
        }
      : undefined;
    const steerWait = hadInflight
      ? { inflight: true, ...(needs.steerWait ? { decision: needs.steerWait } : {}) }
      : undefined;

    // 8. Shadow record (block present -> always; enabled only gates the decision).
    appendShadowRecord(shadowPath, {
      at: input.now.toISOString(),
      topicKey: input.topicKey,
      store: input.store,
      textSource: input.textSource,
      tier: needs.tier,
      score: needs.score,
      confidence: needs.confidence,
      chosen,
      baseline: { worker: input.baselineWorker },
      pinPresent: input.pinPresent,
      disagreement: chosen.worker !== input.baselineWorker && !input.pinPresent,
      sticky,
      stickBreakReason,
      ...shadowExtras(needs, chain),
      reason,
    });

    // 9. Return.
    return {
      tier: needs.tier,
      score: needs.score,
      confidence: needs.confidence,
      chosen,
      chain,
      ...(placement ? { placement } : {}),
      ...(steerWait ? { steerWait } : {}),
      outcome: 'routed',
      reason,
    };
  } catch (err) {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('model-router: routeTurn failed open: ' + msg);
    } catch {
      // never throws
    }
    // Even the catch path records its fail-open line (best-effort; the
    // inner writer swallows its own failures so this can never re-throw).
    try {
      appendShadowRecord(input.config.shadow_path ?? join(paHome(), 'model-router-shadow.jsonl'), {
        at: input.now.toISOString(),
        topicKey: input.topicKey,
        store: input.store,
        textSource: input.textSource,
        chosen: undefined,
        baseline: { worker: input.baselineWorker },
        pinPresent: input.pinPresent,
        disagreement: false,
        sticky: false,
        reason: 'error',
      });
    } catch {
      // never throws
    }
    return { outcome: 'fail-open', reason: 'error' };
  }
}
