import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { TelegramMessage } from './types.js';

export interface TopicEntry {
  name: string;
  description?: string;
  guide_message_id?: number;
}

export type TopicNameMap = Map<string, Map<number, TopicEntry>>;

export interface BranchEntry {
  parentThreadId: number;
  branchName: string;
  createdAt: string;
}

export type BranchIndex = Map<string, Map<number, BranchEntry>>;
// outer key: String(chatId), inner key: threadId (number), value: BranchEntry

function paHome(): string {
  return process.env.PA_HOME ?? join(homedir(), '.pa');
}

function getTopicNamesPath(): string {
  return join(paHome(), 'telegram-topic-names.json');
}

let topicFileMutex: Promise<void> = Promise.resolve();

async function withTopicFileMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = topicFileMutex;
  let release!: () => void;
  topicFileMutex = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Load topic names from disk. Returns empty map if file is missing or corrupt.
 * JSON structure (new): { [chatId: string]: { [threadId: string]: { name, description? } }
 * JSON structure (old, for backward compat): { [chatId: string]: { [threadId: string]: name }
 * threadId keys are parsed to numbers on load.
 */
export async function loadTopicNames(): Promise<TopicNameMap> {
  try {
    const raw = await readFile(getTopicNamesPath(), 'utf8');
    const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const map: TopicNameMap = new Map();
    for (const [chatId, threads] of Object.entries(json)) {
      const inner = new Map<number, TopicEntry>();
      for (const [threadIdStr, value] of Object.entries(threads)) {
        const threadId = parseInt(threadIdStr, 10);
        if (isNaN(threadId)) continue;

        // Handle both old format (string) and new format (object with name/description)
        if (typeof value === 'string') {
          // Old format: "0": "General" -> { name: "General", description: undefined }
          if (value) {
            inner.set(threadId, { name: value });
          }
        } else if (value && typeof value === 'object') {
          // New format: "0": { name: "General", description: "..." }
          const entry = value as { name?: string; description?: string; guide_message_id?: number };
          if (entry.name) {
            inner.set(threadId, { name: entry.name, description: entry.description, guide_message_id: entry.guide_message_id });
          }
        }
      }
      if (inner.size > 0) {
        map.set(chatId, inner);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Persist topic names to disk atomically (write to .tmp then rename).
 * Uses new format with objects containing name and optional description.
 */
export async function saveTopicNames(map: TopicNameMap): Promise<void> {
  await withTopicFileMutex(async () => {
    const json: Record<string, Record<string, TopicEntry>> = {};
    for (const [chatId, threads] of map.entries()) {
      const inner: Record<string, TopicEntry> = {};
      for (const [threadId, entry] of threads.entries()) {
        inner[String(threadId)] = entry;
      }
      json[chatId] = inner;
    }
    const path = getTopicNamesPath();
    const tmp = path + '.tmp';
    await writeFile(tmp, JSON.stringify(json, null, 2), 'utf8');
    await rename(tmp, path);
  });
}

/**
 * Update a single topic name in-memory and persist to disk.
 * Description is not passed — only service messages update names, descriptions are curated manually.
 */
export async function updateTopicName(
  map: TopicNameMap,
  chatId: number,
  threadId: number,
  name: string
): Promise<void> {
  const key = String(chatId);
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  // Preserve existing description and guide_message_id
  const existing = inner.get(threadId);
  inner.set(threadId, { name, description: existing?.description, guide_message_id: existing?.guide_message_id });
  await saveTopicNames(map);
}

/**
 * Set or update the description for a topic. Creates the entry with an empty name
 * if the topic is not yet registered (should be rare — topic creation fires first).
 * Persists atomically.
 */
export async function setTopicDescription(
  map: TopicNameMap,
  chatId: number,
  threadId: number,
  description: string
): Promise<void> {
  const key = String(chatId);
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  const existing = inner.get(threadId);
  inner.set(threadId, { name: existing?.name ?? '', description, guide_message_id: existing?.guide_message_id });
  await saveTopicNames(map);
}

/**
 * Look up a topic name. Returns undefined if not found.
 * Returns just the name string for backward compatibility.
 */
export function getTopicName(
  map: TopicNameMap,
  chatId: number,
  threadId: number
): string | undefined {
  return map.get(String(chatId))?.get(threadId)?.name;
}

// ─── Branch Index ─────────────────────────────────────────────────────────────

function getBranchIndexPath(): string {
  return join(paHome(), 'topic-branches.json');
}

/**
 * Load branch index from disk. Returns empty map if file is missing or corrupt.
 * JSON structure: { [chatId: string]: { [threadId: string]: BranchEntry } }
 */
export async function loadBranches(): Promise<BranchIndex> {
  try {
    const raw = await readFile(getBranchIndexPath(), 'utf8');
    const json = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const map: BranchIndex = new Map();
    for (const [chatId, threads] of Object.entries(json)) {
      const inner = new Map<number, BranchEntry>();
      for (const [threadIdStr, value] of Object.entries(threads)) {
        const threadId = parseInt(threadIdStr, 10);
        if (isNaN(threadId)) continue;
        if (value && typeof value === 'object') {
          const entry = value as BranchEntry;
          if (typeof entry.parentThreadId === 'number' && entry.branchName && entry.createdAt) {
            inner.set(threadId, entry);
          }
        }
      }
      if (inner.size > 0) {
        map.set(chatId, inner);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Persist branch index to disk atomically (write to .tmp then rename).
 */
export async function saveBranches(index: BranchIndex): Promise<void> {
  await withTopicFileMutex(async () => {
    const json: Record<string, Record<string, BranchEntry>> = {};
    for (const [chatId, threads] of index.entries()) {
      const inner: Record<string, BranchEntry> = {};
      for (const [threadId, entry] of threads.entries()) {
        inner[String(threadId)] = entry;
      }
      json[chatId] = inner;
    }
    const path = getBranchIndexPath();
    const tmp = path + '.tmp';
    await writeFile(tmp, JSON.stringify(json, null, 2), 'utf8');
    await rename(tmp, path);
  });
}

/**
 * Add or update a branch entry and persist to disk.
 */
export async function addBranch(
  index: BranchIndex,
  chatId: number,
  threadId: number,
  entry: BranchEntry
): Promise<void> {
  const key = String(chatId);
  let inner = index.get(key);
  if (!inner) {
    inner = new Map();
    index.set(key, inner);
  }
  inner.set(threadId, entry);
  await saveBranches(index);
}

/**
 * Remove a branch entry and persist to disk.
 * Removes the outer key if the inner map becomes empty.
 */
export async function removeBranch(
  index: BranchIndex,
  chatId: number,
  threadId: number
): Promise<void> {
  const key = String(chatId);
  const inner = index.get(key);
  if (!inner) return;
  inner.delete(threadId);
  if (inner.size === 0) {
    index.delete(key);
  }
  await saveBranches(index);
}

/**
 * Look up a branch entry. Returns undefined if not found.
 */
export function getBranchEntry(
  index: BranchIndex,
  chatId: number,
  threadId: number
): BranchEntry | undefined {
  return index.get(String(chatId))?.get(threadId);
}

/**
 * Find the threadId of a parent topic by human-readable name (case-insensitive).
 * Scans topicNames for the given chatId. Returns undefined if no match.
 */
export function findBranchParent(
  topicNames: TopicNameMap,
  chatId: number,
  parentName: string
): number | undefined {
  const inner = topicNames.get(String(chatId));
  if (!inner) return undefined;
  const lowerName = parentName.toLowerCase();
  for (const [threadId, entry] of inner.entries()) {
    if (entry.name.toLowerCase() === lowerName) {
      return threadId;
    }
  }
  return undefined;
}

// ─── Topic Event Extraction ────────────────────────────────────────────────────

/**
 * Extract a topic name event from a Telegram service message.
 * Returns null if the message is not a forum_topic_created or forum_topic_edited
 * service message, or if the event carries no name (e.g. icon-only edit).
 */
export function extractTopicEvent(
  msg: TelegramMessage
): { chatId: number; threadId: number; name: string } | null {
  // thread_id must be present — General topic (absent/undefined) never gets these events
  if (!msg.message_thread_id) return null;

  const threadId = msg.message_thread_id;
  const chatId = msg.chat.id;

  if (msg.forum_topic_created?.name) {
    return { chatId, threadId, name: msg.forum_topic_created.name };
  }

  if (msg.forum_topic_edited?.name) {
    return { chatId, threadId, name: msg.forum_topic_edited.name };
  }

  return null;
}
