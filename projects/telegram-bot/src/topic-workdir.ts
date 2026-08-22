import { mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { ConversationState } from './types.js';
import { getTopicBrainProjectDir } from './topic-brains.js';

export type WorkdirTier = 'override' | 'project' | 'topic-home' | 'bot-cwd';

export interface TopicWorkdir {
  dir: string;
  tier: WorkdirTier;
}

/**
 * Get the topic home directory path.
 * $PA_HOME/topic-brains/{chatId}_{threadId}
 */
export function topicHomeDir(chatId: number, threadId: number): string {
  const PA_HOME = process.env.PA_HOME ?? join(homedir(), '.pa');
  const topicKey = `${chatId}_${threadId}`;
  return join(PA_HOME, 'topic-brains', topicKey);
}

/**
 * Parse a Project pointer from BRAIN.md content.
 * Returns null if no valid pointer found.
 * This is exported for testing.
 */
export function parseProjectPointer(brainMarkdown: string): string | null {
  // Find the Project pointers section
  const sectionRegex = /## Project pointers\n([\s\S]+?)(?=\n##|\nOther topics:|\nCentral brain:|$)/i;
  const sectionMatch = brainMarkdown.match(sectionRegex);
  if (!sectionMatch) return null;

  const sectionContent = sectionMatch[1];
  const lines = sectionContent.split('\n');

  // Find the first bullet with an absolute path ending in CLAUDE.md
  for (const line of lines) {
    const bulletMatch = line.match(/^\s*-\s+(.+)$/);
    if (!bulletMatch) continue;

    let path = bulletMatch[1].trim();
    // Normalize backslashes to forward slashes
    path = path.replace(/\\/g, '/');

    // Check if it's an absolute Windows path ending in CLAUDE.md
    if (/^[A-Za-z]:\/.*\/CLAUDE\.md$/.test(path)) {
      // Return the directory (strip the filename)
      const lastSlash = path.lastIndexOf('/');
      return path.substring(0, lastSlash);
    }
  }

  return null; // No valid pointer found
}

/**
 * Resolve the workdir for a topic based on the cascade.
 * Pure function — performs no mkdir.
 * Order: cwd_override → brain Project pointer → topic home
 */
export async function resolveTopicWorkdir(state: ConversationState): Promise<TopicWorkdir> {
  // Tier 1: cwd_override (no stat — /code already validated at set time)
  if (state.cwd_override) {
    return { dir: state.cwd_override, tier: 'override' };
  }

  // Tier 2: brain Project pointer
  const projectDir = await getTopicBrainProjectDir(state.chat_id, state.thread_id);
  if (projectDir) {
    return { dir: projectDir, tier: 'project' };
  }

  // Tier 3: topic home
  return { dir: topicHomeDir(state.chat_id, state.thread_id), tier: 'topic-home' };
}

/**
 * Ensure the workdir exists, creating it if necessary.
 * For 'topic-home' tier, creates {dir}/scratch recursively.
 * On any error, falls back to BOT_CWD tier.
 */
export async function ensureTopicWorkdir(
  workdir: TopicWorkdir,
  fallbackCwd: string
): Promise<TopicWorkdir> {
  if (workdir.tier === 'topic-home') {
    try {
      // Create topic home and scratch subdirectory
      const scratchDir = join(workdir.dir, 'scratch');
      await mkdir(scratchDir, { recursive: true });
      return workdir;
    } catch {
      // Fallback to BOT_CWD on any mkdir error
      return { dir: fallbackCwd, tier: 'bot-cwd' };
    }
  }

  // Other tiers pass through unchanged
  return workdir;
}
