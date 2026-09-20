/**
 * router-placement.ts — the placement engine's PURE decision module
 * (router-as-orchestrator WP-5, 2026-09-19, spec §3.2/§3.3; decisions 21/23).
 *
 * `applyRouterPlacement` turns the router's placement answer (choices
 * direct/current/other/new/split2/split3 over the ledger candidate list) into
 * ONE mechanical decision — everything deterministic stays deterministic
 * code: target validation, the deterministic topic name, the split
 * validation/collapse, and the I-2 focus-directive composition. The router's
 * answer carries WHICH targets split; the directive text is never
 * model-authored (I-2: composed from the destination candidate's stored
 * title/goal).
 *
 * `resolveDestinationWorker` is the I-3 routing reuse at the destination: the
 * carried needs/chain resolve deterministically against the DESTINATION
 * incumbent (sticky: incumbent-first when it satisfies the carried need;
 * the carried chain is the fallback order; escapes are capability-UP only,
 * §3.3). No second TypeSafe ask anywhere (decision 26).
 *
 * `derivePlacementTopicName` ports route_task.py's `derive_topic_name` rule
 * verbatim (risk R9 — the rule text is quoted at the function; the test
 * quotes both).
 *
 * Unit-testable headless; main.ts (window B) supplies the I/O around it.
 */
import type { CapabilityTier, EffortScore, ModelRouterPolicyRow } from '../../../pa/dist/src/types.js';
import { resolveFromTable, TIER_ORDER } from '../../../pa/dist/src/lib/model-router/policy-table.js';

/** A ledger candidate as the placement decision consumes it (the bot-side
 *  projection of pa's voiceInboxPlacementCandidates row — routedTo is the
 *  load-bearing field the views handed to the classifier do NOT carry). */
export interface RouterPlacementCandidate {
  conversationId: string;   // vi-<12 hex>
  goal: string;
  status: string;
  inflight: boolean;
  routedTo: string | null;  // '<chatId>_<threadId>' when the newest task routed anywhere
}

/** The placement slice of the router's answer (RouteTurnResult.placement). */
export interface RouterPlacementAnswer {
  choice: 'direct' | 'current' | 'other' | 'new' | 'split2' | 'split3';
  targets: string[];
  focus: Array<{ conversationId: string; directive: string }>;
}

export type RouterPlacementPart =
  | { kind: 'move'; targetTopicKey: string; conversationId: string; directive?: string }
  | { kind: 'create'; name: string; description: string; directive?: string };

export type RouterPlacementDecision =
  | { kind: 'in-place' }
  | RouterPlacementPart
  | { kind: 'split'; parts: RouterPlacementPart[] };

/** A valid destination topic key ('<chatId>_<threadId>', §3.2). */
export const PLACEMENT_TARGET_RE = /^-?\d+_\d+$/;

// ---------------------------------------------------------------------------
// Deterministic topic naming (R9) — route_task.py derive_topic_name, ported
// verbatim. The rule, quoted from the source:
//
//   """Short title-cased noun phrase from the task's transcript/request: the
//   first <=6 meaningful (non-stopword, non-filler, alphanumeric) words, capped
//   at TOPIC_NAME_MAX chars on a word boundary. Empty or garbage input (nothing
//   left after stopword/filler/punctuation filtering) falls back to
//   'New work <UTC date>'."""
//
// Constants mirror the source: TOPIC_NAME_MAX = 40, TOPIC_NAME_SOURCE_MAX =
// 220 (scan window), TOPIC_NAME_WORD_TARGET = 6. NO LLM naming — authored
// names stay with the worker (out of scope per the spec).
// ---------------------------------------------------------------------------

const TOPIC_NAME_MAX = 40;
const TOPIC_NAME_SOURCE_MAX = 220;
const TOPIC_NAME_WORD_TARGET = 6;

const NAME_STOPWORDS = new Set((
  'a an the and or but if then else for of to in on at by with from about into over under after before ' +
  'is are was were be been being am do does did done doing have has had having i we you he she it they ' +
  'them me my mine our ours your yours their theirs his her hers its this that these those there here ' +
  'can could will would shall should may might must please let us so as no not now just also very ' +
  'really some any what when where which who whom whose why how um uh hmm er ah oh okay ok yeah yes ' +
  'hey hi thanks thank want need know try make get give tell show help'
).split(' '));

/** Characters the source strips from word ENDS only (word.strip("...")). */
const NAME_WORD_TRIM_RE = /^[.,!?;:'"()[\]{}…\-—`*]+|[.,!?;:'"()[\]{}…\-—`*]+$/g;

export function derivePlacementTopicName(text: string, now: Date = new Date()): string {
  const utcDate = now.toISOString().slice(0, 10);
  const words = (text || '').slice(0, TOPIC_NAME_SOURCE_MAX).replace(/\s+/g, ' ').trim().split(' ');
  const picked: string[] = [];
  for (const word of words) {
    const cleaned = word.replace(NAME_WORD_TRIM_RE, '');
    if (!cleaned || NAME_STOPWORDS.has(cleaned.toLowerCase())) continue;
    if (!/[A-Za-z0-9]/.test(cleaned)) continue;
    picked.push(cleaned);
    if (picked.length >= TOPIC_NAME_WORD_TARGET) break;
  }
  if (picked.length === 0) return `New work ${utcDate}`;
  let name = picked.map((w) => w.slice(0, 1).toUpperCase() + w.slice(1)).join(' ');
  while (name.length > TOPIC_NAME_MAX && name.includes(' ')) {
    name = name.slice(0, name.lastIndexOf(' '));
  }
  if (name.length === 0) return `New work ${utcDate}`;
  return name.slice(0, TOPIC_NAME_MAX);
}

// ---------------------------------------------------------------------------
// applyRouterPlacement (§3.2)
// ---------------------------------------------------------------------------

export interface ApplyRouterPlacementOpts {
  /** The WHOLE origin message — a `new`/create part derives its name from it. */
  userText: string;
  /** The origin topic's name — feeds the deterministic create description. */
  originTopicName: string;
  /** Test seam — defaults to derivePlacementTopicName. */
  deriveName?: (text: string) => string;
}

const placementDescription = (originTopicName: string): string =>
  `New conversation from ${originTopicName}`;

/** Resolve one candidate-id target into a move part. Undefined = invalid:
 *  unknown candidate, null/invalid routedTo, or a self-move (the target IS
 *  the origin — a no-op stays in place). */
function resolveMovePart(
  targetId: string,
  originTopicKey: string,
  candidates: RouterPlacementCandidate[],
  focus: RouterPlacementAnswer['focus'],
): { kind: 'move'; targetTopicKey: string; conversationId: string; directive?: string } | undefined {
  const candidate = candidates.find((c) => c.conversationId === targetId);
  if (!candidate) return undefined;
  if (!candidate.routedTo || !PLACEMENT_TARGET_RE.test(candidate.routedTo)) return undefined;
  if (candidate.routedTo === originTopicKey) return undefined;
  const directive = focus.find((f) => f.conversationId === targetId)?.directive;
  return {
    kind: 'move',
    targetTopicKey: candidate.routedTo,
    conversationId: candidate.conversationId,
    ...(directive !== undefined ? { directive } : {}),
  };
}

/**
 * The pure placement decision (§3.2):
 * - direct/current → in-place: dispatch exactly as today.
 * - other → the target candidate's routedTo; invalid/null → in-place (the
 *   pa-side shadow reason `invalid-target` already recorded the degrade).
 * - new → deterministic name + deterministic description, no LLM.
 * - split2/split3 → 2-3 validated DISTINCT parts (dedupe by target: a move
 *   part by destination key, create parts by being derived from the same
 *   text); below 2 distinct → degrade to that single part; zero valid →
 *   in-place.
 */
export function applyRouterPlacement(
  routed: { placement?: RouterPlacementAnswer },
  originTopicKey: string,
  candidates: RouterPlacementCandidate[],
  opts: ApplyRouterPlacementOpts,
): RouterPlacementDecision {
  const placement = routed.placement;
  if (!placement) return { kind: 'in-place' };
  const derive = opts.deriveName ?? derivePlacementTopicName;

  if (placement.choice === 'direct' || placement.choice === 'current') {
    return { kind: 'in-place' };
  }
  if (placement.choice === 'other') {
    return resolveMovePart(placement.targets[0] ?? '', originTopicKey, candidates, placement.focus)
      ?? { kind: 'in-place' };
  }
  if (placement.choice === 'new') {
    return {
      kind: 'create',
      name: derive(opts.userText),
      description: placementDescription(opts.originTopicName),
    };
  }

  // split2/split3 — validated, deduped, order-stable.
  const seen = new Set<string>();
  const parts: RouterPlacementPart[] = [];
  for (const target of placement.targets) {
    let part: RouterPlacementPart | undefined;
    if (target === 'new') {
      // Multiple create targets derive the SAME name from the same text —
      // the dedupe key collapses them to one created topic.
      part = {
        kind: 'create',
        name: derive(opts.userText),
        description: placementDescription(opts.originTopicName),
      };
    } else {
      part = resolveMovePart(target, originTopicKey, candidates, placement.focus);
    }
    if (!part) continue;
    const key = part.kind === 'create' ? 'new' : `move:${part.targetTopicKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  if (parts.length === 0) return { kind: 'in-place' };
  if (parts.length === 1) return parts[0];
  return { kind: 'split', parts };
}

// ---------------------------------------------------------------------------
// Destination resolve (§3.2/§3.3, I-3) — the carried payload's deterministic
// sticky resolve against the DESTINATION incumbent.
// ---------------------------------------------------------------------------

/** What a placed turn carries to its destination. `tier`/`score` are the
 *  ORIGIN ask's needs (TurnRoutingResult carries them through since the
 *  2026-09-20 integrator seam); they are OPTIONAL because a FAIL-OPEN origin
 *  turn classifies nothing: absent needs skip the capability-UP filter (§3.3)
 *  and the destination's shadow reason carries '+no-carried-needs' so the
 *  flip review can count them. */
export interface PlacementCarry {
  tier?: CapabilityTier;
  score?: EffortScore;
  /** The origin's availability-filtered chain (chosen.worker first). */
  chain?: string[];
  /** Router-metadata wave (2026-09-20, §1.2): the ORIGIN's placement facts for
   *  the destination leg's PA_ROUTING_PLACEMENT/PA_ROUTING_TARGET stamp — which
   *  kind of placement move this turn is, and the origin's ledger conversation
   *  id (ids only; a plain Telegram origin carries none). Resolved at injection
   *  time (main.ts, reverse lookup over the placement candidates); old carries
   *  load fine (additive, absent = the destination stamps nothing). */
  originRouting?: { kind: 'move' | 'create' | 'split'; originConversationId?: string };
}

export interface ResolveDestinationWorkerOpts {
  table: ModelRouterPolicyRow[];
  /** The destination's incumbent worker (context reader). */
  incumbent?: string;
  /** Availability snapshot over incumbent + chain workers. */
  available: ReadonlySet<string>;
}

/**
 * Deterministic sticky resolve (§3.2/§3.3): incumbent FIRST when it satisfies
 * the carried need (capability-UP only — never a downward keep) and is
 * available; the carried chain is the fallback order. Scans that order for
 * the first available row (resolveFromTable's orderedRows mode — never
 * re-sorted). Undefined = nothing available → the caller fails open.
 */
export function resolveDestinationWorker(
  carry: PlacementCarry,
  opts: ResolveDestinationWorkerOpts,
): ModelRouterPolicyRow | undefined {
  const { table, incumbent, available } = opts;
  if (table.length === 0) return undefined;
  const hasNeeds = carry.tier !== undefined && carry.score !== undefined;
  const satisfies = (row: ModelRouterPolicyRow): boolean =>
    !hasNeeds || (TIER_ORDER[row.max_tier] >= TIER_ORDER[carry.tier!] && row.max_score >= carry.score!);
  const rowsFor = (worker: string): ModelRouterPolicyRow | undefined =>
    table.find((r) => r.worker === worker && satisfies(r));
  const ordered: ModelRouterPolicyRow[] = [];
  const seen = new Set<string>();
  const push = (worker: string | undefined): void => {
    if (!worker || seen.has(worker)) return;
    const row = rowsFor(worker);
    if (row) {
      seen.add(worker);
      ordered.push(row);
    }
  };
  push(incumbent);
  for (const worker of carry.chain ?? []) push(worker);
  // The orderedRows branch reads ONLY the order + availability — the needs
  // placeholder is never consulted there.
  return resolveFromTable(
    { tier: carry.tier ?? 'quick_lookup', score: carry.score ?? 1 },
    table,
    available instanceof Set ? available : new Set(available),
    [],
    false,
    ordered,
  );
}

/**
 * PlaceOnce guard (§3.2): a placement branch may act ONLY on a real operator
 * turn — a `__synthetic` update (button press, requeue, route, system resume,
 * and a placed turn itself) is never re-placed.
 */
export function canPlaceUpdate(update: unknown): boolean {
  return Boolean(update) && (update as { __synthetic?: unknown }).__synthetic === undefined;
}
