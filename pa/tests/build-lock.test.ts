import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  withBuildLock,
  buildLockDisabled,
  buildLockLabel,
  BUILD_LOCK_HELD_ENV,
  BUILD_LOCK_DISABLE_ENV,
} from '../src/lib/build-lock.js';
import type { ClaimResult, Reservation } from '../src/lib/reservations.js';

// The suite preload (test-env-setup.ts) already gives this process a real,
// existing PA_HOME before any test runs. Tests must not depend on the
// ambient PA_BUILD_LOCK / PA_BUILD_LOCK_HELD the shell that launched
// `npm test` happened to export — the W-C1 gate itself runs this exact file
// under `PA_BUILD_LOCK=0` to prove the bypass, which would otherwise force
// EVERY test (not just the one that wants it) onto the disabled path. So
// beforeEach unconditionally clears both to a known-clean slate, and only
// the tests that specifically want the disabled/re-entrant path set them.
// PA_HOME is left alone (real, existing, from the suite preload) — the one
// test that needs it missing sets its own value; afterEach restores the
// original snapshot for full hygiene.
const ENV_KEYS = ['PA_HOME', BUILD_LOCK_DISABLE_ENV, BUILD_LOCK_HELD_ENV] as const;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  delete process.env[BUILD_LOCK_DISABLE_ENV];
  delete process.env[BUILD_LOCK_HELD_ENV];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

function fakeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r-fake0001',
    paths: ['@build'],
    session: 'npm-pa-1234',
    note: 'build/test gate',
    claimedAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function conflictResult(holder: Reservation): ClaimResult {
  return { ok: false, conflicts: [holder] };
}

function okResult(reservation: Reservation): ClaimResult {
  return { ok: true, reservation };
}

const noopSleep = async () => {};

describe('build-lock: withBuildLock', () => {
  it('PA_BUILD_LOCK=0 disables the lock — fn runs, claimFn never called', async () => {
    process.env[BUILD_LOCK_DISABLE_ENV] = '0';
    let claimCalls = 0;
    let fnCalls = 0;
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        return 'ok';
      },
      { claimFn: async () => { claimCalls++; return okResult(fakeReservation()); } }
    );
    assert.equal(result, 'ok');
    assert.equal(fnCalls, 1);
    assert.equal(claimCalls, 0);
    assert.equal(buildLockDisabled(), true);
  });

  it('PA_BUILD_LOCK_HELD set ⇒ re-entrant no-op, fn runs, claimFn never called, env unchanged', async () => {
    process.env[BUILD_LOCK_HELD_ENV] = 'r-abc';
    let claimCalls = 0;
    let fnCalls = 0;
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        return 42;
      },
      { claimFn: async () => { claimCalls++; return okResult(fakeReservation()); } }
    );
    assert.equal(result, 42);
    assert.equal(fnCalls, 1);
    assert.equal(claimCalls, 0);
    assert.equal(process.env[BUILD_LOCK_HELD_ENV], 'r-abc');
  });

  it('PA_HOME pointing at a non-existent directory ⇒ no-op, claimFn never called', async () => {
    process.env.PA_HOME = join(tmpdir(), `pa-build-lock-missing-${process.pid}-${Date.now()}`);
    let claimCalls = 0;
    let fnCalls = 0;
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        return 'done';
      },
      { claimFn: async () => { claimCalls++; return okResult(fakeReservation()); } }
    );
    assert.equal(result, 'done');
    assert.equal(fnCalls, 1);
    assert.equal(claimCalls, 0);
  });

  it('happy path: claims with the right args, propagates fn result, releases once', async () => {
    const reservation = fakeReservation({ id: 'r-happy001' });
    let claimArgs: unknown;
    let claimCalls = 0;
    let releaseArgs: unknown;
    let releaseCalls = 0;
    const result = await withBuildLock(
      'npm-pa-999',
      async () => 'fn-return-value',
      {
        claimFn: async (opts) => {
          claimCalls++;
          claimArgs = opts;
          return okResult(reservation);
        },
        releaseFn: async (opts) => {
          releaseCalls++;
          releaseArgs = opts;
          return { released: 1 };
        },
      }
    );
    assert.equal(result, 'fn-return-value');
    assert.equal(claimCalls, 1);
    assert.deepEqual(claimArgs, {
      paths: ['@build'],
      session: 'npm-pa-999',
      note: 'build/test gate',
      ttlMinutes: 30,
    });
    assert.equal(releaseCalls, 1);
    assert.deepEqual(releaseArgs, { id: 'r-happy001' });
  });

  it('sets PA_BUILD_LOCK_HELD to the reservation id during fn, restores previous value after', async () => {
    delete process.env[BUILD_LOCK_HELD_ENV];
    const reservation = fakeReservation({ id: 'r-during001' });
    let seenDuring: string | undefined;
    await withBuildLock(
      'npm-pa-1',
      async () => {
        seenDuring = process.env[BUILD_LOCK_HELD_ENV];
        return null;
      },
      {
        claimFn: async () => okResult(reservation),
        releaseFn: async () => ({ released: 1 }),
      }
    );
    assert.equal(seenDuring, 'r-during001');
    assert.equal(process.env[BUILD_LOCK_HELD_ENV], undefined);
  });

  it('fn throwing propagates the error AND still releases (finally-path)', async () => {
    const reservation = fakeReservation({ id: 'r-throw001' });
    let releaseCalls = 0;
    let releasedId: string | undefined;
    await assert.rejects(
      () =>
        withBuildLock(
          'npm-pa-1',
          async () => {
            throw new Error('boom');
          },
          {
            claimFn: async () => okResult(reservation),
            releaseFn: async (opts) => {
              releaseCalls++;
              releasedId = opts.id;
              return { released: 1 };
            },
          }
        ),
      /boom/
    );
    assert.equal(releaseCalls, 1);
    assert.equal(releasedId, 'r-throw001');
  });

  it('contention then success: retries past two conflicts, one waiting notice, fn runs once', async () => {
    const holder = fakeReservation({ id: 'r-holder001', session: 'npm-pa-777', note: 'other build' });
    const reservation = fakeReservation({ id: 'r-final001' });
    let attempt = 0;
    let fnCalls = 0;
    const notices: string[] = [];
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        return 'ok';
      },
      {
        waitMs: 60_000,
        pollMs: 1,
        now: () => 1000, // constant, well below any deadline computed from it
        sleep: noopSleep,
        notice: (line) => notices.push(line),
        claimFn: async () => {
          attempt++;
          if (attempt <= 2) return conflictResult(holder);
          return okResult(reservation);
        },
        releaseFn: async () => ({ released: 1 }),
      }
    );
    assert.equal(result, 'ok');
    assert.equal(fnCalls, 1);
    assert.equal(attempt, 3);
    const waitingNotices = notices.filter((n) => n.includes('waiting for @build'));
    assert.equal(waitingNotices.length, 1);
    assert.ok(waitingNotices[0].includes('npm-pa-777'));
    assert.ok(waitingNotices[0].includes('other build'));
  });

  it('fail-open: always conflicts past the deadline ⇒ fn still runs once, releaseFn never called', async () => {
    const holder = fakeReservation({ id: 'r-holder002', session: 'npm-pa-555', note: 'stale build' });
    let fnCalls = 0;
    let releaseCalls = 0;
    let clock = 0;
    const notices: string[] = [];
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        return 'ran-anyway';
      },
      {
        waitMs: 100,
        pollMs: 1,
        now: () => clock,
        sleep: async () => {
          clock = 1_000_000; // jump well past the deadline after the first wait
        },
        notice: (line) => notices.push(line),
        claimFn: async () => conflictResult(holder),
        releaseFn: async () => {
          releaseCalls++;
          return { released: 1 };
        },
      }
    );
    assert.equal(result, 'ran-anyway');
    assert.equal(fnCalls, 1);
    assert.equal(releaseCalls, 0);
    assert.ok(notices.some((n) => n.includes('proceeding WITHOUT the lock')));
  });

  it('claimFn throwing ⇒ fn still runs once, no unhandled rejection', async () => {
    let fnCalls = 0;
    const notices: string[] = [];
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        return 'survived';
      },
      {
        notice: (line) => notices.push(line),
        claimFn: async () => {
          throw new Error('store unavailable');
        },
      }
    );
    assert.equal(result, 'survived');
    assert.equal(fnCalls, 1);
    assert.ok(notices.some((n) => n.includes('reservation store unavailable')));
  });

  it('buildLockLabel("pa") matches npm-pa-<pid>', () => {
    assert.match(buildLockLabel('pa'), /^npm-pa-\d+$/);
    assert.match(buildLockLabel('bot'), /^npm-bot-\d+$/);
  });

  it('real end-to-end against the suite temp PA_HOME: a genuine @build reservation is visible during fn and gone after', async () => {
    const { readActive } = await import('../src/lib/reservations.js');
    let sawDuring: Reservation | undefined;
    await withBuildLock('npm-pa-e2e', async () => {
      const active = await readActive();
      sawDuring = active.find((r) => r.paths.includes('@build') && r.session === 'npm-pa-e2e');
    });
    assert.ok(sawDuring, 'expected a real @build reservation to be visible during fn()');
    const after = await readActive();
    assert.equal(
      after.find((r) => r.id === sawDuring!.id),
      undefined,
      'expected the @build reservation to be released after withBuildLock returns'
    );
  });
});
