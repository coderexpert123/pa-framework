import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOAuthCompletionMessage,
  launchOAuthResumeAction,
  normalizeResumeAction,
  redactAuthCommand,
  resolveOAuthResumeHookPath,
  validateTopicResumeAction,
  type OAuthResumeAction,
} from '../oauth.js';

describe('normalizeResumeAction', () => {
  it('returns resume_action when present', () => {
    const action = { type: 'custom', description: 'Retry custom job' };
    assert.deepEqual(normalizeResumeAction({ resume_action: action }), action);
  });

  it('converts legacy retry_action into an opaque resume action', () => {
    assert.deepEqual(normalizeResumeAction({ retry_action: 'daily-mail-brief' }), {
      type: 'legacy_pa_run_skill',
      skill: 'daily-mail-brief',
      description: 'Retry skill: daily-mail-brief',
    });
  });
});

describe('redactAuthCommand', () => {
  it('never stores raw OAuth codes in bot history', () => {
    assert.equal(redactAuthCommand(), '/auth [redacted]');
  });
});

describe('resolveOAuthResumeHookPath', () => {
  it('prefers explicit env configuration', () => {
    const env = { PA_TELEGRAM_OAUTH_RESUME_HOOK: 'C:/custom/hook.py' } as NodeJS.ProcessEnv;
    assert.equal(resolveOAuthResumeHookPath(env), 'C:/custom/hook.py');
  });

  it('falls back to PA_HOME/oauth_resume_hook.py when present', () => {
    const env = { PA_HOME: 'C:/Users/test/.pa' } as NodeJS.ProcessEnv;
    const expected = join('C:/Users/test/.pa', 'oauth_resume_hook.py');
    const hook = resolveOAuthResumeHookPath(env, (path) => path === expected);
    assert.equal(hook, expected);
  });

  it('returns undefined when no hook is configured', () => {
    const env = { PA_HOME: 'C:/Users/test/.pa' } as NodeJS.ProcessEnv;
    assert.equal(resolveOAuthResumeHookPath(env, () => false), undefined);
  });
});

describe('launchOAuthResumeAction', () => {
  it('returns missing_hook when no hook is configured', () => {
    const action: OAuthResumeAction = { type: 'custom' };
    const status = launchOAuthResumeAction(action, {
      cwd: 'C:/pa-checkout',
      env: {} as NodeJS.ProcessEnv,
      fileExists: () => false,
    });
    assert.equal(status, 'missing_hook');
  });

  it('spawns the configured hook with a base64 payload', () => {
    const action: OAuthResumeAction = { type: 'run_pa_skill', skill: 'daily-mail-brief' };
    let captured: { command: string; args: string[]; cwd: string } | undefined;

    const status = launchOAuthResumeAction(action, {
      cwd: 'C:/pa-checkout',
      // PYTHON pinned so this assertion is platform-independent — without it,
      // resolvePythonCommand's real POSIX branch would probe python3/python
      // for real on a POSIX CI runner instead of returning a fixed value.
      env: {
        PA_TELEGRAM_OAUTH_RESUME_HOOK: 'C:/Users/test/.pa/oauth_resume_hook.py',
        PYTHON: 'python',
      } as NodeJS.ProcessEnv,
      spawner: (command, args, options) => {
        captured = { command, args, cwd: options.cwd };
        return { unref() {} };
      },
    });

    assert.equal(status, 'started');
    assert.ok(captured);
    assert.equal(captured.command, 'python');
    assert.equal(captured.cwd, 'C:/pa-checkout');
    assert.deepEqual(captured.args.slice(0, 2), [
      'C:/Users/test/.pa/oauth_resume_hook.py',
      '--resume-action-base64',
    ]);
    const decoded = JSON.parse(Buffer.from(captured.args[2], 'base64').toString('utf8'));
    assert.deepEqual(decoded, action);
  });
});

describe('buildOAuthCompletionMessage', () => {
  it('mentions automatic resume when a hook started the saved action', () => {
    const message = buildOAuthCompletionMessage({
      status: 'success',
      expiry: '2026-05-28T18:00:00Z',
      resume_action: { description: 'Retry the daily mail brief' },
    }, 'started');

    assert.match(message, /Google authentication successful/i);
    assert.match(message, /Resuming saved action: Retry the daily mail brief/);
  });

  it('warns when auth succeeded but no resume hook exists', () => {
    const message = buildOAuthCompletionMessage({
      status: 'success',
      expiry: '2026-05-28T18:00:00Z',
      resume_action: { description: 'Retry the daily mail brief' },
    }, 'missing_hook');

    assert.match(message, /No OAuth resume hook is configured/i);
  });
});

describe('validateTopicResumeAction (AI-181)', () => {
  it('accepts a valid minimal topic_resume action and trims the prompt', () => {
    const result = validateTopicResumeAction({
      type: 'topic_resume',
      prompt: ' continue the contact add ',
    });
    assert.deepEqual(result, { ok: true, prompt: 'continue the contact add' });
  });

  it('rejects an action with extra keys beyond type and prompt', () => {
    const result = validateTopicResumeAction({
      type: 'topic_resume',
      prompt: 'continue',
      description: 'extra key',
    } as any);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'topic_resume must have exactly the keys "type" and "prompt"');
  });

  it('rejects a non-topic_resume action type', () => {
    const result = validateTopicResumeAction({ type: 'run_pa_skill', skill: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not a topic_resume action');
  });

  it('rejects when prompt is not a string', () => {
    const result = validateTopicResumeAction({
      type: 'topic_resume',
      prompt: 123 as any,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'topic_resume.prompt must be a string');
  });

  it('rejects an empty or whitespace-only prompt', () => {
    const result1 = validateTopicResumeAction({ type: 'topic_resume', prompt: '' });
    const result2 = validateTopicResumeAction({ type: 'topic_resume', prompt: '   ' });
    assert.equal(result1.ok, false);
    assert.equal(result1.error, 'topic_resume.prompt must not be empty');
    assert.equal(result2.ok, false);
    assert.equal(result2.error, 'topic_resume.prompt must not be empty');
  });

  it('rejects a prompt containing newlines', () => {
    const result1 = validateTopicResumeAction({ type: 'topic_resume', prompt: 'continue\nnow' });
    const result2 = validateTopicResumeAction({ type: 'topic_resume', prompt: 'continue\rnow' });
    assert.equal(result1.ok, false);
    assert.equal(result1.error, 'topic_resume.prompt must be a single line');
    assert.equal(result2.ok, false);
    assert.equal(result2.error, 'topic_resume.prompt must be a single line');
  });

  it('rejects a prompt over 500 characters', () => {
    const result = validateTopicResumeAction({
      type: 'topic_resume',
      prompt: 'x'.repeat(501),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'topic_resume.prompt exceeds 500 characters');
  });

  it('accepts a prompt exactly 500 characters', () => {
    const result = validateTopicResumeAction({
      type: 'topic_resume',
      prompt: 'x'.repeat(500),
    });
    assert.deepEqual(result, { ok: true, prompt: 'x'.repeat(500) });
  });

  it('rejects a prompt that starts with / after trimming', () => {
    const result = validateTopicResumeAction({ type: 'topic_resume', prompt: '/continue' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'topic_resume.prompt must not start with "/"');
  });

  it('rejects a prompt with leading spaces that starts with / after trim', () => {
    const result = validateTopicResumeAction({ type: 'topic_resume', prompt: '  /continue' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'topic_resume.prompt must not start with "/"');
  });
});

describe('buildOAuthCompletionMessage: topic_resume + interim line (AI-181)', () => {
  it('renders topic_resumed with same topic as "to this topic"', () => {
    const message = buildOAuthCompletionMessage(
      {
        status: 'success',
        resume_action: { type: 'topic_resume', prompt: 'continue the contact add' },
        chat_id: '-1001234567890',
        thread_id: 5002,
      },
      'topic_resumed',
      { chatId: -1001234567890, threadId: 5002 }
    );
    assert.match(message, /dispatched to this topic:/);
    assert.doesNotMatch(message, /dispatched to chat/);
  });

  it('renders topic_resumed with different thread as full chat+thread form', () => {
    const message = buildOAuthCompletionMessage(
      {
        status: 'success',
        resume_action: { type: 'topic_resume', prompt: 'continue the contact add' },
        chat_id: '-1001234567890',
        thread_id: 5002,
      },
      'topic_resumed',
      { chatId: -1009999999999, threadId: 999 }
    );
    assert.match(message, /dispatched to chat -1001234567890 thread 5002:/);
  });

  it('renders topic_resumed without source (no crash on undefined)', () => {
    const message = buildOAuthCompletionMessage(
      {
        status: 'success',
        resume_action: { type: 'topic_resume', prompt: 'continue the contact add' },
        chat_id: '-1001234567890',
        thread_id: 5002,
      },
      'topic_resumed'
    );
    assert.match(message, /dispatched to chat -1001234567890 thread 5002:/);
  });

  it('renders topic_resume_failed with tell-it-to-continue guidance', () => {
    const message = buildOAuthCompletionMessage(
      {
        status: 'success',
        resume_action: { type: 'topic_resume', prompt: 'continue' },
        chat_id: '-100123',
      },
      'topic_resume_failed'
    );
    assert.match(message, /could not be resumed automatically/);
    assert.match(message, /tell it to continue/);
  });

  it('renders interim dead-end line when no resume_action but chat_id present', () => {
    const message = buildOAuthCompletionMessage(
      {
        status: 'success',
        chat_id: '-100123',
      },
      'not_needed'
    );
    assert.match(message, /No resume action was attached — if a task was waiting, tell it to continue/);
  });

  it('does NOT render interim line when no chat_id present', () => {
    const message = buildOAuthCompletionMessage(
      {
        status: 'success',
      },
      'not_needed'
    );
    assert.doesNotMatch(message, /No resume action was attached/);
  });

  it('truncates prompt excerpt to 120 chars', () => {
    const longPrompt = 'continue the task '.repeat(50);
    const message = buildOAuthCompletionMessage(
      {
        status: 'success',
        resume_action: { type: 'topic_resume', prompt: longPrompt },
        chat_id: '-100123',
      },
      'topic_resumed',
      { chatId: -100123, threadId: 0 }
    );
    assert.match(message, /"continue the task continue the task/);
    const excerptMatch = message.match(/"([^"]+)"/);
    assert.ok(excerptMatch);
    assert.ok(excerptMatch[1].length <= 120);
  });
});
