import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  budgetChars,
  budgetedDocFiles,
  docBudgetFailures,
  normalizeDocPath,
  DOCS_FILE_BUDGETS,
  INVENTORY_FILE_BUDGETS,
  PROJECT_CLAUDE_BUDGETS,
  BACKLOG_ROUTER_BUDGET,
  type RaisedBudget,
} from '../src/lib/docs-lint.js';

// Fixture-root tests for the budgeted-doc gate's size arm (AI-242). The trim
// counter arm keeps its fixture-repo instrument in docs-crossref.test.ts —
// this file covers only what that suite can't see: scoping, the shared
// measure, and the recorded-justification contract on raised budgets.

describe('docs-lint budget arm', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pa-docs-lint-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const put = async (rel: string, content: string): Promise<void> => {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), content, 'utf8');
  };

  it('budgetChars normalizes CRLF to one char per line ending', () => {
    assert.equal(budgetChars('ab\r\ncd\n'), 'ab\ncd\n'.length);
    assert.equal(budgetChars('ab\ncd\n'), 6);
  });

  it('a projects/*/CLAUDE.md over the 12k default budget fails; a named raise clears it', async () => {
    // 12,001 chars > the 12,000 default — 'newproj' carries no raise.
    await put('projects/newproj/CLAUDE.md', 'x'.repeat(12_001));
    const failures = docBudgetFailures(root);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].file, 'projects/newproj/CLAUDE.md');
    assert.equal(failures[0].budget, 12_000);
    assert.ok(failures[0].message.includes('12001 chars'), failures[0].message);
  });

  it('a named docs/*.md raise is honored (ARCHITECTURE.md gets 28k, not the 24k evergreen class)', async () => {
    await put('docs/ARCHITECTURE.md', 'x'.repeat(25_000)); // over 24k, under 28k
    const failures = docBudgetFailures(root);
    assert.deepEqual(failures, []);
  });

  it('scoping (`only`) restricts the check to the named paths', async () => {
    await put('BACKLOG.md', 'x'.repeat(BACKLOG_ROUTER_BUDGET + 1)); // over the router budget
    await put('CLAUDE.md', 'x'.repeat(48_001)); // over 48k
    const scoped = docBudgetFailures(root, ['BACKLOG.md']);
    assert.deepEqual(scoped.map((f) => f.file), ['BACKLOG.md']);
    const unrelated = docBudgetFailures(root, ['docs/never-touched.md']);
    assert.deepEqual(unrelated, []);
  });

  it('budgetedDocFiles enumerates the covered set; normalizeDocPath maps absolute+backslash spellings', async () => {
    await put('docs/topic.md', 'x');
    await put('inventory/inv.md', 'x');
    await put('projects/p/CLAUDE.md', 'x');
    const files = budgetedDocFiles(root);
    assert.ok(files.includes('docs/topic.md'));
    assert.ok(files.includes('inventory/inv.md'));
    assert.ok(files.includes('projects/p/CLAUDE.md'));
    assert.equal(normalizeDocPath(root, '.\\docs\\topic.md'), 'docs/topic.md');
    const abs = join(root, 'docs', 'topic.md');
    assert.equal(normalizeDocPath(root, abs), 'docs/topic.md');
  });

  // The AI-242 escape hatch, made mechanical: a budget bump is legitimate
  // only WITH a recorded justification — every raised entry must carry a
  // dated `since` and a non-empty `justification`. A bare number fails here.
  it('every raised (non-default) budget carries a recorded dated justification', () => {
    const raised: Array<[string, RaisedBudget]> = [
      ...Object.entries(PROJECT_CLAUDE_BUDGETS).map(([k, v]) => [`projects:${k}`, v] as [string, RaisedBudget]),
      ...Object.entries(DOCS_FILE_BUDGETS).map(([k, v]) => [`docs:${k}`, v] as [string, RaisedBudget]),
      ...Object.entries(INVENTORY_FILE_BUDGETS).map(([k, v]) => [`inventory:${k}`, v] as [string, RaisedBudget]),
    ];
    assert.ok(raised.length > 0, 'expected at least one raised budget on record');
    for (const [name, rule] of raised) {
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(rule.since), `${name}: since must be a YYYY-MM-DD date, got ${JSON.stringify(rule.since)}`);
      assert.ok(rule.justification.trim().length > 0, `${name}: justification must be non-empty`);
      assert.ok(Number.isInteger(rule.budget) && rule.budget > 0, `${name}: budget must be a positive integer`);
    }
  });
});
