/**
 * Durable per-chat index of recent voice/audio/video-note messages
 * (plan: 2026-08-31-retranscribe-smart.md). Recorded at intake BEFORE
 * transcription so failed notes are recoverable by a bare /retranscribe,
 * across restarts. Never throws — an index failure must never break
 * transcription or dispatch (voice.ts house style). Injectable: every
 * function takes the attachments root explicitly; tests pass a tmp dir.
 */

import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { paHome } from '../../../pa/dist/src/paths.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { KIND_LABEL, type AudioAttachmentKind, type TelegramAudioLike } from './voice.js';

export type AudioIndexStatus = 'pending' | 'ok' | 'failed';

export interface AudioIndexEntry {
  messageId: number;
  threadId: number | null;
  kind: AudioAttachmentKind;
  media: TelegramAudioLike;
  date: string; // ISO 8601, recording time
  status: AudioIndexStatus;
  engine?: string;
  reason?: string;
}

/** What recordAudioMessage accepts — status is forced to 'pending'. */
export type AudioIndexRecordInput = Omit<AudioIndexEntry, 'status' | 'engine' | 'reason'>;

export interface AudioIndexFile {
  version: 1;
  entries: AudioIndexEntry[];
}

/** Default root used by main.ts: <paHome>/attachments. Tests never call this. */
export function audioIndexRoot(): string {
  return join(paHome(), 'attachments');
}

const MAX_ENTRIES = 25;

function indexFilePath(root: string, chatId: number): string {
  return join(root, String(chatId), 'audio-index.json');
}

// Per-chat write serialization (single bot process; same-chat dispatches are
// already serial — this is belt-and-braces for concurrent mark/record). Keyed
// by root|chatId so tests with distinct roots never share a chain.
const writeChains = new Map<string, Promise<void>>();

function enqueueWrite(key: string, op: () => Promise<void>): Promise<void> {
  const chained = (writeChains.get(key) ?? Promise.resolve())
    .then(op)
    .catch((err) => {
      logger.warn('audio-index', 'index write failed', { key, error: err instanceof Error ? err.message : String(err) });
    });
  writeChains.set(key, chained);
  return chained;
}

/** Missing, corrupt, wrong-version, or unreadable file → empty index. Never throws. */
export async function loadAudioIndex(root: string, chatId: number): Promise<AudioIndexFile> {
  try {
    const raw = await readFile(indexFilePath(root, chatId), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === 1 && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries };
    }
    return { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

/** Atomic replace: tmp file in the same directory, then rename over the target. */
async function writeIndexAtomic(root: string, chatId: number, file: AudioIndexFile): Promise<void> {
  const dest = indexFilePath(root, chatId);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(file), 'utf-8');
  await rename(tmp, dest);
}

/**
 * Upsert keyed by media.file_unique_id: a re-sent note replaces the old entry
 * (incoming date wins, status resets to 'pending', engine/reason cleared),
 * then prunes to the 25 newest by date DESC (ties broken by messageId DESC).
 * Never throws.
 */
export async function recordAudioMessage(root: string, chatId: number, entry: AudioIndexRecordInput): Promise<void> {
  await enqueueWrite(`${root}|${chatId}`, async () => {
    const current = await loadAudioIndex(root, chatId);
    const next: AudioIndexEntry = { ...entry, status: 'pending' };
    const entries = current.entries.filter((e) => e.media?.file_unique_id !== next.media.file_unique_id);
    entries.push(next);
    entries.sort((a, b) => (a.date === b.date ? (b.messageId ?? 0) - (a.messageId ?? 0) : a.date < b.date ? 1 : -1));
    await writeIndexAtomic(root, chatId, { version: 1, entries: entries.slice(0, MAX_ENTRIES) });
  });
}

/**
 * Update an entry's outcome in place. No-op (not an error) when the entry or
 * the file is missing. 'ok' sets engine (if given) and clears reason; 'failed'
 * sets reason (if given) and clears engine. Never throws.
 */
export async function markAudioResult(
  root: string,
  chatId: number,
  fileUniqueId: string,
  status: 'ok' | 'failed',
  extra?: { engine?: string; reason?: string }
): Promise<void> {
  await enqueueWrite(`${root}|${chatId}`, async () => {
    const current = await loadAudioIndex(root, chatId);
    const hit = current.entries.find((e) => e.media?.file_unique_id === fileUniqueId);
    if (!hit) return;
    hit.status = status;
    if (status === 'ok') {
      if (extra?.engine !== undefined) hit.engine = extra.engine;
      delete hit.reason;
    } else {
      if (extra?.reason !== undefined) hit.reason = extra.reason;
      delete hit.engine;
    }
    await writeIndexAtomic(root, chatId, current);
  });
}

/** PURE. Exact thread match (null === null); newest status!=='ok' first, else
 * newest overall; undefined when nothing is indexed for this thread. */
export function selectRetranscribeTarget(entries: AudioIndexEntry[], threadId: number | null): AudioIndexEntry | undefined {
  const inThread = entries.filter((e) => (e.threadId ?? null) === threadId);
  if (inThread.length === 0) return undefined;
  const newestFirst = [...inThread].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return newestFirst.find((e) => e.status !== 'ok') ?? newestFirst[0];
}

/** PURE. `Voice message, 3 min ago` — labels come from voice.ts's KIND_LABEL
 * (single label table; voice.test.ts pins the values). Age buckets: <60s
 * "just now"; <60m "N min ago"; <24h "N h ago"; else "N d ago". A future/
 * unparseable date reads as "just now". */
export function describeAudioTarget(entry: AudioIndexEntry, now?: Date): string {
  const label = KIND_LABEL[entry.kind] ?? 'Media message';
  const at = now ?? new Date();
  const ms = at.getTime() - new Date(entry.date).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return `${label}, just now`;
  if (ms < 3_600_000) return `${label}, ${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${label}, ${Math.floor(ms / 3_600_000)} h ago`;
  return `${label}, ${Math.floor(ms / 86_400_000)} d ago`;
}
