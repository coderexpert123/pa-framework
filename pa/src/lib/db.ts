import Database from 'better-sqlite3';

// Thin better-sqlite3 wrapper. No connection caching — every call opens a
// fresh connection, sets busy_timeout, performs the operation, and closes
// in `finally`. This is deliberate: callers may point dbPath at a file
// another process also owns (e.g. codex's own state_5.sqlite), so we must
// never hold a lock between calls.

/** Values better-sqlite3 accepts as bind parameters. */
export type SqlParam = string | number | bigint | Buffer | null;

function openDb(dbPath: string, options?: Database.Options): Database.Database {
  const db = new Database(dbPath, options);
  db.pragma('busy_timeout = 2000');
  return db;
}

/**
 * Runs one or more semicolon-separated SQL statements with no parameter
 * binding (e.g. schema DDL). Creates dbPath if it doesn't already exist.
 */
export function sqliteExec(dbPath: string, sql: string): void {
  const db = openDb(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * Runs a single parameterized write statement against an existing db file.
 * Throws if dbPath doesn't exist.
 */
export function sqliteRun(dbPath: string, sql: string, params: readonly SqlParam[] = []): { changes: number } {
  const db = openDb(dbPath, { fileMustExist: true });
  try {
    const result = db.prepare(sql).run(...params);
    return { changes: result.changes };
  } finally {
    db.close();
  }
}

/**
 * Runs a parameterized read query against an existing db file and returns
 * all matching rows. Opens the connection readonly — any write statement
 * throws, even one shaped like a reader via RETURNING. Throws if dbPath
 * doesn't exist.
 */
export function sqliteQuery<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  params: readonly SqlParam[] = []
): T[] {
  const db = openDb(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
