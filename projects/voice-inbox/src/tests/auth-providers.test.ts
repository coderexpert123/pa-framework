/**
 * Auth provider registry tests (AI-220 auth broker Phase A, WP-B): registry
 * completeness against `OAUTH_PROVIDERS` and the four-placeholder argv
 * substitution rule (§3.4).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OAUTH_PROVIDERS } from '../contracts.js';
import { AUTH_PROVIDER_CONFIGS, getProviderConfig, renderArgv } from '../auth-providers.js';

describe('auth provider registry — completeness and argv rendering', () => {
  it('registers exactly the frozen OAUTH_PROVIDERS list, each keyed by its own name', () => {
    assert.deepEqual(Object.keys(AUTH_PROVIDER_CONFIGS), [...OAUTH_PROVIDERS]);
    for (const key of Object.keys(AUTH_PROVIDER_CONFIGS)) {
      assert.equal(AUTH_PROVIDER_CONFIGS[key].name, key);
    }
  });

  it('getProviderConfig looks up a registered provider and misses an unknown one', () => {
    assert.equal(getProviderConfig('google')?.name, 'google');
    assert.equal(getProviderConfig('microsoft'), undefined);
  });

  it('renderArgv substitutes the four placeholders', () => {
    const argv = renderArgv(['--no-send', '--chat-id', '{chat_id}', '--redirect-uri', '{redirect_uri}'], {
      chat_id: '-1001234567890',
      redirect_uri: 'https://example.test/bridge',
    });
    assert.deepEqual(argv, [
      '--no-send',
      '--chat-id',
      '-1001234567890',
      '--redirect-uri',
      'https://example.test/bridge',
    ]);
    assert.deepEqual(
      renderArgv(['--code', '{code}', '--state', '{state}'], { code: 'abc123', state: 'deadbeef' }),
      ['--code', 'abc123', '--state', 'deadbeef']
    );
  });

  it('renderArgv throws on any other placeholder', () => {
    assert.throws(
      () => renderArgv(['--x', '{nope}'], {}),
      /^Error: unknown placeholder in provider argv: \{nope\}$/
    );
  });
});
