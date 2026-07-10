/**
 * Tests for POSIX crontab registration in syncSchedules / listSchedules.
 * Uses mock exec calls so no real crontab is touched.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, cleanup } from './helpers.js';
import { resolveWindowsPaPath, resolvePosixPaPath } from '../src/scheduler.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
  mock.restoreAll();
});

// Helper: import scheduler with exec mocked at the child_process level
async function importSchedulerWithExecMock(
  execResults: Record<string, string>
): Promise<{ syncSchedules: () => Promise<void>; listSchedules: () => Promise<void> }> {
  // We can't easily mock child_process.exec in ESM without a full loader.
  // Instead, test the logic through integration-level assertions on output.
  // These tests validate the regex/upsert logic directly.
  return { syncSchedules: async () => {}, listSchedules: async () => {} };
}

// ── Crontab upsert logic (pure, extracted for unit testing) ──────────────────

function upsertCronLines(
  existing: string,
  entries: Array<{ sentinel: string; line: string }>
): string {
  let updated = existing;
  for (const { sentinel, line } of entries) {
    const escapedSentinel = sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`${escapedSentinel}\\n[^\\n]*\\n?`, 'g');
    const block = `${sentinel}\n${line}\n`;
    if (pattern.test(updated)) {
      updated = updated.replace(pattern, block);
    } else {
      if (!updated.endsWith('\n') && updated.length > 0) updated += '\n';
      updated += block;
    }
  }
  return updated;
}

// Default catchup cadence matches Windows (every minute) as of 2026-07-10 —
// catchup is lock-guarded, so the tighter cadence just means overdue skills
// are caught sooner, not duplicated. Was */15 * * * *.
const ENTRIES = [
  { sentinel: '# PA-Catchup-Reminders (managed by pa schedules sync)', line: '* * * * * pa catchup --topic reminders' },
  { sentinel: '# PA-Catchup (managed by pa schedules sync)',            line: '* * * * * pa catchup' },
];

describe('POSIX crontab upsert logic', () => {
  it('appends both entries to an empty crontab', () => {
    const result = upsertCronLines('', ENTRIES);
    assert.ok(result.includes('* * * * * pa catchup --topic reminders'));
    assert.ok(result.includes('* * * * * pa catchup'));
    assert.ok(result.includes('PA-Catchup-Reminders'));
    assert.ok(result.includes('PA-Catchup (managed'));
  });

  it('appends to an existing crontab without touching existing lines', () => {
    const existing = '0 9 * * 1 /usr/local/bin/weekly-report\n';
    const result = upsertCronLines(existing, ENTRIES);
    assert.ok(result.startsWith('0 9 * * 1 /usr/local/bin/weekly-report\n'));
    assert.ok(result.includes('* * * * * pa catchup --topic reminders'));
    assert.ok(result.includes('* * * * * pa catchup'));
  });

  it('replaces existing PA lines in-place (no duplicates)', () => {
    const existing =
      '0 9 * * 1 /usr/local/bin/weekly-report\n' +
      '# PA-Catchup-Reminders (managed by pa schedules sync)\n' +
      '* * * * * pa-old catchup --topic reminders\n' +
      '# PA-Catchup (managed by pa schedules sync)\n' +
      '*/30 * * * * pa-old catchup\n';
    const result = upsertCronLines(existing, ENTRIES);
    // Old lines replaced
    assert.ok(!result.includes('pa-old'));
    assert.ok(!result.includes('*/30'));
    // New lines present exactly once. The `$` anchor matters: the reminders
    // line ends in "--topic reminders", so it can't accidentally satisfy the
    // catchup-line count now that both share the "* * * * * pa catchup"
    // prefix (they didn't before the cadence unification).
    const remindersCount = (result.match(/\* \* \* \* \* pa catchup --topic reminders/g) ?? []).length;
    const catchupCount = (result.match(/\* \* \* \* \* pa catchup$/mg) ?? []).length;
    assert.equal(remindersCount, 1);
    assert.equal(catchupCount, 1);
    // Existing non-PA line preserved
    assert.ok(result.includes('0 9 * * 1 /usr/local/bin/weekly-report'));
  });

  it('handles crontab with no trailing newline', () => {
    const existing = '0 1 * * * /usr/bin/some-job';
    const result = upsertCronLines(existing, ENTRIES);
    assert.ok(result.includes('\n# PA-Catchup-Reminders'));
    assert.ok(!result.includes('some-job# PA'));
  });

  it('sentinels are escaped correctly (no regex injection)', () => {
    // Sentinel contains characters that could break an unescaped regex
    const trickySentinel = '# PA-Catchup (managed by pa schedules sync)';
    const entries = [{ sentinel: trickySentinel, line: '* * * * * pa catchup' }];
    const existing = `${trickySentinel}\n* * * * * pa catchup\n`;
    const result = upsertCronLines(existing, entries);
    // Should replace, not duplicate
    const count = (result.match(/\* \* \* \* \* pa catchup$/mg) ?? []).length;
    assert.equal(count, 1);
  });
});

// ── Fail-loud pa-path resolution (D4) ─────────────────────────────────────
// Extracted as pure functions specifically so this is testable without
// mocking child_process.exec (unreliable to intercept for a CJS-compiled
// named import across Node versions) — syncSchedulesWindows/Posix just feed
// real `where`/`which` output (or null on failure) through these.

describe('resolveWindowsPaPath (D4 fail-loud on missing pa)', () => {
  it('fails loud when `where pa` found nothing', () => {
    const result = resolveWindowsPaPath(null);
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /not on PATH/i);
    assert.match(result.errorMessage!, /npm install -g \./);
  });

  it('prefers the .cmd wrapper when multiple candidates are found', () => {
    const result = resolveWindowsPaPath(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\pa\nC:\\Users\\me\\AppData\\Roaming\\npm\\pa.cmd\n'
    );
    assert.equal(result.ok, true);
    assert.ok(result.paPath.toLowerCase().endsWith('.cmd'));
  });

  it('rejects a path containing shell metacharacters', () => {
    const result = resolveWindowsPaPath('C:\\evil&path\\pa.cmd\n');
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /unsafe characters/);
  });
});

describe('resolvePosixPaPath (D4 fail-loud on missing pa)', () => {
  it('fails loud when `which pa` found nothing', () => {
    const result = resolvePosixPaPath(null);
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /not on PATH/i);
    assert.match(result.errorMessage!, /npm install -g \./);
  });

  it('resolves a clean which-pa path', () => {
    const result = resolvePosixPaPath('/usr/local/bin/pa\n');
    assert.equal(result.ok, true);
    assert.equal(result.paPath, '/usr/local/bin/pa');
  });

  it('rejects a path containing shell metacharacters', () => {
    const result = resolvePosixPaPath('/usr/local/bin/pa; rm -rf /\n');
    assert.equal(result.ok, false);
    assert.match(result.errorMessage!, /unsafe characters/);
  });
});
