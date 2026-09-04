import type { ConversationState } from './types.js';
import type { TopicNameMap } from './topic-names.js';
import { getTopicBrainInfo } from './topic-brains.js';

// Import pa modules from compiled output
import { listSkills } from '../../../pa/dist/src/skills.js';
import { getLastRun } from '../../../pa/dist/src/logger.js';
import { todayIST, nowIST, formatIST } from '../../../pa/dist/src/ist.js';
import { readActive } from '../../../pa/dist/src/lib/reservations.js';
import { activeRulesFor } from '../../../pa/dist/src/lib/feedback-rules.js';
import {
  listTasks,
  listRunningTasks,
  TOPIC_TASK_MAX_ATTEMPTS,
  listNotes,
  noteDisplayText,
  TOPIC_NOTE_RENDER_CAP,
} from '../../../pa/dist/src/lib/topic-tasks.js';

const SKILL_STATUS_TTL_MS = 60_000;
let skillStatusCache: { value: string; expiresAt: number } | null = null;

// Only inject skill status when the user message plausibly references it.
// Generic keywords that suggest the user is asking about skill execution status.
// (Skill names themselves are NOT hardcoded here — the framework can't know
// which skills a particular user has installed. Add custom triggers per-skill
// via trigger_description / inject_triggers instead.)
const SKILL_STATUS_TRIGGER = /\b(status|ran|run|running|fail|failed|failing|error|errored|skill|schedule|scheduled|cron|brief|briefing|catchup|overdue)\b/i;

export function _resetSkillStatusCache(): void {
  skillStatusCache = null;
}

export function shouldIncludeSkillStatus(userMessage: string): boolean {
  return SKILL_STATUS_TRIGGER.test(userMessage);
}

/**
 * Build topic description string for injection into LLM prompt.
 * Returns empty string if topicNames not provided or topic not found.
 */
export function buildTopicDescription(state: ConversationState, topicNames?: TopicNameMap): string {
  if (!topicNames) {
    return '';
  }

  const chatTopics = topicNames.get(String(state.chat_id));
  if (!chatTopics) return '';

  const entry = chatTopics.get(state.thread_id);
  if (!entry) return '';

  let desc = entry.description ? ` — ${entry.description}` : '';
  return `Topic: ${entry.name}${desc}`;
}

export async function buildSkillStatus(): Promise<string> {
  const now = Date.now();
  if (skillStatusCache && skillStatusCache.expiresAt > now) {
    return skillStatusCache.value;
  }
  try {
    const skills = await listSkills();
    const lines: string[] = [];
    for (const skill of skills) {
      if (!skill.frontmatter.cron) continue; // skip manual/unscheduled
      const last = await getLastRun(skill.name);
      if (last) {
        const ts = formatIST(new Date(last.timestamp));
        lines.push(`- ${skill.name}: ${last.status}, ${ts}, via ${last.worker} (${Math.round(last.duration / 1000)}s)`);
      } else {
        lines.push(`- ${skill.name}: never run`);
      }
    }
    const manualSkills = skills.filter(s => !s.frontmatter.cron);
    let manualSection = '';
    if (manualSkills.length > 0) {
      const manualLines: string[] = ['\n*Manual Skills*'];
      const displayLimit = 15;
      manualSkills.slice(0, displayLimit).forEach(skill => {
        const desc = skill.frontmatter.description || '';
        const displayDesc = desc.length > 80 ? desc.substring(0, 80) : desc;
        manualLines.push(`- ${skill.name}${desc ? ': ' + displayDesc : ''}`);
      });
      if (manualSkills.length > displayLimit) {
        manualLines.push(`_…and ${manualSkills.length - displayLimit} more — run \`pa list\`_`);
      }
      manualSection = manualLines.join('\n');
    }
    const value = (lines.length > 0 ? lines.join('\n') : '_(no scheduled skills found)_') + manualSection;
    skillStatusCache = { value, expiresAt: now + SKILL_STATUS_TTL_MS };
    return value;
  } catch {
    return '_(could not read skill status)_';
  }
}

const MAX_RESERVATION_ROWS = 10;
const MAX_PATHS_PER_ROW = 3;

// C1b (coordination-remediation Wave C, W-C6): surfaces live `~/.pa/reservations.json`
// state to every dispatched worker (agy/codex/claude/zclaude alike), which is the half
// the Claude-Code-only PreToolUse hook (W-C4) cannot reach. Fail-silent by design — a
// coordination hint must never break a dispatch — and injected into buildPrompt's full
// `## Capabilities & Rules` branch only (see call site below).
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

// Open items: queued topic tasks, in-flight (running/parked) siblings, and
// notes — ALL rendered from the unified topic store (pa/src/lib/topic-tasks.ts,
// operator directive 2026-09-03: notes moved off the per-topic SHORT-TERM.md
// markdown index into the same store as tasks), INLINED rather than a pointer
// — workers outside the repo tree (agy shim sandbox) cannot read ~/.pa.
// buildTaskPrompt (task-executor.ts) renders the same open items into task
// prompts via this same helper. Fail-silent — open items must never break a
// dispatch. The "do not re-run" wording is load-bearing: an eager worker
// seeing a queued task in its prompt must not double-execute it (the drain
// owns execution).
export async function renderOpenItems(chatId: number, threadId: number): Promise<string> {
  try {
    const [notes, queued, running] = await Promise.all([
      listNotes(chatId, threadId),
      listTasks(chatId, threadId),
      listRunningTasks(chatId, threadId),
    ]);
    const taskLines = queued
      .filter((t) => t.kind === 'task')
      .map((t) => {
        const queuedMs = Date.parse(t.created_at);
        // Same bare HH:MM IST clock label the reminder drain uses (main.ts queuedAtIst).
        const queuedAtIst = formatIST(new Date(Number.isFinite(queuedMs) ? queuedMs : Date.now())).slice(11, 16);
        return `- ${t.id} — ${t.title} (queued ${queuedAtIst} IST)`;
      });
    // Wave-2 tier-2 attribution (SPEC §3.1 A.3): running/parked siblings, with
    // the lead line telling workers (and the operator reading a transcript)
    // that a reply to those messages routes into the task automatically.
    const inflightLines = running.map(
      (r) => `- ${r.id} — ${r.title} (${r.status}, attempt ${r.attempts}/${TOPIC_TASK_MAX_ATTEMPTS})`
    );
    const openNotes = notes.filter((n) => n.status === 'OPEN').slice(0, TOPIC_NOTE_RENDER_CAP);
    const noteOverflow = notes.filter((n) => n.status === 'OPEN').length - openNotes.length;
    const noteLines = openNotes.map((n) => `- ${n.key} — ${noteDisplayText(n)}`);
    if (noteOverflow > 0) {
      noteLines.push(`(+${noteOverflow} more — pa topic-note list)`);
    }
    if (taskLines.length > 0 || inflightLines.length > 0 || noteLines.length > 0) {
      const parts = ['\n## Open items (short-term)'];
      if (taskLines.length > 0) {
        parts.push(
          'Queued tasks (dispatched automatically by the system — do not re-run them yourself):',
          ...taskLines
        );
      }
      if (inflightLines.length > 0) {
        parts.push(
          'In-flight tasks (answers to their questions route automatically when you reply to their messages):',
          ...inflightLines
        );
      }
      if (noteLines.length > 0) {
        parts.push('Notes:', ...noteLines);
      }
      return parts.join('\n') + '\n';
    }
    return '';
  } catch { /* no open items on any failure */ }
  return '';
}

/**
 * AI-188, superseded (operator directive 2026-09-03): a fresh dispatch NEVER
 * carries conversation turns — the recency window and the 10-turn slice are
 * retired, not widened. Every fresh prompt renders the same two-line
 * retrieval pointer (topic brain + `pa recall`) regardless of how much or how
 * little history exists; a replied-to message still resolves mechanically
 * via resolveReplyContext, independent of this section entirely.
 */
function renderHistorySection(state: ConversationState): string {
  return (
    `(Conversation turns are not injected into this prompt.)\n` +
    `Use the topic brain above and \`pa recall "<terms>" --thread ${state.thread_id} --json\` for this topic's history.`
  );
}

export async function buildResumedPrompt(
  userMessage: string,
  replyContext?: string,
  pendingAction?: string,
  topicNames?: TopicNameMap,  // For signature consistency; not used in resumed prompts
  // omitStatic is accepted for API symmetry with buildPrompt but is a no-op here:
  // buildResumedPrompt has no static block (identity/capabilities/PA_META) to omit.
  _options?: { omitStatic?: boolean }
): Promise<string> {
  const today = todayIST();
  const now = nowIST();

  const replySection = replyContext
    ? `## Replying To\n${replyContext}\n\n`
    : '';

  const pendingSection = pendingAction
    ? `## Pending Confirmation\nThe user previously said "yes" to this proposed action:\n${pendingAction}\nExecute it now.\n\n`
    : '';

  return `## Context Update
Today is ${today}. Current time (IST): ${now}.

${replySection}${pendingSection}## Current Message
${userMessage}`;
}

export async function buildPrompt(
  userMessage: string,
  state: ConversationState,
  topicNames?: TopicNameMap,
  replyContext?: string,
  pendingAction?: string,
  options?: {
    omitStatic?: boolean;
    priorContext?: { worker: string; sessionId: string; sessionPath: string | null };
    attachments?: Array<{ filename: string; path: string }>;
    workdir?: { dir: string; tier: 'override' | 'project' | 'topic-home' };
    readActiveFn?: typeof readActive;
  }
): Promise<string> {
  const today = todayIST();
  const now = nowIST();

  const omitStatic = options?.omitStatic === true;

  const includeSkillStatus = shouldIncludeSkillStatus(userMessage);
  const skillStatus = includeSkillStatus ? await buildSkillStatus() : '';

  // Fresh dispatches never carry turns (operator directive 2026-09-03) — see renderHistorySection.
  const historySection = renderHistorySection(state);

  let priorContextSection = '';
  if (options?.priorContext) {
    const { worker, sessionId, sessionPath } = options.priorContext;
    const pathLine = sessionPath
      ? `Session transcript: \`${sessionPath}\``
      : `Session ID: \`${sessionId}\` (no transcript file available for this worker type)`;
    priorContextSection = `\n## Prior Worker Context\nThe previous worker (\`${worker}\`) was interrupted before completing this task. ${pathLine}\nYou may read the transcript if context about prior tool calls or partial work would help.\n`;
  }

  const replySection = replyContext
    ? `## Replying To\n${replyContext}\n\n`
    : '';

  // WPE3 (2026-08-18): document/photo attachments ride the same dated-dir
  // substrate as voice notes; the worker gets absolute paths to act on.
  const attachmentsSection = options?.attachments?.length
    ? `## Attachments\nThe user attached file(s), downloaded to disk:\n${options.attachments
        .map((a) => `- [Attachment: ${a.filename} at ${a.path}]`)
        .join('\n')}\n\n`
    : '';

  const pendingSection = pendingAction
    ? `## Pending Confirmation\nThe user previously said "yes" to this proposed action:\n${pendingAction}\nExecute it now.\n\n`
    : '';

  // Env-var-driven personalization (defaults are public-safe; private setup uses secrets.env):
  //   PA_USER_NAME       — display name for the assistant's owner (default: "the user")
  //   PA_LOGS_DIR_HINT   — logs path hint shown to the LLM (default: "~/.pa/logs/<skill>/")
  //   PA_BRIEFS_DIR      — optional briefs directory; when set, adds the "Today's briefs" capability line
  const PA_USER_NAME = process.env.PA_USER_NAME || 'the user';
  const PA_LOGS_DIR_HINT = process.env.PA_LOGS_DIR_HINT || '~/.pa/logs/<skill>/';
  const briefsLine = process.env.PA_BRIEFS_DIR
    ? `\n- Today's briefs: ${process.env.PA_BRIEFS_DIR}/${today}-{morning|evening}.md`
    : '';

  const kbSourcesLine = process.env.PA_KB_SOURCES_PATH
    ? `\n- Grounding Sources: Systems of record: ${process.env.PA_KB_SOURCES_PATH} (start with Sources.md). Before answering a date-sensitive or domain-deterministic factual question, check Sources.md and the file(s) it names, and cite them. Never answer such a question from general/parametric knowledge when a named source exists. (Mirrors bot-instructions.md's Factual Integrity item 4 — claude/zclaude get that file via --append-system-prompt-file, agy/codex only get this inline block, so this rule must exist in both places; keep them in sync, enforced by context.test.ts.)`
    : '';

  // W-C6: only computed for the full capabilities branch (never lean/omitStatic, never
  // execution/pendingAction mode) — matches the interpolation site inside `capabilities` below.
  const reservationLines =
    omitStatic || pendingAction ? '' : await buildReservationLines(options?.readActiveFn);

  const capabilities = omitStatic
    ? ''
    : pendingAction
    ? `## Capabilities\nYou have full tool access. Execute the confirmed action above, report what you did, and confirm completion.`
    : `## Capabilities & Rules
- You can read files on disk, run bash commands, check system state
- pa logs: ${PA_LOGS_DIR_HINT}${briefsLine}
- Run a pa skill: pa run <skill-name>
- Write actions (email, skill runs, file edits): describe the plan and end with exactly "Reply *yes* to confirm or *no* to cancel." Do NOT execute yet.
- Telegram output: write standard Markdown — **bold**, _italic_, ~~strikethrough~~, # Heading, - bullets, \`code\`, [text](url). The system converts to Telegram format automatically. Do NOT use raw Telegram MarkdownV2 syntax. Never add backslash escapes like \\. or \\( — the system handles all escaping. Never use LaTeX/math syntax or delimiters (\`$...$\`, \`$$...$$\`, \`\\text{}\`, \`\\frac{}{}\`, \`\\cdot\`, \`\\mathbf{}\`, etc.) — Telegram has no LaTeX renderer. Write formulas and math using plain text or standard Unicode symbols (e.g. "P = power", "×", "Δ", "≈", "→", "²").
- Multi-step artifacts (uploads, links, plan summaries) MUST appear in the final response. Never send bare "done". For \`/plan\` or \`/deep-plan\`, include a ~400-char summary (goal, phase count, key risks) and the Google Drive link.
- Ambiguous intent: ask exactly ONE clarifying question.
- Never fabricate data. If you don't know, say so.
- Never promise to report back later: you are a one-shot process with no timer, so "I'll let you know when it finishes" never fires. If the result will land in a file or a process you can name, emit a \`watch_job\` PA_META action and say the watch is registered; otherwise tell the user the exact command or file that will show them the answer.
- Blocked on Google auth mid-task: mint a resumable reauth link instead of exiting — run python <repo>/pa/scripts/start_google_telegram_reauth.py --redirect-uri <GOOGLE_AUTH_REDIRECT_URI from ~/.pa/secrets.env> --chat-id <chat> --thread-id <thread> (IDs from your Telegram Metadata section; <repo> from your Working Directory section) --resume-action-json '{"type":"topic_resume","prompt":"<the waiting work, one line, <=500 chars>"}'. The link posts to that chat/thread, and once the user completes /auth the bot re-dispatches your prompt into the topic automatically as a system turn. For a skill-shaped blockage prefer telling the user to run /reauth <skill-name>. Never mint a mid-task reauth link without a resume payload.
${kbSourcesLine}
- Shared working tree: other sessions, skills and agents write this repo at the same time you do.
- Before editing a tracked file, run \`pa claims\`; if your path appears under an active reservation or in the recently-modified list, say so and pick different work rather than editing over it.
- For work spanning more than one file, claim first: \`pa claim <paths> --session <label> --note "<what you are doing>"\`, and \`pa release <id>\` when you are done.
- Never run \`git commit\`, \`git push\`, \`git stash\`, \`git checkout --\`, \`git reset\` or \`git clean\` yourself — commits and pushes go through the commit/push skill family, and stashing or checking out a file you do not own destroys another session's uncommitted work.
- Never run a build or test in the repo while another one is running: \`npm run build\` and \`npm test\` take the \`@build\` reservation themselves and release it when they finish, so a "waiting for @build" line means another build is in flight and yours will start when it ends — that is expected, not stuck. Do not claim \`@build\` by hand; a manual claim collides with the one the npm script takes and stalls your own build for 15 minutes.
- (Mirrors the Shared working tree block in bot-instructions.md and examples/bot-instructions.example.md — claude/zclaude get that file via --append-system-prompt-file, agy/codex only get this inline block, so this rule must exist in both places; kept in sync by context.test.ts.)${reservationLines ? '\n' + reservationLines : ''}
- Topic brains: when the Topic section names a topic brain file, read it before assuming prior context for this topic — it records durable facts, decisions, and open threads; fresh turns override it.
- Recall before assuming: everything outside this window is indexed and searchable — past turns from any topic, past worker runs and their tool calls, topic brains, and the Ecosystem KB. Run \`pa recall "<terms>" --thread <id> --json\` before answering "I don't know", before asking the user to repeat something, and before assuming a past decision was never made.
- Precedent before proposing: before proposing a trip, a briefing change, or a deletion, run \`pa recall "<intent>" --source decisions --json\` — past judgment calls with their rationale and how the user reacted. A rejected alternative is a strong precedent: never re-propose it without new facts; an outcome of "replied" is weak and advisory only.
- Infrastructure outside the repo tree — worker shims, ~/.pa config, installed CLI binaries — is never to be rewritten, replaced, or worked around to fix a failure. Diagnose, then surface the blocker to the operator and stop. Substituting one CLI for another behind a worker's name breaks every assumption the dispatcher, guards, and docs make about that worker (2026-08-14: agy's shim was silently rerouted to a different CLI).
- PA_META (optional last line, single-line JSON, nothing after it):
  [PA_META]: {"actions":[{"type":"T",...}]}
  Types: retry_with_worker{reason} | run_skill{skill} | confirm_required | kb_note{domain,note} | watch_job{description,check,deadline_minutes,interval_seconds} | question{text,options}
  retry_with_worker = you cannot complete the task, route to another worker. run_skill = trigger a pa skill automatically after your response (different from telling the user to run it). PA_META run_skill must never target the git-workflow skills (commit/push/push-public/investigate-flagged/update-brain); those are human-command-only. confirm_required = use instead of the "Reply *yes*" text. kb_note = you changed a deterministic source another topic's domain depends on — records a dated note into Ecosystem KB Sources.md immediately (domain = section name, note = one-line fact, <=300 chars); does not replace your normal response. watch_job = something you started finishes later in a file or process you can name — registers a read-only check (no shell, absolute paths only) that reports into this topic when it completes or when its deadline passes; use it instead of promising to report back. check is a required OBJECT — exact shape {"type":"file_newer_than","path":"C:/abs/path"} — with type one of (file_exists | file_gone | file_newer_than | file_contains | process_gone) plus path (absolute, every file type), pattern (regex string, file_contains only), since_iso (ISO timestamp, file_newer_than only) or pid (positive int, process_gone only); a malformed check is rejected and nothing is watched. question = you need the user to pick one of up to 4 options — the reply renders option buttons; their press is injected back into the topic as your answer. text (the question, <=500 chars), options (1-4 strings, <=40 chars each), taskId (optional, <=64 chars, links the answer to a queued task). Full example: [PA_META]: {"actions":[{"type":"watch_job","description":"Google token refreshed","check":{"type":"file_newer_than","path":"C:/Users/you/.pa/google-token.json"},"deadline_minutes":720}]}. Omit PA_META otherwise.`;

  const identity = omitStatic
    ? ''
    : `You are a personal assistant for ${PA_USER_NAME}, responding via Telegram.\n`;

  // CWD section per §3.8 — tier-specific texts
  let cwdSection = '';
  if (options?.workdir) {
    const { dir, tier } = options.workdir;
    if (tier === 'override' || tier === 'project') {
      cwdSection = `\n## Working Directory\nYou are operating in: \`${dir}\`\nThis is the project root for all file operations. Read the project's CLAUDE.md if present.\n`;
    } else if (tier === 'topic-home') {
      const botCwd = process.env.BOT_CWD || process.cwd();
      cwdSection = `\n## Working Directory\nYou are operating in the topic workspace: \`${dir}\`\nThis is a scratch space for this conversation — use \`scratch/\` for files you create; a CLAUDE.md here (if present) points to this topic's brain. It is not a code repository: for repo work use absolute paths — the main repository is at \`${botCwd}\`.\n`;
    }
    // bot-cwd/undefined → no section (fallback tier produces byte-identical prompts)
  }

  const skillStatusSection = includeSkillStatus
    ? `\n## PA Skill Status (last scheduled run)\n${skillStatus}\n`
    : '';

  // Topic brain pointer (WP1: §3.4 pointer line, §3.5 standing-rule bullet)
  const brainInfo = await getTopicBrainInfo(state.chat_id, state.thread_id);
  let brainPointerLine = '';
  if (brainInfo) {
    const consolidated = brainInfo.consolidated
      ? `consolidated ${brainInfo.consolidated.slice(0, 10)}`
      : 'freshness unknown';
    const covers = brainInfo.covers
      ? `covers through ${brainInfo.covers.slice(0, 10)}`
      : '';
    brainPointerLine = `\nTopic brain: ${brainInfo.path} (${consolidated}${covers ? `, ${covers}` : ''}) — durable per-topic knowledge: what was discussed, decided, and left open. Read it before assuming prior context in this topic; fresh turns override it.`;
  }

  const recallPointerLine = `\nRecall: \`pa recall "<terms>" --thread ${state.thread_id} --json\` searches this topic's full history, worker traces, topic brains and the Ecosystem KB — use it instead of guessing about anything before the window above.`;

  const decisionPointerLine = `\nPrecedent: before proposing in this topic, run \`pa recall "<intent>" --source decisions --thread ${state.thread_id} --json\` — past judgment calls with rationale and your reaction; honor strong precedents.`;

  // AI-165: standing feedback rules — read FRESH per prompt (no cache: an operator edit
  // applies to the next message with no bot restart); fail-to-absent, never throws.
  let standingRulesSection = '';
  try {
    const rules = activeRulesFor({ threadId: state.thread_id });
    if (rules.length > 0) {
      const sectionLines: string[] = [];
      let included = 0;
      for (const rule of rules) {           // recency-first: activeRulesFor orders created_at DESC
        if (included >= 12) break;
        const candidate = [...sectionLines, `- ${rule.text}`];
        const candidateLen = candidate.reduce((n, l) => n + l.length + 1, 0);
        if (candidateLen > 1500) break;
        sectionLines.push(`- ${rule.text}`);
        included++;
      }
      const overflow = rules.length - included;
      standingRulesSection = `\n## Standing rules\nOperator-confirmed behavioral rules from past feedback. Obey them exactly.\n${sectionLines.join('\n')}${overflow > 0 ? `\n(+${overflow} older — pa rules list)` : ''}\n`;
    }
  } catch { /* no section on any failure */ }

  // Wave-1 WP-E open items — Wave-2 SPEC §3.1 A.3 extracted the body into the
  // shared renderOpenItems() helper below (buildTaskPrompt consumes it too).
  const openItemsSection = !omitStatic && !pendingAction
    ? await renderOpenItems(state.chat_id, state.thread_id)
    : '';

  const topicDesc = buildTopicDescription(state, topicNames);
  // Topic section renders if EITHER topic description OR brain pointer exists
  const topicSection = (topicDesc || brainPointerLine)
    ? `\n## Topic\n${topicDesc}${brainPointerLine}${recallPointerLine}${decisionPointerLine}\n`
    : '';

  const telegramMeta = `\n## Telegram Metadata\nChat ID: ${state.chat_id}\nThread ID: ${state.thread_id}\n`;

  const capabilitiesSection = capabilities ? `\n${capabilities}` : '';

  return `${identity}Today is ${today}. Current time (IST): ${now}.
${cwdSection}${skillStatusSection}${topicSection}${openItemsSection}${standingRulesSection}${telegramMeta}
## Conversation History
${historySection}
${priorContextSection}
${replySection}${attachmentsSection}${pendingSection}## Current Message
${userMessage}
${capabilitiesSection}`;
}
