import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';

/**
 * Compute the sha256 hash (first 12 hex chars) and ISO-8601 mtime of a file.
 * Used for the bot startup dist-identity banner.
 */
export function computeFileIdentity(filePath: string): { sha: string; mtime: string } {
  const content = readFileSync(filePath);
  const fullHash = createHash('sha256').update(content).digest('hex');
  const sha = fullHash.slice(0, 12);

  const stats = statSync(filePath);
  const mtime = stats.mtime.toISOString();

  return { sha, mtime };
}

/**
 * Format the boot identity log line.
 * Format: `dist identity sha=<12hex> mtime=<ISO-8601>`
 * (No `[boot] ` prefix here — the logger call site supplies the module tag;
 * a literal prefix doubled it to `[boot] [boot]` in the log.)
 */
export function formatBootIdentity(filePath: string): string {
  const { sha, mtime } = computeFileIdentity(filePath);
  return `dist identity sha=${sha} mtime=${mtime}`;
}
