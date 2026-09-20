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
 * Transcription hold (2026-09-16): with `taskStatesFn` wired, a plain route
 * line (no `kind`) whose task is still `transcribing` is held — neither
 * injected nor consumed — until the bot's transcription drain writes the
 * transcript, and a line whose task is `transcribe_failed` is consumed
 * without injection. Unknown tasks and a failing lookup inject as before.
 *
 * Typed routing gate (2026-09-17): with `typedRouteFn` also wired, an INBOX
 * entry (text starting VOICE_INBOX_ENTRY_PREFIX) whose task is `received` or
 * `routed` asks the gate: `hold` keeps it (not injected, not consumed),
 * `drop` consumes it without injection (the task was already placed), and
 * `inject` — also on a throwing gate — injects as before. The destination
 * entry route_task.py appends for the same task starts `[Voice task ` and
 * never reaches the gate.
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
import { stopWorkerByResource } from './worker-stop.js';
import { cancelOneThread } from './topic-threads.js';
import { listPendingDispatches, removePendingDispatch, pendingDispatchKey, type PendingDispatch } from './pending-dispatches.js';

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
  kind?: string;
  worker_resource?: string;
  worker_dispatch_id?: string;
  steer_mode?: string;
  steer_conversation?: string;
}

/** Task ids named by an injection text. Both inbox texts open
 *  `[Voice inbox task vi-…]` and the target text `[Voice task vi-… routed …]`;
 *  a batched prompt can name several. */
export const VOICE_INBOX_TASK_RE = /\[Voice(?: inbox)? task (vi-[0-9a-f]{12})(?=[\]\s])/g;

/** De-duplicated task ids named by an injection text, in first-seen order. */
export function extractVoiceInboxTaskIds(text: string): string[] {
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

export interface HandleRouteCancelDeps {
  stop?: (resource: string, deps?: unknown, expectedDispatchId?: string) => Promise<number>;
  cancelThread?: (key: string, id: string) => Promise<boolean>;
  listPending?: () => Promise<PendingDispatch[]>;
  removePending?: (key: string) => Promise<void>;
}

/**
 * Act on a `kind: 'cancel'` route-queue entry (§4 FROZEN route-queue contract
 * v2): kill exactly the named worker-pids resource, flip exactly the one
 * thread record the resource names (never the topic-wide flip that cancels
 * every running/queued record in the topic — that blast radius is a known
 * separate issue this per-task path must not have), and purge every
 * pending-dispatch record naming this task (a live incident had two). Every
 * step is individually try/caught: a failure in one never prevents the
 * others, and this function never throws into the drain.
 */
export async function handleRouteCancel(
  entry: RouteQueueEntry,
  deps: HandleRouteCancelDeps = {},
): Promise<void> {
  const stop = deps.stop ?? stopWorkerByResource;
  const cancelThread = deps.cancelThread ?? cancelOneThread;
  const listPending = deps.listPending ?? listPendingDispatches;
  const removePending = deps.removePending ?? removePendingDispatch;

  const taskId = entry.task_id;
  const resource = (entry.worker_resource ?? '').trim();
  let killed = 0;

  if (resource === '') {
    logger.info('voice-inbox', 'cancel entry carries no worker resource; ledger flip only', { task_id: taskId });
  } else {
    // WP-5 K14/D12. A bare topic resource is reused by every message in that
    // topic, so a cancel with no dispatch id to prove it against the one it
    // meant is unsafe to act on — the entry there now may belong to someone
    // else. A thread resource is already one-per-dispatch, so it keeps
    // killing by resource alone even with no id (backward compatible).
    const dispatchId = (entry.worker_dispatch_id ?? '').trim();
    const isThreadResource = /^topic-(-?\d+)_(\d+)-th(\d+)$/.test(resource);
    if (!isThreadResource && dispatchId === '') {
      logger.warn('voice-inbox', 'cancel names a bare topic resource with no dispatch id; not killing (it may no longer be ours)', { task_id: taskId, resource });
    } else {
      try {
        killed = await stop(resource, undefined, dispatchId || undefined);
      } catch (err) {
        logger.warn('voice-inbox', `stopWorkerByResource failed: ${(err as Error).message}`, { task_id: taskId, resource });
      }
      const threadMatch = /^topic-(-?\d+)_(\d+)-th(\d+)$/.exec(resource);
      if (threadMatch) {
        try {
          await cancelThread(`${threadMatch[1]}_${threadMatch[2]}`, `t-${threadMatch[3]}`);
        } catch (err) {
          logger.warn('voice-inbox', `cancelOneThread failed: ${(err as Error).message}`, { task_id: taskId, resource });
        }
      }
    }
  }

  let purged = 0;
  try {
    const pending = await listPending();
    for (const r of pending) {
      if (extractVoiceInboxTaskIds(r.userText).includes(taskId)) {
        await removePending(pendingDispatchKey(r.chatId, r.threadId, r.updateId));
        purged++;
      }
    }
  } catch (err) {
    logger.warn('voice-inbox', `pending-dispatch purge failed: ${(err as Error).message}`, { task_id: taskId });
  }

  logger.info('voice-inbox', 'cancelled a voice-inbox task', { task_id: taskId, resource, killed, purged, ref_id: entry.ref_id });
}

/** The opening of both inbox injection texts (voice-inbox bridge-writer.ts
 *  buildInboxInjectionText / buildVoiceInboxInjectionText). Only these entries
 *  reach the typed routing gate. */
export const VOICE_INBOX_ENTRY_PREFIX = '[Voice inbox task ';

/** One info line per held q_id (bounded), not one per tick. */
const HELD_LOG_MAX = 1000;
const heldLogged = new Set<string>();

export interface DrainVoiceInboxRoutesOpts {
  /** Injection seam — main.ts passes its synthetic-queue pusher. */
  injectFn: (u: TelegramUpdate) => void;
  /** Synthetic update-id mint — shared with the other injectors so ids stay
   *  unique across the injection queue (main.ts passes nextSyntheticUpdateId). */
  nextId: () => number;
  /** Injectable queue path for tests; defaults under PA_HOME. */
  queuePath?: string;
  /** Steer a `kind:"steer"` entry into the work it targets (WP-5
   *  voice-inbox-steer.ts, wired in at the composition root — this module
   *  never imports it directly; that edge would close a module cycle
   *  through logic.ts). An ABSENT `steerFn` HOLDS every steer entry until
   *  its deadline and never injects it early — holding is the safe
   *  direction. */
  steerFn?: (entry: RouteQueueEntry) => Promise<{ settled: boolean }>;
  /** Every task id in a steer entry's conversation, for the pre-start fold
   *  (D9) — finds a sibling route line in the same conversation that has not
   *  started yet. */
  conversationTaskIdsFn?: (conversationId: string) => string[];
  /** Framing prepended to a steer's text when it is folded into a sibling
   *  route line that has not started yet. */
  foldPrefix?: string;
  /** True once a held steer entry has passed its retry deadline (D10) and
   *  must be injected as an ordinary turn instead of held any longer. */
  isPastDeadline?: (ts: string | undefined) => boolean;
  /** Transcription hold (2026-09-16): state lookup for the task ids of plain
   *  route entries (main.ts wires pa's voiceInboxRouteHoldStates). `transcribing`
   *  holds the entry, `transcribe_failed` consumes it without injection, any
   *  other or absent state injects. ABSENT fn = no hold (tests, direct callers). */
  taskStatesFn?: (taskIds: string[]) => Map<string, { state: string }>;
  /** Typed routing gate (2026-09-17; main.ts wires pa's typed route drain).
   *  Consulted only with taskStatesFn, only for inbox entries whose task is
   *  `received` or `routed`. ABSENT fn = no gate (inject as before). */
  typedRouteFn?: (taskId: string, state: string) => 'hold' | 'inject' | 'drop';
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

    // --- Parse pass: garbage is dropped and consumed here; everything else,
    // blank lines included, is carried into `entries` for the passes below.
    const entries: Array<RouteQueueEntry | null> = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        entries.push(null); // blank lines are NOT consumed, exactly as today
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.warn('voice-inbox', 'dropping an unparsable route-queue line (torn append)', { queuePath });
        consumed.add(i);
        entries.push(null);
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') {
        logger.warn('voice-inbox', 'dropping a route-queue line that is not a JSON object', { queuePath });
        consumed.add(i);
        entries.push(null);
        continue;
      }
      const entry = parsed as RouteQueueEntry;
      if (
        typeof entry.chat_id !== 'number' || !Number.isFinite(entry.chat_id) ||
        typeof entry.text !== 'string' || entry.text === ''
      ) {
        logger.warn('voice-inbox', 'dropping a route-queue line with no usable target/text', { queuePath, q_id: String(entry.q_id) });
        consumed.add(i);
        entries.push(null);
        continue;
      }
      entries.push(entry);
    }

    // --- Steer pass: settle, fold, hold or (past the deadline) demote a
    // `kind:"steer"` entry to an ordinary route line. Runs BEFORE the
    // injection loop so a fold can still land on a sibling in this same pass.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || entry.kind !== 'steer') continue;
      // (1) steer the running work — thread lane or topic lane
      let settled = false;
      if (opts.steerFn) {
        try { settled = (await opts.steerFn(entry)).settled; }
        catch (err) { logger.warn('voice-inbox', `voice-inbox steer threw: ${(err as Error).message}`, { q_id: String(entry.q_id), task_id: String(entry.task_id) }); }
      }
      if (settled) { consumed.add(i); entries[i] = null; continue; }
      // (2) pre-start fold into a sibling route line not yet injected
      const conv = entry.steer_conversation;
      const siblingIds = conv && opts.conversationTaskIdsFn ? opts.conversationTaskIdsFn(conv) : [];
      let folded = -1;
      if (siblingIds.length > 0) {
        for (let j = entries.length - 1; j >= 0; j--) {
          const other = entries[j];
          if (j === i || !other || other.kind !== undefined) continue;
          if (!siblingIds.includes(String(other.task_id))) continue;
          folded = j;
          break;
        }
      }
      if (folded !== -1) {
        const other = entries[folded] as RouteQueueEntry;
        other.text = `${other.text}\n\n${opts.foldPrefix ?? ''}${entry.text}`;
        consumed.add(i);
        entries[i] = null;
        logger.info('voice-inbox', 'folded a voice-inbox steer into a request that had not started', { q_id: String(entry.q_id), task_id: String(entry.task_id), into: String(other.task_id), steer_outcome: 'folded-before-start' });
        continue;
      }
      // (3) hold for the next tick, or inject once past the deadline
      if (opts.isPastDeadline?.(entry.ts) === true) {
        logger.warn('voice-inbox', 'a voice-inbox steer reached its deadline with nothing to steer; injecting it as a topic turn', { q_id: String(entry.q_id), task_id: String(entry.task_id), steer_outcome: 'injected-after-deadline' });
        delete entry.kind;   // the injection loop treats it as an ordinary route line
      } else {
        entries[i] = null;   // held: not consumed, not injected, retried next tick
      }
    }

    // --- Transcription hold pass (2026-09-16): see the header docblock.
    if (opts.taskStatesFn) {
      const plainIds = [
        ...new Set(
          entries
            .filter((e): e is RouteQueueEntry => e !== null && e.kind === undefined)
            .map((e) => String(e.task_id)),
        ),
      ];
      let states = new Map<string, { state: string }>();
      if (plainIds.length > 0) {
        try {
          states = opts.taskStatesFn(plainIds);
        } catch (err) {
          logger.warn('voice-inbox', `route hold state lookup failed; injecting unheld: ${(err as Error).message}`, { queuePath });
        }
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry || entry.kind !== undefined) continue;
        const taskState = states.get(String(entry.task_id))?.state;
        if (taskState === 'transcribing') {
          const qid = String(entry.q_id);
          if (!heldLogged.has(qid)) {
            if (heldLogged.size >= HELD_LOG_MAX) heldLogged.clear();
            heldLogged.add(qid);
            logger.info('voice-inbox', 'holding a voice task route entry until its transcript lands', { q_id: qid, task_id: String(entry.task_id) });
          }
          entries[i] = null; // held: not consumed, not injected, re-checked next tick
        } else if (taskState === 'transcribe_failed') {
          logger.info('voice-inbox', 'dropped the route entry of a voice task whose transcription failed', { q_id: String(entry.q_id), task_id: String(entry.task_id) });
          consumed.add(i);
          entries[i] = null;
        } else if (
          opts.typedRouteFn &&
          (taskState === 'received' || taskState === 'routed') &&
          entry.text.startsWith(VOICE_INBOX_ENTRY_PREFIX)
        ) {
          let verdict: 'hold' | 'inject' | 'drop' = 'inject';
          try {
            verdict = opts.typedRouteFn(String(entry.task_id), taskState);
          } catch (err) {
            logger.warn('voice-inbox', `typed routing gate threw; injecting: ${(err as Error).message}`, { q_id: String(entry.q_id), task_id: String(entry.task_id) });
          }
          if (verdict === 'hold') {
            const heldKey = `typed:${String(entry.q_id)}`;
            if (!heldLogged.has(heldKey)) {
              if (heldLogged.size >= HELD_LOG_MAX) heldLogged.clear();
              heldLogged.add(heldKey);
              logger.info('voice-inbox', 'holding an inbox route entry while typed routing places its task', { q_id: String(entry.q_id), task_id: String(entry.task_id) });
            }
            entries[i] = null; // held: not consumed, not injected, re-checked next tick
          } else if (verdict === 'drop') {
            logger.info('voice-inbox', 'dropped the inbox route entry of a task that is already routed', { q_id: String(entry.q_id), task_id: String(entry.task_id) });
            consumed.add(i);
            entries[i] = null;
          }
        }
      }
    }

    // --- Injection loop: a settled/folded/held steer is null here and skipped.
    let injected = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      if (entry.kind === 'cancel') {
        await handleRouteCancel(entry);
        consumed.add(i);
        continue;   // a verb entry is acted on, never injected as a turn
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
