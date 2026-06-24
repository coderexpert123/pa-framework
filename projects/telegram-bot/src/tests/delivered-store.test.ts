import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deliveredKey,
  wasDelivered,
  markDelivered,
  DELIVERED_MAX_AGE_MS,
  _resetDeliveredCacheForTest,
} from '../delivered-store.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pa-delivered-'));
  process.env.PA_HOME = home;
  _resetDeliveredCacheForTest();
});

afterEach(() => {
  delete process.env.PA_HOME;
  _resetDeliveredCacheForTest();
  try { rmSync(home, { recursive: true, force: true }); } catch {}
});

describe('deliveredKey', () => {
  it('is stable for the same chat/thread/update', () => {
    assert.equal(deliveredKey(-100123, 5, 42), deliveredKey(-100123, 5, 42));
  });
  it('differs across updates', () => {
    assert.notEqual(deliveredKey(-100123, 5, 42), deliveredKey(-100123, 5, 43));
  });
});

describe('delivered store', () => {
  it('reports not-delivered for an unknown key', async () => {
    assert.equal(await wasDelivered(deliveredKey(1, 0, 7)), false);
  });

  it('reports delivered after markDelivered', async () => {
    const k = deliveredKey(1, 0, 7);
    await markDelivered(k);
    assert.equal(await wasDelivered(k), true);
  });

  it('persists across a cache reset (survives a simulated restart)', async () => {
    const k = deliveredKey(-100999, 12, 555);
    await markDelivered(k);
    _resetDeliveredCacheForTest(); // simulate process restart re-reading the file
    assert.equal(await wasDelivered(k), true);
  });

  it('markDelivered is idempotent (no duplicate file lines)', async () => {
    const k = deliveredKey(1, 0, 7);
    await markDelivered(k);
    await markDelivered(k);
    const lines = readFileSync(join(home, 'telegram-delivered.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
  });

  it('treats entries older than the TTL as not delivered and compacts them out', async () => {
    const k = deliveredKey(1, 0, 7);
    const stale = Date.now() - DELIVERED_MAX_AGE_MS - 1000;
    writeFileSync(join(home, 'telegram-delivered.jsonl'), JSON.stringify({ key: k, ts: stale }) + '\n', 'utf8');
    _resetDeliveredCacheForTest();
    assert.equal(await wasDelivered(k), false);
    // Compaction on load should have dropped the expired line.
    const after = existsSync(join(home, 'telegram-delivered.jsonl'))
      ? readFileSync(join(home, 'telegram-delivered.jsonl'), 'utf8').trim()
      : '';
    assert.equal(after, '');
  });
});
