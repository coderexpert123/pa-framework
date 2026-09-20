/**
 * AI-246 WP-D: PA-launched headed Chrome for `exclusive_resource:
 * browser-session` skill dispatches.
 *
 * Before this, each worker's Playwright MCP server launched its own Chrome
 * against the shared ~/.pa/browser-profile (the D1 command). For the live
 * screencast feature the browser must carry a DevTools port PA knows about:
 * PA launches Chrome itself with --remote-debugging-port, hands the worker
 * PLAYWRIGHT_MCP_CDP_ENDPOINT (+ friends) through its inherited env, and the
 * MCP server attaches over CDP instead of launching. D1 stays registered —
 * interactive sessions (no PA env) keep launching their own Chrome exactly
 * as before.
 *
 * Safety rules this file enforces (see plans/2026-09-12-browser-mcp-wiring.md):
 * - D6: kill by stored PID TREE only, NEVER by image name (taskkill chrome.exe
 *   would murder the operator's interactive browsers).
 * - The spawn is detached + unref'd: PA's exit must not take the operator's
 *   visible browser down mid-task. stopBrowserChrome owns teardown and is
 *   called by run.ts before it releases the browser-session lock.
 * - Idempotent: if /json/version already answers on the port we reuse it —
 *   we did not start that Chrome this session, so we never tear it down.
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';
import { paHome } from '../paths.js';
import { areProcessesAlive, findProcessesByCommandLine, getCommandLines, killProcessTree } from '../process-tree.js';
import { blackboard } from '../blackboard.js';
import { logger } from './log.js';
import type { PaConfig } from '../types.js';

export const DEFAULT_BROWSER_CDP_PORT = 9222;
export const DEFAULT_VOICE_INBOX_PORT = 8787;

/** What GET http://127.0.0.1:<port>/json/version returns (fields we read). */
export interface VersionProbe {
  webSocketDebuggerUrl?: string;
  Browser?: string;
}

/** Minimal shape of the spawned child the launcher needs. */
export interface SpawnedChrome {
  pid?: number;
  unref(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface ChromeSpawnOptions {
  detached: boolean;
  stdio: 'ignore';
  windowsHide: boolean;
}

/** Injectable IO seams — every external effect goes through one of these so
 *  the launcher is fully testable without a real Chrome (house style: the
 *  injected-fn pattern from process-tree.ts's execFn). Callers pass `deps`
 *  directly, or a test swaps the module-wide override via
 *  _setBrowserLauncherDepsForTest (for run.ts, which takes no deps arg). */
export interface BrowserLauncherDeps {
  /** GET /json/version on the port. Resolve null on ANY failure (connection
   *  refused, timeout, non-200, bad JSON) — callers only care "is a CDP
   *  endpoint answering". */
  fetchVersion?: (port: number, timeoutMs: number) => Promise<VersionProbe | null>;
  spawnProcess?: (chromePath: string, args: string[], opts: ChromeSpawnOptions) => SpawnedChrome;
  fileExists?: (path: string) => boolean;
  isAlive?: (pid: number) => Promise<boolean>;
  cmdline?: (pid: number) => Promise<string>;
  killTree?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Resolve the pid OWNING the CDP listen socket on `port` — the real
   *  browser process. Needed because the chrome.exe we spawn is a
   *  bootstrapper that exits once the true browser process is up (observed
   *  live 2026-09-14: spawned pid died, browser ran on as its child holding
   *  the socket). The pidfile must name the socket owner or teardown skips. */
  cdpOwnerPid?: (port: number) => Promise<number | undefined>;
  /** Enumerate running chrome.exe processes (pid + cmdline) — the seam
   *  chromePidsOnProfile filters by --user-data-dir. Default: one
   *  Win32_Process snapshot scan via process-tree's
   *  findProcessesByCommandLine('chrome') — the same cached enumeration
   *  getCommandLines/areProcessesAlive share, never a per-PID query.
   *  (POSIX: the shared ps snapshot carries no cmdlines, so this lists
   *  nothing — profile-contention handling is a Windows feature.) */
  listChromeCmdlines?: () => Promise<Array<{ pid: number; cmdline: string }>>;
  /** Defaults to ~/.pa/browser-chrome.pid. */
  pidFilePath?: string;
}

async function defaultFetchVersion(port: number, timeoutMs: number): Promise<VersionProbe | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as VersionProbe;
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const execAsync = promisify(exec);

/** Default socket-owner resolution via `netstat -ano` — a console app, so
 *  windowsHide:true prevents the window flash. Not a process-tree query (the
 *  Win32_Process snapshot cannot see socket ownership), so it does not go
 *  through process-tree.ts. */
async function defaultCdpOwnerPid(port: number): Promise<number | undefined> {
  try {
    const { stdout } = await execAsync('netstat -ano -p tcp', { windowsHide: true, timeout: 10_000 });
    for (const line of stdout.split('\n')) {
      const f = line.trim().split(/\s+/);
      // Proto  LocalAddress  ForeignAddress  State  PID
      if (f.length >= 5 && f[0] === 'TCP' && f[3] === 'LISTENING' && f[1].endsWith(`:${port}`)) {
        const pid = parseInt(f[4], 10);
        if (Number.isInteger(pid) && pid > 0) return pid;
      }
    }
  } catch {}
  return undefined;
}

interface ResolvedDeps {
  fetchVersion: (port: number, timeoutMs: number) => Promise<VersionProbe | null>;
  spawnProcess: (chromePath: string, args: string[], opts: ChromeSpawnOptions) => SpawnedChrome;
  fileExists: (path: string) => boolean;
  isAlive: (pid: number) => Promise<boolean>;
  cmdline: (pid: number) => Promise<string>;
  killTree: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  cdpOwnerPid: (port: number) => Promise<number | undefined>;
  listChromeCmdlines: () => Promise<Array<{ pid: number; cmdline: string }>>;
  pidFilePath: string;
}

let _testDeps: BrowserLauncherDeps | null = null;

/** Test-only module-wide dep override (mirrors process-tree's
 *  _setRawExecForTest). run.ts calls ensure/stop with no deps argument, so a
 *  runCommand-level test swaps the seams in here. Pass null to restore. */
export function _setBrowserLauncherDepsForTest(deps: BrowserLauncherDeps | null): void {
  _testDeps = deps;
}

function resolveDeps(deps?: BrowserLauncherDeps): ResolvedDeps {
  const merged: BrowserLauncherDeps = { ...(_testDeps ?? {}), ...(deps ?? {}) };
  return {
    fetchVersion: merged.fetchVersion ?? defaultFetchVersion,
    spawnProcess:
      merged.spawnProcess ??
      ((chromePath, args, opts) =>
        spawn(chromePath, args, { detached: opts.detached, stdio: opts.stdio, windowsHide: opts.windowsHide })),
    fileExists: merged.fileExists ?? existsSync,
    isAlive: merged.isAlive ?? (async (pid) => (await areProcessesAlive([pid])).get(pid) === true),
    cmdline: merged.cmdline ?? (async (pid) => (await getCommandLines([pid])).get(pid) ?? ''),
    killTree: merged.killTree ?? killProcessTree,
    sleep: merged.sleep ?? defaultSleep,
    cdpOwnerPid: merged.cdpOwnerPid ?? defaultCdpOwnerPid,
    listChromeCmdlines: merged.listChromeCmdlines ?? (() => findProcessesByCommandLine('chrome')),
    pidFilePath: merged.pidFilePath ?? join(paHome(), 'browser-chrome.pid'),
  };
}

export interface EnsureBrowserChromeOptions {
  port: number;
  profileDir: string;
  /** Total budget for /json/version to come up after spawn. Default 10s. */
  timeoutMs?: number;
  /** Poll interval. Default 250ms. */
  pollIntervalMs?: number;
  /** Requested window mode (default 'headed'). 'headed' is the
   *  operator-visible browser; 'headless' is for pure read-only task-lane
   *  work. A mismatch with an already-running Chrome only relaunches when
   *  the browser-session lock is free — see ensureBrowserChrome. */
  mode?: 'headed' | 'headless';
}

export interface BrowserChromeHandle {
  /** Value for PLAYWRIGHT_MCP_CDP_ENDPOINT: Chrome's real
   *  webSocketDebuggerUrl (ws://<host>:<port>/devtools/browser/<id>) when the
   *  probe returned it, else the http:// endpoint — playwright resolves that
   *  to the ws URL itself. Never a BARE ws://host:port: playwright's
   *  urlToWSEndpoint passes ws* endpoints through verbatim and Chrome only
   *  accepts /devtools/* WS paths. */
  endpoint: string;
  /** chrome.exe pid when known — the spawned pid, or the stored pidfile pid
   *  on the reuse path. Undefined when reusing an endpoint PA has no pid
   *  record of. */
  pid?: number;
  port: number;
  /** True only when THIS call spawned Chrome. run.ts uses it to scope
   *  stopBrowserChrome to Chrome we actually started — a reused endpoint is
   *  left alone (it may be the operator's own debug Chrome). */
  startedByUs: boolean;
  /** The mode the returned Chrome is actually in: the requested mode on a
   *  fresh spawn, the running Chrome's detected mode on reuse. */
  mode: 'headed' | 'headless';
  /** Set when the caller asked for a different mode than the running
   *  Chrome's and a relaunch was not safe (browser-session lock held, or
   *  the port stayed answered by a Chrome stopBrowserChrome does not own).
   *  `mode` then reports the EXISTING mode, not the requested one. */
  modeOverride?: boolean;
}

interface PidFileRecord {
  pid: number;
  spawnedPid?: number;  // the chrome.exe bootstrapper pid we spawned, when it differs from pid (the socket owner)
  port?: number;
  profileDir?: string;
  startedAt?: string;
}

function parsePidFile(raw: string): PidFileRecord | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && Number.isInteger(obj.pid)) return obj as PidFileRecord;
  } catch {
    // tolerate a bare-integer pidfile
  }
  const pid = parseInt(trimmed, 10);
  return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
}

async function readStoredLivePid(d: ResolvedDeps): Promise<number | undefined> {
  try {
    const rec = parsePidFile(await readFile(d.pidFilePath, 'utf8'));
    if (rec && (await d.isAlive(rec.pid))) return rec.pid;
  } catch {
    // no pidfile / unreadable — treated as "no recorded pid"
  }
  return undefined;
}

/** Path comparison tolerant of slash direction, quoting and case — Chrome
 *  echoes the --user-data-dir arg verbatim in its cmdline, but callers may
 *  pass either separator and the arg may arrive quoted. The marker must end
 *  at a boundary (end of cmdline, whitespace, or a path slash for a trailing
 *  separator): a prefix-substring hit on a SIBLING dir (`browser-profile2`)
 *  is not our Chrome — the new kill sweep makes that distinction load-bearing. */
function profileMarkerMatches(cmdline: string, profileDir: string): boolean {
  const norm = (s: string) => s.replace(/["']/g, '').replace(/\\/g, '/').toLowerCase();
  const marker = `user-data-dir=${norm(profileDir)}`;
  const hay = norm(cmdline);
  const idx = hay.indexOf(marker);
  if (idx === -1) return false;
  const next = hay.charAt(idx + marker.length);
  return next === '' || next === '/' || /\s/.test(next);
}

/** Running chrome.exe pids whose cmdline carries --user-data-dir=<profileDir>
 *  (path-normalized — see profileMarkerMatches). WP-A2: the PA profile is
 *  shared with Playwright MCP's pipe-debugging Chromes, whose orphans hold
 *  the profile without ever binding a DevTools port. The profile marker is
 *  the ownership boundary — the operator's personal Chrome uses a different
 *  user-data-dir and is never listed. */
export async function chromePidsOnProfile(
  profileDir: string,
  deps?: BrowserLauncherDeps,
): Promise<number[]> {
  const d = resolveDeps(deps);
  const pids: number[] = [];
  for (const { pid, cmdline } of await d.listChromeCmdlines()) {
    if (Number.isInteger(pid) && profileMarkerMatches(cmdline, profileDir)) pids.push(pid);
  }
  return pids;
}

/** Reuse-path heal: when the answering Chrome isn't recorded (or its recorded
 *  pid is dead — e.g. an older pidfile named the exited bootstrapper), resolve
 *  the socket owner and record it IF its cmdline proves it drives OUR profile.
 *  A foreign Chrome on our port with a different profile is never claimed —
 *  recording it would arm a later stopBrowserChrome against a browser that is
 *  not ours. */
async function healPidFromSocketOwner(d: ResolvedDeps, port: number, profileDir: string): Promise<number | undefined> {
  const owner = await d.cdpOwnerPid(port);
  if (!owner || !(await d.isAlive(owner))) return undefined;
  const cmdline = (await d.cmdline(owner)).trim();
  if (!cmdline || !profileMarkerMatches(cmdline, profileDir)) return undefined;
  await writePidFile(d, {
    pid: owner,
    port,
    profileDir,
    startedAt: new Date().toISOString(),
  }).catch(() => {});
  return owner;
}

async function writePidFile(d: ResolvedDeps, rec: PidFileRecord): Promise<void> {
  await mkdir(dirname(d.pidFilePath), { recursive: true });
  await writeFile(d.pidFilePath, JSON.stringify(rec) + '\n', 'utf8');
}

function endpointFromProbe(probe: VersionProbe, port: number): string {
  if (typeof probe.webSocketDebuggerUrl === 'string' && probe.webSocketDebuggerUrl.startsWith('ws')) {
    return probe.webSocketDebuggerUrl;
  }
  return `http://127.0.0.1:${port}`;
}

/** Chrome executable candidates, probed in order — never hardcoded to one
 *  path. PA_BROWSER_CHROME_PATH is the explicit override for machines whose
 *  Chrome lives somewhere nonstandard. */
export function chromeExecutableCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.PA_BROWSER_CHROME_PATH?.trim()) return [env.PA_BROWSER_CHROME_PATH.trim()];

  if (platform() === 'win32') {
    const suffix = join('Google', 'Chrome', 'Application', 'chrome.exe');
    return [
      join(env.PROGRAMFILES ?? 'C:\\Program Files', suffix),
      join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', suffix),
      join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), suffix),
    ];
  }
  if (platform() === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

export function findChromeExecutable(d: Pick<ResolvedDeps, 'fileExists'>, env?: NodeJS.ProcessEnv): string | undefined {
  return chromeExecutableCandidates(env).find((p) => d.fileExists(p));
}

/** The blackboard lock `pa run` holds for the whole run when a skill declares
 *  `exclusive_resource: browser-session` (run.ts's exclusiveLockKey shape —
 *  inlined here so this module stays import-cycle-free). `pa browser ensure`
 *  NEVER acquires it: a CLI that exits stops heartbeating and the row goes
 *  stale-and-purged within ~13 min regardless of Chrome's liveness (v4 spec
 *  S1). The lock is only READ here to decide whether a mode-mismatch
 *  relaunch is safe. */
const BROWSER_SESSION_LOCK = 'skill-exclusive:browser-session';

async function browserSessionLockHeld(): Promise<boolean> {
  try {
    return (await blackboard.getActiveLocks()).some((l) => l.resource === BROWSER_SESSION_LOCK);
  } catch {
    // Lock state unreadable: treat as held. Killing a Chrome a live `pa run`
    // is driving is worse than a worker retrying its ensure later.
    return true;
  }
}

function modeFromCmdline(cmdline: string): 'headed' | 'headless' {
  return cmdline.includes('--headless') ? 'headless' : 'headed';
}

/**
 * Ensure a Chrome is answering CDP on `port`, spawning PA's own if not.
 * Idempotent: an already-answering endpoint in the requested mode is reused
 * untouched (startedByUs false). On a mode mismatch the running Chrome is
 * only relaunched when the browser-session lock is free — while a `pa run`
 * holds it the existing mode is returned with modeOverride. On spawn, waits
 * for /json/version (default ~10s); a spawn that never answers is killed and
 * its pidfile removed before the throw — a half-up Chrome is never leaked to
 * the operator's desktop.
 *
 * Shared-profile contention contract (WP-A2): ~/.pa/browser-profile is shared
 * with Playwright MCP's own pipe-debugging Chromes — orphans are common. A
 * foreign holder accepts the spawned chrome.exe's hand-off, so the DevTools
 * port never binds and the spawn times out. When the timeout finds foreign
 * pids on the profile the error names them and points at `pa browser stop`,
 * which clears by profile marker rather than by pidfile.
 */
export async function ensureBrowserChrome(
  opts: EnsureBrowserChromeOptions,
  deps?: BrowserLauncherDeps,
): Promise<BrowserChromeHandle> {
  const d = resolveDeps(deps);
  const port = opts.port;
  const requestedMode = opts.mode ?? 'headed';

  const existing = await d.fetchVersion(port, 1500);
  if (existing) {
    const pid = (await readStoredLivePid(d)) ?? (await healPidFromSocketOwner(d, port, opts.profileDir));
    // Detect the running Chrome's mode from its cmdline. No recorded/healed
    // pid means we cannot inspect it — 'headed' is the honest default: a
    // Chrome PA launched has always been headed, and a foreign Chrome
    // without --headless on its cmdline is headed too.
    const runningMode = pid !== undefined ? modeFromCmdline((await d.cmdline(pid)).trim()) : 'headed';
    if (runningMode === requestedMode) {
      return {
        endpoint: endpointFromProbe(existing, port),
        pid,
        port,
        startedByUs: false,
        mode: runningMode,
      };
    }
    // Mode mismatch. Relaunching while a `pa run` browser-session skill holds
    // the lock would kill the Chrome mid-run — return the existing mode with
    // modeOverride so the caller knows it did NOT get what it asked for.
    if (await browserSessionLockHeld()) {
      logger.warn('browser-launcher', `Chrome on port ${port} is ${runningMode} but ${requestedMode} was requested — browser-session lock held, keeping existing mode`, {
        port, runningMode, requestedMode, pid,
      });
      return {
        endpoint: endpointFromProbe(existing, port),
        pid,
        port,
        startedByUs: false,
        mode: runningMode,
        modeOverride: true,
      };
    }
    await stopBrowserChrome(deps);
    // stopBrowserChrome only kills what the pidfile names (D6) — a foreign
    // Chrome it cannot claim keeps the port bound, and spawning on a bound
    // port would probe-answer against the OLD Chrome and lie about the mode.
    const still = await d.fetchVersion(port, 1500);
    if (still) {
      logger.warn('browser-launcher', `Chrome on port ${port} still answers after stop — cannot relaunch as ${requestedMode}, keeping ${runningMode}`, {
        port, runningMode, requestedMode, pid,
      });
      return {
        endpoint: endpointFromProbe(still, port),
        pid,
        port,
        startedByUs: false,
        mode: runningMode,
        modeOverride: true,
      };
    }
    // Lock free and the port is clear — fall through to spawn in the
    // requested mode.
  }

  const chromePath = findChromeExecutable(d);
  if (!chromePath) {
    throw new Error(
      `Chrome executable not found — probed: ${chromeExecutableCandidates().join(', ')}. ` +
        `Install Chrome or set PA_BROWSER_CHROME_PATH.`,
    );
  }

  await mkdir(opts.profileDir, { recursive: true });
  const headless = requestedMode === 'headless';
  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session=false',
    // AI-246 v3: pin the window so screencast frames are consistently
    // proportioned across runs — the PWA's live-pane view math assumes a
    // stable remote viewport size. Headed-only: meaningless in headless.
    ...(headless ? [] : ['--window-size=1280,800']),
    // WP-X (jev-browser-wingman spec § 0 RO-7): Chrome saves the window
    // position in the profile. After an off-screen session (wingman's
    // default window mode) a launch WITHOUT an explicit position reopens
    // mostly off-screen. Always pass an on-screen position on headed
    // launches; headless has no placed window.
    ...(headless ? [] : ['--window-position=40,40']),
    // AI-246: the CDP screencast (Page.startScreencast) pauses with
    // Page.screencastVisibilityChanged {visible:false} when Chrome backgrounds
    // an occluded window, and Chrome discards/freezes idle page targets after
    // ~30s on Windows — both kill the bridge mid-stream. These flags keep the
    // page painting and the target alive regardless of window visibility or
    // idle state. Mirrors the flags Playwright's launchPersistentContext passes
    // by default for the same reason (verified against a Playwright launch arg
    // capture, 2026-09-14 thread 78b2cfe).
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,TabDiscarding,TabFreezing,IntensiveWakeUpThrottling',
  ];
  // detached + unref: PA exiting must not take the operator's visible browser
  // down. windowsHide:false is deliberate — this IS the operator's browser.
  const child = d.spawnProcess(chromePath, args, { detached: true, stdio: 'ignore', windowsHide: false });
  if (typeof child.pid !== 'number' || child.pid <= 0) {
    throw new Error(`spawn(${chromePath}) returned no pid — Chrome did not start`);
  }
  const pid = child.pid;
  let spawnError: Error | undefined;
  child.on('error', (err) => {
    spawnError = err;
  });
  child.unref();
  await writePidFile(d, { pid, port, profileDir: opts.profileDir, startedAt: new Date().toISOString() });

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const cleanupSpawn = async () => {
    try {
      d.killTree(pid);
    } catch {}
    // Awaited: the contract is "pidfile removed before the throw" — a
    // fire-and-forget unlink lets a caller's immediate fs check observe the
    // file still present (observed as a macOS CI flake, 2026-09-20).
    await unlink(d.pidFilePath).catch(() => {});
  };
  while (Date.now() < deadline) {
    if (spawnError) {
      await cleanupSpawn();
      throw new Error(`Chrome spawn failed: ${spawnError.message}`);
    }
    const probe = await d.fetchVersion(port, 1500);
    if (probe) {
      // The spawned chrome.exe is a bootstrapper that exits once the real
      // browser process is up — record the pid that actually OWNS the listen
      // socket, or stopBrowserChrome would find a dead pid and skip the kill
      // (observed live 2026-09-14: spawned pid dead, port still answering).
      const owner = await d.cdpOwnerPid(port);
      if (owner && owner !== pid) {
        await writePidFile(d, { pid: owner, spawnedPid: pid, port, profileDir: opts.profileDir, startedAt: new Date().toISOString() }).catch(() => {});
      }
      const recordedPid = owner ?? pid;
      logger.info('browser-launcher', `Chrome up on CDP port ${port}`, { pid: recordedPid, spawnedPid: pid, port, profileDir: opts.profileDir, mode: requestedMode });
      return { endpoint: endpointFromProbe(probe, port), pid: recordedPid, port, startedByUs: true, mode: requestedMode };
    }
    await d.sleep(pollIntervalMs);
  }
  await cleanupSpawn();
  // The usual cause of a spawn that never answers: a foreign Chrome already
  // holds our profile — the spawned chrome.exe hands off to it and exits, so
  // the DevTools port never binds (live-smoke 2026-09-15: an orphaned
  // Playwright MCP pipe-Chrome held browser-profile; ensure timed out
  // opaquely). Name the holders so the operator knows the fix.
  const holders = (await chromePidsOnProfile(opts.profileDir, d)).filter((p) => p !== pid);
  if (holders.length > 0) {
    throw new Error(
      `Chrome failed to answer on port ${port} — profile ${opts.profileDir} ` +
        `is already held by Chrome pid(s) ${holders.join(', ')} without a debug port ` +
        `(likely an orphaned Playwright MCP Chrome). Run \`pa browser stop\` to clear them, then retry.`,
    );
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for Chrome DevTools at http://127.0.0.1:${port}/json/version (pid ${pid})`);
}

/**
 * Kill every Chrome PA owns, by identity — never by image name (D6):
 *  1. the pidfile's recorded pid (skipped when dead, or alive but positively
 *     not a debug-port Chrome — a recycled pid),
 *  2. the CDP socket owner, when the record named a dead bootstrapper and the
 *     port still answers,
 *  3. ANY chrome.exe whose cmdline carries --user-data-dir=<PA profile> —
 *     WP-A2: foreign/orphaned holders (Playwright MCP's pipe Chromes) have no
 *     pidfile entry but wedge `ensure` by accepting the spawn hand-off; the
 *     profile marker is the ownership proof, and the operator's personal
 *     Chrome (different user-data-dir) is never listed.
 * The pidfile is removed in every case — a stale record only does harm.
 * Returns the list of pids actually killed (empty when nothing was).
 */
export async function stopBrowserChrome(deps?: BrowserLauncherDeps): Promise<number[]> {
  const d = resolveDeps(deps);
  let rec: PidFileRecord | undefined;
  try {
    rec = parsePidFile(await readFile(d.pidFilePath, 'utf8'));
  } catch {
    // no pidfile — the profile sweep below still runs: foreign holders have
    // no pidfile entry by definition.
  }
  await unlink(d.pidFilePath).catch(() => {});

  const killed: number[] = [];

  // Recycled-pid guard: a live pid whose cmdline positively shows it is NOT a
  // debug Chrome is not ours to kill. An empty cmdline (dead handle / query
  // flake) stays killable — the pidfile's authority stands.
  const tryKill = async (pid: number): Promise<boolean> => {
    if (!(await d.isAlive(pid))) return false;
    const cmdline = (await d.cmdline(pid)).trim();
    if (cmdline && !(cmdline.toLowerCase().includes('chrome') && cmdline.includes('--remote-debugging-port'))) {
      logger.warn('browser-launcher', `browser-chrome.pid pid ${pid} is alive but not a debug Chrome — skipping kill (recycled pid)`, {
        pid,
        cmdline: cmdline.slice(0, 200),
      });
      return false;
    }
    d.killTree(pid);
    logger.info('browser-launcher', `Stopped browser-session Chrome (pid ${pid})`, { pid });
    return true;
  };

  if (rec && Number.isInteger(rec.pid) && rec.pid > 0 && (await tryKill(rec.pid))) {
    killed.push(rec.pid);
  }

  // Self-heal: if the recorded pid was a dead bootstrapper (pre-owner-pid
  // pidfiles) the real browser may still hold the port — resolve the socket
  // owner and kill it too. Still PID-tree only; D6 holds.
  if (rec?.port) {
    await d.sleep(800); // let the fire-and-forget taskkill actually land
    if (await d.fetchVersion(rec.port, 800)) {
      const owner = await d.cdpOwnerPid(rec.port);
      if (owner && owner !== rec.pid && (await tryKill(owner))) {
        logger.warn('browser-launcher', `CDP port ${rec.port} outlived recorded pid ${rec.pid} — killed socket-owner pid ${owner}`);
        killed.push(owner);
      }
    }
  }

  // Profile sweep (WP-A2): every chrome.exe on the PA profile is ours to
  // kill — the orphaned Playwright MCP Chromes (pipe flag, no port, no
  // pidfile entry) that wedge `ensure` live here. Re-verify the marker at
  // kill time: the enumeration can come from a ≤300ms-stale snapshot, and a
  // recycled pid must never take the taskkill aimed at the dead Chrome.
  const profileDir = rec?.profileDir ?? join(paHome(), 'browser-profile');
  for (const pid of await chromePidsOnProfile(profileDir, d)) {
    if (killed.includes(pid)) continue;
    if (!(await d.isAlive(pid))) continue;
    if (!profileMarkerMatches((await d.cmdline(pid)).trim(), profileDir)) continue;
    d.killTree(pid);
    logger.info('browser-launcher', `Stopped profile-holding Chrome (pid ${pid})`, { pid, profileDir });
    killed.push(pid);
  }
  return killed;
}

/**
 * One-shot helper for run.ts: ensure Chrome, then build the worker env the
 * AI-246 contract pins — PLAYWRIGHT_MCP_CDP_ENDPOINT (Playwright MCP attaches
 * instead of launching), PA_BROWSER_CDP_PORT + VOICE_INBOX_PORT +
 * PA_SCREENCAST_INGEST_TOKEN for the worker-spawned screencast bridge (WP-C).
 * The ingest token is only injected when configured — the bridge treats
 * absence as "fail fast", so an unset key warns loudly here instead of
 * silently shipping an unusable env.
 */
export async function buildBrowserSessionEnv(
  config: Pick<PaConfig, 'browser' | 'voice_inbox'>,
  deps?: BrowserLauncherDeps,
): Promise<{ env: Record<string, string>; startedByUs: boolean }> {
  const port = config.browser?.cdp_port ?? DEFAULT_BROWSER_CDP_PORT;
  const handle = await ensureBrowserChrome({ port, profileDir: join(paHome(), 'browser-profile') }, deps);
  const env: Record<string, string> = {
    PLAYWRIGHT_MCP_CDP_ENDPOINT: handle.endpoint,
    PA_BROWSER_CDP_PORT: String(port),
    VOICE_INBOX_PORT: String(config.voice_inbox?.port ?? DEFAULT_VOICE_INBOX_PORT),
  };
  const token = config.voice_inbox?.screencast_ingest_token;
  if (token) {
    env.PA_SCREENCAST_INGEST_TOKEN = token;
  } else {
    logger.warn(
      'browser-launcher',
      'voice_inbox.screencast_ingest_token is not set in ~/.pa/config.yaml — worker screencast bridges cannot authenticate; set it to enable live-view ingest',
    );
  }
  return { env, startedByUs: handle.startedByUs };
}

/**
 * AI-246 v4 (spec S3): the env overlay the bot merges into EVERY worker
 * dispatch so the CDP vars are present before the worker decides to use a
 * browser. Unlike buildBrowserSessionEnv this NEVER launches Chrome — the
 * worker calls `pa browser ensure` itself — so PLAYWRIGHT_MCP_CDP_ENDPOINT
 * is the http:// form Playwright resolves lazily (spec S2: a bare ws:// is
 * never valid). No token here either: the screencast bridge reads
 * screencast_ingest_token from config itself (WP-C).
 */
export function browserSessionEnvOverlay(
  config: Pick<PaConfig, 'browser' | 'voice_inbox'>,
): Record<string, string> {
  const port = config.browser?.cdp_port ?? DEFAULT_BROWSER_CDP_PORT;
  return {
    PLAYWRIGHT_MCP_CDP_ENDPOINT: `http://127.0.0.1:${port}`,
    PA_BROWSER_CDP_PORT: String(port),
    VOICE_INBOX_PORT: String(config.voice_inbox?.port ?? DEFAULT_VOICE_INBOX_PORT),
  };
}
