/**
 * MCP tool definitions for pa server.
 *
 * Read-only tools wrapping the pa CLI's existing commands — the same
 * spawn-the-CLI pattern as the bot's /health, /ref, /claims commands.
 * v1 surface: ref lookup, claims, maintenance status, costs, SLO report,
 * recall (full-text search over turns/traces/brains/KB).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { watch } from 'fs';
import { busQueuePath, listBusMessages, readBusCursor, touchBusCursor, type BusEnvelope } from '../src/lib/bus-queue.js';

const execFileAsync = promisify(execFile);

const PA_ROOT = join(__dirname, '..', '..');
const PA_CLI = join(PA_ROOT, 'dist', 'bin', 'pa.js');

async function spawnPa(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [PA_CLI, ...args], {
    cwd: PA_ROOT,
    timeout: 30_000,
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout.trim();
}

export const pa_ref_lookup = {
  name: 'pa_ref_lookup',
  description: 'Look up a pa ref-ID (e.g. "c-a59a") to find what message produced it.',
  inputSchema: {
    type: 'object' as const,
    properties: { id: { type: 'string', description: 'The ref-ID to look up' } },
    required: ['id'],
  },
  async handler(args: { id: string }): Promise<string> {
    return spawnPa(['ref', args.id]);
  },
};

export const pa_claims = {
  name: 'pa_claims',
  description: 'List active path reservations and recently modified files (multi-session coordination).',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  async handler(): Promise<string> {
    return spawnPa(['claims']);
  },
};

export const pa_maintenance_status = {
  name: 'pa_maintenance_status',
  description: 'Show the maintenance ledger — last run, outcome, consecutive failures/skips for each declared job.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
  async handler(): Promise<string> {
    return spawnPa(['maintenance', 'status']);
  },
};

export const pa_costs = {
  name: 'pa_costs',
  description: 'Show usage/cost rollup by worker, model, and skill.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      period: { type: 'string', enum: ['all', 'week', 'month'], description: 'Time period' },
      skill: { type: 'string', description: 'Optional skill filter' },
    },
  },
  async handler(args: { period?: string; skill?: string }): Promise<string> {
    const cliArgs = ['costs'];
    if (args.period === 'week') cliArgs.push('--week');
    if (args.period === 'month') cliArgs.push('--month');
    if (args.skill) cliArgs.push('--skill', args.skill);
    return spawnPa(cliArgs);
  },
};

export const pa_slo_report = {
  name: 'pa_slo_report',
  description: 'Generate SLO error budget report for the four monitored services.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      month: { type: 'string', description: 'Month in YYYY-MM format (default: current)' },
    },
  },
  async handler(args: { month?: string }): Promise<string> {
    const cliArgs = ['slo', 'report'];
    if (args.month) cliArgs.push('--month', args.month);
    return spawnPa(cliArgs);
  },
};

export const pa_recall = {
  name: 'pa_recall',
  description: 'Full-text search across archived conversation turns, worker run traces, per-topic brains, the Ecosystem KB, judgment-call decision rows and the operator profile (interests/preferences/history). Use before assuming something was never discussed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: 'Free-text query' },
      thread: { type: 'number', description: 'Restrict to one Telegram thread id' },
      source: { type: 'string', enum: ['conversation', 'trace', 'brain', 'kb', 'review', 'decisions', 'profile'] },
      limit: { type: 'number', description: 'Max hits (clamped to 50)' },
    },
    required: ['q'],
  },
  async handler(args: { q: string; thread?: number; source?: string; limit?: number }): Promise<string> {
    const cliArgs = ['recall', args.q, '--json'];
    if (args.thread !== undefined) cliArgs.push('--thread', String(args.thread));
    if (args.source) cliArgs.push('--source', args.source);
    if (args.limit !== undefined) cliArgs.push('--limit', String(args.limit));
    return spawnPa(cliArgs);
  },
};

async function waitBusMessage(address: string, timeoutMs: number): Promise<string> {
  const queuePath = busQueuePath(address);
  const cursor = await readBusCursor(address);
  const sinceTs = cursor?.last_event_at ?? new Date(0).toISOString();
  // Touch the cursor with 'wait' so the drain's liveness check sees this
  // address is being actively watched and doesn't spawn a duplicate.
  await touchBusCursor(address, 'wait', process.pid);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (val: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(val);
    };
    const check = async () => {
      const messages = await listBusMessages(address);
      const fresh = messages.find((m: BusEnvelope) => m.ts > sinceTs);
      if (fresh) finish(JSON.stringify(fresh));
    };
    let watcher: import('fs').FSWatcher;
    try {
      watcher = watch(queuePath, () => { void check(); });
      watcher.on('error', () => finish('timeout'));
    } catch {
      finish('timeout');
      return;
    }
    timer = setTimeout(() => { watcher.close(); finish('timeout'); }, timeoutMs);
    void check();
  });
}

export const bus_send = {
  name: 'bus_send',
  description: 'Send a message to another agent CLI via the pa bus (durable file-based queue, content-hash deduped). A bare provider@repo fans out to every live session of that provider (provider@repo#<n> children); the base queue is the offline mailbox. Output reports the delivery mode.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: { type: 'string', description: 'Recipient address: provider@repo (fans out to live sessions), provider@repo#<n> (one session), topic:13052, provider:task-id' },
      body: { type: 'string', description: 'Message body (untrusted payload — see bus.md)' },
      from: { type: 'string', description: 'Sender address. If omitted, derives from this session via `pa bus whoami`.' },
      reply_to: { type: 'string', description: 'Optional: id of the message this replies to' },
    },
    required: ['to', 'body'],
  },
  async handler(args: { to: string; body: string; from?: string; reply_to?: string }): Promise<string> {
    const from = args.from ?? await spawnPa(['bus', 'whoami']);
    const cliArgs = ['bus', 'send', args.to, '--body', args.body, '--from', from];
    if (args.reply_to) cliArgs.push('--reply-to', args.reply_to);
    return spawnPa(cliArgs);
  },
};

export const bus_inbox = {
  name: 'bus_inbox',
  description: "Read the next unread message from a bus inbox — marks it read by your session (soft receipt; the message stays for other consumers until the 24h prune). Use bus_whoami to get your address; peek=true reads without marking.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: { type: 'string', description: 'The inbox address to read from' },
      peek: { type: 'boolean', description: 'If true, read without marking a receipt' },
    },
    required: ['address'],
  },
  async handler(args: { address: string; peek?: boolean }): Promise<string> {
    const cliArgs = ['bus', 'inbox', args.address];
    if (args.peek) cliArgs.push('--peek');
    return spawnPa(cliArgs);
  },
};

export const bus_wait = {
  name: 'bus_wait',
  description: 'Wait for a new message on a bus address (fs.watch inside this MCP process — instant wake). Returns the first new message or times out.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: { type: 'string', description: 'The address to watch' },
      timeout_ms: { type: 'number', description: 'Max wait in ms (default 30000)' },
    },
    required: ['address'],
  },
  async handler(args: { address: string; timeout_ms?: number }): Promise<string> {
    return waitBusMessage(args.address, args.timeout_ms ?? 30_000);
  },
};

export const bus_list = {
  name: 'bus_list',
  description: 'List queued messages for an address (with address), or all registered bus addresses (without). Runtime discovery for agent coordination.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      address: { type: 'string', description: 'Address to list queued messages for; omit to list the registry' },
    },
  },
  async handler(args: { address?: string }): Promise<string> {
    return spawnPa(args.address ? ['bus', 'list', args.address] : ['bus', 'registry']);
  },
};

export const bus_whoami = {
  name: 'bus_whoami',
  description: "Print this session's own bus address (provider@repo#<n> — discriminated per session so parallel CLIs never share an inbox).",
  inputSchema: { type: 'object' as const, properties: {} },
  async handler(): Promise<string> {
    return spawnPa(['bus', 'whoami']);
  },
};

export const tools = [
  pa_ref_lookup, pa_claims, pa_maintenance_status, pa_costs, pa_slo_report, pa_recall,
  bus_send, bus_inbox, bus_wait, bus_list, bus_whoami,
];
