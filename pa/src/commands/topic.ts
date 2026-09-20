import {
  appendTask,
  listTasks,
  listRunningTasks,
  TOPIC_TASK_MAX_ATTEMPTS,
  addNote,
  listNotes,
  closeNote,
  noteDisplayText,
  TOPIC_NOTE_KEY_RE,
} from '../lib/topic-tasks.js';
import { appendTopicEvent, readTopicEvents, resolveTopicKey } from '../lib/topic-events.js';

/**
 * `pa topic-task` / `pa topic-note` / `pa topic-events` — topic-task handover
 * CLI (pa/src/lib/topic-tasks.ts owns the record shapes and validation).
 *
 * A thin CLI shell over `pa/src/lib/topic-tasks.ts` + `pa/src/lib/topic-events.ts`.
 * Notes live in the unified topic store (operator directive 2026-09-03,
 * retiring the per-topic `SHORT-TERM.md` markdown index) — this file has no
 * file I/O of its own for notes; `addNote`/`listNotes`/`closeNote` own it.
 *
 * Arg style follows pa/src/commands/watch.ts.
 *
 * Exit codes: 0 success · 2 usage/argument error (unknown flag, missing
 * subcommand, bad key/date format) · 3 rejected by a validator or the store
 * (invalid prompt/title, unknown or ambiguous topic key, duplicate/missing
 * note key).
 */

const TASK_USAGE = `Usage:
  pa topic-task add <chatId>_<threadId> --title "<text>" --prompt "<text>" [--created-by <s>] [--worker <pin>] [--model <id>]  Queue a task for the topic's bot drain (content-hash dedup; pin = preferred worker, model = per-task model pin)
  pa topic-task list <topicKey>    List a topic's queued + in-flight (running/parked) tasks`;

const NOTE_USAGE = `Usage:
  pa topic-note add <topicKey> "<text>" [--key <k>] [--expires YYYY-MM-DD]  Add an OPEN note to the topic's store
  pa topic-note list <topicKey>    List the topic's notes (OPEN and DONE)
  pa topic-note close <topicKey> <key>  Flip an OPEN note to DONE`;

const EVENTS_USAGE = `Usage:
  pa topic-events <topicKey>    Show the topic's event log (newest last, last 20)`;

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

async function resolveTopicArg(arg: string | undefined): Promise<{ chatId: number; threadId: number } | null> {
  if (!arg) return null;
  return resolveTopicKey(arg);
}

// ---------------------------------------------------------------------------
// pa topic-task
// ---------------------------------------------------------------------------

async function taskAddSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, new Set(['--title', '--prompt', '--created-by', '--worker', '--model']));
  if (parsed.unknown.length > 0 || parsed.positionals.length !== 1) {
    console.error(TASK_USAGE);
    if (parsed.unknown.length > 0) console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const title = parsed.values['--title'];
  const prompt = parsed.values['--prompt'];
  if (title === undefined || prompt === undefined) {
    console.error(TASK_USAGE);
    console.error('Error: --title and --prompt are required');
    return 2;
  }

  const topic = await resolveTopicArg(parsed.positionals[0]);
  if (!topic) {
    console.error(`Error: unknown or ambiguous topic key: ${parsed.positionals[0]}`);
    return 3;
  }

  let result: { id: string; deduped: boolean };
  try {
    result = await appendTask(topic.chatId, topic.threadId, {
      title,
      prompt,
      createdBy: parsed.values['--created-by'] ?? 'cli',
      ...(parsed.values['--worker'] !== undefined ? { worker: parsed.values['--worker'] } : {}),
      ...(parsed.values['--model'] !== undefined ? { model: parsed.values['--model'] } : {}),
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 3;
  }

  // Event AFTER the queue write. If the event write fails the task is still
  // queued and dedup makes a re-run safe, so a failure here just reports.
  try {
    await appendTopicEvent(topic.chatId, topic.threadId, {
      kind: 'task_queued',
      ref: result.id,
      detail: title,
    });
  } catch (err) {
    console.error(`Warning: queued ${result.id} but failed to write the task_queued event: ${(err as Error).message}`);
  }

  console.log(result.deduped ? `Already queued ${result.id} (deduped)` : `Queued ${result.id}`);
  return 0;
}

async function taskListSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, new Set());
  if (parsed.unknown.length > 0 || parsed.positionals.length !== 1) {
    console.error(TASK_USAGE);
    if (parsed.unknown.length > 0) console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const topic = await resolveTopicArg(parsed.positionals[0]);
  if (!topic) {
    console.error(`Error: unknown or ambiguous topic key: ${parsed.positionals[0]}`);
    return 3;
  }

  const [tasks, running] = await Promise.all([
    listTasks(topic.chatId, topic.threadId),
    listRunningTasks(topic.chatId, topic.threadId),
  ]);
  if (tasks.length === 0 && running.length === 0) {
    console.log(`No queued or in-flight tasks for ${parsed.positionals[0]}.`);
    return 0;
  }
  for (const t of tasks) {
    const pin = t.worker ? `, pin ${t.worker}` : '';
    console.log(`${t.id}  ${t.title}  (queued ${t.created_at}, by ${t.created_by}${pin})`);
  }
  // In-flight lines use the SAME grammar the bot injects into worker prompts
  // (context.ts's open-items section): `- <id> — <title> (<status>, attempt n/3)`.
  for (const r of running) {
    console.log(`- ${r.id} — ${r.title} (${r.status}, attempt ${r.attempts}/${TOPIC_TASK_MAX_ATTEMPTS})`);
  }
  return 0;
}

export async function topicTaskCommand(args: string[]): Promise<number> {
  switch (args[0]) {
    case 'add':
      return taskAddSubcommand(args.slice(1));
    case 'list':
      return taskListSubcommand(args.slice(1));
    default:
      console.error(TASK_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// pa topic-note
// ---------------------------------------------------------------------------

async function noteAddSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, new Set(['--key', '--expires']));
  if (parsed.unknown.length > 0 || parsed.positionals.length !== 2) {
    console.error(NOTE_USAGE);
    if (parsed.unknown.length > 0) console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const topicKey = parsed.positionals[0];
  const text = parsed.positionals[1];

  const topic = await resolveTopicArg(topicKey);
  if (!topic) {
    console.error(`Error: unknown or ambiguous topic key: ${topicKey}`);
    return 3;
  }

  // --key/--expires shape is a usage error (exit 2); the store validates text
  // and duplicate keys itself (exit 3).
  if (parsed.values['--key'] !== undefined && !TOPIC_NOTE_KEY_RE.test(parsed.values['--key'])) {
    console.error('Error: --key must match ^[a-z0-9][a-z0-9-]{0,39}$');
    return 2;
  }
  if (parsed.values['--expires'] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.values['--expires'])) {
    console.error('Error: --expires must be a date like 2026-09-30');
    return 2;
  }

  let result: { key: string };
  try {
    result = await addNote(topic.chatId, topic.threadId, {
      text,
      ...(parsed.values['--key'] !== undefined ? { key: parsed.values['--key'] } : {}),
      ...(parsed.values['--expires'] !== undefined ? { expires: parsed.values['--expires'] } : {}),
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 3;
  }

  try {
    await appendTopicEvent(topic.chatId, topic.threadId, { kind: 'note_added', ref: result.key, detail: text });
  } catch (err) {
    console.error(`Warning: added ${result.key} but failed to write the note_added event: ${(err as Error).message}`);
  }

  console.log(`Added ${result.key} (OPEN)`);
  return 0;
}

async function noteListSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, new Set());
  if (parsed.unknown.length > 0 || parsed.positionals.length !== 1) {
    console.error(NOTE_USAGE);
    if (parsed.unknown.length > 0) console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const topic = await resolveTopicArg(parsed.positionals[0]);
  if (!topic) {
    console.error(`Error: unknown or ambiguous topic key: ${parsed.positionals[0]}`);
    return 3;
  }

  const notes = await listNotes(topic.chatId, topic.threadId);
  if (notes.length === 0) {
    console.log(`No notes for ${parsed.positionals[0]}.`);
    return 0;
  }
  for (const n of notes) {
    console.log(`${n.status} ${n.key} — ${noteDisplayText(n)}`);
  }
  return 0;
}

async function noteCloseSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, new Set());
  if (parsed.unknown.length > 0 || parsed.positionals.length !== 2) {
    console.error(NOTE_USAGE);
    if (parsed.unknown.length > 0) console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const topic = await resolveTopicArg(parsed.positionals[0]);
  if (!topic) {
    console.error(`Error: unknown or ambiguous topic key: ${parsed.positionals[0]}`);
    return 3;
  }

  const key = parsed.positionals[1];
  try {
    await closeNote(topic.chatId, topic.threadId, key);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 3;
  }

  console.log(`Closed ${key}`);
  return 0;
}

export async function topicNoteCommand(args: string[]): Promise<number> {
  switch (args[0]) {
    case 'add':
      return noteAddSubcommand(args.slice(1));
    case 'list':
      return noteListSubcommand(args.slice(1));
    case 'close':
      return noteCloseSubcommand(args.slice(1));
    default:
      console.error(NOTE_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// pa topic-events
// ---------------------------------------------------------------------------

export async function topicEventsCommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, new Set());
  if (parsed.unknown.length > 0 || parsed.positionals.length !== 1) {
    console.error(EVENTS_USAGE);
    if (parsed.unknown.length > 0) console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const topic = await resolveTopicArg(parsed.positionals[0]);
  if (!topic) {
    console.error(`Error: unknown or ambiguous topic key: ${parsed.positionals[0]}`);
    return 3;
  }

  const events = await readTopicEvents(topic.chatId, topic.threadId);
  if (events.length === 0) {
    console.log(`No events for ${parsed.positionals[0]}.`);
    return 0;
  }
  for (const e of events) {
    // Newest LAST — the file is chronological and is printed in file order.
    console.log(`${e.ts} ${e.kind} ref=${e.ref ?? '-'} ${e.detail}`.trimEnd());
  }
  return 0;
}
