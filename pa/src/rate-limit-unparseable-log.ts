import { appendFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from './paths.js';
import { log } from './lib/log.js';

export interface UnparseableRateLimitEntry {
  timestamp: string;
  worker: string;
  raw: string;
  session_id?: string;
  classification?: string;
  reason: 'no-session-evidence' | 'minutes-zero' | 'other';
}

export async function appendUnparseableRateLimit(entry: UnparseableRateLimitEntry): Promise<void> {
  // Also emit to the structured log at WARN with the worker name. The JSONL file
  // alone is write-only in practice: zclaude's terminal 1113 fault landed here
  // four times over eight days (2026-07-11/13/14/19) and nobody saw it, because
  // nothing surfaced it where failures are actually read. An unclassifiable
  // rate-limit signal is a gap in the classifier, so it must be greppable.
  log('warn', 'rate-limits', `unparseable rate-limit output: ${entry.worker} (${entry.reason})`, {
    worker: entry.worker,
    reason: entry.reason,
    classification: entry.classification,
    session_id: entry.session_id,
    raw: entry.raw.slice(0, 300),
  });
  try {
    const path = join(paHome(), 'rate-limit-unparseable.jsonl');
    const line = JSON.stringify({ ...entry, raw: entry.raw.slice(0, 2000) }) + '\n';
    await appendFile(path, line, 'utf8');
  } catch (err) {
    console.warn('[rate-limit-unparseable] failed to write entry:', err);
  }
}
