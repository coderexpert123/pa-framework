import { readFileSync } from 'fs';
import { repoRootFromModule, resolveRepoRoot } from '../lib/git-root.js';
import {
  budgetedDocFiles,
  docBudgetFailures,
  jargonFindings,
  normalizeDocPath,
  sameFileTrimFailures,
} from '../lib/docs-lint.js';

/**
 * `pa docs-lint [--] [path ...]` — the commit-time/post-wave arm of the
 * budgeted-doc gate (AI-242, 2026-09-14). Runs the SAME checks the
 * docs-crossref suite enforces at push time: size budgets for every
 * budgeted doc plus the 24h same-file-trim counter, both implemented once
 * in pa/src/lib/docs-lint.ts.
 *
 * No paths = the full budgeted set (post-wave/orchestrator shape). Named
 * paths scope the check to those files — the commit skill passes each
 * commit group's file list so a stranger's over-budget WIP never blocks an
 * unrelated commit. Exit 0 clean; exit 1 prints every failure and means
 * the landing fails — relocate the overflow into a companion doc in the
 * same wave (COMPANION_DOCS names the recognized destinations) or raise
 * the ceiling in docs-lint.ts with a recorded justification. Exit 2 usage.
 */
export async function docsLintCommand(args: string[] = []): Promise<number> {
  // --jargon mode (Wave C WP-C5): `pa docs-lint --jargon <file>` — exit 1 on
  // ANY J1 finding, exit 0 clean, exit 2 usage. Scope: only
  // `<!-- user-facing -->` fenced sections (lib contract); agent-facing
  // sections exempt. Affirmative clean line required by the wave gate G3.
  if (args[0] === '--jargon') {
    const targets = args.slice(1).filter((a) => a !== '--');
    if (targets.length === 0) {
      console.error('Usage: pa docs-lint --jargon <file ...>');
      return 2;
    }
    let count = 0;
    for (const target of targets) {
      let content: string;
      try {
        content = readFileSync(target, 'utf8');
      } catch (err) {
        console.error(`docs-lint --jargon: cannot read ${target}: ${String(err)}`);
        return 2;
      }
      const findings = jargonFindings(target, content);
      for (const f of findings) console.log(f.message);
      count += findings.length;
    }
    if (count > 0) {
      console.log(`jargon findings: ${count}`);
      return 1;
    }
    console.log('jargon findings: 0');
    return 0;
  }

  const paths = args.filter((a) => a !== '--');
  const unknown = paths.filter((a) => a.startsWith('--'));
  if (unknown.length > 0) {
    console.error(`Usage: pa docs-lint [--] [path ...] (unknown option(s): ${unknown.join(' ')})`);
    return 2;
  }

  // Caller-cwd first (AI-320): a `pa run commit` worker spawned inside a linked
  // worktree must lint THAT tree's docs — module-anchored resolution would
  // measure the main checkout's copies while the commit lands the worktree's.
  // The module anchor stays as fallback for cwd-less daemon invocations.
  const repoRoot = await resolveRepoRoot().catch(() => repoRootFromModule(__filename));
  const wanted = paths.length
    ? new Set(paths.map((p) => normalizeDocPath(repoRoot, p)))
    : null;
  const files = budgetedDocFiles(repoRoot).filter((f) => !wanted || wanted.has(f));

  const failures = [
    ...docBudgetFailures(repoRoot, paths.length ? paths : undefined).map((f) => f.message),
    ...(await sameFileTrimFailures(repoRoot, files, Date.now())),
  ];

  if (failures.length > 0) {
    console.log(failures.join('\n\n'));
    return 1;
  }
  console.log(
    `docs-lint: ${files.length} budgeted doc(s) within budget; same-file-trim counter clean`
  );
  return 0;
}
