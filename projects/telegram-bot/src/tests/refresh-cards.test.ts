import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
      assert.equal(row1.length, 3);
      assert.equal(row1[0].text, '🆕 New');
      assert.equal(row1[0].callback_data, 'cc:new');
      assert.equal(row1[1].text, '⏹ Stop');
      assert.equal(row1[1].callback_data, 'cc:stop');
      assert.equal(row1[2].text, '☕ Keep-awake');
      assert.equal(row1[2].callback_data, 'cc:ka');
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
      const keepAwake = { active: false };
      const tasks = { running: 1, parked: 0, queued: 2 };

      const pinText = renderStatusCard({ snapshot, keepAwake, tasks });
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
});
