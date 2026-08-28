/**
 * recall-store.ts — FTS5 index and query engine for `pa recall`.
 *
 * Single-file, in-process TypeScript store over `better-sqlite3` (already a
 * `pa` dependency; no Python, no spawn — see
 * plans/2026-08-24-recall-traces-wave-SPEC.md §3.3/C1, C8).
 *
 * better-sqlite3 is synchronous by design, and every exported function here
 * stays synchronous end to end (file reads use the `node:fs` sync API) so
 * `recall-index` (host: 'pa') never yields mid-index and the bot's event
 * loop is never touched by this module (it is never imported bot-side).
 *
 * Five sources are indexed, keyed by the `docs.source` column:
 *   conversation | trace | brain | kb | review
 * See §3.3/C3 in the spec for the exact per-source doc-unit / doc_id /
 * cursor rules this file implements.
 */

import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, join, basename, resolve as resolvePath, sep as pathSep } from 'node:path';
import { createHash } from 'node:crypto';
import type { SqlParam } from './db.js'; // reuse, do not redeclare
import { redactSecrets } from './redact.js';
import { logger } from './log.js';

export const RECALL_SCHEMA_VERSION = 1;
export const RECALL_MAX_LIMIT = 50;
export const RECALL_REFRESH_MS = 600_000;

export interface RecallSources {
  conversation: { live: string; archiveDir: string } | null;
  traces: { live: string; archiveDir: string } | null;
  topicBrains: { dir: string } | null;
  kb: { dir: string } | null;
  reviewDigest: { path: string } | null;
  decisions: { dbPath: string } | null;
}

export interface RecallQuery {
  q: string;
  limit?: number;
  thread?: number;
  source?: string;
  role?: 'user' | 'assistant';
  since?: string;
  until?: string;
}

export interface RecallHit {
  doc_id: string;
  source: string;
  ts: string | null;
  thread_id: number | null;
  role: string | null;
  title: string;
  snippet: string;
  ref: Record<string, unknown>;
  rescue: boolean;
}

export interface IndexStats {
  added: number;
  updated: number;
  deleted: number;
  ms: number;
}

export interface RecallQueryResult {
  ok: true;
  total: number;
  limit: number;
  note: string | null;
  indexed: IndexStats | null;
  hits: RecallHit[];
}

export interface RecallIndexResult {
  ok: true;
  indexed: IndexStats;
  sources: Record<string, IndexStats>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so they are unit-testable without a DB — §3.3/C1,C4)
// ---------------------------------------------------------------------------

// TS equivalent of Python's re.UNICODE \w+ (store/fts.py pattern reference).
const FTS_TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** Tokenize and wrap each term in double quotes (implicit AND), or null when
 *  the query has no usable terms. Disables FTS5 operator/column syntax. */
export function ftsSanitize(q: string): string | null {
  const tokens = (q ?? '').match(FTS_TOKEN_RE);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' ');
}

/** OR-joined form for the rescue pass, or null when a fallback can't differ
 *  from the AND form (0 or 1 tokens). */
export function ftsOrForm(q: string): string | null {
  const tokens = (q ?? '').match(FTS_TOKEN_RE);
  if (!tokens || tokens.length < 2) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

export function clampLimit(n: unknown): number {
  const num = Number(n);
  const base = Number.isFinite(num) ? Math.trunc(num) : 10;
  return Math.max(1, Math.min(base, RECALL_MAX_LIMIT));
}

/** lowercase, non-[a-z0-9]+ runs -> '-', trimmed of leading/trailing '-',
 *  truncated to 60 chars. */
export function slugHeading(h: string): string {
  const collapsed = (h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  return trimmed.slice(0, 60);
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DocRow {
  doc_id: string;
  source: string;
  ref_json: string;
  ts: string | null;
  thread_id: number | null;
  role: string | null;
  title: string;
  text: string;
}

interface UpsertStmts {
  exists: Database.Statement;
  upsertDoc: Database.Statement;
  deleteDoc: Database.Statement;
  deleteFts: Database.Statement;
  insertFts: Database.Statement;
}

// ---------------------------------------------------------------------------
// Schema (§3.3/C2 — frozen)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs (
  doc_id    TEXT PRIMARY KEY,
  source    TEXT NOT NULL,
  ref_json  TEXT NOT NULL,
  ts        TEXT,
  thread_id INTEGER,
  role      TEXT,
  title     TEXT NOT NULL DEFAULT '',
  text      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS docs_source_ts  ON docs(source, ts);
CREATE INDEX IF NOT EXISTS docs_thread_ts  ON docs(thread_id, ts);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, title, text);
CREATE TABLE IF NOT EXISTS cursors (
  source      TEXT PRIMARY KEY,
  cursor_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

function createSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)`).run(
    String(RECALL_SCHEMA_VERSION)
  );
}

function dropDataTables(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS docs_fts;
    DROP TABLE IF EXISTS docs;
    DROP TABLE IF EXISTS cursors;
  `);
}

function ensureSchemaCurrent(db: Database.Database): void {
  const hasMeta = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get();
  if (!hasMeta) {
    createSchema(db);
    return;
  }
  const row = db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get() as
    | { v: string }
    | undefined;
  const version = row?.v ?? null;
  if (version !== String(RECALL_SCHEMA_VERSION)) {
    // Foreign or missing schema_version: derived data, so rebuild rather than
    // migrate or fail (§3.3/C2).
    dropDataTables(db);
    createSchema(db);
  }
}

function openStore(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  ensureSchemaCurrent(db);
  return db;
}

function prepareUpsertStmts(db: Database.Database): UpsertStmts {
  return {
    exists: db.prepare('SELECT 1 FROM docs WHERE doc_id = ?'),
    upsertDoc: db.prepare(`
      INSERT INTO docs (doc_id, source, ref_json, ts, thread_id, role, title, text)
      VALUES (@doc_id, @source, @ref_json, @ts, @thread_id, @role, @title, @text)
      ON CONFLICT(doc_id) DO UPDATE SET
        source=excluded.source, ref_json=excluded.ref_json, ts=excluded.ts,
        thread_id=excluded.thread_id, role=excluded.role, title=excluded.title, text=excluded.text
    `),
    deleteDoc: db.prepare('DELETE FROM docs WHERE doc_id = ?'),
    deleteFts: db.prepare('DELETE FROM docs_fts WHERE doc_id = ?'),
    insertFts: db.prepare('INSERT INTO docs_fts (doc_id, title, text) VALUES (?, ?, ?)'),
  };
}

/** Redacts title/text/ref_json, then upserts one doc into `docs` + `docs_fts`.
 *  Returns whether this doc_id already existed.
 *
 *  ref_json redaction (verifier fix, 2026-08-24 — spec §3.3/C1 did not call
 *  this out, matching the same "spec-gap defensive" reasoning the indexer's
 *  own title/text redaction already carries): for `conversation`/`trace`
 *  sources ref_json is ID-only or already redacted upstream (turn-traces.jsonl
 *  is redacted by appendTurnTrace before it ever hits disk), so this is a
 *  no-op there. For `review`, ref_json is the WHOLE raw review-digest-pending
 *  entry (§3.3/C3) including new_text/existing_text — memory_consolidation.py
 *  never redacts fact text before writing that file, so a secret-shaped fact
 *  value would otherwise sit in plaintext in ~/.pa/recall.sqlite at rest even
 *  though every query-time surface (snippet, and the CLI's redactSecrets(result)
 *  pass) already redacts it. Confirmed via a live probe: a planted secret in a
 *  review entry's new_text reached ref_json unredacted before this fix.
 *  redactSecrets on a JSON string only replaces matched substrings, so the
 *  surrounding JSON structure/quoting is preserved. */
function upsertDoc(stmts: UpsertStmts, doc: DocRow): 'added' | 'updated' {
  const title = redactSecrets(doc.title) as string;
  const text = redactSecrets(doc.text) as string;
  const ref_json = redactSecrets(doc.ref_json) as string;
  const existed = !!stmts.exists.get(doc.doc_id);
  stmts.upsertDoc.run({ ...doc, title, text, ref_json });
  stmts.deleteFts.run(doc.doc_id);
  stmts.insertFts.run(doc.doc_id, title, text);
  return existed ? 'updated' : 'added';
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

function listDocIdsByPrefix(db: Database.Database, prefix: string): string[] {
  const pattern = escapeLike(prefix) + '%';
  const rows = db
    .prepare(`SELECT doc_id FROM docs WHERE doc_id LIKE ? ESCAPE '\\'`)
    .all(pattern) as { doc_id: string }[];
  return rows.map((r) => r.doc_id);
}

function deleteDocIds(stmts: UpsertStmts, ids: Iterable<string>): void {
  for (const id of ids) {
    stmts.deleteFts.run(id);
    stmts.deleteDoc.run(id);
  }
}

function zeroStats(): IndexStats {
  return { added: 0, updated: 0, deleted: 0, ms: 0 };
}

function addInto(target: IndexStats, delta: IndexStats): void {
  target.added += delta.added;
  target.updated += delta.updated;
  target.deleted += delta.deleted;
}

function combineStats(all: IndexStats[]): IndexStats {
  const total = zeroStats();
  for (const s of all) addInto(total, s);
  return total;
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

function getCursorRaw(db: Database.Database, key: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT cursor_json FROM cursors WHERE source = ?').get(key) as
    | { cursor_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.cursor_json);
  } catch {
    return null;
  }
}

function setCursor(db: Database.Database, key: string, valueJson: string): void {
  db.prepare(
    `INSERT INTO cursors (source, cursor_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET cursor_json=excluded.cursor_json, updated_at=excluded.updated_at`
  ).run(key, valueJson, new Date().toISOString());
}

function deleteCursor(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM cursors WHERE source = ?').run(key);
}

// ---------------------------------------------------------------------------
// JSONL sources: conversation, trace (§3.3/C3 — append-only, byte-offset cursor)
// ---------------------------------------------------------------------------

interface RawLine {
  offset: number;
  raw: string;
}

/** Byte-exact reader: reads from `fromOffset` to EOF, splits on '\n'. A
 *  trailing partial line (no '\n') is left unread and does not advance the
 *  offset. If the file has shrunk below `fromOffset` (rotation), resets to 0
 *  and re-reads the whole file (§3.3/C3, R4). */
function readNewLinesSync(
  filePath: string,
  fromOffset: number
): { lines: RawLine[]; newOffset: number; size: number } {
  const st = statSync(filePath);
  let start = fromOffset;
  if (st.size < start) start = 0;
  if (st.size <= start) return { lines: [], newOffset: start, size: st.size };

  const length = st.size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }

  const lines: RawLine[] = [];
  let pos = 0;
  let cursor = start;
  for (;;) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // partial trailing line — stop, do not advance past it
    const raw = buf.subarray(pos, nl).toString('utf8');
    lines.push({ offset: cursor, raw });
    cursor += nl - pos + 1;
    pos = nl + 1;
  }
  return { lines, newOffset: cursor, size: st.size };
}

const CONVERSATION_TEXT_CAP = 20_000;

function buildConversationDoc(parsed: unknown, filePath: string, offset: number): DocRow | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const turn = parsed as Record<string, unknown>;
  const rawText = typeof turn.text === 'string' ? turn.text : '';
  const text = rawText.slice(0, CONVERSATION_TEXT_CAP);
  if (text.trim().length === 0) return null;

  const role = turn.role === 'user' || turn.role === 'assistant' ? turn.role : null;
  const threadId = typeof turn.thread_id === 'number' ? turn.thread_id : null;
  const title = threadId !== null ? `${role ?? 'unknown'} · thread ${threadId}` : `${role ?? 'unknown'}`;

  const ref: Record<string, unknown> = { file: filePath, offset };
  for (const key of ['message_id', 'refId', 'session_id', 'update_id', 'run_id', 'worker'] as const) {
    if (turn[key] !== undefined) ref[key] = turn[key];
  }

  return {
    doc_id: `conv:${basename(filePath)}:${offset}`,
    source: 'conversation',
    ref_json: JSON.stringify(ref),
    ts: typeof turn.timestamp === 'string' ? turn.timestamp : null,
    thread_id: threadId,
    role,
    title,
    text,
  };
}

function buildTraceDoc(parsed: unknown): DocRow | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const t = parsed as Record<string, unknown>;
  const runId = typeof t.run_id === 'string' ? t.run_id : null;
  if (!runId) return null;

  const worker = typeof t.worker === 'string' ? t.worker : 'unknown';
  const origin = typeof t.origin === 'string' ? t.origin : 'other';
  const outcome = typeof t.outcome === 'string' ? t.outcome : 'unknown';
  const title = `${worker} · ${origin} · ${outcome}`;

  const toolCalls = Array.isArray(t.tool_calls) ? (t.tool_calls as unknown[]) : [];
  const toolLines = toolCalls.map((tc) => {
    const c = (tc ?? {}) as Record<string, unknown>;
    return `${typeof c.name === 'string' ? c.name : 'unknown'}: ${typeof c.arg === 'string' ? c.arg : ''}`;
  });
  const commands = Array.isArray(t.commands) ? (t.commands as unknown[]).map((c) => String(c)) : [];
  const errors = Array.isArray(t.errors) ? (t.errors as unknown[]).map((e) => String(e)) : [];
  const text = [...toolLines, ...commands, ...errors].join('\n');
  if (text.trim().length === 0) return null;

  const threadId = typeof t.thread_id === 'number' ? t.thread_id : null;

  // ref_json = the whole trace object minus the text-derived fields
  // (tool_calls, commands, errors — §3.3/C3).
  const ref: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (k === 'tool_calls' || k === 'commands' || k === 'errors') continue;
    ref[k] = v;
  }

  return {
    doc_id: `trace:${runId}`,
    source: 'trace',
    ref_json: JSON.stringify(ref),
    ts: typeof t.ts_start === 'string' ? t.ts_start : null,
    thread_id: threadId,
    role: null,
    title,
    text,
  };
}

function indexJsonlSource(
  db: Database.Database,
  stmts: UpsertStmts,
  src: { live: string; archiveDir: string },
  shardSuffix: string,
  buildDoc: (parsed: unknown, filePath: string, offset: number) => DocRow | null
): IndexStats {
  const stats = zeroStats();
  const files: string[] = [];
  if (existsSync(src.live)) files.push(resolvePath(src.live));
  if (existsSync(src.archiveDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(src.archiveDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name.endsWith(shardSuffix)) files.push(resolvePath(join(src.archiveDir, name)));
    }
  }

  for (const filePath of files) {
    const cursorKey = `jsonl:${filePath}`;
    const cur = getCursorRaw(db, cursorKey) as { offset?: number } | null;
    const fromOffset = typeof cur?.offset === 'number' ? cur.offset : 0;
    const { lines, newOffset, size } = readNewLinesSync(filePath, fromOffset);

    for (const { offset, raw } of lines) {
      if (raw.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue; // malformed line — torn-line tolerance, still advances the offset
      }
      const doc = buildDoc(parsed, filePath, offset);
      if (!doc) continue;
      const kind = upsertDoc(stmts, doc);
      if (kind === 'added') stats.added++;
      else stats.updated++;
    }

    setCursor(db, cursorKey, JSON.stringify({ offset: newOffset, size }));
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Markdown / JSONL-whole-file sources: brain, kb, review
// (§3.3/C3 — mtime+size then sha256 cursor, full re-index of the one file)
// ---------------------------------------------------------------------------

interface MdCursor {
  mtime: number;
  size: number;
  sha256: string;
}

/** Re-indexes one whole file under the mtime+size -> sha256 -> full-reparse
 *  cursor discipline shared by brain/kb/review sources. `buildDocs` turns
 *  file content into the file's current doc set; `docIdPrefix` scopes the
 *  delete-then-reinsert and the vanished-file cleanup. */
function reindexOneFile(
  db: Database.Database,
  stmts: UpsertStmts,
  cursorKey: string,
  filePath: string,
  docIdPrefix: string,
  buildDocs: (content: string, mtimeIso: string, filePath: string) => DocRow[]
): IndexStats {
  const stats = zeroStats();
  const cur = getCursorRaw(db, cursorKey) as Partial<MdCursor> | null;

  if (!existsSync(filePath)) {
    if (cur) {
      const oldIds = listDocIdsByPrefix(db, docIdPrefix);
      deleteDocIds(stmts, oldIds);
      stats.deleted += oldIds.length;
      deleteCursor(db, cursorKey);
    }
    return stats;
  }

  const st = statSync(filePath);
  const mtime = st.mtimeMs;
  const size = st.size;
  if (cur && cur.mtime === mtime && cur.size === size) {
    return stats; // unchanged — fast path, adds nothing
  }

  const content = readFileSync(filePath, 'utf8');
  const sha256 = createHash('sha256').update(content).digest('hex');
  if (cur && cur.sha256 === sha256) {
    setCursor(db, cursorKey, JSON.stringify({ mtime, size, sha256 }));
    return stats; // content unchanged despite mtime touch
  }

  const oldIds = new Set(listDocIdsByPrefix(db, docIdPrefix));
  deleteDocIds(stmts, oldIds);

  const mtimeIso = new Date(mtime).toISOString();
  const newDocs = buildDocs(content, mtimeIso, filePath);
  const newIds = new Set<string>();
  for (const doc of newDocs) {
    newIds.add(doc.doc_id);
    upsertDoc(stmts, doc); // rows were just cleared, so this always inserts fresh
  }

  for (const id of oldIds) if (!newIds.has(id)) stats.deleted++;
  for (const id of newIds) if (oldIds.has(id)) stats.updated++;
  else stats.added++;

  setCursor(db, cursorKey, JSON.stringify({ mtime, size, sha256 }));
  return stats;
}

function findVanishedFileCursors(
  db: Database.Database,
  dir: string,
  seenKeys: Set<string>
): Array<{ key: string; filePath: string }> {
  const dirResolved = resolvePath(dir);
  const dirWithSep = dirResolved.endsWith(pathSep) ? dirResolved : dirResolved + pathSep;
  const pattern = `md:${escapeLike(dirWithSep)}%`;
  const rows = db
    .prepare(`SELECT source FROM cursors WHERE source LIKE ? ESCAPE '\\'`)
    .all(pattern) as { source: string }[];
  const out: Array<{ key: string; filePath: string }> = [];
  for (const row of rows) {
    if (seenKeys.has(row.source)) continue;
    out.push({ key: row.source, filePath: row.source.slice('md:'.length) });
  }
  return out;
}

// --- brain: one '## ' section per BRAIN.md / INDEX.md file --------------

function extractHashHashSections(content: string): Array<{ heading: string; body: string }> {
  const lines = content.split(/\r\n|\n/);
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}

function parseThreadIdFromTopicKey(topicKey: string): number | null {
  if (topicKey === 'INDEX') return null;
  const idx = topicKey.lastIndexOf('_');
  if (idx === -1) return null;
  const part = topicKey.slice(idx + 1);
  return /^\d+$/.test(part) ? Number(part) : null;
}

function uniqueSlug(base: string, seen: Map<string, number>): string {
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

function sectionsToBrainDocs(
  content: string,
  mtimeIso: string,
  filePath: string,
  topicKey: string
): DocRow[] {
  const threadId = parseThreadIdFromTopicKey(topicKey);
  const seen = new Map<string, number>();
  const docs: DocRow[] = [];
  for (const s of extractHashHashSections(content)) {
    if (s.body.trim().length === 0) continue;
    const slug = uniqueSlug(slugHeading(s.heading), seen);
    docs.push({
      doc_id: `brain:${topicKey}:${slug}`,
      source: 'brain',
      ref_json: JSON.stringify({ file: filePath, heading: s.heading }),
      ts: mtimeIso,
      thread_id: threadId,
      role: null,
      title: s.heading,
      text: s.body,
    });
  }
  return docs;
}

function indexTopicBrains(db: Database.Database, stmts: UpsertStmts, dir: string): IndexStats {
  const total = zeroStats();
  if (!existsSync(dir)) return total;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }

  const discovered: Array<{ filePath: string; topicKey: string }> = [];
  for (const e of entries) {
    if (e.isFile() && e.name === 'INDEX.md') {
      discovered.push({ filePath: resolvePath(join(dir, e.name)), topicKey: 'INDEX' });
    } else if (e.isDirectory()) {
      const brainPath = join(dir, e.name, 'BRAIN.md');
      if (existsSync(brainPath)) {
        discovered.push({ filePath: resolvePath(brainPath), topicKey: e.name });
      }
    }
  }

  const seen = new Set<string>();
  for (const { filePath, topicKey } of discovered) {
    const cursorKey = `md:${filePath}`;
    seen.add(cursorKey);
    const prefix = `brain:${topicKey}:`;
    const stats = reindexOneFile(db, stmts, cursorKey, filePath, prefix, (content, mtimeIso, fp) =>
      sectionsToBrainDocs(content, mtimeIso, fp, topicKey)
    );
    addInto(total, stats);
  }

  for (const { key, filePath } of findVanishedFileCursors(db, dir, seen)) {
    const fileBase = basename(filePath);
    const topicKey = fileBase === 'INDEX.md' ? 'INDEX' : basename(dirname(filePath));
    const prefix = `brain:${topicKey}:`;
    const oldIds = listDocIdsByPrefix(db, prefix);
    deleteDocIds(stmts, oldIds);
    total.deleted += oldIds.length;
    deleteCursor(db, key);
  }

  return total;
}

// --- kb: one '## ' section per *.md file in a flat directory ------------

function sectionsToKbDocs(content: string, mtimeIso: string, filePath: string, filename: string): DocRow[] {
  const seen = new Map<string, number>();
  const docs: DocRow[] = [];
  for (const s of extractHashHashSections(content)) {
    if (s.body.trim().length === 0) continue;
    const slug = uniqueSlug(slugHeading(s.heading), seen);
    docs.push({
      doc_id: `kb:${filename}:${slug}`,
      source: 'kb',
      ref_json: JSON.stringify({ file: filePath, heading: s.heading }),
      ts: mtimeIso,
      thread_id: null,
      role: null,
      title: s.heading,
      text: s.body,
    });
  }
  return docs;
}

function indexKbDir(db: Database.Database, stmts: UpsertStmts, dir: string): IndexStats {
  const total = zeroStats();
  if (!existsSync(dir)) return total;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return total;
  }

  const seen = new Set<string>();
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue;
    const filePath = resolvePath(join(dir, e.name));
    const cursorKey = `md:${filePath}`;
    seen.add(cursorKey);
    const prefix = `kb:${e.name}:`;
    const stats = reindexOneFile(db, stmts, cursorKey, filePath, prefix, (content, mtimeIso, fp) =>
      sectionsToKbDocs(content, mtimeIso, fp, e.name)
    );
    addInto(total, stats);
  }

  for (const { key, filePath } of findVanishedFileCursors(db, dir, seen)) {
    const filename = basename(filePath);
    const prefix = `kb:${filename}:`;
    const oldIds = listDocIdsByPrefix(db, prefix);
    deleteDocIds(stmts, oldIds);
    total.deleted += oldIds.length;
    deleteCursor(db, key);
  }

  return total;
}

// --- review: one doc per review-digest-pending.jsonl entry --------------

function contentToReviewDocs(content: string): DocRow[] {
  const docs: DocRow[] = [];
  for (const raw of content.split(/\r\n|\n/)) {
    if (raw.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string') continue;
    const newText = typeof e.new_text === 'string' ? e.new_text : '';
    const existingText = typeof e.existing_text === 'string' ? e.existing_text : '';
    const text = `${newText}\n${existingText}`;
    if (text.trim().length === 0) continue;
    const key = typeof e.key === 'string' ? e.key : 'unknown';
    docs.push({
      doc_id: `review:${e.id}`,
      source: 'review',
      ref_json: JSON.stringify(e),
      ts: typeof e.created_at === 'string' ? e.created_at : null,
      thread_id: null,
      role: null,
      title: `conflict ${key}`,
      text,
    });
  }
  return docs;
}

function indexReviewDigest(db: Database.Database, stmts: UpsertStmts, path: string): IndexStats {
  const filePath = resolvePath(path);
  const cursorKey = `md:${filePath}`;
  return reindexOneFile(db, stmts, cursorKey, filePath, 'review:', (content) =>
    contentToReviewDocs(content)
  );
}

// --- decisions: one doc per decision row (AI-164) -------------------------

/** Build one recall doc from a decisions.sqlite row.
 *  The doc text deliberately EXCLUDES outcome/reaction (immutable fields only —
 *  no re-index needed when those mutable columns are filled).
 *  ref_json captures the full first-index snapshot for future consumers.
 *  §3.3/C2, §2.5 */
function buildDecisionDoc(parsed: unknown): DocRow | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;

  // Defensive parsing: decision_id is required and must be a string
  const decisionId = typeof row.decision_id === 'string' ? row.decision_id : null;
  if (!decisionId) return null;

  const skill = typeof row.skill === 'string' ? row.skill : 'bot';
  const decision = typeof row.decision === 'string' ? row.decision : '';
  const source = typeof row.source === 'string' ? row.source : 'bot';

  // Title: "<skill or source> · <decision.slice(0,60)>"
  const title = `${skill} · ${decision.slice(0, 60)}`;

  // Text: request_excerpt + decision + rationale + all alternatives (newline-joined)
  const requestExcerpt = typeof row.request_excerpt === 'string' ? row.request_excerpt : '';
  const rationale = typeof row.rationale === 'string' ? row.rationale : '';
  // alternatives arrives from the raw SQL SELECT as a JSON TEXT string
  // ('["a","b"]'), not an array — parse it (integrator fix 2026-08-27: the
  // original Array.isArray-only check silently dropped every alternative from
  // the doc text while fixtures only asserted rationale, so gates stayed green).
  let alternatives: string[] = [];
  if (typeof row.alternatives === 'string' && row.alternatives.trim() !== '') {
    try {
      const parsed = JSON.parse(row.alternatives);
      if (Array.isArray(parsed)) alternatives = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // malformed JSON column value — keep []
    }
  } else if (Array.isArray(row.alternatives)) {
    alternatives = (row.alternatives as unknown[]).filter((x): x is string => typeof x === 'string');
  }
  const text = [requestExcerpt, decision, rationale, ...alternatives].join('\n').trim();

  // Empty text after trim ⇒ skip this row
  if (text.length === 0) return null;

  const threadId = typeof row.thread_id === 'number' ? row.thread_id : null;

  // ref_json: first-index snapshot of mutable fields (outcome/reaction) —
  // per spec §2.5, these are NULL at first index even if the decisions row
  // already has values (AI-165/AI-168 read live values from decisions.sqlite,
  // not from recall).
  const refJson: Record<string, unknown> = {
    decision_id: decisionId,
    skill,
    source,
    refId: typeof row.refId === 'string' ? row.refId : null,
    session_id: typeof row.session_id === 'string' ? row.session_id : null,
    thread_id: threadId,
    chat_id: typeof row.chat_id === 'number' ? row.chat_id : null,
    message_id: typeof row.message_id === 'number' ? row.message_id : null,
    outcome: null,  // First-index snapshot: always NULL (consumer reads live from decisions.sqlite)
    reaction: null,  // First-index snapshot: always NULL (consumer reads live from decisions.sqlite)
  };

  return {
    doc_id: `decision:${decisionId}`,
    source: 'decisions',
    ref_json: JSON.stringify(refJson),
    ts: typeof row.ts === 'string' ? row.ts : null,
    thread_id: threadId,
    role: null,
    title,
    text,
  };
}

/** Index the decisions.sqlite source (rowid watermark cursor, reset rule).
 *  §3.3/C3 */
function indexDecisionsSource(
  db: Database.Database,
  stmts: UpsertStmts,
  src: { dbPath: string }
): IndexStats {
  const dbPath = resolvePath(src.dbPath);

  // Absent file is a skip, not a failure
  if (!existsSync(dbPath)) {
    return zeroStats();
  }

  const stats = zeroStats();
  const cursorKey = `rowid:${dbPath}`;

  try {
    // Open SECOND connection readonly (decisions.sqlite is external, may be locked by bot)
    const decisionsDb = new Database(dbPath, { readonly: true });
    decisionsDb.pragma('busy_timeout = 3000');

    try {
      // Reset rule: if SELECT MAX(rowid) FROM decisions < stored cursor rowid,
      // the DB was recreated — reset to 0 and re-read (§3.3/C3).
      const maxRowid = decisionsDb.prepare('SELECT MAX(rowid) as m FROM decisions').get() as { m: number | null } | undefined;
      const maxRow = maxRowid?.m ?? 0;

      const cur = getCursorRaw(db, cursorKey) as { rowid?: number } | null;
      let startRowid = typeof cur?.rowid === 'number' ? cur.rowid : 0;

      // Reset rule: if we have a cursor and max rowid <= cursor, DB was recreated
      if (cur && maxRow <= startRowid && maxRow > 0) {
        // Delete all existing decision docs (DB was recreated, start fresh)
        const oldDocIds = listDocIdsByPrefix(db, 'decision:');
        if (oldDocIds.length > 0) {
          for (const docId of oldDocIds) {
            stmts.deleteDoc.run(docId);
            stmts.deleteFts.run(docId);
          }
          stats.deleted = oldDocIds.length;
        }
        startRowid = 0;
      }

      // Batch read: 5000 rows per SELECT
      const rows = decisionsDb.prepare(
        'SELECT rowid AS _rowid, decision_id, refId, session_id, thread_id, source, skill, request_excerpt, context_refs, decision, rationale, alternatives, outcome, reaction, chat_id, message_id, ts FROM decisions WHERE rowid > ? ORDER BY rowid LIMIT 5000'
      ).all(startRowid) as Array<{
        _rowid: number;
        [key: string]: unknown;
      }>;

      for (const row of rows) {
        const doc = buildDecisionDoc(row);
        if (doc) {
          const existed = upsertDoc(stmts, doc);
          if (existed === 'added') stats.added++;
          else stats.updated++;
        }

        // Track max consumed rowid for cursor
        const rowid = typeof row._rowid === 'number' ? row._rowid : 0;
        if (rowid > startRowid) startRowid = rowid;
      }

      setCursor(db, cursorKey, JSON.stringify({ rowid: startRowid }));
    } finally {
      decisionsDb.close();
    }
  } catch (error) {
    // A broken decisions.sqlite must never kill the whole index pass
    logger.warn('recall-store', 'decisions source unreadable', {
      dbPath,
      error: (error as Error).message,
    });
    return zeroStats();
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Full source pass (shared by indexRecall / rebuildRecall / queryRecall's
// incremental refresh) — one db.transaction(...) per source (§3.3).
// ---------------------------------------------------------------------------

function runFullSourcePass(
  db: Database.Database,
  sources: RecallSources
): Record<string, IndexStats> {
  const stmts = prepareUpsertStmts(db);
  const result: Record<string, IndexStats> = {};

  if (sources.conversation) {
    const t0 = Date.now();
    const s = db.transaction(() =>
      indexJsonlSource(db, stmts, sources.conversation!, '-conversation-history.jsonl', buildConversationDoc)
    )();
    s.ms = Date.now() - t0;
    result.conversation = s;
  }
  if (sources.traces) {
    const t0 = Date.now();
    const s = db.transaction(() =>
      indexJsonlSource(db, stmts, sources.traces!, '-turn-traces.jsonl', buildTraceDoc)
    )();
    s.ms = Date.now() - t0;
    result.trace = s;
  }
  if (sources.topicBrains) {
    const t0 = Date.now();
    const s = db.transaction(() => indexTopicBrains(db, stmts, sources.topicBrains!.dir))();
    s.ms = Date.now() - t0;
    result.brain = s;
  }
  if (sources.kb) {
    const t0 = Date.now();
    const s = db.transaction(() => indexKbDir(db, stmts, sources.kb!.dir))();
    s.ms = Date.now() - t0;
    result.kb = s;
  }
  if (sources.reviewDigest) {
    const t0 = Date.now();
    const s = db.transaction(() => indexReviewDigest(db, stmts, sources.reviewDigest!.path))();
    s.ms = Date.now() - t0;
    result.review = s;
  }
  if (sources.decisions) {
    const t0 = Date.now();
    const s = db.transaction(() => indexDecisionsSource(db, stmts, sources.decisions!))();
    s.ms = Date.now() - t0;
    result.decisions = s;
  }

  return result;
}

function needsRefresh(db: Database.Database, refreshIfOlderThanMs: number): boolean {
  const row = db.prepare('SELECT MIN(updated_at) as m, COUNT(*) as c FROM cursors').get() as {
    m: string | null;
    c: number;
  };
  if (!row || row.c === 0 || !row.m) return true;
  const age = Date.now() - Date.parse(row.m);
  return age >= refreshIfOlderThanMs;
}

// ---------------------------------------------------------------------------
// Query (§3.3/C4 — ported literally from store/fts.py)
// ---------------------------------------------------------------------------

interface RawHitRow {
  doc_id: string;
  source: string;
  ts: string | null;
  thread_id: number | null;
  role: string | null;
  title: string;
  ref_json: string;
  snippet: string;
}

function buildFilters(query: RecallQuery): { clauses: string[]; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (query.thread !== undefined) {
    clauses.push('d.thread_id = ?');
    params.push(query.thread);
  }
  if (query.source !== undefined) {
    clauses.push('d.source = ?');
    params.push(query.source);
  }
  if (query.role !== undefined) {
    clauses.push('d.role = ?');
    params.push(query.role);
  }
  if (query.since !== undefined) {
    clauses.push('d.ts >= ?');
    params.push(query.since);
  }
  if (query.until !== undefined) {
    clauses.push("d.ts <= ? || 'T99'");
    params.push(query.until);
  }
  return { clauses, params };
}

function toHit(r: RawHitRow, rescue: boolean): RecallHit {
  let ref: Record<string, unknown> = {};
  try {
    ref = JSON.parse(r.ref_json);
  } catch {
    ref = {};
  }
  return {
    doc_id: r.doc_id,
    source: r.source,
    ts: r.ts,
    thread_id: r.thread_id,
    role: r.role,
    title: r.title,
    snippet: r.snippet,
    ref,
    rescue,
  };
}

const SELECT_COLS = `d.doc_id, d.source, d.ts, d.thread_id, d.role, d.title, d.ref_json,
      snippet(docs_fts, 2, '[', ']', ' … ', 12) AS snippet`;

function runQuery(db: Database.Database, query: RecallQuery, indexed: IndexStats | null): RecallQueryResult {
  const limit = clampLimit(query.limit);
  try {
    const safe = ftsSanitize(query.q);
    if (safe === null) {
      return { ok: true, total: 0, limit, note: null, indexed, hits: [] };
    }

    const { clauses, params } = buildFilters(query);
    const whereExtra = clauses.length ? ' AND ' + clauses.join(' AND ') : '';

    const andSql = `SELECT ${SELECT_COLS} FROM docs_fts f JOIN docs d ON d.doc_id = f.doc_id
      WHERE docs_fts MATCH ?${whereExtra} ORDER BY bm25(docs_fts) LIMIT ?`;
    const andRows = db.prepare(andSql).all(safe, ...params, limit) as RawHitRow[];

    const totalSql = `SELECT COUNT(*) as c FROM docs_fts f JOIN docs d ON d.doc_id = f.doc_id
      WHERE docs_fts MATCH ?${whereExtra}`;
    const total = (db.prepare(totalSql).get(safe, ...params) as { c: number }).c;

    let orRows: RawHitRow[] = [];
    const orForm = ftsOrForm(query.q);
    if (andRows.length < limit && orForm !== null) {
      const remaining = limit - andRows.length;
      const excludeIds = andRows.map((r) => r.doc_id);
      const notIn = excludeIds.length
        ? ` AND d.doc_id NOT IN (${excludeIds.map(() => '?').join(',')})`
        : '';
      const orSql = `SELECT ${SELECT_COLS} FROM docs_fts f JOIN docs d ON d.doc_id = f.doc_id
        WHERE docs_fts MATCH ?${whereExtra}${notIn} ORDER BY bm25(docs_fts) LIMIT ?`;
      orRows = db.prepare(orSql).all(orForm, ...params, ...excludeIds, remaining) as RawHitRow[];
    }

    const hits: RecallHit[] = [
      ...andRows.map((r) => toHit(r, false)),
      ...orRows.map((r) => toHit(r, true)),
    ];
    const note =
      orRows.length > 0
        ? `${orRows.length} of ${hits.length} rows are OR-rescue matches (fewer than ${limit} rows matched all terms)`
        : null;

    return { ok: true, total, limit, note, indexed, hits };
  } catch (err) {
    logger.warn('recall-store', 'fts query failed', { error: String(err) });
    return { ok: true, total: 0, limit, note: null, indexed, hits: [] };
  }
}

// ---------------------------------------------------------------------------
// Public API (§3.3/C1 — frozen)
// ---------------------------------------------------------------------------

/** Incremental pass over every non-null source. Opens, indexes, closes. */
export function indexRecall(dbPath: string, sources: RecallSources): RecallIndexResult {
  const db = openStore(dbPath);
  try {
    const t0 = Date.now();
    const perSource = runFullSourcePass(db, sources);
    const indexed = combineStats(Object.values(perSource));
    indexed.ms = Date.now() - t0;
    return { ok: true, indexed, sources: perSource };
  } finally {
    db.close();
  }
}

/** Drops docs/docs_fts/cursors, recreates the schema, then indexes everything. */
export function rebuildRecall(dbPath: string, sources: RecallSources): RecallIndexResult {
  const db = openStore(dbPath);
  try {
    dropDataTables(db);
    createSchema(db);
    const t0 = Date.now();
    const perSource = runFullSourcePass(db, sources);
    const indexed = combineStats(Object.values(perSource));
    indexed.ms = Date.now() - t0;
    return { ok: true, indexed, sources: perSource };
  } finally {
    db.close();
  }
}

/** Query. Runs an incremental pass FIRST when the oldest cursor is older than
 *  `refreshIfOlderThanMs` or any non-null source has no cursor; `indexed`
 *  reports it. */
export function queryRecall(
  dbPath: string,
  sources: RecallSources,
  query: RecallQuery,
  refreshIfOlderThanMs: number = RECALL_REFRESH_MS
): RecallQueryResult {
  const db = openStore(dbPath);
  try {
    let indexed: IndexStats | null = null;
    if (needsRefresh(db, refreshIfOlderThanMs)) {
      const t0 = Date.now();
      const perSource = runFullSourcePass(db, sources);
      indexed = combineStats(Object.values(perSource));
      indexed.ms = Date.now() - t0;
    }
    return runQuery(db, query, indexed);
  } finally {
    db.close();
  }
}
