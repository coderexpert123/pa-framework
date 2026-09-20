/**
 * Detects a specific, mechanically-decidable signature of a tree clobber
 * (plan: the 2026-08-05 multi-session safety plan §4.2): a tracked file
 * whose working-tree blob is byte-identical to an ANCESTOR of HEAD, and
 * differs from HEAD itself. Normal editing essentially never reproduces a
 * historical version byte-for-byte, so this is a near-zero-false-positive
 * signal that something overwrote the working tree.
 *
 * Deliberately NOT reported: a file that differs from every ancestor too
 * (genuinely new, uncommitted work) — that is ordinary daily editing, and
 * flagging it would make the tool noise (§4.2).
 *
 * Performance: this repo's D: drive is a slow 5400rpm HDD where subprocess-
 * heavy code has caused real timeouts before (CLAUDE.md, 2026-08-05). Per
 * modified file, detectDrift issues exactly 2 git subprocesses — one
 * `git rev-list` to enumerate candidate ancestor commits, and one
 * `git cat-file --batch-check` fed every candidate as `<rev>:<path>` on a
 * single stdin batch — never one subprocess per candidate commit.
 */

import { spawn } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { parsePorcelainEntries, type PorcelainEntry } from './git-status.js';

// ---- Git subprocess runner (injectable for test instrumentation — always
// backed by a real `git` process; nothing here fakes git's behavior) ----

export interface GitRunResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
}

export type GitRunner = (repoRoot: string, args: string[], input?: string | Buffer) => Promise<GitRunResult>;

export const defaultGitRunner: GitRunner = (repoRoot, args, input) => {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks), code: code ?? -1 });
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
};

// ---- Drift detection ----

/** The SINGLE owner of the ancestor-scan window (2026-09-18): both detectDrift
 *  and detectRangeDrift default their per-file `rev-list --max-count` to this. */
export const DRIFT_DEFAULT_MAX_COMMITS = 50;

export interface DriftFinding {
  path: string;
  kind: 'reverted-to-ancestor';
  /** Full sha of the ancestor commit whose blob for `path` matches the working tree. */
  ancestorSha: string;
  /** Full sha of HEAD at detection time. */
  headSha: string;
  /** The (git blob) sha1 of the working-tree content itself. */
  blobSha: string;
}

export interface DetectDriftOptions {
  /** How far back to scan per file (git rev-list --max-count). Defaults to
   *  DRIFT_DEFAULT_MAX_COMMITS — a bounded, documented limitation (§7.3 test 7):
   *  a reversion older than this window is not reported. */
  maxCommits?: number;
  gitRunner?: GitRunner;
}

/**
 * `restoreFromHead`/`mergeAgainstHead` are exported functions any caller can invoke
 * with an arbitrary path string — `reconcile.ts`'s `--restore`/`--merge` CLI flags
 * pass a user-supplied argument straight through with no validation of their own.
 * `mergeAgainstHead` does a DIRECT `readFile(join(repoRoot, relPath))`, not a
 * git-mediated read — unlike `checkFileDrift`'s `relPath` (always sourced from git's
 * own `status --porcelain` output, already confined to the repo), an unvalidated CLI
 * arg here is a real path-traversal read (`../../../../whatever` escapes `repoRoot`
 * entirely). Mirrors `lib/reservations.ts`'s `normalizePath()`, which already defends
 * the structurally identical `pa claim <path>` input — found via a 2026-08-06
 * deep-recheck that this file never got the same treatment.
 */
function assertSafeRelPath(relPath: string): void {
  const p = relPath.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new Error(`path must be repo-relative, not absolute: "${relPath}"`);
  }
  if (p.split('/').some((segment) => segment === '..')) {
    throw new Error(`path escapes the repo root: "${relPath}"`);
  }
}

/** Tracked files with worktree content to compare — excludes untracked (`??`) and
 *  anything without live worktree bytes (deleted, staged-deletion-only). */
function isDriftCandidate(entry: PorcelainEntry): boolean {
  if (entry.x === '?' && entry.y === '?') return false;
  if (entry.y === 'D') return false;
  if (entry.x === 'D' && entry.y === ' ') return false;
  return true;
}

/** git's own blob-object hash: sha1("blob " + byteLength + "\0" + content). Computed
 *  locally so detectDrift never needs a `git hash-object` subprocess per file. */
async function gitBlobHash(absPath: string): Promise<string> {
  const content = await readFile(absPath);
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

interface BatchCheckEntry {
  sha: string | null;
}

/** One `git cat-file --batch-check` call for an arbitrary number of `<rev>:<path>` queries.
 *  FAIL-CLOSED (post-landing verifier finding 2026-09-18): an unchecked nonzero exit or a
 *  short result stream previously degraded into `headEntry` undefined → `return null`,
 *  so a failed batch read silently scanned clean — the exact failure mode a drift gate
 *  exists to refuse. */
async function batchCheckBlobs(gitRunner: GitRunner, repoRoot: string, queries: string[]): Promise<BatchCheckEntry[]> {
  const input = queries.map((q) => q + '\n').join('');
  const res = await gitRunner(repoRoot, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], input);
  const lines = res.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
  if (res.code !== 0 || lines.length < queries.length) {
    throw new Error(`git cat-file failed (exit ${res.code}): ${res.stderr.toString('utf8').trim()}`);
  }
  return lines.map((line) => {
    if (line.endsWith(' missing')) return { sha: null };
    const sha = line.split(' ', 1)[0];
    return { sha: sha || null };
  });
}

/** 2 git subprocesses: one `rev-list` to enumerate candidate ancestor commits for this
 *  path, one batched `cat-file --batch-check` covering HEAD + every candidate. */
async function checkFileDrift(
  gitRunner: GitRunner,
  repoRoot: string,
  relPath: string,
  maxCommits: number,
): Promise<DriftFinding | null> {
  const absPath = join(repoRoot, relPath);
  let workingHash: string;
  try {
    workingHash = await gitBlobHash(absPath);
  } catch {
    return null; // file vanished between `status` and now — no crash, no finding
  }

  const revListRes = await gitRunner(repoRoot, ['rev-list', `--max-count=${maxCommits}`, 'HEAD', '--', relPath]);
  if (revListRes.code !== 0) {
    throw new Error(`git rev-list failed for ${relPath} (exit ${revListRes.code}): ${revListRes.stderr.toString('utf8').trim()}`);
  }
  const shas = revListRes.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean);

  const queries = [`HEAD:${relPath}`, ...shas.map((sha) => `${sha}:${relPath}`)];
  const results = await batchCheckBlobs(gitRunner, repoRoot, queries);

  const headEntry = results[0];
  if (!headEntry || headEntry.sha === workingHash) return null; // matches HEAD (or HEAD lacks the path) — not drift

  for (let i = 0; i < shas.length; i++) {
    const entry = results[i + 1];
    if (entry && entry.sha === workingHash) {
      return { path: relPath, kind: 'reverted-to-ancestor', ancestorSha: shas[i], headSha: headEntry.sha ?? '', blobSha: workingHash };
    }
  }
  return null;
}

export async function detectDrift(repoRoot: string, opts: DetectDriftOptions = {}): Promise<DriftFinding[]> {
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const maxCommits = opts.maxCommits ?? DRIFT_DEFAULT_MAX_COMMITS;

  // A failed `git status` here must never be read as "no candidates" — this tool
  // exists to catch silent tree corruption, so silently reporting a clean scan
  // when the scan itself never ran would be the exact failure mode it's supposed
  // to prevent. Throw loudly instead of returning an empty (falsely reassuring)
  // findings array.
  const statusRes = await gitRunner(repoRoot, ['status', '--porcelain']);
  if (statusRes.code !== 0) {
    throw new Error(`git status failed (exit ${statusRes.code}): ${statusRes.stderr.toString('utf8').trim()}`);
  }
  const candidates = parsePorcelainEntries(statusRes.stdout.toString('utf8')).filter(isDriftCandidate);

  const findings: DriftFinding[] = [];
  // Sequential, not Promise.all — this machine's D: drive starves under concurrent
  // subprocess/disk load (CLAUDE.md, 2026-08-05); one file at a time keeps this cheap.
  for (const candidate of candidates) {
    const finding = await checkFileDrift(gitRunner, repoRoot, candidate.path, maxCommits);
    if (finding) findings.push(finding);
  }
  return findings;
}

// ---- Committed-range drift detection (2026-09-18 push-gated doctrine) ----

export interface DetectRangeDriftOptions {
  /** Ancestor window per file (git rev-list --max-count). Defaults to DRIFT_DEFAULT_MAX_COMMITS. */
  maxCommits?: number;
  gitRunner?: GitRunner;
}

export interface DetectRangeDriftResult {
  /** The merge-base of HEAD and the given ref — the range start the scan ran over. */
  baseSha: string;
  findings: DriftFinding[];
}

/** 2 git subprocesses per range path, plus ONE extra `rev-list` for a rename/copy:
 *  one `rev-list` per name over pre-range history, one batched
 *  `cat-file --batch-check` covering HEAD + base + every candidate under both names. */
async function checkRangePathDrift(
  gitRunner: GitRunner,
  repoRoot: string,
  relPath: string,
  baseSha: string,
  maxCommits: number,
  oldPath?: string,
): Promise<DriftFinding | null> {
  // NOTE: relPath/oldPath are sourced from `git diff --name-status` output, already
  // confined to the repo — same trust model as checkFileDrift's status-sourced
  // paths, so no traversal assert here (unlike restoreFromHead/mergeAgainstHead's
  // CLI-supplied args).
  const revListRes = await gitRunner(repoRoot, ['rev-list', `--max-count=${maxCommits}`, baseSha, '--', relPath]);
  if (revListRes.code !== 0) {
    throw new Error(`git rev-list failed for ${relPath} (exit ${revListRes.code}): ${revListRes.stderr.toString('utf8').trim()}`);
  }
  const shas = revListRes.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean);

  // A rename/copy leaves the file's pre-range history under the OLD name — without
  // it, "rename a→b + revert b to an ancestor" reads as delete+add: the new name
  // has no pre-range history to match and the evasion scans clean.
  const oldShas: string[] = [];
  if (oldPath) {
    const oldRevListRes = await gitRunner(repoRoot, ['rev-list', `--max-count=${maxCommits}`, baseSha, '--', oldPath]);
    if (oldRevListRes.code !== 0) {
      throw new Error(`git rev-list failed for ${oldPath} (exit ${oldRevListRes.code}): ${oldRevListRes.stderr.toString('utf8').trim()}`);
    }
    oldShas.push(...oldRevListRes.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  }

  const queries = [
    `HEAD:${relPath}`,
    `${baseSha}:${relPath}`,
    ...(oldPath ? [`${baseSha}:${oldPath}`] : []),
    ...shas.map((sha) => `${sha}:${relPath}`),
    ...oldShas.map((sha) => `${sha}:${oldPath}`),
  ];
  const results = await batchCheckBlobs(gitRunner, repoRoot, queries);

  const headEntry = results[0];
  const baseEntry = results[1];
  const baseOldEntry = oldPath ? results[2] : undefined;
  const ancestorOffset = oldPath ? 3 : 2;
  if (!headEntry || !headEntry.sha) return null; // deleted in range — not a reversion
  if (baseEntry && baseEntry.sha === headEntry.sha) return null; // HEAD == base (incl. mode-only diffs) — ships nothing reverted
  if (baseOldEntry && baseOldEntry.sha === headEntry.sha) return null; // pure rename, content carried forward — same "ships nothing reverted" test under the old name

  for (let i = 0; i < shas.length; i++) {
    const entry = results[ancestorOffset + i];
    if (entry && entry.sha === headEntry.sha) {
      return { path: relPath, kind: 'reverted-to-ancestor', ancestorSha: shas[i], headSha: headEntry.sha, blobSha: headEntry.sha };
    }
  }
  for (let i = 0; i < oldShas.length; i++) {
    const entry = results[ancestorOffset + shas.length + i];
    if (entry && entry.sha === headEntry.sha) {
      return { path: relPath, kind: 'reverted-to-ancestor', ancestorSha: oldShas[i], headSha: headEntry.sha, blobSha: headEntry.sha };
    }
  }
  return null;
}

/**
 * Scans COMMITTED content for reversions that landed in local commits: files under
 * `<baseRef>..HEAD` whose HEAD blob matches pre-range history. This is the push gate's
 * FAIL half — it verdicts what the push ships (HEAD blobs), unlike the live-tree scan
 * (detectDrift), which verdicts uncommitted bytes that never ship.
 *
 * Accepted edge: a diverged `<baseRef>` can attribute a remote-side old-version file
 * to the range — harmless, that push stops on divergence anyway.
 *
 * Renames/copies are resolved via `diff --name-status -M`: the new name's HEAD blob
 * is checked against pre-range history under BOTH names (one extra `rev-list` per
 * rename over the OLD name) — closing the rename+revert evasion where name-only diff
 * read it as delete+add with no pre-range history under the new name. Spawn bound:
 * 2 + 2×(range paths) + 1 extra rev-list per rename/copy.
 */
interface RangePathEntry {
  /** The path to scan — the NEW name for rename/copy records. */
  path: string;
  /** The OLD name on rename/copy records — its pre-range history is scanned too. */
  oldPath?: string;
}

/** Parses `git diff --name-status -z` output: records are `STATUS\0PATH` for
 *  single-path statuses (A/M/D/T/…) and `R<score>\0OLD\0NEW` / `C<score>\0OLD\0NEW`
 *  for renames/copies. Positional — a path that begins with 'R' or 'C' can't
 *  misparse as a status. Blank fields are skipped. */
function parseNameStatusZ(raw: string): RangePathEntry[] {
  const fields = raw.split('\0').map((s) => s.trim()).filter(Boolean);
  const entries: RangePathEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i++];
    if (status[0] === 'R' || status[0] === 'C') {
      const oldPath = fields[i++] ?? '';
      const newPath = fields[i++] ?? '';
      if (newPath) entries.push({ path: newPath, oldPath: oldPath || undefined });
    } else {
      const p = fields[i++] ?? '';
      if (p) entries.push({ path: p });
    }
  }
  return entries;
}

export async function detectRangeDrift(repoRoot: string, baseRef: string, opts: DetectRangeDriftOptions = {}): Promise<DetectRangeDriftResult> {
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const maxCommits = opts.maxCommits ?? DRIFT_DEFAULT_MAX_COMMITS;

  // Fail closed: an unresolvable base must never read as a clean scan.
  const mergeBaseRes = await gitRunner(repoRoot, ['merge-base', 'HEAD', baseRef]);
  const baseSha = mergeBaseRes.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? '';
  if (mergeBaseRes.code !== 0 || !baseSha) {
    throw new Error(`git merge-base failed (${baseRef}) (exit ${mergeBaseRes.code}): ${mergeBaseRes.stderr.toString('utf8').trim()}`);
  }

  // `-z`: raw NUL-separated fields — without it git C-quotes non-ASCII/control-char
  // paths (core.quotepath), the quoted form never resolves in rev-list/cat-file, and
  // a reverted non-ASCII-named file scans silently clean (verifier finding 2026-09-18).
  // `-M` rename detection: emits `R<score>\0old\0new` records so a rename+revert
  // can be followed across names (was `--name-only`, which saw only delete+add).
  const diffRes = await gitRunner(repoRoot, ['diff', '--name-status', '-z', '-M', baseSha, 'HEAD', '--']);
  if (diffRes.code !== 0) {
    throw new Error(`git diff failed (${baseSha}..HEAD) (exit ${diffRes.code}): ${diffRes.stderr.toString('utf8').trim()}`);
  }
  const rangeEntries = parseNameStatusZ(diffRes.stdout.toString('utf8'));
  if (rangeEntries.length === 0) return { baseSha, findings: [] };

  const findings: DriftFinding[] = [];
  // Sequential, not Promise.all — this machine's D: drive starves under concurrent
  // subprocess/disk load (CLAUDE.md, 2026-08-05); one file at a time keeps this cheap.
  for (const entry of rangeEntries) {
    const finding = await checkRangePathDrift(gitRunner, repoRoot, entry.path, baseSha, maxCommits, entry.oldPath);
    if (finding) findings.push(finding);
  }
  return { baseSha, findings };
}

// ---- Restore (pa reconcile --restore) ----

export interface RestoreResult {
  code: number;
  stderr: string;
}

/** Restores one path to its exact HEAD content. Explicit and per-path — never automatic. */
export async function restoreFromHead(repoRoot: string, relPath: string, opts: { gitRunner?: GitRunner } = {}): Promise<RestoreResult> {
  assertSafeRelPath(relPath);
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const res = await gitRunner(repoRoot, ['checkout', 'HEAD', '--', relPath]);
  return { code: res.code, stderr: res.stderr.toString('utf8') };
}

// ---- Merge assist (pa reconcile --merge) ----

export interface MergeAgainstHeadResult {
  path: string;
  /** git merge-file's exit code, passed through verbatim: 0 clean, >0 conflict count, <0 error. */
  conflictCount: number;
  outputDir: string;
  oursPath: string;
  basePath: string;
  theirsPath: string;
  resultPath: string;
}

export interface MergeAgainstHeadOptions {
  gitRunner?: GitRunner;
  /** Overrides where the reconcile-<ts> directory is created; defaults to `<repoRoot>/scratch`. */
  scratchDir?: string;
  now?: () => Date;
}

async function catFileBlob(gitRunner: GitRunner, repoRoot: string, ref: string): Promise<Buffer> {
  const res = await gitRunner(repoRoot, ['cat-file', '-p', ref]);
  if (res.code !== 0) return Buffer.alloc(0); // ref does not exist at that path/revision — treat as empty
  return res.stdout;
}

/**
 * Diagnostic only — never writes back to the working tree (§4.2, §4.3). Reads the
 * current working-tree bytes as "ours", HEAD's committed content as "theirs", and the
 * content at the previous commit that touched this path as "base", then runs
 * `git merge-file` into a fresh `scratch/reconcile-<ts>-<rand>/` directory. The
 * operator resolves the result by hand and copies it back themselves.
 */
export async function mergeAgainstHead(
  repoRoot: string,
  relPath: string,
  opts: MergeAgainstHeadOptions = {},
): Promise<MergeAgainstHeadResult> {
  assertSafeRelPath(relPath);
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const now = opts.now ?? (() => new Date());

  const ts = now().toISOString().replace(/[:.]/g, '-');
  const rand = randomBytes(4).toString('hex');
  const scratchRoot = opts.scratchDir ?? join(repoRoot, 'scratch');
  const outputDir = join(scratchRoot, `reconcile-${ts}-${rand}`);
  await mkdir(outputDir, { recursive: true });

  const absPath = join(repoRoot, relPath);
  const ours = await readFile(absPath).catch(() => Buffer.alloc(0));

  const revListRes = await gitRunner(repoRoot, ['rev-list', '--max-count=2', 'HEAD', '--', relPath]);
  const shas = revListRes.stdout.toString('utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const headSha = shas[0];
  const prevSha = shas[1];

  const theirs = headSha ? await catFileBlob(gitRunner, repoRoot, `${headSha}:${relPath}`) : Buffer.alloc(0);
  const base = prevSha ? await catFileBlob(gitRunner, repoRoot, `${prevSha}:${relPath}`) : Buffer.alloc(0);

  const oursPath = join(outputDir, 'ours');
  const basePath = join(outputDir, 'base');
  const theirsPath = join(outputDir, 'theirs');
  const resultPath = join(outputDir, 'result');

  await writeFile(oursPath, ours);
  await writeFile(basePath, base);
  await writeFile(theirsPath, theirs);

  // -p: send the merge result to stdout instead of overwriting `oursPath` — none of
  // the three scratch copies (and certainly not the real working-tree file, which is
  // never passed to git at all) is written by this call.
  const mergeRes = await gitRunner(repoRoot, ['merge-file', '-p', '--diff3', oursPath, basePath, theirsPath]);
  await writeFile(resultPath, mergeRes.stdout);

  return { path: relPath, conflictCount: mergeRes.code, outputDir, oursPath, basePath, theirsPath, resultPath };
}
