import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sqliteExec, sqliteRun, sqliteQuery } from '../src/lib/db.js';

let scratchDir: string;

beforeEach(async () => {
  scratchDir = join(tmpdir(), `pa-test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scratchDir, { recursive: true });
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

describe('sqlite helper (pa/src/lib/db.ts)', () => {
  it('sqliteExec creates the db file and applies schema', () => {
    const dbPath = join(scratchDir, 'exec.db');
    assert.ok(!existsSync(dbPath));
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    assert.ok(existsSync(dbPath));
  });

  it('sqliteExec runs multiple statements in one call', () => {
    const dbPath = join(scratchDir, 'multi.db');
    sqliteExec(dbPath, `
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE TABLE b (id INTEGER PRIMARY KEY);
    `);
    // Both tables exist iff both CREATEs ran — proves multi-statement exec, not just the first.
    sqliteRun(dbPath, 'INSERT INTO a (id) VALUES (1)');
    sqliteRun(dbPath, 'INSERT INTO b (id) VALUES (1)');
  });

  it('sqliteRun executes a parameterized write and returns {changes}', () => {
    const dbPath = join(scratchDir, 'run.db');
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    const result = sqliteRun(dbPath, 'INSERT INTO t (name) VALUES (?)', ['alice']);
    assert.equal(result.changes, 1);
  });

  it('sqliteQuery returns rows', () => {
    const dbPath = join(scratchDir, 'query.db');
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    sqliteRun(dbPath, 'INSERT INTO t (name) VALUES (?)', ['bob']);
    const rows = sqliteQuery<{ id: number; name: string }>(dbPath, 'SELECT id, name FROM t');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'bob');
  });

  it('params bind safely — quote/injection characters round-trip verbatim', () => {
    const dbPath = join(scratchDir, 'injection.db');
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    const nasty = `alice'); DROP TABLE t; --"quoted"`;
    sqliteRun(dbPath, 'INSERT INTO t (name) VALUES (?)', [nasty]);
    // Table still exists and holds the value untouched — proves parameter
    // binding is used, not string concatenation.
    const rows = sqliteQuery<{ name: string }>(dbPath, 'SELECT name FROM t');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, nasty);
  });

  it('sqliteRun throws when the db file does not exist', () => {
    const dbPath = join(scratchDir, 'missing-run.db');
    assert.throws(() => sqliteRun(dbPath, 'INSERT INTO t (name) VALUES (?)', ['x']));
  });

  it('sqliteQuery throws when the db file does not exist', () => {
    const dbPath = join(scratchDir, 'missing-query.db');
    assert.throws(() => sqliteQuery(dbPath, 'SELECT 1'));
  });

  it('sqliteQuery opens readonly — a row-returning write statement still throws', () => {
    // A plain INSERT/UPDATE already throws via .all() regardless of
    // readonly mode (better-sqlite3 rejects non-reader statements there).
    // RETURNING makes it a reader statement, so this only throws if the
    // connection itself is opened readonly — the actual invariant we want.
    const dbPath = join(scratchDir, 'readonly.db');
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    assert.throws(() => sqliteQuery(dbPath, `INSERT INTO t (name) VALUES ('should-not-write') RETURNING id`));
  });

  // Lock-release proof: on Windows, an open sqlite handle keeps the file
  // locked and unlink() fails with EBUSY/EPERM. Each helper must close its
  // connection before returning, or these unlinks fail on Windows CI.
  it('lock-release proof: db file unlinks immediately after sqliteExec', async () => {
    const dbPath = join(scratchDir, 'unlink-exec.db');
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    await unlink(dbPath);
  });

  it('lock-release proof: db file unlinks immediately after sqliteRun', async () => {
    const dbPath = join(scratchDir, 'unlink-run.db');
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    sqliteRun(dbPath, 'INSERT INTO t (name) VALUES (?)', ['x']);
    await unlink(dbPath);
  });

  it('lock-release proof: db file unlinks immediately after sqliteQuery', async () => {
    const dbPath = join(scratchDir, 'unlink-query.db');
    sqliteExec(dbPath, `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`);
    sqliteQuery(dbPath, 'SELECT * FROM t');
    await unlink(dbPath);
  });
});
