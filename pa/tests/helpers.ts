import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as yamlStringify } from 'yaml';
import type { DraftMeta } from '../src/types.js';

/**
 * Create a temporary directory mimicking ~/.pa/ structure.
 * Sets process.env.PA_HOME so all path-dependent modules use it.
 */
export async function createTempPaHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pa-test-'));
  await mkdir(join(dir, 'skills'), { recursive: true });
  await mkdir(join(dir, 'logs'), { recursive: true });
  await mkdir(join(dir, 'skill-drafts'), { recursive: true });
  process.env.PA_HOME = dir;
  return dir;
}

/** Create a draft folder with skill.md and draft.meta.json. */
export async function createTempDraft(
  dir: string,
  name: string,
  skillContent: string,
  meta: DraftMeta
): Promise<void> {
  const draftDir = join(dir, 'skill-drafts', name);
  await mkdir(draftDir, { recursive: true });
  await writeFile(join(draftDir, 'skill.md'), skillContent, 'utf8');
  await writeFile(join(draftDir, 'draft.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

/** Write a config.yaml into the temp PA_HOME. */
export async function createTempConfig(dir: string, workers: any[], extra?: Record<string, any>): Promise<void> {
  const yaml = yamlStringify({ workers, ...extra });
  await writeFile(join(dir, 'config.yaml'), yaml, 'utf8');
}

/** Create a skill folder with skill.md. */
export async function createTempSkill(
  dir: string,
  name: string,
  content: string
): Promise<void> {
  const skillDir = join(dir, 'skills', name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'skill.md'), content, 'utf8');
}

/** Write a secrets.env into the temp PA_HOME. */
export async function createTempSecrets(dir: string, content: string): Promise<void> {
  await writeFile(join(dir, 'secrets.env'), content, 'utf8');
}

/** Clean up temp directory and reset PA_HOME. */
export async function cleanup(dir: string): Promise<void> {
  delete process.env.PA_HOME;
  delete process.env.PA_BOT_PID;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {}
}
