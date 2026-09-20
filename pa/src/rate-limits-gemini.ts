import type { RateLimitParseResult } from './rate-limits.js';
import { DEFAULT_COOLDOWN_MINUTES } from './rate-limits.js';
import { formatIST } from './ist.js';

// Kept post-gemini-CLI-sunset (2026-08-28): agy (Antigravity) emits the same Google-API
// quota error shapes; this is agy's live classifier.

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

// Mirrors rate-limits-claude.ts's ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES (6h) — same
// "terminal fault, long bench" convention, applied here when agy's own
// "Individual quota reached" message (see below) carries no parseable
// "Resets in <duration>" tail.
const AGY_QUOTA_EXHAUSTED_DEFAULT_MINUTES = 6 * 60;

// Parses a "Resets in <duration>" tail such as "Resets in 2h 13m", "Resets in
// 45m", "Resets in 1 day 3 hours", or agy's own real (unspaced) production
// format "Resets in 53h9m30s" into minutes. Returns null when no d/h/m
// component is found (caller falls back to AGY_QUOTA_EXHAUSTED_DEFAULT_MINUTES)
// — never guesses a number out of unrecognized text. Capped at 24h, matching
// Rule 4's retryDelay cap below.
//
// 2026-09-10 fix: each unit used to require a trailing `\b` word boundary,
// which never matches between "h" and the digit that starts the next unit
// (both are \w — there is no boundary) — so EVERY real agy specimen sampled
// ("53h9m30s", "52h16m3s", "24h36m57s", ...; agy never emits a space between
// units) silently failed to parse and fell back to the 6h default regardless
// of how long the real reset actually was, up to a day+ off. `(?![a-z])`
// (next char is not a lowercase letter) replaces `\b`: it still rejects a
// partial match into a longer word, but allows the next unit's digit,
// whitespace, punctuation, or end-of-string to follow immediately.
function parseResetsInMinutes(stderr: string): number | null {
  const tailMatch = stderr.match(/Resets in\s+([^.\n]+)/i);
  if (!tailMatch) return null;
  const tail = tailMatch[1];
  const dMatch = tail.match(/(\d+)\s*d(?:ays?)?(?![a-z])/i);
  const hMatch = tail.match(/(\d+)\s*h(?:ours?|rs?)?(?![a-z])/i);
  const mMatch = tail.match(/(\d+)\s*m(?:in(?:utes?)?)?(?![a-z])/i);
  if (!dMatch && !hMatch && !mMatch) return null;
  const days = dMatch ? parseInt(dMatch[1], 10) : 0;
  const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
  const mins = mMatch ? parseInt(mMatch[1], 10) : 0;
  const total = days * 1440 + hours * 60 + mins;
  return total > 0 ? Math.min(total, 1440) : null;
}

/**
 * Classify a gemini stderr dump. Returns null when the stderr contains no
 * 429 / RESOURCE_EXHAUSTED / 403 marker (i.e. not a rate limit at all).
 */
export function classifyGeminiError(stderr: string): RateLimitParseResult | null {
  if (!stderr) return null;

  // Rule -1: agy's own CLI-level terminal quota exhaustion. Distinct from every
  // rule below: those parse a JSON-shaped Google API error blob carrying
  // 429 / RESOURCE_EXHAUSTED; this is Antigravity's CLI wrapper printing a
  // plain-English message when the operator's subscription quota is used up.
  // No 429/RESOURCE_EXHAUSTED marker appears in it, so it fell through every
  // rule below (and the `!has429` guard further down) straight to null for a
  // month — rate-limit-unparseable.jsonl carries this exact text dated
  // 2026-08-09, reason 'no-session-evidence', with zero cooldown ever written.
  // Exact-phrase match only — per this file's own no-loose-heuristics rule.
  const AGY_QUOTA_PHRASE = /Individual quota reached/i;
  if (AGY_QUOTA_PHRASE.test(stderr)) {
    const markerIdx = stderr.search(AGY_QUOTA_PHRASE);
    const minutes = parseResetsInMinutes(stderr) ?? AGY_QUOTA_EXHAUSTED_DEFAULT_MINUTES;
    return {
      minutes,
      classification: 'quota-exhausted',
      source: 'gemini-cli-text',
      resetsAtIST: formatIST(new Date(Date.now() + minutes * 60_000)),
      raw: sliceSnippet(stderr, markerIdx),
    };
  }

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
