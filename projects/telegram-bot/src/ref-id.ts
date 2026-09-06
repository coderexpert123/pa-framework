import { randomBytes } from 'crypto';
import { logger } from '../../../pa/dist/src/lib/log.js';

// Wave-2 task-lane kinds (SPEC §5 edge 5, coined by WP-A 2026-09-02): the five
// FYI/notice kinds below, plus 'task-question' for the parked question's
// keyboard message (the spec's five do not cover it; every appendRefIdAndLog
// caller needs a kind, and the question FYI is a tier-1 anchor like the pickup).
export type RefKind = 'pin' | 'help' | 'branch' | 'lock_busy' | 'failover' | 'system' | 'recovered' | 'callback' | 'requeue-deferred'
  | 'task-pickup' | 'task-done' | 'task-retry' | 'task-failed' | 'task-route' | 'task-question'
  // AI-203 orchestrator execution threads: pickup/retry/done/failed FYIs the
  // thread executor posts back into the owning topic.
  | 'thread-spawned' | 'thread-retry' | 'thread-done' | 'thread-failed';

export function makeRefId(prefix: string = 's'): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

export function appendRefId(text: string, prefix: string = 's'): string {
  return `${text.trim()}\n\n_Ref: ${makeRefId(prefix)}_`;
}

/**
 * Mints a refId, logs a 'system message sent' entry for queryability via `pa ref`,
 * and returns the message text with the ref appended. Use for bot-system messages
 * (pins, help, branch notifications, failover banners, lock-busy notices) — anything
 * that's not a worker reply (worker-reply refIds are queryable via the refId field
 * on their conversation-history.jsonl assistant turns, not an app-log entry).
 */
export function appendRefIdAndLog(
  text: string,
  ctx: { kind: RefKind; chatId: number; threadId?: number },
  prefix: string = 's',
): string {
  const refId = makeRefId(prefix);
  logger.info('bot', 'system message sent', {
    refId,
    kind: ctx.kind,
    chatId: ctx.chatId,
    threadId: ctx.threadId,
    textPreview: text.slice(0, 500),
  });
  return `${text.trim()}\n\n_Ref: ${refId}_`;
}
