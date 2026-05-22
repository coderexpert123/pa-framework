import { readFile, readdir, stat, open } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

export function resolveStateDir(stateDir: string): string {
  return stateDir.replace(/^~/, homedir());
}

interface LatestStateResult {
  path: string;
  mtime: Date;
}

export interface AgentState {
  status: string;
  verdict: 'alive' | 'stuck' | 'unknown';
  lastEntry?: any;
}

/**
 * Find the most recently modified file in a directory tree matching a pattern.
 * Walks one level of subdirectories (sufficient for both Claude and Gemini state dirs).
 */
export async function findLatestStateFile(dir: string, pattern: string): Promise<LatestStateResult | null> {
  try {
    const ext = pattern.replace('*', ''); // "*.jsonl" -> ".jsonl"
    let latest: LatestStateResult | null = null;

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        try {
          const subEntries = await readdir(fullPath);
          for (const sub of subEntries) {
            if (sub.endsWith(ext)) {
              const fp = join(fullPath, sub);
              const s = await stat(fp);
              if (!latest || s.mtime > latest.mtime) {
                latest = { path: fp, mtime: s.mtime };
              }
            }
          }
        } catch {}
      } else if (entry.name.endsWith(ext)) {
        const s = await stat(fullPath);
        if (!latest || s.mtime > latest.mtime) {
          latest = { path: fullPath, mtime: s.mtime };
        }
      }
    }
    return latest;
  } catch {
    return null;
  }
}

export async function getLatestStateMtime(dir: string, pattern: string): Promise<Date | null> {
  const result = await findLatestStateFile(dir, pattern);
  return result?.mtime ?? null;
}

/**
 * Read the last 32KB of the most recently modified state file in a directory.
 * Returns raw string content (may be truncated JSON — that's intentional).
 */
export async function readStateTail(dir: string, pattern: string): Promise<string | null> {
  try {
    const result = await findLatestStateFile(dir, pattern);
    if (!result) return null;

    const fileStat = await stat(result.path);
    const readSize = Math.min(fileStat.size, 32768);
    if (fileStat.size > readSize) {
      const fh = await open(result.path, 'r');
      try {
        const buf = Buffer.alloc(readSize);
        await fh.read(buf, 0, readSize, fileStat.size - readSize);
        return buf.toString('utf8');
      } finally {
        await fh.close();
      }
    } else {
      return await readFile(result.path, 'utf8');
    }
  } catch {
    return null;
  }
}

/**
 * Analyze the conversation state file to determine what the agent is doing
 * and whether it should be kept alive or killed.
 *
 * Reads the last N lines of the JSONL/JSON and applies rules:
 * - tool_use with no tool_result → tool still running → ALIVE
 * - assistant ending with "?" → asking a question we can't answer → STUCK
 * - same tool_use failing 3+ times → retry loop → STUCK
 * - recent tool_result or assistant content → actively working → ALIVE
 * - nothing parseable → UNKNOWN
 */
export async function analyzeAgentState(dir: string, pattern: string): Promise<AgentState> {
  try {
    const content = await readStateTail(dir, pattern);
    if (content === null) return { status: 'no state file found', verdict: 'unknown' };

    const lines = content.trim().split('\n');
    const recentLines = lines.slice(-10);

    // Parse all recent entries
    const entries: any[] = [];
    for (const line of recentLines) {
      try { entries.push(JSON.parse(line)); } catch {}
    }

    // Support for single JSON session file (Gemini format)
    if (entries.length === 0 || (entries.length === 1 && Array.isArray(entries[0]?.messages))) {
      try {
        const full = entries.length === 1 ? entries[0] : JSON.parse(content);
        if (full.messages && Array.isArray(full.messages)) {
          const messages = full.messages.slice(-10);
          for (const msg of messages) {
            const entry: any = {
              role: msg.type === 'gemini' ? 'assistant' : (msg.type === 'user' ? 'user' : msg.role),
              type: msg.type === 'gemini' ? 'assistant' : msg.type,
              content: msg.content,
              ...msg
            };

            // Detect pending tool calls in Gemini format
            if (msg.toolCalls && msg.toolCalls.length > 0) {
              const lastCall = msg.toolCalls[msg.toolCalls.length - 1];
              if (!lastCall.result) {
                entry.type = 'tool_use';
                entry.name = lastCall.name || lastCall.displayName;
              } else {
                // Completed tool calls
                entries.push(entry);
                entries.push({ type: 'tool_result', role: 'tool' });
                continue;
              }
            }
            entries.push(entry);
          }
        }
      } catch {}
    }

    if (entries.length === 0) {
      return { status: 'no parseable entries', verdict: 'unknown' };
    }

    const last = entries[entries.length - 1];

    // --- Rule 1: Pending tool call (tool_use with no subsequent tool_result) ---
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === 'tool_result' || e.role === 'tool') {
        break; // tool completed, not pending
      }
      if (e.type === 'tool_use') {
        const toolName = e.name || e.tool || 'unknown';
        return {
          status: `waiting for tool: ${toolName}`,
          verdict: 'alive',
          lastEntry: e,
        };
      }
    }

    // --- Rule 2: Assistant asking a question (ends with ?) ---
    if (last.type === 'assistant' || last.role === 'assistant' || last.role === 'model') {
      const text = typeof last.content === 'string'
        ? last.content
        : Array.isArray(last.content)
          ? last.content.map((c: any) => c.text || c.message || '').join('')
          : '';
      if (text.trim().endsWith('?')) {
        return {
          status: 'asking a question (no one will answer)',
          verdict: 'stuck',
          lastEntry: last,
        };
      }
    }

    // --- Rule 3: Retry loop detection ---
    const toolUses = entries.filter((e) => e.type === 'tool_use');
    if (toolUses.length >= 3) {
      const lastThree = toolUses.slice(-3);
      const sameTool = lastThree.every((t) => t.name === lastThree[0].name);
      if (sameTool) {
        const toolResults = entries.filter((e) => (e.type === 'tool_result' || e.role === 'tool') && e.is_error);
        if (toolResults.length >= 2) {
          return {
            status: `retry loop: ${lastThree[0].name} failing repeatedly`,
            verdict: 'stuck',
            lastEntry: last,
          };
        }
      }
    }

    // --- Rule 4: Recent activity = alive ---
    if (last.type === 'tool_result' || last.type === 'assistant' || last.role === 'assistant' || last.role === 'model') {
      const status = (last.type === 'tool_result' || last.role === 'tool') ? 'processing tool result' : 'thinking/responding';
      return {
        status,
        verdict: 'alive',
        lastEntry: last,
      };
    }

    return {
      status: `active (${last.type || last.role || 'unknown'})`,
      verdict: 'alive',
      lastEntry: last,
    };
  } catch {
    return { status: 'error reading state', verdict: 'unknown' };
  }
}
