/**
 * Session-capture extraction (AI-203 WP-4).
 *
 * The capture block that lived inline in main.ts's dispatchMessage and the
 * empty-response `findNextAvailableWorker` helper move here VERBATIM (zero
 * behavior change) so the thread executor, the orchestrator dispatch and
 * main.ts all call ONE implementation (no silent-site drift). main.ts keeps
 * its own copies until its rewire lands (AI-203 WP-5); after that rewire this
 * module is the single source for all four exports below.
 */

import { stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { isWorkerCoolingDown } from '../../../pa/dist/src/workers.js';
import type { CommandResult } from '../../../pa/dist/src/types.js';
import type { SessionInfo } from './types.js';

// Moved verbatim from main.ts (agy native resume: trialed 2026-08-16, FLEET-WIDE
// since 2026-08-17). Emergency EXCLUSION list (empty = all topics resume); add a
// threadId here only if a resume pathology ever shows up on it. This copy gates
// captureSessionForResult below; main.ts's copy gates its remaining uses until
// the WP-5 rewire consolidates them.
export const AGY_NATIVE_RESUME_EXCLUDED_TOPICS = new Set<string>([]);

// Moved verbatim from main.ts: threadId from a `topic-<chatId>_<threadId>`
// blackboard resource. chatId may be NEGATIVE (supergroups: -100...), so never
// parse it with \d+ — the obvious /^topic-\d+_/ regex silently fails on
// supergroups (orchestrator correction 2026-08-17, caught in spec review).
export function threadIdFromResource(resource: string): string {
  if (!resource.startsWith('topic-')) return '';
  const parts = resource.replace(/^topic-/, '').split('_');
  if (parts.length < 2) return ''; // malformed: no underscore, no threadId
  return parts.pop() ?? '';
}

/**
 * Verbatim move of main.ts dispatchMessage's post-dispatch capture block
 * (claude/zclaude/codex direct capture; agy success-gate + `.pb`/`.db`
 * file-exists check + warn-and-drop). Zero behavior change.
 *
 * Kill-drop rule: cancelled dispatches are handled by the caller's
 * cancellation exits; the success gate here rejects non-zero exits — a failed
 * agy run may still carry a conversation_id captured mid-stream, and resuming
 * a conversation that died mid-run risks corrupt state. So a sessionId arriving
 * here means the dispatch completed successfully. (Integrator fix 2026-08-17:
 * the success gate is load-bearing; claude/zclaude/codex keep their
 * pre-existing capture-without-success-gate behavior, unchanged on purpose.)
 */
export async function captureSessionForResult(
  worker: string,
  result: CommandResult,
  resource: string
): Promise<SessionInfo | undefined> {
  let sessionId: string | undefined;
  if (worker === 'claude' || worker === 'zclaude' || worker === 'codex') {
    sessionId = result.sessionId;
  } else if (worker === 'agy' && result.success && result.sessionId) {
    // agy native-resume trial (2026-08-16): capture conversation_id for
    // allowlisted topics only. worker-exec.ts extracts conversation_id from
    // agy's stream-json init/result events when output_format=stream-json.
    // Discovery-by-.db-mtime (discoverAgySessionId) stays DEAD — concurrent
    // contamination risk is unchanged.
    //
    // Kill-drop rule: cancelled dispatches return early (the four
    // maybeDropAgySession exits above), and the success gate here rejects
    // non-zero exits — a failed agy run may still carry a conversation_id
    // captured mid-stream, and resuming a conversation that died mid-run
    // risks corrupt state. So a sessionId arriving here means the dispatch
    // completed successfully. (Integrator fix 2026-08-17: the success gate
    // is load-bearing; claude/zclaude/codex keep their pre-existing
    // capture-without-success-gate behavior, unchanged on purpose.)
    if (!AGY_NATIVE_RESUME_EXCLUDED_TOPICS.has(threadIdFromResource(resource))) {
      // Session-validity check (2026-08-17): verify the session file exists
      // before capturing agy native-resume sessionId. If the .pb/.db file is
      // missing (e.g. external deletion or agy's own GC), skip capture and fall
      // through to sessionless. This prevents resuming a non-existent conversation
      // which would fail on the next dispatch with "conversation not found" errors.
      const agySessionId = result.sessionId;
      const agyDir = join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
      let sessionFileExists = false;
      try {
        await stat(join(agyDir, `${agySessionId}.pb`));
        sessionFileExists = true;
      } catch {
        try {
          await stat(join(agyDir, `${agySessionId}.db`));
          sessionFileExists = true;
        } catch {
          // Neither file exists
        }
      }
      if (sessionFileExists) {
        sessionId = agySessionId;
      } else {
        logger.warn('dispatch', 'agy native-resume: session file missing, dropping session', {
          sessionId: agySessionId,
          threadId: threadIdFromResource(resource),
        });
      }
    }
  }
  if (sessionId) return { session_id: sessionId, worker, started_at: new Date().toISOString() };
  return undefined;
}

/**
 * Verbatim move of main.ts's empty-response helper: suggest the next
 * non-cooling worker for the worker-error reply's switch suggestion.
 * WP-5 rewires main.ts's local uses to import it from here — do not
 * duplicate elsewhere.
 */
export async function findNextAvailableWorker(
  currentWorker: string,
  defaultWorker: string | undefined,
  preferredWorker: string | undefined,
  config: { workers: any[] }
): Promise<string | null> {
  if (defaultWorker && defaultWorker !== currentWorker && !(await isWorkerCoolingDown(defaultWorker))) {
    return defaultWorker;
  }
  const excludedWorkers = [currentWorker, preferredWorker].filter(Boolean);
  for (const w of config.workers) {
    if (!excludedWorkers.includes(w.name) && !(await isWorkerCoolingDown(w.name))) {
      return w.name;
    }
  }
  return null;
}
