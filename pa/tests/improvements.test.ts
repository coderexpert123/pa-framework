import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { appendAuditRecord } from '../src/lib/improvement-audit.js';
import type { AuditRecord } from '../src/lib/improvement-audit.js';
import type { RunMeta } from '../src/types.js';
import { buildEvalReport, improvementsCommand } from '../src/commands/improvements.js';
import type { EvalEntry } from '../src/commands/improvements.js';

let dir: string;
const originalLog = console.log;
let output: string[] = [];

beforeEach(async () => {
  dir = await createTempPaHome();
  output = [];
  console.log = (...args: any[]) => output.push(args.join(' '));
});

afterEach(async () => {
  console.log = originalLog;
  await cleanup(dir);
});

async function createTempMeta(skillName: string, meta: RunMeta, nonce: string): Promise<void> {
  const logDir = join(dir, 'logs', skillName);
  await mkdir(logDir, { recursive: true });
  const ts = meta.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(logDir, `${ts}-${nonce}.meta`), JSON.stringify(meta, null, 2), 'utf8');
}

function makeMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return { worker: 'gemini', status: 'success', exitCode: 0, duration: 1000, timestamp: new Date().toISOString(), ...overrides };
}

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: new Date().toISOString(),
    draft: 'x-fix',
    source_type: 'failure',
    action: 'applied-fix',
    risk_flags: [],
    reason: 'x failed twice.',
    ...overrides,
  };
}

describe('buildEvalReport', () => {
  it('reports a no-op message when there are no entries', () => {
    const report = buildEvalReport([], 30);
    assert.match(report, /No applied or rolled-back changes/);
  });

  it('shows baseline, current, and delta for a fix with a recorded baseline', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({
        draft: 'reminders-fix', action: 'applied-fix', target_skill: 'reminders',
        risk_flags: ['declares-secrets'],
        baseline: { window_days: 14, runs: 10, successes: 3, failures: 7 },
      }),
      current: { windowDays: 14, runs: 10, successes: 9, failures: 1 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /reminders-fix/);
    assert.match(report, /applied-fix/);
    assert.match(report, /risk: declares-secrets/);
    assert.match(report, /target: reminders/);
    assert.match(report, /baseline.*10 runs, 3 success, 7 fail/);
    assert.match(report, /current.*10 runs, 9 success, 1 fail/);
    assert.match(report, /delta: \+6 success, -6 fail/);
  });

  it('shows current-only (no baseline, no delta) for a brand-new skill with no baseline recorded', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({ draft: 'new-thing', action: 'approved-new-skill', target_skill: undefined, baseline: undefined }),
      current: { windowDays: 30, runs: 5, successes: 5, failures: 0 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /new-thing/);
    assert.match(report, /approved-new-skill/);
    assert.match(report, /target: new-thing \(new\)/);
    assert.match(report, /5 runs, 5 success, 0 fail/);
    assert.match(report, /no baseline recorded/);
    assert.doesNotMatch(report, /delta:/);
  });

  it('shows a zero delta when current matches baseline exactly (rolled-back, no recovery yet)', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({
        draft: 'flaky-fix', action: 'rolled-back', target_skill: 'flaky',
        baseline: { window_days: 14, runs: 8, successes: 2, failures: 6 },
      }),
      current: { windowDays: 14, runs: 8, successes: 2, failures: 6 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /delta: \+0 success, \+0 fail/);
  });

  it('includes the record date and omits the risk-flag suffix when there are none', () => {
    const entries: EvalEntry[] = [{
      record: makeRecord({ ts: '2026-07-01T12:00:00.000Z', draft: 'plain-fix', target_skill: 'plain', risk_flags: [], baseline: { window_days: 14, runs: 1, successes: 1, failures: 0 } }),
      current: { windowDays: 14, runs: 1, successes: 1, failures: 0 },
    }];
    const report = buildEvalReport(entries, 30);
    assert.match(report, /2026-07-01/);
    assert.doesNotMatch(report, /risk:/);
  });
});

describe('improvementsCommand', () => {
  it('prints applied-fix, approved-new-skill, and rolled-back records with computed current stats', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'a-fix', action: 'applied-fix', target_skill: 'skill-a',
      baseline: { window_days: 14, runs: 3, successes: 0, failures: 3 },
    }));
    await createTempMeta('skill-a', makeMeta({ status: 'success' }), 'n1');
    await createTempMeta('skill-a', makeMeta({ status: 'success' }), 'n2');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /a-fix/);
    assert.match(text, /skill-a/);
    assert.match(text, /2 runs, 2 success, 0 fail/); // current
    assert.match(text, /3 runs, 0 success, 3 fail/); // baseline
  });

  it('excludes non-applied/rolled-back actions (rejected_auto, rejected_stale, validation-failed)', async () => {
    await appendAuditRecord(makeRecord({ draft: 'skip-1', action: 'rejected_auto' }));
    await appendAuditRecord(makeRecord({ draft: 'skip-2', action: 'rejected_stale' }));
    await appendAuditRecord(makeRecord({ draft: 'skip-3', action: 'validation-failed' }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.doesNotMatch(text, /skip-1/);
    assert.doesNotMatch(text, /skip-2/);
    assert.doesNotMatch(text, /skip-3/);
    assert.match(text, /No applied or rolled-back changes/);
  });

  it('respects the --since window, excluding records older than it', async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await appendAuditRecord(makeRecord({ draft: 'old-fix', action: 'applied-fix', target_skill: 'old-skill', ts: old, baseline: { window_days: 14, runs: 1, successes: 1, failures: 0 } }));
    await appendAuditRecord(makeRecord({ draft: 'recent-fix', action: 'applied-fix', target_skill: 'recent-skill', baseline: { window_days: 14, runs: 1, successes: 1, failures: 0 } }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.doesNotMatch(text, /old-fix/);
    assert.match(text, /recent-fix/);
  });

  it('handles an approved-new-skill record by using the draft name as the eval target', async () => {
    await appendAuditRecord(makeRecord({ draft: 'brand-new-skill', action: 'approved-new-skill', target_skill: undefined, baseline: undefined }));
    await createTempMeta('brand-new-skill', makeMeta({ status: 'success' }), 'n1');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /brand-new-skill/);
    assert.match(text, /1 runs, 1 success, 0 fail/);
  });

  it('includes applied-code-fix records with commit hash and files-changed count (2026-07-11)', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'cdu-code-fix', action: 'applied-code-fix', target_skill: 'coding-dirs-update',
      commit_hash: 'abc1234',
      files_changed: ['projects/coding-dirs-updater/update_coding_dirs.py', 'projects/coding-dirs-updater/tests/test_update.py'],
      baseline: { window_days: 14, runs: 4, successes: 1, failures: 3 },
    }));
    await createTempMeta('coding-dirs-update', makeMeta({ status: 'success' }), 'n1');

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /cdu-code-fix/);
    assert.match(text, /applied-code-fix/);
    assert.match(text, /commit abc1234/);
    assert.match(text, /2 file\(s\) changed/);
    assert.match(text, /4 runs, 1 success, 3 fail/); // baseline still shown
  });

  it('shows the revert commit hash on a rolled-back code-fix record (2026-07-11)', async () => {
    await appendAuditRecord(makeRecord({
      draft: 'cdu-code-fix', action: 'rolled-back', target_skill: 'coding-dirs-update',
      commit_hash: 'abc1234', revert_commit_hash: 'def5678',
      baseline: { window_days: 14, runs: 4, successes: 1, failures: 3 },
    }));

    await improvementsCommand(30);

    const text = output.join('\n');
    assert.match(text, /rolled-back/);
    assert.match(text, /reverted commit abc1234/);
    assert.match(text, /revert: def5678/);
  });
});
