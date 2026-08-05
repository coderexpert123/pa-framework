import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { formatIST } from '../../../pa/dist/src/ist.js';

/**
 * AI-101 Layer 2: same-turn write path into the Ecosystem KB's Sources.md
 * (the cross-topic system-of-record index — see that file's own header, and
 * bot-instructions.md's Grounding Sources rule). Lets a worker record a
 * decision the moment it's made instead of waiting for the nightly
 * ecosystem-kb skill sweep. Deliberately narrow: only ever updates or appends
 * a domain section's "Recent" line — never touches any other KB file, never
 * deletes a section, never needs the git-snapshot safety net the full skill
 * run has (the nightly run reconciles/cleans this up regardless).
 */

/** No hardcoded personal default (mirrors PA_BRIEFS_DIR's precedent in context.ts) —
 *  this is a personal knowledge-base path, not something a public framework clone
 *  should ship a default for. Unset means the feature is simply off. */
export function kbSourcesPath(): string | undefined {
  return process.env.PA_KB_SOURCES_PATH;
}

const DOMAIN_MAX = 100;
const NOTE_MAX = 300;

export interface KbNoteResult {
  content: string;
  matchedExisting: boolean;
}

/**
 * Pure transform: apply a dated note to a domain section within Sources.md's
 * existing content. Updates an existing `## {domain}` section's "Recent" line
 * and "Last updated" date if found (case-insensitive match); otherwise
 * appends a new minimal LIVING section at the end. No I/O — callers do the
 * read/write so this is trivially unit-testable.
 */
export function applyKbNote(
  content: string,
  domain: string,
  note: string,
  now: Date
): KbNoteResult {
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = formatIST(now);
  const recentLine = `- **Recent**: ${note} (auto, ${timeStr})`;

  const headingRe = new RegExp(`^## ${escapeRegExp(domain)}\\s*$`, 'im');
  const headingMatch = headingRe.exec(content);

  if (!headingMatch) {
    const newSection = `\n## ${domain}\n\n<!-- LIVING SECTION -->\n\n*Last updated: ${dateStr}*\n\n${recentLine}\n\n---\n`;
    const separator = content.endsWith('\n') ? '' : '\n';
    return { content: content + separator + newSection, matchedExisting: false };
  }

  // Section body runs from the heading to the next `## ` heading or end of file.
  const sectionStart = headingMatch.index;
  const afterHeading = content.slice(sectionStart + headingMatch[0].length);
  const nextHeadingRel = /^## /m.exec(afterHeading);
  const sectionEnd = nextHeadingRel ? sectionStart + headingMatch[0].length + nextHeadingRel.index : content.length;

  let section = content.slice(sectionStart, sectionEnd);

  section = /^\*Last updated:.*\*$/m.test(section)
    ? section.replace(/^\*Last updated:.*\*$/m, `*Last updated: ${dateStr}*`)
    : section + `\n*Last updated: ${dateStr}*\n`;

  section = /^- \*\*Recent\*\*:.*$/m.test(section)
    ? section.replace(/^- \*\*Recent\*\*:.*$/m, recentLine)
    : section.replace(/\n---\s*$/, '') + `\n${recentLine}\n---\n`;

  return {
    content: content.slice(0, sectionStart) + section + content.slice(sectionEnd),
    matchedExisting: true,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate + persist a kb_note action. Never throws — logs and returns false
 * on any failure (a KB-write hiccup must not break the reply that carried it).
 */
export async function appendKbNote(domain: string, note: string): Promise<boolean> {
  const path = kbSourcesPath();
  if (!path) return false; // feature off — PA_KB_SOURCES_PATH not configured
  if (!domain || !note || domain.length > DOMAIN_MAX || note.length > NOTE_MAX) return false;

  try {
    await mkdir(dirname(path), { recursive: true });
    let existing = '';
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      existing = '# Sources\n\nCross-topic system-of-record index.\n\n---\n';
    }
    const { content } = applyKbNote(existing, domain, note, new Date());
    await writeFile(path, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}
