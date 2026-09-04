import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

import { loadConfig } from '../../../pa/dist/src/config.js';
import { loadSecrets } from '../../../pa/dist/src/secrets.js';
import { telegramFetch } from '../../../pa/dist/src/lib/telegram-proxy.js';
import { listRunningTasks, listTasks } from '../../../pa/dist/src/lib/topic-tasks.js';
import { resolveTopicKey } from '../../../pa/dist/src/lib/topic-events.js';
import { addWatchJob } from '../../../pa/dist/src/lib/watch-jobs.js';

import { loadTopicState, saveTopicState, listTopicStateRefs } from '../dist/conversation.js';
import { hydrateModelStatus, renderStatusCard } from '../dist/logic.js';
import { sanitizeMdV2 } from '../dist/telegram.js';
import { getKeepAwakeStatus } from '../dist/keepawake.js';
// Preserve Control Card Keyboard:
// Import buildControlCardKeyboard and currentCardKeyboard from ../src/callbacks.js (via dist at runtime)
import { buildControlCardKeyboard, currentCardKeyboard } from '../dist/callbacks.js';
import type { ConversationState, ModelStatusSnapshot } from '../dist/types.js';

export const USAGE = `Usage:
  pa bot refresh-cards [options]
  node --experimental-strip-types projects/telegram-bot/scripts/refresh-all-topics-status.ts [options]

Options:
  --chat-id <id>       Target chat ID (supergroup ID, e.g. -1001234567890)
  --topic <threadId>   Target single topic thread ID
  --dry-run            Simulate refresh without calling Telegram API or modifying state
  --async              Run detached in background and return immediately
  --watch-topic <key>  Topic key (e.g. -100123_456 or 456) to notify via watch_job when finished
  --pace-ms <ms>       Pacing delay in milliseconds between topic updates (default: 1500)
  --max-retries <n>    Maximum retries on HTTP 429 rate limit per topic (default: 3)
  --help, -h           Show this help message`;

export interface RefreshFlags {
  chatId?: number;
  topic?: number;
  dryRun: boolean;
  async: boolean;
  watchTopic?: string;
  paceMs: number;
  maxRetries: number;
  help: boolean;
}

export function parseRefreshFlags(argv: string[]): RefreshFlags {
  const flags: RefreshFlags = {
    dryRun: false,
    async: false,
    paceMs: 1500,
    maxRetries: 3,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--async') {
      flags.async = true;
    } else if (arg === '--chat-id' && i + 1 < argv.length) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val)) flags.chatId = val;
    } else if (arg.startsWith('--chat-id=')) {
      const val = parseInt(arg.slice('--chat-id='.length), 10);
      if (!isNaN(val)) flags.chatId = val;
    } else if (arg === '--topic' && i + 1 < argv.length) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val)) flags.topic = val;
    } else if (arg.startsWith('--topic=')) {
      const val = parseInt(arg.slice('--topic='.length), 10);
      if (!isNaN(val)) flags.topic = val;
    } else if (arg === '--watch-topic' && i + 1 < argv.length) {
      flags.watchTopic = argv[++i].trim();
    } else if (arg.startsWith('--watch-topic=')) {
      flags.watchTopic = arg.slice('--watch-topic='.length).trim();
    } else if (arg === '--pace-ms' && i + 1 < argv.length) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val >= 0) flags.paceMs = val;
    } else if (arg.startsWith('--pace-ms=')) {
      const val = parseInt(arg.slice('--pace-ms='.length), 10);
      if (!isNaN(val) && val >= 0) flags.paceMs = val;
    } else if (arg === '--max-retries' && i + 1 < argv.length) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val >= 0) flags.maxRetries = val;
    } else if (arg.startsWith('--max-retries=')) {
      const val = parseInt(arg.slice('--max-retries='.length), 10);
      if (!isNaN(val) && val >= 0) flags.maxRetries = val;
    }
  }

  return flags;
}

export function syncModelStatusState(state: ConversationState, snapshot: ModelStatusSnapshot): void {
  state.model_status = snapshot;
  state.pinned_worker = snapshot.current_worker;
}

export function topicKeyFor(chatId: number, threadId: number): string {
  return `${chatId}_${threadId}`;
}

export function resolveEffectiveDefaultWorker(configuredDefault: string | undefined, workers: Array<{ name: string }>): string {
  if (configuredDefault && workers.some((w) => w.name === configuredDefault)) {
    return configuredDefault;
  }
  return workers[0]?.name || 'agy';
}

export function getEffectiveDefaultWorker(config: any, topicKey: string): string {
  const configured = config?.topic_defaults?.[topicKey];
  return resolveEffectiveDefaultWorker(configured, config?.workers ?? []);
}

export async function topicTaskCounts(
  chatId: number,
  threadId: number
): Promise<{ running: number; parked: number; queued: number }> {
  try {
    const [running, queued] = await Promise.all([listRunningTasks(chatId, threadId), listTasks(chatId, threadId)]);
    return {
      running: running.filter((r) => r.status !== 'parked').length,
      parked: running.filter((r) => r.status === 'parked').length,
      queued: queued.filter((t) => t.kind === 'task').length,
    };
  } catch {
    return { running: 0, parked: 0, queued: 0 };
  }
}

export function buildStatusCardPayload(
  chatId: number,
  threadId: number,
  state: ConversationState,
  snapshot: ModelStatusSnapshot,
  keepAwake = getKeepAwakeStatus(),
  tasks?: { running: number; parked: number; queued: number }
): {
  pinText: string;
  sanitizedText: string;
  keyboard: ReturnType<typeof buildControlCardKeyboard>;
  editBody: Record<string, unknown>;
  sendBody: Record<string, unknown>;
} {
  const pinText = renderStatusCard({ snapshot, keepAwake, tasks });
  const sanitizedText = sanitizeMdV2(pinText.trim());
  const keyboard = (state.pinned_status_message_id
    ? currentCardKeyboard(chatId, state.pinned_status_message_id)
    : undefined) ?? buildControlCardKeyboard();

  const editBody: Record<string, unknown> = {
    chat_id: chatId,
    message_id: state.pinned_status_message_id,
    text: sanitizedText,
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  };

  const sendBody: Record<string, unknown> = {
    chat_id: chatId,
    text: sanitizedText,
    parse_mode: 'MarkdownV2',
    reply_markup: buildControlCardKeyboard(),
  };
  if (threadId && threadId !== 0) {
    sendBody.message_thread_id = threadId;
  }

  return { pinText, sanitizedText, keyboard, editBody, sendBody };
}

export async function apiCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  maxRetries: number = 3
): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  let retries = 0;
  while (true) {
    let res: Response;
    try {
      res = await telegramFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      retries++;
      if (retries > maxRetries) {
        throw new Error(`${method} failed on network error and exceeded max retries (${maxRetries}): ${err.message}`);
      }
      console.warn(`[network error on ${method}, retrying in 3s (${retries}/${maxRetries})]:`, err.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (res.ok) {
      return await res.json();
    }

    const errText = await res.text();
    if (res.status === 429) {
      retries++;
      if (retries > maxRetries) {
        throw new Error(`${method} hit 429 rate limit and exceeded max retries (${maxRetries}): ${errText}`);
      }
      let waitSeconds = 35;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.parameters?.retry_after) waitSeconds = parsed.parameters.retry_after + 2;
      } catch {}
      console.log(`⏳ Hit 429 on ${method}. Sleeping ${waitSeconds}s before retry (attempt ${retries}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
      continue;
    }

    if (errText.includes('message is not modified')) {
      return { ok: true, result: true };
    }

    throw new Error(`${method} failed (${res.status}): ${errText}`);
  }
}

export async function runRefresh(
  flags: RefreshFlags,
  childArgsForAsync: string[] = []
): Promise<{ updated: number; failed: number; total: number; exitCode: number }> {
  const startTime = Date.now();
  const runId = process.env.PA_REFRESH_CARDS_RUN_ID || `${Date.now()}-${randomBytes(3).toString('hex')}`;

  // If detached async mode requested:
  if (flags.async) {
    const logDir = join(homedir(), '.pa', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `status-card-refresh-${runId}.log`);
    const sentinelPath = join(homedir(), '.pa', `status-card-refresh-${runId}.done`);

    // Register AI-170 watch_job if watch-topic is requested
    if (flags.watchTopic) {
      const target = await resolveTopicKey(flags.watchTopic);
      if (!target) {
        console.error(`Error: Could not resolve watch topic key: ${flags.watchTopic}`);
        return { updated: 0, failed: 1, total: 0, exitCode: 1 };
      }

      const watchRes = await addWatchJob({
        description: `Multi-topic status card refresh (${runId})`,
        check: {
          type: 'file_exists',
          path: sentinelPath,
        },
        deadlineMinutes: 15,
        source: {
          kind: 'cli',
          chatId: String(target.chatId),
          threadId: target.threadId,
          refId: null,
        },
      });

      if (watchRes.ok) {
        console.log(`Registered watch job: ${watchRes.watch.id} (notifies ${target.chatId}_${target.threadId})`);
      } else {
        console.warn(`Warning: Failed to register watch job: ${watchRes.error}`);
      }
    }

    // Filter child arguments to avoid recursion
    const childArgs = childArgsForAsync.filter((arg, idx, arr) => {
      if (arg === '--async') return false;
      if (arg === '--watch-topic') return false;
      if (arr[idx - 1] === '--watch-topic') return false;
      if (arg.startsWith('--watch-topic=')) return false;
      return true;
    });

    const outFd = openSync(logPath, 'a');
    const thisScript = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, ['--experimental-strip-types', thisScript, ...childArgs], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: {
        ...process.env,
        PA_REFRESH_CARDS_DONE_FILE: sentinelPath,
        PA_REFRESH_CARDS_RUN_ID: runId,
      },
      windowsHide: true,
    });
    child.unref();

    console.log(`Status card refresh started in background.`);
    console.log(`Run ID:    ${runId}`);
    console.log(`Log:       ${logPath}`);
    console.log(`Sentinel:  ${sentinelPath}`);
    return { updated: 0, failed: 0, total: 0, exitCode: 0 };
  }

  // If running synchronously with --watch-topic, register watch on sentinel file
  if (flags.watchTopic && !process.env.PA_REFRESH_CARDS_DONE_FILE) {
    const sentinelPath = join(homedir(), '.pa', `status-card-refresh-${runId}.done`);
    process.env.PA_REFRESH_CARDS_DONE_FILE = sentinelPath;

    const target = await resolveTopicKey(flags.watchTopic);
    if (!target) {
      console.error(`Error: Could not resolve watch topic key: ${flags.watchTopic}`);
      return { updated: 0, failed: 1, total: 0, exitCode: 1 };
    }

    const watchRes = await addWatchJob({
      description: `Multi-topic status card refresh (${runId})`,
      check: {
        type: 'file_exists',
        path: sentinelPath,
      },
      deadlineMinutes: 15,
      source: {
        kind: 'cli',
        chatId: String(target.chatId),
        threadId: target.threadId,
        refId: null,
      },
    });

    if (watchRes.ok) {
      console.log(`Registered watch job: ${watchRes.watch.id} (notifies ${target.chatId}_${target.threadId})`);
    } else {
      console.warn(`Warning: Failed to register watch job: ${watchRes.error}`);
    }
  }

  const secrets = await loadSecrets().catch(() => ({} as Record<string, string>));
  const token = secrets.TELEGRAM_BOT_TOKEN;
  if (!token && !flags.dryRun) {
    console.error('TELEGRAM_BOT_TOKEN missing in secrets');
    return { updated: 0, failed: 1, total: 0, exitCode: 1 };
  }

  const config = await loadConfig().catch(() => ({}));
  const allRefs = await listTopicStateRefs();
  const refSet = new Set<string>();
  const refs: Array<{ chatId: number; threadId: number }> = [];

  // Supergroup IDs in Telegram are negative integers (e.g. -1001234567890).
  // Safely skip invalid chat IDs (e.g. 123_0, non-negative, or NaN).
  for (const r of allRefs) {
    if (typeof r.chatId === 'number' && Number.isInteger(r.chatId) && r.chatId < 0) {
      const key = topicKeyFor(r.chatId, r.threadId);
      if (!refSet.has(key)) {
        refSet.add(key);
        refs.push(r);
      }
    }
  }

  // Also include topics defined in telegram-topic-names.json
  const topicNamesPath = join(homedir(), '.pa', 'telegram-topic-names.json');
  if (existsSync(topicNamesPath)) {
    try {
      const namesData = JSON.parse(readFileSync(topicNamesPath, 'utf8'));
      for (const [chatIdStr, topics] of Object.entries(namesData)) {
        const chatId = parseInt(chatIdStr, 10);
        if (Number.isInteger(chatId) && chatId < 0 && typeof topics === 'object' && topics !== null) {
          for (const threadIdStr of Object.keys(topics)) {
            const threadId = parseInt(threadIdStr, 10);
            if (Number.isInteger(threadId)) {
              const key = topicKeyFor(chatId, threadId);
              if (!refSet.has(key)) {
                refSet.add(key);
                refs.push({ chatId, threadId });
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('Failed to parse telegram-topic-names.json:', err.message);
    }
  }

  // Filter topics by flags
  let filteredRefs = refs;
  if (flags.chatId !== undefined) {
    filteredRefs = filteredRefs.filter((r) => r.chatId === flags.chatId);
  }
  if (flags.topic !== undefined) {
    filteredRefs = filteredRefs.filter((r) => r.threadId === flags.topic);
  }

  if (flags.dryRun) {
    console.log(`[dry-run] Found ${filteredRefs.length} real topics to simulate refresh`);
  } else {
    console.log(`Found ${filteredRefs.length} real topics to refresh across supergroups and topic names`);
  }

  let updatedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < filteredRefs.length; i++) {
    const ref = filteredRefs[i];
    const prefix = `[${i + 1}/${filteredRefs.length}]`;
    try {
      const topicState = await loadTopicState(ref.chatId, ref.threadId);
      const topicKey = topicKeyFor(ref.chatId, ref.threadId);
      const effectiveDefault = getEffectiveDefaultWorker(config, topicKey);
      const snapshot = hydrateModelStatus(topicState, effectiveDefault, config);
      syncModelStatusState(topicState, snapshot);

      const keepAwake = getKeepAwakeStatus();
      const tasks = await topicTaskCounts(ref.chatId, ref.threadId);

      const payload = buildStatusCardPayload(
        ref.chatId,
        ref.threadId,
        topicState,
        snapshot,
        keepAwake,
        tasks
      );

      if (flags.dryRun) {
        console.log(
          `${prefix} [dry-run] Topic ${ref.chatId}_${ref.threadId}: would update status card (agent: ${snapshot.current_worker}, model: ${snapshot.current_llm || 'default'}, tasks: ${tasks.running}r/${tasks.parked}p/${tasks.queued}q)`
        );
        updatedCount++;
        continue;
      }

      let success = false;
      if (topicState.pinned_status_message_id) {
        try {
          await apiCall(token!, 'editMessageText', payload.editBody, flags.maxRetries);
          await apiCall(
            token!,
            'pinChatMessage',
            {
              chat_id: ref.chatId,
              message_id: topicState.pinned_status_message_id,
              disable_notification: false,
            },
            flags.maxRetries
          ).catch((err) => console.warn(`pinChatMessage on ${ref.chatId}_${ref.threadId} returned: ${err.message}`));
          success = true;
        } catch (err: any) {
          if (err.message.includes('message to edit not found')) {
            console.log(`Old pin message not found for ${ref.chatId}_${ref.threadId}, creating new...`);
          } else {
            console.warn(`Edit failed for ${ref.chatId}_${ref.threadId}: ${err.message}`);
          }
        }
      }

      if (!success) {
        const sendRes = await apiCall(token!, 'sendMessage', payload.sendBody, flags.maxRetries);
        const pinMsgId = sendRes.result?.message_id;
        if (pinMsgId) {
          const oldPinId = topicState.pinned_status_message_id;
          await apiCall(
            token!,
            'pinChatMessage',
            {
              chat_id: ref.chatId,
              message_id: pinMsgId,
              disable_notification: false,
            },
            flags.maxRetries
          ).catch((err) => console.warn(`pinChatMessage new on ${ref.chatId}_${ref.threadId} returned: ${err.message}`));
          topicState.pinned_status_message_id = pinMsgId;
          if (oldPinId && oldPinId !== pinMsgId) {
            await apiCall(
              token!,
              'unpinChatMessage',
              {
                chat_id: ref.chatId,
                message_id: oldPinId,
              },
              flags.maxRetries
            ).catch(() => {});
          }
          success = true;
        }
      }

      if (success) {
        await saveTopicState(topicState);
        updatedCount++;
        console.log(
          `✓ ${prefix} Updated topic ${ref.chatId}_${ref.threadId} (agent: ${snapshot.current_worker}, model: ${snapshot.current_llm || 'default'})`
        );
      } else {
        failedCount++;
        console.warn(`✗ ${prefix} Failed to update topic ${ref.chatId}_${ref.threadId}`);
      }

      if (flags.paceMs > 0 && i < filteredRefs.length - 1) {
        await new Promise((r) => setTimeout(r, flags.paceMs));
      }
    } catch (err: any) {
      failedCount++;
      console.error(`Error processing topic ${ref.chatId}_${ref.threadId}:`, err.message);
    }
  }

  console.log(`\n=============================================`);
  if (flags.dryRun) {
    console.log(`Dry-run finished: ${updatedCount} topics simulated, 0 failed.`);
  } else {
    console.log(`Completed topic refresh: ${updatedCount} updated, ${failedCount} failed.`);
  }
  console.log(`=============================================\n`);

  // Write JSON summary to PA_REFRESH_CARDS_DONE_FILE if present
  const doneFile = process.env.PA_REFRESH_CARDS_DONE_FILE;
  if (doneFile) {
    try {
      const summary = {
        runId,
        completedAt: new Date().toISOString(),
        dryRun: flags.dryRun,
        updated: updatedCount,
        failed: failedCount,
        errorCount: failedCount,
        elapsedMs: Date.now() - startTime,
        total: filteredRefs.length,
      };
      writeFileSync(doneFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
      console.log(`Wrote completion sentinel: ${doneFile}`);
    } catch (err: any) {
      console.error(`Failed to write completion sentinel to ${doneFile}:`, err.message);
    }
  }

  return {
    updated: updatedCount,
    failed: failedCount,
    total: filteredRefs.length,
    exitCode: failedCount > 0 ? 1 : 0,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const flags = parseRefreshFlags(argv);

  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  const result = await runRefresh(flags, argv);
  return result.exitCode;
}

const isMain =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
    process.argv[1].endsWith('refresh-all-topics-status.ts') ||
    process.argv[1].endsWith('refresh-all-topics-status.js'));

if (isMain) {
  main().then((code) => {
    if (typeof code === 'number' && code !== 0) {
      process.exit(code);
    }
  }).catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
