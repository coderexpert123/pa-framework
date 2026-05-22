import Database from 'better-sqlite3';
import { join } from 'path';
import { paHome } from '../paths.js';
import { mkdirSync } from 'fs';

let db: any = null;
let currentDbPath: string | null = null;

export function getDb() {
  const dir = paHome();
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'pa.db');

  if (db && currentDbPath === dbPath) return db;

  // Close old connection if path changed
  if (db && currentDbPath !== dbPath) {
    try {
      db.close();
    } catch { }
  }

  db = new Database(dbPath);
  currentDbPath = dbPath;

  // Initialize schema
  // We use ISO-8601 for sent_at for easy parsing and comparison
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key TEXT,
      subject TEXT,
      body_hash TEXT,
      severity TEXT,
      sent_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_dedup_key ON alerts(dedup_key);
    CREATE INDEX IF NOT EXISTS idx_alerts_sent_at ON alerts(sent_at);
  `);

  return db;
}
