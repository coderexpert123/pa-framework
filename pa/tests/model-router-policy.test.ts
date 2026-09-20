// Policy-table resolution tests (spec WP-B, §0.1.4). Pure function — no
// externals to stub. Rank = table order; z.ai workers demote to the tail
// inside the peak window; no satisfying row = undefined (caller fails open).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFromTable, orderCandidateChain, TIER_ORDER } from '../src/lib/model-router/policy-table.js';
import type { ModelRouterPolicyRow } from '../src/types.js';

describe('model-router policy-table', () => {
  it('TIER_ORDER is monotone over the four-tier taxonomy', () => {
    assert.ok(TIER_ORDER.quick_lookup < TIER_ORDER.standard);
    assert.ok(TIER_ORDER.standard < TIER_ORDER.deep_reasoning);
    assert.ok(TIER_ORDER.deep_reasoning < TIER_ORDER.rich_toolchain);
  });

  it('rank-cheapest satisfying row wins (table order is the rank)', () => {
    const rows: ModelRouterPolicyRow[] = [
      { worker: 'agy', model: 'gemini-3.8-flash-low', max_tier: 'quick_lookup', max_score: 3 },
      { worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 },
    ];
    const got = resolveFromTable({ tier: 'standard', score: 2 }, rows, new Set(['agy', 'codex']), ['zclaude'], false);
    assert.equal(got?.worker, 'codex');
  });

  it('a row whose max_tier is below the need is skipped', () => {
    const rows: ModelRouterPolicyRow[] = [
      { worker: 'agy', max_tier: 'quick_lookup', max_score: 3 },
      { worker: 'codex', max_tier: 'deep_reasoning', max_score: 5 },
    ];
    const got = resolveFromTable({ tier: 'deep_reasoning', score: 4 }, rows, new Set(['agy', 'codex']), ['zclaude'], false);
    assert.equal(got?.worker, 'codex');
  });

  it('a row whose max_score is below the need is skipped', () => {
    const rows: ModelRouterPolicyRow[] = [
      { worker: 'agy', max_tier: 'deep_reasoning', max_score: 2 },
      { worker: 'codex', max_tier: 'deep_reasoning', max_score: 5 },
    ];
    const got = resolveFromTable({ tier: 'standard', score: 3 }, rows, new Set(['agy', 'codex']), ['zclaude'], false);
    assert.equal(got?.worker, 'codex');
  });

  it('unavailable workers are skipped', () => {
    const rows: ModelRouterPolicyRow[] = [
      { worker: 'agy', max_tier: 'rich_toolchain', max_score: 5 },
      { worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 },
    ];
    const got = resolveFromTable({ tier: 'quick_lookup', score: 1 }, rows, new Set(['codex']), ['zclaude'], false);
    assert.equal(got?.worker, 'codex');
  });

  it('no satisfying available row -> undefined (never invents a fallback)', () => {
    const rows: ModelRouterPolicyRow[] = [{ worker: 'agy', max_tier: 'quick_lookup', max_score: 1 }];
    const got = resolveFromTable({ tier: 'deep_reasoning', score: 5 }, rows, new Set(['agy']), ['zclaude'], false);
    assert.equal(got, undefined);
  });

  it('z.ai workers move to LAST rank inside the peak window (stable otherwise)', () => {
    const rows: ModelRouterPolicyRow[] = [
      { worker: 'zclaude', max_tier: 'rich_toolchain', max_score: 5 },
      { worker: 'agy', max_tier: 'rich_toolchain', max_score: 5 },
    ];
    const off = resolveFromTable({ tier: 'standard', score: 2 }, rows, new Set(['zclaude', 'agy']), ['zclaude'], false);
    const peak = resolveFromTable({ tier: 'standard', score: 2 }, rows, new Set(['zclaude', 'agy']), ['zclaude'], true);
    assert.equal(off?.worker, 'zclaude');
    assert.equal(peak?.worker, 'agy');
  });

  it('peak demotion only affects z.ai workers', () => {
    const rows: ModelRouterPolicyRow[] = [
      { worker: 'agy', max_tier: 'rich_toolchain', max_score: 5 },
      { worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 },
    ];
    const peak = resolveFromTable({ tier: 'standard', score: 2 }, rows, new Set(['agy', 'codex']), ['zclaude'], true);
    assert.equal(peak?.worker, 'agy');
  });
});

// Router-as-orchestrator decision 20 (2026-09-19): probability-ordered chain.
describe('orderCandidateChain', () => {
  const rows: ModelRouterPolicyRow[] = [
    { worker: 'agy', max_tier: 'standard', max_score: 3 },
    { worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 },
    { worker: 'claude', max_tier: 'standard', max_score: 5 },
    { worker: 'tiny', max_tier: 'quick_lookup', max_score: 1 },
  ];

  it('orders ALL satisfying rows by probability desc, missing => 0', () => {
    const got = orderCandidateChain({ tier: 'standard', score: 2 }, rows, { claude: 0.4, agy: 0.9 }, ['zclaude'], false);
    // 'tiny' does not satisfy the need; codex missing from probabilities => 0.
    assert.deepEqual(got.map((r) => r.worker), ['agy', 'claude', 'codex']);
  });

  it('rows are NOT filtered by availability (never pre-filtered to one)', () => {
    // The pure function takes no availability input at all — pin the shape:
    // every satisfying row comes back regardless of what is actually up.
    const got = orderCandidateChain({ tier: 'standard', score: 2 }, rows, {}, ['zclaude'], false);
    assert.equal(got.length, 3);
  });

  it('table rank is the tiebreak at equal probability', () => {
    const got = orderCandidateChain({ tier: 'standard', score: 2 }, rows, { codex: 0.5, claude: 0.5, agy: 0.5 }, ['zclaude'], false);
    assert.deepEqual(got.map((r) => r.worker), ['agy', 'codex', 'claude']);
  });

  it('z.ai workers move LAST at peak, stable within the group', () => {
    const zrows: ModelRouterPolicyRow[] = [
      { worker: 'zclaude', max_tier: 'rich_toolchain', max_score: 5 },
      { worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 },
      { worker: 'zclaude2', max_tier: 'rich_toolchain', max_score: 5 },
    ];
    const probs = { zclaude: 0.9, codex: 0.5, zclaude2: 0.8 };
    const off = orderCandidateChain({ tier: 'standard', score: 2 }, zrows, probs, ['zclaude', 'zclaude2'], false);
    assert.deepEqual(off.map((r) => r.worker), ['zclaude', 'zclaude2', 'codex']);
    const peak = orderCandidateChain({ tier: 'standard', score: 2 }, zrows, probs, ['zclaude', 'zclaude2'], true);
    assert.deepEqual(peak.map((r) => r.worker), ['codex', 'zclaude', 'zclaude2']);
  });

  it('resolveFromTable with orderedRows scans THAT order and never re-sorts', () => {
    const ordered: ModelRouterPolicyRow[] = [
      { worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 },
      { worker: 'agy', max_tier: 'standard', max_score: 3 },
    ];
    // agy available, codex not: first AVAILABLE in the given order wins even
    // though agy is rank-1 in the table.
    const got = resolveFromTable({ tier: 'standard', score: 2 }, rows, new Set(['agy']), ['zclaude'], false, ordered);
    assert.equal(got?.worker, 'agy');
    // peak=true must NOT re-group the passed order (grouping already applied).
    const gotPeak = resolveFromTable({ tier: 'standard', score: 2 }, rows, new Set(['codex', 'agy']), ['zclaude'], true, ordered);
    assert.equal(gotPeak?.worker, 'codex');
  });

  it('resolveFromTable with orderedRows: nothing available -> undefined (fail open)', () => {
    const got = resolveFromTable(
      { tier: 'standard', score: 2 },
      rows,
      new Set(['claude']),
      ['zclaude'],
      false,
      [{ worker: 'codex', max_tier: 'rich_toolchain', max_score: 5 }]
    );
    assert.equal(got, undefined);
  });

  it('resolveFromTable without orderedRows keeps today\'s rank-order behavior', () => {
    const got = resolveFromTable({ tier: 'standard', score: 2 }, rows, new Set(['agy', 'codex', 'claude']), ['zclaude'], false);
    assert.equal(got?.worker, 'agy');
  });
});
