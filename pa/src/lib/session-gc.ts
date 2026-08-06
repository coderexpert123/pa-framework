import { stat, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { sqliteRun } from './db.js';

// TODO: [AI-020 Phase 6] Extract to shared config (pa/src/lib/config-shared.ts)
// This module should provide centralized path resolution, including session directory paths.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Transcript GC retention for CLIs with no retention of their own (agy, codex).
 * Matches Claude Code's 30-day cleanupPeriodDays. Deliberately NOT SESSION_TTL_MS:
 * that is the 24h *resume* TTL used by isSessionExpired() and must stay 24h. */
export const GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// --- Cleanup ---
//
// Claude Code and Gemini CLI both manage their own transcript retention (30 days
// each — see plans/2026-08-02-session-gc-scope-to-pa-spawned.md) and PA must not
// touch their transcripts at all: an earlier version of this file's 24h GC swept
// the operator's real interactive Claude Code sessions along with PA's own worker
// transcripts, deleting 248 real conversations before it was caught. There is
// deliberately no cleanupClaudeSessions/cleanupGeminiSessions here anymore — do
// not reintroduce them. Antigravity and Codex have no retention of their own, so
// PA prunes those, but at GC_RETENTION_MS (30d), not the 24h resume TTL.
// Now also enforced executably by pa/src/lib/maintenance/policy.ts's FORBIDDEN_ROOTS.

/** Matches agy conversation files: `<uuid>.pb` (current CLI format, protobuf)
 * or `<uuid>.db` (older format). UUID-anchored so non-conversation artifacts
 * (e.g. index/state .pb files) in the same tree are never touched. */
export const AGY_CONVERSATION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pb|db)$/i;

export function agyConversationsDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
}

export function codexStateDbPath(): string {
  return join(homedir(), '.codex', 'state_5.sqlite');
}

/**
 * Delete Antigravity (agy) conversation files older than `cutoffMs`. Exported
 * for unit testing. The live CLI writes `<uuid>.pb` protobuf files (the
 * original `.db` filter was a structural no-op — deep-recheck P1-4); `.db` is
 * kept for older installs. NOTE: this only touches
 * ~/.gemini/antigravity-cli/conversations (the resumable-session files) — it
 * deliberately does NOT touch the large ~/.gemini/antigravity or
 * antigravity-browser-profile caches, which are app state, not transcripts.
 */
export async function cleanupAgySessions(convDir: string, cutoffMs: number): Promise<number> {
  let deleted = 0;
  let entries: string[];
  try {
    entries = await readdir(convDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!AGY_CONVERSATION_FILE_RE.test(entry)) continue;
    const fp = join(convDir, entry);
    try {
      const stats = await stat(fp);
      if (stats.mtime.getTime() < cutoffMs) { await unlink(fp); deleted++; }
    } catch { /* skip unreadable files */ }
  }
  return deleted;
}

/**
 * Clean up expired session files for worker types that PA is responsible for
 * retaining. Claude Code and Gemini CLI are NOT touched here — both self-manage
 * a 30-day retention policy already, and PA has no way to distinguish its own
 * spawned worker transcripts from the operator's real interactive sessions, so
 * deleting either is out of scope. See
 * plans/2026-08-02-session-gc-scope-to-pa-spawned.md for the incident that
 * established this (248 real Claude Code transcripts deleted). Antigravity and
 * Codex have no retention of their own, so PA prunes those at GC_RETENTION_MS
 * (30d) — NOT SESSION_TTL_MS, which governs resume eligibility, not GC.
 *
 * `nowMs` (default Date.now()) so the maintenance job context's clock drives
 * this instead of the wall clock, for deterministic tests.
 */
export async function cleanupExpiredSessions(nowMs: number = Date.now()): Promise<number> {
  const cutoff = nowMs - GC_RETENTION_MS;
  let deletedCount = 0;

  try {
    deletedCount += await cleanupAgySessions(agyConversationsDir(), cutoff);
  } catch (err) {
    console.warn('[session] Antigravity session cleanup failed:', err);
  }

  // Codex threads are archived in SQLite (no transcript file to unlink).
  try {
    const codexDb = codexStateDbPath();
    await cleanupCodexSessions(codexDb, cutoff);
    console.log('[session] Archived expired Codex threads');
  } catch (err) {
    console.warn('[session] Codex session cleanup failed:', err);
  }

  if (deletedCount > 0) {
    console.log(`[session] Cleaned up ${deletedCount} expired session files`);
  }
  return deletedCount;
}

/**
 * Archive expired Codex threads in the SQLite DB.
 * Exported separately for testability (cleanupExpiredSessions hardcodes homedir paths
 * and can't be mocked in ESM — same limitation as Claude/Gemini paths).
 */
export async function cleanupCodexSessions(dbPath: string, cutoffMs: number): Promise<void> {
  await stat(dbPath); // throws if DB doesn't exist — caller catches
  const cutoffEpoch = Math.floor(cutoffMs / 1000); // Codex updated_at is Unix seconds
  const archiveAt = Math.floor(Date.now() / 1000);
  sqliteRun(
    dbPath,
    'UPDATE threads SET archived = 1, archived_at = ? WHERE archived = 0 AND updated_at < ?',
    [archiveAt, cutoffEpoch]
  );
}
