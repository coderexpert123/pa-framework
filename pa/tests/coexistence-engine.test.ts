import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Pure unit tests for the coexistence engine (Wave C WP-C2). Each case gets
// its OWN temp PA_HOME (registry + snapshots live under it) so no test reads
// another's registry rows — paHome() resolves process.env.PA_HOME dynamically
// at every call, so swapping it per-test is the isolation mechanism.
import {
  applyAdditive,
  KeyCollisionError,
  list,
  restore,
  snapshotConfig,
  listForDoctor,
  coexistenceRegistryPath,
  coexistenceSnapshotsDir,
} from '../src/lib/coexistence.js';

describe('coexistence engine', () => {
  let paHomeDir: string;
  const savedPaHome = process.env.PA_HOME;

  afterEach(() => {
    if (paHomeDir) rmSync(paHomeDir, { recursive: true, force: true });
    process.env.PA_HOME = savedPaHome;
    paHomeDir = undefined as unknown as string;
  });

  function freshHome(): string {
    paHomeDir = mkdtempSync(join(tmpdir(), 'coexist-engine-'));
    process.env.PA_HOME = paHomeDir;
    return paHomeDir;
  }

  it('empty registry lists as zero entries', async () => {
    freshHome();
    assert.deepEqual(await list(), []);
    assert.deepEqual(await listForDoctor(), []);
  });

  it('snapshotConfig copies pre-edit bytes; missing surface snapshots as a 0-byte marker', async () => {
    const home = freshHome();
    const surface = join(home, 'surface-a.json');
    writeFileSync(surface, '{"a":1}\n', 'utf8');
    const snap = await snapshotConfig(surface);
    assert.equal(readFileSync(snap, 'utf8'), '{"a":1}\n');
    const missing = join(home, 'surface-missing.json');
    const snap2 = await snapshotConfig(missing);
    assert.ok(existsSync(snap2));
    assert.equal(readFileSync(snap2, 'utf8'), '');
  });

  it('additive apply lands new keys beside existing content and appends one registry row', async () => {
    const home = freshHome();
    const surface = join(home, 'surface-b.json');
    writeFileSync(surface, JSON.stringify({ existing: { keep: true }, keepMe: 'yes' }), 'utf8');
    const r = await applyAdditive('claude', surface, [
      { key: 'existing.newkey', value: { x: 1 } },
      { key: 'added', value: 'v' },
    ]);
    assert.deepEqual(r, { added: ['existing.newkey', 'added'], collided: [] });
    const cfg = JSON.parse(readFileSync(surface, 'utf8'));
    assert.deepEqual(cfg.existing, { keep: true, newkey: { x: 1 } });
    assert.equal(cfg.keepMe, 'yes');
    assert.equal(cfg.added, 'v');
    const entries = await list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].mode, 'registry-restore');
    assert.deepEqual(entries[0].addedKeys, ['existing.newkey', 'added']);
    assert.ok(entries[0].snapshot.startsWith(coexistenceSnapshotsDir()));
    assert.ok(entries[0].id.startsWith('claude-'));
  });

  it('collision throws KeyCollisionError and leaves the file byte-identical (never overwrite)', async () => {
    const home = freshHome();
    const surface = join(home, 'surface-c.json');
    const original = '{"keep":"user-owned"}\n';
    writeFileSync(surface, original, 'utf8');
    await assert.rejects(
      () =>
        applyAdditive('codex', surface, [
          { key: 'keep', value: 'pa-version' },
          { key: 'fresh', value: 1 },
        ]),
      KeyCollisionError,
    );
    assert.equal(readFileSync(surface, 'utf8'), original, 'config bytes unchanged after collision');
    // Nothing was registered either — a refused apply registers no row.
    assert.deepEqual(await list(), []);
    // ...and only-new keys apply cleanly afterwards.
    await applyAdditive('codex', surface, [{ key: 'fresh', value: 1 }]);
    assert.equal(JSON.parse(readFileSync(surface, 'utf8')).fresh, 1);
  });

  it('JSONC surfaces (comments + trailing commas) parse and rewrite as JSON', async () => {
    const home = freshHome();
    const surface = join(home, 'opencode.jsonc');
    writeFileSync(surface, '{\n  // opencode config\n  "theme": "dark",\n}\n', 'utf8');
    await applyAdditive('opencode', surface, [{ key: 'mcp.pa', value: { url: 'stdio' } }]);
    const cfg = JSON.parse(readFileSync(surface, 'utf8'));
    assert.equal(cfg.theme, 'dark');
    assert.deepEqual(cfg.mcp.pa, { url: 'stdio' });
  });

  it('restore returns byte-identical bytes and spends the registry row', async () => {
    const home = freshHome();
    const surface = join(home, 'surface-d.json');
    const original = '{"user":"data","nested":{"v":2}}\n';
    writeFileSync(surface, original, 'utf8');
    const before = readFileSync(surface);
    await applyAdditive('devin', surface, [{ key: 'pa.added', value: true }]);
    const res = await restore((await list())[0].id);
    assert.equal(res.byteIdentical, true);
    assert.equal(readFileSync(surface).equals(before), true);
    assert.deepEqual(await list(), [], 'registry row spent after restore');
  });

  it('absence restore removes a surface PA created from nothing', async () => {
    freshHome();
    const surface = join(paHomeDir, 'surface-e.json');
    await applyAdditive('claude', surface, [{ key: 'new', value: 1 }]);
    assert.ok(existsSync(surface));
    const res = await restore((await list())[0].id);
    assert.equal(res.byteIdentical, true);
    assert.equal(existsSync(surface), false);
    assert.deepEqual(await list(), []);
  });

  it('restore of an unknown id throws; registry path sits under PA_HOME', async () => {
    const home = freshHome();
    await assert.rejects(() => restore('no-such-id'));
    assert.ok(coexistenceRegistryPath().startsWith(home));
  });

  it('listForDoctor degrades to [] when the registry file is corrupt', async () => {
    const home = freshHome();
    writeFileSync(coexistenceRegistryPath(), 'not-json{', 'utf8');
    assert.deepEqual(await listForDoctor(), []);
    rmSync(coexistenceRegistryPath(), { force: true });
  });
});
