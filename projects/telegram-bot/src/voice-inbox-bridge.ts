/**
 * Voice-inbox route bridge (AI-201) — the bot-side half of the cross-process
 * channel shared with projects/voice-inbox:
 *
 *   ~/.pa/voice-inbox/route-queue.jsonl  — drained once per poll tick; each
 *     line is injected as a system-originated synthetic turn tagged
 *     `__synthetic: 'route'` (message_id: 0 — no anchor), so it flows through
 *     the FULL normal pipeline exactly like a user message.
 *   ~/.pa/voice-inbox/pairing-codes.json — `/pair` appends a one-time
 *     pairing code the app's exchange endpoint consumes.
 *
 * Route queue: two writers (the app's bridge-writer for task creation and
 * the worker-side route script for decisions) append one JSON object per
 * line, fields in key order q_id, ts, task_id, tenant_id, chat_id, thread_id,
 * text, ref_id, under a proper-lockfile mutex. This drain is the single
 * consumer: read all lines, inject each, then rewrite the file without the
 * consumed lines — under the SAME lock the writers take, so an append landing
 * mid-drain can never be clobbered. A crash between inject and rewrite
 * re-injects on restart (visible duplicate; the topic's /stop is the hard
 * stop) — accepted, so an injection throw deliberately leaves the file
 * untouched rather than partially consumed.
 *
 * Pairing: `/pair` (allowed chats only) mints an 8-char code from the
 * unambiguous charset and writes the canonical pairing-codes.json entry —
 * the same write projects/voice-inbox/scripts/mint_pairing.mjs performs
 * (bare JSON array of {code, telegram_user_id, telegram_chat_id, first_name,
 * created_at, expires_at}; the shape is pinned by the app's identity.ts and
 * its exchangePairingCode is the only consumer). A code is identity
 * plumbing, not a secret: single-use, short TTL, sha256-hashed at rest once
 * exchanged.
 *
 * main.ts owns all wiring (services seam + poll-loop call + the /pair
 * intercept); this module holds none. Latency contract for the drain: one
 * poll tick.
 */

import { parse as parseYaml } from 'yaml';
import lockfile from 'proper-lockfile';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { paHome } from '../../../pa/dist/src/paths.js';
import type { TelegramUpdate } from './types.js';

/** `/pair` bare — no arguments; the dev/emergency mint script is the
 *  argument-taking path. Known to isKnownCommand so the unknown-command
 *  guard (which runs earlier) does not eat it. */
export const PAIR_PATTERN = /^\/pair\s*$/;

// Must match the app identity module's charset/length — the operator types
// this code, so no 0/O/1/I/L.
const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 8-char pairing code; rejection-samples bytes ≥ 248 so 256 % 31 skew
 *  cannot bias the charset (same mint the reference writer uses). */
function mintPairingCode(): string {
  let out = '';
  while (out.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(4)) {
      if (out.length >= PAIRING_CODE_LENGTH) break;
      if (byte < 248) out += PAIRING_CODE_CHARSET[byte % PAIRING_CODE_CHARSET.length];
    }
  }
  return out;
}

/** pairing TTL from the `voice_inbox.pairing_ttl_minutes` config key,
 *  defaulting to 10 (the app's default) when the block/key is missing,
 *  unparsable, or not a positive integer. */
function pairingTtlMinutes(configPath?: string): number {
  try {
    const raw = readFileSync(configPath ?? join(paHome(), 'config.yaml'), 'utf8');
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    const block = parsed && typeof parsed === 'object' ? parsed['voice_inbox'] : undefined;
    const n = block && typeof block === 'object' ? Number((block as Record<string, unknown>)['pairing_ttl_minutes']) : NaN;
    return Number.isInteger(n) && n >= 1 ? n : 10;
  } catch {
    return 10;
  }
}

export interface PairCommandInput {
  chatId: number;
  userId: number;
  firstName: string | null;
  allowedChatIds: ReadonlySet<number>;
  /** Injectable clock (ms epoch) for tests; defaults to now. */
  now?: () => number;
  /** Injectable pairing-codes.json path for tests; defaults under PA_HOME. */
  pairingPath?: string;
  /** Injectable config.yaml path for tests. */
  configPath?: string;
}

/**
 * Handle `/pair`: mint a one-time pairing code and append it to
 * pairing-codes.json (read-modify-rewrite of the bare JSON array; a torn or
 * missing file starts a fresh array rather than failing the mint). Returns
 * the reply text — main.ts sends it ref-ID'd with kind 'system'.
 */
export function handlePairCommand(input: PairCommandInput): string {
  const { chatId, userId, firstName, allowedChatIds } = input;
  // Belt-and-braces: processUpdate already drops non-allowed chats, but the
  // pairing flow is specified allowed-chats-only, so the guard lives with the
  // mint rather than trusting the caller.
  if (!allowedChatIds.has(chatId)) {
    logger.warn('voice-inbox', 'pairing refused: chat is not an allowed chat', { chatId });
    return 'Pairing is only available from this assistant’s allowed chats.';
  }

  const now = input.now ?? Date.now;
  const ttlMinutes = pairingTtlMinutes(input.configPath);
  const entry = {
    code: mintPairingCode(),
    telegram_user_id: userId,
    telegram_chat_id: chatId,
    first_name: firstName ?? null,
    // created_at backdated 1s like the reference writer, so an operator who
    // starts typing immediately is never told the code is not yet valid.
    created_at: new Date(now() - 1000).toISOString(),
    expires_at: new Date(now() + ttlMinutes * 60_000).toISOString(),
  };

  const path = input.pairingPath ?? join(paHome(), 'voice-inbox', 'pairing-codes.json');
  let pending: unknown[] = [];
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed)) pending = parsed;
    } catch {
      pending = []; // torn file: start a fresh array rather than fail the mint
    }
  }
  pending.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  // pid + Date.now tmp suffix: two /pair handlers can run concurrently in
  // this long-lived process (different topic locks), unlike the one-shot
  // reference script whose pid-only suffix is unique per invocation.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);

  logger.info('voice-inbox', 'minted a pairing code for the voice-inbox app', { chatId, ttlMinutes });
  return `Pairing code: ${entry.code} (expires in ${ttlMinutes} minutes). Enter it in the Voice Inbox app to connect.`;
}

export interface RouteQueueEntry {
  q_id: string;
  ts: string;
  task_id: string;
  tenant_id: string;
  chat_id: number;
  thread_id: number;
  text: string;
  ref_id: string;
}

export interface DrainVoiceInboxRoutesOpts {
  /** Injection seam — main.ts passes its synthetic-queue pusher. */
  injectFn: (u: TelegramUpdate) => void;
  /** Synthetic update-id mint — shared with the other injectors so ids stay
   *  unique across the injection queue (main.ts passes nextSyntheticUpdateId). */
  nextId: () => number;
  /** Injectable queue path for tests; defaults under PA_HOME. */
  queuePath?: string;
}

/**
 * Drain the voice-inbox route queue: one poll tick, inject every entry as a
 * `__synthetic: 'route'` synthetic turn, rewrite the file without the
 * consumed lines. Returns the number of entries injected. Absent file or an
 * unavailable lock = a no-op tick (never throws into the poll loop; an
 * injection throw DOES propagate — the caller's catch logs it and the file
 * stays intact for re-injection, the accepted crash window).
 */
export async function drainVoiceInboxRoutes(opts: DrainVoiceInboxRoutesOpts): Promise<number> {
  const queuePath = opts.queuePath ?? join(paHome(), 'voice-inbox', 'route-queue.jsonl');
  if (!existsSync(queuePath)) return 0;

  // Same lock options the writers take: an append racing the drain blocks on
  // this lock (or vice versa) instead of being clobbered by the rewrite.
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(queuePath, {
      stale: 5_000,
      retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
    });
  } catch (err) {
    logger.warn('voice-inbox', `route queue locked, skipping this tick: ${(err as Error).message}`, { queuePath });
    return 0;
  }

  try {
    const lines = readFileSync(queuePath, 'utf8').split('\n');
    const consumed = new Set<number>();
    let injected = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.warn('voice-inbox', 'dropping an unparsable route-queue line (torn append)', { queuePath });
        consumed.add(i);
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') {
        logger.warn('voice-inbox', 'dropping a route-queue line that is not a JSON object', { queuePath });
        consumed.add(i);
        continue;
      }
      const entry = parsed as RouteQueueEntry;
      if (
        typeof entry.chat_id !== 'number' || !Number.isFinite(entry.chat_id) ||
        typeof entry.text !== 'string' || entry.text === ''
      ) {
        logger.warn('voice-inbox', 'dropping a route-queue line with no usable target/text', { queuePath, q_id: String(entry.q_id) });
        consumed.add(i);
        continue;
      }
      // Inject verbatim — the entry's text IS the injection text built by the
      // writer; no prefix. message_id stays 0: no user message to anchor.
      // A foreign chat_id is still consumed: processUpdate's allowed-chat gate
      // drops the turn, and keeping the line would re-inject it every tick.
      const threadId = typeof entry.thread_id === 'number' && entry.thread_id > 0 ? entry.thread_id : 0;
      opts.injectFn({
        update_id: opts.nextId(),
        message: {
          message_id: 0,
          from: { id: 0, first_name: 'PA system' },
          chat: { id: entry.chat_id, type: threadId ? 'supergroup' : 'private' },
          date: Math.floor(Date.now() / 1000),
          text: entry.text,
          ...(threadId ? { message_thread_id: threadId } : {}),
        },
        __synthetic: 'route',
      } as TelegramUpdate);
      consumed.add(i);
      injected += 1;
    }

    if (consumed.size > 0) {
      const remaining = lines.filter((_, i) => !consumed.has(i)).join('\n');
      const tmp = `${queuePath}.${process.pid}.tmp`;
      writeFileSync(tmp, remaining, 'utf8');
      renameSync(tmp, queuePath);
    }
    if (injected > 0) {
      logger.info('voice-inbox', `drained ${injected} voice-inbox route entr${injected === 1 ? 'y' : 'ies'} into the injection queue`, { queuePath });
    }
    return injected;
  } finally {
    try { await release(); } catch { /* lock already released/stolen */ }
  }
}
