/**
 * Unified ref-ID lookup. Given any refId minted by the bot or pa skills
 * (`c-XXXX`, `g-XXXX`, `l-XXXX`, `z-XXXX`, `s-XXXX`), resolve it to a full
 * record showing what message produced it. Backs the `pa ref <refId>` CLI.
 *
 * Lookup order:
 *  1. ~/.pa/conversation-history.jsonl — preferred; carries full text for
 *     bot replies (Phase 2 added the `refId` field to assistant turns).
 *  2. ~/.pa/app.log.jsonl — covers system messages (pins, help, branch,
 *     failover, lock-busy banners), skill alerts, and pre-Phase-2 bot replies
 *     whose conversation-history.jsonl entry lacks the refId field.
 */

import { createReadStream, existsSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { paHome } from '../paths.js';

const TAIL_LINES = 10_000;

export interface RefRecord {
  refId: string;
  kind: 'turn' | 'pin' | 'help' | 'branch' | 'lock_busy' | 'failover' | 'system' | 'skill_alert';
  timestamp: string;
  worker?: string;
  chatId?: number;
  threadId?: number;
  messageId?: number;
  sessionId?: string;
  text?: string;
  source: 'conversation-history' | 'app-log';
}

interface ConversationTurnEntry {
  role?: string;
  text?: string;
  timestamp?: string;
  message_id?: number;
  thread_id?: number;
  worker?: string;
  session_id?: string;
  refId?: string;
}

interface AppLogEntry {
  timestamp?: string;
  level?: string;
  module?: string;
  message?: string;
  refId?: string;
  worker?: string;
  session_id?: string;
  chatId?: number;
  threadId?: number;
  messageId?: number;
  kind?: string;
  textPreview?: string;
  text?: string;
}

const APP_LOG_MESSAGES = new Set([
  'message sent',
  'system message sent',
  'skill message sent',
  'skill message sent (plain-text fallback)',
]);

export async function lookupRefId(refId: string): Promise<RefRecord | null> {
  const fromTurns = await scanConversationHistory(refId);
  if (fromTurns) return fromTurns;
  return scanAppLog(refId);
}

async function scanConversationHistory(refId: string): Promise<RefRecord | null> {
  const path = join(paHome(), 'conversation-history.jsonl');
  if (!existsSync(path)) return null;

  // Byte-seek the tail instead of reading the whole file — same tailLines()
  // helper scanAppLog uses below. 1500 bytes/line (vs. scanAppLog's 200)
  // because conversation turns are large (assistant replies often 1k–5k
  // bytes); this was previously deferred in favor of a whole-file read
  // bounded only by the 5MB rotation invariant.
  const lines = await tailLines(path, TAIL_LINES, 1500);
  if (lines.length === 0) return null;

  let found: RefRecord | null = null;
  let foundMessageId: number | undefined;
  let foundText: string | undefined;
  let ambiguousTimestamp: string | undefined;
  const wide = isWideRefId(refId);

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: ConversationTurnEntry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (typeof entry !== 'object' || entry === null) continue; // e.g. a literal `null`/number line
    if (entry.refId !== refId) continue;

    if (!found) {
      found = {
        refId,
        kind: 'turn',
        timestamp: entry.timestamp ?? '',
        worker: entry.worker,
        threadId: entry.thread_id,
        messageId: entry.message_id,
        sessionId: entry.session_id,
        text: entry.text,
        source: 'conversation-history',
      };
      foundMessageId = entry.message_id;
      foundText = entry.text;
      if (wide) break; // wide refs can't collide — no need to scan for ambiguity
      continue; // legacy ref: keep scanning the window for a genuine ambiguity
    }

    // Suppress legitimate same-logical-message repeats: equal defined
    // message_ids, or byte-identical text (a turn re-archived after a crash,
    // or copied across topics by /merge — assistant archive turns rarely
    // carry message_id, so text equality is the working discriminator here).
    if (foundMessageId !== undefined && entry.message_id === foundMessageId) continue;
    if (foundText !== undefined && entry.text === foundText) continue;
    ambiguousTimestamp = entry.timestamp;
  }

  if (found && ambiguousTimestamp !== undefined) warnAmbiguous(refId, found.timestamp, ambiguousTimestamp);
  return found;
}

/**
 * Ambiguity detection scope: ONLY legacy short refIds can genuinely collide.
 * Since Phase 3A, refs are minted with 6 random bytes (12 hex chars, 2^48
 * space) — two entries sharing a wide refId within the 10k-line tail window
 * are the same logical send by construction (multi-chunk/multi-chat fan-out
 * logs one line per chunk per chat with the same refId, and coding-dirs
 * deliberately reuses one refId for its recurring pin), not a collision
 * (in-window collision odds ≈ 1e-8). Legacy 4-hex refs (65,536-value space,
 * 80+ real collisions measured) are where wrong-record resolution lives, so
 * the scan continues for those and warns — at most ONCE per lookup — via
 * console.warn (stderr, not the structured app.log.jsonl logger: this backs
 * the interactive `pa ref` CLI, and warning into the very file being scanned
 * would add to exactly the log growth Phases 1-2 bounded).
 */
const WIDE_REF_HEX_LEN = 8;

function isWideRefId(refId: string): boolean {
  const dash = refId.indexOf('-');
  return dash !== -1 && refId.length - dash - 1 >= WIDE_REF_HEX_LEN;
}

function warnAmbiguous(refId: string, foundTimestamp: string, otherTimestamp: string | undefined): void {
  console.warn(
    `[ref-lookup] refId_ambiguous: "${refId}" matches multiple distinct entries — returning the most recent (${foundTimestamp}); an older entry (${otherTimestamp ?? ''}) is shadowed.`
  );
}

async function scanAppLog(refId: string): Promise<RefRecord | null> {
  const path = join(paHome(), 'app.log.jsonl');
  if (!existsSync(path)) return null;

  const lines = await tailLines(path, TAIL_LINES, 200);

  let found: RefRecord | null = null;
  let foundMessageId: number | undefined;
  let ambiguousTimestamp: string | undefined;
  const wide = isWideRefId(refId);

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: AppLogEntry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (typeof entry !== 'object' || entry === null) continue; // e.g. a literal `null`/number line
    if (entry.refId !== refId) continue;
    if (!entry.message || !APP_LOG_MESSAGES.has(entry.message)) continue;

    if (!found) {
      found = {
        refId,
        kind: appLogKind(entry),
        timestamp: entry.timestamp ?? '',
        worker: entry.worker,
        chatId: entry.chatId,
        threadId: entry.threadId,
        messageId: entry.messageId,
        sessionId: entry.session_id,
        text: entry.textPreview ?? entry.text,
        source: 'app-log',
      };
      foundMessageId = entry.messageId;
      if (wide) break; // wide refs can't collide — no need to scan for ambiguity
      continue; // legacy ref: keep scanning the window for a genuine ambiguity
    }

    // Legacy entries: equal defined messageIds = same logical message
    // (repeated pin edits). Anything else could be a real 16-bit collision —
    // flag it. (Legacy multi-chunk sends share a refId with no messageId and
    // differing per-chunk previews; they'll warn until they age out of the
    // ~15-day tail window — acceptable transitional noise on an
    // interactive-only path, preferred over heuristics that could mask a
    // genuine collision.)
    if (foundMessageId !== undefined && entry.messageId === foundMessageId) continue;
    ambiguousTimestamp = entry.timestamp;
  }

  if (found && ambiguousTimestamp !== undefined) warnAmbiguous(refId, found.timestamp, ambiguousTimestamp);
  return found;
}

function appLogKind(entry: AppLogEntry): RefRecord['kind'] {
  if (entry.message === 'message sent') return 'turn';
  if (entry.message === 'system message sent') {
    const k = entry.kind;
    if (k === 'pin' || k === 'help' || k === 'branch' || k === 'lock_busy' || k === 'failover' || k === 'system') return k;
    return 'system';
  }
  return 'skill_alert';
}

/**
 * Read the last `maxLines` lines from a file by seeking near the end (cheap
 * for large files). For small files reads the whole content.
 *
 * `bytesPerLineEstimate` controls how many bytes to read for the requested
 * line budget — tuned per source (~200 for app.log.jsonl).
 */
async function tailLines(path: string, maxLines: number, bytesPerLineEstimate: number): Promise<string[]> {
  const stat = statSync(path);
  const bytesToRead = maxLines * bytesPerLineEstimate * 2;
  const startByte = stat.size > bytesToRead ? stat.size - bytesToRead : 0;

  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { start: startByte, encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const lines: string[] = [];
    rl.on('line', (line) => { lines.push(line); });
    rl.on('close', () => {
      const result = startByte > 0 && lines.length > 0 ? lines.slice(1) : lines;
      resolve(result.slice(-maxLines));
    });
    rl.on('error', reject);
    stream.on('error', reject);
  });
}
