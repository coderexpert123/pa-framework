// Shadow writer (spec 0.1.6). Appends ONE best-effort JSONL line per routed
// turn; NEVER contains turn text (topic key only), never throws, never
// blocks dispatch.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CapabilityTier, EffortScore } from '../../types.js';

export interface ShadowRecord {
  at: string;
  topicKey: string;
  store: 'telegram' | 'voice-inbox';
  textSource: 'ledger-request' | 'turn-text';
  tier?: CapabilityTier;
  score?: EffortScore;
  confidence?: number;
  chosen?: { worker: string; model?: string; effort?: string; outcome?: string };
  baseline: { worker: string };
  pinPresent: boolean;
  disagreement: boolean;
  /** Conversation stickiness (intent decision 19): true when the incumbent
   *  worker was kept inside its capability envelope ('sticky-keep'), false on
   *  a fresh resolve and on every fail-open record. `stickBreakReason` names
   *  WHY a recorded incumbent lost the keep: the need exceeded its envelope
   *  ('unsatisfiable'), it was unavailable ('unavailable'), or it is a z.ai
   *  worker displaced inside the peak window ('peak-zai-last'). Present only
   *  on routed records where an incumbent existed. */
  sticky?: boolean;
  stickBreakReason?: 'unsatisfiable' | 'unavailable' | 'peak-zai-last';
  /** Decision 20 (§9.2): the probability-ordered candidate chain as RESOLVED
   *  (availability-filtered at resolve time, sticky keep reorders to
   *  incumbent-first). Bounded by fleet size; ids/probabilities only. */
  chain?: Array<{ worker: string; p?: number }>;
  /** Decisions 22/23 (§9.2): the placement answer. `candidates` = the count
   *  of candidate views offered; `truncated` = the section cap dropped some.
   *  NO candidate CONTENT — ids and counts only. */
  placement?: { choice: string; targets: string[]; candidates?: number; truncated?: boolean };
  /** Decision 24 (§9.2): the steer/wait answer. `inflight` = an in-flight
   *  run view was offered; `decision` present only when answered validly. */
  steerWait?: { inflight: boolean; decision?: 'steer' | 'wait' };
  reason: string;
}

const MAX_LINE = 1500;

/**
 * Append ONE line, best-effort, never throws, never blocks dispatch.
 * Line <= 1500 chars (reason truncated to 200). NO TURN TEXT in any field.
 */
export function appendShadowRecord(path: string, rec: ShadowRecord): void {
  try {
    const clean: ShadowRecord = { ...rec, reason: rec.reason.length > 200 ? rec.reason.slice(0, 200) : rec.reason };
    let line = JSON.stringify(clean);
    if (line.length > MAX_LINE) {
      line = JSON.stringify({ ...clean, reason: clean.reason.slice(0, 50) });
    }
    if (line.length > MAX_LINE) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line + '\n', { encoding: 'utf8' });
    } catch {
      /* best-effort */
    }
  } catch {
    /* never throws */
  }
}
