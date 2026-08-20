import { loadConfig } from '../../../pa/dist/src/config.js';
import { loadSecrets } from '../../../pa/dist/src/secrets.js';
import { telegramFetch } from '../../../pa/dist/src/lib/telegram-proxy.js';
import { loadTopicState, saveTopicState, listTopicStateRefs } from '../src/conversation.js';
import { hydrateModelStatus, renderStatusCard } from '../src/logic.js';
import { sanitizeMdV2 } from '../src/telegram.js';
import { getKeepAwakeStatus } from '../src/keepawake.js';
import type { ConversationState, ModelStatusSnapshot } from '../src/types.js';

function syncModelStatusState(state: ConversationState, snapshot: ModelStatusSnapshot): void {
  state.model_status = snapshot;
  state.pinned_worker = snapshot.current_worker;
}

function topicKeyFor(chatId: number, threadId: number): string {
  return `${chatId}_${threadId}`;
}

function resolveEffectiveDefaultWorker(configuredDefault: string | undefined, workers: Array<{ name: string }>): string {
  if (configuredDefault && workers.some((w) => w.name === configuredDefault)) {
    return configuredDefault;
  }
  return workers[0]?.name || 'agy';
}

function getEffectiveDefaultWorker(config: any, topicKey: string): string {
  const configured = config?.topic_defaults?.[topicKey];
  return resolveEffectiveDefaultWorker(configured, config?.workers ?? []);
}

async function apiCall(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  while (true) {
    let res: Response;
    try {
      res = await telegramFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      console.warn(`[network error on ${method}, retrying in 3s]:`, err.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    if (res.ok) {
      return await res.json();
    }

    const errText = await res.text();
    if (res.status === 429) {
      let waitSeconds = 35;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.parameters?.retry_after) waitSeconds = parsed.parameters.retry_after + 2;
      } catch {}
      console.log(`⏳ Hit 429 on ${method}. Sleeping ${waitSeconds}s before retry...`);
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
      continue;
    }

    if (errText.includes('message is not modified')) {
      return { ok: true, result: true };
    }

    throw new Error(`${method} failed (${res.status}): ${errText}`);
  }
}

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function main() {
  const secrets = await loadSecrets();
  const token = secrets.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN missing in secrets');
    process.exit(1);
  }
  const config = await loadConfig();
  const allRefs = await listTopicStateRefs();
  const refSet = new Set<string>();

  const refs: Array<{ chatId: number; threadId: number }> = [];

  for (const r of allRefs) {
    if (r.chatId < 0 || r.chatId > 1000000) {
      const key = `${r.chatId}_${r.threadId}`;
      if (!refSet.has(key)) {
        refSet.add(key);
        refs.push(r);
      }
    }
  }

  // Also include any topic defined in telegram-topic-names.json
  const topicNamesPath = join(homedir(), '.pa', 'telegram-topic-names.json');
  if (existsSync(topicNamesPath)) {
    try {
      const namesData = JSON.parse(readFileSync(topicNamesPath, 'utf8'));
      for (const [chatIdStr, topics] of Object.entries(namesData)) {
        const chatId = parseInt(chatIdStr, 10);
        if (!isNaN(chatId) && typeof topics === 'object' && topics !== null) {
          for (const threadIdStr of Object.keys(topics)) {
            const threadId = parseInt(threadIdStr, 10);
            if (!isNaN(threadId)) {
              const key = `${chatId}_${threadId}`;
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

  console.log(`Found ${refs.length} real topics to refresh across supergroups and topic names`);

  let updatedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    console.log(`[${i + 1}/${refs.length}] Processing topic ${ref.chatId}_${ref.threadId}...`);
    try {
      const topicState = await loadTopicState(ref.chatId, ref.threadId);
      const topicKey = topicKeyFor(ref.chatId, ref.threadId);
      const effectiveDefault = getEffectiveDefaultWorker(config, topicKey);
      const snapshot = hydrateModelStatus(topicState, effectiveDefault, config);
      syncModelStatusState(topicState, snapshot);

      const keepAwake = getKeepAwakeStatus();
      const pinText = renderStatusCard({ snapshot, keepAwake });

      let success = false;
      if (topicState.pinned_status_message_id) {
        try {
          await apiCall(token, 'editMessageText', {
            chat_id: ref.chatId,
            message_id: topicState.pinned_status_message_id,
            text: sanitizeMdV2(pinText.trim()),
            parse_mode: 'MarkdownV2',
          });
          // Ensure it is pinned in Telegram
          await apiCall(token, 'pinChatMessage', {
            chat_id: ref.chatId,
            message_id: topicState.pinned_status_message_id,
            disable_notification: false,
          }).catch((err) => console.warn(`pinChatMessage on ${ref.chatId}_${ref.threadId} returned: ${err.message}`));
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
        // Create new message and pin it
        const sendBody: Record<string, unknown> = {
          chat_id: ref.chatId,
          text: sanitizeMdV2(pinText.trim()),
          parse_mode: 'MarkdownV2',
        };
        if (ref.threadId && ref.threadId !== 0) {
          sendBody.message_thread_id = ref.threadId;
        }

        const sendRes = await apiCall(token, 'sendMessage', sendBody);
        const pinMsgId = sendRes.result?.message_id;
        if (pinMsgId) {
          const oldPinId = topicState.pinned_status_message_id;
          await apiCall(token, 'pinChatMessage', {
            chat_id: ref.chatId,
            message_id: pinMsgId,
            disable_notification: false,
          }).catch((err) => console.warn(`pinChatMessage new on ${ref.chatId}_${ref.threadId} returned: ${err.message}`));
          topicState.pinned_status_message_id = pinMsgId;
          if (oldPinId && oldPinId !== pinMsgId) {
            await apiCall(token, 'unpinChatMessage', {
              chat_id: ref.chatId,
              message_id: oldPinId,
            }).catch(() => {});
          }
          success = true;
        }
      }

      if (success) {
        await saveTopicState(topicState);
        updatedCount++;
        console.log(`✓ [${i + 1}/${refs.length}] Updated topic ${ref.chatId}_${ref.threadId} (agent: ${snapshot.current_worker}, model: ${snapshot.current_llm || 'default'})`);
      } else {
        failedCount++;
        console.warn(`✗ [${i + 1}/${refs.length}] Failed to update topic ${ref.chatId}_${ref.threadId}`);
      }

      // Safe pacing: 1500ms delay between updates to respect Telegram rate limits
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err: any) {
      failedCount++;
      console.error(`Error processing topic ${ref.chatId}_${ref.threadId}:`, err.message);
    }
  }

  console.log(`\n=============================================`);
  console.log(`Completed topic refresh: ${updatedCount} updated, ${failedCount} failed.`);
  console.log(`=============================================\n`);
}

main().catch(console.error);
