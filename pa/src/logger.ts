import { writeFile, readFile, readdir, mkdir, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { logsDir } from './paths.js';
import type { RunMeta } from './types.js';

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  // Use UTC to match ISO timestamps in .meta files
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function skillLogDir(skillName: string): string {
  return join(logsDir(), skillName);
}

/**
 * Rotate logs older than specified criteria.
 * Deletes log/meta pairs where the log file is older than maxAge or total size exceeds maxSize.
 */
export async function rotateLogs(
  skillName: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days
  maxSizeBytes: number = 10 * 1024 * 1024 // 10 MB
): Promise<{ deletedCount: number }> {
  const dir = skillLogDir(skillName);
  let deletedCount = 0;
  const now = Date.now();

  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith('.meta')) continue;

      const metaPath = join(dir, file);
      const logPath = metaPath.replace('.meta', '.log');

      try {
        const metaRaw = await readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw) as RunMeta;

        // Check age
        const logAge = now - new Date(meta.timestamp).getTime();
        if (logAge > maxAgeMs) {
          // File is too old, delete it
          await unlink(metaPath).catch(() => {});
          await unlink(logPath).catch(() => {});
          deletedCount++;
          continue;
        }

        // Check size
        const logStats = await stat(logPath).catch(() => ({ size: 0 }));
        if (logStats.size > maxSizeBytes) {
          // File is too large, delete it
          await unlink(metaPath).catch(() => {});
          await unlink(logPath).catch(() => {});
          deletedCount++;
        }
      } catch {
        // Skip corrupt or unreadable files
      }
    }

    if (deletedCount > 0) {
      console.log(`[log] Rotated ${deletedCount} log files for '${skillName}'`);
    }
  } catch (err) {
    console.warn(`[log] Failed to rotate logs for '${skillName}':`, err);
  }

  return { deletedCount };
}

export async function writeLog(skillName: string, output: string, meta: RunMeta): Promise<void> {
  const dir = skillLogDir(skillName);
  await mkdir(dir, { recursive: true });

  const ts = formatTimestamp(new Date(meta.timestamp));
  const nonce = randomBytes(3).toString('hex'); // prevent collision on concurrent runs
  const base = `${ts}-${nonce}`;

  await writeFile(join(dir, `${base}.log`), output, 'utf8');
  await writeFile(join(dir, `${base}.meta`), JSON.stringify(meta, null, 2), 'utf8');
}

export async function readLogs(
  skillName: string,
  count: number = 10
): Promise<Array<{ meta: RunMeta; logPath: string }>> {
  const dir = skillLogDir(skillName);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const metaFiles = files.filter((f) => f.endsWith('.meta')).sort().reverse();
  const results: Array<{ meta: RunMeta; logPath: string }> = [];

  for (const metaFile of metaFiles.slice(0, count)) {
    try {
      const raw = await readFile(join(dir, metaFile), 'utf8');
      const meta: RunMeta = JSON.parse(raw);
      const logFile = metaFile.replace('.meta', '.log');
      results.push({ meta, logPath: join(dir, logFile) });
    } catch {
      // Skip corrupt meta files
    }
  }

  return results;
}

export async function getLastRun(skillName: string): Promise<RunMeta | null> {
  const logs = await readLogs(skillName, 1);
  return logs.length > 0 ? logs[0].meta : null;
}

export async function getLastSuccessfulRun(skillName: string): Promise<RunMeta | null> {
  const logs = await readLogs(skillName, 20);
  for (const { meta } of logs) {
    if (meta.status === 'success') return meta;
  }
  return null;
}
