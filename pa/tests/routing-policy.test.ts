// Model routing policy tests (2026-09-11, plans/2026-09-11-model-routing-policy.md).
// Covers: classification signals, resolution precedence (peak/off-peak, topic
// pins, unknown workers, general fallback), parseRoutingPolicy validation, and
// the lib/peak-window.ts move (re-export compat + resolvePeakWindowUtc).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequestText, resolveRoutingWorker, DEFAULT_CODE_PATTERNS, classifyWithTypeSafe, judgeWithTypeSafe, REQUEST_CLASS_QUESTION, TYPESAFE_JUDGE_STATE_MAX_CHARS } from '../src/lib/routing-policy.js';
import type { RoutingPolicyConfig } from '../src/types.js';
import { parseRoutingPolicy } from '../src/config.js';
import type { TypeSafeResult } from '../src/lib/typesafe-client.js';
// Scheduler must keep re-exporting the moved primitives (cost-tier.test.ts
// imports them from there; this pins the compat surface from this side too).
import { DEFAULT_PEAK_WINDOW_UTC, isPeakWindow, resolvePeakWindowUtc } from '../src/lib/peak-window.js';

const POLICY: RoutingPolicyConfig = {
  enabled: true,
  judge: 'deterministic',
  general_worker: 'agy',
  code_worker: 'zclaude',
  peak_code_worker: 'claude',
};
const WORKERS = ['agy', 'codex', 'zclaude', 'claude'];

// Wed 2026-08-19: 07:00Z = 12:30 IST (inside peak), 12:00Z = 17:30 IST (outside).
const IN_PEAK = new Date('2026-08-19T07:00:00Z');
const OUT_PEAK = new Date('2026-08-19T12:00:00Z');
const SATURDAY = new Date('2026-08-22T07:00:00Z'); // weekend: never peak

async function resolve(text: string, opts: Partial<Parameters<typeof resolveRoutingWorker>[1]> = {}, policy: RoutingPolicyConfig = POLICY) {
  return await resolveRoutingWorker(policy, {
    topicKey: '123_0',
    text,
    workerNames: WORKERS,
    ...opts,
  });
}

describe('classifyRequestText', () => {
  it('code: fix + bug', () => {
    assert.equal(classifyRequestText('the dispatcher crashes on empty input, fix this bug', POLICY), 'code');
  });
  it('code: implement + code noun', () => {
    assert.equal(classifyRequestText('implement a retry function for the poller', POLICY), 'code');
  });
  it('code: code file extension', () => {
    assert.equal(classifyRequestText('look at worker-exec.ts line 40', POLICY), 'code');
  });
  it('code: refactor/typescript', () => {
    assert.equal(classifyRequestText('refactor the typescript parser into two modules', POLICY), 'code');
  });
  it('general: scheduling ask', () => {
    assert.equal(classifyRequestText('remind me to call the bank at 4pm', POLICY), 'general');
  });
  it('general: fix without a code noun', () => {
    assert.equal(classifyRequestText('fix my meeting schedule', POLICY), 'general');
  });
  it('general: plain question', () => {
    assert.equal(classifyRequestText('what did the doctor say about fasting?', POLICY), 'general');
  });
  it('custom patterns are appended', () => {
    const p: RoutingPolicyConfig = { enabled: true, code_patterns: ['\\bspreadsheet\\b'] };
    assert.equal(classifyRequestText('update the spreadsheet macro', p), 'code');
  });
});

describe('resolveRoutingWorker', () => {
  it('code turn outside peak → code_worker', async () => {
    const d = await resolve('fix this bug in the parser', { now: OUT_PEAK });
    assert.equal(d.requestClass, 'code');
    assert.equal(d.peak, false);
    assert.equal(d.worker, 'zclaude');
  });
  it('code turn inside peak → peak_code_worker', async () => {
    const d = await resolve('fix this bug in the parser', { now: IN_PEAK });
    assert.equal(d.requestClass, 'code');
    assert.equal(d.peak, true);
    assert.equal(d.worker, 'claude');
  });
  it('weekend code turn is never peak', async () => {
    const d = await resolve('fix this bug in the parser', { now: SATURDAY });
    assert.equal(d.peak, false);
    assert.equal(d.worker, 'zclaude');
  });
  it('general turn keeps the topic default', async () => {
    const d = await resolve('remind me to call the bank', { now: IN_PEAK, topicDefault: 'claude' });
    assert.equal(d.requestClass, 'general');
    assert.equal(d.worker, undefined);
  });
  it('general turn on a topic with no default → general_worker', async () => {
    const d = await resolve('remind me to call the bank', { now: IN_PEAK });
    assert.equal(d.worker, 'agy');
  });
  it('general turn with a default ignores general_worker', async () => {
    const d = await resolve('remind me to call the bank', { now: IN_PEAK, topicDefault: 'claude' });
    assert.equal(d.worker, undefined);
  });
  it('topic_classes code pin forces the time-window worker', async () => {
    const policy: RoutingPolicyConfig = { ...POLICY, topic_classes: { '123_0': 'code' } };
    const d = await resolve('hello', { now: OUT_PEAK }, policy);
    assert.equal(d.requestClass, 'code');
    assert.equal(d.worker, 'zclaude');
  });
  it('topic_classes general pin forces no override even on code text', async () => {
    const policy: RoutingPolicyConfig = { ...POLICY, topic_classes: { '123_0': 'general' } };
    const d = await resolve('fix this bug', { now: OUT_PEAK, topicDefault: 'codex' }, policy);
    assert.equal(d.worker, undefined);
  });
  it('topic_classes off excludes the topic entirely', async () => {
    const policy: RoutingPolicyConfig = { ...POLICY, topic_classes: { '123_0': 'off' } };
    const d = await resolve('fix this bug', { now: OUT_PEAK }, policy);
    assert.equal(d.worker, undefined);
  });
  it('unknown code_worker fails open to no override', async () => {
    const policy: RoutingPolicyConfig = { ...POLICY, code_worker: 'typo' };
    const d = await resolve('fix this bug', { now: OUT_PEAK }, policy);
    assert.equal(d.worker, undefined);
  });
  it('missing code_worker fails open', async () => {
    const policy: RoutingPolicyConfig = { enabled: true, judge: 'deterministic' };
    const d = await resolve('fix this bug', { now: OUT_PEAK }, policy);
    assert.equal(d.worker, undefined);
  });
  it('honors a custom peak window from cost_tier', async () => {
    // Custom window makes 12:00Z Wed peak (hours 10-14 UTC, all days).
    const d = await resolveRoutingWorker(POLICY, {
      topicKey: '123_0',
      text: 'fix this bug',
      now: new Date('2026-08-19T12:00:00Z'),
      workerNames: WORKERS,
      costTier: { peak_window_utc: { days: [0, 1, 2, 3, 4, 5, 6], start_hour: 10, end_hour: 14 } },
    });
    assert.equal(d.peak, true);
    assert.equal(d.worker, 'claude');
  });
  it('AGY judge returning code via judgeRunner overrides even without code keywords', async () => {
    const agyPolicy: RoutingPolicyConfig = { ...POLICY, judge: 'agy' };
    const d = await resolve('can you look into the auth flow edge cases', {
      now: OUT_PEAK,
      judgeRunner: async () => 'code',
    }, agyPolicy);
    assert.equal(d.requestClass, 'code');
    assert.equal(d.worker, 'zclaude');
  });
  it('AGY judge returning general via judgeRunner keeps default even with code keywords', async () => {
    const agyPolicy: RoutingPolicyConfig = { ...POLICY, judge: 'agy' };
    const d = await resolve('fix this bug in the parser', {
      now: OUT_PEAK,
      topicDefault: 'codex',
      judgeRunner: async () => 'general',
    }, agyPolicy);
    assert.equal(d.requestClass, 'general');
    assert.equal(d.worker, undefined);
  });
  it('AGY judge failure/timeout falls back to deterministic classifyRequestText', async () => {
    const agyPolicy: RoutingPolicyConfig = { ...POLICY, judge: 'agy' };
    // Failing runner (undefined) falls back to regex -> 'fix this bug' is code
    const d1 = await resolve('fix this bug in the parser', {
      now: OUT_PEAK,
      judgeRunner: async () => undefined,
    }, agyPolicy);
    assert.equal(d1.requestClass, 'code');
    assert.equal(d1.worker, 'zclaude');

    // Throwing runner falls back to regex -> 'hello there' is general
    const d2 = await resolve('hello there', {
      now: OUT_PEAK,
      topicDefault: 'claude',
      judgeRunner: async () => { throw new Error('timeout'); },
    }, agyPolicy);
    assert.equal(d2.requestClass, 'general');
    assert.equal(d2.worker, undefined);
  });
  it('deterministic judge skips judgeRunner', async () => {
    let runnerCalled = false;
    const detPolicy: RoutingPolicyConfig = { ...POLICY, judge: 'deterministic' };
    const d = await resolve('fix this bug in the parser', {
      now: OUT_PEAK,
      judgeRunner: async () => { runnerCalled = true; return 'general'; },
    }, detPolicy);
    assert.equal(runnerCalled, false);
    assert.equal(d.requestClass, 'code');
    assert.equal(d.worker, 'zclaude');
  });
});

describe('parseRoutingPolicy', () => {
  it('absent → undefined', () => {
    assert.equal(parseRoutingPolicy(undefined), undefined);
  });
  it('disabled → undefined', () => {
    assert.equal(parseRoutingPolicy({ enabled: false, code_worker: 'zclaude' }), undefined);
  });
  it('non-mapping → undefined', () => {
    assert.equal(parseRoutingPolicy(['x']), undefined);
  });
  it('valid block parses with trimmed names and defaults', () => {
    const p = parseRoutingPolicy({ enabled: true, code_worker: ' zclaude ', peak_code_worker: 'claude', general_worker: 'agy' });
    assert.deepEqual(p, {
      enabled: true,
      judge: 'agy',
      judge_model: 'gemini-3.6-flash-low',
      judge_timeout_ms: 20000,
      code_worker: 'zclaude',
      peak_code_worker: 'claude',
      general_worker: 'agy',
    });
  });
  it('parses custom judge, judge_model, judge_timeout_ms, judge_command', () => {
    const p = parseRoutingPolicy({
      enabled: true,
      judge: 'deterministic',
      judge_model: 'gemini-3.8-flash-high',
      judge_timeout_ms: 15000,
      judge_command: 'custom-agy',
    });
    assert.equal(p?.judge, 'deterministic');
    assert.equal(p?.judge_model, 'gemini-3.8-flash-high');
    assert.equal(p?.judge_timeout_ms, 15000);
    assert.equal(p?.judge_command, 'custom-agy');
  });
  it('invalid judge settings fall back to defaults', () => {
    const p = parseRoutingPolicy({
      enabled: true,
      judge: 'invalid-judge',
      judge_model: '  ',
      judge_timeout_ms: -5,
      judge_command: '  ',
    });
    assert.equal(p?.judge, 'agy');
    assert.equal(p?.judge_model, 'gemini-3.6-flash-low');
    assert.equal(p?.judge_timeout_ms, 20000);
    assert.equal(p?.judge_command, undefined);
  });
  it('invalid regex patterns are dropped, valid kept', () => {
    const p = parseRoutingPolicy({ enabled: true, code_patterns: ['[unclosed', '\\bspreadsheet\\b'] });
    assert.deepEqual(p?.code_patterns, ['\\bspreadsheet\\b']);
  });
  it('invalid topic_classes values are dropped', () => {
    const p = parseRoutingPolicy({ enabled: true, topic_classes: { '1_2': 'code', '3_4': 'sometimes' } });
    assert.deepEqual(p?.topic_classes, { '1_2': 'code' });
  });
});

describe('lib/peak-window move (compat + resolution)', () => {
  it('scheduler re-export matches the lib module', async () => {
    const sched = await import('../src/scheduler.js');
    assert.equal(sched.isPeakWindow, isPeakWindow);
    assert.deepEqual(sched.DEFAULT_PEAK_WINDOW_UTC, DEFAULT_PEAK_WINDOW_UTC);
  });
  it('resolvePeakWindowUtc merges partial overrides onto the default', () => {
    assert.deepEqual(resolvePeakWindowUtc(undefined), DEFAULT_PEAK_WINDOW_UTC);
    assert.deepEqual(
      resolvePeakWindowUtc({ start_hour: 5 }),
      { days: DEFAULT_PEAK_WINDOW_UTC.days, start_hour: 5, end_hour: 10 },
    );
  });
  it('built-in patterns are all valid regexes', () => {
    for (const re of DEFAULT_CODE_PATTERNS) assert.ok(re instanceof RegExp);
  });
});

describe('typesafe judge', () => {
  it('typesafe judge returning code overrides even without code keywords', async () => {
    const d = await resolve(
      'plan my week',
      { typeSafeJudge: async () => 'code', now: OUT_PEAK },
      { ...POLICY, judge: 'typesafe' },
    );
    assert.equal(d.requestClass, 'code');
    assert.equal(d.worker, 'zclaude');
  });

  it('typesafe judge failure falls back to the regex and never to agy', async () => {
    let judgeRunnerCalls = 0;
    const judgeRunner = async () => {
      judgeRunnerCalls += 1;
      throw new Error('agy must not run');
    };
    const d = await resolve(
      'fix this bug in the parser function',
      { typeSafeJudge: async () => undefined, judgeRunner },
      { ...POLICY, judge: 'typesafe' },
    );
    assert.equal(d.requestClass, 'code');
    assert.equal(judgeRunnerCalls, 0);
  });

  it('default judge never calls the typesafe judge', async () => {
    for (const judge of [undefined, 'agy' as const]) {
      let typeSafeJudgeCalls = 0;
      const typeSafeJudge = async () => {
        typeSafeJudgeCalls += 1;
        return 'code' as const;
      };
      const judgeRunner = async () => 'general' as const;
      await resolve(
        'fix this bug in the parser',
        { typeSafeJudge, judgeRunner, now: OUT_PEAK },
        { ...POLICY, judge },
      );
      assert.equal(typeSafeJudgeCalls, 0);
    }
  });

  it('parseRoutingPolicy accepts judge typesafe and keeps agy as the default', () => {
    assert.equal(parseRoutingPolicy({ enabled: true, judge: 'typesafe' })?.judge, 'typesafe');
    assert.equal(parseRoutingPolicy({ enabled: true })?.judge, 'agy');
  });

  it('sql matches as a word but not inside sqlite', () => {
    assert.equal(classifyRequestText('how big is the sqlite database on my phone', POLICY), 'general');
    assert.equal(classifyRequestText('explain this sql', POLICY), 'code');
  });

  it('classifyWithTypeSafe maps the request_class choice and fails open on any client failure', async () => {
    const askCode = async (request: unknown, opts: { purpose: string }) => {
      assert.equal(opts.purpose, 'routing-judge');
      assert.ok('request_class' in (request as { questions: Record<string, unknown> }).questions);
      return {
        ok: true,
        answers: { request_class: { type: 'choice', choice: 'code', probabilities: { code: 0.9, general: 0.1 }, confidence: 0.9 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        status: 200,
        retries: 0,
      } satisfies TypeSafeResult;
    };
    assert.equal(await classifyWithTypeSafe('fix the bug', { ask: askCode }), 'code');

    const askGeneral = async () =>
      ({
        ok: true,
        answers: { request_class: { type: 'choice', choice: 'general', probabilities: { code: 0.1, general: 0.9 }, confidence: 0.9 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        status: 200,
        retries: 0,
      }) satisfies TypeSafeResult;
    assert.equal(await classifyWithTypeSafe('remind me to call the bank', { ask: askGeneral }), 'general');

    const askFail = async () =>
      ({ ok: false, error: 'timeout', latencyMs: 0, retries: 0 }) satisfies TypeSafeResult;
    assert.equal(await classifyWithTypeSafe('anything', { ask: askFail }), undefined);
  });

  it('classifyWithTypeSafe caps the state text at 4000 chars', async () => {
    const longText = 'x'.repeat(10_000);
    let capturedLength = -1;
    const ask = async (request: unknown) => {
      capturedLength = (request as { state: { request: string } }).state.request.length;
      return { ok: false, error: 'timeout', latencyMs: 0, retries: 0 } satisfies TypeSafeResult;
    };
    await classifyWithTypeSafe(longText, { ask });
    assert.equal(capturedLength, TYPESAFE_JUDGE_STATE_MAX_CHARS);
  });

  it('judgeWithTypeSafe returns the class with its confidence under the given purpose', async () => {
    const purposes: string[] = [];
    const answer = (choice: string) => async (_request: unknown, opts: { purpose: string }) => {
      purposes.push(opts.purpose);
      return {
        ok: true,
        answers: { request_class: { type: 'choice', choice, probabilities: { code: 0.17, general: 0.83 }, confidence: 0.83 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        latencyMs: 1,
        status: 200,
        retries: 0,
      } satisfies TypeSafeResult;
    };
    assert.deepEqual(
      await judgeWithTypeSafe('remind me to call the bank', { ask: answer('general'), purpose: 'typesafe-judge-eval' }),
      { requestClass: 'general', confidence: 0.83 }
    );
    assert.equal(await judgeWithTypeSafe('anything', { ask: answer('other') }), undefined);
    const askFail = async () => ({ ok: false, error: 'timeout', latencyMs: 0, retries: 0 }) satisfies TypeSafeResult;
    assert.equal(await judgeWithTypeSafe('anything', { ask: askFail }), undefined);
    assert.deepEqual(purposes, ['typesafe-judge-eval', 'routing-judge']);
  });
});

describe('REQUEST_CLASS_QUESTION (V2 wording, JE-4, 2026-09-18)', () => {
  it('exposes exactly the code and general options', () => {
    assert.deepEqual(Object.keys(REQUEST_CLASS_QUESTION.criteria).sort(), ['code', 'general']);
  });

  it('carries V2s structured criteria verbatim as measured (86% agreement)', () => {
    assert.deepEqual(REQUEST_CLASS_QUESTION.criteria.code, {
      what:
        "Software engineering work: writing, changing, debugging, testing, reviewing, building or deploying code, scripts, configuration or infrastructure; reading or investigating logs, errors, stack traces, crashes, or unexpected behavior; explaining how a program, developer tool, or THIS ASSISTANT'S OWN workers, jobs, UI, or automations behave. Includes bug reports about the assistant's own app or bot not working, and any request about the assistant's own code.",
      not_for:
        'Managing work items as items only — adding, merging, resuming, or reordering tasks, backlog entries, or conversation threads — without asking anything about the software’s behavior to be checked, fixed, or explained. Also not for asking only for a different reply format, tone, or presentation.',
      examples: [
        'fix the crash in the parser',
        'why does the build fail on Windows',
        'add a retry to the sync script',
        'who is creating these extra processes',
        'is claude rate limited, can you check',
        "the mic icon isn't showing in the app",
        'why is the dashboard button erroring',
      ],
    });
    assert.deepEqual(REQUEST_CLASS_QUESTION.criteria.general, {
      what:
        "Anything else: questions, research, planning, reminders, personal admin, writing, shopping, health, travel, and using apps or services as intended. Includes operating or organizing the assistant's own workflow itself — adding, merging, resuming, or reordering its tasks, backlog items, or threads — as long as it does not ask for the underlying software to be changed, fixed, checked, or explained.",
      not_for:
        "Reporting that the assistant's own software, UI, or a worker is broken, or asking how or why its code behaves — that is code even when it reads like an everyday complaint.",
      examples: [
        'remind me to call the bank at 4pm',
        'what did the doctor say about fasting',
        'compare these two cars',
        'resume all stuck threads',
        'add this to the backlog',
        'merge this task with that one',
      ],
    });
  });

  it('instructions include the earlier-technical-work continuation rule', () => {
    assert.match(REQUEST_CLASS_QUESTION.instructions, /continues, checks on, or is a short reply/);
  });
});
