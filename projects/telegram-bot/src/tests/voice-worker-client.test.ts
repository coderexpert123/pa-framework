import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { closeSync, existsSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import net from 'net';
import { rmRetry } from './rm-retry.js';
import {
  voiceWorkerStatePath,
  voiceWorkerScriptPath,
  voiceWorkerLogPath,
  voiceWorkerErrorPath,
  readVoiceWorkerState,
  readWorkerStartFailure,
  pingVoiceWorker,
  probeVoiceWorker,
  ensureVoiceWorker,
  requestTranscription,
  workerSpawnOptions,
  defaultIsPidAlive,
  VoiceWorkerTimeoutError,
  type VoiceWorkerState,
  type VoiceWorkerClientDeps,
  type VoiceWorkerRequest,
} from '../voice-worker-client.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'voice-worker-client-test-'));
});

afterEach(async () => {
  await rmRetry(tempDir);
});

function makeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PA_HOME: tempDir, ...extra };
}

function statePath(env: NodeJS.ProcessEnv): string {
  return voiceWorkerStatePath(env);
}

async function writeState(env: NodeJS.ProcessEnv, state: Partial<VoiceWorkerState> & Record<string, unknown> = {}): Promise<void> {
  const full = {
    pid: process.pid,
    port: 12345,
    token: 'a'.repeat(64),
    started_at: new Date().toISOString(),
    protocol: 1,
    ...state,
  };
  await writeFile(statePath(env), JSON.stringify(full), 'utf8');
}

function makeRequest(overrides: Partial<VoiceWorkerRequest> = {}): VoiceWorkerRequest {
  return {
    audio_path: 'C:/fake/note.oga',
    engine: 'auto',
    engine_preference: 'auto',
    cloud_order: ['groq', 'openai', 'deepgram'],
    language: null,
    max_chars: 40000,
    request_id: 'req-1',
    ...overrides,
  };
}

function makeDeps(env: NodeJS.ProcessEnv, overrides: Partial<VoiceWorkerClientDeps> = {}): VoiceWorkerClientDeps {
  return {
    repoRoot: 'D:/Personal Assistant',
    env,
    ...overrides,
  };
}

/** Never sleeps for real — resolves immediately, tracking invocation count. */
function fakeSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  const fn = async (ms: number) => {
    calls.push(ms);
  };
  return { fn, calls };
}

/** A sleep function paired with a fake clock that advances in lockstep with
 * every sleep — used anywhere spawnAndWait's real-deadline loop needs to
 * terminate deterministically without an actual wall-clock wait. */
function fakeClockSleep(startMs = 0): {
  sleepFn: (ms: number) => Promise<void>;
  nowFn: () => number;
  calls: number[];
} {
  let t = startMs;
  const calls: number[] = [];
  const sleepFn = async (ms: number) => {
    calls.push(ms);
    t += ms;
  };
  return { sleepFn, nowFn: () => t, calls };
}

describe('readVoiceWorkerState', () => {
  it('returns null for a missing file', () => {
    assert.equal(readVoiceWorkerState(makeEnv()), null);
  });

  it('returns null for unparseable content', async () => {
    await writeFile(statePath(makeEnv()), '{', 'utf8');
    assert.equal(readVoiceWorkerState(makeEnv()), null);
  });

  it('returns null for an empty object (missing required fields)', async () => {
    await writeFile(statePath(makeEnv()), '{}', 'utf8');
    assert.equal(readVoiceWorkerState(makeEnv()), null);
  });

  it('returns null for an unknown protocol', async () => {
    const env = makeEnv();
    await writeState(env, { protocol: 99 });
    assert.equal(readVoiceWorkerState(env), null);
  });

  it('round-trips a valid state file', async () => {
    const env = makeEnv();
    await writeState(env, { pid: 4242, port: 9999, token: 'deadbeef' });
    const state = readVoiceWorkerState(env);
    assert.deepEqual(state, {
      pid: 4242,
      port: 9999,
      token: 'deadbeef',
      started_at: state!.started_at,
      protocol: 1,
    });
  });
});

describe('voiceWorkerScriptPath', () => {
  it('defaults to <repoRoot>/pa/scripts/voice_worker.py', () => {
    const p = voiceWorkerScriptPath(makeEnv(), 'D:/Personal Assistant');
    assert.equal(p, join('D:/Personal Assistant', 'pa', 'scripts', 'voice_worker.py'));
  });

  it('honors PA_VOICE_WORKER_SCRIPT override', () => {
    const p = voiceWorkerScriptPath(makeEnv({ PA_VOICE_WORKER_SCRIPT: 'C:/custom/worker.py' }), 'D:/Personal Assistant');
    assert.equal(p, 'C:/custom/worker.py');
  });
});

describe('defaultIsPidAlive', () => {
  it('is exported and reports the current process as alive', () => {
    assert.equal(defaultIsPidAlive(process.pid), true);
  });
});

describe('probeVoiceWorker', () => {
  it("resolves 'ok' only when both ok:true and protocol matches", async () => {
    const env = makeEnv();
    const deps = makeDeps(env, { connectFn: async () => JSON.stringify({ ok: true, protocol: 1 }) });
    const outcome = await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps);
    assert.equal(outcome, 'ok');
  });

  it("resolves 'bad-protocol' when ok:true but the protocol does not match", async () => {
    const env = makeEnv();
    const deps = makeDeps(env, { connectFn: async () => JSON.stringify({ ok: true, protocol: 2 }) });
    const outcome = await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps);
    assert.equal(outcome, 'bad-protocol');
  });

  it("resolves 'busy' on a VoiceWorkerTimeoutError", async () => {
    const env = makeEnv();
    const deps = makeDeps(env, {
      connectFn: async () => {
        throw new VoiceWorkerTimeoutError('timed out');
      },
    });
    const outcome = await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps);
    assert.equal(outcome, 'busy');
  });

  it("resolves 'refused' on a plain connection error", async () => {
    const env = makeEnv();
    const deps = makeDeps(env, {
      connectFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const outcome = await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps);
    assert.equal(outcome, 'refused');
  });

  it("resolves 'refused' when the response parses but ok is not true", async () => {
    const env = makeEnv();
    const deps = makeDeps(env, { connectFn: async () => JSON.stringify({ ok: false }) });
    const outcome = await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps);
    assert.equal(outcome, 'refused');
  });

  it('treats an already-exhausted budgetMs as busy without attempting a connection', async () => {
    const env = makeEnv();
    let connectCalls = 0;
    const deps = makeDeps(env, {
      connectFn: async () => {
        connectCalls++;
        return JSON.stringify({ ok: true, protocol: 1 });
      },
    });
    const outcome = await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps, 0);
    assert.equal(outcome, 'busy');
    assert.equal(connectCalls, 0);
  });

  it('clamps the connect timeout to budgetMs when it is smaller than the default ping timeout', async () => {
    const env = makeEnv();
    let capturedTimeout: number | undefined;
    const deps = makeDeps(env, {
      connectFn: async (_port, _payload, timeoutMs) => {
        capturedTimeout = timeoutMs;
        return JSON.stringify({ ok: true, protocol: 1 });
      },
    });
    await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps, 1234);
    assert.equal(capturedTimeout, 1234);
  });

  it('uses the default ping timeout when budgetMs is larger than it', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_PING_TIMEOUT_MS: '5000' });
    let capturedTimeout: number | undefined;
    const deps = makeDeps(env, {
      connectFn: async (_port, _payload, timeoutMs) => {
        capturedTimeout = timeoutMs;
        return JSON.stringify({ ok: true, protocol: 1 });
      },
    });
    await probeVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps, 999999);
    assert.equal(capturedTimeout, 5000);
  });
});

describe('pingVoiceWorker (wraps probeVoiceWorker)', () => {
  it('is true only for a probeVoiceWorker outcome of ok', async () => {
    const env = makeEnv();
    const deps = makeDeps(env, { connectFn: async () => JSON.stringify({ ok: true, protocol: 1 }) });
    assert.equal(await pingVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps), true);
  });

  it('is false for busy, refused, and bad-protocol alike', async () => {
    const env = makeEnv();
    for (const connectFn of [
      async () => {
        throw new VoiceWorkerTimeoutError('t');
      },
      async () => {
        throw new Error('refused');
      },
      async () => JSON.stringify({ ok: true, protocol: 99 }),
    ]) {
      const deps = makeDeps(env, { connectFn });
      assert.equal(await pingVoiceWorker({ pid: 1, port: 1, token: 't', started_at: '', protocol: 1 }, deps), false);
    }
  });
});

describe('ensureVoiceWorker', () => {
  it('returns the existing state and does not spawn when the PID is alive and ping succeeds', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 111 });
    let spawnCalls = 0;
    const deps = makeDeps(env, {
      spawnFn: () => {
        spawnCalls++;
      },
      isPidAliveFn: () => true,
      connectFn: async () => JSON.stringify({ ok: true, protocol: 1 }),
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result?.port, 111);
    assert.equal(spawnCalls, 0);
  });

  it('a ping timeout against a live PID is treated as busy: no unlink, no spawn (the core regression)', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 111 });
    let spawnCalls = 0;
    const deps = makeDeps(env, {
      spawnFn: () => {
        spawnCalls++;
      },
      isPidAliveFn: () => true,
      connectFn: async () => {
        throw new VoiceWorkerTimeoutError('timed out');
      },
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result?.port, 111);
    assert.equal(spawnCalls, 0);
    assert.notEqual(readVoiceWorkerState(env), null, 'the state file must not be unlinked on a busy worker');
  });

  it('a connection refusal against a live PID still unlinks and respawns (guards against over-broadening the busy fix)', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '500' });
    await writeState(env, { pid: process.pid, port: 111 });
    let spawnCalls = 0;
    const { sleepFn, nowFn } = fakeClockSleep();
    const deps = makeDeps(env, {
      spawnFn: () => {
        spawnCalls++;
      },
      isPidAliveFn: () => true,
      sleepFn,
      nowFn,
      connectFn: async () => {
        throw new Error('connection refused');
      },
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result, null);
    assert.equal(spawnCalls, 1);
  });

  it('unlinks and respawns when the ping succeeds but the protocol does not match (bad-protocol)', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '500' });
    await writeState(env, { pid: process.pid, port: 111 });
    let spawnCalls = 0;
    const { sleepFn, nowFn } = fakeClockSleep();
    const deps = makeDeps(env, {
      spawnFn: () => {
        spawnCalls++;
      },
      isPidAliveFn: () => true,
      sleepFn,
      nowFn,
      connectFn: async () => JSON.stringify({ ok: true, protocol: 99 }),
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result, null);
    assert.equal(spawnCalls, 1);
  });

  it('unlinks a stale file and spawns when the PID is dead', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '500' });
    await writeState(env, { pid: 99999999, port: 111 });
    let spawnCalls = 0;
    const { sleepFn, nowFn } = fakeClockSleep();
    const deps = makeDeps(env, {
      spawnFn: () => {
        spawnCalls++;
      },
      isPidAliveFn: () => false,
      sleepFn,
      nowFn,
      // Never becomes ready — we only care that spawn was attempted and the
      // stale file no longer resolves.
      connectFn: async () => {
        throw new Error('no worker');
      },
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result, null);
    assert.equal(spawnCalls, 1);
    assert.equal(readVoiceWorkerState(env), null);
  });

  it('an already-ready worker is returned without any sleep', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '5000' });
    const { fn: sleepFn, calls } = fakeSleep();
    const deps = makeDeps(env, {
      spawnFn: () => {
        // Simulates a worker fast enough to publish its state file before the
        // first poll tick — the loop must find it on its pre-sleep check.
        writeFileSync(
          statePath(env),
          JSON.stringify({ pid: process.pid, port: 555, token: 'tok', started_at: new Date().toISOString(), protocol: 1 }),
        );
      },
      sleepFn,
      connectFn: async () => JSON.stringify({ ok: true, protocol: 1 }),
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result?.port, 555);
    assert.equal(calls.length, 0);
  });

  it('spawn-then-ready: resolves once the spawned worker writes a valid state file', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '5000' });
    let attempts = 0;
    let clock = 0;
    const sleepFn = async (ms: number) => {
      attempts++;
      clock += ms;
      if (attempts === 2) {
        await writeState(env, { pid: process.pid, port: 222 });
      }
    };
    const deps = makeDeps(env, {
      spawnFn: () => {},
      sleepFn,
      nowFn: () => clock,
      connectFn: async () => JSON.stringify({ ok: true, protocol: 1 }),
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result?.port, 222);
    assert.equal(attempts, 2);
  });

  it('stops polling once the wall-clock deadline passes, not after a fixed attempt count (real-deadline fix)', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '1000' });
    const { sleepFn, nowFn, calls } = fakeClockSleep();
    const deps = makeDeps(env, {
      spawnFn: () => {},
      sleepFn,
      nowFn,
      connectFn: async () => {
        throw new Error('nobody home');
      },
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result, null);
    // 1000ms budget / 250ms poll interval -> exactly 4 sleeps before the
    // deadline is crossed, proven via real wall-clock accounting rather than
    // a hardcoded attempt-count loop (the bug: the old loop's attempt cap
    // was decoupled from actual elapsed time, allowing up to ~21 minutes in
    // practice once ping-timeout costs stacked on top of each poll interval).
    assert.equal(calls.length, 4);
  });

  it("a probe that consumes wall-clock time eats into the remaining budget instead of stacking on top of it", async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '1000' });
    const { sleepFn, nowFn } = fakeClockSleep();
    let clock = 0;
    let probeCalls = 0;
    const deps = makeDeps(env, {
      spawnFn: () => {
        // Publish state immediately so every loop iteration probes instead
        // of sleeping first.
        writeFileSync(
          statePath(env),
          JSON.stringify({ pid: process.pid, port: 111, token: 't', started_at: new Date().toISOString(), protocol: 1 }),
        );
      },
      sleepFn,
      nowFn,
      connectFn: async () => {
        probeCalls++;
        // Simulate a slow probe that itself eats 300ms of wall-clock time.
        clock += 300;
        throw new Error('refused');
      },
    });

    const result = await ensureVoiceWorker(deps);
    assert.equal(result, null);
    // Without the clamp, repeated 300ms probes could overrun the 1000ms
    // deadline; with it, the loop must stop once elapsed time crosses 1000ms
    // regardless of how many slow probes that took.
    assert.ok(probeCalls <= 4, `expected at most 4 probes within the 1000ms deadline, got ${probeCalls}`);
  });
});

describe('readWorkerStartFailure', () => {
  it('returns undefined when no error file exists', () => {
    const env = makeEnv();
    assert.equal(readWorkerStartFailure(env, 0), undefined);
  });

  it('surfaces a start failure recorded at/after sinceMs', () => {
    const env = makeEnv();
    const now = Date.now();
    writeFileSync(
      voiceWorkerErrorPath(env),
      JSON.stringify({ at: new Date(now).toISOString(), pid: 4242, error: 'bind failed', error_type: 'OSError' }),
    );

    const failure = readWorkerStartFailure(env, now - 1000);
    assert.ok(failure);
    assert.equal(failure?.error_type, 'OSError');
    assert.equal(failure?.error, 'bind failed');
  });

  it('ignores a stale error file recorded before sinceMs', () => {
    const env = makeEnv();
    const now = Date.now();
    writeFileSync(
      voiceWorkerErrorPath(env),
      JSON.stringify({ at: new Date(now - 10_000).toISOString(), pid: 4242, error: 'old failure', error_type: 'OSError' }),
    );

    assert.equal(readWorkerStartFailure(env, now), undefined);
  });

  it('returns undefined for malformed content', () => {
    const env = makeEnv();
    writeFileSync(voiceWorkerErrorPath(env), 'not json');
    assert.equal(readWorkerStartFailure(env, 0), undefined);
  });
});

describe('workerSpawnOptions', () => {
  it('forces PYTHONIOENCODING=utf-8 on top of the given env', () => {
    const env = makeEnv({ SOME_OTHER: 'x' });
    const opts = workerSpawnOptions(env);
    closeSync((opts.stdio as any)[2]);
    assert.equal((opts.env as NodeJS.ProcessEnv).PYTHONIOENCODING, 'utf-8');
    assert.equal((opts.env as NodeJS.ProcessEnv).SOME_OTHER, 'x');
  });

  it('redirects stderr to <PA_HOME>/voice-worker.log instead of ignoring it', () => {
    const env = makeEnv();
    const opts = workerSpawnOptions(env);
    const stdio = opts.stdio as unknown[];
    assert.equal(stdio[0], 'ignore');
    assert.equal(stdio[1], 'ignore');
    assert.equal(typeof stdio[2], 'number');
    closeSync(stdio[2] as number);
    assert.ok(existsSync(voiceWorkerLogPath(env)));
  });

  it('truncates the existing log once it exceeds the 1MiB cap', () => {
    const env = makeEnv();
    const logPath = voiceWorkerLogPath(env);
    writeFileSync(logPath, 'x'.repeat(2 * 1024 * 1024));

    const opts = workerSpawnOptions(env);
    closeSync((opts.stdio as any)[2]);
    assert.equal(statSync(logPath).size, 0, 'log file should have been truncated on open, not appended to');
  });

  it('appends (does not truncate) when the existing log is under the cap', () => {
    const env = makeEnv();
    const logPath = voiceWorkerLogPath(env);
    writeFileSync(logPath, 'small');

    const opts = workerSpawnOptions(env);
    closeSync((opts.stdio as any)[2]);
    assert.equal(statSync(logPath).size, 'small'.length, 'log file should have been appended to, not truncated');
  });
});

describe('requestTranscription', () => {
  it('returns unavailable when there is no worker and spawning fails to produce one', async () => {
    const env = makeEnv({ PA_VOICE_WORKER_START_TIMEOUT_MS: '250' });
    const { sleepFn, nowFn } = fakeClockSleep();
    const deps = makeDeps(env, {
      spawnFn: () => {},
      sleepFn,
      nowFn,
      connectFn: async () => {
        throw new Error('nobody home');
      },
    });

    const outcome = await requestTranscription(makeRequest(), deps);
    assert.equal(outcome.kind, 'unavailable');
  });

  it('happy path: returns the envelope and sends every request field plus the token', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 333, token: 'tok-abc' });
    let sentPayload: any = null;
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (_port, payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.op === 'ping') return JSON.stringify({ ok: true, protocol: 1 });
        sentPayload = parsed;
        return JSON.stringify({ ok: true, text: 'hello world' });
      },
    });

    const req = makeRequest();
    const outcome = await requestTranscription(req, deps);
    assert.equal(outcome.kind, 'envelope');
    assert.equal((outcome as any).envelope.ok, true);
    assert.equal(sentPayload.op, 'transcribe');
    assert.equal(sentPayload.token, 'tok-abc');
    for (const key of Object.keys(req) as (keyof VoiceWorkerRequest)[]) {
      assert.deepEqual(sentPayload[key], req[key]);
    }
  });

  it('a worker replying ok:false with an error_code is an envelope, not unavailable', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 333 });
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (_port, payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.op === 'ping') return JSON.stringify({ ok: true, protocol: 1 });
        return JSON.stringify({ ok: false, error_code: 'no-engine', error: 'no cloud key configured' });
      },
    });

    const outcome = await requestTranscription(makeRequest(), deps);
    assert.equal(outcome.kind, 'envelope');
    assert.equal((outcome as any).envelope.error_code, 'no-engine');
  });

  it('a connectFn that rejects with a plain error after a healthy ping resolves unavailable', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 333 });
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (_port, payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.op === 'ping') return JSON.stringify({ ok: true, protocol: 1 });
        throw new Error('worker died mid-request');
      },
    });

    const outcome = await requestTranscription(makeRequest(), deps);
    assert.equal(outcome.kind, 'unavailable');
  });

  it('a transcribe-leg timeout resolves kind "timeout", not "unavailable" (injected error)', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 333 });
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (_port, payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.op === 'ping') return JSON.stringify({ ok: true, protocol: 1 });
        throw new VoiceWorkerTimeoutError('transcribe timed out');
      },
    });

    const outcome = await requestTranscription(makeRequest(), deps);
    assert.equal(outcome.kind, 'timeout');
  });

  it('a transcribe-leg timeout over a real never-replying TCP server resolves kind "timeout"', async () => {
    const server = net.createServer((socket) => {
      // Deliberately never reply to either the ping or the transcribe leg.
      socket.on('error', () => {}); // an RST after client-side destroy is expected, not a test failure
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const env = makeEnv({ PA_VOICE_WORKER_PING_TIMEOUT_MS: '150', PA_VOICE_TRANSCRIBE_TIMEOUT_MS: '150' });
      await writeState(env, { pid: process.pid, port });
      // No connectFn override — exercises the real default connectFn end to
      // end: the ping leg times out ('busy', so the existing state is reused
      // rather than unlinked/respawned) and the transcribe leg's own connect
      // then also times out, which must resolve kind 'timeout', not
      // 'unavailable'.
      const deps = makeDeps(env, { isPidAliveFn: () => true });

      const outcome = await requestTranscription(makeRequest(), deps);
      assert.equal(outcome.kind, 'timeout');
    } finally {
      server.close();
    }
  });

  it('rejects a request_id echo mismatch as unavailable', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 333 });
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (_port, payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.op === 'ping') return JSON.stringify({ ok: true, protocol: 1 });
        return JSON.stringify({ ok: true, text: 'hi', request_id: 'not-the-one-we-sent' });
      },
    });

    const outcome = await requestTranscription(makeRequest({ request_id: 'req-1' }), deps);
    assert.equal(outcome.kind, 'unavailable');
  });

  it('accepts a matching request_id echo', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 333 });
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (_port, payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.op === 'ping') return JSON.stringify({ ok: true, protocol: 1 });
        return JSON.stringify({ ok: true, text: 'hi', request_id: 'req-1' });
      },
    });

    const outcome = await requestTranscription(makeRequest({ request_id: 'req-1' }), deps);
    assert.equal(outcome.kind, 'envelope');
  });

  it('does not reject when the worker omits request_id from its response', async () => {
    const env = makeEnv();
    await writeState(env, { pid: process.pid, port: 333 });
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (_port, payload) => {
        const parsed = JSON.parse(payload);
        if (parsed.op === 'ping') return JSON.stringify({ ok: true, protocol: 1 });
        return JSON.stringify({ ok: true, text: 'hi' });
      },
    });

    const outcome = await requestTranscription(makeRequest(), deps);
    assert.equal(outcome.kind, 'envelope');
  });
});

describe('real socket transport (default connectFn)', () => {
  it('round-trips a large (>64 KiB) response over a real TCP server', async () => {
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const parsed = JSON.parse(line);
        if (parsed.op === 'ping') {
          socket.write(JSON.stringify({ ok: true, protocol: 1 }) + '\n');
        } else {
          const bigText = 'x'.repeat(70_000);
          socket.write(JSON.stringify({ ok: true, text: bigText }) + '\n');
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const env = makeEnv();
      await writeState(env, { pid: process.pid, port });
      // No connectFn override — this exercises the real default connectFn
      // (both the ensureVoiceWorker ping leg and the transcribe leg) against
      // an actual TCP server, including a >64 KiB chunked response.
      const deps = makeDeps(env, { isPidAliveFn: () => true });

      const outcome = await requestTranscription(makeRequest(), deps);
      assert.equal(outcome.kind, 'envelope');
      assert.equal((outcome as any).envelope.text.length, 70_000);
    } finally {
      server.close();
    }
  });

  it('times out and destroys the socket when the server never replies', async () => {
    const server = net.createServer((socket) => {
      // Deliberately never reply — the client's connectFn must time out.
      socket.on('error', () => {}); // an RST after client-side destroy is expected, not a test failure
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const env = makeEnv({ PA_VOICE_WORKER_PING_TIMEOUT_MS: '200' });
      const deps = makeDeps(env);
      const start = Date.now();
      const alive = await pingVoiceWorker({ pid: process.pid, port, token: 't', started_at: '', protocol: 1 }, deps);
      // The real assertion: the call resolves (does not hang) once the 200ms
      // client-side timeout fires, and reports the worker as unreachable.
      assert.equal(alive, false);
      assert.ok(Date.now() - start < 2000, 'pingVoiceWorker must resolve promptly on client-side timeout, not hang');
      // Deliberately NOT asserting that the server observes a socket 'close'
      // event: destroying the client's own socket on timeout is enough to
      // prove the client never hangs (defaultConnect's `finally` calls
      // socket.destroy() on every settle path — see voice-worker-client.ts).
      // Whether the OS/Node reliably delivers a prompt 'close' to the PEER's
      // accepted socket after a client-side destroy() is platform-dependent,
      // not part of this module's contract, and not reliably observable
      // within a bounded test window on this machine (confirmed via a
      // standalone repro: the server-side 'close' event did not fire within
      // 2s of the client's destroy(), even though the client-side timeout,
      // destroy, and rejection all happened correctly and promptly).
      // Asserting on it here previously hung the whole suite indefinitely.
    } finally {
      server.close();
    }
  });
});

describe('SSRF-shaped guard: 127.0.0.1 is hard-coded, never from the state file', () => {
  it('a spoofed "host" field in the state file never reaches the client state or the connection call', async () => {
    const env = makeEnv();
    await writeFile(
      statePath(env),
      JSON.stringify({
        pid: process.pid,
        port: 111,
        token: 'tok',
        started_at: new Date().toISOString(),
        protocol: 1,
        host: 'evil.example.com',
      }),
      'utf8',
    );

    const state = readVoiceWorkerState(env);
    assert.ok(state);
    assert.equal((state as any).host, undefined);

    let capturedArgs: unknown[] = [];
    const deps = makeDeps(env, {
      isPidAliveFn: () => true,
      connectFn: async (...args: unknown[]) => {
        capturedArgs = args;
        return JSON.stringify({ ok: true, protocol: 1 });
      },
    });

    await ensureVoiceWorker(deps);
    // connectFn's contract is (port, payload, timeoutMs) — there is no
    // parameter slot a host could occupy even if one existed on the state.
    assert.equal(capturedArgs.length, 3);
    assert.equal(capturedArgs[0], 111);
  });
});

describe('source hygiene', () => {
  it('the module contains no setInterval', async () => {
    const { readFileSync } = await import('fs');
    // The test suite always runs with cwd = projects/telegram-bot (see the
    // package.json `test` script), so the source tree is reachable directly —
    // no need to derive it from import.meta.url of the compiled dist file.
    const src = readFileSync(join(process.cwd(), 'src', 'voice-worker-client.ts'), 'utf8');
    assert.doesNotMatch(src, /\bsetInterval\s*\(/);
  });
});
