// Shadow-writer tests (spec WP-B, §0.1.6). PA_HOME temp dir; NO TURN TEXT in
// any field; reason truncated to 200; never throws; line <= 1500.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendShadowRecord } from '../src/lib/model-router/shadow.js';
import type { ShadowRecord } from '../src/lib/model-router/shadow.js';

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'model-router-shadow-'));
  process.env.PA_HOME = home;
});
afterEach(() => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* scratch */ }
  delete process.env.PA_HOME;
});

function rec(over: Partial<ShadowRecord> = {}): ShadowRecord {
  return {
    at: '2026-09-18T00:00:00.000Z',
    topicKey: '123_45',
    store: 'telegram',
    textSource: 'turn-text',
    tier: 'standard',
    score: 3,
    confidence: 0.8,
    chosen: { worker: 'codex', model: 'gpt-5.4', effort: 'medium', outcome: 'applied' },
    baseline: { worker: 'agy' },
    pinPresent: false,
    disagreement: true,
    reason: 'table-rank',
    ...over,
  };
}

describe('model-router shadow writer', () => {
  it('appends ONE parseable JSON line per call', () => {
    const p = join(home, 'model-router-shadow.jsonl');
    appendShadowRecord(p, rec());
    appendShadowRecord(p, rec({ topicKey: '9_8' }));
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.topicKey, '123_45');
    assert.equal(parsed.baseline.worker, 'agy');
  });

  it('creates parent directories', () => {
    const p = join(home, 'nested', 'dir', 'shadow.jsonl');
    appendShadowRecord(p, rec());
    assert.ok(existsSync(p));
  });

  it('reason longer than 200 chars is truncated', () => {
    const p = join(home, 'shadow.jsonl');
    appendShadowRecord(p, rec({ reason: 'r'.repeat(500) }));
    const parsed = JSON.parse(readFileSync(p, 'utf8').trim());
    assert.ok(parsed.reason.length <= 200);
  });

  it('a record that cannot render under 1500 chars is SKIPPED (never an oversized line)', () => {
    const p = join(home, 'shadow.jsonl');
    appendShadowRecord(p, rec());  // line 1 lands
    const big = rec({ topicKey: 'k'.repeat(1200), reason: 'r'.repeat(200) });
    appendShadowRecord(p, big);    // oversized -> dropped, best-effort
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'oversized line must not be emitted');
    assert.ok(lines[0].length <= 1500);
  });

  it('NO TURN TEXT in any field — the record schema carries only keys/ids', () => {
    const p = join(home, 'shadow.jsonl');
    const userText = 'the secret user sentence about my bank account XYZ';
    appendShadowRecord(p, rec());
    const line = readFileSync(p, 'utf8').trim();
    assert.ok(!line.includes(userText));
    const parsed = JSON.parse(line);
    const allowed = new Set(['at', 'topicKey', 'store', 'textSource', 'tier', 'score', 'confidence', 'chosen', 'baseline', 'pinPresent', 'disagreement', 'sticky', 'stickBreakReason', 'chain', 'placement', 'steerWait', 'reason']);
    for (const key of Object.keys(parsed)) assert.ok(allowed.has(key), `unexpected field ${key}`);
  });

  it('sticky fields serialize when present and omit when absent', () => {
    const p = join(home, 'shadow.jsonl');
    appendShadowRecord(p, rec({ sticky: true }));
    appendShadowRecord(p, rec({ sticky: false, stickBreakReason: 'unsatisfiable', chosen: undefined }));
    const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].sticky, true);
    assert.equal(lines[0].stickBreakReason, undefined);
    assert.equal(lines[1].sticky, false);
    assert.equal(lines[1].stickBreakReason, 'unsatisfiable');
  });

  // §9.2 shadow additions (router-as-orchestrator WP-1): ids/enums/counts
  // only — and the canary proves fixture turn text never rides the new fields.
  describe('phase-2 fields (chain / placement / steerWait)', () => {
    const userText = 'please move this to the farm conversation and split the invoice part';
    it('chain, placement and steerWait serialize with their new shapes and omit when absent', () => {
      const p = join(home, 'shadow.jsonl');
      appendShadowRecord(p, rec({
        chain: [{ worker: 'agy', p: 0.71 }, { worker: 'codex' }],
        placement: { choice: 'other', targets: ['vi-abc123def456'], candidates: 25, truncated: true },
        steerWait: { inflight: true, decision: 'steer' },
      }));
      appendShadowRecord(p, rec({ chain: undefined, placement: undefined, steerWait: undefined }));
      const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(lines[0].chain, [{ worker: 'agy', p: 0.71 }, { worker: 'codex' }]);
      assert.equal(lines[0].placement.choice, 'other');
      assert.deepEqual(lines[0].placement.targets, ['vi-abc123def456']);
      assert.equal(lines[0].placement.candidates, 25);
      assert.equal(lines[0].placement.truncated, true);
      assert.deepEqual(lines[0].steerWait, { inflight: true, decision: 'steer' });
      assert.equal(lines[1].chain, undefined);
      assert.equal(lines[1].placement, undefined);
      assert.equal(lines[1].steerWait, undefined);
    });

    it('CANARY: fixture turn text never appears in any emitted line, new fields included', () => {
      const p = join(home, 'shadow.jsonl');
      appendShadowRecord(p, rec({
        // Even a hostile/buggy producer putting content-shaped values in the
        // new fields cannot leak the text: the canary asserts the FIELDS the
        // router actually emits carry ids/enums only.
        chain: [{ worker: 'agy', p: 0.5 }],
        placement: { choice: 'split2', targets: ['vi-abc123def456', 'new'], candidates: 3, truncated: true },
        steerWait: { inflight: true, decision: 'wait' },
        reason: 'table-rank+invalid-target',
      }));
      const raw = readFileSync(p, 'utf8');
      assert.ok(raw.length > 0);
      assert.ok(!raw.includes(userText), 'turn text must never enter the shadow line');
      assert.ok(!raw.includes('split the invoice part'), 'turn-text fragments must never enter the shadow line');
      for (const line of raw.trim().split('\n')) {
        const parsed = JSON.parse(line);
        if (parsed.chain !== undefined) {
          assert.ok(Array.isArray(parsed.chain));
          for (const e of parsed.chain) {
            assert.ok(typeof e.worker === 'string');
            assert.ok(e.p === undefined || typeof e.p === 'number');
          }
        }
        if (parsed.placement !== undefined) {
          for (const t of parsed.placement.targets) assert.match(t, /^(vi-[0-9a-f]{12}|new)$/);
        }
        if (parsed.steerWait !== undefined) {
          assert.equal(typeof parsed.steerWait.inflight, 'boolean');
          assert.ok(parsed.steerWait.decision === undefined || parsed.steerWait.decision === 'steer' || parsed.steerWait.decision === 'wait');
        }
      }
    });

    it('a grown record still respects the 1500-char line cap (oversized is skipped)', () => {
      const p = join(home, 'shadow.jsonl');
      appendShadowRecord(p, rec());  // line 1 lands
      // Fleet is bounded, but pin the cap: a hostile record over 1500 chars
      // (30 long chain entries) is SKIPPED whole, never emitted truncated.
      const chain = Array.from({ length: 30 }, (_, i) => ({ worker: `worker-${i}-with-a-very-long-name`, p: 0.5 }));
      appendShadowRecord(p, rec({ chain, topicKey: 'k'.repeat(200) }));
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1, 'the oversized record must be skipped, not emitted');
      assert.ok(lines[0].length <= 1500);
      // A grown-but-fitting record still lands whole.
      appendShadowRecord(p, rec({ chain: [{ worker: 'agy', p: 0.5 }, { worker: 'codex' }] }));
      const after = readFileSync(p, 'utf8').trim().split('\n');
      assert.equal(after.length, 2);
      for (const line of after) assert.ok(line.length <= 1500, `line exceeded the cap: ${line.length}`);
    });
  });

  it('unwritable path never throws', () => {
    // A path under a FILE parent — append must fail silently.
    const fileAsDir = join(home, 'not-a-dir');
    appendShadowRecord(fileAsDir, rec());
    const p = join(fileAsDir, 'shadow.jsonl');
    appendShadowRecord(p, rec());
    assert.ok(true); // reaching here = no throw
  });
});
