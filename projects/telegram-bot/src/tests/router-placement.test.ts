/**
 * router-placement.test.ts — WP-5 (router-as-orchestrator 2026-09-19):
 * the placement engine's pure decision matrix (spec §3.2/§3.3), the
 * deterministic naming rule (R9), the destination resolve (I-3), the
 * placeOnce guard, and the decision-25 session-tunable bypass in main.ts's
 * buildRouterTurnDispatchState.
 *
 * Fixtures use the synthetic id family (-1001234567890, threads 5001/5002)
 * and vi- ids that match the ledger's vi-<12 hex> shape — never real ids.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  applyRouterPlacement,
  derivePlacementTopicName,
  resolveDestinationWorker,
  canPlaceUpdate,
  type RouterPlacementCandidate,
} from '../router-placement.js';
import { buildRouterTurnDispatchState } from '../main.js';
import type { ConversationState } from '../types.js';

const ORIGIN = '-1001234567890_5001';
const DEST = '-1001234567890_5002';

const cand = (over: Partial<RouterPlacementCandidate>): RouterPlacementCandidate => ({
  conversationId: 'vi-aaaaaaaaaaaa',
  goal: 'Fix the parser',
  status: 'running',
  inflight: true,
  routedTo: DEST,
  ...over,
});

const cMove = cand({ conversationId: 'vi-aaaaaaaaaaaa' });
const cNull = cand({ conversationId: 'vi-bbbbbbbbbbbb', routedTo: null, inflight: false, status: 'done' });
const cSelf = cand({ conversationId: 'vi-cccccccccccc', routedTo: ORIGIN });
const cBad = cand({ conversationId: 'vi-dddddddddddd', routedTo: 'not-a-key' });

describe('applyRouterPlacement — direct/current/absent', () => {
  it('direct and current are in-place', () => {
    for (const choice of ['direct', 'current'] as const) {
      assert.deepEqual(
        applyRouterPlacement({ placement: { choice, targets: [cMove.conversationId], focus: [] } }, ORIGIN, [cMove], { userText: 'x', originTopicName: 'Origin' }),
        { kind: 'in-place' },
      );
    }
  });

  it('no placement answer is in-place (fail-open turns never place)', () => {
    assert.deepEqual(
      applyRouterPlacement({}, ORIGIN, [cMove], { userText: 'x', originTopicName: 'Origin' }),
      { kind: 'in-place' },
    );
  });
});

describe('applyRouterPlacement — other (move)', () => {
  it('a valid routedTo moves; the focus directive rides when it matches', () => {
    const d = applyRouterPlacement(
      { placement: { choice: 'other', targets: [cMove.conversationId], focus: [{ conversationId: cMove.conversationId, directive: 'Focus on the parser part' }] } },
      ORIGIN, [cMove], { userText: 'x', originTopicName: 'Origin' },
    );
    assert.deepEqual(d, { kind: 'move', targetTopicKey: DEST, conversationId: cMove.conversationId, directive: 'Focus on the parser part' });
  });

  it('no focus match omits the directive', () => {
    const d = applyRouterPlacement(
      { placement: { choice: 'other', targets: [cMove.conversationId], focus: [] } },
      ORIGIN, [cMove], { userText: 'x', originTopicName: 'Origin' },
    );
    assert.equal((d as { directive?: string }).directive, undefined);
  });

  it('invalid targets fail open to in-place (invalid-target class)', () => {
    const opts = { userText: 'x', originTopicName: 'Origin' };
    for (const c of [cNull, cSelf, cBad]) {
      assert.deepEqual(
        applyRouterPlacement({ placement: { choice: 'other', targets: [c.conversationId], focus: [] } }, ORIGIN, [c], opts),
        { kind: 'in-place' },
        `${c.conversationId} must not move`,
      );
    }
    assert.deepEqual(
      applyRouterPlacement({ placement: { choice: 'other', targets: ['vi-000000000000'], focus: [] } }, ORIGIN, [cMove], opts),
      { kind: 'in-place' },
      'unknown candidate id must not move',
    );
    assert.deepEqual(
      applyRouterPlacement({ placement: { choice: 'other', targets: ['new'], focus: [] } }, ORIGIN, [cMove], opts),
      { kind: 'in-place' },
      "'new' is not a valid 'other' target",
    );
  });
});

describe('applyRouterPlacement — new (create)', () => {
  it('deterministic name + deterministic description, no LLM', () => {
    const d = applyRouterPlacement(
      { placement: { choice: 'new', targets: ['new'], focus: [] } },
      ORIGIN, [], { userText: 'please fix the parser timeout bug tomorrow', originTopicName: 'Origin' },
    );
    assert.deepEqual(d, { kind: 'create', name: 'Fix Parser Timeout Bug Tomorrow', description: 'New conversation from Origin' });
  });

  it('the deriveName seam is honored', () => {
    const d = applyRouterPlacement(
      { placement: { choice: 'new', targets: ['new'], focus: [] } },
      ORIGIN, [], { userText: 'x', originTopicName: 'Origin', deriveName: () => 'Seamed' },
    );
    assert.equal((d as { name: string }).name, 'Seamed');
  });
});

describe('applyRouterPlacement — split2/split3', () => {
  it('a valid two-part split stays a split with directives attached', () => {
    const d = applyRouterPlacement(
      {
        placement: {
          choice: 'split2',
          targets: [cMove.conversationId, 'new'],
          focus: [{ conversationId: cMove.conversationId, directive: 'Focus on the part belonging to "Fix the parser"' }],
        },
      },
      ORIGIN, [cMove], { userText: 'two things', originTopicName: 'Origin' },
    );
    assert.equal(d.kind, 'split');
    const parts = (d as { parts: Array<{ kind: string }> }).parts;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].kind, 'move');
    assert.equal(parts[1].kind, 'create');
    assert.equal((parts[0] as { directive?: string }).directive, 'Focus on the part belonging to "Fix the parser"');
  });

  it('duplicate targets dedupe; below 2 distinct collapses to the single part', () => {
    const d = applyRouterPlacement(
      { placement: { choice: 'split2', targets: [cMove.conversationId, cMove.conversationId], focus: [] } },
      ORIGIN, [cMove], { userText: 'x', originTopicName: 'Origin' },
    );
    assert.deepEqual(d, { kind: 'move', targetTopicKey: DEST, conversationId: cMove.conversationId });

    // Two 'new' targets derive the SAME name from the same text — one create.
    const d2 = applyRouterPlacement(
      { placement: { choice: 'split3', targets: ['new', 'new', 'new'], focus: [] } },
      ORIGIN, [], { userText: 'x', originTopicName: 'Origin' },
    );
    assert.equal(d2.kind, 'create');
  });

  it('zero valid parts degrades to in-place', () => {
    const d = applyRouterPlacement(
      { placement: { choice: 'split3', targets: [cNull.conversationId, cBad.conversationId, 'vi-000000000000'], focus: [] } },
      ORIGIN, [cNull, cBad], { userText: 'x', originTopicName: 'Origin' },
    );
    assert.deepEqual(d, { kind: 'in-place' });
  });
});

describe('canPlaceUpdate — placeOnce', () => {
  it('a plain update is placeable; every __synthetic tag is not', () => {
    assert.equal(canPlaceUpdate({ update_id: 1 }), true);
    assert.equal(canPlaceUpdate({}), true);
    for (const tag of ['placement', 'route', 'requeue', 'system_resume', 'button', 'reaction']) {
      assert.equal(canPlaceUpdate({ __synthetic: tag }), false, `__synthetic: '${tag}' must never re-place`);
    }
    assert.equal(canPlaceUpdate(undefined), false);
  });
});

describe('derivePlacementTopicName — route_task.py derive_topic_name port (R9)', () => {
  // Rule quoted from route_task.py (both this test and the implementation
  // must agree with it):
  //   "Short title-cased noun phrase from the task's transcript/request: the
  //   first <=6 meaningful (non-stopword, non-filler, alphanumeric) words,
  //   capped at TOPIC_NAME_MAX chars on a word boundary. Empty or garbage
  //   input (nothing left after stopword/filler/punctuation filtering) falls
  //   back to 'New work <UTC date>'."
  const now = new Date('2026-09-19T10:00:00Z');

  it('picks the first meaningful words, title-cased, stopwords and punctuation stripped', () => {
    assert.equal(derivePlacementTopicName('Fix the parser timeout bug now, please!', now), 'Fix Parser Timeout Bug');
  });

  it('caps at 6 meaningful words', () => {
    assert.equal(
      derivePlacementTopicName('alpha beta gamma delta epsilon zeta eta theta', now),
      'Alpha Beta Gamma Delta Epsilon Zeta',
    );
  });

  it('garbage input falls back to New work <UTC date>', () => {
    assert.equal(derivePlacementTopicName('!!! ... ---', now), 'New work 2026-09-19');
    assert.equal(derivePlacementTopicName('', now), 'New work 2026-09-19');
    assert.equal(derivePlacementTopicName('the of and', now), 'New work 2026-09-19');
  });

  it('trims over-long names on a word boundary; a single long word hard-slices at 40', () => {
    const long = 'create a wonderfully descriptive naming sentence about parsers and their habits today';
    const name = derivePlacementTopicName(long, now);
    assert.ok(name.length <= 40, `got ${name.length}: ${name}`);
    assert.ok(!name.endsWith(' '), 'trim must land on a word boundary');

    const single = 'x'.repeat(55);
    assert.equal(derivePlacementTopicName(single, now).length, 40);
  });
});

describe('resolveDestinationWorker — I-3 destination resolve (§3.3)', () => {
  const table = [
    { worker: 'agy', max_tier: 'standard' as const, max_score: 3 as const },
    { worker: 'claude', max_tier: 'deep_reasoning' as const, max_score: 5 as const },
    { worker: 'zclaude', max_tier: 'rich_toolchain' as const, max_score: 5 as const },
  ];

  it('destination incumbent sticks when it satisfies the carried need (§3.3)', () => {
    const row = resolveDestinationWorker(
      { tier: 'standard', score: 2, chain: ['claude', 'agy'] },
      { table, incumbent: 'agy', available: new Set(['agy', 'claude']) },
    );
    assert.equal(row?.worker, 'agy');
  });

  it('escape is capability-UP only — an unsatisfiable incumbent falls to the chain', () => {
    const row = resolveDestinationWorker(
      { tier: 'deep_reasoning', score: 4, chain: ['claude', 'agy'] },
      { table, incumbent: 'agy', available: new Set(['agy', 'claude']) },
    );
    assert.equal(row?.worker, 'claude');
  });

  it('an unavailable incumbent falls through the chain order', () => {
    const row = resolveDestinationWorker(
      { tier: 'standard', score: 2, chain: ['claude', 'agy'] },
      { table, incumbent: 'agy', available: new Set(['claude']) },
    );
    assert.equal(row?.worker, 'claude');
  });

  it('carried needs are optional — the filter is skipped, incumbent kept when available', () => {
    const row = resolveDestinationWorker(
      { chain: ['zclaude'] },
      { table, incumbent: 'agy', available: new Set(['agy', 'zclaude']) },
    );
    assert.equal(row?.worker, 'agy');
  });

  it('nothing available → undefined (caller fails open); empty table → undefined', () => {
    assert.equal(
      resolveDestinationWorker({ chain: ['claude'] }, { table, incumbent: undefined, available: new Set() }),
      undefined,
    );
    assert.equal(
      resolveDestinationWorker({ chain: ['claude'] }, { table: [], incumbent: 'agy', available: new Set(['agy']) }),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// Decision 25 (§5): the session-tunable bypass in main.ts's per-turn dispatch
// state view. Exported from main.js for exactly this pin.
// ---------------------------------------------------------------------------

const ORCH_CONTRACT_STATE = {
  chat_id: -1001234567890,
  last_update_id: 0,
  thread_id: 5001,
  turns: [],
  tunable_overrides: { claude: { model: 'session-model', effort: 'low' }, agy: { model: 'keep-me' } },
} as unknown as ConversationState;

describe('buildRouterTurnDispatchState — decision-25 session-tunable bypass', () => {
  const routed = { worker: 'claude', model: 'router-model', effort: 'high' };

  it('bypass OFF keeps today’s semantics byte-for-byte', () => {
    // Router tunables merge OVER the session slice.
    const merged = buildRouterTurnDispatchState(ORCH_CONTRACT_STATE, 'claude', routed, false);
    assert.deepEqual(merged.tunable_overrides?.claude, { model: 'router-model', effort: 'high' });
    assert.deepEqual(merged.tunable_overrides?.agy, { model: 'keep-me' });
    // No router tunables → the SAME reference (zero behavior change).
    assert.equal(buildRouterTurnDispatchState(ORCH_CONTRACT_STATE, 'claude', { worker: 'claude' }, false), ORCH_CONTRACT_STATE);
    assert.equal(buildRouterTurnDispatchState(ORCH_CONTRACT_STATE, 'claude', undefined, false), ORCH_CONTRACT_STATE);
  });

  it('bypass ON: the session slice for the routed worker is dropped, router values win', () => {
    const view = buildRouterTurnDispatchState(ORCH_CONTRACT_STATE, 'claude', routed, true);
    assert.deepEqual(view.tunable_overrides?.claude, { model: 'router-model', effort: 'high' });
    assert.deepEqual(view.tunable_overrides?.agy, { model: 'keep-me' }, 'other workers’ slices are untouched');
    // The real topicState reference stays untouched either way.
    assert.deepEqual(ORCH_CONTRACT_STATE.tunable_overrides?.claude, { model: 'session-model', effort: 'low' });
  });

  it('bypass ON with NO router tunables still strips the session slice (the worker defaults apply)', () => {
    const view = buildRouterTurnDispatchState(ORCH_CONTRACT_STATE, 'claude', { worker: 'claude' }, true);
    assert.equal(view.tunable_overrides?.claude, undefined);
    assert.deepEqual(view.tunable_overrides?.agy, { model: 'keep-me' });
    assert.notEqual(view, ORCH_CONTRACT_STATE, 'a bypassed view must never be the live state');
  });
});

// ---------------------------------------------------------------------------
// main.ts window-B source invariants (the seam glue is not unit-drivable
// headless; the poll-loop-detached-tracking file is the precedent).
// ---------------------------------------------------------------------------

describe('main.ts window-B source invariants', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const mainSrc = readFileSync(join(here, '..', '..', 'src', 'main.ts'), 'utf8');

  it('the placement branch gates on the live surface, the answer, and placeOnce', () => {
    assert.ok(
      mainSrc.includes('if (placementLive && routerTurn.placement && canPlaceUpdate(update)) {'),
      'the placement branch must gate on placementLive + the router answer + canPlaceUpdate',
    );
  });

  it('the injection carries the placement synthetic tag (placeOnce producer)', () => {
    assert.ok(mainSrc.includes("__synthetic: 'placement'"), "placed turns must carry __synthetic: 'placement'");
    assert.ok(mainSrc.includes('__placementCarry'), 'placed turns must carry the routing-reuse payload');
  });

  it('the announce-in-origin is ref-ID’d and no worker runs in the origin', () => {
    assert.ok(
      mainSrc.includes('appendRefIdAndLog(announceLines.join'),
      'the announce reply must be ref-ID’d (appendRefIdAndLog)',
    );
    const branchStart = mainSrc.indexOf('if (placementLive && routerTurn.placement && canPlaceUpdate(update)) {');
    const branchEnd = mainSrc.indexOf('// /orchestrator (AI-203)', branchStart);
    const branch = mainSrc.slice(branchStart, branchEnd);
    assert.ok(branch.includes('skipWorker = true;'), 'a placed turn must not dispatch a worker in the origin');
  });

  it('the persona branch is guarded by the placement-surface skip', () => {
    assert.ok(
      mainSrc.includes('isOrchestratorMode(topicState) && !personaSkipped'),
      'the orchestrator persona branch must be skipped on routed turns under the live placement surface',
    );
  });

  it('the decision-25 bypass reaches the dispatch state', () => {
    assert.ok(
      mainSrc.includes('buildRouterTurnDispatchState(topicState, effectiveDefault, routerTurn, pinsDeprecatedTurnDispatch)'),
      'the dispatch state must be built with the decision-25 session-tunable bypass',
    );
    assert.ok(
      mainSrc.includes('deprecatePinsEffective(mrBlock) && routedTurn'),
      'the bypass gate must be the deprecate-pins predicate AND the routed marker',
    );
  });
});
