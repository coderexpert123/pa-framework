import { writeFile, readFile, readdir, mkdir, unlink, stat, rename } from 'fs/promises';
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

// ---------------------------------------------------------------------------
// O(1) latest-run pointer — avoids readdir+sort+parse over the whole skill
// log dir just to answer "what was the most recent run" (getLastRun) / "what
// was the most recent SUCCESSFUL run" (getLastSuccessfulRun). A minutely
// skill (e.g. reminders) accumulates thousands of files; without this, every
// call to either function scans the entire directory.
// ---------------------------------------------------------------------------

interface LatestPointer {
  latest: RunMeta;
  /** Most recent run with status === 'success', tracked since this pointer
   * started existing. Absent if no success has been recorded yet (either a
   * brand-new/always-failing skill, or one whose real last success predates
   * this pointer — see the fallback in getLastSuccessfulRun). */
  latestSuccess?: RunMeta;
}

function latestPointerPath(skillName: string): string {
  return join(skillLogDir(skillName), 'latest.json');
}

async function readLatestPointer(skillName: string): Promise<LatestPointer | null> {
  try {
    const raw = await readFile(latestPointerPath(skillName), 'utf8');
    return JSON.parse(raw) as LatestPointer;
  } catch {
    return null; // missing, or corrupt — callers fall back to a directory scan
  }
}

async function writeLatestPointer(skillName: string, pointer: LatestPointer): Promise<void> {
  const path = latestPointerPath(skillName);
  // Unique per-write tmp name: a FIXED tmp path shared by two overlapping
  // writeLog calls for the same skill could tear (writer A renames while
  // writer B is mid-writeFile into the same tmp). Stray tmps from a crash are
  // swept opportunistically by rotateLogs.
  const tmp = `${path}.${process.pid.toString(36)}-${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(pointer), 'utf8');
  await rename(tmp, path);
}

/** Matches the exact format writeLog() produces: YYYYMMDD-HHMMSS-<hex>.meta (UTC). */
const META_FILENAME_TS_RE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[a-f0-9]+\.meta$/;

/** Parse the UTC timestamp encoded in a .meta filename, without reading the
 * file. Returns null if the filename doesn't match writeLog()'s format (e.g.
 * a foreign/legacy file) — callers should fall back to content-based parsing
 * in that case. Round-trips the parse through formatTimestamp to reject
 * shape-valid-but-impossible dates (Date.UTC silently rolls e.g. month 13
 * over instead of failing). */
function parseMetaFilenameTimestamp(filename: string): number | null {
  const m = META_FILENAME_TS_RE.exec(filename);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const tsMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (formatTimestamp(new Date(tsMs)) !== `${y}${mo}${d}-${h}${mi}${s}`) return null;
  return tsMs;
}

/**
 * Rotate logs older than specified criteria.
 * Deletes log/meta pairs where the log file is older than maxAge or total size exceeds maxSize.
 *
 * Age is derived from the .meta FILENAME (already timestamp-prefixed by
 * writeLog) rather than reading+parsing file content — avoids readFile+
 * JSON.parse on every file on every pass, which matters once a minutely
 * skill's dir holds thousands of entries. Falls back to content-based
 * parsing only for a filename that doesn't match the expected format (e.g.
 * a foreign/legacy file), preserving exact prior behavior for that case.
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
      // Opportunistic sweep of pointer tmp files stranded by a crash between
      // writeLatestPointer's writeFile and rename (unique-named, so they'd
      // otherwise accumulate). >1h old means no rename is coming.
      if (/^latest\.json\..+\.tmp$/.test(file)) {
        try {
          const s = await stat(join(dir, file));
          if (now - s.mtimeMs > 60 * 60 * 1000) await unlink(join(dir, file)).catch(() => {});
        } catch { /* best-effort */ }
        continue;
      }
      if (!file.endsWith('.meta')) continue;

      const metaPath = join(dir, file);
      const logPath = metaPath.replace('.meta', '.log');

      try {
        let tsMs = parseMetaFilenameTimestamp(file);
        if (tsMs === null) {
          // Anomalous filename — fall back to reading the content, exactly
          // as rotateLogs always did before the filename-based fast path.
          const metaRaw = await readFile(metaPath, 'utf8');
          const meta = JSON.parse(metaRaw) as RunMeta;
          tsMs = new Date(meta.timestamp).getTime();
        }

        // Check age
        const logAge = now - tsMs;
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

  // Update the O(1) lookup pointer LAST (fail-safe write order): if the
  // process crashes between the .meta write above and this rename, the
  // pointer is left present-but-stale-by-one-run rather than corrupt or
  // missing-entirely. getLastRun then returns the PRIOR run until the next
  // successful write repairs it — a skill looks slightly more overdue than
  // reality, never less, so nothing is ever silently suppressed. Best-effort:
  // a failure here just means getLastRun/getLastSuccessfulRun fall back to a
  // directory scan until the next write.
  try {
    const existing = await readLatestPointer(skillName);
    const pointer: LatestPointer = {
      latest: meta,
      latestSuccess: meta.status === 'success' ? meta : existing?.latestSuccess,
    };
    await writeLatestPointer(skillName, pointer);
  } catch {
    // best-effort — see fallback logic in getLastRun/getLastSuccessfulRun
  }
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
  const pointer = await readLatestPointer(skillName);
  if (pointer?.latest) return pointer.latest;

  // Fallback — no pointer yet (pre-migration skill dir, or zero runs ever).
  // Self-healing: the next writeLog() call populates the pointer, after
  // which this scan is never needed again for this skill.
  const logs = await readLogs(skillName, 1);
  return logs.length > 0 ? logs[0].meta : null;
}

export async function getLastSuccessfulRun(skillName: string): Promise<RunMeta | null> {
  const pointer = await readLatestPointer(skillName);
  if (pointer?.latestSuccess) return pointer.latestSuccess;

  // Fallback — pointer missing entirely, OR present but has recorded no
  // success yet. The latter is ambiguous (could be a skill that's been
  // failing continuously since the pointer started, OR one whose real last
  // success predates it / falls outside this bounded scan), so fall back to
  // the same bounded scan this function has always used to find a
  // historical success the pointer doesn't know about yet.
  const logs = await readLogs(skillName, 20);
  for (const { meta } of logs) {
    if (meta.status === 'success') return meta;
  }
  return null;
}
