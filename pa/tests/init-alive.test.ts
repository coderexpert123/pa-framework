import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { initCommand } from '../src/commands/init.js';

describe('pa init alive message', () => {
  let tempHome: string;
  let originalPaHome: string | undefined;
  let notifySpy: ReturnType<typeof mock.fn>;

  beforeEach(() => {
    tempHome = mkdtempSync('pa-test-');
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempHome;
    notifySpy = mock.fn();
  });

  afterEach(() => {
    process.env.PA_HOME = originalPaHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  test('case A: fresh init (scaffold) - spy NOT called, console says skip', async () => {
    // Fresh init - no secrets.env yet
    const consoleLogSpy = mock.method(console, 'log', () => {});
    await initCommand({ notify: notifySpy as any });

    assert.strictEqual(notifySpy.mock.calls.length, 0, 'notify should not be called without secrets');

    // Find the skip message in console output
    const skipMsg = consoleLogSpy.mock.calls.find((call: any) =>
      call.arguments && call.arguments.length > 0 && String(call.arguments[0]).includes('[skip] Alive message not sent')
    );
    assert.ok(skipMsg, 'should log skip message');
    consoleLogSpy.mock.restore();
  });

  test('case B: secrets with token + chat id - spy called ONCE with correct params', async () => {
    // Create secrets.env with both token and chat id
    const secretsPath = join(tempHome, 'secrets.env');
    writeFileSync(secretsPath, 'TELEGRAM_BOT_TOKEN=fake_token\nTELEGRAM_CHAT_ID=12345,-100999\n');

    await initCommand({ notify: notifySpy as any });

    assert.strictEqual(notifySpy.mock.calls.length, 1, 'notify should be called once');

    const call = notifySpy.mock.calls[0];
    const args = call.arguments as any[];
    assert.strictEqual(args[0], 'Your assistant is alive', 'subject should match');
    assert.ok(args[1].includes('pa initialized at'), 'body should mention initialization');
    assert.ok(args[1].includes('run `pa health`'), 'body should suggest next steps');

    const opts = args[2];
    assert.strictEqual(opts.dedupKey, 'init-alive', 'dedupKey should be init-alive');
    assert.strictEqual(opts.escalate, false, 'escalate should be false');
    assert.strictEqual(opts.severity, 'info', 'severity should be info');
    assert.strictEqual(opts.topic.chat_id, '12345', 'chat_id should be first entry (string)');
    assert.strictEqual(opts.topic.thread_id, 0, 'thread_id should be 0');
  });

  test('case C: only token set (no chat id) - spy NOT called', async () => {
    const secretsPath = join(tempHome, 'secrets.env');
    writeFileSync(secretsPath, 'TELEGRAM_BOT_TOKEN=fake_token\n');

    const consoleLogSpy = mock.method(console, 'log', () => {});
    await initCommand({ notify: notifySpy as any });

    assert.strictEqual(notifySpy.mock.calls.length, 0, 'notify should not be called without chat id');

    const skipMsg = consoleLogSpy.mock.calls.find((call: any) =>
      call.arguments && call.arguments.length > 0 && String(call.arguments[0]).includes('[skip] Alive message not sent')
    );
    assert.ok(skipMsg, 'should log skip message');
    consoleLogSpy.mock.restore();
  });

  test('case D: spy rejects - init still completes, no unhandled rejection', async () => {
    const secretsPath = join(tempHome, 'secrets.env');
    writeFileSync(secretsPath, 'TELEGRAM_BOT_TOKEN=fake_token\nTELEGRAM_CHAT_ID=12345\n');

    notifySpy.mock.mockImplementationOnce(() => Promise.reject(new Error('Network error')));

    const consoleLogSpy = mock.method(console, 'log', () => {});

    // Should not throw
    await initCommand({ notify: notifySpy as any });

    // Verify failure was logged
    const failMsg = consoleLogSpy.mock.calls.find((call: any) =>
      call.arguments && call.arguments.length > 0 && String(call.arguments[0]).includes('[skip] Alive message failed')
    );
    assert.ok(failMsg, 'should log failure message');
    consoleLogSpy.mock.restore();
  });
});
