import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, cleanup } from './helpers.js';

// CLI-layer tests for pa/src/commands/claim.ts — the layer pa/tests/reservations.test.ts
// does NOT cover (that file tests lib/reservations.ts's claim()/renew()/release()/
// readActive() directly, never claimCommand/releaseCommand/claimsCommand). Found during
// a 2026-08-06 deep-recheck: a real bug lived specifically in claimCommand's own
// deadline computation, invisible to library-level tests entirely.

describe('claimCommand', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('a non-numeric --wait does not hang forever — falls back to a single immediate attempt', async () => {
    const { claim } = await import('../src/lib/reservations.js');
    const { claimCommand } = await import('../src/commands/claim.js');

    // Pre-claim the same path under a different session so the command's own
    // claim attempt is guaranteed to conflict.
    const pre = await claim({ paths: ['pa/src/foo.ts'], session: 'other-session', note: 'holding it' });
    assert.equal(pre.ok, true);

    const start = Date.now();
    const exitCode = await claimCommand(['pa/src/foo.ts', '--session', 'me', '--note', 'testing', '--wait', 'not-a-number']);
    const elapsedMs = Date.now() - start;

    assert.equal(exitCode, 1, 'a conflicting claim with an invalid --wait must fail, not hang');
    // A real poll loop waits 5s between attempts (POLL_INTERVAL_MS) — completing well
    // under that proves this took exactly one attempt, not an infinite (or even one)
    // poll cycle. Generous margin for CI/slow-disk timing, still far short of 5000ms.
    assert.ok(elapsedMs < 2000, `expected a single immediate attempt (<2000ms), took ${elapsedMs}ms`);
  });

  it('a conflicting claim with no --wait at all also fails immediately (existing behavior, still correct)', async () => {
    const { claim } = await import('../src/lib/reservations.js');
    const { claimCommand } = await import('../src/commands/claim.js');

    const pre = await claim({ paths: ['pa/src/bar.ts'], session: 'other-session', note: 'holding it' });
    assert.equal(pre.ok, true);

    const start = Date.now();
    const exitCode = await claimCommand(['pa/src/bar.ts', '--session', 'me', '--note', 'testing']);
    const elapsedMs = Date.now() - start;

    assert.equal(exitCode, 1);
    assert.ok(elapsedMs < 2000, `expected a single immediate attempt (<2000ms), took ${elapsedMs}ms`);
  });

  it('a valid numeric --wait still polls and eventually succeeds once the conflict clears', async () => {
    const { claim, release } = await import('../src/lib/reservations.js');
    const { claimCommand } = await import('../src/commands/claim.js');

    const pre = await claim({ paths: ['pa/src/baz.ts'], session: 'other-session', note: 'temporary hold' });
    assert.equal(pre.ok, true);

    // Release the conflicting claim shortly after the command starts polling —
    // proves --wait genuinely retries rather than just delaying a single failure.
    setTimeout(() => { void release({ id: pre.reservation!.id }); }, 300);

    const exitCode = await claimCommand(['pa/src/baz.ts', '--session', 'me', '--note', 'testing', '--wait', '5']);
    assert.equal(exitCode, 0, 'must succeed once the conflicting reservation is released within the wait window');
  });
});
