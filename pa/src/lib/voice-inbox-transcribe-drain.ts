/**
 * Voice-inbox transcription drain (2026-09-16) — the bot-process scheduler for
 * deterministic transcription. The telegram bot calls kick() once per poll
 * iteration, synchronously and never awaited, right before its route drain.
 * kick() never throws and never awaits: it scans the ledger (at most once per
 * DRAIN_SCAN_MIN_INTERVAL_MS) and starts at most DRAIN_MAX_CONCURRENT
 * fire-and-forget attempts through the ONE shared transcription action
 * (voice-inbox-transcribe.ts). Each attempt carries a hard deadline that frees
 * its slot even if its promise never settles, so a hung transcription can
 * never stall the poll tick, Telegram delivery or later voice tasks (the
 * 2026-09-15 catchup lane wedge was an unbounded await on a shared tick).
 * Nothing on this path awaits a log flush or updateJobState: log() is
 * fire-and-forget and the operator page is detached.
 */

import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { log } from './log.js';
import { loadSecrets } from '../secrets.js';
import { notifyUser } from './notify.js';
import { repoRootFromModule } from './git-root.js';
import { voiceInboxLedgerPath, voiceInboxTaskStates, type VoiceInboxTaskState } from './voice-inbox-ledger.js';
import {
  WORKER_SCRIPT_TIMEOUT_MS,
  DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS,
  DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS,
  envMs,
  envCount,
  openReadonly,
  findAudioFile,
  fileSize,
  defaultRunScript,
  defaultTranscribe,
  defaultLoadVoiceInboxModules,
  acquireTranscribeClaim,
  transcribeVoiceInboxTask,
  readInfraFailureMarkers,
  retryBackoffMs,
  transcribeAttemptDue,
  infraBoundReached,
  type InfraMarkers,
  type TranscribeOutcome,
} from './voice-inbox-transcribe.js';

const MODULE = 'voice-inbox-transcribe-drain';

export const DRAIN_SCAN_MIN_INTERVAL_MS = 5_000;
export const DRAIN_MAX_CONCURRENT = 3;
export const DEFAULT_DRAIN_TRANSCRIBE_TIMEOUT_MS = 300_000;
export const DRAIN_ATTEMPT_MARGIN_MS = 60_000;
export const CLAIM_BUSY_RETRY_MS = 30_000;
export const DRAIN_CANDIDATE_LIMIT = 50;

export function drainEnabled(): boolean {
  return process.env.PA_VOICE_INBOX_TRANSCRIBE_DRAIN !== '0';
}

export function drainTranscribeTimeoutMs(): number {
  return envMs('PA_VOICE_INBOX_TRANSCRIBE_DRAIN_TIMEOUT_MS', DEFAULT_DRAIN_TRANSCRIBE_TIMEOUT_MS);
}

/** Exec timeout + two task_transcribe.py calls + margin: past this an attempt's
 *  slot is freed whether or not its promise ever settles. */
export function drainAttemptDeadlineMs(transcribeTimeoutMs: number): number {
  return transcribeTimeoutMs + 2 * WORKER_SCRIPT_TIMEOUT_MS + DRAIN_ATTEMPT_MARGIN_MS;
}

export interface TranscribingCandidate {
  task_id: string;
  tenant_id: string;
  created_at: string;
}

/** transcribing tasks with no worker_resource, oldest first. Read-only; an
 *  absent ledger is silently empty; a read error warns and returns []. */
export function selectTranscribingCandidates(dbPath: string): TranscribingCandidate[] {
  if (!existsSync(dbPath)) return [];
  let db: Database.Database | undefined;
  try {
    db = openReadonly(dbPath);
    return db
      .prepare(
        `SELECT task_id, tenant_id, created_at FROM tasks
         WHERE state = 'transcribing' AND (worker_resource IS NULL OR worker_resource = '')
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(DRAIN_CANDIDATE_LIMIT) as TranscribingCandidate[];
  } catch (err) {
    log('warn', MODULE, 'transcribing scan failed; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** The bot route drain's hold lookup (taskStatesFn). Empty map — meaning
 *  "hold nothing, inject as before" — when the drain is disabled or the
 *  ledger file does not exist (avoids the accessor's missing-file warn). */
export function voiceInboxRouteHoldStates(taskIds: readonly string[]): Map<string, VoiceInboxTaskState> {
  if (!drainEnabled()) return new Map();
  if (!existsSync(voiceInboxLedgerPath())) return new Map();
  return voiceInboxTaskStates(taskIds);
}

/** Wraps a notify so the caller's await resolves at once; the real send
 *  continues detached and its failure is logged, never thrown. */
export function fireAndForgetNotify(inner: typeof notifyUser): typeof notifyUser {
  return (subject, body, opts) => {
    try {
      inner(subject, body, opts).catch((err: unknown) => {
        log('warn', MODULE, 'transcription failure page could not be sent', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      log('warn', MODULE, 'transcription failure page could not be sent', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return Promise.resolve({ sent: false, suppressed: false } as Awaited<ReturnType<typeof notifyUser>>);
  };
}

export interface VoiceInboxTranscribeDrainOptions {
  nowFn?: () => number;
  enabledFn?: () => boolean;
  scanMinIntervalMs?: number;
  maxConcurrent?: number;
  transcribeTimeoutMs?: number;
  attemptDeadlineMs?: number;
  selectCandidatesFn?: () => TranscribingCandidate[];
  readMarkersFn?: (candidate: TranscribingCandidate) => InfraMarkers;
  transcribeTaskFn?: (candidate: TranscribingCandidate, now: number) => Promise<TranscribeOutcome>;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface VoiceInboxTranscribeDrain {
  /** Synchronous; never throws; returns the number of attempts started. */
  kick(): number;
  inFlightCount(): number;
}

export function createVoiceInboxTranscribeDrain(opts: VoiceInboxTranscribeDrainOptions = {}): VoiceInboxTranscribeDrain {
  const nowFn = opts.nowFn ?? Date.now;
  const enabledFn = opts.enabledFn ?? drainEnabled;
  const scanMinIntervalMs = opts.scanMinIntervalMs ?? DRAIN_SCAN_MIN_INTERVAL_MS;
  const maxConcurrent = opts.maxConcurrent ?? DRAIN_MAX_CONCURRENT;
  const transcribeTimeoutMs = opts.transcribeTimeoutMs ?? drainTranscribeTimeoutMs();
  const attemptDeadlineMs = opts.attemptDeadlineMs ?? drainAttemptDeadlineMs(transcribeTimeoutMs);
  const selectCandidatesFn = opts.selectCandidatesFn ?? (() => selectTranscribingCandidates(voiceInboxLedgerPath()));
  const readMarkersFn =
    opts.readMarkersFn ?? ((c: TranscribingCandidate) => readInfraFailureMarkers(voiceInboxLedgerPath(), c.tenant_id, c.task_id));
  const setTimeoutFn =
    opts.setTimeoutFn ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimeoutFn = opts.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const transcribeTaskFn =
    opts.transcribeTaskFn ??
    (async (c: TranscribingCandidate, now: number): Promise<TranscribeOutcome> => {
      const repoRoot = await repoRootFromModule(__filename);
      return transcribeVoiceInboxTask(
        c,
        {
          caller: 'voice-inbox-transcribe-drain',
          now,
          repoRoot,
          ledgerPath: voiceInboxLedgerPath(),
          infraMaxAttempts: envCount('PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS', DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS),
          infraWindowMs: envMs('PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS', DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS),
        },
        {
          runScript: defaultRunScript,
          transcribeFn: (audioPath, cloudOrder, env) =>
            defaultTranscribe(audioPath, cloudOrder, env, repoRoot, defaultRunScript, transcribeTimeoutMs),
          loadSecretsFn: loadSecrets,
          findAudioFileFn: findAudioFile,
          fileSizeFn: fileSize,
          loadVoiceInboxModules: defaultLoadVoiceInboxModules,
          notifyFn: fireAndForgetNotify(notifyUser),
          claimFn: acquireTranscribeClaim,
        }
      );
    });

  const inFlight = new Map<string, object>();
  const notBefore = new Map<string, number>();
  let lastScanMs: number | undefined;

  function release(taskId: string, token: object, gateMs: number | undefined): boolean {
    if (inFlight.get(taskId) !== token) return false;
    inFlight.delete(taskId);
    if (gateMs === undefined) notBefore.delete(taskId);
    else notBefore.set(taskId, gateMs);
    return true;
  }

  function startAttempt(c: TranscribingCandidate, markers: InfraMarkers, now: number): void {
    const token = {};
    inFlight.set(c.task_id, token);
    log('info', MODULE, 'transcription attempt started', { taskId: c.task_id, markerCount: markers.count });
    const timer = setTimeoutFn(() => {
      if (release(c.task_id, token, nowFn() + retryBackoffMs(markers.count + 1))) {
        log('warn', MODULE, 'transcription attempt passed its deadline; slot freed', {
          taskId: c.task_id,
          attemptDeadlineMs,
        });
      }
    }, attemptDeadlineMs);
    let attempt: Promise<TranscribeOutcome>;
    try {
      attempt = Promise.resolve(transcribeTaskFn(c, now));
    } catch (err) {
      attempt = Promise.reject(err);
    }
    attempt
      .then(
        (outcome) => {
          clearTimeoutFn(timer);
          const at = nowFn();
          switch (outcome?.kind) {
            case 'transcribed':
            case 'failed-terminal':
            case 'raced':
              release(c.task_id, token, undefined);
              break;
            case 'infra-marked':
              release(c.task_id, token, at + retryBackoffMs(outcome.markerCount));
              break;
            case 'not-due':
            case 'claim-busy':
              release(c.task_id, token, at + CLAIM_BUSY_RETRY_MS);
              break;
            default: // infra-unwritten, script-failed, malformed outcome
              release(c.task_id, token, at + retryBackoffMs((outcome?.markerCount ?? markers.count) + 1));
          }
        },
        (err: unknown) => {
          clearTimeoutFn(timer);
          if (release(c.task_id, token, nowFn() + retryBackoffMs(markers.count + 1))) {
            log('warn', MODULE, 'transcription attempt threw; retrying after backoff', {
              taskId: c.task_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      )
      .catch(() => {
        /* never let a bookkeeping error become an unhandled rejection */
      });
  }

  function kick(): number {
    try {
      if (!enabledFn()) return 0;
      const now = nowFn();
      if (lastScanMs !== undefined && now - lastScanMs < scanMinIntervalMs) return 0;
      lastScanMs = now;
      if (inFlight.size >= maxConcurrent) return 0;
      const candidates = selectCandidatesFn();
      const live = new Set(candidates.map((c) => c.task_id));
      for (const id of [...notBefore.keys()]) {
        if (!live.has(id) && !inFlight.has(id)) notBefore.delete(id);
      }
      const maxAttempts = envCount('PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_ATTEMPTS', DEFAULT_TRANSCRIBE_INFRA_MAX_ATTEMPTS);
      const windowMs = envMs('PA_VOICE_INBOX_FALLBACK_TRANSCRIBE_INFRA_WINDOW_MS', DEFAULT_TRANSCRIBE_INFRA_WINDOW_MS);
      let started = 0;
      for (const c of candidates) {
        if (inFlight.size >= maxConcurrent) break;
        if (inFlight.has(c.task_id)) continue;
        const gate = notBefore.get(c.task_id);
        if (gate !== undefined && now < gate) continue;
        let markers: InfraMarkers;
        try {
          markers = readMarkersFn(c);
        } catch {
          continue;
        }
        if (!infraBoundReached(markers, c.created_at, now, maxAttempts, windowMs) && !transcribeAttemptDue(markers, now)) {
          continue;
        }
        startAttempt(c, markers, now);
        started += 1;
      }
      return started;
    } catch (err) {
      log('warn', MODULE, 'transcription drain scan failed; the next scan retries', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  return {
    kick,
    inFlightCount: () => inFlight.size,
  };
}
