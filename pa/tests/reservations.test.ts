import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';

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
    it('declares destructive:true, exactly one target, a fail-closed match, and a call-time resolve()', async () => {
      const { reservationGcJob } = await import('../src/lib/maintenance/jobs/reservation-gc.js');
      const { paHome } = await import('../src/paths.js');

      assert.equal(reservationGcJob.destructive, true);
      assert.equal(reservationGcJob.targets.length, 1);

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
    });
  });
});
