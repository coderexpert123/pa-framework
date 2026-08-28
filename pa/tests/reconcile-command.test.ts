/**
 * CLI-layer tests for pa/src/commands/reconcile.ts (D22, AI-156/WP-C).
 *
 * V1-F6: reconcileCommand had zero coverage at any layer before this — lib/tree-drift.ts's
 * detectDrift/restoreFromHead/mergeAgainstHead were tested directly, but never through the
 * CLI's arg-parsing, usage/exit-code contract, or its uniform try/catch around all three
 * subcommands. Drives a REAL temp git repo (not a fabricated fixture) so the drift-detected
 * case exercises the genuine `git rev-list` / `git cat-file --batch-check` path, mirroring
 * the real-repo pattern in self-improver.test.ts's rollback fixture.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { reconcileCommand } from '../src/commands/reconcile.js';

const runShell = promisify(execCb);

let repo: string;
let originalCwd: string;
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;
let consoleOutput: string[];
let consoleErrors: string[];

const git = async (cmd: string): Promise<void> => {
  await runShell(cmd, { cwd: repo });
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pa-reconcile-cmd-'));
  await git('git init -q');
  await git('git config user.email pa-test@example.com');
  await git('git config user.name "pa test"');
  await git('git config commit.gpgsign false');
  await git('git config core.autocrlf false'); // byte-for-byte drift comparison below
  await writeFile(join(repo, 'README.md'), 'base\n', 'utf8');
  await git('git add -A');
  await git('git commit -q -m base');

  originalCwd = process.cwd();
  process.chdir(repo);
  process.exitCode = undefined;

  consoleOutput = [];
  consoleErrors = [];
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  console.log = (...args: unknown[]) => { consoleOutput.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); };
});

afterEach(async () => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.chdir(originalCwd);
  process.exitCode = undefined;
  await rm(repo, { recursive: true, force: true });
});

describe('reconcileCommand (CLI layer)', () => {
  it('--restore with no path -> usage on stdout, exitCode 2', async () => {
    await reconcileCommand(['--restore']);
    assert.equal(process.exitCode, 2);
    assert.ok(consoleOutput.some((l) => l.includes('Usage: pa reconcile')));
  });

  it('--merge with no path -> usage on stdout, exitCode 2', async () => {
    await reconcileCommand(['--merge']);
    assert.equal(process.exitCode, 2);
    assert.ok(consoleOutput.some((l) => l.includes('Usage: pa reconcile')));
  });

  it('--help -> exitCode 0 (unset) and usage on stdout', async () => {
    await reconcileCommand(['--help']);
    assert.equal(process.exitCode, undefined);
    assert.ok(consoleOutput.some((l) => l.includes('Usage: pa reconcile')));
  });

  it('--check on a clean temp repo -> exitCode unset/0', async () => {
    await reconcileCommand(['--check']);
    assert.equal(process.exitCode, undefined);
    assert.ok(consoleOutput.some((l) => l.includes('No drift detected')));
  });

  it('--check on a temp repo with a real reverted-to-ancestor file -> exitCode 1, path printed', async () => {
    // v1
    await writeFile(join(repo, 'drift.txt'), 'v1\n', 'utf8');
    await git('git add -A');
    await git('git commit -q -m v1');
    // v2
    await writeFile(join(repo, 'drift.txt'), 'v2\n', 'utf8');
    await git('git add -A');
    await git('git commit -q -m v2');
    // Something reverts the working-tree bytes to v1's content WITHOUT staging or
    // committing — the exact clobber signature detectDrift exists to catch.
    await writeFile(join(repo, 'drift.txt'), 'v1\n', 'utf8');

    await reconcileCommand(['--check']);
    assert.equal(process.exitCode, 1);
    assert.ok(consoleOutput.some((l) => l.includes('drift.txt')), 'the reverted path should be printed');
  });

  it('a path outside the repo (--restore ../../x) -> exitCode 1, safe-path error on stderr (assertSafeRelPath surfaces as a CLI error, not an unhandled rejection)', async () => {
    await reconcileCommand(['--restore', '../../x']);
    assert.equal(process.exitCode, 1);
    assert.ok(
      consoleErrors.some((l) => l.includes('pa reconcile: path escapes the repo root')),
      `expected a "path escapes the repo root" stderr line, got: ${JSON.stringify(consoleErrors)}`
    );
  });
});
