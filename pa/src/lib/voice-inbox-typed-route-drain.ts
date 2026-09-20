/**
 * Voice-inbox typed route drain (2026-09-17) — the bot-process scheduler for
 * TypeSafe typed routing. The telegram bot's route drain calls gate(taskId,
 * state) for each INBOX entry whose task is received or routed; gate is
 * synchronous, never awaits and never throws (the 2026-09-15 catchup lane
 * wedge was an unbounded await on a shared tick). It answers:
 *   inject — today's behaviour: the LLM inbox routing turn runs;
 *   hold   — neither injected nor consumed, re-checked next tick;
 *   drop   — consumed without injection (the task is already routed).
 * With voice_inbox_routing absent/disabled, or PA_VOICE_INBOX_TYPED_ROUTING=0,
 * every entry injects. A received task with TypeSafe configured starts ONE
 * fire-and-forget attempt through the shared action
 * (voice-inbox-typed-route-action.ts), at most TYPED_ROUTE_MAX_CONCURRENT at
 * once. Each attempt frees its DRAIN-SIDE slot at a hard deadline even if its
 * promise never settles. An escalated, failed or timed-out attempt injects on
 * the next gate call; any entry held longer than TYPED_ROUTE_HOLD_MAX_MS
 * injects.
 *
 * Cancel token (2026-09-17, R18): freeing the drain-side slot at the deadline
 * does NOT by itself stop the attempt from still calling route_task.py later
 * — the drain shares a {cancelled} token with each attempt, flips it in the
 * SAME deadline callback, and the action checks it immediately before it
 * would spawn route_task.py. TYPED_ROUTE_ATTEMPT_DEADLINE_MS is DERIVED
 * (TYPED_ROUTE_CLIENT_MAX_MS + WORKER_SCRIPT_TIMEOUT_MS +
 * TYPED_ROUTE_DEADLINE_MARGIN_MS) to be strictly greater than the attempt's
 * own worst case, so by construction the deadline cannot fire while a spawned
 * route_task.py could still be running: it can only fire before the spawn
 * decision, where the cancel-token check catches it. A 'placed' outcome that
 * still arrives after the deadline (the residual risk of a stalled event loop
 * or clock skew, not the client/script budgets) logs
 * typed-route-placed-after-deadline as a tripwire rather than silently
 * discarding it.
 */
import { log } from './log.js';
import { repoRootFromModule } from './git-root.js';
import { voiceInboxLedgerPath } from './voice-inbox-ledger.js';
import { DEFAULT_TYPESAFE_TIMEOUT_MS, TYPESAFE_MAX_ATTEMPTS, isTypeSafeConfigured } from './typesafe-client.js';
import { WORKER_SCRIPT_TIMEOUT_MS } from './voice-inbox-transcribe.js';
import { readVoiceInboxRoutingFileConfig, type VoiceInboxRoutingFileConfig } from './voice-inbox-routing-config.js';
import { logTypedRouteAction, routeVoiceInboxTaskTyped, type TypedRouteOutcome } from './voice-inbox-typed-route-action.js';

const MODULE = 'voice-inbox-typed-route-drain';

export const TYPED_ROUTE_MAX_CONCURRENT = 2;
export const TYPED_ROUTE_HOLD_MAX_MS = 120_000;
/**
 * Conservative worst case for one askSystemOne call (R18): the client already
 * bounds the WHOLE call, retries included, to DEFAULT_TYPESAFE_TIMEOUT_MS —
 * this multiplies by TYPESAFE_MAX_ATTEMPTS anyway so the bound stays correct
 * even if a future client change drops that shared-budget cap across attempts.
 */
export const TYPED_ROUTE_CLIENT_MAX_MS = DEFAULT_TYPESAFE_TIMEOUT_MS * TYPESAFE_MAX_ATTEMPTS;
/** Slack above the derived worst case (claim + DB reads + scheduling jitter). */
export const TYPED_ROUTE_DEADLINE_MARGIN_MS = 22_000;
/**
 * DERIVED, not a bare literal (R18): strictly greater than the client's own
 * worst case plus route_task.py's own kill timeout plus margin, so the
 * deadline can never fire while a spawned route_task.py could still be
 * running — voice-inbox-typed-route-drain.test.ts TD-INEQ pins this
 * arithmetic so a future bump to either input can't silently reopen the gap.
 * Value unchanged from the original literal (60,000 ms).
 */
export const TYPED_ROUTE_ATTEMPT_DEADLINE_MS =
  TYPED_ROUTE_CLIENT_MAX_MS + WORKER_SCRIPT_TIMEOUT_MS + TYPED_ROUTE_DEADLINE_MARGIN_MS;
export const TYPED_ROUTE_CLAIM_BUSY_RETRY_MS = 15_000;
export const TYPED_ROUTE_CONFIG_CACHE_MS = 5_000;
export const TYPED_ROUTE_RECORD_CAP = 500;

export type TypedRouteVerdict = 'hold' | 'inject' | 'drop';

export function typedRouteDrainEnabled(): boolean {
  return process.env.PA_VOICE_INBOX_TYPED_ROUTING !== '0';
}

export interface VoiceInboxTypedRouteDrainOptions {
  nowFn?: () => number;
  enabledFn?: () => boolean;
  readConfigFn?: () => VoiceInboxRoutingFileConfig;
  isConfiguredFn?: () => boolean;
  /** cancelToken: the SAME object for this attempt's whole lifetime, shared
   *  with the deadline timer (R18) — a test can capture it to assert the
   *  timer flips it. */
  routeTaskFn?: (
    taskId: string,
    fileConfig: VoiceInboxRoutingFileConfig,
    cancelToken: { cancelled: boolean }
  ) => Promise<TypedRouteOutcome>;
  maxConcurrent?: number;
  holdMaxMs?: number;
  attemptDeadlineMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface VoiceInboxTypedRouteDrain {
  /** Synchronous; never throws. */
  gate(taskId: string, state: string): TypedRouteVerdict;
  inFlightCount(): number;
}

interface TaskRecord {
  firstSeenMs: number;
  status: 'waiting' | 'in-flight' | 'placed' | 'escalate';
  notBeforeMs: number;
  token?: object;
}

export function createVoiceInboxTypedRouteDrain(opts: VoiceInboxTypedRouteDrainOptions = {}): VoiceInboxTypedRouteDrain {
  const nowFn = opts.nowFn ?? Date.now;
  const enabledFn = opts.enabledFn ?? typedRouteDrainEnabled;
  const readConfigFn = opts.readConfigFn ?? (() => readVoiceInboxRoutingFileConfig());
  const isConfiguredFn = opts.isConfiguredFn ?? (() => isTypeSafeConfigured());
  const maxConcurrent = opts.maxConcurrent ?? TYPED_ROUTE_MAX_CONCURRENT;
  const holdMaxMs = opts.holdMaxMs ?? TYPED_ROUTE_HOLD_MAX_MS;
  const attemptDeadlineMs = opts.attemptDeadlineMs ?? TYPED_ROUTE_ATTEMPT_DEADLINE_MS;
  const setTimeoutFn =
    opts.setTimeoutFn ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const routeTaskFn =
    opts.routeTaskFn ??
    (async (
      taskId: string,
      fileConfig: VoiceInboxRoutingFileConfig,
      cancelToken: { cancelled: boolean }
    ): Promise<TypedRouteOutcome> => {
      const repoRoot = await repoRootFromModule(__filename);
      return routeVoiceInboxTaskTyped(taskId, {
        caller: MODULE,
        repoRoot,
        ledgerPath: voiceInboxLedgerPath(),
        fileConfig,
        lastResort: fileConfig.typedRouting?.escalation === 'place',
        cancelToken,
      });
    });

  const records = new Map<string, TaskRecord>();
  const live = new Set<object>();
  let cached: { atMs: number; value: VoiceInboxRoutingFileConfig } | undefined;

  function config(now: number): VoiceInboxRoutingFileConfig {
    if (cached === undefined || now - cached.atMs >= TYPED_ROUTE_CONFIG_CACHE_MS) {
      cached = { atMs: now, value: readConfigFn() };
    }
    return cached.value;
  }

  function prune(now: number): void {
    if (records.size < TYPED_ROUTE_RECORD_CAP) return;
    for (const [id, rec] of records) {
      if (rec.status !== 'in-flight' && now - rec.firstSeenMs > holdMaxMs) records.delete(id);
    }
  }

  /** The record still owned by this attempt, or undefined. Clears its token. */
  function settle(taskId: string, token: object): TaskRecord | undefined {
    const rec = records.get(taskId);
    if (rec === undefined || rec.token !== token) return undefined;
    rec.token = undefined;
    return rec;
  }

  function start(taskId: string, rec: TaskRecord, fileConfig: VoiceInboxRoutingFileConfig): void {
    const token = {};
    live.add(token);
    rec.status = 'in-flight';
    rec.token = token;
    // R18: one cancel token per attempt, shared with routeTaskFn below. The
    // deadline timer flips it FIRST, unconditionally, before the drain-side
    // bookkeeping below — the action checks it right before it would spawn
    // route_task.py, so a spawn can only happen before this fires (the
    // TYPED_ROUTE_ATTEMPT_DEADLINE_MS derivation guarantees the margin).
    const cancelToken = { cancelled: false };
    const timer = setTimeoutFn(() => {
      cancelToken.cancelled = true;
      if (!live.delete(token)) return;
      const mine = settle(taskId, token);
      if (mine) mine.status = 'escalate';
      logTypedRouteAction('warn', MODULE, taskId, 'typed-route-escalated', { why: 'attempt-deadline', attemptDeadlineMs });
    }, attemptDeadlineMs);
    let attempt: Promise<TypedRouteOutcome>;
    try {
      attempt = Promise.resolve(routeTaskFn(taskId, fileConfig, cancelToken));
    } catch (err) {
      attempt = Promise.reject(err);
    }
    attempt
      .then(
        (outcome) => {
          clearTimeoutFn(timer);
          if (!live.delete(token)) {
            // The deadline timer already fired and escalated this task (the
            // LLM inbox turn may already be running). Every other late
            // outcome had no side effect once this happens, but a 'placed'
            // outcome here means route_task.py actually ran AFTER the drain
            // gave up on it — a real double-routing race (R18), not a
            // harmless bookkeeping no-op. Surface it instead of staying
            // silent; nothing here can undo the route.
            if (outcome?.kind === 'placed') {
              logTypedRouteAction('warn', MODULE, taskId, 'typed-route-placed-after-deadline', {
                why: 'the attempt placed the task after its own deadline had already escalated it; check for a duplicate route',
              });
            }
            return;
          }
          const mine = settle(taskId, token);
          switch (outcome?.kind) {
            case 'placed':
              if (mine) mine.status = 'placed';
              break;
            case 'raced':
              if (mine) records.delete(taskId);
              break;
            case 'claim-busy':
              if (mine) {
                mine.status = 'waiting';
                mine.notBeforeMs = nowFn() + TYPED_ROUTE_CLAIM_BUSY_RETRY_MS;
              }
              logTypedRouteAction('info', MODULE, taskId, 'typed-route-claim-busy', {});
              break;
            case 'escalated':
              if (mine) mine.status = 'escalate';
              logTypedRouteAction('info', MODULE, taskId, 'typed-route-escalated', { why: outcome.why });
              break;
            default:
              if (mine) mine.status = 'escalate';
              logTypedRouteAction('warn', MODULE, taskId, 'typed-route-escalated', {
                why: outcome?.kind === 'script-failed' ? `script-exit-${outcome.scriptExit}` : 'malformed-outcome',
              });
          }
        },
        (err: unknown) => {
          clearTimeoutFn(timer);
          if (!live.delete(token)) return;
          const mine = settle(taskId, token);
          if (mine) mine.status = 'escalate';
          logTypedRouteAction('warn', MODULE, taskId, 'typed-route-escalated', {
            why: 'threw',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      )
      .catch(() => {
        /* never let a bookkeeping error become an unhandled rejection */
      });
  }

  function gate(taskId: string, state: string): TypedRouteVerdict {
    try {
      if (!enabledFn()) return 'inject';
      const now = nowFn();
      const fileConfig = config(now);
      if (!fileConfig.typedRouting) return 'inject';
      if (state === 'routed') {
        records.delete(taskId);
        return 'drop';
      }
      if (state !== 'received') {
        const prior = records.get(taskId);
        if (prior?.status === 'placed') {
          records.delete(taskId);
          return 'drop';
        }
        if (prior?.status === 'in-flight') return 'hold';
        return 'inject';
      }
      let rec = records.get(taskId);
      if (rec === undefined) {
        if (!isConfiguredFn()) return 'inject';
        prune(now);
        rec = { firstSeenMs: now, status: 'waiting', notBeforeMs: now };
        records.set(taskId, rec);
      }
      if (rec.status === 'escalate') {
        records.delete(taskId);
        return 'inject';
      }
      if (now - rec.firstSeenMs >= holdMaxMs) {
        records.delete(taskId);
        logTypedRouteAction('warn', MODULE, taskId, 'typed-route-hold-expired', { holdMaxMs });
        return 'inject';
      }
      if (rec.status === 'in-flight' || rec.status === 'placed') return 'hold';
      if (now < rec.notBeforeMs || live.size >= maxConcurrent) return 'hold';
      if (!isConfiguredFn()) {
        records.delete(taskId);
        return 'inject';
      }
      start(taskId, rec, fileConfig);
      return 'hold';
    } catch (err) {
      log('warn', MODULE, 'typed route gate failed; injecting', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 'inject';
    }
  }

  return { gate, inFlightCount: () => live.size };
}
