import type { RateLimitParseResult } from './rate-limits.js';
import { DEFAULT_COOLDOWN_MINUTES } from './rate-limits.js';

function sliceSnippet(text: string, idx: number, len = 200): string {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + len);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

const ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES = 6 * 60;

/**
 * Classify Devin CLI / Codeium cloud rate-limit and quota errors from plain
 * stderr/stdout text. Devin does not emit a structured error channel, so this
 * parser looks for exact phrases the CLI prints when the cloud quota is hit.
 */
export function classifyDevinError(stderr: string): RateLimitParseResult | null {
  if (!stderr) return null;

  // Terminal billing fault: the account has run out of credits / balance.
  // Long cooldown plus operator alert (handled by caller).
  const accountExhaustedPattern = /(?:out of credits|insufficient balance)/i;
  if (accountExhaustedPattern.test(stderr)) {
    const markerIdx = stderr.search(accountExhaustedPattern);
    return {
      minutes: ACCOUNT_EXHAUSTED_COOLDOWN_MINUTES,
      classification: 'account-exhausted',
      source: 'devin-text',
      raw: sliceSnippet(stderr, markerIdx),
    };
  }

  // Explicit "retry after N minutes/seconds" hint. Classify as quota-per-minute;
  // the caller's burst logic may shorten the effective cooldown when no end time is
  // stated, but a stated duration is recorded verbatim.
  const retryPattern = /(?:retry|try)\s+(?:after\s+|in\s+)?(\d+)\s*(?:min(?:ute)?s?|sec(?:ond)?s?|s)\b/i;
  const rateLimitRetryPattern = /rate limit(?:ed)?[,\s]+(?:retry|try)\s+(?:after\s+|in\s+)?(\d+)\s*(?:min(?:ute)?s?|sec(?:ond)?s?|s)\b/i;
  const retryMatch = stderr.match(retryPattern) ?? stderr.match(rateLimitRetryPattern);
  if (retryMatch) {
    const value = parseInt(retryMatch[1], 10);
    const unit = retryMatch[0].toLowerCase();
    const minutes = unit.includes('min') ? value : Math.max(1, Math.ceil(value / 60));
    const markerIdx = retryMatch.index ?? 0;
    return {
      minutes,
      classification: 'quota-per-minute',
      source: 'devin-text',
      raw: sliceSnippet(stderr, markerIdx),
    };
  }

  // Generic rate-limit / quota phrasing with no parseable duration.
  const genericPattern = /(?:rate limit|quota exceeded|429|usage limit)/i;
  if (genericPattern.test(stderr)) {
    const markerIdx = stderr.search(genericPattern);
    return {
      minutes: DEFAULT_COOLDOWN_MINUTES,
      classification: 'unknown',
      source: 'devin-text',
      raw: sliceSnippet(stderr, markerIdx),
    };
  }

  return null;
}
