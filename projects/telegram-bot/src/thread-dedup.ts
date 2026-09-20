// AI-232: pure duplicate-goal detection for in-topic thread dispatch.
//
// This module is pure text logic: no I/O, no module-level state, and no
// fuzzy/semantic matching. A false positive here would silently serialize
// legitimate parallel work behind an unrelated thread, which is why the
// containment arm below is guarded by DEDUP_MIN_NORMALIZED_CHARS — only a
// long, specific enough overlap is trusted to mean "same job".

import type { ThreadRecord } from './topic-threads.js';

/** Minimum normalized length before a containment (substring) match is allowed. */
export const DEDUP_MIN_NORMALIZED_CHARS = 24;

/** Lowercase, drop every character outside [a-z0-9 ], collapse runs of whitespace
 *  to one space, trim. Deterministic and punctuation-insensitive; never fuzzy. */
export function normalizeGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DuplicateMatch {
  id: string; // the live twin's `t-<n>` id
  title: string; // the live twin's title, for the footer
  reason: 'exact' | 'containment';
}

/** Conservative duplicate check against the topic's CURRENT records.
 *  Candidates: records with status 'running' or 'queued' ONLY, scanned in
 *  ASCENDING `n` (oldest live twin wins — it is furthest along).
 *  Pass 1: normalized equality  -> reason 'exact'.
 *  Pass 2 (only if pass 1 found nothing): one normalized string contains the
 *  other AND the SHORTER of the two is >= DEDUP_MIN_NORMALIZED_CHARS
 *  -> reason 'containment'.
 *  Empty normalized input, or no candidate, returns null. Never throws. */
export function findDuplicateGoal(goal: string, threads: ThreadRecord[]): DuplicateMatch | null {
  const normalizedGoal = normalizeGoal(goal);
  if (!normalizedGoal) return null;

  const candidates = threads
    .filter((t) => t.status === 'running' || t.status === 'queued')
    .sort((a, b) => a.n - b.n);

  for (const candidate of candidates) {
    if (normalizeGoal(candidate.goal) === normalizedGoal) {
      return { id: candidate.id, title: candidate.title, reason: 'exact' };
    }
  }

  for (const candidate of candidates) {
    const candidateNormalized = normalizeGoal(candidate.goal);
    const shorter = Math.min(candidateNormalized.length, normalizedGoal.length);
    if (shorter < DEDUP_MIN_NORMALIZED_CHARS) continue;
    if (candidateNormalized.includes(normalizedGoal) || normalizedGoal.includes(candidateNormalized)) {
      return { id: candidate.id, title: candidate.title, reason: 'containment' };
    }
  }

  return null;
}
