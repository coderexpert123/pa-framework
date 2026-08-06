import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { cleanupAgySessions, GC_RETENTION_MS, SESSION_TTL_MS } from '../session.js';

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

  it('applies 30-day GC retention, not the 24h resume TTL (regression guard: 2026-08-02 incident)', async () => {
    const cutoff = Date.now() - GC_RETENTION_MS;
    const tooOld = 'a1b2c3d4-4444-4444-8444-000000000004.pb';
    const keep = 'b2c3d4e5-5555-4555-8555-000000000005.pb';
    await aged(join(root, tooOld), 40 * DAY);
    await aged(join(root, keep), 20 * DAY); // older than 24h, well within 30d — must survive
    assert.equal(await cleanupAgySessions(root, cutoff), 1);
    assert.deepEqual(await readdir(root), [keep]);
  });
});

describe('GC retention constants', () => {
  it('keeps the GC cutoff and resume TTL as two distinct constants', () => {
    assert.equal(GC_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
    assert.equal(SESSION_TTL_MS, 24 * 60 * 60 * 1000);
  });
});
