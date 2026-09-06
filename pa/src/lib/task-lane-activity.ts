/**
 * Task-lane activity reader/aggregator (AI-197, 2026-09-05).
 *
 * Reads the topic-event log — `pa/src/lib/topic-events.ts`, store
 * `~/.pa/topic-events/<chatId>_<threadId>.jsonl`, one JSON line per event,
 * append-only — and aggregates the task-lane ACTIVITY SET into per-topic,
 * per-task records so the self-improvement analyzers can ground Pass-2
 * proposals in async execution evidence. The log is only ever READ here;
 * the filename is the conversation (`<chatId>_<threadId>` = topic thread),
 * so per-event conversation attribution costs nothing.
 *
 * Trace attribution (`worker`/`session_id`) is INJECTED, not imported: the
 * caller supplies the lookup (the trace sidecar's task_ref join), keeping
 * this module independent of the trace writer. Everything here is tolerant:
 * an absent store, a missing file, a blank/malformed line, or a failing
 * lookup degrades to less evidence — never a throw, never a wrong join.
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../paths.js';
import type { TraceLine } from './ref-lookup.js';

/** Task lines rendered into the Pass-2 prompt. */
export const TASK_LANE_PROMPT_MAX_TASKS = 12;
/** Topic groups rendered into the Pass-2 prompt. */
export const TASK_LANE_PROMPT_MAX_TOPICS = 6;
/** Trace lookups per nightly run (each is a ~8MB tail scan). */
export const TASK_LANE_MAX_TRACE_JOINS = 10;

/** Kinds that constitute analyzed activity. `task_queued` is EXCLUDED —
 *  queued-but-never-started is drain health, not analyzed activity. */
const ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  'task_started',
  'task_resumed',
  'task_completed',
  'task_failed',
  'task_parked',
  'question_asked',
  'question_answered',
]);

export interface TaskLaneTask {
  /** Task id ('tt-…' or whatever the producer set as ref). */
  ref: string;
  /** Last task_started/task_resumed/task_completed detail; else '(queued)'. */
  title: string;
  /** task_started + task_resumed count in window. */
  starts: number;
  completed: boolean;
  failed: boolean;
  /** Last task_failed detail (already redacted at write). */
  failReason?: string;
  /** question_asked with ref === task.ref. */
  askedQuestion: boolean;
  /** question_answered with ref === task.ref. */
  answered: boolean;
  /** task_parked seen and no later completed/failed. */
  parked: boolean;
  /** ISO, earliest/latest event in window. */
  firstSeenAt: string;
  lastSeenAt: string;
  /** Enrichment only. */
  worker?: string;
  /** Enrichment only. */
  session_id?: string;
  /** Enrichment only. */
  traceJoined: boolean;
}

export interface TaskLaneTopic {
  chatId: number;
  threadId: number;
  tasks: TaskLaneTask[];
}

export interface TaskLaneActivity {
  windowDays: number;
  topics: TaskLaneTopic[];
  totals: { tasks: number; starts: number; completed: number; failed: number };
}

interface EventLine {
  ts: string;
  kind: string;
  ref: string;
  detail: string;
}

function blankTask(ref: string, ts: string): TaskLaneTask {
  return {
    ref,
    title: '(queued)',
    starts: 0,
    completed: false,
    failed: false,
    askedQuestion: false,
    answered: false,
    parked: false,
    firstSeenAt: ts,
    lastSeenAt: ts,
    traceJoined: false,
  };
}

function applyEvent(t: TaskLaneTask, ev: EventLine): void {
  // File order is chronological, so the last write is the latest event.
  t.lastSeenAt = ev.ts;
  switch (ev.kind) {
    case 'task_started':
    case 'task_resumed':
      t.starts += 1;
      t.title = ev.detail;
      break;
    case 'task_completed':
      t.completed = true;
      t.parked = false;
      t.title = ev.detail;
      break;
    case 'task_failed':
      t.failed = true;
      t.parked = false;
      t.failReason = ev.detail;
      break;
    case 'task_parked':
      t.parked = true;
      break;
    case 'question_asked':
      t.askedQuestion = true;
      break;
    case 'question_answered':
      t.answered = true;
      break;
  }
}

/**
 * Enumerate `~/.pa/topic-events/*.jsonl` and aggregate the activity window.
 * Tolerant by construction: an absent directory zeroes the activity; a file
 * whose processing throws is skipped whole; a blank/malformed line is
 * skipped. Events outside the window, kinds outside the activity set, and
 * events with no usable ref (nothing to attribute them to) are dropped.
 */
export async function readTaskLaneActivity(opts: { days: number; nowMs?: number }): Promise<TaskLaneActivity> {
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - opts.days * 86400000;
  const zeroed: TaskLaneActivity = {
    windowDays: opts.days,
    topics: [],
    totals: { tasks: 0, starts: 0, completed: 0, failed: 0 },
  };

  let names: string[];
  try {
    names = await readdir(join(paHome(), 'topic-events'));
  } catch {
    return zeroed; // absent store — the normal first-run case
  }

  interface TopicAcc {
    chatId: number;
    threadId: number;
    eventCount: number;
    tasks: Map<string, TaskLaneTask>;
  }
  const topics = new Map<string, TopicAcc>();

  for (const name of names) {
    const m = /^(-?\d+)_(\d+)\.jsonl$/.exec(name);
    if (!m) continue; // not a topic-events file
    const chatId = Number(m[1]);
    const threadId = Number(m[2]);
    try {
      const raw = await readFile(join(paHome(), 'topic-events', name), 'utf8');
      const key = `${chatId}_${threadId}`;
      let acc = topics.get(key);
      if (!acc) {
        acc = { chatId, threadId, eventCount: 0, tasks: new Map() };
        topics.set(key, acc);
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue; // malformed line — skip it, keep the good ones
        }
        if (typeof obj !== 'object' || obj === null) continue;
        if (typeof obj.ts !== 'string' || typeof obj.kind !== 'string') continue;
        if (typeof obj.ref !== 'string' || obj.ref.length === 0) continue; // nothing to attribute to
        if (!ACTIVITY_KINDS.has(obj.kind)) continue;
        const tsMs = Date.parse(obj.ts);
        if (!(tsMs >= cutoff)) continue; // spec-literal keep predicate; NaN-safe (unparseable ts dropped)
        const ev: EventLine = {
          ts: obj.ts,
          kind: obj.kind,
          ref: obj.ref,
          detail: typeof obj.detail === 'string' ? obj.detail : '',
        };
        let t = acc.tasks.get(ev.ref);
        if (!t) {
          t = blankTask(ev.ref, ev.ts);
          acc.tasks.set(ev.ref, t);
        }
        applyEvent(t, ev);
        acc.eventCount += 1;
      }
    } catch {
      continue; // this file's processing failed — skip the file, never throw
    }
  }

  const assembled: TaskLaneTopic[] = [...topics.values()]
    .sort(
      (a, b) =>
        b.eventCount - a.eventCount || a.chatId - b.chatId || a.threadId - b.threadId
    )
    .map((acc) => ({
      chatId: acc.chatId,
      threadId: acc.threadId,
      tasks: [...acc.tasks.values()].sort(
        (a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt)
      ),
    }));

  const all = assembled.flatMap((t) => t.tasks);
  return {
    windowDays: opts.days,
    topics: assembled,
    totals: {
      tasks: all.filter((t) => t.starts >= 1).length,
      starts: all.reduce((sum, t) => sum + t.starts, 0),
      completed: all.filter((t) => t.completed).length,
      failed: all.filter((t) => t.failed).length,
    },
  };
}

/**
 * Join tasks to their dispatch traces via the injected lookup (the trace
 * sidecar's task_ref join; caller wires it — no default import here). Join
 * candidates: all failed tasks first (failure evidence is the valuable
 * kind), then remaining tasks by lastSeenAt desc, up to
 * TASK_LANE_MAX_TRACE_JOINS total. A null/throwing lookup degrades to
 * `traceJoined: false` with worker/session left unset — "not joined",
 * never a wrong join. Returns a NEW object; the input is consumed.
 */
export async function enrichTaskLaneActivity(
  activity: TaskLaneActivity,
  lookup: (taskRef: string) => Promise<TraceLine | null>,
): Promise<TaskLaneActivity> {
  const copy: TaskLaneActivity = {
    windowDays: activity.windowDays,
    totals: { ...activity.totals },
    topics: activity.topics.map((topic) => ({
      chatId: topic.chatId,
      threadId: topic.threadId,
      tasks: topic.tasks.map((task) => ({ ...task })),
    })),
  };

  const flat = copy.topics.flatMap((topic) => topic.tasks);
  // Stable partitions keep the caller's topic/task order within each group.
  const failed = flat.filter((t) => t.failed).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const rest = flat.filter((t) => !t.failed).sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  const candidates = [...failed, ...rest].slice(0, TASK_LANE_MAX_TRACE_JOINS);

  for (const task of candidates) {
    let trace: TraceLine | null = null;
    try {
      trace = await lookup(task.ref);
    } catch {
      trace = null;
    }
    if (trace) {
      task.worker = typeof trace.worker === 'string' ? trace.worker : undefined;
      task.session_id = typeof trace.session_id === 'string' ? trace.session_id : undefined;
      if (task.worker === undefined) delete task.worker;
      if (task.session_id === undefined) delete task.session_id;
      task.traceJoined = true;
    } else {
      delete task.worker;
      delete task.session_id;
      task.traceJoined = false;
    }
  }

  return copy;
}

function outcomeWord(t: TaskLaneTask): string {
  if (t.failed) return `failed (${(t.failReason ?? '').slice(0, 120)})`;
  if (t.completed) return 'completed';
  if (t.askedQuestion) return 'question asked';
  if (t.answered) return 'question answered';
  if (t.parked) return 'parked/open';
  return 'open';
}

/**
 * The optional "Async task-lane activity" Pass-2 prompt section. Empty string
 * when there was no activity — callers insert it verbatim only when truthy,
 * so a quiet task-lane night leaves the prompt byte-identical.
 */
export function formatTaskLanePromptSection(activity: TaskLaneActivity | undefined): string {
  if (!activity || activity.totals.tasks === 0) return '';

  const lines: string[] = [
    `## Async task-lane activity (last ${activity.windowDays} days)`,
    '',
    "Task-lane executions with their conversation (<chatId>_<threadId> = topic thread). A task's",
    'session is the worker conversation that executed it.',
  ];

  const totalTasks = activity.topics.reduce((sum, t) => sum + t.tasks.length, 0);
  let rendered = 0;
  let topicsRendered = 0;
  outer: for (const topic of activity.topics) {
    if (topicsRendered >= TASK_LANE_PROMPT_MAX_TOPICS) break;
    topicsRendered += 1;
    for (const task of topic.tasks) {
      if (rendered >= TASK_LANE_PROMPT_MAX_TASKS) break outer;
      lines.push(
        `- ${topic.chatId}_${topic.threadId}: ${task.title} — started ${task.starts}x, ` +
          `outcome: ${outcomeWord(task)}, worker ${task.worker ?? 'unknown'}, ` +
          `session ${task.session_id ?? 'unknown'}`
      );
      rendered += 1;
    }
  }

  const omitted = totalTasks - rendered;
  if (omitted > 0) lines.push(`(+${omitted} more task(s) not shown)`);
  return lines.join('\n');
}

/**
 * One nightly-report line. null when there was no activity — a task-lane-zero
 * night is the normal state, and the census line already carries the
 * "did anything run" context.
 */
export function formatTaskLaneReportLine(activity: TaskLaneActivity | undefined): string | null {
  if (!activity || activity.totals.tasks === 0) return null;
  return (
    `Task lane (${activity.windowDays}d): ${activity.totals.tasks} task(s) across ` +
    `${activity.topics.length} topic(s) — ${activity.totals.completed} completed, ` +
    `${activity.totals.failed} failed.`
  );
}
