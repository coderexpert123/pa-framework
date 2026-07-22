import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { skillRunStats, appendAuditRecord, readAuditRecords, unifiedDiff, acceptedRollbackCommits, findAcceptance } from '../src/lib/improvement-audit.js';
import type { AuditRecord } from '../src/lib/improvement-audit.js';
import type { RunMeta } from '../src/types.js';

let dir: string;

beforeEach(async () => {
  dir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(dir);
});

/** Same fixture pattern as failure-analyzer.test.ts's createTempMeta. */
async function createTempMeta(skillName: string, meta: RunMeta, nonce = 'abc123'): Promise<void> {
  const logDir = join(dir, 'logs', skillName);
  await mkdir(logDir, { recursive: true });
  const ts = meta.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(logDir, `${ts}-${nonce}.meta`), JSON.stringify(meta, null, 2), 'utf8');
}

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    worker: 'gemini',
    status: 'success',
    exitCode: 0,
    duration: 1000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('skillRunStats', () => {
  it('counts runs/successes/failures within the window', async () => {
    await createTempMeta('my-skill', makeMeta({ status: 'success' }), 'n1');
    await createTempMeta('my-skill', makeMeta({ status: 'success' }), 'n2');
    await createTempMeta('my-skill', makeMeta({ status: 'error', error: 'boom' }), 'n3');

    const stats = await skillRunStats('my-skill', 14);
    assert.equal(stats.windowDays, 14);
    assert.equal(stats.runs, 3);
    assert.equal(stats.successes, 2);
    assert.equal(stats.failures, 1);
  });

  it('excludes runs outside the window', async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await createTempMeta('windowed-skill', makeMeta({ status: 'success', timestamp: old }), 'old');
    await createTempMeta('windowed-skill', makeMeta({ status: 'success' }), 'recent');

    const stats = await skillRunStats('windowed-skill', 14);
    assert.equal(stats.runs, 1);
    assert.equal(stats.successes, 1);
  });

  it('returns all-zero stats for a skill with no logs', async () => {
    const stats = await skillRunStats('never-ran', 14);
    assert.deepEqual(stats, { windowDays: 14, runs: 0, successes: 0, failures: 0 });
  });

  it('rate_limited runs count toward runs but neither successes nor failures', async () => {
    await createTempMeta('rl-skill', makeMeta({ status: 'rate_limited' }), 'rl1');
    const stats = await skillRunStats('rl-skill', 14);
    assert.equal(stats.runs, 1);
    assert.equal(stats.successes, 0);
    assert.equal(stats.failures, 0);
  });
});

describe('appendAuditRecord', () => {
  it('appends one JSON line per call to self-improver-audit.jsonl under PA_HOME', async () => {
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      draft: 'reminders-fix',
      source_type: 'failure',
      target_skill: 'reminders',
      action: 'applied-fix',
      risk_flags: ['declares-secrets'],
      reason: 'reminders failed twice.',
    };
    await appendAuditRecord(record);
    await appendAuditRecord({ ...record, draft: 'reminders-fix-2' });

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.equal(parsed[0].draft, 'reminders-fix');
    assert.equal(parsed[1].draft, 'reminders-fix-2');
    assert.deepEqual(parsed[0].risk_flags, ['declares-secrets']);
  });

  it('preserves the full record shape (validation, diff, backup_path, baseline all round-trip)', async () => {
    const record: AuditRecord = {
      ts: new Date().toISOString(),
      draft: 'notifier-fix',
      source_type: 'failure',
      target_skill: 'notifier',
      action: 'applied-fix',
      risk_flags: [],
      reason: 'notifier failed.',
      validation: { new_run_ok: true, judge_verdict: true, judge_excerpt: 'true — the fix looks correct' },
      diff: '- old line\n+ new line',
      backup_path: 'C:/fake/skill-drafts/notifier-fix/target-backup.skill.md',
      baseline: { window_days: 14, runs: 10, successes: 3, failures: 7 },
    };
    await appendAuditRecord(record);

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const parsed: AuditRecord = JSON.parse(raw.trim());
    assert.deepEqual(parsed, record);
  });

  it('does not throw when the write fails (fail-soft, matches rate-limit-unparseable-log.ts convention)', async () => {
    // Point PA_HOME at a path whose parent doesn't exist, so appendFile fails.
    const originalHome = process.env.PA_HOME;
    process.env.PA_HOME = join(dir, 'nonexistent-nested', 'deeper');
    try {
      await assert.doesNotReject(() => appendAuditRecord({
        ts: new Date().toISOString(),
        draft: 'x', source_type: 'failure', action: 'applied-fix', risk_flags: [], reason: 'x',
      }));
    } finally {
      process.env.PA_HOME = originalHome;
    }
  });
});

describe('readAuditRecords', () => {
  it('returns an empty array when the audit file does not exist yet', async () => {
    assert.deepEqual(await readAuditRecords(), []);
  });

  it('reads back every appended record in order', async () => {
    await appendAuditRecord({ ts: '2026-01-01T00:00:00Z', draft: 'a', source_type: 'failure', action: 'applied-fix', risk_flags: [], reason: 'r1' });
    await appendAuditRecord({ ts: '2026-01-02T00:00:00Z', draft: 'b', source_type: 'failure', action: 'rejected_auto', risk_flags: [], reason: 'r2' });

    const records = await readAuditRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].draft, 'a');
    assert.equal(records[1].draft, 'b');
  });

  it('skips a corrupt line rather than failing the whole read', async () => {
    const { appendFile } = await import('fs/promises');
    await appendAuditRecord({ ts: '2026-01-01T00:00:00Z', draft: 'good', source_type: 'failure', action: 'applied-fix', risk_flags: [], reason: 'r' });
    await appendFile(join(dir, 'self-improver-audit.jsonl'), 'not valid json\n', 'utf8');
    await appendAuditRecord({ ts: '2026-01-02T00:00:00Z', draft: 'good-2', source_type: 'failure', action: 'applied-fix', risk_flags: [], reason: 'r' });

    const records = await readAuditRecords();
    assert.deepEqual(records.map((r) => r.draft), ['good', 'good-2']);
  });
});

describe('rollback-accepted records', () => {
  function acceptance(overrides: Partial<AuditRecord> = {}): AuditRecord {
    return {
      ts: '2026-07-22T09:00:00.000Z',
      draft: 'daily-mail-brief-fix-10',
      source_type: 'failure',
      target_skill: 'daily-mail-brief',
      action: 'rollback-accepted',
      risk_flags: [],
      reason: 'Human review: keep it.',
      commit_hash: '7b82c88',
      accepted_at: '2026-07-22T09:00:00.000Z',
      accepted_by: 'human',
      ...overrides,
    };
  }

  it('round-trips a rollback-accepted record through append + read (commit, accepted_at, accepted_by, reason)', async () => {
    const record = acceptance();
    await appendAuditRecord(record);

    const records = await readAuditRecords();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], record);
    assert.equal(records[0].action, 'rollback-accepted');
    assert.equal(records[0].commit_hash, '7b82c88');
    assert.equal(records[0].accepted_at, '2026-07-22T09:00:00.000Z');
    assert.equal(records[0].accepted_by, 'human');
  });

  it('indexes acceptances by commit hash', () => {
    const accepted = acceptedRollbackCommits([acceptance()]);
    assert.equal(accepted.size, 1);
    assert.equal(findAcceptance(accepted, '7b82c88')?.reason, 'Human review: keep it.');
  });

  it('is COMMIT-SCOPED — an acceptance for one commit does not cover another', () => {
    const accepted = acceptedRollbackCommits([acceptance({ commit_hash: '7b82c88' })]);
    assert.ok(findAcceptance(accepted, '7b82c88'));
    assert.equal(findAcceptance(accepted, 'deadbee'), undefined);
    assert.equal(findAcceptance(accepted, undefined), undefined);
  });

  it('ignores an acceptance with no commit hash rather than treating it as a wildcard', () => {
    const accepted = acceptedRollbackCommits([acceptance({ commit_hash: undefined }), acceptance({ commit_hash: '   ' })]);
    assert.equal(accepted.size, 0);
    assert.equal(findAcceptance(accepted, 'anything'), undefined);
  });

  it('ignores records of every other action', () => {
    const accepted = acceptedRollbackCommits([
      { ts: '2026-07-13T00:00:00Z', draft: 'd', source_type: 'failure', action: 'rollback-failed', risk_flags: [], reason: 'r', commit_hash: '7b82c88' },
      { ts: '2026-07-11T00:00:00Z', draft: 'd', source_type: 'failure', action: 'applied-code-fix', risk_flags: [], reason: 'r', commit_hash: '7b82c88' },
    ]);
    assert.equal(accepted.size, 0);
  });

  it('matches case-insensitively and tolerates surrounding whitespace', () => {
    const accepted = acceptedRollbackCommits([acceptance({ commit_hash: '7B82C88' })]);
    assert.ok(findAcceptance(accepted, ' 7b82c88 '));
  });

  it('keeps the latest acceptance when a commit is accepted more than once', () => {
    const accepted = acceptedRollbackCommits([
      acceptance({ ts: '2026-07-22T09:00:00.000Z', reason: 'first' }),
      acceptance({ ts: '2026-07-23T09:00:00.000Z', reason: 'second' }),
    ]);
    assert.equal(findAcceptance(accepted, '7b82c88')?.reason, 'second');
  });
});

describe('unifiedDiff', () => {
  it('marks unchanged lines with a neutral prefix and changed lines with -/+', () => {
    const diff = unifiedDiff('line one\nline two\nline three', 'line one\nline TWO\nline three');
    assert.match(diff, /^  line one$/m);
    assert.match(diff, /^- line two$/m);
    assert.match(diff, /^\+ line TWO$/m);
    assert.match(diff, /^  line three$/m);
  });

  it('handles a pure addition (old is a prefix of new)', () => {
    const diff = unifiedDiff('line one', 'line one\nline two');
    assert.match(diff, /^  line one$/m);
    assert.match(diff, /^\+ line two$/m);
  });

  it('handles a pure deletion (new is a prefix of old)', () => {
    const diff = unifiedDiff('line one\nline two', 'line one');
    assert.match(diff, /^  line one$/m);
    assert.match(diff, /^- line two$/m);
  });

  it('truncates beyond maxChars with a truncation marker', () => {
    const longOld = Array.from({ length: 500 }, (_, i) => `old-${i}`).join('\n');
    const longNew = Array.from({ length: 500 }, (_, i) => `new-${i}`).join('\n');
    const diff = unifiedDiff(longOld, longNew, 200);
    assert.ok(diff.length <= 220, `expected truncated output near 200 chars, got ${diff.length}`);
    assert.match(diff, /truncated/);
  });
});
