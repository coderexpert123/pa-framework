import { readFile, readdir, stat, open } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { log } from './lib/log.js';

export function resolveStateDir(stateDir: string): string {
  return stateDir.replace(/^~/, homedir());
}

interface LatestStateResult {
  path: string;
  mtime: Date;
}

/**
 * Why a state file that EXISTS still cannot be used for stuck-detection.
 * Currently only 'binary', but kept as a union so a future reason (e.g. an
 * encrypted store) can be added without changing every call site.
 */
export type StateTailProblem = 'binary';

export interface AgentState {
  status: string;
  verdict: 'alive' | 'stuck' | 'unknown';
  lastEntry?: any;
  /**
   * Set when a state file was found but could not be analyzed. Its presence
   * means the 'unknown' verdict is a KNOWN blind spot for this worker, not an
   * absent/empty state file. See readUsableStateTail.
   */
  degraded?: StateTailProblem;
}

export interface UsableStateTail {
  /** Tail text, or null when there is nothing safe to analyze. */
  content: string | null;
  /** Present only when a file WAS found but is unusable. */
  problem?: StateTailProblem;
  /** Path of the file that was inspected, when one was found. */
  path?: string;
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

const TAIL_BYTES = 32768;

/** Read the last TAIL_BYTES of one file as utf8. Never throws; null on any IO error. */
async function readTailOfFile(path: string): Promise<string | null> {
  try {
    const fileStat = await stat(path);
    const readSize = Math.min(fileStat.size, TAIL_BYTES);
    if (fileStat.size > readSize) {
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(readSize);
        await fh.read(buf, 0, readSize, fileStat.size - readSize);
        return buf.toString('utf8');
      } finally {
        await fh.close();
      }
    }
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read the last 32KB of the most recently modified state file in a directory.
 * Returns RAW string content (may be truncated JSON — that's intentional, and
 * may be binary — callers that feed an LLM must use readUsableStateTail).
 */
export async function readStateTail(dir: string, pattern: string): Promise<string | null> {
  try {
    const result = await findLatestStateFile(dir, pattern);
    if (!result) return null;
    return await readTailOfFile(result.path);
  } catch {
    return null;
  }
}

// Known-binary state_pattern suffixes. A worker whose config.yaml declares
// one of these (agy: "*.db", codex: "state_5.sqlite") has ALREADY told us its
// conversation store is binary — no content sniffing is needed, or safe to
// rely on. Add to this list if a new worker's state_pattern names another
// binary format.
const KNOWN_BINARY_STATE_SUFFIXES = ['.db', '.sqlite'];

/**
 * True when a worker's state_pattern glob names a format known ahead of time
 * to be binary (SQLite, etc.), independent of what the content sniff would say.
 */
export function isKnownBinaryStatePattern(pattern: string): boolean {
  const lower = pattern.toLowerCase();
  return KNOWN_BINARY_STATE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Sniff whether a state-file tail is binary rather than text.
 *
 * DO NOT REGRESS. Not every worker stores its conversation as text. agy
 * (Antigravity CLI, the default worker since 2026-07-21) stores each
 * conversation as a WAL-mode SQLite database (`~/.gemini/antigravity-cli/
 * conversations/*.db`) whose payload columns hold protobuf blobs. Decoding
 * that tail as utf8 yields NUL bytes and U+FFFD replacement characters. Those
 * bytes must never be pasted into an LLM evaluator prompt: they carry no usable
 * signal, they waste the evaluator's whole context, and the printable fragments
 * inside them include verbatim file contents the agent read — which the
 * evaluator (a DIFFERENT vendor's CLI by default) would then receive.
 *
 * The check is deliberately a BINARY sniff, not a JSON-parseability check:
 * gemini's single-JSON session file is legitimately unparseable once tail-read
 * at 32KB, and the evaluator prompt explicitly tells the model that truncated
 * JSON is fine. Gating on parseability would break that path.
 *
 * CATEGORICAL SHORT-CIRCUIT (do not regress): the ratio-based sniff below is a
 * heuristic over the first 4096 chars and can UNDERCOUNT a realistic, dense
 * agy/codex database page — mostly printable conversational text with only
 * sparse protobuf tag/varint framing bytes interleaved — easily staying under
 * the 2% "bad byte" threshold and slipping through as "not binary". When the
 * caller knows the worker's state_pattern names a known-binary format
 * (statePattern param), that is authoritative and the ratio heuristic is
 * skipped entirely — no sniffing needed when the format is already known.
 * statePattern is optional so existing pure content-sniff callers/tests keep
 * working; omit it only when the pattern truly isn't known.
 */
export function isBinaryStateContent(content: string, statePattern?: string): boolean {
  if (statePattern && isKnownBinaryStatePattern(statePattern)) return true;
  if (content.length === 0) return false;
  // Whole-file read of a small SQLite db still carries the magic header.
  if (content.startsWith('SQLite format 3')) return true;
  // A raw NUL never appears in JSON/JSONL text (JSON escapes it as a
  // six-character backslash-u-0000 sequence), so a single one is enough.
  if (content.includes('\u0000')) return true;

  const sample = content.slice(0, 4096);
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    // U+FFFD = a byte sequence that was not valid utf8; C0 controls other than
    // tab/newline/carriage-return don't occur in these transcripts.
    if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad / sample.length > 0.02;
}

// One warn line per (worker, file, problem). The bot is a forever-daemon and
// analyzeAgentState runs on every heartbeat that sees state activity, so an
// ungated log would emit thousands of identical lines; but every NEW agy
// conversation is a new file, so a genuinely new blind spot is still reported.
const reportedUnusableState = new Set<string>();

function reportUnusableState(
  workerName: string,
  pattern: string,
  filePath: string,
  problem: StateTailProblem,
  detail: string,
): void {
  const key = `${workerName}|${filePath}|${problem}`;
  if (reportedUnusableState.has(key)) return;
  // Bound the memo — uptime is measured in weeks.
  if (reportedUnusableState.size > 200) reportedUnusableState.clear();
  reportedUnusableState.add(key);

  log(
    'warn',
    'state-monitor',
    `State file for worker "${workerName}" is not readable text — stuck detection is degraded for ${workerName}`,
    { worker: workerName, problem, detail, pattern, path: filePath },
  );
}

/**
 * readStateTail plus a usability gate: a state file that exists but is not
 * readable text is reported once and reduced to `content: null` with a
 * `problem`. Never throws.
 *
 * Every caller that hands state content to an LLM MUST go through this rather
 * than readStateTail.
 */
export async function readUsableStateTail(
  dir: string,
  pattern: string,
  workerName = 'unknown',
): Promise<UsableStateTail> {
  try {
    const found = await findLatestStateFile(dir, pattern);
    if (!found) return { content: null };

    const content = await readTailOfFile(found.path);
    if (content === null) return { content: null, path: found.path };

    if (isBinaryStateContent(content, pattern)) {
      reportUnusableState(
        workerName,
        pattern,
        found.path,
        'binary',
        'not utf8 text (binary conversation store, e.g. SQLite/protobuf)',
      );
      return { content: null, problem: 'binary', path: found.path };
    }

    return { content, path: found.path };
  } catch {
    // Same fail-safe contract as readStateTail: an unreadable state dir is
    // never an exception in the caller's control flow.
    return { content: null };
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
 * - state file is not text at all (agy's SQLite store) → UNKNOWN, degraded:'binary'
 *
 * workerName is used only for the degraded-state log line; pass it whenever the
 * caller knows which worker the state dir belongs to.
 */
export async function analyzeAgentState(dir: string, pattern: string, workerName = 'unknown'): Promise<AgentState> {
  try {
    const tail = await readUsableStateTail(dir, pattern, workerName);

    // A binary state file is an EXPECTED condition for some workers, not an
    // error. Say so out loud rather than reporting a generic 'unknown' that a
    // human would read as "the heuristics ran and were inconclusive".
    if (tail.problem === 'binary') {
      const who = workerName === 'unknown' ? 'this worker' : workerName;
      return {
        status: `state file is not readable text (binary conversation store) — idle/stuck heuristics unavailable for ${who}`,
        verdict: 'unknown',
        degraded: 'binary',
      };
    }

    const content = tail.content;
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
              role: (msg.type === 'gemini' || msg.type === 'agy') ? 'assistant' : (msg.type === 'user' ? 'user' : msg.role),
              type: (msg.type === 'gemini' || msg.type === 'agy') ? 'assistant' : msg.type,
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
