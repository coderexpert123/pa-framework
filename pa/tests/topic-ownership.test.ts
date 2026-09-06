import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup, createTempConfig } from './helpers.js';

// Synthetic ids only — the bot test-fixture rule (never real chat/thread ids
// in fixtures).
const CHAT = '-1001234567890';

async function writeRegistry(data: unknown): Promise<void> {
  const { topicOwnershipRegistryPath } = await import('../src/lib/topic-ownership.js');
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await writeFile(topicOwnershipRegistryPath(), body, 'utf8');
}

describe('topic-ownership', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('missing registry file resolves to an empty registry', async () => {
    const { loadTopicOwnershipRegistry, resolveCatchAll, resolveOwnerForPath } = await import(
      '../src/lib/topic-ownership.js'
    );
    const reg = await loadTopicOwnershipRegistry();
    assert.equal(reg.size, 0);
    assert.equal(resolveCatchAll(reg), undefined);
    assert.equal(resolveOwnerForPath(reg, 'pa/src/x.ts'), null);
  });

  it('corrupt JSON resolves to an empty registry and warns once', async () => {
    const { loadTopicOwnershipRegistry } = await import('../src/lib/topic-ownership.js');
    await writeRegistry('{{{');
    const first = await loadTopicOwnershipRegistry();
    assert.equal(first.size, 0);
    // The warn-once flag is per process, so the second call logs nothing
    // more and must not throw (the orphan-ledger warn-once test's pattern:
    // assert the returned shape, not the log stream).
    const second = await loadTopicOwnershipRegistry();
    assert.equal(second.size, 0);
  });

  it('rows with invalid keys or owned types are dropped and counted in one warn', async () => {
    const { loadTopicOwnershipRegistry } = await import('../src/lib/topic-ownership.js');
    await writeRegistry({
      bogus: { label: 'key fails the topic-key grammar' },
      [`${CHAT}_5001`]: { owned: 'not-an-array' },
      [`${CHAT}_5002`]: { owned: ['pa/src'] },
    });
    const reg = await loadTopicOwnershipRegistry();
    assert.equal(reg.size, 1);
    assert.ok(reg.has(`${CHAT}_5002`));
  });

  it('catch-all resolves to the single role row; first wins when duplicated', async () => {
    const { loadTopicOwnershipRegistry, resolveCatchAll } = await import('../src/lib/topic-ownership.js');
    await writeRegistry({ [`${CHAT}_5001`]: { role: 'catch-all' } });
    assert.equal(resolveCatchAll(await loadTopicOwnershipRegistry()), `${CHAT}_5001`);

    await writeRegistry({
      [`${CHAT}_5001`]: { role: 'catch-all' },
      [`${CHAT}_5002`]: { role: 'catch-all' },
    });
    assert.equal(resolveCatchAll(await loadTopicOwnershipRegistry()), `${CHAT}_5001`, 'first in parse order wins');
  });

  it('owned prefix matches exact and segment-children, never ancestors or partial-segment strings', async () => {
    const { loadTopicOwnershipRegistry, resolveOwnerForPath } = await import('../src/lib/topic-ownership.js');
    await writeRegistry({ [`${CHAT}_5001`]: { owned: ['projects/fitness-data-sync'] } });
    const reg = await loadTopicOwnershipRegistry();
    assert.equal(resolveOwnerForPath(reg, 'projects/fitness-data-sync'), `${CHAT}_5001`, 'exact match');
    assert.equal(
      resolveOwnerForPath(reg, 'projects/fitness-data-sync/scripts/a.py'),
      `${CHAT}_5001`,
      'segment-child matches',
    );
    assert.equal(resolveOwnerForPath(reg, 'projects/fitness'), null, 'the ancestor path does not match');
    assert.equal(resolveOwnerForPath(reg, 'projects/fitness-data-sync2/x'), null, 'partial-segment strings never match');
    assert.equal(resolveOwnerForPath(reg, 'projects'), null, 'a prefix ancestor does not match');
  });

  it('resolveOwnerForPath returns the first matching row in parse order', async () => {
    const { loadTopicOwnershipRegistry, resolveOwnerForPath } = await import('../src/lib/topic-ownership.js');
    await writeRegistry({
      [`${CHAT}_5001`]: { owned: ['area-one'] },
      [`${CHAT}_5002`]: { owned: ['area-two'] },
    });
    const reg = await loadTopicOwnershipRegistry();
    assert.equal(resolveOwnerForPath(reg, 'area-two/file.ts'), `${CHAT}_5002`);
    assert.equal(resolveOwnerForPath(reg, 'area-three/file.ts'), null);
  });

  it('resolveRoutingTarget prefers the registry catch-all over topics.support', async () => {
    const { resolveRoutingTarget } = await import('../src/lib/topic-ownership.js');
    await writeRegistry({ [`${CHAT}_5002`]: { role: 'catch-all' } });
    await createTempConfig(dir, [], { topics: { support: `${CHAT}_5001` } });
    assert.equal(await resolveRoutingTarget(), `${CHAT}_5002`);
  });

  it('resolveRoutingTarget falls back to topics.support with no catch-all', async () => {
    const { resolveRoutingTarget, topicOwnershipRegistryPath } = await import('../src/lib/topic-ownership.js');
    // (a) registry present without a catch-all row → config value.
    await writeRegistry({ [`${CHAT}_5001`]: { owned: ['pa/src'] } });
    await createTempConfig(dir, [], { topics: { support: `${CHAT}_5001` } });
    assert.equal(await resolveRoutingTarget(), `${CHAT}_5001`);

    // (b) registry ABSENT + config present → config value.
    await rm(topicOwnershipRegistryPath(), { force: true });
    assert.equal(await resolveRoutingTarget(), `${CHAT}_5001`);

    // (c) both absent → undefined.
    await rm(join(dir, 'config.yaml'), { force: true });
    assert.equal(await resolveRoutingTarget(), undefined);
  });

  it('loadSupportTopic (the exported seam) returns the registry catch-all', async () => {
    // Through daily-recon's export — the seam the bot imports from pa dist
    // (pins adjudication C: same name, signature and module).
    await writeRegistry({ [`${CHAT}_5002`]: { role: 'catch-all' } });
    await createTempConfig(dir, [], { topics: { support: `${CHAT}_5001` } });
    const { loadSupportTopic } = await import('../src/lib/maintenance/jobs/daily-recon.js');
    assert.equal(await loadSupportTopic(), `${CHAT}_5002`);
  });
});
