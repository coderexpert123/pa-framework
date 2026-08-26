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
  description: 'Full-text search across archived conversation turns, worker run traces, per-topic brains and the Ecosystem KB. Use before assuming something was never discussed.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      q: { type: 'string', description: 'Free-text query' },
      thread: { type: 'number', description: 'Restrict to one Telegram thread id' },
      source: { type: 'string', enum: ['conversation', 'trace', 'brain', 'kb', 'review'] },
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

export const tools = [pa_ref_lookup, pa_claims, pa_maintenance_status, pa_costs, pa_slo_report, pa_recall];
