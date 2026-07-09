import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  markDelivered,
  wasDelivered,
  compactDelivered,
  deliveredKey,
  _resetDeliveredCacheForTest,
} from '../delivered-store.js';

let tempDir: string;
let originalPaHome: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'delivered-compact-'));
  originalPaHome = process.env.PA_HOME;
  process.env.PA_HOME = tempDir;
  _resetDeliveredCacheForTest();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
  if (originalPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = originalPaHome;
  _resetDeliveredCacheForTest();
});

describe('compactDelivered', () => {
  it('drops aged-in-memory keys from BOTH the map and the on-disk file', async () => {
    const k1 = deliveredKey(1, 2, 100);
    const k2 = deliveredKey(1, 2, 101);
    await markDelivered(k1);
    await markDelivered(k2);

    // maxAgeMs = -1 forces every resident key to count as expired, simulating the
    // steady-state case where keys loaded fresh have since aged past the 24h TTL.
    const dropped = await compactDelivered(-1);
    assert.equal(dropped, 2);

    // Both gone from the in-memory map (wasDelivered reads the same cache)...
    assert.equal(await wasDelivered(k1), false);
    assert.equal(await wasDelivered(k2), false);
    // ...and from the file.
    const raw = await readFile(join(tempDir, 'telegram-delivered.jsonl'), 'utf8');
    assert.equal(raw.trim(), '');
  });

  it('is a no-op (returns 0) and preserves fresh keys under the default 24h TTL', async () => {
    const k1 = deliveredKey(5, 6, 7);
    const k2 = deliveredKey(5, 6, 8);
    await markDelivered(k1);
    await markDelivered(k2);
    assert.equal(await compactDelivered(), 0);
    assert.equal(await wasDelivered(k1), true);
    assert.equal(await wasDelivered(k2), true);
  });

  it('mixed case: drops only the expired key while re-serializing the fresh one to disk intact', async () => {
    // Seed the FILE directly: A is 1h old (survives load()'s 24h filter, so no
    // load-time compaction fires), B is fresh. Then compact with a 30-min TTL
    // so only A expires. Proves the rewrite path preserves surviving entries
    // rather than e.g. writing an empty body whenever dropped > 0.
    const kOld = deliveredKey(1, 1, 100);
    const kFresh = deliveredKey(1, 1, 101);
    const path = join(tempDir, 'telegram-delivered.jsonl');
    await writeFile(path, [
      JSON.stringify({ key: kOld, ts: Date.now() - 60 * 60 * 1000 }),
      JSON.stringify({ key: kFresh, ts: Date.now() }),
    ].join('\n') + '\n', 'utf8');
    _resetDeliveredCacheForTest();

    const dropped = await compactDelivered(30 * 60 * 1000);
    assert.equal(dropped, 1);
    assert.equal(await wasDelivered(kOld), false);
    assert.equal(await wasDelivered(kFresh), true, 'fresh key survives in memory');

    const raw = await readFile(path, 'utf8');
    const keysOnDisk = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).key);
    assert.deepEqual(keysOnDisk, [kFresh], 'fresh key re-serialized to disk; expired key gone');
  });
});
