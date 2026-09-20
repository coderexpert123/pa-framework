/**
 * Router-metadata provenance (2026-09-20, decision 31 — router-metadata wave
 * WP-2): unit pins for the PA_ROUTING_* vocabulary's single producer and the
 * dispatch site's pure derivations.
 *
 * - `buildRoutingProvenanceEnv` (dispatch.ts) mapping table: every vocabulary
 *   value emits its exact key; every optional-absent case omits the key; the
 *   steer pair is together-or-absent; NO value may carry whitespace-run text
 *   (the no-turn-text invariant, guarded STRUCTURALLY — ids only in target).
 * - `routingMetaFromOriginRouting` (main.ts): destination-leg meta derivation
 *   from the extended placement carry.
 * - `deriveTurnRoutingDecision` (main.ts): the decision derivation table.
 *
 * PA_ROUTING_FAILOVERS is deliberately NOT covered here — the cascade appends
 * it per hop, not the builder (dispatch.test.ts pins the count).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TurnRoutingMeta } from '../dispatch.js';
import type { TurnRoutingResult } from '../routing.js';
import type { PlacementCarry } from '../router-placement.js';

let paHomeTmp: string;

before(() => {
  // main.js is the composition root — importing it needs a throwaway PA_HOME
  // (dispatch.test.ts's isolation precedent).
  paHomeTmp = mkdtempSync(join(tmpdir(), 'routing-prov-'));
  process.env.PA_HOME = paHomeTmp;
});

after(() => {
  rmSync(paHomeTmp, { recursive: true, force: true });
  delete process.env.PA_HOME;
});

const { buildRoutingProvenanceEnv } = await import('../dispatch.js');
const { routingMetaFromOriginRouting, deriveTurnRoutingDecision } = await import('../main.js');

// ---------------------------------------------------------------------------

describe('buildRoutingProvenanceEnv mapping table (WP-2)', () => {
  it('every decision value emits its exact key', () => {
    for (const decision of ['router', 'ladder', 'command'] as const) {
      assert.deepEqual(buildRoutingProvenanceEnv({ decision }), { PA_ROUTING_DECISION: decision });
    }
  });

  it('every placement value emits its exact key', () => {
    for (const placement of ['continued-here', 'diverted', 'new-conversation', 'split'] as const) {
      const env = buildRoutingProvenanceEnv({ decision: 'router', placement });
      assert.equal(env.PA_ROUTING_PLACEMENT, placement);
      assert.equal(Object.keys(env).length, 2);
    }
  });

  it('a target rides only when present — and only an id, never a name', () => {
    assert.equal(buildRoutingProvenanceEnv({ decision: 'ladder' }).PA_ROUTING_TARGET, undefined);
    assert.equal(
      buildRoutingProvenanceEnv({ decision: 'ladder', target: 'vi-0123456789ab' }).PA_ROUTING_TARGET,
      'vi-0123456789ab',
    );
  });

  it('every effortProj value emits its exact key', () => {
    for (const effortProj of ['applied', 'nearest', 'recategorize'] as const) {
      const env = buildRoutingProvenanceEnv({ decision: 'router', effortProj });
      assert.equal(env.PA_ROUTING_EFFORT_PROJ, effortProj);
      assert.equal(Object.keys(env).length, 2);
    }
  });

  it('every optional-absent case omits its key — minimal meta emits ONLY the decision', () => {
    assert.deepEqual(
      buildRoutingProvenanceEnv({ decision: 'command' }),
      { PA_ROUTING_DECISION: 'command' },
      'no placement/target/steer/steerBy/effortProj keys at all',
    );
  });

  it("steerBy 'router' emits BOTH the paired steer key and PA_ROUTING_STEER_BY", () => {
    assert.deepEqual(
      buildRoutingProvenanceEnv({ decision: 'router', steer: 'wait', steerBy: 'router' }),
      { PA_ROUTING_DECISION: 'router', PA_ROUTING_STEER: 'wait', PA_ROUTING_STEER_BY: 'router' },
    );
    assert.deepEqual(
      buildRoutingProvenanceEnv({ decision: 'router', steer: 'steer', steerBy: 'router' }),
      { PA_ROUTING_DECISION: 'router', PA_ROUTING_STEER: 'steer', PA_ROUTING_STEER_BY: 'router' },
    );
  });

  it("steerBy 'operator' emits PA_ROUTING_STEER_BY=operator with PA_ROUTING_STEER=steer", () => {
    assert.deepEqual(
      buildRoutingProvenanceEnv({ decision: 'ladder', steer: 'steer', steerBy: 'operator' }),
      { PA_ROUTING_DECISION: 'ladder', PA_ROUTING_STEER: 'steer', PA_ROUTING_STEER_BY: 'operator' },
    );
  });

  it('steerBy ABSENT (steer alone) emits NEITHER steer key (together-or-absent)', () => {
    assert.deepEqual(
      buildRoutingProvenanceEnv({ decision: 'router', steer: 'wait' }),
      { PA_ROUTING_DECISION: 'router' },
      'a steer word without its decider stamps nothing',
    );
  });

  it('steerBy present WITHOUT steer emits NEITHER steer key (together-or-absent)', () => {
    assert.deepEqual(
      buildRoutingProvenanceEnv({ decision: 'router', steerBy: 'operator' }),
      { PA_ROUTING_DECISION: 'router' },
    );
  });

  it('STRUCTURAL no-turn-text guard: no output value ever contains whitespace', () => {
    // Full cross-product of the closed vocabulary — if any producer path ever
    // let a topic name, announce text, or request text ride a field, a value
    // would grow a space. Ids are the only free-form strings and they are
    // single-token vi- ids.
    const decisions = ['router', 'ladder', 'command'] as const;
    const placements = [undefined, 'continued-here', 'diverted', 'new-conversation', 'split'] as const;
    const targets = [undefined, 'vi-0123456789ab', 'vi-fedcba987654'] as const;
    const steers = [undefined, 'steer', 'wait'] as const;
    const steerBys = [undefined, 'router', 'operator'] as const;
    const effortProjs = [undefined, 'applied', 'nearest', 'recategorize'] as const;
    for (const decision of decisions) {
      for (const placement of placements) {
        for (const target of targets) {
          for (const steer of steers) {
            for (const steerBy of steerBys) {
              for (const effortProj of effortProjs) {
                const meta: TurnRoutingMeta = {
                  decision,
                  ...(placement ? { placement } : {}),
                  ...(target ? { target } : {}),
                  ...(steer ? { steer } : {}),
                  ...(steerBy ? { steerBy } : {}),
                  ...(effortProj ? { effortProj } : {}),
                };
                const env = buildRoutingProvenanceEnv(meta);
                for (const [key, value] of Object.entries(env)) {
                  assert.match(key, /^PA_ROUTING_[A-Z_]+$/, `unexpected key ${key}`);
                  assert.ok(value.length > 0, `empty value for ${key}`);
                  assert.ok(!/\s/.test(value), `${key}=${JSON.stringify(value)} carries whitespace — turn text leak`);
                }
              }
            }
          }
        }
      }
    }
  });

  it('PA_ROUTING_FAILOVERS is never produced by the builder (cascade-owned, §1.3)', () => {
    const env = buildRoutingProvenanceEnv({
      decision: 'router', placement: 'diverted', target: 'vi-0123456789ab',
      steer: 'wait', steerBy: 'router', effortProj: 'applied',
    });
    assert.ok(!('PA_ROUTING_FAILOVERS' in env));
    assert.equal(Object.keys(env).length, 6, 'the six turn-level keys, never the per-dispatch one');
  });
});

// ---------------------------------------------------------------------------

describe('routingMetaFromOriginRouting (destination-leg derivation, WP-2)', () => {
  const fullCarry = (originRouting: PlacementCarry['originRouting']): PlacementCarry => ({
    tier: 'deep_reasoning',
    score: 4,
    chain: ['codex'],
    ...(originRouting ? { originRouting } : {}),
  });

  it('a move part derives diverted + the ORIGIN conversation id as target', () => {
    assert.deepEqual(
      routingMetaFromOriginRouting(fullCarry({ kind: 'move', originConversationId: 'vi-0123456789ab' }).originRouting),
      { placement: 'diverted', target: 'vi-0123456789ab' },
    );
  });

  it('a move from a plain Telegram origin stamps diverted WITHOUT a target (honest fail-open)', () => {
    assert.deepEqual(
      routingMetaFromOriginRouting(fullCarry({ kind: 'move' }).originRouting),
      { placement: 'diverted' },
    );
  });

  it('a create part derives new-conversation', () => {
    assert.deepEqual(
      routingMetaFromOriginRouting(fullCarry({ kind: 'create', originConversationId: 'vi-0123456789ab' }).originRouting),
      { placement: 'new-conversation', target: 'vi-0123456789ab' },
    );
  });

  it('a split part derives split', () => {
    assert.deepEqual(
      routingMetaFromOriginRouting(fullCarry({ kind: 'split', originConversationId: 'vi-fedcba987654' }).originRouting),
      { placement: 'split', target: 'vi-fedcba987654' },
    );
  });

  it('a malformed target id fails open to absent (never a topic name)', () => {
    assert.deepEqual(
      routingMetaFromOriginRouting(fullCarry({ kind: 'move', originConversationId: 'topic-1234' }).originRouting),
      { placement: 'diverted' },
    );
    assert.deepEqual(
      routingMetaFromOriginRouting(fullCarry({ kind: 'move', originConversationId: 'vi-NOThex!' }).originRouting),
      { placement: 'diverted' },
    );
  });

  it('an absent originRouting slice yields empty meta (old carries load fine)', () => {
    assert.deepEqual(routingMetaFromOriginRouting(undefined), {});
    assert.deepEqual(routingMetaFromOriginRouting(fullCarry(undefined).originRouting), {});
  });
});

// ---------------------------------------------------------------------------

describe('deriveTurnRoutingDecision (decision derivation table, WP-2)', () => {
  const turn = (over: Partial<TurnRoutingResult> = {}): TurnRoutingResult =>
    ({ worker: 'agy', ...over });

  it("a command turn derives 'command'", () => {
    assert.equal(deriveTurnRoutingDecision('/status', turn()), 'command');
  });

  it("a routed turn (chain present) derives 'router'", () => {
    assert.equal(deriveTurnRoutingDecision('plain text', turn({ chain: ['codex', 'agy'] })), 'router');
  });

  it("a turn that carried a placement answer (chain absent) derives 'router'", () => {
    assert.equal(
      deriveTurnRoutingDecision('plain text', turn({
        placement: { choice: 'current', targets: [], focus: [] },
      })),
      'router',
    );
  });

  it("everything else derives 'ladder'", () => {
    assert.equal(deriveTurnRoutingDecision('plain text', turn()), 'ladder');
    assert.equal(
      deriveTurnRoutingDecision('plain text', turn({ model: 'm', effort: 'high', projectionOutcome: 'applied' })),
      'ladder',
      'model/effort projection alone is not a routed turn',
    );
  });
});
