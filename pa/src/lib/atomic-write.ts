import { randomBytes } from 'crypto';
import { rename, unlink, writeFile } from 'fs/promises';

/**
 * Retry a rename operation ONLY on Windows EPERM/EACCES (file open elsewhere).
 * AI-150: pa catchup and bot both write maintenance-state.json concurrently;
 * Windows refuses to rename over a concurrently-open file.
 *
 * @param tmpPath Source file path (temp file to rename)
 * @param path Target path
 * @param opts.attempts Number of retry attempts (default 5)
 * @param opts.baseDelayMs Base backoff delay (default 50ms)
 * @param opts.jitterMs Jitter range override (tests inject 0 for deterministic timing)
 * @param renameFn Rename implementation (overridable for tests)
 * @throws Final error after all retries exhausted, or immediately for non-EPERM/EACCES
 */
export async function renameWithRetry(
  tmpPath: string,
  path: string,
  opts: { attempts?: number; baseDelayMs?: number; jitterMs?: number } = {},
  renameFn: (a: string, b: string) => Promise<void> = rename,
): Promise<void> {
  const maxAttempts = opts.attempts ?? 5;
  const baseDelay = opts.baseDelayMs ?? 50;
  const jitterMs = opts.jitterMs ?? 50; // default jitter range 0-50ms

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await renameFn(tmpPath, path);
      return; // success
    } catch (err: any) {
      // EPERM/EACCES on Windows → target likely open elsewhere, retry with backoff
      if (attempt < maxAttempts && (err?.code === 'EPERM' || err?.code === 'EACCES')) {
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * jitterMs);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        continue;
      }
      // Non-retryable error or final attempt → rethrow
      throw err;
    }
  }
}

// Atomic write helpers: write to a `.tmp` sibling, then rename into place.
// The `.tmp` suffix is deliberate — `jobs/reservation-gc.ts` already sweeps
// stale `~/.pa/*.tmp` artifacts older than 1h, so a crash mid-write leaves
// nothing durable behind.
function tmpPathFor(path: string): string {
  return `${path}.${process.pid.toString(36)}-${randomBytes(3).toString('hex')}.tmp`;
}

export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = tmpPathFor(path);
  try {
    await writeFile(tmp, data, 'utf8');
    await renameWithRetry(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomic(
  path: string,
  data: unknown,
  opts?: { spaces?: number },
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, opts?.spaces ?? 2));
}
