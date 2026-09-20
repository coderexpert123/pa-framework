import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { createTempPaHome, cleanup } from './helpers.js';

const runShell = promisify(execCb);

// CLI-layer tests for pa/src/commands/claim.ts — the layer pa/tests/reservations.test.ts
// does NOT cover (that file tests lib/reservations.ts's claim()/renew()/release()/
// readActive() directly, never claimCommand/releaseCommand/claimsCommand). Found during
// a 2026-08-06 deep-recheck: a real bug lived specifically in claimCommand's own
// deadline computation, invisible to library-level tests entirely.

describe('claimCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('a non-numeric --wait does not hang forever — falls back to a single immediate attempt', async () => {
    const { claim } = await import('../src/lib/reservations.js');
    const { claimCommand } = await import('../src/commands/claim.js');

    // Pre-claim the same path under a different session so the command's own
    // claim attempt is guaranteed to conflict.
    const pre = await claim({ paths: ['pa/src/foo.ts'], session: 'other-session', note: 'holding it' });
    assert.equal(pre.ok, true);

    const start = Date.now();
    const exitCode = await claimCommand(['pa/src/foo.ts', '--session', 'me', '--note', 'testing', '--wait', 'not-a-number']);
    const elapsedMs = Date.now() - start;

    assert.equal(exitCode, 1, 'a conflicting claim with an invalid --wait must fail, not hang');
    // A real poll loop waits 5s between attempts (POLL_INTERVAL_MS) — completing well
    // under that proves this took exactly one attempt, not an infinite (or even one)
    // poll cycle. Generous margin for CI/slow-disk timing, still far short of 5000ms.
    assert.ok(elapsedMs < 2000, `expected a single immediate attempt (<2000ms), took ${elapsedMs}ms`);
  });

  it('a conflicting claim with no --wait at all also fails immediately (existing behavior, still correct)', async () => {
    const { claim } = await import('../src/lib/reservations.js');
    const { claimCommand } = await import('../src/commands/claim.js');

    const pre = await claim({ paths: ['pa/src/bar.ts'], session: 'other-session', note: 'holding it' });
    assert.equal(pre.ok, true);

    const start = Date.now();
    const exitCode = await claimCommand(['pa/src/bar.ts', '--session', 'me', '--note', 'testing']);
    const elapsedMs = Date.now() - start;

    assert.equal(exitCode, 1);
    assert.ok(elapsedMs < 2000, `expected a single immediate attempt (<2000ms), took ${elapsedMs}ms`);
  });

  it('a valid numeric --wait still polls and eventually succeeds once the conflict clears', async () => {
    const { claim, release } = await import('../src/lib/reservations.js');
    const { claimCommand } = await import('../src/commands/claim.js');

    const pre = await claim({ paths: ['pa/src/baz.ts'], session: 'other-session', note: 'temporary hold' });
    assert.equal(pre.ok, true);

    // Release the conflicting claim shortly after the command starts polling —
    // proves --wait genuinely retries rather than just delaying a single failure.
    setTimeout(() => { void release({ id: pre.reservation!.id }); }, 300);

    const exitCode = await claimCommand(['pa/src/baz.ts', '--session', 'me', '--note', 'testing', '--wait', '5']);
    assert.equal(exitCode, 0, 'must succeed once the conflicting reservation is released within the wait window');
  });
});

describe('claimCommand — flag hardening (D8)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('pa claim --release x exits 2 with a usage line', async () => {
    const { claimCommand } = await import('../src/commands/claim.js');
    const exitCode = await claimCommand(['--release', 'x']);
    assert.equal(exitCode, 2, '--release is not a known claim flag — must be rejected as unrecognized, not silently absorbed as a path');
  });

  it('pa claim --unknown-flag exits 2', async () => {
    const { claimCommand } = await import('../src/commands/claim.js');
    const exitCode = await claimCommand(['--unknown-flag']);
    assert.equal(exitCode, 2);
  });

  it('pa claim --help exits 0', async () => {
    const { claimCommand } = await import('../src/commands/claim.js');
    const exitCode = await claimCommand(['--help']);
    assert.equal(exitCode, 0);
  });

  it('a genuine no-paths call still exits 1 (unchanged existing behavior)', async () => {
    const { claimCommand } = await import('../src/commands/claim.js');
    const exitCode = await claimCommand(['--session', 'me', '--note', 'nothing to claim']);
    assert.equal(exitCode, 1);
  });
});

describe('releaseCommand — ownership hardening (D9)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('pa release <id> --session <wrong> exits 3 and does not remove the reservation', async () => {
    const { claim, readActive } = await import('../src/lib/reservations.js');
    const { releaseCommand } = await import('../src/commands/claim.js');

    const result = await claim({ paths: ['pa/src/owned-a.ts'], session: 'owner-session', note: 'work' });
    assert.equal(result.ok, true);

    const exitCode = await releaseCommand([result.reservation!.id, '--session', 'wrong-session']);
    assert.equal(exitCode, 3);

    const active = await readActive();
    assert.equal(active.length, 1, 'reservation must still be present after a rejected release');
    assert.equal(active[0].id, result.reservation!.id);
  });

  it('pa release <id> --session <wrong> --force exits 0, removes it, and logs a forced-release warn', async () => {
    const { claim, readActive } = await import('../src/lib/reservations.js');
    const { releaseCommand } = await import('../src/commands/claim.js');
    const { flushLog } = await import('../src/lib/log.js');

    const result = await claim({ paths: ['pa/src/owned-b.ts'], session: 'owner-session', note: 'work' });
    assert.equal(result.ok, true);

    const exitCode = await releaseCommand([result.reservation!.id, '--session', 'wrong-session', '--force']);
    assert.equal(exitCode, 0);

    const active = await readActive();
    assert.equal(active.length, 0, 'reservation must be removed on a forced release');

    await flushLog();
    const content = await readFile(join(dir, 'app.log.jsonl'), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
    const forcedEntry = lines.find((l) => l.message === "forced release of another session's reservation");
    assert.ok(forcedEntry, 'expected a forced-release warn logged to app.log.jsonl');
    assert.equal(forcedEntry.level, 'warn');
    assert.equal(forcedEntry.owner, 'owner-session');
    assert.equal(forcedEntry.releasedBy, 'wrong-session');
  });

  it('pa release <id> with no --session still works (backward compatible)', async () => {
    const { claim, readActive } = await import('../src/lib/reservations.js');
    const { releaseCommand } = await import('../src/commands/claim.js');

    const result = await claim({ paths: ['pa/src/owned-c.ts'], session: 'owner-session', note: 'work' });
    assert.equal(result.ok, true);

    // releaseCommand falls back to process.env.PA_SESSION — clear it so the
    // no-identity path is what runs even when the suite inherits an exported
    // PA_SESSION from the caller's shell.
    const savedSession = process.env.PA_SESSION;
    delete process.env.PA_SESSION;
    let exitCode: number;
    try {
      exitCode = await releaseCommand([result.reservation!.id]);
    } finally {
      if (savedSession === undefined) delete process.env.PA_SESSION;
      else process.env.PA_SESSION = savedSession;
    }
    assert.equal(exitCode, 0);

    const active = await readActive();
    assert.equal(active.length, 0);
  });

  it('pa release --unknown-flag exits 2', async () => {
    const { releaseCommand } = await import('../src/commands/claim.js');
    const exitCode = await releaseCommand(['--unknown-flag']);
    assert.equal(exitCode, 2);
  });
});

// AI-255 WP-C CLI surface: --planned/--bus/--task/--pid flags, the
// planned-overlap note, and env auto-fill (PA_TASK_ID/PA_WORKER_DISPATCH_ID).
describe('claimCommand — AI-255 identity + planned flags', () => {
  let dir: string;
  let logLines: string[];
  let origLog: typeof console.log;

  beforeEach(async () => {
    dir = await createTempPaHome();
    logLines = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => { logLines.push(a.join(' ')); };
  });

  afterEach(async () => {
    console.log = origLog;
    delete process.env.PA_TASK_ID;
    delete process.env.PA_WORKER_DISPATCH_ID;
    await cleanup(dir);
  });

  it('pa claim --planned stores kind=planned and prints "Planned"', async () => {
    const { claimCommand } = await import('../src/commands/claim.js');
    const { readPlanned } = await import('../src/lib/reservations.js');

    const exitCode = await claimCommand(['pa/src/plan.ts', '--session', 'planner', '--note', 'future work', '--planned']);
    assert.equal(exitCode, 0);
    assert.ok(logLines.some((l) => l.startsWith('Planned r-')), `expected a "Planned r-…" line, got ${JSON.stringify(logLines)}`);
    const planned = await readPlanned();
    assert.equal(planned.length, 1);
    assert.equal(planned[0].kind, 'planned');
  });

  it('pa claim over another session\'s planned row succeeds and prints the overlap note', async () => {
    const { claim } = await import('../src/lib/reservations.js');
    const { claimCommand } = await import('../src/commands/claim.js');

    await claim({ paths: ['pa/src/shared.ts'], session: 'planner', note: 'scoped', kind: 'planned' });
    const exitCode = await claimCommand(['pa/src/shared.ts', '--session', 'me', '--note', 'real work']);
    assert.equal(exitCode, 0);
    assert.ok(logLines.some((l) => l.includes('overlapping planned work')), `expected the planned-overlap note, got ${JSON.stringify(logLines)}`);
  });

  it('PA_TASK_ID and PA_WORKER_DISPATCH_ID envs auto-fill taskId/dispatchId on the stored row', async () => {
    process.env.PA_TASK_ID = 'task-77';
    process.env.PA_WORKER_DISPATCH_ID = 'd-feed42';
    const { claimCommand } = await import('../src/commands/claim.js');
    const { readActive } = await import('../src/lib/reservations.js');

    const exitCode = await claimCommand(['pa/src/env.ts', '--session', 'worker-sess', '--note', 'dispatched']);
    assert.equal(exitCode, 0);
    const [row] = await readActive();
    assert.equal(row.taskId, 'task-77');
    assert.equal(row.dispatchId, 'd-feed42');
  });

  it('explicit --task/--bus/--pid flags land on the stored row', async () => {
    const { claimCommand } = await import('../src/commands/claim.js');
    const { readActive } = await import('../src/lib/reservations.js');

    const exitCode = await claimCommand([
      'pa/src/flags.ts', '--session', 'me', '--note', 'flags',
      '--task', 't-3', '--bus', 'devin@personal-assistant#7', '--pid', '4321',
    ]);
    assert.equal(exitCode, 0);
    const [row] = await readActive();
    assert.equal(row.taskId, 't-3');
    assert.equal(row.bus, 'devin@personal-assistant#7');
    assert.equal(row.pid, 4321);
  });

  it('AI-260: a headed claim outside a dispatch records NO pid (the ppid is a transient shell, dead within seconds)', async () => {
    // PA_BUS_PROVIDER=cli → the ancestor walk hunts cli@…#* registry children,
    // of which none exist, so ident.pid is deterministically absent and the
    // only remaining source is the process.ppid fallback this fix removes.
    const prior = process.env.PA_BUS_PROVIDER;
    process.env.PA_BUS_PROVIDER = 'cli';
    try {
      const { claimCommand } = await import('../src/commands/claim.js');
      const { readActive } = await import('../src/lib/reservations.js');
      const exitCode = await claimCommand(['pa/src/headed.ts', '--session', 'me', '--note', 'no dispatch']);
      assert.equal(exitCode, 0);
      const [row] = await readActive();
      assert.equal(row.pid, undefined, 'no pid ⇒ dead-owner sweep skips the row; TTL bounds it instead');
    } finally {
      if (prior === undefined) delete process.env.PA_BUS_PROVIDER; else process.env.PA_BUS_PROVIDER = prior;
    }
  });

  it('AI-260: under PA_WORKER_DISPATCH_ID the ppid IS the dispatch host and still records', async () => {
    const priorProvider = process.env.PA_BUS_PROVIDER;
    process.env.PA_BUS_PROVIDER = 'cli';
    process.env.PA_WORKER_DISPATCH_ID = 'd-ai260';
    try {
      const { claimCommand } = await import('../src/commands/claim.js');
      const { readActive } = await import('../src/lib/reservations.js');
      const exitCode = await claimCommand(['pa/src/dispatched.ts', '--session', 'w', '--note', 'in dispatch']);
      assert.equal(exitCode, 0);
      const [row] = await readActive();
      assert.equal(row.pid, process.ppid, 'the worker host pid keeps the dead-owner belt for dispatch claims');
    } finally {
      delete process.env.PA_WORKER_DISPATCH_ID;
      if (priorProvider === undefined) delete process.env.PA_BUS_PROVIDER; else process.env.PA_BUS_PROVIDER = priorProvider;
    }
  });
});

// recentActivity() is claim.ts's own porcelain-parsing call site — the ONE that
// had the C1 bug (trim-before-slice dropped every ' M path' line's first
// character, so fs.stat threw and the caller silently skipped it). These tests
// run against a REAL temp git repo, not a stubbed parser, because that is the
// only way to prove the bug is actually gone rather than just re-testing the
// (already-correct) shared parser in isolation (C18).
describe('recentActivity — real git repo instrument (C18)', () => {
  let dir: string;
  let repo: string;
  let originalCwd: string;

  const git = async (cmd: string): Promise<{ stdout: string; stderr: string }> => {
    const { stdout, stderr } = await runShell(cmd, { cwd: repo });
    return { stdout: String(stdout), stderr: String(stderr) };
  };

  beforeEach(async () => {
    dir = await createTempPaHome();
    repo = await mkdtemp(join(tmpdir(), 'pa-recent-activity-repo-'));
    originalCwd = process.cwd();

    await git('git init -q');
    await git('git config user.email pa-test@example.com');
    await git('git config user.name "pa test"');
    await git('git config commit.gpgsign false');

    await writeFile(join(repo, 'tracked.md'), 'original\n', 'utf8');
    await git('git add -A');
    await git('git commit -q -m base');
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await cleanup(dir);
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  it('sees an unstaged edit in a real temp git repo — the C1 regression test', async () => {
    const { recentActivity } = await import('../src/commands/claim.js');
    await writeFile(join(repo, 'tracked.md'), 'edited, unstaged\n', 'utf8');

    process.chdir(repo);
    const recent = await recentActivity();

    assert.ok(
      recent.includes('tracked.md'),
      `expected 'tracked.md' (full filename, not the C1-truncated 'racked.md') in ${JSON.stringify(recent)}`
    );
  });

  it('ignores a file older than the 15-minute window', async () => {
    const { recentActivity } = await import('../src/commands/claim.js');
    await writeFile(join(repo, 'tracked.md'), 'edited, unstaged\n', 'utf8');
    const old = new Date(Date.now() - 20 * 60_000);
    await utimes(join(repo, 'tracked.md'), old, old);

    process.chdir(repo);
    const recent = await recentActivity();

    assert.ok(!recent.includes('tracked.md'), `expected 'tracked.md' to be excluded as stale, got ${JSON.stringify(recent)}`);
  });
});

// AI-255 WP-E: the unclaimed-write telemetry line (reservation-guard.py,
// worker context) must roll up in `pa claims --stats` — post-hoc visibility
// was the whole point of emitting it.
describe('claimsCommand — --stats counts unclaimed writes', () => {
  let dir: string;
  let logLines: string[];
  let origLog: typeof console.log;

  beforeEach(async () => {
    dir = await createTempPaHome();
    logLines = [];
    origLog = console.log;
    console.log = (...a: unknown[]) => { logLines.push(a.join(' ')); };
  });

  afterEach(async () => {
    console.log = origLog;
    await cleanup(dir);
  });

  it('counts module:reservations "unclaimed write" lines and renders the row', async () => {
    const { claimsCommand } = await import('../src/commands/claim.js');
    const entry = {
      timestamp: new Date().toISOString(),
      level: 'warn',
      module: 'reservations',
      message: 'unclaimed write',
      refId: 's-aaaabbbbcccc',
      path: 'docs/x.md',
      dispatchId: 'd-1',
    };
    await writeFile(join(dir, 'app.log.jsonl'), JSON.stringify(entry) + '\n', 'utf8');

    const exitCode = await claimsCommand(['--stats', '--json']);

    assert.equal(exitCode, 0);
    const stats = JSON.parse(logLines.join('\n'));
    assert.equal(stats.unclaimedWrites, 1);
  });
});
