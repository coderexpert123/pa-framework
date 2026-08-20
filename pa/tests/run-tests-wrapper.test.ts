import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The wrapper (pa/scripts/run-tests.mjs) is proven by every suite run passing
// through it. These tests pin its CONTRACTS (manifest shape, quarantine expiry
// window) without spawning the wrapper itself — spawning it from inside a suite
// that the wrapper is running is circular and deadlocks on Windows.
// Paths anchored to THIS compiled module (pa/dist/tests/) → pa/.

const PA_ROOT = join(__dirname, '..', '..');

describe('run-tests.mjs wrapper contracts (WPG4)', () => {
  it('manifest is a valid JSON array with required fields on every entry', () => {
    const manifest = readFileSync(join(PA_ROOT, 'tests', 'quarantine-manifest.json'), 'utf8');
    const parsed = JSON.parse(manifest);
    assert.ok(Array.isArray(parsed), 'manifest is a JSON array');
    for (const e of parsed) {
      assert.ok(e.file && e.reason && e.quarantined_at, `entry has required fields: ${JSON.stringify(e)}`);
      assert.ok(!isNaN(Date.parse(e.quarantined_at)), `quarantined_at is ISO: ${e.quarantined_at}`);
    }
  });

  it('quarantine-check module exports the expiry gate with the 30-day window', async () => {
    const { runQuarantineCheck } = await import('./quarantine-check.js');
    assert.equal(typeof runQuarantineCheck, 'function');
    // The live check proves the current manifest is within the 30-day window.
    assert.doesNotThrow(() => runQuarantineCheck(), 'live manifest has no expired entries');
  });

  it('wrapper source has no TypeScript syntax (the push-gate regression class)', () => {
    const src = readFileSync(join(PA_ROOT, 'scripts', 'run-tests.mjs'), 'utf8');
    assert.ok(!src.includes('interface '), 'no TS interface declarations in .mjs');
    assert.ok(!src.includes(': string[]'), 'no TS type annotations in .mjs');
    assert.ok(!src.includes(': QuarantineEntry'), 'no TS type references in .mjs');
  });
});
