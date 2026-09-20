/**
 * oauth-mint tests (AI-220 auth broker Phase A, WP-B — closing the §3.4/§3.5
 * Google-state gap): `mintOauthAuthUrl`'s script arm must persist the
 * `state` value the start script now surfaces in its JSON stdout into the
 * broker row, so `/api/v1/auth/callback` (auth-callback.ts) can find a real
 * Google redirect by that same value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintOauthAuthUrl } from '../oauth-mint.js';
import { readAuthRequestRow } from '../auth-providers.js';
import { createInputRequest, createTask, openLedger, transitionTask, upsertTenant } from '../ledger.js';

const FAKE_STATE = 'google-state-xyz';
const FAKE_AUTH_URL = 'https://accounts.google.com/o/oauth2/auth?fake=1';
const FAKE_AUTH_ID = 'auth-abc123';

/** A fake node:child_process.spawn matching the shape runMint consumes
 * (stdout/stderr `.on('data', ...)`, `.on('close', ...)`) — no real python
 * process, no network. */
function fakeSpawn(stdoutJson: string) {
  const proc = {
    stdout: {
      on: (ev: string, cb: (d: Buffer) => void) => {
        if (ev === 'data') queueMicrotask(() => cb(Buffer.from(stdoutJson)));
      },
    },
    stderr: { on: () => {} },
    on: (ev: string, cb: () => void) => {
      if (ev === 'close') queueMicrotask(cb);
    },
  };
  return (() => proc as unknown) as unknown as typeof import('node:child_process').spawn;
}

describe('mintOauthAuthUrl — script arm persists the state into the broker row', () => {
  it("the broker row's state equals the start script's stdout state", async () => {
    const paHomeDir = mkdtempSync(join(tmpdir(), 'voice-inbox-oauth-mint-'));
    const prevPaHome = process.env.PA_HOME;
    process.env.PA_HOME = paHomeDir;
    const ledgerDir = mkdtempSync(join(tmpdir(), 'voice-inbox-oauth-mint-ledger-'));
    const db = openLedger(join(ledgerDir, 'ledger.sqlite'));
    try {
      const tenant = upsertTenant(db, { telegramUserId: 42, telegramChatId: -1001234567890, displayName: 'Op' });
      const task = createTask(db, tenant.tenant_id, { source: 'text', requestText: 'authorize google' });
      transitionTask(db, tenant.tenant_id, task.task_id, 'routed', { eventKind: 'task.routed' });
      transitionTask(db, tenant.tenant_id, task.task_id, 'running', { eventKind: 'task.progress' });
      const created = createInputRequest(db, tenant.tenant_id, task.task_id, {
        kind: 'oauth',
        prompt: 'Grant Google access',
        params: { provider: 'google' },
      });

      const secretsFile = join(ledgerDir, 'secrets.env');
      writeFileSync(secretsFile, 'GOOGLE_AUTH_REDIRECT_URI=https://example.test/bridge\n', 'utf8');

      const stdoutJson = JSON.stringify({
        status: 'ok',
        auth_url: FAKE_AUTH_URL,
        auth_id: FAKE_AUTH_ID,
        state: FAKE_STATE,
        reused: false,
        sent: false,
      });

      const authUrl = await mintOauthAuthUrl(
        db,
        { tenant, request: created.request },
        {
          repoRoot: ledgerDir, // never actually joined-and-spawned — spawnFn is faked
          secretsFilePath: secretsFile,
          spawnFn: fakeSpawn(stdoutJson),
        }
      );

      assert.equal(authUrl, FAKE_AUTH_URL);

      const row = readAuthRequestRow(created.request.request_id);
      assert.ok(row, 'expected a broker row to have been written');
      assert.equal(row?.state, FAKE_STATE);
      assert.equal(row?.provider, 'google');
      assert.equal(row?.auth_id, FAKE_AUTH_ID);
      assert.equal(row?.redirect_uri, 'https://example.test/bridge');
      assert.equal(row?.status, 'pending');
    } finally {
      db.close();
      rmSync(ledgerDir, { recursive: true, force: true });
      rmSync(paHomeDir, { recursive: true, force: true });
      if (prevPaHome === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = prevPaHome;
    }
  });
});
