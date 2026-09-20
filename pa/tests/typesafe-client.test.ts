import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askSystemOne,
  isTypeSafeConfigured,
  resolveTypeSafeApiKey,
  resetTypeSafeClientState,
  renderTypeSafeCriterion,
  type TypeSafeRequest,
} from '../src/lib/typesafe-client.js';

interface LogCall {
  level: string;
  module: string;
  message: string;
  ctx: Record<string, unknown>;
}

function stubFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as typeof fetch;
  return { fn, calls };
}

const REQ: TypeSafeRequest = {
  state: { request: 'SECRET-REQUEST-TEXT' },
  questions: { q: { type: 'choice' as const, instructions: 'pick', criteria: { a: 'A', b: 'B' } } },
};
const OK_BODY = {
  model: 'jev-latest',
  answers: { q: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 } },
  usage: { input_tokens: 12, output_tokens: 3 },
};

let priorPaHome: string | undefined;
let tempPaHome: string;

beforeEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_BASE_URL;
  delete process.env.TYPESAFE_TIMEOUT_MS;
  priorPaHome = process.env.PA_HOME;
  tempPaHome = mkdtempSync(join(tmpdir(), 'pa-ts-client-'));
  process.env.PA_HOME = tempPaHome;
  resetTypeSafeClientState();
});

afterEach(() => {
  if (priorPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = priorPaHome;
  rmSync(tempPaHome, { recursive: true, force: true });
  resetTypeSafeClientState();
});

describe('askSystemOne', () => {
  it('askSystemOne without a key returns no-key and never calls fetch', async () => {
    const { fn, calls } = stubFetch([{ status: 200, body: OK_BODY }]);
    const logs: LogCall[] = [];
    const result = await askSystemOne(REQ, {
      purpose: 'routing-judge',
      fetchFn: fn,
      logFn: (level, module, message, ctx) => logs.push({ level, module, message, ctx: ctx ?? {} }),
    });
    assert.deepEqual(result, { ok: false, error: 'no-key', latencyMs: 0, retries: 0 });
    assert.equal(calls.length, 0);
    assert.equal(logs.length, 0);
  });

  it('askSystemOne posts model, state and questions with a Bearer header to the systemone endpoint', async () => {
    const { fn, calls } = stubFetch([{ status: 200, body: OK_BODY }]);
    const result = await askSystemOne(REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn: fn });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(calls[0].init.method, 'POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key-1');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(body.state, REQ.state);
    assert.deepEqual(body.questions, REQ.questions);
  });

  it('askSystemOne parses a choice answer, probabilities, confidence and usage', async () => {
    const { fn } = stubFetch([{ status: 200, body: OK_BODY }]);
    const result = await askSystemOne(REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn: fn });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.answers.q, { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 });
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
    assert.equal(result.status, 200);
    assert.equal(result.retries, 0);
  });

  it('askSystemOne returns HTTP 500 as a failure and never invents an answer', async () => {
    const { fn, calls } = stubFetch([{ status: 500 }, { status: 500 }]);
    const sleeps: number[] = [];
    const result = await askSystemOne(REQ, {
      purpose: 'routing-judge',
      apiKey: 'test-key-1',
      fetchFn: fn,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'http');
    assert.equal(result.status, 500);
    assert.equal('answers' in result, false);
    assert.equal(calls.length, 2);
    assert.equal(result.retries, 1);
  });

  it('askSystemOne retries a 429 once after retry-after-ms and succeeds', async () => {
    const { fn, calls } = stubFetch([{ status: 429, headers: { 'retry-after-ms': '120' } }, { status: 200, body: OK_BODY }]);
    const sleeps: number[] = [];
    const result = await askSystemOne(REQ, {
      purpose: 'routing-judge',
      apiKey: 'test-key-1',
      fetchFn: fn,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.retries, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [120]);
  });

  it('askSystemOne never retries 401 or 422', async () => {
    {
      const { fn, calls } = stubFetch([{ status: 401 }]);
      const result = await askSystemOne(REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn: fn });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, 'http');
        assert.equal(result.status, 401);
      }
      assert.equal(calls.length, 1);
    }
    {
      const { fn, calls } = stubFetch([{ status: 422 }]);
      const result = await askSystemOne(REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn: fn });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error, 'http');
        assert.equal(result.status, 422);
      }
      assert.equal(calls.length, 1);
    }
  });

  it('askSystemOne maps an aborted request to timeout within the budget', async () => {
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as typeof fetch;
    const result = await askSystemOne(REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn, timeoutMs: 30 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'timeout');
  });

  it('askSystemOne rejects an answer whose choice is not a listed option as invalid-response', async () => {
    const badBody = { ...OK_BODY, answers: { q: { type: 'choice', choice: 'zzz', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.8 } } };
    const { fn } = stubFetch([{ status: 200, body: badBody }]);
    const result = await askSystemOne(REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn: fn });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, 'invalid-response');
      assert.equal(result.status, 200);
    }
  });

  it('three consecutive failures open the circuit breaker until it expires', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key-2';
    let t = 1_000_000;
    const nowFn = () => t;
    for (let i = 0; i < 3; i++) {
      const { fn, calls } = stubFetch([{ status: 401 }]);
      const result = await askSystemOne(REQ, { purpose: 'routing-judge', fetchFn: fn, nowFn });
      assert.equal(result.ok, false);
      assert.equal(calls.length, 1);
    }
    assert.equal(isTypeSafeConfigured(t), false);
    const { fn: fn2, calls: calls2 } = stubFetch([{ status: 200, body: OK_BODY }]);
    const fourth = await askSystemOne(REQ, { purpose: 'routing-judge', fetchFn: fn2, nowFn });
    assert.equal(fourth.ok, false);
    if (!fourth.ok) assert.equal(fourth.error, 'circuit-open');
    assert.equal(calls2.length, 0);
    t += 120_000 + 1;
    assert.equal(isTypeSafeConfigured(t), true);
  });

  it('resolveTypeSafeApiKey reads secrets.env when the environment has no key', () => {
    writeFileSync(join(tempPaHome, 'secrets.env'), 'TYPESAFE_API_KEY="from-file-123456"\n');
    assert.equal(resolveTypeSafeApiKey(), 'from-file-123456');
    assert.equal(isTypeSafeConfigured(), true);
  });

  it('the call log line carries ids, confidence and latency but never the state text or the key', async () => {
    const { fn } = stubFetch([{ status: 200, body: OK_BODY }]);
    const logs: LogCall[] = [];
    const result = await askSystemOne(REQ, {
      purpose: 'routing-judge',
      apiKey: 'test-key-SECRET9',
      fetchFn: fn,
      logFn: (level, module, message, ctx) => logs.push({ level, module, message, ctx: ctx ?? {} }),
    });
    assert.equal(result.ok, true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].module, 'typesafe');
    assert.equal(logs[0].level, 'info');
    const serialized = JSON.stringify(logs[0]);
    assert.equal(serialized.includes('SECRET-REQUEST-TEXT'), false);
    assert.equal(serialized.includes('test-key-SECRET9'), false);
    assert.equal((logs[0].ctx.answers as Record<string, { choice: string }>).q.choice, 'a');
    assert.deepEqual(logs[0].ctx.questionIds, ['q']);
    assert.equal(typeof logs[0].ctx.latencyMs, 'number');
  });

  it('a thrown fetch error is a network failure, never a throw', async () => {
    const { fn } = stubFetch([new Error('ECONNRESET')]);
    const result = await askSystemOne(REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn: fn });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, 'network');
  });
});

// Widened 2026-09-18 (typesafe judge wording tuning, JE-4): criteria may now
// be a structured {what, not_for, examples} object, not just string | null.
describe('structured Choice criteria (JE-4, 2026-09-18)', () => {
  const STRUCTURED_REQ: TypeSafeRequest = {
    state: { request: 'fix the bug' },
    questions: {
      request_class: {
        type: 'choice',
        instructions: 'pick',
        criteria: {
          code: { what: 'Software engineering work.', not_for: 'Everyday app use.', examples: ['fix the crash'] },
          general: 'Anything else.',
        },
      },
    },
  };

  it('askSystemOne serializes a structured criterion object on the wire unchanged', async () => {
    const { fn, calls } = stubFetch([{ status: 200, body: OK_BODY }]);
    await askSystemOne(STRUCTURED_REQ, { purpose: 'routing-judge', apiKey: 'test-key-1', fetchFn: fn });
    assert.equal(calls.length, 1);
    const body = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(body.questions, STRUCTURED_REQ.questions);
  });

  it('renderTypeSafeCriterion renders a plain string as-is', () => {
    assert.equal(renderTypeSafeCriterion('Anything else.'), 'Anything else.');
  });

  it('renderTypeSafeCriterion renders null as an empty string', () => {
    assert.equal(renderTypeSafeCriterion(null), '');
  });

  it('renderTypeSafeCriterion renders what/not_for/examples into readable text', () => {
    const rendered = renderTypeSafeCriterion({
      what: 'Software engineering work.',
      not_for: 'Everyday app use.',
      examples: ['fix the crash', 'why does the build fail'],
    });
    assert.equal(
      rendered,
      'Software engineering work. Not for: Everyday app use. Examples: "fix the crash", "why does the build fail"'
    );
  });

  it('renderTypeSafeCriterion renders a structured criterion with only "what"', () => {
    assert.equal(renderTypeSafeCriterion({ what: 'Software engineering work.' }), 'Software engineering work.');
  });
});
