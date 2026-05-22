import { stat, readdir, readFile, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import type { SessionInfo } from './types.js';

// TODO: [AI-020 Phase 6] Extract to shared config (pa/src/lib/config-shared.ts)
// This module should provide centralized path resolution, including session directory paths.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// --- Cleanup ---

/**
 * Clean up expired session files for all worker types.
 * Removes session files older than SESSION_TTL_MS (24 hours).
 * Called on bot startup to prevent accumulation.
 */
export async function cleanupExpiredSessions(): Promise<void> {
  const now = Date.now();
  const cutoff = now - SESSION_TTL_MS;
  let deletedCount = 0;

  // Clean up Claude/zclaude sessions across all project directories
  try {
    const claudeProjectsRoot = join(homedir(), '.claude', 'projects');
    const projectDirs = await readdir(claudeProjectsRoot);
    for (const dir of projectDirs) {
      const claudeSessionDir = join(claudeProjectsRoot, dir);
      try {
        const entries = await readdir(claudeSessionDir);
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue;
          const fp = join(claudeSessionDir, entry);
          try {
            const stats = await stat(fp);
            if (stats.mtime.getTime() < cutoff) {
              await unlink(fp);
              deletedCount++;
            }
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // skip non-directory entries or unreadable dirs
      }
    }
  } catch (err) {
    // Directory doesn't exist or unreadable - skip
    console.warn('[session] Claude session cleanup failed:', err);
  }

  // Clean up Gemini sessions
  try {
    const geminiSessionDir = join(homedir(), '.gemini', 'tmp', 'personal-assistant', 'chats');
    const geminiEntries = await readdir(geminiSessionDir);
    for (const entry of geminiEntries) {
      if (!entry.startsWith('session-') || !entry.endsWith('.json')) continue;

      const fp = join(geminiSessionDir, entry);
      try {
        const stats = await stat(fp);
        if (stats.mtime.getTime() < cutoff) {
          await unlink(fp);
          deletedCount++;
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch (err) {
    // Directory doesn't exist or unreadable - skip
    console.warn('[session] Gemini session cleanup failed:', err);
  }

  // Clean up Codex sessions (archive old threads in SQLite)
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
function cwdToClaudeProjectDir(cwd: string): string {
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
    return `${homedir()}/.gemini/tmp/personal-assistant/chats/session-*-${sessionId.slice(0, 8)}*.json`;
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
      (e) => e.startsWith('session-') && e.includes(prefix) && e.endsWith('.json')
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
      if (!name.startsWith('session-') || !name.endsWith('.json')) continue;
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
    const data = JSON.parse(raw) as { sessionId?: string };
    return data.sessionId ?? null;
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
  // Both Claude and Gemini accept --resume <uuid>
  return ['--resume', session.session_id];
}
