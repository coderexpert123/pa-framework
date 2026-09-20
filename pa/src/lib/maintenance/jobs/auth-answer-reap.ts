/**
 * Reaps operator-typed secret answer values on two independent retention
 * windows, plus the broker's own short-lived request rows (auth broker
 * Phase A, D5, 2026-09-10).
 *
 * An operator-typed secret answer (S3/S4, and worker-created `secret`
 * widgets more generally) is written in plaintext to
 * `~/.pa/voice-inbox/answers/<task_id>/<request_id>.txt` and had no
 * retention job at all until this one (auth-broker survey, 2026-09-10;
 * confirmed by the same day's refutation pass, claim 11). Two scopes:
 *
 *  1. Broker-known answers: the broker's own row under
 *     `~/.pa/auth/requests/<request_id>.json` stamps `delivered_at` when
 *     `answerAndResume` or `pa auth wait` delivers the value — that answer
 *     file is deleted 1 hour later.
 *  2. Worker-created secrets with no broker row: selected off the ledger's
 *     `answered_at` for `kind = 'secret'` requests, 24 hours later — this is
 *     the gap the broker's own store can never see (D5's second clause).
 *
 * A third, independent pass deletes the broker request rows themselves
 * (`~/.pa/auth/requests/*.json`) once they are 24 hours past `expires_at` or
 * `delivered_at` — short-lived handoff state, not an audit trail.
 *
 * Every deletion is fail-closed on the FILENAME, never on the row's own
 * claim about the path: a broker/ledger row's `answer_pointer` is only ever
 * unlinked when its basename matches `ANSWER_FILE_RE`, and a broker row file
 * is only ever unlinked when its own basename matches the second
 * RetentionTarget's pattern. A stray unrelated file in either directory
 * (e.g. `notes.txt`) is never touched, regardless of what any row claims.
 * Never throws: a per-item failure (unreadable row, vanished file, EPERM)
 * logs a warn and the pass continues.
 */

import { basename, join } from 'node:path';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { paHome } from '../../../paths.js';
import { log } from '../../log.js';
import { voiceInboxAnsweredSecretRequests } from '../../voice-inbox-ledger.js';
import type { MaintenanceJob, MaintenanceJobContext, MaintenanceJobResult } from '../types.js';

const MODULE = 'auth-answer-reap';

export const DELIVERED_RETENTION_MS = 60 * 60 * 1000;
export const ANSWERED_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ROW_RETENTION_MS = 24 * 60 * 60 * 1000;
export const JOB_EVERY_MS = 15 * 60 * 1000;

/** Answer files live at `~/.pa/voice-inbox/answers/<task_id>/<request_id>.txt`
 *  (`routes.ts`'s `answerHandler` / `answer-resume.ts`'s value path) — this
 *  is the fail-closed basename filter, never a top-level mtime scan. */
export const ANSWER_FILE_RE = /^ir-[0-9a-f]{12}\.txt$/;

/** Broker request rows live at `~/.pa/auth/requests/<request_id>.json`
 *  (§3.3) — same fail-closed basename discipline as ANSWER_FILE_RE. */
export const BROKER_ROW_FILE_RE = /^ir-[0-9a-f]{12}\.json$/;

function requestsDir(): string {
  return join(paHome(), 'auth', 'requests');
}

interface BrokerRow {
  request_id: string;
  task_id: string;
  tenant_id: string;
  shape: string;
  provider: string | null;
  kind: string;
  status: string;
  created_at: string;
  expires_at: string;
  state: string | null;
  code_verifier: string | null;
  redirect_uri: string | null;
  auth_id: string | null;
  answer_pointer: string | null;
  delivered_at: string | null;
}

interface BrokerRowFile {
  file: string;
  row: BrokerRow;
}

/** Every broker row whose filename matches BROKER_ROW_FILE_RE, parsed.
 *  Fail-open: a missing directory returns []; an unreadable/unparseable
 *  individual row is skipped with a warn, never aborting the whole read. */
function readBrokerRows(): BrokerRowFile[] {
  const dir = requestsDir();
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: BrokerRowFile[] = [];
  for (const file of files) {
    if (!BROKER_ROW_FILE_RE.test(file)) continue;
    const full = join(dir, file);
    try {
      const row = JSON.parse(readFileSync(full, 'utf8')) as BrokerRow;
      rows.push({ file: full, row });
    } catch (err) {
      log('warn', MODULE, 'skipping unreadable broker row', {
        file: full,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return rows;
}

/**
 * Deletes `pointer` iff it is non-null AND its basename matches
 * ANSWER_FILE_RE — the fail-closed check that protects a stray file (e.g.
 * `notes.txt`) sitting in the same per-task answers directory even when a
 * row's own `answer_pointer` field claims otherwise. Never throws: ENOENT is
 * normal and silent (already reaped, or never written); any other error is
 * logged at 'warn' and treated as "not deleted".
 */
function deleteAnswerFileIfMatching(pointer: string | null | undefined, reason: string): boolean {
  if (!pointer) return false;
  if (!ANSWER_FILE_RE.test(basename(pointer))) return false;
  try {
    unlinkSync(pointer);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    log('warn', MODULE, 'failed to delete answer file', {
      pointer,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function runAuthAnswerReap(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
  const now = ctx.now;
  let touched = 0;

  // Pass 1: broker rows whose delivered_at is past DELIVERED_RETENTION_MS.
  const brokerRows = readBrokerRows();
  let deliveredDeleted = 0;
  for (const { row } of brokerRows) {
    if (!row.delivered_at) continue;
    const deliveredMs = Date.parse(row.delivered_at);
    if (!Number.isFinite(deliveredMs)) continue;
    if (now - deliveredMs < DELIVERED_RETENTION_MS) continue;
    if (deleteAnswerFileIfMatching(row.answer_pointer, 'delivered-retention')) {
      touched += 1;
      deliveredDeleted += 1;
    }
  }

  // Pass 2: answered `secret` ledger rows with no broker row (D5's second
  // clause) — voiceInboxAnsweredSecretRequests is itself fail-open to [].
  const answeredCutoff = new Date(now - ANSWERED_RETENTION_MS).toISOString();
  const answeredSecrets = voiceInboxAnsweredSecretRequests(answeredCutoff);
  let answeredDeleted = 0;
  for (const row of answeredSecrets) {
    if (deleteAnswerFileIfMatching(row.answer_pointer, 'answered-retention')) {
      touched += 1;
      answeredDeleted += 1;
    }
  }

  // Pass 3: the broker rows themselves, past ROW_RETENTION_MS by either
  // expires_at or delivered_at — short-lived handoff state, not an audit
  // trail (D2/D5).
  let rowsDeleted = 0;
  for (const { file, row } of brokerRows) {
    const expiresMs = Date.parse(row.expires_at);
    const deliveredMs = row.delivered_at ? Date.parse(row.delivered_at) : NaN;
    const expiresStale = Number.isFinite(expiresMs) && now - expiresMs >= ROW_RETENTION_MS;
    const deliveredStale = Number.isFinite(deliveredMs) && now - deliveredMs >= ROW_RETENTION_MS;
    if (!expiresStale && !deliveredStale) continue;
    try {
      unlinkSync(file);
      touched += 1;
      rowsDeleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log('warn', MODULE, 'failed to delete broker row', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    touched,
    detail: {
      brokerRowsSeen: brokerRows.length,
      deliveredAnswersDeleted: deliveredDeleted,
      answeredSecretsSeen: answeredSecrets.length,
      answeredSecretsDeleted: answeredDeleted,
      brokerRowsDeleted: rowsDeleted,
    },
  };
}

export const authAnswerReapJob: MaintenanceJob = {
  name: 'auth-answer-reap',
  host: 'pa',
  everyMs: JOB_EVERY_MS,
  description:
    'Reaps operator-typed secret answer values on two retention windows — the broker store\'s ' +
    'own delivered_at (1h, ~/.pa/auth/requests/) and the ledger\'s answered_at for secret ' +
    'requests with no broker row (24h, covering worker-created secret widgets) — plus broker ' +
    'request rows themselves 24h past expires_at or delivered_at. Fail-closed filename match ' +
    'on both the answer files and the broker rows; never touches anything else.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => join(paHome(), 'voice-inbox', 'answers'),
      match: ANSWER_FILE_RE,
      maxAgeMs: ANSWERED_RETENTION_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence:
        "Submitted secret answers sat plaintext with no retention job (auth-broker survey, 2026-09-10; confirmed by the same day's refutation pass, claim 11).",
      note: 'Files live one directory deeper, under answers/<task_id>/; selection is driven by the broker request store and the ledger\'s answered_at, not by top-level mtime.',
    },
    {
      resolve: () => join(paHome(), 'auth', 'requests'),
      match: BROKER_ROW_FILE_RE,
      maxAgeMs: ROW_RETENTION_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: 'Broker request rows are short-lived handoff state minted by pa auth request (auth broker Phase A, 2026-09-10).',
    },
  ],
  async run(ctx) {
    return runAuthAnswerReap(ctx);
  },
};
