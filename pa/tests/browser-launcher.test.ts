import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdir, readFile, writeFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { createTempPaHome, createTempSkill, createTempConfig, cleanup } from './helpers.js';
import {
  ensureBrowserChrome,
  stopBrowserChrome,
  chromePidsOnProfile,
  buildBrowserSessionEnv,
  browserSessionEnvOverlay,
  chromeExecutableCandidates,
  _setBrowserLauncherDepsForTest,
  type BrowserLauncherDeps,
} from '../src/lib/browser-launcher.js';
import { parseBrowser, parseVoiceInbox } from '../src/config.js';
import { runCommand } from '../src/commands/run.js';
import { browserEnsureCommand, browserStopCommand } from '../src/commands/browser.js';

// See run-exclusive-lock.test.ts — required for direct `node --test` runs
// (npm test sets it via the preload too).
process.env.PA_NOTIFY_DISABLED = '1';

const WS_URL = 'ws://127.0.0.1:9222/devtools/browser/fake-browser-id';
const CHROME_CMDLINE = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\\profile';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  scriptDir = join(tmpdir(), `pa-test-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  _setBrowserLauncherDepsForTest(null);
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
});

interface MockCalls {
  spawn: Array<{ path: string; args: string[]; opts: { detached: boolean; stdio: string; windowsHide: boolean } }>;
  kill: number[];
}

/** Launcher IO fully mocked — no real Chrome, no real processes. Default
 *  posture: /json/version already answers (reuse path), socket-owner
 *  resolution finds nothing. */
function makeDeps(overrides: Partial<BrowserLauncherDeps> = {}): { deps: BrowserLauncherDeps; calls: MockCalls } {
  const calls: MockCalls = { spawn: [], kill: [] };
  const deps: BrowserLauncherDeps = {
    fetchVersion: async () => ({ webSocketDebuggerUrl: WS_URL }),
    spawnProcess: (chromePath, args, opts) => {
      calls.spawn.push({ path: chromePath, args, opts });
      return { pid: 4242, unref() {}, on() {} };
    },
    fileExists: () => true,
    isAlive: async () => true,
    cmdline: async () => CHROME_CMDLINE,
    killTree: (pid) => { calls.kill.push(pid); },
    sleep: async () => {},
    cdpOwnerPid: async () => undefined,
    listChromeCmdlines: async () => [],
    ...overrides,
  };
  return { deps, calls };
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** Capture console.log lines (the commands' stdout) — logger.info also lands
 *  here, so assertions pick the LAST line (the command's JSON is printed
 *  last, after any logging the launcher did). */
async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('parseBrowser', () => {
  it('absent block resolves to the 9222 default', () => {
    assert.deepEqual(parseBrowser(undefined), { cdp_port: 9222 });
    assert.deepEqual(parseBrowser(null), { cdp_port: 9222 });
  });
  it('honours a valid cdp_port and falls back on invalid ones', () => {
    assert.deepEqual(parseBrowser({ cdp_port: 9333 }), { cdp_port: 9333 });
    for (const bad of ['9222', 80, 70000, 9222.5, {}]) {
      assert.equal(parseBrowser({ cdp_port: bad }).cdp_port, 9222, `bad value ${JSON.stringify(bad)} should fall back`);
    }
  });
  it('a non-mapping block falls back to defaults', () => {
    assert.deepEqual(parseBrowser([]), { cdp_port: 9222 });
    assert.deepEqual(parseBrowser('x'), { cdp_port: 9222 });
  });
});

describe('parseVoiceInbox', () => {
  it('absent block stays absent', () => {
    assert.equal(parseVoiceInbox(undefined), undefined);
    assert.equal(parseVoiceInbox(null), undefined);
  });
  it('parses port and screencast_ingest_token', () => {
    assert.deepEqual(
      parseVoiceInbox({ port: 8899, screencast_ingest_token: ' tok-123 ' }),
      { port: 8899, screencast_ingest_token: 'tok-123' },
    );
  });
  it('drops malformed fields, keeps the block', () => {
    assert.deepEqual(parseVoiceInbox({ port: 'abc', screencast_ingest_token: 42 }), {});
    assert.deepEqual(parseVoiceInbox({ inbox_topic: '-1_2' }), {});
  });
});

describe('ensureBrowserChrome', () => {
  it('reuses an already-answering endpoint without spawning (idempotent)', async () => {
    const { deps, calls } = makeDeps();
    const handle = await ensureBrowserChrome({ port: 9222, profileDir: join(tempDir, 'browser-profile') }, deps);
    assert.equal(handle.endpoint, WS_URL);
    assert.equal(handle.startedByUs, false);
    assert.equal(handle.pid, undefined);
    assert.equal(calls.spawn.length, 0, 'reuse path must not spawn');
  });

  it('reuse path returns the stored pidfile pid when it is alive', async () => {
    await writeFile(join(tempDir, 'browser-chrome.pid'), JSON.stringify({ pid: 5555, port: 9222 }), 'utf8');
    const { deps } = makeDeps();
    const handle = await ensureBrowserChrome({ port: 9222, profileDir: join(tempDir, 'browser-profile') }, deps);
    assert.equal(handle.pid, 5555);
    assert.equal(handle.startedByUs, false);
  });

  it('reuse path heals a dead pidfile from the socket owner when its cmdline matches our profile', async () => {
    const profileDir = join(tempDir, 'browser-profile');
    await writeFile(join(tempDir, 'browser-chrome.pid'), JSON.stringify({ pid: 1111, port: 9222 }), 'utf8');
    const { deps } = makeDeps({
      isAlive: async (pid) => pid === 7777, // stored 1111 is dead
      cdpOwnerPid: async () => 7777,
      cmdline: async (pid) => pid === 7777
        ? `"C:\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="${profileDir.replace(/\//g, '\\')}"`
        : '',
    });
    const handle = await ensureBrowserChrome({ port: 9222, profileDir }, deps);
    assert.equal(handle.pid, 7777);
    assert.equal(handle.startedByUs, false);
    const rec = JSON.parse(await readFile(join(tempDir, 'browser-chrome.pid'), 'utf8'));
    assert.equal(rec.pid, 7777);
  });

  it('reuse path never claims a foreign Chrome on our port (different profile dir)', async () => {
    await writeFile(join(tempDir, 'browser-chrome.pid'), JSON.stringify({ pid: 1111, port: 9222 }), 'utf8');
    const { deps } = makeDeps({
      isAlive: async () => false,
      cdpOwnerPid: async () => 9999,
      cmdline: async () => '"C:\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\\other-profile',
    });
    const handle = await ensureBrowserChrome({ port: 9222, profileDir: join(tempDir, 'browser-profile') }, deps);
    assert.equal(handle.pid, undefined);
  });

  it('spawns detached Chrome with the spec args and records the SOCKET-OWNER pid (not the exiting bootstrapper)', async () => {
    let fetches = 0;
    const { deps, calls } = makeDeps({
      fetchVersion: async () => (++fetches === 1 ? null : { webSocketDebuggerUrl: WS_URL }),
      cdpOwnerPid: async () => 5555, // real browser process; spawned 4242 is the bootstrapper
    });
    const profileDir = join(tempDir, 'browser-profile');
    const handle = await ensureBrowserChrome({ port: 9333, profileDir }, deps);

    assert.equal(handle.startedByUs, true);
    assert.equal(handle.pid, 5555);
    assert.equal(handle.endpoint, WS_URL);
    assert.equal(calls.spawn.length, 1);
    const spawn = calls.spawn[0];
    const expectedChrome = chromeExecutableCandidates()[0];
    assert.equal(spawn.path, expectedChrome);
    assert.deepEqual(spawn.args, [
      '--remote-debugging-port=9333',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--restore-last-session=false',
      '--window-size=1280,800',
      '--window-position=40,40',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion,TabDiscarding,TabFreezing,IntensiveWakeUpThrottling',
    ]);
    assert.equal(spawn.opts.detached, true);
    assert.equal(spawn.opts.stdio, 'ignore');
    assert.equal(spawn.opts.windowsHide, false);

    const rec = JSON.parse(await readFile(join(tempDir, 'browser-chrome.pid'), 'utf8'));
    assert.equal(rec.pid, 5555);
    assert.equal(rec.spawnedPid, 4242);
    assert.equal(rec.port, 9333);
    assert.equal(rec.profileDir, profileDir);
  });

  it('launches headed Chrome with an explicit on-screen window position (WP-X)', async () => {
    let fetches = 0;
    const { deps, calls } = makeDeps({
      fetchVersion: async () => (++fetches === 1 ? null : { webSocketDebuggerUrl: WS_URL }),
    });
    await ensureBrowserChrome({ port: 9333, profileDir: join(tempDir, 'browser-profile') }, deps);
    assert.equal(calls.spawn.length, 1);
    const pos = calls.spawn[0].args.find((a) => a.startsWith('--window-position='));
    assert.equal(
      pos,
      '--window-position=40,40',
      'a headed launch must pass an explicit on-screen position so it never inherits the profile saved off-screen placement (RO-7)',
    );
  });

  it('a spawn that never answers is killed and its pidfile removed before the timeout throw', async () => {
    const { deps, calls } = makeDeps({ fetchVersion: async () => null });
    await assert.rejects(
      () => ensureBrowserChrome({ port: 9222, profileDir: join(tempDir, 'browser-profile'), timeoutMs: 300 }, deps),
      /Timed out after 300ms/,
    );
    assert.deepEqual(calls.kill, [4242], 'the spawned tree must be killed on timeout — never left for the operator');
    assert.equal(await exists(join(tempDir, 'browser-chrome.pid')), false);
  });

  it('spawn-timeout with foreign pids on the profile throws the actionable contention error (WP-A2)', async () => {
    const profileDir = join(tempDir, 'browser-profile');
    const { deps, calls } = makeDeps({
      fetchVersion: async () => null,
      spawnProcess: (chromePath, args, opts) => {
        calls.spawn.push({ path: chromePath, args, opts });
        return { pid: 5555, unref() {}, on() {} };
      },
      listChromeCmdlines: async () => [
        // Our own just-spawned pid still shows in the enumeration — it must
        // be filtered out of the "foreign holders" list.
        { pid: 5555, cmdline: `"C:\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=${profileDir}` },
        { pid: 19424, cmdline: `"C:\\chrome.exe" --remote-debugging-pipe --user-data-dir="${profileDir}"` },
      ],
    });
    await assert.rejects(
      () => ensureBrowserChrome({ port: 9222, profileDir, timeoutMs: 300 }, deps),
      (err: Error) => {
        assert.match(err.message, /Chrome failed to answer on port 9222 — profile /);
        assert.ok(err.message.includes(profileDir), 'error names the contended profile dir');
        assert.match(err.message, /Chrome pid\(s\) 19424 without a debug port/);
        assert.match(err.message, /orphaned Playwright MCP Chrome/);
        assert.ok(err.message.includes('`pa browser stop`'), 'error tells the operator how to clear it');
        return true;
      },
    );
    assert.deepEqual(calls.kill, [5555], 'the spawned tree is still cleaned up');
    assert.equal(await exists(join(tempDir, 'browser-chrome.pid')), false);
  });

  it('spawn-timeout with no foreign pids on the profile keeps the original timeout error', async () => {
    const profileDir = join(tempDir, 'browser-profile');
    const { deps, calls } = makeDeps({
      fetchVersion: async () => null,
      // Only our own spawned pid is enumerated — no foreign holder, so the
      // plain timeout error stands.
      listChromeCmdlines: async () => [
        { pid: 4242, cmdline: `"C:\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=${profileDir}` },
      ],
    });
    await assert.rejects(
      () => ensureBrowserChrome({ port: 9222, profileDir, timeoutMs: 300 }, deps),
      /Timed out after 300ms/,
    );
    assert.deepEqual(calls.kill, [4242]);
  });

  it('a child error event fails fast with a clear error and cleans up', async () => {
    let errorListener: ((err: Error) => void) | undefined;
    const { deps, calls } = makeDeps({
      fetchVersion: async () => null,
      // sleep must yield to the event loop: with an instant `async () => {}`
      // stub the launcher's poll loop spins as a tight microtask loop and
      // starves this test's setTimeout-based attach poll, so the error event
      // is never fired before the deadline. A setTimeout(0) yield lets the
      // poll run between loop iterations (the real launcher's setTimeout(250)
      // + fetch(1500) yield naturally).
      sleep: async () => { await new Promise((r) => setTimeout(r, 0)); },
      spawnProcess: () => ({
        pid: 4242,
        unref() {},
        on(_e, l) { errorListener = l; },
      }),
    });
    const pending = ensureBrowserChrome({ port: 9222, profileDir: join(tempDir, 'browser-profile'), timeoutMs: 5000 }, deps);
    // on('error') is attached after the first awaited probe + real mkdir —
    // wait for the listener to exist before firing it.
    const attachDeadline = Date.now() + 2000;
    while (!errorListener && Date.now() < attachDeadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(errorListener, 'precondition: spawnProcess on(error) listener must be attached');
    errorListener(new Error('spawn ENOENT'));
    await assert.rejects(() => pending, /Chrome spawn failed: spawn ENOENT/);
    assert.deepEqual(calls.kill, [4242]);
    assert.equal(await exists(join(tempDir, 'browser-chrome.pid')), false);
  });

  it('throws a clear error when no Chrome executable exists', async () => {
    const { deps, calls } = makeDeps({ fetchVersion: async () => null, fileExists: () => false });
    await assert.rejects(
      () => ensureBrowserChrome({ port: 9222, profileDir: join(tempDir, 'browser-profile') }, deps),
      /Chrome executable not found/,
    );
    assert.equal(calls.spawn.length, 0);
  });

  it('falls back to the http endpoint when the probe has no webSocketDebuggerUrl', async () => {
    const { deps } = makeDeps({ fetchVersion: async () => ({ Browser: 'Chrome/140' }) });
    const handle = await ensureBrowserChrome({ port: 9222, profileDir: join(tempDir, 'browser-profile') }, deps);
    assert.equal(handle.endpoint, 'http://127.0.0.1:9222');
  });

  it('mode headless spawns with --headless=new and drops the headed-only window pin', async () => {
    let fetches = 0;
    const { deps, calls } = makeDeps({
      fetchVersion: async () => (++fetches === 1 ? null : { webSocketDebuggerUrl: WS_URL }),
      cdpOwnerPid: async () => 5555,
    });
    const handle = await ensureBrowserChrome(
      { port: 9222, profileDir: join(tempDir, 'browser-profile'), mode: 'headless' },
      deps,
    );
    assert.equal(handle.mode, 'headless');
    assert.equal(handle.startedByUs, true);
    assert.equal(calls.spawn.length, 1);
    assert.ok(calls.spawn[0].args.includes('--headless=new'));
    assert.ok(!calls.spawn[0].args.includes('--window-size=1280,800'));
    assert.ok(
      !calls.spawn[0].args.some((a) => a.startsWith('--window-position=')),
      'headless has no placed window — no position pin',
    );
  });

  it('reuse path detects the running Chrome mode from its cmdline (headed and headless)', async () => {
    await writeFile(join(tempDir, 'browser-chrome.pid'), JSON.stringify({ pid: 5555, port: 9222 }), 'utf8');

    const headed = makeDeps({ cmdline: async () => CHROME_CMDLINE });
    const h1 = await ensureBrowserChrome(
      { port: 9222, profileDir: join(tempDir, 'browser-profile'), mode: 'headed' },
      headed.deps,
    );
    assert.equal(h1.mode, 'headed');
    assert.equal(h1.modeOverride, undefined);
    assert.equal(h1.startedByUs, false);

    const headless = makeDeps({ cmdline: async () => `${CHROME_CMDLINE} --headless=new` });
    const h2 = await ensureBrowserChrome(
      { port: 9222, profileDir: join(tempDir, 'browser-profile'), mode: 'headless' },
      headless.deps,
    );
    assert.equal(h2.mode, 'headless');
    assert.equal(h2.modeOverride, undefined);
    assert.equal(headless.calls.spawn.length, 0, 'same-mode reuse must not respawn');
  });

  it('mode mismatch with the browser-session lock held returns the existing mode + modeOverride, no relaunch', async () => {
    await writeFile(join(tempDir, 'browser-chrome.pid'), JSON.stringify({ pid: 5555, port: 9222 }), 'utf8');
    // A live `pa run` holds the lock: alive pid + fresh heartbeat classifies
    // 'alive' in getActiveLocks. The CLI never acquires this lock itself.
    await writeFile(join(tempDir, 'blackboard.json'), JSON.stringify({
      active_locks: [
        { resource: 'skill-exclusive:browser-session', agent: 'run:test', pid: process.pid, heartbeat: new Date().toISOString() },
      ],
    }), 'utf8');
    const { deps, calls } = makeDeps(); // running Chrome's cmdline is headed
    const handle = await ensureBrowserChrome(
      { port: 9222, profileDir: join(tempDir, 'browser-profile'), mode: 'headless' },
      deps,
    );
    assert.equal(handle.mode, 'headed');
    assert.equal(handle.modeOverride, true);
    assert.equal(handle.startedByUs, false);
    assert.equal(handle.endpoint, WS_URL);
    assert.equal(calls.spawn.length, 0, 'lock-held mismatch must not respawn');
    assert.deepEqual(calls.kill, [], 'lock-held mismatch must not kill the running Chrome');
  });

  it('mode mismatch with the lock free stops the running Chrome and respawns in the requested mode', async () => {
    const profileDir = join(tempDir, 'browser-profile');
    await writeFile(join(tempDir, 'browser-chrome.pid'), JSON.stringify({ pid: 5555, port: 9222 }), 'utf8');
    let killed = false;
    const { deps, calls } = makeDeps({
      isAlive: async () => !killed, // stored 5555 lives until killTree lands
      cmdline: async () => CHROME_CMDLINE,
      killTree: (pid) => { calls.kill.push(pid); killed = true; },
      // The old headed Chrome answers until killed; after the stop the port
      // is silent until the respawned Chrome comes up.
      fetchVersion: async () => (killed && calls.spawn.length === 0 ? null : { webSocketDebuggerUrl: WS_URL }),
      cdpOwnerPid: async () => 5555,
    });
    const handle = await ensureBrowserChrome({ port: 9222, profileDir, mode: 'headless' }, deps);
    assert.deepEqual(calls.kill, [5555], 'the mismatched Chrome must be stopped before respawn');
    assert.equal(calls.spawn.length, 1);
    assert.ok(calls.spawn[0].args.includes('--headless=new'));
    assert.ok(!calls.spawn[0].args.includes('--window-size=1280,800'));
    assert.equal(handle.mode, 'headless');
    assert.equal(handle.startedByUs, true);
    assert.equal(handle.modeOverride, undefined);
  });
});

describe('stopBrowserChrome', () => {
  it('kills the stored pid tree and removes the pidfile', async () => {
    const pidFile = join(tempDir, 'browser-chrome.pid');
    await writeFile(pidFile, JSON.stringify({ pid: 4242, port: 9222 }), 'utf8');
    const { deps, calls } = makeDeps();
    assert.deepEqual(await stopBrowserChrome(deps), [4242]);
    assert.deepEqual(calls.kill, [4242]);
    assert.equal(await exists(pidFile), false);
  });

  it('is a no-op with no pidfile and no profile holders', async () => {
    const { deps, calls } = makeDeps();
    assert.deepEqual(await stopBrowserChrome(deps), []);
    assert.deepEqual(calls.kill, []);
  });

  it('does not kill a dead stored pid (stale pidfile cleanup only)', async () => {
    const pidFile = join(tempDir, 'browser-chrome.pid');
    await writeFile(pidFile, '4242', 'utf8'); // bare-int pidfile tolerated
    const { deps, calls } = makeDeps({ isAlive: async () => false });
    assert.deepEqual(await stopBrowserChrome(deps), []);
    assert.deepEqual(calls.kill, []);
    assert.equal(await exists(pidFile), false);
  });

  it('refuses to kill a live stored pid that is positively not a debug Chrome (recycled pid, D6)', async () => {
    const pidFile = join(tempDir, 'browser-chrome.pid');
    await writeFile(pidFile, JSON.stringify({ pid: 4242 }), 'utf8');
    const { deps, calls } = makeDeps({ cmdline: async () => 'node server.js' });
    assert.deepEqual(await stopBrowserChrome(deps), []);
    assert.deepEqual(calls.kill, []);
    assert.equal(await exists(pidFile), false);
  });

  it('self-heals a dead bootstrapper record: port still answering → kills the socket-owner tree', async () => {
    const pidFile = join(tempDir, 'browser-chrome.pid');
    await writeFile(pidFile, JSON.stringify({ pid: 4242, port: 9222 }), 'utf8');
    const { deps, calls } = makeDeps({
      isAlive: async (pid) => pid === 9999, // recorded 4242 is the exited bootstrapper
      fetchVersion: async () => ({ webSocketDebuggerUrl: WS_URL }), // port still answers after the no-op kill
      cdpOwnerPid: async () => 9999,
      cmdline: async (pid) => (pid === 9999 ? CHROME_CMDLINE : ''),
    });
    assert.deepEqual(await stopBrowserChrome(deps), [9999]);
    assert.deepEqual(calls.kill, [9999]);
    assert.equal(await exists(pidFile), false);
  });

  it('kills the pidfile pid AND foreign Chromes holding the profile (WP-A2 orphans)', async () => {
    const profileDir = join(tempDir, 'browser-profile');
    const pidFile = join(tempDir, 'browser-chrome.pid');
    await writeFile(pidFile, JSON.stringify({ pid: 4242, port: 9222 }), 'utf8');
    const onProfile = (extra: string) => `"C:\\chrome.exe" ${extra} --user-data-dir="${profileDir}"`;
    const { deps, calls } = makeDeps({
      fetchVersion: async () => null, // port silent after the kill — no socket-owner heal
      cmdline: async (pid) =>
        pid === 19424 ? onProfile('--remote-debugging-pipe')
        : pid === 7777 ? '"C:\\chrome.exe" --user-data-dir=C:\\other-profile'
        : onProfile('--remote-debugging-port=9222'),
      listChromeCmdlines: async () => [
        { pid: 4242, cmdline: onProfile('--remote-debugging-port=9222') },
        // The orphaned Playwright MCP Chrome: pipe flag, no port, no pidfile
        // entry — the cmdline check that guards the pidfile kill would reject
        // it, but the profile marker is its ownership proof.
        { pid: 19424, cmdline: onProfile('--remote-debugging-pipe') },
        // The operator's personal Chrome — different user-data-dir, never ours.
        { pid: 7777, cmdline: '"C:\\chrome.exe" --user-data-dir=C:\\other-profile' },
      ],
    });
    assert.deepEqual(await stopBrowserChrome(deps), [4242, 19424]);
    assert.deepEqual(calls.kill, [4242, 19424]);
    assert.equal(await exists(pidFile), false);
  });

  it('with no pidfile still kills profile-holding Chromes (the pure-orphan case)', async () => {
    const profileDir = join(tempDir, 'browser-profile');
    const { deps, calls } = makeDeps({
      cmdline: async () => `"C:\\chrome.exe" --remote-debugging-pipe --user-data-dir="${profileDir}"`,
      listChromeCmdlines: async () => [
        { pid: 19424, cmdline: `"C:\\chrome.exe" --remote-debugging-pipe --user-data-dir="${profileDir}"` },
      ],
    });
    assert.deepEqual(await stopBrowserChrome(deps), [19424]);
    assert.deepEqual(calls.kill, [19424]);
  });
});

describe('chromePidsOnProfile', () => {
  it('matches --user-data-dir across slash direction and quoting, and rejects other dirs', async () => {
    const profileDir = join(tempDir, 'browser-profile');
    const { deps } = makeDeps({
      listChromeCmdlines: async () => [
        // Quoted, backslashed — the verbatim PA-spawn form.
        { pid: 100, cmdline: `"C:\\chrome.exe" --remote-debugging-pipe --user-data-dir="${profileDir}"` },
        // Forward slashes — Playwright's own spawn style.
        { pid: 200, cmdline: `C:/chrome.exe --user-data-dir=${profileDir.replace(/\\/g, '/')}` },
        // Different profile dir — the operator's own Chrome.
        { pid: 300, cmdline: '"C:\\chrome.exe" --user-data-dir=C:\\other-profile' },
        // Sibling prefix dir — must NOT match (substring is not ownership).
        { pid: 400, cmdline: `"C:\\chrome.exe" --user-data-dir=${profileDir}2` },
        // No user-data-dir at all.
        { pid: 500, cmdline: '"C:\\chrome.exe" --remote-debugging-pipe' },
      ],
    });
    assert.deepEqual(await chromePidsOnProfile(profileDir, deps), [100, 200]);
  });
});

describe('buildBrowserSessionEnv', () => {
  it('builds the AI-246 env contract from config', async () => {
    const { deps } = makeDeps();
    const { env, startedByUs } = await buildBrowserSessionEnv(
      { browser: { cdp_port: 9333 }, voice_inbox: { port: 8899, screencast_ingest_token: 'tok-xyz' } },
      deps,
    );
    assert.equal(startedByUs, false);
    assert.equal(env.PLAYWRIGHT_MCP_CDP_ENDPOINT, WS_URL);
    assert.equal(env.PA_BROWSER_CDP_PORT, '9333');
    assert.equal(env.VOICE_INBOX_PORT, '8899');
    assert.equal(env.PA_SCREENCAST_INGEST_TOKEN, 'tok-xyz');
  });

  it('omits the ingest token when unconfigured and defaults the voice-inbox port', async () => {
    const { deps } = makeDeps();
    const { env } = await buildBrowserSessionEnv({ browser: { cdp_port: 9222 } }, deps);
    assert.equal(env.PA_SCREENCAST_INGEST_TOKEN, undefined);
    assert.equal(env.VOICE_INBOX_PORT, '8787');
  });
});

describe('browserSessionEnvOverlay (AI-246 v4)', () => {
  it('emits the three CDP vars from config — http endpoint, no token, and it takes no deps so it cannot launch Chrome', () => {
    const overlay = browserSessionEnvOverlay({
      browser: { cdp_port: 9333 },
      voice_inbox: { port: 8899, screencast_ingest_token: 'tok-should-not-leak' },
    });
    assert.deepEqual(overlay, {
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'http://127.0.0.1:9333',
      PA_BROWSER_CDP_PORT: '9333',
      VOICE_INBOX_PORT: '8899',
    });
  });

  it('falls back to the default ports when the config blocks are absent', () => {
    const overlay = browserSessionEnvOverlay({ browser: { cdp_port: 9222 } });
    assert.equal(overlay.PLAYWRIGHT_MCP_CDP_ENDPOINT, 'http://127.0.0.1:9222');
    assert.equal(overlay.VOICE_INBOX_PORT, '8787');
  });
});

describe('pa browser commands', () => {
  it('browserEnsureCommand prints the handle JSON (ok, endpoint, port, pid, mode, startedByUs, modeOverride)', async () => {
    const { deps } = makeDeps(); // /json/version answers — reuse path
    _setBrowserLauncherDepsForTest(deps);
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: ['-e', 'true'], check: 'echo ok', priority: 1 },
    ], { browser: { cdp_port: 9222 } });

    const lines = await captureConsole(() => browserEnsureCommand([]));
    const out = JSON.parse(lines[lines.length - 1]);
    assert.equal(out.ok, true);
    assert.equal(out.endpoint, WS_URL);
    assert.equal(out.port, 9222);
    assert.equal(out.pid, null);
    assert.equal(out.mode, 'headed');
    assert.equal(out.startedByUs, false);
    assert.equal(out.modeOverride, false);
  });

  it('browserStopCommand kills the pidfile Chrome and prints {ok,killed}', async () => {
    const pidFile = join(tempDir, 'browser-chrome.pid');
    await writeFile(pidFile, JSON.stringify({ pid: 4242, port: 9222 }), 'utf8');
    const { deps, calls } = makeDeps({ cdpOwnerPid: async () => undefined });
    _setBrowserLauncherDepsForTest(deps);

    const lines = await captureConsole(() => browserStopCommand());
    assert.deepEqual(calls.kill, [4242]);
    assert.deepEqual(JSON.parse(lines[lines.length - 1]), { ok: true, killed: [4242] });
    assert.equal(await exists(pidFile), false);
  });
});

describe('runCommand browser-session dispatch (AI-246)', () => {
  async function makeEnvDumpSkill(name: string): Promise<string> {
    const dumpScript = join(scriptDir, `${name}-dump.js`);
    await writeFile(
      dumpScript,
      `process.stdout.write([process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT ?? 'unset', process.env.PA_BROWSER_CDP_PORT ?? 'unset', process.env.VOICE_INBOX_PORT ?? 'unset', process.env.PA_SCREENCAST_INGEST_TOKEN ?? 'unset'].join('|'));`,
      'utf8',
    );
    await createTempSkill(tempDir, name, [
      '---',
      'cmd: node ' + JSON.stringify(dumpScript),
      'exclusive_resource: browser-session',
      'timeout: 15',
      '---',
      'unused',
    ].join('\n'));
    return dumpScript;
  }

  it('injects the CDP env into a browser-session skill and leaves Chrome running (v4 persistence)', async () => {
    let fetches = 0;
    const { deps, calls } = makeDeps({
      fetchVersion: async () => (++fetches === 1 ? null : { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/fake' }),
      cdpOwnerPid: async () => 5555, // real browser pid; spawned 4242 is the bootstrapper
    });
    _setBrowserLauncherDepsForTest(deps);

    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: ['-e', 'true'], check: 'echo ok', priority: 1 },
    ], {
      browser: { cdp_port: 9333 },
      voice_inbox: { port: 8899, screencast_ingest_token: 'tok-secret' },
    });
    await makeEnvDumpSkill('browser-skill');

    const result = await runCommand('browser-skill');
    assert.equal(result.success, true);
    assert.equal(result.output, 'ws://127.0.0.1:9333/devtools/browser/fake|9333|8899|tok-secret');
    // AI-246 v4: Chrome is NEVER torn down by `pa run` — it persists across
    // tasks so the credential profile accumulates and `pa browser ensure`
    // can reuse it. No kill, and the pidfile stays for the next caller.
    assert.deepEqual(calls.kill, []);
    assert.equal(await exists(join(tempDir, 'browser-chrome.pid')), true);
  });

  it('reuses an already-running endpoint and does NOT tear it down', async () => {
    const { deps, calls } = makeDeps(); // fetchVersion answers on first probe
    _setBrowserLauncherDepsForTest(deps);

    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: ['-e', 'true'], check: 'echo ok', priority: 1 },
    ], { browser: { cdp_port: 9222 } });
    await makeEnvDumpSkill('browser-reuse-skill');

    const result = await runCommand('browser-reuse-skill');
    assert.equal(result.success, true);
    assert.equal(result.output, `${WS_URL}|9222|8787|unset`);
    assert.deepEqual(calls.kill, [], 'a Chrome we did not start must never be killed');
  });

  it('a Chrome launch failure fails the run fast (no dispatch)', async () => {
    const { deps, calls } = makeDeps({
      fetchVersion: async () => null,
      fileExists: () => false, // no Chrome anywhere
    });
    _setBrowserLauncherDepsForTest(deps);

    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: ['-e', 'true'], check: 'echo ok', priority: 1 },
    ]);
    await makeEnvDumpSkill('browser-fail-skill');

    const result = await runCommand('browser-fail-skill');
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /browser-session Chrome launch failed: Chrome executable not found/);
    assert.equal(calls.spawn.length, 0);
  });

  it('exports the run lock context for jev-browser-wingman', async () => {
    const { deps } = makeDeps();
    _setBrowserLauncherDepsForTest(deps);

    const dumpScript = join(scriptDir, 'lock-context-dump.js');
    await writeFile(
      dumpScript,
      `process.stdout.write(process.env.PA_BROWSER_SESSION_LOCK_CONTEXT ?? 'unset');`,
      'utf8',
    );
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: ['-e', 'true'], check: 'echo ok', priority: 1 },
    ], { browser: { cdp_port: 9222 } });
    await createTempSkill(tempDir, 'lock-context-skill', [
      '---',
      'cmd: node ' + JSON.stringify(dumpScript),
      'exclusive_resource: browser-session',
      'timeout: 15',
      '---',
      'unused',
    ].join('\n'));

    const result = await runCommand('lock-context-skill');
    assert.equal(result.success, true);
    assert.match(result.output ?? '', /^[0-9a-f-]{36}$/);
  });
});
