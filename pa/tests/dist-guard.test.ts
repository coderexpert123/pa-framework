import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// AI-255 WP-G gate: the shared stale-dist guard module is a real .mjs
// side-effect-free script — imported dynamically like testlock.mjs, driven
// with injected assertFresh/runBuild fakes so the policy (refuse vs rebuild)
// is what is under test, not tsc.
const SCRIPT = join(__dirname, '..', '..', 'scripts', 'dist-guard.mjs');

interface DistGuardModule {
  ensureFreshDist(opts: {
    pkg: string;
    assertFresh: () => Promise<void>;
    buildScript: string;
    buildCwd: string;
    runBuild?: (script: string, cwd: string) => Promise<number>;
    env?: Record<string, string | undefined>;
    log?: (line: string) => void;
    error?: (line: string) => void;
  }): Promise<number>;
}

async function loadModule(): Promise<DistGuardModule> {
  const mod: unknown = await import(pathToFileURL(SCRIPT).href);
  return mod as DistGuardModule;
}

function staleErr(detail: string): Error & { code: string } {
  const e = new Error(`DIST STALE (pa): ${detail}`) as Error & { code: string };
  e.code = 'DIST_STALE';
  return e;
}

function fixture(over: Partial<Parameters<DistGuardModule['ensureFreshDist']>[0]> = {}) {
  const calls = { builds: 0, asserts: 0 };
  const lines = { log: [] as string[], error: [] as string[] };
  const opts: Parameters<DistGuardModule['ensureFreshDist']>[0] = {
    pkg: 'pa',
    assertFresh: async () => { calls.asserts++; },
    buildScript: '/x/scripts/build.mjs',
    buildCwd: '/x',
    runBuild: async () => { calls.builds++; return 0; },
    env: {},
    log: (l) => lines.log.push(l),
    error: (l) => lines.error.push(l),
    ...over,
  };
  return { calls, lines, opts };
}

describe('dist-guard.mjs — AI-255 WP-G managed rebuild policy', () => {
  it('fresh dist → 0, no build attempted', async () => {
    const mod = await loadModule();
    const f = fixture();
    assert.equal(await mod.ensureFreshDist(f.opts), 0);
    assert.equal(f.calls.builds, 0, 'no rebuild when the assert passes');
    assert.equal(f.calls.asserts, 1);
  });

  it('DIST_STALE → one inline build → re-assert passes → 0', async () => {
    const mod = await loadModule();
    const f = fixture({
      assertFresh: (() => {
        let n = 0;
        return async () => {
          f.calls.asserts++;
          if (n++ === 0) throw staleErr('src changed after build');
        };
      })(),
    });
    assert.equal(await mod.ensureFreshDist(f.opts), 0);
    assert.equal(f.calls.builds, 1, 'exactly one managed rebuild');
    assert.equal(f.calls.asserts, 2, 'freshness re-asserted after the build');
    assert.ok(f.lines.log.some((l) => /build inline/.test(l)), 'the rebuild is announced');
  });

  it('PA_NO_AUTOBUILD=1 → refuse-fast, build never attempted', async () => {
    const mod = await loadModule();
    const f = fixture({
      assertFresh: async () => { throw staleErr('sha-mismatch'); },
      env: { PA_NO_AUTOBUILD: '1' },
    });
    assert.equal(await mod.ensureFreshDist(f.opts), 1);
    assert.equal(f.calls.builds, 0, 'PA_NO_AUTOBUILD preserves refuse-fast');
    assert.ok(f.lines.error.some((l) => /Refusing to run tests/.test(l)), 'the AI-180 refusal line survives');
  });

  it('a failed inline build refuses without re-asserting', async () => {
    const mod = await loadModule();
    const f = fixture({
      assertFresh: async () => { f.calls.asserts++; throw staleErr('stamp-missing'); },
      runBuild: async () => { f.calls.builds++; return 2; },
    });
    assert.equal(await mod.ensureFreshDist(f.opts), 1);
    assert.equal(f.calls.builds, 1);
    assert.equal(f.calls.asserts, 1, 'no second assert after a failed build');
    assert.ok(f.lines.error.some((l) => /exited 2/.test(l)), 'the build failure is named');
  });

  it('still-stale after a successful build refuses (no retry loop)', async () => {
    const mod = await loadModule();
    const f = fixture({
      assertFresh: async () => { f.calls.asserts++; throw staleErr('src-newer'); },
    });
    assert.equal(await mod.ensureFreshDist(f.opts), 1);
    assert.equal(f.calls.builds, 1, 'exactly ONE build — no loop');
    assert.equal(f.calls.asserts, 2);
    assert.ok(f.lines.error.some((l) => /after the inline build/.test(l)));
  });

  it('a non-DIST_STALE error refuses without a build attempt', async () => {
    const mod = await loadModule();
    const f = fixture({
      assertFresh: async () => { throw new Error('registry exploded'); },
    });
    assert.equal(await mod.ensureFreshDist(f.opts), 1);
    assert.equal(f.calls.builds, 0, 'only DIST_STALE triggers the rebuild arm');
  });
});
