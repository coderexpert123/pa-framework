// applyRoutingPolicy wrapper tests (2026-09-11,
// plans/2026-09-11-model-routing-policy.md): precedence + fail-open behavior
// at the bot's single integration point.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyRoutingPolicy, classifiableRequestText, isCommandTurn, resolveClassificationText } from '../routing.js';
import { classifyRequestText } from '../../../../pa/dist/src/lib/routing-policy.js';

const POLICY = {
  enabled: true as const,
  judge: 'deterministic' as const,
  general_worker: 'agy',
  code_worker: 'zclaude',
  peak_code_worker: 'claude',
};

const BASE = {
  topicKey: '123_0',
  userText: 'fix this bug in the parser',
  baselineDefault: 'agy',
  configuredDefault: undefined as string | undefined,
};

// Wed 07:00Z = inside the default peak window; 12:00Z = outside.
const IN_PEAK = new Date('2026-08-19T07:00:00Z');

type ApplyArgs = Partial<Pick<typeof BASE, 'topicKey' | 'userText' | 'baselineDefault' | 'configuredDefault'>> & {
  preferredWorker?: string;
  now?: Date;
  config?: any;
};

async function apply(args: ApplyArgs, currentDefault = 'agy'): Promise<string> {
  const { config, ...rest } = args;
  return await applyRoutingPolicy(
    {
      config: { routing_policy: POLICY, workers: [{ name: 'agy' }, { name: 'zclaude' }, { name: 'claude' }], ...config },
      now: IN_PEAK,
      ...BASE,
      ...rest,
    } as any,
    currentDefault,
  );
}

describe('applyRoutingPolicy', () => {
  it('disabled/absent policy keeps the default', async () => {
    await expectDisabled({ routing_policy: { enabled: false } });
    await expectDisabled({ routing_policy: undefined });
    async function expectDisabled(config: any) {
      assert.equal(await apply({ config }), 'agy');
    }
  });
  it('code turn inside peak overrides the default', async () => {
    assert.equal(await apply({}), 'claude');
  });
  it('general turn keeps the default', async () => {
    assert.equal(await apply({ userText: 'remind me to call the bank', configuredDefault: 'agy' }), 'agy');
  });
  it('explicit /agent pin outranks the policy', async () => {
    assert.equal(await apply({ preferredWorker: 'codex' }), 'agy');
  });
  it('a same-turn router mutation outranks the policy', async () => {
    assert.equal(await apply({}, 'codex'), 'codex');
  });
  it('policy resolving to the current default returns it unchanged', async () => {
    // Custom window: Wed 07:00Z off-peak here → code_worker zclaude == currentDefault path via different default.
    const d = await apply({ config: { routing_policy: POLICY, cost_tier: { peak_window_utc: { days: [1], start_hour: 8, end_hour: 9 } } } }, 'zclaude');
    assert.equal(d, 'zclaude');
  });
  it('fails open when the config shape is unusable', async () => {
    assert.equal(await apply({ config: { routing_policy: { enabled: true, judge: 'deterministic', code_worker: { bad: true } }, workers: [{ name: 'agy' }] } }), 'agy');
  });
});

describe('applyRoutingPolicy classifies the request, not the injection (2026-09-16)', () => {
  const VI_A = 'vi-0123456789ab';
  const VI_B = 'vi-ba9876543210';
  const GENERAL_REQUEST = 'Live check for the routing retry: reply with the single word noted.';
  const CODE_REQUEST = 'fix the crash in the parser function';
  const AGY_POLICY = { ...POLICY, judge: 'agy' as const };
  const WORKERS = [{ name: 'agy' }, { name: 'zclaude' }, { name: 'claude' }];

  /** The live target-injection shape (bridge-writer.ts buildTargetInjectionText), trimmed. */
  const injected = (id: string, request: string) =>
    `[Voice task ${id} routed from inbox — reason: operator live check] ${request}. ` +
    `This task arrives from the voice-inbox app. Run first: python "/repo/projects/voice-inbox/scripts/task_telemetry.py" start --task ${id}. ` +
    `Finish with python "/repo/projects/voice-inbox/scripts/task_complete.py" --task ${id} --summary "<the complete answer>".`;

  const textRow = (requestText: string) => ({ source: 'text', requestText, transcript: null });

  async function run(userText: string, reader: (ids: readonly string[]) => Map<string, any>, config: any = { routing_policy: AGY_POLICY, workers: WORKERS }) {
    const judged: string[] = [];
    const readCalls: string[][] = [];
    const worker = await applyRoutingPolicy({
      config,
      topicKey: '123_0',
      userText,
      baselineDefault: 'agy',
      configuredDefault: 'agy',
      now: IN_PEAK,
      judgeRunner: async (text) => { judged.push(text); return undefined; }, // undefined = regex fallback on the SAME text
      readVoiceTaskRequests: (ids) => { readCalls.push([...ids]); return reader(ids); },
    }, 'agy');
    return { worker, judged, readCalls };
  }

  it('precondition: the injection wrapper alone classifies code under the regex fallback', () => {
    assert.equal(classifyRequestText(injected(VI_A, GENERAL_REQUEST), AGY_POLICY), 'code');
    assert.equal(classifyRequestText(GENERAL_REQUEST, AGY_POLICY), 'general');
  });

  it('a general request inside a voice injection is classified general; the judge sees only the request', async () => {
    const r = await run(injected(VI_A, GENERAL_REQUEST), () => new Map([[VI_A, textRow(GENERAL_REQUEST)]]));
    assert.deepEqual(r.judged, [GENERAL_REQUEST]);
    assert.deepEqual(r.readCalls, [[VI_A]]);
    assert.equal(r.worker, 'agy');
  });

  it('a code request inside a voice injection is still classified code', async () => {
    const r = await run(injected(VI_A, CODE_REQUEST), () => new Map([[VI_A, textRow(CODE_REQUEST)]]));
    assert.deepEqual(r.judged, [CODE_REQUEST]);
    assert.equal(r.worker, 'claude');
  });

  it('no voice task id: the turn text is classified unchanged and the ledger is never read', async () => {
    const r = await run('fix this bug in the parser', () => { throw new Error('must not be called'); });
    assert.deepEqual(r.judged, ['fix this bug in the parser']);
    assert.deepEqual(r.readCalls, []);
    assert.equal(r.worker, 'claude');
  });

  it('ledger read throws: falls back to the turn text (not to the outer catch)', async () => {
    const turn = injected(VI_A, GENERAL_REQUEST);
    const r = await run(turn, () => { throw new Error('SQLITE_BUSY'); });
    assert.deepEqual(r.judged, [turn]);
    assert.equal(r.worker, 'claude'); // turn text is code; the outer catch would have kept 'agy'
  });

  it('a task id missing from the ledger falls back to the turn text', async () => {
    const turn = injected(VI_A, GENERAL_REQUEST);
    const r = await run(turn, () => new Map());
    assert.deepEqual(r.judged, [turn]);
  });

  it('a voice task not yet transcribed falls back to the turn text, never the placeholder', async () => {
    const turn = injected(VI_A, GENERAL_REQUEST);
    const r = await run(turn, () => new Map([[VI_A, { source: 'voice', requestText: '(voice recording)', transcript: null }]]));
    assert.deepEqual(r.judged, [turn]);
  });

  it('several task ids: every request, first-seen order, joined by a blank line', async () => {
    const turn = `${injected(VI_A, 'reply with hello')}\n\n[Additional instruction from the operator.] ${injected(VI_B, 'reply with bye')}`;
    const r = await run(turn, () => new Map([[VI_A, textRow('reply with hello')], [VI_B, textRow('reply with bye')]]));
    assert.deepEqual(r.readCalls, [[VI_A, VI_B]]);
    assert.deepEqual(r.judged, ['reply with hello\n\nreply with bye']);
  });

  it('a disabled policy never reads the ledger', async () => {
    const r = await run(injected(VI_A, GENERAL_REQUEST), () => new Map(), { routing_policy: { enabled: false }, workers: WORKERS });
    assert.deepEqual(r.readCalls, []);
    assert.deepEqual(r.judged, []);
  });

  it('classifiableRequestText precedence', () => {
    assert.equal(classifiableRequestText({ source: 'voice', requestText: 'cleaned', transcript: 'um raw' }), 'cleaned');
    assert.equal(classifiableRequestText({ source: 'voice', requestText: '  ', transcript: 'um raw' }), 'um raw');
    assert.equal(classifiableRequestText({ source: 'voice', requestText: '(voice recording)', transcript: null }), undefined);
    assert.equal(classifiableRequestText({ source: 'text', requestText: 'typed', transcript: null }), 'typed');
    assert.equal(classifiableRequestText({ source: 'text', requestText: '', transcript: null }), undefined);
  });

  it('resolveClassificationText reports its source and fallback reason', () => {
    assert.deepEqual(resolveClassificationText('hello', () => new Map()), { text: 'hello', source: 'turn-text', taskIds: [] });
    const t = injected(VI_A, GENERAL_REQUEST);
    const r = resolveClassificationText(t, () => new Map());
    assert.equal(r.source, 'turn-text');
    assert.equal(r.fallbackReason, `no ledger row for ${VI_A}`);
    assert.deepEqual(resolveClassificationText(t, () => new Map([[VI_A, textRow(GENERAL_REQUEST)]])),
      { text: GENERAL_REQUEST, source: 'ledger-request', taskIds: [VI_A] });
  });
});

describe('applyRoutingPolicy: command turns skip the judge (operator decision 2026-09-16)', () => {
  const AGY_POLICY = { ...POLICY, judge: 'agy' as const };
  const WORKERS = [{ name: 'agy' }, { name: 'zclaude' }, { name: 'claude' }];

  async function run(userText: string) {
    const judged: string[] = [];
    const readCalls: string[][] = [];
    const worker = await applyRoutingPolicy({
      config: { routing_policy: AGY_POLICY, workers: WORKERS },
      topicKey: '123_0',
      userText,
      baselineDefault: 'agy',
      configuredDefault: 'agy',
      now: IN_PEAK,
      judgeRunner: async (text) => { judged.push(text); return 'code'; },
      readVoiceTaskRequests: (ids) => { readCalls.push([...ids]); return new Map(); },
    }, 'agy');
    return { worker, judged, readCalls };
  }

  it('/status makes zero judge calls and keeps the incoming default', async () => {
    const r = await run('/status');
    assert.deepEqual(r.judged, []);
    assert.deepEqual(r.readCalls, []);
    assert.equal(r.worker, 'agy'); // the judge would have said code -> claude
  });

  it('a normal question still calls the judge exactly once', async () => {
    const r = await run('what is the weather tomorrow');
    assert.deepEqual(r.judged, ['what is the weather tomorrow']);
    assert.equal(r.worker, 'claude');
  });

  it('a skill pass-through command dispatches an LLM turn, so it is classified', async () => {
    const r = await run('/deep-plan refactor the parser');
    assert.deepEqual(r.judged, ['/deep-plan refactor the parser']);
  });

  it('isCommandTurn matches the router and processUpdate command forms, not dispatching text', () => {
    for (const t of ['/status', '/status@PaBot', '  /help ', '/agent claude', '/model claude', '/code /x', '/orchestrator on', '/branch x do it', '/foo', '/update_brain']) {
      assert.equal(isCommandTurn(t), true, t);
    }
    for (const t of ['what is the weather', '/deep-plan refactor the parser', '/agent claude fix the parser', '/foo bar', 'path /tmp/x']) {
      assert.equal(isCommandTurn(t), false, t);
    }
  });
});
