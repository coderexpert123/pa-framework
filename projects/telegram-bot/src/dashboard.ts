import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { getKeepAwakeStatus } from './keepawake.js';
import { sendMessageWithId, editMessageText, pinChatMessage, createForumTopic } from './telegram.js';
import { loadConfig } from '../../../pa/dist/src/config.js';
import { listSkills } from '../../../pa/dist/src/skills.js';
import { formatIST } from '../../../pa/dist/src/ist.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { loadTopicNames, setTopicDescription } from './topic-names.js';
import { appendRefIdAndLog } from './ref-id.js';

const DASHBOARD_TOPIC_NAME = 'System Dashboard';
const DASHBOARD_DESCRIPTION = 'Live system status — keep-awake state, model failover priorities, and scheduled skill crons. Auto-updated by the bot.';

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

  const lines: string[] = [];
  lines.push('⚫️ **SYSTEM DASHBOARD**');
  lines.push(`_${DASHBOARD_DESCRIPTION}_`);
  lines.push('');

  // 1. Keep-awake status
  let kaStatus = 'off';
  if (ka.active) {
    const since = ka.since ? formatIST(new Date(ka.since)).slice(11, 16) : '';
    kaStatus = `on${since ? ` since ${since} IST` : ''}`;
  }
  lines.push(`⏰ **Keep-awake**: ${kaStatus}`);
  lines.push('');

  // 2. Model Priorities
  lines.push('⚙️ **Model Failover Order**');
  const sortedWorkers = [...(config.workers || [])].sort((a, b) => a.priority - b.priority);
  sortedWorkers.forEach((w, i) => {
    lines.push(`${i + 1}. ${w.name} (priority ${w.priority})`);
  });
  lines.push('');

  // 3. Scheduled Skills
  lines.push('📊 **Skill Schedule**');
  const scheduled = skills.filter(s => s.frontmatter.cron);
  if (scheduled.length === 0) {
    lines.push('_No scheduled skills_');
  } else {
    scheduled.forEach(s => {
      lines.push(`- **${s.name}**: \`${s.frontmatter.cron}\``);
    });
  }

  lines.push('');
  lines.push(`_Last updated: ${formatIST(new Date())}_`);

  return lines.join('\n');
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
