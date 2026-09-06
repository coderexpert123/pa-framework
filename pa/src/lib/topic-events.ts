/**
 * Append-only per-topic event log — topic-task handover Wave 1 (SPEC §3.2,
 * the WAVE1 spec, 2026-09-02).
 *
 * `~/.pa/topic-events/<chatId>_<threadId>.jsonl`, one JSON line per event,
 * UTF-8. Each line is a single `appendFile` of `JSON.stringify(...) + '\n'`
 * and is far under 4 KB (detail capped at 200 chars), so appends never
 * interleave mid-line. Retention: NONE in Wave 1 — the
 * conversation-history.jsonl precedent (permanent, tiny lines); a declared
 * prune job is deferred to a backlog note, not built here (SPEC §3.2).
 */
import { appendFile, mkdir, readFile, readdir } from 'fs/promises';
import type { Dirent } from 'fs';
import { dirname, join } from 'path';
import { paHome } from '../paths.js';
import { log } from './log.js';

/** Closed enum — Wave 1 emits task_queued/note_added (CLI); Wave 2 adds the
 *  executor-lane kinds (task_parked/task_resumed/task_completed); the 2026-09-06
 *  orchestrator-threads increment adds the thread lifecycle kinds
 *  (thread_spawned/thread_steered/thread_completed/thread_failed/
 *  thread_cancelled, bot-emitted). `ref` for a thread kind is the thread id
 *  `t-<n>`. Thread kinds are deliberately NOT task-lane activity —
 *  task-lane-activity's ACTIVITY_KINDS excludes them (pinned by test). */
export const TOPIC_EVENT_KINDS = [
  'task_queued',
  'task_started',
  'task_failed',
  'task_parked',
  'task_resumed',
  'task_completed',
  'question_asked',
  'question_answered',
  'note_added',
  'wave_done',
  'thread_spawned',
  'thread_steered',
  'thread_completed',
  'thread_failed',
  'thread_cancelled',
] as const;

export type TopicEventKind = (typeof TOPIC_EVENT_KINDS)[number];

export const TOPIC_EVENT_MAX_DETAIL_CHARS = 200;

export interface TopicEvent {
  /** ISO 8601. */
  ts: string;
  kind: TopicEventKind;
  /** Task id | note key | refId | null. */
  ref: string | null;
  /** <=200 chars. */
  detail: string;
}

function topicEventsPath(chatId: number, threadId: number): string {
  return join(paHome(), 'topic-events', `${chatId}_${threadId}.jsonl`);
}

/**
 * Append one event line. Throws on an unknown kind (a caller using a kind
 * outside the closed enum is a code bug, not a runtime condition); truncates
 * over-long detail to the frozen 200-char cap instead of failing the caller.
 */
export async function appendTopicEvent(
  chatId: number,
  threadId: number,
  ev: { kind: TopicEventKind; ref?: string | null; detail?: string },
): Promise<void> {
  if (!TOPIC_EVENT_KINDS.includes(ev.kind)) {
    throw new Error(`unknown topic event kind: ${String(ev.kind)}`);
  }
  const record: TopicEvent = {
    ts: new Date().toISOString(),
    kind: ev.kind,
    ref: ev.ref ?? null,
    detail: (ev.detail ?? '').slice(0, TOPIC_EVENT_MAX_DETAIL_CHARS),
  };
  const path = topicEventsPath(chatId, threadId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
}

// Tolerant reader: blank/malformed lines are skipped, warned about ONCE per
// process (a corrupt tail must not spam every read), never thrown.
let warnedMalformedLine = false;

function warnOnceMalformed(path: string): void {
  if (warnedMalformedLine) return;
  warnedMalformedLine = true;
  log('warn', 'topic-events', 'skipped blank/malformed line(s) in a topic-events log (warn-once per process)', { path });
}

/**
 * Read a topic's events, NEWEST LAST, capped at the newest `limit` (default
 * 20). Absent file → [] (the normal case). Malformed lines are skipped with
 * the warn-once log.
 */
export async function readTopicEvents(
  chatId: number,
  threadId: number,
  limit = 20,
): Promise<TopicEvent[]> {
  let raw: string;
  try {
    raw = await readFile(topicEventsPath(chatId, threadId), 'utf8');
  } catch {
    return [];
  }

  const events: TopicEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.ts === 'string' && TOPIC_EVENT_KINDS.includes(obj.kind as TopicEventKind)) {
        events.push({
          ts: obj.ts,
          kind: obj.kind as TopicEventKind,
          ref: obj.ref == null ? null : String(obj.ref),
          detail: typeof obj.detail === 'string' ? obj.detail : '',
        });
      } else {
        warnOnceMalformed(topicEventsPath(chatId, threadId));
      }
    } catch {
      warnOnceMalformed(topicEventsPath(chatId, threadId));
    }
  }

  // Newest LAST: file order is chronological, so the newest `limit` events
  // are the tail, returned in file order. Guard the limit<=0 slice(-0) trap.
  const n = Math.max(0, Math.floor(limit));
  return n === 0 ? [] : events.slice(-n);
}

/**
 * Resolve a topic key argument. Accepts `<chatId>_<threadId>` directly, or a
 * bare thread id resolved by UNIQUE filename match across the three per-topic
 * stores (`~/.pa/topic-tasks` and `~/.pa/topic-events` hold files named
 * `<chatId>_<threadId>.json[l]`; `~/.pa/topic-brains` holds directories named
 * `<chatId>_<threadId>`). Ambiguous or absent → null.
 */
export async function resolveTopicKey(arg: string): Promise<{ chatId: number; threadId: number } | null> {
  const trimmed = arg.trim();
  // `<chatId>_<threadId>` is always taken literally — even when no store has
  // seen the topic yet.
  const direct = /^(-?\d+)_(\d+)$/.exec(trimmed);
  if (direct) {
    return { chatId: Number(direct[1]), threadId: Number(direct[2]) };
  }

  const threadMatch = /^\d+$/.exec(trimmed);
  if (!threadMatch) return null;
  const threadId = Number(trimmed);

  const chatIds = new Set<number>();
  const scanStore = async (dir: string, wantDir: boolean): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // absent store — the normal first-run case
    }
    for (const entry of entries) {
      if (entry.isDirectory() !== wantDir) continue;
      // Store FILES carry an extension (`123_310.json`, `123_310.jsonl`);
      // topic-brains entries are directories with no extension.
      const m = /^(-?\d+)_(\d+)(?:\.json|\.jsonl)?$/.exec(entry.name);
      if (m && Number(m[2]) === threadId) chatIds.add(Number(m[1]));
    }
  };

  await Promise.all([
    scanStore(join(paHome(), 'topic-tasks'), false),
    scanStore(join(paHome(), 'topic-events'), false),
    scanStore(join(paHome(), 'topic-brains'), true),
  ]);

  if (chatIds.size !== 1) return null; // ambiguous or absent
  return { chatId: Array.from(chatIds)[0], threadId };
}
