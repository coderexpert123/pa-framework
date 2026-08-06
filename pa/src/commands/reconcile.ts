import { detectDrift, mergeAgainstHead, restoreFromHead } from '../lib/tree-drift.js';
import { resolveRepoRoot } from '../lib/git-root.js';

function usage(): void {
  console.log('Usage: pa reconcile [--check] [--restore <path>] [--merge <path>]');
  console.log('  --check (default)  scan the working tree for files reverted to an ancestor of HEAD');
  console.log('  --restore <path>   restore one such file to HEAD exactly');
  console.log('  --merge <path>     write a 3-way merge diagnostic into scratch/ — never writes back');
}

async function runCheck(repoRoot: string): Promise<void> {
  const findings = await detectDrift(repoRoot);
  if (findings.length === 0) {
    console.log('No drift detected — no tracked file reverted to an ancestor of HEAD.');
    return;
  }
  console.log(`${findings.length} file(s) reverted to an ancestor of HEAD:`);
  for (const f of findings) {
    console.log(`  ${f.path}  (matches ${f.ancestorSha.slice(0, 12)}; HEAD is ${f.headSha.slice(0, 12)})`);
  }
  console.log('\nRestore with:  pa reconcile --restore <path>');
  console.log('If the file also has content you want to keep, diagnose first:  pa reconcile --merge <path>');
  process.exitCode = 1;
}

async function runRestore(repoRoot: string, path: string | undefined): Promise<void> {
  if (!path) {
    usage();
    process.exitCode = 2;
    return;
  }
  const res = await restoreFromHead(repoRoot, path);
  if (res.code !== 0) {
    console.error(`Restore failed for ${path}: ${res.stderr.trim() || `exit ${res.code}`}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Restored ${path} from HEAD.`);
}

async function runMerge(repoRoot: string, path: string | undefined): Promise<void> {
  if (!path) {
    usage();
    process.exitCode = 2;
    return;
  }
  const result = await mergeAgainstHead(repoRoot, path);
  console.log(`3-way merge diagnostic written to ${result.outputDir}`);
  console.log(`  ours:   ${result.oursPath}`);
  console.log(`  base:   ${result.basePath}`);
  console.log(`  theirs: ${result.theirsPath}`);
  console.log(`  result: ${result.resultPath}`);
  console.log('The working tree is unchanged — resolve the result file by hand and copy it back yourself.');
  if (result.conflictCount > 0) {
    console.log(`${result.conflictCount} conflict(s) marked in the result file.`);
    process.exitCode = 1;
  } else if (result.conflictCount < 0) {
    console.error(`git merge-file reported an error (exit ${result.conflictCount}).`);
    process.exitCode = 1;
  } else {
    console.log('Clean merge, no conflicts.');
  }
}

export async function reconcileCommand(args: string[]): Promise<void> {
  // Must be the true repo root, not process.cwd() — git-status-relative paths
  // joined onto a subdirectory produce a non-existent path and silently find
  // nothing (see lib/git-root.ts; found 2026-08-05 in this exact command).
  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot();
  } catch (err: any) {
    console.error(`pa reconcile: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const restoreIdx = args.indexOf('--restore');
  if (restoreIdx !== -1) {
    await runRestore(repoRoot, args[restoreIdx + 1]);
    return;
  }

  const mergeIdx = args.indexOf('--merge');
  if (mergeIdx !== -1) {
    await runMerge(repoRoot, args[mergeIdx + 1]);
    return;
  }

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  // Default and explicit --check both scan.
  await runCheck(repoRoot);
}
