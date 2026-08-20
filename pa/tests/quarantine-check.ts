import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared quarantine-check logic (WPG4) — used by tests/quarantine.test.ts.
 *  Unit-testable without spawning; time-injectable. */

export interface QuarantineEntry {
  file: string;
  reason: string;
  quarantined_at: string; // ISO 8601 date string
}

export function loadManifest(
  manifestPath: string = join(process.cwd(), 'tests', 'quarantine-manifest.json')
): QuarantineEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function runQuarantineCheck(injectedNow?: Date): void {
  const now = injectedNow ?? new Date();
  const manifest = loadManifest();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  if (manifest.length === 0) {
    console.log('No quarantined tests');
    return;
  }

  for (const entry of manifest) {
    const ageMs = now.getTime() - new Date(entry.quarantined_at).getTime();
    if (ageMs > thirtyDaysMs) {
      throw new Error(
        `Quarantine entry for "${entry.file}" expired ${Math.floor(ageMs / thirtyDaysMs)} days ago. ` +
        `Reason: "${entry.reason}". Quarantined: ${entry.quarantined_at}. ` +
        `Fix the test, delete the entry, or update quarantined_at.`
      );
    }
  }

  const files = manifest.map((e) => e.file).sort().join(', ');
  console.log(`${manifest.length} quarantined test(s): ${files}`);
}
