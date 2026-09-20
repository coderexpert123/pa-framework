/**
 * Voice-inbox transcription — the ONE deterministic transcription action
 * (2026-09-16). Two callers share it:
 *  - the telegram bot's poll-tick drain (voice-inbox-transcribe-drain.ts), the
 *    PRIMARY path, which attempts a new recording within one poll tick;
 *  - the pa `voice-inbox-fallback` maintenance job, a BACKSTOP for anything the
 *    bot did not finish. Its lane can stall silently, so nothing here treats it
 *    as a guarantee.
 * Every attempt: blackboard claim `voice-inbox-transcribe:<task_id>` → live
 * state recheck → audio checks → AI-239 infra bound → retry pacing →
 * transcribe_voice.py (process tree killed at its timeout) → task_transcribe.py.
 * task_transcribe.py's transcribing-only write-back stays the final guard
 * against a double write. Moved out of voice-inbox-fallback.ts, which
 * re-exports the moved symbols for existing importers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { paHome } from '../paths.js';
import { loadSecrets } from '../secrets.js';
import { resolvePythonCommand } from './python.js';
import { notifyUser } from './notify.js';
import { log } from './log.js';
import { killProcessTree } from '../process-tree.js';
import { blackboard } from '../blackboard.js';

const MINUTE = 60_000;

export const DEFAULT_MIN_AUDIO_BYTES = 8 * 1024; // 8 KB
/** AI-239: bounded auto-retry for transcription INFRA failures (good audio on
 *  disk — the 2026-09-13 14h-stranding class). A `transcribing` task
 *  accumulating this many prior `task.failed` markers with `payload.code ===
 *  'infra'` is marked terminally (`--code infra`, surfaces in the list) instead
 *  of retried again. The age window is the backstop bound that needs no writes:
 *  when markers cannot be recorded (voice-inbox package not built), retries
 *  still stop once the task outlives the window. */
export const DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS = 4;
export const DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS = 45 * MINUTE;
/** The fallback caller's transcribe_voice.py exec timeout — matches the
 *  PA_VOICE_TRANSCRIBE_TIMEOUT_MS default (docs/CONFIGURATION.md). The bot
 *  drain passes its own shorter value. */
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 600_000;
/** task_transcribe.py is a fast local sqlite write. */
export const WORKER_SCRIPT_TIMEOUT_MS = 30_000;
/** Next attempt after an infra marker is due this long after the NEWEST
 *  marker: index 0 = first marker, 1 = second, 2 = third or later. */
export const TRANSCRIBE_RETRY_BACKOFF_MS: readonly number[] = [2 * MINUTE, 5 * MINUTE, 10 * MINUTE];
export const TRANSCRIBE_CLAIM_AGENT = 'voice-inbox-transcribe';
/** Exit code reported for a run killed at its timeout (GNU timeout convention). */
export const TIMED_OUT_EXIT_CODE = 124;
const NEAR_SILENCE_ARTIFACT_MAX_WORDS = 3;
const MAX_CAPTURE_CHARS = 10 * 1024 * 1024;

export function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function envBytes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Non-negative int knob. Deliberately NOT envMs(): envMs maps every
 *  non-positive value to the fallback, which would turn "0 disables" into
 *  "0 means default". */
export function envCount(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export type TranscribeCaller = 'voice-inbox-fallback' | 'voice-inbox-transcribe-drain';

/** The columns one attempt needs (StuckTaskRow and the drain's candidate both satisfy it). */
export interface TranscribeTaskRow {
  task_id: string;
  tenant_id: string;
  created_at: string;
}

export interface InfraMarkers {
  count: number;
  /** Epoch ms of the newest infra marker's `ts`; undefined when count is 0 or unparseable. */
  newestMs: number | undefined;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  /** true only when the runner killed the process tree at its timeout. */
  timedOut?: boolean;
  /** the spawned python PID, when spawn succeeded. */
  pid?: number;
}

export type RunScriptFn = (
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
) => Promise<ExecResult>;

export interface TranscribeEnvelope {
  ok: boolean;
  text?: string;
  engine?: string;
  error?: string;
  error_code?: string;
}

export type TranscribeFn = (
  audioPath: string,
  cloudOrder: string,
  env: NodeJS.ProcessEnv
) => Promise<TranscribeEnvelope>;

// --- dynamic load of voice-inbox's OWN ledger/bridge-writer functions -------
// voice-inbox ships no .d.ts (its tsconfig has no "declaration": true) and pa's
// tsconfig is strict with no override for that package, so a literal static
// `import` here would fail to compile (TS2307/TS7016). A dynamic import()
// whose specifier is a computed value (not a string literal) is untyped by
// design and skips module resolution at compile time — this is the standard,
// zero-new-files way to consume a sibling package's compiled output without
// touching that package's build config. Requires projects/voice-inbox to have
// been built first (its dist/ is a real npm-buildable package, same as pa/bot;
// CI does not currently build it — see docs/maintenance-jobs.md's note on this
// job for the follow-up).

export interface VoiceInboxLedgerModule {
  transitionTask(
    db: Database.Database,
    tenantId: string,
    taskId: string,
    toState: string,
    input: {
      eventKind: string;
      routedTo?: string;
      routingReason?: string;
      eventPayload?: Record<string, unknown>;
    }
  ): { task: unknown; event: unknown };
  /** ledger.ts's non-transitional event writer — the AI-239 infra-attempt
   *  marker channel (a task.failed event with code 'infra' on a task that
   *  STAYS in transcribing). */
  appendEvent(
    db: Database.Database,
    tenantId: string,
    taskId: string,
    kind: string,
    input: { summary?: string; payload?: Record<string, unknown> }
  ): unknown;
  /** ledger.ts's router offer (typed routing, 2026-09-17). OPTIONAL: fakes in
   *  existing tests omit it, and the typed router reads absence as no offer.
   *  Pre-v14 rows carry no status word; v14 appends ` [<Word>]`. */
  listOpenConversations?(
    db: Database.Database,
    tenantId: string,
    options?: { excludeConversationId?: string }
  ): Array<{ conversationId: string; snippet: string }>;
}

export interface VoiceInboxBridgeWriterModule {
  appendRouteEntry(
    queuePath: string,
    input: {
      taskId: string;
      tenantId: string;
      chatId: number;
      threadId: number;
      text: string;
    }
  ): Promise<{ q_id: string; ref_id: string }>;
  buildTargetInjectionText(input: {
    taskId: string;
    requestText: string;
    reason: string;
    repoRoot: string;
    conversationBriefing?: string;
  }): string;
}

/** The conversation-briefing module (AI-conversation-context, Piece 1,
 *  2026-09-10) — loaded the same dynamic-import way as the other two
 *  voice-inbox modules; see the block comment above this section. */
export interface VoiceInboxBriefingModule {
  CONVERSATION_BRIEFING_MIN: number;
  buildConversationBriefing(
    db: Database.Database,
    tenantId: string,
    options: { conversationId: string; excludeTaskId: string; ledgerPath: string; maxChars: number }
  ): string;
  briefingBudget(baseLength: number, cap?: number): number;
  ledgerPathOf(db: Database.Database): string;
}

export interface VoiceInboxModules {
  ledger: VoiceInboxLedgerModule;
  bridgeWriter: VoiceInboxBridgeWriterModule;
  briefing: VoiceInboxBriefingModule;
}

export async function defaultLoadVoiceInboxModules(repoRoot: string): Promise<VoiceInboxModules> {
  const ledgerPath = join(repoRoot, 'projects', 'voice-inbox', 'dist', 'ledger.js');
  const bridgeWriterPath = join(repoRoot, 'projects', 'voice-inbox', 'dist', 'bridge-writer.js');
  const briefingPath = join(repoRoot, 'projects', 'voice-inbox', 'dist', 'conversation-briefing.js');
  const ledgerHref = pathToFileURL(ledgerPath).href;
  const bridgeWriterHref = pathToFileURL(bridgeWriterPath).href;
  const briefingHref = pathToFileURL(briefingPath).href;
  const ledger = (await import(ledgerHref)) as VoiceInboxLedgerModule;
  const bridgeWriter = (await import(bridgeWriterHref)) as VoiceInboxBridgeWriterModule;
  const briefing = (await import(briefingHref)) as VoiceInboxBriefingModule;
  return { ledger, bridgeWriter, briefing };
}

/** Same WAL/busy_timeout convention as the python worker scripts' open_ledger()
 *  and pa/src/lib/voice-inbox-ledger.ts's read-only accessor. Never creates
 *  schema: a missing file resolves to "nothing to do" via the caller's
 *  fail-open catch, exactly like the read-only accessor precedent. */
export function openReadonly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 3000');
  return db;
}

/** Same WAL/busy_timeout convention, opened for the ONE write this job ever
 *  makes (the stale-routed re-append's transitionTask call). Never creates
 *  schema, matching the python worker scripts' open_ledger() precondition —
 *  a missing ledger throws rather than silently minting an empty one. */
export function openLedgerForWrite(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error('ledger missing: start the server first');
  }
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 3000');
  db.pragma('journal_mode = WAL');
  return db;
}

export function findAudioFile(taskId: string): string | undefined {
  const dir = join(paHome(), 'voice-inbox', 'files', taskId);
  try {
    const entries = readdirSync(dir);
    const audio = entries.find((f) => /^audio\./i.test(f));
    return audio ? join(dir, audio) : undefined;
  } catch {
    return undefined;
  }
}

export function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

export function ageMinutes(createdAtIso: string, now: number): number {
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return 0;
  return Math.max(0, Math.round((now - createdMs) / MINUTE));
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logTranscribe(
  caller: TranscribeCaller,
  level: 'info' | 'warn',
  taskId: string,
  action: string,
  detail: Record<string, unknown>
): void {
  const refId = `s-${randomBytes(6).toString('hex')}`;
  const prefix = caller === 'voice-inbox-fallback' ? 'deterministic fallback' : 'deterministic transcription';
  log(level, caller, `${prefix}: ${action}`, { refId, taskId, action, ...detail });
}

/** AI-239 infra markers on one task: task.failed events whose payload carries
 *  code 'infra'. Count plus the newest marker's ts. Read-only; fail-open to
 *  {count: 0} — the age window is the always-available backstop bound. */
export function readInfraFailureMarkers(dbPath: string, tenantId: string, taskId: string): InfraMarkers {
  if (!existsSync(dbPath)) return { count: 0, newestMs: undefined };
  let db: Database.Database | undefined;
  try {
    db = openReadonly(dbPath);
    const rows = db
      .prepare(`SELECT payload_json, ts FROM events WHERE tenant_id = ? AND task_id = ? AND kind = 'task.failed'`)
      .all(tenantId, taskId) as { payload_json: string; ts: string }[];
    let count = 0;
    let newestMs: number | undefined;
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.payload_json);
        if (
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
          (parsed as Record<string, unknown>)['code'] === 'infra'
        ) {
          count += 1;
          const ms = Date.parse(row.ts);
          if (Number.isFinite(ms) && (newestMs === undefined || ms > newestMs)) newestMs = ms;
        }
      } catch {
        /* unparseable payload — not an infra marker */
      }
    }
    return { count, newestMs };
  } catch (err) {
    log('warn', 'voice-inbox-transcribe', 'infra-marker read failed; deferring to the age-window bound', {
      taskId,
      error: errText(err),
    });
    return { count: 0, newestMs: undefined };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** Kept for existing importers: the count half of readInfraFailureMarkers. */
export function countInfraFailureMarkers(dbPath: string, tenantId: string, taskId: string): number {
  return readInfraFailureMarkers(dbPath, tenantId, taskId).count;
}

export function retryBackoffMs(markerCount: number): number {
  if (markerCount <= 0) return 0;
  const i = Math.min(markerCount, TRANSCRIBE_RETRY_BACKOFF_MS.length) - 1;
  return TRANSCRIBE_RETRY_BACKOFF_MS[i];
}

/** True when an attempt may run now: no markers, or the newest marker is at
 *  least retryBackoffMs(count) old. */
export function transcribeAttemptDue(markers: InfraMarkers, now: number): boolean {
  if (markers.count <= 0 || markers.newestMs === undefined) return true;
  return now - markers.newestMs >= retryBackoffMs(markers.count);
}

/** The AI-239 give-up condition: the marker cap, or ≥1 recorded marker on a
 *  task older than the window (by created_at). Checked BEFORE pacing. */
export function infraBoundReached(
  markers: InfraMarkers,
  createdAtIso: string,
  now: number,
  maxAttempts: number,
  windowMs: number
): boolean {
  const ageMs = Math.max(0, now - (Date.parse(createdAtIso) || now));
  return markers.count >= maxAttempts || (markers.count >= 1 && ageMs > windowMs);
}

/** Runs `python <script> ...args`. At `timeoutMs` it kills the whole process
 *  tree by the captured PID and resolves IMMEDIATELY — it never waits for
 *  `close`, which a grandchild still holding the stdout pipe can delay
 *  indefinitely (execFile's own timeout killed only the direct child and
 *  still waited). Never rejects. */
export function defaultRunScript(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<ExecResult> {
  const python = resolvePythonCommand(env);
  return new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawn(python, [script, ...args], {
        env: { ...env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX: make the PID a process-group leader so killProcessTree's
        // group kill reaches the whole tree. Never on Windows (new console).
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      finish({ stdout: '', stderr: errText(err), code: 1 });
      return;
    }
    const pid = child.pid;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk;
    });
    child.on('error', (err) => finish({ stdout, stderr: stderr || err.message, code: 1, pid }));
    child.on('close', (code) => finish({ stdout, stderr, code: typeof code === 'number' ? code : 1, pid }));
    timer = setTimeout(() => {
      if (typeof pid === 'number') {
        try {
          killProcessTree(pid);
        } catch {
          /* best effort — the waiter is freed regardless */
        }
      }
      finish({
        stdout,
        stderr: `${stderr}\n[killed: ran past ${timeoutMs} ms; process tree of pid ${pid ?? 'unknown'} killed]`,
        code: TIMED_OUT_EXIT_CODE,
        timedOut: true,
        pid,
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

/** Runs pa/scripts/transcribe_voice.py and parses its one-line JSON envelope.
 *  Never throws. A timeout, spawn failure or unparseable stdout comes back as
 *  {ok:false, error_code:'other'} so callers classify it as infra. */
export async function defaultTranscribe(
  audioPath: string,
  cloudOrder: string,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
  runScript: RunScriptFn,
  timeoutMs: number = DEFAULT_TRANSCRIBE_TIMEOUT_MS
): Promise<TranscribeEnvelope> {
  const script = join(repoRoot, 'pa', 'scripts', 'transcribe_voice.py');
  const result = await runScript(script, [audioPath, '--cloud-order', cloudOrder], env, timeoutMs);
  if (result.timedOut) {
    return {
      ok: false,
      error_code: 'other',
      error: `transcription timed out after ${Math.round(timeoutMs / 1000)} s; its process tree was killed`,
    };
  }
  const lastLine = result.stdout.trim().split('\n').pop() ?? '';
  try {
    const parsed: unknown = JSON.parse(lastLine || '{}');
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { ok?: unknown }).ok === 'boolean') {
      return parsed as TranscribeEnvelope;
    }
  } catch {
    /* fall through to the unparseable envelope */
  }
  return {
    ok: false,
    error_code: 'other',
    error: `unparseable transcribe_voice.py output: ${result.stderr.slice(-300) || result.stdout.slice(-300)}`,
  };
}

export interface TranscribeClaim {
  release(): Promise<void>;
}

export function transcribeClaimResource(taskId: string): string {
  return `voice-inbox-transcribe:${taskId}`;
}

/** Try-once blackboard claim on one task's transcription. A fresh contextId
 *  per call means the SAME process cannot re-enter its own live claim. null =
 *  someone else holds it (or the store was momentarily busy). */
export async function acquireTranscribeClaim(taskId: string): Promise<TranscribeClaim | null> {
  const resource = transcribeClaimResource(taskId);
  const contextId = randomUUID();
  const ok = await blackboard.acquireLock(resource, TRANSCRIBE_CLAIM_AGENT, process.pid, 0, contextId);
  if (!ok) return null;
  return {
    release: () => blackboard.releaseLock(resource, TRANSCRIBE_CLAIM_AGENT, contextId, { pid: process.pid }),
  };
}

/** Live state of one task, read-only. undefined on a missing row, missing
 *  file or read error — callers treat undefined as "do not proceed". */
export function readTaskState(dbPath: string, taskId: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = openReadonly(dbPath);
    const row = db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(taskId) as { state: string } | undefined;
    return row?.state;
  } catch (err) {
    log('warn', 'voice-inbox-transcribe', 'live-state recheck failed; skipping rather than risking a duplicate attempt', {
      taskId,
      error: errText(err),
    });
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

export type TranscribeOutcomeKind =
  | 'transcribed'      // task_transcribe.py --transcript exited 0
  | 'failed-terminal'  // task_transcribe.py --fail exited 0 (audio-side, too_short, or infra give-up)
  | 'infra-marked'     // non-terminal infra marker written; task stays transcribing
  | 'infra-unwritten'  // marker could not be written; task stays transcribing
  | 'raced'            // the task was not transcribing when the claimed attempt began, or left it mid-attempt
  | 'not-due'          // the retry backoff has not elapsed
  | 'claim-busy'       // another holder owns the claim
  | 'script-failed';   // a task_transcribe.py call exited non-zero (incl. its state-gate refusal)

export interface TranscribeOutcome {
  /** Whether a durable change landed — the fallback's `touched` count reads this. */
  acted: boolean;
  kind: TranscribeOutcomeKind;
  /** Infra markers on the task after this attempt (0 when unknown). */
  markerCount: number;
}

export interface TranscribeTaskContext {
  caller: TranscribeCaller;
  now: number;
  repoRoot: string;
  ledgerPath: string;
  infraMaxAttempts: number;
  infraWindowMs: number;
}

export interface TranscribeTaskDeps {
  runScript: RunScriptFn;
  transcribeFn: TranscribeFn;
  loadSecretsFn: typeof loadSecrets;
  findAudioFileFn: (taskId: string) => string | undefined;
  fileSizeFn: (path: string) => number | undefined;
  loadVoiceInboxModules: (repoRoot: string) => Promise<VoiceInboxModules>;
  notifyFn: typeof notifyUser;
  claimFn: (taskId: string) => Promise<TranscribeClaim | null>;
}

type InfraMarkOutcome = 'marked' | 'raced' | 'unwritten';

/** AI-239: record ONE non-terminal infra attempt on a still-`transcribing`
 *  task — a `task.failed` event with `code: 'infra'` and NO state change,
 *  written through voice-inbox's own `appendEvent` (the same sanctioned
 *  dynamic-import seam the stale-routed/dead-dispatch arms use; the ledger
 *  is never hand-written). The marker is both the audit trail in the task's
 *  work log and the retry bound's counter (`countInfraFailureMarkers`).
 *  Fail-soft everywhere: a package-not-built or ledger error only means the
 *  marker is missing — the task stays `transcribing`, is re-selected next
 *  tick, and the age window still bounds the retries. The live-state recheck
 *  (same fail-closed idiom as isStillReceived/handleDeadDispatch) keeps a
 *  worker that wrote the transcript mid-attempt from gaining a bogus failure
 *  line on a now-`received` task. */
async function markInfraAttempt(
  task: TranscribeTaskRow,
  ctx: TranscribeTaskContext,
  reason: string,
  priorInfra: number,
  deps: Pick<TranscribeTaskDeps, 'loadVoiceInboxModules'>
): Promise<InfraMarkOutcome> {
  let modules: VoiceInboxModules;
  try {
    modules = await deps.loadVoiceInboxModules(ctx.repoRoot);
  } catch (err) {
    logTranscribe(ctx.caller, 'warn', task.task_id, 'transcribe-marker-skipped-package-not-built', {
      reason: 'voice-inbox package is not built; infra attempt left unrecorded — the age window still bounds retries',
      error: errText(err),
    });
    return 'unwritten';
  }
  let db: Database.Database | undefined;
  try {
    db = openLedgerForWrite(ctx.ledgerPath);
    const current = db
      .prepare('SELECT state FROM tasks WHERE tenant_id = ? AND task_id = ?')
      .get(task.tenant_id, task.task_id) as { state: string } | undefined;
    if (current?.state !== 'transcribing') {
      logTranscribe(ctx.caller, 'info', task.task_id, 'transcribe-infra-marker-skipped', {
        reason: 'task moved off transcribing since this job tick started; not recording a stale failure',
        state: current?.state ?? 'row-vanished',
      });
      return 'raced';
    }
    modules.ledger.appendEvent(db, task.tenant_id, task.task_id, 'task.failed', {
      payload: { reason, code: 'infra' },
    });
    logTranscribe(ctx.caller, 'info', task.task_id, 'transcribe-infra-retry', {
      reason,
      attempt: priorInfra + 1,
      ageMinutes: ageMinutes(task.created_at, ctx.now),
    });
    return 'marked';
  } catch (err) {
    logTranscribe(ctx.caller, 'warn', task.task_id, 'transcribe-infra-marker-failed', {
      error: errText(err),
    });
    return 'unwritten';
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** One transcription attempt for one task, from either caller. Never throws
 *  for an expected failure. Releases its claim on every path. */
export async function transcribeVoiceInboxTask(
  task: TranscribeTaskRow,
  ctx: TranscribeTaskContext,
  deps: TranscribeTaskDeps
): Promise<TranscribeOutcome> {
  let claim: TranscribeClaim | null;
  try {
    claim = await deps.claimFn(task.task_id);
  } catch (err) {
    logTranscribe(ctx.caller, 'warn', task.task_id, 'transcribe-claim-error', { error: errText(err) });
    claim = null;
  }
  if (claim === null) {
    logTranscribe(ctx.caller, 'info', task.task_id, 'transcribe-claim-busy', {});
    return { acted: false, kind: 'claim-busy', markerCount: 0 };
  }
  try {
    return await attemptUnderClaim(task, ctx, deps);
  } finally {
    try {
      await claim.release();
    } catch (err) {
      logTranscribe(ctx.caller, 'warn', task.task_id, 'transcribe-claim-release-error', { error: errText(err) });
    }
  }
}

async function attemptUnderClaim(
  task: TranscribeTaskRow,
  ctx: TranscribeTaskContext,
  deps: TranscribeTaskDeps
): Promise<TranscribeOutcome> {
  const { caller, now, repoRoot, ledgerPath, infraMaxAttempts, infraWindowMs } = ctx;
  const taskTranscribePy = join(repoRoot, 'projects', 'voice-inbox', 'scripts', 'task_transcribe.py');
  const minBytes = envBytes('PA_VOICE_INBOX_FALLBACK_MIN_AUDIO_BYTES', DEFAULT_MIN_AUDIO_BYTES);
  const reasonSuffix = caller === 'voice-inbox-fallback' ? ' (deterministic fallback)' : ' (deterministic transcription)';

  const liveState = readTaskState(ledgerPath, task.task_id);
  if (liveState !== 'transcribing') {
    logTranscribe(caller, 'info', task.task_id, 'transcribe-skipped-raced', { state: liveState ?? 'row-vanished' });
    return { acted: false, kind: 'raced', markerCount: 0 };
  }

  // AI-223: the three failure shapes below (sub-floor / empty / near-silence
  // artefact) are honest "nothing was really said" outcomes, not real
  // transcription/infra errors — coded `too_short` so the PWA can hide them
  // from the list and the triage count instead of leaving an unresolvable
  // "Not placed yet" row. Reason text is unchanged; `code` is additive.
  const fail = async (reason: string, code: string | undefined, markerCount: number): Promise<TranscribeOutcome> => {
    const args = ['--task', task.task_id, '--fail', '--reason', `${reason}${reasonSuffix}`];
    if (code) args.push('--code', code);
    const result = await deps.runScript(taskTranscribePy, args, process.env, WORKER_SCRIPT_TIMEOUT_MS);
    logTranscribe(caller, 'info', task.task_id, 'transcribe-fail', {
      reason,
      code,
      ageMinutes: ageMinutes(task.created_at, now),
      scriptExit: result.code,
    });
    return result.code === 0
      ? { acted: true, kind: 'failed-terminal', markerCount }
      : { acted: false, kind: 'script-failed', markerCount };
  };

  const audioPath = deps.findAudioFileFn(task.task_id);
  if (!audioPath) {
    return fail('audio file missing for this task', undefined, 0);
  }

  const bytes = deps.fileSizeFn(audioPath) ?? 0;
  const underFloor = bytes < minBytes;
  if (underFloor) {
    return fail(`audio file is ${bytes} bytes, under the ${minBytes}-byte floor — likely an accidental tap`, 'too_short', 0);
  }

  // AI-239 bound check BEFORE spending a transcription call. The marker-count
  // bound is the normal terminator. The age bound additionally requires >=1
  // RECORDED infra attempt: a task that merely sat `transcribing` past the
  // window (pa down, worker never ran — no failure was ever recorded) is not a
  // retry saga and still deserves its first real transcription attempt.
  const markers = readInfraFailureMarkers(ledgerPath, task.tenant_id, task.task_id);
  const priorInfra = markers.count;
  const taskAgeMs = Math.max(0, now - (Date.parse(task.created_at) || now));
  const overAge = taskAgeMs > infraWindowMs;

  const giveUpInfra = async (reason: string): Promise<TranscribeOutcome> => {
    const outcome = await fail(reason, 'infra', priorInfra);
    if (outcome.acted) {
      try {
        await deps.notifyFn(
          `Voice note transcription failed: ${task.task_id}`,
          `Transcription infrastructure has failed ${priorInfra} recorded attempt(s) ` +
            `(task age ${ageMinutes(task.created_at, now)} min); the task is now marked failed ` +
            `and the recording is still on disk under files/${task.task_id}/. ` +
            `Check transcription engine keys/connectivity, then re-record or recover by hand.`,
          { dedupKey: `voice-inbox-transcribe-failed:${task.task_id}`, severity: 'warn' }
        );
      } catch (err) {
        logTranscribe(caller, 'warn', task.task_id, 'transcribe-fail-notify-error', { error: errText(err) });
      }
    }
    return outcome;
  };

  if (infraBoundReached(markers, task.created_at, now, infraMaxAttempts, infraWindowMs)) {
    return giveUpInfra(
      `transcription infra failure persists — ${priorInfra} recorded infra attempt(s), ` +
        `age ${ageMinutes(task.created_at, now)} min — giving up`
    );
  }

  if (!transcribeAttemptDue(markers, now)) {
    logTranscribe(caller, 'info', task.task_id, 'transcribe-not-due', {
      markerCount: priorInfra,
      retryBackoffMs: retryBackoffMs(priorInfra),
    });
    return { acted: false, kind: 'not-due', markerCount: priorInfra };
  }

  const secrets = await deps.loadSecretsFn();
  const env = { ...process.env, ...secrets };
  const envelope = await deps.transcribeFn(audioPath, 'groq,openai,deepgram', env);

  if (!envelope.ok) {
    const code = envelope.error_code;
    const reason = `transcription failed (${code ?? 'error'}): ${envelope.error ?? 'unknown error'}`;
    // AI-239: audio-side codes are honest terminal failures (retrying cannot
    // shrink an oversize file or re-create a missing one); everything else —
    // no-engine, cloud-auth, ffmpeg-missing, other/network/timeout — is INFRA:
    // record a NON-TERMINAL marker (task.failed event, code 'infra', NO state
    // change — ledger appendEvent) and leave the task in transcribing so the
    // next tick retries it. The bound check above turns the markers terminal.
    if (code === 'missing-file' || code === 'oversize') {
      return fail(reason, undefined, priorInfra);
    }
    const mark = await markInfraAttempt(task, ctx, reason, priorInfra, deps);
    if (mark === 'unwritten' && overAge) {
      return giveUpInfra(
        `transcription infra failure persists — attempt could not be recorded ` +
          `(marker channel unavailable), age ${ageMinutes(task.created_at, now)} min exceeds the retry window — giving up`
      );
    }
    if (mark === 'marked') return { acted: true, kind: 'infra-marked', markerCount: priorInfra + 1 };
    if (mark === 'raced') return { acted: false, kind: 'raced', markerCount: priorInfra };
    return { acted: false, kind: 'infra-unwritten', markerCount: priorInfra };
  }

  const text = (envelope.text ?? '').trim();
  if (text.length === 0) {
    return fail('transcription produced an empty transcript', 'too_short', priorInfra);
  }
  const isArtifact = underFloor && wordCount(text) <= NEAR_SILENCE_ARTIFACT_MAX_WORDS;
  if (isArtifact) {
    return fail("transcript is Whisper's near-silence artefact on a sub-floor recording", 'too_short', priorInfra);
  }

  const args = ['--task', task.task_id, '--transcript', text];
  if (envelope.engine) args.push('--engine', envelope.engine);
  const result = await deps.runScript(taskTranscribePy, args, process.env, WORKER_SCRIPT_TIMEOUT_MS);
  logTranscribe(caller, 'info', task.task_id, 'transcribe-success', {
    engine: envelope.engine,
    chars: text.length,
    ageMinutes: ageMinutes(task.created_at, now),
    scriptExit: result.code,
  });
  return result.code === 0
    ? { acted: true, kind: 'transcribed', markerCount: priorInfra }
    : { acted: false, kind: 'script-failed', markerCount: priorInfra };
}
