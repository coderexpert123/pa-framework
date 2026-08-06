/**
 * Detects a specific, mechanically-decidable signature of a tree clobber
 * (plan: plans/2026-08-05-concurrent-session-safety.md §4.2): a tracked file
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
  /** How far back to scan per file (git rev-list --max-count). Default 50 — a bounded,
   *  documented limitation (§7.3 test 7): a reversion older than this window is not reported. */
  maxCommits?: number;
  gitRunner?: GitRunner;
}

interface StatusEntry {
  x: string;
  y: string;
  path: string;
}

/** Parses `git status --porcelain` (v1) output into status-code + path rows. */
function parsePorcelainStatus(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    // Renames/copies report "old -> new"; only the new path is a WT concern here.
    const arrowIdx = rest.indexOf(' -> ');
    if (arrowIdx !== -1) rest = rest.slice(arrowIdx + 4);
    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    entries.push({ x, y, path: rest });
  }
  return entries;
}

/** Tracked files with worktree content to compare — excludes untracked (`??`) and
 *  anything without live worktree bytes (deleted, staged-deletion-only). */
function isDriftCandidate(entry: StatusEntry): boolean {
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

/** One `git cat-file --batch-check` call for an arbitrary number of `<rev>:<path>` queries. */
async function batchCheckBlobs(gitRunner: GitRunner, repoRoot: string, queries: string[]): Promise<BatchCheckEntry[]> {
  const input = queries.map((q) => q + '\n').join('');
  const res = await gitRunner(repoRoot, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], input);
  const lines = res.stdout.toString('utf8').split('\n').filter((l) => l.length > 0);
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
  const maxCommits = opts.maxCommits ?? 50;

  const statusRes = await gitRunner(repoRoot, ['status', '--porcelain']);
  const candidates = parsePorcelainStatus(statusRes.stdout.toString('utf8')).filter(isDriftCandidate);

  const findings: DriftFinding[] = [];
  // Sequential, not Promise.all — this machine's D: drive starves under concurrent
  // subprocess/disk load (CLAUDE.md, 2026-08-05); one file at a time keeps this cheap.
  for (const candidate of candidates) {
    const finding = await checkFileDrift(gitRunner, repoRoot, candidate.path, maxCommits);
    if (finding) findings.push(finding);
  }
  return findings;
}

// ---- Restore (pa reconcile --restore) ----

export interface RestoreResult {
  code: number;
  stderr: string;
}

/** Restores one path to its exact HEAD content. Explicit and per-path — never automatic. */
export async function restoreFromHead(repoRoot: string, relPath: string, opts: { gitRunner?: GitRunner } = {}): Promise<RestoreResult> {
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
