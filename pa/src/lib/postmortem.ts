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
import { paHome } from '../paths.js';

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

// Postmortems are LIVING STATE: they are written under PA_HOME (~/.pa), never
// the repo tree — the same rule as every other runtime store (2026-09-04
// relocation, A16 adjudication; the old repo-side location held no records on
// this deployment, so no legacy read-fallback was added). The layout mirrors
// the old structure (index in the parent of postmortems/) so the row-link
// format `(./postmortems/<file>)` is unchanged.
const PA_PLANS_DIR = 'plans';
const POSTMORTEMS_DIR = join(PA_PLANS_DIR, 'postmortems');
const INDEX_PATH = join(PA_PLANS_DIR, 'INDEX.md');

/**
 * Appends a row to the internal plans index for a new postmortem.
 *
 * The row format matches the existing INDEX.md table structure:
 * | Date | Title | Status | Link |
 *
 * @throws Error if INDEX.md cannot be read or written.
 */
async function appendIndexRow(baseDir: string, date: string, title: string, filename: string): Promise<void> {
  const indexPath = join(baseDir, INDEX_PATH);

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
/**
 * Creates a postmortem stub under PA_HOME. Test isolation is via the PA_HOME
 * env var (the suite's standard convention) — there is deliberately NO
 * override parameter: the AI-176 repoRoot override existed only because the
 * write root was repo-derived (module location vs process.cwd() ambiguity).
 * paHome() is unambiguous by definition, so the old wrong-root guard
 * ("resolved root carries plans/") has no remaining hazard to guard.
 */
export async function createPostmortemStub(
  input: PostmortemInput,
  meta: PostmortemMetadata
): Promise<string> {
  const baseDir = paHome();

  const postmortemsDir = join(baseDir, POSTMORTEMS_DIR);

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
    await appendIndexRow(baseDir, input.date, input.title, filename);
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
