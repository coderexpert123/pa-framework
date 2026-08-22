import { readFile, readdir, stat } from 'fs/promises';
import { constants } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface TopicBrainInfo {
  path: string;
  consolidated: string | null;  // ISO timestamp or null if stamp unparsable
  covers: string | null;         // ISO timestamp or null if stamp unparsable
}

/**
 * Read topic brain info from the BRAIN.md file.
 * Returns null if the file doesn't exist.
 * Returns degraded info (null stamps) if file exists but stamp is missing or unparsable.
 * Never throws — all failure paths resolve.
 */
export async function getTopicBrainInfo(
  chatId: number,
  threadId: number
): Promise<TopicBrainInfo | null> {
  const PA_HOME = process.env.PA_HOME ?? join(homedir(), '.pa');
  const topicKey = `${chatId}_${threadId}`;
  const brainPath = join(PA_HOME, 'topic-brains', topicKey, 'BRAIN.md');

  try {
    // Read only first 4,096 bytes (stamp must be within this range per §3.2)
    const buffer = await readFile(brainPath);
    const firstChunk = buffer.toString('utf8', 0, Math.min(4096, buffer.length));

    // Stamp format per §3.2:
    // <!-- topic-brain: consolidated=2026-08-21T21:30:00+05:30 covers=2026-08-21T18:03:11.000Z -->
    const stampRegex = /<!-- topic-brain: consolidated=([^\s]+) covers=([^\s]+)(?: folded-into=[^\s]+)? -->/;
    const match = firstChunk.match(stampRegex);

    if (match) {
      return {
        path: brainPath,
        consolidated: match[1],
        covers: match[2]
      };
    } else {
      // File exists but stamp missing or unparsable → degraded info
      return {
        path: brainPath,
        consolidated: null,
        covers: null
      };
    }
  } catch (error) {
    // ENOENT is the normal case for most topics — no error-level logging
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    // Any other error (permissions, corrupt file) → treat as missing
    return null;
  }
}

/**
 * Read the project directory from a topic brain's BRAIN.md.
 * Returns null if the file doesn't exist or has no valid Project pointer.
 * Never throws — all failure paths resolve.
 */
export async function getTopicBrainProjectDir(
  chatId: number,
  threadId: number
): Promise<string | null> {
  const PA_HOME = process.env.PA_HOME ?? join(homedir(), '.pa');
  const topicKey = `${chatId}_${threadId}`;
  const brainPath = join(PA_HOME, 'topic-brains', topicKey, 'BRAIN.md');

  try {
    // Read only first 16 KB (section must be within this range)
    const buffer = await readFile(brainPath);
    const firstChunk = buffer.toString('utf8', 0, Math.min(16384, buffer.length));

    // Find the Project pointers section
    const sectionRegex = /## Project pointers\n([\s\S]+?)(?=\n##|\nOther topics:|\nCentral brain:|$)/i;
    const sectionMatch = firstChunk.match(sectionRegex);
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
  } catch (error) {
    // ENOENT or any other error → treat as missing
    return null;
  }
}

/**
 * Read the topic exemptions registry.
 * Returns empty map if the file doesn't exist, is unreadable, or is malformed JSON.
 * Never throws — all failure paths resolve to an empty map.
 */
export async function getTopicExemptions(): Promise<ReadonlyMap<string, string>> {
  const PA_HOME = process.env.PA_HOME ?? join(homedir(), '.pa');
  const exemptPath = join(PA_HOME, 'topic-brains', 'EXEMPT.json');

  try {
    const content = await readFile(exemptPath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, string>;

    // Validate schema: each value should be a known exemption class
    const validClasses = new Set(['output-only', 'duplicate', 'one-off', 'pinned-guide', 'dormant']);
    const map = new Map<string, string>();

    for (const [topicKey, className] of Object.entries(parsed)) {
      if (typeof className === 'string' && validClasses.has(className)) {
        map.set(topicKey, className);
      } else {
        // Log unknown class to stderr but continue
        console.error(`[topic-brains] Unknown exemption class "${className}" for topic ${topicKey}`);
      }
    }

    return map;
  } catch (error) {
    // ENOENT, JSON parse error, or any other error → empty map
    return new Map();
  }
}
