import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { createHash, randomUUID } from 'crypto';
import { loadSkill } from './skills.js';
import { runWithFailover } from './workers.js';
import { botRestartCommand } from './commands/bot.js';
import { checkBotProcess } from './commands/health.js';
import { exclusiveLockKey } from './commands/run.js';
import { blackboard, startLockRenewal } from './blackboard.js';
import { appendAuditRecord, skillRunStats, toAuditBaseline } from './lib/improvement-audit.js';
import { resolvePythonCommand } from './lib/python.js';
import { recentActivity } from './commands/claim.js';
import { readActive } from './lib/reservations.js';
import { withBuildLock } from './lib/build-lock.js';
import { parsePorcelainPaths } from './lib/git-status.js';
import { checkGitWorkflowAllowed } from './lib/git-guard.js';
import type { GitGuardResult } from './lib/git-guard.js';
import type { DraftProposal, Skill } from './types.js';
import type { FailureRecord } from './failure-analyzer.js';
import type { AuditTestRunCounts } from './lib/improvement-audit.js';
import type { CheckResult } from './commands/health.js';

// C12: re-exported (not just imported) because self-improver.ts:30 imports
// parsePorcelainPaths from THIS module, not from lib/git-status.ts directly.
export { parsePorcelainPaths };

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
//   F5. Blast-radius bounds — per-run: one attempt per target skill, disjoint files across a
//       run's applied fixes (same-run-overlap guard below), wall-clock budget (all three
//       enforced by self-improver.ts's orchestrator / this module's diff inspection; the
//       pre-2026-08-23 global one-fix-per-night cap is gone — see
//       plans/2026-08-23-code-fix-multi-per-night-SPEC.md) + the data-destruction guard
//       (touchesGuardedDataPath).
//   F6. Commit + push PRIVATE origin only. NEVER the public mirror (.git-public) — this
//       module only ever calls plain `git`, which always resolves to `.git`.
// ---------------------------------------------------------------------------

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (command: string, options?: { cwd?: string }) => Promise<ExecResult>;

const defaultExec: ExecFn = promisify(execCb);

// ---------------------------------------------------------------------------
// git-workflow lock (2026-08-05) — attemptCodeFix mutates this repo's shared git
// working tree directly (git commit/push/reset --hard/clean -fd), entirely
// outside the skill-frontmatter exclusive_resource mechanism the commit/push/
// push-public/investigate-flagged/update-brain skill family already uses. It
// takes the SAME blackboard lock so a nightly autonomous fix can never race a
// concurrent manual /commit or /push. See plans/federated-booping-hammock.md.
//
// Must match the `exclusive_resource:` value in all five git-workflow skill.md
// files — changing this string without changing them silently disables the
// mutual exclusion.
export const GIT_WORKFLOW_RESOURCE = 'git-workflow';
// Real skill timeouts are commit=600s, push/push-public=3600s,
// investigate-flagged=1800s — 5 min comfortably outlasts a typical /commit
// without pretending it could ever outwait a /push; it's 8% of self-improver's
// own 3600s skill budget; and a missed night self-heals on the next cron.
export const GIT_LOCK_WAIT_MS = 300_000;
const LOCK_HEARTBEAT_MS = 60_000;
const CODE_FIX_LOCK_AGENT = 'self-improver-code-fix';

// Narrowed-Pick DI, mirrors worker-exec.ts's `bb: Pick<typeof blackboard, 'acquireLock'>`
// precedent. Exported so self-improver.ts's rollback() reuses the same shape.
export type BlackboardLockClient = Pick<typeof blackboard, 'acquireLock' | 'updateHeartbeat' | 'releaseLock'>;

export type CodeFixOutcome =
  | 'applied-code-fix'
  | 'code-fix-reverted'
  | 'code-fix-skipped-no-target'
  | 'code-fix-skipped-dirty-worktree'
  | 'code-fix-skipped-worker-failed'
  | 'code-fix-skipped-no-changes'
  | 'code-fix-skipped-git-lock-busy'
  | 'code-fix-skipped-stranger-overlap'
  | 'code-fix-skipped-staged-mismatch'
  | 'code-fix-skipped-concurrent-activity'
  // 2026-08-23 (F5 rework, plans/2026-08-23-code-fix-multi-per-night-SPEC.md): the global
  // one-fix-per-night cap is gone; these three replace it as the per-run bounds.
  | 'code-fix-skipped-same-run-overlap'      // code-fixer: diff touches a file an earlier fix THIS run already changed
  | 'code-fix-skipped-target-already-attempted' // orchestrator: one attempt per target skill per run
  | 'code-fix-skipped-budget-exhausted'      // orchestrator: per-run wall-clock budget spent
  | 'code-fix-skipped-git-disabled';         // git-optional gate: git_workflow disabled or not a work tree

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
  blackboardFn?: BlackboardLockClient;
  /** Test-only: overrides LOCK_HEARTBEAT_MS so heartbeat tests don't need to wait 60s. */
  lockHeartbeatMs?: number;
  /** Test-only: overrides recentActivity probe. */
  recentActivityFn?: () => Promise<string[]>;
  /** Test-only: overrides readActive probe. */
  readActiveFn?: () => Promise<import('./lib/reservations.js').Reservation[]>;
  /** Test-only: overrides withBuildLock so tests never touch the real reservation store. */
  withBuildLockFn?: typeof withBuildLock;
  /** Test-only: overrides the git-optional gate (2026-08-31 WP-B). */
  gitGuardFn?: () => Promise<GitGuardResult>;
  /**
   * Repo-relative paths changed by code fixes ALREADY APPLIED earlier in the same nightly
   * run (2026-08-23 F5 rework). A diff that touches any of them is reverted and recorded as
   * 'code-fix-skipped-same-run-overlap': every applied fix must stay independently
   * `git revert`-able, and a second commit on the same file would make reverting the first
   * one conflict. Orchestrator-supplied; empty/undefined = first fix of the run.
   */
  sameRunAppliedFiles?: string[];
}

// --- F1: protected framework paths — the loop's own execution/audit/rollback chain and the
// repo-boundary tooling. Never touched, no matter what the coding worker's diff contains. ---

const PROTECTED_CODE_EXACT = new Set([
  'pa/src/self-improver.ts',
  'pa/src/validator.ts',
  'pa/src/analyzer.ts',
  'pa/src/failure-analyzer.ts',
  'pa/src/feedback-analyzer.ts',
  'pa/src/lib/feedback-rules.ts',
  'pa/src/commands/rules.ts',
  'pa/src/drafts.ts',
  'pa/src/lib/improvement-audit.ts',
  'pa/src/code-fixer.ts',
  'pa/src/commands/improvements.ts',
  'pa/bin/pa.ts',
  'projects/telegram-bot/src/rules-critic.ts',
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

async function hardRevert(exec: ExecFn, repoRoot: string, preFixHead: string, paths: string[]): Promise<void> {
  const opts = { cwd: repoRoot };
  // Scoped revert (2026-08-15): only the worker's own touched paths are reverted, not the
  // entire tree. This allows out-of-scope WIP to coexist with autonomous fixes. Churn is still
  // stashed/pop'd across the operation — pa/data/profile* files are never reverted or cleaned.
  // Before 2026-08-15, this used tree-wide `git reset --hard` + bare `git clean -fd`, which
  // forced F4 to refuse on ANY dirty path. The new scoped revert enables F4 v2's scoped gate.
  //
  // Split into three buckets to avoid throwing on worker-created staged files (which don't
  // exist at preFixHead and would cause `git checkout` to error):
  //   1. existsAtPreFixHead: restore via `git checkout ${preFixHead} -- <path>`
  //   2. stagedNew: remove via `git rm -q -f -- <path>` (drops from index AND disk)
  //   3. untracked: remove via `git clean -fd -- <path>`
  const stashed = await stashChurn(exec, `pa-code-fix-revert-${preFixHead}`, opts);
  try {
    const pathspec = paths.map((p) => `"${p}"`).join(' ');

    // Bucket 1: files that exist at preFixHead (in the tree at that commit)
    const { stdout: lsTreeOut } = await exec(`git ls-tree --name-only ${preFixHead} -- ${pathspec}`, opts);
    const existsAtPreFixHead = lsTreeOut.trim().split('\n').filter((p) => p.length > 0).map((p) => normalizePath(p));

    // Bucket 2: files in the index but NOT at preFixHead (worker-created, staged new files)
    const { stdout: lsFilesOut } = await exec(`git ls-files -- ${pathspec}`, opts);
    const staged = lsFilesOut.trim().split('\n').filter((p) => p.length > 0).map((p) => normalizePath(p));
    const stagedSet = new Set(staged);
    const existsAtPreFixHeadSet = new Set(existsAtPreFixHead);
    const stagedNew = staged.filter((p) => !existsAtPreFixHeadSet.has(p));

    // Bucket 3: untracked files (not in the index)
    const untracked = paths.filter((p) => !stagedSet.has(p));

    // Apply each bucket's cleanup only when non-empty — each command must succeed without throwing
    if (existsAtPreFixHead.length > 0) {
      const existsPathspec = existsAtPreFixHead.map((p) => `"${p}"`).join(' ');
      await exec(`git checkout ${preFixHead} -- ${existsPathspec}`, opts);
    }
    if (stagedNew.length > 0) {
      const stagedNewPathspec = stagedNew.map((p) => `"${p}"`).join(' ');
      await exec(`git rm -q -f -- ${stagedNewPathspec}`, opts);
    }
    if (untracked.length > 0) {
      const untrackedPathspec = untracked.map((p) => `"${p}"`).join(' ');
      await exec(`git clean -fd -- ${untrackedPathspec}`, opts);
    }
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

  // 2026-08-23 (alerts wave, WP-J2a): a maintenance-job target has no project directory of its
  // own to name — it names the declared job and the ledger error that triggered the proposal
  // instead, and its scope instruction points at the job's own source file rather than a dir.
  const isJobTarget = proposal.target_kind === 'maintenance-job';
  const targetBlock = isJobTarget
    ? `Declared maintenance job: ${proposal.target_skill}\nJob file: ${proposal.code_target ?? ''}\nLedger error: ${evidence[0]?.error ?? '(none recorded)'}`
    : `Project directory: ${projectRelDir}\n${proposal.code_target ? `Likely file: ${proposal.code_target}` : ''}`;
  const scopeTarget = isJobTarget ? `\`${proposal.code_target}\` and its test file` : projectRelDir;

  return `You are fixing a recurring bug in an automated skill's own script — not its LLM prompt (this skill's prompt is documentation only; the real behavior lives in the code below).

## Target
${targetBlock}

## Recorded failure evidence (last 14 days)
${evidenceBlock}

## Why this fix was proposed
${proposal.reason}

## Requirements
1. Write a failing test FIRST that reproduces the recorded failure (TDD), confirm it fails, then fix the code so it passes. Add new test files or add lines to existing tests — do not weaken or delete existing test coverage.
2. Scope your changes to ${scopeTarget} only. Do NOT touch any of the following protected paths under any circumstances — these are the self-improvement loop's own execution/audit/rollback machinery and repo-boundary tooling:
${PROTECTED_LIST_TEXT}
3. Data-destruction guard: do not touch, modify, or delete anything under a data/ directory, any .env file, or anything with "secrets" in its name or path. Do not run the live skill itself as a form of validation — tests only.
4. Run the relevant test suite yourself before declaring done, and only declare done if it passes.
5. Do NOT commit, push, or invoke any git-workflow skill (e.g. \`pa run commit\`) — leave your changes uncommitted. The caller already holds this repo's git-workflow lock and will commit and push on your behalf. This overrides this repo's usual CLAUDE.md directive that all commits/pushes go through the git-workflow skill family — that directive does not apply to this task.

Make the minimal change that fixes the recorded failure. Do not refactor unrelated code.`;
}

// ---------------------------------------------------------------------------
// Verification gate (F3)
// ---------------------------------------------------------------------------

interface VerificationOutcome {
  ok: boolean;
  excerpt?: string;
  testRunCounts?: AuditTestRunCounts;
  /** Which verification arms ran (2026-08-23 WP-J2a scoped gate): any of 'pa-node',
   *  'pa-pytest', 'bot-node', 'project-pytest', 'py-compile'. Surfaced into the audit
   *  record's `reason` text (a sibling of test_run_counts) so a human reading the trail can
   *  tell which gates actually covered a given fix. */
  gates?: string[];
}

function excerptOf(err: unknown): string {
  const e = err as { message?: string; stdout?: string; stderr?: string };
  return (e.stderr || e.stdout || e.message || String(err)).slice(0, 500);
}

/** Formats VerificationOutcome.gates for embedding into an audit record's `reason` text —
 *  chosen over a new top-level AuditRecord field (2026-08-23 WP-J2a: pa/src/lib/improvement-
 *  audit.ts is not owned by this wave's code-fixer work package). Empty/undefined → ''. */
function gatesSuffixText(gates?: string[]): string {
  return gates && gates.length > 0 ? ` Gates run: ${gates.join(', ')}.` : '';
}

/**
 * Verification-gate diagnosability (2026-08-23 F5 rework,
 * plans/2026-08-23-code-fix-multi-per-night-SPEC.md): a bare 500-char slice of raw `npm test`
 * output rarely lands on the actual failure — two 08-19/08-20 reverts were unexplainable from
 * the audit trail because of it. TAP's `not ok` lines and the `# tests/# pass/# fail` summary
 * are what actually matter, so pull those out instead. Falls back to excerptOf(err) (first 500
 * chars) when the output carries no `not ok` line (e.g. a non-TAP failure).
 */
export function testFailureExcerpt(err: unknown): string {
  const e = err as { message?: string; stdout?: string; stderr?: string };
  const text = `${e.stderr ?? ''}\n${e.stdout ?? ''}`;
  const notOkLines = text.match(/^not ok\b.*$/gm) ?? [];
  if (notOkLines.length === 0) return excerptOf(err);
  const summaryLines = text.match(/^# (tests|pass|fail) \d+$/gm) ?? [];
  return [...notOkLines.slice(0, 8), ...summaryLines].join('\n').slice(0, 1000);
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

/**
 * Run pa/scripts/tests (pa's own Python helper-script suite) from the repo root. Mirrors
 * collectProjectTests' new-failures-only pattern but targets a fixed directory rather than a
 * project's own layout — added 2026-08-23 (WP-J2a scoped verification) so a fix touching
 * pa/scripts/**.py or pa/src/**.py gets Python coverage the pa node suite alone can't provide.
 * Never throws — pytest's nonzero exit on failures is data, not a crash.
 */
async function collectPaPyTests(
  repoRoot: string,
  exec: ExecFn
): Promise<{ failedIds: Set<string>; counts?: AuditTestRunCounts }> {
  const python = resolvePythonCommand();
  let out = '';
  try {
    const { stdout, stderr } = await exec(`${python} -m pytest pa/scripts/tests -q`, { cwd: repoRoot });
    out = `${stdout}\n${stderr}`;
  } catch (err: any) {
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

/**
 * Scoped verification (2026-08-23, plans/2026-08-23-alerts-wave-SPEC.md WP-J2a). Previously
 * this ran the pa build + full pa node suite unconditionally on every fix regardless of what
 * it touched — 12-20 min per fix on this machine, and an unexplained-cause candidate behind
 * two 2026-08-19/20 reverts the audit trail couldn't diagnose (review §4). Invariant: a fix
 * may only skip a gate that its own touched paths provably cannot affect.
 *
 *   any pa/**, .github/**, or a repo-root config path -> pa build + pa npm test
 *   any pa/scripts/**.py or pa/src/**.py               -> additionally pytest pa/scripts/tests
 *   any projects/telegram-bot/**                       -> bot build + bot npm test + restart/health
 *   ONLY projects/<x>/** (x != telegram-bot)            -> py_compile + that project's pytest,
 *                                                          and NOTHING else
 */
async function runVerificationGate(
  touchedPaths: string[],
  repoRoot: string,
  exec: ExecFn,
  botRestartFn: typeof botRestartCommand,
  checkBotProcessFn: () => Promise<CheckResult>,
  sleep: (ms: number) => Promise<void>,
  targetProjectDir?: string,
  projectBaselineFailures?: Set<string>,
  paPyBaselineFailures?: Set<string>
): Promise<VerificationOutcome> {
  const gates: string[] = [];
  const paTouched = touchedPaths.some((p) => p.startsWith('pa/') || p.startsWith('.github/') || !p.includes('/'));

  let paCounts: AuditTestRunCounts | undefined;
  if (paTouched) {
    gates.push('pa-node');
    try {
      await exec('npm run build', { cwd: join(repoRoot, 'pa') });
    } catch (err) {
      return { ok: false, excerpt: `pa build failed: ${excerptOf(err)}`, gates };
    }
    try {
      const { stdout, stderr } = await exec('npm test', { cwd: join(repoRoot, 'pa') });
      paCounts = parseNodeTestSummary(stdout) ?? parseNodeTestSummary(stderr);
    } catch (err) {
      return { ok: false, excerpt: `pa test suite failed: ${testFailureExcerpt(err)}`, gates };
    }
  }

  // Additional Python arm for pa's own scripts — only when the diff actually touches a pa
  // Python file; the pa node suite above does not exercise pa/scripts/tests at all.
  const paPyTouched = touchedPaths.some((p) => /^pa\/(scripts|src)\/.*\.py$/.test(p));
  let paPyCounts: AuditTestRunCounts | undefined;
  if (paPyTouched) {
    gates.push('pa-pytest');
    const post = await collectPaPyTests(repoRoot, exec);
    paPyCounts = post.counts;
    const baseline = paPyBaselineFailures ?? new Set<string>();
    const newFailures = [...post.failedIds].filter((id) => !baseline.has(id));
    if (newFailures.length > 0) {
      return { ok: false, excerpt: `pa/scripts/tests: fix introduced ${newFailures.length} new test failure(s): ${newFailures.slice(0, 5).join(', ')}`, gates };
    }
  }

  const botTouched = touchedPaths.some((p) => p.startsWith('projects/telegram-bot/'));
  let botCounts: AuditTestRunCounts | undefined;
  if (botTouched) {
    gates.push('bot-node');
    try {
      await exec('npm run build', { cwd: join(repoRoot, 'projects/telegram-bot') });
    } catch (err) {
      return { ok: false, excerpt: `bot build failed: ${excerptOf(err)}`, gates };
    }
    try {
      const { stdout, stderr } = await exec('npm test', { cwd: join(repoRoot, 'projects/telegram-bot') });
      botCounts = parseNodeTestSummary(stdout) ?? parseNodeTestSummary(stderr);
    } catch (err) {
      return { ok: false, excerpt: `bot test suite failed: ${testFailureExcerpt(err)}`, gates };
    }

    await botRestartFn();
    const healthy = await pollBotHealth(checkBotProcessFn, sleep);
    if (!healthy) {
      return { ok: false, excerpt: 'bot restart triggered but the health check never confirmed the bot came back up', gates };
    }
  }

  // Project-only case: neither pa nor bot touched, and every touched path belongs to one
  // non-bot project. py_compile catches a syntax error before pytest would even collect it;
  // pytest itself is the same new-failures-only gate the pre-scoping code always ran, tested
  // from the project dir so both tests/ and scripts/tests/ layouts are found.
  let projectCounts: AuditTestRunCounts | undefined;
  const rawProjectDir = targetProjectDir
    ?? touchedPaths.find((p) => p.startsWith('projects/') && !p.startsWith('projects/telegram-bot/'))
      ?.split('/').slice(0, 2).join('/');
  // telegram-bot is a node project verified by the bot npm-test arm above, not pytest.
  const projectDir = rawProjectDir && !rawProjectDir.startsWith('projects/telegram-bot')
    ? rawProjectDir : undefined;
  const projectOnly = !paTouched && !botTouched && projectDir !== undefined;
  if (projectOnly) {
    const changedPyFiles = touchedPaths.filter((p) => p.startsWith(`${projectDir}/`) && p.endsWith('.py'));
    if (changedPyFiles.length > 0) {
      gates.push('py-compile');
      try {
        await exec(`${resolvePythonCommand()} -m py_compile ${changedPyFiles.join(' ')}`, { cwd: repoRoot });
      } catch (err) {
        return { ok: false, excerpt: `py_compile failed: ${excerptOf(err)}`, gates };
      }
    }
    gates.push('project-pytest');
    const post = await collectProjectTests(projectDir, repoRoot, exec);
    if (post) {
      projectCounts = post.counts;
      const baseline = projectBaselineFailures ?? new Set<string>();
      const newFailures = [...post.failedIds].filter((id) => !baseline.has(id));
      if (newFailures.length > 0) {
        return { ok: false, excerpt: `${projectDir}: fix introduced ${newFailures.length} new test failure(s): ${newFailures.slice(0, 5).join(', ')}`, gates };
      }
    }
  }

  return { ok: true, testRunCounts: mergeCounts(paCounts, paPyCounts, botCounts, projectCounts), gates };
}

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

function buildCommitMessage(proposal: DraftProposal, evidence: FailureRecord[]): string {
  const evidenceBlock = evidence.length > 0
    ? evidence.slice(0, 5).map((f) => `- [${f.timestamp}] ${f.error}`).join('\n')
    : '(no recorded failure evidence)';

  // 2026-08-23 (alerts wave, WP-J2a): distinguish a maintenance-job fix's commit subject from
  // an ordinary skill fix — the Target: line below already names the job via target_skill.
  const subject = proposal.target_kind === 'maintenance-job'
    ? `autonomous-code-fix: maintenance-job ${proposal.target_skill}`
    : `autonomous-code-fix: ${proposal.name}`;

  return `${subject}

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

  // 2026-08-23 (alerts wave, WP-J2a): what target_skill names. Explicit `const` type
  // annotation (not `as const`) so the literal union survives into baseAudit below without
  // widening to `string` — pa/src/lib/improvement-audit.ts's AuditRecord isn't imported here,
  // so this can't be cross-checked via an `as AuditRecord['target_kind']` cast.
  const targetKind: 'skill' | 'maintenance-job' = proposal.target_kind ?? 'skill';
  const baseAudit = {
    ts: new Date().toISOString(),
    draft: proposal.name,
    source_type: 'failure' as const,
    target_skill: proposal.target_skill,
    target_kind: targetKind,
    risk_flags: [] as string[],
    reason: proposal.reason,
    evidence_excerpt: evidence.slice(0, 10).map((f) => `[${f.timestamp}] ${f.error}`).join('\n').slice(0, 2000),
  };

  if (!proposal.target_skill) {
    const reason = `Proposal '${proposal.name}' has no target_skill — code-fixer requires a cmd-based skill target in v1.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-worker-failed', reason });
    return { outcome: 'code-fix-skipped-no-target', reason };
  }
  // Captured as its own (non-optional) binding for the same reason as `target` above:
  // runBody() is a nested closure, so the narrowing this early-return performs on
  // proposal.target_skill itself doesn't carry across the function boundary.
  const targetSkillName = proposal.target_skill;

  // Git-optional gate (2026-08-31, plans/2026-08-31-git-optional-SPEC.md): this
  // lane commits and pushes on the user's behalf. Unless the deployment opted
  // in (git_workflow.enabled — absent block = legacy-allowed) AND we are inside
  // a git work tree, skip the whole lane: the nightly loop degrades to
  // analysis + skill-draft proposals, exactly like the other skip outcomes.
  const gitGuard = await (opts.gitGuardFn ?? checkGitWorkflowAllowed)();
  if (!gitGuard.allowed) {
    const reason = `Git not allowed — ${gitGuard.reason}. Code-fix lane skipped; analysis and skill-draft proposals unaffected.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-git-disabled', reason });
    return { outcome: 'code-fix-skipped-git-disabled', reason };
  }

  // 2026-08-23 (alerts wave, WP-J2a): a maintenance-job target has no skill.md to load — its
  // "target" is a declared MaintenanceJob whose source file is proposal.code_target instead.
  const isJobTarget = targetKind === 'maintenance-job';
  if (isJobTarget) {
    if (!proposal.code_target || !proposal.code_target.startsWith('pa/src/lib/maintenance/jobs/')) {
      const reason = `Proposal '${proposal.name}' targets maintenance job '${proposal.target_skill}' but code_target '${proposal.code_target ?? ''}' is not under pa/src/lib/maintenance/jobs/.`;
      await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-worker-failed', reason });
      return { outcome: 'code-fix-skipped-no-target', reason };
    }
  }

  // Explicitly typed (not inferred) because runBody(), a nested function declared further
  // down, closes over this variable — TypeScript's control-flow narrowing for a bare `let`
  // doesn't carry across a function boundary, so an inferred `any` would silently widen.
  // Stays undefined for a maintenance-job target, which skips loadSkill entirely.
  let target: Skill | undefined;
  if (!isJobTarget) {
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

  // Same cross-closure narrowing reason as `target`/`targetSkillName` above. A maintenance-job
  // fix has no project directory of its own — pointing targetCwd at the repo root makes
  // projectRelDir (below) compute to '', so the job's diff is verified by the pa gate only,
  // never a nonexistent "project" pytest suite.
  const targetCwd = isJobTarget ? repoRoot : target!.frontmatter.cwd!;

  const { stdout: branchRaw } = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
  const branch = branchRaw.trim();

  // git-workflow lock: acquired here — right after repoRoot/branch resolve, before the
  // quiet-tree gate — not just around the final commit/push. The quiet-tree gate means
  // nothing if another process can dirty the tree right after the check; the coding worker
  // writes into the shared tree for up to 30 minutes, entirely before any commit happens;
  // and hardRevert()'s scoped revert (the most destructive operation in this file) runs
  // on every F1/F2/F3 failure path, not just F6. See buildCodeFixBrief's requirement 5
  // (above), which the coding worker's brief cross-references: it must not invoke a
  // git-workflow skill of its own while this lock is held.
  const bb = opts.blackboardFn ?? blackboard;
  const lockKey = exclusiveLockKey(GIT_WORKFLOW_RESOURCE);
  const contextId = randomUUID();
  const lockAcquired = await bb.acquireLock(lockKey, CODE_FIX_LOCK_AGENT, process.pid, GIT_LOCK_WAIT_MS, contextId);
  if (!lockAcquired) {
    const reason = `Skipped: another skill/process is holding exclusive_resource "${GIT_WORKFLOW_RESOURCE}" — waited ${Math.round(GIT_LOCK_WAIT_MS / 1000)}s.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-git-lock-busy', reason });
    return { outcome: 'code-fix-skipped-git-lock-busy', reason };
  }
  // Set by startLockRenewal's onLost (D2/D3/D4, 2026-08-23): checked in runBody()
  // right after workerPaths is computed, before the stranger-overlap guard.
  let lockLost: 'expired' | 'purged' | undefined;
  const renewal = startLockRenewal(lockKey, CODE_FIX_LOCK_AGENT, contextId, {
    intervalMs: opts.lockHeartbeatMs ?? LOCK_HEARTBEAT_MS,
    client: bb,
    onLost: (reason) => { lockLost = reason; },
  });

  try {
    return await runBody();
  } finally {
    renewal.stop();
    await bb.releaseLock(lockKey, CODE_FIX_LOCK_AGENT, contextId, { pid: process.pid }).catch(() => {});
  }

  async function runBody(): Promise<CodeFixResult> {
  const { stdout: preFixHeadRaw } = await exec('git rev-parse HEAD', { cwd: repoRoot });
  const preFixHead = preFixHeadRaw.trim();

  const projectRelDir = normalizePath(relative(repoRoot, targetCwd));

  // Quiet-tree gate (2026-08-15): proceed only when no concurrent activity is detected.
  // This replaces F4 v2's scoped dirty-path refusal — instead of refusing on dirty paths,
  // we now allow a heavily dirty tree as long as it's stale (finished agent work awaiting
  // commit, not live work). The gate checks two things:
  //   1. No active reservations (readActive) — the self-improver loop itself holds none,
  //      so ANY active reservation means another session declared work.
  //   2. No recent non-churn path modifications (recentActivity filtered by isChurnPath) —
  //      the 15-minute mtime window distinguishes finished work (stale dirt) from live work.
  // Either trips ⇒ skip with outcome code-fix-skipped-concurrent-activity, retry next night.
  // The safety net built earlier (scoped hardRevert, stranger-overlap guard, staged-set
  // verification, narrowed rollback refusal) covers races that slip through.
  //
  // We still compute preExisting (non-churn dirty paths) because the stranger-overlap
  // snapshot and workerPaths isolation need it.
  const recentActivityFn = opts.recentActivityFn ?? recentActivity;
  const readActiveFn = opts.readActiveFn ?? readActive;
  const preExisting = await getWorkingTreePaths(exec, repoRoot);
  const activeReservations = await readActiveFn();
  if (activeReservations.length > 0) {
    const reason = `Active reservations: ${activeReservations.map((r) => `${r.id} (${r.session})`).join(', ')} — deferring to avoid concurrent work.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-concurrent-activity', reason });
    return { outcome: 'code-fix-skipped-concurrent-activity', reason };
  }
  const recent = await recentActivityFn();
  const recentNonChurn = recent.filter((p) => !isChurnPath(p));
  if (recentNonChurn.length > 0) {
    const reason = `Recent non-churn modifications: ${recentNonChurn.slice(0, 5).join(', ')} — deferring to avoid concurrent work.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-concurrent-activity', reason });
    return { outcome: 'code-fix-skipped-concurrent-activity', reason };
  }

  // F3 baseline: capture the target project's PRE-FIX failing tests, on a clean
  // tree, before the worker touches anything — so the post-fix gate can tell a
  // regression the fix introduced from reds a human already left in the project.
  // (telegram-bot is a node project checked by the bot npm-test arm, not pytest.)
  // A maintenance-job target has no project dir (projectRelDir === '') — guarded off
  // (2026-08-23 WP-J2a) so this doesn't run collectProjectTests('', ...) against the whole repo.
  const preFixProject = (!isJobTarget && projectRelDir && !projectRelDir.startsWith('projects/telegram-bot'))
    ? await collectProjectTests(projectRelDir, repoRoot, exec).catch(() => null)
    : null;
  const projectBaselineFailures = preFixProject?.failedIds ?? new Set<string>();

  // Pre-fix baseline for the pa/scripts/tests pytest arm (2026-08-23 WP-J2a scoped gate) —
  // captured the same way as projectBaselineFailures above, before the worker touches
  // anything, so the post-fix gate blocks only NEW failures a fix introduces.
  const preFixPaPy = await collectPaPyTests(repoRoot, exec).catch(() => null);
  const paPyBaselineFailures = preFixPaPy?.failedIds ?? new Set<string>();

  // Pre-flight snapshot for stranger-overlap detection (2026-08-15): hash every preExisting
  // file NOW, before the worker runs, so we can detect if the worker modified a file that was
  // already dirty. If we snapshot post-flight, both reads see the same content and modifications
  // are undetected. Conservative fallback: '<unreadable>' means "assume it changed."
  const preExistingHashes = new Map<string, string>();
  for (const p of preExisting) {
    try {
      const content = await readFile(join(repoRoot, p), 'utf8');
      preExistingHashes.set(p, createHash('sha256').update(content).digest('hex'));
    } catch {
      // If we can't read the file, conservatively assume it might have changed.
      preExistingHashes.set(p, '<unreadable>');
    }
  }

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

  // Post-flight worker-diff isolation (2026-08-15): compute what the worker actually touched
  // by comparing pre-flight and post-flight dirty sets. This isolates the worker's changes from
  // pre-existing out-of-scope WIP that F4 v2 now allows to remain.
  const currentDirty = await getWorkingTreePaths(exec, repoRoot);
  const preExistingSet = new Set(preExisting);
  const workerPaths = currentDirty.filter((p) => !preExistingSet.has(p));

  if (workerPaths.length === 0) {
    const reason = 'Coding worker completed but made no file changes.';
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-no-changes', reason });
    return { outcome: 'code-fix-skipped-no-changes', reason };
  }

  // Lock-loss check (D2/D3/D4, 2026-08-23): the git-workflow lock this run
  // holds may have been purged out from under it while the coding worker ran
  // (up to 30 min). Checked here — after workerPaths exists (hardRevert needs
  // it) and after the no-changes guard, before the stranger-overlap guard —
  // so a lost lock always reverts before any further inspection or the
  // eventual commit. Reuses the existing code-fix-skipped-concurrent-activity
  // outcome/action (C14): the lock was lost BECAUSE another process is
  // concurrently active, so no new closed-union member is needed.
  if (lockLost) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const reason = `Lock lost mid-run (${lockLost}): ${lockKey} was purged while this fix held it — another process may be mutating the tree. Reverted worker paths only, deferring to the next run.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-concurrent-activity', reason, files_changed: workerPaths });
    return { outcome: 'code-fix-skipped-concurrent-activity', reason };
  }

  // Stranger-overlap guard (2026-08-15): if any preExisting file's content CHANGED post-flight,
  // the worker edited a file that already carried someone else's uncommitted work. That file's
  // diff now mixes both changes and must never be committed or reverted. Before 2026-08-15,
  // F4's whole-tree clean check prevented this scenario; with F4 v2's scoped gate, it can
  // happen, so we detect it explicitly. The snapshot was taken pre-flight (above), so this
  // comparison detects actual worker modifications to pre-existing dirty files.
  const overlapped: string[] = [];
  for (const p of preExisting) {
    try {
      const content = await readFile(join(repoRoot, p), 'utf8');
      const currentHash = createHash('sha256').update(content).digest('hex');
      if (currentHash !== preExistingHashes.get(p)) {
        overlapped.push(p);
      }
    } catch {
      // If we can't read the file now, conservatively assume it changed.
      overlapped.push(p);
    }
  }
  if (overlapped.length > 0) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const reason = `Stranger overlap: worker edited file(s) with pre-existing uncommitted work: ${overlapped.join(', ')} — reverted worker paths only.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-stranger-overlap', reason, files_changed: workerPaths });
    return { outcome: 'code-fix-skipped-stranger-overlap', reason };
  }

  // Same-run-overlap guard (2026-08-23 F5 rework, plans/2026-08-23-code-fix-multi-per-night-
  // SPEC.md): if this diff touches a file a fix applied EARLIER IN THE SAME RUN already
  // changed, revert — every applied fix in a run must stay independently `git revert`-able,
  // and a second commit on the same file would make reverting the first one conflict.
  const sameRun = new Set(opts.sameRunAppliedFiles ?? []);
  const sameRunHit = workerPaths.filter((p) => sameRun.has(p));
  if (sameRunHit.length) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const reason = `Same-run overlap: diff touches file(s) already changed by a fix applied earlier this run: ${sameRunHit.join(', ')} — reverted worker paths only (keeps each applied fix independently revertable).`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-same-run-overlap', reason, files_changed: workerPaths });
    return { outcome: 'code-fix-skipped-same-run-overlap', reason };
  }

  // F1: protected-path diff inspection.
  const protectedTouched = workerPaths.filter(isProtectedPath);
  if (protectedTouched.length > 0) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const reason = `Coding worker touched protected path(s): ${protectedTouched.join(', ')} — reverted.`;
    await appendAuditRecord({ ...baseAudit, action: 'reverted-protected-path', reason, files_changed: workerPaths });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F5 (diff-inspection half): data-destruction guard.
  const guardedTouched = workerPaths.filter(touchesGuardedDataPath);
  if (guardedTouched.length > 0) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const reason = `Coding worker touched a guarded data/secrets path: ${guardedTouched.join(', ')} — reverted.`;
    await appendAuditRecord({ ...baseAudit, action: 'reverted-protected-path', reason, files_changed: workerPaths });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F2: test-integrity guard — net deletions in an existing test file.
  const numstat = await getNumstat(exec, repoRoot, preFixHead);
  const weakened = numstat.filter((n) => isExistingTestFile(n.path) && n.deleted > n.added);
  if (weakened.length > 0) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const reason = `Net test deletions in existing test file(s): ${weakened.map((w) => w.path).join(', ')} — reverted.`;
    await appendAuditRecord({ ...baseAudit, action: 'reverted-test-weakening', reason, files_changed: workerPaths });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F3: post-apply verification gate — scoped to what the diff actually touched (2026-08-23
  // WP-J2a; see runVerificationGate's own doc comment for the matrix). A maintenance-job
  // target has no project dir of its own, so its gate is the pa arms only.
  //
  // W-C8 (AI-156 Wave C): holds @build for the gate's duration so a concurrent build/test
  // elsewhere can't tear pa/dist out from under it. MUST stay below the quiet-tree gate
  // (readActiveFn, above) — claiming @build any earlier would make code-fixer read its own
  // reservation and skip itself every night (V16).
  const withBuildLockFn = opts.withBuildLockFn ?? withBuildLock;
  const verification = await withBuildLockFn(
    `code-fixer-${process.pid}`,
    () => runVerificationGate(
      workerPaths, repoRoot, exec, botRestartFn, checkBotProcessFn, sleep,
      isJobTarget ? undefined : projectRelDir, projectBaselineFailures, paPyBaselineFailures,
    ),
    { ttlMinutes: 60 },
  );
  if (!verification.ok) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const reason = `Verification failed: ${verification.excerpt ?? 'unknown failure'} — reverted.${gatesSuffixText(verification.gates)}`;
    await appendAuditRecord({
      ...baseAudit, action: 'reverted-verification-failed', reason, files_changed: workerPaths,
      test_run_counts: verification.testRunCounts,
    });
    return { outcome: 'code-fix-reverted', reason };
  }

  // F6: commit + push PRIVATE origin only (plain `git` always resolves to .git, never
  // .git-public — this module never invokes git-public.ps1/.cmd or passes --git-dir).
  //
  // Index hygiene (2026-08-15): full unstage first (`git reset -q HEAD`), then stage ONLY the
  // worker's paths, then verify that the staged set matches exactly. This prevents a stranger's
  // staged index from riding along in the fix commit. Before 2026-08-15, we unstaged only the
  // churn pathspecs and assumed the rest was clean; with F4 v2 allowing out-of-scope WIP, a
  // stranger's staged entries would otherwise slip into the commit.
  //
  // Pathspec-limited staging (2026-07-21, do NOT regress to a bare `git add -A`): the bare
  // form swept the nightly pa/data/profile* churn into the fix commit itself, which made every
  // autonomous fix commit UN-REVERTABLE by construction — `git revert` aborts on "local changes
  // to pa/data/profile.json would be overwritten by merge" as soon as learn_agent has rewritten
  // it again (see DIRTY_IGNORE_PREFIXES for the 7b82c88 incident). `workerPaths` already
  // excludes the churn, so it is exactly the set the coding worker changed. The new mechanism
  // adds a staged-set equality check on top of the 2026-07-21 pathspec-limited staging.
  await exec(`git reset -q HEAD`, { cwd: repoRoot }).catch(() => {});
  const commitPathspec = workerPaths.map((p) => `"${p}"`).join(' ');
  await exec(`git add -A -- ${commitPathspec}`, { cwd: repoRoot });

  // Verify staged-set matches exactly — any mismatch means something unexpected slipped in.
  const { stdout: stagedNames } = await exec(`git diff --cached --name-only`, { cwd: repoRoot });
  const stagedSet = new Set(stagedNames.trim().split('\n').filter((p) => p.length > 0).map((p) => normalizePath(p)));
  const workerSet = new Set(workerPaths);
  if (stagedSet.size !== workerSet.size || ![...stagedSet].every((p) => workerSet.has(p))) {
    await hardRevert(exec, repoRoot, preFixHead, workerPaths);
    const unexpected = [...stagedSet].filter((p) => !workerSet.has(p));
    const missing = [...workerSet].filter((p) => !stagedSet.has(p));
    const reason = `Staged set mismatch: staged [${[...stagedSet].join(', ')}] vs worker [${workerPaths.join(', ')}] — unexpected: [${unexpected.join(', ')}], missing: [${missing.join(', ')}]. Reverted worker paths only.`;
    await appendAuditRecord({ ...baseAudit, action: 'code-fix-skipped-staged-mismatch', reason, files_changed: workerPaths });
    return { outcome: 'code-fix-skipped-staged-mismatch', reason };
  }

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

  const reason = `Applied and pushed autonomous code fix for '${proposal.target_skill}' (commit ${commitHash ?? 'unknown'}).${gatesSuffixText(verification.gates)}`;
  await appendAuditRecord({
    ...baseAudit,
    action: 'applied-code-fix',
    reason,
    commit_hash: commitHash,
    files_changed: workerPaths,
    test_run_counts: verification.testRunCounts,
    baseline: toAuditBaseline(await skillRunStats(targetSkillName, 14)),
  });

  return { outcome: 'applied-code-fix', reason, commitHash, filesChanged: workerPaths, testRunCounts: verification.testRunCounts };
  }
}
