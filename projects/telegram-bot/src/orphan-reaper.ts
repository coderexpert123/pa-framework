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
import { sendMessage, sendMessageWithKeyboard, sendMessageWithKeyboardDetailed, sendTyping, editMessageText, type InlineKeyboardMarkup } from './telegram.js';
import { sendReplyText } from './rich-message.js';
import { getPriorSessionPath, buildResumeArgs } from './session.js';
import { parseMetadata, buildModelStatusSnapshot, renderStatusCard, resolveWorkerLlm, selectWorkerTunables, formatWorkerReply } from './logic.js';
import type { ModelStatusReasonCode } from './types.js';
import { loadTopicState, saveTopicState, addTurn } from './conversation.js';
import { deliveredKey, wasDelivered, markDelivered } from './delivered-store.js';
import { listPendingDispatches, removePendingDispatch, pendingDispatchKey, updatePendingDispatch, type PendingDispatch } from './pending-dispatches.js';
import { putResend, takeResend, resendKey } from './resend-store.js';
import { isBarePlaceholderUserText, transcribeVoiceMessage, formatTranscriptUserText, extensionForAttachment, voiceAttachmentPath } from './voice.js';
import { buildResendKeyboard } from './callbacks.js';
import { makeRefId } from './ref-id.js';
import { markTopicRecovering, clearTopicRecovering } from './recovery-gate.js';
import { isTopicStopped } from './worker-stop.js';
import { listWorkerPids, isProcessAlive } from '../../../pa/dist/src/worker-pids.js';
import { getDescendantPids } from '../../../pa/dist/src/process-tree.js';
import { executeWorker } from '../../../pa/dist/src/worker-exec.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { getKeepAwakeStatus } from './keepawake.js';

const CLAUDE_FAMILY = new Set(['claude', 'zclaude']);

/** Transcript must be untouched this long before we trust it as final. */
export const TRANSCRIPT_QUIESCENT_MS = 90_000;
/** Give up waiting for an orphan this long after reaping starts. */
export const REAP_MAX_WAIT_MS = 45 * 60 * 1000;
export const REAP_POLL_MS = 20_000;
export const TYPING_REFRESH_MS = 4_000;
/** Same value as main.ts's ORPHAN_HARVEST_WINDOW_MS — protects the
 * re-dispatched worker from the per-minute orphan sweep. */
const REDISPATCH_HARVEST_MS = 50 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pure transcript parsing
// ---------------------------------------------------------------------------

/**
 * Recover {kind, caption} from a placeholder userText ("[Voice message] raw caption")
 *  — the label set mirrors isBarePlaceholderUserText's regex (voice.ts). Null when the
 *  text is not a bare placeholder.
 */
export function placeholderKindAndCaption(userText: string):
    { kind: 'voice' | 'audio' | 'video_note'; caption?: string } | null {
  const m = /^\[(Voice message|Audio file|Video note)\](?: (.*))?$/.exec(userText);
  if (!m) return null;
  const kind = m[1] === 'Voice message' ? 'voice' : m[1] === 'Audio file' ? 'audio' : 'video_note';
  const caption = m[2]?.trim();
  return { kind, ...(caption ? { caption } : {}) };
}

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
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      // Position-aware tool_use handling: skip only if a tool_use block
      // appears AFTER the last text block (mid-turn). A tool_use before or
      // between text blocks with a final text block means the turn completed.
      // Examples:
      //   [text, tool_use] → skip (tool_use after last text = mid-turn)
      //   [tool_use, text] → deliver text (tool_use before text = completed)
      //   [text, tool_use, text] → deliver last text (tool_use between texts)
      const lastTextIndex = content.map((b: any, i: number) => [i, b]).filter(([, b]) => b?.type === 'text').pop()?.[0] ?? -1;
      const hasToolUseAfterLastText = content.some((b: any, i: number) => b?.type === 'tool_use' && i > lastTextIndex);
      if (hasToolUseAfterLastText) continue;
      // Only return the last text block (the final answer after tool use)
      const lastTextBlock = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').pop();
      text = lastTextBlock?.text ?? '';
    }
    if (text.trim()) found = { text: text.trim(), timestamp: entry.timestamp };
  }
  return found;
}

/**
 * Extract the final output from an agy stream-json tee file.
 * Finds the last `type:'result'` event whose `result` field is a non-empty
 * string — this matches worker-exec's `stdout = event.result` assignment.
 * Returns null when no result event is found (incomplete/corrupt/empty file).
 * Handles both NDJSON (stream-json) and plain-text fallback per §0.
 */
export function extractTeeResult(raw: string): string | null {
  // First pass: check if this looks like NDJSON (at least one line parses as JSON)
  let hasJsonLine = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { JSON.parse(line); hasJsonLine = true; break; } catch { continue; }
  }

  // NDJSON path: extract last result event
  if (hasJsonLine) {
    let result: string | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let event: any;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type === 'result' && typeof event.result === 'string' && event.result.trim()) {
        result = event.result.trim();
      }
      // agy stream-json: uses event.event (not event.type), result is an object with .response
      if (event?.event === 'result' && typeof event.result === 'object' && event.result !== null
          && typeof (event.result as any).response === 'string' && (event.result as any).response.trim()) {
        result = ((event.result as any).response as string).trim();
      }
    }
    return result;
  }

  // Plain-text fallback: return entire non-empty trimmed content
  const trimmed = raw.trim();
  return trimmed || null;
}

// ---------------------------------------------------------------------------
// Injectable dependencies (defaults hit the real fs / process table / Telegram)
// ---------------------------------------------------------------------------

export interface ReaperDeps {
  send: (record: PendingDispatch, text: string, replyMarkup?: InlineKeyboardMarkup) => Promise<boolean>;
  /** Optional: like `send`, but reports whether a delivery failure is terminal
   * (retrying can never succeed — e.g. Telegram 400 "chat not found"). The
   * death-notice path prefers it; when absent, `send` is used and every
   * failure is treated as non-terminal (pre-AI-186 behavior). */
  sendDetailed?: (record: PendingDispatch, text: string, replyMarkup?: InlineKeyboardMarkup) => Promise<{ delivered: boolean; terminal?: boolean }>;
  readTranscript: (record: PendingDispatch) => Promise<{ content: string; mtimeMs: number } | null>;
  isTopicWorkerAlive: (record: PendingDispatch) => Promise<boolean>;
  now: () => number;
  /** Optional: keep the topic's typing indicator alive while a recovery is
   * pending — the process that owned the original typing loop is dead, so
   * without this the topic looks silent while the orphan finishes. */
  sendTyping?: (record: PendingDispatch) => Promise<void>;
  /** Optional: read the tee-captured stdout path for a non-transcript worker
   * (agy). Returns null when no tee file is associated with this dispatch.
   * If omitted, tee recovery is skipped entirely (falls to death notice). */
  readTeePath?: (record: PendingDispatch) => Promise<string | null>;
  /** Optional: read file contents for tee recovery (mocked in tests). If omitted,
   * uses the real fs.readFile. */
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  /** Check the best recovery source (tee file or transcript) for a
   * completed result. Returns the raw result text, or null if nothing
   * is available yet. */
  checkRecoverySource?: (record: PendingDispatch) => Promise<string | null>;
  /** Capture the session ID from a recovery result into the topic state,
   * so the next normal dispatch resumes the conversation. */
  captureSession?: (record: PendingDispatch, resultText: string) => Promise<void>;
  /** Update the pinned status card to show recovery status. */
  updatePinnedCard?: (record: PendingDispatch, opts: { reasonCode: string }) => Promise<void>;
  /** Re-dispatch with native conversation resume when the original
   * worker died without producing a result. Returns the raw output
   * or null. Injected for testing; default calls the real function. */
  redispatchWithResume?: (record: PendingDispatch) => Promise<string | null>;
  /** Injects the original request back through the normal dispatch pipeline
   *  (main.ts's synthetic-update requeue). Record arrives with requeueCount already
   *  incremented. */
  requeueUpdate?: (record: PendingDispatch) => void;
  /** Revive an untranscribed voice/audio/video_note placeholder: re-download via
   *  voiceFileId and re-transcribe through voice.ts's existing pipeline. Returns
   *  the formatted transcript text, or null on any failure (caller falls to the
   *  neutral notice). Injected for testing; default impl in makeDefaultDeps. */
  reviveVoiceNote?: (record: PendingDispatch) => Promise<string | null>;
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
    // for...of instead of .some() — the descendants-gap fallback below needs await
    for (const e of entries) {
      if (e.skill !== resource) continue;
      // Direct PID check or descendants check
      if (isProcessAlive(e.pid) || (e.descendants ?? []).some((d) => isProcessAlive(d))) return true;
      // Descendants-list gap fix (30-second heartbeat): the worker was
      // dispatched recently but the heartbeat hasn't fired yet, so the
      // descendants list is empty. Do a direct process-tree scan.
      if (!e.descendants || e.descendants.length === 0) {
        try {
          const desc = await getDescendantPids(e.pid);
          if (desc.some((d: { pid: number }) => isProcessAlive(d.pid))) return true;
        } catch { /* process-tree scan failed — fall through */ }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Look up the tee-captured stdout path from the worker-pids registry for a
 * given pending dispatch. Returns the teePath from the first matching entry,
 * or null if no entry has one. Exported for tests.
 */
export async function findTeePathByRegistry(record: PendingDispatch): Promise<string | null> {
  const resource = `topic-${record.chatId}_${record.threadId}`;
  try {
    const entries = await listWorkerPids();
    for (const entry of entries) {
      if (entry.skill === resource) {
        // teePath is added by WP1's worker-pids.ts change; access via type
        // assertion to avoid compile-time dependency on WP1's unmerged type.
        const teePath = (entry as { teePath?: string }).teePath;
        if (teePath) return teePath;
      }
    }
  } catch {
    // registry unreadable — no recovery possible
  }
  return null;
}

export function makeDefaultDeps(token: string, secrets?: Record<string, string>): ReaperDeps {
  return {
    send: async (record, text, replyMarkup) => {
      const refId = makeRefId();
      const fullText = `${text}\n\n_Ref: ${refId}_`;
      const delivered = replyMarkup !== undefined
        ? (await sendMessageWithKeyboard(token, record.chatId, fullText, replyMarkup, record.messageId, record.threadId)) !== null
        : (await sendReplyText(token, record.chatId, fullText, record.messageId, record.threadId, process.env)).delivered;
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
    sendDetailed: async (record, text, replyMarkup) => {
      const refId = makeRefId();
      const fullText = `${text}\n\n_Ref: ${refId}_`;
      let delivered: boolean;
      let terminal = false;
      if (replyMarkup !== undefined) {
        const r = await sendMessageWithKeyboardDetailed(token, record.chatId, fullText, replyMarkup, record.messageId, record.threadId);
        delivered = r.messageId !== null;
        terminal = r.terminalError;
      } else {
        delivered = (await sendReplyText(token, record.chatId, fullText, record.messageId, record.threadId, process.env)).delivered;
      }
      if (delivered) {
        logger.info('bot', 'system message sent', { refId, kind: 'recovered', chatId: record.chatId, threadId: record.threadId, textPreview: text.slice(0, 200) });
        // Same post-delivery bookkeeping as `send` (duplicated deliberately —
        // minimal diff; extract only if a third caller appears).
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
      return { delivered, terminal };
    },
    readTranscript: defaultReadTranscript,
    isTopicWorkerAlive: isTopicWorkerAliveByRegistry,
    readTeePath: findTeePathByRegistry,
    readFile: readFile,
    now: () => Date.now(),
    sendTyping: (record) => sendTyping(token, record.chatId, record.threadId),
    checkRecoverySource: async (record) => {
      // Tee file (from pending dispatch, takes priority over transcript)
      if (record.teePath) {
        try {
          const raw = await readFile(record.teePath, 'utf8');
          const extracted = extractTeeResult(raw);
          if (extracted) return extracted;
        } catch {}
      }
      // Transcript (claude-family)
      if (record.session && CLAUDE_FAMILY.has(record.session.worker)) {
        const path = getPriorSessionPath(record.session.worker, record.session.session_id, record.cwd);
        if (!path) return null;
        try {
          const [content, s] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
          const final = extractFinalAssistantText(content, record.startedAt);
          if (final && Date.now() - s.mtimeMs >= TRANSCRIPT_QUIESCENT_MS) {
            return final.text;
          }
        } catch {}
      }
      return null;
    },
    captureSession: async (record, resultText) => {
      const session = record.session;
      if (!session) return;
      try {
        const topicState = await loadTopicState(record.chatId, record.threadId);
        topicState.session = { ...session, started_at: new Date().toISOString() };
        await saveTopicState(topicState);
        logger.info('reaper', 'captured session after recovery', {
          session_id: session.session_id,
          worker: session.worker,
          chatId: record.chatId,
          threadId: record.threadId,
        });
      } catch (err) {
        logger.warn('reaper', 'failed to capture session after recovery', { error: String(err) });
      }
    },
    updatePinnedCard: async (record, opts) => {
      try {
        const topicState = await loadTopicState(record.chatId, record.threadId);
        const worker = topicState.preferred_worker || 'default';
        const currentWorker = opts?.reasonCode === 'recovery-resume' ? (record.session?.worker ?? worker) : worker;
        const config = await loadConfig().catch(() => ({ workers: [] }));
        const workerConfig = (config as any)?.workers?.find((w: any) => w.name === currentWorker);
        const currentLlm = workerConfig
          ? resolveWorkerLlm(workerConfig, selectWorkerTunables(topicState.tunable_overrides, currentWorker), selectWorkerTunables(topicState.tunable_defaults, currentWorker))
          : undefined;
        // Build a recovery snapshot — pinned card shows "Recovering..." while waiting
        const snapshot = buildModelStatusSnapshot({
          defaultWorker: worker,
          currentWorker,
          currentLlm,
          reasonCode: (opts?.reasonCode ?? 'recovery') as any,
          reasonText: 'Resuming your request…',
        });
        topicState.model_status = snapshot;
        if (topicState.pinned_status_message_id) {
          const pinText = renderStatusCard({ snapshot, keepAwake: getKeepAwakeStatus() });
          await editMessageText(token, record.chatId, topicState.pinned_status_message_id, pinText).catch(() => false);
        } else {
          // No pinned message — skip
        }
        await saveTopicState(topicState);
      } catch (err) {
        logger.warn('reaper', 'failed to update pinned card', { error: String(err) });
      }
    },
    redispatchWithResume: (record) => redispatchWithResume(record, token, secrets ?? Object.fromEntries(Object.entries(process.env).filter(([k,v]) => v !== undefined)) as Record<string, string>),
    reviveVoiceNote: (record) => reviveVoiceNote(record, token, secrets ?? {}),
  };
}

async function reviveVoiceNote(record: PendingDispatch, token: string, secrets: Record<string, string>): Promise<string | null> {
  const kc = placeholderKindAndCaption(record.userText);
  if (!kc || !record.voiceFileId) return null;
  // Command-caption guard: if caption starts with '/', do NOT revive
  if (kc.caption && kc.caption.startsWith('/')) return null;

  const media = {
    file_id: record.voiceFileId,
    file_unique_id: `recovered-${record.updateId}`,
    duration: 0,
  };

  try {
    const vr = await transcribeVoiceMessage(token, record.chatId, media, {
      repoRoot: record.cwd || process.env.PA_BOT_CWD || process.cwd(),
      env: { ...process.env, ...secrets },
      transcription: (await loadConfig().catch(() => ({ transcription: {} } as any))).transcription,
      threadId: record.threadId,
    }, kc.kind);

    if (vr.ok && vr.text) {
      return formatTranscriptUserText(vr.text, { truncated: vr.truncated, caption: kc.caption, kind: kc.kind, speakers: vr.speakers });
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-record evaluation (single step, no sleeping — the loop lives outside)
// ---------------------------------------------------------------------------

export type ReapOutcome = 'already-delivered' | 'recovered' | 'dead' | 'waiting' | 'requeued' | 'parked';

function preview(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 120) + '…' : t;
}

function deathNotice(record: PendingDispatch): string {
  return `⚠️ This request couldn't be completed — tap Resend, or send it again:\n«${preview(record.userText)}»`;
}

function untranscribedNotice(_record: PendingDispatch): string {
  return '⚠️ That voice note couldn\'t be processed — please send it again.';
}

async function finish(record: PendingDispatch, outcome: 'recovered' | 'dead'): Promise<void> {
  // Mark delivered so a re-run of the reaper (or update reprocessing) can't
  // double-deliver, then clear the record.
  await markDelivered(deliveredKey(record.chatId, record.threadId, record.updateId)).catch(() => {});
  await removePendingDispatch(pendingDispatchKey(record.chatId, record.threadId, record.updateId));
  logger.info('reaper', `pending dispatch ${outcome}`, { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId });
}

/**
 * Re-dispatch a pending request with native conversation resume.
 * Called when the worker is dead, no result was recoverable from the tee
 * file or transcript, but a session ID exists. Spawns a new worker with
 * resume args and the original user text, returning the raw output.
 *
 * Returns the output string, or null if re-dispatch is not possible
 * (no session, no worker config, execution failed).
 */
export async function redispatchWithResume(
  record: PendingDispatch,
  token: string,
  secrets: Record<string, string>,
): Promise<string | null> {
  const session = record.session;
  if (!session || !session.session_id) return null;
  try {
    const config = await loadConfig();
    const workers = config.workers ?? [];
    const workerConfig = workers.find((w: any) => w.name === session.worker);
    if (!workerConfig) return null;

    const resource = `topic-${record.chatId}_${record.threadId}`;
    const resumeArgs = buildResumeArgs(session);
    const prompt = record.userText;

    // Build a minimal prompt — just the user text. Native resume picks up
    // conversation context from the worker's own session history.
    const result = await executeWorker(
      workerConfig,
      prompt,
      {
        cwd: record.cwd || process.env.PA_BOT_CWD || process.cwd(),
        env: { ...process.env, ...secrets, PA_BOT_PID: String(process.pid) },
        extraArgs: undefined, // No tunables for recovery re-dispatch
        resource,
        agentName: session.worker,
        harvestWindowMs: REDISPATCH_HARVEST_MS,
      },
    );

    if (result.success && result.output.trim()) {
      return result.output;
    }
    return null;
  } catch (err) {
    logger.warn('reaper', 're-dispatch with resume failed', {
      error: String(err),
      session_id: session.session_id,
      worker: session.worker,
    });
    return null;
  }
}

export async function evaluatePendingDispatch(
  record: PendingDispatch,
  deps: ReaperDeps,
  deadlineMs: number,
): Promise<ReapOutcome> {
  // WP-C C2: a parked ladder record (requeueNotBefore set by main.ts's failure
  // suppression) belongs to the maintenance drain, not the reaper. Skipping it
  // entirely — not 'waiting' — lets the topic's gate clear this round so the
  // drain's re-injected synthetic is never wedged behind the recovery gate.
  if (record.requeueNotBefore !== undefined) {
    logger.info('reaper', 'skipping parked ladder record (drain owns it)',
      { updateId: record.updateId, requeueNotBefore: record.requeueNotBefore });
    return 'parked';
  }

  // Step 0: Already delivered?
  const key = deliveredKey(record.chatId, record.threadId, record.updateId);
  if (await wasDelivered(key)) {
    await removePendingDispatch(pendingDispatchKey(record.chatId, record.threadId, record.updateId));
    return 'already-delivered';
  }

  const expired = deps.now() >= deadlineMs;

  // Step 1: Worker alive? (ALWAYS first, for ALL records)
  // The 30-second heartbeat gap means a newly-dispatched worker's
  // descendants list may be empty, so `isTopicWorkerAliveByRegistry`
  // can false-negative. The deps implementation adds a direct
  // process-tree scan fallback for that window.
  const workerAlive = await deps.isTopicWorkerAlive(record);

  if (workerAlive && !expired) {
    // Worker still running. Check recovery sources for completion.
    const sourceResult = await deps.checkRecoverySource?.(record) ?? null;
    if (sourceResult !== null) {
      // Worker finished producing output while we were checking.
      // Deliver the harvested reply.
      const { cleaned } = parseMetadata(sourceResult);
      const body = cleaned.trim() || sourceResult.trim();
      const worker = record.workerName ?? record.session?.worker ?? 'agy';
      const formatted = formatWorkerReply(body, worker);
      if (formatted === '') {
        // Worker produced no output — treat as null source
        return 'waiting';
      }
      const sent = await deps.send(record, formatted);
      if (sent) {
        await deps.captureSession?.(record, sourceResult);
        await deps.updatePinnedCard?.(record, { reasonCode: 'recovery-worker-alive' });
        await finish(record, 'recovered');
        return 'recovered';
      }
      return 'waiting'; // send failed — retry next poll
    }
    return 'waiting'; // worker alive, no result yet
  }

  // Step 2: Worker dead (or expired). Check recovery sources.
  // 2a: Tee file (from pending dispatch if set, else from worker-pids registry)
  let teeRaw: string | null = null;
  // First try record.teePath (set by processUpdate after dispatch)
  if (record.teePath) {
    try {
      teeRaw = await (deps.readFile ?? readFile)(record.teePath, 'utf8');
    } catch {
      teeRaw = null;
    }
  }
  // Fallback: readTeePath dep (reads from worker-pids registry for old records)
  if (teeRaw === null) {
    const teePath = await deps.readTeePath?.(record) ?? null;
    if (teePath) {
      try {
        teeRaw = await (deps.readFile ?? readFile)(teePath, 'utf8');
      } catch {
        teeRaw = null;
      }
    }
  }
  if (teeRaw !== null) {
    const extracted = extractTeeResult(teeRaw);
    if (extracted) {
      const { cleaned } = parseMetadata(extracted);
      const body = cleaned.trim() || extracted.trim();
      const worker = record.workerName ?? record.session?.worker ?? 'agy';
      const formatted = formatWorkerReply(body, worker);
      if (formatted === '') {
        // Fall through to transcript check
      } else {
        const sent = await deps.send(record, formatted);
        if (sent) {
          await deps.captureSession?.(record, extracted);
          await deps.updatePinnedCard?.(record, { reasonCode: 'recovery-tee' });
          await finish(record, 'recovered');
          return 'recovered';
        }
        return 'waiting';
      }
    }
    // Tee file exists but has no extractable result — fall through to transcript check
  }

  // 2b: Transcript (claude-family with session)
  const session = record.session;
  const recoverable = !!session && CLAUDE_FAMILY.has(session.worker);
  if (recoverable) {
    const transcript = await deps.readTranscript(record);
    if (transcript) {
      const final = extractFinalAssistantText(transcript.content, record.startedAt);
      const quiescent = deps.now() - transcript.mtimeMs >= TRANSCRIPT_QUIESCENT_MS;
      if (final && (quiescent || expired)) {
        const { cleaned } = parseMetadata(final.text);
        const body = cleaned.trim() || final.text.trim();
        const worker = record.workerName ?? record.session?.worker ?? 'agy';
        const formatted = formatWorkerReply(body, worker);
        if (formatted === '') {
          // Fall through to redispatch
        } else {
          const sent = await deps.send(record, formatted);
          if (sent) {
            await deps.captureSession?.(record, final.text);
            await deps.updatePinnedCard?.(record, { reasonCode: 'recovery-transcript' });
            await finish(record, 'recovered');
            return 'recovered';
          }
          return 'waiting';
        }
      }
      if (!expired) return 'waiting';
    }
  }

  // Step 3: Native resume re-dispatch (worker dead, no result anywhere, but have session)
  // Only attempt if session has a valid session_id (empty session_id means
  // the session was never properly initialized, so skip re-dispatch).
  let resumeAttemptedAndFailed = false;
  if (session?.session_id && !expired && deps.redispatchWithResume) {
    const result = await deps.redispatchWithResume(record);
    if (result !== null && result !== undefined) {
      const { cleaned } = parseMetadata(result);
      const body = cleaned.trim() || result.trim();
      const worker = record.workerName ?? record.session?.worker ?? 'agy';
      const formatted = formatWorkerReply(body, worker);
      if (formatted === '') {
        // Fall through to death notice
        resumeAttemptedAndFailed = true;
      } else {
        const sent = await deps.send(record, formatted);
        if (sent) {
          await deps.captureSession?.(record, result);
          await deps.updatePinnedCard?.(record, { reasonCode: 'recovery-resume' });
          await finish(record, 'recovered');
          return 'recovered';
        }
        return 'waiting'; // send failed — retry next poll
      }
    } else {
      // Re-dispatch returned null (execution failed or no worker config) — mark
      // as attempted-and-failed so we fall through to death notice below.
      resumeAttemptedAndFailed = true;
    }
  }

  // Step 4: Death notice (true last resort)
  // Send death notice when: expired, OR no session, OR session exists but is
  // non-recoverable (not in CLAUDE_FAMILY), OR all recovery sources have been
  // exhausted (worker dead + no tee + no transcript + resume failed/skipped).
  if (expired || !session || !recoverable || resumeAttemptedAndFailed) {
    // Voice placeholder branch: try revive before giving up (A10 part b)
    if (isBarePlaceholderUserText(record.userText) && record.userTextSettled !== true) {
      const kc = placeholderKindAndCaption(record.userText);
      const v = Number(process.env.PA_REQUEUE_MAX);
      const max = Number.isFinite(v) && v >= 0 ? v : 2; // PA_REQUEUE_* frozen in SPEC §2
      const stopped = isTopicStopped(`${record.chatId}_${record.threadId}`, record.updateId);

      // Voice revive attempt
      if (kc && kc.caption && !kc.caption.startsWith('/') && record.voiceFileId && deps.reviveVoiceNote && (record.requeueCount ?? 0) < max && !stopped) {
        const transcript = await deps.reviveVoiceNote(record);
        if (transcript !== null) {
          // Revive succeeded: requeue with transcript
          const next = (record.requeueCount ?? 0) + 1;
          await updatePendingDispatch(
            pendingDispatchKey(record.chatId, record.threadId, record.updateId),
            { requeueCount: next, userText: transcript, userTextSettled: true },
          ).catch(() => {});
          logger.info('reaper', 'voice placeholder revived with transcript',
            { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId });
          deps.requeueUpdate?.({ ...record, userText: transcript, userTextSettled: true, requeueCount: next });
          return 'requeued';
        }
      }
      // Revive failed or not possible: send neutral untranscribed notice
      const sent = await deps.send(record, untranscribedNotice(record)).catch(() => false);
      if (!sent) return 'waiting';
      await finish(record, 'dead');
      return 'dead';
    }

    // Auto-requeue ladder (A4 part b)
    const v = Number(process.env.PA_REQUEUE_MAX);
    const max = Number.isFinite(v) && v >= 0 ? v : 2; // PA_REQUEUE_* frozen in SPEC §2
    const stopped = isTopicStopped(`${record.chatId}_${record.threadId}`, record.updateId);
    if (deps.requeueUpdate && !stopped
        && !isBarePlaceholderUserText(record.userText)
        && (record.requeueCount ?? 0) < max) {
      const next = (record.requeueCount ?? 0) + 1;
      await updatePendingDispatch(
        pendingDispatchKey(record.chatId, record.threadId, record.updateId),
        { requeueCount: next },
      ).catch(() => {});
      logger.info('reaper', `pending dispatch requeued (attempt ${next})`,
        { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId });
      deps.requeueUpdate({ ...record, requeueCount: next });
      return 'requeued';
    }

    // No requeue possible: send death notice with resend keyboard
    await putResend({
      chatId: record.chatId,
      threadId: record.threadId,
      updateId: record.updateId,
      messageId: record.messageId,
      userText: record.userText,
      userTextSettled: record.userTextSettled,
      storedAt: new Date().toISOString(),
    }).catch(() => {});
    const keyboard = buildResendKeyboard(record.chatId, record.threadId, record.updateId);
    // AI-186: prefer the detailed send when injected — it classifies terminal
    // failures (400 chat not found) so an unreachable chat settles 'dead'
    // instead of retrying every poll for the whole reap window.
    const sentInfo = deps.sendDetailed
      ? await deps.sendDetailed(record, deathNotice(record), keyboard).catch(() => ({ delivered: false, terminal: false }))
      : { delivered: await deps.send(record, deathNotice(record), keyboard).catch(() => false), terminal: false as const };
    if (!sentInfo.delivered) {
      if (sentInfo.terminal) {
        logger.warn('reaper', 'death notice undeliverable (terminal send failure) — dropping dispatch and its resend record', { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId });
        await takeResend(resendKey(record.chatId, record.threadId, record.updateId)).catch(() => {});
        await finish(record, 'dead');
        return 'dead';
      }
      return 'waiting';
    }
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
  opts: { deps?: ReaperDeps; maxWaitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; secrets?: Record<string, string>; requeueUpdate?: (record: PendingDispatch) => void; reviveVoiceNote?: (record: PendingDispatch) => Promise<string | null>; allowedChatIds?: ReadonlySet<number> } = {},
): Promise<void> {
  const deps = opts.deps
    ?? { ...makeDefaultDeps(token, opts.secrets ?? {}),
         ...(opts.requeueUpdate ? { requeueUpdate: opts.requeueUpdate } : {}),
         ...(opts.reviveVoiceNote ? { reviveVoiceNote: opts.reviveVoiceNote } : {}) };
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
          // AI-186: a record for a chat the operator never allowed (e.g. a leaked
          // test fixture) can never be delivered — quarantine it dead at round 0
          // instead of death-noticing into a 400 chat-not-found retry flood.
          if (opts.allowedChatIds && !opts.allowedChatIds.has(record.chatId)) {
            logger.warn('reaper', 'quarantining dispatch to chat outside allowedChatIds — unreachable', { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId });
            await finish(record, 'dead');
            continue;
          }
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
