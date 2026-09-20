// Model-router config-surface tests (2026-09-18, plans/2026-09-18-model-router-SPEC.md WP-A).
// Covers parseModelRouter's WARN-AND-SKIP-per-field semantics: each bad field
// warns and drops THAT field (never the whole block, unlike routing_policy's
// enabled-gate — shadow runs iff the block EXISTS, enabled only gates the
// decision, spec §0.7). Known-bad probe: a tier string outside the four-tier
// taxonomy must WARN and drop the row, never silently normalize it.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelRouter } from '../src/config.js';
import type { ModelRouterConfig } from '../src/types.js';

// Capture console.warn so each test can assert warn COUNT + content.
let warns: string[] = [];
const origWarn = console.warn;

beforeEach(() => {
  warns = [];
  console.warn = (...args: any[]) => { warns.push(args.map(String).join(' ')); };
  process.env.PA_HOME = mkdtempSync(join(tmpdir(), 'model-router-config-'));
});

afterEach(() => {
  console.warn = origWarn;
  try { rmSync(process.env.PA_HOME!, { recursive: true, force: true }); } catch { /* scratch */ }
  delete process.env.PA_HOME;
});

const VALID: any = {
  enabled: true,
  judge: 'typesafe',
  state_max_chars: 5000,
  context_max_chars: 2500,
  topic_max_chars: 400,
  zai_workers: ['zclaude', 'kgclaude'],
  table: [
    { worker: 'agy', max_tier: 'quick_lookup', max_score: 1 },
    { worker: 'codex', model: 'gpt-5-codex', max_tier: 'rich_toolchain', max_score: 5 },
  ],
  effort_projection: {
    codex: { tunable: 'effort', map: { 1: 'minimal', 5: 'high' } },
    devin: { tunable: 'none' },
  },
  shadow_path: 'custom-shadow.jsonl',
};

describe('parseModelRouter', () => {
  it('valid full block parses with every field intact', () => {
    const cfg = parseModelRouter({ ...VALID }) as ModelRouterConfig;
    assert.ok(cfg);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.judge, 'typesafe');
    assert.deepEqual(cfg.zai_workers, ['zclaude', 'kgclaude']);
    assert.equal(cfg.table?.length, 2);
    assert.equal(cfg.table?.[1].model, 'gpt-5-codex');
    assert.equal(cfg.shadow_path, 'custom-shadow.jsonl');
    assert.deepEqual(cfg.effort_projection?.codex?.map, { 1: 'minimal', 5: 'high' });
    assert.equal(warns.length, 0);
  });

  it('absent block -> undefined (zero behavior, zero logging)', () => {
    assert.equal(parseModelRouter(undefined), undefined);
    assert.equal(parseModelRouter(null), undefined);
    assert.equal(warns.length, 0);
  });

  it('not-a-mapping drops the WHOLE block with a warn', () => {
    assert.equal(parseModelRouter('nope'), undefined);
    assert.equal(parseModelRouter([1, 2]), undefined);
    assert.equal(warns.length, 2);
    assert.ok(warns[0].includes('model_router'));
  });

  it('enabled defaults to false when omitted; block still returned (shadow runs on presence)', () => {
    const cfg = parseModelRouter({}) as ModelRouterConfig;
    assert.ok(cfg);
    assert.equal(cfg.enabled, false);
  });

  it('non-boolean enabled warns and defaults to false', () => {
    const cfg = parseModelRouter({ enabled: 'yes' }) as ModelRouterConfig;
    assert.equal(cfg.enabled, false);
    assert.equal(warns.length, 1);
  });

  it('defaults: state 4000 / context 2000 / topic 300 / zai_workers [zclaude]', () => {
    const cfg = parseModelRouter({}) as ModelRouterConfig;
    assert.equal(cfg.state_max_chars, 4000);
    assert.equal(cfg.context_max_chars, 2000);
    assert.equal(cfg.topic_max_chars, 300);
    assert.deepEqual(cfg.zai_workers, ['zclaude']);
  });

  it('invalid judge value warns and drops the field', () => {
    const cfg = parseModelRouter({ judge: 'coin-flip' }) as ModelRouterConfig;
    assert.equal(cfg.judge, undefined);
    assert.equal(warns.length, 1);
  });

  it('each bad cap warns and drops THAT field (others keep values)', () => {
    const cfg = parseModelRouter({
      state_max_chars: -1, context_max_chars: 'big', topic_max_chars: 0,
    }) as ModelRouterConfig;
    assert.equal(cfg.state_max_chars, 4000);
    assert.equal(cfg.context_max_chars, 2000);
    assert.equal(cfg.topic_max_chars, 300);
    assert.equal(warns.length, 3);
  });

  it('zai_workers: non-array drops to default; bad entries dropped per-item', () => {
    const dropped = parseModelRouter({ zai_workers: 7 }) as ModelRouterConfig;
    assert.deepEqual(dropped.zai_workers, ['zclaude']);
    const partial = parseModelRouter({ zai_workers: ['zclaude', '', '  ', 'codex'] }) as ModelRouterConfig;
    assert.deepEqual(partial.zai_workers, ['zclaude', 'codex']);
  });

  it('KNOWN-BAD PROBE: table row with max_tier \'excellent\' WARNS and drops the row', () => {
    const cfg = parseModelRouter({
      table: [
        { worker: 'agy', max_tier: 'quick_lookup', max_score: 1 },
        { worker: 'codex', max_tier: 'excellent', max_score: 5 },
      ],
    }) as ModelRouterConfig;
    assert.equal(cfg.table?.length, 1, 'the bad row must be DROPPED, not normalized');
    assert.equal(cfg.table?.[0].worker, 'agy');
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes('excellent'));
  });

  it('table rows: empty worker / non-integer or out-of-range max_score / bad model each drop the row', () => {
    const cfg = parseModelRouter({
      table: [
        { worker: '', max_tier: 'standard', max_score: 2 },
        { worker: 'agy', max_tier: 'standard', max_score: 0 },
        { worker: 'agy', max_tier: 'standard', max_score: 6 },
        { worker: 'agy', max_tier: 'standard', max_score: 2.5 },
        { worker: 'agy', max_tier: 'standard', max_score: 3, model: 42 },
        { worker: 'agy', max_tier: 'standard', max_score: 3 },
      ],
    }) as ModelRouterConfig;
    assert.equal(cfg.table?.length, 1);
    assert.equal(cfg.table?.[0].max_score, 3);
    assert.equal(warns.length, 5);
  });

  it('table: not-an-array drops the table, block survives', () => {
    const cfg = parseModelRouter({ table: 'everything' }) as ModelRouterConfig;
    assert.equal(cfg.table, undefined);
    assert.equal(warns.length, 1);
  });

  it('effort_projection: bad tunable / bad map keys / bad map values drop THAT projection entry', () => {
    const cfg = parseModelRouter({
      effort_projection: {
        codex: { tunable: 'effort', map: { 1: 'low', 3: 5 } },
        devin: { tunable: 'none' },
        bogus: { tunable: 'louder' },
        empty: { tunable: 'effort' },
      },
    }) as ModelRouterConfig;
    // 'empty' (tunable: effort, no map) is LEGAL per spec §0.1.5 — map is
    // optional and its absence degrades to the explicit 'nearest' outcome,
    // never a silent downgrade. The bad map PAIR is dropped per-item (the
    // topic_classes idiom) so codex survives with its valid pair — 3 entries
    // survive: codex (partial map), devin, empty.
    assert.equal(Object.keys(cfg.effort_projection ?? {}).length, 3);
    assert.ok(cfg.effort_projection?.devin);
    assert.ok(cfg.effort_projection?.empty);
    assert.equal(cfg.effort_projection?.empty?.map, undefined);
    assert.ok(cfg.effort_projection?.codex);
    assert.deepEqual(cfg.effort_projection?.codex?.map, { 1: 'low' });
    assert.ok(warns.length === 2);
  });

  it('shadow_path: non-empty string required; bad value warns and drops the field', () => {
    const cfg = parseModelRouter({ shadow_path: '' }) as ModelRouterConfig;
    assert.equal(cfg.shadow_path, undefined);
    assert.equal(warns.length, 1);
    const ok = parseModelRouter({ shadow_path: 'x.jsonl' }) as ModelRouterConfig;
    assert.equal(ok.shadow_path, 'x.jsonl');
  });

  it('sticky: absent stays undefined (= ON semantics); booleans parse; non-boolean warns and drops', () => {
    const absent = parseModelRouter({ enabled: true }) as ModelRouterConfig;
    assert.equal(absent.sticky, undefined, 'absent = ON when the block exists (router reads sticky !== false)');
    const off = parseModelRouter({ sticky: false }) as ModelRouterConfig;
    assert.equal(off.sticky, false);
    const on = parseModelRouter({ sticky: true }) as ModelRouterConfig;
    assert.equal(on.sticky, true);
    const bad = parseModelRouter({ sticky: 'yes' }) as ModelRouterConfig;
    assert.equal(bad.sticky, undefined);
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes('sticky'));
  });

  // Phase-2 fields (2026-09-19 router-as-orchestrator): same warn-and-drop
  // per-field semantics.
  it('deprecate_pins: absent stays undefined (= ON when block exists); booleans parse; junk warns and drops', () => {
    const absent = parseModelRouter({ enabled: true }) as ModelRouterConfig;
    assert.equal(absent.deprecate_pins, undefined, 'absent = true per decision 25 (router reads !== false)');
    assert.equal((parseModelRouter({ deprecate_pins: false }) as ModelRouterConfig).deprecate_pins, false);
    assert.equal((parseModelRouter({ deprecate_pins: true }) as ModelRouterConfig).deprecate_pins, true);
    const bad = parseModelRouter({ deprecate_pins: 'nope' }) as ModelRouterConfig;
    assert.equal(bad.deprecate_pins, undefined);
    assert.equal(warns.length, 1);
    assert.ok(warns[0].includes('deprecate_pins'));
  });

  it('availability_ttl_ms: non-negative numbers parse (0 = disabled); negatives/junk warn and drop', () => {
    assert.equal((parseModelRouter({ availability_ttl_ms: 2500 }) as ModelRouterConfig).availability_ttl_ms, 2500);
    assert.equal((parseModelRouter({ availability_ttl_ms: 0 }) as ModelRouterConfig).availability_ttl_ms, 0);
    const bad = parseModelRouter({ availability_ttl_ms: -1 }) as ModelRouterConfig;
    assert.equal(bad.availability_ttl_ms, undefined);
    assert.equal(warns.length, 1);
    const junk = parseModelRouter({ availability_ttl_ms: 'soon' }) as ModelRouterConfig;
    assert.equal(junk.availability_ttl_ms, undefined);
    assert.equal(warns.length, 2);
  });

  it('placement caps: mapping parses; each bad cap warns and drops THAT field; non-mapping drops the block', () => {
    const ok = parseModelRouter({ placement: { candidate_cap: 10, goal_chars: 60, section_chars: 1200 } }) as ModelRouterConfig;
    assert.deepEqual(ok.placement, { candidate_cap: 10, goal_chars: 60, section_chars: 1200 });
    const partial = parseModelRouter({ placement: { candidate_cap: 10, goal_chars: -1, section_chars: 'big' } }) as ModelRouterConfig;
    assert.deepEqual(partial.placement, { candidate_cap: 10 });
    assert.equal(warns.length, 2);
    const dropped = parseModelRouter({ placement: [1, 2] }) as ModelRouterConfig;
    assert.equal(dropped.placement, undefined);
    assert.equal(warns.length, 3);
  });

  it('surfaces: shadow|live parse per surface; bad values warn and drop THAT field; non-mapping drops the block', () => {
    const ok = parseModelRouter({ surfaces: { fallback: 'live', steer: 'shadow', placement: 'live' } }) as ModelRouterConfig;
    assert.deepEqual(ok.surfaces, { fallback: 'live', steer: 'shadow', placement: 'live' });
    const bad = parseModelRouter({ surfaces: { fallback: 'dark', steer: 3, placement: 'live' } }) as ModelRouterConfig;
    assert.deepEqual(bad.surfaces, { placement: 'live' });
    assert.equal(warns.length, 2);
    assert.ok(warns[0].includes('surfaces.fallback'));
    const dropped = parseModelRouter({ surfaces: 'now' }) as ModelRouterConfig;
    assert.equal(dropped.surfaces, undefined);
    assert.equal(warns.length, 3);
  });
});
