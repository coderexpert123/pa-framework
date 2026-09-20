/**
 * Deterministic voice-inbox placement fallback (AI-214 follow-up F-A,
 * 2026-09-09 live incident).
 *
 * The promise of the voice-inbox app is that a recorded message gets PLACED
 * (transcribed and routed to a topic) — never silently stuck. On
 * 2026-09-09 that promise broke three separate times in one day: the
 * inbox-topic worker was quota-exhausted, cooling, or answered in chat
 * instead of running the routing script, and six voice notes sat untouched
 * until a human ran `transcribe_voice.py` / `task_transcribe.py` /
 * `route_task.py` by hand. This job automates exactly that hand
 * resolution — no LLM, no chat, deterministic scripts only — so placement
 * never depends on an LLM worker being healthy.
 *
 * Three independent actions, one per stuck shape:
 *  1. `transcribing` stuck  -> run transcribe_voice.py, then
 *     task_transcribe.py --transcript or --fail. AI-239: a failed envelope is
 *     classified by error_code — audio-side codes (missing-file, oversize)
 *     stay terminal immediately, while infra codes (no-engine, cloud-auth,
 *     ffmpeg-missing, other) record a NON-TERMINAL task.failed marker
 *     (payload.code 'infra', no state change, via the ledger's own
 *     appendEvent) and leave the task in `transcribing` for the next tick's
 *     retry. The bound: PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS
 *     markers (default 4), or a task with >=1 recorded marker outliving
 *     PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS (default 45 min,
 *     by created_at) — a task that merely SAT past the window with no
 *     recorded failure still gets its first real attempt; when the marker
 *     channel itself is broken (voice-inbox package not built) an over-age
 *     task terminates instead of retrying forever -> terminal
 *     --fail --code infra + an operator page. Audio-unusable shapes
 *     (sub-floor/empty/near-silence, code too_short) stay terminal as before.
 *     The transcription body now lives in the shared action
 *     (pa/src/lib/voice-inbox-transcribe.ts), built 2026-09-16 for a second,
 *     faster caller (the telegram bot's poll-tick drain) that is not wired
 *     up yet — until it lands and is verified live, this job remains the
 *     only caller of that action.
 *  2. `received` stuck (transcribed, never routed) -> route_task.py to a
 *     deterministic target (keyword table, else the inbox chat's
 *     general-knowledge topic), optionally merging into a very recent,
 *     near-identical open conversation via --continues.
 *  3. `routed` stuck (routed but no worker ever picked it up) -> replay the
 *     SAME mechanism the operator reroute endpoint uses (transitionTask +
 *     appendRouteEntry, both loaded from the voice-inbox package itself —
 *     never hand-built) to the same topic, so the injected line resends.
 *     Skipped when a sibling task of the same conversation is LIVE —
 *     carries a worker_resource AND is in state `running` or
 *     `awaiting_input`: workers claim one task row but work the whole
 *     conversation, so re-injecting a routed sibling of a live conversation
 *     double-delivers into a topic the conversation's worker is already
 *     handling (2026-09-11 triple-reroute incident, conversation
 *     vi-1415efecbf6b). A sibling blocks re-injection ONLY while it is in
 *     that live dispatch state — a terminal sibling (done/failed/cancelled/
 *     transcribe_failed) keeps its worker_resource as history and must
 *     never block, or every conversation that ever finished a task would be
 *     blocked forever (same-day incident, conversation vi-ce98d47bdfc7:
 *     routed 2+ hours with two DONE siblings, silently starved before this
 *     state restriction was added). A running sibling whose worker has
 *     since died is recovered by this job's own dead-dispatch action below
 *     — once that recovery moves its state, the routed sibling here
 *     unblocks on the next pass.
 *
 * Every action is read-driven off the ledger the app itself owns
 * (~/.pa/voice-inbox/ledger.sqlite) and mutates it ONLY through the same
 * surfaces a real worker or the app server would use: the worker scripts as
 * subprocesses, or voice-inbox's own compiled ledger/bridge-writer/
 * conversation-briefing functions (dynamically imported — voice-inbox ships
 * no `.d.ts`, and pa's strict tsconfig has no override for that package, so
 * a literal static import would fail to compile; a computed specifier is
 * untyped by design and skips module resolution at compile time — see
 * loadVoiceInboxModules). This job NEVER hand-builds a ledger write or a
 * route-queue line itself. The stale-routed and dead-dispatch replays
 * (action 3 and its running-task extension below) also thread a bounded
 * conversation briefing into the replayed injection text — same contract as
 * `projects/voice-inbox/CONTRACTS.md` § "Conversation briefing
 * (2026-09-10)" — so a follow-up re-injected by this job still carries the
 * conversation's prior turns, never an empty briefing.
 *
 * Every action is logged with a freshly minted ref-id
 * (`voice-inbox-fallback` module) naming which task/action/reason fired;
 * the worker-script `--reason` arguments (already required by the scripts'
 * own CLIs) are where "this was the deterministic fallback" surfaces inside
 * the ledger's own event payloads and the operator-visible injected text.
 * A separate `task.progress` ledger event was NOT added for this: it is
 * only a legal event kind from state `routed` (where it transitions the
 * task to `running`) or `running` itself (ledger.ts's
 * TRANSITION_EVENT_KINDS + task_transcribe.py's/task_telemetry.py's own
 * state gate) — none of the three actions here leave a task in `running`,
 * and forcing one would either violate the state gate or falsely claim a
 * worker picked the task up.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { paHome } from '../../../paths.js';
import { configPath } from '../../../paths.js';
import { loadSecrets } from '../../../secrets.js';
import { repoRootFromModule } from '../../git-root.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import {
  voiceInboxLedgerPath,
  VOICE_INBOX_TERMINAL_STATES,
  voiceInboxRunningWithDispatch,
  type RunningDispatchRow,
} from '../../voice-inbox-ledger.js';
import { VOICE_ROUTE_RETRY_REASON, voiceInboxRouteRetryPendingIds } from '../../voice-inbox-route-retry.js';
import {
  readVoiceInboxRoutingFileConfig,
  resolveVoiceInboxDefaultTopic,
  type VoiceInboxTypedRoutingConfig,
} from '../../voice-inbox-routing-config.js';
import { routeVoiceInboxTaskTyped, type TypedRouteOutcome } from '../../voice-inbox-typed-route-action.js';
import {
  listWorkerPids,
  removeWorkerPid,
  type WorkerPidEntry,
} from '../../../worker-pids.js';
import {
  areProcessesAlive,
  findProcessesByCommandLine,
  killProcessTree,
} from '../../../process-tree.js';
import type { MaintenanceJob, MaintenanceJobContext, MaintenanceJobResult } from '../types.js';
import {
  DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS,
  DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS,
  DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  WORKER_SCRIPT_TIMEOUT_MS,
  envMs,
  envCount,
  openReadonly,
  openLedgerForWrite,
  ageMinutes,
  findAudioFile,
  fileSize,
  defaultRunScript,
  defaultTranscribe,
  defaultLoadVoiceInboxModules,
  acquireTranscribeClaim,
  transcribeVoiceInboxTask,
  type RunScriptFn,
  type TranscribeFn,
  type TranscribeClaim,
  type VoiceInboxModules,
} from '../../voice-inbox-transcribe.js';
export {
  DEFAULT_MIN_AUDIO_BYTES,
  DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS,
  DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS,
  countInfraFailureMarkers,
  defaultLoadVoiceInboxModules,
} from '../../voice-inbox-transcribe.js';
export type {
  ExecResult,
  RunScriptFn,
  TranscribeEnvelope,
  TranscribeFn,
  VoiceInboxLedgerModule,
  VoiceInboxBridgeWriterModule,
  VoiceInboxBriefingModule,
  VoiceInboxModules,
} from '../../voice-inbox-transcribe.js';

const MODULE = 'voice-inbox-fallback';
const MINUTE = 60_000;

/** Dropped to 2 min (WP-F, 2026-09-16): WP-3a and WP-4 are both live and
 *  verified, so the bot's poll-tick drain now finishes a healthy
 *  transcription well inside 2 min and the routing worker itself no longer
 *  transcribes first. Two minutes is more than one idle poll tick (30 s
 *  long poll) plus a healthy cloud transcription (tens of seconds at
 *  most), so in a healthy system the drain finishes first — lowering it
 *  further would not add resilience, only tighten this job's own retry
 *  cadence, since the claim (not this timer) is what prevents a double
 *  attempt. */
export const DEFAULT_TRANSCRIBING_STALE_MS = 2 * MINUTE;
/** The received arm's own threshold (split from the transcribing arm
 *  2026-09-16): deterministic routing must not race the LLM routing worker
 *  any earlier than it did before the split. */
export const DEFAULT_RECEIVED_STALE_MS = 6 * MINUTE;
export const DEFAULT_ROUTED_STALE_MS = 20 * MINUTE;
export const DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS = 20 * MINUTE;
/** 10× the 30-s executor heartbeat cadence (the worker-pids entry file's
 *  mtime), margin for WMI-stall tick skipping; an executor wedge longer than
 *  this falls back to kill-before-replay. */
export const DEFAULT_SUPERVISION_STALE_MS = 5 * MINUTE;
/** Bounded-noise stuck-placement alert (2026-09-12 dispatch-reliability
 *  incident, thread t-58): when a task already carries this many prior
 *  task.rerouted events, the replay pages the operator before re-injecting
 *  again — unbounded silent retries were the diagnosed gap (task
 *  vi-7ab45f7bd3b7: four re-injections over 95 minutes, no pickup, no alert).
 *  0 disables the alert entirely; retries continue either way — the alert
 *  NEVER gates the replay (a voice note's content is irreplaceable and the
 *  incident itself proved recovery happens once a worker returns). */
/** The failure reason a never-routed task gets when no deterministic target
 *  exists (no inbox_topic, no keyword match, no override). Plain language —
 *  it renders on the operator's card (answer register). ≤300 chars
 *  (TaskFailedPayload). */
export const NEVER_ROUTED_FAILED_REASON =
  'This request stopped before it was passed on to anyone, so nothing was done. Send it again to retry.';

export const DEFAULT_REROUTE_ALERT_AFTER = 3;
const JOB_EVERY_MS = 5 * MINUTE;

const CONTINUES_WINDOW_MS = 3 * MINUTE;
const CONTINUES_WORD_OVERLAP_MIN = 0.6;

function envEnabled(): boolean {
  return process.env.PA_VOICE_INBOX_FALLBACK !== '0';
}

// --- ledger row shape (only the columns this job reads) ---------------------

export interface StuckTaskRow {
  task_id: string;
  tenant_id: string;
  state: string;
  request_text: string;
  transcript: string | null;
  routed_to: string | null;
  conversation_id: string;
  created_at: string;
  updated_at: string;
}

/** Select every task this job might act on: transcribing tasks stale by
 *  created_at past transcribingStaleMs, received tasks past receivedStaleMs,
 *  and routed tasks stale by updated_at (time since
 *  routing, not original creation — a task can sit in transcribing for a
 *  long time before finally routing). The transcribing/received arms share
 *  a no-worker_resource filter — once a real worker claims a task, this job
 *  leaves it alone. The routed arm needs no such filter: entering `routed`
 *  clears worker identity (2026-09-12), so a routed row with identity is a
 *  legacy pre-fix leftover this scan heals (see the comment at the query).
 *  The routed half additionally requires that NO task of the same conversation is
 *  currently LIVE — has a worker_resource AND is in state `running` or
 *  `awaiting_input`: workers claim one task row but work the whole
 *  conversation, so an unclaimed routed sibling is left to that worker
 *  while it is active, rather than re-injected into a topic the worker is
 *  already delivering into (2026-09-11 triple-reroute incident,
 *  conversation vi-1415efecbf6b). A sibling blocks ONLY while live: once a
 *  task reaches a terminal state (done/failed/cancelled/transcribe_failed)
 *  its worker_resource survives forever as history and must not keep
 *  blocking — an earlier version of this guard tested worker_resource
 *  presence alone (any state) and so starved every later routed sibling of
 *  a conversation that had ever finished a task (same-day incident,
 *  conversation vi-ce98d47bdfc7: routed 2+ hours with two DONE siblings).
 *  This deliberately reads narrower than voice-inbox's own
 *  conversationWorkerResource (any state, any worker_resource) — that
 *  reader answers "who last touched this conversation", this one answers
 *  "is anyone working it right now". A running sibling whose worker has
 *  since died is not left blocking forever either: this job's own
 *  dead-dispatch action (below) recovers it, and once that recovery moves
 *  its state off `running`, the routed sibling here unblocks on the job's
 *  next pass. Early-stage placement stays per-task: a new note recorded
 *  into a busy conversation still gets transcribed/routed.
 *  Fail-open: any read failure (missing ledger, missing table) returns []. */
export function selectStuckTasks(
  dbPath: string,
  now: number,
  transcribingStaleMs: number,
  routedStaleMs: number,
  receivedStaleMs: number
): StuckTaskRow[] {
  if (!existsSync(dbPath)) return [];
  let db: Database.Database | undefined;
  try {
    db = openReadonly(dbPath);
    const cols =
      'task_id, tenant_id, state, request_text, transcript, routed_to, conversation_id, created_at, updated_at';
    const transcribingCutoff = new Date(now - transcribingStaleMs).toISOString();
    const routedCutoff = new Date(now - routedStaleMs).toISOString();
    const receivedCutoff = new Date(now - receivedStaleMs).toISOString();

    const earlyStage = db
      .prepare(
        `SELECT ${cols} FROM tasks
         WHERE (worker_resource IS NULL OR worker_resource = '')
           AND ((state = 'transcribing' AND created_at <= ?) OR (state = 'received' AND created_at <= ?))
         ORDER BY created_at ASC`
      )
      .all(transcribingCutoff, receivedCutoff) as StuckTaskRow[];

    // The routed arm deliberately does NOT filter on worker_resource. Since
    // 2026-09-12, entering `routed` clears worker identity (voice-inbox
    // transitionTask), so a routed row carrying a worker_resource is
    // impossible-by-construction for anything written after that fix: the
    // only matches are legacy pre-fix replay leftovers — a dead worker's
    // identity the old replay never cleared — which this scan previously
    // EXCLUDED, orphaning them between this arm and the dead-dispatch
    // selector (2026-09-12 dispatch-reliability incident: task
    // vi-c1f51a157e11 silent 10:03-11:05; task vi-35a4487d5c04 silent
    // >30 h). One replay normalizes such a row: the replay's own
    // transitionTask clears the stale identity. The live-sibling NOT EXISTS
    // guard below remains the real "is anyone working this conversation"
    // protection and applies to these rows exactly as to fresh ones.
    const staleRouted = db
      .prepare(
        `SELECT ${cols} FROM tasks
         WHERE state = 'routed'
           AND updated_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM tasks AS claimed
             WHERE claimed.tenant_id = tasks.tenant_id
               AND claimed.conversation_id = tasks.conversation_id
               AND claimed.worker_resource IS NOT NULL
               AND claimed.worker_resource != ''
               AND claimed.state IN ('running', 'awaiting_input')
           )
         ORDER BY updated_at ASC`
      )
      .all(routedCutoff) as StuckTaskRow[];

    return [...earlyStage, ...staleRouted];
  } catch (err) {
    log('warn', MODULE, 'failed to read voice-inbox ledger; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** Re-reads one task's live `state`, read-only. Used immediately before a
 *  write this job is about to make on a `received` task, to close the race
 *  between `selectStuckTasks`'s snapshot (taken once per job tick) and the
 *  moment this job actually acts, which can be a minute or more later given
 *  the transcription/routing work in between. A real (LLM) worker can pick
 *  the same task up and route it in that window — route_task.py's own state
 *  gate allows re-routing FROM 'routed' (that's how handleStaleRouted's
 *  legitimate re-injection works), so without this check a fallback call that
 *  started while the task was still `received` would still succeed after a
 *  live worker already routed it, silently overwriting a correct, freshly
 *  made routing decision with the fallback's own generic default (observed
 *  live: vi-7d9f91d0e907, routed by an LLM worker to a specific dev-tooling
 *  topic at 10:49:04, then re-routed by this job to the generic
 *  general-knowledge topic 5 seconds later at 10:49:09 — the exact failure
 *  mode behind the vi-6cb5faaf1b74 bug report). Fail-closed (returns false,
 *  meaning "do not proceed"): unlike the other read-only helpers in this file,
 *  a read failure here must not be treated as "safe to act" — the whole point
 *  is avoiding an unverified write. */
function isStillReceived(dbPath: string, taskId: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: Database.Database | undefined;
  try {
    db = openReadonly(dbPath);
    const row = db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(taskId) as
      | { state: string }
      | undefined;
    return row?.state === 'received';
  } catch (err) {
    log('warn', MODULE, 'live-state recheck failed; skipping this task rather than risking a stale write', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** The newest non-terminal task in the same tenant, excluding `excludeTaskId`,
 *  read-only. Fail-open: any error returns undefined (no merge candidate). */
function findContinuationCandidate(
  dbPath: string,
  tenantId: string,
  excludeTaskId: string
): StuckTaskRow | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: Database.Database | undefined;
  try {
    db = openReadonly(dbPath);
    const terminal = [...VOICE_INBOX_TERMINAL_STATES];
    const placeholders = terminal.map(() => '?').join(',');
    const row = db
      .prepare(
        `SELECT task_id, tenant_id, state, request_text, transcript, routed_to, conversation_id, created_at, updated_at
         FROM tasks
         WHERE tenant_id = ? AND task_id != ? AND state NOT IN (${placeholders})
         ORDER BY created_at DESC, task_id DESC
         LIMIT 1`
      )
      .get(tenantId, excludeTaskId, ...terminal) as StuckTaskRow | undefined;
    return row;
  } catch (err) {
    log('warn', MODULE, 'continuation lookup failed; treating as standalone', {
      error: err instanceof Error ? err.message : String(err),
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

/** Word-set Jaccard similarity (intersection / union) over lowercased,
 *  punctuation-stripped tokens. The spec's "shares >= 60% of words" doesn't
 *  pin an exact formula; Jaccard is the standard reading of "shares X% of
 *  words" between two short utterances. */
export function wordOverlap(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter((w) => w.length > 0)
    );
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// --- config (read directly from ~/.pa/config.yaml; no PaConfig schema change) --

interface FallbackAppConfig {
  inboxTopic?: string;
  keywordTopics: Record<string, string>;
  /** voice_inbox.default_topic (2026-09-17). */
  defaultTopic?: string;
  /** voice_inbox_routing when enabled (TypeSafe typed routing, 2026-09-17). */
  typedRouting?: VoiceInboxTypedRoutingConfig;
}

/** Reads voice_inbox.inbox_topic / default_topic, voice_inbox_fallback.keyword_topics
 *  and voice_inbox_routing off the shared config.yaml through the one raw reader
 *  (voice-inbox-routing-config.ts), independent of pa's typed loadConfig().
 *  Fail-soft: a missing file or block yields an empty table and no inbox topic;
 *  unset fields are omitted. */
export function readFallbackAppConfig(): FallbackAppConfig {
  const file = readVoiceInboxRoutingFileConfig();
  const out: FallbackAppConfig = { keywordTopics: file.keywordTopics };
  if (file.inboxTopic !== undefined) out.inboxTopic = file.inboxTopic;
  if (file.defaultTopic !== undefined) out.defaultTopic = file.defaultTopic;
  if (file.typedRouting !== undefined) out.typedRouting = file.typedRouting;
  return out;
}

/** Why resolveTargetDetailed picked a target — 'keyword' is a real bucket fit
 *  (a table entry matched), 'override' is the PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC
 *  env pin (an explicit operator "route everything unmatched HERE"), and
 *  'general-knowledge' is the generic bucket the fallback falls through to. */
export type FallbackTargetBasis = 'keyword' | 'override' | 'general-knowledge';

/** Deterministic target topic for a `received` task, with the decision's
 *  basis. The basis is what the route-stage topic-creation decision reads
 *  (2026-09-14 operator feature): a task whose target basis is
 *  'general-knowledge' fit NO bucket, so the fallback asks route_task.py to
 *  form a topic instead of forcing the generic bucket — an 'override' target
 *  is an explicit operator choice of bucket and suppresses creation. */
export function resolveTargetDetailed(
  requestText: string,
  cfg: FallbackAppConfig
): { topic: string; basis: FallbackTargetBasis } | undefined {
  const lower = requestText.toLowerCase();

  for (const [keyword, topic] of Object.entries(cfg.keywordTopics)) {
    if (keyword && lower.includes(keyword)) return { topic, basis: 'keyword' };
  }
  // The one default-topic resolver (2026-09-17): env PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC,
  // then voice_inbox.default_topic — both explicit operator pins ('override') —
  // then thread 0 of the inbox chat ('general-knowledge').
  const resolved = resolveVoiceInboxDefaultTopic({ inboxTopic: cfg.inboxTopic, configDefault: cfg.defaultTopic });
  if (!resolved) return undefined;
  return { topic: resolved.topic, basis: resolved.source === 'inbox-chat' ? 'general-knowledge' : 'override' };
}

/** Deterministic target topic for a `received` task: the first keyword table
 *  entry whose key appears (case-insensitively) in the transcript, else the
 *  inbox chat's general-knowledge topic (thread 0) — the same chat the
 *  voice-inbox app's own inbox_topic uses, per the 2026-09-09 incident
 *  resolution. Returns undefined only when no inbox_topic is configured at
 *  all AND no keyword matched (nothing deterministic to route to). */
export function resolveTarget(requestText: string, cfg: FallbackAppConfig): string | undefined {
  return resolveTargetDetailed(requestText, cfg)?.topic;
}

function routeQueuePath(): string {
  return join(paHome(), 'voice-inbox', 'route-queue.jsonl');
}

/** First ~140 chars of the request text for the stuck-placement alert body. */
function excerptOf(text: string): string {
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

/** Prior task.rerouted event count for one task — the replay counter the
 *  stuck-placement threshold reads. Tenant-scoped like the ledger's own
 *  listEvents reader. */
function countReroutes(db: Database.Database, tenantId: string, taskId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND task_id = ? AND kind = 'task.rerouted'`
    )
    .get(tenantId, taskId) as { n: number };
  return row.n;
}

/** created_at for the alert's age line. StuckTaskRow carries it, but the
 *  dead-dispatch selector (RunningDispatchRow in pa/src/lib/voice-inbox-ledger.ts)
 *  does not — read it off the already-open handle rather than widening that
 *  selector's column list for an alert-only field. */
function readCreatedAt(db: Database.Database, tenantId: string, taskId: string): string | undefined {
  const row = db
    .prepare('SELECT created_at FROM tasks WHERE tenant_id = ? AND task_id = ?')
    .get(tenantId, taskId) as { created_at: string } | undefined;
  return row?.created_at;
}

function logAction(taskId: string, action: string, detail: Record<string, unknown>): void {
  const refId = `s-${randomBytes(6).toString('hex')}`;
  log('info', MODULE, `deterministic fallback: ${action}`, { refId, taskId, action, ...detail });
}

/** Same ref-id-minting convention as logAction, at 'warn' level — for
 *  environment/infra faults (a missing build artifact), never for ordinary
 *  no-target-configured skip decisions (those stay 'info' via logAction). */
function logWarnAction(taskId: string, action: string, detail: Record<string, unknown>): void {
  const refId = `s-${randomBytes(6).toString('hex')}`;
  log('warn', MODULE, `deterministic fallback: ${action}`, { refId, taskId, action, ...detail });
}

/** The typed received-arm route (2026-09-17): the shared typed action as the
 *  LAST resort — acts on the top destination at any confidence. */
function defaultTypedRouteFn(runScript: RunScriptFn): NonNullable<VoiceInboxFallbackDeps['typedRouteFn']> {
  return (task, c) =>
    routeVoiceInboxTaskTyped(
      task.task_id,
      {
        caller: MODULE,
        repoRoot: c.repoRoot,
        ledgerPath: c.ledgerPath,
        fileConfig: {
          keywordTopics: c.cfg.keywordTopics,
          ...(c.cfg.inboxTopic !== undefined ? { inboxTopic: c.cfg.inboxTopic } : {}),
          ...(c.cfg.defaultTopic !== undefined ? { defaultTopic: c.cfg.defaultTopic } : {}),
          ...(c.cfg.typedRouting !== undefined ? { typedRouting: c.cfg.typedRouting } : {}),
        },
        lastResort: true,
        reasonSuffix: ` It waited ${c.minutes} minutes for a worker first.`,
      },
      { runScript }
    );
}

// --- injectable dependencies -------------------------------------------------

export interface VoiceInboxFallbackDeps {
  nowFn?: () => number;
  runScript?: RunScriptFn;
  transcribeFn?: TranscribeFn;
  loadSecretsFn?: typeof loadSecrets;
  loadVoiceInboxModules?: (repoRoot: string) => Promise<VoiceInboxModules>;
  repoRootFn?: () => Promise<string>;
  findAudioFileFn?: (taskId: string) => string | undefined;
  fileSizeFn?: (path: string) => number | undefined;
  readConfigFn?: () => FallbackAppConfig;
  ledgerPathFn?: () => string;
  listWorkerPidsFn?: () => Promise<WorkerPidEntry[]>;
  /** OS-truth readers for the dead-dispatch decision (t-31 fix 1, 2026-09-13).
   *  Defaults are process-tree's snapshot-backed exports (ONE cached OS query,
   *  never per-PID CIM); tests inject canned maps/scans. Same hook shape as
   *  bgtasks.ts / worker-edit-audit-sweep.ts. */
  areProcessesAliveFn?: (pids: number[]) => Promise<Map<number, boolean>>;
  findProcessesByCommandLineFn?: (
    needle: string
  ) => Promise<Array<{ pid: number; cmdline: string }>>;
  /** Kill-path doubles for kill-before-replay (t-32 fix 2, 2026-09-13). Defaults
   *  are the same pa modules /stop uses (process-tree.killProcessTree,
   *  worker-pids.removeWorkerPid); tests MUST inject recorders — the defaults
   *  fire a REAL OS taskkill and delete real registry files. */
  killProcessFn?: (pid: number) => void;
  removeWorkerPidFn?: (pid: number) => Promise<void>;
  /** Operator alert channel. Default notifyUser; tests inject a recorder.
   *  Same injectable-dep precedent as c-disk-floor-watchdog. */
  notifyFn?: typeof notifyUser;
  /** Transcription claim (2026-09-16). Default acquireTranscribeClaim (the
   *  blackboard); tests inject a double. */
  claimFn?: (taskId: string) => Promise<TranscribeClaim | null>;
  /** Typed received-arm route (2026-09-17). Default: the shared typed action
   *  as last resort. Consulted only when voice_inbox_routing is enabled. */
  typedRouteFn?: (
    task: StuckTaskRow,
    ctx: { repoRoot: string; ledgerPath: string; cfg: FallbackAppConfig; minutes: number }
  ) => Promise<TypedRouteOutcome>;
}

// --- per-shape actions --------------------------------------------------------

export async function handleReceived(
  task: StuckTaskRow,
  now: number,
  repoRoot: string,
  ledgerPath: string,
  cfg: FallbackAppConfig,
  deps: Required<Pick<VoiceInboxFallbackDeps, 'runScript' | 'typedRouteFn'>>
): Promise<boolean> {
  const scripts = join(repoRoot, 'projects', 'voice-inbox', 'scripts');
  const routeTaskPy = join(scripts, 'route_task.py');
  const minutes = ageMinutes(task.created_at, now);

  // TypeSafe typed routing (2026-09-17): when voice_inbox_routing is enabled,
  // this arm places through the SAME typed action the bot's drain uses, as the
  // last resort (top destination at any confidence; operator decision D8).
  // A placement returns; a race or a busy claim leaves the task for the next
  // pass; an escalation (client unavailable, no topics, no text) or a failed
  // route_task.py run falls through to today's keyword table below.
  if (cfg.typedRouting) {
    const outcome = await deps.typedRouteFn(task, { repoRoot, ledgerPath, cfg, minutes });
    if (outcome.kind === 'placed') {
      logAction(task.task_id, 'route', {
        target: outcome.action.topicKey,
        basis: 'typesafe',
        typedBasis: outcome.action.basis,
        createTopicRequested: outcome.action.kind === 'create-topic',
        ageMinutes: minutes,
        continues: outcome.action.kind === 'route' && outcome.action.continues !== undefined,
        scriptExit: 0,
      });
      return true;
    }
    if (outcome.kind === 'raced' || outcome.kind === 'claim-busy') {
      logAction(task.task_id, 'route-skipped', { reason: `typed routing did not place it (${outcome.kind})` });
      return false;
    }
    logAction(task.task_id, 'typed-route-fell-back', {
      why: outcome.kind === 'escalated' ? outcome.why : `script-exit-${outcome.scriptExit}`,
    });
  }

  const target = resolveTargetDetailed(task.request_text, cfg);
  if (!target) {
    logAction(task.task_id, 'route-skipped', { reason: 'no deterministic target available (no inbox_topic configured)' });
    return false;
  }

  const args = [
    '--task', task.task_id,
    '--topic', target.topic,
    '--reason', `Placed by the deterministic fallback after ${minutes} minutes without a worker routing it`,
  ];

  const candidate = findContinuationCandidate(ledgerPath, task.tenant_id, task.task_id);
  if (candidate) {
    const createdGapMs = Math.abs(Date.parse(task.created_at) - Date.parse(candidate.created_at));
    const overlap = wordOverlap(task.request_text, candidate.request_text);
    if (createdGapMs <= CONTINUES_WINDOW_MS && overlap >= CONTINUES_WORD_OVERLAP_MIN) {
      args.push('--continues', candidate.task_id);
    }
  }

  // Route-stage topic creation (operator feature, 2026-09-14): when the task
  // fit NO keyword bucket AND the target is the generic general-knowledge
  // bucket (an 'override' target is an explicit operator choice of bucket and
  // suppresses this), the fallback asks route_task.py to FORM a topic from
  // the transcript/request instead of forcing the nearest bucket. Formation
  // and every failure path live inside route_task.py, which then falls back
  // to --topic with a reason note — placement never depends on formation
  // succeeding. A task merging into an existing conversation (--continues
  // above) never mints a topic.
  if (target.basis === 'general-knowledge' && !args.includes('--continues')) {
    args.push('--create-topic');
  }

  // Re-check right before acting, as late as possible: `task` is a snapshot
  // from selectStuckTasks, taken at the START of this job tick, and the
  // transcription/routing work above can take a while — long enough for a
  // real (LLM) worker to have routed this same task in the meantime. Once
  // that happens the task is no longer `received`, and route_task.py would
  // otherwise still accept it (its state gate allows re-routing FROM
  // 'routed' too, which is exactly how the legitimate stale-routed replay
  // works) — so without this guard the fallback silently clobbers a fresh,
  // correct routing decision with its own generic keyword-table default. See
  // isStillReceived's doc comment for the live incident this closes.
  if (!isStillReceived(ledgerPath, task.task_id)) {
    logAction(task.task_id, 'route-skipped', {
      reason: 'task moved off received (a live worker routed it) since this job tick started; not clobbering it',
    });
    return false;
  }

  const result = await deps.runScript(routeTaskPy, args, process.env, WORKER_SCRIPT_TIMEOUT_MS);
  logAction(task.task_id, 'route', {
    target: target.topic,
    basis: target.basis,
    createTopicRequested: args.includes('--create-topic'),
    ageMinutes: minutes,
    continues: args.includes('--continues'),
    scriptExit: result.code,
  });
  return result.code === 0;
}

async function handleStaleRouted(
  task: StuckTaskRow,
  now: number,
  repoRoot: string,
  ledgerPath: string,
  cfg: FallbackAppConfig,
  deps: Required<Pick<VoiceInboxFallbackDeps, 'loadVoiceInboxModules' | 'notifyFn'>>,
  rerouteAlertAfter: number
): Promise<boolean> {
  // Routing-retry placement (2026-09-16): a task the bot returned to its
  // routing thread's topic whose retry ALSO ended unrouted is placed through
  // the dead-dispatch arm's never-routed branch (same recheck, target, event
  // and failure path) — never replayed into the routing thread's topic.
  if (task.routed_to && voiceInboxRouteRetryPendingIds([task.task_id], ledgerPath).has(task.task_id)) {
    return handleDeadDispatch(
      {
        task_id: task.task_id,
        tenant_id: task.tenant_id,
        conversation_id: task.conversation_id,
        routed_to: task.routed_to,
        request_text: task.request_text,
        worker_dispatch_id: '',
        updated_at: task.updated_at,
      },
      now,
      repoRoot,
      ledgerPath,
      cfg,
      deps,
      rerouteAlertAfter,
      undefined,
      'routed'
    );
  }
  const topic = task.routed_to;
  if (!topic || !/^-?\d+_\d+$/.test(topic)) {
    logAction(task.task_id, 'reroute-skipped', { reason: 'routed_to is missing or malformed', routedTo: task.routed_to });
    return false;
  }
  const match = /^(-?\d+)_(\d+)$/.exec(topic)!;
  const chatId = Number(match[1]);
  const threadId = Number(match[2]);
  const minutes = ageMinutes(task.updated_at, now);
  const reason = `Placed by the deterministic fallback after ${minutes} minutes without a worker picking up the route`;

  // Fails open when the voice-inbox package has never been built (fresh
  // clone, CI, a worktree that never ran its build) — this dynamic import is
  // an environment precondition, not a per-task decision, so it gets its own
  // catch (never the generic per-task catch in the caller) with a dedicated
  // warn line naming the missing module. Never throws into catchup, never
  // retries in a tight loop: the next tick's stale-routed scan tries again.
  let modules: VoiceInboxModules;
  try {
    modules = await deps.loadVoiceInboxModules(repoRoot);
  } catch (err) {
    logWarnAction(task.task_id, 'reroute-skipped-package-not-built', {
      reason: 'voice-inbox package is not built; skipping the stale-routed replay until it is',
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const { ledger, bridgeWriter, briefing } = modules;

  let conversationBriefing = '';
  let db: Database.Database | undefined;
  try {
    db = openLedgerForWrite(ledgerPath);
    // Bounded-noise stuck-placement alert: count PRIOR re-routes (before this
    // replay adds its own event); past the threshold, notify the operator
    // BEFORE re-injecting. The notify is in its own try/catch and the replay
    // ALWAYS proceeds — an alert failure must never block a delivery that
    // would otherwise land (same rule as the briefing failure below).
    const rerouteCount = countReroutes(db, task.tenant_id, task.task_id);
    if (rerouteAlertAfter > 0 && rerouteCount >= rerouteAlertAfter) {
      try {
        const createdAt = readCreatedAt(db, task.tenant_id, task.task_id) ?? task.updated_at;
        await deps.notifyFn(
          `Voice-inbox task stuck: ${task.task_id}`,
          `Re-routed ${rerouteCount} times by the deterministic fallback, still no worker pickup ` +
            `(age ${ageMinutes(createdAt, now)} min).\n` +
            `Target topic: ${topic}\n` +
            `Request: ${excerptOf(task.request_text)}\n` +
            `Re-injecting now; if this keeps repeating, check worker fleet health.`,
          { dedupKey: `voice-inbox-stuck:${task.task_id}`, severity: 'warn' }
        );
      } catch (err) {
        logWarnAction(task.task_id, 'stuck-alert-failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    ledger.transitionTask(db, task.tenant_id, task.task_id, 'routed', {
      eventKind: 'task.rerouted',
      routedTo: topic,
      routingReason: reason,
      eventPayload: { from: topic, to: topic, reason },
    });
    // A briefing failure must never abort a replay that would otherwise
    // deliver (§6.3 E32) — its own try/catch, db still open, transitionTask
    // already committed.
    try {
      const base = bridgeWriter.buildTargetInjectionText({
        taskId: task.task_id,
        requestText: task.request_text,
        reason,
        repoRoot,
      });
      const budget = briefing.briefingBudget(base.length);
      if (budget >= briefing.CONVERSATION_BRIEFING_MIN) {
        conversationBriefing = briefing.buildConversationBriefing(db, task.tenant_id, {
          conversationId: task.conversation_id,
          excludeTaskId: task.task_id,
          ledgerPath: briefing.ledgerPathOf(db),
          maxChars: budget,
        });
      }
    } catch (err) {
      logAction(task.task_id, 'briefing-skipped', { error: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    logAction(task.task_id, 'reroute-failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }

  try {
    await bridgeWriter.appendRouteEntry(routeQueuePath(), {
      taskId: task.task_id,
      tenantId: task.tenant_id,
      chatId,
      threadId,
      text: bridgeWriter.buildTargetInjectionText({
        taskId: task.task_id,
        requestText: task.request_text,
        reason,
        repoRoot,
        conversationBriefing,
      }),
    });
  } catch (err) {
    // State + event already landed (matches routes.ts's own rerouteHandler
    // tolerance for a lost append: visible, re-routable next tick).
    logAction(task.task_id, 'reroute-append-failed', { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  logAction(task.task_id, 'reroute', { topic, ageMinutes: minutes });
  return true;
}

/** t-31 fix 1 (2026-09-13) + t-32 fix 2 (2026-09-13): OS-truth evidence for ONE
 *  dispatch, returned as the set of pids that are ALIVE on this machine. Empty
 *  set = no live process found = the only basis on which the dead-dispatch arm
 *  may conclude "dead". Two prongs, in fixed order:
 *   1. Registry pids resolved against the OS: the worker-pids entries matching
 *      this dispatch id contribute their wrapper pid plus every recorded
 *      descendant (the wrapper can die while the real CLI child lives —
 *      worker-pids.ts's own doc), and process-tree's snapshot answers alive/dead.
 *      A registry entry alone is a HINT: a registry that can silently lose or
 *      outlive its entries (bot restarts) must never be load-bearing here.
 *   2. Command-line scan by dispatch id, reached ONLY when prong 1 found
 *      nothing alive: scan the snapshot's command lines for the dispatch id
 *      itself — catches the live-but-unregistered process. On POSIX the shared
 *      snapshot carries no command lines, so prong 2 finds no scan evidence
 *      there (a miss is never positive evidence of death — an empty set is the
 *      correct "no evidence" answer). On Windows the dispatch id is env-only
 *      (PA_WORKER_DISPATCH_ID, in no command line), so prong 2 is inert in
 *      production today — kept correct-by-construction, NOT "fixed" (t-31
 *      residual, operator-acknowledged).
 *  A dispatch id is 12 hex chars; a substring hit inside an unrelated longer id
 *  is astronomically unlikely and the design pins the scan to the id as-is.
 *  Pure decision over injected reads: no logging, no policy, no kills. The
 *  returned set IS the kill-before-replay target set, so the alive decision and
 *  the kill collection cannot drift apart. */
export async function collectDispatchAliveTargets(
  dispatchId: string,
  registeredEntries: WorkerPidEntry[],
  areProcessesAliveFn: (pids: number[]) => Promise<Map<number, boolean>>,
  scanCommandLines: (needle: string) => Promise<Array<{ pid: number; cmdline: string }>>
): Promise<Set<number>> {
  const targets = new Set<number>();
  if (!dispatchId) return targets;
  const candidates = new Set<number>();
  for (const entry of registeredEntries) {
    if (entry.dispatchId !== dispatchId) continue;
    candidates.add(entry.pid);
    for (const pid of entry.descendants ?? []) candidates.add(pid);
  }
  if (candidates.size > 0) {
    const aliveByPid = await areProcessesAliveFn([...candidates]);
    for (const [pid, alive] of aliveByPid) {
      if (alive) targets.add(pid);
    }
    if (targets.size > 0) return targets;
  }
  const matches = await scanCommandLines(dispatchId);
  for (const match of matches) targets.add(match.pid);
  return targets;
}

/** Boolean wrapper over collectDispatchAliveTargets — the t-31 fix-1 API,
 *  unchanged in meaning: true iff at least one live process backs this
 *  dispatch. Kept exported (pa/CLAUDE.md documents it) so the alive DECISION
 *  and the kill TARGET collection stay one implementation. */
export async function isDispatchAliveOnMachine(
  dispatchId: string,
  registeredEntries: WorkerPidEntry[],
  areProcessesAliveFn: (pids: number[]) => Promise<Map<number, boolean>>,
  scanCommandLines: (needle: string) => Promise<Array<{ pid: number; cmdline: string }>>
): Promise<boolean> {
  const targets = await collectDispatchAliveTargets(
    dispatchId,
    registeredEntries,
    areProcessesAliveFn,
    scanCommandLines
  );
  return targets.size > 0;
}

/** Age of the freshest executor heartbeat among registry entries for ONE
 *  dispatch, in ms — undefined when no entry carries a heartbeatAt (no
 *  registry entry, pre-change entry file, or stat failure): the caller
 *  treats undefined as stale. */
export function freshestSupervisionAgeMs(
  dispatchId: string,
  registeredEntries: WorkerPidEntry[],
  now: number
): number | undefined {
  let freshest: number | undefined;
  for (const entry of registeredEntries) {
    if (entry.dispatchId !== dispatchId) continue;
    if (typeof entry.heartbeatAt !== 'number' || !Number.isFinite(entry.heartbeatAt)) continue;
    const age = now - entry.heartbeatAt;
    if (freshest === undefined || age < freshest) freshest = age;
  }
  return freshest;
}

/** One kill attempt's outcome. `attempted` = at least one live target was found
 *  and kill attempts were issued; `allDead` = every target confirmed dead after
 *  the attempts (vacuously true when nothing was alive). */
interface KillAttempt {
  attempted: boolean;
  allDead: boolean;
  killedPids: number[];
  survivors: number[];
}

/** t-32 fix 2: the pa-side mirror of /stop's kill mechanism, for ONE dispatch.
 *  Kills every alive target (wrapper + descendants — D5), logs heartbeat age
 *  and the pid list, then re-checks. Registry entries are removed ONLY on a
 *  confirmed-clean kill (D4): a surviving pid must keep its registry evidence
 *  so the next pass can find and re-kill it — removing it earlier would let the
 *  next pass judge the (still-alive) dispatch dead and double-dispatch around
 *  the survivor. All failures are isolated per pid / per entry; the recheck is
 *  the only call allowed to throw (into the caller's per-candidate catch —
 *  kills issued + unknown liveness must never lead to a replay). */
async function attemptKillBeforeReplay(
  task: RunningDispatchRow,
  aliveTargets: Set<number>,
  registeredEntries: WorkerPidEntry[],
  now: number,
  deps: Required<Pick<VoiceInboxFallbackDeps, 'areProcessesAliveFn' | 'killProcessFn' | 'removeWorkerPidFn'>>
): Promise<KillAttempt> {
  if (aliveTargets.size === 0) {
    return { attempted: false, allDead: true, killedPids: [], survivors: [] };
  }
  const targets = [...aliveTargets].sort((a, b) => a - b);
  logAction(task.task_id, 'kill-before-replay', {
    dispatchId: task.worker_dispatch_id,
    heartbeatAgeMinutes: ageMinutes(task.updated_at, now),
    killTargets: targets,
  });
  const killedPids: number[] = [];
  for (const pid of targets) {
    try {
      deps.killProcessFn(pid);
      killedPids.push(pid);
    } catch (err) {
      logWarnAction(task.task_id, 'kill-error', {
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const after = await deps.areProcessesAliveFn(targets);
  const survivors = targets.filter((pid) => after.get(pid) === true);
  if (survivors.length > 0) {
    // Deliberately NO entry removal here (D4). Safe direction on a stale read:
    // a fresh kill read as a survivor only delays the replay to the next pass.
    logAction(task.task_id, 'kill-incomplete', { survivors, killedPids });
    return { attempted: true, allDead: false, killedPids, survivors };
  }
  for (const entry of registeredEntries) {
    if (entry.dispatchId !== task.worker_dispatch_id) continue;
    try {
      await deps.removeWorkerPidFn(entry.pid);
    } catch (err) {
      logWarnAction(task.task_id, 'registry-remove-error', {
        pid: entry.pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logAction(task.task_id, 'kill-complete', { killedPids });
  return { attempted: true, allDead: true, killedPids, survivors: [] };
}

/** Never-routed placement's honest end: no deterministic target exists, so
 *  the task fails with NEVER_ROUTED_FAILED_REASON and one pa-alerts page
 *  instead of hanging open. Same live recheck as the placement (fail-closed):
 *  only a task still in the expected state and routed_to — and, for a
 *  routing-retry task, still carrying VOICE_ROUTE_RETRY_REASON — is failed. */
async function failNeverRoutedTask(
  task: RunningDispatchRow,
  repoRoot: string,
  ledgerPath: string,
  deps: Required<Pick<VoiceInboxFallbackDeps, 'loadVoiceInboxModules' | 'notifyFn'>>,
  expected: { state: string; routedTo: string | null; retried: boolean }
): Promise<boolean> {
  let modules: VoiceInboxModules;
  try {
    modules = await deps.loadVoiceInboxModules(repoRoot);
  } catch (err) {
    logWarnAction(task.task_id, 'running-skipped-package-not-built', {
      reason: 'voice-inbox package is not built; skipping the never-routed failure until it is',
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  let db: Database.Database | undefined;
  try {
    db = openLedgerForWrite(ledgerPath);
    const current = db
      .prepare('SELECT state, routed_to, routing_reason FROM tasks WHERE tenant_id = ? AND task_id = ?')
      .get(task.tenant_id, task.task_id) as
      | { state: string; routed_to: string | null; routing_reason: string | null }
      | undefined;
    if (
      !current ||
      current.state !== expected.state ||
      (current.routed_to ?? null) !== expected.routedTo ||
      (expected.retried && current.routing_reason !== VOICE_ROUTE_RETRY_REASON)
    ) {
      logAction(task.task_id, 'never-routed-fail-skipped', {
        state: current?.state ?? 'row-vanished',
        routedTo: current?.routed_to ?? null,
      });
      return false;
    }
    modules.ledger.transitionTask(db, task.tenant_id, task.task_id, 'failed', {
      eventKind: 'task.failed',
      eventPayload: { reason: NEVER_ROUTED_FAILED_REASON },
    });
  } catch (err) {
    logAction(task.task_id, 'never-routed-fail-failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
  try {
    await deps.notifyFn(
      `Voice-inbox request could not be placed: ${task.task_id}`,
      `A request stopped in the inbox without being routed, and no fallback target is configured ` +
        `(voice_inbox.inbox_topic, voice_inbox_fallback.keyword_topics, PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC). ` +
        `It was marked failed.\nRequest: ${excerptOf(task.request_text)}`,
      { dedupKey: `voice-inbox-never-routed-failed:${task.task_id}`, severity: 'warn' }
    );
  } catch (err) {
    logWarnAction(task.task_id, 'never-routed-alert-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  logAction(task.task_id, 'never-routed-failed', {});
  return true;
}

/** AI-221 fallback extension (C4/C5): a `running` task whose dispatch shows NO
 *  live process on the machine (t-31 fix 1: decided by `isDispatchAliveOnMachine`
 *  — registry pids against the OS snapshot plus a command-line scan — never by
 *  registry membership alone, which bot restarts turned into a silent
 *  never-replayed drop) has nothing left driving it — its
 *  spawner is gone and no future orphan-reap cycle will ever revive it, so
 *  it replays the SAME mechanism as a stale-routed task
 *  (transitionTask + appendRouteEntry). `voiceInboxRunningWithDispatch`'s own
 *  `worker_dispatch_id IS NOT NULL AND != ''` clause (C4) is what keeps this
 *  from ever seeing the broker's own standing auth tasks — this function
 *  only ever runs on a row that already carries a real dispatch id. */
async function handleDeadDispatch(
  task: RunningDispatchRow,
  now: number,
  repoRoot: string,
  ledgerPath: string,
  cfg: FallbackAppConfig,
  deps: Required<Pick<VoiceInboxFallbackDeps, 'loadVoiceInboxModules' | 'notifyFn'>>,
  rerouteAlertAfter: number,
  kill?: { killedPids: number[] },
  expectedState: 'running' | 'routed' = 'running'
): Promise<boolean> {
  // Never-routed placement (2026-09-16, vi-d79c09c5eb37): an inbox routing
  // run moved the task to running (task_telemetry.py stamps its dispatch) and
  // ended without route_task.py, so routed_to is NULL. There is no topic to
  // replay to — the task is placed ONCE, as a first routing, to the received
  // arm's deterministic target over the already-legal running -> routed edge.
  // routed_to is never cleared afterwards, so this branch cannot recur.
  // Routing-retry placement (2026-09-16): the bot returned this task to its
  // routing thread's topic once (routing_reason = VOICE_ROUTE_RETRY_REASON) and
  // that retry ALSO ended unrouted — placed like a never-routed task, never
  // replayed into the routing thread's topic.
  const retried = !!task.routed_to && voiceInboxRouteRetryPendingIds([task.task_id], ledgerPath).has(task.task_id);
  const neverRouted = !task.routed_to || retried;
  let topic: string | null = task.routed_to;
  if (neverRouted) {
    const target = resolveTargetDetailed(task.request_text, cfg);
    if (!target) {
      return failNeverRoutedTask(task, repoRoot, ledgerPath, deps, {
        state: expectedState,
        routedTo: task.routed_to,
        retried,
      });
    }
    topic = target.topic;
  }
  if (!topic || !/^-?\d+_\d+$/.test(topic)) {
    logAction(task.task_id, 'running-skipped', { reason: 'routed_to is missing or malformed', routedTo: task.routed_to });
    return false;
  }
  const match = /^(-?\d+)_(\d+)$/.exec(topic)!;
  const chatId = Number(match[1]);
  const threadId = Number(match[2]);
  const minutes = ageMinutes(task.updated_at, now);
  // AI-221 (2026-09-14): the kill path previously wrote "no live worker
  // process" over a 15-process live tree — the mislabel misdirected the
  // operator report. Killed vs never-alive now carry distinct reasons; the
  // trailing guidance is byte-identical on both branches.
  const reason = neverRouted
    ? `Placed by the deterministic fallback: the inbox run stopped ${minutes} minutes ago without passing the request on to a topic`
    : ((kill !== undefined
      ? `Re-dispatched by the deterministic fallback after the previous run's worker processes were killed — no progress telemetry for ${minutes} minutes and no live supervising executor for its dispatch (AI-221)`
      : `Re-dispatched by the deterministic fallback after ${minutes} minutes running with no live worker process for its dispatch (AI-221)`) +
    ' — if a prior pass of this task left a yes/no confirmation pending in chat, claim the task and raise the app card with task_input.py (kind confirm); never gate the decision in chat');

  // Same environment-precondition catch as handleStaleRouted: the
  // voice-inbox package not being built is an infra fault, not a per-task
  // decision, so it gets its own catch with a dedicated warn line.
  let modules: VoiceInboxModules;
  try {
    modules = await deps.loadVoiceInboxModules(repoRoot);
  } catch (err) {
    logWarnAction(task.task_id, 'running-skipped-package-not-built', {
      reason: 'voice-inbox package is not built; skipping the dead-dispatch replay until it is',
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const { ledger, bridgeWriter, briefing } = modules;

  let conversationBriefing = '';
  let db: Database.Database | undefined;
  try {
    db = openLedgerForWrite(ledgerPath);
    // t-32 fix 2: a task that already reached a terminal state is never redone.
    // Single-row re-read on the ALREADY-OPEN write connection, as late as
    // possible before the write (same live-recheck idiom as isStillReceived
    // above): between voiceInboxRunningWithDispatch's scan and this moment the
    // task can finish through its own worker's late telemetry, and a replay
    // would redo finished work. Deliberately fail-CLOSED — a read error throws
    // into the catch below and skips this tick's replay. This is the opposite
    // of voiceInboxTerminalTaskIds's fail-open contract, which serves the bot's
    // non-blocking lookups and is wrong for gating a destructive redo (D3).
    // A vanished row skips too: there is nothing left to re-dispatch.
    const current = db
      .prepare('SELECT state, routed_to, routing_reason FROM tasks WHERE tenant_id = ? AND task_id = ?')
      .get(task.tenant_id, task.task_id) as
      | { state: string; routed_to: string | null; routing_reason: string | null }
      | undefined;
    if (!current || VOICE_INBOX_TERMINAL_STATES.has(current.state)) {
      logAction(task.task_id, 'running-skip-terminal', {
        state: current?.state ?? 'row-vanished',
      });
      return false;
    }
    // A never-routed (or routing-retry) task that anyone moved since the scan
    // is theirs: someone routed it (the operator's reroute endpoint, or the
    // retry run's own route_task.py), or a worker picked it up (state
    // changed) — transitionTask's COALESCE would otherwise overwrite that
    // routing with this job's generic target.
    if (
      neverRouted &&
      (current.state !== expectedState ||
        (current.routed_to ?? null) !== (task.routed_to ?? null) ||
        (retried && current.routing_reason !== VOICE_ROUTE_RETRY_REASON))
    ) {
      logAction(task.task_id, 'running-skip-routed-meanwhile', { routedTo: current.routed_to, state: current.state });
      return false;
    }
    // Bounded-noise stuck-placement alert: count PRIOR re-routes (before this
    // replay adds its own event); past the threshold, notify the operator
    // BEFORE re-injecting. The notify is in its own try/catch and the replay
    // ALWAYS proceeds — an alert failure must never block a delivery that
    // would otherwise land (same rule as the briefing failure below).
    const rerouteCount = countReroutes(db, task.tenant_id, task.task_id);
    if (rerouteAlertAfter > 0 && rerouteCount >= rerouteAlertAfter) {
      try {
        const createdAt = readCreatedAt(db, task.tenant_id, task.task_id) ?? task.updated_at;
        await deps.notifyFn(
          `Voice-inbox task stuck: ${task.task_id}`,
          `Re-routed ${rerouteCount} times by the deterministic fallback, still no worker pickup ` +
            `(age ${ageMinutes(createdAt, now)} min).\n` +
            `Target topic: ${topic}\n` +
            `Request: ${excerptOf(task.request_text)}\n` +
            `Re-injecting now; if this keeps repeating, check worker fleet health.`,
          { dedupKey: `voice-inbox-stuck:${task.task_id}`, severity: 'warn' }
        );
      } catch (err) {
        logWarnAction(task.task_id, 'stuck-alert-failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // t-32 fix 3: one short system line to the TARGET THREAD (not pa-alerts).
    // Skipped for a never-routed placement: it is a first delivery to that
    // topic, not a re-dispatch (handleReceived sends no such line either).
    // Via notifyFn with a topic override — a notifyUser topic message is
    // bot-posted, never enters getUpdates, never spawns a worker; a route-queue
    // entry WOULD spawn one and must never be used for this. Own try/catch: a
    // notify failure must never block the replay (same rule as the stuck alert
    // and the briefing). Fires only on actual replays (D7).
    if (!neverRouted) {
      try {
        const killed = kill !== undefined;
        const subject = killed
          ? `Previous run killed for not heartbeating: ${task.task_id}`
          : `Worker missing, re-dispatching task: ${task.task_id}`;
        const body = killed
          ? `The previous run of this task (dispatch ${task.worker_dispatch_id}) was killed for not heartbeating — no progress telemetry for ${minutes} minutes — and the task is being re-dispatched.\n` +
            `A genuinely working run must emit progress telemetry (task_telemetry.py).`
          : `No live worker process was found for this task's dispatch for ${minutes} minutes; the task is being re-dispatched.\n` +
            `A genuinely working run must emit progress telemetry (task_telemetry.py).`;
        await deps.notifyFn(subject, body, {
          dedupKey: `voice-inbox-redispatch:${task.task_id}:${task.worker_dispatch_id}`,
          severity: killed ? 'warn' : 'info',
          topic: { chat_id: String(chatId), thread_id: threadId },
        });
      } catch (err) {
        logWarnAction(task.task_id, 'redispatch-notify-failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    ledger.transitionTask(db, task.tenant_id, task.task_id, 'routed', neverRouted && !retried
      ? {
          eventKind: 'task.routed',
          routedTo: topic,
          routingReason: reason,
          eventPayload: { routed_to: topic, reason },
        }
      : {
          eventKind: 'task.rerouted',
          routedTo: topic,
          routingReason: reason,
          eventPayload: { from: task.routed_to ?? topic, to: topic, reason },
        });
    // A briefing failure must never abort a replay that would otherwise
    // deliver (§6.3 E33, mirroring E32). `RunningDispatchRow` now selects
    // `conversation_id` (pa/src/lib/voice-inbox-ledger.ts, E34 fix closing
    // the gap the WP-3 report flagged) — read the same way handleStaleRouted
    // reads it off StuckTaskRow, no defensive cast needed.
    try {
      const base = bridgeWriter.buildTargetInjectionText({
        taskId: task.task_id,
        requestText: task.request_text,
        reason,
        repoRoot,
      });
      const budget = briefing.briefingBudget(base.length);
      if (budget >= briefing.CONVERSATION_BRIEFING_MIN) {
        conversationBriefing = briefing.buildConversationBriefing(db, task.tenant_id, {
          conversationId: task.conversation_id,
          excludeTaskId: task.task_id,
          ledgerPath: briefing.ledgerPathOf(db),
          maxChars: budget,
        });
      }
    } catch (err) {
      logAction(task.task_id, 'briefing-skipped', { error: err instanceof Error ? err.message : String(err) });
    }
  } catch (err) {
    logAction(task.task_id, 'running-reroute-failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }

  try {
    await bridgeWriter.appendRouteEntry(routeQueuePath(), {
      taskId: task.task_id,
      tenantId: task.tenant_id,
      chatId,
      threadId,
      text: bridgeWriter.buildTargetInjectionText({
        taskId: task.task_id,
        requestText: task.request_text,
        reason,
        repoRoot,
        conversationBriefing,
      }),
    });
  } catch (err) {
    // State + event already landed (matches handleStaleRouted's own
    // tolerance for a lost append: visible, re-routable next tick).
    logAction(task.task_id, 'running-reroute-append-failed', { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  logAction(task.task_id, neverRouted ? 'never-routed-placed' : 'running-reroute', {
    topic,
    ageMinutes: minutes,
    dispatchId: task.worker_dispatch_id,
    ...(retried ? { retried: true } : {}),
  });
  return true;
}

// --- job entry point ----------------------------------------------------------

export async function runVoiceInboxFallback(
  ctx: MaintenanceJobContext,
  deps: VoiceInboxFallbackDeps = {}
): Promise<MaintenanceJobResult> {
  if (!envEnabled()) {
    return { touched: 0, detail: { skipped: 'disabled via PA_VOICE_INBOX_FALLBACK=0' } };
  }

  const nowFn = deps.nowFn ?? (() => ctx.now);
  const now = nowFn();
  const repoRootFn = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const ledgerPathFn = deps.ledgerPathFn ?? voiceInboxLedgerPath;
  const readConfigFn = deps.readConfigFn ?? readFallbackAppConfig;
  const runScript = deps.runScript ?? defaultRunScript;
  const loadVoiceInboxModules = deps.loadVoiceInboxModules ?? defaultLoadVoiceInboxModules;
  const loadSecretsFn = deps.loadSecretsFn ?? loadSecrets;
  const findAudioFileFn = deps.findAudioFileFn ?? findAudioFile;
  const fileSizeFn = deps.fileSizeFn ?? fileSize;
  const listWorkerPidsFn = deps.listWorkerPidsFn ?? listWorkerPids;
  const killProcessFn = deps.killProcessFn ?? killProcessTree;
  const removeWorkerPidFn = deps.removeWorkerPidFn ?? removeWorkerPid;
  const notifyFn = deps.notifyFn ?? notifyUser;
  const claimFn = deps.claimFn ?? acquireTranscribeClaim;
  const typedRouteFn = deps.typedRouteFn ?? defaultTypedRouteFn(runScript);

  const ledgerPath = ledgerPathFn();
  const transcribingStaleMs = envMs('PA_VOICE_INBOX_FALLBACK_TRANSCRIBING_STALE_MS', DEFAULT_TRANSCRIBING_STALE_MS);
  const routedStaleMs = envMs('PA_VOICE_INBOX_FALLBACK_ROUTED_STALE_MS', DEFAULT_ROUTED_STALE_MS);
  const receivedStaleMs = envMs('PA_VOICE_INBOX_FALLBACK_RECEIVED_STALE_MS', DEFAULT_RECEIVED_STALE_MS);
  const runningStaleMs = envMs('PA_VOICE_INBOX_FALLBACK_RUNNING_STALE_MS', DEFAULT_RUNNING_DEAD_DISPATCH_STALE_MS);
  const supervisionStaleMs = envMs('PA_VOICE_INBOX_FALLBACK_SUPERVISION_STALE_MS', DEFAULT_SUPERVISION_STALE_MS);
  const rerouteAlertAfter = envCount('PA_VOICE_INBOX_FALLBACK_REROUTE_ALERT_AFTER', DEFAULT_REROUTE_ALERT_AFTER);
  const infraMaxAttempts = envCount('PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS', DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS);
  const infraWindowMs = envMs('PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS', DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS);

  const stuck = selectStuckTasks(ledgerPath, now, transcribingStaleMs, routedStaleMs, receivedStaleMs);
  const runningCutoff = new Date(now - runningStaleMs).toISOString();
  const runningCandidates = voiceInboxRunningWithDispatch(runningCutoff);

  if (stuck.length === 0 && runningCandidates.length === 0) {
    return { touched: 0, detail: { transcribing: 0, received: 0, routed: 0, running: 0 } };
  }

  const repoRoot = await repoRootFn();
  const transcribeFn: TranscribeFn =
    deps.transcribeFn ??
    ((audioPath, cloudOrder, env) => defaultTranscribe(audioPath, cloudOrder, env, repoRoot, runScript, DEFAULT_TRANSCRIBE_TIMEOUT_MS));

  let touched = 0;
  const counts = { transcribing: 0, received: 0, routed: 0, running: 0 };

  for (const task of stuck) {
    try {
      let acted = false;
      if (task.state === 'transcribing') {
        const outcome = await transcribeVoiceInboxTask(
          task,
          { caller: 'voice-inbox-fallback', now, repoRoot, ledgerPath, infraMaxAttempts, infraWindowMs },
          { runScript, transcribeFn, loadSecretsFn, findAudioFileFn, fileSizeFn, loadVoiceInboxModules, notifyFn, claimFn }
        );
        acted = outcome.acted;
        if (acted) counts.transcribing += 1;
      } else if (task.state === 'received') {
        acted = await handleReceived(task, now, repoRoot, ledgerPath, readConfigFn(), { runScript, typedRouteFn });
        if (acted) counts.received += 1;
      } else if (task.state === 'routed') {
        acted = await handleStaleRouted(task, now, repoRoot, ledgerPath, readConfigFn(), { loadVoiceInboxModules, notifyFn }, rerouteAlertAfter);
        if (acted) counts.routed += 1;
      }
      if (acted) touched += 1;
    } catch (err) {
      // Per-task isolation (the queue-drain per-source idiom): one task's
      // unexpected failure must never stop the rest of the batch.
      log('warn', MODULE, 'action failed for one task; continuing with the rest', {
        taskId: task.task_id,
        state: task.state,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (runningCandidates.length > 0) {
    // The worker-pids registry is a HINT (candidate pids + descendants); the
    // DECISION is OS truth (t-31 fix 1): a registered-but-dead pid must not
    // keep a task unserved forever, and an unregistered-but-alive worker must
    // not be double-dispatched. Fetched once per pass, not per-row: the
    // registry read and the ONE OS snapshot both serve every candidate in
    // this tick (process-tree's 300ms TTL cache makes the second prong free).
    // Since t-32, an OS-alive dispatch is first kill-before-replay'd
    // (attemptKillBeforeReplay), not skipped.
    const registeredEntries = await listWorkerPidsFn();
    const areAliveFn = deps.areProcessesAliveFn ?? areProcessesAlive;
    const scanCmdlinesFn = deps.findProcessesByCommandLineFn ?? findProcessesByCommandLine;
    for (const task of runningCandidates) {
      try {
        const aliveTargets = await collectDispatchAliveTargets(
          task.worker_dispatch_id,
          registeredEntries,
          areAliveFn,
          scanCmdlinesFn
        );
        let killContext: { killedPids: number[] } | undefined;
        if (aliveTargets.size > 0) {
          // AI-221 (2026-09-14, task vi-7790f35108f8): a FRESH executor
          // heartbeat proves the dispatch is alive AND supervised — the
          // executor's own idle/no-progress/evaluator/absolute-timeout ladder
          // owns hang recovery (it correctly killed the dead agy attempt in
          // 23 s that day); killing here duplicated a healthy streaming run
          // that was 21 min between voluntary telemetry emissions. When that
          // ladder finally kills a hung run, done() removes the registry
          // entry and the next 5-min pass sees a genuinely dead dispatch and
          // replays — recovery is delayed, never lost.
          const supervisionAgeMs = freshestSupervisionAgeMs(task.worker_dispatch_id, registeredEntries, now);
          if (supervisionAgeMs !== undefined && supervisionAgeMs < supervisionStaleMs) {
            logAction(task.task_id, 'running-skipped-supervised', {
              dispatchId: task.worker_dispatch_id,
              heartbeatAgeSeconds: Math.round(supervisionAgeMs / 1000),
              livePids: aliveTargets.size,
            });
            continue;
          }
          // Alive-but-silent past the staleness window: kill through the /stop
          // mechanism's pa-side mirror (t-32 fix 2), then replay only on a
          // confirmed-clean kill. A surviving pid aborts this pass — the next
          // 5-min pass retries the kill (its registry evidence was kept, D4);
          // never knowingly double-dispatch.
          const kill = await attemptKillBeforeReplay(task, aliveTargets, registeredEntries, now, {
            areProcessesAliveFn: areAliveFn,
            killProcessFn,
            removeWorkerPidFn,
          });
          if (!kill.allDead) continue;
          killContext = { killedPids: kill.killedPids };
        }
        const acted = await handleDeadDispatch(
          task,
          now,
          repoRoot,
          ledgerPath,
          readConfigFn(),
          { loadVoiceInboxModules, notifyFn },
          rerouteAlertAfter,
          killContext
        );
        if (acted) {
          counts.running += 1;
          touched += 1;
        }
      } catch (err) {
        log('warn', MODULE, 'action failed for one task; continuing with the rest', {
          taskId: task.task_id,
          state: 'running',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { touched, detail: counts };
}

export const voiceInboxFallbackJob: MaintenanceJob = {
  name: 'voice-inbox-fallback',
  host: 'pa',
  everyMs: JOB_EVERY_MS,
  description:
    'Deterministic voice-inbox placement fallback (AI-214 follow-up F-A, 2026-09-09 incident): every 5 min, ' +
    'selects tasks stuck in transcribing past PA_VOICE_INBOX_FALLBACK_TRANSCRIBING_STALE_MS (default 2 min) ' +
    'or received past PA_VOICE_INBOX_FALLBACK_RECEIVED_STALE_MS (default 6 min), both by created_at with no ' +
    'worker_resource, or stuck routed past PA_VOICE_INBOX_FALLBACK_ROUTED_STALE_MS (default 20 min, by ' +
    'updated_at), and does exactly what the operator did by hand: runs ' +
    'transcribe_voice.py + task_transcribe.py (failing sub-floor/empty/near-silence-artefact audio honestly ' +
    'via PA_VOICE_INBOX_FALLBACK_MIN_AUDIO_BYTES, default 8 KB), routes received tasks via route_task.py to a ' +
    'deterministic target (config.yaml voice_inbox_fallback.keyword_topics, else the inbox chat\'s ' +
    'general-knowledge topic), and replays a stale routed task\'s queue injection via voice-inbox\'s own ' +
    'transitionTask + appendRouteEntry (never hand-built) — except when a task of the same conversation is ' +
    'LIVE (carries a worker_resource AND is state running/awaiting_input): workers claim one task row but ' +
    'work the whole conversation, so an unclaimed routed sibling is left to them instead of re-injected while ' +
    'they are active; a sibling whose worker_resource is left over from a terminal state does not block ' +
    '(2026-09-11 double-routing fix, narrowed same-day to live states only after it starved a conversation ' +
    'with a finished sibling). ' +
    'Transcription failures are classified (AI-239, 2026-09-13 stranding incident): audio-side envelope codes ' +
    '(missing-file, oversize) and the sub-floor/empty/near-silence shapes (code too_short) fail terminally as ' +
    'before, while infra codes (no-engine, cloud-auth, ffmpeg-missing, other) write a NON-TERMINAL task.failed ' +
    'marker (payload code infra, no state change, via ledger appendEvent) and stay in transcribing for the next ' +
    'tick\u2019s retry; past PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS (default 4) recorded markers, or ' +
    'with \u22651 marker past PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS (default 45 min, by created_at — ' +
    'a never-attempted task still gets its first real try; an unrecordable over-age attempt terminates ' +
    'instead), the task goes terminally transcribe_failed with code infra and pa-alerts is paged once (dedup ' +
    'voice-inbox-transcribe-failed:<task_id>). ' +
    'A fourth action (AI-221 extension, auth broker ' +
    'Phase A, 2026-09-10; OS-truth decision since 2026-09-13) re-dispatches running tasks whose dispatch shows ' +
    'no live process on the machine — the worker-pids registry\'s pids+descendants checked against the OS ' +
    'process snapshot, plus a command-line scan by dispatch id, never registry membership alone (t-31) — ' +
    'past PA_VOICE_INBOX_FALLBACK_RUNNING_STALE_MS (default 20 min, by updated_at) via the same ' +
    'transitionTask + appendRouteEntry replay — excluding, by construction, any running task with a NULL or ' +
    'empty worker_dispatch_id (a standing auth-broker task was never dispatched to begin with). ' +
    'When such a dispatch IS alive but silent past the staleness window, the job kills it ' +
    'first through the same mechanism /stop uses — every live pid+descendant registered under ' +
    'the dispatch id is process-tree-killed, heartbeat age and pid list logged, registry ' +
    'entries removed only after a confirmed-clean kill — and a surviving pid aborts the pass ' +
    '(retried next tick; never knowingly double-dispatched). A dispatch whose executor heartbeat is fresh ' +
    '(the registry entry file\'s mtime, younger than PA_VOICE_INBOX_FALLBACK_SUPERVISION_STALE_MS, default ' +
    '5 min) is supervised and is never killed — its own executor timeout ladder owns hang recovery. Before every dead-dispatch replay ' +
    'the task is re-read on the open ledger connection and a task already terminal ' +
    '(done/failed/cancelled) is never redone. On every kill+replay or ' +
    'dead-dispatch replay the target thread gets one short system line via notifyUser (dedup ' +
    "key 'voice-inbox-redispatch:<task_id>:<dispatch_id>', severity warn when a run was " +
    'killed, info when nothing was alive) saying the previous run was killed for not ' +
    'heartbeating / re-dispatched after silence and that genuinely-working runs must emit ' +
    'progress telemetry (task_telemetry.py); a notify failure never blocks the replay. ' +
    'When a stale-routed or dead-dispatch replay target already carries PA_VOICE_INBOX_FALLBACK_REROUTE_ALERT_AFTER ' +
    '(default 3, 0 disables) prior task.rerouted events, the job pages pa-alerts before re-injecting (notify dedup ' +
    "key 'voice-inbox-stuck:<task_id>', severity warn) — the alert never gates the replay. " +
    'No LLM ' +
    'involved anywhere in this job. PA_VOICE_INBOX_FALLBACK=0 disables entirely.',
  destructive: false,
  shedWhenDegraded: false, // placement IS the product here, not housekeeping — never shed (watch-jobs-runner precedent)
  targets: [],
  async run(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
    return runVoiceInboxFallback(ctx);
  },
};
