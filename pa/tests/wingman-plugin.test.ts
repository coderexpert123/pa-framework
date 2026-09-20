import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  wingmanPlugin,
  wingmanLockCheck,
  wingmanLog,
  WINGMAN_BROWSER_LOCK,
  WINGMAN_LOCK_CONTEXT_ENV,
  _setWingmanLogForTest,
} from '../src/lib/wingman-plugin.js';
import { askSystemOne } from '../src/lib/typesafe-client.js';

// dist/tests -> dist -> pa (mirrors dist-guard.test.ts's resolution).
const WINGMAN_PKG_SCRIPT = join(__dirname, '..', '..', 'scripts', 'wingman_pkg.mjs');

async function loadWingmanPkg() {
  return await import(pathToFileURL(WINGMAN_PKG_SCRIPT).href);
}

afterEach(() => {
  _setWingmanLogForTest(null);
});

describe('wingmanPlugin', () => {
  it('wingmanPlugin.ask is askSystemOne', () => {
    assert.equal(wingmanPlugin.ask, askSystemOne);
  });

  it('no browser-session lock allows the call', async () => {
    const result = await wingmanLockCheck({}, async () => []);
    assert.deepEqual(result, { ok: true });
  });

  it('a lock held by another run refuses with lock-held', async () => {
    const result = await wingmanLockCheck(
      { [WINGMAN_LOCK_CONTEXT_ENV]: 'my-context' },
      async () => [{ resource: WINGMAN_BROWSER_LOCK, contextId: 'other-context' }],
    );
    assert.deepEqual(result, { ok: false, reason: 'lock-held' });
  });

  it("a lock held by this run's context allows the call", async () => {
    const result = await wingmanLockCheck(
      { [WINGMAN_LOCK_CONTEXT_ENV]: 'my-context' },
      async () => [{ resource: WINGMAN_BROWSER_LOCK, contextId: 'my-context' }],
    );
    assert.deepEqual(result, { ok: true });
  });

  it('an unreadable blackboard refuses (fail closed)', async () => {
    const result = await wingmanLockCheck({}, async () => {
      throw new Error('blackboard read failed');
    });
    assert.deepEqual(result, { ok: false, reason: 'lock-held' });
  });

  it('wingmanLog routes one record under module jev-browser-wingman', () => {
    const calls: unknown[][] = [];
    _setWingmanLogForTest(((...args: unknown[]) => {
      calls.push(args);
    }) as typeof import('../src/lib/log.js').log);
    wingmanLog({ tool: 'wingman_do', status: 'ok' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'info');
    assert.equal(calls[0][1], 'jev-browser-wingman');
    assert.equal(calls[0][2], 'wingman call');
    assert.deepEqual(calls[0][3], { tool: 'wingman_do', status: 'ok' });
  });

  it('wingman_pkg resolves the env vars first, then the global npm root', async () => {
    const { wingmanPackageDir, wingmanDistDir } = await loadWingmanPkg();
    const fakeRoot = () => join('fake', 'npm', 'root');

    assert.equal(wingmanPackageDir({}, fakeRoot), join(fakeRoot(), 'jev-browser-wingman'));
    assert.equal(wingmanPackageDir({ WINGMAN_PKG_DIR: '/set/pkg' }, fakeRoot), '/set/pkg');
    assert.equal(wingmanDistDir({}, fakeRoot), join(fakeRoot(), 'jev-browser-wingman', 'dist'));
    assert.equal(wingmanDistDir({ WINGMAN_DIST_DIR: '/set/dist' }, fakeRoot), '/set/dist');
  });
});
