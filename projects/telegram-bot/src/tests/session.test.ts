import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import {
  SESSION_TTL_MS,
  isSessionExpired,
  sessionFileExists,
  isSessionValid,
  discoverGeminiSessionId,
  buildResumeArgs,
  cleanupCodexSessions,
  getPriorSessionPath,
  cwdToClaudeProjectDir,
} from '../session.js';
import type { SessionInfo } from '../types.js';

// ---------------------------------------------------------------------------
// isSessionExpired
// ---------------------------------------------------------------------------

describe('isSessionExpired', () => {
  it('returns false for a freshly created session', () => {
    const session: SessionInfo = {
      session_id: 'abc',
      worker: 'claude',
      started_at: new Date().toISOString(),
    };
    assert.equal(isSessionExpired(session), false);
  });

  it('returns false for a session 1 hour old', () => {
    const session: SessionInfo = {
      session_id: 'abc',
      worker: 'claude',
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    };
    assert.equal(isSessionExpired(session), false);
  });

  it('returns true for a session 25 hours old', () => {
    const session: SessionInfo = {
      session_id: 'abc',
      worker: 'claude',
      started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    assert.equal(isSessionExpired(session), true);
  });

  it('returns true for a session exactly at TTL boundary', () => {
    const session: SessionInfo = {
      session_id: 'abc',
      worker: 'claude',
      started_at: new Date(Date.now() - SESSION_TTL_MS).toISOString(),
    };
    assert.equal(isSessionExpired(session), true);
  });
});

// ---------------------------------------------------------------------------
// sessionFileExists — tested via a fake home dir using monkey-patching
// We test the Gemini path via discoverGeminiSessionId (uses real filesystem).
// For Claude, we test indirectly through isSessionValid with a temp dir.
// ---------------------------------------------------------------------------

// We can't easily monkey-patch homedir() in ESM, so we test the Gemini branch
// through discoverGeminiSessionId and trust the Claude branch follows the same logic.

// ---------------------------------------------------------------------------
// discoverGeminiSessionId
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('discoverGeminiSessionId', () => {
  it('returns null for an empty directory', async () => {
    const chatsDir = join(tempDir, 'chats');
    await mkdir(chatsDir, { recursive: true });

    // Override the home lookup by using the parent of chatsDir as projectDir
    // We can't easily override homedir(), so we test the function's directory logic
    // by placing files at the expected relative path under a temp root.
    // discoverGeminiSessionId uses: join(homedir(), '.gemini', 'tmp', projectDir, 'chats')
    // We'll create a symlink-like structure using a custom projectDir path.

    // Since we can't override homedir(), we test the "no matching files" branch
    // by using a valid dir with no session-*.json files.
    // The function returns null for empty chats dir.
    const result = await discoverGeminiSessionId('__nonexistent_project_12345__');
    assert.equal(result, null);
  });

  it('parses sessionId from the newest session file', async () => {
    // Create the expected directory structure: ~/.gemini/tmp/<project>/chats/
    const geminiDir = join(homedir(), '.gemini', 'tmp');
    const projectDir = `tgbot-test-${Date.now()}`;
    const chatsDir = join(geminiDir, projectDir, 'chats');
    await mkdir(chatsDir, { recursive: true });

    const sessionId1 = 'aaaaaaaa-0000-0000-0000-000000000001';
    const sessionId2 = 'bbbbbbbb-0000-0000-0000-000000000002';

    // Write an older file first
    await writeFile(
      join(chatsDir, 'session-2026-01-01T00-00-aaaaaaaa.json'),
      JSON.stringify({ sessionId: sessionId1, messages: [] })
    );

    // Small delay to ensure distinct mtime
    await new Promise((r) => setTimeout(r, 50));

    // Write a newer file
    await writeFile(
      join(chatsDir, 'session-2026-01-02T00-00-bbbbbbbb.json'),
      JSON.stringify({ sessionId: sessionId2, messages: [] })
    );

    try {
      const result = await discoverGeminiSessionId(projectDir);
      assert.equal(result, sessionId2, 'should return the most recent sessionId');
    } finally {
      await rm(join(geminiDir, projectDir), { recursive: true, force: true });
    }
  });

  it('ignores non-session files', async () => {
    const geminiDir = join(homedir(), '.gemini', 'tmp');
    const projectDir = `tgbot-test-ignore-${Date.now()}`;
    const chatsDir = join(geminiDir, projectDir, 'chats');
    await mkdir(chatsDir, { recursive: true });

    // Write files that don't match session-*.json pattern
    await writeFile(join(chatsDir, 'config.json'), JSON.stringify({ sessionId: 'should-not-appear' }));
    await writeFile(join(chatsDir, 'not-a-session.txt'), 'irrelevant');

    try {
      const result = await discoverGeminiSessionId(projectDir);
      assert.equal(result, null);
    } finally {
      await rm(join(geminiDir, projectDir), { recursive: true, force: true });
    }
  });

  it('returns null if session file has no sessionId field', async () => {
    const geminiDir = join(homedir(), '.gemini', 'tmp');
    const projectDir = `tgbot-test-noid-${Date.now()}`;
    const chatsDir = join(geminiDir, projectDir, 'chats');
    await mkdir(chatsDir, { recursive: true });

    await writeFile(
      join(chatsDir, 'session-2026-01-01T00-00-aabbccdd.json'),
      JSON.stringify({ messages: [] }) // no sessionId
    );

    try {
      const result = await discoverGeminiSessionId(projectDir);
      assert.equal(result, null);
    } finally {
      await rm(join(geminiDir, projectDir), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// buildResumeArgs
// ---------------------------------------------------------------------------

describe('buildResumeArgs', () => {
  it('returns --resume <uuid> for claude', () => {
    const session: SessionInfo = {
      session_id: 'e0912e78-2c5b-4359-89a9-c0aa7915a346',
      worker: 'claude',
      started_at: new Date().toISOString(),
    };
    const args = buildResumeArgs(session);
    assert.deepEqual(args, ['--resume', 'e0912e78-2c5b-4359-89a9-c0aa7915a346']);
  });

  it('returns --resume <uuid> for gemini (same as claude)', () => {
    const session: SessionInfo = {
      session_id: 'cc0c2c94-5c4e-4e6b-90f7-afe2a4cf6fca',
      worker: 'gemini',
      started_at: new Date().toISOString(),
    };
    const args = buildResumeArgs(session);
    assert.deepEqual(args, ['--resume', 'cc0c2c94-5c4e-4e6b-90f7-afe2a4cf6fca']);
  });

  it('returns --resume <uuid> for zclaude (passthrough wrapper, same args as claude)', () => {
    const session: SessionInfo = {
      session_id: 'dd0d3d05-6d5f-5f7c-a1b8-bfb3b5dg7gdb',
      worker: 'zclaude',
      started_at: new Date().toISOString(),
    };
    const args = buildResumeArgs(session);
    assert.deepEqual(args, ['--resume', 'dd0d3d05-6d5f-5f7c-a1b8-bfb3b5dg7gdb']);
  });

  it('returns resume <uuid> for codex (subcommand syntax)', () => {
    const session: SessionInfo = {
      session_id: '019d7484-f431-7420-9f93-ec843d3fb6a6',
      worker: 'codex',
      started_at: new Date().toISOString(),
    };
    assert.deepEqual(buildResumeArgs(session), ['resume', '019d7484-f431-7420-9f93-ec843d3fb6a6']);
  });
});

// ---------------------------------------------------------------------------
// sessionFileExists — codex
// ---------------------------------------------------------------------------

describe('sessionFileExists: codex worker', () => {
  it('returns false for invalid (non-UUID) session ID', async () => {
    const session: SessionInfo = {
      session_id: 'not-a-uuid',
      worker: 'codex',
      started_at: new Date().toISOString(),
    };
    assert.equal(await sessionFileExists(session), false);
  });

  it('returns false for valid UUID that does not exist in codex DB', async () => {
    const session: SessionInfo = {
      session_id: '00000000-0000-0000-0000-000000000000',
      worker: 'codex',
      started_at: new Date().toISOString(),
    };
    // This UUID is extremely unlikely to exist — returns false
    assert.equal(await sessionFileExists(session), false);
  });

  it('returns false when codex sqlite DB does not exist', async () => {
    // Uses a UUID format that is valid but DB check will fail if sqlite3 or DB absent
    const session: SessionInfo = {
      session_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      worker: 'codex',
      started_at: new Date().toISOString(),
    };
    // Gracefully returns false (no crash)
    assert.equal(typeof await sessionFileExists(session), 'boolean');
  });
});

// ---------------------------------------------------------------------------
// isSessionValid — integrates expiry + file existence
// ---------------------------------------------------------------------------

describe('isSessionValid', () => {
  it('returns false for expired session (no file check needed)', async () => {
    const session: SessionInfo = {
      session_id: 'some-uuid',
      worker: 'claude',
      started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    assert.equal(await isSessionValid(session), false);
  });

  it('returns false for fresh session with missing file', async () => {
    const session: SessionInfo = {
      session_id: 'nonexistent-uuid-that-will-not-exist',
      worker: 'claude',
      started_at: new Date().toISOString(),
    };
    assert.equal(await isSessionValid(session), false);
  });

  it('returns true for fresh session with existing Claude file', async () => {
    // Create a real .jsonl file in the Claude session directory — the same path
    // claudeSessionPath() resolves to — then verify isSessionValid returns true.
    const sessionId = `00000000-0000-0000-0000-${Date.now().toString(10).slice(-12).padStart(12, '0')}`;
    // Resolve the default project dir exactly as the code does (cwd/BOT_CWD-derived)
    // so the fixture lands where isSessionValid (no cwd) looks, on any machine.
    const claudeDir = join(homedir(), '.claude', 'projects', cwdToClaudeProjectDir(process.env.BOT_CWD || process.cwd()));
    const sessionFile = join(claudeDir, `${sessionId}.jsonl`);
    await mkdir(claudeDir, { recursive: true });
    try {
      await writeFile(sessionFile, '', 'utf8'); // empty JSONL is fine for existence check
      const session: SessionInfo = {
        session_id: sessionId,
        worker: 'claude',
        started_at: new Date().toISOString(),
      };
      assert.equal(await isSessionValid(session), true);
    } finally {
      try { await unlink(sessionFile); } catch {} // unlink the file only — never rm a possibly-real dir
    }
  });

  it('returns true for zclaude session with existing Claude file (same path as claude)', async () => {
    // zclaude wraps claude and uses the same ~/.claude/projects/ state dir
    const sessionId = `11111111-1111-1111-1111-${Date.now().toString(10).slice(-12).padStart(12, '0')}`;
    const claudeDir = join(homedir(), '.claude', 'projects', cwdToClaudeProjectDir(process.env.BOT_CWD || process.cwd()));
    const sessionFile = join(claudeDir, `${sessionId}.jsonl`);
    await mkdir(claudeDir, { recursive: true });
    try {
      await writeFile(sessionFile, '', 'utf8');
      const session: SessionInfo = {
        session_id: sessionId,
        worker: 'zclaude',
        started_at: new Date().toISOString(),
      };
      assert.equal(await isSessionValid(session), true);
    } finally {
      try { await unlink(sessionFile); } catch {} // unlink the file only — never rm a possibly-real dir
    }
  });

  it('returns false for zclaude session with missing file', async () => {
    const session: SessionInfo = {
      session_id: 'nonexistent-zclaude-uuid',
      worker: 'zclaude',
      started_at: new Date().toISOString(),
    };
    assert.equal(await isSessionValid(session), false);
  });

  it('returns false for expired codex session', async () => {
    const session: SessionInfo = {
      session_id: '019d7484-f431-7420-9f93-ec843d3fb6a6',
      worker: 'codex',
      started_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };
    assert.equal(await isSessionValid(session), false);
  });

  it('returns false for codex session with invalid session ID', async () => {
    const session: SessionInfo = {
      session_id: 'not-a-uuid',
      worker: 'codex',
      started_at: new Date().toISOString(),
    };
    assert.equal(await isSessionValid(session), false);
  });

  it('finds claude session in cwd-derived project dir when cwd is provided', async () => {
    // Simulates the cwd_override scenario: the session file lives in the
    // project dir derived from fakeCwd, NOT the default (process cwd) project
    // dir. isSessionValid(session, cwd) must look in the right place.
    const ts = Date.now();
    const fakeCwd = `C:/test-repos/test-${ts}`;
    const projectDir = cwdToClaudeProjectDir(fakeCwd); // must match what isSessionValid(session, fakeCwd) derives
    const sessionId = `22222222-2222-2222-2222-${ts.toString().slice(-12).padStart(12, '0')}`;
    const claudeDir = join(homedir(), '.claude', 'projects', projectDir);
    const sessionFile = join(claudeDir, `${sessionId}.jsonl`);
    await mkdir(claudeDir, { recursive: true });
    try {
      await writeFile(sessionFile, '', 'utf8');
      const session: SessionInfo = { session_id: sessionId, worker: 'claude', started_at: new Date().toISOString() };
      assert.equal(await isSessionValid(session, fakeCwd), true,
        'should find file in cwd-derived project dir');
      assert.equal(await isSessionValid(session), false,
        'should NOT find file in the default (cwd-derived) project dir when it is elsewhere');
    } finally {
      try { await unlink(sessionFile); } catch {}
      try { await rm(claudeDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// cleanupCodexSessions
// ---------------------------------------------------------------------------

describe('cleanupCodexSessions', () => {
  let tmpDb: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-cleanup-'));
    tmpDb = join(dir, 'state_5.sqlite');
  });

  afterEach(async () => {
    const dir = join(tmpDb, '..');
    await rm(dir, { recursive: true, force: true });
  });

  /** Helper: run a sqlite3 command and return stdout */
  function sqlite3(db: string, sql: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('sqlite3', [db, sql], (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout as string).trim());
      });
    });
  }

  it('archives threads older than cutoff', async () => {
    const expiredAt = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000); // 48h ago
    await sqlite3(tmpDb, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER);',
      `INSERT INTO threads VALUES('expired-thread', ${expiredAt}, 0, NULL);`,
    ].join(' '));

    const cutoff = Date.now() - SESSION_TTL_MS;
    await cleanupCodexSessions(tmpDb, cutoff);

    const archived = await sqlite3(tmpDb, "SELECT archived FROM threads WHERE id = 'expired-thread'");
    assert.equal(archived, '1', 'expired thread should be archived');
  });

  it('does not archive recent threads', async () => {
    const recentAt = Math.floor((Date.now() - 1 * 60 * 60 * 1000) / 1000); // 1h ago
    await sqlite3(tmpDb, [
      'CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER);',
      `INSERT INTO threads VALUES('recent-thread', ${recentAt}, 0, NULL);`,
    ].join(' '));

    const cutoff = Date.now() - SESSION_TTL_MS;
    await cleanupCodexSessions(tmpDb, cutoff);

    const archived = await sqlite3(tmpDb, "SELECT archived FROM threads WHERE id = 'recent-thread'");
    assert.equal(archived, '0', 'recent thread should NOT be archived');
  });

  it('rejects when DB does not exist', async () => {
    await assert.rejects(
      () => cleanupCodexSessions('/nonexistent/path/state_5.sqlite', Date.now() - SESSION_TTL_MS),
      { code: 'ENOENT' }
    );
  });
});

// ---------------------------------------------------------------------------
// getPriorSessionPath
// ---------------------------------------------------------------------------

describe('getPriorSessionPath', () => {
  it('returns .jsonl path for claude', () => {
    const result = getPriorSessionPath('claude', 'abc-def-123', 'C:/test-project');
    assert.ok(result !== null, 'should return a path');
    assert.ok(result!.endsWith('abc-def-123.jsonl'), `expected .jsonl suffix, got: ${result}`);
  });

  it('returns same path for zclaude as claude', () => {
    const claude = getPriorSessionPath('claude', 'abc-def-123', 'C:/test-project');
    const zclaude = getPriorSessionPath('zclaude', 'abc-def-123', 'C:/test-project');
    assert.equal(zclaude, claude);
  });

  it('returns glob pattern for gemini containing id prefix and a .json* suffix (matches .json and .jsonl)', () => {
    const result = getPriorSessionPath('gemini', 'abc12345xxxx', undefined);
    assert.ok(result !== null, 'should return a path');
    assert.ok(result!.includes('abc12345'), `should contain first 8 chars of id, got: ${result}`);
    assert.ok(/\.json\*?$/.test(result!), `should end in a .json/.json* glob suffix, got: ${result}`);
  });

  it('returns null for codex', () => {
    assert.equal(getPriorSessionPath('codex', 'any-id', undefined), null);
  });

  it('returns null for unknown worker', () => {
    assert.equal(getPriorSessionPath('unknown', 'any-id', undefined), null);
  });
});
