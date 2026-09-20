/**
 * Topic registry reader (2026-09-17) — the ONE parser of
 * ~/.pa/telegram-topic-names.json. The bot's topic-names.ts builds its
 * TopicNameMap from parseTopicRegistryJson; pa's typed voice-inbox router
 * reads names and descriptions from readTopicRegistry. Accepts both registry
 * shapes: a bare string name (legacy) and {name, description?,
 * guide_message_id?}. Adding a registry field means adding it here. Never
 * throws: a missing or corrupt file reads as [].
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paHome } from '../paths.js';

export interface TopicRegistryEntry {
  chatId: string;
  threadId: number;
  /** `<chatId>_<threadId>` */
  key: string;
  name: string;
  description?: string;
  guideMessageId?: number;
  /** true = the legacy bare-string shape (no description, no guide id). */
  legacyString: boolean;
}

export function topicRegistryPath(): string {
  return join(paHome(), 'telegram-topic-names.json');
}

export function parseTopicRegistryJson(json: unknown): TopicRegistryEntry[] {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return [];
  const out: TopicRegistryEntry[] = [];
  for (const [chatId, threads] of Object.entries(json as Record<string, unknown>)) {
    if (!threads || typeof threads !== 'object' || Array.isArray(threads)) continue;
    for (const [threadIdStr, value] of Object.entries(threads as Record<string, unknown>)) {
      const threadId = parseInt(threadIdStr, 10);
      if (isNaN(threadId)) continue;
      const key = `${chatId}_${threadId}`;
      if (typeof value === 'string') {
        if (value) out.push({ chatId, threadId, key, name: value, legacyString: true });
      } else if (value && typeof value === 'object') {
        const entry = value as { name?: unknown; description?: unknown; guide_message_id?: unknown };
        if (typeof entry.name === 'string' && entry.name) {
          out.push({
            chatId,
            threadId,
            key,
            name: entry.name,
            description: typeof entry.description === 'string' ? entry.description : undefined,
            guideMessageId: typeof entry.guide_message_id === 'number' ? entry.guide_message_id : undefined,
            legacyString: false,
          });
        }
      }
    }
  }
  return out;
}

export function readTopicRegistry(path: string = topicRegistryPath()): TopicRegistryEntry[] {
  try {
    return parseTopicRegistryJson(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return [];
  }
}
