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
  GIT_WORKFLOW_RESOURCE,
  GIT_LOCK_WAIT_MS,
  isChurnPath,
  stashChurn,
  popChurn,
} from '../src/code-fixer.js';
import type { ExecFn, ExecResult, BlackboardLockClient } from '../src/code-fixer.js';
import { exclusiveLockKey } from '../src/commands/run.js';
import type { Reservation } from '../src/lib/reservations.js';
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

describe('isChurnPath', () => {
  it('matches the pa/data/profile* files learn_agent/oracle rewrite nightly', () => {
    assert.equal(isChurnPath('pa/data/profile.json'), true);
    assert.equal(isChurnPath('pa/data/profile-history-archive.jsonl'), true);
    assert.equal(isChurnPath('pa\\data\\profile.json'), true);
  });

  it('does not match ordinary code or other data files', () => {
    assert.equal(isChurnPath('pa/src/code-fixer.ts'), false);
    assert.equal(isChurnPath('pa/data/other.json'), false);
  });
});

describe('stashChurn / popChurn', () => {
  it('does not stash when the churn paths are clean', async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec([{ match: 'git status --porcelain', stdout: '' }], calls);
    assert.equal(await stashChurn(exec, 'label'), false);
    assert.equal(calls.some((c) => c.command.startsWith('git stash')), false);
  });

  it('stashes ONLY the churn pathspecs (never a bare stash of the whole tree)', async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec([
      { match: 'git status --porcelain', stdout: ' M pa/data/profile.json\n' },
      { match: 'git stash', stdout: '' },
    ], calls);

    assert.equal(await stashChurn(exec, 'pa-self-improver-revert-abc1234'), true);
    const push = calls.find((c) => c.command.startsWith('git stash push'));
    assert.ok(push, 'expected a git stash push');
    assert.match(push!.command, /-- "pa\/data\/profile\*"/);
    // Never checkout/clean the user's profile data — that would destroy it outright.
    assert.equal(calls.some((c) => c.command.startsWith('git checkout')), false);
    assert.equal(calls.some((c) => c.command.startsWith('git clean')), false);
  });

  it('never throws and never drops the stash when the pop fails — it reports how to recover', async () => {
    const calls: ExecCall[] = [];
    const exec = makeExec([{ match: 'git stash pop', reject: 'CONFLICT (content): merge conflict in pa/data/profile.json' }], calls);

    const err = await popChurn(exec);
    assert.ok(err, 'expected an error string, not a throw');
    assert.match(err!, /still in the git stash/i);
    assert.match(err!, /git stash pop/);
    assert.equal(calls.some((c) => c.command.includes('stash drop')), false);
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

  it('forbids the coding worker from committing, pushing, or invoking a git-workflow skill (the caller already holds the lock)', () => {
    const brief = buildCodeFixBrief(proposal, evidence, 'projects/daily-mail-brief');
    assert.match(brief, /do not (commit|push)/i);
    assert.match(brief, /git-workflow/i);
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
  // hardRevert() brackets its reset/clean with a churn stash/pop so the nightly
  // pa/data/profile* data survives a revert, and the commit path unstages any already-staged
  // churn before adding the worker's own paths (2026-07-21).
  { match: 'git stash', stdout: '' },
  { match: 'git reset -q HEAD', stdout: '' },
];

// ---------------------------------------------------------------------------
// git-workflow lock fake (2026-08-05) — pushes ordering markers into the SAME
// shared `calls[]` array the exec fake already populates, so acquire-vs-git-
// command ordering is directly assertable without a second call log.
// ---------------------------------------------------------------------------

interface LockFakeState {
  acquireCalls: Array<{ resource: string; agent: string; pid: number; timeoutMs?: number }>;
  heartbeatCalls: number;
  releaseCalls: number;
  held: boolean;
}

function makeLockFake(
  calls: ExecCall[] = [],
  opts: { acquire?: boolean } = {}
): { bb: BlackboardLockClient; state: LockFakeState } {
  const state: LockFakeState = { acquireCalls: [], heartbeatCalls: 0, releaseCalls: 0, held: false };
  const bb: BlackboardLockClient = {
    acquireLock: async (resource: string, agent: string, pid: number, timeoutMs?: number) => {
      state.acquireCalls.push({ resource, agent, pid, timeoutMs });
      calls.push({ command: `lock-acquire:${resource}` });
      const acquired = opts.acquire !== false;
      if (acquired) state.held = true;
      return acquired;
    },
    updateHeartbeat: async (resource: string) => {
      state.heartbeatCalls++;
      calls.push({ command: `lock-heartbeat:${resource}` });
      return true;
    },
    releaseLock: async (resource: string) => {
      state.releaseCalls++;
      state.held = false;
      calls.push({ command: `lock-release:${resource}` });
    },
  };
  return { bb, state };
}

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
  it('ignores pa/data/profile* runtime drift when checking the tree (churn is filtered from recent-activity check)', async () => {
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
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn });

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
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: failRunner, blackboardFn: bb, recentActivityFn });

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
    const { bb } = makeLockFake();

    const recentActivityFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn });

    assert.equal(result.outcome, 'code-fix-skipped-no-changes');
    assert.equal(statusCalls, 2); // once for quiet-tree gate, once after the worker ran
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
      { match: 'git ls-files', stdout: 'pa/src/validator.ts\nprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git ls-tree', stdout: 'pa/src/validator.ts\nprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git checkout', stdout: '' },
      { match: 'git clean', stdout: '' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn });

    assert.equal(result.outcome, 'code-fix-reverted');
    assert.match(result.reason, /protected/i);
    // After 2026-08-15: scoped revert uses `git checkout <sha> -- <path>`
    assert.ok(calls.some((c) => c.command.startsWith('git checkout') && c.command.includes('abc1111')));
    // NO tree-wide reset --hard or bare clean -fd
    assert.equal(calls.some((c) => c.command === 'git reset --hard abc1111' || c.command.match(/^git reset --hard /)), false);
    assert.equal(calls.some((c) => c.command === 'git clean -fd'), false);
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
      { match: 'git ls-files', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\nprojects/daily-mail-brief/tests/test_run_brief.py\n' },
      { match: 'git ls-tree', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\nprojects/daily-mail-brief/tests/test_run_brief.py\n' },
      { match: 'git checkout', stdout: '' },
      { match: 'git clean', stdout: '' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn });

    assert.equal(result.outcome, 'code-fix-reverted');
    assert.match(result.reason, /test/i);
    // After 2026-08-15: scoped revert uses `git checkout <sha> -- <path>`
    assert.ok(calls.some((c) => c.command.startsWith('git checkout') && c.command.includes('abc1111')));
    // NO bare `git reset --hard`
    assert.equal(calls.some((c) => c.command.match(/^git reset --hard\b/)), false);

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
      { match: 'git diff --cached --name-only', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\nprojects/daily-mail-brief/tests/test_run_brief.py\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
      { match: 'git push origin', stdout: '' },
    ]);
    const { bb } = makeLockFake();

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });

    assert.equal(result.outcome, 'applied-code-fix');
  });

  it('reverts (F3) when the pa test suite fails after the fix — scoped revert, no push', async () => {
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
      { match: 'git ls-files', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git ls-tree', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git checkout', stdout: '' },
      { match: 'git clean', stdout: '' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });

    assert.equal(result.outcome, 'code-fix-reverted');
    // After 2026-08-15: scoped revert uses `git checkout <sha> -- <path>`
    assert.ok(calls.some((c) => c.command.startsWith('git checkout') && c.command.includes('abc1111')));
    // NO tree-wide reset --hard or bare clean -fd
    assert.equal(calls.some((c) => c.command.match(/^git reset --hard\b/)), false);
    assert.equal(calls.some((c) => c.command === 'git clean -fd'), false);
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
      { match: 'git diff --cached --name-only', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] fix\n' },
      { match: 'git push origin', stdout: '' },
    ]);
    const { bb } = makeLockFake();

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });
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
      { match: 'git ls-files', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git ls-tree', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git checkout', stdout: '' },
      { match: 'git clean', stdout: '' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });
    assert.equal(result.outcome, 'code-fix-reverted');
    // After 2026-08-15: scoped revert uses `git checkout <sha> -- <path>`
    assert.ok(calls.some((c) => c.command.startsWith('git checkout') && c.command.includes('abc1111')));
    // NO tree-wide reset --hard or bare clean -fd
    assert.equal(calls.some((c) => c.command.match(/^git reset --hard\b/)), false);
    assert.equal(calls.some((c) => c.command === 'git clean -fd'), false);
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
      { match: 'git diff --cached --name-only', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
      { match: 'git push origin master', stdout: '' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });

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

  it('stages and commits ONLY the worker paths — a fix commit never carries pa/data/profile* (2026-07-21)', async () => {
    // Regression guard for the un-revertable-fix-commit bug: `git add -A` swept the nightly
    // learn_agent/oracle churn into the commit, so `git revert` of that commit later aborted
    // on "local changes to pa/data/profile.json would be overwritten by merge" (audit:
    // rollback-failed for 7b82c88, twice) and the condemned fix stayed live forever.
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let statusCall = 0;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          statusCall++;
          // F4 sees churn-only drift (allowed); post-worker sees the fix PLUS more churn.
          return statusCall === 1
            ? ' M pa/data/profile.json\n'
            : ' M projects/daily-mail-brief/scripts/run_brief.py\n M pa/data/profile.json\n M pa/data/profile-history-archive.jsonl\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n' },
      { match: 'git ls-files', stdout: '' },
      { match: 'git diff --cached --name-only', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
      { match: 'git push origin master', stdout: '' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });

    assert.equal(result.outcome, 'applied-code-fix');
    assert.deepEqual(result.filesChanged, ['projects/daily-mail-brief/scripts/run_brief.py']);

    const cmds = calls.map((c) => c.command);

    const add = cmds.find((c) => c.startsWith('git add'));
    assert.ok(add, `expected a git add, got: ${cmds.join(' | ')}`);
    assert.equal(add, 'git add -A -- "projects/daily-mail-brief/scripts/run_brief.py"');
    // The bare `git add -A` this replaced is what made fix commits un-revertable.
    assert.equal(cmds.some((c) => c === 'git add -A'), false);

    // Any already-staged churn is unstaged first — index only, so the file on disk (and the
    // user's profile data) is never touched. F4 v2 (2026-08-15) unstage all, then stage only
    // the worker paths, so the check is for the unstage-all before the staged add.
    const unstageIdx = cmds.findIndex((c) => c === 'git reset -q HEAD');
    assert.ok(unstageIdx >= 0, `expected the index to be reset before staging, got: ${cmds.join(' | ')}`);
    assert.ok(unstageIdx < cmds.findIndex((c) => c.startsWith('git add')));

    const commit = cmds.find((c) => c.startsWith('git commit'));
    assert.ok(commit, 'expected a git commit');
    assert.doesNotMatch(commit!, /pa\/data\/profile/);
  });

  it('preserves pa/data/profile* churn across a hard revert: stash → checkout/clean (scoped) → pop, never checkout/clean on it', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          return ' M pa/src/validator.ts\n M pa/data/profile.json\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git ls-files', stdout: 'pa/src/validator.ts\n' },
      { match: 'git ls-tree', stdout: 'pa/src/validator.ts\n' },
      { match: 'git checkout', stdout: '' },
      { match: 'git clean', stdout: '' },
    ], calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, recentActivityFn, readActiveFn });

    assert.equal(result.outcome, 'code-fix-reverted');
    const cmds = calls.map((c) => c.command);
    const pushIdx = cmds.findIndex((c) => c.startsWith('git stash push'));
    const checkoutIdx = cmds.findIndex((c) => c.startsWith('git checkout') && c.includes('abc1111'));
    const popIdx = cmds.findIndex((c) => c.startsWith('git stash pop'));
    assert.ok(pushIdx >= 0, `expected a churn stash push, got: ${cmds.join(' | ')}`);
    assert.ok(checkoutIdx > pushIdx, 'the churn must be stashed BEFORE the destructive checkout');
    assert.ok(popIdx > checkoutIdx, 'the churn must be restored AFTER the checkout/clean');
    // The profile data is never restored-from-HEAD or deleted outright.
    assert.equal(cmds.some((c) => c.includes('checkout') && c.includes('profile')), false);
    assert.equal(cmds.some((c) => c.startsWith('git clean') && c.includes('profile')), false);
    // NO tree-wide reset --hard or bare clean -fd
    assert.equal(cmds.some((c) => c === 'git reset --hard abc1111' || c.match(/^git reset --hard /)), false);
    assert.equal(cmds.some((c) => c === 'git clean -fd'), false);
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
      { match: 'git ls-files', stdout: '' },
      { match: 'git diff --cached --name-only', stdout: 'projects/telegram-bot/src/logic.ts\n' },
      { match: 'git add -A', stdout: '' },
      { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
      { match: 'git push origin master', stdout: '' },
    ]);
    const botRestartFn = async () => { botRestartCalled = true; };
    const checkBotProcessFn = async (): Promise<CheckResult> => {
      healthPolls++;
      return { name: 'bot-process', status: 'OK', detail: 'PID 1 alive' };
    };

    const { bb } = makeLockFake();
    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];
    const result = await attemptCodeFix(
      makeProposal({ target_skill: 'daily-mail-brief' }), evidence,
      { execFn: exec, runner: okRunner, botRestartFn, checkBotProcessFn, sleepFn: noopSleep, blackboardFn: bb, recentActivityFn, readActiveFn },
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
      { match: 'git ls-files', stdout: 'projects/telegram-bot/src/logic.ts\n' },
      { match: 'git ls-tree', stdout: 'projects/telegram-bot/src/logic.ts\n' },
      { match: 'git checkout', stdout: '' },
      { match: 'git clean', stdout: '' },
    ], calls);
    const unhealthyBot = async (): Promise<CheckResult> => ({ name: 'bot-process', status: 'FAIL', detail: 'no lock file' });
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(
      makeProposal(), evidence,
      { execFn: exec, runner: okRunner, botRestartFn: noopBotRestart, checkBotProcessFn: unhealthyBot, sleepFn: noopSleep, blackboardFn: bb, recentActivityFn, readActiveFn },
    );

    assert.equal(result.outcome, 'code-fix-reverted');
    // After 2026-08-15: scoped revert uses `git checkout <sha> -- <path>`
    assert.ok(calls.some((c) => c.command.startsWith('git checkout') && c.command.includes('abc1111')));
    // NO tree-wide reset --hard or bare clean -fd
    assert.equal(calls.some((c) => c.command.match(/^git reset --hard\b/)), false);
    assert.equal(calls.some((c) => c.command === 'git clean -fd'), false);
    assert.equal(calls.some((c) => c.command.startsWith('git push')), false);
  });

  // ---------------------------------------------------------------------------
  // F4 v2 scenario tests (2026-08-17) — scoped gate and bucket sorting
  // ---------------------------------------------------------------------------

  it('F4 v2: skips when active reservations exist (defers to concurrent work)', async () => {
    // F4 v2 active-reservation detection: when another agent holds an active
    // reservation on any path, defer to avoid concurrent work collisions.
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git status --porcelain', stdout: '' },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [
      { id: 'r-other-123', paths: ['projects/other-thing'], session: 'waveA-wp1', note: 'unrelated work', claimedAt: '2026-08-17T12:00:00.000Z', expiresAt: '2026-08-17T13:00:00.000Z' },
    ];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });

    assert.equal(result.outcome, 'code-fix-skipped-concurrent-activity');
    assert.match(result.reason, /Active reservations/);
    assert.match(result.reason, /r-other-123/);
  });

  it('F4 v2: reverts when staged set mismatches worker paths (stranger-overlap snapshot mismatch)', async () => {
    // F4 v2 staged-set mismatch: when git add --pathspec stages a different set
    // than the worker actually changed, revert to avoid committing unrelated work.
    // This catches the case where someone staged unrelated changes while the
    // worker was running.
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    let postWorkerStatus = false;
    const calls: ExecCall[] = [];
    const exec = makeExec([
      ...baseHandlers(),
      {
        match: 'git status --porcelain', stdout: () => {
          if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
          // Worker changed only run_brief.py
          return ' M projects/daily-mail-brief/scripts/run_brief.py\n';
        },
      },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'npm run build', stdout: '' },
      { match: 'npm test', stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0\n' },
      { match: 'git ls-files', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      { match: 'git ls-tree --name-only', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
      // But someone staged a different file (stranger overlap)
      { match: 'git diff --cached --name-only', stdout: 'projects/daily-mail-brief/scripts/other_script.py\n' },
      // Revert uses pathspec staging
      { match: 'git add -A --', stdout: '' },
      { match: 'git checkout', stdout: '' },
      { match: 'git clean', stdout: '' },
    ], calls);
    const { bb } = makeLockFake(calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });

    assert.equal(result.outcome, 'code-fix-skipped-staged-mismatch');
    assert.match(result.reason, /Staged set mismatch/);
    assert.match(result.reason, /unexpected.*other_script\.py/);
  });
});

// ---------------------------------------------------------------------------
// git-workflow lock (2026-08-05) — attemptCodeFix must take the same
// exclusive_resource blackboard lock the commit/push/push-public/
// investigate-flagged/update-brain skill family uses (pa/src/commands/run.ts),
// so a nightly autonomous fix can never race a concurrent manual /commit or
// /push. See plans/federated-booping-hammock.md.
// ---------------------------------------------------------------------------

describe('attemptCodeFix — git-workflow lock', () => {
  it('acquires the exact skill-exclusive:git-workflow resource after repoRoot/branch resolve, before the quiet-tree gate', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    const { bb, state } = makeLockFake(calls);
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git status --porcelain', stdout: ' M projects/other-thing/scratch.py\n' },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
    ], calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn });

    assert.equal(state.acquireCalls.length, 1);
    assert.equal(state.acquireCalls[0].resource, exclusiveLockKey(GIT_WORKFLOW_RESOURCE));
    assert.equal(state.acquireCalls[0].resource, 'skill-exclusive:git-workflow');

    const cmds = calls.map((c) => c.command);
    const acquireIdx = cmds.findIndex((c) => c.startsWith('lock-acquire:'));
    const statusIdx = cmds.findIndex((c) => c === 'git status --porcelain');
    assert.ok(acquireIdx >= 0, `expected a lock-acquire call, got: ${cmds.join(' | ')}`);
    assert.ok(statusIdx > acquireIdx, `expected the quiet-tree gate after lock-acquire, got: ${cmds.join(' | ')}`);
  });

  it('returns code-fix-skipped-git-lock-busy, audits it, and never runs the F4 dirty check or any mutating git command when the lock is busy', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    const { bb } = makeLockFake(calls, { acquire: false });
    const exec = makeExec([...baseHandlers()], calls);
    let workerCalled = false;
    const runner = async (...args: any[]) => { workerCalled = true; return okRunner(); };

    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner, blackboardFn: bb });

    assert.equal(result.outcome, 'code-fix-skipped-git-lock-busy');
    assert.equal(workerCalled, false);
    assert.equal(calls.some((c) => c.command === 'git status --porcelain'), false);
    assert.equal(calls.some((c) => c.command.startsWith('git commit')), false);
    assert.equal(calls.some((c) => c.command.startsWith('git push')), false);
    assert.equal(calls.some((c) => c.command.startsWith('git reset')), false);

    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.action, 'code-fix-skipped-git-lock-busy');
  });

  type Branch = 'concurrent-activity' | 'worker-failed' | 'no-changes' | 'reverted-protected-path' | 'reverted-verification-failed' | 'applied-happy-path';

  const EXPECTED_OUTCOMES: Record<Branch, string> = {
    'concurrent-activity': 'code-fix-skipped-concurrent-activity',
    'worker-failed': 'code-fix-skipped-worker-failed',
    'no-changes': 'code-fix-skipped-no-changes',
    'reverted-protected-path': 'code-fix-reverted',
    'reverted-verification-failed': 'code-fix-reverted',
    'applied-happy-path': 'applied-code-fix',
  };

  function buildBranchFixture(branch: Branch): { exec: ExecFn; runner: typeof okRunner; calls: ExecCall[]; recentActivityFn?: () => Promise<string[]>; readActiveFn?: () => Promise<Reservation[]> } {
    const calls: ExecCall[] = [];
    let postWorkerStatus = false;
    switch (branch) {
      case 'concurrent-activity':
        return {
          calls, runner: okRunner,
          exec: makeExec([
            ...baseHandlers(),
            { match: 'git status --porcelain', stdout: ' M projects/other-thing/scratch.py\n' },
            { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
          ], calls),
          recentActivityFn: async () => ['projects/other-thing/scratch.py'],
          readActiveFn: async () => [],
        };
      case 'worker-failed':
        return {
          calls, runner: failRunner,
          exec: makeExec([
            ...baseHandlers(),
            { match: 'git status --porcelain', stdout: '' },
            { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
          ], calls),
          recentActivityFn: async () => [],
          readActiveFn: async () => [],
        };
      case 'no-changes':
        return {
          calls, runner: okRunner,
          exec: makeExec([
            ...baseHandlers(),
            { match: 'git status --porcelain', stdout: '' },
            { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
          ], calls),
          recentActivityFn: async () => [],
          readActiveFn: async () => [],
        };
      case 'reverted-protected-path':
        return {
          calls, runner: okRunner,
          exec: makeExec([
            ...baseHandlers(),
            {
              match: 'git status --porcelain', stdout: () => {
                if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
                return ' M pa/src/validator.ts\n M projects/daily-mail-brief/scripts/run_brief.py\n';
              },
            },
            { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
            { match: 'git ls-files', stdout: 'pa/src/validator.ts\n' },
            { match: 'git ls-tree --name-only', stdout: 'pa/src/validator.ts\nprojects/daily-mail-brief/scripts/run_brief.py\n' },
            { match: 'git checkout', stdout: '' },
            { match: 'git reset --hard', stdout: '' },
            { match: 'git clean -fd', stdout: '' },
          ], calls),
          recentActivityFn: async () => [],
          readActiveFn: async () => [],
        };
      case 'reverted-verification-failed':
        return {
          calls, runner: okRunner,
          exec: makeExec([
            ...baseHandlers(),
            {
              match: 'git status --porcelain', stdout: () => {
                if (!postWorkerStatus) { postWorkerStatus = true; return ''; }
                return ' M projects/daily-mail-brief/scripts/run_brief.py\n';
              },
            },
            { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
            { match: 'git ls-files', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
            { match: 'git ls-tree --name-only', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
            { match: 'git diff --numstat', stdout: '5\t1\tprojects/daily-mail-brief/scripts/run_brief.py\n' },
            { match: 'npm run build', stdout: '' },
            { match: 'npm test', reject: 'Command failed: npm test\n# fail 3' },
            { match: 'git checkout', stdout: '' },
            { match: 'git reset --hard', stdout: '' },
            { match: 'git clean -fd', stdout: '' },
          ], calls),
          recentActivityFn: async () => [],
          readActiveFn: async () => [],
        };
      case 'applied-happy-path':
        return {
          calls, runner: okRunner,
          exec: makeExec([
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
            { match: 'git ls-files', stdout: '' },
            { match: 'git diff --cached --name-only', stdout: 'projects/daily-mail-brief/scripts/run_brief.py\n' },
            { match: 'git add -A', stdout: '' },
            { match: 'git commit -F', stdout: '[master abc9999] autonomous-code-fix: daily-mail-brief-fix\n' },
            { match: 'git push origin master', stdout: '' },
          ], calls),
          recentActivityFn: async () => [],
          readActiveFn: async () => [],
        };
    }
  }

  for (const branch of Object.keys(EXPECTED_OUTCOMES) as Branch[]) {
    it(`releases the lock exactly once after outcome '${EXPECTED_OUTCOMES[branch]}' (${branch})`, async () => {
      await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
      const { exec, runner, calls, recentActivityFn, readActiveFn } = buildBranchFixture(branch);
      const { bb, state } = makeLockFake(calls);

      const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner, blackboardFn: bb, recentActivityFn, readActiveFn });

      assert.equal(result.outcome, EXPECTED_OUTCOMES[branch]);
      assert.equal(state.acquireCalls.length, 1);
      assert.equal(state.releaseCalls, 1);
      assert.equal(state.held, false);

      if (branch === 'applied-happy-path') {
        const cmds = calls.map((c) => c.command);
        assert.equal(cmds[cmds.length - 1], 'lock-release:skill-exclusive:git-workflow', `expected release to be last, got: ${cmds.join(' | ')}`);
      }
    });
  }

  it('releases the lock even when an unexpected exec error propagates as a thrown rejection', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    const { bb, state } = makeLockFake(calls);
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git status --porcelain', reject: 'unexpected git failure' },
    ], calls);

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    await assert.rejects(
      () => attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, blackboardFn: bb, recentActivityFn, readActiveFn }),
      /unexpected git failure/
    );

    assert.equal(state.releaseCalls, 1);
    assert.equal(state.held, false);
  });

  it('heartbeats the lock repeatedly during a long-running worker and stops once attemptCodeFix returns', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const calls: ExecCall[] = [];
    const { bb, state } = makeLockFake(calls);
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git status --porcelain', stdout: '' },
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
    ], calls);
    const slowRunner = async () => {
      await new Promise((r) => setTimeout(r, 120));
      return okRunner();
    };

    const recentActivityFn = async () => [];
    const readActiveFn = async () => [];

    const result = await attemptCodeFix(
      makeProposal(), evidence,
      { execFn: exec, runner: slowRunner, blackboardFn: bb, lockHeartbeatMs: 20, recentActivityFn, readActiveFn },
    );

    assert.equal(result.outcome, 'code-fix-skipped-no-changes');
    assert.ok(state.heartbeatCalls >= 3, `expected several heartbeats during a 120ms run at 20ms interval, got ${state.heartbeatCalls}`);

    const heartbeatsAtReturn = state.heartbeatCalls;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(state.heartbeatCalls, heartbeatsAtReturn, 'heartbeat must stop once attemptCodeFix has returned');
  });

  it('with no blackboardFn injected, the real singleton default wiring still produces the expected fast non-git outcome on a concurrent-activity fixture', async () => {
    await createTempSkill(dir, 'daily-mail-brief', '---\ncwd: "D:/fake-repo/projects/daily-mail-brief"\ncmd: "python scripts/run_brief.py"\n---\n\nBody.');
    const exec = makeExec([
      ...baseHandlers(),
      { match: 'git rev-parse HEAD', stdout: 'abc1111\n' },
      { match: 'git status --porcelain', stdout: ' M projects/other-thing/scratch.py\n' },
    ]);

    const recentActivityFn = async () => ['projects/other-thing/scratch.py'];
    const readActiveFn = async () => [];
    const result = await attemptCodeFix(makeProposal(), evidence, { execFn: exec, runner: okRunner, recentActivityFn, readActiveFn });

    assert.equal(result.outcome, 'code-fix-skipped-concurrent-activity');
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
