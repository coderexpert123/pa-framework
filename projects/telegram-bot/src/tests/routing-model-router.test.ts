// resolveTurnRouting tests (2026-09-18, model-router WP-F): the router step
// added between 'resolve classification' and 'return decision' at the bot's
// single integration point. Every external call is stubbed via the existing
// seam style (judgeRunner for the ladder, routerAsk/routerAvailability/
// routeTurnFn for the router); PA_HOME points at a temp dir so nothing
// durable is touched.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTurnRouting, applyRoutingPolicy } from '../routing.js';

const POLICY = {
  enabled: true as const,
  judge: 'deterministic' as const,
  general_worker: 'agy',
  code_worker: 'zclaude',
  peak_code_worker: 'claude',
};

// Wed 07:00Z = inside the default peak window; the code ladder picks `claude`.
const IN_PEAK = new Date('2026-08-19T07:00:00Z');
const USER_TEXT = 'fix this bug in the parser';

const WORKERS = [{ name: 'agy' }, { name: 'zclaude' }, { name: 'claude' }, { name: 'codex' }];

const TABLE = [
  { worker: 'codex', model: 'codex-router-model', max_tier: 'rich_toolchain' as const, max_score: 5 as const },
];

const routerAskOk = async () => ({
  ok: true as const,
  answers: {
    tier: { type: 'choice' as const, choice: 'deep_reasoning', confidence: 0.9 },
    score: { type: 'choice' as const, choice: 4, confidence: 0.8 },
  },
  usage: { inputTokens: 1, outputTokens: 1 },
  latencyMs: 1,
});

let paHomeTmp: string;

function shadowPath(name: string): string {
  return join(paHomeTmp, `${name}-model-router-shadow.jsonl`);
}

function shadowLines(name: string): any[] {
  const p = shadowPath(name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

async function run(overrides: Record<string, any>, block: any, currentDefault = 'agy'): Promise<any> {
  return await resolveTurnRouting(
    {
      config: {
        routing_policy: POLICY,
        workers: WORKERS,
        model_router: block,
        ...(overrides.config ?? {}),
      },
      topicKey: '123_5001',
      userText: USER_TEXT,
      baselineDefault: 'agy',
      configuredDefault: 'agy',
      now: IN_PEAK,
      judgeRunner: async () => undefined, // deterministic regex fallback on the SAME text
      routerAsk: routerAskOk,
      routerAvailability: async () => true,
      ...(overrides.args ?? {}),
    } as any,
    currentDefault,
  );
}

describe('resolveTurnRouting (model-router WP-F)', () => {
  before(() => {
    paHomeTmp = mkdtempSync(join(tmpdir(), 'wpf-routing-'));
    process.env.PA_HOME = paHomeTmp;
  });
  after(() => {
    rmSync(paHomeTmp, { recursive: true, force: true });
    delete process.env.PA_HOME;
  });

  it('a. policy absent keeps the default and never shadows', async () => {
    const r = await run({ config: { routing_policy: undefined } }, { enabled: true }, 'agy');
    assert.deepEqual(r, { worker: 'agy' });
    assert.equal(existsSync(join(paHomeTmp, 'model-router-shadow.jsonl')), false);
  });

  it('b. pin / mutation / command: router shadow-only with pinPresent true', async () => {
    // pin (deprecate_pins: false keeps the pre-phase-2 pinned semantics — under
    // the default-ON flag this turn would route; pinned-turn coverage under the
    // flag lives in the WP-3 describe below)
    const pin = await run(
      { args: { preferredWorker: 'codex' } },
      { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('pin') },
    );
    assert.deepEqual(pin, { worker: 'agy' });
    const lines = shadowLines('pin');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].pinPresent, true);
    assert.equal(lines[0].baseline.worker, 'agy');

    // same-turn mutation of the default
    const mut = await run({}, { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('mut') }, 'codex');
    assert.deepEqual(mut, { worker: 'codex' });
    assert.equal(shadowLines('mut').length, 1);

    // command turn
    const cmd = await run(
      { args: { userText: '/status' } },
      { enabled: true, table: TABLE, shadow_path: shadowPath('cmd') },
    );
    assert.deepEqual(cmd, { worker: 'agy' });
    const cl = shadowLines('cmd');
    assert.equal(cl.length, 1);
    assert.equal(cl[0].pinPresent, true);
  });

  it('c/d. shadow-only (flag OFF): dispatch untouched, ONE shadow line, ladder baseline', async () => {
    const r = await run({}, { enabled: false, table: TABLE, shadow_path: shadowPath('off') });
    // ladder: code turn in peak -> claude; router would have chosen codex
    assert.deepEqual(r, { worker: 'claude' });
    const lines = shadowLines('off');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].chosen.worker, 'codex');
    assert.equal(lines[0].baseline.worker, 'claude');
    assert.equal(lines[0].pinPresent, false);
    assert.equal(lines[0].disagreement, true);
    assert.ok(!JSON.stringify(lines[0]).includes(USER_TEXT), 'no turn text in the shadow line');
  });

  it('e. enabled: the router decides and carries model/effort/projectionOutcome', async () => {
    const r = await run({}, { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('on') });
    assert.deepEqual(r, {
      worker: 'codex',
      model: 'codex-router-model',
      effort: 'medium', // codex projection map: score 4 -> medium
      projectionOutcome: 'applied',
      tier: 'deep_reasoning', // integrator seam (2026-09-20): needs pass through for the placement carry
      score: 4,
      chain: ['codex'], // WP-1 (decision 20): every routed turn carries the chain
    });
    const lines = shadowLines('on');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].baseline.worker, 'claude'); // the ladder still ran as baseline
    assert.ok(!JSON.stringify(lines[0]).includes(USER_TEXT), 'no turn text in the shadow line');
  });

  it('fail-open paths return the LADDER worker and each writes ONE shadow line with its reason', async () => {
    // no-table (code turn in peak -> ladder picks claude)
    const noTable = await run({}, { enabled: true, deprecate_pins: false, shadow_path: shadowPath('notable') });
    assert.deepEqual(noTable, { worker: 'claude' });
    const ntLines = shadowLines('notable');
    assert.equal(ntLines.length, 1);
    assert.equal(ntLines[0].reason, 'no-table');

    // nothing-available
    const none = await run(
      { args: { routerAvailability: async () => false } },
      { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('none') },
    );
    assert.deepEqual(none, { worker: 'claude' });
    const noneLines = shadowLines('none');
    assert.equal(noneLines.length, 1);
    assert.equal(noneLines[0].reason, 'nothing-available');

    // classify-failed
    const bad = await run(
      { args: { routerAsk: async () => ({ ok: false as const, answers: {}, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0 }) } },
      { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('badask') },
    );
    assert.deepEqual(bad, { worker: 'claude' });
    const badLines = shadowLines('badask');
    assert.equal(badLines.length, 1);
    assert.equal(badLines[0].reason, 'classify-failed');
  });

  it('enabled-mode: a config-read fault marks availability false — fail-open is the LADDER worker', async () => {
    // PA_HOME has NO config.yaml -> loadConfig throws inside routeTurn's
    // defaultAvailability -> the catch returns FALSE (unknown is never
    // guessed available) -> 'nothing-available' -> the ladder's worker.
    const r = await run(
      { args: { routerAvailability: undefined } },
      { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('avfail') },
    );
    assert.deepEqual(r, { worker: 'claude' });
    const lines = shadowLines('avfail');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'nothing-available');
  });

  it('flag OFF + router fail-open keeps the LADDER worker (dispatch never changes)', async () => {
    const r = await run(
      { args: { routerAvailability: async () => false } },
      { enabled: false, table: TABLE, shadow_path: shadowPath('offfail') },
    );
    assert.deepEqual(r, { worker: 'claude' });
    // The fail-open reason is still shadowed — fail-open lines accrue too.
    const lines = shadowLines('offfail');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'nothing-available');
  });

  it('resolveTurnRouting never throws even when the router seam explodes', async () => {
    const r = await run(
      { args: { routerAsk: async () => { throw new Error('boom'); } } },
      { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('boom') },
    );
    assert.deepEqual(r, { worker: 'claude' });
    const lines = shadowLines('boom');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'classify-failed');
  });

  it('voice-inbox turn: the router input carries store voice-inbox, threadId, conversationKey', async () => {
    let seen: any;
    const r = await run(
      {
        args: {
          userText: `[Voice task vi-0123456789ab] please look. ${USER_TEXT}`,
          readVoiceTaskRequests: (ids: readonly string[]) =>
            new Map([[ids[0], { source: 'text', requestText: 'ledger request text', transcript: null } as any]]),
          routeTurnFn: (input: any) => {
            seen = input;
            return {
              outcome: 'routed' as const,
              reason: 'table-rank',
              chosen: { worker: 'codex', model: 'm', effort: 'high', outcome: 'applied' },
            };
          },
        },
      },
      { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('vi') },
    );
    assert.equal(seen.store, 'voice-inbox');
    assert.equal(seen.text, 'ledger request text');
    assert.equal(seen.threadId, '5001');
    assert.equal(seen.conversationKey, '123_5001');
    assert.deepEqual(r, { worker: 'codex', model: 'm', effort: 'high', projectionOutcome: 'applied' });
  });

  it('applyRoutingPolicy delegates to resolveTurnRouting (returns the result worker)', async () => {
    const worker = await applyRoutingPolicy(
      {
        config: {
          routing_policy: POLICY,
          workers: WORKERS,
          model_router: { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('del') },
        },
        topicKey: '123_5001',
        userText: USER_TEXT,
        baselineDefault: 'agy',
        configuredDefault: 'agy',
        now: IN_PEAK,
        judgeRunner: async () => undefined,
        routerAsk: routerAskOk,
        routerAvailability: async () => true,
      } as any,
      'agy',
    );
    assert.equal(worker, 'codex');
  });
});

// Conversation stickiness (intent decision 19): the incumbent worker — the
// `worker` field on the newest archive turn for the thread — is KEPT while a
// table row for it satisfies the classified need and it is available. The
// routerAsk stub classifies every turn below as deep_reasoning/4. Escapes:
// unsatisfiable (need exceeds the envelope), unavailable (cooling down),
// peak-zai-last (a non-z.ai row satisfies inside the peak window). Stubs ride
// the routerReadContext/routerAvailability seams — no live file access.
describe('conversation stickiness (decision 19)', () => {
  // Wed 12:00Z — outside the default 06:00-10:00Z peak window.
  const OFF_PEAK = new Date('2026-08-19T12:00:00Z');

  // agy ranks FIRST; claude's row satisfies deep_reasoning/4 exactly.
  const STICK_TABLE = [
    { worker: 'agy', model: 'agy-m', max_tier: 'rich_toolchain' as const, max_score: 5 as const },
    { worker: 'claude', model: 'claude-m', max_tier: 'deep_reasoning' as const, max_score: 4 as const },
  ];
  // zclaude ranks FIRST; agy is the non-z.ai alternative.
  const ZAI_TABLE = [
    { worker: 'zclaude', model: 'zai-m', max_tier: 'rich_toolchain' as const, max_score: 5 as const },
    { worker: 'agy', model: 'agy-m', max_tier: 'rich_toolchain' as const, max_score: 5 as const },
  ];

  // readContext is SYNC (readTurnContext's signature) — a plain function,
  // never async.
  const incumbent = (worker?: string) => () =>
    ({ priorTurns: [], ...(worker ? { incumbentWorker: worker } : {}) });

  it('a. incumbent satisfying + available -> incumbent picked even when the table ranks another first', async () => {
    const r = await run(
      { args: { routerReadContext: incumbent('claude') } },
      { enabled: true, table: STICK_TABLE, shadow_path: shadowPath('stick-a') },
    );
    assert.deepEqual(r, {
      worker: 'claude',      // kept — NOT agy despite rank-1
      model: 'claude-m',     // earliest satisfying incumbent row re-picks the model
      effort: 'high',        // effort still re-projects per turn: score 4 -> high on claude
      projectionOutcome: 'applied',
      tier: 'deep_reasoning', // integrator seam (2026-09-20): needs pass through for the placement carry
      score: 4,
      chain: ['claude', 'agy'], // WP-1: sticky keep REORDERS the chain incumbent-first, never drops the rest
    });
    const l = shadowLines('stick-a');
    assert.equal(l.length, 1);
    assert.equal(l[0].reason, 'sticky-keep');
    assert.equal(l[0].sticky, true);
    assert.equal(l[0].stickBreakReason, undefined);
  });

  it('b. needs exceeding the incumbent envelope -> normal resolve, stickBreakReason unsatisfiable', async () => {
    const r = await run(
      { args: { routerReadContext: incumbent('claude') } },
      {
        enabled: true,
        table: [
          { worker: 'agy', max_tier: 'rich_toolchain' as const, max_score: 5 as const },
          // claude's only row cannot express deep_reasoning/4.
          { worker: 'claude', max_tier: 'quick_lookup' as const, max_score: 1 as const },
        ],
        shadow_path: shadowPath('stick-b'),
      },
    );
    assert.equal(r.worker, 'agy');
    const l = shadowLines('stick-b');
    assert.equal(l[0].sticky, false);
    assert.equal(l[0].stickBreakReason, 'unsatisfiable');
    assert.equal(l[0].reason, 'table-rank');
  });

  it('c. incumbent cooling down -> normal resolve, stickBreakReason unavailable', async () => {
    const r = await run(
      {
        args: {
          routerReadContext: incumbent('claude'),
          routerAvailability: async (w: string) => w !== 'claude',
        },
      },
      { enabled: true, table: STICK_TABLE, shadow_path: shadowPath('stick-c') },
    );
    assert.equal(r.worker, 'agy');
    const l = shadowLines('stick-c');
    assert.equal(l[0].sticky, false);
    assert.equal(l[0].stickBreakReason, 'unavailable');
  });

  it('d. peak + z.ai incumbent + non-z.ai satisfier -> non-z.ai pick; off-peak keeps the incumbent', async () => {
    const peakR = await run(
      { args: { routerReadContext: incumbent('zclaude') } },
      { enabled: true, table: ZAI_TABLE, shadow_path: shadowPath('stick-d-peak') },
    );
    assert.equal(peakR.worker, 'agy'); // decision 10 outranks continuity at peak
    const lp = shadowLines('stick-d-peak');
    assert.equal(lp[0].sticky, false);
    assert.equal(lp[0].stickBreakReason, 'peak-zai-last');

    const off = await run(
      { args: { routerReadContext: incumbent('zclaude'), now: OFF_PEAK } },
      { enabled: true, table: ZAI_TABLE, shadow_path: shadowPath('stick-d-off') },
    );
    assert.equal(off.worker, 'zclaude');
    const lo = shadowLines('stick-d-off');
    assert.equal(lo[0].sticky, true);
    assert.equal(lo[0].reason, 'sticky-keep');
  });

  it('e. no incumbent -> normal resolve unchanged', async () => {
    const r = await run(
      { args: { routerReadContext: incumbent() } },
      { enabled: true, table: STICK_TABLE, shadow_path: shadowPath('stick-e') },
    );
    assert.equal(r.worker, 'agy'); // rank-1 normal resolve
    const l = shadowLines('stick-e');
    assert.equal(l[0].sticky, false);
    assert.equal(l[0].stickBreakReason, undefined);
    assert.equal(l[0].reason, 'table-rank');
  });

  it('f. sticky:false opts out -> normal resolve even with a satisfying incumbent', async () => {
    const r = await run(
      { args: { routerReadContext: incumbent('claude') } },
      { enabled: true, sticky: false, table: STICK_TABLE, shadow_path: shadowPath('stick-f') },
    );
    assert.equal(r.worker, 'agy');
    const l = shadowLines('stick-f');
    assert.equal(l[0].sticky, false);
    assert.equal(l[0].stickBreakReason, undefined);
    assert.equal(l[0].reason, 'table-rank');
  });
});

// WP-3 (2026-09-19, router-as-orchestrator spec §5/§6 + §1.3 pass-through):
// the deprecate-pins gate (decision 25 — absent + block present = TRUE) and the
// TurnRoutingResult chain/placement/steerWait pass-through. Under the gate the
// pinned turns collapse to COMMAND turns only, the judge ladder never runs
// (exactly ONE TypeSafe ask), and the fail-open floor is the FIRST CONFIGURED
// worker (I-4), never a ladder re-run.
describe('deprecate-pins gate + chain/placement/steerWait pass-through (WP-3)', () => {
  const judgeSpy = (judged: string[]) => async (text: string) => { judged.push(text); return undefined; };

  it('deprecate_pins: true turns a PINNED turn into a routed one — the ladder never runs (one ask)', async () => {
    const judged: string[] = [];
    let asks = 0;
    const r = await run(
      {
        args: {
          preferredWorker: 'codex',
          judgeRunner: judgeSpy(judged),
          routerAsk: async () => { asks += 1; return routerAskOk(); },
        },
      },
      { enabled: true, table: TABLE, deprecate_pins: true, shadow_path: shadowPath('dp-pin') },
    );
    assert.deepEqual(r, {
      worker: 'codex',
      model: 'codex-router-model',
      effort: 'medium',
      projectionOutcome: 'applied',
      tier: 'deep_reasoning', // integrator seam (2026-09-20): needs pass through for the placement carry
      score: 4,
      chain: ['codex'],
    });
    assert.deepEqual(judged, [], 'the judge ladder never runs on a routed turn (§6 one-ask)');
    assert.equal(asks, 1, 'exactly ONE TypeSafe ask');
    const l = shadowLines('dp-pin');
    assert.equal(l.length, 1);
    assert.equal(l[0].pinPresent, false, 'the pin is deprecated for dispatch — the router runs unpinned');
    assert.equal(l[0].baseline.worker, 'agy', 'baseline is the FIRST CONFIGURED worker (I-4), not the ladder pick claude');
  });

  it('deprecate_pins ABSENT + block present defaults ON: a same-turn mutation routes and a fail-open returns the FIRST CONFIGURED worker', async () => {
    // The mutated default 'codex' is a deprecated surface under the flag; the
    // router fails open; floor = WORKERS[0] 'agy' — NOT the ladder's peak pick
    // 'claude' and NOT the mutated default 'codex'.
    const judged: string[] = [];
    const r = await run(
      { args: { routerAvailability: async () => false, judgeRunner: judgeSpy(judged) } },
      { enabled: true, table: TABLE, shadow_path: shadowPath('dp-open') },
      'codex',
    );
    assert.deepEqual(r, { worker: 'agy' });
    assert.deepEqual(judged, [], 'fail-open under the flag never re-runs the ladder');
    const l = shadowLines('dp-open');
    assert.equal(l.length, 1);
    assert.equal(l[0].reason, 'nothing-available');
    assert.equal(l[0].baseline.worker, 'agy');
  });

  it('deprecate_pins: false keeps the pinned turn shadow-only (today byte-for-byte)', async () => {
    const judged: string[] = [];
    const r = await run(
      { args: { preferredWorker: 'codex', judgeRunner: judgeSpy(judged) } },
      { enabled: true, table: TABLE, deprecate_pins: false, shadow_path: shadowPath('dp-off') },
    );
    assert.deepEqual(r, { worker: 'agy' });
    const l = shadowLines('dp-off');
    assert.equal(l.length, 1);
    assert.equal(l[0].pinPresent, true);
  });

  it('a command turn stays on the pinned path even under the flag (shadow-only, verbatim)', async () => {
    const judged: string[] = [];
    const r = await run(
      { args: { userText: '/status', judgeRunner: judgeSpy(judged) } },
      { enabled: true, table: TABLE, shadow_path: shadowPath('dp-cmd') },
    );
    assert.deepEqual(r, { worker: 'agy' });
    const l = shadowLines('dp-cmd');
    assert.equal(l.length, 1);
    assert.equal(l[0].pinPresent, true);
  });

  it('a routed turn passes chain (as worker names), tier/score, placement and steerWait through', async () => {
    const r = await run(
      {
        args: {
          routeTurnFn: async () => ({
            outcome: 'routed' as const,
            reason: 'table-rank',
            chosen: { worker: 'codex', model: 'm', effort: 'high', outcome: 'applied' },
            tier: 'deep_reasoning' as const,
            score: 4 as const,
            chain: [{ worker: 'codex', p: 0.7 }, { worker: 'claude' }, { worker: 'agy', p: 0.2 }],
            placement: { choice: 'other' as const, targets: ['vi-0123456789ab'], focus: [] },
            steerWait: { inflight: true, decision: 'wait' as const },
          }),
        },
      },
      { enabled: true, table: TABLE, shadow_path: shadowPath('dp-chain') },
    );
    assert.deepEqual(r, {
      worker: 'codex',
      model: 'm',
      effort: 'high',
      projectionOutcome: 'applied',
      tier: 'deep_reasoning', // integrator seam (2026-09-20): needs ride the placement carry
      score: 4,
      chain: ['codex', 'claude', 'agy'],
      placement: { choice: 'other', targets: ['vi-0123456789ab'], focus: [] },
      steerWait: { inflight: true, decision: 'wait' },
    });
  });

  it('a fail-open turn carries NO chain/placement/steerWait (static chain at the seam)', async () => {
    const r = await run(
      { args: { routerAvailability: async () => false } },
      { enabled: true, table: TABLE, shadow_path: shadowPath('dp-openplain') },
    );
    assert.deepEqual(r, { worker: 'agy' }, 'deepEqual pins the absence of every optional field');
  });

  it('candidates/currentInflight args are forwarded into the router input verbatim (empty candidates included)', async () => {
    const seen: any[] = [];
    const candidates: Array<{ id: string; goal: string; status: string; inflight: boolean }> = [
      { id: 'vi-0123456789ab', goal: 'g', status: 'running', inflight: true },
    ];
    const currentInflight = [{ id: 't-7', title: 'T', status: 'running' }];
    await run(
      {
        args: {
          routeTurnFn: async (input: any) => { seen.push(input); return { outcome: 'routed' as const, reason: 'table-rank', chosen: { worker: 'codex' } }; },
          candidates,
          currentInflight,
        },
      },
      { enabled: true, table: TABLE, shadow_path: shadowPath('dp-inputs') },
    );
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].candidates, candidates, 'present list forwarded verbatim');
    assert.deepEqual(seen[0].currentInflight, currentInflight);
    // The empty case must STAY present — the placement question is asked
    // whenever candidates is present, even with nothing to offer.
    await run(
      {
        args: {
          routeTurnFn: async (input: any) => { seen.push(input); return { outcome: 'routed' as const, reason: 'table-rank', chosen: { worker: 'codex' } }; },
          candidates: [],
        },
      },
      { enabled: true, table: TABLE, shadow_path: shadowPath('dp-inputs') },
    );
    assert.deepEqual(seen[1].candidates, [], 'empty candidates still forwarded (present, not collapsed)');
    assert.equal(seen[1].currentInflight, undefined, 'absent stays absent');
  });
});

// Router-metadata wave WP-2 (2026-09-20, decision 31): source pins on the
// main.ts dispatch site — the metadata derivation lives INLINE there (it reads
// turn-scoped facts no seam exposes), so the wiring is pinned the way the
// poll-loop-detached-tracking tests pin theirs: on the source text.
describe('router-metadata dispatch-site source pins (WP-2)', () => {
  const mainSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'main.ts'), 'utf8');

  it('the dispatch site builds the routing env from the single pure producer', () => {
    assert.ok(
      mainSrc.includes('const routingEnv = buildRoutingProvenanceEnv(routingMeta);'),
      'the env must be built ONCE, before the dispatch ternary, by buildRoutingProvenanceEnv',
    );
    assert.ok(
      mainSrc.includes('deriveTurnRoutingDecision(userText, routerTurn)'),
      'the decision derives from the pure table, not an inline conditional',
    );
  });

  it('the dispatch site passes routingEnv to BOTH lanes', () => {
    assert.ok(
      mainSrc.includes('routingEnv,'),
      'the orchestrator lane (dispatchOrchestratorTurn args) receives routingEnv',
    );
    assert.ok(
      mainSrc.includes('routedTurn, routingEnv));'),
      'the human lane (dispatchMessage trailing param) receives routingEnv',
    );
  });

  it('injectPlacementTurn carries originRouting (ids only) for the destination leg', () => {
    assert.ok(mainSrc.includes('originRouting'), 'the extended carry is wired');
    assert.ok(
      mainSrc.includes("kind: decision.kind === 'split' ? 'split' : part.kind,"),
      'the carried kind covers move/create AND the split collapse',
    );
    assert.ok(
      mainSrc.includes("c.routedTo === topicKey)?.conversationId"),
      'the ORIGIN conversation id resolves by reverse lookup (routedTo === origin topic key)',
    );
  });

  it('the operator /steer continuation is marked at the fold site for the steerBy stamp', () => {
    assert.ok(
      mainSrc.includes('(update as any).__operatorSteer = true;'),
      'the queue-entry steerContext fold stamps the marker the dispatch site reads',
    );
  });
});
