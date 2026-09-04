// AI-190 (2026-09-03): unit coverage for the /debug interception pieces —
// ref-ID extraction (present/absent), target resolution (reply-to vs the
// message right before), the task-prompt build (caps, single line, debug
// handle), the operator gate, and task filing through the INJECTED appendTask
// (never the real store). The processUpdate wiring is covered end-to-end in
// poll-loop.test.ts's /debug describe.
import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEBUG_PATTERN,
  buildDebugTaskInput,
  extractRefId,
  handleDebugCommand,
  parseSupportTopicKey,
  resolveDebugTarget,
  type AppendTaskFn,
} from '../debug-command.js';

function recorder(): { fn: AppendTaskFn; calls: Array<{ chatId: number; threadId: number; input: { title: string; prompt: string; createdBy: string } }> } {
  const calls: Array<{ chatId: number; threadId: number; input: { title: string; prompt: string; createdBy: string } }> = [];
  const fn: AppendTaskFn = async (chatId, threadId, input) => {
    calls.push({ chatId, threadId, input });
    return { id: 'tt-0123456789ab', deduped: false };
  };
  return { fn, calls };
}

const SUPPORT = { chatId: -1001234567890, threadId: 5001 };

describe('DEBUG_PATTERN', () => {
  it('matches bare /debug and the @botname form, nothing else', () => {
    assert.ok(DEBUG_PATTERN.test('/debug'));
    assert.ok(DEBUG_PATTERN.test('/debug@example_pa_bot'));
    assert.ok(!DEBUG_PATTERN.test('/debug extra'));
    assert.ok(!DEBUG_PATTERN.test('/debugfoo'));
  });
});

describe('extractRefId', () => {
  it('extracts from the canonical _Ref: s-…_ trailer', () => {
    assert.equal(extractRefId('Reply body\n\n_Ref: s-1a2b3c4d5e6f_'), 's-1a2b3c4d5e6f');
  });

  it('extracts from the plain-text Ref: form (edited/quoted originals)', () => {
    assert.equal(extractRefId('Reply body\n\nRef: s-1a2b3c4d5e6f'), 's-1a2b3c4d5e6f');
  });

  it('returns null when no trailer is present', () => {
    assert.equal(extractRefId('just some user text'), null);
    assert.equal(extractRefId(''), null);
    assert.equal(extractRefId(undefined), null);
  });
});

describe('parseSupportTopicKey', () => {
  it('parses a negative supergroup chat id and thread', () => {
    assert.deepEqual(parseSupportTopicKey('-1001234567890_5001'), { chatId: -1001234567890, threadId: 5001 });
  });

  it('rejects malformed keys', () => {
    assert.equal(parseSupportTopicKey('garbage'), null);
    assert.equal(parseSupportTopicKey('310'), null);
    assert.equal(parseSupportTopicKey(''), null);
  });

  it('the documented synthetic key parses to the SUPPORT shape the filing tests use', () => {
    assert.deepEqual(parseSupportTopicKey('-1001234567890_5001'), SUPPORT);
  });

  it('rejects the unset-key shape: an empty string returns null (config-or-error, no fallback)', () => {
    assert.equal(parseSupportTopicKey(''), null);
    assert.equal(parseSupportTopicKey('   '), null);
  });
});

describe('resolveDebugTarget', () => {
  it('a reply-to wins: text + message id come from the replied-to message', () => {
    const target = resolveDebugTarget(
      { text: 'worker reply\n\n_Ref: s-aaaabbbbcccc_', message_id: 41 },
      [{ role: 'user', text: 'earlier', message_id: 40 }],
      42
    );
    assert.deepEqual(target, { text: 'worker reply\n\n_Ref: s-aaaabbbbcccc_', messageId: 41 });
  });

  it('no reply-to falls back to the newest turn that is not the /debug message itself', () => {
    const turns = [
      { role: 'user' as const, text: 'first', message_id: 10 },
      { role: 'assistant' as const, text: 'answer with _Ref: s-ddddeeeeffff_', message_id: undefined },
      { role: 'user' as const, text: '/debug', message_id: 43 },
    ];
    const target = resolveDebugTarget(undefined, turns, 43);
    assert.deepEqual(target, { text: 'answer with _Ref: s-ddddeeeeffff_', messageId: undefined });
  });

  it('an empty topic resolves to an empty target (caller replies "nothing to debug")', () => {
    assert.deepEqual(resolveDebugTarget(undefined, [], 44), {});
  });

  it('a caption-only reply-to (media) still resolves', () => {
    const target = resolveDebugTarget({ caption: 'photo caption', message_id: 9 }, [], 10);
    assert.deepEqual(target, { text: 'photo caption', messageId: 9 });
  });
});

describe('buildDebugTaskInput', () => {
  it('with a ref-ID, the ref is the debug handle in title and prompt', () => {
    const { title, prompt } = buildDebugTaskInput({
      target: { text: 'Something broke\n\n_Ref: s-1a2b3c4d5e6f_', messageId: 41 },
      refId: 's-1a2b3c4d5e6f',
      chatId: 555,
      threadId: 7,
    });
    assert.ok(title.includes('s-1a2b3c4d5e6f'));
    assert.ok(prompt.includes('pa ref s-1a2b3c4d5e6f'), 'the prompt must name the pa ref lookup');
    assert.ok(!prompt.startsWith('/'), 'validateTaskPrompt rejects a leading slash');
  });

  it('without a ref-ID, text + message id + thread identify the target', () => {
    const { title, prompt } = buildDebugTaskInput({
      target: { text: 'plain user text', messageId: 77 },
      refId: null,
      chatId: 555,
      threadId: 7,
    });
    assert.ok(title.includes('msg 77'));
    assert.ok(prompt.includes('message 77'));
    assert.ok(prompt.includes('thread 7'));
    assert.ok(!prompt.includes('pa ref'), 'no ref lookup instructed when there is no ref');
  });

  it('the prompt stays a single line within pa\'s 500-char cap even for long target text', () => {
    const { prompt } = buildDebugTaskInput({
      target: { text: 'x'.repeat(2000), messageId: 5 },
      refId: null,
      chatId: 555,
      threadId: 7,
    });
    assert.ok(prompt.length <= 500, `got ${prompt.length}`);
    assert.ok(!/[\r\n]/.test(prompt));
  });
});

describe('handleDebugCommand', () => {
  const target = { text: 'worker reply\n\n_Ref: s-1a2b3c4d5e6f_', messageId: 41 };

  it('files a task to the support topic with the ref-ID handle and returns the task id', async () => {
    const { fn, calls } = recorder();
    const result = await handleDebugCommand({
      userId: '42',
      operatorId: '42',
      target,
      chatId: 555,
      threadId: 7,
      support: SUPPORT,
      appendTaskFn: fn,
    });
    assert.equal(result.filed, true);
    assert.ok(result.response.includes('tt-0123456789ab'), 'the confirmation must include the task id');
    assert.ok(result.response.includes('s-1a2b3c4d5e6f'));
    assert.equal(calls.length, 1);
    assert.deepEqual(
      { chatId: calls[0].chatId, threadId: calls[0].threadId },
      SUPPORT,
      'the task must land on the pa-support topic'
    );
    assert.ok(calls[0].input.prompt.includes('pa ref s-1a2b3c4d5e6f'));
    assert.equal(calls[0].input.createdBy, 'operator');
  });

  it('a non-operator is refused and nothing is filed', async () => {
    const { fn, calls } = recorder();
    const result = await handleDebugCommand({
      userId: '999',
      operatorId: '42',
      target,
      chatId: 555,
      threadId: 7,
      support: SUPPORT,
      appendTaskFn: fn,
    });
    assert.equal(result.filed, false);
    assert.ok(result.response.includes('operator-only'));
    assert.equal(calls.length, 0);
  });

  it('fail-closed when PA_OPERATOR_USER_ID is not configured at all', async () => {
    const { fn, calls } = recorder();
    const result = await handleDebugCommand({
      userId: '42',
      operatorId: undefined,
      target,
      chatId: 555,
      threadId: 7,
      support: SUPPORT,
      appendTaskFn: fn,
    });
    assert.equal(result.filed, false);
    assert.equal(calls.length, 0);
  });

  it('nothing to debug (no reply-to, no prior turns) refuses without filing', async () => {
    const { fn, calls } = recorder();
    const result = await handleDebugCommand({
      userId: '42',
      operatorId: '42',
      target: {},
      chatId: 555,
      threadId: 7,
      support: SUPPORT,
      appendTaskFn: fn,
    });
    assert.equal(result.filed, false);
    assert.equal(calls.length, 0);
  });

  it('an appendTask failure is reported, never thrown, and files nothing', async () => {
    const fn: AppendTaskFn = async () => {
      throw new Error('task.prompt exceeds 500 characters');
    };
    const result = await handleDebugCommand({
      userId: '42',
      operatorId: '42',
      target,
      chatId: 555,
      threadId: 7,
      support: SUPPORT,
      appendTaskFn: fn,
    });
    assert.equal(result.filed, false);
    assert.ok(result.response.includes('Failed to file'));
    assert.ok(result.response.includes('task.prompt exceeds 500 characters'));
  });
});
