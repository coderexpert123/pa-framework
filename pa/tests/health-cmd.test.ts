import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { before, describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

describe('healthCommand', () => {
  let tempHome: string;
  let originalPaHome: string | undefined;

  before(async () => {
    // Create a temp PA_HOME directory
    tempHome = join(tmpdir(), `pa-health-test-${Date.now()}`);
    await mkdir(tempHome, { recursive: true });

    // Set up minimal secrets to avoid FAIL results
    await writeFile(join(tempHome, 'secrets.env'), 'TELEGRAM_BOT_TOKEN=test\nTELEGRAM_CHAT_ID=123\n');

    // Create lock file to avoid bot-process FAIL
    await writeFile(join(tempHome, 'telegram-bot.lock'), '99999\n');

    // Store original PA_HOME
    originalPaHome = process.env.PA_HOME;

    // Set PA_HOME to temp directory
    process.env.PA_HOME = tempHome;
  });

  after(async () => {
    // Restore original PA_HOME
    if (originalPaHome !== undefined) {
      process.env.PA_HOME = originalPaHome;
    } else {
      delete process.env.PA_HOME;
    }

    // Clean up temp directory (optional, tmpdir handles this)
  });

  it('default run emits ANSI color codes', async () => {
    // Import after build to avoid circular dependency
    const { healthCommand } = await import('../src/commands/health.js');

    // Pin the env this assertion depends on — other test files may run with
    // NO_COLOR set and leak it into shared-process captures.
    const prevNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      await healthCommand();
    } finally {
      console.log = originalLog;
      if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
    }

    // Should contain color codes
    const output = logs.join('\n');
    assert.match(output, /\x1b\[/, 'default output should contain ANSI color codes');
    assert.match(output, /PA Health Check/, 'should contain PA Health Check header');
    assert.match(output, /\[OK\]/, 'should contain [OK] or [FAIL] label');
  });

  it('--no-color emits zero ANSI codes', async () => {
    const { healthCommand } = await import('../src/commands/health.js');

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    await healthCommand(['--no-color']);

    console.log = originalLog;

    const output = logs.join('\n');
    assert.equal(output.includes('\x1b'), false, '--no-color output should contain zero ANSI codes');
  });

  it('NO_COLOR env emits zero ANSI codes (env restored after)', async () => {
    const { healthCommand } = await import('../src/commands/health.js');

    const originalNoColor = process.env.NO_COLOR;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    try {
      process.env.NO_COLOR = '1';
      await healthCommand();

      console.log = originalLog;

      const output = logs.join('\n');
      assert.equal(output.includes('\x1b'), false, 'NO_COLOR=1 output should contain zero ANSI codes');
    } finally {
      // Restore env
      if (originalNoColor !== undefined) {
        process.env.NO_COLOR = originalNoColor;
      } else {
        delete process.env.NO_COLOR;
      }
    }
  });

  it('--no-color keeps aligned labels', async () => {
    const { healthCommand } = await import('../src/commands/health.js');

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };

    await healthCommand(['--no-color']);

    console.log = originalLog;

    const output = logs.join('\n');
    // Should have [WARN] with padding (space after the closing bracket)
    assert.match(output, /\[WARN\] /, '--no-color output should keep aligned labels with padding');
  });
});
