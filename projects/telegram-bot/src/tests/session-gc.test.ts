import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupClaudeSessions, cleanupGeminiSessions, cleanupAgySessions } from '../session.js';

// These helpers take the root dir as a parameter, so they are testable with pure
// temp dirs (unlike cleanupExpiredSessions, which hardcodes homedir()).

let root: string;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-gc-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function aged(path: string, ageMs: number, content = '{}'): Promise<void> {
  await writeFile(path, content, 'utf8');
  const t = new Date(Date.now() - ageMs);
  await utimes(path, t, t);
}

describe('cleanupGeminiSessions (multi project-dir coverage)', () => {
  it('prunes expired sessions across ALL project dirs, not just personal-assistant', async () => {
    const cutoff = Date.now() - DAY;
    // personal-assistant/chats (the only dir the buggy version cleaned)
    const pa = join(root, 'personal-assistant', 'chats');
    await mkdir(pa, { recursive: true });
    await aged(join(pa, 'session-old-aaaa.json'), 2 * DAY);
    await aged(join(pa, 'session-new-bbbb.json'), 60 * 1000);
    // a hash-named project dir (the ones the old code leaked forever)
    const hash = join(root, 'deadbeefdeadbeef', 'chats');
    await mkdir(hash, { recursive: true });
    await aged(join(hash, 'session-old-cccc.jsonl'), 3 * DAY);
    await aged(join(hash, 'session-new-dddd.jsonl'), 60 * 1000);

    const removed = await cleanupGeminiSessions(root, cutoff);
    assert.equal(removed, 2, 'both expired sessions removed across both project dirs');
    assert.deepEqual(await readdir(pa), ['session-new-bbbb.json']);
    assert.deepEqual(await readdir(hash), ['session-new-dddd.jsonl']);
  });

  it('ignores non-session top-level files and returns 0 for a missing root', async () => {
    const chats = join(root, 'proj', 'chats');
    await mkdir(chats, { recursive: true });
    await aged(join(chats, 'config.json'), 10 * DAY);   // not session-*
    await aged(join(chats, 'notes.txt'), 10 * DAY);
    assert.equal(await cleanupGeminiSessions(root, Date.now() - DAY), 0);
    assert.equal(await cleanupGeminiSessions(join(root, 'nope'), Date.now()), 0);
  });

  it('prunes expired transcripts inside UUID conversation dirs and removes emptied dirs (deep-recheck P1-1)', async () => {
    const cutoff = Date.now() - DAY;
    const chats = join(root, 'personal-assistant', 'chats');
    // UUID dir whose contents are ALL expired → files deleted, dir removed.
    const deadDir = join(chats, 'a1b2c3d4-0000-4000-8000-000000000001');
    await mkdir(deadDir, { recursive: true });
    await aged(join(deadDir, '88c97b81-1111-4111-8111-000000000001.jsonl'), 3 * DAY);
    await aged(join(deadDir, 'ovuwjp.json'), 5 * DAY); // April-era inner name, no session- prefix
    // UUID dir with one fresh transcript → fresh file and dir survive.
    const liveDir = join(chats, 'b2c3d4e5-0000-4000-8000-000000000002');
    await mkdir(liveDir, { recursive: true });
    await aged(join(liveDir, 'session.jsonl'), 60 * 1000);
    // Non-transcript file inside a UUID dir → untouched, keeps its dir alive.
    const mixedDir = join(chats, 'c3d4e5f6-0000-4000-8000-000000000003');
    await mkdir(mixedDir, { recursive: true });
    await aged(join(mixedDir, 'logs.bin'), 10 * DAY);

    const removed = await cleanupGeminiSessions(root, cutoff);
    assert.equal(removed, 2, 'both expired inner transcripts removed');
    assert.equal(existsSync(deadDir), false, 'emptied UUID dir is removed');
    assert.deepEqual(await readdir(liveDir), ['session.jsonl']);
    assert.deepEqual(await readdir(mixedDir), ['logs.bin'], 'non-transcript files are never touched');
  });
});

describe('cleanupClaudeSessions', () => {
  it('prunes expired .jsonl across all project dirs, keeps fresh', async () => {
    const cutoff = Date.now() - DAY;
    const p1 = join(root, 'C--proj-one');
    const p2 = join(root, 'C--proj-two');
    await mkdir(p1, { recursive: true });
    await mkdir(p2, { recursive: true });
    await aged(join(p1, 'old.jsonl'), 2 * DAY);
    await aged(join(p2, 'fresh.jsonl'), 60 * 1000);
    assert.equal(await cleanupClaudeSessions(root, cutoff), 1);
    assert.equal((await readdir(p1)).length, 0);
    assert.deepEqual(await readdir(p2), ['fresh.jsonl']);
  });
});

describe('cleanupAgySessions', () => {
  it('prunes expired UUID-named .pb (live format) and .db (legacy) conversations only (deep-recheck P1-4)', async () => {
    const cutoff = Date.now() - DAY;
    const oldPb = 'a1b2c3d4-1111-4111-8111-000000000001.pb';
    const freshPb = 'b2c3d4e5-2222-4222-8222-000000000002.pb';
    const oldDb = 'c3d4e5f6-3333-4333-8333-000000000003.db';
    await aged(join(root, oldPb), 2 * DAY);
    await aged(join(root, freshPb), 1000);
    await aged(join(root, oldDb), 2 * DAY);
    await aged(join(root, 'index.pb'), 5 * DAY);        // non-UUID artifact — never touched
    await aged(join(root, 'not-a-session.txt'), 5 * DAY);
    assert.equal(await cleanupAgySessions(root, cutoff), 2);
    assert.deepEqual((await readdir(root)).sort(), [freshPb, 'index.pb', 'not-a-session.txt'].sort());
  });
});
