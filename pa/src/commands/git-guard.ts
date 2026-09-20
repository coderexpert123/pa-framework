import { checkGitWorkflowAllowed } from '../lib/git-guard.js';

const GIT_GUARD_USAGE =
  'Usage: pa git-guard [<dir>] [--session <label>] [--path <repo-relative-path> ...] [-- <path>...]\n' +
  '  Exit 0 = skills may run git here. Exit 1 = not allowed (reason on stdout).\n' +
  '  The claims gate (AI-243): with no paths, every STAGED index path is checked\n' +
  '  (what a bare `git commit` lands); with --path/extra positionals, only those\n' +
  '  paths are checked (what `git commit -- <paths>` lands). A target under\n' +
  "  another session's ACTIVE reservation refuses; --session (or PA_SESSION)\n" +
  '  exempts your own claims, expired claims never block.';

interface ParsedGitGuardArgs {
  dir?: string;
  session?: string;
  paths: string[];
  help: boolean;
  unknownFlags: string[];
  /** A value-taking flag (`--session`/`--path`) was the last arg — the value
   *  it needs never arrived. A gate must not silently treat a malformed
   *  invocation as "nothing to check": this is a usage error (exit 2). */
  missingValue?: string;
}

function parseGitGuardArgs(args: string[]): ParsedGitGuardArgs {
  let dir: string | undefined;
  let session: string | undefined;
  const paths: string[] = [];
  let help = false;
  const unknownFlags: string[] = [];
  let positionalOnly = false;
  let missingValue: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positionalOnly) {
      paths.push(arg);
      continue;
    }
    if (arg === '--') { positionalOnly = true; continue; }
    if (arg === '--session') {
      const v = args[++i];
      if (v === undefined) missingValue = '--session'; else session = v;
      continue;
    }
    if (arg === '--path') {
      const v = args[++i];
      if (v === undefined) missingValue = '--path'; else paths.push(v);
      continue;
    }
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    // First bare positional is the work-tree dir (legacy form); any further
    // positionals are commit-target paths — `pa git-guard . a/b.ts c.ts`.
    if (dir === undefined) { dir = arg; continue; }
    paths.push(arg);
  }

  return { dir, session, paths, help, unknownFlags, missingValue };
}

/**
 * `pa git-guard [<dir>] [--session <label>] [--path <p> ...] [-- <path>...]`
 * — exit 0 = skills may run git; exit 1 = they must not (reason on stdout).
 * Skills (e.g. examples/skills/update-brain) invoke this before any
 * commit/push/revert on the user's behalf; the dir argument is where the
 * work-tree check runs (default: process cwd).
 *
 * AI-243: the CLI always runs the claims gate — a commit target (the staged
 * index, or the named --path/positional paths) sitting under another
 * session's ACTIVE `pa claim` reservation refuses the commit, naming the
 * holder. `--session`/PA_SESSION exempts the caller's own claims so a wave
 * builder committing pathspec'd files under its own reservation still
 * passes; expired reservations never block.
 */
export async function gitGuardCommand(args: string[] = []): Promise<number> {
  const parsed = parseGitGuardArgs(args);

  if (parsed.help) {
    console.log(GIT_GUARD_USAGE);
    return 0;
  }
  if (parsed.unknownFlags.length > 0 || parsed.missingValue) {
    console.error(GIT_GUARD_USAGE);
    if (parsed.unknownFlags.length > 0) {
      console.error(`Unrecognized option(s): ${parsed.unknownFlags.join(', ')}`);
    }
    if (parsed.missingValue) {
      console.error(`Option ${parsed.missingValue} requires a value`);
    }
    return 2;
  }

  const result = await checkGitWorkflowAllowed({
    cwd: parsed.dir,
    claimsCheck: {
      session: parsed.session,
      paths: parsed.paths.length > 0 ? parsed.paths : undefined,
    },
  });
  console.log(`git-guard: ${result.allowed ? 'ALLOWED' : 'NOT ALLOWED'} — ${result.reason}`);
  return result.allowed ? 0 : 1;
}
