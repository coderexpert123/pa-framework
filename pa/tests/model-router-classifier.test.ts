// Needs-classifier tests (spec WP-B, §0.1.3). askSystemOne is stubbed via
// the `ask` seam — every external call stubbed; no network, no key.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNeeds } from '../src/lib/model-router/needs-classifier.js';
import type { PlacementCandidateView, InflightRunView } from '../src/lib/model-router/needs-classifier.js';
import { askSystemOne, resetTypeSafeClientState } from '../src/lib/typesafe-client.js';
import type { TypeSafeRequest, TypeSafeResult, AskOptions, TypeSafeAnswer } from '../src/lib/typesafe-client.js';

// A transport stub returning a 200 with the given answers map (drives the
// REAL client parse path — no ask-seam shortcuts).
function wireAnswers(answers: Record<string, unknown>): typeof fetch {
  return (async () => new Response(JSON.stringify({ answers }), { status: 200 })) as unknown as typeof fetch;
}

function okAsk(choiceTier: string, choiceScore: string, confidence = 0.9) {
  return (req: TypeSafeRequest, _opts: AskOptions): Promise<TypeSafeResult> => {
    return Promise.resolve({
      ok: true,
      answers: {
        tier: { type: 'choice', choice: choiceTier, probabilities: {}, confidence },
        score: { type: 'choice', choice: choiceScore, probabilities: {}, confidence },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 1,
      status: 200,
      retries: 0,
    });
  };
}

// Stub that answers tier/score PLUS arbitrary extra answers (bypasses the
// client's strict all-questions validation, like the real wire would when a
// model returns garbage for one question).
function extAsk(extra: Record<string, { choice: string; probabilities?: Record<string, number>; confidence?: number }>) {
  return (req: TypeSafeRequest, _opts: AskOptions): Promise<TypeSafeResult> => {
    const answers: Record<string, TypeSafeAnswer> = {
      tier: { type: 'choice', choice: 'standard', probabilities: {}, confidence: 0.9 },
      score: { type: 'choice', choice: '3', probabilities: {}, confidence: 0.9 },
      ...Object.fromEntries(
        Object.entries(extra).map(([id, a]) => [
          id,
          { type: 'choice', choice: a.choice, probabilities: a.probabilities ?? {}, confidence: a.confidence ?? 0.8 },
        ])
      ),
    };
    return Promise.resolve({
      ok: true,
      answers,
      usage: { inputTokens: 10, outputTokens: 5 },
      latencyMs: 1,
      status: 200,
      retries: 0,
    });
  };
}

const CANDS: PlacementCandidateView[] = [
  { id: 'vi-aaaaaaaaaaaa', goal: 'fix the farm gate', status: 'awaiting_input', inflight: false },
  { id: 'vi-bbbbbbbbbbbb', goal: 'quarterly tax docs', status: 'running', inflight: true },
];
const INFLIGHT: InflightRunView[] = [{ id: 't-7', title: 'current work', status: 'running' }];

describe('model-router needs classifier', () => {
  it('ONE request carrying TWO choice questions (tier + score)', async () => {
    let seen: TypeSafeRequest | undefined;
    const ask = (req: TypeSafeRequest, opts: AskOptions) => {
      seen = req;
      return okAsk('standard', '3')(req, opts);
    };
    const got = await classifyNeeds({
      text: 'fix the bug',
      contextDigest: '',
      topic: {},
      caps: { state_max_chars: 4000 },
      ask,
    });
    assert.ok(got);
    assert.equal(got.tier, 'standard');
    assert.equal(got.score, 3);
    assert.ok(seen);
    assert.equal(Object.keys(seen.questions).length, 2);
    assert.ok(seen.questions.tier && seen.questions.tier.type === 'choice');
    assert.ok(seen.questions.score && seen.questions.score.type === 'choice');
  });

  it('confidence is the min of the two answers', async () => {
    let first = true;
    const ask = (req: TypeSafeRequest, opts: AskOptions): Promise<TypeSafeResult> => {
      // tier answer low confidence, score high
      return Promise.resolve({
        ok: true,
        answers: {
          tier: { type: 'choice', choice: 'standard', probabilities: {}, confidence: 0.3 },
          score: { type: 'choice', choice: '2', probabilities: {}, confidence: 0.95 },
        },
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        status: 200,
        retries: 0,
      });
    };
    const got = await classifyNeeds({ text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 }, ask });
    assert.equal(got?.confidence, 0.3);
  });

  it('ok:false result -> undefined (fail-open)', async () => {
    const ask = (): Promise<TypeSafeResult> =>
      Promise.resolve({ ok: false, error: 'timeout', latencyMs: 1, retries: 0 });
    const got = await classifyNeeds({ text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 }, ask });
    assert.equal(got, undefined);
  });

  it('an out-of-taxonomy tier choice -> undefined (never guessed)', async () => {
    const got = await classifyNeeds({ text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 }, ask: okAsk('excellent', '3') });
    assert.equal(got, undefined);
  });

  it('an out-of-range score choice -> undefined', async () => {
    const got = await classifyNeeds({ text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 }, ask: okAsk('standard', '9') });
    assert.equal(got, undefined);
  });

  it('turn text is capped to state_max_chars on egress', async () => {
    let seen: TypeSafeRequest | undefined;
    const ask = (req: TypeSafeRequest, opts: AskOptions) => {
      seen = req;
      return okAsk('standard', '3')(req, opts);
    };
    await classifyNeeds({
      text: 'a'.repeat(9999),
      contextDigest: 'ctx',
      topic: { name: 'n', description: 'd' },
      caps: { state_max_chars: 4000 },
      ask,
    });
    const state: any = seen?.state as any;
    assert.ok(state.text.length <= 4000);
  });

  it('a throwing ask -> undefined (never throws)', async () => {
    const ask = (): Promise<TypeSafeResult> => Promise.reject(new Error('boom'));
    const got = await classifyNeeds({ text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 }, ask });
    assert.equal(got, undefined);
  });
});

// Router-as-orchestrator §1.1-§1.2: the extended ONE-ask classifier.
describe('classifyNeeds — extended questions (same request)', () => {
  const base = {
    text: 'fix the bug',
    contextDigest: '',
    topic: {},
    caps: { state_max_chars: 4000 },
  };

  it('ALL questions ride ONE TypeSafeRequest when all inputs are present', async () => {
    let seen: TypeSafeRequest | undefined;
    const ask = (req: TypeSafeRequest, opts: AskOptions) => {
      seen = req;
      return extAsk({})(req, opts);
    };
    const got = await classifyNeeds({
      ...base,
      candidates: CANDS,
      currentInflight: INFLIGHT,
      chainWorkers: ['agy', 'codex'],
      ask,
    });
    assert.ok(got);
    assert.ok(seen);
    assert.deepEqual(Object.keys(seen.questions).sort(), [
      'chain', 'placement', 'score', 'steer_wait', 'target', 'target2', 'target3', 'tier',
    ]);
    // The state carries the bounded candidate + inflight sections.
    const state: any = seen.state;
    assert.deepEqual(state.candidates.map((c: any) => c.id), ['vi-aaaaaaaaaaaa', 'vi-bbbbbbbbbbbb']);
    assert.deepEqual(state.current_inflight.map((r: any) => r.id), ['t-7']);
  });

  it('no extended inputs -> exactly today\'s two questions (byte-identical ask)', async () => {
    let seen: TypeSafeRequest | undefined;
    const ask = (req: TypeSafeRequest, opts: AskOptions) => {
      seen = req;
      return okAsk('standard', '3')(req, opts);
    };
    await classifyNeeds({ ...base, ask });
    assert.equal(Object.keys(seen!.questions).length, 2);
  });

  it('steer_wait included IFF currentInflight is non-empty', async () => {
    let withInflight: TypeSafeRequest | undefined;
    let without: TypeSafeRequest | undefined;
    await classifyNeeds({
      ...base, currentInflight: INFLIGHT, candidates: CANDS,
      ask: (req, o) => { withInflight = req; return extAsk({})(req, o); },
    });
    await classifyNeeds({
      ...base, currentInflight: [], candidates: CANDS,
      ask: (req, o) => { without = req; return extAsk({})(req, o); },
    });
    assert.ok(withInflight!.questions.steer_wait);
    assert.equal(without!.questions.steer_wait, undefined);
  });

  it('target questions only when candidates are non-empty; placement asked even for an empty list', async () => {
    let emptyList: TypeSafeRequest | undefined;
    await classifyNeeds({
      ...base, candidates: [],
      ask: (req, o) => { emptyList = req; return extAsk({})(req, o); },
    });
    assert.ok(emptyList!.questions.placement, 'placement question asked even for an empty candidate list');
    assert.equal(emptyList!.questions.target, undefined);
  });

  it('a valid `other` answer carries the candidate id; `new` carries [new]', async () => {
    const other = await classifyNeeds({
      ...base, candidates: CANDS,
      ask: extAsk({ placement: { choice: 'other' }, target: { choice: 'vi-bbbbbbbbbbbb' } }),
    });
    assert.deepEqual(other?.placement, { choice: 'other', targets: ['vi-bbbbbbbbbbbb'] });
    const created = await classifyNeeds({
      ...base, candidates: CANDS,
      ask: extAsk({ placement: { choice: 'new' } }),
    });
    assert.deepEqual(created?.placement, { choice: 'new', targets: ['new'] });
  });

  it('an unknown placement target downgrades to `current` with invalidTarget (fail-open per question)', async () => {
    const got = await classifyNeeds({
      ...base, candidates: CANDS,
      ask: extAsk({ placement: { choice: 'other' }, target: { choice: 'vi-not-offered' } }),
    });
    assert.ok(got?.placement);
    assert.equal(got.placement.choice, 'current');
    assert.deepEqual(got.placement.targets, []);
    assert.equal(got.placement.invalidTarget, true);
    // tier/score still came through — the whole ask did NOT fail.
    assert.equal(got.tier, 'standard');
  });

  it('split2 dedupes and validates targets; a full miss collapses to current+invalidTarget', async () => {
    const split = await classifyNeeds({
      ...base, candidates: CANDS,
      ask: extAsk({
        placement: { choice: 'split2' },
        target: { choice: 'vi-aaaaaaaaaaaa' },
        target2: { choice: 'new' },
        target3: { choice: 'vi-aaaaaaaaaaaa' },
      }),
    });
    assert.equal(split?.placement?.choice, 'split2');
    assert.deepEqual(split?.placement?.targets, ['vi-aaaaaaaaaaaa', 'new']);
    const collapsed = await classifyNeeds({
      ...base, candidates: CANDS,
      ask: extAsk({ placement: { choice: 'split2' }, target: { choice: 'bogus' }, target2: { choice: 'bogus2' } }),
    });
    assert.equal(collapsed?.placement?.choice, 'current');
    assert.equal(collapsed?.placement?.invalidTarget, true);
  });

  it('an unknown placement CHOICE degrades to `current` with absentChoice (completeness marker)', async () => {
    const got = await classifyNeeds({
      ...base, candidates: CANDS,
      ask: extAsk({ placement: { choice: 'teleport' } }),
    });
    assert.ok(got);
    assert.deepEqual(got.placement, { choice: 'current', targets: [], absentChoice: true });
  });

  it('ABSENT answers degrade per question: placement -> current (+absent-placement), steer_wait -> wait, chain -> rank-order', async () => {
    // extAsk({}) answers ONLY tier/score — every new question is absent, the
    // M1 absent-path for each.
    const got = await classifyNeeds({
      ...base, candidates: CANDS, currentInflight: INFLIGHT, chainWorkers: ['agy', 'codex'],
      ask: extAsk({}),
    });
    assert.ok(got, 'tier/score survive a fully-absent new-question set');
    assert.deepEqual(got.placement, { choice: 'current', targets: [], absentChoice: true });
    assert.equal(got.steerWait, 'wait');
    assert.equal(got.chainP, undefined);
  });

  it('steer/wait: valid answer recorded; garbage/absent degrades to wait', async () => {
    const steer = await classifyNeeds({
      ...base, currentInflight: INFLIGHT,
      ask: extAsk({ steer_wait: { choice: 'steer' } }),
    });
    assert.equal(steer?.steerWait, 'steer');
    const junk = await classifyNeeds({
      ...base, currentInflight: INFLIGHT,
      ask: extAsk({ steer_wait: { choice: 'nuke' } }),
    });
    assert.equal(junk?.steerWait, 'wait');
    assert.equal(junk?.tier, 'standard', 'a bad steer_wait must not fail the ask');
  });

  it('chainP is the chain answer\'s probabilities map; empty probabilities degrade to rank-order', async () => {
    const probs = await classifyNeeds({
      ...base, chainWorkers: ['agy', 'codex'],
      ask: extAsk({ chain: { choice: 'agy', probabilities: { agy: 0.7, codex: 0.3 } } }),
    });
    assert.deepEqual(probs?.chainP, { agy: 0.7, codex: 0.3 });
    const none = await classifyNeeds({
      ...base, chainWorkers: ['agy', 'codex'],
      ask: extAsk({ chain: { choice: 'agy', probabilities: {} } }),
    });
    assert.equal(none?.chainP, undefined);
  });

  it('candidate section truncates tail-first at section_chars and records `truncated`', async () => {
    const many: PlacementCandidateView[] = Array.from({ length: 12 }, (_, i) => ({
      id: `vi-${String(i).padStart(12, '0')}`,
      goal: `goal number ${i} `.padEnd(60, 'x'),
      status: 'running',
      inflight: false,
    }));
    let seen: TypeSafeRequest | undefined;
    const got = await classifyNeeds({
      ...base, candidates: many, placement: { section_chars: 400 },
      ask: (req, o) => { seen = req; return extAsk({})(req, o); },
    });
    const state: any = seen!.state;
    const offered = state.candidates.length;
    assert.ok(offered < 12, 'the section cap must have dropped candidates');
    assert.ok(JSON.stringify(state.candidates).length <= 400, 'the rendered section must fit the cap');
    // Tail-first: the FIRST ids survive, the tail is dropped.
    assert.equal(state.candidates[0].id, 'vi-000000000000');
    assert.ok(got?.placement?.truncated, 'truncation is recorded on the classified turn');
  });

  it('goals are capped to goal_chars per candidate', async () => {
    let seen: TypeSafeRequest | undefined;
    await classifyNeeds({
      ...base,
      candidates: [{ id: 'vi-cccccccccccc', goal: 'g'.repeat(500), status: 'running', inflight: false }],
      placement: { goal_chars: 30 },
      ask: (req, o) => { seen = req; return extAsk({})(req, o); },
    });
    const state: any = seen!.state;
    assert.equal(state.candidates[0].goal.length, 30);
  });

  // M1: the fail-open contract binds at the PARSE BOUNDARY — through the REAL
  // client (stubbed transport), not just the ask seam.
  describe('real-client lenient parse boundary (M1)', () => {
    const realAsk = (answers: Record<string, unknown>) =>
      (req: TypeSafeRequest, opts: AskOptions) =>
        askSystemOne(req, { ...opts, lenient: true, fetchFn: wireAnswers(answers), apiKey: 'test-key' });
    const strictAsk = (answers: Record<string, unknown>) =>
      (req: TypeSafeRequest, opts: AskOptions) =>
        // classifyNeeds now passes lenient:true in opts — STRIP it here so
        // this test exercises the client's true DEFAULT (strict) path.
        askSystemOne(req, { purpose: opts.purpose, fetchFn: wireAnswers(answers), apiKey: 'test-key', lenient: false });

    const TIER_OK = { choice: 'standard', probabilities: { standard: 0.9 }, confidence: 0.9 };
    const SCORE_OK = { choice: '3', probabilities: { '3': 0.9 }, confidence: 0.9 };
    const PLACEMENT_GARBAGE = { choice: 'bogus-option', probabilities: {}, confidence: 0.5 };

    beforeEach(() => resetTypeSafeClientState());

    it('partial-valid response: tier/score survive a garbage placement (lenient)', async () => {
      const got = await classifyNeeds({
        text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 },
        candidates: CANDS,
        ask: realAsk({ tier: TIER_OK, score: SCORE_OK, placement: PLACEMENT_GARBAGE }),
      });
      assert.ok(got, 'classification must survive one garbage answer under lenient parse');
      assert.equal(got.tier, 'standard');
      assert.equal(got.score, 3);
      assert.deepEqual(got.placement, { choice: 'current', targets: [], absentChoice: true });
    });

    it('absent placement/steer_wait answers through the real client still classify (lenient)', async () => {
      const got = await classifyNeeds({
        text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 },
        candidates: CANDS, currentInflight: INFLIGHT,
        ask: realAsk({ tier: TIER_OK, score: SCORE_OK }),
      });
      assert.ok(got);
      assert.deepEqual(got.placement, { choice: 'current', targets: [], absentChoice: true });
      assert.equal(got.steerWait, 'wait');
    });

    it('the DEFAULT strict path is byte-unchanged: the same garbage voids the whole response', async () => {
      const got = await classifyNeeds({
        text: 'x', contextDigest: '', topic: {}, caps: { state_max_chars: 4000 },
        candidates: CANDS,
        ask: strictAsk({ tier: TIER_OK, score: SCORE_OK, placement: PLACEMENT_GARBAGE }),
      });
      assert.equal(got, undefined, 'strict parse must keep the all-or-nothing contract');
    });
  });
});
