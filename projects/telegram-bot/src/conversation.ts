import fs from 'fs-extra';
import { open as fsOpen } from 'fs/promises';
import { createInterface } from 'readline';
import lockfile from 'proper-lockfile';
import { join } from 'path';
import { homedir } from 'os';
import type { ConversationState, ConversationTurn } from './types.js';
import { rotateFileIfNeeded } from './archive-files.js';

const MAX_TURNS = 20;
const MAX_HISTORY_CHARS = 8000;

function paHome(): string {
  return process.env.PA_HOME ?? join(homedir(), '.pa');
}

function getStatePath(): string {
  return join(paHome(), 'telegram-bot-state.json');
}

function getTopicPath(chatId: number, threadId: number): string {
  return join(paHome(), `telegram-bot-topic-${chatId}_${threadId}.json`);
}

function getArchivePath(): string {
  return join(paHome(), 'conversation-history.jsonl');
}

/**
 * Tail-read last N bytes of a file. Returns empty string if file doesn't exist.
 * Used to avoid reading entire archive files for deduplication.
 */
async function tailRead(path: string, bytes: number): Promise<string> {
  try {
    const stats = await fs.stat(path);
    // console.log(`[tailRead] size=${stats.size}`);
    if (stats.size <= bytes) {
      const content = await fs.readFile(path, 'utf8');
      // console.log(`[tailRead] small file content: ${content}`);
      return content;
    }
    const fd = await fsOpen(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      await fd.read(buffer, 0, bytes, stats.size - bytes);
      const content = buffer.toString('utf8');
      const newlineIdx = content.indexOf('\n');
      if (newlineIdx !== -1) return content.slice(newlineIdx + 1);
      return '';
    } finally {
      await fd.close();
    }
  } catch (err) {
    // console.log(`[tailRead] error:`, err);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Per-thread archive watermarks — eliminates 64KB tail-scan window exhaustion
// ---------------------------------------------------------------------------

interface ArchiveWatermark {
  lastUserMsgId: number;
  lastTimestamp: string;
}

function getWatermarkPath(): string {
  return join(paHome(), 'conversation-archive-watermarks.json');
}

/**
 * Watermarks are only read/written inside archiveNewTurns(),
 * which holds proper-lockfile on the archive file for the entire sequence.
 * Do NOT call loadWatermarks/saveWatermarks from outside that lock.
 */
async function loadWatermarks(): Promise<Record<string, ArchiveWatermark>> {
  try {
    const raw = await fs.readFile(getWatermarkPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveWatermarks(wm: Record<string, ArchiveWatermark>): Promise<void> {
  const tmp = getWatermarkPath() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(wm), 'utf8');
  await fs.rename(tmp, getWatermarkPath());
}

async function archiveNewTurns(turns: ConversationTurn[], threadId?: number): Promise<void> {
  if (turns.length === 0) return;

  const archivePath = getArchivePath();
  const home = paHome();

  // Ensure directory and file exist for lockfile to work
  await fs.ensureDir(home);
  if (!(await fs.pathExists(archivePath))) {
    try {
      await fs.writeFile(archivePath, '', { flag: 'wx' });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  let release: (() => Promise<void>) | undefined;
  try {
    // Lock the archive file to prevent race conditions during read-filter-append
    release = await lockfile.lock(archivePath, { retries: 10, realpath: false });

    // Per-thread watermarks replace the 64KB tail-scan for dedup.
    // Tail-scan was vulnerable to window exhaustion: if the 64KB buffer contained
    // separate topics, lastArchivedUserMsgId stayed -1 and ALL
    // state turns would re-archive as duplicates.
    const threadKey = String(threadId ?? 0);

    // Rotate if needed (inside lock)
    await rotateFileIfNeeded(archivePath);

    const watermarks = await loadWatermarks();

    const wm = watermarks[threadKey] || { lastUserMsgId: -1, lastTimestamp: '' };

    // First call for this thread: fall back to tail scan to bootstrap the watermark
    // from the existing archive (backward compatibility with pre-watermark history).
    if (!watermarks[threadKey]) {
      const content = await tailRead(archivePath, 65536);
      const lines = content.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const t = JSON.parse(lines[i]) as ConversationTurn;
          if (threadId !== undefined && t.thread_id !== undefined && t.thread_id !== threadId) {
            continue;
          }
          if (t.timestamp > wm.lastTimestamp) wm.lastTimestamp = t.timestamp;
          if (t.role === 'user' && t.message_id !== undefined) {
            if (t.message_id > wm.lastUserMsgId) wm.lastUserMsgId = t.message_id;
          }
        } catch { /* skip corrupt lines */ }
      }
    }

    const newTurns = turns.filter((t) => {
      if (t.role === 'user' && t.message_id !== undefined) {
        return t.message_id > wm.lastUserMsgId;
      }
      return t.timestamp > wm.lastTimestamp;
    });

    if (newTurns.length > 0) {
      // Stamp with threadId if provided and not already present
      const stamped = threadId !== undefined
        ? newTurns.map(t => (t.thread_id === undefined ? { ...t, thread_id: threadId } : t))
        : newTurns;
      await fs.appendFile(archivePath, stamped.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8');

      // Update watermark from the newly archived turns
      for (const t of stamped) {
        if (t.timestamp > wm.lastTimestamp) wm.lastTimestamp = t.timestamp;
        if (t.role === 'user' && t.message_id !== undefined) {
          if (t.message_id > wm.lastUserMsgId) wm.lastUserMsgId = t.message_id;
        }
      }
    }

    // Always persist watermark (even if no new turns — establishes baseline for this thread)
    watermarks[threadKey] = wm;
    await saveWatermarks(watermarks);
  } catch (err) {
    console.error('[conversation] archiveNewTurns failed:', err);
  } finally {
    if (release) await release();
  }
}

function defaultState(chatId: number): ConversationState {
  return { chat_id: chatId, last_update_id: 0, thread_id: 0, turns: [] };
}

function defaultTopicState(chatId: number, threadId: number): ConversationState {
  return { chat_id: chatId, last_update_id: 0, thread_id: threadId, turns: [] };
}

export interface TopicStateRef {
  chatId: number;
  threadId: number;
  path: string;
}

export async function loadState(chatId: number): Promise<ConversationState> {
  try {
    const raw = await fs.readFile(getStatePath(), 'utf8');
    const data = JSON.parse(raw) as ConversationState;
    if (data.chat_id === chatId) return data;
    // Different chat_id — fresh conversation but preserve Telegram offset if valid
    const savedOffset = typeof data.last_update_id === 'number' ? data.last_update_id : 0;
    return { ...defaultState(chatId), last_update_id: savedOffset };
  } catch {
    return defaultState(chatId);
  }
}

export async function saveState(state: ConversationState): Promise<void> {
  // Archive before trimming so no turn is ever lost.
  try {
    await archiveNewTurns(state.turns, 0); // 0 = General topic for global state
  } catch (err) {
    console.error('[conversation] archive failed (non-fatal):', err);
  }

  // Trim history before saving
  let turns = state.turns.slice(-MAX_TURNS);

  // Also enforce character budget — drop oldest turns if too long
  let totalChars = turns.reduce((acc, t) => acc + t.text.length, 0);
  while (totalChars > MAX_HISTORY_CHARS && turns.length > 2) {
    const dropped = turns.shift()!;
    totalChars -= dropped.text.length;
  }

  await fs.writeFile(getStatePath(), JSON.stringify({ ...state, turns }, null, 2), 'utf8');
}

export async function loadTopicState(chatId: number, threadId: number): Promise<ConversationState> {
  try {
    const raw = await fs.readFile(getTopicPath(chatId, threadId), 'utf8');
    const data = JSON.parse(raw) as ConversationState;
    if (data.chat_id === chatId) {
      return { ...data, thread_id: data.thread_id ?? threadId };
    }
    return defaultTopicState(chatId, threadId);
  } catch {
    return defaultTopicState(chatId, threadId);
  }
}

export async function saveTopicState(state: ConversationState): Promise<void> {
  // Archive before trimming so no turn is lost.
  try {
    await archiveNewTurns(state.turns, state.thread_id);
  } catch (err) {
    console.error('[conversation] archive failed (non-fatal):', err);
  }

  let turns = state.turns.slice(-MAX_TURNS);
  let totalChars = turns.reduce((acc, t) => acc + t.text.length, 0);
  while (totalChars > MAX_HISTORY_CHARS && turns.length > 2) {
    const dropped = turns.shift()!;
    totalChars -= dropped.text.length;
  }

  await fs.writeFile(getTopicPath(state.chat_id, state.thread_id), JSON.stringify({ ...state, turns }, null, 2), 'utf8');
}

export async function listTopicStateRefs(): Promise<TopicStateRef[]> {
  const dir = paHome();
  try {
    const entries = await fs.readdir(dir);
    return entries
      .map((entry) => {
        const match = /^telegram-bot-topic-(-?\d+)_(\d+)\.json$/.exec(entry);
        if (!match) return null;
        return {
          chatId: Number.parseInt(match[1], 10),
          threadId: Number.parseInt(match[2], 10),
          path: join(dir, entry),
        } satisfies TopicStateRef;
      })
      .filter((entry): entry is TopicStateRef => entry !== null);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Archive history lookups (used by /new cross-session context restoration)
// ---------------------------------------------------------------------------

/**
 * Fetch up to `maxTurns` turns from `conversation-history.jsonl` belonging to
 * the given CLI session and topic thread.
 *
 * Algorithm: stream turns in order; for each turn with the matching thread_id,
 * assign it to a session group based on the `session_id` field (present on both
 * user and assistant turns). Collect the last `maxTurns` turns from the group
 * matching `sessionId`.
 *
 * Note: chat_id is not stored in archive turns — filtering by thread_id +
 * session_id is sufficient for a single-user PA.
 */
export async function findHistoricalSessionTurns(
  sessionId: string,
  threadId: number,
  maxTurns: number
): Promise<ConversationTurn[]> {
  const archivePath = getArchivePath();
  if (!(await fs.pathExists(archivePath))) return [];

  const matchedTurns: ConversationTurn[] = [];

  await streamArchiveLines(archivePath, (line) => {
    try {
      const turn = JSON.parse(line) as ConversationTurn;
      if (turn.thread_id !== threadId) return;
      if (turn.session_id === sessionId) {
        matchedTurns.push(turn);
      }
    } catch { /* skip malformed */ }
  });

  return matchedTurns.slice(-maxTurns);
}

/**
 * Fetch up to `maxTurns` most recent turns from the archive for a given topic.
 * Used by Phase 6B description generation to derive context for a topic.
 */
export async function findRecentTurnsByTopic(
  threadId: number,
  maxTurns: number
): Promise<ConversationTurn[]> {
  const archivePath = getArchivePath();
  if (!(await fs.pathExists(archivePath))) return [];

  const matched: ConversationTurn[] = [];

  await streamArchiveLines(archivePath, (line) => {
    try {
      const turn = JSON.parse(line) as ConversationTurn;
      if (turn.thread_id === threadId) {
        matched.push(turn);
      }
    } catch { /* skip malformed */ }
  });

  return matched.slice(-maxTurns);
}

/**
 * Stream lines from the archive file, calling `onLine` for each non-empty line.
 */
async function streamArchiveLines(
  archivePath: string,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(archivePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => { if (line.trim()) onLine(line); });
    rl.on('close', resolve);
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

export function addTurn(state: ConversationState, turn: ConversationTurn): void {
  state.turns.push(turn);
}

export function formatHistory(turns: ConversationTurn[]): string {
  if (turns.length === 0) return '(no prior conversation)';
  return turns
    .map((t) => {
      const label = t.role === 'user' ? 'User' : `Assistant${t.worker ? ` (${t.worker})` : ''}`;
      return `${label}: ${t.text}`;
    })
    .join('\n\n');
}
