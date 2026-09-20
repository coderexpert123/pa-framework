// Peak-window primitives (moved verbatim from scheduler.ts 2026-09-11 — the
// model-routing policy needed them without scheduler's import chain; scheduler
// re-exports for compat). Single source of the ZAI peak-billing window truth:
// z.ai peak = Mon-Fri 06:00-10:00 UTC (11:30-15:30 IST, 2x credits).

import type { CostTierPeakWindowUtc } from '../types.js';

export const DEFAULT_PEAK_WINDOW_UTC = {
  days: [1, 2, 3, 4, 5], // Mon-Fri
  start_hour: 6,            // 06:00 UTC
  end_hour: 10,              // 10:00 UTC
};

export interface PeakWindowUtc {
  days: number[];
  start_hour: number;
  end_hour: number;
}

/** Merge a config's optional `cost_tier.peak_window_utc` overrides onto the
 *  default window — the exact resolution scheduler.ts's cost-tier partition
 *  does inline (kept here so every consumer resolves the same way). */
export function resolvePeakWindowUtc(overrides?: CostTierPeakWindowUtc): PeakWindowUtc {
  return overrides
    ? {
        days: overrides.days ?? DEFAULT_PEAK_WINDOW_UTC.days,
        start_hour: overrides.start_hour ?? DEFAULT_PEAK_WINDOW_UTC.start_hour,
        end_hour: overrides.end_hour ?? DEFAULT_PEAK_WINDOW_UTC.end_hour,
      }
    : DEFAULT_PEAK_WINDOW_UTC;
}

/** True while inside the z.ai peak billing window (Mon-Fri 06:00-10:00 UTC by default). */
export function isPeakWindow(now: Date = new Date(), window: PeakWindowUtc = DEFAULT_PEAK_WINDOW_UTC): boolean {
  const d = now.getUTCDay();
  const h = now.getUTCHours();
  return window.days.includes(d) && h >= window.start_hour && h < window.end_hour;
}
