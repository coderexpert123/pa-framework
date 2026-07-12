import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import { skillsDir, paHome } from './paths.js';
import { DEFAULT_TIMEOUT, DEFAULT_IDLE_TIMEOUT } from './types.js';
import type { Skill, SkillFrontmatter, TelegramOutput } from './types.js';

export function parseFrontmatter(content: string): { meta: Record<string, any>; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    return { meta: {}, body: content };
  }

  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) {
    return { meta: {}, body: content };
  }

  const yamlBlock = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).trim();
  const meta = parseYaml(yamlBlock) || {};
  return { meta, body };
}

/**
 * Interpolate ${VAR_NAME} references against process.env. If a referenced env
 * var is unset, leaves the literal `${VAR_NAME}` in place so the error surfaces
 * (rather than silently mis-routing to an empty string).
 *
 * ${PA_HOME} is special-cased to paHome() rather than a raw process.env.PA_HOME
 * read: paHome() defaults to homedir()+'.pa' internally when the env var is
 * unset, but that default is never written back to process.env — so a user
 * relying on the implicit default (the common case) would see "${PA_HOME}"
 * left un-interpolated in any skill's cwd/cmd, not silently resolved to the
 * right directory (2026-07-10, fresh-install dry-run finding B).
 *
 * Applied to: cwd, cmd, telegram_output.chat_id, telegram_output.token_secret,
 * telegram_output.thread_id (with numeric coercion). NOT applied to: secrets[]
 * array entries (those are env-var NAMES, not values), body content, other fields.
 */
export function interpolate(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return s;
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => {
    if (k === 'PA_HOME') return paHome();
    return process.env[k] ?? `\${${k}}`;
  });
}

function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

export async function loadSkill(name: string): Promise<Skill> {
  // Validate skill name — prevent path traversal
  if (!name || /[\/\\]|\.\./.test(name)) {
    throw new Error(`Invalid skill name: '${name}'`);
  }
  const skillPath = join(skillsDir(), name, 'skill.md');
  let raw: string;
  try {
    raw = await readFile(skillPath, 'utf8');
  } catch {
    throw new Error(`Skill '${name}' not found at ${skillPath}`);
  }

  const { meta, body } = parseFrontmatter(raw);

  let telegramOutput: TelegramOutput | undefined;
  if (meta.telegram_output) {
    const rawThreadId = meta.telegram_output.thread_id;
    // Numeric coercion: literal numbers pass through; interpolated strings convert back.
    let threadId: number | undefined;
    if (typeof rawThreadId === 'number') {
      threadId = rawThreadId;
    } else if (typeof rawThreadId === 'string') {
      const interp = interpolate(rawThreadId);
      const n = Number(interp);
      threadId = Number.isFinite(n) ? n : undefined;
    }
    telegramOutput = {
      chat_id: interpolate(String(meta.telegram_output.chat_id))!,
      thread_id: threadId,
      token_secret: interpolate(meta.telegram_output.token_secret) ?? meta.telegram_output.token_secret,
    };
  }

  // cwd and cmd support ${VAR} interpolation against process.env (Cat J).
  // Resolution order: interpolate first, then resolvePath() expands "~".
  const cwdInterp = interpolate(meta.cwd);
  const frontmatter: SkillFrontmatter = {
    cron: meta.cron,
    on_missed: meta.on_missed || 'latest',
    cwd: cwdInterp ? resolvePath(cwdInterp) : undefined,
    secrets: meta.secrets,
    timeout: meta.timeout || DEFAULT_TIMEOUT,
    idle_timeout: meta.idle_timeout || DEFAULT_IDLE_TIMEOUT,
    trigger_description: meta.trigger_description,
    inject_triggers: !!meta.inject_triggers,
    worker: meta.worker,
    cmd: interpolate(meta.cmd),
    topic: meta.topic || meta.queue || (meta.priority === 'high' ? 'reminders' : 'default'),
    telegram_output: telegramOutput,
    no_fallback: typeof meta.no_fallback === 'string'
      ? String(meta.no_fallback).toLowerCase() === 'true'
      : !!meta.no_fallback,
    critical: !!meta.critical,
    worker_args: Array.isArray(meta.worker_args)
      ? meta.worker_args.map((a: unknown) => String(a))
      : undefined,
  };

  return { name, path: skillPath, frontmatter, prompt: body };
}

export async function listSkills(): Promise<Skill[]> {
  const dir = skillsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      const s = await stat(entryPath);
      if (!s.isDirectory()) continue;
      const skill = await loadSkill(entry);
      skills.push(skill);
    } catch {
      // Skip invalid skill directories
    }
  }

  return skills;
}
