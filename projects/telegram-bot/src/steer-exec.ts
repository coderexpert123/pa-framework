/**
 * steer-exec.ts — the /steer mechanics, extracted (router-as-orchestrator
 * WP-4, 2026-09-19, spec §4.2 "unified development — no fork").
 *
 * `executeSteer` IS the inline /steer block that used to live in
 * runPollLoop's batch loop (mark + PID-captured kill + queued-entry drain +
 * M2 no-source recovery + E6/E7 own-audio prefetch + steerContext handoff),
 * moved verbatim so both call sites run the SAME code:
 *   - the /steer handler (runPollLoop) — passes the steer message; the fold
 *     stays DEFERRED via the side map, materialized by the enqueue
 *     normalizer exactly as before;
 *   - the router-steer call site (processUpdate, steer surface LIVE only,
 *     spec §4.2/decision 24) — passes no message; the current turn's text is
 *     the steer prompt and the caller folds the returned context inline
 *     (`materializeSteerPrompt`) so the CURRENT turn re-dispatches as the
 *     fresh continuation.
 *
 * Kill discipline is worker-stop's: PID-captured process-tree kills only,
 * never an image-name sweep. The §4.3 double-fire guard (router steer vs the
 * same turn's PA_META steer_thread) lives here too as a per-turn in-process
 * map — crash loss degrades to handleSteer's own fresh-read re-validation
 * (risk R7, accepted).
 */
import { sendMessage } from './telegram.js';
import { appendRefIdAndLog } from './ref-id.js';
import { stopTopicWorkers, markTopicStopped } from './worker-stop.js';
import { drainQueuedEntries, snapshotDrained, addHeldEntry, absorbHeldEntries, type SteerFoldContext, type AudioMediaIdentity } from './topic-queue.js';
import { absorbHeldDispatchRecords, listPendingDispatches, removePendingDispatch, pendingDispatchKey } from './pending-dispatches.js';
import { startPrefetch, lookupPrefetch, lookupPrefetchDescriptor, type VoicePrefetchDescriptor } from './voice-prefetch.js';
import { extractAudioAttachment, isBarePlaceholderUserText, type AudioAttachmentKind, type VoiceResult, type VoiceDeps } from './voice.js';
import { describeForwardOrigin } from './logic.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import type { TelegramUpdate } from './types.js';

export interface ExecuteSteerArgs {
  topicKey: string;
  chatId: number;
  threadId: number;
  /** The steering update's id — scopes the stop marker (dispatches OLDER than
   *  this are aborted/muted; this update's own dispatch is not). */
  updateId: number;
  /** Reply target for the "nothing was running" notice. */
  messageId?: number;
  /** The correction text (/steer prompt arg; the router path passes the
   *  current turn's text). A bare /steer has none — the drain IS the prompt. */
  steerPrompt?: string;
  /** The steer message itself (/steer path only): a text-only steer has its
   *  text rewritten to the combined fold; its own audio starts an E6/E7
   *  prefetch. The router path passes none. */
  msg?: TelegramUpdate['message'];
  /** runPollLoop's in-flight set — the detached kill and recovery promises
   *  are tracked there. The router path omits it: processUpdate already runs
   *  under the turn's own tracked promise. */
  inFlight?: Set<Promise<unknown>>;
  /** /steer path only: the per-batch side map the enqueue normalizer reads
   *  to attach the fold to the queue entry. */
  steerContexts?: Map<number, SteerFoldContext>;
  /** Transcription deps for the E6/E7 own-audio prefetch (same shape the
   *  stop block builds: repoRoot/env/transcription/threadId). */
  prefetchDeps: VoiceDeps;
  token: string;
  /** Test seam — defaults to the real PID-captured stopTopicWorkers. */
  stopTopicWorkersFn?: (chatId: number, threadId: number) => Promise<number>;
  /** Test seam. */
  sendMessageFn?: typeof sendMessage;
}

export interface ExecuteSteerResult {
  /** The fold handoff: /steer stores it in the side map; the router path
   *  materializes it inline via materializeSteerPrompt. */
  steerContext: SteerFoldContext;
  /** True when the drained entries or the steer message carry voice — the
   *  fold must go through transcript materialization, not text concat. */
  hasVoice: boolean;
}

/**
 * The /steer mechanics, byte-equivalent to the former inline block:
 * mark → detached PID-captured kill ("Nothing was running" notice on 0) →
 * drainQueuedEntries(topicKey, 'steer') → detached M2 no-source recovery →
 * E6/E7 own-audio prefetch → steerContext build → (/steer path) message text
 * rewrite + side-map handoff. Everything before the first await runs
 * synchronously, exactly like the old batch-loop pass.
 */
export async function executeSteer(args: ExecuteSteerArgs): Promise<ExecuteSteerResult> {
  const { topicKey, chatId, threadId, updateId, steerPrompt, msg, inFlight, steerContexts, prefetchDeps, token } = args;
  const doStop = args.stopTopicWorkersFn ?? stopTopicWorkers;
  const doSend = args.sendMessageFn ?? sendMessage;
  // Mark BEFORE killing: a fast-dying worker's error path could otherwise
  // race past the consume check before the marker exists (AI-092).
  markTopicStopped(topicKey, 'steer', updateId);
  // Detached, tracked in `inFlight` (2026-09-17): the batch loop / turn must
  // not block on the kill round-trip.
  const killP: Promise<void> = (async () => {
    const killed = await doStop(chatId, threadId);
    if (killed === 0) {
      // Steer with nothing running: the prompt below dispatches normally.
      await doSend(token, chatId, appendRefIdAndLog('Nothing was running — dispatching your prompt as a new message.', { kind: 'system', chatId, threadId }), args.messageId, threadId);
    }
  })()
    .catch((err) => logger.warn('worker-stop', `stop/steer failed: ${(err as Error).message}`))
    .finally(() => { if (inFlight) inFlight.delete(killP); });
  if (inFlight) inFlight.add(killP);
  // /steer handler: drain queued entries and store steerContext for
  // materialization in the normalizer. Held entries are absorbed at
  // normalizer time (A7), not iteration time.
  const drainedEntries = drainQueuedEntries(topicKey, 'steer');
  const drained = snapshotDrained(drainedEntries);
  // M2 (fix-wave): no-source recovery for drained entries whose voice attach
  // never landed. In order: (a) the durable record's SETTLED transcript, (b)
  // the prefetch map's own promise + descriptor, (c) the entry's placeholder
  // text, warned. Detached: a hold that lands after the fold's absorb is
  // picked up by the topic's NEXT dispatch instead (still delivered — never
  // dropped).
  const steerRecoveryP: Promise<void> = (async () => {
    for (const entry of drainedEntries) {
      if (entry.voice || entry.isCommand) continue;
      const rec = (await listPendingDispatches().catch(() => []))
        .find(r => r.chatId === chatId && r.threadId === threadId && r.updateId === entry.updateId);
      if (rec?.userTextSettled) {
        // (a) — recovered from the settled record WITH updateId, so the
        // seam dedup (M1 rule 1) covers it against the durable half.
        addHeldEntry(topicKey, { text: rec.userText, updateId: entry.updateId });
        logger.warn('steer-fold', 'drained entry lost its voice attach — recovered settled transcript from its pending-dispatch record', { topicKey, updateId: entry.updateId });
        continue;
      }
      const descriptor = lookupPrefetchDescriptor(topicKey, entry.updateId);
      const promise = descriptor ? lookupPrefetch(topicKey, entry.updateId) : undefined;
      if (descriptor && promise) {
        // (b) — held as a promise item with updateId; absorbHeldEntries
        // formats it with the SAME descriptor, byte-identical to
        // userTextFromVoiceResult(await promise, descriptor).
        addHeldEntry(topicKey, { promise, descriptor, updateId: entry.updateId });
        logger.warn('steer-fold', 'drained entry lost its voice attach — recovered from prefetch map', { topicKey, updateId: entry.updateId });
        continue;
      }
      // (c) — nothing better exists. Gated on the placeholder shape so a
      // drained plain-TEXT entry is not held here (it would fold twice).
      if (isBarePlaceholderUserText(entry.text)) {
        addHeldEntry(topicKey, { text: entry.text, updateId: entry.updateId });
        logger.warn('steer-fold', 'drained entry had no transcript source — held instead', { topicKey, updateId: entry.updateId });
      }
    }
  })()
    .catch((err) => logger.warn('steer-fold', `drain recovery failed: ${(err as Error).message}`))
    .finally(() => { if (inFlight) inFlight.delete(steerRecoveryP); });
  if (inFlight) inFlight.add(steerRecoveryP);
  // E6/E7: /steer message itself has audio — start prefetch (router path has
  // no message; this block is skipped there).
  const steerAudio = msg ? extractAudioAttachment(msg) : undefined;
  let steerVoice: { promise: Promise<VoiceResult>; descriptor: VoicePrefetchDescriptor } | undefined = undefined;
  if (msg && steerAudio) {
    const steerDescriptor: VoicePrefetchDescriptor = {
      kind: steerAudio.kind,
      caption: msg.caption,
      forwardedFrom: describeForwardOrigin(msg),
      messageDate: new Date(msg.date * 1000).toISOString(),
    };
    startPrefetch(topicKey, updateId, token, chatId, steerAudio.media, prefetchDeps, steerAudio.kind, steerDescriptor);
    const prefetch = lookupPrefetch(topicKey, updateId);
    if (prefetch) {
      steerVoice = { promise: prefetch, descriptor: steerDescriptor };
    }
  }
  // Store steerContext for the fold. The /steer path's enqueue block attaches
  // it after registerQueuedUpdate returns (side map); the router path's
  // caller materializes it inline.
  const steerContext = { drainedEntries, drained, steerPrompt };
  // For text-only steer (no audio anywhere), use the old combined-text path.
  // For voice steer (drainedEntries has voice OR steerVoice is set), store
  // steerContext and set just the prompt.
  const hasVoiceInDrain = drainedEntries.some(e => e.voice !== undefined);
  const hasVoice = hasVoiceInDrain || steerVoice !== undefined;
  if (msg && steerContexts) {
    if (!hasVoice) {
      // Text-only steer: combine drained texts + prompt immediately.
      const drainedTexts = drainedEntries.map(e => e.text).filter(t => t !== '');
      const parts = steerPrompt ? [...drainedTexts, steerPrompt] : drainedTexts;
      msg.text = parts.join('\n\n');
    } else {
      // Voice steer: store steerContext and set just the prompt. The
      // normalizer materializes the full prompt with transcripts (including
      // held entries). A BARE /steer keeps its original text (AI-208): the
      // fold replaces update.message.text with the materialized prompt before
      // dispatch.
      msg.text = steerPrompt ?? msg.text;
    }
    steerContexts.set(updateId, steerContext);
  }
  return { steerContext, hasVoice };
}

/**
 * The router-steer fold (§4.2): held absorb + durable-held absorb + drained
 * transcripts + the current turn's text, joined exactly like the normalizer's
 * inline fold (minus the own-transcript leg — the router path's turn has no
 * voice queue entry; its own transcript is already its text). Voice-bearing
 * drained entries come back as foldedVoice so the caller can set
 * `__foldedVoice` for the attachment stage. Consumes the drained records at
 * proven delivery (M1 rule 3).
 */
export interface SteerPromptMaterialization {
  text: string;
  foldedVoice: Array<{ text: string; media: AudioMediaIdentity; kind: AudioAttachmentKind; messageId?: number }>;
}

export async function materializeSteerPrompt(
  ctx: SteerFoldContext,
  topicKey: string,
  chatId: number,
  threadId: number,
): Promise<SteerPromptMaterialization> {
  const texts: string[] = [];
  // A7: absorb held entries first — they are the OLDEST context.
  const heldTexts = await absorbHeldEntries(topicKey);
  texts.push(...heldTexts.map(h => h.text));
  // M1 rule 1/2: records already covered by ctx.drained are consumed WITHOUT
  // emitting — each transcript folds exactly once.
  const coveredIds = new Set(ctx.drained.map(d => d.updateId));
  const durableHeldTexts = await absorbHeldDispatchRecords(chatId, threadId, coveredIds);
  texts.push(...durableHeldTexts);
  const allPending = await listPendingDispatches().catch(() => []);
  const foldedVoice: SteerPromptMaterialization['foldedVoice'] = [];
  // Drained entries in arrival order; snapshots format success AND rejection.
  for (const d of ctx.drained) {
    const text = await d.textPromise;
    const origEntry = ctx.drainedEntries.find(e => e.updateId === d.updateId);
    if (origEntry?.voice) {
      const pendingRec = allPending.find(p => p.chatId === chatId && p.threadId === threadId && p.updateId === d.updateId);
      foldedVoice.push({
        text,
        media: origEntry.voice.media,
        kind: origEntry.voice.kind,
        ...(pendingRec?.messageId !== undefined ? { messageId: pendingRec.messageId } : {}),
      });
    }
    texts.push(text);
  }
  if (ctx.steerPrompt !== undefined && ctx.steerPrompt.trim().length > 0) {
    texts.push(ctx.steerPrompt);
  }
  // M1 rule 3 — consume at proven delivery: the drained transcripts reached
  // THIS prompt, so their records must not be re-absorbed by the next
  // dispatch. Best-effort.
  for (const d of ctx.drained) {
    removePendingDispatch(pendingDispatchKey(chatId, threadId, d.updateId)).catch(() => {});
  }
  return { text: texts.filter(t => t.trim().length > 0).join('\n\n'), foldedVoice };
}

// --- §4.3 double-fire guard (router steer vs same-turn PA_META steer) -------

/** Frozen §4.3 footer — a same-turn steer_thread the router already fired is
 *  dropped from the route-application loop with exactly this text. */
export const STEER_ALREADY_ROUTED_FOOTER = '\n\n_(steer already applied by routing)_';

/** In-memory, per-turn: topicKey+updateId → the thread ids the router steered
 *  for that turn. Crash loss degrades to handleSteer's own fresh-read
 *  re-validation (risk R7, accepted). Entries are pruned on write and
 *  consumed once on read (per-turn lifetime). */
const ROUTER_STEER_GUARD_TTL_MS = 5 * 60 * 1000;
const routerSteeredThreads = new Map<string, { at: number; threadIds: Set<string> }>();

const routerSteerGuardKey = (topicKey: string, updateId: number): string => `${topicKey}:${updateId}`;

/** Written by the router-steer path (§4.2) BEFORE dispatch, with the thread
 *  ids the router's steer targeted (the FYI anchor — §4.2's in-flight
 *  context). */
export function markRouterSteered(topicKey: string, updateId: number, threadIds: string[]): void {
  const now = Date.now();
  for (const [k, v] of routerSteeredThreads) {
    if (now - v.at > ROUTER_STEER_GUARD_TTL_MS) routerSteeredThreads.delete(k);
  }
  routerSteeredThreads.set(routerSteerGuardKey(topicKey, updateId), { at: now, threadIds: new Set(threadIds) });
}

/** Read by the route-application loop (§4.3): the SAME turn's steer_thread
 *  actions for these ids are dropped. Read-and-clear — the guard is
 *  per-turn. */
export function takeRouterSteered(topicKey: string, updateId: number): Set<string> | undefined {
  const key = routerSteerGuardKey(topicKey, updateId);
  const entry = routerSteeredThreads.get(key);
  if (!entry) return undefined;
  routerSteeredThreads.delete(key);
  return entry.threadIds;
}

/** Test hook. */
export function _clearRouterSteerGuardForTest(): void {
  routerSteeredThreads.clear();
}
