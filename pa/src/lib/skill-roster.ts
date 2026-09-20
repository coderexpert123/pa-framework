import { PROTECTED_SKILLS } from '../validator.js';

export interface SkillRosterEntry {
  name: string;
  frontmatter?: { trigger_description?: string; description?: string };
}

export interface SkillRosterOpts {
  exclude?: ReadonlySet<string>;          // default PROTECTED_SKILLS
  maxLines?: number;                      // default 24
  maxChars?: number;                      // default 1500 (joined lines, pre-overflow)
  requireTriggerDescription?: boolean;    // default false — the `pa run` catalog sets true
}

/** Bullet-free line shape shared by every consumer: `[<name>] <desc>` —
 *  desc = trigger_description ?? description. Overflow line: `(+N more — pa list)`.
 *  Returns '' when nothing survives the filters. */
export function renderSkillRoster(skills: SkillRosterEntry[], opts?: SkillRosterOpts): string {
  const exclude = opts?.exclude ?? PROTECTED_SKILLS;
  const maxLines = opts?.maxLines ?? 24;
  const maxChars = opts?.maxChars ?? 1500;
  const requireTrigger = opts?.requireTriggerDescription ?? false;

  const lines: string[] = [];
  let overflow = 0;
  for (const s of skills) {
    if (exclude.has(s.name)) continue;
    const desc = s.frontmatter?.trigger_description ?? s.frontmatter?.description;
    if (requireTrigger && !s.frontmatter?.trigger_description) continue;
    if (lines.length >= maxLines) {
      overflow++;
      continue;
    }
    const line = `[${s.name}] ${desc ?? ''}`.trimEnd();
    const joined = [...lines, line].join('\n');
    if (joined.length > maxChars) {
      overflow++;
      continue;
    }
    lines.push(line);
  }
  if (lines.length === 0) return '';
  const suffix = overflow > 0 ? `\n(+${overflow} more — pa list)` : '';
  return lines.join('\n') + suffix;
}
