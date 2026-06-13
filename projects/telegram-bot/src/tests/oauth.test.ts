import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOAuthCompletionMessage,
  launchOAuthResumeAction,
  normalizeResumeAction,
  redactAuthCommand,
  resolveOAuthResumeHookPath,
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
      cwd: 'D:/Personal Assistant',
      env: {} as NodeJS.ProcessEnv,
      fileExists: () => false,
    });
    assert.equal(status, 'missing_hook');
  });

  it('spawns the configured hook with a base64 payload', () => {
    const action: OAuthResumeAction = { type: 'run_pa_skill', skill: 'daily-mail-brief' };
    let captured: { command: string; args: string[]; cwd: string } | undefined;

    const status = launchOAuthResumeAction(action, {
      cwd: 'D:/Personal Assistant',
      env: { PA_TELEGRAM_OAUTH_RESUME_HOOK: 'C:/Users/test/.pa/oauth_resume_hook.py' } as NodeJS.ProcessEnv,
      spawner: (command, args, options) => {
        captured = { command, args, cwd: options.cwd };
        return { unref() {} };
      },
    });

    assert.equal(status, 'started');
    assert.ok(captured);
    assert.equal(captured.command, 'python');
    assert.equal(captured.cwd, 'D:/Personal Assistant');
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
