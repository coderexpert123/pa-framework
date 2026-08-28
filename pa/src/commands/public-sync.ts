import path from 'path';
import { randomUUID } from 'crypto';
import { syncPublicMirror } from '../lib/public-sync.js';
import { resolveRepoRoot } from '../lib/git-root.js';
import { blackboard, startLockRenewal } from '../blackboard.js';
import { exclusiveLockKey } from './run.js';

const PUBLIC_SYNC_LOCK_AGENT = 'public-sync';

// Default 300s (D5) — same rationale as GIT_LOCK_WAIT_MS in code-fixer.ts:
// comfortably outlasts a typical sync without pretending to outwait a
// concurrent /push. Overridable ONLY for tests (PA_PUBLIC_SYNC_LOCK_WAIT_MS) —
// production always gets the 300_000ms default; no config knob for it.
function publicSyncLockWaitMs(): number {
  const raw = process.env.PA_PUBLIC_SYNC_LOCK_WAIT_MS;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 300_000;
}

export async function publicSyncCommand(args: string[]): Promise<number> {
  let publicDir: string | undefined = process.env.PA_PUBLIC_DIR;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--public-dir') {
      publicDir = args[++i];
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      console.error(`pa public-sync: unrecognized argument '${arg}'`);
      return 1;
    }
  }

  // Must be the true repo root, not process.cwd() — `git archive HEAD` run from
  // a subdirectory archives ONLY that subtree (verified empirically: `git -C pa
  // archive HEAD` contains just pa/'s own files). Run from inside pa/ (the
  // standard `cd pa && npm run build` workflow), the old process.cwd() default
  // would have made this sync everything outside pa/ look "no longer in
  // private HEAD" — and step 6's prune logic would have DELETED it from the
  // public mirror. Found 2026-08-05 before any real (non---dry-run) sync had
  // ever executed against the real repo.
  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot();
  } catch (err: any) {
    console.log(JSON.stringify({ ok: false, code: 1, error: err.message }, null, 2));
    return 1;
  }

  // Nested but independent: <repo root>/pa-public, own .git/, gitignored by
  // the private repo. Resolved here (not at module load) because the default
  // depends on repoRoot, which isn't known until after argument parsing.
  const resolvedPublicDir = publicDir || path.join(repoRoot, 'pa-public');

  // D5 (2026-08-23): the public mirror gets its OWN blackboard resource
  // (`git-public-workflow`), separate from `git-workflow` — serializes
  // concurrent public-syncs against each other without adding public-sync to
  // the private git-workflow lock family. Acquired here, in the CLI layer,
  // NOT inside lib/public-sync.ts — syncPublicMirror stays lock-free so
  // public-sync.test.ts can keep testing it directly. --dry-run is
  // side-effect-free by construction and skips the lock entirely.
  if (dryRun) {
    const result = await syncPublicMirror({ privateDir: repoRoot, publicDir: resolvedPublicDir, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return result.code;
  }

  const lockKey = exclusiveLockKey('git-public-workflow');
  const contextId = randomUUID();
  const lockAcquired = await blackboard.acquireLock(lockKey, PUBLIC_SYNC_LOCK_AGENT, process.pid, publicSyncLockWaitMs(), contextId);
  if (!lockAcquired) {
    console.log(JSON.stringify({ ok: false, code: 5, error: `another public-sync is holding ${lockKey}` }, null, 2));
    return 5;
  }

  const renewal = startLockRenewal(lockKey, PUBLIC_SYNC_LOCK_AGENT, contextId);
  try {
    const result = await syncPublicMirror({ privateDir: repoRoot, publicDir: resolvedPublicDir, dryRun });
    console.log(JSON.stringify(result, null, 2));
    return result.code;
  } finally {
    renewal.stop();
    await blackboard.releaseLock(lockKey, PUBLIC_SYNC_LOCK_AGENT, contextId, { pid: process.pid }).catch(() => {});
  }
}
