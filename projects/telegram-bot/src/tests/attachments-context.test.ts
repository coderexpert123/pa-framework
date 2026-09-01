import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildPrompt } from '../context.js';
import type { ConversationState } from '../types.js';
import { waitForDrain } from './test-teardown-guard.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'attachments-context-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  await waitForDrain();
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

function makeState(): ConversationState {
  return { chat_id: -1001234567890, thread_id: 0, last_update_id: 0, turns: [] } as ConversationState;
}

describe('buildPrompt attachments (WPE3)', () => {
  it('renders an Attachments section with the spec-exact line format', async () => {
    const prompt = await buildPrompt('summarize this', makeState(), undefined, undefined, undefined, {
      attachments: [{ filename: 'report.pdf', path: '/home/user/.pa/attachments/-1001234567890/2026-08-18/x.pdf' }],
    });
    assert.ok(prompt.includes('## Attachments'), 'section present');
    assert.ok(
      prompt.includes('[Attachment: report.pdf at /home/user/.pa/attachments/-1001234567890/2026-08-18/x.pdf]'),
      'spec-exact injection line',
    );
  });

  it('renders multiple attachments as a list', async () => {
    const prompt = await buildPrompt('see files', makeState(), undefined, undefined, undefined, {
      attachments: [
        { filename: 'a.pdf', path: '/tmp/a.pdf' },
        { filename: 'b.png', path: '/tmp/b.png' },
      ],
    });
    const lines = prompt.split('\n').filter((l) => l.startsWith('- [Attachment:'));
    assert.equal(lines.length, 2);
  });

  it('no Attachments section when none provided', async () => {
    const prompt = await buildPrompt('plain message', makeState());
    assert.ok(!prompt.includes('## Attachments'));
  });

  it('attachments section sits before Current Message and after Replying To', async () => {
    const prompt = await buildPrompt('msg', makeState(), undefined, 'reply ctx', undefined, {
      attachments: [{ filename: 'a.pdf', path: '/tmp/a.pdf' }],
    });
    const idxReply = prompt.indexOf('## Replying To');
    const idxAttach = prompt.indexOf('## Attachments');
    const idxCurrent = prompt.indexOf('## Current Message');
    assert.ok(idxReply >= 0 && idxAttach > idxReply && idxCurrent > idxAttach, 'ordering reply < attachments < current');
  });
});
