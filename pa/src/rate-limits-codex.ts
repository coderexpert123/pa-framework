import type { RateLimitParseResult } from './rate-limits.js';
import { DEFAULT_COOLDOWN_MINUTES } from './rate-limits.js';
import { formatIST } from './ist.js';

export interface CodexRateLimitTelemetry {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number; // unix seconds
}

/**
 * Parse a codex stream-json NDJSON buffer and return the LAST `token_count`
 * event's `rate_limits.primary` telemetry (or null if absent / malformed).
 */
export function extractCodexRateLimitTelemetry(streamJsonBuffer: string): CodexRateLimitTelemetry | null {
  if (!streamJsonBuffer) return null;
  const lines = streamJsonBuffer.split('\n');
  let last: CodexRateLimitTelemetry | null = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'event_msg'
          && ev?.payload?.type === 'token_count'
          && ev?.payload?.rate_limits?.primary) {
        const p = ev.payload.rate_limits.primary;
        if (typeof p.used_percent === 'number'
            && typeof p.window_minutes === 'number'
            && typeof p.resets_at === 'number') {
          last = {
            usedPercent: p.used_percent,
            windowMinutes: p.window_minutes,
            resetsAt: p.resets_at,
          };
        }
      }
    } catch {
      // malformed line — skip
    }
  }
  return last;
}

/**
 * Reactive classifier for codex failures. Prefers proactive telemetry
 * (used_percent, resets_at) when present; falls back to stderr text scan.
 */
export function classifyCodexError(stdout: string, stderr: string): RateLimitParseResult | null {
  const telemetry = extractCodexRateLimitTelemetry(stdout);
  if (telemetry && telemetry.usedPercent >= 100) {
    const nowMs = Date.now();
    const resetMs = telemetry.resetsAt * 1000;
    const rawMinutes = Math.ceil((resetMs - nowMs) / 60000);
    const minutes = Math.max(1, Math.min(telemetry.windowMinutes, rawMinutes));
    return {
      minutes,
      classification: telemetry.windowMinutes <= 60 ? 'quota-per-minute' : 'quota-daily',
      source: 'codex-telemetry',
      resetsAtIST: formatIST(new Date(resetMs)),
      raw: `used_percent=${telemetry.usedPercent} window=${telemetry.windowMinutes}m`,
    };
  }

  // Text fallback (stdout NDJSON error events are merged into stderr by worker-exec)
  const combined = `${stdout}\n${stderr}`;
  if (/hit your usage limit/i.test(combined)) {
    const m = combined.match(/hit your usage limit/i);
    const idx = m?.index ?? 0;
    const start = Math.max(0, idx - 40);
    const end = Math.min(combined.length, idx + 200);
    const raw = combined.slice(start, end).replace(/\s+/g, ' ').trim();

    // Parse "try again at <Month> <Day>, <Year> <H>:<MM> <AM|PM>" reset time.
    // ChatGPT displays reset times in the user's local time (IST = UTC+5:30).
    const retryMatch = combined.match(
      /try again at (\w+)\s+(\d+)(?:st|nd|rd|th),?\s+(\d{4})\s+(\d+):(\d{2})\s*(AM|PM)/i,
    );
    if (retryMatch) {
      const [, mon, day, year, hStr, minStr, ampm] = retryMatch;
      const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const monthIdx = monthNames.indexOf(mon.slice(0, 3).toLowerCase());
      let h = parseInt(hStr, 10);
      const min = parseInt(minStr, 10);
      if (ampm.toLowerCase() === 'pm' && h < 12) h += 12;
      if (ampm.toLowerCase() === 'am' && h === 12) h = 0;

      if (monthIdx >= 0) {
        // ChatGPT renders reset times in the user's system locale timezone.
        // Parsing with new Date(y, m, d, h, min) uses system local time — no hardcoded offset.
        // Cap at 45 days so a wrong clock/locale can't produce an unbounded cooldown.
        const resetDate = new Date(parseInt(year, 10), monthIdx, parseInt(day, 10), h, min, 0);
        const resetUtcMs = resetDate.getTime();
        const rawMinutes = Math.ceil((resetUtcMs - Date.now()) / 60000);
        const minutes = Math.max(1, Math.min(45 * 24 * 60, rawMinutes));
        const resetsAtIST = formatIST(resetDate);
        return {
          minutes,
          classification: 'usage-limit-session',
          source: 'codex-stderr',
          resetsAtIST,
          raw,
        };
      }
    }

    return {
      minutes: DEFAULT_COOLDOWN_MINUTES,
      classification: 'unknown',
      source: 'codex-stderr',
      raw,
    };
  }

  return null;
}
