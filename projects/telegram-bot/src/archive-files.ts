import { mkdir, readdir, rename, stat, writeFile } from 'fs/promises';
import { basename, join, dirname } from 'path';
import lockfile from 'proper-lockfile';
import { homedir } from 'os';

export const RUNTIME_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;

function paHome(): string {
  return process.env.PA_HOME ?? join(homedir(), '.pa');
}

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
    const release = await lockfile.lock(filePath, { retries: 5, realpath: false });
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
