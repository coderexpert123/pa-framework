// AI-255 WP-G (2026-09-16): the stale-dist guard + managed rebuild, shared by
// pa/scripts/run-tests.mjs and projects/telegram-bot/scripts/run-tests.mjs —
// one policy, imported by both entry points. Side-effect-free on import: the
// runners pass real dependencies, tests inject fakes (same non-literal
// import() pattern as testlock.test.ts).
//
// Contract:
//   * assertFresh() throwing code==='DIST_STALE' runs the package's own
//     build.mjs inline ONCE — the build script itself acquires @build through
//     withBuildLock, so the rebuild serializes with every other gate — then
//     re-asserts. Still stale after a successful build → refuse, as before.
//   * PA_NO_AUTOBUILD=1 restores the pre-WP-G refuse-fast behavior — wave
//     integrators and CI manage their own builds and must not inherit a
//     surprise nested one.
//   * PA_ALLOW_STALE_DIST=1 never reaches here: assertDistFresh warns and
//     returns instead of throwing.
//   * A non-DIST_STALE error refuses without a build attempt.

import { spawn } from 'node:child_process';

/** Spawn the package's own build script; resolves its exit code (never 1-on-error only). */
export function runPackageBuild(buildScript, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [buildScript], {
      stdio: 'inherit',
      cwd,
      env: process.env,
      windowsHide: true,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/**
 * Returns 0 when the dist is fresh (possibly after one managed rebuild), 1
 * when the run must refuse.
 *   opts.pkg         — 'pa' | 'bot' label for messages
 *   opts.assertFresh — () => Promise<void>; throws {code:'DIST_STALE'} on staleness
 *   opts.buildScript — absolute path to the package's scripts/build.mjs
 *   opts.buildCwd    — cwd for the build spawn
 *   opts.runBuild    — injectable (script, cwd) => Promise<code>
 *   opts.env         — defaults to process.env (tests inject a plain object)
 *   opts.log/error   — output sinks
 */
export async function ensureFreshDist(opts) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line) => console.error(line));
  const error = opts.error ?? ((line) => console.error(line));
  const runBuild = opts.runBuild ?? runPackageBuild;

  try {
    await opts.assertFresh();
    return 0;
  } catch (e) {
    if (e?.code !== 'DIST_STALE' || env.PA_NO_AUTOBUILD === '1') {
      error(`Refusing to run tests against this dist (AI-180): ${e?.message ?? e}`);
      return 1;
    }
    log(`[dist-guard] ${opts.pkg} dist is stale — running its build inline once (AI-255). ` +
        'Set PA_NO_AUTOBUILD=1 to keep the refuse-fast behavior.');
    const code = await runBuild(opts.buildScript, opts.buildCwd);
    if (code !== 0) {
      error(`Refusing to run tests: the inline ${opts.pkg} build exited ${code} (AI-255).`);
      return 1;
    }
    try {
      await opts.assertFresh();
      return 0;
    } catch (e2) {
      error(`Refusing to run tests even after the inline build (AI-180): ${e2?.message ?? e2}`);
      return 1;
    }
  }
}
