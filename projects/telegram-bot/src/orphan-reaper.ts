/**
 * Startup orphan-dispatch reaper (AI-095).
 *
 * When the bot dies mid-dispatch, the worker survives as an orphan and its
 * reply has nowhere to go. On startup this module walks the pending-dispatch
 * store (records the dead instance never cleared), and for each one either:
 *
 *   - drops it, if the delivered-store shows the reply already went out;
 *   - waits for a still-running orphan worker on that topic to finish, then
 *     harvests the final assistant message from the claude-family session
 *     transcript and delivers it (this is the complementary half of AI-039,
 *     which kills orphans without harvesting them — main.ts excludes topics
 *     with pending dispatches from that kill pass so we get here first);
 *   - or, when recovery is impossible (no resumable claude-family session,
 *     transcript never produced a reply, deadline passed), tells the user the
 *     request died so they can resend — a death notice beats a silent void.
 *
 * Recovery is deliberately claude/zclaude-only: their transcript path is
 * deterministic from (session_id, cwd). Fresh dispatches and other workers get
 * the honest death notice.
 */
import { readFile, stat } from 'fs/promises';
import { sendMessage, sendTyping } from './telegram.js';
import { getPriorSessionPath } from './session.js';
import { parseMetadata } from './logic.js';
import { loadTopicState, saveTopicState, addTurn } from './conversation.js';
import { deliveredKey, wasDelivered, markDelivered } from './delivered-store.js';
import { listPendingDispatches, removePendingDispatch, pendingDispatchKey, type PendingDispatch } from './pending-dispatches.js';
import { makeRefId } from './ref-id.js';
import { markTopicRecovering, clearTopicRecovering } from './recovery-gate.js';
import { listWorkerPids, isProcessAlive } from '../../../pa/dist/src/worker-pids.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

const CLAUDE_FAMILY = new Set(['claude', 'zclaude']);

/** Transcript must be untouched this long before we trust it as final. */
export const TRANSCRIPT_QUIESCENT_MS = 90_000;
/** Give up waiting for an orphan this long after reaping starts. */
export const REAP_MAX_WAIT_MS = 45 * 60 * 1000;
export const REAP_POLL_MS = 20_000;
export const TYPING_REFRESH_MS = 4_000;

// ---------------------------------------------------------------------------
// Pure transcript parsing
// ---------------------------------------------------------------------------

/**
 * Extract the final assistant text from a claude-family session transcript
 * (jsonl), considering only entries after `afterIso` (the dispatch start).
 * Returns null when the transcript holds no post-dispatch assistant text.
 */
export function extractFinalAssistantText(jsonl: string, afterIso: string): { text: string; timestamp: string } | null {
  const after = new Date(afterIso).getTime();
  let found: { text: string; timestamp: string } | null = null;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const ts = new Date(entry.timestamp ?? 0).getTime();
    if (!Number.isFinite(ts) || ts <= after) continue;
    const content = entry.message?.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n');
    }
    if (text.trim()) found = { text: text.trim(), timestamp: entry.timestamp };
  }
  return found;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (defaults hit the real fs / process table / Telegram)
// ---------------------------------------------------------------------------

export interface ReaperDeps {
  send: (record: PendingDispatch, text: string) => Promise<boolean>;
  readTranscript: (record: PendingDispatch) => Promise<{ content: string; mtimeMs: number } | null>;
  isTopicWorkerAlive: (record: PendingDispatch) => Promise<boolean>;
  now: () => number;
  /** Optional: keep the topic's typing indicator alive while a recovery is
   * pending — the process that owned the original typing loop is dead, so
   * without this the topic looks silent while the orphan finishes. */
  sendTyping?: (record: PendingDispatch) => Promise<void>;
}

function defaultReadTranscript(record: PendingDispatch): Promise<{ content: string; mtimeMs: number } | null> {
  const session = record.session;
  if (!session || !CLAUDE_FAMILY.has(session.worker)) return Promise.resolve(null);
  const path = getPriorSessionPath(session.worker, session.session_id, record.cwd);
  if (!path) return Promise.resolve(null);
  return (async () => {
    try {
      const [content, s] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return { content, mtimeMs: s.mtime.getTime() };
    } catch {
      return null;
    }
  })();
}

/**
 * Registry-based worker liveness. Checks BOTH the registered pid (the shell
 * wrapper) and its last-known descendants: when the spawner crashes, the
 * wrapper often dies with it while the real CLI child keeps running — checking
 * only `e.pid` false-negatives and triggers a premature harvest (2026-07-04
 * incident: intermediate assistant text delivered as a "final" reply).
 * Exported for tests.
 */
export async function isTopicWorkerAliveByRegistry(record: PendingDispatch): Promise<boolean> {
  const resource = `topic-${record.chatId}_${record.threadId}`;
  try {
    const entries = await listWorkerPids();
    return entries.some((e) =>
      e.skill === resource && (isProcessAlive(e.pid) || (e.descendants ?? []).some((d) => isProcessAlive(d)))
    );
  } catch {
    return false;
  }
}

export function makeDefaultDeps(token: string): ReaperDeps {
  return {
    send: async (record, text) => {
      const refId = makeRefId();
      const delivered = await sendMessage(token, record.chatId, `${text}\n\n_Ref: ${refId}_`, record.messageId, record.threadId);
      if (delivered) {
        logger.info('bot', 'system message sent', { refId, kind: 'recovered', chatId: record.chatId, threadId: record.threadId, textPreview: text.slice(0, 200) });
        // Restore conversational continuity. The ASSISTANT turn is always
        // missing (the dead instance never delivered it), but the USER turn
        // is normally already there: main.ts persists it AT RECEIPT (AI-095
        // item 2), before the dispatch record is even written. Only re-add
        // it for pre-item-2 records / receipt-persist failures — an
        // unconditional append duplicated the user turn on every recovery.
        try {
          const topicState = await loadTopicState(record.chatId, record.threadId);
          const userTurnPresent = topicState.turns.some(
            (t) => t.role === 'user' && t.message_id === record.messageId,
          );
          if (!userTurnPresent) {
            addTurn(topicState, { role: 'user', text: record.userText, timestamp: record.startedAt, message_id: record.messageId, worker: record.session?.worker ?? 'worker' });
          }
          addTurn(topicState, { role: 'assistant', text, timestamp: new Date().toISOString(), worker: 'worker', refId });
          await saveTopicState(topicState);
        } catch (err) {
          logger.warn('reaper', 'failed to persist recovered turns', { error: String(err) });
        }
      }
      return delivered;
    },
    readTranscript: defaultReadTranscript,
    isTopicWorkerAlive: isTopicWorkerAliveByRegistry,
    now: () => Date.now(),
    sendTyping: (record) => sendTyping(token, record.chatId, record.threadId),
  };
}

// ---------------------------------------------------------------------------
// Per-record evaluation (single step, no sleeping — the loop lives outside)
// ---------------------------------------------------------------------------

export type ReapOutcome = 'already-delivered' | 'recovered' | 'dead' | 'waiting';

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

function deathNotice(record: PendingDispatch): string {
  return `⚠️ The bot restarted while processing your message and the reply could not be recovered. Please resend:\n«${preview(record.userText)}»`;
}

async function finish(record: PendingDispatch, outcome: 'recovered' | 'dead'): Promise<void> {
  // Mark delivered so a re-run of the reaper (or update reprocessing) can't
  // double-deliver, then clear the record.
  await markDelivered(deliveredKey(record.chatId, record.threadId, record.updateId)).catch(() => {});
  await removePendingDispatch(pendingDispatchKey(record.chatId, record.threadId, record.updateId));
  logger.info('reaper', `pending dispatch ${outcome}`, { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId });
}

export async function evaluatePendingDispatch(
  record: PendingDispatch,
  deps: ReaperDeps,
  deadlineMs: number,
): Promise<ReapOutcome> {
  const key = deliveredKey(record.chatId, record.threadId, record.updateId);
  if (await wasDelivered(key)) {
    await removePendingDispatch(pendingDispatchKey(record.chatId, record.threadId, record.updateId));
    return 'already-delivered';
  }

  const session = record.session;
  const recoverable = !!session && CLAUDE_FAMILY.has(session.worker);
  const expired = deps.now() >= deadlineMs;

  if (recoverable) {
    const transcript = await deps.readTranscript(record);
    const final = transcript ? extractFinalAssistantText(transcript.content, record.startedAt) : null;
    const workerAlive = await deps.isTopicWorkerAlive(record);
    const quiescent = transcript ? deps.now() - transcript.mtimeMs >= TRANSCRIPT_QUIESCENT_MS : false;

    if (final && !workerAlive && (quiescent || expired)) {
      const { cleaned } = parseMetadata(final.text); // strip [PA_META] — never execute actions from a harvested reply
      const body = cleaned.trim() || final.text.trim();
      const sent = await deps.send(record, `♻️ *Recovered reply* (the bot restarted mid-request; the worker finished on its own):\n\n${body}`);
      if (sent) {
        await finish(record, 'recovered');
        return 'recovered';
      }
      return 'waiting'; // send failed — retry next poll until deadline
    }
    if (!expired && (workerAlive || !quiescent || !final)) return 'waiting';
    // Deadline passed with nothing recoverable → fall through to the death notice.
  }

  if (!recoverable || expired) {
    // Mirror the recovered path: a FAILED death-notice send must not settle
    // the record — finish() would markDelivered + remove it, leaving the
    // user's request a silent void (the exact outcome this module exists to
    // prevent) and foreclosing the next restart's retry. 'waiting' retries
    // until the giveUpAt grace window; unsettled records stay on disk for
    // the next restart and TTL out at 24h (PENDING_DISPATCH_MAX_AGE_MS).
    const sent = await deps.send(record, deathNotice(record)).catch(() => false);
    if (!sent) return 'waiting';
    await finish(record, 'dead');
    return 'dead';
  }
  return 'waiting';
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Must exactly match main.ts's topicPending/getUpdateTopicKey/topicKeyFor
 * format (`${chatId}_${threadId}`) — this is the same key isTopicRecovering
 * is queried with. */
function recordTopicKey(record: PendingDispatch): string {
  return `${record.chatId}_${record.threadId}`;
}

/**
 * Recover (or bury) every pending dispatch left behind by a crashed instance.
 * Runs in the background at startup; resolves when all records are settled.
 *
 * AI-095 follow-up (deep-recheck 2026-07-08, Phase 1B): while a topic has an
 * unsettled record, its recovery gate stays marked (recovery-gate.ts) so
 * processUpdate defers new dispatches into it instead of risking a
 * concurrent resume of the same session the orphan may still be running.
 * This function is the gate's SOLE owner (mark + clear) — processUpdate only
 * reads it.
 */
export async function reapOrphanedDispatches(
  token: string,
  opts: { deps?: ReaperDeps; maxWaitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const deps = opts.deps ?? makeDefaultDeps(token);
  const maxWaitMs = opts.maxWaitMs ?? REAP_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? REAP_POLL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let records = await listPendingDispatches();
  if (records.length === 0) return;
  logger.info('reaper', `found ${records.length} pending dispatch(es) from a prior instance`, {});

  const markedTopics = new Set(records.map(recordTopicKey));
  for (const t of markedTopics) markTopicRecovering(t);

  try {
    const deadline = deps.now() + maxWaitMs;
    // Past the deadline, evaluation settles records with death notices; the grace
    // window only exists for the case where even those sends keep failing — then
    // we stop (records stay on disk for the next restart, and TTL out after 24h).
    const giveUpAt = deadline + 10 * pollMs;
    while (records.length > 0) {
      const roundTopics = new Set(records.map(recordTopicKey));
      const waiting: PendingDispatch[] = [];
      for (const record of records) {
        try {
          const outcome = await evaluatePendingDispatch(record, deps, deadline);
          if (outcome === 'waiting') waiting.push(record);
        } catch (err) {
          logger.warn('reaper', 'evaluation failed', { updateId: record.updateId, error: String(err) });
          waiting.push(record);
        }
      }
      records = waiting;

      // Per-topic, per-ROUND clearing — not per-individual-record mid-loop.
      // Only once the full round's `waiting` array is known can we tell which
      // topics have NO record left pending; clearing on the first record to
      // settle, without checking whether a sibling record for the same topic
      // (evaluated later in this same round) is still waiting, would
      // prematurely unmark a topic still genuinely under recovery. This still
      // closes the vast majority of the wedge — at most one poll cycle after
      // a topic's own records all settle, instead of up to 45 minutes
      // regardless of how fast an unrelated topic finishes.
      const stillWaitingTopics = new Set(records.map(recordTopicKey));
      for (const t of roundTopics) {
        if (!stillWaitingTopics.has(t)) clearTopicRecovering(t);
      }

      if (records.length === 0) break;
      if (deps.now() >= giveUpAt) {
        logger.warn('reaper', `giving up on ${records.length} unsettled record(s) — will retry on next restart`, {});
        break;
      }
      // Wait for the next evaluation pass, refreshing the typing indicator for
      // topics still being recovered (Telegram shows it ~5s; refresh every 4s).
      let waited = 0;
      while (waited < pollMs) {
        for (const r of records) void deps.sendTyping?.(r).catch(() => {});
        const step = Math.min(TYPING_REFRESH_MS, pollMs - waited);
        await sleep(step);
        waited += step;
      }
    }
  } finally {
    // Backstop covering the give-up-at-deadline and thrown-exception exits,
    // where records may never individually settle — clearing an
    // already-cleared topic (the common case) is a safe no-op.
    for (const t of markedTopics) clearTopicRecovering(t);
  }
}
