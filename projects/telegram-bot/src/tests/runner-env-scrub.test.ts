/**
 * runner-env-scrub.test.ts — AI-199 regression (2026-09-03).
 *
 * The push skill's gate runs `npm test` from inside an LLM-worker shell whose
 * environment carries every secrets.env value (pa run injects them for LLM
 * workers). Deployment flags that runtime code reads from process.env leaked
 * into the suite and flipped externally-visible behavior: PA_RICH_MESSAGES=1
 * (secrets.env) routed worker replies over /sendRichMessage instead of
 * /sendMessage, so every test asserting on captured /sendMessage bodies
 * failed — the identical 12 subtests on every gate run, never locally and
 * never on CI (which has no secrets.env). Investigation:
 * plans/2026-09-03-push-gate-env-investigation.md.
 *
 * This test spawns the REAL runner (scripts/run-tests.mjs — the entry point
 * `npm test` invokes) on a fast dispatch-path file with PA_RICH_MESSAGES=1
 * injected into the runner's own env, and asserts the run is green: the
 * runner must scrub deployment-env flags from the child it spawns, so a
 * gate-shell run measures the same behavior CI measures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const botRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('test runner scrubs deployment env from the suite (AI-199)', () => {
  it('worker-edit-audit-wiring passes with PA_RICH_MESSAGES=1 in the runner env', { timeout: 120_000 }, async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PA_RICH_MESSAGES: '1' };
    // Nested-runner guard: NODE_TEST_CONTEXT in a spawned runner's env trips
    // node:test's recursion guard (the documented dark-file hazard) — strip
    // it so the inner run is a normal suite run.
    delete env.NODE_TEST_CONTEXT;
    // Scoped inner run: bypass @build (this outer run already holds it) and
    // the dist-freshness gate (the outer runner already checked it). Neither
    // is what this test exercises.
    env.PA_BUILD_LOCK = '0';
    env.PA_ALLOW_STALE_DIST = '1';

    const { code, tail } = await new Promise<{ code: number; tail: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [join(botRoot, 'scripts', 'run-tests.mjs'), 'worker-edit-audit-wiring'],
        { cwd: botRoot, env, stdio: 'pipe' },
      );
      let out = '';
      child.stdout.on('data', (c) => { out += String(c); });
      child.stderr.on('data', (c) => { out += String(c); });
      child.on('close', (c) => resolve({ code: c ?? 1, tail: out.slice(-3000) }));
    });
    assert.strictEqual(
      code, 0,
      `inner runner run failed under PA_RICH_MESSAGES=1 — the runner must scrub ` +
      `deployment-env flags before spawning the suite. Tail:\n${tail}`,
    );
  });
});
