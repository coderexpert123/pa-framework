/**
 * AI-175 — dispatch-scoped before/after `git status` snapshot, reconciled at
 * dispatch end, to detect a worker editing tracked paths it never claimed.
 * Design: plans/2026-09-01-ai175-worker-edit-enforcement-SPEC.md.
 *
 * Detection only. Nothing here blocks a dispatch, refuses an edit, or
 * mutates the tree — consistent with Rule 3 (reservations are advisory) and
 * Rule 9 (never destroy what you do not own).
 *
 * CommonJS module (pa/ has no "type":"module") — __filename, never the ESM
 * meta-url form (root CLAUDE.md, the 2026-08-23 live outage).
 *
 * `openWindow`/`closeWindow` never throw: they sit on the bot's live reply
 * path, and an audit that can break a user's dispatch is worse than no
 * audit at all.
 */

import { randomBytes, createHash } from 'crypto';
import { mkdir, readdir, readFile, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { defaultGitRunner, type GitRunner } from './tree-drift.js';
import { parsePorcelainEntries } from './git-status.js';
import { pathsOverlap, readActive, readReleasedSince } from './reservations.js';
import type { Reservation, ReleasedReservation } from './reservations.js';
import { repoRootFromModule } from './git-root.js';
import { appendOrphanRecord } from './orphan-ledger.js';
import { notifyUser } from './notify.js';
import { log } from './log.js';
import { writeJsonAtomic } from './atomic-write.js';
import { paHome } from '../paths.js';

// ---- Types (frozen — §3.1) ----

export interface TreeEntry {
  xy: string;
  mtimeMs: number;
  size: number;
}

export interface TreeSnapshot {
  /** `git rev-parse HEAD`; '' when unavailable. */
  headSha: string;
  /** key = repo-relative path with forward slashes, as git emits it. */
  entries: Record<string, TreeEntry>;
}

export type EditFindingKind = 'appeared' | 'modified' | 'vanished';
export interface EditFinding {
  path: string;
  kind: EditFindingKind;
}

export interface DispatchWindow {
  /** "w-" + 12 hex. Also the window file's basename stem. */
  id: string;
  /** the bot's `resource`, e.g. "topic-123_456". */
  resource: string;
  /** null until closeWindow supplies it — the failover cascade picks the worker
   *  after the window opens, and the sweeper never learns it at all. */
  worker: string | null;
  startedAt: number;
  botPid: number;
  before: TreeSnapshot;
  /** normalized paths of every reservation active when the window opened. */
  reservedAtStart: string[];
}

export interface CloseResult {
  findings: EditFinding[];
  notified: boolean;
  /** other windows whose [startedAt, now] span overlapped this one (C8). */
  concurrentWindows: number;
  /** set when nothing was evaluated: 'disabled' | 'no-window' | 'git-failed' | 'alert-cap'. */
  skipped?: 'disabled' | 'no-window' | 'git-failed' | 'alert-cap';
}

// ---- Environment knobs (frozen names and defaults — §3.6) ----

const DEFAULT_MAX_ALERTS_PER_DAY = 10;

export function isAuditEnabled(): boolean {
  return process.env.PA_WORKER_EDIT_AUDIT !== '0';
}

function maxAlertsPerDay(): number {
  const raw = Number(process.env.PA_WORKER_EDIT_AUDIT_MAX_ALERTS_PER_DAY);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_ALERTS_PER_DAY;
}

/** Splits PA_WORKER_EDIT_AUDIT_IGNORE on ',', trims, drops empties, normalises
 *  backslashes to forward slashes. Empty/unset ⇒ []. */
export function readIgnorePrefixes(): string[] {
  const raw = process.env.PA_WORKER_EDIT_AUDIT_IGNORE ?? '';
  return raw
    .split(',')
    .map((p) => p.trim().replace(/\\/g, '/'))
    .filter((p) => p.length > 0);
}

export function windowDir(): string {
  return join(paHome(), 'worker-edit-audit');
}

function windowFilePath(id: string): string {
  return join(windowDir(), `${id}.json`);
}

function alertCountPath(): string {
  return join(windowDir(), 'alert-count.json');
}

function refId(): string {
  return `s-${randomBytes(6).toString('hex')}`;
}

// ---- Snapshot ----

export interface SnapshotTreeOptions {
  gitRunner?: GitRunner;
  statFn?: (absPath: string) => Promise<{ mtimeMs: number; size: number }>;
}

const defaultStatFn = async (absPath: string): Promise<{ mtimeMs: number; size: number }> => {
  const s = await stat(absPath);
  return { mtimeMs: s.mtimeMs, size: s.size };
};

/**
 * One `git status --porcelain`, one `git rev-parse HEAD`, one `fs.stat` per
 * dirty entry. Sequential — never `Promise.all`: D: is a 5400rpm HDD and
 * subprocess/disk-heavy concurrent code has caused real timeouts before
 * (tree-drift.ts's detectDrift carries the same comment for the same reason).
 * A failed `git status` must never read as a clean scan — throw loudly.
 * A failed `git rev-parse HEAD` degrades to headSha:'' rather than a throw
 * (C5's vanished-suppression guard treats an all-empty headSha pair as equal,
 * which is the safest available fallback when HEAD cannot be resolved at all).
 */
export async function snapshotTree(repoRoot: string, opts: SnapshotTreeOptions = {}): Promise<TreeSnapshot> {
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const statFn = opts.statFn ?? defaultStatFn;

  const statusRes = await gitRunner(repoRoot, ['status', '--porcelain']);
  if (statusRes.code !== 0) {
    throw new Error(`git status failed (exit ${statusRes.code}): ${statusRes.stderr.toString('utf8').trim()}`);
  }
  const porcelainEntries = parsePorcelainEntries(statusRes.stdout.toString('utf8'));

  const headRes = await gitRunner(repoRoot, ['rev-parse', 'HEAD']);
  const headSha = headRes.code === 0 ? headRes.stdout.toString('utf8').trim() : '';

  const entries: Record<string, TreeEntry> = {};
  for (const entry of porcelainEntries) {
    const xy = entry.x + entry.y;
    try {
      const s = await statFn(join(repoRoot, entry.path));
      entries[entry.path] = { xy, mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      entries[entry.path] = { xy, mtimeMs: 0, size: -1 };
    }
  }

  return { headSha, entries };
}

// ---- Diff (frozen — §3.4) ----

export function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot): EditFinding[] {
  const findings: EditFinding[] = [];
  const beforeKeys = Object.keys(before.entries);
  const afterKeys = Object.keys(after.entries);
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);

  for (const path of afterKeys) {
    if (!beforeSet.has(path)) {
      findings.push({ path, kind: 'appeared' });
      continue;
    }
    const b = before.entries[path];
    const a = after.entries[path];
    if (b.xy !== a.xy || b.mtimeMs !== a.mtimeMs || b.size !== a.size) {
      findings.push({ path, kind: 'modified' });
    }
  }

  // A commit landing inside the window moves tracked files out of the dirty
  // set with no worker action at all — suppress `vanished` wholesale rather
  // than misreport every file the `commit` skill just committed (C5).
  if (before.headSha === after.headSha) {
    for (const path of beforeKeys) {
      if (!afterSet.has(path)) {
        findings.push({ path, kind: 'vanished' });
      }
    }
  }

  return findings;
}

// ---- Filters ----

/** Drops a finding when `pathsOverlap(finding.path, c)` is true for any `c`
 *  in `coveredPaths`. Reuses reservations.ts's boundary-aware overlap check —
 *  never a raw string-prefix comparison. */
export function filterUnreserved(findings: EditFinding[], coveredPaths: string[]): EditFinding[] {
  return findings.filter((f) => !coveredPaths.some((c) => pathsOverlap(f.path, c)));
}

/** Drops a finding whose path equals an ignore prefix or starts with
 *  `prefix + '/'` — the same boundary rule as pathsOverlap; a bare string
 *  prefix would wrongly drop `plansmith/x.md` for an ignore prefix `plans`. */
export function applyIgnoreList(findings: EditFinding[], prefixes: string[]): EditFinding[] {
  if (prefixes.length === 0) return findings;
  return findings.filter((f) => !prefixes.some((p) => f.path === p || f.path.startsWith(p + '/')));
}

/** `'worker-edit-audit:' + sha1(sorted "<kind>:<path>" lines joined by '\n').slice(0,12)`.
 *  Content-hashed, never topic-keyed (root CLAUDE.md alert-substrate rule:
 *  dedup keys never embed PIDs, topic ids or counts). */
export function findingsDedupKey(findings: EditFinding[]): string {
  const lines = findings.map((f) => `${f.kind}:${f.path}`).sort();
  const hash = createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 12);
  return `worker-edit-audit:${hash}`;
}

// ---- Day-counter (delivered-alert cap, C7) ----

interface AlertCountState {
  day: string;
  count: number;
}

function todayKeyUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** A malformed or missing file resets to zero for today. */
async function readAlertCount(): Promise<AlertCountState> {
  const today = todayKeyUTC();
  try {
    const raw = await readFile(alertCountPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.day === 'string' && typeof parsed.count === 'number' && parsed.day === today) {
      return { day: today, count: parsed.count };
    }
  } catch {
    // missing or malformed — treat as zero for today
  }
  return { day: today, count: 0 };
}

/** Returns whether this reconcile may still send today, and bumps the
 *  counter when it may. Counts every attempted reconcile with non-empty
 *  findings, not just confirmed deliveries — a thrashing worker producing a
 *  new path set every dispatch would otherwise never trip the cap at all
 *  (each content-hashed dedupKey looks "new" to notify.ts's own dedup). */
async function checkAndBumpAlertCount(): Promise<{ allowed: boolean }> {
  const state = await readAlertCount();
  if (state.count >= maxAlertsPerDay()) {
    return { allowed: false };
  }
  await mkdir(windowDir(), { recursive: true });
  await writeJsonAtomic(alertCountPath(), { day: state.day, count: state.count + 1 }).catch(() => {});
  return { allowed: true };
}

// ---- Alert body (frozen format — §3.3) ----

function buildAlertBody(
  win: DispatchWindow,
  worker: string | null,
  findings: EditFinding[],
  concurrentWindows: number,
  closedAt: Date,
  ref: string,
): string {
  const workerLabel = worker ?? 'unknown (bot restarted mid-dispatch)';
  const lines = findings.map((f) => `  - \`${f.path}\` (${f.kind})`);
  const shown = lines.slice(0, 15);
  const extra = lines.length - shown.length;

  const parts: string[] = [
    '**Unreserved edits during a worker dispatch**',
    '',
    `Topic: \`${win.resource}\` — worker: \`${workerLabel}\``,
    `Window: ${new Date(win.startedAt).toISOString()} → ${closedAt.toISOString()}`,
    '',
    ...shown,
  ];
  if (extra > 0) {
    parts.push(`  - …and ${extra} more`);
  }
  parts.push(
    '',
    'None of these paths was covered by a reservation active at either end of the window, or ' +
      'claimed and released inside it. Claim before editing: `pa claim <paths> --session <label> ' +
      '--note "<what you are doing>"`.',
  );
  if (concurrentWindows > 0) {
    parts.push(
      `${concurrentWindows} other dispatch(es) were in flight during this window, so attribution to this topic is not certain.`,
    );
  }
  parts.push('', `_Ref: ${ref}_`);

  return parts.join('\n');
}

// ---- Orphan ledger (Wave 2 WP-C, AI-189) ----

export interface OrphanLedgerLaneInput {
  /** Findings after the ignore list — the pool both lanes draw from. */
  ignored: EditFinding[];
  /** Normalized paths covered by a reservation (reservedAtStart + active +
   *  released), exactly what filterUnreserved consumed. */
  coveredPaths: string[];
  /** filterUnreserved's output — the alerted (uncovered) lane. */
  unreservedFindings: EditFinding[];
  after: TreeSnapshot;
  active: Reservation[];
  released: ReleasedReservation[];
  /** Paths covered when the window OPENED — paths only, no session label. */
  reservedAtStart: string[];
  topic?: { chatId: number; threadId: number };
}

/** A finding is still dirty when its path remains in the after-snapshot.
 *  `vanished` findings left the dirty set (committed or deleted mid-window)
 *  and would make the sweep file a land-or-discard task for a clean path. */
function isStillDirty(f: EditFinding, after: TreeSnapshot): boolean {
  return after.entries[f.path] !== undefined;
}

/**
 * Write the close's orphan-ledger records: at most TWO lines — one for the
 * covered-but-still-dirty lane (owner_session = the first covering
 * reservation's session label, active first, then released-during-window;
 * paths covered only by reservedAtStart carry no label anywhere and read as
 * null), one for the uncovered lane (owner_session null). Returns lines
 * written. Throws on write failure; closeWindow wraps the call in try/catch
 * so a ledger failure can never break a reply-path close.
 */
export async function writeOrphanLedgerRecords(input: OrphanLedgerLaneInput): Promise<number> {
  const ts = new Date().toISOString();
  const ownerTopic = input.topic ? `${input.topic.chatId}_${input.topic.threadId}` : null;

  const covered = input.ignored.filter(
    (f) => input.coveredPaths.some((c) => pathsOverlap(f.path, c)) && isStillDirty(f, input.after),
  );
  const unowned = input.unreservedFindings.filter((f) => isStillDirty(f, input.after));

  const coveringReservation = (p: string): { session: string | null; releasedAt: string | null } | null => {
    const a = input.active.find((r) => r.paths.some((rp) => pathsOverlap(p, rp)));
    if (a) return { session: a.session, releasedAt: a.expiresAt };
    const r = input.released.find((rr) => rr.paths.some((rp) => pathsOverlap(p, rp)));
    if (r) return { session: r.session, releasedAt: r.releasedAt };
    if (input.reservedAtStart.some((rp) => pathsOverlap(p, rp))) return { session: null, releasedAt: null };
    return null;
  };

  let written = 0;
  if (covered.length > 0) {
    const first = covered
      .map((f) => coveringReservation(f.path))
      .find((a) => a !== undefined && a !== null) ?? null;
    written += await appendOrphanRecord({
      ts,
      paths: covered.map((f) => f.path),
      owner_session: first ? first.session : null,
      owner_topic: ownerTopic,
      source: 'dispatch-close',
      released_at: first ? first.releasedAt : null,
    });
  }
  if (unowned.length > 0) {
    written += await appendOrphanRecord({
      ts,
      paths: unowned.map((f) => f.path),
      owner_session: null,
      owner_topic: ownerTopic,
      source: 'dispatch-close',
      released_at: null,
    });
  }
  return written;
}

// ---- Window lifecycle ----

export interface OpenWindowOptions {
  resource: string;
  gitRunner?: GitRunner;
}

/**
 * Never throws. Returns null when disabled, when the repo root or `git
 * status` fails, or on any write error.
 */
export async function openWindow(opts: OpenWindowOptions): Promise<DispatchWindow | null> {
  if (!isAuditEnabled()) return null;

  try {
    const gitRunner = opts.gitRunner ?? defaultGitRunner;
    const repoRoot = await repoRootFromModule(__filename);
    const before = await snapshotTree(repoRoot, { gitRunner });
    const reservedAtStart = (await readActive()).flatMap((r) => r.paths);

    const win: DispatchWindow = {
      id: `w-${randomBytes(6).toString('hex')}`,
      resource: opts.resource,
      worker: null,
      startedAt: Date.now(),
      botPid: process.pid,
      before,
      reservedAtStart,
    };

    await mkdir(windowDir(), { recursive: true });
    await writeJsonAtomic(windowFilePath(win.id), win);
    return win;
  } catch (err) {
    log('warn', 'worker-edit-audit', 'openWindow failed; dispatch will not be audited', {
      refId: refId(),
      resource: opts.resource,
      error: String(err),
    });
    return null;
  }
}

/**
 * Deliberately narrower than notify.ts's own (unexported) NotifyOpts/NotifyResult —
 * referencing those directly via `typeof notifyUser` in this EXPORTED interface
 * would make tsc's declaration emit fail ("has or is using private name"), since
 * neither type is exported from notify.ts and this module does not own that file.
 * The real `notifyUser` is structurally assignable to this narrower shape.
 */
interface WorkerEditNotifyOpts {
  dedupKey?: string;
  dedupWindowMs?: number;
  severity?: 'info' | 'warn' | 'error';
}
type NotifyFn = (subject: string, body: string, opts?: WorkerEditNotifyOpts) => Promise<unknown>;

export interface CloseWindowOptions {
  worker: string | null;
  /** Wave 2 WP-C (AI-189): the dispatching topic, when the caller knows it —
   *  written into the orphan ledger record so the daily-recon sweep can file
   *  a land-or-discard task back to the owning topic. The sweeper never has
   *  one (its bot is gone by definition), so it stays optional. */
  topic?: { chatId: number; threadId: number };
  gitRunner?: GitRunner;
  /** Test-only injection point — the real notifyUser can never be relied on
   *  to throw (it documents "never throws"), so exercising closeWindow's own
   *  throw-safety needs a double. Defaults to the real notifyUser. */
  notifyFn?: NotifyFn;
}

/**
 * Never throws. The window file is deleted on every path (a `finally`, so a
 * throw inside notifyUser cannot leak it).
 */
export async function closeWindow(win: DispatchWindow | null, opts: CloseWindowOptions): Promise<CloseResult> {
  if (win === null) {
    return { findings: [], notified: false, concurrentWindows: 0, skipped: 'no-window' };
  }

  try {
    if (!isAuditEnabled()) {
      return { findings: [], notified: false, concurrentWindows: 0, skipped: 'disabled' };
    }

    const gitRunner = opts.gitRunner ?? defaultGitRunner;
    const notifyFn = opts.notifyFn ?? notifyUser;

    let after: TreeSnapshot;
    try {
      const repoRoot = await repoRootFromModule(__filename);
      after = await snapshotTree(repoRoot, { gitRunner });
    } catch (err) {
      log('warn', 'worker-edit-audit', 'after-snapshot failed; window closed without evaluation', {
        refId: refId(),
        windowId: win.id,
        resource: win.resource,
        error: String(err),
      });
      return { findings: [], notified: false, concurrentWindows: 0, skipped: 'git-failed' };
    }

    const rawFindings = diffSnapshots(win.before, after);
    const ignored = applyIgnoreList(rawFindings, readIgnorePrefixes());

    const active = await readActive();
    const released = await readReleasedSince(win.startedAt);
    const coveredPaths = [
      ...win.reservedAtStart,
      ...active.flatMap((r) => r.paths),
      ...released.flatMap((r) => r.paths),
    ];
    const findings = filterUnreserved(ignored, coveredPaths);

    // Orphan ledger (Wave 2 WP-C, AI-189) — written BEFORE the empty-findings
    // early return, the alert-cap gate and the notify path: a covered-only
    // close (findings empty after filtering) still needs its owned record,
    // and the cap gates only the ALERT, never the sweep's input. Ledger
    // failure logs and continues — the audit sits on the live reply path.
    try {
      await writeOrphanLedgerRecords({
        ignored,
        coveredPaths,
        unreservedFindings: findings,
        after,
        active,
        released,
        reservedAtStart: win.reservedAtStart,
        topic: opts.topic,
      });
    } catch (err) {
      log('warn', 'worker-edit-audit', 'orphan ledger write failed; continuing', {
        refId: refId(),
        windowId: win.id,
        resource: win.resource,
        error: String(err),
      });
    }

    if (findings.length === 0) {
      return { findings: [], notified: false, concurrentWindows: 0 };
    }

    const openWindows = await listOpenWindows();
    const concurrentWindows = openWindows.filter((w) => w.id !== win.id).length;

    const { allowed } = await checkAndBumpAlertCount();
    if (!allowed) {
      log('warn', 'worker-edit-audit', 'unreserved edits found but day-cap exceeded; logging only', {
        refId: refId(),
        windowId: win.id,
        resource: win.resource,
        findings,
      });
      return { findings, notified: false, concurrentWindows, skipped: 'alert-cap' };
    }

    const closedAt = new Date();
    const ref = refId();
    const dedupKey = findingsDedupKey(findings);
    const subject = `Unreserved worker edits: ${findings.length} path(s)`;
    const body = buildAlertBody(win, opts.worker, findings, concurrentWindows, closedAt, ref);

    let notified = false;
    try {
      await notifyFn(subject, body, {
        dedupKey,
        dedupWindowMs: 3_600_000,
        severity: 'warn',
      });
      notified = true;
    } catch (err) {
      log('error', 'worker-edit-audit', 'notifyUser threw while closing a window', {
        refId: ref,
        windowId: win.id,
        resource: win.resource,
        error: String(err),
      });
    }

    return { findings, notified, concurrentWindows };
  } finally {
    await unlink(windowFilePath(win.id)).catch(() => {});
  }
}

/** Reads windowDir(), skips unparseable files (logs at warn with a ref-ID,
 *  does not delete them — the sweeper's retention target does that on age). */
export async function listOpenWindows(): Promise<DispatchWindow[]> {
  let files: string[];
  try {
    files = await readdir(windowDir());
  } catch {
    return [];
  }

  const windows: DispatchWindow[] = [];
  for (const file of files) {
    if (!/^w-[0-9a-f]{12}\.json$/.test(file)) continue;
    try {
      const raw = await readFile(join(windowDir(), file), 'utf8');
      windows.push(JSON.parse(raw) as DispatchWindow);
    } catch (err) {
      log('warn', 'worker-edit-audit', 'unparseable window file skipped', {
        refId: refId(),
        file,
        error: String(err),
      });
    }
  }
  return windows;
}
