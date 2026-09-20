import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEPLOYMENT_ENV_SCRUB, stripDeploymentEnv } from '../src/lib/test-env-scrub.js';

describe('DEPLOYMENT_ENV_SCRUB', () => {
  it('covers the AI-199 mechanism variable', () => {
    assert.ok(
      DEPLOYMENT_ENV_SCRUB.includes('PA_RICH_MESSAGES'),
      'PA_RICH_MESSAGES must be scrubbed — it routes worker replies over /sendRichMessage (AI-199)',
    );
  });

  it('does not scrub operational vars the runners pass down', () => {
    for (const operational of ['PA_BUILD_LOCK', 'PA_ALLOW_STALE_DIST', 'PA_TEST_TMP_DIR']) {
      assert.ok(
        !DEPLOYMENT_ENV_SCRUB.includes(operational),
        `${operational} is operational — scrubbing it would break scoped/locked runs`,
      );
    }
  });

  it('scrubs the TypeSafe key and base URL so no test reaches the live API', () => {
    for (const name of ['TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL']) {
      assert.ok(DEPLOYMENT_ENV_SCRUB.includes(name), `${name} must be scrubbed from suite spawns`);
    }
  });
});

describe('stripDeploymentEnv', () => {
  it('removes every listed variable and keeps the rest', () => {
    const env = {
      PA_RICH_MESSAGES: '1',
      PA_OPERATOR_USER_ID: '42',
      PA_BUILD_LOCK: '0',
      PATH: 'C:/x',
      KEEP_ME: 'yes',
    };
    const out = stripDeploymentEnv(env);
    assert.strictEqual(out.PA_RICH_MESSAGES, undefined);
    assert.strictEqual(out.PA_OPERATOR_USER_ID, undefined);
    assert.strictEqual(out.PA_BUILD_LOCK, '0');
    assert.strictEqual(out.PATH, 'C:/x');
    assert.strictEqual(out.KEEP_ME, 'yes');
  });

  it('returns a copy — the input object is not mutated', () => {
    const env = { PA_RICH_MESSAGES: '1', PA_BUILD_LOCK: '0' };
    const out = stripDeploymentEnv(env);
    assert.strictEqual(env.PA_RICH_MESSAGES, '1');
    assert.strictEqual(out.PA_BUILD_LOCK, '0');
  });
});
