/**
 * Tests for catchup.ts's pure "▶ Run now" keyboard helper (WP-P2,
 * the 2026-08-24 buttons-program spec §3.2/§3.3).
 *
 * Dynamic import (not static), mirroring catchup.test.ts's own convention for
 * this module — catchup.ts pulls in the blackboard singleton and other
 * command-layer modules, and this file's own doc comment records the
 * project's established caution about static imports of pa/src/commands
 * files baking in module-load-time state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('runNowKeyboard (pure)', () => {
  it('returns the "▶ Run now" keyboard for an eligible skill name (kind: run)', async () => {
    const { runNowKeyboard } = await import('../src/commands/catchup.js');
    assert.deepEqual(runNowKeyboard('run', 'daily-mail-brief'), {
      inline_keyboard: [[{ text: '▶ Run now', callback_data: 'sk:run:daily-mail-brief' }]],
    });
  });

  it('undefined for a protected skill (PA_META_PROTECTED_SKILLS member), kind: run', async () => {
    const { runNowKeyboard } = await import('../src/commands/catchup.js');
    assert.equal(runNowKeyboard('run', 'push'), undefined);
  });

  it('undefined for a 41-char name (over the 40-char cap)', async () => {
    const { runNowKeyboard } = await import('../src/commands/catchup.js');
    const longName = 'a'.repeat(41);
    assert.equal(longName.length, 41);
    assert.equal(runNowKeyboard('run', longName), undefined);
  });

  it('undefined for a malformed name ("Bad Name" — space and uppercase)', async () => {
    const { runNowKeyboard } = await import('../src/commands/catchup.js');
    assert.equal(runNowKeyboard('run', 'Bad Name'), undefined);
  });

  it('every other protected skill is also blocked for kind: run', async () => {
    const { runNowKeyboard } = await import('../src/commands/catchup.js');
    for (const name of ['self-improver', 'commit', 'push-public', 'investigate-flagged', 'update-brain']) {
      assert.equal(runNowKeyboard('run', name), undefined, `${name} must be blocked`);
    }
  });

  it('kind: job has no protected-set concept — a maintenance job named "push" is NOT blocked', async () => {
    const { runNowKeyboard } = await import('../src/commands/catchup.js');
    assert.deepEqual(runNowKeyboard('job', 'push'), {
      inline_keyboard: [[{ text: '▶ Run now', callback_data: 'sk:job:push' }]],
    });
  });

  it('a 40-char name (exactly at the cap) is accepted', async () => {
    const { runNowKeyboard } = await import('../src/commands/catchup.js');
    const name = 'a'.repeat(40);
    assert.equal(name.length, 40);
    const kb = runNowKeyboard('run', name);
    assert.ok(kb);
    assert.equal(kb!.inline_keyboard[0][0].callback_data, `sk:run:${name}`);
  });
});
