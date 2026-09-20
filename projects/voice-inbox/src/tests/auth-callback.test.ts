/**
 * Auth callback tests (AI-220 auth broker Phase A, WP-B, §3.5): the reserved-
 * path invariant, and the generic state/single-use/expiry/exchange flow —
 * every negative case is shown to fail on its known-bad input, never merely
 * asserted to pass on a good one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_CALLBACK_PATH,
  AUTH_PAGE_FAIL,
  AUTH_PAGE_OK,
  collidesWithRelayReserved,
  handleAuthCallback,
  type AuthCallbackDeps,
  type ScriptRunner,
  type WriteTokenFile,
} from '../auth-callback.js';
import { AUTH_PROVIDER_CONFIGS, type AuthProviderConfig, type AuthRequestRow } from '../auth-providers.js';

// --- fixtures -----------------------------------------------------------------------

const FIXED_NOW = new Date('2026-09-10T06:00:00.000Z');

function makeRow(overrides: Partial<AuthRequestRow> = {}): AuthRequestRow {
  return {
    request_id: 'ir-0123456789ab',
    task_id: 'vi-0123456789ab',
    tenant_id: 't-1234567',
    shape: 'S1',
    provider: 'google',
    kind: 'oauth',
    status: 'pending',
    created_at: '2026-09-10T05:00:00.000Z',
    expires_at: '2026-09-10T18:00:00.000Z',
    state: 'state-abc123',
    code_verifier: null,
    redirect_uri: null,
    auth_id: null,
    answer_pointer: null,
    delivered_at: null,
    ...overrides,
  };
}

interface Harness {
  store: Map<string, AuthRequestRow>;
  scriptCalls: Array<{ script: string; argv: string[] }>;
  fetchCalls: Array<{ url: string; body: string }>;
  tokenWrites: Array<{ path: string; contents: string; mode: number }>;
  answerCalls: Array<{ tenantId: string; taskId: string; requestId: string; pointer: string }>;
  deps: AuthCallbackDeps;
}

function makeHarness(opts: {
  scriptResult?: { ok: boolean; parsed: Record<string, unknown> | null };
  fetchFn?: typeof fetch;
} = {}): Harness {
  const store = new Map<string, AuthRequestRow>();
  const scriptCalls: Harness['scriptCalls'] = [];
  const fetchCalls: Harness['fetchCalls'] = [];
  const tokenWrites: Harness['tokenWrites'] = [];
  const answerCalls: Harness['answerCalls'] = [];

  const spawnFn: ScriptRunner = async (script, argv) => {
    scriptCalls.push({ script, argv });
    return opts.scriptResult ?? { ok: true, parsed: { status: 'ok', access_token: 'ya29.fake' } };
  };

  const fetchFn: typeof fetch =
    opts.fetchFn ??
    (async (url, init) => {
      fetchCalls.push({ url: String(url), body: String((init as RequestInit)?.body ?? '') });
      return new Response(JSON.stringify({ access_token: 'fake-token' }), { status: 200 });
    });

  const writeTokenFile: WriteTokenFile = (path, contents, opts2) => {
    tokenWrites.push({ path, contents, mode: opts2.mode });
  };

  const answerFn: AuthCallbackDeps['answerFn'] = async (tenantId, taskId, requestId, pointer) => {
    answerCalls.push({ tenantId, taskId, requestId, pointer });
  };

  const deps: AuthCallbackDeps = {
    readRow: (state) => {
      for (const row of store.values()) {
        if (row.state === state) return row;
      }
      return undefined;
    },
    writeRow: (row) => {
      store.set(row.request_id, row);
    },
    spawnFn,
    fetchFn,
    writeTokenFile,
    answerFn,
    now: () => FIXED_NOW,
  };

  return { store, scriptCalls, fetchCalls, tokenWrites, answerCalls, deps };
}

/** Seed a row through the harness's own `writeRow` (keyed by `request_id`,
 * exactly like production) — never poke `h.store` with an unrelated key. */
function seedRow(h: Harness, overrides: Partial<AuthRequestRow> = {}): AuthRequestRow {
  const row = makeRow(overrides);
  h.deps.writeRow(row);
  return row;
}

// --- suites --------------------------------------------------------------------------

describe('auth callback — state nonce, single use, expiry, reserved paths', () => {
  it('the callback path never collides with the relay reserved surface — and the check can fail', () => {
    assert.equal(collidesWithRelayReserved(AUTH_CALLBACK_PATH), false);
    // Positive controls proving the assertion above is not vacuously true.
    assert.equal(collidesWithRelayReserved('/work'), true);
    assert.equal(collidesWithRelayReserved('/resp'), true);
    assert.equal(collidesWithRelayReserved('/healthz'), true);
    assert.equal(collidesWithRelayReserved('/body/x'), true);
  });

  it('a forged state matching no broker row is a 400 with no network call', async () => {
    const h = makeHarness();
    seedRow(h);
    const result = await handleAuthCallback(
      { state: 'state-forged-does-not-exist', code: 'whatever', error: null },
      h.deps
    );
    assert.equal(result.status, 400);
    assert.equal(result.html, AUTH_PAGE_FAIL);
    assert.equal(h.scriptCalls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
  });

  it('replay: the same state succeeds once, then 400s — the exchange runs exactly once', async () => {
    const h = makeHarness();
    seedRow(h);
    const first = await handleAuthCallback({ state: 'state-abc123', code: 'auth-code', error: null }, h.deps);
    assert.equal(first.status, 200);
    assert.equal(first.html, AUTH_PAGE_OK);

    const second = await handleAuthCallback({ state: 'state-abc123', code: 'auth-code', error: null }, h.deps);
    assert.equal(second.status, 400);
    assert.equal(second.html, AUTH_PAGE_FAIL);
    assert.equal(h.scriptCalls.length, 1);
  });

  it('an expired broker row is a 400 and gets marked expired — zero exchange calls', async () => {
    const h = makeHarness();
    seedRow(h, { expires_at: '2026-09-10T05:59:59.000Z' }); // 1s before FIXED_NOW
    const result = await handleAuthCallback({ state: 'state-abc123', code: 'auth-code', error: null }, h.deps);
    assert.equal(result.status, 400);
    assert.equal(result.html, AUTH_PAGE_FAIL);
    assert.equal(h.scriptCalls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.store.get('ir-0123456789ab')?.status, 'expired');
  });

  it('a provider error cancels the row and returns 200 with the failure page', async () => {
    const h = makeHarness();
    seedRow(h);
    const result = await handleAuthCallback({ state: 'state-abc123', code: null, error: 'access_denied' }, h.deps);
    assert.equal(result.status, 200);
    assert.equal(result.html, AUTH_PAGE_FAIL);
    assert.equal(h.scriptCalls.length, 0);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.store.get('ir-0123456789ab')?.status, 'cancelled');
  });

  it('script exchange happy path: 200, the success page, answerFn called once', async () => {
    const h = makeHarness({ scriptResult: { ok: true, parsed: { status: 'ok', access_token: 'ya29.fake' } } });
    seedRow(h);
    const result = await handleAuthCallback({ state: 'state-abc123', code: 'auth-code', error: null }, h.deps);
    assert.equal(result.status, 200);
    assert.equal(result.html, AUTH_PAGE_OK);
    assert.equal(h.scriptCalls.length, 1);
    assert.equal(h.answerCalls.length, 1);
    assert.equal(h.answerCalls[0].tenantId, 't-1234567');
    assert.equal(h.answerCalls[0].taskId, 'vi-0123456789ab');
    assert.equal(h.answerCalls[0].requestId, 'ir-0123456789ab');
    assert.equal(h.store.get('ir-0123456789ab')?.status, 'answered');
  });

  it('script exchange happy path never writes the provider token_file — the script itself already wrote it (C12 fix, deep-recheck 2026-09-10)', async () => {
    // The script's stdout is a STATUS object, not credentials — writing it
    // over google-token.json would destroy the refresh token the script just
    // saved. Known-bad control: before the fix this assertion failed because
    // handleAuthCallback wrote `tokens` (this very object) to that path.
    const h = makeHarness({ scriptResult: { ok: true, parsed: { status: 'success', expiry: '2026-09-10T18:00:00.000Z' } } });
    seedRow(h);
    const result = await handleAuthCallback({ state: 'state-abc123', code: 'auth-code', error: null }, h.deps);
    assert.equal(result.status, 200);
    assert.equal(
      h.tokenWrites.some((w) => w.path.endsWith('google-token.json')),
      false,
      'the callback must never write the provider token_file for a script exchange'
    );
    assert.equal(
      h.tokenWrites.some((w) => w.path.includes('markers') && w.path.endsWith('ir-0123456789ab.txt')),
      true,
      'the non-secret marker file must still be written'
    );
  });

  it('script exchange failure cancels the row and returns the failure page', async () => {
    const h = makeHarness({ scriptResult: { ok: false, parsed: { error: 'invalid_grant' } } });
    seedRow(h);
    const result = await handleAuthCallback({ state: 'state-abc123', code: 'bad-code', error: null }, h.deps);
    assert.equal(result.status, 400);
    assert.equal(result.html, AUTH_PAGE_FAIL);
    assert.equal(h.answerCalls.length, 0);
    assert.equal(h.store.get('ir-0123456789ab')?.status, 'cancelled');
  });

  it('http exchange happy path: the POST body carries the five fields; token written 0600', async () => {
    const testConfig: AuthProviderConfig = {
      name: 'test-http',
      authorize: { kind: 'http', authorize_url: 'https://example.test/authorize', scopes: ['read'], client_id_key: 'TEST_CLIENT_ID' },
      exchange: { kind: 'http', token_url: 'https://example.test/token', client_id_key: 'TEST_CLIENT_ID' },
      pkce: true,
      token_file: 'test-http-token.json',
    };
    const registry = AUTH_PROVIDER_CONFIGS as Record<string, AuthProviderConfig>;
    registry['test-http'] = testConfig;
    process.env.TEST_CLIENT_ID = 'test-client-id-value';
    try {
      const h = makeHarness();
      seedRow(h, {
        request_id: 'ir-http000001',
        provider: 'test-http',
        state: 'state-http-1',
        code_verifier: 'verifier-value-xyz',
        redirect_uri: 'https://example.test/api/v1/auth/callback',
      });
      const result = await handleAuthCallback(
        { state: 'state-http-1', code: 'http-auth-code', error: null },
        h.deps
      );
      assert.equal(result.status, 200);
      assert.equal(result.html, AUTH_PAGE_OK);
      assert.equal(h.fetchCalls.length, 1);
      const posted = new URLSearchParams(h.fetchCalls[0].body);
      assert.equal(posted.get('grant_type'), 'authorization_code');
      assert.equal(posted.get('code'), 'http-auth-code');
      assert.equal(posted.get('redirect_uri'), 'https://example.test/api/v1/auth/callback');
      assert.equal(posted.get('client_id'), 'test-client-id-value');
      assert.equal(posted.get('code_verifier'), 'verifier-value-xyz');

      const tokenWrite = h.tokenWrites.find((w) => w.path.endsWith('test-http-token.json'));
      assert.ok(tokenWrite, 'expected a token file write for test-http-token.json');
      assert.equal(tokenWrite?.mode, 0o600);
    } finally {
      delete registry['test-http'];
      delete process.env.TEST_CLIENT_ID;
    }
  });

  it('http exchange failure: a non-2xx response never writes a token or answers', async () => {
    const testConfig: AuthProviderConfig = {
      name: 'test-http-fail',
      authorize: { kind: 'http', authorize_url: 'https://example.test/authorize', scopes: [], client_id_key: 'TEST_CLIENT_ID' },
      exchange: { kind: 'http', token_url: 'https://example.test/token', client_id_key: 'TEST_CLIENT_ID' },
      pkce: false,
      token_file: 'test-http-fail-token.json',
    };
    const registry = AUTH_PROVIDER_CONFIGS as Record<string, AuthProviderConfig>;
    registry['test-http-fail'] = testConfig;
    process.env.TEST_CLIENT_ID = 'test-client-id-value';
    try {
      const h = makeHarness({
        fetchFn: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      });
      seedRow(h, { request_id: 'ir-http000002', provider: 'test-http-fail', state: 'state-http-2' });
      const result = await handleAuthCallback(
        { state: 'state-http-2', code: 'bad-code', error: null },
        h.deps
      );
      assert.equal(result.status, 400);
      assert.equal(result.html, AUTH_PAGE_FAIL);
      assert.equal(h.answerCalls.length, 0);
      assert.equal(h.tokenWrites.length, 0);
      assert.equal(h.store.get('ir-http000002')?.status, 'cancelled');
    } finally {
      delete registry['test-http-fail'];
      delete process.env.TEST_CLIENT_ID;
    }
  });
});
