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

export async function saveDraft(
  proposal: DraftProposal,
  sourceType: 'conversation' | 'failure'
): Promise<void> {
  const dir = join(draftsDir(), proposal.name);
  await mkdir(dir, { recursive: true });

  // Build skill.md content
  const fm: Record<string, any> = {};
  if (proposal.frontmatter.cron) fm.cron = proposal.frontmatter.cron;
  if (proposal.frontmatter.on_missed) fm.on_missed = proposal.frontmatter.on_missed;
  if (proposal.frontmatter.cwd) fm.cwd = proposal.frontmatter.cwd;
  if (proposal.frontmatter.secrets) fm.secrets = proposal.frontmatter.secrets;
  if (proposal.frontmatter.timeout) fm.timeout = proposal.frontmatter.timeout;
  if (proposal.frontmatter.idle_timeout) fm.idle_timeout = proposal.frontmatter.idle_timeout;
  if (proposal.frontmatter.trigger_description) fm.trigger_description = proposal.frontmatter.trigger_description;
  if (proposal.frontmatter.inject_triggers) fm.inject_triggers = proposal.frontmatter.inject_triggers;
  if (proposal.frontmatter.worker) fm.worker = proposal.frontmatter.worker;
  if (proposal.frontmatter.telegram_output) fm.telegram_output = proposal.frontmatter.telegram_output;

  const skillContent = Object.keys(fm).length > 0
    ? `---\n${yamlStringify(fm).trim()}\n---\n\n${proposal.prompt}`
    : proposal.prompt;

  await writeFile(draftSkillPath(proposal.name), skillContent, 'utf8');

  const meta: DraftMeta = {
    proposed_at: new Date().toISOString(),
    reason: proposal.reason,
    source_turns: proposal.source_message_ids,
    status: 'pending',
    fingerprint: computeFingerprint(proposal.name, proposal.prompt),
    source_type: sourceType,
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

export async function approveDraft(name: string): Promise<void> {
  const { skill, meta } = await loadDraft(name);

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

  const updated: DraftMeta = { ...meta, status: 'approved', reviewed_at: new Date().toISOString() };
  await writeFile(draftMetaPath(name), JSON.stringify(updated, null, 2), 'utf8');
}

export async function rejectDraft(name: string): Promise<void> {
  const { meta } = await loadDraft(name);
  const updated: DraftMeta = { ...meta, status: 'rejected', reviewed_at: new Date().toISOString() };
  await writeFile(draftMetaPath(name), JSON.stringify(updated, null, 2), 'utf8');
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
