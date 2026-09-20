/**
 * Voice-inbox steering (WP-5 D3-D13) — deliver a follow-up message INTO the
 * work already running for its conversation, rather than as a second,
 * unrelated turn.
 *
 * This lives in its OWN module, not folded into voice-inbox-bridge.ts,
 * because of a real module cycle: the thread lane needs `handleSteer`
 * (orchestrator.ts), but orchestrator.ts is imported by logic.ts, and
 * logic.ts is imported by voice-inbox-bridge.ts's own dependency chain — a
 * static import from voice-inbox-bridge.ts to orchestrator.ts would close
 * that cycle. main.ts (the composition root) wires this module in directly
 * instead (spec K2/K3). `handleSteer` is CALLED here rather than
 * re-implemented so its interrupt sequence and its terminal-thread wake path
 * (the FIFO claim, the runSeq bump, the session drop) keep exactly one owner.
 */
import { handleSteer, type SteerMode } from './orchestrator.js';
import { getThread, type ThreadRecord } from './topic-threads.js';
import { stopWorkerByResource } from './worker-stop.js';
import {
  listPendingDispatches,
  removePendingDispatch,
  pendingDispatchKey,
  type PendingDispatch,
} from './pending-dispatches.js';
import { voiceInboxConversationState } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

export const STEER_PREFIX_INTERRUPT =
  '[Course correction from the operator. This supersedes the instruction you are working on wherever the two conflict; keep whatever you have already finished that still applies.] ';
export const STEER_PREFIX_QUEUE =
  '[Additional instruction from the operator. Finish the step you are on, then handle this as well.] ';
export const STEER_PREFIX_FOLD =
  '[The operator added this to the same request before it started. Do both, in this order.] ';

export const STEER_MESSAGE_MAX = 4000;
export const VOICE_INBOX_STEER_DEADLINE_MS = 10 * 60 * 1000;
export const THREAD_RESOURCE_RE = /^topic-(-?\d+)_(\d+)-th(\d+)$/;
export const TOPIC_RESOURCE_RE = /^topic-(-?\d+)_(\d+)$/;
/** Copy of voice-inbox-bridge.ts's VOICE_INBOX_TASK_RE. Duplicated, not
 *  imported: that import closes a module cycle (spec K2). Pinned byte-equal by
 *  this module's own source-invariant test. */
export const VOICE_INBOX_TASK_RE = /\[Voice(?: inbox)? task (vi-[0-9a-f]{12})(?=[\]\s])/g;
export const STEER_REJECTED_PREFIX = '\n\n_(steer rejected:';

export type SteerOutcomeKind =
  | 'interrupted-thread'
  | 'queued-into-thread'
  | 'folded-before-start'
  | 'woke-terminal-thread'
  | 'interrupted-dispatch'
  | 'queued-into-topic'
  | 'not-yet';

export interface VoiceInboxSteerRuntime {
  secrets: Record<string, string>;
  token: string;
  topicNameFromKey: (topicKey: string) => string;
  /** Injection seam — the same one main.ts hands the drain. Used only by the
   *  TOPIC lane, which delivers by injecting a synthetic turn. */
  injectFn: (chatId: number, threadId: number, text: string) => void;
}

export interface VoiceInboxSteerEntry {
  task_id?: string;
  text: string;
  steer_mode?: string;
  steer_conversation?: string;
  ref_id?: string;
}

/** `settled` false means NOTHING was done and the caller must hold the entry
 *  for the next tick (or fold it, or inject it past the deadline). It is never
 *  an instruction to downgrade the steer. */
export interface VoiceInboxSteerResult {
  settled: boolean;
  outcome: SteerOutcomeKind;
  mode: SteerMode;
  resource: string | null;
  reason?: string;
}

type ConversationState = ReturnType<typeof voiceInboxConversationState>;

const EMPTY_CONVERSATION_STATE: ConversationState = {
  workerResource: null,
  workerDispatchId: null,
  originTaskId: null,
  taskIds: [],
};

/** Every task id in this voice-inbox conversation (D9's fold uses this to
 *  find a sibling route line that has not started yet). */
export function steerConversationTaskIds(conversationId: string): string[] {
  return voiceInboxConversationState(conversationId).taskIds;
}

export function steerPrefixFor(mode: SteerMode): string {
  return mode === 'interrupt' ? STEER_PREFIX_INTERRUPT : STEER_PREFIX_QUEUE;
}

/** A line whose age cannot be known (absent/unparseable `ts`) must not be
 *  held forever, so it counts as past the deadline (D10). */
export function isPastSteerDeadline(entryTs: string | undefined, now: number = Date.now()): boolean {
  if (!entryTs) return true;
  const ts = Date.parse(entryTs);
  if (Number.isNaN(ts)) return true;
  return now - ts > VOICE_INBOX_STEER_DEADLINE_MS;
}

/** De-duplicated task ids named by an injection text, in first-seen order. */
export function taskIdsInText(text: string): string[] {
  VOICE_INBOX_TASK_RE.lastIndex = 0;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(VOICE_INBOX_TASK_RE)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function notYet(mode: SteerMode, resource: string | null, reason: string): VoiceInboxSteerResult {
  return { settled: false, outcome: 'not-yet', mode, resource, reason };
}

/**
 * Local name for the `deps` seam, not exported: the external call shape
 * (positional `deps?: {...}`) is unchanged, this just gives the shape a name
 * so `listWorkerPids` below can carry its own doc comment.
 */
type SteerIntoWorkDeps = {
  conversationState?: typeof voiceInboxConversationState;
  getThread?: (key: string, id: string) => Promise<ThreadRecord | undefined>;
  steer?: typeof handleSteer;
  stop?: typeof stopWorkerByResource;
  listPending?: typeof listPendingDispatches;
  removePending?: typeof removePendingDispatch;
  /** Non-destructive worker-pids registry query for the TOPIC lane's 5(d)
   *  mid-hand-off exception. Wired at the composition root (main.ts) from
   *  pa's `listWorkerPids`, NOT imported here — this module deliberately
   *  never reaches into the pa package for anything but types, so the
   *  cycle-avoidance rule at the top of this file has exactly one shape to
   *  audit. Absent (e.g. a caller that only exercises other lanes) means
   *  "cannot verify"; the exception then never fires and the topic lane
   *  falls through to its existing safe default of injecting the steer text
   *  alone rather than holding — see the call site below. */
  listWorkerPids?: () => Promise<Array<{ dispatchId?: string }>>;
};

/**
 * Deliver ONE voice-inbox steer entry into the work it targets — the thread
 * lane (D8) or the topic lane (D11), resolved fresh from the ledger on every
 * call because a verdict frozen at routing time goes stale (K7). Never
 * throws: every failure path returns `settled: false` with a `reason`, which
 * tells the caller (the drain) to hold the entry for the next tick.
 */
export async function steerIntoWork(
  entry: VoiceInboxSteerEntry,
  runtime: VoiceInboxSteerRuntime,
  deps?: SteerIntoWorkDeps,
): Promise<VoiceInboxSteerResult> {
  const conversationState = deps?.conversationState ?? voiceInboxConversationState;
  const getThreadRecord = deps?.getThread ?? getThread;
  const steer = deps?.steer ?? handleSteer;
  const stop = deps?.stop ?? stopWorkerByResource;
  const listPending = deps?.listPending ?? listPendingDispatches;
  const removePending = deps?.removePending ?? removePendingDispatch;

  const mode: SteerMode = entry.steer_mode === 'interrupt' ? 'interrupt' : 'queue';

  const result = await settle();
  logger.info('voice-inbox', `voice-inbox steer settled: ${result.outcome}`, {
    steer_outcome: result.outcome,
    task_id: String(entry.task_id ?? ''),
    resource: result.resource ?? '',
    mode,
    ref_id: String(entry.ref_id ?? ''),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
  });
  return result;

  async function settle(): Promise<VoiceInboxSteerResult> {
    const conv = entry.steer_conversation ?? '';
    if (conv === '') return notYet(mode, null, 'entry carries no steer_conversation');

    let state: ConversationState;
    try {
      state = conversationState(conv);
    } catch {
      state = EMPTY_CONVERSATION_STATE;
    }
    const resource = state.workerResource ?? '';

    const threadMatch = THREAD_RESOURCE_RE.exec(resource);
    if (threadMatch) return threadLane(resource, threadMatch);

    const topicMatch = TOPIC_RESOURCE_RE.exec(resource);
    if (topicMatch) return topicLane(resource, topicMatch, state);

    return notYet(mode, resource, 'worker resource is neither a thread nor a topic resource');
  }

  async function threadLane(resource: string, m: RegExpExecArray): Promise<VoiceInboxSteerResult> {
    const topicKey = `${m[1]}_${m[2]}`;
    const threadId = `t-${m[3]}`;
    const rec = await getThreadRecord(topicKey, threadId).catch(() => undefined);
    if (!rec) return notYet(mode, resource, `thread ${threadId} is not in the topic store`);
    // Safety pin (D7): the resource we resolved must name exactly this record.
    if (String(rec.n) !== m[3]) return notYet(mode, resource, 'thread record n does not match the resource');
    if (rec.status === 'cancelled') return notYet(mode, resource, `thread ${threadId} is cancelled`);

    const message = steerPrefixFor(mode) + entry.text;
    if (message.length > STEER_MESSAGE_MAX) {
      return notYet(mode, resource, `steer message exceeds ${STEER_MESSAGE_MAX} characters`);
    }

    const statusBefore = rec.status;
    let footer: string;
    try {
      footer = await steer({
        topicKey,
        topicName: runtime.topicNameFromKey(topicKey),
        steer: { thread: rec, message, queued: rec.status === 'running' || rec.status === 'queued', mode },
        secrets: runtime.secrets,
        token: runtime.token,
        workdir: '', // handleSteer never reads workdir (spec K11)
      });
    } catch (err) {
      return notYet(mode, resource, `handleSteer threw: ${(err as Error).message}`);
    }
    if (footer.startsWith(STEER_REJECTED_PREFIX)) {
      return notYet(mode, resource, `handleSteer rejected: ${footer.trim()}`);
    }

    const outcome: SteerOutcomeKind =
      statusBefore === 'running' && mode === 'interrupt'
        ? 'interrupted-thread'
        : statusBefore === 'running' && mode === 'queue'
          ? 'queued-into-thread'
          : statusBefore === 'queued'
            ? 'folded-before-start'
            : 'woke-terminal-thread';
    return { settled: true, outcome, mode, resource };
  }

  async function topicLane(resource: string, t: RegExpExecArray, state: ConversationState): Promise<VoiceInboxSteerResult> {
    const chatId = Number(t[1]);
    const threadId = Number(t[2]);
    const origin = state.originTaskId;
    if (origin === null) return notYet(mode, resource, 'conversation has no origin task');

    let pending: PendingDispatch[];
    try {
      pending = await listPending();
    } catch (err) {
      return notYet(mode, resource, `listPendingDispatches threw: ${(err as Error).message}`);
    }
    const inThisTopic = pending.filter((r) => r.chatId === chatId && r.threadId === threadId);

    // Idempotency (D11): a crash between injecting the combined turn and
    // rewriting the queue would otherwise re-run this entry and inject twice.
    const alreadyInjected = inThisTopic.some((r) => {
      const ids = taskIdsInText(r.userText);
      return ids.includes(origin) && entry.task_id !== undefined && ids.includes(entry.task_id);
    });
    if (alreadyInjected) {
      return { settled: true, outcome: 'interrupted-dispatch', mode, resource, reason: 'already injected' };
    }

    const matches = inThisTopic.filter((r) => taskIdsInText(r.userText).includes(origin));
    matches.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const originRec = matches[0];

    if (mode === 'queue' || !originRec) {
      // EXCEPTION (WP-5 5(d)): originRec absent but the dispatch's own
      // worker is STILL registered means this is a mid-hand-off window (the
      // old dispatch's pending record was already purged but the new
      // dispatch has not registered one of its own yet) — hold rather than
      // inject, so the combined turn isn't lost to that race. A caller that
      // cannot supply listWorkerPids (deps.listWorkerPids undefined) cannot
      // verify this and falls through to the branch's existing safe
      // default: inject the steer text alone.
      if (!originRec && state.workerDispatchId && deps?.listWorkerPids) {
        let stillRegistered = false;
        try {
          const entries = await deps.listWorkerPids();
          stillRegistered = entries.some((e) => e.dispatchId === state.workerDispatchId);
        } catch {
          stillRegistered = false;
        }
        if (stillRegistered) {
          return notYet(mode, resource, 'origin dispatch record missing while its worker is still registered');
        }
      }
      // Queue mode never kills; and with no origin dispatch record to
      // combine with, interrupt mode falls back to the same delivery — the
      // topic session resumes, so this still continues the same CLI context.
      runtime.injectFn(chatId, threadId, steerPrefixFor(mode) + entry.text);
      return { settled: true, outcome: 'queued-into-topic', mode, resource };
    }

    // interrupt mode with an originRec: try to kill exactly our dispatch.
    const dispatchId = state.workerDispatchId ?? '';
    if (dispatchId === '') {
      return notYet(mode, resource, 'no dispatch id recorded; refusing to kill a bare topic resource');
    }

    let killed: number;
    try {
      killed = await stop(resource, undefined, dispatchId);
    } catch (err) {
      return notYet(mode, resource, `stopWorkerByResource threw: ${(err as Error).message}`);
    }
    if (killed === 0) {
      // The dispatch identity no longer matches (K14) — it is not ours to
      // kill. Fall back to injecting the steer text alone.
      runtime.injectFn(chatId, threadId, steerPrefixFor(mode) + entry.text);
      return { settled: true, outcome: 'queued-into-topic', mode, resource };
    }

    await removePending(pendingDispatchKey(chatId, threadId, originRec.updateId)).catch(() => {});
    runtime.injectFn(chatId, threadId, `${originRec.userText}\n\n${STEER_PREFIX_INTERRUPT}${entry.text}`);
    return { settled: true, outcome: 'interrupted-dispatch', mode, resource };
  }
}
