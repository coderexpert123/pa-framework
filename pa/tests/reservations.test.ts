import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { flushLog } from '../src/lib/log.js';

async function readAppLogLines(paHomeDir: string): Promise<any[]> {
  try {
    const content = await readFile(join(paHomeDir, 'app.log.jsonl'), 'utf8');
    return content.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('reservations', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  describe('normalizePath', () => {
    it('converts backslashes to forward slashes', async () => {
      const { normalizePath } = await import('../src/lib/reservations.js');
      assert.equal(normalizePath('pa\\src\\code-fixer.ts'), 'pa/src/code-fixer.ts');
    });

    it('strips a leading ./ and trailing /', async () => {
      const { normalizePath } = await import('../src/lib/reservations.js');
      assert.equal(normalizePath('./pa/src/'), 'pa/src');
    });

    it('rejects absolute paths', async () => {
      const { normalizePath } = await import('../src/lib/reservations.js');
      assert.throws(() => normalizePath('/etc/passwd'));
      assert.throws(() => normalizePath('D:\\Personal Assistant\\pa'));
    });

    it('rejects .. escapes', async () => {
      const { normalizePath } = await import('../src/lib/reservations.js');
      assert.throws(() => normalizePath('pa/src/../../secrets.env'));
    });

    it('passes @logical resources through unchanged', async () => {
      const { normalizePath } = await import('../src/lib/reservations.js');
      assert.equal(normalizePath('@build'), '@build');
    });
  });

  describe('pathsOverlap', () => {
    it('truth table', async () => {
      const { pathsOverlap } = await import('../src/lib/reservations.js');

      // identical
      assert.equal(pathsOverlap('pa/src/a.ts', 'pa/src/a.ts'), true);

      // parent/child, both directions
      assert.equal(pathsOverlap('pa/src', 'pa/src/a.ts'), true);
      assert.equal(pathsOverlap('pa/src/a.ts', 'pa/src'), true);

      // siblings sharing a string prefix but not a path prefix — the classic bug
      assert.equal(pathsOverlap('pa/src/a.ts', 'pa/src/ab.ts'), false);

      // logical resources
      assert.equal(pathsOverlap('@build', '@build'), true);
      assert.equal(pathsOverlap('@build', 'pa/src'), false);
    });
  });

  describe('claim', () => {
    it('succeeds on a free path with a well-formed id', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const result = await claim({ paths: ['pa/src/code-fixer.ts'], session: 's-a', note: 'refactor' });
      assert.equal(result.ok, true);
      assert.match(result.reservation!.id, /^r-[0-9a-f]{8}$/);
    });

    it('overlapping claim from a different session conflicts', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const first = await claim({ paths: ['pa/src/code-fixer.ts'], session: 's-a', note: 'refactor A' });
      assert.equal(first.ok, true);

      const second = await claim({ paths: ['pa/src'], session: 's-b', note: 'refactor B' });
      assert.equal(second.ok, false);
      assert.equal(second.conflicts?.length, 1);
      assert.equal(second.conflicts![0].session, 's-a');
      assert.equal(second.conflicts![0].note, 'refactor A');
    });

    it('overlapping claim from the SAME session succeeds (re-entrancy)', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const first = await claim({ paths: ['pa/src/code-fixer.ts'], session: 's-a', note: 'part 1' });
      assert.equal(first.ok, true);

      const second = await claim({ paths: ['pa/src'], session: 's-a', note: 'part 2' });
      assert.equal(second.ok, true);
    });

    it('--force claims over a conflict; both reservations coexist', async () => {
      const { claim, readActive } = await import('../src/lib/reservations.js');
      const first = await claim({ paths: ['pa/src/code-fixer.ts'], session: 's-a', note: 'refactor A' });
      assert.equal(first.ok, true);

      const second = await claim({ paths: ['pa/src'], session: 's-b', note: 'refactor B', force: true });
      assert.equal(second.ok, true);

      const active = await readActive();
      assert.equal(active.length, 2);
      const ids = active.map((r) => r.id).sort();
      assert.deepEqual(ids, [first.reservation!.id, second.reservation!.id].sort());
    });

    it('an expired reservation does not conflict', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const start = Date.now();
      const first = await claim({
        paths: ['pa/src/code-fixer.ts'],
        session: 's-a',
        note: 'refactor A',
        ttlMinutes: 1,
        now: start,
      });
      assert.equal(first.ok, true);

      // 2 minutes later — the 1-minute TTL has expired.
      const second = await claim({
        paths: ['pa/src/code-fixer.ts'],
        session: 's-b',
        note: 'refactor B',
        now: start + 2 * 60_000,
      });
      assert.equal(second.ok, true);
    });

    it('clamps ttlMinutes to the 240-minute hard max', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const result = await claim({
        paths: ['pa/src/code-fixer.ts'],
        session: 's-a',
        note: 'huge ttl',
        ttlMinutes: 10_000,
        now,
      });
      assert.equal(result.ok, true);
      const expiresAt = new Date(result.reservation!.expiresAt).getTime();
      assert.equal(expiresAt, now + 240 * 60_000);
    });

    it('10 parallel claims on 10 distinct paths all succeed with no lost update', async () => {
      const { claim, readActive } = await import('../src/lib/reservations.js');
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          claim({ paths: [`pa/src/file-${i}.ts`], session: `s-${i}`, note: `work ${i}` })
        )
      );
      assert.ok(results.every((r) => r.ok), 'every claim on a distinct path should succeed');

      const active = await readActive();
      assert.equal(active.length, 10);
      const ids = new Set(active.map((r) => r.id));
      assert.equal(ids.size, 10, 'no lost update — all 10 ids distinct and present');
    });

    it('5 parallel claims on the SAME path with force:false: exactly 1 succeeds', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          claim({ paths: ['pa/src/contended.ts'], session: `s-${i}`, note: `attempt ${i}`, force: false })
        )
      );
      const succeeded = results.filter((r) => r.ok);
      assert.equal(succeeded.length, 1, 'exactly one claim on the contended path should win');
    });
  });

  describe('renew', () => {
    it('extends expiresAt, leaves claimedAt and id unchanged', async () => {
      const { claim, renew } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const result = await claim({ paths: ['pa/src/code-fixer.ts'], session: 's-a', note: 'long job', now });
      const original = result.reservation!;

      const renewed = await renew(original.id, { now: now + 30 * 60_000 });
      assert.ok(renewed);
      assert.equal(renewed!.id, original.id);
      assert.equal(renewed!.claimedAt, original.claimedAt);
      assert.notEqual(renewed!.expiresAt, original.expiresAt);
      assert.equal(new Date(renewed!.expiresAt).getTime(), now + 30 * 60_000 + 45 * 60_000);
    });
  });

  describe('release', () => {
    it('release({session}) drops all of that session\'s rows and none of another\'s', async () => {
      const { claim, release, readActive } = await import('../src/lib/reservations.js');
      await claim({ paths: ['pa/src/a.ts'], session: 's-a', note: 'a1' });
      await claim({ paths: ['pa/src/b.ts'], session: 's-a', note: 'a2' });
      await claim({ paths: ['pa/src/c.ts'], session: 's-b', note: 'b1' });

      const { released } = await release({ session: 's-a' });
      assert.equal(released, 2);

      const active = await readActive();
      assert.equal(active.length, 1);
      assert.equal(active[0].session, 's-b');
    });
  });

  describe('gcExpired', () => {
    it('removes exactly the expired rows, returns the count, leaves live rows byte-identical', async () => {
      const { claim, gcExpired, readActive } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const expired = await claim({
        paths: ['pa/src/old.ts'],
        session: 's-a',
        note: 'stale',
        ttlMinutes: 1,
        now,
      });
      const live = await claim({
        paths: ['pa/src/new.ts'],
        session: 's-b',
        note: 'fresh',
        ttlMinutes: 45,
        now,
      });

      const gcAt = now + 2 * 60_000; // past the expired one's TTL, before the live one's
      const removed = await gcExpired(gcAt);
      assert.equal(removed, 1);

      const remaining = await readActive(gcAt);
      assert.equal(remaining.length, 1);
      assert.deepEqual(remaining[0], live.reservation);
      assert.notEqual(remaining[0].id, expired.reservation!.id);
    });
  });

  describe('release ledger (WP-4, AI-175)', () => {
    it('release() records a ledger entry carrying paths, session and note', async () => {
      const { claim, release, readReleasedSince } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const claimed = await claim({
        paths: ['pa/src/ledger-a.ts'],
        session: 's-ledger',
        note: 'ledger test',
        now,
      });
      assert.equal(claimed.ok, true);

      const releaseAt = now + 60_000;
      const { released } = await release({ id: claimed.reservation!.id, now: releaseAt });
      assert.equal(released, 1);

      const entries = await readReleasedSince(now, releaseAt + 1_000);
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0].paths, ['pa/src/ledger-a.ts']);
      assert.equal(entries[0].session, 's-ledger');
      assert.equal(entries[0].note, 'ledger test');
      assert.equal(entries[0].id, claimed.reservation!.id);
      assert.equal(entries[0].claimedAt, claimed.reservation!.claimedAt);
      assert.equal(entries[0].releasedAt, new Date(releaseAt).toISOString());
    });

    it('readReleasedSince(t) returns an entry released after t and omits one released before it', async () => {
      const { claim, release, readReleasedSince } = await import('../src/lib/reservations.js');
      const now = Date.now();

      const early = await claim({ paths: ['pa/src/ledger-early.ts'], session: 's-a', note: 'early', now });
      await release({ id: early.reservation!.id, now: now + 10_000 });

      const late = await claim({ paths: ['pa/src/ledger-late.ts'], session: 's-b', note: 'late', now: now + 20_000 });
      await release({ id: late.reservation!.id, now: now + 30_000 });

      const sinceMidpoint = await readReleasedSince(now + 20_000, now + 40_000);
      assert.equal(sinceMidpoint.length, 1);
      assert.equal(sinceMidpoint[0].session, 's-b');
    });

    it('an entry older than RELEASE_LEDGER_TTL_MS is pruned by the next release() and by gcExpired()', async () => {
      const { claim, release, gcExpired, readReleasedSince, RELEASE_LEDGER_TTL_MS } = await import(
        '../src/lib/reservations.js'
      );
      const now = Date.now();
      const pastTtl = now + RELEASE_LEDGER_TTL_MS + 60_000;

      // --- pruned as a side effect of a later release() call ---
      const stale = await claim({ paths: ['pa/src/ledger-stale.ts'], session: 's-a', note: 'stale', now });
      await release({ id: stale.reservation!.id, now });
      const beforePrune = await readReleasedSince(now, now + 1_000);
      assert.equal(beforePrune.length, 1, 'still inside the TTL immediately after release');

      const fresh = await claim({ paths: ['pa/src/ledger-fresh.ts'], session: 's-b', note: 'fresh', now: pastTtl });
      await release({ id: fresh.reservation!.id, now: pastTtl });
      const afterReleasePrune = await readReleasedSince(now, pastTtl + 1_000);
      assert.equal(afterReleasePrune.some((e) => e.session === 's-a'), false, 'stale entry pruned by release()');
      assert.equal(afterReleasePrune.some((e) => e.session === 's-b'), true, 'fresh entry survives');

      // --- pruned by gcExpired(), independent of any release() call ---
      const another = await claim({
        paths: ['pa/src/ledger-another.ts'],
        session: 's-c',
        note: 'another',
        now: pastTtl,
      });
      await release({ id: another.reservation!.id, now: pastTtl });
      const wellPastTtl = pastTtl + RELEASE_LEDGER_TTL_MS + 60_000;
      await gcExpired(wellPastTtl);
      const afterGc = await readReleasedSince(now, wellPastTtl + 1_000);
      assert.equal(afterGc.some((e) => e.session === 's-c'), false, 'gcExpired() prunes the ledger too');
    });

    it('a store file written without a released key loads, and the first release() creates it (back-compat)', async () => {
      await writeFile(join(dir, 'reservations.json'), JSON.stringify({ reservations: [] }), 'utf8');
      const { claim, release, readReleasedSince } = await import('../src/lib/reservations.js');
      const now = Date.now();

      const claimed = await claim({ paths: ['pa/src/backcompat.ts'], session: 's-a', note: 'back-compat', now });
      assert.equal(claimed.ok, true);
      const { released } = await release({ id: claimed.reservation!.id, now: now + 1_000 });
      assert.equal(released, 1);

      const entries = await readReleasedSince(now, now + 2_000);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].session, 's-a');
    });

    it('readActive() is unaffected by ledger contents', async () => {
      const { claim, release, readActive } = await import('../src/lib/reservations.js');
      const now = Date.now();

      const claimed = await claim({ paths: ['pa/src/still-active.ts'], session: 's-a', note: 'active', now });
      const other = await claim({ paths: ['pa/src/to-release.ts'], session: 's-b', note: 'to release', now });
      await release({ id: other.reservation!.id, now: now + 1_000 });

      const active = await readActive(now + 2_000);
      assert.equal(active.length, 1);
      assert.equal(active[0].id, claimed.reservation!.id);
    });
  });

  describe('corrupt store recovery', () => {
    it('a corrupt reservations.json is recovered as empty and does not throw', async () => {
      await writeFile(join(dir, 'reservations.json'), '{ this is not json', 'utf8');
      const { readActive, claim } = await import('../src/lib/reservations.js');
      const active = await readActive();
      assert.deepEqual(active, []);

      const result = await claim({ paths: ['pa/src/x.ts'], session: 's-a', note: 'after corruption' });
      assert.equal(result.ok, true);
    });

    it('an empty reservations.json is recovered as empty and does not throw', async () => {
      await writeFile(join(dir, 'reservations.json'), '', 'utf8');
      const { readActive } = await import('../src/lib/reservations.js');
      const active = await readActive();
      assert.deepEqual(active, []);
    });
  });

  describe('reservationGcJob (maintenance job shape)', () => {
    it('declares destructive:true, its two targets (reservation rows + stale ~/.pa/*.tmp), fail-closed matches, and call-time resolve()', async () => {
      const { reservationGcJob } = await import('../src/lib/maintenance/jobs/reservation-gc.js');
      const { paHome } = await import('../src/paths.js');

      assert.equal(reservationGcJob.destructive, true);
      // Target 1: the reservation registry (row-level TTL expiry).
      // Target 2: the stale atomic-write .tmp sweep in ~/.pa/ itself
      // (added 2026-08-09 alongside cleanStaleTmpFiles — update this count
      // if the job legitimately grows more targets).
      assert.equal(reservationGcJob.targets.length, 2);

      const target = reservationGcJob.targets[0];
      assert.equal(target.match.test('reservations.json'), true);
      assert.equal(target.match.test('reservations.json.bak'), false);

      // resolve() must read PA_HOME at call time, not at import time: change
      // PA_HOME after the module has already been imported and confirm the
      // resolved path follows it.
      const before = target.resolve();
      assert.equal(before, join(paHome(), 'reservations.json'));

      const otherHome = await createTempPaHome();
      try {
        const after = target.resolve();
        assert.equal(after, join(otherHome, 'reservations.json'));
        assert.notEqual(after, before);
      } finally {
        await cleanup(otherHome);
        process.env.PA_HOME = dir;
      }

      // Second target: the stale-tmp sweep declares the PA_HOME directory
      // itself, matches ONLY *.tmp filenames, and ages out at 1h (well past
      // any in-flight atomic write's lifetime, so a live write is never swept).
      const tmpTarget = reservationGcJob.targets[1];
      assert.equal(tmpTarget.resolve(), paHome());
      assert.equal(tmpTarget.match.test('maintenance-state.json.abc-123.tmp'), true);
      assert.equal(tmpTarget.match.test('maintenance-state.json'), false);
      assert.equal(tmpTarget.match.test('config.yaml'), false);
      assert.equal(tmpTarget.maxAgeMs, 3_600_000);
    });
  });

  describe('reservation activity logging (D10)', () => {
    it('claim() logs "claim granted" with a refId', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const result = await claim({ paths: ['pa/src/log-a.ts'], session: 's-log', note: 'log test' });
      assert.equal(result.ok, true);
      await flushLog();

      const lines = await readAppLogLines(dir);
      const entry = lines.find((l) => l.message === 'claim granted');
      assert.ok(entry, 'expected a "claim granted" log line');
      assert.equal(entry.level, 'info');
      assert.equal(entry.module, 'reservations');
      assert.match(entry.refId, /^s-[0-9a-f]{12}$/);
      assert.equal(entry.id, result.reservation!.id);
      assert.equal(entry.session, 's-log');
      assert.equal(entry.forced, false);
    });

    it('claim() conflict logs "claim denied"', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      const first = await claim({ paths: ['pa/src/log-b.ts'], session: 's-1', note: 'first' });
      assert.equal(first.ok, true);
      const second = await claim({ paths: ['pa/src/log-b.ts'], session: 's-2', note: 'second' });
      assert.equal(second.ok, false);
      await flushLog();

      const lines = await readAppLogLines(dir);
      const entry = lines.find((l) => l.message === 'claim denied');
      assert.ok(entry, 'expected a "claim denied" log line');
      assert.equal(entry.level, 'warn');
      assert.equal(entry.session, 's-2');
      assert.match(entry.refId, /^s-[0-9a-f]{12}$/);
    });

    it('release() logs "reservation released"', async () => {
      const { claim, release } = await import('../src/lib/reservations.js');
      const result = await claim({ paths: ['pa/src/log-c.ts'], session: 's-a', note: 'to release' });
      assert.equal(result.ok, true);
      const { released } = await release({ id: result.reservation!.id });
      assert.equal(released, 1);
      await flushLog();

      const lines = await readAppLogLines(dir);
      const entry = lines.find((l) => l.message === 'reservation released');
      assert.ok(entry, 'expected a "reservation released" log line');
      assert.equal(entry.level, 'info');
      assert.equal(entry.releasedCount, 1);
      assert.equal(entry.id, result.reservation!.id);
    });

    it('gcExpired() logs only when it removed something', async () => {
      const { claim, gcExpired } = await import('../src/lib/reservations.js');
      const now = Date.now();
      await claim({ paths: ['pa/src/log-d.ts'], session: 's-a', note: 'stale', ttlMinutes: 1, now });
      await flushLog();
      let lines = await readAppLogLines(dir);
      assert.equal(
        lines.some((l) => l.message === 'reservations gc-expired'),
        false,
        'no gc-expired line should be logged before any expiry is actually removed'
      );

      const removed = await gcExpired(now + 2 * 60_000);
      assert.equal(removed, 1);
      await flushLog();
      lines = await readAppLogLines(dir);
      const entry = lines.find((l) => l.message === 'reservations gc-expired');
      assert.ok(entry, 'expected a gc-expired log line once something was actually removed');
      assert.equal(entry.removed, 1);
      assert.match(entry.refId, /^s-[0-9a-f]{12}$/);

      // A no-op GC pass (nothing left to expire) must not add a second line —
      // otherwise a 5-minute job would flood the log even when nothing happens.
      const removedAgain = await gcExpired(now + 3 * 60_000);
      assert.equal(removedAgain, 0);
      await flushLog();
      lines = await readAppLogLines(dir);
      assert.equal(lines.filter((l) => l.message === 'reservations gc-expired').length, 1);
    });

    it('mutate() leaves no .tmp on success', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      await claim({ paths: ['pa/src/log-e.ts'], session: 's-a', note: 'tmp check' });

      const files = await readdir(dir);
      assert.equal(files.some((f) => f.endsWith('.tmp')), false, `expected no .tmp files, got ${JSON.stringify(files)}`);
    });

    it('a truncated reservations.json logs at error with a refId and resets to empty', async () => {
      await writeFile(join(dir, 'reservations.json'), '{"reservations":', 'utf8');
      const { readActive } = await import('../src/lib/reservations.js');
      const active = await readActive();
      assert.deepEqual(active, []);
      await flushLog();

      const lines = await readAppLogLines(dir);
      const entry = lines.find((l) => l.message === 'store unreadable — resetting to empty');
      assert.ok(entry, 'expected an error-level "store unreadable" log line');
      assert.equal(entry.level, 'error');
      assert.equal(entry.module, 'reservations');
      assert.match(entry.refId, /^s-[0-9a-f]{12}$/);
    });
  });

  describe('renew ownership checks (AI-177)', () => {
    it('renew with the OWNING session extends the row', async () => {
      const { claim, renew } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const claimed = await claim({ paths: ['pa/src/owned.ts'], session: 's-owner', note: 'mine', now });
      const original = claimed.reservation!;

      const renewed = await renew(original.id, { session: 's-owner', now: now + 60_000 });
      assert.ok(renewed, 'the owner must be able to renew');
      assert.equal(renewed!.id, original.id);
      assert.equal(new Date(renewed!.expiresAt).getTime(), now + 60_000 + 45 * 60_000);
    });

    it('renew with a FOREIGN session returns null and leaves the row untouched', async () => {
      const { claim, renew, readActive } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const claimed = await claim({
        paths: ['pa/src/owned.ts'],
        session: 's-owner',
        note: 'mine',
        ttlMinutes: 45,
        now,
      });
      const original = claimed.reservation!;

      const renewed = await renew(original.id, { session: 's-intruder', now: now + 60_000 });
      assert.equal(renewed, null, 'a foreign session must not be able to renew');

      const active = await readActive(now + 61_000);
      const row = active.find((r) => r.id === original.id);
      assert.ok(row, 'the row must still exist');
      assert.equal(row!.expiresAt, original.expiresAt, 'the row must be untouched by the denied renew');
    });

    it('renew WITHOUT a session keeps the legacy behavior (no ownership check)', async () => {
      const { claim, renew } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const claimed = await claim({ paths: ['pa/src/legacy.ts'], session: 's-owner', note: 'mine', now });
      const renewed = await renew(claimed.reservation!.id, { now: now + 60_000 });
      assert.ok(renewed, 'a sessionless renew (existing callers) must keep working');
    });

    it('a denied renew logs "renew denied (owner mismatch)" naming owner and requester', async () => {
      const { claim, renew } = await import('../src/lib/reservations.js');
      const now = Date.now();
      const claimed = await claim({ paths: ['pa/src/owned.ts'], session: 's-owner', note: 'mine', now });
      await renew(claimed.reservation!.id, { session: 's-intruder', now: now + 60_000 });
      await flushLog();

      const lines = await readAppLogLines(dir);
      const entry = lines.find((l) => l.message === 'renew denied (owner mismatch)');
      assert.ok(entry, 'expected a "renew denied (owner mismatch)" log line');
      assert.equal(entry.level, 'warn');
      assert.equal(entry.ownerSession, 's-owner');
      assert.equal(entry.requestedBy, 's-intruder');
      assert.match(entry.refId, /^s-[0-9a-f]{12}$/);
    });
  });

  describe('release attribution (AI-177)', () => {
    it('the release log line prints bySession so releases stay greppable', async () => {
      const { claim, release } = await import('../src/lib/reservations.js');
      const claimed = await claim({ paths: ['pa/src/attribution.ts'], session: 's-holder', note: 'held' });
      await release({ id: claimed.reservation!.id, bySession: 's-releaser' });
      await flushLog();

      const lines = await readAppLogLines(dir);
      const entry = lines.find((l) => l.message === 'reservation released');
      assert.ok(entry, 'expected a "reservation released" log line');
      assert.equal(entry.bySession, 's-releaser');
    });
  });

  describe('safeLockOptions compromise policies (AI-177)', () => {
    const captureConsoleError = async (fn: () => Promise<void> | void): Promise<string[]> => {
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => {
        errors.push(a.map(String).join(' '));
      };
      try {
        await fn();
      } finally {
        console.error = orig;
      }
      return errors;
    };

    it('continue (default): logs and keeps going — never throws', async () => {
      const { safeLockOptions } = await import('../src/lib/safe-lock.js');
      const opts = safeLockOptions('t-continue');
      const err = new Error('mtime missed');
      const errors = await captureConsoleError(() => {
        (opts.onCompromised as (e: Error) => void)(err);
      });
      assert.match(errors.join('\n'), /continuing unsynchronized/);
      assert.equal((err as Error & { compromised?: boolean }).compromised, undefined);
    });

    it('fail policy default: tags the error and NEVER throws (onCompromised runs in a timer — AI-096)', async () => {
      const { safeLockOptions } = await import('../src/lib/safe-lock.js');
      const opts = safeLockOptions('t-fail', {}, { compromisedPolicy: 'fail' });
      const err = new Error('mtime missed');
      const errors = await captureConsoleError(() => {
        (opts.onCompromised as (e: Error) => void)(err);
      });
      assert.equal(
        (err as Error & { compromised?: boolean }).compromised,
        true,
        'the error must carry the compromised tag for the caller to route'
      );
      assert.match(errors.join('\n'), /fail-policy/);
    });

    it('fail policy with a caller onCompromised in extra: the caller handler wins (reject routing)', async () => {
      const { safeLockOptions } = await import('../src/lib/safe-lock.js');
      let routed: Error | undefined;
      const opts = safeLockOptions(
        't-fail-routed',
        {
          onCompromised: (e: Error) => {
            routed = e;
          },
        },
        { compromisedPolicy: 'fail' }
      );
      const err = new Error('mtime missed');
      (opts.onCompromised as (e: Error) => void)(err);
      assert.equal(routed, err, 'the reservations-style reject route must receive the error');
    });
  });

  describe('planned reservations + lifecycle (AI-255 WP-C)', () => {
    it('a planned row is stored with kind and excluded from readActive, listed by readPlanned', async () => {
      const { claim, readActive, readPlanned } = await import('../src/lib/reservations.js');
      const res = await claim({
        paths: ['pa/src/thing.ts'],
        session: 'plan-sess',
        note: 'intend to work here',
        kind: 'planned',
        bus: 'devin@personal-assistant#1',
      });
      assert.equal(res.ok, true);
      assert.equal(res.reservation!.kind, 'planned');
      assert.equal(res.reservation!.bus, 'devin@personal-assistant#1');
      assert.equal((await readActive()).length, 0, 'planned rows must not count as active claims');
      const planned = await readPlanned();
      assert.equal(planned.length, 1);
      assert.equal(planned[0].id, res.reservation!.id);
    });

    it('a planned row never blocks a normal claim — it surfaces as a plannedConflict instead', async () => {
      const { claim } = await import('../src/lib/reservations.js');
      await claim({
        paths: ['pa/src/thing.ts'],
        session: 'planner',
        note: 'planned work',
        kind: 'planned',
      });
      const res = await claim({ paths: ['pa/src/thing.ts'], session: 'other-sess', note: 'real claim' });
      assert.equal(res.ok, true, 'planned rows must not block');
      assert.equal(res.plannedConflicts?.length, 1);
      assert.equal(res.plannedConflicts![0].session, 'planner');
    });

    it('a same-session claim fully covering planned paths absorbs the planned row', async () => {
      const { claim, readPlanned } = await import('../src/lib/reservations.js');
      await claim({
        paths: ['pa/src/a.ts', 'pa/src/b.ts'],
        session: 'same-sess',
        note: 'plan',
        kind: 'planned',
      });
      const res = await claim({ paths: ['pa/src/a.ts', 'pa/src/b.ts'], session: 'same-sess', note: 'now doing it' });
      assert.equal(res.ok, true);
      assert.equal((await readPlanned()).length, 0, 'fully covered planned row should be absorbed');
    });

    it('a same-session claim only partially covering planned paths leaves the row', async () => {
      const { claim, readPlanned } = await import('../src/lib/reservations.js');
      await claim({
        paths: ['pa/src/wide/'],
        session: 'same-sess',
        note: 'plan the whole dir',
        kind: 'planned',
      });
      const res = await claim({ paths: ['pa/src/wide/one.ts'], session: 'same-sess', note: 'narrow start' });
      assert.equal(res.ok, true);
      const planned = await readPlanned();
      assert.equal(planned.length, 1, 'narrower claim must not absorb a broader plan');
    });

    it('a different-session claim does NOT absorb the planned row', async () => {
      const { claim, readPlanned } = await import('../src/lib/reservations.js');
      await claim({
        paths: ['pa/src/a.ts'],
        session: 'planner',
        note: 'plan',
        kind: 'planned',
      });
      const res = await claim({ paths: ['pa/src/a.ts'], session: 'other', note: 'mine now' });
      assert.equal(res.ok, true);
      assert.equal((await readPlanned()).length, 1, "a stranger's claim must not absorb the planner's row");
    });

    it('claim fields bus/pid/dispatchId/taskId persist on the stored row', async () => {
      const { claim, readActive } = await import('../src/lib/reservations.js');
      await claim({
        paths: ['pa/src/x.ts'],
        session: 's',
        note: 'n',
        bus: 'devin@personal-assistant#42',
        pid: 4321,
        dispatchId: 'd-abc123',
        taskId: 't-7',
      });
      const [row] = await readActive();
      assert.equal(row.bus, 'devin@personal-assistant#42');
      assert.equal(row.pid, 4321);
      assert.equal(row.dispatchId, 'd-abc123');
      assert.equal(row.taskId, 't-7');
    });

    it('release({dispatchId}) and release({taskId}) match-release their rows', async () => {
      const { claim, release, readActive } = await import('../src/lib/reservations.js');
      await claim({ paths: ['pa/src/d.ts'], session: 'w', note: 'd', dispatchId: 'd-111' });
      await claim({ paths: ['pa/src/t.ts'], session: 'w', note: 't', taskId: 'task-9' });
      await claim({ paths: ['pa/src/k.ts'], session: 'w', note: 'keep' });
      const r1 = await release({ dispatchId: 'd-111' });
      assert.equal(r1.released, 1);
      const r2 = await release({ taskId: 'task-9' });
      assert.equal(r2.released, 1);
      const rest = await readActive();
      assert.equal(rest.length, 1);
      assert.equal(rest[0].paths[0], 'pa/src/k.ts');
    });

    it('sweepDeadOwners drops dead-pid rows (ledger reason dead-owner), keeps live and pid-less rows', async () => {
      const { claim, sweepDeadOwners, readActive, readReleasedSince } = await import('../src/lib/reservations.js');
      // A pid that just exited: spawn a trivial child, wait for it, reuse its pid.
      const { spawnSync } = await import('child_process');
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const deadPid = child.pid!;
      await claim({ paths: ['pa/src/dead.ts'], session: 'gone', note: 'crashed', pid: deadPid });
      await claim({ paths: ['pa/src/live.ts'], session: 'alive', note: 'running', pid: process.pid });
      await claim({ paths: ['pa/src/no-pid.ts'], session: 'old-style', note: 'pre-AI-255 row' });
      const swept = await sweepDeadOwners();
      assert.equal(swept, 1);
      const active = await readActive();
      const paths = active.map((r) => r.paths[0]).sort();
      assert.deepEqual(paths, ['pa/src/live.ts', 'pa/src/no-pid.ts']);
      const ledger = await readReleasedSince(Date.now() - 60_000);
      assert.equal(ledger[0].reason, 'dead-owner', 'swept rows land in the release ledger with an audit reason');
    });

    it('AI-260: a dead pid + FRESH bus cursor vetoes the sweep; a stale cursor does not', async () => {
      const { claim, sweepDeadOwners, readActive } = await import('../src/lib/reservations.js');
      const { touchBusCursor, busCursorPath } = await import('../src/lib/bus-queue.js');
      const { writeJsonAtomic } = await import('../src/lib/atomic-write.js');
      const { spawnSync } = await import('child_process');
      const dead1 = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
      const dead2 = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid!;
      // Same dead-pid posture on both rows — only the cursor freshness differs.
      // The fresh-cursor row models a session that re-registered under the same
      // address after its host respawned: recorded pid dead, session alive.
      await claim({ paths: ['pa/src/respawned.ts'], session: 'respawned', note: 'respawn', pid: dead1, bus: 'claude@personal-assistant#freshcur' });
      await claim({ paths: ['pa/src/reallydead.ts'], session: 'reallydead', note: 'dead', pid: dead2, bus: 'claude@personal-assistant#stalecur' });
      await touchBusCursor('claude@personal-assistant#freshcur', 'ev-fresh');
      await writeJsonAtomic(busCursorPath('claude@personal-assistant#stalecur'),
        { last_event: 'ev-old', last_event_at: new Date(Date.now() - 60 * 60_000).toISOString(), pid: dead2 });
      const swept = await sweepDeadOwners();
      assert.equal(swept, 1, 'only the stale-cursor row sheds');
      const paths = (await readActive()).map((r) => r.paths[0]);
      assert.deepEqual(paths, ['pa/src/respawned.ts'], 'fresh cursor kept the claim alive');
    });

    it('2026-09-17: a LIVE pid with a superseded bus identity still sheds — spawned-context claims', async () => {
      const { claim, sweepDeadOwners, readActive } = await import('../src/lib/reservations.js');
      const { touchBusCursor, registerBusAddress } = await import('../src/lib/bus-queue.js');
      const { spawn } = await import('child_process');
      const livePid = process.pid;
      // A second live host that registers/fires NOTHING — the silent-host
      // posture (agy-style or a wedged session): claims on it stay ambiguous.
      const silentHost = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
      try {
        // The host now lives under a DIFFERENT registered address with a fresh
        // cursor (a restarted generation / a sibling session on the same host).
        await registerBusAddress('claude@personal-assistant#222222', { capabilities: ['hooks'], pid: livePid });
        await touchBusCursor('claude@personal-assistant#222222', 'ev-live');
        // Phantom bus identity: the subagent/worker/dead-generation address —
        // registered nowhere, cursor silent.
        await claim({ paths: ['pa/src/spawned.ts'], session: 'spawned', note: 'subagent done', pid: livePid, bus: 'claude@personal-assistant#333333' });
        // Control: live pid hosting no live identity at all → kept.
        await claim({ paths: ['pa/src/ambiguous.ts'], session: 'ambig', note: 'host silent', pid: silentHost.pid, bus: 'claude@personal-assistant#444444' });
        // The claimant's OWN fresh cursor still vetoes under a live pid.
        await claim({ paths: ['pa/src/stillfiring.ts'], session: 'firing', note: 'claimant live', pid: livePid, bus: 'claude@personal-assistant#555555' });
        await touchBusCursor('claude@personal-assistant#555555', 'ev-claimant');
        const swept = await sweepDeadOwners();
        const paths = (await readActive()).map((r) => r.paths[0]).sort();
        assert.deepEqual(paths, ['pa/src/ambiguous.ts', 'pa/src/stillfiring.ts'],
          'superseded row sheds; ambiguous-host and still-firing claimants keep their claims');
        assert.equal(swept, 1);
      } finally {
        silentHost.kill();
      }
    });
  });
});
