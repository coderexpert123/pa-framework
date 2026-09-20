// Tier-eval unit tests (node:test, PA_HOME temp dir, every external call
// stubbed). The eval's live run is a separate operator-driven step; here the
// real consumer (runTierEval) drives REAL producer output (classifyNeeds over
// fixture label rows) through a stubbed ask seam.

import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import type { TypeSafeRequest, TypeSafeResult } from '../src/lib/typesafe-client.js';
import { TIER_EVAL_STUB_TABLE, deriveTierLabel, percentile, runTierEval } from '../src/lib/model-router/tier-eval.js';
import { resolveFromTable } from '../src/lib/model-router/policy-table.js';
import { TIER_ORDER } from '../src/lib/model-router/policy-table.js';
import type { CapabilityTier, EffortScore } from '../src/types.js';

const PA_TEST_ROOT = mkdtempSync(join(tmpdir(), 'tier-eval-test-'));
process.env.PA_HOME = PA_TEST_ROOT;
after(() => {
  try {
    rmSync(PA_TEST_ROOT, { recursive: true, force: true });
  } catch {
    /* temp cleanup best-effort */
  }
});

const LABELS = [
  { id: 't1', label: 'code', text: 'Fix the login button alignment in the settings page.' },
  { id: 't2', label: 'code', text: 'We need to rethink the architecture of the scheduler across files, trade-offs matter.' },
  { id: 't3', label: 'general', text: 'What is the capital of France?' },
  { id: 't4', label: 'unclear', text: 'ok thanks' },
  { id: 't5', label: 'code', text: 'Add a debug log line in worker-exec.ts.' },
];

function writeLabels(): string {
  const p = join(PA_TEST_ROOT, 'labels.jsonl');
  const lines = LABELS.map((r) => JSON.stringify({ id: r.id, label: r.label, text: r.text, source: 'history' }));
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

// Deterministic classifier: tier from text markers, score follows tier.
const STUB_PROFILE: Record<string, { tier: CapabilityTier; score: EffortScore }> = {
  t1: { tier: 'standard', score: 3 },
  t2: { tier: 'deep_reasoning', score: 4 },
  t3: { tier: 'quick_lookup', score: 1 },
  t4: { tier: 'quick_lookup', score: 1 },
  t5: { tier: 'standard', score: 2 },
};

async function stubAsk(req: TypeSafeRequest): Promise<TypeSafeResult> {
  const text = String((req.state as { text?: string } | null)?.text ?? '');
  const match = LABELS.find((l) => text.startsWith(l.text.slice(0, 20))) ?? LABELS[0];
  const prof = STUB_PROFILE[match.id];
  return {
    ok: true,
    answers: {
      tier: { type: 'choice', choice: prof.tier, probabilities: {}, confidence: 0.9 },
      score: { type: 'choice', choice: String(prof.score), probabilities: {}, confidence: 0.8 },
    },
    usage: { inputTokens: 100, outputTokens: 10 },
    latencyMs: 42,
    status: 200,
    retries: 0,
  };
}

test('deriveTierLabel: code turns derive standard/deep_reasoning; others null', () => {
  assert.strictEqual(deriveTierLabel('code', 'Add a debug log line.'), 'standard');
  assert.strictEqual(deriveTierLabel('code', 'Rethink the architecture, trade-offs across files.'), 'deep_reasoning');
  assert.strictEqual(deriveTierLabel('general', 'anything'), null);
  assert.strictEqual(deriveTierLabel('unclear', 'ok'), null);
});

test('stub table falls through low-rank rows to higher capability', () => {
  const all = new Set(TIER_EVAL_STUB_TABLE.map((r) => r.worker));
  // quick_lookup score<=3 -> agy (rank 1)
  assert.strictEqual(resolveFromTable({ tier: 'quick_lookup', score: 1 }, TIER_EVAL_STUB_TABLE, all, ['zclaude'], false)?.worker, 'agy');
  // deep_reasoning score 4 falls past agy (standard/score3) to codex
  assert.strictEqual(resolveFromTable({ tier: 'deep_reasoning', score: 4 }, TIER_EVAL_STUB_TABLE, all, ['zclaude'], false)?.worker, 'codex');
  // z.ai-peak-last: a z.ai worker is chosen only when no non-z.ai candidate exists
  for (const tier of ['quick_lookup', 'standard', 'deep_reasoning', 'rich_toolchain'] as CapabilityTier[]) {
    for (let s = 1; s <= 5; s++) {
      const peakPick = resolveFromTable({ tier, score: s as EffortScore }, TIER_EVAL_STUB_TABLE, all, ['zclaude'], true);
      const nonPeak = resolveFromTable({ tier, score: s as EffortScore }, TIER_EVAL_STUB_TABLE, all, ['zclaude'], false);
      assert.ok(nonPeak !== undefined);
      if (peakPick === undefined) continue;
      if (peakPick.worker === 'zclaude') {
        assert.strictEqual(nonPeak?.worker, 'zclaude', `peak chose z.ai but non-peak had a non-z.ai option for ${tier}/${s}`);
      }
    }
  }
  assert.ok(TIER_ORDER['standard'] === 1);
});

test('runTierEval: real classifyNeeds over stubbed ask; labels + summary written', async () => {
  const labelsPath = writeLabels();
  const labelsOutPath = join(PA_TEST_ROOT, 'router-tier-labels.jsonl');
  const resultOutPath = join(PA_TEST_ROOT, 'router-tier-eval-result.md');
  const lines: string[] = [];
  const code = await runTierEval(
    { labelsPath, labelsOutPath, resultOutPath, dryRun: false },
    { print: (l) => lines.push(l), askFn: stubAsk as never, configuredFn: () => true }
  );
  assert.strictEqual(code, 0, `exit ${code}: ${lines.join('\n')}`);
  const rows = readFileSync(labelsOutPath, 'utf8').split('\n').filter((l) => l.trim() !== '');
  assert.strictEqual(rows.length, LABELS.length);
  const parsed = rows.map((r) => JSON.parse(r));
  // 'code' rows carry DERIVED tiers; general/unclear rows are OPERATOR-provenance (no tier truth)
  const byId = new Map(parsed.map((p) => [p.id, p]));
  assert.strictEqual(byId.get('t1').provenance, 'DERIVED');
  assert.strictEqual(byId.get('t1').derivedTier, 'standard');
  assert.strictEqual(byId.get('t3').provenance, 'OPERATOR');
  assert.strictEqual(byId.get('t3').derivedTier, null);
  // majority tier/score recorded; asks = 3 + 1 duplicate (all rows are in the flip subset)
  assert.strictEqual(byId.get('t2').majorityTier, 'deep_reasoning');
  assert.strictEqual(byId.get('t1').asks.length, 4);
  // Agreement proxy: t1,t2,t5 are code turns; stub agrees with derived on all 3
  assert.ok(lines.some((l) => l.includes("(a) agreement proxy (classifier tier vs DERIVED tier on 3 'code' turns): **100%**")));
  // Success rate 100%, latency p50 42ms
  assert.ok(lines.some((l) => l.includes('(c) ask success rate: **100%**')));
  assert.ok(lines.some((l) => l.includes('(d) ask latency p50: **42 ms**')));
  // Summary file has the caveats paragraph
  const md = readFileSync(resultOutPath, 'utf8');
  assert.ok(md.includes('## Caveats'));
  assert.ok(md.includes('never operator truth'));
});

test('runTierEval dry-run: exit 0, no sends, no files written', async () => {
  const labelsPath = writeLabels();
  const out = join(PA_TEST_ROOT, 'dryrun-labels.jsonl');
  const lines: string[] = [];
  const code = await runTierEval(
    { labelsPath, labelsOutPath: out, dryRun: true },
    { print: (l) => lines.push(l) }
  );
  assert.strictEqual(code, 0);
  assert.ok(lines.some((l) => l.includes('dry-run, no requests sent')));
  assert.strictEqual(existsSync(out), false);
});

test('runTierEval: missing labels file exits 1', async () => {
  const lines: string[] = [];
  const code = await runTierEval(
    { labelsPath: join(PA_TEST_ROOT, 'missing.jsonl'), dryRun: false },
    { print: (l) => lines.push(l) }
  );
  assert.strictEqual(code, 1);
});

test('percentile returns sorted-order values', () => {
  assert.strictEqual(percentile([], 50), 0);
  assert.strictEqual(percentile([10, 20, 30, 40], 50), 30);
  assert.strictEqual(percentile([10, 20, 30, 40], 0), 10);
});
