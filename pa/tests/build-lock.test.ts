import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  withBuildLock,
  buildLockDisabled,
  buildLockLabel,
  parseHolderPid,
  isHolderAlive,
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

  it('AI-174: dead-holder takeover — releases the dead reservation, re-claims, HOLDS the lock during fn(), and releases after', async () => {
    // Corrected 2026-09-01: proceeding UNLOCKED for a confirmed-dead holder (the
    // original design) would leave the dead row standing, so a second waiter behind
    // the same dead holder would ALSO fail open and run CONCURRENTLY with the first
    // — the exact hazard AI-174 exists to prevent. Takeover means we hold a live row
    // and everyone else serializes behind it properly. This supersedes the earlier
    // "fail-open ... confirmed DEAD ⇒ releaseFn never called" test, whose premise is
    // no longer true under the corrected design.
    const deadHolder = fakeReservation({ id: 'r-holder010', session: 'npm-pa-9999', note: 'killed build' });
    const newReservation = fakeReservation({ id: 'r-takeover010', session: 'npm-pa-1' });
    let fnCalls = 0;
    let seenDuring: string | undefined;
    let claimCalls = 0;
    let releaseCalls = 0;
    const releaseArgs: unknown[] = [];
    let livenessArgs: [number, number] | undefined;
    let livenessCalls = 0;
    let clock = 0;
    const notices: string[] = [];
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        seenDuring = process.env[BUILD_LOCK_HELD_ENV];
        return 'ran-with-lock';
      },
      {
        waitMs: 100,
        pollMs: 1,
        now: () => clock,
        sleep: async () => {
          clock = 1_000_000;
        },
        notice: (line) => notices.push(line),
        claimFn: async () => {
          claimCalls++;
          if (claimCalls === 1) return conflictResult(deadHolder);
          return okResult(newReservation); // the takeover retry succeeds
        },
        releaseFn: async (opts) => {
          releaseCalls++;
          releaseArgs.push(opts);
          return { released: 1 };
        },
        checkHolderAliveFn: async (pid, claimedAtMs) => {
          livenessCalls++;
          livenessArgs = [pid, claimedAtMs];
          return false;
        },
      }
    );
    assert.equal(result, 'ran-with-lock');
    assert.equal(fnCalls, 1);
    assert.equal(livenessCalls, 1);
    assert.deepEqual(livenessArgs, [9999, new Date(deadHolder.claimedAt).getTime()]);
    assert.equal(seenDuring, newReservation.id, 'expected the lock to be genuinely held during fn()');
    assert.equal(claimCalls, 2, 'expected the initial conflicting attempt plus the takeover retry');
    assert.equal(releaseCalls, 2, 'expected the forced takeover release plus the normal end-of-fn release');
    assert.deepEqual(releaseArgs[0], {
      id: deadHolder.id,
      force: true,
      ownerSession: deadHolder.session,
      bySession: 'npm-pa-1',
    });
    assert.deepEqual(releaseArgs[1], { id: newReservation.id });
    assert.ok(notices.some((n) => n.includes('is dead') && n.includes('taking over')));
  });

  it('AI-174: takeover races another waiter behind the same dead holder — never force-releases the new legitimate holder, waits it out then succeeds', async () => {
    const deadHolder = fakeReservation({ id: 'r-dead020', session: 'npm-pa-9999', note: 'killed build' });
    const raceWinner = fakeReservation({ id: 'r-race020', session: 'npm-pa-4242', note: 'took over first' });
    const finalReservation = fakeReservation({ id: 'r-final020', session: 'npm-pa-1' });
    let claimCalls = 0;
    let releaseCalls = 0;
    const releaseArgs: unknown[] = [];
    let livenessCalls = 0;
    let fnCalls = 0;
    let seenDuring: string | undefined;
    let clock = 0;
    const notices: string[] = [];
    const result = await withBuildLock(
      'npm-pa-1',
      async () => {
        fnCalls++;
        seenDuring = process.env[BUILD_LOCK_HELD_ENV];
        return 'ok-after-race';
      },
      {
        waitMs: 100,
        pollMs: 1,
        now: () => clock,
        sleep: async () => {
          clock += 200;
        },
        notice: (line) => notices.push(line),
        claimFn: async () => {
          claimCalls++;
          if (claimCalls === 1) return conflictResult(deadHolder);
          // Our takeover retry races against another waiter who claimed first.
          if (claimCalls === 2) return conflictResult(raceWinner);
          return okResult(finalReservation); // raceWinner eventually released it
        },
        releaseFn: async (opts) => {
          releaseCalls++;
          releaseArgs.push(opts);
          return { released: 1 };
        },
        checkHolderAliveFn: async () => {
          livenessCalls++;
          return false; // only ever asked about the ORIGINAL dead holder
        },
      }
    );
    assert.equal(result, 'ok-after-race');
    assert.equal(fnCalls, 1);
    assert.equal(seenDuring, finalReservation.id);
    assert.equal(claimCalls, 3);
    assert.equal(livenessCalls, 1, 'expected the race winner to never be re-checked for liveness');
    assert.equal(releaseCalls, 2, 'expected exactly one forced takeover release plus one normal end-of-fn release');
    assert.deepEqual(releaseArgs[0], {
      id: deadHolder.id,
      force: true,
      ownerSession: deadHolder.session,
      bySession: 'npm-pa-1',
    });
    assert.deepEqual(releaseArgs[1], { id: finalReservation.id });
    assert.ok(notices.some((n) => n.includes('is dead') && n.includes('taking over')));
  });

  it('AI-174: no-PID label ⇒ legacy fail-open, liveness check never called', async () => {
    const holder = fakeReservation({ id: 'r-holder011', session: 'legacy-worker', note: 'old-style label' });
    let fnCalls = 0;
    let livenessCalls = 0;
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
          clock = 1_000_000;
        },
        notice: (line) => notices.push(line),
        claimFn: async () => conflictResult(holder),
        checkHolderAliveFn: async () => {
          livenessCalls++;
          return true; // must never be reached — pid is unparseable
        },
      }
    );
    assert.equal(result, 'ran-anyway');
    assert.equal(fnCalls, 1);
    assert.equal(livenessCalls, 0);
    assert.ok(notices.some((n) => n.includes('legacy behavior')));
    assert.ok(notices.some((n) => n.includes('proceeding WITHOUT the lock')));
  });

  it('AI-174: alive holder extends the wait past the original deadline, then fails CLOSED at the hard cap', async () => {
    const holder = fakeReservation({ id: 'r-holder012', session: 'npm-pa-8888', note: 'long build' });
    let fnCalls = 0;
    let claimCalls = 0;
    let livenessCalls = 0;
    let clock = 0;
    const notices: string[] = [];
    await assert.rejects(
      () =>
        withBuildLock(
          'npm-pa-1',
          async () => {
            fnCalls++;
            return 'should-not-run';
          },
          {
            waitMs: 100,
            hardCapMs: 500,
            pollMs: 1,
            now: () => clock,
            sleep: async () => {
              clock += 200;
            },
            notice: (line) => notices.push(line),
            claimFn: async () => {
              claimCalls++;
              return conflictResult(holder);
            },
            checkHolderAliveFn: async () => {
              livenessCalls++;
              return true;
            },
          }
        ),
      /@build still held by "npm-pa-8888"/
    );
    assert.equal(fnCalls, 0);
    // Liveness runs exactly once (at the original waitMs deadline), never again while
    // extending the wait toward the hard cap.
    assert.equal(livenessCalls, 1);
    assert.ok(claimCalls >= 3, `expected at least 3 claim attempts, got ${claimCalls}`);
    assert.ok(notices.some((n) => n.includes('still alive — continuing to wait')));
  });

  it('parseHolderPid: extracts the trailing PID from npm-<pkg>-<pid> and code-fixer-<pid> labels', () => {
    assert.equal(parseHolderPid('npm-pa-1234'), 1234);
    assert.equal(parseHolderPid('npm-bot-5678'), 5678);
    assert.equal(parseHolderPid('code-fixer-9999'), 9999);
  });

  it('parseHolderPid: returns null for a label with no trailing numeric segment', () => {
    assert.equal(parseHolderPid('legacy-worker'), null);
    assert.equal(parseHolderPid(undefined), null);
    assert.equal(parseHolderPid(null), null);
    assert.equal(parseHolderPid(''), null);
  });

  it('isHolderAlive: PID not found (null start time) ⇒ dead', async () => {
    const alive = await isHolderAlive(9999, 5000, async () => null);
    assert.equal(alive, false);
  });

  it('isHolderAlive: PID started before the claim ⇒ alive', async () => {
    const alive = await isHolderAlive(9999, 5000, async () => 1000);
    assert.equal(alive, true);
  });

  it('isHolderAlive: PID-reused-younger-than-claim (started AFTER claimedAt) ⇒ treated as dead', async () => {
    // PID-reuse guard: a process bearing this PID exists, but it started AFTER the
    // reservation was claimed, so it cannot be the process that claimed it — some
    // other process has since taken over the recycled PID number.
    const alive = await isHolderAlive(9999, 1000, async () => 5000);
    assert.equal(alive, false);
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
