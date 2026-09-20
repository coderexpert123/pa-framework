import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import {
  withBuildLock,
  buildLockDisabled,
  buildLockLabel,
  parseHolderPid,
  isHolderAlive,
  assertDistFresh,
  ALLOW_STALE_DIST_ENV,
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
    assert.deepEqual(releaseArgs, { id: 'r-happy001', bySession: 'npm-pa-999' });
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
    assert.deepEqual(releaseArgs[1], { id: newReservation.id, bySession: 'npm-pa-1' });
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
    assert.deepEqual(releaseArgs[1], { id: finalReservation.id, bySession: 'npm-pa-1' });
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
    assert.match(buildLockLabel('voice-inbox'), /^npm-voice-inbox-\d+$/);
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

// ---- AI-180: assertDistFresh ----

interface DistSandbox {
  root: string;
  distDir: string;
  srcDir: string;
  testsDir: string;
  stampPath: string;
}

const STALE_DATE = '2020-01-01T00:00:00.000Z';

async function makePaSandbox(tag: string): Promise<DistSandbox> {
  const root = await mkdtemp(join(tmpdir(), `pa-dist-${tag}-`));
  const distDir = join(root, 'pa', 'dist');
  const srcDir = join(root, 'pa', 'src');
  const testsDir = join(distDir, 'tests');
  await mkdir(join(srcDir, 'lib'), { recursive: true });
  await mkdir(testsDir, { recursive: true });
  return { root, distDir, srcDir, testsDir, stampPath: join(distDir, '.build-stamp') };
}

async function writeSandboxStamp(
  sandbox: DistSandbox,
  stamp: { builtAt: string; sha: string }
): Promise<void> {
  await writeFile(
    sandbox.stampPath,
    JSON.stringify({ builtAt: stamp.builtAt, sha: stamp.sha, pkg: 'pa' }) + '\n',
    'utf8'
  );
}

function cleanupSandbox(sandbox: DistSandbox): Promise<void> {
  // Node's fs.rm unlinks junctions/symlinks rather than descending into them,
  // so the junctioned sandbox node_modules is removed without touching the
  // real pa/node_modules it points at.
  return rm(sandbox.root, { recursive: true, force: true });
}

describe('build-lock: assertDistFresh (AI-180)', () => {
  it('resolves on a fresh dist: stamp sha matches HEAD, no src file newer than builtAt', async () => {
    const s = await makePaSandbox('fresh');
    try {
      const srcFile = join(s.srcDir, 'lib', 'fresh.ts');
      await writeFile(srcFile, 'export const fresh = 1;\n');
      const old = new Date(STALE_DATE);
      await utimes(srcFile, old, old); // deterministic: strictly older than builtAt
      await writeSandboxStamp(s, { builtAt: new Date().toISOString(), sha: 'abc1234' });
      let headCalls = 0;
      await assertDistFresh({
        pkg: 'pa',
        repoRoot: s.root,
        revParseFn: async () => {
          headCalls++;
          return 'abc1234';
        },
      });
      assert.equal(headCalls, 1, 'expected exactly one HEAD lookup');
    } finally {
      await cleanupSandbox(s);
    }
  });

  it('refuses when the stamp is missing (never built here)', async () => {
    const s = await makePaSandbox('nostamp');
    try {
      await assert.rejects(
        () =>
          assertDistFresh({ pkg: 'pa', repoRoot: s.root, revParseFn: async () => 'abc1234' }),
        /no readable \.build-stamp/
      );
    } finally {
      await cleanupSandbox(s);
    }
  });

  it('refuses when HEAD cannot be determined — fail-closed, not skip', async () => {
    const s = await makePaSandbox('nohead');
    try {
      await writeSandboxStamp(s, { builtAt: new Date().toISOString(), sha: 'abc1234' });
      await assert.rejects(
        () => assertDistFresh({ pkg: 'pa', repoRoot: s.root, revParseFn: async () => null }),
        /cannot verify HEAD/
      );
    } finally {
      await cleanupSandbox(s);
    }
  });

  it('refuses when the stamp sha differs from HEAD and the message names both shas', async () => {
    const s = await makePaSandbox('shadrift');
    try {
      await writeSandboxStamp(s, { builtAt: STALE_DATE, sha: 'abc1234' });
      await assert.rejects(
        () => assertDistFresh({ pkg: 'pa', repoRoot: s.root, revParseFn: async () => 'dead4321' }),
        (err: Error) => {
          assert.match(err.message, /built from abc1234/);
          assert.match(err.message, /HEAD is dead4321/);
          assert.match(err.message, /DIST STALE \(pa\)/);
          return true;
        }
      );
    } finally {
      await cleanupSandbox(s);
    }
  });

  it('stale-dist negative test: touching a src file after the build makes the guard fire, naming the file', async () => {
    const s = await makePaSandbox('touch');
    try {
      await writeSandboxStamp(s, { builtAt: STALE_DATE, sha: 'abc1234' });
      // Created NOW — its mtime is strictly newer than the 2020 stamp.
      await writeFile(join(s.srcDir, 'lib', 'just-edited.ts'), '// edited after the build\n');
      await assert.rejects(
        () => assertDistFresh({ pkg: 'pa', repoRoot: s.root, revParseFn: async () => 'abc1234' }),
        (err: Error) => {
          assert.match(err.message, /src changed after the/);
          assert.match(err.message, /just-edited\.ts/);
          return true;
        }
      );
    } finally {
      await cleanupSandbox(s);
    }
  });

  it('checks every compiled root: a newer file under pa/tests (not just pa/src) fires the guard', async () => {
    const s = await makePaSandbox('roots');
    try {
      await writeSandboxStamp(s, { builtAt: STALE_DATE, sha: 'abc1234' });
      const testsRoot = join(s.root, 'pa', 'tests');
      await mkdir(testsRoot, { recursive: true });
      await writeFile(join(testsRoot, 'newly-edited.test.ts'), '// edited after the build\n');
      await assert.rejects(
        () => assertDistFresh({ pkg: 'pa', repoRoot: s.root, revParseFn: async () => 'abc1234' }),
        /newly-edited\.test\.ts/
      );
    } finally {
      await cleanupSandbox(s);
    }
  });

  it('bot layout: verifies projects/telegram-bot/{dist,src}', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-dist-bot-'));
    const distDir = join(root, 'projects', 'telegram-bot', 'dist');
    const srcDir = join(root, 'projects', 'telegram-bot', 'src');
    await mkdir(distDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    try {
      await writeFile(join(srcDir, 'main.ts'), '// fresh\n');
      const old = new Date(STALE_DATE);
      await utimes(join(srcDir, 'main.ts'), old, old);
      await writeFile(
        join(distDir, '.build-stamp'),
        JSON.stringify({ builtAt: new Date().toISOString(), sha: 'b0b1234', pkg: 'bot' }) + '\n',
        'utf8'
      );
      // Fresh: resolves.
      await assertDistFresh({ pkg: 'bot', repoRoot: root, revParseFn: async () => 'b0b1234' });

      // Then a src edit newer than the build refuses, same policy as pa. The
      // mtime is set EXPLICITLY past the stamp: same-tick writes quantize to
      // the same file-system timestamp, and the guard compares strictly >.
      const builtAt = new Date();
      await writeFile(
        join(distDir, '.build-stamp'),
        JSON.stringify({ builtAt: builtAt.toISOString(), sha: 'b0b1234', pkg: 'bot' }) + '\n',
        'utf8'
      );
      const afterBuild = new Date(builtAt.getTime() + 60_000);
      await utimes(join(srcDir, 'main.ts'), afterBuild, afterBuild);
      await assert.rejects(
        () => assertDistFresh({ pkg: 'bot', repoRoot: root, revParseFn: async () => 'b0b1234' }),
        /DIST STALE \(bot\)/
      );
    } finally {
      await cleanupSandbox({ root, distDir, srcDir, testsDir: distDir, stampPath: '' });
    }
  });

  it("voice-inbox layout: verifies projects/voice-inbox/{dist,src}, not PA's dist paths", async () => {
    const root = await mkdtemp(join(tmpdir(), 'pa-dist-vi-'));
    const distDir = join(root, 'projects', 'voice-inbox', 'dist');
    const srcDir = join(root, 'projects', 'voice-inbox', 'src');
    await mkdir(distDir, { recursive: true });
    await mkdir(srcDir, { recursive: true });
    try {
      await writeFile(join(srcDir, 'server.ts'), '// fresh\n');
      const old = new Date(STALE_DATE);
      await utimes(join(srcDir, 'server.ts'), old, old); // deterministic: strictly older than builtAt
      await writeFile(
        join(distDir, '.build-stamp'),
        JSON.stringify({ builtAt: new Date().toISOString(), sha: 'v1c1234', pkg: 'voice-inbox' }) + '\n',
        'utf8'
      );
      // Fresh: resolves. This is the misroute regression proof: before the
      // 'voice-inbox' arm existed, distLayout fell through to PA's layout and
      // this exact call refused with stamp-missing (the sandbox has no
      // pa/dist at all), so the package runner had to omit the guard.
      await assertDistFresh({ pkg: 'voice-inbox', repoRoot: root, revParseFn: async () => 'v1c1234' });

      // Then a src edit newer than the build refuses against THIS package's
      // src root, same policy as pa/bot. The mtime is set EXPLICITLY past the
      // stamp: same-tick writes quantize to the same file-system timestamp,
      // and the guard compares strictly >.
      const builtAt = new Date();
      await writeFile(
        join(distDir, '.build-stamp'),
        JSON.stringify({ builtAt: builtAt.toISOString(), sha: 'v1c1234', pkg: 'voice-inbox' }) + '\n',
        'utf8'
      );
      const afterBuild = new Date(builtAt.getTime() + 60_000);
      await utimes(join(srcDir, 'server.ts'), afterBuild, afterBuild);
      await assert.rejects(
        () => assertDistFresh({ pkg: 'voice-inbox', repoRoot: root, revParseFn: async () => 'v1c1234' }),
        /DIST STALE \(voice-inbox\)/
      );
    } finally {
      await cleanupSandbox({ root, distDir, srcDir, testsDir: distDir, stampPath: '' });
    }
  });

  it(`PA_ALLOW_STALE_DIST=1 warns and continues instead of refusing`, async () => {
    const s = await makePaSandbox('allow');
    const origError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    };
    try {
      await writeSandboxStamp(s, { builtAt: STALE_DATE, sha: 'abc1234' });
      await writeFile(join(s.srcDir, 'lib', 'stale-but-allowed.ts'), '// newer\n');
      process.env[ALLOW_STALE_DIST_ENV] = '1';
      await assertDistFresh({ pkg: 'pa', repoRoot: s.root, revParseFn: async () => 'abc1234' });
      const joined = errors.join('\n');
      assert.match(joined, /WARNING: DIST STALE \(pa\)/);
      assert.match(joined, /stale-but-allowed\.ts/);
    } finally {
      delete process.env[ALLOW_STALE_DIST_ENV];
      console.error = origError;
      await cleanupSandbox(s);
    }
  });
});

describe('build-lock: run-tests.mjs guard wiring (AI-180 — real runner over a sandbox tree)', () => {
  // The compiled form of THIS test lives at <repo>/pa/dist/tests/ — three
  // levels up is the repo root the LIVE runner script belongs to.
  const LIVE_REPO_ROOT = join(__dirname, '..', '..', '..');

  /** A full runnable checkout skeleton: the real runner script, the real
   * compiled guard module (junctioned node_modules so its deps resolve), a
   * git repo whose HEAD the stamp matches, and one tiny runnable smoke test.
   * The src tree carries a file newer than the stamp — deliberately stale. */
  async function makeRunnerSandbox(): Promise<DistSandbox> {
    const s = await makePaSandbox('runner');
    // Pin CommonJS exactly like the real pa package (no "type" field → CJS
    // default; the tmp parent has no package.json of its own).
    await writeFile(
      join(s.root, 'pa', 'package.json'),
      JSON.stringify({ name: 'pa-sandbox', version: '0.0.0', private: true }),
      'utf8'
    );
    // build-lock → reservations → fs-extra/proper-lockfile: the compiled guard
    // module needs the real dependency tree to be requirable in the sandbox.
    await symlink(join(LIVE_REPO_ROOT, 'pa', 'node_modules'), join(s.root, 'pa', 'node_modules'), 'junction');
    await cp(join(LIVE_REPO_ROOT, 'pa', 'dist', 'src'), join(s.distDir, 'src'), { recursive: true });
    await mkdir(join(s.root, 'pa', 'scripts'), { recursive: true });
    await cp(
      join(LIVE_REPO_ROOT, 'pa', 'scripts', 'run-tests.mjs'),
      join(s.root, 'pa', 'scripts', 'run-tests.mjs')
    );
    // AI-255 split the guard check into pa/scripts/dist-guard.mjs — the runner
    // imports it, so the sandbox needs the real module beside the script.
    await cp(
      join(LIVE_REPO_ROOT, 'pa', 'scripts', 'dist-guard.mjs'),
      join(s.root, 'pa', 'scripts', 'dist-guard.mjs')
    );
    // A no-op preload (the real test-env-setup redirects PA_HOME etc.; the
    // sandbox smoke test needs none of that) + one real runnable smoke test.
    await writeFile(join(s.testsDir, 'test-env-setup.js'), '// AI-180 sandbox fixture: deliberate no-op preload.\n', 'utf8');
    await writeFile(
      join(s.testsDir, 'dist-guard-smoke.test.js'),
      "const { test } = require('node:test');\ntest('dist guard smoke', () => {});\n",
      'utf8'
    );
    // A real git repo so the guard's genuine `git rev-parse --short HEAD`
    // default succeeds, and a stamp claiming the dist was built from it —
    // in 2020, so the freshly-created src file is newer than the build.
    execSync('git init', { cwd: s.root, stdio: 'ignore' });
    execSync('git -c user.email=guard@test -c user.name=guard commit --allow-empty -m init', {
      cwd: s.root,
      stdio: 'ignore',
    });
    const headSha = execSync('git rev-parse --short HEAD', { cwd: s.root, encoding: 'utf8' }).trim();
    await writeSandboxStamp(s, { builtAt: STALE_DATE, sha: headSha });
    await writeFile(join(s.srcDir, 'lib', 'ai180-stale-marker.ts'), '// created AFTER the 2020 stamp\n');
    return s;
  }

  function runRunner(s: DistSandbox, args: string[], extraEnv: Record<string, string>) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const env: Record<string, string | undefined> = { ...process.env, PA_BUILD_LOCK: '0', ...extraEnv };
      // Hermetic spawn: node's test runner marks test files with
      // NODE_TEST_CONTEXT; if a spawned production runner inherits it, the
      // runner's INNER node --test detects "recursive run()" and silently
      // SKIPS every file while still exiting 0. Strip the test-runner
      // plumbing a real shell would never carry.
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_OPTIONS;
      const child = spawn(process.execPath, [join(s.root, 'pa', 'scripts', 'run-tests.mjs'), ...args], {
        cwd: s.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    });
  }

  it('refuses a stale dist and never runs a test — EVEN under PA_BUILD_LOCK=0 (the guard is not lock-exempt)', async () => {
    const s = await makeRunnerSandbox();
    try {
      // PA_NO_AUTOBUILD=1: this test asserts the REFUSE path; AI-255's default
      // is a managed inline rebuild, which a minimal sandbox cannot satisfy
      // (no real build.mjs/src tree) — pin refuse-fast explicitly.
      const out = await runRunner(s, [], { PA_NO_AUTOBUILD: '1' });
      assert.equal(
        out.code,
        1,
        `expected refusal exit 1\ncode=${out.code}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`
      );
      assert.match(out.stderr, /Refusing to run tests against this dist \(AI-180\)/);
      assert.match(out.stderr, /src changed after the/);
      assert.match(out.stderr, /ai180-stale-marker\.ts/);
      assert.doesNotMatch(out.stdout, /dist guard smoke/, 'no test may execute once the guard refuses');
    } finally {
      await cleanupSandbox(s);
    }
  });

  it('PA_ALLOW_STALE_DIST=1 lets the SAME stale-dist run warn and proceed to actually run the tests', async () => {
    const s = await makeRunnerSandbox();
    try {
      const out = await runRunner(s, ['dist-guard-smoke'], { PA_ALLOW_STALE_DIST: '1' });
      assert.equal(
        out.code,
        0,
        `expected the allowed run to pass\ncode=${out.code}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`
      );
      assert.match(out.stderr, /WARNING: DIST STALE \(pa\)/);
      assert.match(out.stdout, /dist guard smoke/, 'the smoke test must really have run');
    } finally {
      await cleanupSandbox(s);
    }
  });
});
