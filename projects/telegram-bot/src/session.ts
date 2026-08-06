import { stat, readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { sqliteQuery } from '../../../pa/dist/src/lib/db.js';
import {
  GC_RETENTION_MS,
  AGY_CONVERSATION_FILE_RE,
  cleanupAgySessions,
  cleanupCodexSessions,
  cleanupExpiredSessions,
} from '../../../pa/dist/src/lib/session-gc.js';
import type { SessionInfo } from './types.js';

// TODO: [AI-020 Phase 6] Extract to shared config (pa/src/lib/config-shared.ts)
// This module should provide centralized path resolution, including session directory paths.

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// The GC implementation moved to pa (pa/src/lib/session-gc.ts) when it became
// the declared `session-gc` maintenance job on the pa host (AI-100 Wave 1).
// Re-exported here so every existing bot caller and test keeps working — the
// same cross-package pattern the db.js import above already uses. SESSION_TTL_MS
// stays LOCAL: it is the 24h resume TTL, NOT the 30d GC retention, and the two
// must never be merged. There is deliberately no cleanupClaudeSessions /
// cleanupGeminiSessions anywhere in this codebase anymore — do not reintroduce
// them; that is now enforced executably by pa/src/lib/maintenance/policy.ts's
// FORBIDDEN_ROOTS, not just by this comment. See
// plans/2026-08-02-session-gc-scope-to-pa-spawned.md for the incident that
// established this (248 real Claude Code transcripts deleted).
export { GC_RETENTION_MS, AGY_CONVERSATION_FILE_RE, cleanupAgySessions, cleanupCodexSessions, cleanupExpiredSessions };

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
  // Agy + Codex: conversation state is a binary SQLite store, not a readable
  // transcript — no path to hand the model. Returning null makes context.ts
  // emit its "no transcript file available for this worker type" line instead.
  //
  // Do NOT reinstate a path here (2026-07-22). The previous version returned
  // `<id>.pb`, which was wrong twice over: agy writes `<uuid>.db` (SQLite, WAL
  // mode) and there has never been a single `.pb` on disk; and on the fresh-
  // dispatch failure path main.ts passes sessionId '', so the string became
  // `.../conversations/.pb` — still truthy, so the model was told to read a
  // file that cannot exist. A `.db` path would be no better: it is protobuf
  // blobs inside SQLite, unreadable by the model and carrying verbatim
  // fragments of files the prior agent had read.
  return null;
}

async function codexSessionExists(sessionId: string): Promise<boolean> {
  // Kept even though parameterization below makes it redundant — defense in depth.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(sessionId)) return false;

  const dbPath = join(homedir(), '.codex', 'state_5.sqlite');
  try {
    const rows = sqliteQuery<{ hit: number }>(
      dbPath,
      'SELECT 1 AS hit FROM threads WHERE id = ? AND archived = 0 LIMIT 1',
      [sessionId]
    );
    return rows.length === 1;
  } catch {
    // Missing file, corrupt DB, locked — gracefully report "no session".
    return false;
  }
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
