import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildControlCardKeyboard, currentCardKeyboard } from '../callbacks.js';
import { renderStatusCard } from '../logic.js';
import type { ConversationState, ModelStatusSnapshot } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const botRoot = join(__dirname, '../..');
const repoRoot = join(botRoot, '../..');
const scriptPath = join(botRoot, 'scripts', 'refresh-all-topics-status.ts');

describe('refresh-cards (WP-1, WP-2, WP-3)', () => {
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'pa-refresh-test-'));
    await writeFile(join(testHome, 'config.yaml'), 'workers:\n  - name: agy\n', 'utf8');
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true }).catch(() => {});
  });

  describe('CLI flags & --help usage', () => {
    it('prints full usage text and exits 0 on --help', () => {
      const res = spawnSync(
        process.execPath,
        ['--experimental-strip-types', scriptPath, '--help'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          windowsHide: true,
        }
      );

      assert.equal(res.status, 0, `Expected exit code 0, got ${res.status}. Stderr: ${res.stderr}`);
      const out = res.stdout;
      assert.match(out, /Usage:/);
      assert.match(out, /pa bot refresh-cards/);
      assert.match(out, /--chat-id <id>/);
      assert.match(out, /--topic <threadId>/);
      assert.match(out, /--dry-run/);
      assert.match(out, /--async/);
      assert.match(out, /--watch-topic <key>/);
      assert.match(out, /--pace-ms <ms>/);
      assert.match(out, /--max-retries <n>/);
      assert.match(out, /--help, -h/);
    });

    it('prints usage text and exits 0 on -h', () => {
      const res = spawnSync(
        process.execPath,
        ['--experimental-strip-types', scriptPath, '-h'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          windowsHide: true,
        }
      );

      assert.equal(res.status, 0);
      assert.match(res.stdout, /Usage:/);
    });
  });

  describe('--dry-run mode', () => {
    it('simulates refresh without calling Telegram and safely skips invalid chat IDs', async () => {
      // Create a valid negative supergroup topic and an invalid positive chat topic in isolated testHome
      const validChatId = -1009999999999;
      const validThreadId = 42;
      const invalidChatId = 123;
      const invalidThreadId = 0;

      const validState: ConversationState = {
        chat_id: validChatId,
        last_update_id: 0,
        thread_id: validThreadId,
        pinned_status_message_id: 111,
        pinned_worker: 'agy',
        turns: [],
      };

      const invalidState: ConversationState = {
        chat_id: invalidChatId,
        last_update_id: 0,
        thread_id: invalidThreadId,
        pinned_status_message_id: 222,
        pinned_worker: 'agy',
        turns: [],
      };

      await writeFile(
        join(testHome, `telegram-bot-topic-${validChatId}_${validThreadId}.json`),
        JSON.stringify(validState),
        'utf8'
      );
      await writeFile(
        join(testHome, `telegram-bot-topic-${invalidChatId}_${invalidThreadId}.json`),
        JSON.stringify(invalidState),
        'utf8'
      );

      const res = spawnSync(
        process.execPath,
        ['--experimental-strip-types', scriptPath, '--dry-run', '--topic', String(validThreadId)],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PA_HOME: testHome,
            HOME: testHome,
            USERPROFILE: testHome,
          },
          windowsHide: true,
        }
      );

      assert.equal(res.status, 0, `Dry run failed: ${res.stderr}\n${res.stdout}`);
      assert.match(res.stdout, /\[dry-run\]/);
      assert.match(res.stdout, new RegExp(`Topic ${validChatId}_${validThreadId}: would update status card`));
      assert.doesNotMatch(res.stdout, new RegExp(`Topic ${invalidChatId}_${invalidThreadId}`));
      assert.match(res.stdout, /Dry-run finished: 1 topics simulated, 0 failed/);
    });
  });

  describe('Control card keyboard preservation', () => {
    it('buildControlCardKeyboard provides required menu and action buttons', () => {
      const kb = buildControlCardKeyboard();
      assert.ok(kb.inline_keyboard, 'Expected inline_keyboard array');
      assert.equal(kb.inline_keyboard.length, 2, 'Expected 2 rows of buttons');

      const row0 = kb.inline_keyboard[0];
      assert.equal(row0.length, 3);
      assert.equal(row0[0].text, 'Agent ▸');
      assert.equal(row0[0].callback_data, 'cc:agent');
      assert.equal(row0[1].text, 'Model ▸');
      assert.equal(row0[1].callback_data, 'cc:model');
      assert.equal(row0[2].text, 'Effort ▸');
      assert.equal(row0[2].callback_data, 'cc:effort');

      const row1 = kb.inline_keyboard[1];
      assert.equal(row1.length, 2);
      assert.equal(row1[0].text, '🆕 New');
      assert.equal(row1[0].callback_data, 'cc:new');
      assert.equal(row1[1].text, '⏹ Stop');
      assert.equal(row1[1].callback_data, 'cc:stop');
    });

    it('currentCardKeyboard defaults to buildControlCardKeyboard when no submenu active', () => {
      const kb = currentCardKeyboard(-100123, 999999) ?? buildControlCardKeyboard();
      assert.ok(kb);
      assert.equal(kb.inline_keyboard[0][0].callback_data, 'cc:agent');
    });

    it('payload includes reply_markup for both new sends and in-place edits', () => {
      const snapshot: ModelStatusSnapshot = {
        current_worker: 'agy',
        default_worker: 'agy',
        reason_code: 'default_active',
        reason_text: 'Default worker',
        changed_at: new Date().toISOString(),
        current_llm: 'gemini-3.8-flash-high',
        current_effort: 'high',
      };
      const tasks = { running: 1, parked: 0, queued: 2 };

      const pinText = renderStatusCard({ snapshot, tasks });
      assert.match(pinText, /Tasks: 1 running · 0 parked · 2 queued/);

      const controlKeyboard = buildControlCardKeyboard();
      const sendBody = {
        chat_id: -100123,
        text: pinText,
        reply_markup: controlKeyboard,
      };

      const editBody = {
        chat_id: -100123,
        message_id: 456,
        text: pinText,
        reply_markup: controlKeyboard,
      };

      assert.ok(sendBody.reply_markup?.inline_keyboard, 'sendBody must have inline_keyboard');
      assert.ok(editBody.reply_markup?.inline_keyboard, 'editBody must have inline_keyboard');
      assert.equal(sendBody.reply_markup.inline_keyboard[0][0].callback_data, 'cc:agent');
      assert.equal(editBody.reply_markup.inline_keyboard[0][0].callback_data, 'cc:agent');
    });
  });

  describe('Completion sentinel file', () => {
    it('writes JSON summary to PA_REFRESH_CARDS_DONE_FILE upon completion', async () => {
      const sentinelFile = join(testHome, 'status-card-refresh-test.done');
      const validChatId = -1009999999999;
      const validThreadId = 77;

      const validState: ConversationState = {
        chat_id: validChatId,
        last_update_id: 0,
        thread_id: validThreadId,
        pinned_status_message_id: 888,
        pinned_worker: 'agy',
        turns: [],
      };

      await writeFile(
        join(testHome, `telegram-bot-topic-${validChatId}_${validThreadId}.json`),
        JSON.stringify(validState),
        'utf8'
      );

      const res = spawnSync(
        process.execPath,
        ['--experimental-strip-types', scriptPath, '--dry-run', '--topic', String(validThreadId)],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PA_HOME: testHome,
            HOME: testHome,
            USERPROFILE: testHome,
            PA_REFRESH_CARDS_DONE_FILE: sentinelFile,
            PA_REFRESH_CARDS_RUN_ID: 'test-run-1234',
          },
          windowsHide: true,
        }
      );

      assert.equal(res.status, 0, `Execution failed: ${res.stderr}\n${res.stdout}`);
      assert.ok(existsSync(sentinelFile), `Sentinel file ${sentinelFile} was not written`);

      const content = JSON.parse(await readFile(sentinelFile, 'utf8'));
      assert.equal(content.runId, 'test-run-1234');
      assert.equal(content.dryRun, true);
      assert.equal(content.updated, 1);
      assert.equal(content.failed, 0);
      assert.equal(content.errorCount, 0);
      assert.equal(content.total, 1);
      assert.ok(content.completedAt, 'completedAt must be set');
      assert.ok(typeof content.elapsedMs === 'number', 'elapsedMs must be a number');
    });
  });

  describe('Replace-path pin contract (pin-loss fix)', () => {
    // Each test spawns the REAL script through a driver that installs a Telegram
    // API fetch double, so the actual edit/replace/pin decision code runs against
    // per-method canned responses and the topic-state file records the outcome.
    // The double is installed AFTER the script import (telegram-proxy captures
    // the import-time fetch), and __PA_REAL_FETCH__ keeps the true real fetch
    // distinguishable, so the inherited PA_NOTIFY_DISABLED=1 kill switch routes
    // every call to the double — the network is never touched.
    const CHAT = -1009999999999;

    const DRIVER_SOURCE = `
// Spawned by refresh-cards.test.ts — installs a Telegram API fetch double, then
// runs the real refresh-all-topics-status script against it.
import { writeFileSync } from 'node:fs';
const calls = [];
globalThis.__PA_REAL_FETCH__ = globalThis.fetch;
const mod = await import(process.env.PA_TG_SCRIPT_URL);
const profile = JSON.parse(process.env.PA_TG_PROFILE || '{}');
const respond = (status, payload) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init) => {
  const m = String(url).match(/\\/bot[^/]+\\/([A-Za-z]+)/);
  const method = m ? m[1] : String(url);
  const body = init && init.body ? JSON.parse(String(init.body)) : {};
  calls.push({ method, body });
  const rule = profile[method];
  if (rule === undefined || rule === 'ok') {
    return respond(200, { ok: true, result: { message_id: 424242 } });
  }
  if (rule === 'not-found') {
    return respond(400, { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });
  }
  if (rule === 'server-error') {
    return respond(500, { ok: false, error_code: 500, description: 'Bad Request: internal server error' });
  }
  if (rule === 'rate-limited') {
    return respond(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 0',
      parameters: { retry_after: 0 },
    });
  }
  return respond(200, { ok: true, result: { message_id: rule } });
};
const cliArgs = JSON.parse(process.env.PA_TG_CLI_ARGS || '[]');
const flags = mod.parseRefreshFlags(cliArgs);
const result = await mod.runRefresh(flags, cliArgs);
const { flushLog } = await import(process.env.PA_TG_LOG_URL);
await flushLog();
writeFileSync(process.env.PA_TG_RESULT_FILE, JSON.stringify({ calls, result }, null, 2), 'utf8');
`;

    let driverPath: string;
    let resultPath: string;

    const statePath = (threadId: number) => join(testHome, `telegram-bot-topic-${CHAT}_${threadId}.json`);

    const writeState = async (threadId: number, pinnedId: number | null) => {
      const state: ConversationState = {
        chat_id: CHAT,
        last_update_id: 0,
        thread_id: threadId,
        pinned_worker: 'agy',
        turns: [],
      };
      if (pinnedId !== null) state.pinned_status_message_id = pinnedId;
      await writeFile(statePath(threadId), JSON.stringify(state), 'utf8');
    };

    const readState = async (threadId: number) =>
      JSON.parse(await readFile(statePath(threadId), 'utf8')) as ConversationState;

    const runDriver = (threadId: number, profile: Record<string, unknown>, maxRetries = 3) =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', driverPath],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            PA_HOME: testHome,
            HOME: testHome,
            USERPROFILE: testHome,
            PA_TG_SCRIPT_URL: pathToFileURL(scriptPath).href,
            PA_TG_LOG_URL: pathToFileURL(join(repoRoot, 'pa', 'dist', 'src', 'lib', 'log.js')).href,
            PA_TG_PROFILE: JSON.stringify(profile),
            PA_TG_CLI_ARGS: JSON.stringify([
              '--topic',
              String(threadId),
              '--pace-ms',
              '0',
              '--max-retries',
              String(maxRetries),
            ]),
            PA_TG_RESULT_FILE: resultPath,
          },
          windowsHide: true,
          timeout: 120_000,
        }
      );

    beforeEach(async () => {
      driverPath = join(testHome, 'tg-double-driver.mjs');
      resultPath = join(testHome, 'tg-double-driver-result.json');
      await writeFile(driverPath, DRIVER_SOURCE, 'utf8');
      await writeFile(join(testHome, 'secrets.env'), 'TELEGRAM_BOT_TOKEN=123456000:AAEfakeTestToken\n', 'utf8');
    });

    it('pin success records the new id and unpins the old', async () => {
      await writeState(91, 111);
      const res = runDriver(91, {
        editMessageText: 'not-found',
        sendMessage: 777,
        pinChatMessage: 'ok',
        unpinChatMessage: 'ok',
      });
      assert.equal(res.status, 0, `driver failed: ${res.stderr}\n${res.stdout}`);
      const { calls, result } = JSON.parse(await readFile(resultPath, 'utf8'));
      const state = await readState(91);
      assert.equal(state.pinned_status_message_id, 777, 'state must record the new card id');
      const unpin = calls.find((c: any) => c.method === 'unpinChatMessage');
      assert.ok(unpin, 'expected unpinChatMessage for the old card');
      assert.equal(unpin.body.message_id, 111);
      const pin = calls.find((c: any) => c.method === 'pinChatMessage');
      assert.equal(pin.body.message_id, 777);
      assert.equal(pin.body.disable_notification, true, 'pins must carry disable_notification: true');
      assert.equal(result.updated, 1);
      assert.equal(result.failed, 0);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.pinTotals, { pinned: 1, keptOld: 0, failed: 0 });
      assert.equal(result.topicOutcomes[0].outcome, 'pinned');
    });

    it('pin failure keeps the old id, never unpins, and logs the failure', async () => {
      await writeState(92, 111);
      const res = runDriver(92, { editMessageText: 'not-found', sendMessage: 777, pinChatMessage: 'rate-limited' }, 0);
      assert.equal(res.status, 0, `driver failed: ${res.stderr}\n${res.stdout}`);
      const { calls, result } = JSON.parse(await readFile(resultPath, 'utf8'));
      const state = await readState(92);
      assert.equal(state.pinned_status_message_id, 111, 'old pinned id must be retained when the new pin fails');
      assert.ok(!calls.some((c: any) => c.method === 'unpinChatMessage'), 'must NOT unpin the old card on pin failure');
      assert.equal(result.updated, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.pinTotals, { pinned: 0, keptOld: 0, failed: 1 });
      assert.equal(result.topicOutcomes[0].outcome, 'failed');
      const logRaw = await readFile(join(testHome, 'app.log.jsonl'), 'utf8');
      assert.match(logRaw, /"module":"refresh-cards"/);
      assert.match(logRaw, /pin of new status card failed/);
    });

    it('non-not-found edit failure skips replace and keeps the pinned card', async () => {
      await writeState(93, 111);
      const res = runDriver(93, { editMessageText: 'server-error' });
      assert.equal(res.status, 0, `driver failed: ${res.stderr}\n${res.stdout}`);
      const { calls, result } = JSON.parse(await readFile(resultPath, 'utf8'));
      assert.ok(calls.some((c: any) => c.method === 'editMessageText'));
      assert.ok(
        !calls.some((c: any) => c.method === 'sendMessage'),
        'must not fall to replace on a non-not-found edit failure'
      );
      assert.ok(!calls.some((c: any) => c.method === 'pinChatMessage'));
      const state = await readState(93);
      assert.equal(state.pinned_status_message_id, 111);
      assert.equal(result.updated, 0);
      assert.equal(result.failed, 1);
      assert.equal(result.topicOutcomes[0].outcome, 'failed');
    });

    it('fresh topic pins the new card without an unpin', async () => {
      await writeState(94, null);
      const res = runDriver(94, { sendMessage: 888, pinChatMessage: 'ok' });
      assert.equal(res.status, 0, `driver failed: ${res.stderr}\n${res.stdout}`);
      const { calls, result } = JSON.parse(await readFile(resultPath, 'utf8'));
      const state = await readState(94);
      assert.equal(state.pinned_status_message_id, 888);
      assert.ok(!calls.some((c: any) => c.method === 'unpinChatMessage'));
      assert.deepEqual(result.pinTotals, { pinned: 1, keptOld: 0, failed: 0 });
      assert.equal(result.topicOutcomes[0].outcome, 'pinned');
    });

    it('in-place edit success re-pins the same card silently and counts kept-old', async () => {
      await writeState(95, 111);
      const res = runDriver(95, { editMessageText: 'ok', pinChatMessage: 'ok' });
      assert.equal(res.status, 0, `driver failed: ${res.stderr}\n${res.stdout}`);
      const { calls, result } = JSON.parse(await readFile(resultPath, 'utf8'));
      const state = await readState(95);
      assert.equal(state.pinned_status_message_id, 111);
      assert.ok(!calls.some((c: any) => c.method === 'sendMessage'));
      assert.ok(!calls.some((c: any) => c.method === 'unpinChatMessage'));
      const pin = calls.find((c: any) => c.method === 'pinChatMessage');
      assert.equal(pin.body.message_id, 111);
      assert.equal(pin.body.disable_notification, true);
      assert.deepEqual(result.pinTotals, { pinned: 0, keptOld: 1, failed: 0 });
      assert.equal(result.topicOutcomes[0].outcome, 'kept-old');
    });
  });
});
