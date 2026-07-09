import { readFile, writeFile, readdir, mkdir, rm, stat, copyFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { stringify as yamlStringify } from 'yaml';
import { draftsDir, skillsDir } from './paths.js';
import { parseFrontmatter } from './skills.js';
import { DEFAULT_TIMEOUT, DEFAULT_IDLE_TIMEOUT } from './types.js';
import type { DraftMeta, DraftProposal, Skill, SkillFrontmatter, TelegramOutput } from './types.js';

function draftSkillPath(name: string): string {
  return join(draftsDir(), name, 'skill.md');
}

function draftMetaPath(name: string): string {
  return join(draftsDir(), name, 'draft.meta.json');
}

export function computeFingerprint(_name: string, prompt: string): string {
  return createHash('sha256')
    .update(prompt.slice(0, 200).toLowerCase().trim())
    .digest('hex');
}

/**
 * Serialize a (partial or full) SkillFrontmatter + prompt into skill.md content.
 * Shared by saveDraft() (sparse, LLM-authored frontmatter) and applyFix() in validator.ts
 * (full frontmatter from an existing deployed skill, via loadSkill()) so both stay in sync
 * on which fields round-trip to disk.
 *
 * Note: fields that loadSkill() always defaults (on_missed, timeout, idle_timeout,
 * inject_triggers, no_fallback, topic) will always be written explicitly when serializing
 * a full loaded Skill's frontmatter, even if the original skill.md omitted them — harmless
 * (same effective value) but slightly more verbose than the source file. Not worth the extra
 * complexity of tracking which fields were explicitly authored vs. defaulted.
 */
export function serializeSkillMd(frontmatter: Partial<SkillFrontmatter>, prompt: string): string {
  const fm: Record<string, any> = {};
  if (frontmatter.cron) fm.cron = frontmatter.cron;
  if (frontmatter.on_missed) fm.on_missed = frontmatter.on_missed;
  if (frontmatter.cwd) fm.cwd = frontmatter.cwd;
  if (frontmatter.secrets) fm.secrets = frontmatter.secrets;
  if (frontmatter.timeout) fm.timeout = frontmatter.timeout;
  if (frontmatter.idle_timeout) fm.idle_timeout = frontmatter.idle_timeout;
  if (frontmatter.trigger_description) fm.trigger_description = frontmatter.trigger_description;
  if (frontmatter.inject_triggers) fm.inject_triggers = frontmatter.inject_triggers;
  if (frontmatter.worker) fm.worker = frontmatter.worker;
  if (frontmatter.no_fallback) fm.no_fallback = frontmatter.no_fallback;
  if (frontmatter.cmd) fm.cmd = frontmatter.cmd;
  if (frontmatter.topic) fm.topic = frontmatter.topic;
  if (frontmatter.critical) fm.critical = frontmatter.critical;
  if (frontmatter.telegram_output) fm.telegram_output = frontmatter.telegram_output;

  return Object.keys(fm).length > 0
    ? `---\n${yamlStringify(fm).trim()}\n---\n\n${prompt}`
    : prompt;
}

/**
 * Find the first unused name among baseName, baseName-2, baseName-3, ... by checking
 * both skillsDir() and draftsDir(). Used to avoid isDuplicate()'s by-name check silently
 * dropping a genuinely new fix/reinforce proposal just because an earlier, unrelated fix
 * for the same target skill already occupies the plain "<target>-fix" name.
 */
export async function uniqueDraftName(baseName: string): Promise<string> {
  let candidate = baseName;
  let suffix = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const takenAsSkill = await stat(join(skillsDir(), candidate)).then(() => true, () => false);
    const takenAsDraft = await stat(join(draftsDir(), candidate)).then(() => true, () => false);
    if (!takenAsSkill && !takenAsDraft) return candidate;
    candidate = `${baseName}-${suffix}`;
    suffix++;
  }
}

export async function saveDraft(
  proposal: DraftProposal,
  sourceType: 'conversation' | 'failure' | 'feedback'
): Promise<void> {
  const dir = join(draftsDir(), proposal.name);
  await mkdir(dir, { recursive: true });

  const skillContent = serializeSkillMd(proposal.frontmatter, proposal.prompt);
  await writeFile(draftSkillPath(proposal.name), skillContent, 'utf8');

  const meta: DraftMeta = {
    proposed_at: new Date().toISOString(),
    reason: proposal.reason,
    source_turns: proposal.source_message_ids,
    status: 'pending',
    fingerprint: computeFingerprint(proposal.name, proposal.prompt),
    source_type: sourceType,
    ...(proposal.target_skill ? { target_skill: proposal.target_skill } : {}),
  };

  await writeFile(draftMetaPath(proposal.name), JSON.stringify(meta, null, 2), 'utf8');
}

export async function loadDraft(name: string): Promise<{ skill: Skill; meta: DraftMeta }> {
  if (!name || /[\/\\]|\.\./.test(name)) {
    throw new Error(`Invalid draft name: '${name}'`);
  }

  const skillPath = draftSkillPath(name);
  const metaPath = draftMetaPath(name);

  let raw: string;
  try {
    raw = await readFile(skillPath, 'utf8');
  } catch {
    throw new Error(`Draft '${name}' not found at ${skillPath}`);
  }

  const { meta: fm, body } = parseFrontmatter(raw);

  let telegramOutput: TelegramOutput | undefined;
  if (fm.telegram_output) {
    telegramOutput = {
      chat_id: String(fm.telegram_output.chat_id),
      thread_id: fm.telegram_output.thread_id,
      token_secret: fm.telegram_output.token_secret,
    };
  }

  const frontmatter: SkillFrontmatter = {
    cron: fm.cron,
    on_missed: fm.on_missed || 'latest',
    cwd: fm.cwd,
    secrets: fm.secrets,
    timeout: fm.timeout || DEFAULT_TIMEOUT,
    idle_timeout: fm.idle_timeout || DEFAULT_IDLE_TIMEOUT,
    trigger_description: fm.trigger_description,
    inject_triggers: !!fm.inject_triggers,
    worker: fm.worker,
    telegram_output: telegramOutput,
    critical: !!fm.critical,
  };

  const skill: Skill = { name, path: skillPath, frontmatter, prompt: body };

  let draftMeta: DraftMeta;
  try {
    draftMeta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch {
    throw new Error(`Draft metadata for '${name}' not found or corrupt at ${metaPath}`);
  }

  return { skill, meta: draftMeta };
}

export async function listDrafts(
  filter?: 'pending' | 'approved' | 'rejected'
): Promise<Array<{ skill: Skill; meta: DraftMeta }>> {
  const dir = draftsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: Array<{ skill: Skill; meta: DraftMeta }> = [];
  for (const entry of entries) {
    try {
      const s = await stat(join(dir, entry));
      if (!s.isDirectory()) continue;
      const draft = await loadDraft(entry);
      if (!filter || draft.meta.status === filter) {
        results.push(draft);
      }
    } catch {
      // Skip corrupt drafts
    }
  }

  return results;
}

/**
 * Update a draft's meta.json only — no skillsDir() deployment. Used by rejectDraft(),
 * and by applyFix() in validator.ts, which deploys by overwriting target_skill's own
 * skill.md directly (not by copying the draft under its own name) and only needs this
 * function for the approval bookkeeping/audit-trail record.
 */
export async function markDraftMeta(name: string, updates: Partial<DraftMeta>): Promise<void> {
  const { meta } = await loadDraft(name);
  const updated: DraftMeta = { ...meta, ...updates, reviewed_at: updates.reviewed_at ?? new Date().toISOString() };
  await writeFile(draftMetaPath(name), JSON.stringify(updated, null, 2), 'utf8');
}

export async function approveDraft(name: string, extra?: Partial<DraftMeta>): Promise<void> {
  await loadDraft(name); // validates the draft exists and is readable before deploying

  const targetDir = join(skillsDir(), name);
  const targetSkill = join(targetDir, 'skill.md');

  // Refuse if skill already exists
  try {
    await stat(targetSkill);
    throw new Error(`Skill '${name}' already exists at ${targetSkill}. Remove it first.`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    // ENOENT — skill doesn't exist yet, continue
  }

  await mkdir(targetDir, { recursive: true });
  await copyFile(draftSkillPath(name), targetSkill);

  await markDraftMeta(name, { status: 'approved', ...extra });
}

export async function rejectDraft(name: string): Promise<void> {
  await markDraftMeta(name, { status: 'rejected' });
}

export async function isDuplicate(proposal: DraftProposal): Promise<boolean> {
  const fingerprint = computeFingerprint(proposal.name, proposal.prompt);

  // Check by name in active skills
  try {
    await stat(join(skillsDir(), proposal.name, 'skill.md'));
    return true;
  } catch {}

  // Check by name in existing drafts (catches same name with different prompt)
  try {
    await stat(join(draftsDir(), proposal.name, 'skill.md'));
    return true;
  } catch {}

  // Check by fingerprint in existing drafts (catches same prompt with different name)
  const drafts = await listDrafts();
  return drafts.some((d) => d.meta.fingerprint === fingerprint);
}

export async function cleanRejected(): Promise<number> {
  const drafts = await listDrafts('rejected');
  let count = 0;
  for (const { skill } of drafts) {
    try {
      await rm(join(draftsDir(), skill.name), { recursive: true, force: true });
      count++;
    } catch {}
  }
  return count;
}
