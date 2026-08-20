import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { dlqListCommand, dlqReplayCommand, dlqDiscardCommand, dlqCommand } from '../src/commands/dlq.js';
import { paHome } from '../src/paths.js';

interface DlqEntry {
  chatId: number;
  threadId: number;
  replyToMessageId?: number;
  text: string;
  timestamp: string;
  updateId: number;
  refId?: string;
  attempts?: number;
  quarantined?: boolean;
}

function makeEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
  return {
    chatId: 123,
    threadId: 0,
    replyToMessageId: undefined,
    text: 'hello',
    timestamp: new Date().toISOString(),
    updateId: 1,
    ...overrides,
  };
}

async function writeTestDlq(entries: DlqEntry[]): Promise<void> {
  const dlqPath = join(paHome(), 'telegram-dlq.jsonl');
  await writeFile(dlqPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

let tempDir: string;
let originalPaHome: string | undefined;
let originalConsoleLog: typeof console.log;
let consoleOutput: string[];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'dlq-cmd-test-'));
  process.env.PA_HOME = tempDir;
  originalPaHome = process.env.PA_HOME;

  // Capture console.log output
  consoleOutput = [];
  originalConsoleLog = console.log;
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  };
});

afterEach(async () => {
  console.log = originalConsoleLog;
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) {
    delete process.env.PA_HOME;
  } else {
    process.env.PA_HOME = originalPaHome;
  }
});

// ---------------------------------------------------------------------------
// dlq list
// ---------------------------------------------------------------------------

describe('dlq list', () => {
  it('prints message when DLQ is empty', async () => {
    await dlqListCommand();
    assert.ok(consoleOutput.some((line) => line.includes('DLQ is empty')));
  });

  it('lists entries with age, attempts, quarantined, and preview', async () => {
    const entries = [
      makeEntry({ text: 'normal message', updateId: 1, attempts: 0, quarantined: false }),
      makeEntry({ text: 'failing message', updateId: 2, attempts: 3, quarantined: false }),
      makeEntry({ text: 'quarantined message', updateId: 3, attempts: 5, quarantined: true }),
    ];
    await writeTestDlq(entries);

    await dlqListCommand();

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('Idx'));
    assert.ok(output.includes('Age'));
    assert.ok(output.includes('Attempts'));
    assert.ok(output.includes('Quarantined'));
    assert.ok(output.includes('Preview'));
    assert.ok(output.includes('normal message'));
    assert.ok(output.includes('quarantined message'));
  });

  it('shows N for non-quarantined, Y for quarantined', async () => {
    const entries = [
      makeEntry({ text: 'normal', updateId: 1, attempts: 0, quarantined: false }),
      makeEntry({ text: 'quarantined', updateId: 2, attempts: 5, quarantined: true }),
    ];
    await writeTestDlq(entries);

    await dlqListCommand();

    const output = consoleOutput.join('\n');
    // Find the lines with the entries (skip header)
    const lines = output.split('\n');
    const normalLine = lines.find((l) => l.includes('normal'));
    const quarantinedLine = lines.find((l) => l.includes('quarantined'));

    assert.ok(normalLine?.includes('N'), 'normal entry should show N');
    assert.ok(quarantinedLine?.includes('Y'), 'quarantined entry should show Y');
  });

  it('truncates long previews to 60 chars', async () => {
    const longText = 'a'.repeat(100);
    const entries = [makeEntry({ text: longText, updateId: 1 })];
    await writeTestDlq(entries);

    await dlqListCommand();

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('aaa...'), 'long text should be truncated with ...');
    assert.ok(!output.includes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  });
});

// ---------------------------------------------------------------------------
// dlq replay
// ---------------------------------------------------------------------------

describe('dlq replay', () => {
  it('replays a specific quarantined entry by index', async () => {
    const entries = [
      makeEntry({ text: 'normal', updateId: 1, attempts: 0, quarantined: false }),
      makeEntry({ text: 'quarantined', updateId: 2, attempts: 5, quarantined: true }),
    ];
    await writeTestDlq(entries);

    await dlqReplayCommand('1');

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('Replayed 1 quarantined entrie(s)'));

    // Verify the file was updated
    const dlqPath = join(paHome(), 'telegram-dlq.jsonl');
    const raw = await readFile(dlqPath, 'utf8');
    const parsed = raw.trim().split('\n').map((line) => JSON.parse(line) as DlqEntry);
    assert.equal(parsed[1].quarantined, false);
    assert.equal(parsed[1].attempts, 0);
  });

  it('replays all quarantined entries with "all" keyword', async () => {
    const entries = [
      makeEntry({ text: 'q1', updateId: 1, attempts: 5, quarantined: true }),
      makeEntry({ text: 'q2', updateId: 2, attempts: 5, quarantined: true }),
      makeEntry({ text: 'normal', updateId: 3, attempts: 0, quarantined: false }),
    ];
    await writeTestDlq(entries);

    await dlqReplayCommand('all');

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('Replayed 2 quarantined entrie(s)'));

    // Verify all quarantined entries were updated
    const dlqPath = join(paHome(), 'telegram-dlq.jsonl');
    const raw = await readFile(dlqPath, 'utf8');
    const parsed = raw.trim().split('\n').map((line) => JSON.parse(line) as DlqEntry);
    assert.equal(parsed[0].quarantined, false);
    assert.equal(parsed[0].attempts, 0);
    assert.equal(parsed[1].quarantined, false);
    assert.equal(parsed[1].attempts, 0);
    assert.equal(parsed[2].quarantined, false); // normal stays normal
  });

  it('warns about duplicate delivery risk', async () => {
    const entries = [makeEntry({ text: 'quarantined', updateId: 1, attempts: 5, quarantined: true })];
    await writeTestDlq(entries);

    await dlqReplayCommand('0');

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('WARNING'), 'should warn about duplicate risk');
    assert.ok(output.includes('duplicate deliveries'), 'should mention duplicate deliveries');
  });

  it('reports when no quarantined entries found at index', async () => {
    const entries = [makeEntry({ text: 'normal', updateId: 1, attempts: 0, quarantined: false })];
    await writeTestDlq(entries);

    await dlqReplayCommand('0');

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('No quarantined entries found'));
  });

  it('rejects invalid index', async () => {
    const entries = [makeEntry({ text: 'test', updateId: 1 })];
    await writeTestDlq(entries);

    let threw = false;
    try {
      await dlqReplayCommand('999');
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, 1); // process.exitCode = 1
    }
    assert.ok(threw, 'should throw for invalid index');
  });

  it('handles empty DLQ gracefully', async () => {
    await dlqReplayCommand('0');
    assert.ok(consoleOutput.some((line) => line.includes('DLQ is empty')));
  });
});

// ---------------------------------------------------------------------------
// dlq discard
// ---------------------------------------------------------------------------

describe('dlq discard', () => {
  it('discards a specific entry by index', async () => {
    const entries = [
      makeEntry({ text: 'keep', updateId: 1 }),
      makeEntry({ text: 'discard', updateId: 2 }),
      makeEntry({ text: 'keep too', updateId: 3 }),
    ];
    await writeTestDlq(entries);

    await dlqDiscardCommand('1');

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('Discarded 1 entry from DLQ'));
    assert.ok(output.includes('Remaining: 2'));

    // Verify the entry was removed
    const dlqPath = join(paHome(), 'telegram-dlq.jsonl');
    const raw = await readFile(dlqPath, 'utf8');
    const parsed = raw.trim().split('\n').map((line) => JSON.parse(line) as DlqEntry);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].text, 'keep');
    assert.equal(parsed[1].text, 'keep too');
  });

  it('discards all entries with "all" keyword', async () => {
    const entries = [
      makeEntry({ text: 'a', updateId: 1 }),
      makeEntry({ text: 'b', updateId: 2 }),
    ];
    await writeTestDlq(entries);

    await dlqDiscardCommand('all');

    const output = consoleOutput.join('\n');
    assert.ok(output.includes('Discarded all 2 entrie(s)'));

    // Verify the file was deleted
    const dlqPath = join(paHome(), 'telegram-dlq.jsonl');
    const exists = await readFile(dlqPath, 'utf8').then(() => true, () => false);
    assert.equal(exists, false, 'DLQ file should be deleted after discarding all');
  });

  it('rejects invalid index', async () => {
    const entries = [makeEntry({ text: 'test', updateId: 1 })];
    await writeTestDlq(entries);

    let threw = false;
    try {
      await dlqDiscardCommand('999');
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, 1); // process.exitCode = 1
    }
    assert.ok(threw, 'should throw for invalid index');
  });

  it('handles empty DLQ gracefully', async () => {
    await dlqDiscardCommand('0');
    assert.ok(consoleOutput.some((line) => line.includes('DLQ is empty')));
  });
});

// ---------------------------------------------------------------------------
// dlq command router
// ---------------------------------------------------------------------------

describe('dlq command', () => {
  it('routes to list subcommand', async () => {
    const entries = [makeEntry({ text: 'test', updateId: 1 })];
    await writeTestDlq(entries);

    await dlqCommand(['list']);
    assert.ok(consoleOutput.some((line) => line.includes('DLQ Entries')));
  });

  it('routes to replay subcommand', async () => {
    const entries = [makeEntry({ text: 'q', updateId: 1, attempts: 5, quarantined: true })];
    await writeTestDlq(entries);

    await dlqCommand(['replay', '0']);
    assert.ok(consoleOutput.some((line) => line.includes('Replayed')));
  });

  it('routes to discard subcommand', async () => {
    const entries = [makeEntry({ text: 'test', updateId: 1 })];
    await writeTestDlq(entries);

    await dlqCommand(['discard', '0']);
    assert.ok(consoleOutput.some((line) => line.includes('Discarded')));
  });

  it('errors on missing replay argument', async () => {
    let threw = false;
    try {
      await dlqCommand(['replay']);
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, 1);
    }
    assert.ok(threw);
  });

  it('errors on missing discard argument', async () => {
    let threw = false;
    try {
      await dlqCommand(['discard']);
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, 1);
    }
    assert.ok(threw);
  });

  it('errors on unknown subcommand', async () => {
    let threw = false;
    try {
      await dlqCommand(['unknown']);
    } catch (err: any) {
      threw = true;
      assert.equal(err.code, 1);
    }
    assert.ok(threw);
  });
});
