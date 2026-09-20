/**
 * Auth-prompt sentinel nudge (auth broker Phase A, 2026-09-10 build spec §5
 * WP-G, decisions C6/D8). Pins nudgeAuthPrompt directly with injected
 * recentAuthRequestsFn and sendFn — no real ~/.pa/auth/requests/ I/O, no
 * spawn. Isolation mirrors dispatch.test.ts: PA_HOME points at a fresh temp
 * dir before the dynamic import, since some transitive import in dispatch.ts
 * reads it at load time.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { CommandResult } from '../../../../pa/dist/src/types.js';
import { rmRetry } from './rm-retry.js';

let sharedTempDir: string;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'dispatch-auth-sentinel-test-'));
  process.env.PA_HOME = sharedTempDir;
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

const { nudgeAuthPrompt, AUTH_PROMPT_NUDGE_TEXT } = await import('../dispatch.js');

function makeResult(extra: Partial<CommandResult> = {}): CommandResult {
  return { success: true, output: 'the delivered reply text', exitCode: 0, ...extra };
}

describe('dispatch — auth sentinel nudge', () => {
  it('nudges exactly once, with the exact G-E4 text, when no broker request was minted', async () => {
    const sends: Array<[string, number, string, number | undefined, number | undefined]> = [];
    const result = makeResult({ authPrompts: ['Enter the code shown on your phone.'] });
    await nudgeAuthPrompt(
      {
        secrets: { TELEGRAM_BOT_TOKEN: 'tok-1' },
        sinceIso: '2026-09-10T06:00:00.000Z',
        recentAuthRequestsFn: () => 0,
        sendFn: (async (token, chatId, text, replyTo, threadId) => {
          sends.push([token, chatId, text, replyTo, threadId]);
          return true;
        }) as any,
      },
      result,
      -100123,
      29
    );
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0], ['tok-1', -100123, AUTH_PROMPT_NUDGE_TEXT, undefined, 29]);
  });

  it('does not nudge when a broker request row already exists', async () => {
    const sends: unknown[] = [];
    const result = makeResult({ authPrompts: ['Paste the code here'] });
    await nudgeAuthPrompt(
      {
        secrets: { TELEGRAM_BOT_TOKEN: 'tok-1' },
        sinceIso: '2026-09-10T06:00:00.000Z',
        recentAuthRequestsFn: () => 1,
        sendFn: (async (...args: unknown[]) => { sends.push(args); return true; }) as any,
      },
      result,
      -100123,
      29
    );
    assert.equal(sends.length, 0);
  });

  it('does not nudge when the result carries no authPrompts', async () => {
    const sends: unknown[] = [];
    const recentCalls: string[] = [];
    const result = makeResult();
    await nudgeAuthPrompt(
      {
        secrets: { TELEGRAM_BOT_TOKEN: 'tok-1' },
        sinceIso: '2026-09-10T06:00:00.000Z',
        recentAuthRequestsFn: (sinceIso: string) => { recentCalls.push(sinceIso); return 0; },
        sendFn: (async (...args: unknown[]) => { sends.push(args); return true; }) as any,
      },
      result,
      -100123,
      29
    );
    assert.equal(sends.length, 0);
    // Short-circuits before even consulting the broker store when there is
    // nothing to nudge about.
    assert.equal(recentCalls.length, 0);
  });

  it('never alters the delivered reply text, even when the send itself fails', async () => {
    // Fail-silent by contract is the CALL SITE's job (runDispatchCascade
    // wraps this in .catch(), same as the alertRawTelegramSends precedent —
    // never awaited into the reply path), not nudgeAuthPrompt's own job. What
    // this pins is narrower and unconditional: whether the send succeeds or
    // rejects, the CommandResult the caller is about to deliver as the reply
    // is never read back into or mutated by the nudge.
    const result = makeResult({ authPrompts: ['one-time code: 123456'] });
    const before = { ...result };
    await assert.rejects(
      nudgeAuthPrompt(
        {
          secrets: { TELEGRAM_BOT_TOKEN: 'tok-1' },
          sinceIso: '2026-09-10T06:00:00.000Z',
          recentAuthRequestsFn: () => 0,
          sendFn: (async () => { throw new Error('network down'); }) as any,
        },
        result,
        -100123,
        29
      ),
      /network down/
    );
    assert.deepEqual(result, before);
    assert.equal(result.output, 'the delivered reply text');
  });

  it('skips silently when there is no bot token', async () => {
    const sends: unknown[] = [];
    const result = makeResult({ authPrompts: ['Enter the code shown on your phone.'] });
    await nudgeAuthPrompt(
      {
        secrets: {},
        sinceIso: '2026-09-10T06:00:00.000Z',
        recentAuthRequestsFn: () => 0,
        sendFn: (async (...args: unknown[]) => { sends.push(args); return true; }) as any,
      },
      result,
      -100123,
      29
    );
    assert.equal(sends.length, 0);
  });
});
