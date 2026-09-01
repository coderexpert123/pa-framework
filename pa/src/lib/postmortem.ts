/**
 * Postmortem stub creator for production incidents.
 *
 * Automatically creates a structured postmortem markdown file when a rollback or
 * rollback-failed occurs in the self-improvement loop. Each stub includes a checklist
 * of action items tracked by the human-gated-blocker-watch skill.
 */

import { mkdir, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { log } from './log.js';
import { repoRootFromModule } from './git-root.js';

export interface PostmortemInput {
  date: string;           // ISO date string (YYYY-MM-DD)
  slug: string;          // URL-safe identifier (e.g., "rollback-failed-xyz")
  title: string;         // Human-readable title
  timelineRefs: string[]; // Ref-IDs from the audit trail (e.g., ["s-abc123def456"])
  actionItems: string[]; // Checklist items from audit record
}

export interface PostmortemMetadata {
  created: string;      // ISO timestamp when stub was created
  sourceAction: string; // 'rolled-back' | 'rollback-failed'
  sourceSkill: string;  // Skill that triggered the rollback
  sourceCommit?: string; // For git-revert rollbacks, the commit that was reverted
}

const POSTMORTEMS_DIR = 'plans/postmortems';
const INDEX_PATH = 'plans/INDEX.md';

/**
 * Appends a row to plans/INDEX.md for a new postmortem.
 *
 * The row format matches the existing INDEX.md table structure:
 * | Date | Title | Status | Link |
 *
 * @throws Error if INDEX.md cannot be read or written.
 */
async function appendIndexRow(repoRoot: string, date: string, title: string, filename: string): Promise<void> {
  const indexPath = join(repoRoot, INDEX_PATH);

  if (!existsSync(indexPath)) {
    throw new Error(`INDEX.md not found at ${indexPath}`);
  }

  const indexContent = await readFile(indexPath, 'utf-8');

  // Idempotency guard (AI-176): a retried rollback attempt for the same
  // postmortem must not accumulate a second INDEX.md row for it. Match on the
  // row's link target — the postmortem file path is the unique identity here,
  // independent of title/date formatting.
  const linkTarget = `(./postmortems/${filename})`;
  if (indexContent.includes(linkTarget)) {
    log('info', 'postmortem', 'skipped duplicate INDEX.md row — postmortem file already linked', { filename });
    return;
  }

  // Build the new row
  const newRow = `| ${date} | ${title} | TODO | [Local](./postmortems/${filename}) |`;

  // Append the row
  const updatedContent = indexContent.trimEnd() + '\n' + newRow + '\n';

  await writeFile(indexPath, updatedContent, 'utf-8');
}

/**
 * Creates a postmortem stub markdown file from a fixed template.
 *
 * Template sections:
 * - Impact (TODO — filled in by human)
 * - Detection (how the issue was detected)
 * - Timeline (ref-ID links via `pa ref` syntax)
 * - Root cause (TODO)
 * - Action items (checkboxes from audit record)
 *
 * @throws Error if the postmortems directory cannot be created or file cannot be written.
 */
export interface CreatePostmortemOptions {
  /**
   * Explicit override for the repo root postmortem files and INDEX.md rows are
   * written under. Test-only — production always omits this.
   *
   * Default (no override): resolved via `repoRootFromModule(__filename)` —
   * the TRUE repo root, found via git from THIS MODULE's own on-disk location
   * — never `process.cwd()`. AI-176: before this fix, two
   * self-improver.test.ts describes drove the real rollback path with cwd
   * left pointing at the live repo (no chdir), so every run silently wrote
   * real postmortem stubs + INDEX.md rows into production plans/ using the
   * test fixture's literal skillName ('x', 'coding-dirs-update') — the actual
   * origin of the duplicate/bogus rows found there. A caller that only
   * isolates process.cwd() is not a durable fix (same class as the
   * Task-Scheduler cwd=System32 bug, root CLAUDE.md 2026-08-23): resolving
   * against the module's own location makes the write root correct
   * regardless of ambient cwd, and callers that genuinely need isolation
   * (tests) must opt in explicitly via this field.
   */
  repoRoot?: string;
}

export async function createPostmortemStub(
  input: PostmortemInput,
  meta: PostmortemMetadata,
  opts: CreatePostmortemOptions = {}
): Promise<string> {
  const repoRoot = opts.repoRoot ?? await repoRootFromModule(__filename);

  // Wrong-root guard: only a repo ROOT carries plans/. If the resolved root
  // lacks it (a test fixture with no plans/ dir, an extracted subtree), a
  // rollback hook firing from here would litter stubs into an unrelated tree
  // — skip silently instead. Production always resolves to the real repo
  // root, which always has plans/ present.
  if (!existsSync(join(repoRoot, 'plans'))) {
    return '';
  }

  const postmortemsDir = join(repoRoot, POSTMORTEMS_DIR);

  // Ensure the postmortems directory exists
  if (!existsSync(postmortemsDir)) {
    await mkdir(postmortemsDir, { recursive: true });
  }

  const filename = `${input.date}-${input.slug}.md`;
  const filepath = join(postmortemsDir, filename);

  const content = renderPostmortemTemplate(input, meta);

  await writeFile(filepath, content, 'utf-8');

  // WPD6: Also append a row to INDEX.md
  try {
    await appendIndexRow(repoRoot, input.date, input.title, filename);
  } catch (err) {
    // Log but don't fail — the postmortem file itself is the critical output
    console.error(`[postmortem] Failed to append INDEX.md row: ${err}`);
  }

  return filepath;
}

function renderPostmortemTemplate(
  input: PostmortemInput,
  meta: PostmortemMetadata
): string {
  const { date, slug, title, timelineRefs, actionItems } = input;
  const { created, sourceAction, sourceSkill, sourceCommit } = meta;

  // Build Timeline section with ref-ID links
  const timelineLines = timelineRefs.map(ref => `- [${ref}](pa://${ref})`).join('\n');

  // Build Action Items section with unchecked checkboxes
  const actionItemLines = actionItems.map(item => `- [ ] ${item}`).join('\n');

  // Get the commit details for git-revert rollbacks
  const commitLine = sourceCommit
    ? `Condemned commit: \`${sourceCommit}\`\n`
    : '';

  return `# ${title}

**Date:** ${date}
**Created:** ${created}
**Source:** ${sourceAction} of skill \`${sourceSkill}\`
${commitLine}

## Impact

_TODO: Describe the impact of this incident._

## Detection

Detected via the self-improvement loop's rollback mechanism.

## Timeline

${timelineLines || '(No timeline refs available)'}

## Root Cause

_TODO: Investigate and document the root cause._

## Action Items

${actionItemLines || '(No action items defined)'}

---

*This postmortem stub was auto-generated by the self-improvement loop.*
*Unclosed action items are surfaced by the \`human-gated-blocker-watch\` skill after 30 days.*
`;
}
