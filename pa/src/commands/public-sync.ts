import path from 'path';
import { syncPublicMirror } from '../lib/public-sync.js';
import { resolveRepoRoot } from '../lib/git-root.js';

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

  const result = await syncPublicMirror({ privateDir: repoRoot, publicDir: resolvedPublicDir, dryRun });
  console.log(JSON.stringify(result, null, 2));
  return result.code;
}
