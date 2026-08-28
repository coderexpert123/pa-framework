import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { resetRedactCache } from '../src/lib/redact.js';
import {
  ftsSanitize,
  ftsOrForm,
  clampLimit,
  slugHeading,
  indexRecall,
  rebuildRecall,
  queryRecall,
  type RecallSources,
} from '../src/lib/recall-store.js';

let dir: string;

beforeEach(async () => {
  dir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(dir);
});

function emptySources(): RecallSources {
  return { conversation: null, traces: null, topicBrains: null, kb: null, reviewDigest: null, decisions: null };
}

function convTurn(fields: Record<string, unknown>): string {
  return JSON.stringify({ role: 'user', timestamp: '2026-01-01T00:00:00.000Z', thread_id: 1, ...fields }) + '\n';
}

function dbIntrospect(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const docs = db.prepare('SELECT doc_id, source, ts, thread_id, role, title, text FROM docs').all() as Array<{
      doc_id: string;
      source: string;
      ts: string | null;
      thread_id: number | null;
      role: string | null;
      title: string;
      text: string;
    }>;
    return docs;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('ftsSanitize wraps tokens in double quotes (implicit AND)', () => {
    assert.equal(ftsSanitize('vendor-neutral based'), '"vendor" "neutral" "based"');
  });

  it('ftsSanitize returns null for empty or punctuation-only input', () => {
    assert.equal(ftsSanitize(''), null);
    assert.equal(ftsSanitize('   '), null);
    assert.equal(ftsSanitize('...---!!!'), null);
  });

  it('ftsSanitize preserves unicode tokens', () => {
    assert.equal(ftsSanitize('café naïve'), '"café" "naïve"');
  });

  it('ftsOrForm is null for one token, OR-joined for two or more', () => {
    assert.equal(ftsOrForm('solo'), null);
    assert.equal(ftsOrForm(''), null);
    assert.equal(ftsOrForm('a b'), '"a" OR "b"');
    assert.equal(ftsOrForm('a b c'), '"a" OR "b" OR "c"');
  });

  it('clampLimit follows the frozen formula exactly', () => {
    assert.equal(clampLimit(500), 50);
    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(undefined), 10);
    assert.equal(clampLimit('7'), 7);
    assert.equal(clampLimit(NaN), 10);
  });

  it('slugHeading collapses non-alnum runs, trims dashes, truncates to 60', () => {
    assert.equal(slugHeading('Hello, World!'), 'hello-world');
    assert.equal(slugHeading('  --Leading and Trailing--  '), 'leading-and-trailing');
    const long = 'Section '.repeat(20); // well over 60 chars once slugged
    const slug = slugHeading(long);
    assert.ok(slug.length <= 60);
    assert.equal(slug, slugHeading(long).slice(0, 60));
  });
});

// ---------------------------------------------------------------------------
// Query semantics: AND / OR rescue, limit, filters, snippet
// ---------------------------------------------------------------------------

describe('query semantics', () => {
  it('AND pass first, then OR-rescue rows appended with rescue:true and an AND-anchored total', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    const lines = [
      convTurn({ text: 'alpha bravo charlie', thread_id: 1 }), // has BOTH terms
      convTurn({ text: 'alpha only delta', thread_id: 2 }), // has one term
      convTurn({ text: 'bravo only echo', thread_id: 3 }), // has one term
    ];
    writeFileSync(convLive, lines.join(''), 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    indexRecall(join(dir, 'recall.sqlite'), sources);

    const result = queryRecall(join(dir, 'recall.sqlite'), sources, { q: 'alpha bravo', limit: 5 });
    assert.equal(result.total, 1); // AND-anchored, not the OR count
    assert.equal(result.hits.length, 3); // 1 AND hit + 2 OR-rescue hits
    assert.equal(result.hits[0].rescue, false);
    assert.ok(result.hits.slice(1).every((h) => h.rescue === true));
    assert.ok(result.note && /OR-rescue/.test(result.note));
  });

  it('no rescue rows when the AND pass already fills the limit', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    const lines = [convTurn({ text: 'alpha bravo one' }), convTurn({ text: 'alpha bravo two' })];
    writeFileSync(convLive, lines.join(''), 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    indexRecall(join(dir, 'recall.sqlite'), sources);

    const result = queryRecall(join(dir, 'recall.sqlite'), sources, { q: 'alpha bravo', limit: 2 });
    assert.equal(result.hits.length, 2);
    assert.ok(result.hits.every((h) => h.rescue === false));
    assert.equal(result.note, null);
  });

  it('limit is clamped to RECALL_MAX_LIMIT and the result reports the clamped value', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push(convTurn({ text: `clamptoken row ${i}`, thread_id: i }));
    writeFileSync(convLive, lines.join(''), 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    indexRecall(join(dir, 'recall.sqlite'), sources);

    const result = queryRecall(join(dir, 'recall.sqlite'), sources, { q: 'clamptoken', limit: 500 });
    assert.equal(result.limit, 50);
    assert.ok(result.hits.length <= 50);
  });

  it('thread / source / role / since / until filters narrow both hits and total', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    const lines = [
      convTurn({ text: 'filtertoken one', role: 'user', thread_id: 100, timestamp: '2026-01-01T00:00:00.000Z' }),
      convTurn({ text: 'filtertoken two', role: 'assistant', thread_id: 100, timestamp: '2026-06-01T00:00:00.000Z' }),
      convTurn({ text: 'filtertoken three', role: 'user', thread_id: 200, timestamp: '2026-03-01T00:00:00.000Z' }),
      // Deliberately near end-of-day to prove the `until` bare-date whole-day-inclusion rule.
      convTurn({ text: 'filtertoken four', role: 'user', thread_id: 300, timestamp: '2026-02-01T23:59:00.000Z' }),
    ];
    writeFileSync(convLive, lines.join(''), 'utf8');

    const tracesLive = join(dir, 'turn-traces.jsonl');
    writeFileSync(
      tracesLive,
      JSON.stringify({
        v: 1,
        run_id: '22222222-2222-2222-2222-222222222222',
        ts_start: '2026-01-01T00:00:00.000Z',
        worker: 'agy',
        origin: 'skill',
        outcome: 'ok',
        exit_code: 0,
        tool_calls: [],
        commands: ['filtertoken command'],
        errors: [],
      }) + '\n',
      'utf8'
    );

    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
      traces: { live: tracesLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    indexRecall(dbPath, sources);

    const all = queryRecall(dbPath, sources, { q: 'filtertoken' });
    assert.equal(all.total, 5); // 4 conversation + 1 trace

    const byThread = queryRecall(dbPath, sources, { q: 'filtertoken', thread: 100 });
    assert.equal(byThread.total, 2);

    const byRole = queryRecall(dbPath, sources, { q: 'filtertoken', role: 'user' });
    assert.equal(byRole.total, 3);

    const bySource = queryRecall(dbPath, sources, { q: 'filtertoken', source: 'trace' });
    assert.equal(bySource.total, 1);
    assert.equal(bySource.hits[0].source, 'trace');

    const bySince = queryRecall(dbPath, sources, { q: 'filtertoken', since: '2026-02-15' });
    assert.equal(bySince.total, 2); // the March turn and the June turn are both after 2026-02-15

    const byUntil = queryRecall(dbPath, sources, { q: 'filtertoken', until: '2026-02-01' });
    // Includes the Jan turn AND the 23:59 Feb-1 turn (whole-day inclusion via the 'T99' suffix)
    // AND the trace doc (also ts 2026-01-01), but not March or June.
    assert.equal(byUntil.total, 3);
  });

  it('every hit carries a non-empty snippet bracketed with [ and ]', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    writeFileSync(convLive, convTurn({ text: 'snippettoken visible in context' }), 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    indexRecall(dbPath, sources);
    const result = queryRecall(dbPath, sources, { q: 'snippettoken' });
    assert.ok(result.hits.length >= 1);
    for (const hit of result.hits) {
      assert.ok(hit.snippet.length > 0);
      assert.ok(hit.snippet.includes('['));
      assert.ok(hit.snippet.includes(']'));
    }
  });
});

// ---------------------------------------------------------------------------
// Conversation cursor: incremental, rotation, torn lines
// ---------------------------------------------------------------------------

describe('conversation cursor', () => {
  it('incremental indexing only adds newly appended lines, with byte-exact offsets for multi-byte text', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    const line1 = convTurn({ text: 'first ascii line', thread_id: 1 });
    writeFileSync(convLive, line1, 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    const first = indexRecall(dbPath, sources);
    assert.equal(first.sources.conversation.added, 1);

    // A multi-byte line (emoji + accented text), then a plain marker line.
    const line2 = convTurn({ text: 'héllo wörld 😀 second line', thread_id: 1 });
    const line3 = convTurn({ text: 'third marker line', thread_id: 1 });
    appendFileSync(convLive, line2 + line3, 'utf8');

    const second = indexRecall(dbPath, sources);
    assert.equal(second.sources.conversation.added, 2);

    const expectedLine3Offset = Buffer.byteLength(line1, 'utf8') + Buffer.byteLength(line2, 'utf8');
    const found = queryRecall(dbPath, sources, { q: 'marker' });
    assert.equal(found.hits.length, 1);
    assert.equal(found.hits[0].doc_id, `conv:conversation-history.jsonl:${expectedLine3Offset}`);
    assert.equal(found.hits[0].ref.offset, expectedLine3Offset);
  });

  it('a rotation (file shrinks below the stored offset) resets the cursor to 0 with no duplicate doc_id', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    const lineA = convTurn({ text: 'pre-rotation alpha content' });
    const lineB = convTurn({ text: 'pre-rotation bravo content' });
    writeFileSync(convLive, lineA + lineB, 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    indexRecall(dbPath, sources);
    assert.ok(queryRecall(dbPath, sources, { q: 'alpha' }).total >= 1);

    // Simulate rotation: the live file is truncated and rewritten with shorter content
    // whose size is below the previously stored byte offset.
    const shortLine = convTurn({ text: 'post-rotation gamma' });
    writeFileSync(convLive, shortLine, 'utf8');
    assert.ok(shortLine.length < (lineA + lineB).length);

    const reindexed = indexRecall(dbPath, sources);
    assert.equal(reindexed.sources.conversation.added + reindexed.sources.conversation.updated, 1);

    const gamma = queryRecall(dbPath, sources, { q: 'gamma' });
    assert.equal(gamma.total, 1);
    assert.equal(gamma.hits[0].doc_id, 'conv:conversation-history.jsonl:0');

    // The old pre-rotation content at offset 0 was replaced, not duplicated.
    const alphaAfter = queryRecall(dbPath, sources, { q: 'alpha' });
    assert.equal(alphaAfter.total, 0);

    const docs = dbIntrospect(dbPath);
    const offsetZeroDocs = docs.filter((d) => d.doc_id === 'conv:conversation-history.jsonl:0');
    assert.equal(offsetZeroDocs.length, 1); // no duplicate row for the reused doc_id
  });

  it('a final line with no trailing newline is not indexed and the cursor does not advance past it', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    const complete = convTurn({ text: 'complete first line' });
    writeFileSync(convLive, complete, 'utf8');
    // Append a partial line fragment with NO trailing newline.
    const partialFragment = '{"role":"user","text":"tornlinetoken incomple';
    appendFileSync(convLive, partialFragment, 'utf8');

    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    const first = indexRecall(dbPath, sources);
    assert.equal(first.sources.conversation.added, 1); // only the complete line

    const notYet = queryRecall(dbPath, sources, { q: 'tornlinetoken' });
    assert.equal(notYet.total, 0);

    // Complete the line.
    const rest = 'te", "timestamp":"2026-01-01T00:05:00.000Z", "thread_id": 1}\n';
    appendFileSync(convLive, rest, 'utf8');
    const second = indexRecall(dbPath, sources);
    assert.equal(second.sources.conversation.added, 1); // indexed exactly once

    const now = queryRecall(dbPath, sources, { q: 'tornlinetoken' });
    assert.equal(now.total, 1);
  });
});

// ---------------------------------------------------------------------------
// Markdown re-section (brain source)
// ---------------------------------------------------------------------------

describe('markdown re-section (brain source)', () => {
  it('a heading rename removes the old section doc and adds the new one; an unchanged file adds nothing; a deleted file removes its docs', () => {
    const topicDir = join(dir, 'topic-brains', 'mytopic');
    mkdirSync(topicDir, { recursive: true });
    const brainPath = join(topicDir, 'BRAIN.md');
    writeFileSync(
      brainPath,
      '# mytopic\n\n## Section One\nbody one uniquetoken1\n\n## Section Two\nbody two uniquetoken2\n',
      'utf8'
    );
    const sources: RecallSources = { ...emptySources(), topicBrains: { dir: join(dir, 'topic-brains') } };
    const dbPath = join(dir, 'recall.sqlite');

    const first = indexRecall(dbPath, sources);
    assert.equal(first.sources.brain.added, 2);
    assert.equal(queryRecall(dbPath, sources, { q: 'uniquetoken1' }).total, 1);
    assert.equal(queryRecall(dbPath, sources, { q: 'uniquetoken2' }).total, 1);

    // Unchanged file: re-indexing adds nothing.
    const unchanged = indexRecall(dbPath, sources);
    assert.deepEqual(
      { added: unchanged.sources.brain.added, updated: unchanged.sources.brain.updated, deleted: unchanged.sources.brain.deleted },
      { added: 0, updated: 0, deleted: 0 }
    );

    // Rename "Section Two" -> a different heading (different slug).
    writeFileSync(
      brainPath,
      '# mytopic\n\n## Section One\nbody one uniquetoken1\n\n## Section Two Renamed\nbody two uniquetoken2\n',
      'utf8'
    );
    const renamed = indexRecall(dbPath, sources);
    assert.equal(renamed.sources.brain.added, 1); // section-two-renamed
    assert.equal(renamed.sources.brain.updated, 1); // section-one round-trips
    assert.equal(renamed.sources.brain.deleted, 1); // old section-two gone

    const renamedHit = queryRecall(dbPath, sources, { q: 'uniquetoken2' });
    assert.equal(renamedHit.total, 1);
    assert.equal(renamedHit.hits[0].title, 'Section Two Renamed');

    // Delete the file entirely.
    unlinkSync(brainPath);
    const afterDelete = indexRecall(dbPath, sources);
    assert.equal(afterDelete.sources.brain.deleted, 2);
    assert.equal(queryRecall(dbPath, sources, { q: 'uniquetoken1' }).total, 0);
    assert.equal(queryRecall(dbPath, sources, { q: 'uniquetoken2' }).total, 0);
  });
});

// ---------------------------------------------------------------------------
// Trace doc
// ---------------------------------------------------------------------------

describe('trace doc', () => {
  it('one turn-traces.jsonl line becomes one doc whose text carries tool names, commands and errors', () => {
    const tracesLive = join(dir, 'turn-traces.jsonl');
    const runId = '33333333-3333-3333-3333-333333333333';
    writeFileSync(
      tracesLive,
      JSON.stringify({
        v: 1,
        run_id: runId,
        ts_start: '2026-08-24T00:00:00.000Z',
        worker: 'agy',
        origin: 'skill',
        outcome: 'ok',
        exit_code: 0,
        thread_id: 42,
        tool_calls: [{ n: 1, name: 'run_command', arg: 'npm test', ok: true }],
        commands: ['npm test'],
        files: ['D:/Personal Assistant/pa/src/worker-exec.ts'],
        errors: ['boom: something failed'],
      }) + '\n',
      'utf8'
    );
    const sources: RecallSources = {
      ...emptySources(),
      traces: { live: tracesLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    indexRecall(dbPath, sources);

    for (const term of ['run_command', 'npm', 'boom']) {
      const result = queryRecall(dbPath, sources, { q: term });
      assert.equal(result.total, 1, `expected exactly 1 hit for "${term}"`);
      assert.equal(result.hits[0].doc_id, `trace:${runId}`);
    }

    const docs = dbIntrospect(dbPath);
    const traceDoc = docs.find((d) => d.doc_id === `trace:${runId}`)!;
    assert.ok(traceDoc);
    assert.equal(traceDoc.thread_id, 42);
    assert.equal(traceDoc.role, null);
    // ref_json (not directly readable via dbIntrospect's projection) must NOT retain the
    // text-derived arrays — verified through the module's public query result instead.
    const hit = queryRecall(dbPath, sources, { q: 'run_command' }).hits[0];
    assert.ok(!('tool_calls' in hit.ref));
    assert.ok(!('commands' in hit.ref));
    assert.ok(!('errors' in hit.ref));
    assert.equal(hit.ref.worker, 'agy');
  });
});

// ---------------------------------------------------------------------------
// Absent sources
// ---------------------------------------------------------------------------

describe('absent sources', () => {
  it('a null source and a missing live file both produce no error and no docs', () => {
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: join(dir, 'does-not-exist.jsonl'), archiveDir: join(dir, 'does-not-exist-archive') },
      kb: null,
    };
    const dbPath = join(dir, 'recall.sqlite');
    const result = indexRecall(dbPath, sources);
    assert.equal(result.sources.conversation.added, 0);
    assert.equal(result.sources.conversation.updated, 0);
    assert.equal(result.sources.conversation.deleted, 0);
    assert.ok(!('kb' in result.sources));
    assert.ok(!('trace' in result.sources));
    assert.ok(!('brain' in result.sources));
    assert.ok(!('review' in result.sources));
  });
});

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

describe('rebuild', () => {
  it('rebuildRecall reproduces the same doc count and doc_id set as the original index', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    writeFileSync(
      convLive,
      [convTurn({ text: 'rebuild alpha' }), convTurn({ text: 'rebuild bravo' })].join(''),
      'utf8'
    );
    const topicDir = join(dir, 'topic-brains', 'rt');
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, 'BRAIN.md'), '## Only Section\nrebuild charlie content\n', 'utf8');

    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
      topicBrains: { dir: join(dir, 'topic-brains') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    indexRecall(dbPath, sources);
    const before = dbIntrospect(dbPath)
      .map((d) => d.doc_id)
      .sort();

    rebuildRecall(dbPath, sources);
    const after = dbIntrospect(dbPath)
      .map((d) => d.doc_id)
      .sort();

    assert.deepEqual(after, before);
    assert.ok(before.length >= 3);
  });
});

// ---------------------------------------------------------------------------
// Foreign schema
// ---------------------------------------------------------------------------

describe('foreign schema', () => {
  it('a DB with schema_version=99 is rebuilt rather than thrown on', () => {
    const dbPath = join(dir, 'recall.sqlite');
    const foreign = new Database(dbPath);
    foreign.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO meta (k, v) VALUES ('schema_version', '99');`);
    foreign.close();

    const convLive = join(dir, 'conversation-history.jsonl');
    writeFileSync(convLive, convTurn({ text: 'foreign schema recovers' }), 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };

    assert.doesNotThrow(() => indexRecall(dbPath, sources));

    const check = new Database(dbPath, { readonly: true });
    const row = check.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get() as { v: string };
    check.close();
    assert.equal(row.v, '1');
    assert.equal(queryRecall(dbPath, sources, { q: 'foreign' }).total, 1);
  });
});

// ---------------------------------------------------------------------------
// Refresh gating
// ---------------------------------------------------------------------------

describe('refresh gating', () => {
  it('a fresh cursor skips the incremental pass; a forced-stale threshold triggers one', () => {
    const convLive = join(dir, 'conversation-history.jsonl');
    writeFileSync(convLive, convTurn({ text: 'refresh gating token' }), 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    indexRecall(dbPath, sources); // sets the cursor's updated_at to "now"

    const fresh = queryRecall(dbPath, sources, { q: 'refresh' }, 10 * 60 * 1000);
    assert.equal(fresh.indexed, null);

    const stale = queryRecall(dbPath, sources, { q: 'refresh' }, 0);
    assert.notEqual(stale.indexed, null);
  });
});

// ---------------------------------------------------------------------------
// Redaction (C19 global rule: "every new outbound string passes
// redactSecrets"). NOT in §3.3's named test list or Tests section — the
// dispatch message asked for it explicitly and R3 assigns trace-object
// redaction to WP-A and recall OUTPUT-PATH redaction to WP-D, leaving
// index-time redaction of markdown/conversation text unassigned. Reported
// as a spec gap; implemented defensively here since it is cheap, matches
// C19's unqualified wording, and R3's WP-D redaction is idempotent against
// text already redacted at index time.
// ---------------------------------------------------------------------------

describe('redaction (spec-gap defensive test — see report)', () => {
  it('a planted secrets.env value is redacted out of indexed title/text before it reaches a query result', async () => {
    await createTempSecrets(dir, 'MY_SECRET_TOKEN=abcdefgh12345678\n');
    resetRedactCache();

    const convLive = join(dir, 'conversation-history.jsonl');
    writeFileSync(convLive, convTurn({ text: 'leaked token abcdefgh12345678 in the clear' }), 'utf8');
    const sources: RecallSources = {
      ...emptySources(),
      conversation: { live: convLive, archiveDir: join(dir, 'archive') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    indexRecall(dbPath, sources);

    const docs = dbIntrospect(dbPath);
    assert.equal(docs.length, 1);
    assert.ok(docs[0].text.includes('<redacted:'));
    assert.ok(!docs[0].text.includes('abcdefgh12345678'));

    const result = queryRecall(dbPath, sources, { q: 'leaked' });
    assert.equal(result.total, 1);
    assert.ok(!result.hits[0].snippet.includes('abcdefgh12345678'));

    resetRedactCache();
  });
});

// ---------------------------------------------------------------------------
// Decision source (AI-164, §3.3/C-tests)
// ---------------------------------------------------------------------------

describe('decision source', () => {
  it('fixture helper creates decisions.sqlite with 2 synthetic rows', async () => {
    const decisionsDb = join(dir, 'decisions.sqlite');
    const db = new Database(decisionsDb);
    try {
      // Create schema (§2.1 verbatim)
      db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(decision_id UNINDEXED, request_excerpt, decision, rationale);
CREATE INDEX IF NOT EXISTS decisions_thread_ts ON decisions(thread_id, ts);
CREATE INDEX IF NOT EXISTS decisions_chat_msg  ON decisions(chat_id, message_id);
      `);

      // Insert 2 synthetic rows
      const insert = db.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, alternatives, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('d-202608271200-ab12cd34ef56', 'skill', 'daily-mail-brief', 'Synthetic Sender - quarterly statement', 'excluded', 'Duplicate of an already-included thread', '["included"]', 4242, '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z');
      insert.run('d-202608271201-cd34ef56ab12', 'bot', 'reminders', 'synthetic reminder', 'snoozed 1 h', 'User deferred from keyboard', '["done"]', 9999, '2026-08-27T12:01:00.000Z', '2026-08-27T12:01:00.000Z');

      // Verify rows exist
      const rows = db.prepare('SELECT COUNT(*) as c FROM decisions').get() as { c: number };
      assert.equal(rows.c, 2);
    } finally {
      db.close();
    }
  });

  it('index creates 2 docs with decision:<id> doc_id, source=decisions, and rationale in text', async () => {
    const decisionsDb = join(dir, 'decisions.sqlite');
    const db = new Database(decisionsDb);
    try {
      db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
      `);
      const insert = db.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, alternatives, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('d-202608271200-ab12cd34ef56', 'skill', 'daily-mail-brief', 'Synthetic Sender - quarterly statement', 'excluded', 'Duplicate of an already-included thread', '["included"]', 4242, '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z');
      insert.run('d-202608271201-cd34ef56ab12', 'bot', 'reminders', 'synthetic reminder', 'snoozed 1 h', 'User deferred from keyboard', '["done"]', 9999, '2026-08-27T12:01:00.000Z', '2026-08-27T12:01:00.000Z');
    } finally {
      db.close();
    }

    const sources: RecallSources = {
      ...emptySources(),
      decisions: { dbPath: decisionsDb },
    };
    const dbPath = join(dir, 'recall.sqlite');
    const r = await indexRecall(dbPath, sources);
    assert.equal(r.ok, true);
    assert.equal(r.indexed?.added, 2);

    const docs = dbIntrospect(dbPath);
    assert.equal(docs.length, 2);

    const doc1 = docs.find((d) => d.doc_id === 'decision:d-202608271200-ab12cd34ef56');
    assert.ok(doc1);
    assert.equal(doc1.source, 'decisions');
    assert.equal(doc1.thread_id, 4242);
    assert.ok(doc1.text.includes('Duplicate of an already-included thread'));
    // alternatives arrive as a JSON TEXT string from the raw SELECT — the doc
    // text must carry the parsed entries (the dropped-alternatives regression).
    assert.ok(doc1.text.includes('included'), `alternatives entry missing from doc text: ${doc1.text}`);

    const doc2 = docs.find((d) => d.doc_id === 'decision:d-202608271201-cd34ef56ab12');
    assert.ok(doc2);
    assert.equal(doc2.source, 'decisions');
    assert.equal(doc2.thread_id, 9999);
    assert.ok(doc2.text.includes('User deferred from keyboard'));
  });

  it('queryRecall with source=decisions returns decision docs and total reflects filter', async () => {
    const decisionsDb = join(dir, 'decisions.sqlite');
    const db = new Database(decisionsDb);
    try {
      db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
      `);
      db.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('d-202608271200-ab12cd34ef56', 'skill', 'daily-mail-brief', 'quarterly statement', 'excluded', 'Duplicate of thread', 4242, '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z');
    } finally {
      db.close();
    }

    const sources: RecallSources = {
      ...emptySources(),
      decisions: { dbPath: decisionsDb },
    };
    const dbPath = join(dir, 'recall.sqlite');
    await indexRecall(dbPath, sources);

    const result = queryRecall(dbPath, sources, { q: 'quarterly', source: 'decisions' });
    assert.equal(result.ok, true);
    assert.equal(result.total, 1);
    assert.equal(result.hits[0].source, 'decisions');
    assert.ok(result.hits[0].snippet.includes('Duplicate'));
  });

  it('incremental: insert a 3rd row, re-index ⇒ added=1, first two docs not re-upserted', async () => {
    const decisionsDb = join(dir, 'decisions.sqlite');
    const db = new Database(decisionsDb);
    try {
      db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
      `);
      const insert = db.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run('d-202608271200-ab12cd34ef56', 'skill', 'daily-mail-brief', 'first', 'excluded', 'rationale one', 4242, '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z');
      insert.run('d-202608271201-cd34ef56ab12', 'bot', 'reminders', 'second', 'snoozed', 'rationale two', 9999, '2026-08-27T12:01:00.000Z', '2026-08-27T12:01:00.000Z');
    } finally {
      db.close();
    }

    const sources: RecallSources = {
      ...emptySources(),
      decisions: { dbPath: decisionsDb },
    };
    const dbPath = join(dir, 'recall.sqlite');
    const r1 = await indexRecall(dbPath, sources);
    assert.equal(r1.indexed?.added, 2);

    // Insert 3rd row
    const db2 = new Database(decisionsDb);
    try {
      db2.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('d-202608271202-ef56ab12cd34', 'skill', 'travel-butler', 'third', 'proposed', 'rationale three', 4242, '2026-08-27T12:02:00.000Z', '2026-08-27T12:02:00.000Z');
    } finally {
      db2.close();
    }

    const r2 = await indexRecall(dbPath, sources);
    assert.equal(r2.indexed?.added, 1);
    assert.equal(r2.indexed?.updated, 0);
    assert.equal(r2.sources.decisions?.added, 1);
    assert.equal(r2.sources.decisions?.updated, 0);
  });

  it('reset rule: rebuild decisions DB with lower rowids ⇒ next pass resets and re-indexes without duplicates', async () => {
    const decisionsDb = join(dir, 'decisions.sqlite');
    const db = new Database(decisionsDb);
    try {
      db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
      `);
      db.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('d-202608271200-ab12cd34ef56', 'skill', 'daily-mail-brief', 'old row', 'excluded', 'rationale', 4242, '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z');
    } finally {
      db.close();
    }

    const sources: RecallSources = {
      ...emptySources(),
      decisions: { dbPath: decisionsDb },
    };
    const dbPath = join(dir, 'recall.sqlite');
    const r1 = await indexRecall(dbPath, sources);
    assert.equal(r1.indexed?.added, 1);

    // Recreate DB (simulating recreation) - rowids reset to 1
    const db2 = new Database(decisionsDb);
    try {
      db2.exec('DROP TABLE IF EXISTS decisions');
      db2.exec(`
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
      `);
      db2.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('d-202608271201-cd34ef56ab12', 'bot', 'reminders', 'new row', 'snoozed', 'new rationale', 9999, '2026-08-27T12:01:00.000Z', '2026-08-27T12:01:00.000Z');
    } finally {
      db2.close();
    }

    const r2 = await indexRecall(dbPath, sources);
    assert.equal(r2.indexed?.added, 1);
    const docs = dbIntrospect(dbPath);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].doc_id, 'decision:d-202608271201-cd34ef56ab12');
  });

  it('absent DB: decisions source with nonexistent dbPath ⇒ no error, zero docs', async () => {
    const sources: RecallSources = {
      ...emptySources(),
      decisions: { dbPath: join(dir, 'does-not-exist.sqlite') },
    };
    const dbPath = join(dir, 'recall.sqlite');
    const r = await indexRecall(dbPath, sources);
    assert.equal(r.ok, true);
    assert.equal(r.indexed?.added, 0);
    assert.equal(r.indexed?.updated, 0);
    assert.equal(r.indexed?.deleted, 0);
  });

  it('immutability: filling outcome/reaction on an indexed row, re-index ⇒ text unchanged, ref_json is first-index snapshot', async () => {
    const decisionsDb = join(dir, 'decisions.sqlite');
    const db = new Database(decisionsDb);
    try {
      db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
      `);
      db.prepare(`
INSERT INTO decisions (decision_id, source, skill, request_excerpt, decision, rationale, thread_id, ts, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('d-202608271200-ab12cd34ef56', 'skill', 'daily-mail-brief', 'test', 'excluded', 'rationale', 4242, '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z');
    } finally {
      db.close();
    }

    const sources: RecallSources = {
      ...emptySources(),
      decisions: { dbPath: decisionsDb },
    };
    const dbPath = join(dir, 'recall.sqlite');
    await indexRecall(dbPath, sources);

    // Fill outcome/reaction in decisions DB
    const db2 = new Database(decisionsDb);
    try {
      db2.prepare('UPDATE decisions SET outcome = ?, reaction = ?, updated_at = ? WHERE decision_id = ?')
        .run('approved', '👍', '2026-08-27T12:05:00.000Z', 'd-202608271200-ab12cd34ef56');
    } finally {
      db2.close();
    }

    // Re-index
    await indexRecall(dbPath, sources);

    const docs = dbIntrospect(dbPath);
    assert.equal(docs.length, 1);
    const doc = docs[0];

    // text should NOT contain outcome/reaction (immutable fields only)
    assert.ok(!doc.text.includes('approved'));
    assert.ok(!doc.text.includes('👍'));

    // ref_json should be the first-index snapshot (outcome/reaction are NULL in snapshot)
    const ref = JSON.parse(doc.title?.includes('daily-mail-brief') ? '{}' : '{}');
    const recallDb = new Database(dbPath);
    try {
      const row = recallDb.prepare('SELECT ref_json FROM docs WHERE doc_id = ?').get('decision:d-202608271200-ab12cd34ef56') as { ref_json: string };
      const refJson = JSON.parse(row.ref_json);
      assert.equal(refJson.outcome, null);
      assert.equal(refJson.reaction, null);
    } finally {
      recallDb.close();
    }
  });
});
