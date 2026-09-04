import './test-env-guard.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { injectSystemResumeUpdate } from '../main.js';
import { AUTH_PATTERN, REAUTH_PATTERN, AGENT_BARE_PATTERN } from '../logic.js';

describe('injectSystemResumeUpdate (AI-181)', () => {
  it('builds a system_resume synthetic for a forum thread', (t) => {
    const injected: any[] = [];
    const injectFn = (u: any) => injected.push(u);

    const updateId = injectSystemResumeUpdate(
      { chatId: -1001234567890, threadId: 5002, prompt: 'continue the contact add' },
      injectFn
    );

    assert.strictEqual(injected.length, 1);
    const update = injected[0];

    assert.strictEqual(update.__synthetic, 'system_resume');
    assert.strictEqual(update.message.text, '[System: auto-resumed after Google auth] continue the contact add');
    assert.strictEqual(update.message.chat.id, -1001234567890);
    assert.strictEqual(update.message.chat.type, 'supergroup');
    assert.strictEqual(update.message.message_thread_id, 5002);
    assert.strictEqual(update.message.message_id, 0);
    assert.deepStrictEqual(update.message.from, { id: 0, first_name: 'PA system' });
    assert.strictEqual(typeof update.message.date, 'number');
    assert.ok(update.message.date > 0);
    assert.strictEqual(typeof updateId, 'number');
    assert.ok(updateId > 0);
  });

  it('threadId 0 omits message_thread_id and marks the chat private', (t) => {
    const injected: any[] = [];
    const injectFn = (u: any) => injected.push(u);

    injectSystemResumeUpdate(
      { chatId: -1001234567890, threadId: 0, prompt: 'continue the contact add' },
      injectFn
    );

    assert.strictEqual(injected.length, 1);
    const update = injected[0];

    assert.strictEqual(update.message.message_thread_id, undefined);
    assert.strictEqual(update.message.chat.type, 'private');
  });

  it('returned update ids are strictly increasing across calls', (t) => {
    const injectFn = () => {};

    const id1 = injectSystemResumeUpdate({ chatId: -1001234567890, threadId: 0, prompt: 'first' }, injectFn);
    const id2 = injectSystemResumeUpdate({ chatId: -1001234567890, threadId: 0, prompt: 'second' }, injectFn);
    const id3 = injectSystemResumeUpdate({ chatId: -1001234567890, threadId: 0, prompt: 'third' }, injectFn);

    assert.ok(id2 > id1);
    assert.ok(id3 > id2);
  });

  it('label cannot collide with command patterns', (t) => {
    const injected: any[] = [];
    const injectFn = (u: any) => injected.push(u);

    injectSystemResumeUpdate(
      { chatId: -1001234567890, threadId: 5002, prompt: 'continue the contact add' },
      injectFn
    );

    const text = injected[0].message.text;
    assert.strictEqual(AUTH_PATTERN.test(text), false);
    assert.strictEqual(REAUTH_PATTERN.test(text), false);
    assert.strictEqual(AGENT_BARE_PATTERN.test(text), false);
  });
});
