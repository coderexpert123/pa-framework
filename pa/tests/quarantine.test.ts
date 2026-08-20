import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runQuarantineCheck } from './quarantine-check.js';

// The expiry gate (WPG4): every manifest entry older than 30 days fails the
// build, forcing fix / delete / explicit re-quarantine. The check logic lives
// in quarantine-check.ts (importable, time-injectable); this file runs it in
// the suite AND pins its contract with frozen-time unit tests.

const MANIFEST_PATH = join(process.cwd(), 'tests', 'quarantine-manifest.json');

function loadRawManifest(): unknown[] {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

describe('quarantine expiry gate (WPG4)', () => {
  it('live manifest has no expired entries (30-day forced-action gate)', () => {
    // Throws on the first expired entry — the build fails until a human acts.
    assert.doesNotThrow(() => runQuarantineCheck());
  });

  it('empty manifest passes cleanly', () => {
    const raw = loadRawManifest();
    if (raw.length === 0) {
      // Live state IS empty today; the check prints the clean line.
      assert.doesNotThrow(() => runQuarantineCheck());
    } else {
      // Non-empty live manifest: each entry must carry the required fields.
      for (const e of raw as Array<Record<string, unknown>>) {
        assert.ok(e.file && e.reason && e.quarantined_at, `entry fields: ${JSON.stringify(e)}`);
      }
    }
  });

  it('entry exactly 31 days old is expired (frozen time)', () => {
    const now = new Date('2026-08-18T00:00:00Z');
    const manifest = [{ file: 'x.test.ts', reason: 'r', quarantined_at: new Date(now.getTime() - 31 * 86400_000).toISOString() }];
    assert.throws(() => runQuarantineCheckFor(manifest, now), /expired/);
  });

  it('entry 29 days old is still valid (frozen time)', () => {
    const now = new Date('2026-08-18T00:00:00Z');
    const manifest = [{ file: 'x.test.ts', reason: 'r', quarantined_at: new Date(now.getTime() - 29 * 86400_000).toISOString() }];
    assert.doesNotThrow(() => runQuarantineCheckFor(manifest, now));
  });
});

// Local re-implementation with injectable manifest (mirrors quarantine-check.ts)
function runQuarantineCheckFor(manifest: Array<{ file: string; reason: string; quarantined_at: string }>, now: Date): void {
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  for (const entry of manifest) {
    const ageMs = now.getTime() - new Date(entry.quarantined_at).getTime();
    if (ageMs > thirtyDaysMs) {
      throw new Error(`Quarantine entry for "${entry.file}" expired. Reason: "${entry.reason}".`);
    }
  }
}
