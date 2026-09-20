// Effort projection (spec 0.1.5): map a router EffortScore onto each
// worker's EXISTING effort tunable. Explicit outcomes - a knobless worker
// plus a high need yields the EXPLICIT 'recategorize' outcome, never a
// silent downgrade.

import type { EffortScore, ModelRouterEffortProjection } from '../../types.js';

export type ProjectionOutcome =
  | { applied: true; tunable: 'effort'; value: string }
  | { applied: false; outcome: 'nearest' | 'recategorize'; detail: string };

// agy/agyc/devin are tunable 'none' - agy encodes effort in the model row;
// agyc/devin are knobless, so a high need on them yields the EXPLICIT
// 'recategorize' outcome, never a silent downgrade.
export const DEFAULT_EFFORT_PROJECTION: Record<string, ModelRouterEffortProjection> = {
  codex: { tunable: 'effort', map: { 1: 'minimal', 2: 'low', 3: 'medium', 4: 'medium', 5: 'high' } },
  zclaude: { tunable: 'effort', map: { 1: 'low', 2: 'low', 3: 'medium', 4: 'high', 5: 'max' } },
  claude: { tunable: 'effort', map: { 1: 'low', 2: 'low', 3: 'medium', 4: 'high', 5: 'max' } },
  kgclaude: { tunable: 'effort', map: { 1: 'low', 2: 'low', 3: 'medium', 4: 'high', 5: 'max' } },
  agy: { tunable: 'none' },
  agyc: { tunable: 'none' },
  devin: { tunable: 'none' },
};

export function projectEffort(score: EffortScore, worker: string, cfg: Record<string, ModelRouterEffortProjection> | undefined): ProjectionOutcome {
  try {
    const entry = cfg && cfg[worker] ? cfg[worker] : DEFAULT_EFFORT_PROJECTION[worker];
    if (!entry) {
      return { applied: false, outcome: 'nearest', detail: 'no projection for worker ' + worker };
    }
    if (entry.tunable === 'none') {
      return { applied: false, outcome: 'recategorize', detail: 'worker ' + worker + ' has no effort knob' };
    }
    const value = entry.map ? entry.map[score] : undefined;
    if (!value) {
      return { applied: false, outcome: 'nearest', detail: 'no effort mapping for score ' + score + ' on ' + worker };
    }
    return { applied: true, tunable: 'effort', value: value };
  } catch (err) {
    return { applied: false, outcome: 'nearest', detail: 'projection error' };
  }
}
