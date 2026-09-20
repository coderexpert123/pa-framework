// Policy-table resolution (spec §0.1.4, decision 15). Pure and deterministic:
// the table IS the rank — "cheapest" means earliest rank, never a price
// number. Metadata is a validate/warn input only.

import type { CapabilityTier, EffortScore, ModelRouterPolicyRow } from '../../types.js';

export const TIER_ORDER: Record<CapabilityTier, number> = {
  quick_lookup: 0,
  standard: 1,
  deep_reasoning: 2,
  rich_toolchain: 3,
};

/**
 * Deterministic reduce over the config table (rank = row order). Candidates =
 * rows satisfying the need (row.max_tier >= need tier, row.max_score >= need
 * score) AND available. z.ai workers move to the END of the candidate order
 * when inside the peak window (stable within their group). Returns undefined
 * when NO satisfying row is available — the caller fails open.
 *
 * `orderedRows` (2026-09-19 router-as-orchestrator decision 20): when present,
 * scan THAT order and return the first row whose worker is in `available` —
 * the peak grouping has already been applied by `orderCandidateChain`, so the
 * parameter is never re-sorted. Absent → exactly the rank-order behavior
 * above (the tier eval and sticky path keep calling it that way).
 */
export function resolveFromTable(
  needs: { tier: CapabilityTier; score: EffortScore },
  rows: ModelRouterPolicyRow[],
  available: Set<string>,
  zaiWorkers: string[],
  peak: boolean,
  orderedRows?: ModelRouterPolicyRow[],
): ModelRouterPolicyRow | undefined {
  if (orderedRows) {
    for (const row of orderedRows) {
      if (available.has(row.worker)) return row;
    }
    return undefined;
  }
  const zai = new Set(zaiWorkers);
  let zaiTail: ModelRouterPolicyRow[] = [];
  let head: ModelRouterPolicyRow[] = [];
  for (const row of rows) {
    if (TIER_ORDER[needs.tier] > TIER_ORDER[row.max_tier]) continue;
    if (needs.score > row.max_score) continue;
    if (!available.has(row.worker)) continue;
    if (peak && zai.has(row.worker)) zaiTail.push(row);
    else head.push(row);
  }
  const ordered = head.concat(zaiTail);
  return ordered.length ? ordered[0] : undefined;
}

/**
 * Decision 20: order ALL need-satisfying rows by the ask's per-worker
 * probabilities (desc), table rank as tiebreak, then z.ai-peak-last grouping
 * (stable within group) when `peak`. Rows are NOT filtered by availability
 * here — the chain is never pre-filtered to one (intent risk note).
 * Missing worker in `probabilities` => probability 0.
 */
export function orderCandidateChain(
  needs: { tier: CapabilityTier; score: EffortScore },
  rows: ModelRouterPolicyRow[],
  probabilities: Record<string, number>,
  zaiWorkers: string[],
  peak: boolean,
): ModelRouterPolicyRow[] {
  const satisfying: Array<{ row: ModelRouterPolicyRow; rank: number }> = [];
  for (let rank = 0; rank < rows.length; rank++) {
    const row = rows[rank];
    if (TIER_ORDER[needs.tier] > TIER_ORDER[row.max_tier]) continue;
    if (needs.score > row.max_score) continue;
    satisfying.push({ row, rank });
  }
  const byP = satisfying.sort((a, b) => {
    const pa = probabilities[a.row.worker] ?? 0;
    const pb = probabilities[b.row.worker] ?? 0;
    if (pb !== pa) return pb - pa;
    return a.rank - b.rank;
  });
  if (!peak) return byP.map((e) => e.row);
  const zai = new Set(zaiWorkers);
  return byP
    .filter((e) => !zai.has(e.row.worker))
    .concat(byP.filter((e) => zai.has(e.row.worker)))
    .map((e) => e.row);
}
