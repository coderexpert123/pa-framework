import { checkGitWorkflowAllowed } from '../lib/git-guard.js';

/**
 * `pa git-guard [<dir>]` — exit 0 = skills may run git; exit 1 = they must
 * not (reason on stdout). Skills (e.g. examples/skills/update-brain) invoke
 * this before any commit/push/revert on the user's behalf; the dir argument
 * is where the work-tree check runs (default: process cwd).
 */
export async function gitGuardCommand(dirArg?: string): Promise<number> {
  const result = await checkGitWorkflowAllowed(dirArg ? { cwd: dirArg } : {});
  console.log(`git-guard: ${result.allowed ? 'ALLOWED' : 'NOT ALLOWED'} — ${result.reason}`);
  return result.allowed ? 0 : 1;
}
