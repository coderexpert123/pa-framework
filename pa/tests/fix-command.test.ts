import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { fixCommand } from '../src/commands/fix.js';
import { readFixLedger, type FixRecord } from '../src/lib/fix-ledger.js';
import type { AlertCensus } from '../src/lib/alert-census.js';

let tempDir: string;
let consoleOutput: string[];
let originalConsoleLog: typeof console.log;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  consoleOutput = [];
  originalConsoleLog = console.log;
  console.log = (...args: any[]) => {
    consoleOutput.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
  };
});

afterEach(async () => {
  console.log = originalConsoleLog;
  await cleanup(tempDir);
});

describe('fixCommand', () => {
  it('appends a record with family/fixedAt/note/source', async () => {
    const testStart = new Date();
    await fixCommand(['daily-mail-brief', '--note', 'reauth flow replaced']);

    const records = await readFixLedger(tempDir);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].family, 'daily-mail-brief');
    assert.strictEqual(records[0].note, 'reauth flow replaced');
    assert.strictEqual(records[0].source, 'cli');
    const fixedAt = Date.parse(records[0].fixedAt);
    assert.ok(Number.isFinite(fixedAt));
    assert.ok(fixedAt >= testStart.getTime());
  });

  it('--note omitted ⇒ empty string note', async () => {
    await fixCommand(['test-family']);
    const records = await readFixLedger(tempDir);
    assert.strictEqual(records[0].note, '');
  });

  it('prints the census status line when the family is present', async () => {
    const census: AlertCensus = {
      generatedAt: '2026-08-29T00:00:00.000Z',
      windowDays: 7,
      since: '2026-08-22T00:00:00.000Z',
      until: '2026-08-29T00:00:00.000Z',
      totalSent: 100,
      totalSuppressed: 10,
      sentPerDay: {},
      families: [{
        family: 'daily-mail-brief',
        subjectSample: 'Skill failed: daily-mail-brief',
        sent: 4,
        suppressed: 0,
        other: 0,
        firstSeen: '2026-08-24T00:00:00.000Z',
        lastSeen: '2026-08-24T00:00:00.000Z',
        ownerKind: 'skill',
        owner: 'daily-mail-brief',
        ownerStatus: { status: 'error', consecutiveFailures: 5 },
        distinctBodies: 1,
        classification: 'human-gated',
      }],
      maskedFailures: [],
      topLine: '100 alerts / 1 families in 7d — top: daily-mail-brief 4',
    };
    await writeFile(join(tempDir, 'alert-census.json'), JSON.stringify(census, null, 2), 'utf8');

    await fixCommand(['daily-mail-brief']);
    assert.ok(consoleOutput.some(line => line.includes('Census (7d): 4 sent')));
  });

  it('unknown family warns but proceeds', async () => {
    await fixCommand(['unknown-family']);
    assert.ok(consoleOutput.some(line => line.includes('not present in the current alert-census.json')));

    const records = await readFixLedger(tempDir);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].family, 'unknown-family');
  });

  it('--list prints records oldest first', async () => {
    const rec1: FixRecord = { family: 'family-a', fixedAt: '2026-08-28T00:00:00.000Z', note: 'first', source: 'cli' };
    const rec2: FixRecord = { family: 'family-b', fixedAt: '2026-08-29T00:00:00.000Z', note: 'second', source: 'cli' };
    await writeFile(join(tempDir, 'fix-ledger.json'), JSON.stringify([rec1, rec2], null, 2), 'utf8');

    await fixCommand(['--list']);
    assert.ok(consoleOutput[0].includes('2 fix record(s), oldest first:'));
    assert.ok(consoleOutput.some(line => line.includes('2026-08-28T00:00:00.000Z') && line.includes('family-a')));
    assert.ok(consoleOutput.some(line => line.includes('2026-08-29T00:00:00.000Z') && line.includes('family-b')));
  });

  it('--list on an empty ledger prints "No fix records."', async () => {
    await fixCommand(['--list']);
    assert.ok(consoleOutput.some(line => line === 'No fix records.'));
  });
});
