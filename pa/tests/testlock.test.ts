import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

// The compiled form of THIS test lives at <repo>/pa/dist/tests/ — three levels
// up is the repo root, and the real script under test is pa/scripts/testlock.mjs
// (.mjs — never compiled; the tests drive the REAL CLI file).
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'pa', 'scripts', 'testlock.mjs');

interface HolderShape {
  session: string;
  pid: number;
  at: string;
  beat?: string;
  sessionPid?: number;
}

interface LockState {
  kind: 'free' | 'no-holder' | 'holder' | 'holder-unreadable';
  holder?: HolderShape;
}

interface AcquireResult {
  ok: boolean;
  reason?: string;
  state?: LockState;
  holder?: HolderShape;
}

interface ReleaseResult {
  ok: boolean;
  reason?: string;
  action?: string;
  holder?: HolderShape;
}

interface TestLockModule {
  readHolder(dir?: string): LockState;
  acquireLock(
    session: string,
    opts?: {
      dir?: string; pollMs?: number; waitMs?: number; graceMs?: number; removeStale?: boolean;
      ownerPid?: number; nudge?: false | ((address: string, body: string) => unknown | Promise<unknown>);
      notice?: (line: string) => void;
    }
  ): Promise<AcquireResult>;
  releaseLock(
    opts?: { dir?: string; graceMs?: number; force?: boolean; session?: string; notice?: (line: string) => void }
  ): Promise<ReleaseResult>;
  statusLock(dir?: string): { text: string; state: LockState };
}

// Non-literal import specifier: TS skips module resolution for the untyped
// .mjs and the file loads as real ESM from the compiled CJS test.
async function loadModule(): Promise<TestLockModule> {
  const mod: unknown = await import(pathToFileURL(SCRIPT).href);
  return mod as TestLockModule;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Hermetic spawn of the real CLI: env-injected lock dir + timing knobs, with
// the test-runner plumbing stripped (inherited NODE_TEST_CONTEXT can silently
// skip files in spawned runners; NODE_OPTIONS can reroute the child).
function runCli(args: string[], lockDirPath: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PA_TESTLOCK_DIR: lockDirPath,
      ...extraEnv,
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [SCRIPT, ...args], {
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

const holderPath = (dir: string) => join(dir, 'HOLDER');

async function seedHolder(dir: string, holder: HolderShape): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(holderPath(dir), JSON.stringify(holder) + '\n', 'utf8');
}

// A guaranteed-dead pid: spawn a process that exits immediately, then reuse
// its (now-reaped) pid. pidAlive() must classify it ESRCH ⇒ dead.
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid ?? -1;
}

// Suite-lock tests never touch the machine-global default directory: every
// spawn injects PA_TESTLOCK_DIR and every direct function call passes an
// explicit dir. Ambient PA_TESTLOCK_* from the invoking shell is cleared so
// nothing leaks into the direct-call defaults either.
const AMBIENT_KEYS = [
  'PA_TESTLOCK_DIR', 'PA_TESTLOCK_POLL_MS', 'PA_TESTLOCK_WAIT_MS', 'PA_TESTLOCK_GRACE_MS',
  'PA_TESTLOCK_STALE_MS', 'PA_TESTLOCK_NO_NUDGE', 'PA_CLI',
];
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const k of AMBIENT_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of AMBIENT_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
});

describe('testlock.mjs — CLI (real spawned processes, env-injected lock dir)', () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pa-testlock-cli-'));
    lockPath = join(root, 'test.lock');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('acquire on a free directory claims it and writes HOLDER {session, pid, at}', async () => {
    const r = await runCli(['acquire', 'sess-a'], lockPath);
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.ok(existsSync(lockPath), 'lock directory must exist');
    const raw = await readFile(holderPath(lockPath), 'utf8');
    const holder = JSON.parse(raw) as HolderShape;
    assert.equal(holder.session, 'sess-a');
    assert.equal(typeof holder.pid, 'number');
    assert.ok(!Number.isNaN(Date.parse(holder.at)), 'at must be a parseable timestamp');
  });

  it('acquire creates the lock PARENT when missing too (the wiped C:/wt shape)', async () => {
    const nested = join(root, 'missing-parent', 'test.lock');
    const r = await runCli(['acquire', 'sess-parent'], nested);
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const raw = await readFile(holderPath(nested), 'utf8');
    assert.equal((JSON.parse(raw) as HolderShape).session, 'sess-parent');
  });

  it('acquire against a held lock prints the holder, waits, exits 1 — and never takes over', async () => {
    await seedHolder(lockPath, { session: 'other-sess', pid: 999999, at: new Date().toISOString() });
    const r = await runCli(['acquire', 'waiter'], lockPath, { PA_TESTLOCK_POLL_MS: '10', PA_TESTLOCK_WAIT_MS: '120' });
    assert.equal(r.code, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /other-sess/, 'the holder must be named in the waiter output');
    const raw = await readFile(holderPath(lockPath), 'utf8');
    assert.equal((JSON.parse(raw) as HolderShape).session, 'other-sess', 'HOLDER must be untouched');
  });

  it('acquire succeeds when the lock frees mid-wait', async () => {
    await seedHolder(lockPath, { session: 'doomed-sess', pid: 999999, at: new Date().toISOString() });
    const waiter = runCli(['acquire', 'waiter-mid'], lockPath, { PA_TESTLOCK_POLL_MS: '10', PA_TESTLOCK_WAIT_MS: '8000' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await rm(lockPath, { recursive: true, force: true });
    const r = await waiter;
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const raw = await readFile(holderPath(lockPath), 'utf8');
    assert.equal((JSON.parse(raw) as HolderShape).session, 'waiter-mid');
  });

  it('release refuses a foreign holder (naming it), releases the right label, is idempotent when free', async () => {
    const first = await runCli(['acquire', 'sess-a'], lockPath);
    assert.equal(first.code, 0, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`);

    const wrong = await runCli(['release', 'wrong-label'], lockPath);
    assert.equal(wrong.code, 1, 'a release naming a different session must refuse');
    assert.match(wrong.stderr, /sess-a/, 'the refusal must name the actual holder (zero archaeology)');
    assert.match(wrong.stderr, /--force/);
    assert.ok(existsSync(lockPath), 'a refused release must leave the lock standing');

    const right = await runCli(['release', 'sess-a'], lockPath);
    assert.equal(right.code, 0, `stdout:\n${right.stdout}\nstderr:\n${right.stderr}`);
    assert.ok(!existsSync(lockPath), 'lock directory must be gone after the holder releases');

    const again = await runCli(['release'], lockPath);
    assert.equal(again.code, 0, 'release on a free lock is a no-op, not an error');
    assert.match(again.stdout, /nothing to release/);
  });

  it('release --force clears a foreign lock and prints the sanction note', async () => {
    await seedHolder(lockPath, { session: 'foreign-sess', pid: 999999, at: new Date().toISOString() });
    const r = await runCli(['release', '--force'], lockPath);
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /FORCE/);
    assert.match(r.stdout, /sanction/);
    assert.ok(!existsSync(lockPath));
  });

  it('bare release clears a pre-convention no-HOLDER lock; bare acquire never does', async () => {
    await mkdir(lockPath, { recursive: true }); // bare: directory only, no HOLDER

    const waiter = await runCli(['acquire', 'waiter'], lockPath, {
      PA_TESTLOCK_POLL_MS: '10',
      PA_TESTLOCK_WAIT_MS: '120',
    });
    assert.equal(waiter.code, 1);
    assert.match(waiter.stdout, /pre-convention/, 'the waiter must report the no-HOLDER shape');
    assert.ok(existsSync(lockPath), 'a bare acquire must never remove the lock it waited on');
    assert.ok(!existsSync(holderPath(lockPath)), 'and must not write a HOLDER into it either');

    const release = await runCli(['release'], lockPath);
    assert.equal(release.code, 0, `stdout:\n${release.stdout}\nstderr:\n${release.stderr}`);
    assert.ok(!existsSync(lockPath), 'bare release clears the pre-convention lock');
  });

  it('acquire --remove-stale clears a bare lock and claims it in one invocation, printing evidence', async () => {
    await mkdir(lockPath, { recursive: true });
    const r = await runCli(['acquire', 'sess-r', '--remove-stale'], lockPath);
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /removed stale no-HOLDER lock/, 'the evidence line must be printed');
    const raw = await readFile(holderPath(lockPath), 'utf8');
    assert.equal((JSON.parse(raw) as HolderShape).session, 'sess-r');
  });

  it('acquire --remove-stale refuses a lock that HAS a holder — it times out, holder intact', async () => {
    await seedHolder(lockPath, { session: 'live-sess', pid: 999999, at: new Date().toISOString() });
    const r = await runCli(['acquire', 'waiter', '--remove-stale'], lockPath, {
      PA_TESTLOCK_POLL_MS: '10',
      PA_TESTLOCK_WAIT_MS: '120',
      PA_TESTLOCK_NO_NUDGE: '1',
    });
    assert.equal(r.code, 1, '--remove-stale must never eat a lock that carries a HOLDER');
    assert.doesNotMatch(r.stdout, /removed stale no-HOLDER lock/);
    const raw = await readFile(holderPath(lockPath), 'utf8');
    assert.equal((JSON.parse(raw) as HolderShape).session, 'live-sess');
  });

  it('acquire writes HOLDER with beat + sessionPid when --owner-pid resolves one', async () => {
    const r = await runCli(['acquire', 'sess-pid', '--owner-pid', '4321'], lockPath);
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    const holder = JSON.parse(await readFile(holderPath(lockPath), 'utf8')) as HolderShape;
    assert.equal(holder.session, 'sess-pid');
    assert.ok(!Number.isNaN(Date.parse(holder.beat ?? '')), 'beat must be a parseable timestamp');
    assert.equal(holder.sessionPid, 4321, '--owner-pid lands on HOLDER.sessionPid');
  });

  it('acquire --remove-stale clears a HELD lock whose heartbeat aged past PA_TESTLOCK_STALE_MS', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await seedHolder(lockPath, { session: 'ghost-sess', pid: 999999, at: old, beat: old });
    const r = await runCli(['acquire', 'sess-fresh', '--remove-stale'], lockPath, {
      PA_TESTLOCK_STALE_MS: '60000',
    });
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /removed stale held lock/, 'evidence line names the held-lock removal');
    assert.match(r.stdout, /age/, 'the evidence names the staleness signal');
    const holder = JSON.parse(await readFile(holderPath(lockPath), 'utf8')) as HolderShape;
    assert.equal(holder.session, 'sess-fresh', 'the waiter re-acquired in the same invocation');
  });

  it('acquire --remove-stale clears a held lock whose sessionPid is dead — even with a fresh beat', async () => {
    const dead = await deadPid();
    const now = new Date().toISOString();
    await seedHolder(lockPath, { session: 'exited-sess', pid: dead, at: now, beat: now, sessionPid: dead });
    const r = await runCli(['acquire', 'sess-takeover', '--remove-stale'], lockPath);
    assert.equal(r.code, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, /session pid \d+ is dead/, 'the evidence names the dead-pid signal');
    const holder = JSON.parse(await readFile(holderPath(lockPath), 'utf8')) as HolderShape;
    assert.equal(holder.session, 'sess-takeover');
  });

  it('a dead HOLDER.pid NEVER makes a fresh lock stale — pid is the short-lived acquirer', async () => {
    // Regression guard for the AI-255 C1 design hazard: `pid` records the
    // `node testlock.mjs acquire` process, which exits seconds after claiming.
    // Every legitimate lock would be evicted if staleness probed it — only
    // sessionPid is a liveness signal; `pid` stays identity-only.
    const dead = await deadPid();
    const now = new Date().toISOString();
    await seedHolder(lockPath, { session: 'live-sess', pid: dead, at: now, beat: now });
    const r = await runCli(['acquire', 'waiter', '--remove-stale'], lockPath, {
      PA_TESTLOCK_POLL_MS: '10',
      PA_TESTLOCK_WAIT_MS: '120',
      PA_TESTLOCK_NO_NUDGE: '1',
    });
    assert.equal(r.code, 1, 'a live-beat holder must survive --remove-stale regardless of HOLDER.pid');
    const holder = JSON.parse(await readFile(holderPath(lockPath), 'utf8')) as HolderShape;
    assert.equal(holder.session, 'live-sess', 'HOLDER untouched');
  });

  it('status prints the three shapes: free, held-no-holder (pre-convention), holder JSON', async () => {
    const free = await runCli(['status'], lockPath);
    assert.equal(free.code, 0);
    assert.equal(free.stdout.trim(), 'free');

    await mkdir(lockPath, { recursive: true });
    const bare = await runCli(['status'], lockPath);
    assert.equal(bare.code, 0);
    assert.equal(bare.stdout.trim(), 'held-no-holder (pre-convention)');

    await writeFile(holderPath(lockPath), JSON.stringify({ session: 'status-sess', pid: 1, at: new Date().toISOString() }) + '\n', 'utf8');
    const held = await runCli(['status'], lockPath);
    assert.equal(held.code, 0);
    assert.match(held.stdout.trim(), /status-sess/, 'the held shape carries the HOLDER JSON');
  });

  it('usage errors exit 1 with the usage text', async () => {
    const r = await runCli(['acquire'], lockPath);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /usage:/);
  });
});

describe('testlock.mjs — module API (pid-match branch and holder kinds)', () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pa-testlock-api-'));
    lockPath = join(root, 'test.lock');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('release with HOLDER.pid === the calling process releases (pid-match branch)', async () => {
    await seedHolder(lockPath, { session: 'not-even-mine', pid: process.pid, at: new Date().toISOString() });
    const mod = await loadModule();
    const r = await mod.releaseLock({ dir: lockPath });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.action, 'released');
    assert.ok(!existsSync(lockPath));
  });

  it('readHolder distinguishes free / no-holder / holder / holder-unreadable', async () => {
    const mod = await loadModule();
    assert.equal(mod.readHolder(lockPath).kind, 'free');

    await mkdir(lockPath, { recursive: true });
    assert.equal(mod.readHolder(lockPath).kind, 'no-holder');

    await writeFile(holderPath(lockPath), JSON.stringify({ session: 's', pid: 1, at: 'now' }) + '\n', 'utf8');
    const held = mod.readHolder(lockPath);
    assert.equal(held.kind, 'holder');
    assert.equal(held.holder?.session, 's');

    await writeFile(holderPath(lockPath), '{not json', 'utf8');
    assert.equal(mod.readHolder(lockPath).kind, 'holder-unreadable');
  });

  it('acquire timeout fires the injected nudge at the holder\u2019s resolved bus address', async () => {
    const paHome = await mkdtemp(join(tmpdir(), 'pa-testlock-home-'));
    const prevHome = process.env.PA_HOME;
    try {
      await mkdir(join(paHome, 'queues'), { recursive: true });
      await writeFile(
        join(paHome, 'queues', 'registry.json'),
        JSON.stringify({ 'holder@repo#9': { pid: process.pid, capabilities: ['hooks'] } }),
        'utf8'
      );
      process.env.PA_HOME = paHome;
      const now = new Date().toISOString();
      await seedHolder(lockPath, { session: 'holder@repo#9', pid: 999999, at: now, beat: now });

      const nudges: Array<{ address: string; body: string }> = [];
      const notices: string[] = [];
      const mod = await loadModule();
      const r = await mod.acquireLock('waiter', {
        dir: lockPath,
        waitMs: 120,
        pollMs: 10,
        nudge: (address, body) => { nudges.push({ address, body }); },
        notice: (line) => notices.push(line),
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'timeout');
      assert.equal(nudges.length, 1, 'exactly one nudge fired');
      assert.equal(nudges[0].address, 'holder@repo#9', 'nudge went to the resolved address');
      assert.match(nudges[0].body, /test-suite lock/, 'the nudge body explains the ask');
      assert.ok(notices.some((n) => /nudged holder@repo#9/.test(n)), 'the notice reports the nudge');
    } finally {
      if (prevHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = prevHome;
      await rm(paHome, { recursive: true, force: true });
    }
  });

  it('nudge resolves a holder session label through registry nativeSessionId', async () => {
    const paHome = await mkdtemp(join(tmpdir(), 'pa-testlock-home-'));
    const prevHome = process.env.PA_HOME;
    try {
      await mkdir(join(paHome, 'queues'), { recursive: true });
      await writeFile(
        join(paHome, 'queues', 'registry.json'),
        JSON.stringify({ 'claude@repo#5': { pid: process.pid, nativeSessionId: 'native-xyz' } }),
        'utf8'
      );
      process.env.PA_HOME = paHome;
      const now = new Date().toISOString();
      await seedHolder(lockPath, { session: 'native-xyz', pid: 999999, at: now, beat: now });

      const nudges: Array<{ address: string }> = [];
      const mod = await loadModule();
      const r = await mod.acquireLock('waiter', {
        dir: lockPath, waitMs: 120, pollMs: 10,
        nudge: (address) => { nudges.push({ address }); },
        notice: () => {},
      });
      assert.equal(r.ok, false);
      assert.equal(nudges.length, 1);
      assert.equal(nudges[0].address, 'claude@repo#5', 'nativeSessionId resolved to the live address');
    } finally {
      if (prevHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = prevHome;
      await rm(paHome, { recursive: true, force: true });
    }
  });

  it('the nudge is suppressed by nudge:false and by PA_TESTLOCK_NO_NUDGE=1', async () => {
    const paHome = await mkdtemp(join(tmpdir(), 'pa-testlock-home-'));
    const prevHome = process.env.PA_HOME;
    try {
      await mkdir(join(paHome, 'queues'), { recursive: true });
      await writeFile(
        join(paHome, 'queues', 'registry.json'),
        JSON.stringify({ 'h@repo#1': { pid: process.pid } }),
        'utf8'
      );
      process.env.PA_HOME = paHome;
      const now = new Date().toISOString();
      const mod = await loadModule();

      await seedHolder(lockPath, { session: 'h@repo#1', pid: 999999, at: now, beat: now });
      let fired = 0;
      const r1 = await mod.acquireLock('waiter', {
        dir: lockPath, waitMs: 60, pollMs: 10, nudge: false, notice: () => {},
      });
      assert.equal(r1.ok, false);

      process.env.PA_TESTLOCK_NO_NUDGE = '1';
      const r2 = await mod.acquireLock('waiter', {
        dir: lockPath, waitMs: 60, pollMs: 10,
        nudge: () => { fired++; },
        notice: () => {},
      });
      delete process.env.PA_TESTLOCK_NO_NUDGE;
      assert.equal(r2.ok, false);
      assert.equal(fired, 0, 'PA_TESTLOCK_NO_NUDGE suppresses even an injected nudge');
    } finally {
      if (prevHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = prevHome;
      delete process.env.PA_TESTLOCK_NO_NUDGE;
      await rm(paHome, { recursive: true, force: true });
    }
  });

  it('an unresolved holder session skips the nudge and still times out cleanly', async () => {
    const now = new Date().toISOString();
    await seedHolder(lockPath, { session: 'no-such-registered-session', pid: 999999, at: now, beat: now });
    const mod = await loadModule();
    let fired = 0;
    const r = await mod.acquireLock('waiter', {
      dir: lockPath, waitMs: 60, pollMs: 10,
      nudge: () => { fired++; },
      notice: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'timeout');
    assert.equal(fired, 0, 'no registry resolution = no nudge');
  });

  it('release refuses an unreadable HOLDER without force and clears it with force', async () => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(holderPath(lockPath), '{not json', 'utf8');
    const mod = await loadModule();

    const refused = await mod.releaseLock({ dir: lockPath });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.reason, 'holder-unreadable');
    assert.ok(existsSync(lockPath), 'refusal leaves the lock standing');

    const forced = await mod.releaseLock({ dir: lockPath, force: true, notice: () => {} });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.ok(!existsSync(lockPath));
  });
});
