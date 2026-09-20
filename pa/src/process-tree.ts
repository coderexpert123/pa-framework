import { exec } from 'child_process';
import { platform } from 'os';
import { promisify } from 'util';

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>;

// Low-level exec runner backing the DEFAULT (no execFn injected) snapshot path.
// Overridable ONLY for tests. ExecFn deliberately erases exec() options
// (timeout, windowsHide) so a mock and the real exec function share one shape —
// which means no test can see, from that shape alone, whether a given call
// carried those options. _rawExec is the seam: a test swaps it to capture the
// options argument directly and prove the default path is wired to the timed,
// hidden exec — see the 4th-storm-variant note below.
export type RawExec = (cmd: string, options: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
const realRawExec: RawExec = promisify(exec) as unknown as RawExec;
let _rawExec: RawExec = realRawExec;
export function _setRawExecForTest(fn: RawExec | null): void {
  _rawExec = fn ?? realRawExec;
}

// Hidden exec wrapper for Windows — prevents console window flash on every spawn
const execHidden: ExecFn = (cmd) => _rawExec(cmd, { windowsHide: true, timeout: 15_000, killSignal: 'SIGKILL' });
// timeout (2026-08-31): a saturated WMI makes Get-CimInstance hang forever, and
// exec's default timeout is NONE — stuck snapshot queries then accumulate one
// wedged powershell per pa process and hold WMI hostage machine-wide (third
// storm variant, 19:30 IST: 120 zombie shells, WMI dead, both lock-heartbeat
// timers stalled). 15s hard cap → stuck child killed, empty snapshot returned,
// next heartbeat retries; degradation instead of deadlock.
//
// 4th storm variant (2026-09-12): the timed/hidden wrapper above and the 300ms
// cache below both already existed, but neither was actually load-bearing in
// production — "the mechanism exists somewhere in the file" is not the same
// claim as "the default call path uses it". getProcessSnapshot's default fetch
// called the PLAIN untimed/unhidden promisified exec instead of execHidden, and
// its cache-bypass check (`if (execFn) return buildSnapshotFromQuery(execFn)`)
// tripped for ANY truthy execFn — including the `= execHidden` DEFAULT
// PARAMETER value that getDescendantPids/getCommandLines/hasChildProcesses all
// carry, so every production caller bypassed the cache and ran untimed queries.
// With 6+ workers live and a 30s heartbeat each, this stacked 67-127 concurrent
// Get-CimInstance shells (3.8-6.4GB RAM, ~1.2s/query serialized by WMI, some
// living up to 4 minutes). Fixed by (1) routing the default path through
// execHidden, (2) treating `execFn === undefined || execFn === execHidden` as
// "not genuinely injected" so the cache actually applies to production's
// default-parameter calls, (3) coalescing concurrent default-path snapshot
// requests into one in-flight promise, and (4) a heartbeat re-entrancy guard in
// worker-exec.ts so a slow tick can't stack a second one on top of itself.
// Next reader: verify the actual call site every time, not just that the right
// primitive exists in the file.

// Raw C0 control characters (U+0000 through U+001F) are ILLEGAL inside JSON
// strings, but PowerShell's ConvertTo-Json leaves some of them unescaped in its
// output (incident 2026-09-03: a bash wrapper's argv carried a mangled arrow
// glyph as a raw SUB byte; ONE poisoned argv string made JSON.parse throw and
// the whole snapshot degrade to an empty map — which then got cached for the
// TTL — so every liveness read machine-wide saw an empty machine for as long as
// the carrier process lived, blinding idle-kill, orphan-sweep and bg-leak).
// The character class is built at RUNTIME from char codes: a literal escape in
// source risks the file-writing tooling decoding it into a real control byte
// (repo lesson 2026-08-31).
const C0_CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}]`,
  'g'
);

/**
 * JSON.parse for process-listing payloads, tolerating raw C0 control characters.
 * The first parse is plain JSON.parse (the healthy path stays byte-identical);
 * only on a throw does the sanitized retry run. Stripping C0 chars cannot
 * corrupt valid JSON: inside strings they are illegal anyway, and outside
 * strings they are optional whitespace. Legal ESCAPED forms (backslash-n,
 * backslash-u001a — two characters each, not raw bytes) are untouched.
 */
export function parseProcessJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(raw.replace(C0_CONTROL_CHARS_RE, ''));
  }
}

const BATCH_SIZE = 50;

// Snapshot cache to avoid per-PID OS queries on hot paths (heartbeat, idle checks)
const SNAPSHOT_TTL_MS = 300;
export interface ProcessRecord {
  parentPid: number;
  cmdline: string;
  /** Process creation time in epoch ms when the platform query provides it
   *  (Windows: Win32_Process.CreationDate; POSIX: etimes-derived). Absent on
   *  callers/tests that build synthetic records — consumers must tolerate
   *  undefined (a missing timestamp proves nothing, never excludes). */
  createdMs?: number;
}
let _cachedSnapshot: Map<number, ProcessRecord> | null = null;
let _snapshotExpiresAt = 0;
// In-flight default-path snapshot query. Concurrent default callers (including
// a `fresh: true` caller arriving while one is already running) await this
// SAME promise instead of each spawning their own Get-CimInstance shell.
let _inFlightSnapshot: Promise<Map<number, ProcessRecord>> | null = null;

/** Test-only: clear cache + in-flight state so cases don't leak into each other. */
export function _resetSnapshotCacheForTest(): void {
  _cachedSnapshot = null;
  _snapshotExpiresAt = 0;
  _inFlightSnapshot = null;
}

/**
 * Get a process-tree snapshot in ONE OS query. Returns a map of PID→{parentPid,cmdline}.
 * Results are cached for 300ms to make consecutive heartbeats/idle checks essentially free.
 * When a GENUINELY injected execFn is passed (tests — anything other than the
 * `execHidden` default-parameter value production code carries), bypass the
 * cache/coalescing entirely to preserve call-count semantics. Treating the
 * `execHidden` default-parameter value itself as "injected" was the 4th storm
 * variant's root cause (see execHidden's header comment above) — every
 * production caller using the default parameter was bypassing the cache.
 * `fresh: true` forces a new query AND refreshes the cache — for DECISION points
 * (kill/extend, idle-kill) where a ≤300ms-stale read can see a just-exited child
 * as still present and wrongly extend instead of killing (2026-08-31). A fresh
 * call arriving while another default-path query is already in flight coalesces
 * onto it rather than issuing a second one.
 *
 * Exported for bus-queue's termKey liveness check (AI-272): a registry row's
 * recorded pid is probed against this same snapshot — no per-PID queries.
 */
export async function getProcessSnapshot(execFn?: ExecFn, fresh = false): Promise<Map<number, ProcessRecord>> {
  const now = Date.now();

  // Genuinely injected execFn (tests) — bypass cache/coalescing entirely.
  if (execFn && execFn !== execHidden) {
    return buildSnapshotFromQuery(execFn);
  }

  // Check cache for default path
  if (!fresh && _cachedSnapshot && now < _snapshotExpiresAt) {
    return _cachedSnapshot;
  }

  // Cache miss, expired, or fresh — coalesce concurrent default-path callers
  // onto ONE in-flight query instead of each spawning their own.
  if (_inFlightSnapshot) {
    return _inFlightSnapshot;
  }
  _inFlightSnapshot = (async () => {
    try {
      const snapshot = await buildSnapshotFromQuery(execHidden);
      _cachedSnapshot = snapshot;
      _snapshotExpiresAt = Date.now() + SNAPSHOT_TTL_MS;
      return snapshot;
    } finally {
      _inFlightSnapshot = null;
    }
  })();
  return _inFlightSnapshot;
}

async function buildSnapshotFromQuery(execFn: ExecFn): Promise<Map<number, ProcessRecord>> {
  try {
    let records: Map<number, ProcessRecord>;

    if (platform() === 'win32') {
      const { stdout } = await execFn(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,@{n='CreatedMs';e={if ($_.CreationDate) {[DateTimeOffset]$_.CreationDate.ToUnixTimeMilliseconds()} else {$null}}} | ConvertTo-Json -Compress"`
      );
      const raw = stdout.trim();
      if (!raw) return new Map();
      const data = parseProcessJson(raw);
      const arr = Array.isArray(data) ? data : [data];
      records = new Map();
      for (const p of arr) {
        if (typeof p.ProcessId === 'number') {
          records.set(p.ProcessId, {
            parentPid: p.ParentProcessId as number,
            cmdline: p.CommandLine ?? '',
            ...(typeof p.CreatedMs === 'number' ? { createdMs: p.CreatedMs } : {}),
          });
        }
      }
    } else {
      const { stdout } = await execFn('ps -eo pid=,ppid=,etimes= --no-headers 2>/dev/null || ps -eo pid,ppid');
      const nowMs = Date.now();
      records = new Map();
      for (const line of stdout.trim().split('\n')) {
        if (!line.trim()) continue;
        const [pidStr, ppidStr, etimesStr] = line.trim().split(/\s+/);
        const pid = parseInt(pidStr, 10);
        const ppid = parseInt(ppidStr, 10);
        if (!isNaN(pid) && !isNaN(ppid)) {
          const etimes = parseInt(etimesStr, 10);
          records.set(pid, {
            parentPid: ppid,
            cmdline: '',
            ...(isNaN(etimes) ? {} : { createdMs: nowMs - etimes * 1000 }),
          });
        }
      }
    }

    return records;
  } catch (err: any) {
    if (err.code === 'ENOENT') warnProcessTreeUnavailable(platform() === 'win32' ? 'powershell' : 'ps', 'getProcessSnapshot');
    else if (err instanceof SyntaxError) warnSnapshotUnparseable(err);
    return new Map();
  }
}

// A snapshot that STILL fails to parse after C0 sanitization is genuine
// corruption. Warn once so a blinded machine is observable instead of silently
// reading as empty — that silent-empty was the 2026-09-03 incident's
// detection gap (~40 min of machine-wide blindness before anyone looked).
let _warnedUnparseableSnapshot = false;
function warnSnapshotUnparseable(err: SyntaxError): void {
  if (_warnedUnparseableSnapshot) return;
  _warnedUnparseableSnapshot = true;
  console.warn(
    `[pa/process-tree] process snapshot still unparseable after control-char sanitize — ` +
    `liveness reads degrade to EMPTY until the payload is clean: ${err.message}`
  );
}

/**
 * Build parent→children adjacency map from the snapshot cache.
 * Used by getDescendantPids, getChildPids, hasChildProcesses.
 */
function buildAdjacencyMap(snapshot: Map<number, ProcessRecord>): Map<number, number[]> {
  const childMap = new Map<number, number[]>();
  for (const [pid, record] of snapshot) {
    if (!childMap.has(record.parentPid)) childMap.set(record.parentPid, []);
    childMap.get(record.parentPid)!.push(pid);
  }
  return childMap;
}

// Emit at most one warning per process lifetime when process-listing tools are absent
let _warnedProcessTree = false;
function warnProcessTreeUnavailable(tool: string, fn: string): void {
  if (_warnedProcessTree) return;
  _warnedProcessTree = true;
  console.warn(
    `[pa/process-tree] ${tool} not found. Child-process tracking disabled. ` +
    `To add support for this system, implement a new branch in pa/src/process-tree.ts:${fn}() ` +
    `using your platform's process-listing tool.`
  );
}

export async function getChildPids(pid: number, execFn?: ExecFn): Promise<number[]> {
  const snapshot = await getProcessSnapshot(execFn);
  const adjacency = buildAdjacencyMap(snapshot);
  return adjacency.get(pid) ?? [];
}

export async function hasChildProcesses(pid: number, isShell: boolean = false, execFn?: ExecFn, fresh = false): Promise<boolean> {
  const snapshot = await getProcessSnapshot(execFn, fresh);
  const adjacency = buildAdjacencyMap(snapshot);
  const children = adjacency.get(pid) ?? [];

  if (children.length === 0) return false;

  if (isShell) {
    // If we are spawning via a shell, the direct child is the worker agent.
    // We only count it as "having active children" if the agent itself has children (e.g. running a tool).
    for (const childPid of children) {
      const grandchildren = adjacency.get(childPid) ?? [];
      if (grandchildren.length > 0) return true;
    }
    // POSIX sh -c exec-collapse (macOS CI fail 2026-09-20): when `pid` is a
    // shell that exec'd its single-command payload, `pid` itself IS the
    // worker and `children` are its tools — the depth-2 walk above probes
    // the TOOLS' children and wrongly reports "no liveness", so the
    // no-progress guard killed live workers on macOS (/bin/sh = bash, which
    // execs `-c` payloads; dash on ubuntu does not). Probe pid's own
    // cmdline: no longer a shell → children are the worker's tools → alive.
    if (platform() !== 'win32' && children.length > 0) {
      try {
        const own = (await getCommandLines([pid], execFn)).get(pid) ?? '';
        const argv0 = (own.trim().split(/\s+/)[0] ?? '').split('/').pop() ?? '';
        if (argv0 && !/^(?:-?\w*sh|cmd(?:\.exe)?|command)$/i.test(argv0)) return true;
      } catch { /* fall through — a dead pid reads as no liveness anyway */ }
    }
    return false;
  }

  return true;
}

/**
 * Return ALL descendants (grandchildren, great-grandchildren, etc.) of a process.
 * Issues ONE OS-level query and BFS in memory — O(total processes), not O(tree depth).
 */
export async function getDescendantPids(
  workerPid: number,
  execFn: ExecFn = execHidden
): Promise<Array<{ pid: number; parentPid: number }>> {
  const snapshot = await getProcessSnapshot(execFn);
  const adjacency = buildAdjacencyMap(snapshot);

  // BFS from workerPid — collect all descendants
  const result: Array<{ pid: number; parentPid: number }> = [];
  const queue: Array<{ pid: number; parent: number }> = [{ pid: workerPid, parent: 0 }];
  const visited = new Set<number>([workerPid]);

  while (queue.length > 0) {
    const { pid: current } = queue.shift()!;
    for (const childPid of adjacency.get(current) ?? []) {
      if (!visited.has(childPid)) {
        visited.add(childPid);
        result.push({ pid: childPid, parentPid: current });
        queue.push({ pid: childPid, parent: current });
      }
    }
  }

  return result;
}

/**
 * Return the ancestor chain of a pid, nearest parent first. One OS-level
 * query (the shared snapshot), then an in-memory parent walk — O(tree
 * depth). Stops at a missing record or a parent cycle.
 */
export async function getAncestorPids(
  pid: number,
  execFn?: ExecFn,
): Promise<number[]> {
  const snapshot = await getProcessSnapshot(execFn);
  const result: number[] = [];
  const seen = new Set<number>([pid]);
  let cur = snapshot.get(pid)?.parentPid ?? 0;
  while (cur > 0 && !seen.has(cur)) {
    seen.add(cur);
    result.push(cur);
    cur = snapshot.get(cur)?.parentPid ?? 0;
  }
  return result;
}

/**
 * Verify that a pid genuinely belongs to a tracked process family before
 * killing or alerting on it. Two stale-PPID failure modes this defends
 * against (Windows ParentProcessId is set at spawn and NEVER updated — a
 * dead ancestor's pid can be reused by an unrelated process, and BFS then
 * mis-attributes unrelated processes, including system services, into the
 * tree — observed live 2026-09-18: 211 "descendants" incl. svchost /
 * WUDFHost / fontdrvhost on a skill-commit run):
 *
 *  - Phantom: the process PREDATES the run — createdMs < notBeforeMs proves
 *    it cannot be the worker's descendant regardless of what its recorded
 *    parentPid says. (skipped when createdMs is absent — no data, no verdict)
 *  - Pid reuse / mis-attribution: the pid's LIVE ancestor chain contains a
 *    process outside familyPids → it hangs off a foreign live process, not
 *    the dead worker tree. Real descendants' chains either reach rootPid or
 *    terminate at dead in-family ancestors (dead pids are absent from the
 *    snapshot — the walk stops there and stays "verified").
 *
 * `pid === rootPid` is always verified: the family's own root is expected to
 * have ancestors outside the family (the executor that spawned it).
 */
export function isVerifiedTreeMember(
  pid: number,
  rootPid: number | undefined,
  familyPids: ReadonlySet<number>,
  snapshot: ReadonlyMap<number, ProcessRecord>,
  notBeforeMs?: number,
): boolean {
  if (pid === rootPid) return true;
  const rec = snapshot.get(pid);
  if (!rec) return false; // absent from snapshot = already dead — nothing to verify or kill
  if (notBeforeMs !== undefined && rec.createdMs !== undefined && rec.createdMs < notBeforeMs) {
    return false;
  }
  const seen = new Set<number>([pid]);
  let cur = rec.parentPid ?? 0;
  while (cur > 0 && !seen.has(cur)) {
    if (cur === rootPid) return true;          // chain reached the family root
    if (!familyPids.has(cur)) return false;    // live ancestor outside the family → not ours
    seen.add(cur);
    const parentRec = snapshot.get(cur);
    if (!parentRec) return true;               // in-family ancestor is dead → chain ends inside the family
    cur = parentRec.parentPid ?? 0;
  }
  return true;
}

/** Partition pids into verified family members vs foreign/mis-attributed. */
export function partitionVerifiedTreeMembers(
  pids: number[],
  rootPid: number | undefined,
  trackedPids: ReadonlySet<number> | readonly number[],
  snapshot: ReadonlyMap<number, ProcessRecord>,
  notBeforeMs?: number,
): { verified: number[]; foreign: number[] } {
  const familyPids = new Set<number>(trackedPids);
  if (rootPid !== undefined) familyPids.add(rootPid);
  const verified: number[] = [];
  const foreign: number[] = [];
  for (const pid of pids) {
    (isVerifiedTreeMember(pid, rootPid, familyPids, snapshot, notBeforeMs) ? verified : foreign).push(pid);
  }
  return { verified, foreign };
}

/**
 * Fetch command-lines for a list of PIDs.
 * - win32: filters from cached snapshot (one OS query per 300ms refresh)
 * - POSIX: uses ps (no CommandLine available in snapshot)
 * - Injected execFn: bypasses cache and queries directly (preserves test call-count semantics)
 */
export async function getCommandLines(
  pids: number[],
  execFn: ExecFn = execHidden
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0) return result;

  // Injected execFn: bypass cache (tests need exact call counts)
  if (execFn !== execHidden) {
    return getCommandLinesDirect(pids, execFn);
  }

  if (platform() === 'win32') {
    // Use cached snapshot — filter for requested PIDs
    const snapshot = await getProcessSnapshot();
    for (const pid of pids) {
      const record = snapshot.get(pid);
      result.set(pid, record?.cmdline ?? '');
    }
    return result;
  }

  // POSIX: use ps (no CommandLine in snapshot)
  return getCommandLinesDirect(pids, execFn);
}

/**
 * Direct query path (bypasses cache). Used by injected execFn (tests) and POSIX.
 */
async function getCommandLinesDirect(
  pids: number[],
  execFn: ExecFn
): Promise<Map<number, string>> {
  const result = new Map<number, string>();

  for (let i = 0; i < pids.length; i += BATCH_SIZE) {
    const batch = pids.slice(i, i + BATCH_SIZE);
    try {
      if (platform() === 'win32') {
        const filter = batch.map(p => `ProcessId = ${p}`).join(' OR ');
        const { stdout } = await execFn(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`
        );
        const raw = stdout.trim();
        if (!raw) continue;
        const data = parseProcessJson(raw);
        const arr = Array.isArray(data) ? data : [data];
        for (const p of arr) {
          if (typeof p.ProcessId === 'number') {
            result.set(p.ProcessId, p.CommandLine ?? '');
          }
        }
      } else {
        const pidList = batch.join(',');
        const { stdout } = await execFn(`ps -o pid=,command= -p ${pidList}`);
        for (const line of stdout.trim().split('\n')) {
          if (!line.trim()) continue;
          const [pidStr, ...rest] = line.trim().split(/\s+/);
          const pid = parseInt(pidStr, 10);
          if (!isNaN(pid)) result.set(pid, rest.join(' '));
        }
      }
    } catch {
      // Batch failed — continue with next
    }
  }

  return result;
}

/**
 * Every live process whose command line contains `needle`, from the SAME cached
 * snapshot the other readers use (one OS query per TTL, coalesced, hidden+timed
 * exec on the default path — never a per-PID query). For decision points that
 * must find a process WITHOUT a registry pid to anchor on (voice-inbox
 * fallback's dead-dispatch arm scanning by dispatch id — the registry can lose
 * entries, so its absence must not by itself conclude "dead").
 * POSIX limitation: the shared snapshot's `ps -eo pid=,ppid=` query deliberately
 * carries no command lines, so this finds nothing there — callers must treat a
 * miss as "no scan evidence", never as positive evidence of death.
 */
export async function findProcessesByCommandLine(
  needle: string,
  execFn: ExecFn = execHidden
): Promise<Array<{ pid: number; cmdline: string }>> {
  if (!needle) return [];
  const snapshot = await getProcessSnapshot(execFn);
  const hits: Array<{ pid: number; cmdline: string }> = [];
  for (const [pid, record] of snapshot) {
    if (record.cmdline && record.cmdline.includes(needle)) {
      hits.push({ pid, cmdline: record.cmdline });
    }
  }
  return hits;
}

/**
 * Check which PIDs from a list are still alive.
 * - POSIX: uses process.kill(pid, 0) — no subprocess spawn.
 * - win32: checks cached snapshot (pid enumerated ≤300ms ago = alive; absent = dead).
 * - Injected execFn: bypasses cache and queries directly (preserves test call-count semantics).
 *
 * NOTE: killProcessTree does NOT use this function (it taskkills directly).
 * Any caller using areProcessesAlive for kill decisions should consider the 300ms staleness acceptable.
 */
export async function areProcessesAlive(
  pids: number[],
  execFn: ExecFn = execHidden
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();
  if (pids.length === 0) return result;

  // Injected execFn: bypass cache (tests need exact call counts)
  if (execFn !== execHidden && platform() === 'win32') {
    return areProcessesAliveDirect(pids, execFn);
  }

  if (platform() !== 'win32') {
    // POSIX: process.kill(pid, 0) is free — no spawn
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        result.set(pid, true);
      } catch (err: any) {
        result.set(pid, err.code === 'EPERM'); // EPERM → alive but not ours; ESRCH → dead
      }
    }
    return result;
  }

  // win32: use cached snapshot — presence check
  const snapshot = await getProcessSnapshot();
  for (const pid of pids) {
    result.set(pid, snapshot.has(pid));
  }
  return result;
}

/**
 * Direct query path for win32 (bypasses cache). Used by injected execFn (tests).
 */
async function areProcessesAliveDirect(
  pids: number[],
  execFn: ExecFn
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();

  for (let i = 0; i < pids.length; i += BATCH_SIZE) {
    const batch = pids.slice(i, i + BATCH_SIZE);
    try {
      const idList = batch.join(',');
      const { stdout } = await execFn(
        `powershell -NoProfile -Command "Get-Process -Id ${idList} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"`
      );
      const alivePids = new Set(
        stdout.trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))
      );
      for (const pid of batch) {
        result.set(pid, alivePids.has(pid));
      }
    } catch {
      for (const pid of batch) result.set(pid, false);
    }
  }

  return result;
}

/** Kill a process and its entire child tree. */
export function killProcessTree(pid: number): void {
  if (platform() === 'win32') {
    // taskkill /T kills the tree, /F forces it
    exec(`taskkill /T /F /PID ${pid}`, { windowsHide: true }, () => {});
  } else if (platform() === 'linux' || platform() === 'darwin') {
    try {
      process.kill(-pid, 'SIGTERM'); // negative PID = process group
    } catch {
      // process.kill(-pid) throws when pid isn't a process-group leader —
      // i.e. it was spawned without `detached: true` (setsid). That's the
      // common case for anything spawned with shell:true and no detached
      // flag, so silently swallowing this (the old behavior) meant /stop,
      // /steer, idle-kill, and orphan-reap all silently did nothing on
      // Linux/macOS. Fall back to walking the descendant tree and killing
      // each PID individually — void/fire-and-forget, so this runs as an
      // un-awaited async IIFE (all callers of killProcessTree expect sync).
      (async () => {
        // Capture descendants BEFORE killing the parent: a dead parent can
        // get its children reparented/reaped before we get to look them up.
        const descendants = await getDescendantPids(pid);
        try { process.kill(pid, 'SIGTERM'); } catch {}
        for (const { pid: childPid } of descendants) {
          try { process.kill(childPid, 'SIGTERM'); } catch {}
        }
      })();
    }
  } else {
    warnProcessTreeUnavailable('process group kill', 'killProcessTree');
    try { process.kill(pid, 'SIGTERM'); } catch {} // best-effort single-PID kill
  }
}
