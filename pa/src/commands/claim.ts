import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { join } from 'path';
import fs from 'fs-extra';
import { claim, release, renew, readActive, readPlanned, type ReleaseOptions } from '../lib/reservations.js';
import { resolveSessionBusAddress } from '../lib/bus-queue.js';
import { resolveRepoRoot } from '../lib/git-root.js';
import { parsePorcelainPaths } from '../lib/git-status.js';
import { paHome } from '../paths.js';

const RECENT_WINDOW_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

const CLAIM_USAGE =
  'Usage: pa claim <path...> --session <label> --note "<what you are doing>" [--ttl <minutes>] [--force] [--wait <seconds>]\n' +
  '              [--planned] [--bus <addr>] [--task <id>] [--pid <n>]\n' +
  '       pa claim --renew <id> [--ttl <minutes>]';

const RELEASE_USAGE = 'Usage: pa release <id> [--session <label>] [--force]';

const CLAIMS_USAGE = 'Usage: pa claims [--stats [--days N] [--json]]';

interface ParsedClaimArgs {
  paths: string[];
  session?: string;
  note?: string;
  ttlMinutes?: number;
  force: boolean;
  planned: boolean;
  bus?: string;
  taskId?: string;
  pid?: number;
  waitSeconds?: number;
  renewId?: string;
  help: boolean;
  unknownFlags: string[];
}

function parseClaimArgs(args: string[]): ParsedClaimArgs {
  const paths: string[] = [];
  let session: string | undefined;
  let note: string | undefined;
  let ttlMinutes: number | undefined;
  let force = false;
  let planned = false;
  let bus: string | undefined;
  let taskId: string | undefined;
  let pid: number | undefined;
  let waitSeconds: number | undefined;
  let renewId: string | undefined;
  let help = false;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') { session = args[++i]; continue; }
    if (arg === '--note') { note = args[++i]; continue; }
    if (arg === '--ttl') { ttlMinutes = Number(args[++i]); continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--planned') { planned = true; continue; }
    if (arg === '--bus') { bus = args[++i]; continue; }
    if (arg === '--task') { taskId = args[++i]; continue; }
    if (arg === '--pid') { pid = Number(args[++i]); continue; }
    if (arg === '--wait') { waitSeconds = Number(args[++i]); continue; }
    if (arg === '--renew') { renewId = args[++i]; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    paths.push(arg);
  }

  return {
    paths,
    session: session ?? process.env.PA_SESSION,
    note,
    ttlMinutes,
    force,
    planned,
    bus,
    taskId,
    pid: Number.isFinite(pid) ? pid : undefined,
    waitSeconds,
    renewId,
    help,
    unknownFlags,
  };
}

/**
 * `pa claim <path...> --session <label> --note "<text>" [--ttl <minutes>]
 *   [--force] [--wait <seconds>]`
 * `pa claim --renew <id> [--ttl <minutes>]`
 *
 * Claude Code's Bash tool does not persist environment variables between
 * calls, so `export PA_SESSION=...` silently does nothing — a session must
 * pass `--session` on every invocation (or accept the generated label this
 * prints, and reuse it).
 */
export async function claimCommand(args: string[]): Promise<number> {
  const parsed = parseClaimArgs(args);

  if (parsed.help) {
    console.log(CLAIM_USAGE);
    return 0;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(CLAIM_USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknownFlags.join(', ')}`);
    return 2;
  }

  if (parsed.renewId) {
    // AI-177: the renew is owner-checked inside reservations.renew — a session
    // label passed here is verified against the row's owning session.
    const session = parsed.session ?? process.env.PA_SESSION;
    const result = await renew(parsed.renewId, { ttlMinutes: parsed.ttlMinutes, session });
    if (!result) {
      // Distinguish "no such row" from "owned by another session" the same way
      // releaseCommand does (exit 3 for a refusal, 1 for not-found).
      if (session) {
        const active = await readActive();
        const reservation = active.find((r) => r.id === parsed.renewId);
        if (reservation && reservation.session !== session) {
          console.error(
            `pa claim --renew: ${parsed.renewId} is held by "${reservation.session}" — pass --session ${reservation.session} (or drop --session) to renew it.`
          );
          return 3;
        }
      }
      console.error(`No active reservation found with id ${parsed.renewId}`);
      return 1;
    }
    console.log(`Renewed ${result.id} — now expires ${result.expiresAt}`);
    return 0;
  }

  if (parsed.paths.length === 0) {
    console.error(CLAIM_USAGE);
    return 1;
  }

  let session = parsed.session;
  if (!session) {
    session = `s-${randomBytes(3).toString('hex')}`;
    console.log(`No --session given (and PA_SESSION unset) — generated "${session}". Reuse it on every subsequent call.`);
  }

  // Identity auto-fill (AI-255): a claim should name WHERE its owner is
  // reachable (bus) and WHICH process owns it (pid — enables the GC dead-owner
  // sweep). Both come from the same resolution `pa bus whoami` uses, so the
  // claim's bus address IS the session's registered address. Dispatched
  // workers inherit PA_WORKER_DISPATCH_ID — carrying it lets the worker-exec
  // settle funnel auto-release the claim (B4: claims outliving their work).
  const dispatchId = process.env.PA_WORKER_DISPATCH_ID || undefined;
  let bus = parsed.bus;
  let pid = parsed.pid;
  if (bus === undefined || pid === undefined) {
    const ident = await resolveSessionBusAddress();
    bus = bus ?? ident.address;
    // ident.pid is the registered session host (ancestor-matched even on
    // pin/key paths — AI-260). When it's absent, process.ppid is only a real
    // owner under a dispatch (the worker host — dead ⇒ the dispatch died ⇒
    // claims shed); for a headed claim it is a per-invocation shell that's
    // dead within seconds, and recording it made every plain claim
    // dead-owner-sweepable. Record nothing instead — the row then rides its
    // TTL like any pid-less reservation.
    pid = pid ?? ident.pid ?? (dispatchId ? process.ppid : undefined);
  }
  // PA_TASK_ID rides the per-hop getEnv hook (task-executor stamps the task id,
  // thread-executor t-<n>) — the getEnv merge lands AFTER runWithFailover's
  // secret_allowlist filter, so it reaches allowlisted workers; a worker's
  // claims then release on the work item's terminal transition even if the
  // dispatch settle already ran.
  const taskId = parsed.taskId ?? process.env.PA_TASK_ID ?? undefined;

  const note = parsed.note ?? '';
  // A non-numeric --wait (e.g. a typo'd value) must never become a deadline of NaN:
  // `now >= NaN` is always false, so the retry loop below would never terminate on
  // its own — it would only stop when this command's own outer process timeout (or
  // the calling skill's, e.g. push's 3600s) eventually kills it. Fail fast instead:
  // an invalid --wait behaves as if --wait were never given (single attempt, no poll).
  const deadline = parsed.waitSeconds !== undefined && Number.isFinite(parsed.waitSeconds)
    ? Date.now() + parsed.waitSeconds * 1000
    : undefined;

  for (;;) {
    const result = await claim({
      paths: parsed.paths,
      session,
      note,
      ttlMinutes: parsed.ttlMinutes,
      force: parsed.force,
      kind: parsed.planned ? 'planned' : undefined,
      bus,
      pid,
      dispatchId,
      taskId,
    });

    if (result.ok) {
      const r = result.reservation!;
      if (result.plannedConflicts?.length) {
        const lines = result.plannedConflicts
          .map((c) => `  ${c.paths.join(', ')} planned by "${c.session}" (${c.note})${c.bus ? ` bus=${c.bus}` : ''}`)
          .join('\n');
        console.log(`Note — overlapping planned work:\n${lines}`);
      }
      const tag = parsed.planned ? 'Planned' : 'Claimed';
      console.log(`${tag} ${r.id} — ${r.paths.join(', ')} (expires ${r.expiresAt})`);
      return 0;
    }

    const conflictLines = (result.conflicts ?? [])
      .map((c) => `  ${c.paths.join(', ')} held by "${c.session}" (${c.note}) until ${c.expiresAt}`)
      .join('\n');

    const now = Date.now();
    if (deadline === undefined || now >= deadline) {
      console.error(`Claim conflicts with an active reservation:\n${conflictLines}`);
      return 1;
    }

    console.log(`Waiting on:\n${conflictLines}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

interface ParsedReleaseArgs {
  id?: string;
  session?: string;
  force: boolean;
  help: boolean;
  unknownFlags: string[];
}

function parseReleaseArgs(args: string[]): ParsedReleaseArgs {
  let id: string | undefined;
  let session: string | undefined;
  let force = false;
  let help = false;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') { session = args[++i]; continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    if (id === undefined) { id = arg; continue; }
    // extra positional args beyond the first are ignored — only args[0] was
    // ever read as the id, unchanged from pre-existing behaviour.
  }

  return { id, session, force, help, unknownFlags };
}

/**
 * `pa release <id> [--session <label>] [--force]`
 *
 * `--session` is optional (falls back to PA_SESSION). When given and it does
 * not match the reservation's owning session, the release is refused (exit 3)
 * unless `--force` is also given.
 */
export async function releaseCommand(args: string[]): Promise<number> {
  const parsed = parseReleaseArgs(args);

  if (parsed.help) {
    console.log(RELEASE_USAGE);
    return 0;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(RELEASE_USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknownFlags.join(', ')}`);
    return 2;
  }

  if (!parsed.id) {
    console.error('Usage: pa release <id>');
    return 1;
  }

  const session = parsed.session ?? process.env.PA_SESSION;
  let releaseOpts: ReleaseOptions = { id: parsed.id };

  if (session) {
    const active = await readActive();
    const reservation = active.find((r) => r.id === parsed.id);
    if (reservation && reservation.session !== session) {
      if (!parsed.force) {
        console.error(
          `pa release: ${parsed.id} is held by "${reservation.session}" (${reservation.note}) — pass --session ${reservation.session}, or --force to release it anyway.`
        );
        return 3;
      }
      releaseOpts = { id: parsed.id, force: true, ownerSession: reservation.session, bySession: session };
    }
  }

  const { released } = await release(releaseOpts);
  if (released === 0) {
    console.error(`No reservation found with id ${parsed.id}`);
    return 1;
  }
  console.log(`Released ${parsed.id}.`);
  return 0;
}

interface ParsedClaimsArgs {
  stats: boolean;
  json: boolean;
  days?: number;
  help: boolean;
  unknownFlags: string[];
}

function parseClaimsArgs(args: string[]): ParsedClaimsArgs {
  let stats = false;
  let json = false;
  let days: number | undefined;
  let help = false;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stats') { stats = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--days') { days = Number(args[++i]); continue; }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    // non-flag positional args are silently ignored — `pa claims` takes none.
  }

  return { stats, json, days, help, unknownFlags };
}

/**
 * `pa claims` — always prints both coordination layers (plan §4.5):
 * explicit reservations (cooperation required), and mtime-derived recent
 * activity from `git status --porcelain` (zero cooperation required, so it
 * catches the Telegram bot and any non-participating editor too).
 *
 * `pa claims --stats [--days N] [--json]` instead prints a rollup of
 * reservation activity (claims/forces/denials/releases/renewals/GC-expiries)
 * logged to app.log.jsonl over the last N days (default 7).
 */
export async function claimsCommand(args: string[] = []): Promise<number> {
  const parsed = parseClaimsArgs(args);

  if (parsed.help) {
    console.log(CLAIMS_USAGE);
    return 0;
  }

  if (parsed.unknownFlags.length > 0) {
    console.error(CLAIMS_USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknownFlags.join(', ')}`);
    return 2;
  }

  if (parsed.stats) {
    const days = parsed.days !== undefined && Number.isFinite(parsed.days) && parsed.days > 0 ? parsed.days : 7;
    const stats = await coordinationStats({ days });
    if (parsed.json) {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      console.log(renderCoordinationStats(stats));
    }
    return 0;
  }

  const active = await readActive();
  console.log('Active reservations:');
  if (active.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of active) {
      const bus = r.bus ? `  bus=${r.bus}` : '';
      const owner = r.pid ? `  pid=${r.pid}` : '';
      console.log(`  ${r.id}  ${r.paths.join(', ')}  session=${r.session}${bus}${owner}  note="${r.note}"  expires=${r.expiresAt}`);
    }
  }

  const planned = await readPlanned();
  console.log('');
  console.log('Planned (declared intent — does not block):');
  if (planned.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of planned) {
      const bus = r.bus ? `  bus=${r.bus}` : '';
      console.log(`  ${r.id}  ${r.paths.join(', ')}  session=${r.session}${bus}  note="${r.note}"  expires=${r.expiresAt}`);
    }
  }

  console.log('');
  console.log('Recently modified (last 15 minutes, git status + mtime):');
  const recent = await recentActivity();
  if (recent.length === 0) {
    console.log('  (none)');
  } else {
    for (const path of recent) {
      console.log(`  ${path}`);
    }
  }

  return 0;
}

export async function recentActivity(): Promise<string[]> {
  // Must be the true repo root, not process.cwd() — git status --porcelain
  // returns root-relative paths regardless of invoking cwd, so joining them
  // onto anything else produces a non-existent path (see lib/git-root.ts).
  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot();
  } catch {
    return []; // not inside a git repo — nothing to report, not a crash
  }
  const out = await runGitStatus(repoRoot);
  const changed = parsePorcelainPaths(out);
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent: string[] = [];
  for (const rel of changed) {
    try {
      const stat = await fs.stat(join(repoRoot, rel));
      if (stat.mtimeMs >= cutoff) recent.push(rel);
    } catch {
      // deleted/renamed between `git status` and stat — skip
    }
  }
  return recent;
}

function runGitStatus(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', () => resolve(out));
    child.on('error', () => resolve(''));
  });
}

// ---- pa claims --stats ----

export interface CoordinationStats {
  days: number;
  claims: number;
  forced: number;
  denied: number;
  released: number;
  forcedReleases: number;
  renewed: number;
  gcExpired: number;
  hookWarnings: number;
  unclaimedWrites: number;
  distinctSessions: number;
  autoSessionIds: number;
  sessions: Array<{ session: string; claims: number }>;
}

const AUTO_SESSION_ID_RE = /^s-[0-9a-f]{6}$/;
const ARCHIVE_LOG_RE = /-app\.log\.jsonl$/;

async function listArchiveLogFiles(logDir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(join(logDir, 'archive'));
    return names.filter((n) => ARCHIVE_LOG_RE.test(n)).map((n) => join(logDir, 'archive', n));
  } catch {
    return [];
  }
}

async function readLogLines(path: string): Promise<string[]> {
  try {
    const content = await fs.readFile(path, 'utf8');
    return content.split('\n').filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Rolls up `module: 'reservations'` lines from app.log.jsonl (plus rotated
 * archive shards) over the last `days` days. Zero matching lines is not an
 * error — the caller renders a zeroed block. Unparseable lines are skipped
 * silently; the log is append-only and a torn line (mid-write crash) is an
 * expected, not exceptional, condition.
 */
export async function coordinationStats(
  opts?: { days?: number; now?: number; logDir?: string }
): Promise<CoordinationStats> {
  const days = opts?.days !== undefined && Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 7;
  const now = opts?.now ?? Date.now();
  const windowStart = now - days * 24 * 60 * 60 * 1000;
  const logDir = opts?.logDir ?? paHome();

  const files = [join(logDir, 'app.log.jsonl'), ...(await listArchiveLogFiles(logDir))];

  let claims = 0;
  let forced = 0;
  let denied = 0;
  let released = 0;
  let forcedReleases = 0;
  let renewed = 0;
  let gcExpired = 0;
  let hookWarnings = 0;
  let unclaimedWrites = 0;
  const sessionCounts = new Map<string, number>();

  for (const file of files) {
    const lines = await readLogLines(file);
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || entry.module !== 'reservations') continue;
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts) || ts < windowStart || ts > now) continue;

      switch (entry.message) {
        case 'claim granted':
          claims++;
          if (entry.forced === true) forced++;
          if (typeof entry.session === 'string') {
            sessionCounts.set(entry.session, (sessionCounts.get(entry.session) ?? 0) + 1);
          }
          break;
        case 'claim denied':
          denied++;
          break;
        case 'reservation released':
          released += Number(entry.releasedCount) || 0;
          break;
        case "forced release of another session's reservation":
          forcedReleases++;
          break;
        case 'reservation renewed':
          renewed++;
          break;
        case 'reservations gc-expired':
          gcExpired += Number(entry.removed) || 0;
          break;
        case 'hook warning':
          hookWarnings++;
          break;
        // AI-255 B5: worker-context unclaimed-write telemetry from the
        // reservation guard — which dispatches touched shared surfaces with no
        // covering claim.
        case 'unclaimed write':
          unclaimedWrites++;
          break;
        default:
          break;
      }
    }
  }

  const distinctSessions = sessionCounts.size;
  const autoSessionIds = Array.from(sessionCounts.keys()).filter((s) => AUTO_SESSION_ID_RE.test(s)).length;
  const sessions = Array.from(sessionCounts.entries())
    .map(([session, count]) => ({ session, claims: count }))
    .sort((a, b) => b.claims - a.claims)
    .slice(0, 10);

  return {
    days,
    claims,
    forced,
    denied,
    released,
    forcedReleases,
    renewed,
    gcExpired,
    hookWarnings,
    unclaimedWrites,
    distinctSessions,
    autoSessionIds,
    sessions,
  };
}

const STATS_LABEL_COL = 21;

function statsLabel(label: string): string {
  return ('  ' + label).padEnd(STATS_LABEL_COL);
}

function renderCoordinationStats(stats: CoordinationStats): string {
  const lines: string[] = [];
  lines.push(`Coordination stats (last ${stats.days} days):`);
  lines.push(statsLabel('claims granted:') + `${stats.claims}  (${stats.forced} forced)`);
  lines.push(statsLabel('claims denied:') + `${stats.denied}`);
  lines.push(statsLabel('released:') + `${stats.released}  (${stats.forcedReleases} forced)`);
  lines.push(statsLabel('renewed:') + `${stats.renewed}`);
  lines.push(statsLabel('gc-expired:') + `${stats.gcExpired}`);
  lines.push(statsLabel('hook warnings:') + `${stats.hookWarnings}`);
  lines.push(statsLabel('unclaimed writes:') + `${stats.unclaimedWrites}`);
  lines.push(
    statsLabel('session labels:') +
      `${stats.distinctSessions} distinct, ${stats.autoSessionIds} auto-generated (s-xxxxxx)`
  );
  const topSessions = stats.sessions.length > 0
    ? stats.sessions.map((s) => `${s.session}(${s.claims})`).join(', ')
    : '(none)';
  lines.push(statsLabel('top sessions:') + topSessions);

  const hasActivity = stats.claims + stats.denied + stats.released + stats.renewed + stats.gcExpired + stats.hookWarnings + stats.unclaimedWrites > 0;
  if (!hasActivity) {
    lines.push('  (no reservation activity logged in this window)');
  }

  return lines.join('\n');
}
