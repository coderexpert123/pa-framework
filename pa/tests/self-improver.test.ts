import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/self-improver.js';
import type { ReportEntry } from '../src/self-improver.js';

function makeEntry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    name: 'test-entry',
    sourceType: 'failure',
    outcome: 'manual-review-validation-failed',
    reason: 'This is the stated reason the pattern was proposed.',
    ...overrides,
  };
}

describe('buildReport', () => {
  it('reports nothing-to-report when there are no entries and no rollbacks', () => {
    const report = buildReport([], []);
    assert.match(report, /Nothing to report/);
  });

  it('includes the reason line under every manual-review entry — not just a category label', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'daily-mail-brief-fix-3', outcome: 'manual-review-critical', targetSkill: 'daily-mail-brief', reason: 'daily-mail-brief failed 3 times with a template error.' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /daily-mail-brief-fix-3/);
    assert.match(report, /targets a critical skill \(`daily-mail-brief`\)/);
    assert.match(report, /daily-mail-brief failed 3 times with a template error\./);
  });

  it('distinguishes fix-validation-failure from new-skill-validation-failure in the reason label', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'some-fix', outcome: 'manual-review-validation-failed', targetSkill: 'some-skill' }),
      makeEntry({ name: 'some-new-skill', outcome: 'manual-review-validation-failed', targetSkill: undefined }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /proposed fix for `some-skill`, but failed autonomous validation/);
    assert.match(report, /proposed new skill, but failed autonomous validation/);
  });

  it('includes the reason line under every autonomously-applied entry too', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'explain-agent-status', outcome: 'approved-new-skill', reason: 'User asked this 4 times.' }),
      makeEntry({ name: 'reminders-fix', outcome: 'applied-fix', targetSkill: 'reminders', detail: 'overwrote `reminders`', reason: 'reminders failed twice with a timezone bug.' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /explain-agent-status.*— new skill/);
    assert.match(report, /User asked this 4 times\./);
    assert.match(report, /reminders-fix.*— fix to `reminders`: overwrote `reminders`/);
    assert.match(report, /reminders failed twice with a timezone bug\./);
  });

  it('flags side-effect-gated entries distinctly from critical and validation-failed ones', () => {
    const entries: ReportEntry[] = [
      makeEntry({ name: 'sends-email-fix', outcome: 'manual-review-side-effects', targetSkill: 'sends-email' }),
    ];
    const report = buildReport([], entries);
    assert.match(report, /has real side effects \(declares secrets\)/);
  });

  it('includes rollback lines in their own section, separate from proposals', () => {
    const report = buildReport(['- **Restored** `reminders` to its pre-fix version (fix draft: `reminders-fix`) — elevated failure rate since the fix was applied.'], []);
    assert.match(report, /\*Rollbacks \(1\)\*/);
    assert.match(report, /Restored.*reminders/);
  });

  it('counts and analysis-window line always appears, regardless of content', () => {
    const report = buildReport([], [makeEntry()]);
    assert.match(report, /Analyzed the last 14 days\. 1 proposal\(s\) generated\./);
  });
});
