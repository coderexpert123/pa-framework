import { readFile, unlink, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { paHome } from '../paths.js';

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

function dlqPath(): string {
  return join(paHome(), 'telegram-dlq.jsonl');
}

async function loadDlq(): Promise<DlqEntry[]> {
  try {
    const raw = await readFile(dlqPath(), 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DlqEntry);
  } catch {
    return [];
  }
}

async function writeDlq(entries: DlqEntry[]): Promise<void> {
  const path = dlqPath();
  const tmp = path + '.tmp';
  await writeFile(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  await rename(tmp, path);
}

function formatAge(timestamp: string): string {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const ageMins = Math.floor(ageMs / 60000);
  if (ageMins < 60) return `${ageMins}m`;
  const ageHours = Math.floor(ageMins / 60);
  if (ageHours < 24) return `${ageHours}h`;
  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays}d`;
}

function formatPreview(text: string, maxLength: number = 60): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export async function dlqListCommand(): Promise<void> {
  const entries = await loadDlq();

  if (entries.length === 0) {
    console.log('DLQ is empty.');
    return;
  }

  console.log('\nDLQ Entries:');
  console.log('─────────────────────────────────────────────────────────────────────────────');
  console.log('Idx   Age    Attempts  Quarantined  Preview');
  console.log('────  ─────  ────────  ──────────  ────────────────────────────────────────────');

  entries.forEach((entry, idx) => {
    const age = formatAge(entry.timestamp);
    const attempts = entry.attempts ?? 0;
    const quarantined = entry.quarantined ? 'Y' : 'N';
    const preview = formatPreview(entry.text);
    console.log(`${String(idx).padStart(4)}  ${padEnd(age, 5)}  ${String(attempts).padStart(7)}  ${quarantined.padStart(9)}  ${preview}`);
  });

  console.log('─────────────────────────────────────────────────────────────────────────────');
  console.log(`Total: ${entries.length} entry(ies)\n`);
}

export async function dlqReplayCommand(target: string): Promise<void> {
  const entries = await loadDlq();

  if (entries.length === 0) {
    console.log('DLQ is empty. Nothing to replay.');
    return;
  }

  const targetIndices: number[] = [];
  if (target === 'all') {
    targetIndices.push(...entries.map((_, idx) => idx));
  } else {
    const idx = parseInt(target, 10);
    if (isNaN(idx) || idx < 0 || idx >= entries.length) {
      console.error(`Invalid index: ${target}. Use 0-${entries.length - 1} or 'all'.`);
      const err: any = new Error(`Invalid index: ${target}`);
      err.code = 1;
      throw err;
    }
    targetIndices.push(idx);
  }

  let replayed = 0;
  const updated = entries.map((entry, idx) => {
    if (targetIndices.includes(idx) && entry.quarantined) {
      replayed++;
      return { ...entry, quarantined: false, attempts: 0 };
    }
    return entry;
  });

  await writeDlq(updated);

  if (replayed > 0) {
    console.log(`Replayed ${replayed} quarantined entrie(s). They will be retried on the next flush.`);
    console.log('WARNING: Replaying after the 24h TTL may cause duplicate deliveries if the original send eventually succeeded.');
  } else {
    console.log('No quarantined entries found at the specified index/indices.');
  }
}

export async function dlqDiscardCommand(target: string): Promise<void> {
  const entries = await loadDlq();

  if (entries.length === 0) {
    console.log('DLQ is empty. Nothing to discard.');
    return;
  }

  if (target === 'all') {
    const path = dlqPath();
    try {
      await unlink(path);
      console.log(`Discarded all ${entries.length} entrie(s) from DLQ.`);
    } catch (err: any) {
      console.error(`Failed to discard: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const idx = parseInt(target, 10);
  if (isNaN(idx) || idx < 0 || idx >= entries.length) {
    console.error(`Invalid index: ${target}. Use 0-${entries.length - 1} or 'all'.`);
    const err: any = new Error(`Invalid index: ${target}`);
    err.code = 1;
    throw err;
  }

  const filtered = entries.filter((_, i) => i !== idx);
  await writeDlq(filtered);

  console.log(`Discarded 1 entry from DLQ. Remaining: ${filtered.length}`);
}

function padEnd(str: string, length: number): string {
  return str.length < length ? str + ' '.repeat(length - str.length) : str.slice(0, length);
}

export async function dlqCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'list') {
    await dlqListCommand();
  } else if (sub === 'replay') {
    const target = args[1];
    if (!target) {
      console.error('Usage: pa dlq replay <index|all>');
      const err: any = new Error('Missing target argument for replay');
      err.code = 1;
      throw err;
    }
    await dlqReplayCommand(target);
  } else if (sub === 'discard') {
    const target = args[1];
    if (!target) {
      console.error('Usage: pa dlq discard <index|all>');
      const err: any = new Error('Missing target argument for discard');
      err.code = 1;
      throw err;
    }
    await dlqDiscardCommand(target);
  } else {
    console.error('Usage: pa dlq <list|replay|discard> [args]');
    const err: any = new Error('Unknown subcommand');
    err.code = 1;
    throw err;
  }
}
