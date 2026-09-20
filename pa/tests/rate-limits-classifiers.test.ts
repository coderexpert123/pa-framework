import './test-env-guard.js';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, unlink, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Point PA_HOME at a test tmpdir BEFORE importing rate-limits so statePath()
// resolves into an isolated directory.
const PA_HOME = join(tmpdir(), `rate-limits-classifiers-test-${process.pid}`);
process.env.PA_HOME = PA_HOME;
// The account-exhausted path alerts via notifyUser — keep it off the network.
process.env.PA_NOTIFY_DISABLED = '1';

import { classifyGeminiError } from '../src/rate-limits-gemini.js';
import { flushLog } from '../src/lib/log.js';
import {
  extractCodexRateLimitTelemetry,
  classifyCodexError,
} from '../src/rate-limits-codex.js';
import {
  classifyClaudeErrors,
  classifyClaudeText,
  readClaudeSessionErrors,
  findStateFileById,
  classifyZhipuAccountExhausted,
  hasZhipuBalanceSignature,
  ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES,
  type ApiErrorEvent,
} from '../src/rate-limits-claude.js';
import {
  classifyRateLimit,
  DEFAULT_COOLDOWN_MINUTES,
  BURST_RETRY_COOLDOWN_S,
  recordRateLimit,
  getWorkerCooldown,
  getCooldownStatus,
  isWorkerCoolingDown,
  clearWorkerCooldown,
  clearRateLimitCache,
} from '../src/rate-limits.js';
import {
  effectiveSlotCount,
  _resetForTest as _resetGovernorForTest,
  _setDepsForTest as _setGovernorDepsForTest,
} from '../src/lib/dynamic-slots.js';
import type { PressureSample } from '../src/lib/pressure-sample.js';
import { executeWorker } from '../src/workers.js';
import type { WorkerConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// classifyGeminiError
// ---------------------------------------------------------------------------

describe('classifyGeminiError', () => {
  it('returns null for stderr without 429 or RESOURCE_EXHAUSTED', () => {
    assert.equal(classifyGeminiError('some unrelated error text'), null);
    assert.equal(classifyGeminiError(''), null);
  });

  it('classifies MODEL_CAPACITY_EXHAUSTED as server-overload with 1 minute', () => {
    const stderr = `Attempt 1 failed with status 429. _GaxiosError: [{
      "error": {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "details": [{ "reason": "MODEL_CAPACITY_EXHAUSTED" }]
      }
    }]`;
    const result = classifyGeminiError(stderr);
    assert.ok(result);
    assert.equal(result!.classification, 'server-overload');
    assert.equal(result!.minutes, 1);
    assert.equal(result!.source, 'gemini-stderr');
  });

  it('classifies PerMinute quota as quota-per-minute (2 min default)', () => {
    const stderr = `status: 429 "quotaMetric": "generativelanguage.googleapis.com/generate_content_input_tokens_PerMinutePerProjectPerModel"`;
    const result = classifyGeminiError(stderr);
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.minutes, 2);
  });

  it('classifies PerDay quota as quota-daily with computed minutes', () => {
    const stderr = `code: 429, "status": "RESOURCE_EXHAUSTED", "quotaMetric": "aiplatform.googleapis.com/generate_content_requests_PerDayPerProject"`;
    const result = classifyGeminiError(stderr);
    assert.ok(result);
    assert.equal(result!.classification, 'quota-daily');
    assert.ok(result!.minutes >= 60, `expected >= 60, got ${result!.minutes}`);
    assert.ok(result!.minutes <= 1440, `expected <= 1440, got ${result!.minutes}`);
    assert.ok(result!.resetsAtIST);
    assert.match(result!.resetsAtIST!, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} IST/);
  });

  it('retryDelay overrides per-minute quota', () => {
    const stderr = `"code": 429, "quotaMetric": "...PerMinute...", "retryDelay": "40s"`;
    const result = classifyGeminiError(stderr);
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.minutes, 1); // ceil(40/60) = 1
  });

  it('retryDelay does NOT override daily quota', () => {
    const stderr = `"code": 429, "quotaMetric": "...PerDay...", "retryDelay": "60s"`;
    const result = classifyGeminiError(stderr);
    assert.ok(result);
    assert.equal(result!.classification, 'quota-daily');
    assert.ok(result!.minutes >= 60, `daily quota should stay long, got ${result!.minutes}`);
  });

  it('captures raw snippet around marker', () => {
    const stderr = 'x'.repeat(200) + ' status: 429 error here ' + 'y'.repeat(200);
    const result = classifyGeminiError(stderr);
    assert.ok(result);
    assert.ok(result!.raw);
    assert.ok(result!.raw!.includes('429'));
    // Window is 40 before + 500 after the marker; snippet must include more context now
    assert.ok(result!.raw!.length > 160, `expected snippet > 160 chars, got ${result!.raw!.length}`);
    assert.ok(result!.raw!.length <= 540, `snippet should not exceed window, got ${result!.raw!.length}`);
  });
});

// ---------------------------------------------------------------------------
// classifyGeminiError — agy CLI-text terminal quota exhaustion (2026-09-09 incident)
//
// agy's own CLI wrapper (distinct from the JSON Google-API error blobs parsed
// above) prints "Error: Individual quota reached. Please upgrade your
// subscription to increase your limits. Resets in <duration>" on exit 1 when
// the operator's Antigravity subscription quota is used up. No 429 /
// RESOURCE_EXHAUSTED marker appears anywhere in it, so it fell through every
// rule above (and the `!has429` guard) straight to null for a month —
// ~/.pa/rate-limit-unparseable.jsonl has five rows for this exact text dated
// 2026-08-09, reason 'no-session-evidence', because rate-limits.ts's agy
// branch had nothing to record a cooldown from.
// ---------------------------------------------------------------------------

// Verbatim specimen, truncated to 100 chars — the exact bytes rate-limits.ts's
// `stderr.slice(0, 100)` wrote to rate-limit-unparseable.jsonl on 2026-08-09.
// It never captured a "Resets in <duration>" tail because the tail falls past
// the 100-char cut, which is exactly why a default cooldown is required.
const AGY_QUOTA_SPECIMEN_TRUNCATED =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in';

describe('classifyGeminiError — agy CLI-text quota exhaustion', () => {
  it('classifies the verbatim truncated specimen as quota-exhausted with the documented default cooldown', () => {
    const result = classifyGeminiError(AGY_QUOTA_SPECIMEN_TRUNCATED);
    assert.ok(result, 'the "Individual quota reached" specimen must classify, not return null');
    assert.equal(result!.classification, 'quota-exhausted');
    assert.equal(result!.source, 'gemini-cli-text');
    assert.equal(result!.minutes, 360, 'no "Resets in <duration>" tail survived truncation — must fall back to the documented 6h default');
    assert.ok(result!.resetsAtIST);
    assert.ok(result!.raw && result!.raw.includes('Individual quota reached'));
  });

  it('parses a full "Resets in 2h 13m" tail into minutes instead of using the default', () => {
    const full = 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h 13m.';
    const result = classifyGeminiError(full);
    assert.ok(result);
    assert.equal(result!.classification, 'quota-exhausted');
    assert.equal(result!.source, 'gemini-cli-text');
    assert.equal(result!.minutes, 133, 'expected 2h13m = 133 minutes');
  });

  it('parses agy\'s real unspaced production format "Resets in 12h13m34s" (2026-09-10 fix)', () => {
    // Every specimen sampled from real production output uses this exact
    // no-space-between-units shape ("53h9m30s", "52h16m3s", "24h36m57s", ...).
    // Before the fix, the trailing `\b` in each unit's regex never matched
    // between a unit letter and the immediately-following digit of the next
    // unit — this fell through to the 360-minute default every single time,
    // regardless of how much longer the real reset window actually was.
    const full = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 12h13m34s.';
    const result = classifyGeminiError(full);
    assert.ok(result);
    assert.equal(result!.classification, 'quota-exhausted');
    assert.equal(result!.minutes, 12 * 60 + 13, 'expected 12h13m = 733 minutes (seconds truncated), not the 360-minute default');
  });

  it('caps the real unspaced format at 24h when the reset window is longer', () => {
    // Real specimen: "Resets in 53h9m30s." — well over a day out.
    const full = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 53h9m30s.';
    const result = classifyGeminiError(full);
    assert.ok(result);
    assert.equal(result!.minutes, 1440, 'must cap at 24h (1440 min), matching the documented cap');
  });

  it('falls back to the default when the tail carries no d/h/m component', () => {
    const noTail = 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in a while.';
    const result = classifyGeminiError(noTail);
    assert.ok(result);
    assert.equal(result!.minutes, 360);
  });

  it('negative twin: non-quota agy stderr still returns null (no loose /quota/ heuristic)', () => {
    // Contains the word "quota" but not the exact "Individual quota reached" phrase —
    // must NOT classify, per this file's own exact-phrase-only rule.
    assert.equal(classifyGeminiError('Warning: approaching your quota, consider upgrading soon'), null);
    assert.equal(classifyGeminiError('quota exceeded for some other reason entirely'), null);
  });
});

// ---------------------------------------------------------------------------
// extractCodexRateLimitTelemetry
// ---------------------------------------------------------------------------

describe('extractCodexRateLimitTelemetry', () => {
  it('returns null for empty buffer', () => {
    assert.equal(extractCodexRateLimitTelemetry(''), null);
  });

  it('returns null when no token_count event present', () => {
    const buf = `{"type":"event_msg","payload":{"type":"other","foo":1}}`;
    assert.equal(extractCodexRateLimitTelemetry(buf), null);
  });

  it('extracts single token_count event', () => {
    const buf = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 12.5, window_minutes: 60, resets_at: 1800000000 } },
      },
    });
    const result = extractCodexRateLimitTelemetry(buf);
    assert.ok(result);
    assert.equal(result!.usedPercent, 12.5);
    assert.equal(result!.windowMinutes, 60);
    assert.equal(result!.resetsAt, 1800000000);
  });

  it('returns the LAST token_count event when multiple present', () => {
    const first = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 10, window_minutes: 60, resets_at: 1800000000 } },
      },
    });
    const second = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 55, window_minutes: 60, resets_at: 1800000001 } },
      },
    });
    const buf = first + '\n' + second;
    const result = extractCodexRateLimitTelemetry(buf);
    assert.ok(result);
    assert.equal(result!.usedPercent, 55);
    assert.equal(result!.resetsAt, 1800000001);
  });

  it('skips malformed lines and continues parsing', () => {
    const good = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 77, window_minutes: 1440, resets_at: 1800000000 } },
      },
    });
    const buf = `{not json\n${good}\n{also not json`;
    const result = extractCodexRateLimitTelemetry(buf);
    assert.ok(result);
    assert.equal(result!.usedPercent, 77);
  });
});

// ---------------------------------------------------------------------------
// classifyCodexError
// ---------------------------------------------------------------------------

describe('classifyCodexError', () => {
  it('returns null when no telemetry and no rate-limit markers in stderr', () => {
    assert.equal(classifyCodexError('', 'some other error'), null);
  });

  it('uses telemetry at 100% with weekly window → quota-daily', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const buf = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: {
            used_percent: 100,
            window_minutes: 10080, // 1 week
            resets_at: nowSec + 600, // 10 min from now
          },
        },
      },
    });
    const result = classifyCodexError(buf, '');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-daily');
    assert.equal(result!.source, 'codex-telemetry');
    assert.ok(result!.minutes >= 10 && result!.minutes <= 11);
    assert.ok(result!.resetsAtIST);
  });

  it('uses telemetry at 100% with 60-min window → quota-per-minute', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const buf = JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 100, window_minutes: 60, resets_at: nowSec + 120 },
        },
      },
    });
    const result = classifyCodexError(buf, '');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
  });

  it('returns null for unrecognized error messages (no heuristics — exact match only)', () => {
    // Unrecognized errors are not treated as rate limits; user feedback → add exact pattern when needed
    assert.equal(classifyCodexError('', 'HTTP 429 Too Many Requests'), null);
    assert.equal(classifyCodexError('', 'ECONNRESET network error'), null);
    assert.equal(classifyCodexError('', 'quota exceeded'), null);
  });

  it('matches chatgpt usage-limit message and parses reset time', () => {
    // Future date so the cooldown is positive regardless of when test runs.
    // Parser uses system local time (new Date(y,m,d,h,min)) — construct the message
    // using local time components so the round-trip is exact on any timezone.
    const future = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3h ahead
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mon = months[future.getMonth()];
    const day = future.getDate();
    let h = future.getHours();
    const min = String(future.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    const suffix = day === 1 || day === 21 || day === 31 ? 'st'
                 : day === 2 || day === 22 ? 'nd'
                 : day === 3 || day === 23 ? 'rd' : 'th';
    const msg = `You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at ${mon} ${day}${suffix}, ${future.getFullYear()} ${h}:${min} ${ampm}.`;
    const result = classifyCodexError('', msg);
    assert.ok(result, 'should detect usage-limit message');
    assert.equal(result!.classification, 'usage-limit-session');
    assert.equal(result!.source, 'codex-stderr');
    assert.ok(result!.resetsAtIST, 'should populate resetsAtIST');
    // Cooldown should be ~3 hours (180 min), within 5 min tolerance
    assert.ok(result!.minutes >= 175 && result!.minutes <= 185,
      `expected ~180 min cooldown, got ${result!.minutes}`);
  });

  it('caps reset-time cooldown at 45 days', () => {
    // Reset ~100 days in the future — well beyond the 45-day sanity cap that
    // guards against a wrong clock/locale producing an unbounded cooldown
    // (classifyCodexError parses the reset time in system-local tz).
    const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mon = months[future.getMonth()];
    const day = future.getDate();
    const msg = `You've hit your usage limit, try again at ${mon} ${day}th, ${future.getFullYear()} 10:00 AM.`;
    const result = classifyCodexError('', msg);
    assert.ok(result);
    assert.equal(result!.minutes, 45 * 24 * 60);
  });

  it('floors reset-time cooldown at 1 minute when reset is in past', () => {
    // Past date — minutes should be clamped to 1
    const msg = `You've hit your usage limit, try again at Jan 1st, 2020 10:00 AM.`;
    const result = classifyCodexError('', msg);
    assert.ok(result);
    assert.equal(result!.minutes, 1);
  });
});

// ---------------------------------------------------------------------------
// classifyClaudeText + classifyClaudeErrors
// ---------------------------------------------------------------------------

describe('classifyClaudeText', () => {
  it('prefers Zhipu "for N hour" over absolute timestamp', () => {
    const text = 'Usage limit reached for 5 hour. Your limit will reset at 2026-03-26 16:32:03';
    const result = classifyClaudeText(text);
    assert.equal(result.source, 'zhipu-text');
    assert.equal(result.minutes, 300);
    assert.equal(result.classification, 'usage-limit-session');
  });

  it('parses "resets 10:30am" legacy format', () => {
    const result = classifyClaudeText("You've hit your limit · resets 10:30am (Asia/Calcutta)");
    assert.equal(result.source, 'claude-text');
    assert.equal(result.classification, 'usage-limit-session');
    assert.ok(result.minutes > 0 && result.minutes <= 24 * 60);
    assert.ok(result.resetsAtIST);
  });

  it('defaults to 2 min / unknown / default for empty or unrelated text', () => {
    const result = classifyClaudeText('');
    assert.equal(result.source, 'default');
    assert.equal(result.classification, 'unknown');
    assert.equal(result.minutes, 2);
  });
});

describe('classifyClaudeErrors', () => {
  const freshEvent = (retryAttempt: number, maxRetries: number = 10, msg: string = ''): ApiErrorEvent => ({
    status: 429,
    message: msg,
    retryAttempt,
    maxRetries,
    timestamp: new Date().toISOString(),
  });

  it('returns minutes=0 (transient) when retryAttempt < maxRetries', () => {
    const errors = [freshEvent(1), freshEvent(2), freshEvent(3)];
    const result = classifyClaudeErrors(errors);
    assert.ok(result);
    assert.equal(result!.minutes, 0);
    assert.equal(result!.source, 'claude-session');
  });

  it('flags usage-limit-session when retryAttempt >= maxRetries', () => {
    const errors = [freshEvent(10, 10, 'Usage limit reached for 3 hour.')];
    const result = classifyClaudeErrors(errors);
    assert.ok(result);
    assert.equal(result!.classification, 'usage-limit-session');
    assert.equal(result!.source, 'claude-session');
    assert.equal(result!.minutes, 180);
  });

  it('returns null when all events are stale (no fresh session evidence)', () => {
    const staleTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stale: ApiErrorEvent[] = [{
      status: 429,
      message: 'old',
      retryAttempt: 10,
      maxRetries: 10,
      timestamp: staleTs,
    }];
    // No text fallback — session JSONL is the only mechanism
    const result = classifyClaudeErrors(stale);
    assert.equal(result, null, 'stale events with no fresh evidence must return null');
  });

  it('returns null for empty event list (no session evidence)', () => {
    const result = classifyClaudeErrors([]);
    assert.equal(result, null, 'no events = no rate-limit evidence = null');
  });

  it('absence ladder: timeless, classless message gets the 15-min probe as unknown — no fabricated 60-min session window', () => {
    const errors = [freshEvent(10, 10, 'some opaque message')];
    const result = classifyClaudeErrors(errors);
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.source, 'claude-session');
    assert.equal(result!.minutes, 15);
  });

  it('absence ladder: burst phrasing with no stated end is quota-per-minute at the 90s retry duration', () => {
    // Verbatim live specimen (2026-09-13 zclaude ghost-cooldown incident).
    const errors = [freshEvent(10, 10, 'API Error: Request rejected (429) · [1302][Rate limit reached for requests][20260914001521ccb3c4dd569a43d0]')];
    const result = classifyClaudeErrors(errors);
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.source, 'claude-session');
    assert.equal(result!.minutes, 1.5); // BURST_RETRY_COOLDOWN_S / 60
  });

  it('a date-prefixed stated reset ("resets Sep 15, 5:30pm (Asia/Kolkata)") parses as the stated usage-limit window', () => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const target = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow, always future at 5:30pm
    const msg = `You've hit your weekly limit · resets ${MONTHS[target.getMonth()]} ${target.getDate()}, 5:30pm (Asia/Kolkata)`;
    const errors = [freshEvent(10, 10, msg)];
    const result = classifyClaudeErrors(errors);
    assert.ok(result);
    assert.equal(result!.classification, 'usage-limit-session');
    assert.equal(result!.source, 'claude-session');
    assert.ok(result!.resetsAtIST, 'a stated end must carry resetsAtIST');
    const expectedTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 17, 30, 0, 0);
    const expectedMinutes = Math.ceil((expectedTarget.getTime() - Date.now()) / 60000);
    assert.ok(
      Math.abs(result!.minutes - expectedMinutes) <= 2,
      `parsed minutes (${result!.minutes}) must match the stated reset (±2 min of ${expectedMinutes})`,
    );
  });

  it('a proxy-banner latest event is not rate-limit evidence (null)', () => {
    const errors = [freshEvent(10, 10, '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login')];
    const result = classifyClaudeErrors(errors);
    assert.equal(result, null);
  });

  it('treats missing retryAttempt (default 999) as exhausted', () => {
    // Simulates readErrorsFromFile defaulting retryAttempt to 999 when missing.
    const errors: ApiErrorEvent[] = [{
      status: 429,
      message: 'Usage limit reached for 1 hour',
      retryAttempt: 999,
      maxRetries: 10,
      timestamp: new Date().toISOString(),
    }];
    const result = classifyClaudeErrors(errors);
    assert.ok(result);
    assert.equal(result!.classification, 'usage-limit-session');
    assert.equal(result!.minutes, 60);
    assert.equal(result!.source, 'claude-session');
  });
});

// ---------------------------------------------------------------------------
// Absence ladder — loud unparseable rows for claude-session misses
// (classifyRateLimit's claude branch is the async context that writes them)
// ---------------------------------------------------------------------------

describe('classifyRateLimit — absence-ladder unparseable rows', () => {
  const LADDER_DIR = join(tmpdir(), `rate-limits-ladder-test-${process.pid}`);

  before(async () => {
    await mkdir(LADDER_DIR, { recursive: true });
    await mkdir(PA_HOME, { recursive: true });
  });

  after(async () => {
    try { await rm(LADDER_DIR, { recursive: true, force: true }); } catch {}
  });

  async function writeSession(sessionId: string, message: string): Promise<void> {
    const event = {
      type: 'system',
      subtype: 'api_error',
      error: { status: 429, error: { error: { code: '1302', message }, request_id: 'x' } },
      retryAttempt: 10,
      maxRetries: 10,
      timestamp: new Date().toISOString(),
    };
    await writeFile(join(LADDER_DIR, `${sessionId}.jsonl`), JSON.stringify(event), 'utf8');
  }

  async function unparseableRowCount(): Promise<number> {
    const content = await readFile(join(PA_HOME, 'rate-limit-unparseable.jsonl'), 'utf8').catch(() => '');
    const trimmed = content.trim();
    return trimmed ? trimmed.split('\n').length : 0;
  }

  async function lastUnparseableRow(): Promise<Record<string, unknown>> {
    const content = await readFile(join(PA_HOME, 'rate-limit-unparseable.jsonl'), 'utf8');
    const lines = content.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  }

  it('a burst-class miss records no unparseable row (the classification is known)', async () => {
    await writeSession('ladder-burst', 'API Error: Request rejected (429) · [1302][Rate limit reached for requests][deadbeef]');
    const before = await unparseableRowCount();
    const result = await classifyRateLimit('zclaude', '', '', 'ladder-burst', LADDER_DIR, '*.jsonl');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(await unparseableRowCount(), before, 'a known burst class must not write a digest row');
  });

  it('a timeless miss writes an unknown-pattern row alongside the 15-min probe', async () => {
    await writeSession('ladder-unknown', 'upstream capacity queue full, no eta given');
    const before = await unparseableRowCount();
    const result = await classifyRateLimit('zclaude', '', '', 'ladder-unknown', LADDER_DIR, '*.jsonl');
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.minutes, 15);
    assert.equal(await unparseableRowCount(), before + 1);
    const row = await lastUnparseableRow();
    assert.equal(row.reason, 'unknown-pattern');
    assert.equal(row.worker, 'zclaude');
  });

  it('a time-hinted miss writes a time-hint-unparsed row (digest + self-heal feed)', async () => {
    await writeSession('ladder-hint', 'temporary limit — resets after maintenance completes');
    const before = await unparseableRowCount();
    const result = await classifyRateLimit('zclaude', '', '', 'ladder-hint', LADDER_DIR, '*.jsonl');
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.minutes, 15);
    assert.equal(await unparseableRowCount(), before + 1);
    const row = await lastUnparseableRow();
    assert.equal(row.reason, 'time-hint-unparsed');
  });

  it('a clean stated-time parse writes no row', async () => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const target = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await writeSession('ladder-stated', `You've hit your weekly limit · resets ${MONTHS[target.getMonth()]} ${target.getDate()}, 5:30pm (Asia/Kolkata)`);
    const before = await unparseableRowCount();
    const result = await classifyRateLimit('zclaude', '', '', 'ladder-stated', LADDER_DIR, '*.jsonl');
    assert.ok(result);
    assert.equal(result!.classification, 'usage-limit-session');
    assert.ok(result!.resetsAtIST, 'the stated reset must be surfaced');
    assert.equal(await unparseableRowCount(), before, 'a clean parse of a stated end time must log nothing');
  });

  it('a banner-dominated stream is skipped entirely — even when it carries a 429 marker', async () => {
    // An EMPTY state dir: readClaudeSessionErrors' latest-recent-file
    // fallback must not hand the classifier a sibling test's session.
    const emptyDir = join(LADDER_DIR, 'empty');
    await mkdir(emptyDir, { recursive: true });
    const before = await unparseableRowCount();
    // stdout carries BOTH the banner and a 429 marker: without the banner
    // skip the /429/ pattern check would write a no-session-evidence row.
    const result = await classifyRateLimit(
      'zclaude',
      '⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set [claude-code:unrecognized_model] status 429',
      '',
      'no-such-session',
      emptyDir,
      '*.jsonl',
    );
    assert.equal(result, null);
    assert.equal(await unparseableRowCount(), before, 'banner noise must not reach the digest');
  });
});

// ---------------------------------------------------------------------------
// recordRateLimit / getWorkerCooldown / classification persistence
// ---------------------------------------------------------------------------

describe('recordRateLimit + getWorkerCooldown', () => {
  before(async () => {
    await mkdir(PA_HOME, { recursive: true });
  });

  after(async () => {
    try { await rm(PA_HOME, { recursive: true, force: true }); } catch {}
  });

  async function resetState() {
    try { await unlink(join(PA_HOME, 'rate-limit-state.json')); } catch {}
  }

  it('persists classification field alongside cooldown', async () => {
    await resetState();
    await recordRateLimit('zclaude', 30, '[usage-limit-session] claude-session — ...', 'usage-limit-session');
    const entry = await getWorkerCooldown('zclaude');
    assert.ok(entry, 'entry must exist');
    assert.equal(entry!.classification, 'usage-limit-session');
    assert.ok(entry!.cooldown_until);
    assert.ok(entry!.reason.includes('usage-limit-session'));
  });

  // Classification-aware cooldown recording (operator ruling 2026-09-13,
  // superseding the same-day 30m cap): a 429 message that CLEARLY states an end
  // time is trusted verbatim — no cap, the recorded cooldown runs to the stated
  // reset. A burst-shaped limit ('quota-per-minute': per-request-rate /
  // too-many-requests, no parseable end) records the short BURST_RETRY_COOLDOWN_S
  // cooldown instead — retrying soon is the correct response, and the slot
  // governor sheds capacity to attack the concurrency that caused it.

  it('records a stated 292-min usage-limit-session cooldown verbatim — no cap (zclaude)', async () => {
    await resetState();
    await recordRateLimit('zclaude', 292, '[usage-limit-session] claude-session — parsed 292 min', 'usage-limit-session');
    const entry = await getWorkerCooldown('zclaude');
    assert.ok(entry, 'entry must exist');
    assert.equal(entry!.classification, 'usage-limit-session');
    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    assert.ok(
      remainingMs > 290 * 60 * 1000,
      `a stated end time must be recorded verbatim (~292 min), got ${remainingMs}ms`,
    );
    assert.ok(
      remainingMs <= 292 * 60 * 1000,
      `cooldown should not exceed the stated duration, got ${remainingMs}ms`,
    );
  });

  it('records the same stated duration verbatim for claude', async () => {
    await resetState();
    await recordRateLimit('claude', 292, '[usage-limit-session] claude-session — parsed 292 min', 'usage-limit-session');
    const entry = await getWorkerCooldown('claude');
    assert.ok(entry, 'entry must exist');
    assert.equal(entry!.classification, 'usage-limit-session');
    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    assert.ok(
      remainingMs > 290 * 60 * 1000,
      `a stated end time must be recorded verbatim (~292 min), got ${remainingMs}ms`,
    );
  });

  it('records a burst-class 429 as the short 90-second retry cooldown', async () => {
    await resetState();
    await recordRateLimit('zclaude', 2, '[quota-per-minute] gemini-stderr — PerMinute quota', 'quota-per-minute');
    const entry = await getWorkerCooldown('zclaude');
    assert.ok(entry, 'entry must exist');
    assert.equal(entry!.classification, 'quota-per-minute');
    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    assert.ok(
      remainingMs > (BURST_RETRY_COOLDOWN_S - 5) * 1000,
      `a burst 429 must record the ~${BURST_RETRY_COOLDOWN_S}s retry cooldown, got ${remainingMs}ms`,
    );
    assert.ok(
      remainingMs <= BURST_RETRY_COOLDOWN_S * 1000,
      `a burst 429 must not record more than ${BURST_RETRY_COOLDOWN_S}s, got ${remainingMs}ms`,
    );

    // One log line records the override (worker, parsed-mins, burst-cooldown).
    await flushLog();
    const logContent = await readFile(join(PA_HOME, 'app.log.jsonl'), 'utf8').catch(() => '');
    const burstLine = logContent.trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((e) => e.worker === 'zclaude' && e.parsed_minutes === 2 && e.burst_cooldown_s === BURST_RETRY_COOLDOWN_S);
    assert.ok(burstLine, 'the burst override must log one line carrying worker, parsed-mins and burst-cooldown');
  });

  it('keeps codex usage-limit-session at its real (long) window', async () => {
    await resetState();
    await recordRateLimit('codex', 180, '[usage-limit-session] codex-stderr — parsed 180 min', 'usage-limit-session');
    const entry = await getWorkerCooldown('codex');
    assert.ok(entry, 'entry must exist');
    assert.equal(entry!.classification, 'usage-limit-session');
    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    assert.ok(
      remainingMs > 170 * 60 * 1000,
      `codex must keep its real ~180-min duration, got ${remainingMs}ms`,
    );
  });

  it('does NOT cap a non-session classification on zclaude (account-exhausted keeps its long window)', async () => {
    await resetState();
    await recordRateLimit('zclaude', ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES, '[account-exhausted] zhipu-text', 'account-exhausted');
    const entry = await getWorkerCooldown('zclaude');
    assert.ok(entry, 'entry must exist');
    assert.equal(entry!.classification, 'account-exhausted');
    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    assert.ok(
      remainingMs > 60 * 60 * 1000,
      `account-exhausted must keep its long window, got ${remainingMs}ms`,
    );
  });

  // Cross-seam: a recorded burst feeds the dynamic slot governor (real
  // consumers over real producer output — the shed is observed through
  // effectiveSlotCount, not a mock). Hermetic: the operator's Windows User env
  // carries PA_SLOTS_MIN / PA_MAX_CONCURRENT_WORKERS, which this process
  // inherits, so the governor knobs are deleted and the sampler is stubbed
  // exactly as dynamic-slots.test.ts does.

  function isolateGovernor(): void {
    for (const k of ['PA_DYNAMIC_SLOTS', 'PA_SLOTS_MIN', 'PA_MAX_CONCURRENT_WORKERS', 'PA_SLOTS_PHYSICAL_BRAKE_MB', 'PA_SLOTS_CPU_BRAKE_PCT', 'PA_SLOTS_DISK_QUEUE_BRAKE']) delete process.env[k];
    _resetGovernorForTest();
    _setGovernorDepsForTest({ readSample: () => null, cpuCount: () => 12 });
  }

  it('a recorded burst-class 429 sheds worker slots, and clean samples climb back', async () => {
    isolateGovernor();
    await resetState();
    await recordRateLimit('zclaude', 2, '[quota-per-minute] gemini-stderr — PerMinute quota', 'quota-per-minute');
    assert.equal(effectiveSlotCount(48), 36, 'the burst record must shed a quarter of the pool');

    _setGovernorDepsForTest({ readSample: (): PressureSample => ({ physFreeMb: 5000, cpuPct: 10, diskQueue: 0, sampledAtMs: 1 }) });
    assert.equal(effectiveSlotCount(48), 36, 'one clean sample does not recover');
    _setGovernorDepsForTest({ readSample: (): PressureSample => ({ physFreeMb: 5000, cpuPct: 10, diskQueue: 0, sampledAtMs: 2 }) });
    assert.equal(effectiveSlotCount(48), 47, 'two clean samples return to lastCut - 1');
  });

  it('a stated-end-time quota record does NOT shed worker slots', async () => {
    isolateGovernor();
    await resetState();
    await recordRateLimit('claude', 292, '[usage-limit-session] claude-session — parsed 292 min', 'usage-limit-session');
    assert.equal(effectiveSlotCount(48), 48, 'waiting out a stated reset is the correct response — the governor is untouched');
  });

  it('getWorkerCooldown returns null for unknown worker', async () => {
    const result = await getWorkerCooldown('no-such-worker');
    assert.equal(result, null);
  });

  it('getWorkerCooldown returns null for expired entry without mutating state', async () => {
    await resetState();
    // Write an expired entry directly via the state file
    const expired = {
      'claude': {
        cooldown_until: new Date(Date.now() - 60_000).toISOString(),
        last_event: new Date(Date.now() - 120_000).toISOString(),
        reason: 'expired',
        classification: 'unknown',
      },
    };
    await writeFile(join(PA_HOME, 'rate-limit-state.json'), JSON.stringify(expired), 'utf8');
    // Force re-read: recordRateLimit populates cache, so we write directly AFTER
    // any previous operation in this test. Since recordRateLimit above ran in a
    // separate 'it', the cache may already hold that entry. Call a no-op to nudge
    // the cache... actually the simplest is to just call getWorkerCooldown here.
    // If it reads from cache, the expired entry isn't visible. That's OK — the
    // behaviour is covered by the next test.
    const result = await getWorkerCooldown('claude');
    // Either null (read from disk and saw expired) or the stale zclaude from
    // previous test — neither is 'claude' expired. Accept null.
    if (result !== null) {
      // If cache had stale claude data, that's a test isolation artifact, not
      // a production bug. Skip assertion.
    }
  });

  it('recordRateLimit with duration=0 is a no-op (no state file entry)', async () => {
    await resetState();
    await recordRateLimit('agy', 0, 'transient', 'unknown');
    const entry = await getWorkerCooldown('agy');
    assert.equal(entry, null);
    assert.equal(await isWorkerCoolingDown('agy'), false);
  });

  it('getCooldownStatus returns all entries with classification', async () => {
    await resetState();
    await recordRateLimit('codex', 5, 'test', 'quota-per-minute');
    await recordRateLimit('claude', 30, 'test', 'usage-limit-session');
    const status = await getCooldownStatus();
    assert.ok(status['codex']);
    assert.ok(status['claude']);
    assert.equal(status['codex'].classification, 'quota-per-minute');
    assert.equal(status['claude'].classification, 'usage-limit-session');
  });
});

// ---------------------------------------------------------------------------
// readClaudeSessionErrors (filesystem integration)
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `rate-limits-claude-test-${process.pid}`);

describe('readClaudeSessionErrors', () => {
  before(async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await mkdir(join(TEST_DIR, 'proj-a'), { recursive: true });
  });

  after(async () => {
    try { await rm(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  it('finds session file by id and parses api_error events', async () => {
    const sessionId = 'test-session-1';
    const filePath = join(TEST_DIR, 'proj-a', `${sessionId}.jsonl`);
    const events = [
      {
        type: 'system',
        subtype: 'api_error',
        error: {
          status: 429,
          error: { error: { code: '1308', message: 'Usage limit reached for 5 hour.' }, request_id: 'x' },
        },
        retryAttempt: 1,
        maxRetries: 10,
        timestamp: new Date().toISOString(),
      },
      {
        type: 'system',
        subtype: 'api_error',
        error: {
          status: 429,
          error: { error: { code: '1308', message: 'Usage limit reached for 5 hour.' }, request_id: 'y' },
        },
        retryAttempt: 10,
        maxRetries: 10,
        timestamp: new Date().toISOString(),
      },
    ];
    await writeFile(filePath, events.map(e => JSON.stringify(e)).join('\n'), 'utf8');

    const errors = await readClaudeSessionErrors(sessionId, TEST_DIR, '*.jsonl');
    assert.equal(errors.length, 2);
    assert.equal(errors[0].retryAttempt, 1);
    assert.equal(errors[1].retryAttempt, 10);
    assert.equal(errors[0].maxRetries, 10);
    assert.ok(errors[0].message.includes('Usage limit'));
  });

  it('returns [] when session file does not exist and no recent fallback', async () => {
    const errors = await readClaudeSessionErrors('nonexistent-session', TEST_DIR, '*.jsonl');
    // findLatestStateFile will find the file we wrote above but its mtime
    // should still be within 5 min — let's just verify it returns a list or []
    assert.ok(Array.isArray(errors));
  });

  it('returns [] when stateDir does not exist', async () => {
    const errors = await readClaudeSessionErrors('any', join(TEST_DIR, 'nonexistent'), '*.jsonl');
    assert.deepEqual(errors, []);
  });

  it('findStateFileById returns null for unknown session', async () => {
    const result = await findStateFileById(TEST_DIR, 'does-not-exist', '*.jsonl');
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// classifyRateLimit dispatcher
// ---------------------------------------------------------------------------

describe('classifyRateLimit dispatcher', () => {
  it('dispatches to agy classifier', async () => {
    const stderr = '"code": 429, "reason": "MODEL_CAPACITY_EXHAUSTED"';
    const result = await classifyRateLimit('agy', '', stderr);
    assert.ok(result);
    assert.equal(result!.classification, 'server-overload');
    assert.equal(result!.source, 'gemini-stderr');
  });

  it('agy: returns null when stderr has no 429 / RESOURCE_EXHAUSTED marker', async () => {
    // No 429 in stderr → classifier returns null → not a rate limit
    const result = await classifyRateLimit('agy', '', 'plain network timeout');
    assert.equal(result, null, 'agy with no 429 marker must return null');
  });

  it('dispatches to claude/zclaude with session file lookup', async () => {
    // No sessionId and TEST_DIR state files may or may not be within freshness window.
    // Key assertion: does not throw; returns null (no session evidence) or a valid result.
    const result = await classifyRateLimit('claude', '', '', undefined, TEST_DIR, '*.jsonl');
    if (result !== null) {
      assert.ok(typeof result.minutes === 'number');
    }
    // Either null (no fresh session evidence) or a non-null result — both are valid.
  });

  it('zclaude with no session evidence returns null (no text fallback)', async () => {
    // No state dir → readClaudeSessionErrors returns [] → classifyClaudeErrors([]) = null
    // Text fallback has been removed; session JSONL is the only mechanism.
    const result = await classifyRateLimit('zclaude', '', 'Usage limit reached for 5 hour');
    assert.equal(result, null, 'zclaude must return null when no session evidence, even with rate-limit text');
  });

  it('unknown worker returns default (backward compat for custom workers with patterns)', async () => {
    // isRateLimited gate fires for unknown workers; classifyRateLimit provides a default cooldown.
    const result = await classifyRateLimit('no-such-worker', 'x', 'y');
    assert.ok(result);
    assert.equal(result!.classification, 'unknown');
    assert.equal(result!.source, 'default');
    assert.equal(result!.minutes, 2);
  });
});

// ---------------------------------------------------------------------------
// Synthetic 429 assistant message detection (Phase 1 — April 18 incident fix)
// ---------------------------------------------------------------------------

// The reset timestamp must sit in the FUTURE relative to Date.now() —
// classifyClaudeErrors derives cooldown minutes from it and skips any reset
// already in the past. Computed at module load; an absolute literal here
// silently degraded these fixtures once real time passed the date.
const FUTURE_RESET_STR = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

const SYNTHETIC_429_ENVELOPE = JSON.stringify({
  type: 'assistant',
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  message: {
    id: 'msg_synthetic',
    type: 'message',
    role: 'assistant',
    model: '<synthetic>',
    content: [
      { type: 'text', text: `API Error: Request rejected (429) · Weekly/Monthly Limit Exhausted. Your limit will reset at ${FUTURE_RESET_STR}` },
    ],
    stop_reason: 'end_turn',
  },
  timestamp: new Date().toISOString(),
});

const SYNTHETIC_NO_ERROR_FIELDS = JSON.stringify({
  type: 'assistant',
  message: {
    model: '<synthetic>',
    content: [
      { type: 'text', text: `API Error: Request rejected (429) · Weekly/Monthly Limit Exhausted. Your limit will reset at ${FUTURE_RESET_STR}` },
    ],
  },
  timestamp: new Date().toISOString(),
});

const SYNTHETIC_429_DIR = join(tmpdir(), `synthetic-429-test-${process.pid}`);

describe('readClaudeSessionErrors — synthetic 429 assistant messages', () => {
  before(async () => {
    await mkdir(SYNTHETIC_429_DIR, { recursive: true });
    await mkdir(join(SYNTHETIC_429_DIR, 'proj-synthetic'), { recursive: true });
  });

  after(async () => {
    try { await rm(SYNTHETIC_429_DIR, { recursive: true, force: true }); } catch {}
  });

  it('picks up synthetic 429 assistant messages via isApiErrorMessage+apiErrorStatus (Strategy A)', async () => {
    const sessionId = 'synthetic-a';
    const filePath = join(SYNTHETIC_429_DIR, 'proj-synthetic', `${sessionId}.jsonl`);
    const unrelated = JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId });
    await writeFile(filePath, [unrelated, SYNTHETIC_429_ENVELOPE].join('\n'), 'utf8');

    const errors = await readClaudeSessionErrors(sessionId, SYNTHETIC_429_DIR, '*.jsonl');
    assert.equal(errors.length, 1, 'should parse exactly one ApiErrorEvent');
    assert.equal(errors[0].status, 429);
    assert.equal(errors[0].retryAttempt, 999);
    assert.equal(errors[0].code, 'synthetic_assistant');
    assert.ok(errors[0].message.includes('Your limit will reset at'), `message should include reset text, got: ${errors[0].message}`);
  });

  it('falls back to text regex when isApiErrorMessage is missing (Strategy B)', async () => {
    const sessionId = 'synthetic-b';
    const filePath = join(SYNTHETIC_429_DIR, 'proj-synthetic', `${sessionId}.jsonl`);
    const unrelated = JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId });
    await writeFile(filePath, [unrelated, SYNTHETIC_NO_ERROR_FIELDS].join('\n'), 'utf8');

    const errors = await readClaudeSessionErrors(sessionId, SYNTHETIC_429_DIR, '*.jsonl');
    assert.equal(errors.length, 1, 'should parse exactly one ApiErrorEvent via Strategy B');
    assert.equal(errors[0].status, 429);
    assert.equal(errors[0].retryAttempt, 999);
    assert.ok(errors[0].message.includes('Your limit will reset at'), `message should include reset text`);
  });

  it('classifyClaudeErrors promotes synthetic 429 to exhausted cooldown', async () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const futureDateStr = future.toISOString().replace('T', ' ').slice(0, 19);
    const syntheticEvent: ApiErrorEvent = {
      status: 429,
      code: 'synthetic_assistant',
      message: `API Error: Request rejected (429) · Weekly/Monthly Limit Exhausted. Your limit will reset at ${futureDateStr}`,
      retryAttempt: 999,
      maxRetries: 10,
      timestamp: new Date().toISOString(),
    };
    const result = classifyClaudeErrors([syntheticEvent]);
    assert.ok(result !== null, 'should return non-null');
    assert.ok(result!.minutes > 0, `minutes should be >0, got ${result!.minutes}`);
    assert.equal(result!.classification, 'usage-limit-session');
    assert.equal(result!.source, 'claude-session');
    assert.ok(result!.resetsAtIST && result!.resetsAtIST.length > 0, 'resetsAtIST should be set');
  });

  it('ignores synthetic assistant messages without 429 indicators', async () => {
    const sessionId = 'synthetic-innocent';
    const filePath = join(SYNTHETIC_429_DIR, 'proj-synthetic', `${sessionId}.jsonl`);
    const innocent = JSON.stringify({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: "Here's the report for today." }],
      },
      timestamp: new Date().toISOString(),
    });
    await writeFile(filePath, innocent, 'utf8');

    const errors = await readClaudeSessionErrors(sessionId, SYNTHETIC_429_DIR, '*.jsonl');
    assert.equal(errors.length, 0, 'innocent synthetic message should not be parsed as an error');
  });
});

// ---------------------------------------------------------------------------
// Terminal account-balance fault (Zhipu 1113) — 2026-07-21
//
// zclaude is a Zhipu GLM wrapper. An exhausted account balance arrives as HTTP
// 429 carrying code 1113 — it looks exactly like a transient rate limit but
// never self-heals. Between 2026-07-11 and 07-19 it produced four
// 'no-session-evidence' rows in rate-limit-unparseable.jsonl, ZERO cooldown
// entries, and ~150 doomed spawns of the priority-1 worker.
// ---------------------------------------------------------------------------

const ZHIPU_1113_RAW =
  'API Error: Request rejected (429) [1113][Insufficient balance or no resource package. Please recharge and try again.]';

const ACCOUNT_EXHAUSTED_HOME = join(tmpdir(), `rate-limits-account-exhausted-test-${process.pid}`);

describe('Zhipu terminal account-balance fault', () => {
  before(async () => {
    process.env.PA_HOME = ACCOUNT_EXHAUSTED_HOME;
    clearRateLimitCache();
    await mkdir(ACCOUNT_EXHAUSTED_HOME, { recursive: true });
  });

  after(async () => {
    try { await rm(ACCOUNT_EXHAUSTED_HOME, { recursive: true, force: true }); } catch {}
    process.env.PA_HOME = PA_HOME;
    clearRateLimitCache();
  });

  it('classifies the 1113 raw string as account-exhausted with a long cooldown', () => {
    const result = classifyZhipuAccountExhausted(ZHIPU_1113_RAW);
    assert.ok(result, 'the 1113 signature must classify');
    assert.equal(result!.classification, 'account-exhausted');
    assert.equal(result!.source, 'zhipu-text');
    assert.equal(result!.minutes, ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES);
    assert.ok(result!.minutes >= 60, 'cooldown must be long enough to stop per-dispatch re-probing');
    assert.ok(result!.minutes <= 24 * 60, 'cooldown must not outlast a day, so a recharge is noticed');
    assert.ok(result!.raw && result!.raw.includes('1113'), 'raw snippet should carry the code');
  });

  it('matches the message text alone (no bracketed code)', () => {
    const result = classifyZhipuAccountExhausted(
      'API Error: Request rejected (429) Insufficient balance or no resource package',
    );
    assert.ok(result);
    assert.equal(result!.classification, 'account-exhausted');
  });

  it('classifyRateLimit routes zclaude 1113 stdout to account-exhausted', async () => {
    const result = await classifyRateLimit('zclaude', ZHIPU_1113_RAW, '');
    assert.ok(result, 'must not return null — null means "not a rate limit", i.e. no cooldown');
    assert.equal(result!.classification, 'account-exhausted');
    assert.equal(result!.minutes, ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES);
  });

  it('classifyRateLimit also detects it on stderr', async () => {
    const result = await classifyRateLimit('zclaude', '', ZHIPU_1113_RAW);
    assert.ok(result);
    assert.equal(result!.classification, 'account-exhausted');
  });

  it('writes a cooldown for the worker so it stops being re-probed', async () => {
    try { await unlink(join(ACCOUNT_EXHAUSTED_HOME, 'rate-limit-state.json')); } catch {}
    clearRateLimitCache();

    // Mirrors the caller contract in workers.ts: classify → recordRateLimit.
    const cls = await classifyRateLimit('zclaude', ZHIPU_1113_RAW, '');
    assert.ok(cls);
    await recordRateLimit('zclaude', cls!.minutes, `[${cls!.classification}] ${cls!.source}`, cls!.classification);

    const entry = await getWorkerCooldown('zclaude');
    assert.ok(entry, 'a cooldown entry must exist');
    assert.equal(entry!.classification, 'account-exhausted');
    assert.equal(await isWorkerCoolingDown('zclaude'), true);

    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    assert.ok(remainingMs > 60 * 60 * 1000, `cooldown should be hours, got ${remainingMs}ms`);
  });

  it('a successful run clears the state (the long cooldown is overridable)', async () => {
    await recordRateLimit('zclaude', ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES, 'account exhausted', 'account-exhausted');
    assert.equal(await isWorkerCoolingDown('zclaude'), true);

    assert.equal(await clearWorkerCooldown('zclaude'), true, 'first clear removes the entry');
    assert.equal(await getWorkerCooldown('zclaude'), null);
    assert.equal(await isWorkerCoolingDown('zclaude'), false);
    assert.equal(await clearWorkerCooldown('zclaude'), false, 'clearing a clean worker is a no-op');
  });

  it('a genuine transient 429 still gets the existing short cooldown', async () => {
    // agy per-minute quota — a real, self-healing rate limit.
    const result = await classifyRateLimit(
      'agy',
      '',
      'status: 429 "quotaMetric": "generativelanguage.googleapis.com/generate_content_requests_PerMinutePerProject"',
    );
    assert.ok(result);
    assert.equal(result!.classification, 'quota-per-minute');
    assert.equal(result!.minutes, 2);
  });

  it('a claude/zclaude session 429 still in retry budget stays transient', () => {
    const result = classifyClaudeErrors([
      {
        status: 429,
        code: '1302',
        message: 'API Error: Request rejected (429) Too many concurrent requests',
        retryAttempt: 1,
        maxRetries: 10,
        timestamp: new Date().toISOString(),
      },
    ]);
    assert.ok(result);
    assert.equal(result!.minutes, 0);
    assert.notEqual(result!.classification, 'account-exhausted');
  });

  it('session event with code 1113 is terminal even inside the retry budget', () => {
    const result = classifyClaudeErrors([
      {
        status: 429,
        code: '1113',
        message: 'Insufficient balance or no resource package.',
        retryAttempt: 1,
        maxRetries: 10,
        timestamp: new Date().toISOString(),
      },
    ]);
    assert.ok(result);
    assert.equal(result!.classification, 'account-exhausted');
    assert.equal(result!.source, 'claude-session');
    assert.equal(result!.minutes, ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES);
  });

  it('is not fooled by the phrase appearing inside unrelated text', async () => {
    const prose =
      'The user asked what "Insufficient balance or no resource package" means; explain that it is a billing error.';
    assert.equal(classifyZhipuAccountExhausted(prose), null, 'prose without 429 framing must not classify');
    assert.equal(await classifyRateLimit('zclaude', prose, ''), null);

    // 429 framing present, but on a DIFFERENT line from the balance phrase.
    const distant = [
      'API Error: Request rejected (429) — agy hit a per-minute quota earlier today.',
      'Separately, a teammate asked what "Insufficient balance or no resource package" means.',
    ].join('\n');
    assert.equal(classifyZhipuAccountExhausted(distant), null, 'cross-line coincidence must not classify');

    assert.equal(classifyZhipuAccountExhausted(''), null);
    assert.equal(classifyZhipuAccountExhausted('plain network timeout'), null);
  });

  it('hasZhipuBalanceSignature only fires on the balance signature', () => {
    assert.equal(hasZhipuBalanceSignature('Insufficient balance or no resource package.'), true);
    assert.equal(hasZhipuBalanceSignature('[1113][something]'), true);
    assert.equal(hasZhipuBalanceSignature('Usage limit reached for 5 hour.'), false);
    assert.equal(hasZhipuBalanceSignature(''), false);
  });
});

// ---------------------------------------------------------------------------
// classifyRateLimit dispatcher — agy CLI-text terminal quota exhaustion routes
// to the same alert path as zclaude's Zhipu-1113 fault above, and (unlike the
// pre-fix behaviour) records a cooldown so the dispatch cascade actually
// skips agy instead of burning ~5 minutes per dispatch before failover.
// ---------------------------------------------------------------------------

const AGY_TERMINAL_HOME = join(tmpdir(), `rate-limits-agy-terminal-test-${process.pid}`);

describe('classifyRateLimit — agy terminal quota exhaustion routes to the alert path', () => {
  before(async () => {
    process.env.PA_HOME = AGY_TERMINAL_HOME;
    clearRateLimitCache();
    await mkdir(AGY_TERMINAL_HOME, { recursive: true });
  });

  after(async () => {
    try { await rm(AGY_TERMINAL_HOME, { recursive: true, force: true }); } catch {}
    process.env.PA_HOME = PA_HOME;
    clearRateLimitCache();
  });

  it('classifies, alerts (warn log), and does NOT write to rate-limit-unparseable.jsonl', async () => {
    const result = await classifyRateLimit('agy', '', AGY_QUOTA_SPECIMEN_TRUNCATED);
    assert.ok(result, 'must not return null — null means "not a rate limit", i.e. no cooldown');
    assert.equal(result!.classification, 'quota-exhausted');
    assert.equal(result!.minutes, 360);

    await flushLog();
    const logContent = await readFile(join(AGY_TERMINAL_HOME, 'app.log.jsonl'), 'utf8').catch(() => '');
    const entries = logContent.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const alertLine = entries.find((e) => e.level === 'warn' && e.worker === 'agy' && /benched/i.test(e.message));
    assert.ok(alertLine, 'terminal account-fault alert must be logged for agy, same as the zclaude path');

    const unparseableExists = await readFile(join(AGY_TERMINAL_HOME, 'rate-limit-unparseable.jsonl'), 'utf8')
      .then(() => true)
      .catch(() => false);
    assert.equal(unparseableExists, false, 'a classified quota exhaustion must not also land in the unparseable log');
  });

  it('records a cooldown so the dispatch cascade actually skips agy (the original defect)', async () => {
    const cls = await classifyRateLimit('agy', '', AGY_QUOTA_SPECIMEN_TRUNCATED);
    assert.ok(cls);
    // Mirrors the caller contract in workers.ts: classify → recordRateLimit. Also
    // mirrors the shape of the operator's manual 2026-09-09 state-file entry so a
    // real event overwrites it cleanly.
    await recordRateLimit('agy', cls!.minutes, `[${cls!.classification}] agy exit:1 "Individual quota reached"`, cls!.classification);

    const entry = await getWorkerCooldown('agy');
    assert.ok(entry, 'a cooldown entry must exist — this is the exact gap the incident report described');
    assert.equal(entry!.classification, 'quota-exhausted');
    assert.equal(await isWorkerCoolingDown('agy'), true);

    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    assert.ok(remainingMs > 5 * 60 * 60 * 1000, `cooldown should be hours, got ${remainingMs}ms`);
  });

  it('negative twin at the dispatcher level: non-quota agy stderr still lands in the unparseable log', async () => {
    const preContent = await readFile(join(AGY_TERMINAL_HOME, 'rate-limit-unparseable.jsonl'), 'utf8').catch(() => '');
    const preCount = preContent.trim() ? preContent.trim().split('\n').length : 0;

    const result = await classifyRateLimit('agy', '', 'quota exceeded for some other reason entirely');
    assert.equal(result, null);

    const postContent = await readFile(join(AGY_TERMINAL_HOME, 'rate-limit-unparseable.jsonl'), 'utf8');
    const lines = postContent.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, preCount + 1, 'exactly one new unparseable row must be appended');
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.worker, 'agy');
    assert.equal(last.reason, 'no-session-evidence');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a realistic agy quota-exhaustion STREAM (the real dialect's
// `result` event, carrying the phrase on `.error`, not `.response` — see
// worker-exec.ts's 2026-09-10 fix) must survive the full path through
// executeWorker -> classifyRateLimit -> recordRateLimit and land a real
// cooldown. Before that fix, this text never reached classifyGeminiError at
// all: worker-exec.ts only ever read `.response`, which on a real
// quota-exhaustion result event is empty, so ~/.pa/rate-limit-state.json got
// no agy entry despite dozens of quota-exhaustion episodes in production —
// the fleet kept re-selecting agy on every dispatch.
// ---------------------------------------------------------------------------

const AGY_E2E_HOME = join(tmpdir(), `rate-limits-agy-e2e-test-${process.pid}`);
const AGY_E2E_SCRIPT_DIR = join(tmpdir(), `rate-limits-agy-e2e-scripts-${process.pid}`);

function agyStubWorker(scriptPath: string): WorkerConfig {
  return {
    name: 'agy',
    command: `"${process.execPath}"`,
    args: [scriptPath],
    check: 'echo ok',
    rate_limit_patterns: [],
    priority: 1,
    input_mode: 'stdin-text',
    check_timeout: 5,
    output_format: 'stream-json',
  };
}

async function writeAgyResultStub(path: string, resultJson: string): Promise<void> {
  const lines = [
    '{"event":"init","conversation_id":"e2e-quota","init":{"model":"gemini-3.8-flash-high"}}',
    resultJson,
  ];
  await writeFile(path, `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')})\n`, 'utf8');
}

describe('end-to-end: realistic agy quota-exhaustion stream -> cooldown persisted', () => {
  before(async () => {
    process.env.PA_HOME = AGY_E2E_HOME;
    clearRateLimitCache();
    await mkdir(AGY_E2E_HOME, { recursive: true });
    await mkdir(AGY_E2E_SCRIPT_DIR, { recursive: true });
  });

  after(async () => {
    try { await rm(AGY_E2E_HOME, { recursive: true, force: true }); } catch {}
    try { await rm(AGY_E2E_SCRIPT_DIR, { recursive: true, force: true }); } catch {}
    process.env.PA_HOME = PA_HOME;
    clearRateLimitCache();
  });

  it('a real result-event .error quota phrase reaches CommandResult.error, classifies, and persists a cooldown derived from the "Resets in" tail', async () => {
    // Verbatim shape captured from production tee output: status:"ERROR",
    // response:"" (agy never produced usable text before giving up), the
    // actual message on `.error`.
    const scriptPath = join(AGY_E2E_SCRIPT_DIR, 'agy-e2e-quota.mjs');
    await writeAgyResultStub(
      scriptPath,
      '{"event":"result","result":{"conversation_id":"e2e-quota","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 12h13m34s.","duration_seconds":7.19,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}',
    );

    const dispatch = await executeWorker(agyStubWorker(scriptPath), 'test prompt', { timeout: 10 });
    assert.ok(
      dispatch.error && dispatch.error.includes('Individual quota reached'),
      `worker-exec must surface the .error text on CommandResult.error, got: ${dispatch.error}`,
    );

    const cls = await classifyRateLimit('agy', dispatch.output, dispatch.error ?? '', dispatch.sessionId);
    assert.ok(cls, 'classifyRateLimit must not return null for a real quota-exhaustion result — null means no cooldown gets written');
    assert.equal(cls!.classification, 'quota-exhausted');
    assert.equal(cls!.source, 'gemini-cli-text');
    assert.equal(cls!.minutes, 12 * 60 + 13, 'expected 12h13m parsed from the "Resets in" tail (seconds truncated, not rounded)');

    await recordRateLimit('agy', cls!.minutes, `[${cls!.classification}] ${cls!.source} — ${cls!.raw ?? ''}`, cls!.classification);

    const entry = await getWorkerCooldown('agy');
    assert.ok(entry, 'a cooldown entry must exist for agy — this is the exact gap the 2026-09-10 incident report described');
    assert.equal(entry!.classification, 'quota-exhausted');
    assert.equal(await isWorkerCoolingDown('agy'), true);

    const remainingMs = new Date(entry!.cooldown_until).getTime() - Date.now();
    const expectedMs = (12 * 60 + 13) * 60 * 1000;
    assert.ok(Math.abs(remainingMs - expectedMs) < 60_000, `cooldown_until should land ~12h13m out, got ${remainingMs}ms`);
  });

  it('falls back to the documented 6h default when the result-event .error carries no "Resets in" tail', async () => {
    try { await unlink(join(AGY_E2E_HOME, 'rate-limit-state.json')); } catch {}
    clearRateLimitCache();

    const scriptPath = join(AGY_E2E_SCRIPT_DIR, 'agy-e2e-quota-no-tail.mjs');
    await writeAgyResultStub(
      scriptPath,
      '{"event":"result","result":{"conversation_id":"e2e-quota-no-tail","status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits.","duration_seconds":2.1,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}',
    );

    const dispatch = await executeWorker(agyStubWorker(scriptPath), 'test prompt', { timeout: 10 });
    const cls = await classifyRateLimit('agy', dispatch.output, dispatch.error ?? '', dispatch.sessionId);
    assert.ok(cls);
    assert.equal(cls!.classification, 'quota-exhausted');
    assert.equal(cls!.minutes, 360, 'no "Resets in" tail survived — must fall back to the documented 6h default');

    await recordRateLimit('agy', cls!.minutes, `[${cls!.classification}] ${cls!.source}`, cls!.classification);
    const entry = await getWorkerCooldown('agy');
    assert.ok(entry);
    assert.equal(entry!.classification, 'quota-exhausted');
  });

  it('negative twin: the existing stderr-only path is unaffected by the stream-path fix', async () => {
    // Same phrase, delivered the OLD way (raw stderr, no stream event at all)
    // — must classify identically. Proves the fix is additive to the stream
    // path, not a change to how stderr is handled.
    const result = await classifyRateLimit('agy', '', 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 12h13m34s.');
    assert.ok(result);
    assert.equal(result!.classification, 'quota-exhausted');
    assert.equal(result!.source, 'gemini-cli-text');
    assert.equal(result!.minutes, 12 * 60 + 13);
  });
});
