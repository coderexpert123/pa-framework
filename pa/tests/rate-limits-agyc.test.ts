import './test-env-guard.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Point PA_HOME at a test tmpdir BEFORE importing rate-limits so statePath()
// resolves into an isolated directory.
const PA_HOME = join(tmpdir(), `rate-limits-agyc-test-${process.pid}`);
process.env.PA_HOME = PA_HOME;
// The account-exhausted path alerts via notifyUser — keep it off the network.
process.env.PA_NOTIFY_DISABLED = '1';

import { classifyRateLimit } from '../src/rate-limits.js';
import { recordRateLimit, getWorkerCooldown, clearRateLimitCache } from '../src/rate-limits.js';
import { flushLog } from '../src/lib/log.js';

// Representative stderr fixtures (shapes taken from rate-limits-gemini.ts's own
// rule structure): JSON 429 with a retryDelay, agy's CLI-level terminal quota
// text, and non-rate-limit stderr.

const STDERR_429_RETRYDELAY = JSON.stringify({
  error: {
    code: 429,
    message: 'Resource has been exhausted',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { reason: 'QUOTA_EXHAUSTED', quotaMetric: 'GenerateRequestsPerMinute', retryDelay: '45s' },
    ],
  },
});

const STDERR_TERMINAL_QUOTA = [
  'Individual quota reached. Please wait for the quota to reset or upgrade your plan.',
  'Resets in 55 min.',
].join('\n');

const STDERR_UNRELATED = 'plain network timeout: connect ETIMEDOUT';

async function logLines(): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(join(PA_HOME, 'app.log.jsonl'), 'utf8').catch(() => '');
  return content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

before(async () => {
  await mkdir(PA_HOME, { recursive: true });
  clearRateLimitCache();
});

after(async () => {
  try { await rm(PA_HOME, { recursive: true, force: true }); } catch {}
});

describe('classifyRateLimit — agyc rides the agy (gemini) classifier path', () => {
  it('agyc: JSON 429 with retryDelay classifies gemini-stderr with minutes > 0', async () => {
    const result = await classifyRateLimit('agyc', '', STDERR_429_RETRYDELAY);
    assert.ok(result, '429 stderr must classify');
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.source, 'gemini-stderr');
    assert.ok(result!.minutes > 0, `cooldown minutes must be > 0, got ${result!.minutes}`);
  });

  it('agyc: terminal CLI quota text takes the alert path and returns gemini-cli-text', async () => {
    const result = await classifyRateLimit('agyc', '', STDERR_TERMINAL_QUOTA);
    assert.ok(result, 'terminal quota text must classify');
    assert.equal(result!.classification, 'quota-exhausted');
    assert.equal(result!.source, 'gemini-cli-text');
    assert.ok(result!.minutes > 0);

    await flushLog();
    const lines = await logLines();
    const alertLine = lines.find(
      (e) => e.message === 'terminal account fault: agyc benched' && e.worker === 'agyc',
    );
    assert.ok(alertLine, 'terminal account fault must be alerted (warn log line)');
  });

  it('agyc: terminal classification persists a cooldown via recordRateLimit', async () => {
    const result = await classifyRateLimit('agyc', '', STDERR_TERMINAL_QUOTA);
    assert.ok(result);
    await recordRateLimit('agyc', result!.minutes, result!.raw ?? '', result!.classification);
    const entry = await getWorkerCooldown('agyc');
    assert.ok(entry, 'cooldown entry must exist');
    assert.equal(entry!.classification, 'quota-exhausted');
    assert.ok(entry!.cooldown_until);
  });

  it('agyc: non-rate-limit stderr returns null', async () => {
    const result = await classifyRateLimit('agyc', '', STDERR_UNRELATED);
    assert.equal(result, null, 'unrelated stderr must not classify as a rate limit');
  });

  it('agy regression: identical fixtures classify identically to agyc', async () => {
    const agy429 = await classifyRateLimit('agy', '', STDERR_429_RETRYDELAY);
    const agyc429 = await classifyRateLimit('agyc', '', STDERR_429_RETRYDELAY);
    assert.deepEqual(
      { c: agyc429!.classification, s: agyc429!.source, m: agyc429!.minutes },
      { c: agy429!.classification, s: agy429!.source, m: agy429!.minutes },
      'agyc must match agy on the 429 fixture',
    );

    const agyTerm = await classifyRateLimit('agy', '', STDERR_TERMINAL_QUOTA);
    const agycTerm = await classifyRateLimit('agyc', '', STDERR_TERMINAL_QUOTA);
    assert.equal(agyTerm!.classification, agycTerm!.classification);
    assert.equal(agyTerm!.source, agycTerm!.source);

    const agyNull = await classifyRateLimit('agy', '', STDERR_UNRELATED);
    assert.equal(agyNull, null);
  });
});
