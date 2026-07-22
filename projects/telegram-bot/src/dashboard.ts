import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { getKeepAwakeStatus } from './keepawake.js';
import { sendMessageWithId, editMessageText, pinChatMessage, createForumTopic } from './telegram.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import { listSkills } from '../../../pa/dist/src/skills.js';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { sanitizeMdV2 } from '../../../pa/dist/src/lib/mdv2.js';
import { describeTunables } from '../../../pa/dist/src/lib/tunables.js';
import { readObservedTunableValuesForWorker } from '../../../pa/dist/src/lib/tunables-observed.js';
import type { WorkerConfig } from '../../../pa/dist/src/types.js';
import { loadTopicNames, setTopicDescription } from './topic-names.js';
import { appendRefIdAndLog } from './ref-id.js';

const DASHBOARD_TOPIC_NAME = 'System Dashboard';
const DASHBOARD_DESCRIPTION = 'Live system status — keep-awake state, model failover order, per-CLI settings, and scheduled skill crons. Auto-updated by the bot.';

/**
 * THE CAPABILITY MATRIX IS GLOBAL, NOT PER-TOPIC.
 *
 * This is a single pinned message for the whole chat, so it can only ever
 * document what is POSSIBLE. A topic's ACTIVE value comes from the 4-tier
 * cascade (session / topic / worker default / CLI default) and is answered by a
 * bare `/llm` or `/effort` in that topic. Keep this distinction spelled out in
 * the rendered text — a matrix that reads like current state is worse than no
 * matrix at all.
 */
const CAPABILITY_NOTE =
  'What each CLI ACCEPTS — capability only, never any topic’s active setting. '
  + 'Set with /llm or /effort inside a topic; send either one bare to see that topic’s current value.';

/**
 * Telegram hard-caps a message at 4096 characters, and `editMessageText` (this
 * dashboard's update path, see updateDashboard below) CANNOT chunk — an
 * over-long edit simply fails, which would freeze the ENTIRE pinned dashboard,
 * not just the section that overflowed.
 *
 * Measured on the live config 2026-07-22: the pre-matrix dashboard was 1127 raw
 * / 1296 post-sanitize characters (21 scheduled skills, 5 workers), and the
 * richest matrix rendering adds ~600 — roughly 1.9k of a 4096 budget. There is
 * plenty of headroom TODAY, which is exactly why the budget check must be
 * mechanical rather than eyeballed: skills and workers both grow over time.
 * renderWorkerCapabilityMatrix() therefore degrades through progressively
 * terser renderings and always has the original bare priority list to fall back
 * on.
 *
 * Length is measured POST-`sanitizeMdV2`, because that is what is actually
 * sent: MarkdownV2 escaping only ever ADDS backslashes (~15% on this content),
 * so measuring the raw string would under-count.
 *
 * The skill schedule is clamped by the same budget (getDashboardContent). That
 * is a PRE-EXISTING overflow this work surfaced rather than caused: 21 skills
 * render to 1385 sanitized characters, but ~60 would exceed 4096 on their own,
 * with no cap anywhere in the old code.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Headroom for the `_Ref: s-…_` line appendRefIdAndLog adds, plus slack. */
export const DASHBOARD_RESERVE = 200;

/** Declared values are short vocabularies; cap anyway so a config typo can't flood the pin. */
const MAX_DECLARED_SHOWN = 8;
/** Observed values are unbounded (every model name ever used) — keep it to a taste. */
const MAX_OBSERVED_SHOWN = 3;

/**
 * The observed-values scan is bounded harder here than the reader's own
 * defaults (300 files / 90 days). The dashboard only refreshes on bot startup
 * and on a keep-awake toggle, so cost is not the driver — recency is: a pinned
 * "recently used" hint listing a model from three months ago is misinformation.
 */
const OBSERVED_OPTS = { maxFiles: 150, maxAgeDays: 60 } as const;

export interface DashboardSettingCapability {
  setting: string;
  /** Declared canonical values; [] means free-form (values are never gated). */
  values: string[];
  /** Values seen in real run history that aren't already declared; [] when none. */
  observed: string[];
}

export interface DashboardWorkerCapability {
  name: string;
  priority: number;
  /** [] for a worker that declares no tunables — renders as a clean one-liner. */
  settings: DashboardSettingCapability[];
}

/** Post-sanitize length — the number Telegram actually enforces. */
function measure(text: string): number {
  return sanitizeMdV2(text).length;
}

function joinCapped(values: string[], max: number): string {
  if (values.length <= max) return values.join(', ');
  return `${values.slice(0, max).join(', ')}, …`;
}

/**
 * The original bare line, preserved verbatim at EVERY detail level so the
 * richer renderings are strictly additive.
 */
function workerHeadline(cap: DashboardWorkerCapability, index: number): string {
  return `${index + 1}. ${cap.name} (priority ${cap.priority})`;
}

/**
 * Detail levels, richest (0) to tersest (3). 3 is byte-identical to the
 * pre-matrix dashboard, so the fallback can never itself be the thing that
 * breaks the message.
 */
function renderAtDetail(caps: DashboardWorkerCapability[], detail: 0 | 1 | 2 | 3): string[] {
  const lines: string[] = [];
  caps.forEach((cap, i) => {
    const head = workerHeadline(cap, i);
    if (detail === 3) {
      lines.push(head);
      return;
    }
    if (cap.settings.length === 0) {
      // Not awkward, not blank: say so explicitly. gemini genuinely has no
      // effort flag, and that absence is information the user needs.
      lines.push(`${head} — no settable options`);
      return;
    }
    if (detail === 2) {
      lines.push(`${head} — accepts: ${cap.settings.map((s) => s.setting).join(', ')}`);
      return;
    }
    lines.push(head);
    for (const s of cap.settings) {
      const parts: string[] = [s.values.length > 0 ? joinCapped(s.values, MAX_DECLARED_SHOWN) : 'any value'];
      if (detail === 0 && s.observed.length > 0) {
        parts.push(`recent: ${joinCapped(s.observed, MAX_OBSERVED_SHOWN)}`);
      }
      // One setting per line, indented — Telegram wraps dense tables badly on a phone.
      lines.push(`   • ${s.setting}: ${parts.join(' · ')}`);
    }
  });
  return lines;
}

/**
 * PURE. Render the capability matrix at the richest detail that fits `budget`
 * post-sanitize characters, degrading rather than risking the 4096 cap.
 *
 * A non-positive or impossibly small budget still yields the bare priority list
 * — dropping the worker section entirely would lose information the dashboard
 * has always carried.
 */
export function renderWorkerCapabilityMatrix(caps: DashboardWorkerCapability[], budget: number): string[] {
  for (const detail of [0, 1, 2, 3] as const) {
    const lines = renderAtDetail(caps, detail);
    if (measure(lines.join('\n')) <= budget) return lines;
  }
  return renderAtDetail(caps, 3);
}

/**
 * Read each worker's declared tunables plus (fail-soft) the values its runs
 * actually used. A worker predating the tunables schema has no `tunables` block
 * at all and yields `settings: []` — backward compatible by construction.
 */
async function collectWorkerCapabilities(workers: WorkerConfig[]): Promise<DashboardWorkerCapability[]> {
  return Promise.all(workers.map(async (w) => {
    let described: ReturnType<typeof describeTunables> = [];
    try {
      described = describeTunables(w);
    } catch {
      described = [];
    }

    let observed: Record<string, string[]> = {};
    if (described.length > 0) {
      try {
        observed = await readObservedTunableValuesForWorker(w, OBSERVED_OPTS);
      } catch {
        observed = {};   // history is a nice-to-have; never let it break the pin
      }
    }

    return {
      name: w.name,
      priority: w.priority,
      settings: described.map((d) => {
        const declaredLower = d.values.map((v) => v.toLowerCase());
        return {
          setting: d.setting,
          values: d.values,
          // Only show history that ADDS something — repeating declared values
          // as "recent" is noise.
          observed: (observed[d.setting] ?? []).filter((v) => !declaredLower.includes(v.toLowerCase())),
        };
      }),
    };
  }));
}

interface DashboardState {
  chat_id?: number;
  thread_id?: number;
  message_id?: number;
}

function paHome(): string {
  return process.env.PA_HOME ?? join(homedir(), '.pa');
}

function getDashboardStatePath(): string {
  return join(paHome(), 'telegram-dashboard.json');
}

async function loadDashboardState(): Promise<DashboardState> {
  try {
    const raw = await readFile(getDashboardStatePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveDashboardState(state: DashboardState): Promise<void> {
  await writeFile(getDashboardStatePath(), JSON.stringify(state, null, 2));
}

export async function getDashboardContent(): Promise<string> {
  const ka = getKeepAwakeStatus();
  const config = await loadConfig();
  const skills = await listSkills();

  // Everything except the capability matrix is built first, so the matrix can
  // be sized against the space that is ACTUALLY left over rather than a guess.
  const head: string[] = [];
  head.push('⚫️ **SYSTEM DASHBOARD**');
  head.push(`_${DASHBOARD_DESCRIPTION}_`);
  head.push('');

  // 1. Keep-awake status
  let kaStatus = 'off';
  if (ka.active) {
    const since = ka.since ? formatIST(new Date(ka.since)).slice(11, 16) : '';
    kaStatus = `on${since ? ` since ${since} IST` : ''}`;
  }
  head.push(`⏰ **Keep-awake**: ${kaStatus}`);
  head.push('');

  // 2. Model priorities + per-worker capability matrix
  head.push('⚙️ **Model Failover Order & Settings**');
  head.push(`_${CAPABILITY_NOTE}_`);

  // 3. Scheduled Skills
  const scheduled = skills.filter(s => s.frontmatter.cron);
  const skillSection = (max?: number): string[] => {
    const lines = ['', '📊 **Skill Schedule**'];
    if (scheduled.length === 0) {
      lines.push('_No scheduled skills_');
      return lines;
    }
    const shown = max === undefined ? scheduled : scheduled.slice(0, Math.max(0, max));
    shown.forEach(s => lines.push(`- **${s.name}**: \`${s.frontmatter.cron}\``));
    if (shown.length < scheduled.length) {
      lines.push(`_…and ${scheduled.length - shown.length} more — run \`pa list\`_`);
    }
    return lines;
  };

  const sortedWorkers = [...(config.workers || [])].sort((a, b) => a.priority - b.priority);
  const caps = await collectWorkerCapabilities(sortedWorkers);

  const footer = ['', `_Last updated: ${formatIST(new Date())}_`];
  const assemble = (matrix: string[], skillMax?: number) =>
    [...head, ...matrix, ...skillSection(skillMax), ...footer].join('\n');

  const MAX = TELEGRAM_MESSAGE_LIMIT - DASHBOARD_RESERVE;
  // The bare priority list — the tersest the matrix can ever get. Budget the
  // skill list against THIS so a growing skill roster can't crowd the worker
  // section out entirely (nor, more importantly, blow the 4096 cap on its own:
  // at 60 skills the schedule section alone already exceeds it, which would
  // fail the edit and freeze the whole pinned dashboard).
  const floorMatrix = renderWorkerCapabilityMatrix(caps, -1);

  let skillMax: number | undefined;
  if (measure(assemble(floorMatrix)) > MAX) {
    skillMax = scheduled.length;
    while (skillMax > 0 && measure(assemble(floorMatrix, skillMax)) > MAX) skillMax--;
  }

  const budget = MAX - measure(assemble([], skillMax));
  const matrix = renderWorkerCapabilityMatrix(caps, budget);

  const content = assemble(matrix, skillMax);
  // Last line of defence: the budget above ignores the newlines the matrix
  // itself adds, so re-check the assembled string and drop back to the floor
  // rendering rather than ever emitting an edit Telegram will reject.
  return measure(content) > MAX ? assemble(floorMatrix, skillMax) : content;
}

/**
 * Search topic-names.json for an existing topic with the dashboard name.
 * Returns the thread_id if found, undefined otherwise.
 */
async function findExistingDashboardTopic(chatId: number): Promise<number | undefined> {
  try {
    const map = await loadTopicNames();
    const inner = map.get(String(chatId));
    if (!inner) return undefined;
    for (const [threadIdStr, entry] of inner) {
      if (entry.name === DASHBOARD_TOPIC_NAME) {
        return Number(threadIdStr);
      }
    }
  } catch {
    // topic-names.json may not exist yet
  }
  return undefined;
}

export async function updateDashboard(token: string, fallbackChatId: number): Promise<void> {
  const state = await loadDashboardState();
  const chatId = state.chat_id || fallbackChatId;
  const content = await getDashboardContent();

  logger.info('dashboard', `Updating dashboard for chat ${chatId}`, {
    hasThread: !!state.thread_id,
    hasMessage: !!state.message_id
  });

  // 1. Ensure topic exists
  if (!state.thread_id) {
    // Check for an existing System Dashboard topic before creating a new one
    const existingThread = await findExistingDashboardTopic(chatId);
    if (existingThread) {
      logger.info('dashboard', `Reusing existing dashboard topic: ${existingThread}`);
      state.thread_id = existingThread;
      state.chat_id = chatId;
      await saveDashboardState(state);
    } else {
      try {
        logger.info('dashboard', 'Creating new forum topic');
        state.thread_id = await createForumTopic(token, chatId, DASHBOARD_TOPIC_NAME);
        state.chat_id = chatId;
        await saveDashboardState(state);
        logger.info('dashboard', `Created topic: ${state.thread_id}`);

        // Set a deterministic description for this system-managed topic
        try {
          const map = await loadTopicNames();
          await setTopicDescription(map, chatId, state.thread_id, DASHBOARD_DESCRIPTION);
        } catch (descErr) {
          logger.warn('dashboard', `Failed to set dashboard description: ${(descErr as Error).message}`);
        }
      } catch (err) {
        logger.error('dashboard', `Failed to create topic: ${(err as Error).message}`);
        return;
      }
    }
  }

  // 2. Message creation or update
  if (!state.message_id) {
    logger.info('dashboard', 'Sending initial dashboard message');
    const msgId = await sendMessageWithId(token, chatId, appendRefIdAndLog(content, { kind: 'system', chatId, threadId: state.thread_id }), state.thread_id);
    if (msgId) {
      state.message_id = msgId;
      const pinned = await pinChatMessage(token, chatId, msgId);
      if (!pinned) logger.warn('dashboard', 'Failed to pin message');
      await saveDashboardState(state);
      logger.info('dashboard', `Dashboard message sent and pinned: ${msgId}`);
    } else {
      logger.error('dashboard', 'Failed to send initial dashboard message');
    }
  } else {
    logger.info('dashboard', `Editing existing dashboard message: ${state.message_id}`);
    const success = await editMessageText(token, chatId, state.message_id, appendRefIdAndLog(content, { kind: 'system', chatId, threadId: state.thread_id }));
    if (!success) {
      // Potential deletion, clear and recreate
      logger.warn('dashboard', 'Edit failed, attempting recreation');
      state.message_id = undefined;
      await saveDashboardState(state);

      const msgId = await sendMessageWithId(token, chatId, appendRefIdAndLog(content, { kind: 'system', chatId, threadId: state.thread_id }), state.thread_id);
      if (msgId) {
        state.message_id = msgId;
        await pinChatMessage(token, chatId, msgId);
        await saveDashboardState(state);
        logger.info('dashboard', `Recreated dashboard message: ${msgId}`);
      } else {
        // If creation fails, maybe the thread is gone?
        logger.error('dashboard', 'Recreation failed, clearing thread_id');
        state.thread_id = undefined;
        await saveDashboardState(state);
      }
    } else {
      logger.info('dashboard', 'Dashboard message updated successfully');
    }
  }
}
