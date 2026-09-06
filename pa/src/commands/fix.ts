import { readFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../paths.js';
import { readFixLedger, appendFixRecord, type FixRecord } from '../lib/fix-ledger.js';
import { ALERT_CENSUS_FILE, type AlertCensus } from '../lib/alert-census.js';

/**
 * `pa fix` CLI (2026-08-29, the alert-suppression spec).
 *
 * Append-only fix ledger, written by the FIXER session, not the operator. A fix
 * record is what makes the census overlay stop surfacing a family. No delete,
 * no edit — corrections are new records (a later fixedAt wins; if the family
 * fires again after it, the census marks it regressed and it resurfaces).
 *
 * Exit codes: 0 — record appended / list printed (an unknown family or a missing
 * census file WARNS but proceeds); 2 — argument parse error.
 */
export async function fixCommand(args: string[] = process.argv.slice(2)): Promise<void> {
  const home = paHome();

  if (args.includes('--list')) {
    const records = await readFixLedger(home);
    if (records.length === 0) {
      console.log('No fix records.');
      return;
    }
    console.log(`${records.length} fix record(s), oldest first:`);
    for (const r of records) {
      console.log(`- ${r.fixedAt}  ${r.family}  (source: ${r.source})${r.note ? ` — ${r.note}` : ''}`);
    }
    return;
  }

  const family = args[0] !== undefined && !args[0].startsWith('-') ? args[0] : undefined;
  if (family === undefined) {
    console.error('Usage: pa fix <family> [--note "<text>"]  |  pa fix --list');
    process.exit(2);
  }

  const noteIdx = args.indexOf('--note');
  const note = noteIdx !== -1 ? (args[noteIdx + 1] ?? '') : '';

  const rec: FixRecord = { family, fixedAt: new Date().toISOString(), note, source: 'cli' };
  await appendFixRecord(home, rec);
  console.log(`Recorded fix for \`${family}\` (fixedAt ${rec.fixedAt}, source ${rec.source}).`);

  // Current census status when findable. Warn-but-proceed on an unknown family:
  // backfilling an already-aged-out incident is a first-class use (PLAN §Design 2).
  let census: AlertCensus | undefined;
  try {
    census = JSON.parse(await readFile(join(home, ALERT_CENSUS_FILE), 'utf8')) as AlertCensus;
  } catch {
    census = undefined; // absent or unreadable census — same warn path
  }
  const entry = census?.families.find((f) => f.family === family);
  if (entry === undefined) {
    console.log(`Note: \`${family}\` is not present in the current ${ALERT_CENSUS_FILE} — recorded anyway (aged-out backfill or not yet censused).`);
    return;
  }
  const owner = entry.owner ? `${entry.ownerKind}:${entry.owner}` : entry.ownerKind;
  console.log(`Census (7d): ${entry.sent} sent, last seen ${entry.lastSeen}, owner ${owner}, classification ${entry.classification}${entry.suppressedBy ? `, suppressed (${entry.suppressedBy})` : ''}.`);
}
