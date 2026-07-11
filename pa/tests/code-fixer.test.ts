import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempSkill, cleanup } from './helpers.js';
import {
  attemptCodeFix,
  isProtectedPath,
  isExistingTestFile,
  touchesGuardedDataPath,
  buildCodeFixBrief,
} from '../src/code-fixer.js';
import type { ExecFn, ExecResult } from '../src/code-fixer.js';
import { resolvePythonCommand } from '../src/lib/python.js';
import type { DraftProposal } from '../src/types.js';
import type { FailureRecord } from '../src/failure-analyzer.js';
import type { CheckResult } from '../src/commands/health.js';

let dir: string;

beforeEach(async () => {
  dir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(dir);
});

// ---------------------------------------------------------------------------
// Pure predicate helpers (F1/F2/F5 building blocks)
// ---------------------------------------------------------------------------

describe('isProtectedPath', () => {
  it('matches every exact file in the F1 allowlist', () => {
    for (const p of [
      'pa/src/self-improver.ts', 'pa/src/validator.ts', 'pa/src/analyzer.ts',
      'pa/src/failure-analyzer.ts', 'pa/src/feedback-analyzer.ts', 'pa/src/drafts.ts',
      'pa/src/lib/improvement-audit.ts', 'pa/src/code-fixer.ts',
      'pa/src/commands/improvements.ts', 'pa/bin/pa.ts',
    ]) {
      assert.equal(isProtectedPath(p), true, `expected ${p} to be protected`);
    }
  });

  it('matches anything under pa/scripts/git-hooks/ and .github/', () => {
    assert.equal(isProtectedPath('pa/scripts/git-hooks/pre-push-pii-guard'), true);
    assert.equal(isProtectedPath('.github/workflows/ci.yml'), true);
  });

  it('matches .gitignore* and git-public.* at repo root', () => {
    assert.equal(isProtectedPath('.gitignore'), true);
    assert.equal(isProtectedPath('.gitignore-public'), true);
    assert.equal(isProtectedPath('git-public.ps1'), true);
    assert.equal(isProtectedPath('git-public.cmd'), true);
  });

  it('does not flag an ordinary project or skill file', () => {
    assert.equal(isProtectedPath('projects/daily-mail-brief/scripts/run_brief.py'), false);
    assert.equal(isProtectedPath('pa/src/workers.ts'), false);
    assert.equal(isProtectedPath('pa/tests/code-fixer.test.ts'), false);
  });

  it('normalizes backslashes before matching', () => {
    assert.equal(isProtectedPath('pa\\src\\validator.ts'), true);
  });
});

describe('isExistingTestFile', () => {
  it('matches pa/tests/**', () => {
    assert.equal(isExistingTestFile('pa/tests/code-fixer.test.ts'), true);
    assert.equal(isExistingTestFile('pa/tests/helpers.ts'), true);
  });

  it('matches projects/telegram-bot/src/tests/**', () => {
    assert.equal(isExistingTestFile('projects/telegram-bot/src/tests/logic.test.ts'), true);
  });

  it('matches projects/<name>/tests/** for any other project', () => {
    assert.equal(isExistingTestFile('projects/daily-mail-brief/tests/test_send_telegram.py'), true);
  });

  it('does not match a non-test source file', () => {
    assert.equal(isExistingTestFile('projects/daily-mail-brief/scripts/run_brief.py'), false);
    assert.equal(isExistingTestFile('pa/src/code-fixer.ts'), false);
  });
});

describe('touchesGuardedDataPath', () => {
  it('flags any path containing a /data/ segment', () => {
    assert.equal(touchesGuardedDataPath('projects/fitness-data-sync/data/raw/export.csv'), true);
  });

  it('flags secrets.env', () => {
    assert.equal(touchesGuardedDataPath('secrets.env'), true);
  });

  it('does not flag an ordinary source path', () => {
    assert.equal(touchesGuardedDataPath('projects/daily-mail-brief/scripts/run_brief.py'), false);
  });
});

describe('buildCodeFixBrief', () => {
  const proposal: DraftProposal = {
    name: 'daily-mail-brief-fix', reason: 'Recurring missing BRIEFING marker.',
    source_message_ids: [], frontmatter: {}, prompt: '(unused for code fixes)',
    target_skill: 'daily-mail-brief', code_target: 'projects/daily-mail-brief/scripts/run_brief.py',
  };
  const evidence: FailureRecord[] = [
    { skillName: 'daily-mail-brief', error: 'Missing BRIEFING marker', timestamp: '2026-07-10T13:30:00Z', duration: 5000, worker: 'gemini' },
  ];

  it('includes the evidence, the project dir, and the code_target hint', () => {
    const brief = buildCodeFixBrief(proposal, evidence, 'projects/daily-mail-brief');
    assert.match(brief, /Missing BRIEFING marker/);
    assert.match(brief, /projects\/daily-mail-brief/);
    assert.match(brief, /run_brief\.py/);
  });

  it('states the TDD requirement (failing test first)', () => {
    const brief = buildCodeFixBrief(proposal, evidence, 'projects/daily-mail-brief');
    assert.match(brief, /failing test/i);
  });

  it('includes the F1 protected-path list verbatim and the F5 data-destruction guard', () => {
    const brief = buildCodeFixBrief(proposal, evidence, 'projects/daily-mail-brief');
    assert.match(brief, /pa\/src\/self-improver\.ts/);
    assert.match(brief, /pa\/src\/validator\.ts/);
    assert.match(brief, /do not (touch|modify|edit).*data/i);
    assert.match(brief, /run the (relevant )?(test )?suite yourself/i);
  });
});

// ---------------------------------------------------------------------------
// attemptCodeFix — end-to-end via injected exec/runner/bot-health fakes
// ---------------------------------------------------------------------------

const REPO_ROOT = 'D:/fake-repo';

interface ExecCall { command: string; cwd?: string; }

function makeExec(
  handlers: Array<{ match: string | RegExp; stdout?: string | (() => string); reject?: string }>,
  calls: ExecCall[] = []
): ExecFn {
  return async (command: string, opts?: { cwd?: string }): Promise<ExecResult> => {
    calls.push({ command, cwd: opts?.cwd });
    for (const h of handlers) {
      const matches = typeof h.match === 'string' ? command.startsWith(h.match) : h.match.test(command);
      if (matches) {
        if (h.reject) throw new Error(h.reject);
        const stdout = typeof h.stdout === 'function' ? h.stdout() : (h.stdout ?? '');
        return { stdout, stderr: '' };
      }
    }
    throw new Error(`Unhandled exec command in test: ${command} (cwd: ${opts?.cwd})`);
  };
}

const baseHandlers = () => [
  { match: 'git rev-parse --show-toplevel', stdout: `${REPO_ROOT}\n` },
  { match: 'git rev-parse --abbrev-ref HEAD', stdout: 'master\n' },
];

function makeProposal(overrides: Partial<DraftProposal> = {}): DraftProposal {
  return {
    name: 'daily-mail-brief-fix', reason: 'Recurring missing BRIEFING marker.',
    source_message_ids: [], frontmatter: {}, prompt: '(unused for code fixes)',
    target_skill: 'daily-mail-brief',
    ...overrides,
  };
}

const evidence: FailureRecord[] = [
  { skillName: 'daily-mail-brief', error: 'Missing BRIEFING marker', timestamp: '2026-07-10T13:30:00Z', duration: 5000, worker: 'gemini' },
];

const okRunner = async () => ({ result: { success: true, output: 'Fixed it.', exitCode: 0 as number | null }, worker: 'zclaude' });
const failRunner = async () => ({ result: { success: false, output: '', error: 'worker crashed', exitCode: 1 as number | null }, worker: 'zclaude' });

const noopBotRestart = async () => {};
const healthyBot = async (): Promise<CheckResult> => ({ name: 'bot-process', status: 'OK', detail: 'PID 123 alive' });
const noopSleep = async () => {};

describe('attemptCodeFix', () => {
  it('skips (dirty-worktree) and never spawns a worker when git status --porcelain is non-empty', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    let workerCalled = false;
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git status --porcelain', stdout: ' M projects/other-thing/scratch.py\n' },
    ], calls);
    const runner = async (...args: any[]) => { workerCalled = true; return okRunner(); };

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner });

    assert.equal(result.outcome, 'code-fix-skipped-dirty-worktree');
    assert.equal(workerCalled, false);
    assert.equal(calls.some((c) => c.command.startsWith('git push')), false);

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'code-fix-skipped-dirty-worktree');
  });

  it('ignores pa/data/profile* runtime drift when checking dirty-worktree', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git status --porcelain', stdout: ' M pa/data/profile.json\n M pa/data/profile-history-archive.jsonl\n' },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n' },
      { match: 'git ls-files', stdout: '' },
    ], calls);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });

    // Worker ran but made no changes (status --porcelain is called a 2nd time post-worker; our
    // handler returns the same drift-only output both times) — proves the drift didn't count as
    // "dirty" and didn't count as a worker change either.
    assert.equal(result.outcome, 'code-fix-skipped-no-changes');
  });

  it('skips (worker-failed) when the coding worker fails, with no revert needed (nothing was touched)', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git status --porcelain', stdout: '' },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
    ], calls);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: failRunner });

    assert.equal(result.outcome, 'code-fix-skipped-worker-failed');
    assert.equal(calls.some((c) => c.command.startsWith('git reset --hard')), false);
    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'code-fix-skipped-worker-failed');
  });

  it('skips (no-changes) when the worker succeeds but the working tree is still clean', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let statusCalls = 0;
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git status --porcelain', stdout: () => { statusCalls++; return ''; } },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
    ]);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });

    assert.equal(result.outcome, 'code-fix-skipped-no-changes');
    assert.equal(statusCalls, 2); // once for F4 (dirty check), once after the worker ran
  });

  it('reverts (F1) when the diff touches a protected path — no commit, no push', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    let postWorkerStatus = false;
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M pa/src/validator.ts\n M projects/daily-mail-brief/scripts/run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git reset --hard', stdout: '' },
      { match: 'git clean -fd', stdout: '' },
    ], calls);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });

    assert.equal(result.outcome, 'code-fix-reverted');
    assert.match(result.reason, /protected/i);
    assert.ok(calls.some((c) => c.command.startsWith('git reset --hard') && c.command.includes('abc1111')));
    assert.ok(calls.some((c) => c.command.startsWith('git clean -fd')));
    assert.equal(calls.some((c) => c.command.startsWith('git commit')), false);
    assert.equal(calls.some((c) => c.command.startsWith('git push')), false);

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'reverted-protected-path');
  });

  it('reverts (F2) on net test deletions in an existing test file', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/daily-mail-brief/scripts/run_brief.py\n M projects/daily-mail-brief/tests/test_run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n0\t8\tprojects/daily-mail-brief/tests/test_run_brief.py\n' },
      { match: 'git reset --hard', stdout: '' },
      { match: 'git clean -fd', stdout: '' },
    ], calls);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });

    assert.equal(result.outcome, 'code-fix-reverted');
    assert.match(result.reason, /test/i);
    assert.ok(calls.some((c) => c.command.startsWith('git reset --hard')));

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'reverted-test-weakening');
  });

  it('does NOT flag test changes that add more than they delete (net growth)', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/daily-mail-brief/scripts/run_brief.py\n M projects/daily-mail-brief/tests/test_run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n10\t2\tprojects/daily-mail-brief/tests/test_run_brief.py\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n' },
      { match: 'git ls-files', stdout: 'projects/daily-mail-brief/tests/test_run_brief.py\n' },
      { match: `${resolvePythonForTest()} -m pytest`, stdout: '3 passed in 0.4s\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
      { match: 'git push origin', stdout: '' },
    ]);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });

    assert.equal(result.outcome, 'applied-code-fix');
  });

  it('reverts (F3) when the pa test suite fails after the fix — full revert, no push', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/daily-mail-brief/scripts/run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', reject: 'Command failed: npm test\n# fail 3\nassertion error in daily-mail-brief.test.js' },
      { match: 'git reset --hard', stdout: '' },
      { match: 'git clean -fd', stdout: '' },
    ], calls);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });

    assert.equal(result.outcome, 'code-fix-reverted');
    assert.ok(calls.some((c) => c.command.startsWith('git reset --hard')));
    assert.equal(calls.some((c) => c.command.startsWith('git push')), false);

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'reverted-verification-failed');
    assert.match(record.reason, /pa test/i);
  });

  it('F3: does NOT block on PRE-EXISTING project test reds unchanged by the fix — still applies', async () => {
    // Regression guard for the 2026-07-11 gap: daily-mail-brief carries 2 pre-existing
    // pdf-test failures, and the gate must not let those freeze every autonomous fix to
    // the project. Baseline pytest and post-fix pytest report the SAME failing id → no
    // NEW failure → apply.
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    const preExistingRed = 'FAILED scripts/tests/test_generate_analysis_pdf.py::test_variation_selector\n1 failed, 3 passed';
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/daily-mail-brief/scripts/run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git ls-files projects/daily-mail-brief', stdout: 'projects/daily-mail-brief/scripts/tests/test_run_brief.py\n' },
      { match: `${resolvePythonForTest()} -m pytest`, stdout: preExistingRed }, // same both calls
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] fix\n' },
      { match: 'git push origin', stdout: '' },
    ]);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });
    assert.equal(result.outcome, 'applied-code-fix');
  });

  it('F3: reverts when the fix introduces a NEW project test failure (not in the baseline)', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    let pytestCall = 0;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/daily-mail-brief/scripts/run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git ls-files projects/daily-mail-brief', stdout: 'projects/daily-mail-brief/scripts/tests/test_run_brief.py\n' },
      {
        match: `${resolvePythonForTest()} -m pytest`, stdout: () => {
          pytestCall++;
          // baseline (call 1): clean; post-fix (call 2): a NEW failure the fix introduced.
          return pytestCall === 1
            ? '4 passed'
            : 'FAILED scripts/tests/test_run_brief.py::test_regressed_by_fix\n1 failed, 3 passed';
        },
      },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n' },
      { match: 'git reset --hard', stdout: '' },
      { match: 'git clean -fd', stdout: '' },
    ], calls);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });
    assert.equal(result.outcome, 'code-fix-reverted');
    assert.ok(calls.some((c) => c.command.startsWith('git reset --hard')));
    assert.equal(calls.some((c) => c.command.startsWith('git push')), false);

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'reverted-verification-failed');
    assert.match(record.reason, /new test failure/i);
    assert.match(record.reason, /test_regressed_by_fix/);
  });

  it('applies (happy path): commits + pushes to origin (private repo), audits applied-code-fix with commit hash and files changed', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/daily-mail-brief/scripts/run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 620\n# pass 620\n# fail 0\n# skipped 0\n' },
      { match: 'git ls-files', stdout: '' }, // no tests/ dir for this project in this fixture
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
      { match: 'git push origin master', stdout: '' },
    ], calls);

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner });

    assert.equal(result.outcome, 'applied-code-fix');
    assert.equal(result.commitHash, 'abc9999');
    assert.deepEqual(result.filesChanged, ['projects/daily-mail-brief/scripts/run_brief.py']);
    assert.ok(calls.some((c) => c.command.startsWith('git push origin master')));

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'applied-code-fix');
    assert.equal(record.commit_hash, 'abc9999');
    assert.deepEqual(record.files_changed, ['projects/daily-mail-brief/scripts/run_brief.py']);
    assert.match(record.evidence_excerpt, /Missing BRIEFING marker/);
  });

  it('builds+tests+restarts+polls the bot when projects/telegram-bot is touched', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/telegram-bot"\ncmd: "npm start"\n---\n\nBody.');
    let postWorkerStatus = false;
    let botRestartCalled = false;
    let healthPolls = 0;
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/telegram-bot/src/logic.ts\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/telegram-bot/src/logic.ts\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 5\n# pass 5\n# fail 0\n# skipped 0\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
      { match: 'git push origin master', stdout: '' },
    ]);
    const botRestartFn = async () => { botRestartCalled = true; };
    const checkBotProcessFn = async (): Promise<CheckResult> => {
      healthPolls++;
      return { name: 'bot-process', status: 'OK', detail: 'PID 1 alive' };
    };

    const result = await attemptCodeFix(
      makeProposal({ target_skill: 'daily-mail-brief' }), evidence,
      { execFn: exec, runner: okRunner, botRestartFn, checkBotProcessFn, sleepFn: noopSleep },
    );

    assert.equal(result.outcome, 'applied-code-fix');
    assert.equal(botRestartCalled, true);
    assert.ok(healthPolls >= 1);
  });

  it('reverts (F3) when the bot restarts but health check never confirms it came back up', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/telegram-bot"\ncmd: "npm start"\n---\n\nBody.');
    let postWorkerStatus = false;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M projects/telegram-bot/src/logic.ts\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/telegram-bot/src/logic.ts\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 5\n# pass 5\n# fail 0\n# skipped 0\n' },
      { match: 'git reset --hard', stdout: '' },
      { match: 'git clean -fd', stdout: '' },
    ], calls);
    const unhealthyBot = async (): Promise<CheckResult> => ({ name: 'bot-process', status: 'FAIL', detail: 'no lock file' });

    const result = await attemptCodeFix(
      makeProposal(), evidence,
      { execFn: exec, runner: okRunner, botRestartFn: noopBotRestart, checkBotProcessFn: unhealthyBot, sleepFn: noopSleep },
    );

    assert.equal(result.outcome, 'code-fix-reverted');
    assert.equal(calls.some((c) => c.command.startsWith('git push')), false);
  });
});

function resolvePythonForTest(): string {
  // Must match whatever code-fixer.ts's runVerificationGate() actually resolves at runtime —
  // NOT a hardcoded 'python'. On the macOS/Linux CI lanes that probes to 'python3', so a
  // hardcoded 'python' left the fake-exec pytest handler unmatched, the gate saw an
  // "unhandled command" as a verification failure, and the fix got spuriously reverted
  // (surfaced as an unhandled `git reset --hard`). Delegate to the real resolver.
  return resolvePythonCommand();
}
