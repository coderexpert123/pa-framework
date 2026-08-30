import { readFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import { notifyUser } from '../../notify.js';
import type { MaintenanceJob } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;
const SEND_CAP = 10;
// 30 days (§3.7) — the dedup record IS the "post once" mechanism, no new state file.
const DEDUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Matches the `mc:<conflictId≤32>` field in the callback grammar (spec §3.2) —
// an id outside this shape could never round-trip through a press anyway.
const CONFLICT_ID_RE = /^[A-Za-z0-9-]{1,32}$/;

/**
 * One line of ~/.pa/review-digest-pending.jsonl, written by
 * pa/scripts/memory_consolidation.py's write_conflicts (correction 7):
 * {id, created_at, resolved, resolved_at, resolution, key, new_text,
 * existing_text, existing_valid_from, category, source, source_ref}. Only the
 * fields this job reads are typed; the rest round-trips untouched.
 */
export interface ReviewDigestConflict {
  id: string;
  key?: string;
  category?: string;
  new_text?: string;
  existing_text?: string;
  created_at?: string;
  resolved?: boolean;
  [extra: string]: unknown;
}

export interface ConflictKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

function truncate(text: string | undefined, max: number): string {
  const s = text ?? '';
  return s.length > max ? s.slice(0, max) : s;
}

/** Pure. The notifyUser body for one unresolved conflict (§3.7 / WP-P3). */
export function buildConflictBody(entry: ReviewDigestConflict): string {
  return [
    `Key: ${entry.key ?? ''}`,
    `Category: ${entry.category ?? ''}`,
    `New: ${truncate(entry.new_text, 200)}`,
    `Existing: ${truncate(entry.existing_text, 200)}`,
    `Created: ${entry.created_at ?? ''}`,
    `Resolve with: pa/scripts/review_digest_action.py --conflict-id ${entry.id} --action accept|reject|ignore`,
  ].join('\n');
}

/** Pure. `mc:<id>:a|r|x` (§3.2, operator-gated). Undefined when `id` does not
 *  fit the field the parser accepts — the same guard on both ends. */
export function conflictKeyboard(id: string): ConflictKeyboard | undefined {
  if (!CONFLICT_ID_RE.test(id)) return undefined;
  return {
    inline_keyboard: [
      [
        { text: '✅ Accept new', callback_data: `mc:${id}:a` },
        { text: '❌ Keep existing', callback_data: `mc:${id}:r` },
      ],
      [{ text: '🚫 Ignore', callback_data: `mc:${id}:x` }],
    ],
  };
}

export interface ReviewConflictButtonsDeps {
  notifyFn?: typeof notifyUser;
  readFileFn?: (path: string) => Promise<string>;
}

export async function runReviewConflictButtons(
  deps: ReviewConflictButtonsDeps = {},
): Promise<{ touched: number; detail: Record<string, unknown> }> {
  const notifyDep = deps.notifyFn ?? notifyUser;
  const readFileDep = deps.readFileFn ?? ((p: string) => readFile(p, 'utf8'));

  const filePath = join(paHome(), 'review-digest-pending.jsonl');
  let raw = '';
  try {
    raw = await readFileDep(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { touched: 0, detail: { unresolved: 0, sent: 0, capped: false } };
    }
    throw err;
  }

  // Torn-line guard mirrors weekly_digest.py:159-178 — never throw on a
  // blank or unparseable line.
  const eligible: ReviewDigestConflict[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const entry = parsed as ReviewDigestConflict;
    if (entry.resolved === true) continue;
    if (typeof entry.id !== 'string' || !CONFLICT_ID_RE.test(entry.id)) continue;
    eligible.push(entry);
  }

  let sent = 0;
  for (const entry of eligible) {
    if (sent >= SEND_CAP) break;
    await notifyDep(
      `Memory conflict needs a decision: ${entry.key ?? ''}`,
      buildConflictBody(entry),
      {
        dedupKey: `review-conflict-${entry.id}`,
        dedupWindowMs: DEDUP_WINDOW_MS,
        escalate: false,
        severity: 'info',
        // NotifyOpts.replyMarkup is `Record<string, unknown>` (pre-work P4,
        // FROZEN) — same cast self-improver.ts already uses for a non-fresh
        // named-interface keyboard value (P9's `object | undefined`).
        replyMarkup: conflictKeyboard(entry.id) as unknown as Record<string, unknown> | undefined,
      },
    );
    sent += 1;
  }

  return {
    touched: sent,
    detail: { unresolved: eligible.length, sent, capped: eligible.length > SEND_CAP },
  };
}

/**
 * review-conflict-buttons (2026-08-24 buttons program,
 * plans/2026-08-24-buttons-program-SPEC.md P9 / §3.7 / WP-P3).
 *
 * Daily: read ~/.pa/review-digest-pending.jsonl (written by
 * memory_consolidation.py's write_conflicts) and post ONE notifyUser message
 * per unresolved conflict, carrying an operator-gated `mc:<id>:a|r|x`
 * keyboard. notifyUser's 30-day dedupKey (`review-conflict-<id>`) is the
 * ONLY "already posted" state — no new state file (§3.7). The bot's press
 * spawns pa/scripts/review_digest_action.py, the sole writer of the pending
 * file's resolution fields (WP-Y2); this job never writes to that file.
 * Non-destructive: no retention targets.
 */
export const reviewConflictButtonsJob: MaintenanceJob = {
  name: 'review-conflict-buttons',
  host: 'pa',
  everyMs: DAY,
  description: 'Daily: post an Accept new / Keep existing / Ignore inline keyboard for each unresolved memory-consolidation conflict in ~/.pa/review-digest-pending.jsonl (operator-gated mc: callbacks; the 30-day notifyUser dedup is the post-once guard).',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run() {
    return runReviewConflictButtons();
  },
};
