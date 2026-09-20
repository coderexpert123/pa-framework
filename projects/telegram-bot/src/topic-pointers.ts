/**
 * Shared per-topic pointer lines + the live-reservations block — ONE renderer
 * per fact, consumed by every prompt lane (human `buildPrompt`, orchestrator,
 * spawned threads, queued tasks). The lines were born as `buildPrompt` locals
 * and reached only the human lane (orchestrator carried byte-copies marked "do
 * not reflow"); this module is the single owner so the lanes cannot drift.
 *
 * Lane awareness: `human`/`thread`/`task` share the imperative voice (they all
 * have tools); `orchestrator` is tool-less (orchestrator.ts: "You have NO
 * tools"), so its recall/decisions lines speak in spawn-to-run voice. The
 * brain line is identical on every lane.
 *
 * Fail-silent by design — a pointer must never break a dispatch: a throwing
 * `getTopicBrainInfo` degrades to `brain:''`, a throwing `readActive` to `''`.
 */

import { getTopicBrainInfo } from './topic-brains.js';
import { readActive } from '../../../pa/dist/src/lib/reservations.js';

export type PointerLane = 'human' | 'orchestrator' | 'thread' | 'task';

export interface TopicPointerLines {
  brain: string;      // '' when the topic has no brain
  recall: string;     // always non-empty
  decisions: string;  // always non-empty
}

export interface TopicPointerDeps {
  getTopicBrainInfoFn?: typeof getTopicBrainInfo;   // test seam
}

export async function renderTopicPointerLines(
  topic: { chatId: number; threadId: number },
  lane: PointerLane,
  deps?: TopicPointerDeps,
): Promise<TopicPointerLines> {
  const brainFn = deps?.getTopicBrainInfoFn ?? getTopicBrainInfo;

  let brain = '';
  try {
    const brainInfo = await brainFn(topic.chatId, topic.threadId);
    if (brainInfo) {
      const consolidated = brainInfo.consolidated
        ? `consolidated ${brainInfo.consolidated.slice(0, 10)}`
        : 'freshness unknown';
      const covers = brainInfo.covers
        ? `covers through ${brainInfo.covers.slice(0, 10)}`
        : '';
      brain = `\nTopic brain: ${brainInfo.path} (${consolidated}${covers ? `, ${covers}` : ''}) — durable per-topic knowledge: what was discussed, decided, and left open. Read it before assuming prior context in this topic; fresh turns override it.`;
    }
  } catch { /* brain pointer is best-effort — never break a dispatch */ }

  if (lane === 'orchestrator') {
    return {
      brain,
      recall: `\nRecall: you cannot run commands — when an answer depends on history outside this prompt, spawn a thread whose goal includes running \`pa recall "<terms>" --thread ${topic.threadId} --json\` and reporting back.`,
      decisions: `\nPrecedent: you cannot run commands — before proposing in this topic, spawn a thread whose goal includes running \`pa recall "<intent>" --source decisions --thread ${topic.threadId} --json\` — past judgment calls carry rationale and the operator reaction; honor strong precedents.`,
    };
  }

  return {
    brain,
    recall: `\nRecall: \`pa recall "<terms>" --thread ${topic.threadId} --json\` searches this topic's full history, worker traces, topic brains and the Ecosystem KB — use it instead of guessing about anything before the window above.`,
    decisions: `\nPrecedent: before proposing in this topic, run \`pa recall "<intent>" --source decisions --thread ${topic.threadId} --json\` — past judgment calls with rationale and your reaction; honor strong precedents.`,
  };
}

const MAX_RESERVATION_ROWS = 10;
const MAX_PATHS_PER_ROW = 3;

// C1b (coordination-remediation Wave C, W-C6): surfaces live `~/.pa/reservations.json`
// state to every dispatched worker (agy/codex/claude/zclaude alike), which is the half
// the Claude-Code-only PreToolUse hook (W-C4) cannot reach. Fail-silent by design — a
// coordination hint must never break a dispatch. Body text preserved byte-for-byte
// from its context.ts origin; renderReservationsBlock wraps it as a standalone
// section so it reaches every executor lane independent of --append-system-prompt-file.
async function buildReservationLines(readActiveFn: typeof readActive = readActive): Promise<string> {
  try {
    const active = await readActiveFn();
    if (active.length === 0) {
      return '- Active reservations right now: none.';
    }
    const rows = active.slice(0, MAX_RESERVATION_ROWS).map((r) => {
      const extraPaths = r.paths.length - MAX_PATHS_PER_ROW;
      const pathsText =
        r.paths.slice(0, MAX_PATHS_PER_ROW).join(', ') + (extraPaths > 0 ? ` (+${extraPaths} more)` : '');
      const row = `  - ${r.id} — ${pathsText} — session "${r.session}" — "${r.note}" — expires ${r.expiresAt}`;
      return row.length > 160 ? row.slice(0, 160) : row;
    });
    const extraRows = active.length - MAX_RESERVATION_ROWS;
    if (extraRows > 0) {
      rows.push(`  - (+${extraRows} more — run \`pa claims\`)`);
    }
    return `- Active reservations right now (do not edit these paths unless the reservation is yours):\n${rows.join('\n')}`;
  } catch {
    return '';
  }
}

export interface ReservationsDeps {
  readActiveFn?: typeof readActive;                 // test seam (moved from context.ts)
}

/**
 * The standalone `## Live reservations` section — '\n'-leading, '' on throw.
 * Rendered on every non-execution prompt lane (human incl. omitStatic, thread,
 * task); pendingAction still suppresses it on the human lane, and the
 * orchestrator gets none (no tools — it cannot edit files anyway).
 */
export async function renderReservationsBlock(deps?: ReservationsDeps): Promise<string> {
  const body = await buildReservationLines(deps?.readActiveFn);
  return body ? `\n## Live reservations\n${body}` : '';
}
