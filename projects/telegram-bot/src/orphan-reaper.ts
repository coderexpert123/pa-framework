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
import { sendMessage, sendMessageWithKeyboard, sendMessageWithKeyboardDetailed, sendTyping, editMessageText, sendMessageWithId, type InlineKeyboardMarkup } from './telegram.js';
import { sendReplyText } from './rich-message.js';
import { getPriorSessionPath, buildResumeArgs } from './session.js';
import { parseMetadata, buildModelStatusSnapshot, renderStatusCard, resolveWorkerLlm, selectWorkerTunables, formatWorkerReply, isPrematureAsyncReply, normalizeMarkdown } from './logic.js';
import type { ModelStatusReasonCode } from './types.js';
import { loadTopicState, saveTopicState, addTurn } from './conversation.js';
import { deliveredKey, wasDelivered, markDelivered } from './delivered-store.js';
import { listPendingDispatches, removePendingDispatch, pendingDispatchKey, updatePendingDispatch, type PendingDispatch } from './pending-dispatches.js';
import { putResend, takeResend, resendKey } from './resend-store.js';
import { isBarePlaceholderUserText, transcribeVoiceMessage, formatTranscriptUserText, extensionForAttachment, voiceAttachmentPath } from './voice.js';
import { buildResendKeyboard } from './callbacks.js';
import { makeRefId, appendRefIdAndLog, type RefKind } from './ref-id.js';
import { markTopicRecovering, clearTopicRecovering } from './recovery-gate.js';
import { isTopicStopped } from './worker-stop.js';
import { ORPHAN_HARVEST_WINDOW_MS } from './task-executor.js';
import { THREAD_RESPONSE_CAP_CHARS } from './thread-executor.js';
import {
  listStoreKeys,
  listThreads,
  getThread,
  touchThread,
  settleOrphanedThread,
  restartParkFields,
  type ThreadRecord,
} from './topic-threads.js';
import { extractVoiceInboxTaskIds } from './voice-inbox-bridge.js';
import { listWorkerPids } from '../../../pa/dist/src/worker-pids.js';
import { getDescendantPids, areProcessesAlive, findProcessesByCommandLine } from '../../../pa/dist/src/process-tree.js';
import { executeWorker } from '../../../pa/dist/src/worker-exec.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { voiceInboxTerminalTaskIds as voiceInboxTerminalTaskIdsSync } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import { appendTopicEvent, type TopicEventKind } from '../../../pa/dist/src/lib/topic-events.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';

/** Minimal structural logger so tests can observe the held-record notice via
 *  `_setLoggerForTest` (AI-208 fix-wave m3). */
type ReaperNoticeLogger = {
  info: (module: string, message: string, ctx?: Record<string, unknown>) => void;
};
let noticeLog: ReaperNoticeLogger = logger;

/** Test hook: injects a fake logger for the held-record notice (pass null to restore the real one). */
export function _setNoticeLoggerForTest(fake: ReaperNoticeLogger | null): void {
  noticeLog = fake ?? logger;
}

const CLAUDE_FAMILY = new Set(['claude', 'zclaude']);

/** Transcript must be untouched this long before we trust it as final. */
export const TRANSCRIPT_QUIESCENT_MS = 90_000;
/** Give up waiting for an orphan this long after reaping starts. */
export const REAP_MAX_WAIT_MS = 45 * 60 * 1000;
export const REAP_POLL_MS = 20_000;
export const TYPING_REFRESH_MS = 4_000;
/** Protects the re-dispatched worker from the per-minute orphan sweep — the
 * same harvest window that guarded the original dispatch (single source:
 * task-executor.ts; the "same value" restatement drifted once already). */
const REDISPATCH_HARVEST_MS = ORPHAN_HARVEST_WINDOW_MS;

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
  /** Dead-dispatch arm's liveness decision (AI-241): the default impl is
   *  OS-truth (`isTopicWorkerAliveOnMachine`) — the worker-pids registry is
   *  only a pid HINT inside it, never the verdict. */
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
  /** Which of these voice-inbox task ids are in a terminal ledger state
   *  (done/failed/cancelled/transcribe_failed). Optional: when absent the
   *  guard is skipped entirely, so hand-built test deps keep today's
   *  behavior. Fails open — an unreadable ledger returns an empty set. */
  voiceInboxTerminalTaskIds?: (taskIds: string[]) => Promise<Set<string>>;
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

/** Injectable OS reads backing the dead-dispatch liveness decision (AI-241).
 *  Defaults route through process-tree's shared snapshot — ONE full-process
 *  OS query per TTL window, never per-PID CIM/ps calls on this path. Tests
 *  inject fakes for call-count semantics. */
export interface TopicWorkerOsReads {
  areProcessesAlive?: (pids: number[]) => Promise<Map<number, boolean>>;
  getDescendantPids?: (pid: number) => Promise<Array<{ pid: number; parentPid: number }>>;
  scanCommandLines?: (needle: string) => Promise<Array<{ pid: number; cmdline: string }>>;
}

/**
 * OS-truth worker liveness core (AI-241, generalized for AI-228's thread
 * sibling). The worker-pids registry is a HINT — candidate pids to resolve —
 * never the verdict itself: it lies stale after bot restarts in BOTH
 * directions (entry lingers while the process is dead; entry gone while the
 * process lives — registry removal must never by itself conclude "dead"). Two
 * prongs, in fixed order, both answered by the OS process snapshot:
 *
 *  1. Registry pids resolved against the OS: every registry entry matching
 *     `resource` contributes its wrapper pid plus recorded descendants (the
 *     wrapper can die while the real CLI child lives — 2026-07-04 incident:
 *     intermediate assistant text delivered as a "final" reply), plus a live
 *     snapshot tree-walk when the descendants list is empty (30 s heartbeat
 *     gap — a just-dispatched worker's children aren't recorded yet). A
 *     matching entry's `teePath` basename also joins the needle set here —
 *     the same entries prong 1 already lists, no second registry read (the
 *     agy tee helper's `<contextId>.out` path survives on the orphan's
 *     cmdline even when the record itself never captured one).
 *  2. Command-line scan, reached ONLY when prong 1 found nothing alive:
 *     scan the snapshot's command lines for needles that actually appear on
 *     a worker's cmdline — the resumed session id (`--resume`/`resume`/
 *     `--conversation <id>`) and tee-path basenames (basename only —
 *     slash-normalization-proof). Catches the live-but-unregistered worker
 *     the registry lost. A POSIX snapshot carries no command lines, so this
 *     finds nothing there — a miss is "no evidence", never positive proof
 *     of death.
 */
async function isWorkerAliveOnMachineCore(
  resource: string,
  needles: Iterable<string>,
  reads: TopicWorkerOsReads,
): Promise<boolean> {
  const areAlive = reads.areProcessesAlive ?? areProcessesAlive;
  const descendantsOf = reads.getDescendantPids ?? getDescendantPids;
  const scanCmdlines = reads.scanCommandLines ?? findProcessesByCommandLine;

  const allNeedles = new Set(needles);
  // Prong 1 — registry-resolved pids checked against the OS snapshot.
  try {
    const entries = await listWorkerPids();
    const candidates = new Set<number>();
    for (const e of entries) {
      if (e.skill !== resource) continue;
      candidates.add(e.pid);
      for (const d of e.descendants ?? []) candidates.add(d);
      // The matching entry's own tee file is a prong-2 needle too — pulled
      // from the entry prong 1 already holds (see header).
      const teeBase = e.teePath?.split(/[\\/]/).pop();
      if (teeBase) allNeedles.add(teeBase);
      if (!e.descendants || e.descendants.length === 0) {
        try {
          for (const d of await descendantsOf(e.pid)) candidates.add(d.pid);
        } catch { /* process-tree scan failed — fall through */ }
      }
    }
    if (candidates.size > 0) {
      const aliveByPid = await areAlive([...candidates]);
      for (const alive of aliveByPid.values()) {
        if (alive) return true;
      }
    }
  } catch { /* registry unreadable — fall through to the cmdline scan */ }

  // Prong 2 — command-line scan for the live-but-unregistered worker.
  for (const needle of allNeedles) {
    try {
      if ((await scanCmdlines(needle)).length > 0) return true;
    } catch { /* scan failed — no evidence */ }
  }
  return false;
}

/**
 * Topic-turn dispatch liveness — thin adapter over the core (AI-241).
 * Resource is the topic lane's `topic-<chatId>_<threadId>`; needles are the
 * record's own session id + captured tee basename. Exported for tests.
 */
export async function isTopicWorkerAliveOnMachine(
  record: PendingDispatch,
  reads: TopicWorkerOsReads = {},
): Promise<boolean> {
  const resource = `topic-${record.chatId}_${record.threadId}`;
  return isWorkerAliveOnMachineCore(resource, dispatchCmdlineNeedles(record), reads);
}

/**
 * Thread-worker liveness (AI-228) — same OS-truth core, thread resource
 * `topic-<key>-th<rec.n>` (byte-identical to the executor's resource at
 * dispatch). Needles: the resumed run's session id; matching registry
 * entries' teePath basenames are collected by the core itself. Known hole,
 * accepted by design: a FRESH-run claude orphan that lost its registry entry
 * carries no needle at all → prong 2 is empty → can false-negative to dead →
 * demote-while-alive → duplicate run. Bounded because a live orphan inside
 * its 50-min harvest window keeps its entry (the startup kill pass spares
 * it) and outside it the kill pass already killed it — the residual is
 * registry-removal-while-alive only (spawnedBy PID reuse, manual rm).
 * Exported for tests.
 */
export async function isThreadWorkerAliveOnMachine(
  key: string,
  rec: Pick<ThreadRecord, 'n' | 'session'>,
  reads: TopicWorkerOsReads = {},
): Promise<boolean> {
  const resource = `topic-${key}-th${rec.n}`;
  const needles: string[] = [];
  if (rec.session?.session_id) needles.push(rec.session.session_id);
  return isWorkerAliveOnMachineCore(resource, needles, reads);
}

/** Command-line needles identifying THIS dispatch's worker on the OS
 *  process table (AI-241 prong 2). Session ids and contextId-based tee
 *  filenames are uuid-class strings — a substring hit inside an unrelated
 *  longer id is astronomically unlikely; the topic resource string itself
 *  is deliberately NOT a needle (PA_WORKER_RESOURCE is env-only, never on
 *  a command line). */
export function dispatchCmdlineNeedles(record: PendingDispatch): string[] {
  const needles = new Set<string>();
  if (record.session?.session_id) needles.add(record.session.session_id);
  if (record.teePath) {
    // Split on BOTH separators — path.basename ignores '\' on POSIX, and the
    // tee path is written with platform separators while cmdlines may carry
    // either form. The basename alone is the needle (slash-agnostic).
    const base = record.teePath.split(/[\\/]/).pop();
    if (base) needles.add(base);
  }
  return [...needles];
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

/**
 * The tee-captured stdout path for a THREAD worker (AI-228): the record
 * carries no teePath field (unlike PendingDispatch), so the registry entry
 * matching the thread's `topic-<key>-th<n>` resource is the only source.
 * Exported for tests.
 */
export async function findThreadTeePathByRegistry(key: string, n: number): Promise<string | null> {
  const resource = `topic-${key}-th${n}`;
  try {
    const entries = await listWorkerPids();
    for (const entry of entries) {
      if (entry.skill === resource && entry.teePath) return entry.teePath;
    }
  } catch {
    // registry unreadable — no recovery source
  }
  return null;
}

export function makeDefaultDeps(token: string, secrets?: Record<string, string>): ReaperDeps {
  return {
    send: async (record, text, replyMarkup) => {
      const refId = makeRefId();
      // normalizeMarkdown wraps a markdown table in a ``` block before
      // sanitizeMdV2 escapes it (see main.ts's textToSend for the same fix) —
      // recovered worker output degrades to raw pipe text otherwise.
      const fullText = `${normalizeMarkdown(text)}\n\n_Ref: ${refId}_`;
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
      const fullText = `${normalizeMarkdown(text)}\n\n_Ref: ${refId}_`;
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
    isTopicWorkerAlive: isTopicWorkerAliveOnMachine,
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
          const pinText = renderStatusCard({ snapshot });
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
    voiceInboxTerminalTaskIds: async (taskIds) => voiceInboxTerminalTaskIdsSync(taskIds),
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

export type ReapOutcome = 'already-delivered' | 'recovered' | 'dead' | 'waiting' | 'requeued' | 'parked' | 'held' | 'terminal';

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
  // Step -1: a voice-inbox task the operator cancelled (or that already
  // finished) must never be re-dispatched. The fact lives in the voice-inbox
  // ledger, which the HTTP cancel writes synchronously — a bot-side mirror
  // would only be written by the drain, and the crash window where the drain
  // has NOT run is exactly the case this guard exists for (live incident
  // 2026-09-08: two stale records for one cancelled task). Guard fires only
  // when the record names at least one task id and EVERY named id is terminal,
  // so a batched prompt mixing a cancelled and a live request still recovers.
  const namedTaskIds = extractVoiceInboxTaskIds(record.userText);
  if (namedTaskIds.length > 0 && deps.voiceInboxTerminalTaskIds) {
    const terminal = await deps.voiceInboxTerminalTaskIds(namedTaskIds).catch(() => new Set<string>());
    if (namedTaskIds.every((id) => terminal.has(id))) {
      logger.info('reaper', 'dropping a pending dispatch for a terminal voice-inbox task',
        { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId, taskIds: namedTaskIds.join(',') });
      await removePendingDispatch(pendingDispatchKey(record.chatId, record.threadId, record.updateId));
      return 'terminal';
    }
  }

  // AI-208 WP-4 E3: a held record (drained by a /steer or /stop, transcript
  // held for the topic's next dispatch instead of dispatched) is NOT a dead
  // dispatch. It must never get a death notice and never be requeued as a
  // failure — the next dispatch in the topic absorbs it (absorbHeldDispatchRecords)
  // and the requeue ladder would only duplicate it. Skip it entirely — not
  // 'waiting' — so it settles this round and the topic's recovery gate clears,
  // letting that absorbing dispatch through. The record stays on disk.
  // Fix-wave m3: the skip notice logs ONCE (first pass sets heldNotifiedAt on
  // the record, best-effort) so a record held across many reaper passes
  // doesn't spam the log.
  if (record.heldForTopic === true) {
    if (record.heldNotifiedAt === undefined) {
      noticeLog.info('reaper', 'held record left for next dispatch',
        { updateId: record.updateId, chatId: record.chatId, threadId: record.threadId });
      await updatePendingDispatch(
        pendingDispatchKey(record.chatId, record.threadId, record.updateId),
        { heldNotifiedAt: new Date().toISOString() },
      ).catch(() => {}); // best-effort: a failed write must not fail the evaluation
    }
    return 'held';
  }

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
  // The default deps implementation is OS-truth (AI-241): registry pids
  // resolved against the process snapshot plus a command-line scan for
  // the live-but-unregistered case — registry membership alone never
  // decides "dead".
  const workerAlive = await deps.isTopicWorkerAlive(record);

  if (workerAlive && !expired) {
    // Worker still running. Check recovery sources for completion.
    const sourceResult = await deps.checkRecoverySource?.(record) ?? null;
    if (sourceResult !== null) {
      // Worker finished producing output while we were checking.
      // Deliver the harvested reply.
      const { cleaned, meta } = parseMetadata(sourceResult);
      const body = cleaned.trim() || sourceResult.trim();
      const worker = record.workerName ?? record.session?.worker ?? 'agy';
      const formatted = formatWorkerReply(body, worker);
      if (formatted === '' || (meta === null && isPrematureAsyncReply(body))) {
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
      const { cleaned, meta } = parseMetadata(extracted);
      const body = cleaned.trim() || extracted.trim();
      const worker = record.workerName ?? record.session?.worker ?? 'agy';
      const formatted = formatWorkerReply(body, worker);
      if (formatted === '' || (meta === null && isPrematureAsyncReply(body))) {
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
        const { cleaned, meta } = parseMetadata(final.text);
        const body = cleaned.trim() || final.text.trim();
        const worker = record.workerName ?? record.session?.worker ?? 'agy';
        const formatted = formatWorkerReply(body, worker);
        if (formatted === '' || (meta === null && isPrematureAsyncReply(body))) {
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
      const { cleaned, meta } = parseMetadata(result);
      const body = cleaned.trim() || result.trim();
      const worker = record.workerName ?? record.session?.worker ?? 'agy';
      const formatted = formatWorkerReply(body, worker);
      if (formatted === '' || (meta === null && isPrematureAsyncReply(body))) {
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

// ---------------------------------------------------------------------------
// Orphaned THREAD records (AI-228) — the topic-threads store's recovery pass
// ---------------------------------------------------------------------------
//
// When the bot crashes mid-dispatch of an orchestrator thread, the owning
// ThreadRecord keeps `status: 'running'` with a frozen updatedAt — a zombie
// only the lazy 30-minute stale sweep would eventually requeue. Thread
// dispatches never write PendingDispatch records (the executor fires
// runWithFailover directly on resource `topic-<key>-th<n>`), so this is a
// SIBLING pass in the same module, keyed off the thread store itself: at
// process start — before any claimThreadStarts can fire — every `running`
// record is definitionally orphaned, because the executor pump that owns its
// updatedAt died with the previous process. Startup state is unambiguous in
// a way mid-run reads never are.
//
// Ordering is LOAD-BEARING: this pass must run AFTER the startup
// cleanupOrphanedWorkers kill pass. A live orphan inside its 50-min
// harvestUntil window keeps its registry entry (the kill spares it), while a
// dead one's entry is already gone — so registry+OS truth is reliable
// exactly because we run second. The topic's recovery gate is deliberately
// NOT involved: a thread orphan writes its own session on its own resource,
// so marking its topic 'recovering' would block unrelated dispatches for no
// safety gain.

/** Slack subtracted from a record's adoption-time `updatedAt` to anchor
 *  transcript harvest: the dead executor's last pump beat precedes death by
 *  <= the ~10 s pump cadence, so 60 s covers the pump gap without reaching
 *  into the previous turn's answer. For a resumed run the session transcript
 *  IS the current run's. */
export const THREAD_HARVEST_LOOKBACK_MS = 60_000;
/** Detached-watcher cadence for the give-up tail (D7) — slower than the
 *  active-pass poll; it only needs to outlive the orphan. */
export const THREAD_WATCHER_POLL_MS = 60_000;
/** The honest 'done' note when the dead orphan's carried voice tasks are ALL
 *  already terminal — its own task_complete.py beat the crash, and
 *  re-running finished work is the worst outcome. No FYI rides it: the task
 *  card already settled, so there is nothing new for the operator. Same
 *  register as the executor's THREAD_VOICE_EMPTY_RESULT_NOTE. */
export const THREAD_ORPHAN_CLOSED_TASK_NOTE =
  'This run was interrupted by a bot restart; the task it carried was already closed. Ask again to redo it.';

/** One running record adopted at pass 0 — the ownership gate rides runSeq. */
export interface AdoptedThread {
  key: string;
  id: string;
  /** runSeq captured at adoption; any advance means a new owner took it. */
  runSeq: number;
  /** Transcript harvest anchor (ISO): adoption-time updatedAt minus
   *  THREAD_HARVEST_LOOKBACK_MS. Frozen at adoption — the reaper's own
   *  touchThread pump must never slide it forward and lose a
   *  completed-before-death result. */
  afterIso: string;
}

export type ThreadReapOutcome = 'done' | 'requeued' | 'waiting' | 'dropped';

/**
 * Every side effect injectable (ReaperDeps precedent). Defaults hit the real
 * stores, the OS process snapshot and Telegram.
 */
export interface ThreadReaperDeps {
  listStoreKeys: () => Promise<string[]>;
  /** Per-topic read WITH lazy stale demotion — records already >30 min stale
   *  are requeued by the existing sweep for free; we adopt only what stays
   *  `running`. */
  listThreads: (key: string) => Promise<ThreadRecord[]>;
  /** Fresh re-read each round (no demotion on read). */
  getThread: (key: string, id: string) => Promise<ThreadRecord | undefined>;
  /** The dead pump's replacement — REQUIRED for a live orphan, or demoteStale
   *  fires underneath it. */
  touchThread: (key: string, id: string) => Promise<void>;
  /** The conditional write — every settle goes through it so a lost race is a
   *  no-op, never a clobber. */
  settleOrphanedThread: (key: string, id: string, expectedRunSeq: number, patch: Partial<ThreadRecord>) => Promise<boolean>;
  /** OS-truth liveness for the thread's `topic-<key>-th<n>` resource. */
  isThreadWorkerAlive: (key: string, rec: ThreadRecord) => Promise<boolean>;
  /** The matching registry entry's teePath (agy), or null. */
  readTeeForThread: (key: string, rec: ThreadRecord) => Promise<string | null>;
  /** Claude-family session transcript for a resumed run (session + workdir),
   *  or null. */
  readTranscriptForThread: (key: string, rec: ThreadRecord) => Promise<{ content: string; mtimeMs: number } | null>;
  /** File read for the tee source (mocked in tests). */
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  /** The `✅ Thread <id> done:` FYI — same shape the executor sends. */
  sendThreadFyi: (key: string, text: string, kind: RefKind) => Promise<unknown>;
  /** Topic-event append (thread_completed), keyed by store key. */
  appendThreadEvent: (key: string, ev: { kind: TopicEventKind; ref?: string | null; detail?: string }) => Promise<void>;
  /** Which carried voice-inbox task ids are already terminal. Optional and
   *  fail-OPEN — absent or throwing means "not all terminal" → demote, the
   *  safe direction. */
  voiceInboxTerminalTaskIds?: (taskIds: string[]) => Promise<Set<string>>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function defaultReadThreadTranscript(rec: ThreadRecord): Promise<{ content: string; mtimeMs: number } | null> {
  const session = rec.session;
  if (!session || !CLAUDE_FAMILY.has(session.worker)) return Promise.resolve(null);
  const path = getPriorSessionPath(session.worker, session.session_id, rec.workdir);
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

export function makeDefaultThreadDeps(token: string, _secrets?: Record<string, string>): ThreadReaperDeps {
  return {
    listStoreKeys,
    listThreads,
    getThread,
    touchThread,
    settleOrphanedThread,
    isThreadWorkerAlive: (key, rec) => isThreadWorkerAliveOnMachine(key, rec),
    readTeeForThread: (key, rec) => findThreadTeePathByRegistry(key, rec.n),
    readTranscriptForThread: (_key, rec) => defaultReadThreadTranscript(rec),
    readFile,
    sendThreadFyi: async (key, text, kind) => {
      // Same unparseable-key skip as cancelRunningThreads' event emission —
      // some test store dirs use keys the Telegram path cannot address.
      const parsed = /^(-?\d+)_(\d+)$/.exec(key);
      if (!parsed) return null;
      const chatId = Number(parsed[1]);
      const threadId = Number(parsed[2]);
      return sendMessageWithId(
        token,
        chatId,
        appendRefIdAndLog(text, { kind, chatId, threadId }),
        threadId || undefined,
      );
    },
    appendThreadEvent: async (key, ev) => {
      const parsed = /^(-?\d+)_(\d+)$/.exec(key);
      if (!parsed) return;
      await appendTopicEvent(Number(parsed[1]), Number(parsed[2]), ev);
    },
    voiceInboxTerminalTaskIds: async (taskIds) => voiceInboxTerminalTaskIdsSync(taskIds),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

/**
 * Harvested text → storable body, or null. Same gate trio the dispatch arm
 * relies on (parseMetadata strip → formatWorkerReply non-empty → the AI-202
 * premature-async guard gated on meta === null): a contentless
 * "launched, waiting" stub must never become a lastResult.
 */
function usableThreadResult(raw: string, rec: ThreadRecord): string | null {
  const { cleaned, meta } = parseMetadata(raw);
  const body = cleaned.trim() || raw.trim();
  const formatted = formatWorkerReply(body, rec.session?.worker ?? 'agy');
  if (formatted === '' || (meta === null && isPrematureAsyncReply(body))) return null;
  return body;
}

/**
 * The orphan's harvest sources, mirroring the dispatch arm's step 2:
 * (a) the matching registry entry's teePath → extractTeeResult (agy);
 * (b) a claude-family session transcript → extractFinalAssistantText
 *     anchored at adopted.afterIso and gated on TRANSCRIPT_QUIESCENT_MS mtime
 *     quiescence (a still-moving transcript is never final).
 *
 * `pending` reports "a post-anchor reply exists but is not yet quiescent" —
 * the dispatch arm's `!quiescent && !expired → waiting` case. A dead orphan
 * with a pending reply WAITS a round for the mtime to settle rather than
 * demoting under work that already finished; a premature-async stub is never
 * pending (it cannot improve).
 */
async function harvestOrphanedThreadResult(
  adopted: AdoptedThread,
  rec: ThreadRecord,
  deps: ThreadReaperDeps,
): Promise<{ result: string | null; pending: boolean }> {
  const teePath = await deps.readTeeForThread(adopted.key, rec).catch(() => null);
  if (teePath) {
    try {
      const raw = await (deps.readFile ?? readFile)(teePath, 'utf8');
      const extracted = extractTeeResult(raw);
      const usable = extracted ? usableThreadResult(extracted, rec) : null;
      if (usable) return { result: usable, pending: false };
    } catch { /* tee unreadable — fall through to the transcript */ }
  }
  const transcript = await deps.readTranscriptForThread(adopted.key, rec).catch(() => null);
  if (transcript) {
    const final = extractFinalAssistantText(transcript.content, adopted.afterIso);
    const quiescent = deps.now() - transcript.mtimeMs >= TRANSCRIPT_QUIESCENT_MS;
    if (final && quiescent) {
      const usable = usableThreadResult(final.text, rec);
      if (usable) return { result: usable, pending: false };
    } else if (final) {
      return { result: null, pending: usableThreadResult(final.text, rec) !== null };
    }
  }
  return { result: null, pending: false };
}

/**
 * One per-record step of the thread-reaper pass — no sleeping (the loop lives
 * in reapOrphanedThreads / the detached watcher). Outcomes:
 *
 *  - 'dropped'  — the record left our ownership: re-read shows terminal /
 *    queued / a new runSeq (a claim, /stop, demoteStale or a settle won the
 *    race). Never written.
 *  - 'done'     — a harvestable result settled it (redactSecrets'd, uncapped;
 *    `thread_completed` event + the standard ✅ FYI), OR the dead orphan's
 *    carried voice tasks were all already terminal (honest note, NO FYI).
 *  - 'requeued' — dead orphan, no result, work plausibly unfinished: demoted
 *    to `queued` via the shared restartParkFields shape. The claim is NOT
 *    ours — claimThreadStarts is the only queued→running transition; the
 *    60 s reconcile picks it up after the park stamp and its own 🧵 FYI is
 *    the visibility.
 *  - 'waiting'  — the orphan is still alive: touched (the dead pump's
 *    replacement) and kept `running` for the next round.
 */
export async function evaluateOrphanedThread(
  adopted: AdoptedThread,
  deps: ThreadReaperDeps,
): Promise<ThreadReapOutcome> {
  const rec = await deps.getThread(adopted.key, adopted.id).catch(() => undefined);
  if (!rec || rec.status !== 'running' || rec.runSeq !== adopted.runSeq) return 'dropped';

  // Harvest FIRST — it covers the dead orphan AND the live orphan that
  // finished output but has not exited yet (settles 'done' early).
  const harvest = await harvestOrphanedThreadResult(adopted, rec, deps);
  if (harvest.result !== null) {
    const wrote = await deps.settleOrphanedThread(adopted.key, adopted.id, adopted.runSeq, {
      status: 'done',
      lastResult: redactSecrets(harvest.result) as string, // uncapped — the 2026-09-13 rule
      lastError: undefined,   // terminal hygiene: clear a stale restart-park/error
      parkedUntil: undefined, // from a previous episode (recommended + harmless)
      unavailableParks: 0,    // every outcome write resets the episode counter
    }).catch(() => false);
    if (!wrote) return 'dropped';
    try {
      await deps.appendThreadEvent(adopted.key, { kind: 'thread_completed', ref: adopted.id, detail: rec.title });
    } catch (err) {
      logger.warn('thread-reaper', `thread_completed event failed: ${(err as Error).message}`, { key: adopted.key, id: adopted.id });
    }
    // The executor's done-FYI shape, minus mirror/notice footers (a harvested
    // reply's PA_META actions do not re-arm — the record is already settled;
    // the operator can reply to continue the thread). No restart narration,
    // per the AI-095 user-strings rule.
    const normalized = normalizeMarkdown(redactSecrets(harvest.result) as string);
    const capped = normalized.length > THREAD_RESPONSE_CAP_CHARS
      ? normalized.slice(0, THREAD_RESPONSE_CAP_CHARS) + '…'
      : normalized;
    try {
      await deps.sendThreadFyi(
        adopted.key,
        `✅ Thread ${adopted.id} done: ${rec.title}\n\n${capped}\n\n_(Reply to this message to continue the thread.)_`,
        'thread-done',
      );
    } catch (err) {
      logger.warn('thread-reaper', `thread-done FYI failed: ${(err as Error).message}`, { key: adopted.key, id: adopted.id });
    }
    return 'done';
  }

  const alive = await deps.isThreadWorkerAlive(adopted.key, rec).catch(() => false);
  if (alive) {
    // REQUIRED, not optional: replace the dead executor's activity pump so
    // demoteStale cannot fire underneath a genuinely live orphan.
    await deps.touchThread(adopted.key, adopted.id).catch(() => {});
    return 'waiting';
  }

  if (harvest.pending) {
    // Dead worker, but a usable post-anchor reply sits inside the quiescence
    // window — wait a round for the mtime to settle instead of demoting under
    // finished work (the dispatch arm's `!quiescent && !expired` case).
    await deps.touchThread(adopted.key, adopted.id).catch(() => {});
    return 'waiting';
  }

  // Dead + no result + every carried voice task already terminal → an honest
  // 'done'. The ledger read fails OPEN (unreadable ⇒ empty ⇒ treated open ⇒
  // demote) — re-running finished work is the worst outcome, but a lost
  // ledger must never bury still-open work.
  const carried = rec.voiceTaskIds ?? [];
  if (carried.length > 0 && deps.voiceInboxTerminalTaskIds) {
    const terminal = await deps.voiceInboxTerminalTaskIds(carried).catch(() => new Set<string>());
    if (carried.every((vt) => terminal.has(vt))) {
      const wrote = await deps.settleOrphanedThread(adopted.key, adopted.id, adopted.runSeq, {
        status: 'done',
        lastResult: THREAD_ORPHAN_CLOSED_TASK_NOTE,
        lastError: undefined,
        parkedUntil: undefined,
        unavailableParks: 0,
      }).catch(() => false);
      if (!wrote) return 'dropped';
      try {
        await deps.appendThreadEvent(adopted.key, { kind: 'thread_completed', ref: adopted.id, detail: rec.title });
      } catch (err) {
        logger.warn('thread-reaper', `thread_completed event failed: ${(err as Error).message}`, { key: adopted.key, id: adopted.id });
      }
      return 'done';
    }
  }

  // Dead + no result + open/absent voice tasks → the restart-park demote,
  // field-identical to demoteStale's (shared shaper — they cannot drift).
  // `pendingInput` survives: a queued steer drains on the re-claimed run.
  const wrote = await deps.settleOrphanedThread(
    adopted.key,
    adopted.id,
    adopted.runSeq,
    restartParkFields(deps.now(), 'bot restarted mid-run'),
  ).catch(() => false);
  if (wrote) {
    logger.info('thread-reaper', 'orphaned thread requeued (restart-parked)', { key: adopted.key, id: adopted.id });
  }
  return wrote ? 'requeued' : 'dropped';
}

/**
 * D7 give-up tail: a shared unref'd interval keeps pumping and settling
 * still-live orphans until each exits or the process ends — pa's
 * orphan-worker-reap kills the worker at `harvestUntil` anyway, which bounds
 * the watch. The interval clears itself once every record settles and is
 * unref'd so it can never be an exit-blocking handle (the WP-H lesson).
 */
function armOrphanedThreadWatcher(
  remaining: AdoptedThread[],
  deps: ThreadReaperDeps,
  pollMs: number,
): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return; // a slow round never double-fires
    inFlight = true;
    void (async () => {
      try {
        const still: AdoptedThread[] = [];
        for (const a of remaining) {
          try {
            const outcome = await evaluateOrphanedThread(a, deps);
            if (outcome === 'waiting') still.push(a);
          } catch (err) {
            logger.warn('thread-reaper', 'watcher evaluation failed', { key: a.key, id: a.id, error: String(err) });
            still.push(a);
          }
        }
        remaining.length = 0;
        remaining.push(...still);
      } finally {
        inFlight = false;
        if (remaining.length === 0) clearInterval(timer);
      }
    })();
  }, pollMs);
  timer.unref();
}

/**
 * Settle (or watch) every thread record left `running` by a crashed prior
 * instance. Launched from main.ts's startup chain AFTER the awaited
 * cleanupOrphanedWorkers kill pass (its ordering is load-bearing — see the
 * section header), beside reapOrphanedDispatches; runs concurrently with it
 * and never touches the recovery gate. Resolves when every adopted record
 * settles, or hands the stragglers to the detached watcher at give-up.
 */
export async function reapOrphanedThreads(
  opts: {
    token?: string;
    secrets?: Record<string, string>;
    deps?: ThreadReaperDeps;
    maxWaitMs?: number;
    pollMs?: number;
    /** Detached-watcher cadence — tests shrink it. */
    watcherPollMs?: number;
  } = {},
): Promise<void> {
  const deps = opts.deps ?? makeDefaultThreadDeps(opts.token ?? '', opts.secrets ?? {});
  const maxWaitMs = opts.maxWaitMs ?? REAP_MAX_WAIT_MS;
  const pollMs = opts.pollMs ?? REAP_POLL_MS;
  const watcherPollMs = opts.watcherPollMs ?? THREAD_WATCHER_POLL_MS;

  // Pass 0 — enumerate every topic store and adopt each record STILL
  // 'running': listThreads' own demoteStale already requeued anything past
  // the 30-min silence window for free.
  const adopted: AdoptedThread[] = [];
  for (const key of await deps.listStoreKeys().catch(() => [] as string[])) {
    const records = await deps.listThreads(key).catch(() => [] as ThreadRecord[]);
    for (const rec of records) {
      if (rec.status !== 'running') continue;
      const updatedMs = Date.parse(rec.updatedAt);
      adopted.push({
        key,
        id: rec.id,
        runSeq: rec.runSeq,
        afterIso: new Date((Number.isFinite(updatedMs) ? updatedMs : deps.now()) - THREAD_HARVEST_LOOKBACK_MS).toISOString(),
      });
    }
  }
  if (adopted.length === 0) return;
  logger.info('thread-reaper', `adopted ${adopted.length} running thread record(s) orphaned by a prior instance`, {});

  // Same give-up shape as the dispatch pass: the poll window plus a grace of
  // ten more polls for stragglers, then the detached watcher takes over.
  const giveUpAt = deps.now() + maxWaitMs + 10 * pollMs;
  let remaining = adopted;
  while (remaining.length > 0) {
    const waiting: AdoptedThread[] = [];
    for (const a of remaining) {
      try {
        const outcome = await evaluateOrphanedThread(a, deps);
        if (outcome === 'waiting') waiting.push(a);
      } catch (err) {
        logger.warn('thread-reaper', 'evaluation failed', { key: a.key, id: a.id, error: String(err) });
        waiting.push(a);
      }
    }
    remaining = waiting;
    if (remaining.length === 0) break;
    if (deps.now() >= giveUpAt) {
      logger.warn('thread-reaper', `handing ${remaining.length} still-running orphaned thread(s) to the detached watcher`, {});
      armOrphanedThreadWatcher(remaining, deps, watcherPollMs);
      break;
    }
    await deps.sleep(pollMs);
  }
}
