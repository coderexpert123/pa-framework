/**
 * Orphan ledger — topic-task handover Wave 2, WP-C (AI-189). SPEC §3.3,
 * plans/2026-09-02-topic-handover-WAVE2-SPEC.md.
 *
 * Append-only `~/.pa/orphan-ledger.jsonl`, one JSON line per record, UTF-8 —
 * the topic-events.ts discipline: each line is a single `appendFile` of
 * `JSON.stringify(...) + '\n'` capped at 4 KB, so appends never interleave
 * mid-line. A record whose path list would push the line past the cap is
 * CHUNKED into multiple records sharing the same metadata (never split a
 * path, never drop one).
 *
 * Writers today: worker-edit-audit's closeWindow ("dispatch-close" source).
 * Reader today: the daily-recon maintenance job's orphan sweep, which groups
 * still-dirty paths by the newest record naming each path and files
 * land-or-discard tasks to the owning topics.
 *
 * Retention: none this wave (backlog note; lines are tiny) — the
 * conversation-history.jsonl precedent.
 */
import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { paHome } from '../paths.js';
import { log } from './log.js';

/** A chunked line, including its trailing newline, never exceeds this. */
export const ORPHAN_LEDGER_MAX_LINE_BYTES = 4096;

export interface OrphanLedgerRecord {
  /** ISO 8601 — when the record was written. */
  ts: string;
  /** Repo-relative paths (forward slashes) — the dirty finding set. */
  paths: string[];
  /** Covering reservation's session label; null when unowned or unknowable. */
  owner_session: string | null;
  /** "<chatId>_<threadId>" of the dispatching topic; null when the caller
   *  did not know it or the finding had no topic. */
  owner_topic: string | null;
  /** Which producer wrote the record ('dispatch-close' today). */
  source: string;
  /** Covering reservation's expiry ISO (still active) or release ISO
   *  (released mid-window); null when unowned. */
  released_at: string | null;
}

export function orphanLedgerPath(): string {
  return join(paHome(), 'orphan-ledger.jsonl');
}

/**
 * Append one record as one or more ≤4 KB JSON lines. Returns the number of
 * lines written. Throws on write failure — callers on a close path wrap this
 * in their own try/catch (closeWindow must never throw).
 */
export async function appendOrphanRecord(rec: OrphanLedgerRecord): Promise<number> {
  const meta = {
    ts: rec.ts,
    owner_session: rec.owner_session,
    owner_topic: rec.owner_topic,
    source: rec.source,
    released_at: rec.released_at,
  };
  const lineBytes = (paths: string[]): number =>
    Buffer.byteLength(JSON.stringify({ ...meta, paths }) + '\n', 'utf8');

  const chunks: string[][] = [];
  let current: string[] = [];
  for (const p of rec.paths) {
    // A lone over-long path still gets its own record — a path cannot be
    // split, and dropping it silently would defeat the sweep's purpose.
    if (current.length > 0 && lineBytes([...current, p]) > ORPHAN_LEDGER_MAX_LINE_BYTES) {
      chunks.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);

  const path = orphanLedgerPath();
  await mkdir(dirname(path), { recursive: true });
  let written = 0;
  for (const paths of chunks) {
    await appendFile(path, JSON.stringify({ ...meta, paths }) + '\n', 'utf8');
    written++;
  }
  return written;
}

// Tolerant reader (topic-events.ts pattern): blank/malformed lines are
// skipped, warned about ONCE per process, never thrown.
let warnedMalformedLine = false;

function warnOnceMalformed(path: string): void {
  if (warnedMalformedLine) return;
  warnedMalformedLine = true;
  log('warn', 'orphan-ledger', 'skipped blank/malformed line(s) in the orphan ledger (warn-once per process)', { path });
}

function isOrphanLedgerRecord(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.ts === 'string' &&
    typeof obj.source === 'string' &&
    Array.isArray(obj.paths) &&
    obj.paths.every((p) => typeof p === 'string')
  );
}

/**
 * Read the ledger, NEWEST LAST (file order is chronological), capped at the
 * newest `limit` records (default 500). Absent file → [] (the normal first
 * -run case). Malformed lines are skipped with the warn-once log.
 */
export async function readOrphanLedger(limit = 500): Promise<OrphanLedgerRecord[]> {
  let raw: string;
  try {
    raw = await readFile(orphanLedgerPath(), 'utf8');
  } catch {
    return [];
  }

  const records: OrphanLedgerRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (isOrphanLedgerRecord(obj)) {
        records.push({
          ts: obj.ts as string,
          paths: obj.paths as string[],
          owner_session: obj.owner_session == null ? null : String(obj.owner_session),
          owner_topic: obj.owner_topic == null ? null : String(obj.owner_topic),
          source: obj.source as string,
          released_at: obj.released_at == null ? null : String(obj.released_at),
        });
      } else {
        warnOnceMalformed(orphanLedgerPath());
      }
    } catch {
      warnOnceMalformed(orphanLedgerPath());
    }
  }

  // Guard the limit<=0 slice(-0) trap (readTopicEvents precedent).
  const n = Math.max(0, Math.floor(limit));
  return n === 0 ? [] : records.slice(-n);
}
