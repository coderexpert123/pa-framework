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
import { readFile } from 'fs/promises';
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

  // Conversation turns are large (assistant replies often 1k–5k bytes). For
  // current file sizes (~6 MB) reading the whole file is the simplest correct
  // approach. If it grows past 50 MB, switch to a 1500-byte-per-line tail
  // estimate similar to scanAppLog().
  const raw = await readFile(path, 'utf8').catch(() => '');
  if (!raw) return null;

  const lines = raw.trim().split('\n').filter(Boolean);
  const start = Math.max(0, lines.length - TAIL_LINES);

  for (let i = lines.length - 1; i >= start; i--) {
    let entry: ConversationTurnEntry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.refId !== refId) continue;

    return {
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
  }

  return null;
}

async function scanAppLog(refId: string): Promise<RefRecord | null> {
  const path = join(paHome(), 'app.log.jsonl');
  if (!existsSync(path)) return null;

  const lines = await tailLines(path, TAIL_LINES, 200);
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: AppLogEntry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.refId !== refId) continue;
    if (!entry.message || !APP_LOG_MESSAGES.has(entry.message)) continue;

    return {
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
  }

  return null;
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
