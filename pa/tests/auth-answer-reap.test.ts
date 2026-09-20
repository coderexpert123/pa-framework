import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { validateRegistry } from '../src/lib/maintenance/policy.js';
import { voiceInboxLedgerPath } from '../src/lib/voice-inbox-ledger.js';
import {
  runAuthAnswerReap,
  authAnswerReapJob,
  DELIVERED_RETENTION_MS,
  ANSWERED_RETENTION_MS,
  ROW_RETENTION_MS,
} from '../src/lib/maintenance/jobs/auth-answer-reap.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function requestsDir(): string {
  return join(tempDir, 'auth', 'requests');
}

function answersTaskDir(taskId: string): string {
  return join(tempDir, 'voice-inbox', 'answers', taskId);
}

interface BrokerRowFixture {
  request_id: string;
  task_id?: string;
  tenant_id?: string;
  shape?: string;
  provider?: string | null;
  kind?: string;
  status?: string;
  created_at?: string;
  expires_at?: string;
  state?: string | null;
  code_verifier?: string | null;
  redirect_uri?: string | null;
  auth_id?: string | null;
  answer_pointer?: string | null;
  delivered_at?: string | null;
}

/** Writes one broker row exactly matching the §3.3 key set/order (this test
 *  only needs the keys the reaper reads, but the full shape is written for
 *  realism). */
function writeBrokerRow(row: BrokerRowFixture): void {
  const dir = requestsDir();
  mkdirSync(dir, { recursive: true });
  const full = {
    request_id: row.request_id,
    task_id: row.task_id ?? 'vi-000000000000',
    tenant_id: row.tenant_id ?? 't-1234567',
    shape: row.shape ?? 'S4',
    provider: row.provider ?? null,
    kind: row.kind ?? 'secret',
    status: row.status ?? 'answered',
    created_at: row.created_at ?? '2026-01-01T00:00:00.000Z',
    expires_at: row.expires_at ?? '2026-01-02T00:00:00.000Z',
    state: row.state ?? null,
    code_verifier: row.code_verifier ?? null,
    redirect_uri: row.redirect_uri ?? null,
    auth_id: row.auth_id ?? null,
    answer_pointer: row.answer_pointer ?? null,
    delivered_at: row.delivered_at ?? null,
  };
  writeFileSync(join(dir, `${row.request_id}.json`), JSON.stringify(full), 'utf8');
}

function brokerRowPath(requestId: string): string {
  return join(requestsDir(), `${requestId}.json`);
}

/** Writes a real answer file (or an arbitrary stray file) under
 *  ~/.pa/voice-inbox/answers/<taskId>/<filename>, returning its full path. */
function writeAnswerLikeFile(taskId: string, filename: string, content = 'the secret value'): string {
  const dir = answersTaskDir(taskId);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, filename);
  writeFileSync(target, content, 'utf8');
  return target;
}

interface InputRequestFixture {
  request_id: string;
  task_id: string;
  kind: string;
  status: string;
  answer_pointer: string | null;
  answered_at: string | null;
}

/** Minimal `input_requests`-only ledger fixture — the reaper's second pass
 *  reads only this table's four columns. Closes the handle before returning
 *  (Windows-EBUSY precedent shared with the other voice-inbox-ledger
 *  fixtures in this test suite). */
function buildAnsweredRequestsLedger(rows: InputRequestFixture[]): void {
  mkdirSync(join(tempDir, 'voice-inbox'), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec(`CREATE TABLE input_requests (
      request_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      answer_pointer TEXT,
      answered_at TEXT
    )`);
    const insert = db.prepare(
      `INSERT INTO input_requests (request_id, task_id, kind, status, answer_pointer, answered_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      insert.run(row.request_id, row.task_id, row.kind, row.status, row.answer_pointer, row.answered_at);
    }
  } finally {
    db.close();
  }
}

function isoAgo(msAgo: number, now: number): string {
  return new Date(now - msAgo).toISOString();
}

describe('auth-answer-reap — registry shape', () => {
  it('validates against policy.ts without throwing', () => {
    assert.doesNotThrow(() => validateRegistry([authAnswerReapJob]));
  });

  it('is declared destructive with two RetentionTargets, both under paHome(), never shed', () => {
    assert.equal(authAnswerReapJob.host, 'pa');
    assert.equal(authAnswerReapJob.destructive, true);
    assert.equal(authAnswerReapJob.shedWhenDegraded, true);
    assert.equal(authAnswerReapJob.targets.length, 2);
  });
});

describe('auth-answer-reap — two retention windows, fail-closed filename filter', () => {
  it('reaps delivered answers (1h), answered-secret-with-no-broker-row answers (24h), and stale broker rows (24h past expiry) — never touching a non-matching filename, and touched equals the exact count', async () => {
    const now = Date.now();

    // --- Case 1: delivered 61 minutes ago — answer file must be deleted.
    const r1Answer = writeAnswerLikeFile('vi-000000000001', 'ir-000000000001.txt');
    writeBrokerRow({
      request_id: 'ir-000000000001',
      task_id: 'vi-000000000001',
      status: 'delivered',
      expires_at: isoAgo(2 * 60_000, now), // recently expired, not row-stale
      delivered_at: isoAgo(DELIVERED_RETENTION_MS + 60_000, now), // 61 min ago
      answer_pointer: r1Answer,
    });

    // --- Case 2: delivered 59 minutes ago — answer file must survive.
    const r2Answer = writeAnswerLikeFile('vi-000000000002', 'ir-000000000002.txt');
    writeBrokerRow({
      request_id: 'ir-000000000002',
      task_id: 'vi-000000000002',
      status: 'delivered',
      expires_at: isoAgo(2 * 60_000, now),
      delivered_at: isoAgo(DELIVERED_RETENTION_MS - 60_000, now), // 59 min ago
      answer_pointer: r2Answer,
    });

    // --- Case 3 (fail-closed control): delivered 61 minutes ago, but its
    // answer_pointer names a file that does NOT match ANSWER_FILE_RE — the
    // basename check must refuse to delete it regardless of the row's claim.
    const notesFile = writeAnswerLikeFile('vi-000000000005', 'notes.txt', 'unrelated operator notes');
    writeBrokerRow({
      request_id: 'ir-000000000005',
      task_id: 'vi-000000000005',
      status: 'delivered',
      expires_at: isoAgo(2 * 60_000, now),
      delivered_at: isoAgo(DELIVERED_RETENTION_MS + 60_000, now),
      answer_pointer: notesFile,
    });

    // --- Case 4: a broker row 25 hours past expires_at (never delivered) —
    // the ROW ITSELF must be deleted (pass 3).
    writeBrokerRow({
      request_id: 'ir-000000000006',
      task_id: 'vi-000000000006',
      status: 'expired',
      expires_at: isoAgo(ROW_RETENTION_MS + 60 * 60_000, now), // 25h past expiry
      delivered_at: null,
      answer_pointer: null,
    });

    // --- Case 5: an answered `secret` ledger row 25 hours old with NO
    // broker row at all — must lose its file (D5's second clause).
    const secretLedgerAnswer = writeAnswerLikeFile('vi-000000000003', 'ir-000000000003.txt');
    // --- Case 6: an answered `text` ledger row 25 hours old — must survive
    // (excluded by kind, not by age).
    const textLedgerAnswer = writeAnswerLikeFile('vi-000000000004', 'ir-000000000004.txt');
    // --- Case 7 (genuine age-threshold control): an answered `secret` row
    // only 23 hours old — must survive. Without this case, a broken
    // ANSWERED_RETENTION_MS (e.g. selecting on kind alone, ignoring age)
    // would go undetected, because case 6 above is kept for a DIFFERENT
    // reason (kind, not age).
    const recentSecretAnswer = writeAnswerLikeFile('vi-000000000007', 'ir-000000000007.txt');
    buildAnsweredRequestsLedger([
      {
        request_id: 'ir-000000000003',
        task_id: 'vi-000000000003',
        kind: 'secret',
        status: 'answered',
        answer_pointer: secretLedgerAnswer,
        answered_at: isoAgo(ANSWERED_RETENTION_MS + 60 * 60_000, now), // 25h ago
      },
      {
        request_id: 'ir-000000000004',
        task_id: 'vi-000000000004',
        kind: 'text',
        status: 'answered',
        answer_pointer: textLedgerAnswer,
        answered_at: isoAgo(ANSWERED_RETENTION_MS + 60 * 60_000, now), // 25h ago
      },
      {
        request_id: 'ir-000000000007',
        task_id: 'vi-000000000007',
        kind: 'secret',
        status: 'answered',
        answer_pointer: recentSecretAnswer,
        answered_at: isoAgo(ANSWERED_RETENTION_MS - 60 * 60_000, now), // 23h ago
      },
    ]);

    const result = await runAuthAnswerReap({ now, everyMs: 900_000 });

    // Exact count: case 1's answer file + case 4's row + case 5's answer
    // file = 3. Cases 2, 3 (fail-closed), 6 and 7 contribute zero.
    assert.equal(result.touched, 3);

    assert.equal(existsSync(r1Answer), false, 'case 1: delivered 61 min ago must lose its answer file');
    assert.equal(existsSync(r2Answer), true, 'case 2: delivered 59 min ago must keep its answer file');
    assert.equal(existsSync(notesFile), true, 'case 3: a non-matching filename must never be deleted');
    assert.equal(existsSync(brokerRowPath('ir-000000000005')), true, 'case 3: the broker row itself is untouched by this scenario');
    assert.equal(existsSync(brokerRowPath('ir-000000000006')), false, 'case 4: a broker row 25h past expires_at must be deleted');
    assert.equal(existsSync(secretLedgerAnswer), false, 'case 5: an answered secret ledger row 25h old with no broker row must lose its file');
    assert.equal(existsSync(textLedgerAnswer), true, 'case 6: an answered text ledger row must survive regardless of age');
    assert.equal(existsSync(recentSecretAnswer), true, 'case 7: an answered secret row only 23h old must survive (age threshold control)');

    // The still-present broker rows must be byte-identical JSON (untouched).
    const r1Row = JSON.parse(readFileSync(brokerRowPath('ir-000000000001'), 'utf8'));
    assert.equal(r1Row.status, 'delivered');
    assert.equal(r1Row.answer_pointer, r1Answer);
  });

  it('never throws when both stores are entirely absent', async () => {
    const result = await runAuthAnswerReap({ now: Date.now(), everyMs: 900_000 });
    assert.equal(result.touched, 0);
  });
});
