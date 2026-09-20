/**
 * Router tier/Score eval (2026-09-18) — extends the typesafe eval harness to
 * score the model-router's NEW needs taxonomy (capability tier + effort Score)
 * over the labelled turns in ~/.pa/typesafe-eval/judge-labels.jsonl. The 86%
 * number belongs to the OLD code/general judge; this eval gives the router its
 * OWN number.
 *
 * The operator-labelled set has code/general/unclear labels, NOT tier labels,
 * so tier ground truth is DERIVED deterministically (provenance 'DERIVED',
 * never operator truth): a 'code' turn is tier=standard unless its text
 * matches the needs-classifier's own deep-reasoning criteria wording.
 * `pa typesafe eval --tier` is the only caller.
 *
 * Metrics (intent decision 17 gates, measured offline — the shadow JSONL is a
 * separate ≥3-day measurement):
 *  (a) agreement proxy: classifier tier vs derived tier on 'code' turns;
 *  (b) label noise: same-input flip rate on a 20-row duplicated subset;
 *  (c) ask success rate (fail-open rate is its complement);
 *  (d) p50 ask latency.
 * Plus classifier stability across 3 asks per turn (majority / any-disagreement)
 * and a policy-table sanity pass: with availability stubbed ALL-available the
 * rank-cheapest resolution must be deterministic and z.ai workers must resolve
 * LAST inside a peak-window stub (never chosen when a non-z.ai candidate exists).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paHome } from '../../paths.js';
import { askSystemOne, isTypeSafeConfigured } from '../typesafe-client.js';
import type { AskOptions, TypeSafeRequest, TypeSafeResult } from '../typesafe-client.js';
import { classifyNeeds, TIER_VALUES } from './needs-classifier.js';
import { resolveFromTable } from './policy-table.js';
import type { CapabilityTier, EffortScore, ModelRouterPolicyRow } from '../../types.js';

export const TIER_EVAL_DUP_SUBSET = 20;
export const TIER_EVAL_ASKS_PER_TURN = 3;
export const TIER_EVAL_PURPOSE = 'router-eval';

/** Deterministic deep-reasoning markers, taken from needs-classifier.ts's own
 *  deep_reasoning criteria text: 'architecture, trade-offs, debugging across
 *  files'. Bare 'debug' alone over-fires (a debug-log-line request is ordinary
 *  single-step work), so the debugging marker keeps the criterion's own
 *  'across files' qualifier. Derived labels only — never operator truth. */
export const DEEP_REASONING_MARKER_RE =
  /architect|trade-?offs?|debugging across|debug .*across|across files|multi-step|design (judg|decision)/i;

export interface TierEvalInputRow {
  id: string;
  label: string;
  source?: string;
  text: string;
}

export function deriveTierLabel(label: string, text: string): CapabilityTier | null {
  if (label !== 'code') return null; // general/unclear have NO tier ground truth
  return DEEP_REASONING_MARKER_RE.test(text) ? 'deep_reasoning' : 'standard';
}

/**
 * Eval stub table (NOT the live config): rank order = row order; a row that
 * only satisfies up to `standard`/score 3 forces deep/high needs to fall
 * through to later rows, exercising the fall-through path.
 */
export const TIER_EVAL_STUB_TABLE: ModelRouterPolicyRow[] = [
  { worker: 'agy', max_tier: 'standard', max_score: 3 },
  { worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 },
  { worker: 'zclaude', max_tier: 'standard', max_score: 3 },
  { worker: 'claude', max_tier: 'deep_reasoning', max_score: 5 },
  { worker: 'devin', max_tier: 'rich_toolchain', max_score: 5 },
];

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length) - (p === 100 ? 1 : 0)));
  return sorted[idx];
}

export interface TierEvalMetrics {
  turns: number;
  asks: number;
  askSuccesses: number;
  latenciesMs: number[];
  stabilityAll3Same: number;
  stabilityAnyDisagree: number;
  flipSubset: number;
  flips: number;
  codeTurns: number;
  codeAgreement: number;
  tierDistribution: Record<string, number>;
}

export interface TierEvalRowOut {
  id: string;
  label: string;
  source?: string;
  derivedTier: CapabilityTier | null;
  provenance: 'DERIVED' | 'OPERATOR';
  asks: Array<{ tier?: string; score?: number; confidence?: number; ok: boolean }>;
  majorityTier?: string;
  majorityScore?: number;
  stubWorker: string;
}

export interface TierEvalOptions {
  labelsPath?: string;
  labelsOutPath?: string;
  resultOutPath?: string;
  limit?: number;
  dryRun: boolean;
}

export interface TierEvalDeps {
  print: (line: string) => void;
  configuredFn?: () => boolean;
  askFn?: typeof askSystemOne;
  nowFn?: () => number;
}

export function readTierEvalInputs(labelsPath: string, limit?: number): TierEvalInputRow[] {
  const rows: TierEvalInputRow[] = [];
  for (const line of readFileSync(labelsPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      const text = typeof rec.text === 'string' ? rec.text.trim() : '';
      const id = typeof rec.id === 'string' ? rec.id : '';
      const label = typeof rec.label === 'string' ? rec.label : '';
      if (text === '' || id === '') continue;
      rows.push({ id, label, source: typeof rec.source === 'string' ? rec.source : undefined, text });
    } catch {
      /* skip malformed line */
    }
  }
  return limit !== undefined ? rows.slice(0, limit) : rows;
}

function majorityOf(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

export function writeResultReport(print: (line: string) => void, m: TierEvalMetrics, outPath: string): void {
  const agreementPct = m.codeTurns === 0 ? 0 : Math.round((100 * m.codeAgreement) / m.codeTurns);
  const flipPct = m.flipSubset === 0 ? 0 : Math.round((100 * m.flips) / m.flipSubset);
  const successPct = m.asks === 0 ? 0 : Math.round((100 * m.askSuccesses) / m.asks);
  const lat = [...m.latenciesMs].sort((a, b) => a - b);
  const p50 = percentile(lat, 50);
  const p95 = percentile(lat, 95);
  const failOpenPct = m.asks === 0 ? 0 : Math.round((100 * (m.asks - m.askSuccesses)) / m.asks);
  const lines = [
    '# Router tier/Score eval',
    '',
    `Data: ${m.turns} labelled turns, ${m.asks} asks (${TIER_EVAL_ASKS_PER_TURN} per turn + ${m.flipSubset} duplicate subset).`,
    '',
    '## Gate numbers (decision 17, offline proxy)',
    '',
    `- (a) agreement proxy (classifier tier vs DERIVED tier on ${m.codeTurns} 'code' turns): **${agreementPct}%** (${m.codeAgreement}/${m.codeTurns})`,
    `- (b) label noise — same-input flip rate on ${m.flipSubset}-row duplicated subset: **${flipPct}%** (${m.flips}/${m.flipSubset})`,
    `- (c) ask success rate: **${successPct}%** (fail-open rate ${failOpenPct}% of ${m.asks} asks)`,
    `- (d) ask latency p50: **${p50} ms** (p95 ${p95} ms)`,
    '',
    '## Classifier stability (3 asks per turn)',
    '',
    `- all 3 asks same tier: ${m.stabilityAll3Same}/${m.turns}; any-disagreement rate: ${m.stabilityAnyDisagree}/${m.turns}`,
    `- tier distribution (majority tier over all turns): ${JSON.stringify(m.tierDistribution)}`,
    '',
    '## Caveats',
    '',
    'The tier ground truth here is DERIVED deterministically from the old code/general labels (provenance DERIVED, never operator truth): a code turn is standard unless its text matches the needs-classifier deep-reasoning criteria wording, and general/unclear turns carry no tier label at all — the agreement proxy therefore covers only code turns and is an upper bound on true agreement. The 20-row duplicate subset measures the SAME nondeterminism of the TypeSafe endpoint, not operator labelling noise, so ~3% expected noise is a floor. Policy-table sanity ran with availability stubbed ALL-available and the eval stub table (rank = row order), not the live config table, so the tier-to-model distribution is shape-exercising, not a deployment forecast.',
  ];
  mkdirSync(dirname(outPath), { recursive: true });
  appendFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  for (const l of lines) print(l);
}

/** Returns the process exit code: 0 done, 1 cannot run, 2 usage. */
export async function runTierEval(opts: TierEvalOptions, deps: TierEvalDeps): Promise<number> {
  const print = deps.print;
  const labelsPath = opts.labelsPath ?? join(paHome(), 'typesafe-eval', 'judge-labels.jsonl');
  if (!existsSync(labelsPath)) {
    print(`typesafe eval --tier: no labels file at ${labelsPath}`);
    return 1;
  }
  const rows = readTierEvalInputs(labelsPath, opts.limit);
  if (rows.length === 0) {
    print('typesafe eval --tier: no usable labelled rows (need id + text)');
    return 1;
  }
  const stamp = new Date((deps.nowFn ?? Date.now)()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const labelsOutPath = opts.labelsOutPath ?? join(paHome(), 'typesafe-eval', 'router-tier-labels.jsonl');
  const resultOutPath = opts.resultOutPath ?? join(paHome(), 'typesafe-eval', `router-tier-eval-${stamp}.md`);
  if (opts.dryRun) {
    const derived = rows.filter((r) => deriveTierLabel(r.label, r.text) !== null).length;
    print(`typesafe eval --tier: dry-run, no requests sent; rows=${rows.length} derived-tier=${derived} would_write=${labelsOutPath}`);
    return 0;
  }
  if (!(deps.configuredFn ?? (() => isTypeSafeConfigured()))()) {
    print('typesafe eval --tier: not configured (TYPESAFE_API_KEY unset or circuit breaker open); nothing was sent');
    return 1;
  }

  const askFn = deps.askFn ?? askSystemOne;
  const metrics: TierEvalMetrics = {
    turns: rows.length,
    asks: 0,
    askSuccesses: 0,
    latenciesMs: [],
    stabilityAll3Same: 0,
    stabilityAnyDisagree: 0,
    flipSubset: 0,
    flips: 0,
    codeTurns: 0,
    codeAgreement: 0,
    tierDistribution: {},
  };
  mkdirSync(dirname(labelsOutPath), { recursive: true });

  const askOnce = async (text: string): Promise<{ ok: boolean; tier?: CapabilityTier; score?: EffortScore; confidence?: number }> => {
    const profile = await classifyNeeds({
      text,
      contextDigest: '',
      topic: {},
      caps: { state_max_chars: 4000 },
      ask: (req: TypeSafeRequest, o: AskOptions) =>
        askFn(req, { ...o, purpose: TIER_EVAL_PURPOSE }).then((r: TypeSafeResult) => {
          metrics.asks += 1;
          if (r.ok) {
            metrics.askSuccesses += 1;
            metrics.latenciesMs.push(r.latencyMs);
          }
          return r;
        }),
    });
    return profile === undefined
      ? { ok: false }
      : { ok: true, tier: profile.tier, score: profile.score, confidence: profile.confidence };
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const derivedTier = deriveTierLabel(row.label, row.text);
    const provenance: 'DERIVED' | 'OPERATOR' = derivedTier === null ? 'OPERATOR' : 'DERIVED';
    const asks: TierEvalRowOut['asks'] = [];
    for (let k = 0; k < TIER_EVAL_ASKS_PER_TURN; k++) {
      const r = await askOnce(row.text);
      asks.push(r.ok ? { tier: r.tier, score: r.score, confidence: r.confidence, ok: true } : { ok: false });
    }
    // Duplicate-subset flip check: one extra same-input ask for the first N rows.
    if (i < TIER_EVAL_DUP_SUBSET) {
      metrics.flipSubset += 1;
      const dup = await askOnce(row.text);
      const primary = asks[0];
      if (dup.ok && primary.ok && dup.tier !== primary.tier) metrics.flips += 1;
      asks.push(dup.ok ? { tier: dup.tier, score: dup.score, confidence: dup.confidence, ok: true } : { ok: false });
    }
    const tierVals = asks.slice(0, TIER_EVAL_ASKS_PER_TURN).map((a) => a.tier);
    const scoreVals = asks.slice(0, TIER_EVAL_ASKS_PER_TURN).map((a) => a.score as number | undefined);
    const majorityTier = majorityOf(tierVals);
    const majorityScore = majorityOf(scoreVals.map((s) => (s === undefined ? undefined : String(s))));
    const defined = tierVals.filter((t) => t !== undefined) as string[];
    if (defined.length === 3 && defined.every((t) => t === defined[0])) metrics.stabilityAll3Same += 1;
    if (defined.length > 0 && defined.length < 3) metrics.stabilityAnyDisagree += 1;
    if (defined.length === 3) metrics.stabilityAnyDisagree += defined.some((t) => t !== defined[0]) ? 1 : 0;
    if (majorityTier !== undefined) {
      metrics.tierDistribution[majorityTier] = (metrics.tierDistribution[majorityTier] ?? 0) + 1;
    }
    if (derivedTier !== null) {
      metrics.codeTurns += 1;
      if (majorityTier === derivedTier) metrics.codeAgreement += 1;
    }
    // Policy-table sanity per turn: ALL-available stub, deterministic resolve,
    // z.ai-peak-last (a z.ai worker may be chosen only when no non-z.ai candidate exists).
    const allAvailable = new Set(TIER_EVAL_STUB_TABLE.map((r) => r.worker));
    const needs =
      majorityTier !== undefined && majorityScore !== undefined
        ? { tier: majorityTier as CapabilityTier, score: Number(majorityScore) as EffortScore }
        : undefined;
    let stubWorker = '';
    if (needs !== undefined && TIER_VALUES.includes(needs.tier) && needs.score >= 1 && needs.score <= 5) {
      const a = resolveFromTable(needs, TIER_EVAL_STUB_TABLE, allAvailable, ['zclaude'], false);
      const b = resolveFromTable(needs, TIER_EVAL_STUB_TABLE, allAvailable, ['zclaude'], false);
      if (a !== b) print(`typesafe eval --tier: NON-DETERMINISTIC resolve for ${row.id}`);
      const peak = resolveFromTable(needs, TIER_EVAL_STUB_TABLE, allAvailable, ['zclaude'], true);
      if (peak !== undefined && peak.worker === 'zclaude' && a !== undefined && a.worker !== 'zclaude') {
        print(`typesafe eval --tier: PEAK-LAST VIOLATION for ${row.id}`);
      }
      stubWorker = a?.worker ?? '';
    }
    const out: TierEvalRowOut = {
      id: row.id,
      label: row.label,
      source: row.source,
      derivedTier,
      provenance,
      asks,
      majorityTier,
      majorityScore: majorityScore !== undefined ? Number(majorityScore) : undefined,
      stubWorker,
    };
    appendFileSync(labelsOutPath, `${JSON.stringify(out)}\n`, 'utf8');
  }
  writeResultReport(print, metrics, resultOutPath);
  print(`typesafe eval --tier: wrote ${labelsOutPath} and ${resultOutPath}`);
  return 0;
}
