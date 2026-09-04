import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { watchCommand } from '../src/commands/watch.js';
import { listWatchJobs } from '../src/lib/watch-jobs.js';

// Portable absolute path for validation-only fixture args: `C:/...` is only
// absolute on win32 (path.isAbsolute('C:/x') is false on ubuntu/macos, which
// made every "should validate" case fail with "check.path must be absolute"
// on the public CI's non-Windows legs). The file need not exist for these
// cases — only validateWatchInput's isAbsolute() check runs.
const absPath = (name: string) => join(tmpdir(), 'ai170-fixtures', name);

let tempDir: string;
let consoleLogOutput: string[];
let consoleErrorOutput: string[];
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;

function joinedLog(): string {
  return consoleLogOutput.join('\n');
}

function joinedError(): string {
  return consoleErrorOutput.join('\n');
}

beforeEach(async () => {
  tempDir = await createTempPaHome();
  consoleLogOutput = [];
  consoleErrorOutput = [];
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  console.log = (...args: any[]) => {
    consoleLogOutput.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.error = (...args: any[]) => {
    consoleErrorOutput.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
});

afterEach(async () => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  await cleanup(tempDir);
});

describe('watchCommand', () => {
  describe('add', () => {
    it('happy path with --chat-id registers an active watch', async () => {
      const code = await watchCommand([
        'add', '--desc', 'download finishes', '--type', 'file_exists',
        '--path', absPath('thing.zip'), '--chat-id', '12345',
      ]);
      assert.equal(code, 0);
      assert.match(joinedLog(), /Watch w-[0-9a-f]{8} registered — reports to chat 12345 thread 0, deadline /);

      const all = await listWatchJobs();
      assert.equal(all.length, 1);
      assert.equal(all[0].status, 'active');
      assert.match(all[0].id, /^w-[0-9a-f]{8}$/);
    });

    it('invalid regex is rejected with the frozen validator string, exit 3', async () => {
      const code = await watchCommand([
        'add', '--desc', 'log line appears', '--type', 'file_contains',
        '--path', absPath('x.log'), '--pattern', '(', '--chat-id', '12345',
      ]);
      assert.equal(code, 3);
      assert.match(joinedError(), /Error: check\.pattern is not a valid regular expression: /);
      assert.equal((await listWatchJobs()).length, 0);
    });

    it('unknown flag prints the usage block and exits 2', async () => {
      const code = await watchCommand([
        'add', '--desc', 'x', '--type', 'file_exists', '--path', absPath('x.txt'),
        '--chat-id', '12345', '--bogus', 'y',
      ]);
      assert.equal(code, 2);
      assert.match(joinedError(), /Usage:/);
      assert.match(joinedError(), /--bogus/);
    });

    it('--deadline with no unit exits 2', async () => {
      const code = await watchCommand([
        'add', '--desc', 'x', '--type', 'file_exists', '--path', absPath('x.txt'),
        '--chat-id', '12345', '--deadline', '90',
      ]);
      assert.equal(code, 2);
      assert.match(joinedError(), /--deadline must be a duration like 90s, 30m, 6h or 2d/);
    });

    it('parses seconds and minutes for --interval', async () => {
      const codeS = await watchCommand([
        'add', '--desc', 'a', '--type', 'file_exists', '--path', absPath('a.txt'),
        '--chat-id', '1', '--interval', '90s',
      ]);
      assert.equal(codeS, 0);
      const codeM = await watchCommand([
        'add', '--desc', 'b', '--type', 'file_exists', '--path', absPath('b.txt'),
        '--chat-id', '1', '--interval', '45m',
      ]);
      assert.equal(codeM, 0);

      const all = await listWatchJobs();
      const a = all.find((w) => w.description === 'a')!;
      const b = all.find((w) => w.description === 'b')!;
      assert.equal(a.intervalMs, 90_000);
      assert.equal(b.intervalMs, 45 * 60_000);
    });

    it('parses hours and days for --deadline', async () => {
      const before = Date.now();
      const codeH = await watchCommand([
        'add', '--desc', 'c', '--type', 'file_exists', '--path', absPath('c.txt'),
        '--chat-id', '1', '--deadline', '6h',
      ]);
      assert.equal(codeH, 0);
      const codeD = await watchCommand([
        'add', '--desc', 'd', '--type', 'file_exists', '--path', absPath('d.txt'),
        '--chat-id', '1', '--deadline', '2d',
      ]);
      assert.equal(codeD, 0);
      const after = Date.now();

      const all = await listWatchJobs();
      const c = all.find((w) => w.description === 'c')!;
      const d = all.find((w) => w.description === 'd')!;
      const cDeadline = Date.parse(c.deadlineAt);
      const dDeadline = Date.parse(d.deadlineAt);
      assert.ok(cDeadline >= before + 6 * 3_600_000 && cDeadline <= after + 6 * 3_600_000);
      assert.ok(dDeadline >= before + 2 * 86_400_000 && dDeadline <= after + 2 * 86_400_000);
    });

    it('no chat id resolvable exits 3 with the frozen error', async () => {
      // No --chat-id and no secrets.env in this temp PA_HOME, so
      // resolveNotifyTopic() resolves to an empty chat id. Clear any
      // host-environment vars that could otherwise supply one, for
      // deterministic behaviour regardless of the machine this runs on.
      const savedChat = process.env.PA_ALERTS_CHAT_ID;
      const savedTelegram = process.env.TELEGRAM_CHAT_ID;
      delete process.env.PA_ALERTS_CHAT_ID;
      delete process.env.TELEGRAM_CHAT_ID;
      try {
        const code = await watchCommand([
          'add', '--desc', 'x', '--type', 'file_exists', '--path', absPath('x.txt'),
        ]);
        assert.equal(code, 3);
        assert.match(joinedError(), /Error: no chat id — pass --chat-id or set PA_ALERTS_CHAT_ID \/ TELEGRAM_CHAT_ID in ~\/\.pa\/secrets\.env/);
      } finally {
        if (savedChat !== undefined) process.env.PA_ALERTS_CHAT_ID = savedChat;
        if (savedTelegram !== undefined) process.env.TELEGRAM_CHAT_ID = savedTelegram;
      }
    });
  });

  describe('list', () => {
    it('empty store prints "No watches registered."', async () => {
      const code = await watchCommand(['list']);
      assert.equal(code, 0);
      assert.equal(joinedLog().trim(), 'No watches registered.');
    });

    it('renders both the active and terminal sections', async () => {
      await watchCommand([
        'add', '--desc', 'still going', '--type', 'file_exists',
        '--path', absPath('still.txt'), '--chat-id', '1',
      ]);
      const addCode = await watchCommand([
        'add', '--desc', 'to be cancelled', '--type', 'file_exists',
        '--path', absPath('gone.txt'), '--chat-id', '1',
      ]);
      assert.equal(addCode, 0);
      const all = await listWatchJobs();
      const toCancel = all.find((w) => w.description === 'to be cancelled')!;
      const rmCode = await watchCommand(['rm', toCancel.id]);
      assert.equal(rmCode, 0);

      consoleLogOutput = [];
      const code = await watchCommand(['list']);
      assert.equal(code, 0);
      const out = joinedLog();
      assert.match(out, /Active watches \(1\/25\):/);
      assert.match(out, /still going/);
      assert.match(out, /Recent terminal \(last 10\):/);
      assert.match(out, new RegExp(`${toCancel.id}  cancelled`));
    });

    it('--json prints parseable JSON matching the store', async () => {
      await watchCommand([
        'add', '--desc', 'json check', '--type', 'file_exists',
        '--path', absPath('j.txt'), '--chat-id', '1',
      ]);
      consoleLogOutput = [];
      const code = await watchCommand(['list', '--json']);
      assert.equal(code, 0);
      const parsed = JSON.parse(joinedLog());
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].description, 'json check');
    });
  });

  describe('rm', () => {
    it('cancels a real id, exit 0', async () => {
      await watchCommand([
        'add', '--desc', 'cancel me', '--type', 'file_exists',
        '--path', absPath('rm-c.txt'), '--chat-id', '1',
      ]);
      const all = await listWatchJobs();
      const id = all[0].id;

      consoleLogOutput = [];
      const code = await watchCommand(['rm', id]);
      assert.equal(code, 0);
      assert.equal(joinedLog().trim(), `Cancelled watch ${id}.`);

      const after = await listWatchJobs();
      assert.equal(after.find((w) => w.id === id)!.status, 'cancelled');
    });

    it('unknown id exits 3 with the frozen error', async () => {
      const code = await watchCommand(['rm', 'w-deadbeef']);
      assert.equal(code, 3);
      assert.match(joinedError(), /Error: no watch with id w-deadbeef/);
    });
  });

  // WP-D2 B.7 (2026-09-02, the topic-handover WAVE2 spec §3.4 item 7a):
  // `pa watch re-register <id>` copies a TERMINAL row's spec into a fresh active watch
  // via the existing add path; unknown/active/cancelled ids are refused (exit 3 — the
  // documented store-rejection code, per this file's header convention).
  describe('re-register', () => {
    async function addAndTerminal(description: string, status: 'reported' | 'expired' | 'cancelled' | 'check-failed') {
      await watchCommand([
        'add', '--desc', description, '--type', 'file_exists',
        '--path', absPath(`${description.replace(/\s+/g, '-')}.txt`), '--chat-id', '1',
      ]);
      const all = await listWatchJobs();
      const row = all.find((w) => w.description === description)!;
      // Force a terminal status directly in the store file — re-register's contract
      // is about TERMINAL rows, however they got there.
      const { readFile, writeFile } = await import('fs/promises');
      const storePath = join(tempDir, 'watch-jobs.json');
      const store = JSON.parse(await readFile(storePath, 'utf8'));
      const record = store.watches.find((w: { id: string }) => w.id === row.id);
      record.status = status;
      record.terminalAt = new Date().toISOString();
      record.outcome = 'test-seeded terminal';
      await writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');
      return row;
    }

    it('copies a terminal row into a fresh active watch, exit 0', async () => {
      const original = await addAndTerminal('re-register me', 'expired');

      consoleLogOutput = [];
      const code = await watchCommand(['re-register', original.id]);
      assert.equal(code, 0);
      assert.match(joinedLog(), new RegExp(`Watch w-[0-9a-f]{8} re-registered from ${original.id}`));

      const all = await listWatchJobs();
      assert.equal(all.length, 2, 'the terminal original stays for audit');
      const fresh = all.find((w) => w.id !== original.id && w.status === 'active')!;
      assert.ok(fresh, 'a new ACTIVE row exists');
      assert.equal(fresh.description, original.description);
      assert.deepEqual(fresh.check, original.check);
      assert.equal(fresh.intervalMs, original.intervalMs);
      assert.equal(fresh.source.chatId, original.source.chatId);
      assert.equal(fresh.source.threadId, original.source.threadId);
      // deadline span reproduced from the original createdAt→deadlineAt window
      const originalSpanMs = Date.parse(original.deadlineAt) - Date.parse(original.createdAt);
      const freshSpanMs = Date.parse(fresh.deadlineAt) - Date.parse(fresh.createdAt);
      assert.ok(Math.abs(freshSpanMs - originalSpanMs) < 5_000, `deadline span copied (${freshSpanMs} vs ${originalSpanMs})`);
      assert.notEqual(fresh.id, original.id);
    });

    it('unknown id exits 3 with a clear line', async () => {
      const code = await watchCommand(['re-register', 'w-deadbeef']);
      assert.equal(code, 3);
      assert.match(joinedError(), /Error: unknown watch id w-deadbeef/);
    });

    it('still-active id exits 3 — nothing to re-register', async () => {
      await watchCommand([
        'add', '--desc', 'still active', '--type', 'file_exists',
        '--path', absPath('still-active.txt'), '--chat-id', '1',
      ]);
      const all = await listWatchJobs();
      const code = await watchCommand(['re-register', all[0].id]);
      assert.equal(code, 3);
      assert.match(joinedError(), /still active/);
    });

    it('cancelled id exits 3 — cancelling was an explicit kill', async () => {
      const original = await addAndTerminal('explicitly cancelled', 'cancelled');
      const code = await watchCommand(['re-register', original.id]);
      assert.equal(code, 3);
      assert.match(joinedError(), /was cancelled/);
    });

    it('missing id argument exits 2 with the usage block', async () => {
      const code = await watchCommand(['re-register']);
      assert.equal(code, 2);
      assert.match(joinedError(), /Usage:/);
    });
  });

  it('no subcommand exits 2 with the usage block', async () => {
    const code = await watchCommand([]);
    assert.equal(code, 2);
    assert.match(joinedError(), /Usage:/);
  });
});
