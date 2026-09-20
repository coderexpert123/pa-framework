/**
 * Voice-inbox routing retry (2026-09-16, vi-d79c09c5eb37) — the ONE place that
 * sends a never-routed voice task back for routing. The telegram bot calls
 * returnVoiceTaskForRouting when a voice-stamped thread settles `done` with a
 * carried task still unrouted (and from its reconcile sweep after a restart),
 * then queues the returned message as that thread's next turn. The pa
 * voice-inbox-fallback job reads voiceInboxRouteRetryPendingIds to PLACE a task
 * whose retry also ended unrouted, instead of replaying it into that topic.
 *
 * The repair is one legal transition through voice-inbox's own transitionTask:
 * `received|running -> routed`, routed_to = the settling thread's topic key,
 * routing_reason = VOICE_ROUTE_RETRY_REASON, event `task.routed`. Entering
 * `routed` clears the failed run's worker identity, and route_task.py accepts a
 * `routed` task again (it refuses `running`). It fires at most once per task by
 * construction: it requires routed_to IS NULL, and routed_to is only ever set,
 * never cleared. The write re-reads the row inside an IMMEDIATE transaction, so
 * a route_task.py that commits first wins. Any real routing overwrites
 * routing_reason, which ends the retry shape.
 *
 * Writes run in the bot process through voice-inbox's compiled ledger module
 * (the transcription drain's cross-package path) — never hand-built SQL.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paHome } from '../paths.js';
import { log } from './log.js';
import { repoRootFromModule } from './git-root.js';
import { readVoiceInboxRoutingFileConfig, resolveVoiceInboxDefaultTopic } from './voice-inbox-routing-config.js';
import { voiceInboxLedgerPath, VOICE_INBOX_TERMINAL_STATES } from './voice-inbox-ledger.js';
import {
  defaultLoadVoiceInboxModules,
  openLedgerForWrite,
  openReadonly,
  type VoiceInboxModules,
} from './voice-inbox-transcribe.js';

const MODULE = 'voice-inbox-route-retry';
const VALID_TASK_ID_RE = /^vi-[0-9a-f]{12}$/;
const TOPIC_KEY_RE = /^-?\d+_\d+$/;
const ID_CHUNK_SIZE = 400;
const RETRYABLE_STATES: ReadonlySet<string> = new Set(['received', 'running']);

/** The routing_reason (and event reason) of a returned task. Plain language —
 *  it renders as the work-log line's detail on the operator's card. Exact
 *  string: the bot sweep and the pa fallback recognize the retry shape by it. */
export const VOICE_ROUTE_RETRY_REASON =
  'Sent back once for routing: the routing run ended without passing this request on to a topic.';
/** Request excerpt cap inside the retry message (the message rides a thread's
 *  pendingInput, capped at 4000 chars by queueThreadInput). */
export const VOICE_ROUTE_RETRY_REQUEST_MAX_CHARS = 1500;

export type VoiceRouteRetryResult =
  | { outcome: 'returned'; taskId: string; message: string }
  | { outcome: 'skipped'; taskId: string; reason: string }
  | { outcome: 'error'; taskId: string; error: string };

export interface VoiceRouteRetryDeps {
  ledgerPath?: string;
  repoRoot?: string;
  topicNamesPath?: string;
  loadVoiceInboxModules?: (repoRoot: string) => Promise<VoiceInboxModules>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function skipReason(row: { state: string; routed_to: string | null } | undefined): string | undefined {
  if (!row) return 'task not found';
  if (row.routed_to) return 'already routed';
  if (!RETRYABLE_STATES.has(row.state)) return `state ${row.state}`;
  return undefined;
}

/** The retry turn's message. Forbids the three failure modes seen live:
 *  re-transcribing, backgrounding a command and ending the turn, and a progress
 *  post (which moves the task to `running`, where route_task.py refuses it). */
export function buildVoiceRouteRetryMessage(input: {
  taskId: string;
  topicKey: string;
  requestText: string;
  repoRoot: string;
  topicNamesPath: string;
  /** The resolved default topic (resolveVoiceInboxDefaultTopic). Absent: thread 0 of the routing topic's chat. */
  defaultTopic?: string;
}): string {
  const script = join(input.repoRoot, 'projects', 'voice-inbox', 'scripts', 'route_task.py').replace(/\\/g, '/');
  const topics = input.topicNamesPath.replace(/\\/g, '/');
  // The default topic is the one the pa fallback places into
  // (resolveVoiceInboxDefaultTopic); absent, thread 0 of the routing topic's chat.
  const defaultTopic = input.defaultTopic ?? `${input.topicKey.slice(0, input.topicKey.lastIndexOf('_'))}_0`;
  const request = input.requestText.trim();
  const excerpt =
    request.length > VOICE_ROUTE_RETRY_REQUEST_MAX_CHARS
      ? `${request.slice(0, VOICE_ROUTE_RETRY_REQUEST_MAX_CHARS)}…`
      : request;
  return (
    `Routing retry for voice inbox task ${input.taskId}. Your last run ended without running route_task.py, so the request was never passed on; it is sent back to you once. ` +
    `The request text below is final (for a voice note it is the recorded transcript): do not run transcribe_voice.py or task_transcribe.py, and do not start any background command. ` +
    `Do not run task_telemetry.py for this task: a progress post moves it to running, and route_task.py then refuses it. ` +
    `Skip any request cleanup step (task_request.py clean): route with the request text as it stands.\n\n` +
    `Request: ${excerpt}\n\n` +
    `Pick the best topic now and run: python "${script}" --task ${input.taskId} --topic <chatId>_<threadId> --reason "<one line>" --title "<short noun phrase naming what this is about, at most 60 characters>". ` +
    `Keep the --continues flag if your last run chose a conversation to continue. The topics are listed in ${topics} (chat id, then thread id, then name). ` +
    `If you are unsure where it belongs, route it to the default topic ${defaultTopic}. ` +
    `Routing is mandatory: run route_task.py before you end your turn; if it prints an error, quote that error in one line and end your turn. ` +
    `Route it and stop: do not answer the request, do not ask the operator anything, and never run task_complete.py for it.`
  );
}

/**
 * Return one never-routed task (`received`/`running`, routed_to NULL) for
 * routing to `topicKey`. Never throws. `skipped` is the common, silent case
 * (the task is routed, terminal, awaiting input, or unknown); `error` means the
 * ledger or the voice-inbox package could not be used.
 */
export async function returnVoiceTaskForRouting(
  taskId: string,
  topicKey: string,
  deps: VoiceRouteRetryDeps = {}
): Promise<VoiceRouteRetryResult> {
  if (!VALID_TASK_ID_RE.test(taskId)) return { outcome: 'skipped', taskId, reason: 'not a voice-inbox task id' };
  if (!TOPIC_KEY_RE.test(topicKey)) return { outcome: 'skipped', taskId, reason: 'malformed topic key' };
  const ledgerPath = deps.ledgerPath ?? voiceInboxLedgerPath();
  if (!existsSync(ledgerPath)) return { outcome: 'skipped', taskId, reason: 'no voice-inbox ledger' };

  // Read-only pre-check: nearly every settle carries a task that is already
  // routed or terminal, and that case must never load modules or take the
  // write lock.
  let pre: { state: string; routed_to: string | null } | undefined;
  let ro: ReturnType<typeof openReadonly> | undefined;
  try {
    ro = openReadonly(ledgerPath);
    pre = ro.prepare('SELECT state, routed_to FROM tasks WHERE task_id = ?').get(taskId) as
      | { state: string; routed_to: string | null }
      | undefined;
  } catch (err) {
    return { outcome: 'error', taskId, error: `ledger read failed: ${errText(err)}` };
  } finally {
    try {
      ro?.close();
    } catch {
      /* already closed or never opened */
    }
  }
  const preSkip = skipReason(pre);
  if (preSkip) return { outcome: 'skipped', taskId, reason: preSkip };

  let repoRoot: string;
  let modules: VoiceInboxModules;
  try {
    repoRoot = deps.repoRoot ?? (await repoRootFromModule(__filename));
    modules = await (deps.loadVoiceInboxModules ?? defaultLoadVoiceInboxModules)(repoRoot);
  } catch (err) {
    return { outcome: 'error', taskId, error: `voice-inbox package unavailable: ${errText(err)}` };
  }

  let requestText = '';
  let db: ReturnType<typeof openLedgerForWrite> | undefined;
  try {
    db = openLedgerForWrite(ledgerPath);
    const writer = db;
    const skip = writer
      .transaction((): string | undefined => {
        const row = writer
          .prepare('SELECT tenant_id, state, routed_to, request_text FROM tasks WHERE task_id = ?')
          .get(taskId) as { tenant_id: string; state: string; routed_to: string | null; request_text: string } | undefined;
        const reason = skipReason(row);
        if (reason !== undefined || !row) return reason ?? 'task not found';
        modules.ledger.transitionTask(writer, row.tenant_id, taskId, 'routed', {
          eventKind: 'task.routed',
          routedTo: topicKey,
          routingReason: VOICE_ROUTE_RETRY_REASON,
          eventPayload: { routed_to: topicKey, reason: VOICE_ROUTE_RETRY_REASON },
        });
        requestText = row.request_text;
        return undefined;
      })
      .immediate();
    if (skip !== undefined) return { outcome: 'skipped', taskId, reason: skip };
  } catch (err) {
    log('warn', MODULE, 'routing retry repair failed', { taskId, topicKey, error: errText(err) });
    return { outcome: 'error', taskId, error: errText(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
  return {
    outcome: 'returned',
    taskId,
    message: buildVoiceRouteRetryMessage({
      taskId,
      topicKey,
      requestText,
      repoRoot,
      topicNamesPath: deps.topicNamesPath ?? join(paHome(), 'telegram-topic-names.json'),
      defaultTopic: resolveVoiceInboxDefaultTopic({
        inboxTopic: topicKey,
        configDefault: readVoiceInboxRoutingFileConfig().defaultTopic,
      })?.topic,
    }),
  };
}

/**
 * Of the given task ids, the NON-terminal ones still in the retry shape
 * (routing_reason === VOICE_ROUTE_RETRY_REASON: returned for routing and not
 * routed since). Read-only, fail-open: a missing ledger or any error returns an
 * empty set (plus one warn on a real read failure).
 */
export function voiceInboxRouteRetryPendingIds(
  taskIds: readonly string[],
  ledgerPath: string = voiceInboxLedgerPath()
): Set<string> {
  const ids = taskIds.filter((id) => VALID_TASK_ID_RE.test(id));
  if (ids.length === 0 || !existsSync(ledgerPath)) return new Set();
  let db: ReturnType<typeof openReadonly> | undefined;
  try {
    db = openReadonly(ledgerPath);
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT task_id, state FROM tasks WHERE routing_reason = ? AND task_id IN (${placeholders})`)
        .all(VOICE_ROUTE_RETRY_REASON, ...chunk) as Array<{ task_id: string; state: string }>;
      for (const row of rows) {
        if (!VOICE_INBOX_TERMINAL_STATES.has(row.state)) out.add(row.task_id);
      }
    }
    return out;
  } catch (err) {
    log('warn', MODULE, 'failed to read routing-retry state; failing open', { error: errText(err) });
    return new Set();
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}
