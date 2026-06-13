export type RefKind = 'pin' | 'help' | 'branch' | 'lock_busy' | 'failover' | 'system';
export declare function makeRefId(prefix?: string): string;
export declare function appendRefId(text: string, prefix?: string): string;
/**
 * Mints a refId, logs a 'system message sent' entry for queryability via `pa ref`,
 * and returns the message text with the ref appended. Use for bot-system messages
 * (pins, help, branch notifications, failover banners, lock-busy notices) — anything
 * that's not a worker reply (which has its own 'message sent' log call).
 */
export declare function appendRefIdAndLog(text: string, ctx: {
    kind: RefKind;
    chatId: number;
    threadId?: number;
}, prefix?: string): string;
