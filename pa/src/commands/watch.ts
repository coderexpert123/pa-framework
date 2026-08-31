import {
  addWatchJob,
  listWatchJobs,
  cancelWatchJob,
  MAX_ACTIVE_WATCHES,
} from '../lib/watch-jobs.js';
import type { WatchCheck, WatchInput, WatchJob } from '../lib/watch-jobs.js';
import { resolveNotifyTopic } from '../lib/notify.js';

/**
 * `pa watch add|list|rm` (AI-170, plans/2026-08-31-ai170-async-watch-SPEC.md §5).
 *
 * A thin CLI shell over `pa/src/lib/watch-jobs.ts` — all validation, the store,
 * and the tick engine live there. This file only parses argv, resolves the
 * report target (`--chat-id`/`--thread-id` or the default notify topic), and
 * renders output.
 *
 * Exit codes: 0 success · 2 usage/argument error (unknown flag, missing
 * subcommand, bad duration) · 3 rejected by the validator or the store
 * (invalid regex, cap reached, unknown id).
 */

const USAGE = `Usage:
  pa watch add --desc "<text>" --type <file_exists|file_gone|file_newer_than|file_contains|process_gone> [--path <p>] [--pattern <re>] [--pid <n>] [--since <iso>] [--deadline <dur>] [--interval <dur>] [--chat-id <id>] [--thread-id <n>]
  pa watch list [--json]
  pa watch rm <id>`;

const ADD_FLAGS = new Set([
  '--desc',
  '--type',
  '--path',
  '--pattern',
  '--pid',
  '--since',
  '--deadline',
  '--interval',
  '--chat-id',
  '--thread-id',
]);

const LIST_FLAGS = new Set(['--json']);

interface ParsedFlags {
  values: Record<string, string>;
  positionals: string[];
  unknown: string[];
}

function parseFlags(args: string[], known: Set<string>): ParsedFlags {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (!known.has(arg)) {
        unknown.push(arg);
        continue;
      }
      values[arg] = args[++i];
      continue;
    }
    positionals.push(arg);
  }

  return { values, positionals, unknown };
}

/** `/^(\d+)(s|m|h|d)$/` → milliseconds. Anything else (including a bare number) is `null`. */
function parseDuration(s: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unitMs = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  return n * unitMs;
}

/** Local equivalent of pa/src/commands/maintenance.ts's relativeTime — not exported from there
 *  (that file is not owned by this WP), and extended to handle a never-checked (null) row. */
function relativeTime(iso: string | null, nowMs: number = Date.now()): string {
  if (iso === null) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const diff = nowMs - t;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

function describeCheck(check: WatchCheck): string {
  switch (check.type) {
    case 'file_exists':
    case 'file_gone':
      return `path=${check.path}`;
    case 'file_newer_than':
      return `path=${check.path} since=${check.sinceIso}`;
    case 'file_contains':
      return `path=${check.path} pattern=${check.pattern}`;
    case 'process_gone':
      return `pid=${check.pid}`;
    default:
      return '(unknown check)';
  }
}

async function addSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, ADD_FLAGS);
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  let deadlineMs: number | undefined;
  if (parsed.values['--deadline'] !== undefined) {
    const d = parseDuration(parsed.values['--deadline']);
    if (d === null) {
      console.error('Error: --deadline must be a duration like 90s, 30m, 6h or 2d');
      return 2;
    }
    deadlineMs = d;
  }

  let intervalMs: number | undefined;
  if (parsed.values['--interval'] !== undefined) {
    const iv = parseDuration(parsed.values['--interval']);
    if (iv === null) {
      console.error('Error: --interval must be a duration like 90s, 30m, 6h or 2d');
      return 2;
    }
    intervalMs = iv;
  }

  let chatId = parsed.values['--chat-id'];
  if (chatId === undefined) {
    const t = await resolveNotifyTopic();
    chatId = t.chat_id;
  }
  if (!chatId) {
    console.error('Error: no chat id — pass --chat-id or set PA_ALERTS_CHAT_ID / TELEGRAM_CHAT_ID in ~/.pa/secrets.env');
    return 3;
  }
  const threadId = parsed.values['--thread-id'] !== undefined ? Number(parsed.values['--thread-id']) : 0;

  const pidRaw = parsed.values['--pid'];
  const input: WatchInput = {
    description: (parsed.values['--desc'] ?? '').trim(),
    check: {
      type: parsed.values['--type'] ?? '',
      path: parsed.values['--path'],
      pattern: parsed.values['--pattern'],
      sinceIso: parsed.values['--since'],
      pid: pidRaw !== undefined ? Number(pidRaw) : undefined,
    },
    intervalSeconds: intervalMs !== undefined ? intervalMs / 1000 : undefined,
    deadlineMinutes: deadlineMs !== undefined ? deadlineMs / 60_000 : undefined,
    source: { kind: 'cli', chatId, threadId, refId: null },
  };

  const reg = await addWatchJob(input);
  if (reg.ok) {
    console.log(`Watch ${reg.watch.id} registered — reports to chat ${chatId} thread ${threadId}, deadline ${reg.watch.deadlineAt}.`);
    return 0;
  }
  console.error(`Error: ${reg.error}`);
  return 3;
}

async function listSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, LIST_FLAGS);
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const all = await listWatchJobs();

  if (parsed.values['--json'] !== undefined || args.includes('--json')) {
    console.log(JSON.stringify(all, null, 2));
    return 0;
  }

  if (all.length === 0) {
    console.log('No watches registered.');
    return 0;
  }

  const active = all.filter((w: WatchJob) => w.status === 'active');
  console.log(`Active watches (${active.length}/${MAX_ACTIVE_WATCHES}):`);
  for (const w of active) {
    console.log(`${w.id}  [${w.check.type}]  ${w.description}`);
    console.log(`  check: ${describeCheck(w.check)}`);
    console.log(`  every ${w.intervalMs / 1000}s, deadline ${w.deadlineAt}`);
    console.log(`  last checked ${relativeTime(w.lastCheckedAt)} — ${w.lastObservation ?? 'never'}`);
    console.log(`  report to chat ${w.source.chatId} thread ${w.source.threadId}`);
  }

  const terminal = all
    .filter((w: WatchJob) => w.status !== 'active')
    .sort((a: WatchJob, b: WatchJob) => Date.parse(b.terminalAt ?? '') - Date.parse(a.terminalAt ?? ''))
    .slice(0, 10);
  if (terminal.length > 0) {
    console.log('Recent terminal (last 10):');
    for (const w of terminal) {
      console.log(`${w.id}  ${w.status}  ${w.terminalAt ?? 'unknown'}  ${w.description}`);
    }
  }

  return 0;
}

async function rmSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, new Set());
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const id = parsed.positionals[0];
  if (!id) {
    console.error(USAGE);
    return 2;
  }

  const result = await cancelWatchJob(id);
  if (result.ok) {
    console.log(`Cancelled watch ${id}.`);
    return 0;
  }
  console.error(`Error: ${result.error}`);
  return 3;
}

export async function watchCommand(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'add':
      return addSubcommand(args.slice(1));
    case 'list':
      return listSubcommand(args.slice(1));
    case 'rm':
      return rmSubcommand(args.slice(1));
    default:
      console.error(USAGE);
      return 2;
  }
}
