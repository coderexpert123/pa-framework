import type { RateLimitParseResult } from './rate-limits.js';
import { DEFAULT_COOLDOWN_MINUTES } from './rate-limits.js';
import { formatIST } from './ist.js';

function sliceSnippet(stderr: string, idx: number, len = 500): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(stderr.length, idx + len);
  return stderr.slice(start, end).replace(/\s+/g, ' ').trim();
}

// Gemini's daily quota resets at midnight in Google's billing timezone (Pacific).
// Override via PA_GEMINI_RESET_TZ if Google ever changes this.
const GEMINI_RESET_TZ = process.env.PA_GEMINI_RESET_TZ || 'America/Los_Angeles';

function computeNextPacificMidnightMinutes(now: Date): { minutes: number; resetsAtIST: string } {
  // Compute "next midnight in the configured reset timezone" via Intl.DateTimeFormat parts.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: GEMINI_RESET_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
  const h = parseInt(get('hour'), 10);
  const mi = parseInt(get('minute'), 10);
  const s = parseInt(get('second'), 10);
  // Seconds elapsed since start of PT day. Assumes 24h day — off by ±1h on DST
  // transition days (twice a year), acceptable for a daily cooldown.
  const elapsedSec = h * 3600 + mi * 60 + s;
  const secondsUntilMidnight = 86400 - elapsedSec;
  const minutes = Math.max(60, Math.min(1440, Math.ceil(secondsUntilMidnight / 60)));
  const target = new Date(now.getTime() + secondsUntilMidnight * 1000);
  const istFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const istParts = istFmt.formatToParts(target);
  const ig = (t: string) => istParts.find(p => p.type === t)?.value ?? '00';
  const resetsAtIST = `${ig('year')}-${ig('month')}-${ig('day')} ${ig('hour')}:${ig('minute')} IST`;
  return { minutes, resetsAtIST };
}

/**
 * Classify a gemini stderr dump. Returns null when the stderr contains no
 * 429 / RESOURCE_EXHAUSTED / 403 marker (i.e. not a rate limit at all).
 */
export function classifyGeminiError(stderr: string): RateLimitParseResult | null {
  if (!stderr) return null;

  // Rule 0: 403 / PERMISSION_DENIED — IAM or auth failure (not a quota error).
  // Apply a 120-minute cooldown to stop repeated futile attempts until the user
  // re-authenticates or GCP project permissions are restored.
  const has403 = /["']?code["']?\s*:\s*403/.test(stderr)
    || /\bPERMISSION_DENIED\b/.test(stderr)
    || /\bstatus[:\s]+403\b/i.test(stderr);
  if (has403) {
    const markerIdx = (() => {
      const m = stderr.match(/PERMISSION_DENIED|403/);
      return m?.index ?? 0;
    })();
    return {
      minutes: 120,
      classification: 'auth-error',
      source: 'gemini-stderr',
      raw: sliceSnippet(stderr, markerIdx),
    };
  }

  const has429 = /["']?code["']?\s*:\s*429/.test(stderr)
    || /\bRESOURCE_EXHAUSTED\b/.test(stderr)
    || /\bstatus[:\s]+429\b/i.test(stderr);
  if (!has429) return null;

  const markerIdx = (() => {
    const m = stderr.match(/RESOURCE_EXHAUSTED|429/);
    return m?.index ?? 0;
  })();
  const raw = sliceSnippet(stderr, markerIdx);

  const hasModelCapacityExhausted = /["']?reason["']?\s*:\s*["']MODEL_CAPACITY_EXHAUSTED["']/.test(stderr);
  const hasQuotaExhausted = /["']?reason["']?\s*:\s*["']QUOTA_EXHAUSTED["']/.test(stderr);
  const quotaMetricMatch = stderr.match(/["']?quotaMetric["']?\s*:\s*["']([^"']+)["']/);
  const retryDelayMatch = stderr.match(/["']?retryDelay["']?\s*:\s*["']?(\d+)s["']?/);
  const retryDelayMsMatch = stderr.match(/["']?retryDelayMs["']?\s*:\s*["']?([\d.]+)["']?/);

  // Rule 1: transient server capacity issue — short cooldown
  if (hasModelCapacityExhausted) {
    return {
      minutes: 1,
      classification: 'server-overload',
      source: 'gemini-stderr',
      raw,
    };
  }

  // Rule 2: daily quota — must NOT be overridden by retryDelay
  if (quotaMetricMatch && /PerDay/i.test(quotaMetricMatch[1])) {
    const { minutes, resetsAtIST } = computeNextPacificMidnightMinutes(new Date());
    return {
      minutes,
      classification: 'quota-daily',
      source: 'gemini-stderr',
      resetsAtIST,
      raw,
    };
  }

  // Rule 3: per-minute quota
  if (quotaMetricMatch && /PerMinute/i.test(quotaMetricMatch[1])) {
    let minutes = 2;
    if (retryDelayMatch) {
      const seconds = parseInt(retryDelayMatch[1], 10);
      if (seconds <= 600) minutes = Math.max(1, Math.ceil(seconds / 60));
    }
    return {
      minutes,
      classification: 'quota-per-minute',
      source: 'gemini-stderr',
      raw,
    };
  }

  // Rule 4: explicit quota exhaustion with a server-provided retry delay
  if (hasQuotaExhausted && retryDelayMsMatch) {
    const ms = parseFloat(retryDelayMsMatch[1]);
    const cappedMs = Math.min(ms, 1440 * 60_000);
    const minutes = Math.max(1, Math.ceil(cappedMs / 60_000));
    const resetsAtIST = formatIST(new Date(Date.now() + cappedMs));
    return {
      minutes,
      classification: 'quota-exhausted',
      source: 'gemini-stderr',
      resetsAtIST,
      raw,
    };
  }

  // Rule 5: 429 present but no specific classification — apply retryDelay override if present
  let fallbackMinutes = DEFAULT_COOLDOWN_MINUTES;
  if (retryDelayMsMatch) {
    const ms = parseFloat(retryDelayMsMatch[1]);
    const minutes = Math.ceil(ms / 60000);
    if (minutes >= 1 && minutes <= 1440) fallbackMinutes = minutes;
  } else if (retryDelayMatch) {
    const seconds = parseInt(retryDelayMatch[1], 10);
    if (seconds <= 600) fallbackMinutes = Math.max(1, Math.ceil(seconds / 60));
  }
  return {
    minutes: fallbackMinutes,
    classification: 'unknown',
    source: 'gemini-stderr',
    raw,
  };
}
