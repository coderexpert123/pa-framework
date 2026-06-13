import { randomBytes } from 'crypto';
import { logger } from '../../../pa/dist/src/lib/log.js';
export function makeRefId(prefix = 's') {
    return `${prefix}-${randomBytes(2).toString('hex')}`;
}
export function appendRefId(text, prefix = 's') {
    return `${text.trim()}\n\n_Ref: ${makeRefId(prefix)}_`;
}
/**
 * Mints a refId, logs a 'system message sent' entry for queryability via `pa ref`,
 * and returns the message text with the ref appended. Use for bot-system messages
 * (pins, help, branch notifications, failover banners, lock-busy notices) — anything
 * that's not a worker reply (which has its own 'message sent' log call).
 */
export function appendRefIdAndLog(text, ctx, prefix = 's') {
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
