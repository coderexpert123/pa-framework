import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import {
  proxyRefreshIntervalMs,
  isDirectRouteHealthy,
  runScheduledPoolRefresh,
} from '../src/lib/telegram-proxy.js';

// AI-100 Wave 2: the periodic proxy-pool-refresh setInterval was replaced by a
// declared bot-host maintenance job that calls runScheduledPoolRefresh() on
// the cadence reported by proxyRefreshIntervalMs(). These tests lock the
// standalone (pre-startProxyAutoRefresh) defaults and the no-op guards that
// must survive the migration — most importantly that a working direct route
// (and disabled/unconfigured deployments) still cost zero proxy scans.

describe('proxyRefreshIntervalMs / isDirectRouteHealthy (standalone defaults)', () => {
  it('proxyRefreshIntervalMs() returns a finite positive number before any startProxyAutoRefresh call', () => {
    const ms = proxyRefreshIntervalMs();
    assert.ok(Number.isFinite(ms) && ms > 0, `expected a finite positive default, got ${ms}`);
  });

  it('isDirectRouteHealthy() returns true on a fresh module load (assume-healthy initial state)', () => {
    assert.equal(isDirectRouteHealthy(), true);
  });
});

describe('runScheduledPoolRefresh — no-op guards never touch the network', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  // Both guards below are proven network-free by construction, not by
  // intercepting the network call: runScheduledPoolRefresh's PA_NOTIFY_DISABLED
  // check and its `if (!sourceUrl) return 0;` check both execute — and return —
  // strictly before the function reaches its only network call
  // (undiciFetch inside refreshPoolFromSource), so a `result === 0` in well
  // under the 20s AbortSignal.timeout() that call would carry is sufficient
  // proof no fetch was attempted. (An earlier version of this test tried to
  // intercept undici's `fetch` export directly via mock.method — undici does
  // not expose `fetch` as a plain writable data property in this environment,
  // so the mock itself threw at setup time before the assertion ever ran.)
  it('PA_NOTIFY_DISABLED=1 (suite-wide test default): resolves 0 with no network attempt', async () => {
    assert.equal(process.env.PA_NOTIFY_DISABLED, '1', 'expected the suite-wide test default (test-env-setup.ts) to be set');
    const start = Date.now();
    const result = await runScheduledPoolRefresh('fake-token');
    assert.equal(result, 0);
    assert.ok(Date.now() - start < 1000, 'should return near-instantly — a real network attempt would take far longer');
  });

  it('no TELEGRAM_PROXY_SOURCE_URL configured: resolves 0 with no network attempt', async () => {
    const prevDisabled = process.env.PA_NOTIFY_DISABLED;
    delete process.env.PA_NOTIFY_DISABLED;
    try {
      await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=fake-token\n');
      const start = Date.now();
      const result = await runScheduledPoolRefresh('fake-token');
      assert.equal(result, 0);
      assert.ok(Date.now() - start < 1000, 'should return near-instantly — a real network attempt would take far longer');
    } finally {
      if (prevDisabled === undefined) delete process.env.PA_NOTIFY_DISABLED;
      else process.env.PA_NOTIFY_DISABLED = prevDisabled;
    }
  });
});
