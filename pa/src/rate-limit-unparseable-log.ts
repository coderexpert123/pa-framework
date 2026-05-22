import { appendFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from './paths.js';

export interface UnparseableRateLimitEntry {
  timestamp: string;
  worker: string;
  raw: string;
  session_id?: string;
  classification?: string;
  reason: 'no-session-evidence' | 'minutes-zero' | 'other';
}

export async function appendUnparseableRateLimit(entry: UnparseableRateLimitEntry): Promise<void> {
  try {
    const path = join(paHome(), 'rate-limit-unparseable.jsonl');
    const line = JSON.stringify({ ...entry, raw: entry.raw.slice(0, 2000) }) + '\n';
    await appendFile(path, line, 'utf8');
  } catch (err) {
    console.warn('[rate-limit-unparseable] failed to write entry:', err);
  }
}
