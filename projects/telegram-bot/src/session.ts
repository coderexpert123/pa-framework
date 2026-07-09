import { stat, readdir, readFile, unlink, rmdir } from 'fs/promises';
import { execFile } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionInfo } from './types.js';

// TODO: [AI-020 Phase 6] Extract to shared config (pa/src/lib/config-shared.ts)
// This module should provide centralized path resolution, including session directory paths.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Cleanup ---

/**
 * Delete Claude/zclaude session transcripts older than `cutoffMs` across ALL
 * project directories under `projectsRoot`. Exported for unit testing —
 * cleanupExpiredSessions hardcodes homedir() and can't be mocked in ESM.
 */
export async function cleanupClaudeSessions(projectsRoot: string, cutoffMs: number): Promise<number> {
  let deleted = 0;
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsRoot);
  } catch {
    return 0; // root doesn't exist / unreadable
  }
  for (const dir of projectDirs) {
    const sessionDir = join(projectsRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(sessionDir);
    } catch {
      continue; // not a directory or unreadable
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fp = join(sessionDir, entry);
      try {
        const stats = await stat(fp);
        if (stats.mtime.getTime() < cutoffMs) { await unlink(fp); deleted++; }
      } catch { /* skip unreadable files */ }
    }
  }
  return deleted;
}

/**
 * Delete Gemini session transcripts older than `cutoffMs` across ALL project
 * directories under `tmpRoot`. Gemini stores chats under per-project-hash dirs
 * (`~/.gemini/tmp/<projectDir>/chats/`) — 'personal-assistant' plus 40+
 * hash-named dirs — in TWO layouts, both actively written:
 *   1. top-level `chats/session-*.json(l)` files (bot dispatches), and
 *   2. per-conversation UUID subdirectories `chats/<uuid>/<file>.json(l)`
 *      (subagent/newer-CLI sessions — files inside are NOT session-prefixed).
 * The prior implementation only handled layout 1, so UUID-dir sessions leaked
 * indefinitely (deep-recheck P1-1). Exported for unit testing.
 */
export async function cleanupGeminiSessions(tmpRoot: string, cutoffMs: number): Promise<number> {
  let deleted = 0;
  let projectDirs: string[];
  try {
    projectDirs = await readdir(tmpRoot);
  } catch {
    return 0;
  }
  for (const projectDir of projectDirs) {
    const chatsDir = join(tmpRoot, projectDir, 'chats');
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = await readdir(chatsDir, { withFileTypes: true });
    } catch {
      continue; // no chats/ subdir here
    }
    for (const entry of entries) {
      const fp = join(chatsDir, entry.name);
      if (entry.isDirectory()) {
        // Layout 2: UUID conversation dir — prune expired transcript files
        // inside (any .json/.jsonl, no prefix requirement), then remove the
        // dir itself if that left it empty. All failures non-fatal.
        try {
          const inner = await readdir(fp);
          for (const name of inner) {
            if (!name.endsWith('.json') && !name.endsWith('.jsonl')) continue;
            const innerPath = join(fp, name);
            try {
              const stats = await stat(innerPath);
              if (stats.mtime.getTime() < cutoffMs) { await unlink(innerPath); deleted++; }
            } catch { /* skip unreadable files */ }
          }
          if ((await readdir(fp)).length === 0) await rmdir(fp).catch(() => {});
        } catch { /* skip unreadable dirs */ }
        continue;
      }
      // Layout 1: top-level session-*.json(l) files.
      if (!entry.name.startsWith('session-') || (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl'))) continue;
      try {
        const stats = await stat(fp);
        if (stats.mtime.getTime() < cutoffMs) { await unlink(fp); deleted++; }
      } catch { /* skip unreadable files */ }
    }
  }
  return deleted;
}

/** Matches agy conversation files: `<uuid>.pb` (current CLI format, protobuf)
 * or `<uuid>.db` (older format). UUID-anchored so non-conversation artifacts
 * (e.g. index/state .pb files) in the same tree are never touched. */
const AGY_CONVERSATION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pb|db)$/i;

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
 * Clean up expired session files for all worker types (older than SESSION_TTL_MS).
 * Safe to call periodically — the 24h TTL matches the resume TTL, so anything it
 * deletes is already non-resumable. Previously only ran at bot startup, which on
 * a forever-daemon meant it effectively never ran in steady state.
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const cutoff = Date.now() - SESSION_TTL_MS;
  let deletedCount = 0;

  try {
    deletedCount += await cleanupClaudeSessions(join(homedir(), '.claude', 'projects'), cutoff);
  } catch (err) {
    console.warn('[session] Claude session cleanup failed:', err);
  }

  try {
    deletedCount += await cleanupGeminiSessions(join(homedir(), '.gemini', 'tmp'), cutoff);
  } catch (err) {
    console.warn('[session] Gemini session cleanup failed:', err);
  }

  try {
    deletedCount += await cleanupAgySessions(join(homedir(), '.gemini', 'antigravity-cli', 'conversations'), cutoff);
  } catch (err) {
    console.warn('[session] Antigravity session cleanup failed:', err);
  }

  // Codex threads are archived in SQLite (no transcript file to unlink).
  try {
    const codexDb = join(homedir(), '.codex', 'state_5.sqlite');
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
  await new Promise<void>((resolve, reject) => {
    execFile('sqlite3', [
      dbPath,
      `UPDATE threads SET archived = 1, archived_at = ${archiveAt} WHERE archived = 0 AND updated_at < ${cutoffEpoch}`
    ], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// --- Expiry ---

export function isSessionExpired(session: SessionInfo): boolean {
  return Date.now() - new Date(session.started_at).getTime() >= SESSION_TTL_MS;
}

// --- File existence ---

/**
 * Derive the Claude project directory name from a cwd path.
 * Claude maps cwd to project dir by replacing the drive prefix (e.g. "C:/") with
 * the drive letter + "--", then replacing all remaining path separators and spaces with "-".
 * e.g. "C:/My Project"           -> "C--My-Project"
 *      "C:/code/claude-demo"     -> "C--code-claude-demo"
 */
export function cwdToClaudeProjectDir(cwd: string): string {
  return cwd
    .replace(/^([A-Za-z]):[\\/]/, '$1--')  // "C:/" -> "C--"
    .replace(/[\\/\s]/g, '-');             // separators and spaces -> "-"
}

const DEFAULT_CLAUDE_PROJECT_DIR = (process.env.BOT_CWD || process.cwd())
  .replace(/^([A-Za-z]):[\\/]/, '$1--')
  .replace(/[\\/\s]/g, '-');

function claudeSessionPath(sessionId: string, cwd?: string): string {
  const projectDir = cwd ? cwdToClaudeProjectDir(cwd) : DEFAULT_CLAUDE_PROJECT_DIR;
  return join(homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`);
}

export function getPriorSessionPath(worker: string, sessionId: string, cwd?: string): string | null {
  if (worker === 'claude' || worker === 'zclaude') {
    return claudeSessionPath(sessionId, cwd);
  }
  if (worker === 'gemini') {
    // Exact filename requires async dir scan; return a glob pattern the LLM can resolve.
    return `${homedir()}/.gemini/tmp/personal-assistant/chats/session-*-${sessionId.slice(0, 8)}*.json*`;
  }
  if (worker === 'agy') {
    // Current CLI writes <uuid>.pb (protobuf); .db was the older format.
    return `${homedir()}/.gemini/antigravity-cli/conversations/${sessionId}.pb`;
  }
  // Codex: stored in SQLite only — no transcript file.
  return null;
}

async function codexSessionExists(sessionId: string): Promise<boolean> {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(sessionId)) return false;

  const dbPath = join(homedir(), '.codex', 'state_5.sqlite');
  try { await stat(dbPath); } catch { return false; }

  return new Promise((resolve) => {
    const query = `SELECT 1 FROM threads WHERE id = '${sessionId}' AND archived = 0 LIMIT 1`;
    execFile('sqlite3', [dbPath, query], (err, stdout) => {
      resolve(!err && stdout.trim() === '1');
    });
  });
}

async function geminiSessionPath(sessionId: string): Promise<string | null> {
  // Gemini session files: ~/.gemini/tmp/personal-assistant/chats/session-*-<id-prefix>.json
  // The first 8 chars of the sessionId appear in the filename.
  const dir = join(homedir(), '.gemini', 'tmp', 'personal-assistant', 'chats');
  const prefix = sessionId.slice(0, 8);
  try {
    const entries = await readdir(dir);
    const match = entries.find(
      (e) => e.startsWith('session-') && e.includes(prefix) && (e.endsWith('.json') || e.endsWith('.jsonl'))
    );
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

export async function sessionFileExists(session: SessionInfo, cwd?: string): Promise<boolean> {
  try {
    if (session.worker === 'claude' || session.worker === 'zclaude') {
      await stat(claudeSessionPath(session.session_id, cwd));
      return true;
    } else if (session.worker === 'codex') {
      return codexSessionExists(session.session_id);
    } else if (session.worker === 'agy') {
      // .pb is the live format; fall back to .db for sessions from older installs.
      const agyDir = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
      try {
        await stat(join(agyDir, `${session.session_id}.pb`));
        return true;
      } catch {
        await stat(join(agyDir, `${session.session_id}.db`));
        return true;
      }
    } else {
      const path = await geminiSessionPath(session.session_id);
      if (!path) return false;
      await stat(path);
      return true;
    }
  } catch {
    return false;
  }
}

// --- Session validity ---

export async function isSessionValid(session: SessionInfo, cwd?: string): Promise<boolean> {
  if (isSessionExpired(session)) return false;
  return sessionFileExists(session, cwd);
}

// --- Gemini session discovery ---

export async function discoverGeminiSessionId(projectDir: string): Promise<string | null> {
  const dir = join(homedir(), '.gemini', 'tmp', projectDir, 'chats');
  try {
    const entries = await readdir(dir);
    let latest: { path: string; mtime: Date } | null = null;

    for (const name of entries) {
      if (!name.startsWith('session-') || (!name.endsWith('.json') && !name.endsWith('.jsonl'))) continue;
      const fp = join(dir, name);
      try {
        const s = await stat(fp);
        if (!latest || s.mtime > latest.mtime) {
          latest = { path: fp, mtime: s.mtime };
        }
      } catch {
        // skip unreadable entries
      }
    }

    if (!latest) return null;

        const raw = await readFile(latest.path, 'utf8');
    let data: { sessionId?: string };
    if (latest.path.endsWith('.jsonl')) {
      const firstLine = raw.split('\n')[0];
      data = JSON.parse(firstLine);
    } else {
      data = JSON.parse(raw);
    }
    return data.sessionId ?? null;
  } catch {
    return null;
  }
}

export async function discoverAgySessionId(): Promise<string | null> {
  const dir = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
  try {
    const entries = await readdir(dir);
    let latest: { name: string; mtime: Date } | null = null;

    for (const name of entries) {
      // UUID-anchored, .pb (live) or .db (legacy) — same filter as the GC:
      // non-conversation artifacts (index/state .pb) in the same dir must
      // never be picked up as a "session id" (they'd persistently win on
      // mtime while real conversations age out at the 24h TTL, poisoning
      // every subsequent resume with e.g. `--conversation index`).
      if (!AGY_CONVERSATION_FILE_RE.test(name)) continue;
      const fp = join(dir, name);
      try {
        const s = await stat(fp);
        if (!latest || s.mtime > latest.mtime) {
          latest = { name, mtime: s.mtime };
        }
      } catch {
        // skip unreadable
      }
    }

    if (!latest) return null;
    return latest.name.replace(/\.(pb|db)$/, ''); // Strip whichever extension matched
  } catch {
    return null;
  }
}

// --- Resume args ---

export function buildResumeArgs(session: SessionInfo): string[] {
  if (session.worker === 'codex') {
    // Codex uses subcommand syntax: `codex exec ... resume <id> -`
    return ['resume', session.session_id];
  }
  if (session.worker === 'agy') {
    // Antigravity CLI uses --conversation instead of --resume
    return ['--conversation', session.session_id];
  }
  // Both Claude and Gemini accept --resume <uuid>
  return ['--resume', session.session_id];
}
