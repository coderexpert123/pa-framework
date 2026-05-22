import { createReadStream, existsSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';

function paHome(): string {
  return process.env.PA_HOME ?? join(homedir(), '.pa');
}

function getAppLogPath(): string {
  return join(paHome(), 'app.log.jsonl');
}

// Log entries from app.log.jsonl have context fields spread at top level:
// { timestamp, level, module, message, ...ctx }
// For 'message sent' entries: { module: 'bot', message: 'message sent', refId, session_id, ... }
interface MessageSentEntry {
  module: string;
  message: string;
  refId?: string;
  session_id?: string;
}

/**
 * Scan app.log.jsonl for a 'message sent' entry with the given refId.
 * Returns the associated session_id, or null if not found.
 *
 * Reads from the tail (up to TAIL_LINES most-recent lines) since the Ref ID
 * from a replied message is almost always recent. If the Ref ID is not found
 * within the tail window, returns null — graceful degradation: /new still
 * resets context, just without seeding from history.
 */
export async function findSessionForRefId(refId: string): Promise<string | null> {
  const logPath = getAppLogPath();
  if (!existsSync(logPath)) return null;

  const TAIL_LINES = 10_000;
  const lines = await readTailLines(logPath, TAIL_LINES);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as MessageSentEntry;
      if (entry.module === 'bot' && entry.message === 'message sent' && entry.refId === refId) {
        return entry.session_id ?? null;
      }
    } catch {
      // skip malformed lines
    }
  }

  return null;
}

/**
 * Read up to maxLines lines from the tail of a file.
 * For small files reads the whole thing; for large files seeks near the end.
 */
async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  const stat = statSync(filePath);

  // Estimate: average log line ~200 bytes. Read 2x to be safe.
  const bytesToRead = maxLines * 200 * 2;

  let startByte = 0;
  if (stat.size > bytesToRead) {
    startByte = stat.size - bytesToRead;
  }

  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start: startByte, encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];

    rl.on('line', (line) => {
      lines.push(line);
    });

    rl.on('close', () => {
      // If we started mid-file, the first "line" may be a partial line — drop it.
      const result = startByte > 0 && lines.length > 0 ? lines.slice(1) : lines;
      resolve(result.slice(-maxLines));
    });

    rl.on('error', reject);
    stream.on('error', reject);
  });
}
