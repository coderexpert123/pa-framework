/**
 * Fix ledger (2026-08-29, plans/2026-08-29-alert-suppression-SPEC.md).
 *
 * Append-only record of SHIPPED fixes, written by the fixer session (or `pa fix`),
 * never the operator. The census overlay (lib/alert-census.ts) consults it so a
 * fixed incident stops demanding operator action instead of paging until its last
 * log line ages out. Corrections are new records — there is no edit and no delete.
 *
 * File: <paHome>/fix-ledger.json — a plain JSON array of FixRecord, newest LAST.
 * Missing/corrupt file reads as [] (never throws — the census's own tolerance
 * contract, see forEachLine in alert-census.ts).
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { writeJsonAtomic } from './atomic-write.js';

export interface FixRecord {
  family: string;    // census family key (censusFamilyKey output / dedupKey)
  fixedAt: string;   // ISO UTC — when the fix shipped
  note: string;      // free text — what was fixed
  source: string;    // who wrote the record, e.g. 'cli'
}

export const FIX_LEDGER_FILE = 'fix-ledger.json';

function fixLedgerPath(ph: string): string {
  return join(ph, FIX_LEDGER_FILE);
}

/** Reads the ledger. Missing file, unparseable JSON, or a non-array top level
 *  all return [] — a corrupt ledger must not take down the nightly census. */
export async function readFixLedger(ph: string): Promise<FixRecord[]> {
  let raw: string;
  try {
    raw = await readFile(fixLedgerPath(ph), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as FixRecord[] : [];
  } catch {
    return [];
  }
}

/** Appends one record (newest last) and rewrites the file atomically via
 *  writeJsonAtomic. Read-modify-write: concurrent appends from two processes
 *  can lose one record — accepted by design (one fixer session at a time). */
export async function appendFixRecord(ph: string, rec: FixRecord): Promise<void> {
  const records = await readFixLedger(ph);
  records.push(rec);
  await writeJsonAtomic(fixLedgerPath(ph), records);
}

/** Pure: for each family, the record with the greatest Date.parse(fixedAt)
 *  (ties → later array index). A record whose fixedAt does not parse to a
 *  finite epoch ms is never selected — a corrupt row cannot suppress a live
 *  family. Consumers consult only the latest record per family (PLAN §Design 1). */
export function latestFixByFamily(records: FixRecord[]): Map<string, FixRecord> {
  const latest = new Map<string, FixRecord>();
  const latestMs = new Map<string, number>();
  for (const rec of records) {
    const ms = Date.parse(rec.fixedAt);
    if (!Number.isFinite(ms)) continue;
    const cur = latestMs.get(rec.family);
    if (cur === undefined || ms >= cur) {
      latest.set(rec.family, rec);
      latestMs.set(rec.family, ms);
    }
  }
  return latest;
}
