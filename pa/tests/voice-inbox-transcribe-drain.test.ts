import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { voiceInboxLedgerPath } from '../src/lib/voice-inbox-ledger.js';
import type { notifyUser } from '../src/lib/notify.js';
import {
  createVoiceInboxTranscribeDrain,
  fireAndForgetNotify,
  voiceInboxRouteHoldStates,
  drainAttemptDeadlineMs,
  DRAIN_SCAN_MIN_INTERVAL_MS,
  DRAIN_MAX_CONCURRENT,
  DEFAULT_DRAIN_TRANSCRIBE_TIMEOUT_MS,
  type VoiceInboxTranscribeDrainOptions,
} from '../src/lib/voice-inbox-transcribe-drain.js';
import type { TranscribeOutcome, InfraMarkers } from '../src/lib/voice-inbox-transcribe.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

interface TimerEntry {
  fn: () => void;
  ms: number;
}

function baseOpts(overrides: Partial<VoiceInboxTranscribeDrainOptions> = {}): {
  opts: VoiceInboxTranscribeDrainOptions;
  clockRef: { clock: number };
  timers: TimerEntry[];
} {
  const clockRef = { clock: Date.now() };
  const timers: TimerEntry[] = [];
  const opts: VoiceInboxTranscribeDrainOptions = {
    nowFn: () => clockRef.clock,
    scanMinIntervalMs: 0,
    attemptDeadlineMs: 1_000,
    setTimeoutFn: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeoutFn: () => {},
    enabledFn: () => true,
    readMarkersFn: () => ({ count: 0, newestMs: undefined }),
    ...overrides,
  };
  return { opts, clockRef, timers };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('voice-inbox-transcribe-drain: kick scheduling', () => {
  it('kick is synchronous and returns before the attempt settles', () => {
    const { opts } = baseOpts();
    let settled = false;
    let resolveFn: (o: TranscribeOutcome) => void = () => {};
    const pending = new Promise<TranscribeOutcome>((resolve) => {
      resolveFn = resolve;
    });
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      selectCandidatesFn: () => [{ task_id: 'A', tenant_id: 't', created_at: new Date().toISOString() }],
      transcribeTaskFn: async () => {
        return pending.then((o) => {
          settled = true;
          return o;
        });
      },
    });
    const r = drain.kick();
    assert.equal(typeof r, 'number');
    assert.equal(r, 1);
    assert.equal(settled, false);
    assert.equal(drain.inFlightCount(), 1);
    resolveFn({ acted: true, kind: 'transcribed', markerCount: 0 });
  });

  it('a never-settling attempt frees its slot at the attempt deadline and the next kick starts the next task', async () => {
    const { opts, timers } = baseOpts({ maxConcurrent: 1 } as VoiceInboxTranscribeDrainOptions);
    const started: string[] = [];
    let candidates = [
      { task_id: 'A', tenant_id: 't', created_at: new Date().toISOString() },
      { task_id: 'B', tenant_id: 't', created_at: new Date().toISOString() },
    ];
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      maxConcurrent: 1,
      selectCandidatesFn: () => candidates,
      transcribeTaskFn: async (c) => {
        started.push(c.task_id);
        return new Promise(() => {});
      },
    });

    assert.equal(drain.kick(), 1);
    assert.equal(drain.kick(), 0);
    assert.equal(timers.length, 1);
    timers[0].fn();
    candidates = [candidates[1]];
    assert.equal(drain.kick(), 1);
    assert.deepEqual(started, ['A', 'B']);
  });

  it('one slow task never starves the others', async () => {
    const { opts } = baseOpts({ maxConcurrent: 2 } as VoiceInboxTranscribeDrainOptions);
    const started: string[] = [];
    let candidates = [
      { task_id: 'A', tenant_id: 't', created_at: new Date().toISOString() },
      { task_id: 'B', tenant_id: 't', created_at: new Date().toISOString() },
      { task_id: 'C', tenant_id: 't', created_at: new Date().toISOString() },
    ];
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      maxConcurrent: 2,
      selectCandidatesFn: () => candidates,
      transcribeTaskFn: async (c) => {
        started.push(c.task_id);
        if (c.task_id === 'B') {
          candidates = candidates.filter((x) => x.task_id !== 'B');
          return { acted: true, kind: 'transcribed', markerCount: 0 };
        }
        return new Promise(() => {});
      },
    });

    assert.equal(drain.kick(), 2);
    await flush();
    assert.equal(drain.kick(), 1);
    assert.deepEqual(started, ['A', 'B', 'C']);
  });

  it('a throwing attempt frees its slot and the task waits out its retry backoff', async () => {
    const { opts, clockRef } = baseOpts();
    let callCount = 0;
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      selectCandidatesFn: () => [{ task_id: 'A', tenant_id: 't', created_at: new Date().toISOString() }],
      transcribeTaskFn: () => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('boom');
        }
        return new Promise(() => {});
      },
    });

    assert.equal(drain.kick(), 1);
    await flush();
    assert.equal(drain.inFlightCount(), 0);
    assert.equal(drain.kick(), 0);
    clockRef.clock += 120_000;
    assert.equal(drain.kick(), 1);
    assert.equal(callCount, 2);
  });

  it('a throwing candidate selector never throws out of kick and the next scan runs', () => {
    const { opts } = baseOpts();
    let selectorCalls = 0;
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      selectCandidatesFn: () => {
        selectorCalls += 1;
        if (selectorCalls === 1) throw new Error('selector boom');
        return [{ task_id: 'A', tenant_id: 't', created_at: new Date().toISOString() }];
      },
      transcribeTaskFn: async () => new Promise(() => {}),
    });

    assert.doesNotThrow(() => {
      assert.equal(drain.kick(), 0);
    });
    assert.equal(drain.kick(), 1);
    assert.equal(selectorCalls, 2);
  });

  it('scans the ledger at most once per scan interval', () => {
    const { opts, clockRef } = baseOpts({ scanMinIntervalMs: 5_000 } as VoiceInboxTranscribeDrainOptions);
    let selectorCalls = 0;
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      scanMinIntervalMs: 5_000,
      selectCandidatesFn: () => {
        selectorCalls += 1;
        return [];
      },
    });

    drain.kick();
    assert.equal(selectorCalls, 1);
    clockRef.clock += 4_999;
    drain.kick();
    assert.equal(selectorCalls, 1);
    clockRef.clock += 1;
    drain.kick();
    assert.equal(selectorCalls, 2);
  });

  it('a task with a fresh infra marker is not started until its retry backoff elapses', () => {
    const { opts, clockRef } = baseOpts();
    const markerMs = clockRef.clock;
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      selectCandidatesFn: () => [{ task_id: 'A', tenant_id: 't', created_at: new Date(clockRef.clock).toISOString() }],
      readMarkersFn: (): InfraMarkers => ({ count: 1, newestMs: markerMs }),
      transcribeTaskFn: async () => new Promise(() => {}),
    });

    assert.equal(drain.kick(), 0);
    clockRef.clock += 119_999;
    assert.equal(drain.kick(), 0);
    clockRef.clock += 1;
    assert.equal(drain.kick(), 1);
  });

  it('a task at its infra bound is started at once so the give-up is never delayed', () => {
    const { opts, clockRef } = baseOpts();
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      selectCandidatesFn: () => [{ task_id: 'A', tenant_id: 't', created_at: new Date(clockRef.clock).toISOString() }],
      readMarkersFn: (): InfraMarkers => ({ count: 4, newestMs: clockRef.clock }),
      transcribeTaskFn: async () => new Promise(() => {}),
    });

    assert.equal(drain.kick(), 1);
  });

  it('a task already in flight is never started twice', () => {
    const { opts } = baseOpts();
    let callCount = 0;
    const drain = createVoiceInboxTranscribeDrain({
      ...opts,
      selectCandidatesFn: () => [{ task_id: 'A', tenant_id: 't', created_at: new Date().toISOString() }],
      transcribeTaskFn: async () => {
        callCount += 1;
        return new Promise(() => {});
      },
    });

    assert.equal(drain.kick(), 1);
    assert.equal(drain.kick(), 0);
    assert.equal(callCount, 1);
  });

  it('PA_VOICE_INBOX_TRANSCRIBE_DRAIN=0 disables the drain — kick starts nothing and never scans', () => {
    const prev = process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN;
    process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN = '0';
    try {
      const { opts } = baseOpts();
      delete (opts as any).enabledFn;
      let selectorCalls = 0;
      const drain = createVoiceInboxTranscribeDrain({
        ...opts,
        selectCandidatesFn: () => {
          selectorCalls += 1;
          return [];
        },
      });
      assert.equal(drain.kick(), 0);
      assert.equal(selectorCalls, 0);
    } finally {
      if (prev === undefined) delete process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN;
      else process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN = prev;
    }
  });
});

describe('voice-inbox-transcribe-drain: notify and hold-state helpers', () => {
  it('fireAndForgetNotify resolves at once even when the inner notify never settles', async () => {
    const inner = (() => new Promise(() => {})) as unknown as typeof notifyUser;
    const r = await fireAndForgetNotify(inner)('s', 'b', {});
    assert.equal(r.sent, false);
  });

  it('voiceInboxRouteHoldStates reads states only while the drain is enabled and the ledger exists', () => {
    assert.equal(voiceInboxRouteHoldStates(['vi-aaaaaaaaaaaa']).size, 0);

    const dbPath = voiceInboxLedgerPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, state TEXT NOT NULL, routed_to TEXT)');
    db.prepare("INSERT INTO tasks (task_id, state, routed_to) VALUES ('vi-aaaaaaaaaaaa', 'transcribing', NULL)").run();
    db.close();

    assert.equal(voiceInboxRouteHoldStates(['vi-aaaaaaaaaaaa']).get('vi-aaaaaaaaaaaa')?.state, 'transcribing');

    const prev = process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN;
    process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN = '0';
    try {
      assert.equal(voiceInboxRouteHoldStates(['vi-aaaaaaaaaaaa']).size, 0);
    } finally {
      if (prev === undefined) delete process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN;
      else process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN = prev;
    }
  });
});

// A4 (2026-09-16, WP-1 follow-up): every test above injects its own overrides
// for scanMinIntervalMs/maxConcurrent/transcribeTimeoutMs/attemptDeadlineMs,
// so a silent edit to a DEFAULT ships unseen. Pin the defaults directly.
describe('voice-inbox-transcribe-drain: default constants', () => {
  it('pins the drain default constants', () => {
    assert.equal(DRAIN_SCAN_MIN_INTERVAL_MS, 5_000);
    assert.equal(DRAIN_MAX_CONCURRENT, 3);
    assert.equal(DEFAULT_DRAIN_TRANSCRIBE_TIMEOUT_MS, 300_000);
    assert.equal(drainAttemptDeadlineMs(DEFAULT_DRAIN_TRANSCRIBE_TIMEOUT_MS), 420_000);
  });
});
