import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { loadSkill } from './skills.js';
import { runWithFailover } from './workers.js';
import { botRestartCommand } from './commands/bot.js';
import { checkBotProcess } from './commands/health.js';
import { appendAuditRecord, skillRunStats, toAuditBaseline } from './lib/improvement-audit.js';
import { resolvePythonCommand } from './lib/python.js';
import type { DraftProposal } from './types.js';
import type { FailureRecord } from './failure-analyzer.js';
import type { AuditTestRunCounts } from './lib/improvement-audit.js';
import type { CheckResult } from './commands/health.js';

// ---------------------------------------------------------------------------
// Autonomous CODE-fix capability (2026-07-11) — see
// plans/2026-07-11-autonomous-code-fix-capability.md. The self-improver's fully-autonomous
// prompt-fix loop (validator.ts) is a no-op for a cmd-based skill: the prompt body is
// documentation, the real behavior lives in the script the frontmatter's `cmd:` points to.
// This module extends autonomy to that script/framework code itself, with git as the
// recovery story: every applied fix is one commit on the PRIVATE origin remote, so a bad fix
// is always one `git revert` away from gone (see self-improver.ts's rollback() extension).
//
// Six non-negotiable floors — each exists because git cannot recover from its absence:
//   F1. PROTECTED_CODE — a hard block on the loop's own execution/audit/rollback chain and
//       the repo-boundary tooling, enforced by DIFF INSPECTION after the fact (isProtectedPath
//       below), not by trusting the coding worker's brief to behave.
//   F2. Test-integrity guard — a fix diff may not net-delete lines from an EXISTING test file
//       (isExistingTestFile below) — the guard against "green by deleting the test."
//   F3. Post-apply verification gate, same run: build + full relevant suites (+ bot
//       restart/health poll if the bot was touched). ANY failure reverts everything.
//   F4. Working-tree-clean precondition — never mixes an autonomous diff with human WIP.
//   F5. One fix per nightly run (enforced by self-improver.ts's orchestrator, not here) +
//       a data-destruction guard, both in the coding worker's brief AND enforced here via
//       touchesGuardedDataPath (diff inspection, not just the brief — same F1 principle).
//   F6. Commit + push PRIVATE origin only. NEVER the public mirror (.git-public) — this
//       module only ever calls plain `git`, which always resolves to `.git`.
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string, options?: { cwd?: string }) => Promise<ExecResult>;

const defaultExec: ExecFn = promisify(execCb);

export type CodeFixOutcome =
  | 'applied-code-fix'
  | 'code-fix-reverted'
  | 'code-fix-skipped-no-target'
  | 'code-fix-skipped-dirty-worktree'
  | 'code-fix-skipped-worker-failed'
  | 'code-fix-skipped-no-changes';

export interface CodeFixResult {
  outcome: CodeFixOutcome;
  reason: string;
  commitHash?: string;
  filesChanged?: string[];
  testRunCounts?: AuditTestRunCounts;
}

export interface CodeFixOptions {
  execFn?: ExecFn;
  runner?: typeof runWithFailover;
  botRestartFn?: typeof botRestartCommand;
  checkBotProcessFn?: () => Promise<CheckResult>;
  sleepFn?: (ms: number) => Promise<void>;
}

// --- F1: protected framework paths — the loop's own execution/audit/rollback chain and the
// repo-boundary tooling. Never touched, no matter what the coding worker's diff contains. ---

const PROTECTED_CODE_EXACT = new Set([
  'pa/src/self-improver.ts',
  'pa/src/validator.ts',
  'pa/src/analyzer.ts',
  'pa/src/failure-analyzer.ts',
  'pa/src/feedback-analyzer.ts',
  'pa/src/drafts.ts',
  'pa/src/lib/improvement-audit.ts',
  'pa/src/code-fixer.ts',
  'pa/src/commands/improvements.ts',
  'pa/bin/pa.ts',
]);
const PROTECTED_CODE_DIR_PREFIXES = ['pa/scripts/git-hooks/', '.github/'];
// Bare-name prefix match at repo root only (no '/' in the remainder) — matches
// .gitignore/.gitignore-public and git-public.ps1/git-public.cmd without also matching an
// unrelated nested file that happens to start with the same characters.
const PROTECTED_CODE_ROOT_FILE_PREFIXES = ['.gitignore', 'git-public.'];

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isProtectedPath(path: string): boolean {
  const norm = normalizePath(path);
  if (PROTECTED_CODE_EXACT.has(norm)) return true;
  if (PROTECTED_CODE_DIR_PREFIXES.some((p) => norm.startsWith(p))) return true;
  if (!norm.includes('/') && PROTECTED_CODE_ROOT_FILE_PREFIXES.some((p) => norm.startsWith(p))) return true;
  return false;
}

// --- F2: existing test files — a net line-count deletion here (via `git diff --numstat`,
// deleted > added) means the fix made a test weaker rather than making the code correct. ---

export function isExistingTestFile(path: string): boolean {
  const norm = normalizePath(path);
  if (norm.startsWith('pa/tests/')) return true;
  if (norm.startsWith('projects/telegram-bot/src/tests/')) return true;
  if (/^projects\/[^/]+\/tests\//.test(norm)) return true;
  return false;
}

// --- F5 (diff-inspection half): never let the coding worker's diff touch a data directory or
// an env/secrets file, regardless of what its brief says. Defense in depth — F1's principle
// ("diff inspection, not trusting the brief") applied to the data-destruction guard too. ---

export function touchesGuardedDataPath(path: string): boolean {
  const norm = normalizePath(path);
  if (/(^|\/)data\//.test(norm)) return true;
  if (/\.env(\.|$)/.test(norm) || /secrets/i.test(norm)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// git status/diff parsing helpers
// ---------------------------------------------------------------------------

// Runtime drift that isn't human WIP and shouldn't block F4's dirty-worktree check — the
// learn_agent/oracle skill can rewrite these between the last commit and a nightly run.
//
// EXPORTED (2026-07-21) because the carve-out has to hold at BOTH ends of the safety model,
// not just at the F4 gate. Until then `git add -A` below swept these churning data files into
// every autonomous fix commit, and self-improver.ts's recovery path ran a bare
// `git revert` — which aborts with "Your local changes to the following files would be
// overwritten by merge: pa/data/profile.json" the moment learn_agent has rewritten it again.
// Result: audit action 'rollback-failed' for commit 7b82c88 on BOTH 2026-07-13 and
// 2026-07-16, the condemned fix still an ancestor of HEAD, and the loop's stated guarantee
// ("a bad fix is always one `git revert` away") quietly false. Do not regress either half.
export const DIRTY_IGNORE_PREFIXES = ['pa/data/profile'];

/** The churn paths above as pre-quoted git pathspecs, ready to append to a command line. */
export const CHURN_PATHSPEC_ARGS = DIRTY_IGNORE_PREFIXES.map((p) => `"${p}*"`).join(' ');

/** True when `path` is nightly runtime churn (see DIRTY_IGNORE_PREFIXES), not human WIP. */
export function isChurnPath(path: string): boolean {
  const norm = normalizePath(path);
  return DIRTY_IGNORE_PREFIXES.some((pre) => norm.startsWith(pre));
}

export function parsePorcelainPaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    // Porcelain v1: exactly 2 status chars, a space, then the path (renames: "old -> new").
    const rest = line.slice(3);
    const arrowIdx = rest.indexOf(' -> ');
    const path = arrowIdx !== -1 ? rest.slice(arrowIdx + 4) : rest;
    const unquoted = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
    paths.push(normalizePath(unquoted));
  }
  return paths;
}

async function getWorkingTreePaths(exec: ExecFn, repoRoot: string): Promise<string[]> {
  const { stdout } = await exec('git status --porcelain', { cwd: repoRoot });
  return parsePorcelainPaths(stdout).filter((p) => !isChurnPath(p));
}

// --- Churn preservation across destructive git operations (2026-07-21) --------------------
// `git reset --hard` / `git revert` both clobber the tracked pa/data/profile* files, which
// carry a day of learn_agent-written user data that is NOT reproducible. Stash exactly those
// paths across the destructive step and put them back afterwards. Deliberately never
// `git checkout` / `git clean` them, and never `git stash drop` — worst case the data sits in
// the stash and the caller says so out loud. Crash-safe by construction: between the stash
// and the pop, profile.json holds its last COMMITTED content (valid JSON, never truncated)
// and the newer content lives in git's object store.

/** True when any DIRTY_IGNORE_PREFIXES file currently has uncommitted changes. */
export async function churnIsDirty(exec: ExecFn, opts?: { cwd?: string }): Promise<boolean> {
  const { stdout } = await exec(`git status --porcelain -- ${CHURN_PATHSPEC_ARGS}`, opts);
  return stdout.trim().length > 0;
}

/** Stashes ONLY the churn paths. Returns true when something was stashed (pop with popChurn). */
export async function stashChurn(exec: ExecFn, label: string, opts?: { cwd?: string }): Promise<boolean> {
  if (!(await churnIsDirty(exec, opts))) return false;
  const safeLabel = label.replace(/[^0-9A-Za-z._-]/g, '-');
  await exec(`git stash push -u -m "${safeLabel}" -- ${CHURN_PATHSPEC_ARGS}`, opts);
  return true;
}

/**
 * Restores a stashChurn() stash. Never throws and never drops the stash: on failure the data
 * is still fully recoverable, and the returned string says exactly how — callers surface it
 * rather than swallowing it.
 */
export async function popChurn(exec: ExecFn, opts?: { cwd?: string }): Promise<string | undefined> {
  try {
    await exec('git stash pop', opts);
    return undefined;
  } catch (err: any) {
    return `pa/data/profile* changes are still in the git stash and were NOT restored — recover with \`git stash list\` + \`git stash pop\`: ${(err?.message ?? String(err)).slice(0, 200)}`;
  }
}

interface NumstatEntry { added: number; deleted: number; path: string; }

async function getNumstat(exec: ExecFn, repoRoot: string, preFixHead: string): Promise<NumstatEntry[]> {
  const { stdout } = await exec(`git diff --numstat ${preFixHead}`, { cwd: repoRoot });
  const entries: NumstatEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
    if (addedRaw === '-' || deletedRaw === '-') continue; // binary file — numstat can't count lines
    const added = Number(addedRaw);
    const deleted = Number(deletedRaw);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue;
    entries.push({ added, deleted, path: normalizePath(pathParts.join('\t')) });
  }
  return entries;
}

async function hardRevert(exec: ExecFn, repoRoot: string, preFixHead: string): Promise<void> {
  const opts = { cwd: repoRoot };
  // `git reset --hard` would roll the nightly-churning pa/data/profile* files back to the
  // pre-fix commit and silently destroy a day of learn_agent-written profile data — the F4
  // carve-out let that drift through the gate, so it is still present here. Stash just those
  // paths across the reset/clean and put them back (2026-07-21). Do not regress.
  const stashed = await stashChurn(exec, `pa-code-fix-revert-${preFixHead}`, opts);
  try {
    await exec(`git reset --hard ${preFixHead}`, opts);
    // reset --hard doesn't remove new untracked files the worker created — F4 already confirmed
    // the tree was clean before the worker ran, so anything untracked now is the worker's.
    await exec('git clean -fd', opts);
  } finally {
    if (stashed) {
      const restoreError = await popChurn(exec, opts);
      if (restoreError) console.warn(`[code-fixer] ${restoreError}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Coding worker brief
// ---------------------------------------------------------------------------

const PROTECTED_LIST_TEXT = [...PROTECTED_CODE_EXACT, ...PROTECTED_CODE_DIR_PREFIXES.map((p) => `${p}**`), ...PROTECTED_CODE_ROOT_FILE_PREFIXES.map((p) => `${p}*`)]
  .map((p) => `- ${p}`)
  .join('\n');

export function buildCodeFixBrief(
  proposal: DraftProposal,
  evidence: FailureRecord[],
  projectRelDir: string
): string {
  const evidenceBlock = evidence.length > 0
    ? evidence.slice(0, 10).map((f) => `- [${f.timestamp}] ${f.error}`).join('\n')
    : '(no recorded failure evidence available)';

  return `You are fixing a recurring bug in an automated skill's own script — not its LLM prompt (this skill's prompt is documentation only; the real behavior lives in the code below).

## Target
Project directory: ${projectRelDir}
${proposal.code_target ? `Likely file: ${proposal.code_target}` : ''}

## Recorded failure evidence (last 14 days)
${evidenceBlock}

## Why this fix was proposed
${proposal.reason}

## Requirements
1. Write a failing test FIRST that reproduces the recorded failure (TDD), confirm it fails, then fix the code so it passes. Add new test files or add lines to existing tests — do not weaken or delete existing test coverage.
2. Scope your changes to ${projectRelDir} only. Do NOT touch any of the following protected paths under any circumstances — these are the self-improvement loop's own execution/audit/rollback machinery and repo-boundary tooling:
${PROTECTED_LIST_TEXT}
3. Data-destruction guard: do not touch, modify, or delete anything under a data/ directory, any .env file, or anything with "secrets" in its name or path. Do not run the live skill itself as a form of validation — tests only.
4. Run the relevant test suite yourself before declaring done, and only declare done if it passes.

Make the minimal change that fixes the recorded failure. Do not refactor unrelated code.`;
}

// ---------------------------------------------------------------------------
// Verification gate (F3)
// ---------------------------------------------------------------------------

interface VerificationOutcome {
  ok: boolean;
  excerpt?: string;
  testRunCounts?: AuditTestRunCounts;
}

function excerptOf(err: unknown): string {
  const e = err as { message?: string; stdout?: string; stderr?: string };
  return (e.stderr || e.stdout || e.message || String(err)).slice(0, 500);
}

function parseNodeTestSummary(text: string): AuditTestRunCounts | undefined {
  const total = text.match(/^# tests (\d+)$/m);
  const pass = text.match(/^# pass (\d+)$/m);
  const fail = text.match(/^# fail (\d+)$/m);
  const skip = text.match(/^# skipped (\d+)$/m);
  if (!total || !pass || !fail) return undefined;
  return { total: Number(total[1]), pass: Number(pass[1]), fail: Number(fail[1]), skip: skip ? Number(skip[1]) : 0 };
}

function parsePytestSummary(text: string): AuditTestRunCounts | undefined {
  const passed = text.match(/(\d+) passed/);
  const failed = text.match(/(\d+) failed/);
  const skipped = text.match(/(\d+) skipped/);
  const errors = text.match(/(\d+) error/);
  if (!passed && !failed) return undefined;
  const pass = passed ? Number(passed[1]) : 0;
  const fail = (failed ? Number(failed[1]) : 0) + (errors ? Number(errors[1]) : 0);
  const skip = skipped ? Number(skipped[1]) : 0;
  return { total: pass + fail + skip, pass, fail, skip };
}

// Parse the set of failing test node-ids from pytest's `FAILED path::test` lines
// (present with -q / default reporting). Used to baseline pre-existing failures so
// the gate blocks only NEW regressions, not reds a human already left in the project.
function parsePytestFailedIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/^FAILED (\S+)/gm)) ids.add(m[1]);
  for (const m of text.matchAll(/^ERROR (\S+)/gm)) ids.add(m[1]);
  return ids;
}

/**
 * Run a project's pytest suite from its OWN directory so BOTH test layouts are
 * discovered (projects/<x>/tests/ AND projects/<x>/scripts/tests/ — the old gate
 * only checked <x>/tests and silently skipped the many projects that use
 * scripts/tests/, e.g. daily-mail-brief). Returns null when the project has no
 * tests at all. Never throws — a nonzero pytest exit (failures) is a normal,
 * expected result we parse, not an error.
 */
async function collectProjectTests(
  projectDir: string,
  repoRoot: string,
  exec: ExecFn
): Promise<{ failedIds: Set<string>; counts?: AuditTestRunCounts } | null> {
  const { stdout: tracked } = await exec(`git ls-files ${projectDir}`, { cwd: repoRoot });
  if (!/(^|\/)tests?\//m.test(tracked) && !/test_.*\.py/m.test(tracked)) return null;
  const python = resolvePythonCommand();
  let out = '';
  try {
    const { stdout, stderr } = await exec(`${python} -m pytest`, { cwd: join(repoRoot, projectDir) });
    out = `${stdout}\n${stderr}`;
  } catch (err: any) {
    // pytest exits nonzero on failures — that's data, not a crash. Capture its output.
    out = `${err?.stdout ?? ''}\n${err?.stderr ?? err?.message ?? ''}`;
  }
  return { failedIds: parsePytestFailedIds(out), counts: parsePytestSummary(out) };
}

function mergeCounts(...counts: Array<AuditTestRunCounts | undefined>): AuditTestRunCounts | undefined {
  const present = counts.filter((c): c is AuditTestRunCounts => !!c);
  if (present.length === 0) return undefined;
  return present.reduce((acc, c) => ({
    total: acc.total + c.total, pass: acc.pass + c.pass, fail: acc.fail + c.fail, skip: acc.skip + c.skip,
  }));
}

async function pollBotHealth(
  checkBot: () => Promise<CheckResult>,
  sleep: (ms: number) => Promise<void>,
  attempts = 10,
  intervalMs = 2000
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const result = await checkBot();
    if (result.status === 'OK') return true;
    await sleep(intervalMs);
  }
  return false;
}

async function runVerificationGate(
  touchedPaths: string[],
  repoRoot: string,
  exec: ExecFn,
  botRestartFn: typeof botRestartCommand,
  checkBotProcessFn: () => Promise<CheckResult>,
  sleep: (ms: number) => Promise<void>,
  targetProjectDir?: string,
  projectBaselineFailures?: Set<string>
): Promise<VerificationOutcome> {
  // pa: build + full suite, always — the substrate everything else (including this module)
  // depends on, cheap enough to run unconditionally as the primary safety net.
  try {
    await exec('npm run build', { cwd: join(repoRoot, 'pa') });
  } catch (err) {
    return { ok: false, excerpt: `pa build failed: ${excerptOf(err)}` };
  }
  let paCounts: AuditTestRunCounts | undefined;
  try {
    const { stdout, stderr } = await exec('npm test', { cwd: join(repoRoot, 'pa') });
    paCounts = parseNodeTestSummary(stdout) ?? parseNodeTestSummary(stderr);
  } catch (err) {
    return { ok: false, excerpt: `pa test suite failed: ${excerptOf(err)}` };
  }

  const botTouched = touchedPaths.some((p) => p.startsWith('projects/telegram-bot/'));
  let botCounts: AuditTestRunCounts | undefined;
  if (botTouched) {
    try {
      await exec('npm run build', { cwd: join(repoRoot, 'projects/telegram-bot') });
    } catch (err) {
      return { ok: false, excerpt: `bot build failed: ${excerptOf(err)}` };
    }
    try {
      const { stdout, stderr } = await exec('npm test', { cwd: join(repoRoot, 'projects/telegram-bot') });
      botCounts = parseNodeTestSummary(stdout) ?? parseNodeTestSummary(stderr);
    } catch (err) {
      return { ok: false, excerpt: `bot test suite failed: ${excerptOf(err)}` };
    }

    await botRestartFn();
    const healthy = await pollBotHealth(checkBotProcessFn, sleep);
    if (!healthy) {
      return { ok: false, excerpt: 'bot restart triggered but the health check never confirmed the bot came back up' };
    }
  }

  // Touched project's pytest suite — tested from the project dir so both
  // tests/ and scripts/tests/ layouts are found. Blocks only NEW failures
  // (post minus the pre-fix baseline), so a project carrying pre-existing reds
  // a human left in place doesn't permanently freeze autonomous fixes to it,
  // while a genuine regression the fix introduced still reverts.
  let projectCounts: AuditTestRunCounts | undefined;
  const rawProjectDir = targetProjectDir
    ?? touchedPaths.find((p) => p.startsWith('projects/') && !p.startsWith('projects/telegram-bot/'))
      ?.split('/').slice(0, 2).join('/');
  // telegram-bot is a node project verified by the bot npm-test arm above, not pytest.
  const projectDir = rawProjectDir && !rawProjectDir.startsWith('projects/telegram-bot')
    ? rawProjectDir : undefined;
  if (projectDir) {
    const post = await collectProjectTests(projectDir, repoRoot, exec);
    if (post) {
      projectCounts = post.counts;
      const baseline = projectBaselineFailures ?? new Set<string>();
      const newFailures = [...post.failedIds].filter((id) => !baseline.has(id));
      if (newFailures.length > 0) {
        return { ok: false, excerpt: `${projectDir}: fix introduced ${newFailures.length} new test failure(s): ${newFailures.slice(0, 5).join(', ')}` };
      }
    }
  }

  return { ok: true, testRunCounts: mergeCounts(paCounts, botCounts, projectCounts) };
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

function buildCommitMessage(proposal: DraftProposal, evidence: FailureRecord[]): string {
  const evidenceBlock = evidence.length > 0
    ? evidence.slice(0, 5).map((f) => `- [${f.timestamp}] ${f.error}`).join('\n')
    : '(no recorded failure evidence)';

  return `autonomous-code-fix: ${proposal.name}

Target: ${proposal.target_skill ?? proposal.name}
Reason: ${proposal.reason}

Evidence:
${evidenceBlock}

Autonomous-Code-Fix: ${proposal.name}
Audit: self-improver-audit.jsonl
`;
}

function parseCommitHash(commitStdout: string): string | undefined {
  const m = commitStdout.match(/\[[^\]]*?\s([0-9a-f]{4,40})\]/);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// attemptCodeFix
// ---------------------------------------------------------------------------

export async function attemptCodeFix(
  proposal: DraftProposal,
  evidence: FailureRecord[],
  opts: CodeFixOptions = {}
): Promise<CodeFixResult> {
  const exec = opts.execFn ?? defaultExec;
  const runner = opts.runner ?? runWithFailover;
  const botRestartFn = opts.botRestartFn ?? botRestartCommand;
  const checkBotProcessFn = opts.checkBotProcessFn ?? checkBotProcess;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const baseAudit = {
    ts: new Date().toISOString(),
    draft: proposal.name,
    source_type: 'failure' as const,
    target_skill: proposal.target_skill,
    risk_flags: [] as string[],
    reason: proposal.reason,
    evidence_excerpt: evidence.slice(0, 10).map((f) => `[${f.timestamp}] ${f.error}`).join('\n').slice(0, 2000),
  };

  if (!proposal.target_skill) {
    const reason = `Proposal '${proposal.name}' has no target_skill — code-fixer requires a cmd-based skill target in v1.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-worker-failed', reason });
    return { outcome: 'code-fix-skipped-no-target', reason };
  }

  let target;
  try {
    target = await loadSkill(proposal.target_skill);
  } catch (err: any) {
    const reason = `Could not load target skill '${proposal.target_skill}': ${err.message}`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-worker-failed', reason });
    return { outcome: 'code-fix-skipped-no-target', reason };
  }
  if (!target.frontmatter.cwd) {
    const reason = `Target skill '${proposal.target_skill}' has no cwd — cannot resolve a project directory to fix.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-worker-failed', reason });
    return { outcome: 'code-fix-skipped-no-target', reason };
  }

  let repoRoot: string;
  try {
    const { stdout } = await exec('git rev-parse --show-toplevel');
    repoRoot = stdout.trim();
  } catch (err) {
    const reason = `Could not determine repo root: ${excerptOf(err)}`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-worker-failed', reason });
    return { outcome: 'code-fix-skipped-no-target', reason };
  }

  const { stdout: branchRaw } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
  const branch = branchRaw.trim();

  // F4: working-tree-clean precondition — never mix an autonomous diff with human WIP.
  const preExisting = await getWorkingTreePaths(exec, repoRoot);
  if (preExisting.length > 0) {
    const reason = `Working tree has ${preExisting.length} uncommitted change(s) — refusing to run: ${preExisting.slice(0, 5).join(', ')}`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-dirty-worktree', reason });
    return { outcome: 'code-fix-skipped-dirty-worktree', reason };
  }

  const { stdout: preFixHeadRaw } = await exec('git rev-parse HEAD', { cwd: repoRoot });
  const preFixHead = preFixHeadRaw.trim();

  const projectRelDir = normalizePath(relative(repoRoot, target.frontmatter.cwd));

  // F3 baseline: capture the target project's PRE-FIX failing tests, on a clean
  // tree, before the worker touches anything — so the post-fix gate can tell a
  // regression the fix introduced from reds a human already left in the project.
  // (telegram-bot is a node project checked by the bot npm-test arm, not pytest.)
  const preFixProject = projectRelDir.startsWith('projects/telegram-bot')
    ? null
    : await collectProjectTests(projectRelDir, repoRoot, exec).catch(() => null);
  const projectBaselineFailures = preFixProject?.failedIds ?? new Set<string>();

  const brief = buildCodeFixBrief(proposal, evidence, projectRelDir);

  const { result: workerResult } = await runner(brief, {
    resource: `self-improver-code-fix-${proposal.name}`,
    preferredWorker: 'zclaude',
    timeout: 1800,
    idleTimeout: 300,
  });

  if (!workerResult.success) {
    const reason = `Coding worker failed: ${(workerResult.error ?? 'unknown').slice(0, 300)}`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-worker-failed', reason });
    return { outcome: 'code-fix-skipped-worker-failed', reason };
  }

  const touchedPaths = await getWorkingTreePaths(exec, repoRoot);
  if (touchedPaths.length === 0) {
    const reason = 'Coding worker completed but made no file changes.';
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-no-changes', reason });
    return { outcome: 'code-fix-skipped-no-changes', reason };
  }

  // F1: protected-path diff inspection.
  const protectedTouched = touchedPaths.filter(isProtectedPath);
  if (protectedTouched.length > 0) {
    await hardRevert(exec, repoRoot, preFixHead);
    const reason = `Coding worker touched protected path(s): ${protectedTouched.join(', ')} — reverted.`;
    await appendAuditRecord({ ...baseAudit, action: 'reverted-protected-path', reason, files_changed: touchedPaths });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F5 (diff-inspection half): data-destruction guard.
  const guardedTouched = touchedPaths.filter(touchesGuardedDataPath);
  if (guardedTouched.length > 0) {
    await hardRevert(exec, repoRoot, preFixHead);
    const reason = `Coding worker touched a guarded data/secrets path: ${guardedTouched.join(', ')} — reverted.`;
    await appendAuditRecord({ ...baseAudit, action: 'reverted-protected-path', reason, files_changed: touchedPaths });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F2: test-integrity guard — net deletions in an existing test file.
  const numstat = await getNumstat(exec, repoRoot, preFixHead);
  const weakened = numstat.filter((n) => isExistingTestFile(n.path) && n.deleted > n.added);
  if (weakened.length > 0) {
    await hardRevert(exec, repoRoot, preFixHead);
    const reason = `Net test deletions in existing test file(s): ${weakened.map((w) => w.path).join(', ')} — reverted.`;
    await appendAuditRecord({ ...baseAudit, action: 'reverted-test-weakening', reason, files_changed: touchedPaths });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F3: post-apply verification gate — build + full relevant suites (+ bot restart/health).
  const verification = await runVerificationGate(touchedPaths, repoRoot, exec, botRestartFn, checkBotProcessFn, sleep, projectRelDir, projectBaselineFailures);
  if (!verification.ok) {
    await hardRevert(exec, repoRoot, preFixHead);
    const reason = `Verification failed: ${verification.excerpt ?? 'unknown failure'} — reverted.`;
    await appendAuditRecord({
      ...baseAudit, action: 'reverted-verification-failed', reason, files_changed: touchedPaths,
      test_run_counts: verification.testRunCounts,
    });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F6: commit + push PRIVATE origin only (plain `git` always resolves to .git, never
  // .git-public — this module never invokes git-public.ps1/.cmd or passes --git-dir).
  //
  // Pathspec-limited staging (2026-07-21, do NOT regress to a bare `git add -A`): the bare
  // form swept the nightly pa/data/profile* churn into the fix commit itself, which made every
  // autonomous fix commit UN-REVERTABLE by construction — `git revert` aborts on "local changes
  // to pa/data/profile.json would be overwritten by merge" as soon as learn_agent has rewritten
  // it again (see DIRTY_IGNORE_PREFIXES for the 7b82c88 incident). `touchedPaths` already
  // excludes the churn, so it is exactly the set the coding worker changed. The pathspec-limited
  // `git reset` first is belt-and-suspenders against churn that was somehow already staged: it
  // only rewrites the INDEX entry, never the working tree, so no profile data is touched.
  const commitPathspec = touchedPaths.map((p) => `"${p}"`).join(' ');
  await exec(`git reset -q HEAD -- ${CHURN_PATHSPEC_ARGS}`, { cwd: repoRoot }).catch(() => {});
  await exec(`git add -A -- ${commitPathspec}`, { cwd: repoRoot });
  const commitMessage = buildCommitMessage(proposal, evidence);
  const tmpDir = await mkdtemp(join(tmpdir(), 'pa-code-fix-'));
  const msgPath = join(tmpDir, 'commit-message.txt');
  let commitHash: string | undefined;
  try {
    await writeFile(msgPath, commitMessage, 'utf8');
    const { stdout: commitStdout } = await exec(`git commit -F "${msgPath}"`, { cwd: repoRoot });
    commitHash = parseCommitHash(commitStdout);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  await exec(`git push origin ${branch}`, { cwd: repoRoot });

  const reason = `Applied and pushed autonomous code fix for '${proposal.target_skill}' (commit ${commitHash ?? 'unknown'}).`;
  await appendAuditRecord({
    ...baseAudit,
    action: 'applied-code-fix',
    reason,
    commit_hash: commitHash,
    files_changed: touchedPaths,
    test_run_counts: verification.testRunCounts,
    baseline: toAuditBaseline(await skillRunStats(proposal.target_skill, 14)),
  });

  return { outcome: 'applied-code-fix', reason, commitHash, filesChanged: touchedPaths, testRunCounts: verification.testRunCounts };
}
