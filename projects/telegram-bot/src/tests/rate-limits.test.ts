import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Use a temp file for state so tests are isolated from ~/.pa/rate-limit-state.json
const TEST_DIR = join(tmpdir(), `rate-limits-test-${process.pid}`);
const TEST_STATE_PATH = join(TEST_DIR, 'rate-limit-state.json');

// Override PA_HOME before importing the module so statePath() resolves to our temp dir
process.env.PA_HOME = TEST_DIR;

// Dynamic import after env var is set. The canonical rate-limits module lives
// in pa/src/rate-limits.ts; import via its built output so this test exercises
// the same code the bot runs at runtime.
const { recordRateLimit, isWorkerCoolingDown, getCooldownStatus, parseRateLimitDuration } = await import('../../../../pa/dist/src/rate-limits.js');

async function resetState(): Promise<void> {
  try { await unlink(TEST_STATE_PATH); } catch {}
  // Clear in-memory cache by writing an empty object
  await writeFile(TEST_STATE_PATH, '{}', 'utf8');
}

before(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await resetState();
});

after(async () => {
  try { await unlink(TEST_STATE_PATH); } catch {}
});

// ---------------------------------------------------------------------------
// parseRateLimitDuration
// ---------------------------------------------------------------------------

describe('parseRateLimitDuration', () => {
  it('parses Zhipu "for N hour" format', () => {
    const output = 'API Error: 429 {"error":{"code":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-04-09 15:13:03"},"request_id":"abc"}';
    assert.equal(parseRateLimitDuration(output), 300);
  });

  it('parses "for 1 hour"', () => {
    assert.equal(parseRateLimitDuration('usage limit reached for 1 hour'), 60);
  });

  it('parses "retry after N min" pattern', () => {
    assert.equal(parseRateLimitDuration('rate limited, retry after 30 min'), 30);
  });

  it('falls back to 2 when no duration found', () => {
    assert.equal(parseRateLimitDuration('rate limit exceeded'), 2);
  });

  it('falls back to 2 for empty string', () => {
    assert.equal(parseRateLimitDuration(''), 2);
  });
});

// ---------------------------------------------------------------------------
// recordRateLimit + isWorkerCoolingDown
// ---------------------------------------------------------------------------

describe('recordRateLimit + isWorkerCoolingDown', () => {
  it('worker is cooling down after recordRateLimit with explicit duration', async () => {
    await resetState();
    await recordRateLimit('claude', 30, 'test');
    assert.equal(await isWorkerCoolingDown('claude'), true);
  });

  it('durationMinutes <= 0 is a no-op (transient retry signal)', async () => {
    // Use a unique worker name to avoid cache-collision with the previous
    // test's claude entry. The module-level state cache in pa/src/rate-limits.ts
    // is not directly resettable from here, so tests that verify "no entry"
    // must use a fresh worker name.
    const w = `transient-test-${Date.now()}`;
    await recordRateLimit(w, 0, 'test');
    assert.equal(await isWorkerCoolingDown(w), false);
  });

  it('defaults to 2-min cooldown when no duration specified', async () => {
    await resetState();
    await recordRateLimit('gemini');
    const status = await getCooldownStatus();
    const entry = status['gemini'];
    assert.ok(entry, 'entry should exist');
    const cooldownUntil = new Date(entry.cooldown_until);
    const expectedMin = new Date(Date.now() + 1 * 60 * 1000);
    assert.ok(cooldownUntil > expectedMin, 'cooldown should be ~2 minutes from now');
  });

  it('returns false for unknown worker', async () => {
    await resetState();
    assert.equal(await isWorkerCoolingDown('unknown-worker'), false);
  });
});

// ---------------------------------------------------------------------------
// File persistence
// ---------------------------------------------------------------------------

describe('rate-limit file persistence', () => {
  it('state survives a cache clear (simulated reload)', async () => {
    await resetState();
    await recordRateLimit('zclaude', 30, 'persistence test');

    // Simulate cache cleared by writing the file manually and re-checking
    // (the module's in-memory cache will still have the entry, so we verify
    //  that the file was written correctly by reading it directly)
    const raw = await import('fs/promises').then((fs) => fs.readFile(TEST_STATE_PATH, 'utf8'));
    const saved = JSON.parse(raw);
    assert.ok(saved['zclaude'], 'zclaude entry should be persisted to disk');
    assert.ok(saved['zclaude'].cooldown_until, 'cooldown_until should be persisted');
  });

  it('getCooldownStatus returns all active cooldowns', async () => {
    await resetState();
    await recordRateLimit('claude', 30, 'test1');
    await recordRateLimit('gemini', 20, 'test2');
    const status = await getCooldownStatus();
    assert.ok(status['claude'], 'claude should be in status');
    assert.ok(status['gemini'], 'gemini should be in status');
  });
});

// ---------------------------------------------------------------------------
// classifyRateLimit — zclaude synthetic 429 populates raw field
// ---------------------------------------------------------------------------

describe('classifyRateLimit — zclaude synthetic 429 raw field', () => {
  const CLS_DIR = join(tmpdir(), `rate-limits-cls-test-${process.pid}`);

  before(async () => {
    await mkdir(join(CLS_DIR, 'proj-cls'), { recursive: true });
  });

  after(async () => {
    try { await rm(CLS_DIR, { recursive: true, force: true }); } catch {}
  });

  it('returns result with raw populated when zclaude emits a synthetic 429 envelope', async () => {
    const { classifyRateLimit: cls } = await import('../../../../pa/dist/src/rate-limits.js');
    const sessionId = 'cls-test-zclaude';
    const envelope = JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: Request rejected (429) · Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-04-20 23:07:02' }],
      },
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(CLS_DIR, 'proj-cls', `${sessionId}.jsonl`), envelope, 'utf8');

    const result = await cls('zclaude', '', '', sessionId, CLS_DIR, '*.jsonl');
    assert.ok(result !== null, 'should return a non-null result for synthetic 429');
    assert.ok(result!.minutes > 0, `minutes should be >0, got ${result!.minutes}`);
    assert.equal(result!.classification, 'usage-limit-session');
    assert.ok(result!.raw && result!.raw.includes('Your limit will reset at'),
      `raw should include the reset message, got: ${result!.raw}`);
  });
});
