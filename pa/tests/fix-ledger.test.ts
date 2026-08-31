import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFixLedger, appendFixRecord, latestFixByFamily, type FixRecord } from '../src/lib/fix-ledger.js';

describe('fix-ledger', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-fix-ledger-test-'));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readFixLedger', () => {
    it('missing file ⇒ []', async () => {
      const records = await readFixLedger(tempDir);
      assert.deepStrictEqual(records, []);
    });

    it('corrupt JSON ⇒ [] (never throws)', async () => {
      await writeFile(join(tempDir, 'fix-ledger.json'), 'not json', 'utf8');
      const records = await readFixLedger(tempDir);
      assert.deepStrictEqual(records, []);
    });

    it('non-array top level (e.g. {}) ⇒ []', async () => {
      await writeFile(join(tempDir, 'fix-ledger.json'), '{}', 'utf8');
      const records = await readFixLedger(tempDir);
      assert.deepStrictEqual(records, []);
    });
  });

  describe('appendFixRecord', () => {
    it('append → read round-trip returns exactly the record', async () => {
      const rec: FixRecord = {
        family: 'test-family',
        fixedAt: '2026-08-29T00:00:00.000Z',
        note: 'fixed the bug',
        source: 'cli'
      };
      await appendFixRecord(tempDir, rec);
      const records = await readFixLedger(tempDir);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0], rec);
    });

    it('append preserves prior records, newest last', async () => {
      const recA: FixRecord = { family: 'family-a', fixedAt: '2026-08-29T00:00:00.000Z', note: 'first', source: 'cli' };
      const recB: FixRecord = { family: 'family-b', fixedAt: '2026-08-29T01:00:00.000Z', note: 'second', source: 'cli' };
      await appendFixRecord(tempDir, recA);
      await appendFixRecord(tempDir, recB);
      const records = await readFixLedger(tempDir);
      assert.strictEqual(records.length, 2);
      assert.deepStrictEqual(records[0], recA);
      assert.deepStrictEqual(records[1], recB);
    });
  });

  describe('latestFixByFamily', () => {
    it('two records for one family → greater fixedAt wins', () => {
      const rec1: FixRecord = { family: 'family-a', fixedAt: '2026-08-28T00:00:00.000Z', note: 'old', source: 'cli' };
      const rec2: FixRecord = { family: 'family-a', fixedAt: '2026-08-29T00:00:00.000Z', note: 'new', source: 'cli' };
      const rec3: FixRecord = { family: 'family-b', fixedAt: '2026-08-27T00:00:00.000Z', note: 'other family', source: 'cli' };
      const latest = latestFixByFamily([rec1, rec2, rec3]);
      assert.strictEqual(latest.size, 2);
      assert.deepStrictEqual(latest.get('family-a'), rec2);
      assert.deepStrictEqual(latest.get('family-b'), rec3);
    });

    it('unparseable fixedAt is never selected', () => {
      const rec1: FixRecord = { family: 'family-a', fixedAt: 'not-a-date', note: 'bad', source: 'cli' };
      const rec2: FixRecord = { family: 'family-b', fixedAt: '2026-08-29T00:00:00.000Z', note: 'good', source: 'cli' };
      const latest = latestFixByFamily([rec1, rec2]);
      assert.strictEqual(latest.size, 1);
      assert.strictEqual(latest.get('family-a'), undefined);
      assert.deepStrictEqual(latest.get('family-b'), rec2);
    });

    it('tie → later array index wins', () => {
      const rec1: FixRecord = { family: 'family-a', fixedAt: '2026-08-29T00:00:00.000Z', note: 'first', source: 'cli' };
      const rec2: FixRecord = { family: 'family-a', fixedAt: '2026-08-29T00:00:00.000Z', note: 'second', source: 'cli' };
      const latest = latestFixByFamily([rec1, rec2]);
      assert.strictEqual(latest.size, 1);
      assert.deepStrictEqual(latest.get('family-a'), rec2);
    });
  });
});
