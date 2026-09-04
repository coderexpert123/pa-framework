import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as yamlStringify } from 'yaml';
import { flushLog } from '../src/lib/log.js';
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
  // Drain the logger's fire-and-forget queue FIRST. Entries are pinned to the
  // PA_HOME captured at enqueue time (pa/src/lib/log.ts), so a still-queued
  // append targets `dir` — and ensureLogFile() does a recursive mkdir, which
  // would RECREATE the directory we are about to remove (or race the rm and
  // leave a half-deleted tree behind).
  await flushLog();

  // DO NOT REGRESS: reset to the suite-wide temp PA_HOME set by
  // tests/test-env-setup.ts rather than deleting the variable. Deleting it
  // reopened a window — until the next beforeEach — in which paHome() fell
  // back to the REAL ~/.pa, and any late fire-and-forget log (worker-exec's
  // exit alert, the bg-task orphan sweep, a killed worker's late 'close'
  // event) wrote synthetic records into the production forensic log.
  //
  // 2026-08-17: this happened for real when a test file was run WITHOUT the
  // `--import test-env-setup.js` preload (a direct `node --test
  // dist/tests/x.test.js`, exactly the scoped-run form this repo's own
  // guidance recommends). With no preload, PA_TEST_LOG_HOME was never set, so
  // this branch fell to `delete process.env.PA_HOME` and every fire-and-forget
  // write after that point resolved paHome() to the REAL ~/.pa. 3 real
  // Telegram alerts reached chat/thread 3376 (`worker-under-test`, `test`,
  // `kill-tree-worker`; archive/2026-08-18-134211-app.log.jsonl:12647,12764,
  // 14202) and 64 `telegram`-module rows plus 40 of 63 429 rows carried the
  // `-1001234567` fixture chat id from pa/tests/telegram.test.ts:76 (the
  // 2026-08-23 alerts-week review §5.3). Fix: never delete PA_HOME —
  // mint a fresh temp home via mkdtempSync when no preload ran, so an unset
  // PA_TEST_LOG_HOME can no longer make paHome() fall back to the real ~/.pa.
  if (!process.env.PA_TEST_LOG_HOME) {
    // No preload ran (a direct `node --test dist/tests/x.test.js`). Mint a home
    // rather than unsetting: an unset PA_HOME makes paHome() resolve to the REAL
    // ~/.pa for every late fire-and-forget write.
    const fallback = mkdtempSync(join(tmpdir(), 'pa-test-home-'));
    process.env.PA_TEST_LOG_HOME = fallback;
  }
  process.env.PA_HOME = process.env.PA_TEST_LOG_HOME;
  process.env.PA_NOTIFY_DISABLED = process.env.PA_NOTIFY_DISABLED ?? '1';
  delete process.env.PA_BOT_PID;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {}
}
