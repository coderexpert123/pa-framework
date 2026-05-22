import type { ConversationState } from './types.js';
import { formatHistory } from './conversation.js';
import type { TopicNameMap } from './topic-names.js';

// Import pa modules from compiled output
import { listSkills } from '../../../pa/dist/src/skills.js';
import { getLastRun } from '../../../pa/dist/src/logger.js';
import { todayIST, nowIST, formatIST } from '../../../pa/dist/src/ist.js';

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
    const value = lines.length > 0 ? lines.join('\n') : '_(no scheduled skills found)_';
    skillStatusCache = { value, expiresAt: now + SKILL_STATUS_TTL_MS };
    return value;
  } catch {
    return '_(could not read skill status)_';
  }
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
  options?: { omitStatic?: boolean; priorContext?: { worker: string; sessionId: string; sessionPath: string | null } }
): Promise<string> {
  const today = todayIST();
  const now = nowIST();

  const omitStatic = options?.omitStatic === true;

  const includeSkillStatus = shouldIncludeSkillStatus(userMessage);
  const skillStatus = includeSkillStatus ? await buildSkillStatus() : '';

  const historySection = formatHistory(state.turns.slice(-10)); // last 10 turns in prompt

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

  const capabilities = omitStatic
    ? ''
    : pendingAction
    ? `## Capabilities\nYou have full tool access. Execute the confirmed action above, report what you did, and confirm completion.`
    : `## Capabilities & Rules
- You can read files on disk, run bash commands, check system state
- pa logs: ${PA_LOGS_DIR_HINT}${briefsLine}
- Run a pa skill: pa run <skill-name>
- Write actions (email, skill runs, file edits): describe the plan and end with exactly "Reply *yes* to confirm or *no* to cancel." Do NOT execute yet.
- Telegram output: write standard Markdown — **bold**, _italic_, ~~strikethrough~~, # Heading, - bullets, \`code\`, [text](url). The system converts to Telegram format automatically. Do NOT use raw Telegram MarkdownV2 syntax. Never add backslash escapes like \\. or \\( — the system handles all escaping.
- Multi-step artifacts (uploads, links, plan summaries) MUST appear in the final response. Never send bare "done". For \`/plan\` or \`/deep-plan\`, include a ~400-char summary (goal, phase count, key risks) and the Google Drive link.
- Ambiguous intent: ask exactly ONE clarifying question.
- Never fabricate data. If you don't know, say so.
- PA_META (optional last line, single-line JSON, nothing after it):
  [PA_META]: {"actions":[{"type":"T",...}]}
  Types: retry_with_worker{reason} | run_skill{skill} | confirm_required
  retry_with_worker = you cannot complete the task, route to another worker. run_skill = trigger a pa skill automatically after your response (different from telling the user to run it). confirm_required = use instead of the "Reply *yes*" text. Omit PA_META otherwise.`;

  const identity = omitStatic
    ? ''
    : `You are a personal assistant for ${PA_USER_NAME}, responding via Telegram.\n`;

  const cwdSection = state.cwd_override
    ? `\n## Working Directory\nYou are operating in: \`${state.cwd_override}\`\nThis is the project root for all file operations. Read the project's CLAUDE.md if present.\n`
    : '';

  const skillStatusSection = includeSkillStatus
    ? `\n## PA Skill Status (last scheduled run)\n${skillStatus}\n`
    : '';

  const topicDesc = buildTopicDescription(state, topicNames);
  const topicDescSection = topicDesc ? `\n## Topic\n${topicDesc}\n` : '';

  const telegramMeta = `\n## Telegram Metadata\nChat ID: ${state.chat_id}\nThread ID: ${state.thread_id}\n`;

  const capabilitiesSection = capabilities ? `\n${capabilities}` : '';

  return `${identity}Today is ${today}. Current time (IST): ${now}.
${cwdSection}${skillStatusSection}${topicDescSection}${telegramMeta}
## Conversation History
${historySection}
${priorContextSection}
${replySection}${pendingSection}## Current Message
${userMessage}
${capabilitiesSection}`;
}
