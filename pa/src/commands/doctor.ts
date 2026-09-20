import { exec, execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import { delimiter, join } from 'path';
import { arch, cpus, platform, release, totalmem } from 'os';
import { paHome } from '../paths.js';
import { repoRootFromModule } from '../lib/git-root.js';
import { listForDoctor, type CoexistenceEntrySummary } from '../lib/coexistence.js';

/**
 * `pa doctor [--json] [--text]` — detect and emit a machine profile as JSON
 * (default) or a human table (--text). Read-only: every probe only reads or
 * spawns a version/help query; nothing on this machine is written.
 *
 * Probe contract: every probe is individually wrapped and degrades to
 * 'unknown'/false — a probe failure NEVER throws and never fails the command.
 * Total runtime is bounded well under 30 s (slow probes carry their own
 * timeouts and the independent ones run concurrently).
 *
 * Generalization substrate: downstream tooling keys off `derivedProfile`
 * (resourceClass / diskClass / suggestedSerializeSuites) instead of re-poking
 * the OS, so the thresholds live HERE as named constants.
 */

export type SsdLikely = boolean | 'unknown';
export type SchedulerBackend = 'task-scheduler' | 'cron' | 'launchd' | 'unknown';
export type ResourceClass = 'low' | 'mid' | 'high';
export type DiskClass = 'hdd' | 'ssd' | 'unknown';

export interface DiskEntry {
  mount: string;
  gb: number;
  /** Machine-level conservative spindle evidence (see machineDiskVerdict):
   *  true = confirmed non-rotational media, false = a rotational disk IS
   *  present, 'unknown' = could not tell. On non-Windows this is always
   *  'unknown' (the rotational flag comes from Get-PhysicalDisk). */
  ssdLikely: SsdLikely;
}

export interface WorkerEntry {
  name: string;
  available: boolean;
  version?: string;
}

export interface ProbeResults {
  os: { platform: string; release: string; arch: string };
  shell: { powershell: boolean; pwsh: boolean; bash: boolean };
  cpus: number;
  memTotalBytes: number;
  disk: DiskEntry[];
  paHome: string;
  paths: { repoRoot: string; nodeVersion: string };
  schedulerBackend: SchedulerBackend;
  /** true = api.telegram.org answered a HEAD directly; false = the probe
   *  errored/timed out; 'unknown' = no fetch implementation. */
  telegramDirect: boolean | 'unknown';
  workers: WorkerEntry[];
  /** Entries PA wrote to the user's CLI configs per the coexistence registry
   *  (Wave C WP-C2). Empty on a machine PA has not modified; a registry read
   *  failure degrades to [] (probe-degrades-to-unknown contract). */
  coexistence: CoexistenceEntrySummary[];
}

export interface DerivedProfile {
  resourceClass: ResourceClass;
  diskClass: DiskClass;
  suggestedSerializeSuites: boolean;
}

export type MachineProfile = ProbeResults & { derivedProfile: DerivedProfile };

// resourceClass thresholds (cpus/mem). Deliberate named constants, not knobs:
// doctor is read-only detection and downstream consumers key off the CLASS,
// not the raw numbers.
const LOW_CPUS = 2;
const LOW_MEM_BYTES = 4 * 1024 ** 3;
const HIGH_CPUS = 8;
const HIGH_MEM_BYTES = 16 * 1024 ** 3;

export function resourceClassFor(cpuCount: number, memTotalBytes: number): ResourceClass {
  if (cpuCount <= LOW_CPUS || memTotalBytes <= LOW_MEM_BYTES) return 'low';
  if (cpuCount >= HIGH_CPUS && memTotalBytes >= HIGH_MEM_BYTES) return 'high';
  return 'mid';
}

/**
 * Machine-level disk class from per-mount spindle evidence. One CONFIRMED
 * rotational disk anywhere => 'hdd' (the machine has a spindle, whatever else
 * it has); all mounts confirmed non-rotational => 'ssd'; otherwise (nothing
 * probed, probe failed, or only partial evidence) => 'unknown'.
 */
export function diskClassFor(disk: DiskEntry[]): DiskClass {
  if (disk.length === 0) return 'unknown';
  if (disk.some((d) => d.ssdLikely === false)) return 'hdd';
  if (disk.every((d) => d.ssdLikely === true)) return 'ssd';
  return 'unknown';
}

export function deriveProfile(p: ProbeResults): DerivedProfile {
  const diskClass = diskClassFor(p.disk);
  return {
    resourceClass: resourceClassFor(p.cpus, p.memTotalBytes),
    diskClass,
    suggestedSerializeSuites: diskClass === 'hdd',
  };
}

export function buildProfile(p: ProbeResults): MachineProfile {
  return { ...p, derivedProfile: deriveProfile(p) };
}

// ---------------------------------------------------------------------------
// Probe plumbing
// ---------------------------------------------------------------------------

const WORKER_PROBE_TIMEOUT_MS = 5000;
const TELEGRAM_PROBE_TIMEOUT_MS = 5000;
// The physical-disk probe loads PowerShell's Storage module — cold starts
// measured 3 s standalone but >10 s on a busy machine, so this is the one
// probe with a retry (2x this budget = 24 s, still inside the 30 s command cap).
const DISK_PROBE_TIMEOUT_MS = 12000;

// The four fleet CLIs doctor reports on, in failover-chain order.
const FLEET_CLIS = ['claude', 'zclaude', 'agy', 'codex'] as const;

interface ProbeOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Shell-routed probe (resolves .cmd shims on Windows). Resolves, never
 *  rejects; `ok` is the child's exit status under the timeout. */
function shellProbe(command: string, timeoutMs: number): Promise<ProbeOutput> {
  return new Promise((resolve) => {
    exec(command, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

/** Direct argv probe (no cmd.exe layer, so no quoting hazards). Resolves,
 *  never rejects. */
function toolProbe(cmd: string, args: string[], timeoutMs: number): Promise<ProbeOutput> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

// PATH scan for tool availability — no spawns, so shell/scheduler probes are
// effectively free. Well-known Windows locations cover tools installed but
// not on PATH.
const WIN_KNOWN_TOOLS: Record<string, string> = {
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  schtasks: 'C:\\Windows\\System32\\schtasks.exe',
  bash: 'C:\\Program Files\\Git\\bin\\bash.exe',
};

function findOnPath(name: string): string | null {
  const pathVar = process.env.PATH || process.env.Path || '';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here — keep scanning
      }
    }
  }
  return null;
}

function toolAvailable(name: string): boolean {
  if (findOnPath(name) !== null) return true;
  const known = process.platform === 'win32' ? WIN_KNOWN_TOOLS[name] : undefined;
  return known !== undefined && existsSync(known);
}

function probeShells(): ProbeResults['shell'] {
  return {
    powershell: toolAvailable('powershell'),
    pwsh: toolAvailable('pwsh'),
    bash: toolAvailable('bash'),
  };
}

function detectSchedulerBackend(): SchedulerBackend {
  switch (process.platform) {
    case 'win32':
      return toolAvailable('schtasks') ? 'task-scheduler' : 'unknown';
    case 'darwin':
      return (existsSync('/bin/launchctl') || existsSync('/sbin/launchd')) ? 'launchd' : 'unknown';
    default:
      return toolAvailable('crontab') ? 'cron' : 'unknown';
  }
}

/** HEAD api.telegram.org — ANY response proves direct reachability (the API
 *  answers 404 on the bare host; connectivity is the question, not the
 *  status). Error/timeout => false; no fetch implementation => 'unknown'. */
async function probeTelegramDirect(timeoutMs = TELEGRAM_PROBE_TIMEOUT_MS): Promise<boolean | 'unknown'> {
  if (typeof fetch !== 'function') return 'unknown';
  try {
    await fetch('https://api.telegram.org', { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** Probe one fleet CLI via `<cli> --version`. available = exit 0 AND a
 *  non-empty version line (stdout first, stderr as fallback — some CLIs print
 *  the version there). */
async function probeWorker(name: string, timeoutMs: number): Promise<WorkerEntry> {
  try {
    const r = await shellProbe(`${name} --version`, timeoutMs);
    const raw = r.stdout.trim() || r.stderr.trim();
    const version = raw.split(/\r?\n/)[0]?.trim() ?? '';
    if (r.ok && version.length > 0) return { name, available: true, version };
    return { name, available: false };
  } catch {
    return { name, available: false };
  }
}

async function probeWorkers(timeoutMs = WORKER_PROBE_TIMEOUT_MS): Promise<WorkerEntry[]> {
  // Parallel: the fleet's worst case then costs ONE timeout, not four.
  return Promise.all(FLEET_CLIS.map((name) => probeWorker(name, timeoutMs)));
}

// --- disk probes -----------------------------------------------------------

interface MountSize {
  mount: string;
  gb: number;
}

/** Physical-disk spindle evidence, one entry per physical disk:
 *  spindle = rotational media confirmed; ssd = non-rotational confirmed;
 *  both false = the drive reported neither (USB/unspecified media). */
interface PhysicalVerdict {
  spindle: boolean;
  ssd: boolean;
}

/**
 * Conservative MACHINE-level verdict from per-physical-disk evidence:
 * any rotational disk => 'hdd'; else any confirmed SSD/NVMe => 'ssd';
 * else 'unknown'. This verdict is what each MOUNT's ssdLikely reports —
 * doctor does not map volumes to platters, so a mixed machine reads
 * honestly as 'hdd' (spindle present) rather than guessing per letter.
 */
function machineDiskVerdict(entries: PhysicalVerdict[]): DiskClass {
  if (entries.length === 0) return 'unknown';
  if (entries.some((e) => e.spindle)) return 'hdd';
  if (entries.some((e) => e.ssd)) return 'ssd';
  return 'unknown';
}

function parseJsonArray<T>(raw: string): T[] {
  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed !== null && typeof parsed === 'object') return [parsed as T];
  return [];
}

async function probeWindowsMounts(timeoutMs: number): Promise<MountSize[]> {
  try {
    const r = await toolProbe(
      'powershell',
      ['-NoProfile', '-Command',
        '@(Get-CimInstance Win32_LogicalDisk -Filter \'DriveType=3\' | Select-Object DeviceID,Size) | ConvertTo-Json -Compress'],
      timeoutMs
    );
    if (!r.ok) return [];
    const rows = parseJsonArray<{ DeviceID?: string; Size?: string | number }>(r.stdout);
    const out: MountSize[] = [];
    for (const row of rows) {
      if (!row.DeviceID) continue;
      const bytes = Number(row.Size);
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      out.push({ mount: row.DeviceID.endsWith('\\') ? row.DeviceID : row.DeviceID + '\\', gb: Math.round(bytes / 2 ** 30) });
    }
    return out;
  } catch {
    return [];
  }
}

async function probeWindowsPhysicalVerdict(timeoutMs: number): Promise<PhysicalVerdict[]> {
  // MediaType arrives as the enum name OR its number depending on
  // PowerShell/CIM version, so both spellings are matched. SpindleSpeed is
  // RPM: >0 (and not the unknown sentinel) = rotational; 0 = non-rotational.
  try {
    const r = await toolProbe(
      'powershell',
      ['-NoProfile', '-Command',
        '@(Get-PhysicalDisk | ForEach-Object { ' +
        '$mt = $_.MediaType; $rpm = $_.SpindleSpeed; $bt = $_.BusType; ' +
        '$rpmUnknown = ($rpm -eq [uint64]::MaxValue); ' +
        '$spindle = (($mt -eq \'HDD\') -or ($mt -eq 3) -or (($rpm -gt 0) -and (-not $rpmUnknown))); ' +
        '$ssd = (($mt -eq \'SSD\') -or ($mt -eq 4) -or ($bt -eq \'NVMe\') -or (($rpm -eq 0) -and ($mt -ne \'HDD\') -and ($mt -ne 3))); ' +
        '[pscustomobject]@{ spindle = [bool]$spindle; ssd = [bool]$ssd } }) ' +
        '| ConvertTo-Json -Compress'],
      timeoutMs
    );
    if (!r.ok) return [];
    return parseJsonArray<PhysicalVerdict>(r.stdout).map((e) => ({
      spindle: e.spindle === true,
      ssd: e.ssd === true,
    }));
  } catch {
    return [];
  }
}

async function probeUnixMounts(timeoutMs: number): Promise<MountSize[]> {
  try {
    const r = await toolProbe('df', ['-P', '-k'], timeoutMs);
    if (!r.ok) return [];
    const out: MountSize[] = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.startsWith('/')) continue; // real filesystems only
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const kb = Number(parts[1]);
      if (!Number.isFinite(kb) || kb <= 0) continue;
      out.push({ mount: parts.slice(5).join(' '), gb: Math.round(kb / 2 ** 20) });
    }
    return out;
  } catch {
    return [];
  }
}

async function probeDisks(timeoutMs = DISK_PROBE_TIMEOUT_MS): Promise<DiskEntry[]> {
  if (process.platform === 'win32') {
    const [mounts, phys] = await Promise.all([
      probeWindowsMounts(timeoutMs),
      (async (): Promise<PhysicalVerdict[]> => {
        const first = await probeWindowsPhysicalVerdict(timeoutMs);
        if (first.length > 0) return first;
        // Cold Storage-module enumeration loses to its own timeout on a busy
        // machine (observed: >10 s under concurrent load, 3 s standalone).
        return probeWindowsPhysicalVerdict(timeoutMs);
      })(),
    ]);
    const verdict = machineDiskVerdict(phys);
    const ssdLikely: SsdLikely = verdict === 'hdd' ? false : verdict === 'ssd' ? true : 'unknown';
    return mounts.map((m) => ({ ...m, ssdLikely }));
  }
  const mounts = await probeUnixMounts(timeoutMs);
  return mounts.map((m) => ({ ...m, ssdLikely: 'unknown' }));
}

// ---------------------------------------------------------------------------
// Collection + rendering
// ---------------------------------------------------------------------------

/** Run every probe (independent ones concurrently) and assemble the raw
 *  ProbeResults. No derived fields here — that is buildProfile's job. */
export async function collectProbes(): Promise<ProbeResults> {
  const [repoRoot, telegramDirect, disk, workers] = await Promise.all([
    (async (): Promise<string> => {
      try {
        return await repoRootFromModule(__filename);
      } catch {
        return 'unknown';
      }
    })(),
    probeTelegramDirect(),
    probeDisks(),
    probeWorkers(),
  ]);
  return {
    os: { platform: platform(), release: release(), arch: arch() },
    shell: probeShells(),
    cpus: cpus().length,
    memTotalBytes: totalmem(),
    disk,
    paHome: paHome(),
    paths: { repoRoot, nodeVersion: process.version },
    schedulerBackend: detectSchedulerBackend(),
    telegramDirect,
    workers,
    coexistence: await listForDoctor(),
  };
}

export function renderText(p: MachineProfile): string {
  const lines: string[] = [];
  lines.push('pa doctor — machine profile');
  lines.push(`os         ${p.os.platform} ${p.os.release} ${p.os.arch}`);
  lines.push(`shell      powershell=${p.shell.powershell ? 'yes' : 'no'} pwsh=${p.shell.pwsh ? 'yes' : 'no'} bash=${p.shell.bash ? 'yes' : 'no'}`);
  lines.push(`cpu/mem    ${p.cpus} cpus, ${p.memTotalBytes} bytes (${(p.memTotalBytes / 2 ** 30).toFixed(1)} GB)`);
  if (p.disk.length === 0) {
    lines.push('disk       (none detected)');
  } else {
    for (const d of p.disk) lines.push(`disk       ${d.mount} ${d.gb} GB ssdLikely=${d.ssdLikely}`);
  }
  lines.push(`paHome     ${p.paHome}`);
  lines.push(`paths      repoRoot=${p.paths.repoRoot} node=${p.paths.nodeVersion}`);
  lines.push(`scheduler  ${p.schedulerBackend}`);
  lines.push(`telegram   direct=${p.telegramDirect}`);
  for (const w of p.workers) {
    lines.push(`worker     ${w.name}: ${w.available ? `available${w.version ? ` (${w.version})` : ''}` : 'unavailable'}`);
  }
  for (const c of p.coexistence ?? []) {
    lines.push(`coexist    ${c.cli} ${c.id} addedKeys=${c.addedKeys.join(',') || '(none)'}`);
  }
  lines.push(`derived    resourceClass=${p.derivedProfile.resourceClass} diskClass=${p.derivedProfile.diskClass} suggestedSerializeSuites=${p.derivedProfile.suggestedSerializeSuites}`);
  return lines.join('\n');
}

/** `pa doctor [--json] [--text]` — JSON is the default output; --json is
 *  accepted explicitly for symmetry with other pa commands. Read-only. */
export async function doctorCommand(args: string[] = []): Promise<void> {
  const profile = buildProfile(await collectProbes());
  if (args.includes('--text')) {
    console.log(renderText(profile));
    return;
  }
  console.log(JSON.stringify(profile, null, 2));
}
