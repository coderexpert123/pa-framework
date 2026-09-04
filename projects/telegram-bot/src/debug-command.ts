/**
 * AI-190 (2026-09-03): `/debug` — operator-only interception that opens a
 * debugging task with pa-support instead of dispatching a worker in the asking
 * topic. The target message is either the replied-to message or the message
 * sent right before /debug in the same topic. Its ref-ID (the `_Ref: s-…_`
 * trailer every system message carries) is the debug handle; without one the
 * task carries the target's text + message id + thread context as the fallback
 * handle. Pure parsing/building lives here; processUpdate (main.ts) owns the
 * wiring — registration in commands.ts alone routes nothing.
 */

export const DEBUG_PATTERN = /^\/debug(?:@\w+)?$/i;

/**
 * The pa-support topic key is configuration, not code: config.yaml
 * `topics.support`, read via pa's loadSupportTopic(). When it is unset or
 * malformed, /debug is unavailable and reports a configuration error — there
 * is no frozen fallback topic.
 */

/** "<chatId>_<threadId>" → parts, or null when malformed. */
export function parseSupportTopicKey(key: string): { chatId: number; threadId: number } | null {
  const m = /^(-?\d+)_(\d+)$/.exec(key.trim());
  if (!m) return null;
  const chatId = Number(m[1]);
  const threadId = Number(m[2]);
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) return null;
  return { chatId, threadId };
}

/**
 * The ref-ID trailer extractor. Deliberate mirror of the /new seeding regex
 * (main.ts): `_Ref: s-…_` is the canonical MarkdownV2-rendered form, `Ref: …`
 * the plain-text fallback; both are accepted so an edit or quote of the
 * original still resolves.
 */
const REF_TRAILER_RE = /(?:_Ref:\s*|\bRef:\s*)([a-z0-9-]+)(?:_|\b)/i;

/** The target message's ref-ID, or null when its text carries no trailer. */
export function extractRefId(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = REF_TRAILER_RE.exec(text);
  return m ? m[1] : null;
}

/** The message /debug points at: the reply-to when present, else (fallback)
 *  the newest turn that is not the /debug message itself (it is already
 *  archived by the time the interception runs). */
export interface DebugTarget {
  text?: string;
  messageId?: number;
}

export function resolveDebugTarget(
  replyTo: { text?: string; caption?: string; message_id?: number } | undefined,
  turns: ReadonlyArray<{ role: string; text: string; message_id?: number }>,
  currentMessageId: number | undefined
): DebugTarget {
  if (replyTo && (typeof replyTo.message_id === 'number' || replyTo.text || replyTo.caption)) {
    return {
      text: replyTo.text ?? replyTo.caption,
      messageId: typeof replyTo.message_id === 'number' ? replyTo.message_id : undefined,
    };
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (currentMessageId !== undefined && turn.message_id === currentMessageId) continue;
    return { text: turn.text, messageId: turn.message_id };
  }
  return {};
}

/** Single-line, whitespace-collapsed excerpt for the task prompt. */
function excerpt(text: string | undefined, max: number): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

const PROMPT_HARD_CAP = 500; // pa validateTaskPrompt's cap

/** The queued task's frozen shape: ref-ID (when present) is the debug handle;
 *  otherwise text + message id + thread context identify the target. The tail
 *  instruction is AI-190's executor contract: fix autonomously under the gate
 *  disciplines, or ask via the question action when no choosing principle
 *  separates the viable solutions. */
export function buildDebugTaskInput(args: {
  target: DebugTarget;
  refId: string | null;
  chatId: number;
  threadId: number;
}): { title: string; prompt: string } {
  const { target, refId, threadId } = args;
  const handle = refId ?? `msg ${target.messageId ?? 'unknown'} in thread ${threadId}`;
  const title = `Debug: ${handle}`.slice(0, 80);
  const head = refId
    ? `Operator flagged a problem with message ${target.messageId ?? 'unknown'} (ref ${refId}). Fetch the trail with: pa ref ${refId}.`
    : `Operator flagged a problem with message ${target.messageId ?? 'unknown'} in thread ${threadId}; it carried no ref-ID trailer.`;
  const quote = target.text ? ` Target text: "${excerpt(target.text, 180)}".` : '';
  const tail =
    ' Diagnose the problem, then fix autonomously under the usual gate disciplines. If several viable solutions exist with no clear choosing principle, ask via the question action instead of guessing.';
  const prompt = `${head}${quote}${tail}`.slice(0, PROMPT_HARD_CAP);
  return { title, prompt };
}

/** Result of the interception: the local reply text (caller ref-IDs it) and
 *  whether a task actually landed. */
export interface DebugCommandResult {
  response: string;
  filed: boolean;
}

/** AppendTask's shape, injected so tests never touch the real store and this
 *  module never imports pa/dist at runtime (main.ts passes the real fn). */
export type AppendTaskFn = (
  chatId: number,
  threadId: number,
  input: { title: string; prompt: string; createdBy: string }
) => Promise<{ id: string; deduped: boolean }>;

export async function handleDebugCommand(args: {
  userId?: string;
  operatorId: string | undefined;
  target: DebugTarget;
  chatId: number;
  threadId: number;
  support: { chatId: number; threadId: number };
  appendTaskFn: AppendTaskFn;
}): Promise<DebugCommandResult> {
  // Fail closed: without PA_OPERATOR_USER_ID configured nobody may file.
  if (!args.operatorId) {
    return { response: '🐞 /debug needs PA_OPERATOR_USER_ID configured — nothing filed.', filed: false };
  }
  if (args.userId !== args.operatorId) {
    return { response: '🐞 /debug is operator-only — nothing filed.', filed: false };
  }
  if (!args.target.messageId && !args.target.text) {
    return { response: '🐞 Nothing to debug yet — reply to the message, or send /debug right after it.', filed: false };
  }

  const refId = extractRefId(args.target.text);
  const { title, prompt } = buildDebugTaskInput({
    target: args.target,
    refId,
    chatId: args.chatId,
    threadId: args.threadId,
  });
  let filed: { id: string; deduped: boolean };
  try {
    filed = await args.appendTaskFn(args.support.chatId, args.support.threadId, {
      title,
      prompt,
      createdBy: 'operator',
    });
  } catch (err) {
    return {
      response: `🐞 Failed to file the debug task: ${(err as Error).message}`,
      filed: false,
    };
  }
  const handle = refId ?? `message ${args.target.messageId ?? 'unknown'}`;
  return {
    response: `🐞 Debug task ${filed.id} filed to pa-support for ${handle}${filed.deduped ? ' (already queued)' : ''}.`,
    filed: true,
  };
}
