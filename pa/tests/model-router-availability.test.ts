// Availability-cache tests (2026-09-19 router-as-orchestrator SPEC §7,
// decision 27). All IO injected via setAvailabilityIoForTests; frozen clock;
// NO network, NO real config/cooldown reads. The check-able contract: ONE
// config read + ONE cooldown read per TTL window; `0` disables; faults record
// unknown workers unavailable (never guessed-available, decision 2).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCachedAvailability,
  setAvailabilityIoForTests,
  resetAvailabilityCacheForTests,
  DEFAULT_AVAILABILITY_TTL_MS,
  type AvailabilityIo,
} from '../src/lib/model-router/availability.js';

let clockMs = 1_000_000_000;
let configReads = 0;
let cooldownReads = 0;
const WORKERS = ['agy', 'codex', 'zclaude'];

function baseIo(over: {
  workers?: Array<any>;
  cooldown?: Record<string, { cooldown_until?: string }>;
  fail?: boolean;
  availability_ttl_ms?: number;
} = {}): AvailabilityIo {
  return {
    loadConfig: async () => {
      configReads++;
      if (over.fail) throw new Error('config store unavailable');
      return {
        workers: over.workers ?? [
          { name: 'agy', command: 'agy', args: [], check: 'x', rate_limit_patterns: [], priority: 1, input_mode: 'arg', check_timeout: 5 },
          { name: 'codex', command: 'codex', args: [], check: 'x', rate_limit_patterns: [], priority: 2, input_mode: 'arg', check_timeout: 5 },
          { name: 'zclaude', command: 'zclaude', args: [], check: 'x', rate_limit_patterns: [], priority: 3, input_mode: 'arg', check_timeout: 5 },
        ],
        ...(over.availability_ttl_ms !== undefined ? { model_router: { availability_ttl_ms: over.availability_ttl_ms } } : {}),
      };
    },
    cooldown: async () => {
      cooldownReads++;
      return over.cooldown ?? {};
    },
    now: () => clockMs,
  };
}

beforeEach(() => {
  resetAvailabilityCacheForTests();
  clockMs = 1_000_000_000;
  configReads = 0;
  cooldownReads = 0;
  delete process.env.PA_MODEL_ROUTER_AVAILABILITY_TTL_MS;
  setAvailabilityIoForTests(baseIo());
});

afterEach(() => {
  setAvailabilityIoForTests(undefined);
  resetAvailabilityCacheForTests();
  delete process.env.PA_MODEL_ROUTER_AVAILABILITY_TTL_MS;
});

describe('getCachedAvailability', () => {
  it('default TTL: one config read + one cooldown read serve the whole window', async () => {
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(await getCachedAvailability('codex', WORKERS), true);
    assert.equal(await getCachedAvailability('zclaude', WORKERS), true);
    assert.equal(configReads, 1, 'the config parse must be cached across the window');
    assert.equal(cooldownReads, 1, 'ONE cooldown snapshot serves all workers per refresh');
    // Past the TTL the window refreshes.
    clockMs += DEFAULT_AVAILABILITY_TTL_MS + 1;
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(configReads, 2);
    assert.equal(cooldownReads, 2);
  });

  it('a cooling worker is unavailable for the window; expired entries are not cooling', async () => {
    setAvailabilityIoForTests(baseIo({
      cooldown: { codex: { cooldown_until: new Date(clockMs + 60_000).toISOString() } },
    }));
    assert.equal(await getCachedAvailability('codex', WORKERS), false);
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
  });

  it('manual_only workers stay auto-ineligible; unknown workers are unavailable', async () => {
    setAvailabilityIoForTests(baseIo({
      workers: [{ name: 'agy', manual_only: true }, { name: 'codex' }],
    }));
    assert.equal(await getCachedAvailability('agy', ['agy', 'codex']), false);
    assert.equal(await getCachedAvailability('codex', ['agy', 'codex']), true);
    assert.equal(await getCachedAvailability('ghost', ['agy', 'codex']), false);
  });

  it('a config read fault records EVERY queried worker unavailable (never guessed-available)', async () => {
    setAvailabilityIoForTests(baseIo({ fail: true }));
    assert.equal(await getCachedAvailability('agy', WORKERS), false);
    assert.equal(await getCachedAvailability('codex', WORKERS), false);
  });

  it('a worker outside workerNames is unavailable with ZERO I/O', async () => {
    const before = configReads;
    assert.equal(await getCachedAvailability('ghost', WORKERS), false);
    assert.equal(configReads, before);
  });

  it('env PA_MODEL_ROUTER_AVAILABILITY_TTL_MS overrides; `0` disables the cache (always fresh)', async () => {
    process.env.PA_MODEL_ROUTER_AVAILABILITY_TTL_MS = '0';
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(configReads, 2, 'ttl 0 = every call refreshes');
    // The env override governs the next window too (it beats any config TTL).
    process.env.PA_MODEL_ROUTER_AVAILABILITY_TTL_MS = '100000';
    clockMs += 200;
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(configReads, 2, 'still inside the env-TTL window');
    clockMs += 100_001;
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(configReads, 3, 'past the env TTL the window refreshes');
  });

  it('config-carried availability_ttl_ms governs the window once known', async () => {
    setAvailabilityIoForTests(baseIo({ availability_ttl_ms: 50 }));
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    clockMs += 10;
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(configReads, 1, 'still inside the 50ms config window');
    clockMs += 41;
    assert.equal(await getCachedAvailability('agy', WORKERS), true);
    assert.equal(configReads, 2, 'past 50ms the window refreshes');
  });

  it('concurrent callers share ONE in-flight refresh (no read storm)', async () => {
    const [a, b, c] = await Promise.all([
      getCachedAvailability('agy', WORKERS),
      getCachedAvailability('codex', WORKERS),
      getCachedAvailability('zclaude', WORKERS),
    ]);
    assert.deepEqual([a, b, c], [true, true, true]);
    assert.equal(configReads, 1);
    assert.equal(cooldownReads, 1);
  });
});
