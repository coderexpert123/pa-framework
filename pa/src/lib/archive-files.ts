import { mkdir, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { basename, join, dirname } from 'path';
import lockfile from 'proper-lockfile';
import { safeLockOptions } from './safe-lock.js';
import { paHome } from '../paths.js';

export const RUNTIME_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;

function archiveDir(): string {
  return join(paHome(), 'archive');
}

function formatArchiveStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function nextArchivePath(baseName: string): Promise<string> {
  const dir = archiveDir();
  const stamp = formatArchiveStamp(new Date());
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const candidate = join(dir, `${stamp}${suffix}-${baseName}`);
    if (!(await pathExists(candidate))) return candidate;
    attempt++;
  }
}

/**
 * Ensures the target file is created with an empty object if it doesn't exist.
 * This is necessary for proper-lockfile to have a target to lock on.
 */
async function ensureFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (!(await pathExists(path))) {
    await writeFile(path, '', { flag: 'wx' }).catch((err: any) => {
      if (err.code !== 'EEXIST') throw err;
    });
  }
}

const rotationMutexes: Map<string, Promise<void>> = new Map();

/**
 * In-process mutex per file to prevent concurrent lock attempts from the same process.
 */
async function withRotationMutex<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = rotationMutexes.get(filePath) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  rotationMutexes.set(filePath, current);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    if (rotationMutexes.get(filePath) === current) {
      rotationMutexes.delete(filePath);
    }
    release();
  }
}

/**
 * Rotates a file if it exceeds the maximum allowed size.
 * Uses a combination of an in-process mutex and proper-lockfile to ensure 
 * cross-process safety during rotation.
 * 
 * @param filePath Path to the file to rotate.
 * @param upcomingBytes Estimated size of the data about to be appended (optional).
 * @param maxBytes Maximum allowed size before rotation.
 */
export async function rotateFileIfNeeded(
  filePath: string,
  upcomingBytes: number = 0,
  maxBytes: number = RUNTIME_ARCHIVE_MAX_BYTES,
): Promise<boolean> {
  let currentSize = 0;
  try {
    currentSize = (await stat(filePath)).size;
  } catch {
    // If file doesn't exist, it doesn't need rotation yet.
    return false;
  }

  if (currentSize + upcomingBytes <= maxBytes) return false;

  await ensureFile(filePath);
  
  return withRotationMutex(filePath, async () => {
    // Use a lock to ensure only one process performs the rotation.
    // realpath: false is used for Windows compatibility and to handle renames better.
    const release = await lockfile.lock(filePath, safeLockOptions('archive-rotate', { retries: 5, realpath: false }));
    try {
      // Re-check size after acquiring lock (another process might have rotated it already).
      const freshSize = (await stat(filePath)).size;
      if (freshSize + upcomingBytes <= maxBytes) return false;

      await mkdir(archiveDir(), { recursive: true });
      const archivedPath = await nextArchivePath(basename(filePath));
      
      // Atomic rename
      await rename(filePath, archivedPath);
      
      // Create fresh empty file so subsequent writers (or the same process) 
      // can continue immediately.
      await writeFile(filePath, '', 'utf8');
      
      return true;
    } finally {
      await release();
    }
  });
}

export async function listArchiveFiles(baseName: string, newestFirst: boolean = true): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(archiveDir());
  } catch {
    return [];
  }

  const matches = entries
    .filter((entry) => entry.endsWith(`-${baseName}`))
    .map((entry) => join(archiveDir(), entry));

  const enriched = await Promise.all(matches.map(async (path) => ({
    path,
    mtimeMs: (await stat(path)).mtimeMs,
  })));

  enriched.sort((a, b) => newestFirst ? b.mtimeMs - a.mtimeMs : a.mtimeMs - b.mtimeMs);
  return enriched.map((entry) => entry.path);
}

export interface ArchiveRetention {
  /** Delete archives whose mtime is older than this many days. */
  maxAgeDays?: number;
  /** Hard cap on total archive-dir bytes — deletes oldest-first until under. */
  maxTotalBytes?: number;
}

export const DEFAULT_ARCHIVE_RETENTION: Required<ArchiveRetention> = {
  maxAgeDays: 90,
  maxTotalBytes: 500 * 1024 * 1024, // 500 MB
};

/**
 * Archive files eligible for pruning, by basename suffix (rotation names shards
 * `<stamp>-<baseName>`). Explicit ALLOWLIST — anything not listed is kept
 * forever, failing safe for unknown names. In particular, rotated
 * conversation-history.jsonl shards are documented as PERMANENT (CLAUDE.md
 * "Permanent Archive" / "Deep Context Retrieval" instructs agents to scan them
 * for context beyond the rolling 20-turn window) and must never be deleted;
 * this also protects manually-parked files like TROUBLESHOOTING.md's
 * `conv-YYYY-MM-DD.jsonl`.
 */
const PRUNABLE_ARCHIVE_SUFFIXES = ['-app.log.jsonl', '-telegram-bot.log'];

function isPrunableArchiveFile(name: string): boolean {
  return PRUNABLE_ARCHIVE_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Enforce a retention policy on ~/.pa/archive/. rotateFileIfNeeded renames 5 MB
 * shards in here but nothing ever deleted them, so total disk was strictly
 * monotonic for the life of the install. This prunes by age first, then applies
 * a total-bytes backstop (oldest-first). Returns the number of files deleted.
 * Best-effort: individual unlink failures are swallowed.
 *
 * Only PRUNABLE_ARCHIVE_SUFFIXES are ever deleted, by BOTH the age loop and the
 * byte-cap loop; the byte cap is likewise computed over prunable files only
 * (permanent files don't count toward it — deleting every prunable file could
 * never get the total under the cap otherwise, and permanence is policy).
 */
export async function pruneArchive(
  retention: ArchiveRetention = {},
  // Test hook: Windows fs.unlink silently clears the read-only attribute and
  // retries, so a failing unlink can't be staged via the filesystem alone.
  unlinkImpl: (path: string) => Promise<void> = unlink,
): Promise<number> {
  const maxAgeDays = retention.maxAgeDays ?? DEFAULT_ARCHIVE_RETENTION.maxAgeDays;
  const maxTotalBytes = retention.maxTotalBytes ?? DEFAULT_ARCHIVE_RETENTION.maxTotalBytes;
  const dir = archiveDir();

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0; // no archive dir yet
  }

  const files = (await Promise.all(names.filter(isPrunableArchiveFile).map(async (name) => {
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (!s.isFile()) return null;
      return { path, mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  }))).filter((f): f is { path: string; mtimeMs: number; size: number } => f !== null);

  const ageCutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  // 1. Age-based prune.
  const survivors: { path: string; mtimeMs: number; size: number }[] = [];
  for (const f of files) {
    if (f.mtimeMs < ageCutoff) {
      try { await unlinkImpl(f.path); removed++; } catch { /* best-effort */ }
    } else {
      survivors.push(f);
    }
  }

  // 2. Total-bytes backstop — delete oldest-first until under the cap.
  survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let total = survivors.reduce((sum, f) => sum + f.size, 0);
  for (const f of survivors) {
    if (total <= maxTotalBytes) break;
    // Account for the file BEFORE attempting the unlink: if the unlink fails
    // (e.g. EBUSY/EPERM on a Windows file held open), leaving `total`
    // unchanged would make the loop compensate by deleting additional NEWER
    // shards — while the stuck file still occupies disk anyway. Best-effort
    // means: try each candidate once, never over-delete to compensate.
    total -= f.size;
    try { await unlinkImpl(f.path); removed++; } catch { /* best-effort */ }
  }

  return removed;
}
