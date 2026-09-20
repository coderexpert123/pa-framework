import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVoiceInboxTypedRouteDrain,
  TYPED_ROUTE_HOLD_MAX_MS,
  TYPED_ROUTE_CLIENT_MAX_MS,
  TYPED_ROUTE_ATTEMPT_DEADLINE_MS,
} from '../src/lib/voice-inbox-typed-route-drain.js';
import { DEFAULT_TYPESAFE_TIMEOUT_MS, TYPESAFE_MAX_ATTEMPTS } from '../src/lib/typesafe-client.js';
import { WORKER_SCRIPT_TIMEOUT_MS } from '../src/lib/voice-inbox-transcribe.js';
import type { VoiceInboxRoutingFileConfig } from '../src/lib/voice-inbox-routing-config.js';
import type { TypedRouteOutcome } from '../src/lib/voice-inbox-typed-route-action.js';

const ENABLED: VoiceInboxRoutingFileConfig = {
  keywordTopics: {},
  typedRouting: { actConfidence: 0.9, continueConfidence: 0.9, noMatch: 'create-topic', escalation: 'llm-turn' },
};

interface TimerHandle {
  fire(): void;
  cleared: boolean;
}

function makeTimerRecorder() {
  const timers: TimerHandle[] = [];
  const setTimeoutFn = (fn: () => void, _ms: number): unknown => {
    const handle: TimerHandle = {
      cleared: false,
      fire() {
        if (!this.cleared) fn();
      },
    };
    timers.push(handle);
    return handle;
  };
  const clearTimeoutFn = (handle: unknown): void => {
    (handle as TimerHandle).cleared = true;
  };
  return { timers, setTimeoutFn, clearTimeoutFn };
}

describe('voice-inbox-typed-route-drain', () => {
  it('gate injects everything when voice_inbox_routing is disabled and never starts an attempt', () => {
    let routeCalls = 0;
    let configuredCalls = 0;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ({ keywordTopics: {} }),
      isConfiguredFn: () => {
        configuredCalls += 1;
        return true;
      },
      routeTaskFn: async () => {
        routeCalls += 1;
        return new Promise(() => {});
      },
    });
    assert.equal(drain.gate('vi-1', 'received'), 'inject');
    assert.equal(drain.gate('vi-1', 'routed'), 'inject');
    assert.equal(routeCalls, 0);
    assert.equal(configuredCalls, 0);
  });

  it('gate injects a received entry when TypeSafe is not configured', () => {
    let routeCalls = 0;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => false,
      routeTaskFn: async () => {
        routeCalls += 1;
        return new Promise(() => {});
      },
    });
    assert.equal(drain.gate('vi-1', 'received'), 'inject');
    assert.equal(routeCalls, 0);
  });

  it('gate holds a received entry and keeps holding while its attempt is in flight', () => {
    let t = 1000;
    let routeCalls = 0;
    const timers = makeTimerRecorder();
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => t,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: async () => {
        routeCalls += 1;
        return new Promise(() => {});
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(routeCalls, 1);
    for (let i = 0; i < 3; i += 1) {
      t += 1000;
      assert.equal(drain.gate('vi-1', 'received'), 'hold');
    }
    assert.equal(routeCalls, 1);
  });

  it('a placed attempt keeps holding until the task reads routed, then drops', async () => {
    const timers = makeTimerRecorder();
    let resolveAttempt!: (v: TypedRouteOutcome) => void;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () =>
        new Promise((resolve) => {
          resolveAttempt = resolve;
        }),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    resolveAttempt({
      kind: 'placed',
      action: { kind: 'route', topicKey: '-1_1', reason: 'r', basis: 'typesafe' },
      scriptExit: 0,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(drain.gate('vi-1', 'routed'), 'drop');
  });

  it('an escalated attempt injects once on the next gate call', async () => {
    const timers = makeTimerRecorder();
    let routeCalls = 0;
    let resolveAttempt!: (v: TypedRouteOutcome) => void;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () => {
        routeCalls += 1;
        return new Promise((resolve) => {
          resolveAttempt = resolve;
        });
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    resolveAttempt({ kind: 'escalated', why: 'low-confidence:0.500' });
    await new Promise((r) => setImmediate(r));
    assert.equal(drain.gate('vi-1', 'received'), 'inject');
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(routeCalls, 2);
  });

  it('claim-busy waits and retries after the retry interval', async () => {
    const timers = makeTimerRecorder();
    let t = 1000;
    let routeCalls = 0;
    let resolveAttempt!: (v: TypedRouteOutcome) => void;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => t,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () => {
        routeCalls += 1;
        return new Promise((resolve) => {
          resolveAttempt = resolve;
        });
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    resolveAttempt({ kind: 'claim-busy' });
    await new Promise((r) => setImmediate(r));
    t += 14_999;
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(routeCalls, 1);
    t += 1;
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(routeCalls, 2);
  });

  it('an attempt past its deadline frees its slot and escalates', () => {
    const timers = makeTimerRecorder();
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () => new Promise(() => {}),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    timers.timers[0].fire();
    assert.equal(drain.inFlightCount(), 0);
    assert.equal(drain.gate('vi-1', 'received'), 'inject');
  });

  it('a hold past hold_max injects even while an attempt is in flight', () => {
    const timers = makeTimerRecorder();
    let t = 1000;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => t,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () => new Promise(() => {}),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    t += TYPED_ROUTE_HOLD_MAX_MS;
    assert.equal(drain.gate('vi-1', 'received'), 'inject');
  });

  it('concurrency never exceeds the maximum; extra tasks hold without starting', () => {
    const timers = makeTimerRecorder();
    let routeCalls = 0;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () => {
        routeCalls += 1;
        return new Promise(() => {});
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      maxConcurrent: 2,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(drain.gate('vi-2', 'received'), 'hold');
    assert.equal(drain.gate('vi-3', 'received'), 'hold');
    assert.equal(routeCalls, 2);
    assert.equal(drain.inFlightCount(), 2);
  });

  it('the kill switch PA_VOICE_INBOX_TYPED_ROUTING=0 injects', () => {
    const original = process.env.PA_VOICE_INBOX_TYPED_ROUTING;
    process.env.PA_VOICE_INBOX_TYPED_ROUTING = '0';
    let routeCalls = 0;
    try {
      const drain = createVoiceInboxTypedRouteDrain({
        nowFn: () => 1000,
        readConfigFn: () => ENABLED,
        isConfiguredFn: () => true,
        routeTaskFn: () => {
          routeCalls += 1;
          return new Promise(() => {});
        },
      });
      assert.equal(drain.gate('vi-1', 'received'), 'inject');
      assert.equal(routeCalls, 0);
    } finally {
      if (original === undefined) delete process.env.PA_VOICE_INBOX_TYPED_ROUTING;
      else process.env.PA_VOICE_INBOX_TYPED_ROUTING = original;
    }
  });

  it('gate never throws: a throwing config reader injects', () => {
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => {
        throw new Error('boom');
      },
      isConfiguredFn: () => true,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'inject');
  });

  it('routed entries drop only when typed routing is enabled', () => {
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
    });
    assert.equal(drain.gate('vi-1', 'routed'), 'drop');
    assert.equal(drain.gate('vi-1', 'running'), 'inject');
  });

  it('the deadline timer flips the shared cancel token before it marks the record escalate', () => {
    const timers = makeTimerRecorder();
    let capturedToken: { cancelled: boolean } | undefined;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: (_taskId, _fileConfig, cancelToken) => {
        capturedToken = cancelToken;
        return new Promise(() => {});
      },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(capturedToken!.cancelled, false);
    timers.timers[0].fire();
    assert.equal(capturedToken!.cancelled, true);
    assert.equal(drain.inFlightCount(), 0);
  });

  it('a placed record whose task moved past routed without a routed read drops instead of injecting', async () => {
    const timers = makeTimerRecorder();
    let resolveAttempt!: (v: TypedRouteOutcome) => void;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => 1000,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () =>
        new Promise((resolve) => {
          resolveAttempt = resolve;
        }),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    resolveAttempt({
      kind: 'placed',
      action: { kind: 'route', topicKey: '-1_1', reason: 'r', basis: 'typesafe' },
      scriptExit: 0,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(drain.gate('vi-1', 'running'), 'drop');
    assert.equal(drain.gate('vi-1', 'running'), 'inject');
  });

  it('an in-flight attempt holds while its task moves on and injects after the deadline', () => {
    const timers = makeTimerRecorder();
    let t = 1000;
    const drain = createVoiceInboxTypedRouteDrain({
      nowFn: () => t,
      enabledFn: () => true,
      readConfigFn: () => ENABLED,
      isConfiguredFn: () => true,
      routeTaskFn: () => new Promise(() => {}),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    assert.equal(drain.gate('vi-1', 'received'), 'hold');
    assert.equal(drain.gate('vi-1', 'running'), 'hold');
    t += TYPED_ROUTE_ATTEMPT_DEADLINE_MS;
    timers.timers[0].fire();
    assert.equal(drain.gate('vi-1', 'running'), 'inject');
  });

  it("TYPED_ROUTE_ATTEMPT_DEADLINE_MS is strictly greater than the client's worst case plus the script kill timeout", () => {
    assert.equal(TYPED_ROUTE_ATTEMPT_DEADLINE_MS > TYPED_ROUTE_CLIENT_MAX_MS + WORKER_SCRIPT_TIMEOUT_MS, true);
    assert.equal(TYPED_ROUTE_CLIENT_MAX_MS, DEFAULT_TYPESAFE_TIMEOUT_MS * TYPESAFE_MAX_ATTEMPTS);
    assert.equal(TYPED_ROUTE_ATTEMPT_DEADLINE_MS, 60_000);
  });
});
