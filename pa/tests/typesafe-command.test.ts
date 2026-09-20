import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { typesafeCommand, TYPESAFE_USAGE, TYPESAFE_CHECK_STATE } from '../src/commands/typesafe.js';
import type { TypeSafeRequest, TypeSafeResult } from '../src/lib/typesafe-client.js';
import type { EvalDeps, EvalOptions } from '../src/lib/typesafe-routing-eval.js';
import type { JudgeEvalDeps, JudgeEvalOptions } from '../src/lib/typesafe-judge-eval.js';

function collectingPrint(): { print: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { print: (line: string) => lines.push(line), lines };
}

describe('typesafeCommand', () => {
  it('an unknown subcommand or --help prints usage, exits 2 and sends nothing', async () => {
    const cases: string[][] = [[], ['help'], ['check', '--help'], ['eval', '--help'], ['check', '--samples', '0']];
    for (const args of cases) {
      const { print, lines } = collectingPrint();
      let askCalls = 0;
      let runEvalCalls = 0;
      const code = await typesafeCommand(args, {
        print,
        ask: async () => {
          askCalls += 1;
          return { ok: false, error: 'no-key', latencyMs: 0, retries: 0 } satisfies TypeSafeResult;
        },
        runEval: async () => {
          runEvalCalls += 1;
          return 0;
        },
      });
      assert.equal(code, 2, `args=${JSON.stringify(args)}`);
      assert.ok(
        lines[lines.length - 1].startsWith('Usage: pa typesafe check'),
        `args=${JSON.stringify(args)} lines=${JSON.stringify(lines)}`
      );
      assert.equal(askCalls, 0, `args=${JSON.stringify(args)}`);
      assert.equal(runEvalCalls, 0, `args=${JSON.stringify(args)}`);
    }
    assert.equal(TYPESAFE_USAGE.startsWith('Usage: pa typesafe check'), true);
  });

  it('check without a key exits 1 and sends nothing', async () => {
    const { print, lines } = collectingPrint();
    let askCalls = 0;
    const code = await typesafeCommand(['check'], {
      print,
      configured: () => false,
      ask: async () => {
        askCalls += 1;
        return { ok: false, error: 'no-key', latencyMs: 0, retries: 0 } satisfies TypeSafeResult;
      },
    });
    assert.equal(code, 1);
    assert.equal(askCalls, 0);
    assert.ok(lines.some((l) => l.includes('nothing was sent')));
  });

  it('check prints one line per sample and a latency summary', async () => {
    const { print, lines } = collectingPrint();
    const latencies = [30, 10, 20];
    let call = 0;
    const seenQuestionIds: string[][] = [];
    const seenStates: unknown[] = [];
    const code = await typesafeCommand(['check', '--samples', '3'], {
      print,
      configured: () => true,
      ask: async (request: TypeSafeRequest) => {
        seenQuestionIds.push(Object.keys(request.questions));
        seenStates.push(request.state);
        const latencyMs = latencies[call];
        call += 1;
        return {
          ok: true,
          answers: {
            request_class: { type: 'choice', choice: 'general', probabilities: { code: 0.1, general: 0.9 }, confidence: 0.9 },
          },
          usage: { inputTokens: 42, outputTokens: 3 },
          latencyMs,
          status: 200,
          retries: 0,
        } satisfies TypeSafeResult;
      },
    });
    assert.equal(code, 0);
    assert.equal(lines.length, 4);
    assert.ok(lines[0].startsWith('sample 1: status=ok http=200 latency_ms=30 input_tokens='));
    assert.ok(lines[1].startsWith('sample 2: status=ok http=200 latency_ms=10 input_tokens='));
    assert.ok(lines[2].startsWith('sample 3: status=ok http=200 latency_ms=20 input_tokens='));
    assert.equal(lines[3], 'typesafe: ok samples=3 latency_ms p50=20 max=30');
    for (const ids of seenQuestionIds) assert.deepEqual(ids, ['request_class']);
    for (const s of seenStates) assert.deepEqual(s, TYPESAFE_CHECK_STATE);
  });

  it('check stops at the first API error with exit 1', async () => {
    const { print, lines } = collectingPrint();
    let askCalls = 0;
    const code = await typesafeCommand(['check'], {
      print,
      configured: () => true,
      ask: async () => {
        askCalls += 1;
        return { ok: false, error: 'http', status: 401, latencyMs: 9, retries: 0 } satisfies TypeSafeResult;
      },
    });
    assert.equal(code, 1);
    assert.equal(lines[0], 'sample 1: status=error error=http http=401 latency_ms=9');
    assert.equal(askCalls, 1);
  });

  it('eval parses its flags and passes them to the eval run', async () => {
    const { print } = collectingPrint();
    let received: EvalOptions | undefined;
    let receivedDeps: EvalDeps | undefined;
    const code = await typesafeCommand(
      ['eval', '--since', '2026-09-01', '--limit', '5', '--dry-run', '--out', 'C:/x.jsonl'],
      {
        print,
        runEval: async (opts: EvalOptions, deps: EvalDeps) => {
          received = opts;
          receivedDeps = deps;
          return 0;
        },
      }
    );
    assert.equal(code, 0);
    assert.deepEqual(received, { dryRun: true, sinceIso: '2026-09-01T00:00:00.000Z', limit: 5, outPath: 'C:/x.jsonl' });
    assert.equal(typeof receivedDeps?.print, 'function');
  });

  it('eval --judge parses its flags and passes them to the judge eval run', async () => {
    const { print } = collectingPrint();
    const received: JudgeEvalOptions[] = [];
    let receivedDeps: JudgeEvalDeps | undefined;
    let runEvalCalls = 0;
    const deps = {
      print,
      runEval: async () => {
        runEvalCalls += 1;
        return 0;
      },
      runJudgeEval: async (opts: JudgeEvalOptions, d: JudgeEvalDeps) => {
        received.push(opts);
        receivedDeps = d;
        return 0;
      },
    };
    const full = ['eval', '--judge', '--since', '2026-09-01', '--until', '2026-09-10', '--limit', '40', '--agy', '0', '--labels-only', '--dry-run', '--out', 'C:/j.jsonl'];
    assert.equal(await typesafeCommand(full, deps), 0);
    assert.equal(await typesafeCommand(['eval', '--judge'], deps), 0);
    assert.deepEqual(received, [
      { limit: 40, agy: 0, dryRun: true, labelsOnly: true, sinceIso: '2026-09-01T00:00:00.000Z', untilIso: '2026-09-10T00:00:00.000Z', outPath: 'C:/j.jsonl' },
      { limit: 150, agy: 10, dryRun: false, labelsOnly: false },
    ]);
    assert.equal(runEvalCalls, 0);
    assert.equal(typeof receivedDeps?.print, 'function');
  });

  it('eval --judge rejects out-of-range values and prints usage', async () => {
    const cases: string[][] = [
      ['eval', '--judge', '--limit', '401'],
      ['eval', '--judge', '--limit', '0'],
      ['eval', '--judge', '--agy', '31'],
      ['eval', '--judge', '--since', '2026-13-45'],
      ['eval', '--labels-only'],
    ];
    for (const args of cases) {
      const { print, lines } = collectingPrint();
      let calls = 0;
      const code = await typesafeCommand(args, {
        print,
        runEval: async () => {
          calls += 1;
          return 0;
        },
        runJudgeEval: async () => {
          calls += 1;
          return 0;
        },
      });
      assert.equal(code, 2, `args=${JSON.stringify(args)}`);
      assert.equal(calls, 0, `args=${JSON.stringify(args)}`);
      assert.ok(lines[lines.length - 1].startsWith('Usage: pa typesafe check'), `args=${JSON.stringify(args)}`);
    }
  });
});
