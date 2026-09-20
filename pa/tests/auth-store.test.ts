/**
 * Auth broker store tests (auth broker Phase A, 2026-09-10 build spec,
 * WP-D). Each of the three security-relevant properties (key order, 0600,
 * delivered-once) is proven with a known-bad case shown to fail first.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  authDir,
  requestsDir,
  writeRow,
  readRow,
  markDelivered,
  type AuthRequestRow,
} from '../src/lib/auth/store.js';
import { loadProfiles, upsertProfile, type AuthProfile } from '../src/lib/auth/profiles.js';

const ROW_KEY_ORDER = [
  'request_id',
  'task_id',
  'tenant_id',
  'shape',
  'provider',
  'kind',
  'status',
  'created_at',
  'expires_at',
  'state',
  'code_verifier',
  'redirect_uri',
  'auth_id',
  'answer_pointer',
  'delivered_at',
];

function baseRow(overrides: Partial<AuthRequestRow> = {}): AuthRequestRow {
  return {
    request_id: 'ir-0123456789ab',
    task_id: 'vi-0123456789ab',
    tenant_id: 't-1234567',
    shape: 'S1',
    provider: 'google',
    kind: 'oauth',
    status: 'pending',
    created_at: '2026-09-10T06:00:00.000Z',
    expires_at: '2026-09-10T18:00:00.000Z',
    state: null,
    code_verifier: null,
    redirect_uri: null,
    auth_id: 'a1b2c3d4e5f6a7b8',
    answer_pointer: null,
    delivered_at: null,
    ...overrides,
  };
}

describe('auth broker store — key order, 0600, delivered-once', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('writes a row whose Object.keys deep-equals the §3.3 order', () => {
    const row = baseRow();
    writeRow(row);
    const raw = JSON.parse(readFileSync(join(requestsDir(), `${row.request_id}.json`), 'utf8'));
    assert.deepEqual(Object.keys(raw), ROW_KEY_ORDER);

    // Known-bad case, run through the REAL writeRow: build the SAME row with
    // its own enumeration order reversed (JS preserves object-literal /
    // assignment insertion order for string keys), so a naive
    // `JSON.stringify(row)` with no reordering step would persist a
    // SCRAMBLED key order. writeRow must still emit the canonical order —
    // proving `orderRow` actually reorders rather than passing through
    // whatever order the caller happened to use.
    const scrambled = {} as AuthRequestRow;
    for (const key of [...ROW_KEY_ORDER].reverse()) {
      (scrambled as any)[key] = (row as any)[key];
    }
    (scrambled as any).request_id = 'ir-scrambled01';
    assert.notDeepEqual(Object.keys(scrambled), ROW_KEY_ORDER); // the INPUT is genuinely scrambled
    writeRow(scrambled); // bypass baseRow()'s merge, which would re-normalize order itself
    const rawScrambled = JSON.parse(readFileSync(join(requestsDir(), 'ir-scrambled01.json'), 'utf8'));
    assert.deepEqual(Object.keys(rawScrambled), ROW_KEY_ORDER);
  });

  it('writes the file with mode 0600 on posix', () => {
    if (process.platform === 'win32') return; // Windows has no POSIX mode bits
    const row = baseRow();
    writeRow(row);
    const mode = statSync(join(requestsDir(), `${row.request_id}.json`)).mode & 0o777;
    assert.equal(mode, 0o600);

    // Known-bad control: a file written with a permissive mode is NOT 0600 —
    // proves the assertion actually discriminates.
    const other = join(dir, 'not-0600.txt');
    writeFileSync(other, 'x', { mode: 0o644 });
    const otherMode = statSync(other).mode & 0o777;
    assert.notEqual(otherMode, 0o600);
  });

  it('markDelivered sets delivered_at and leaves every other key byte-identical', () => {
    const row = baseRow({ delivered_at: null });
    writeRow(row);
    const updated = markDelivered(row.request_id, '2026-09-10T07:00:00.000Z');
    assert.ok(updated);
    assert.equal(updated!.delivered_at, '2026-09-10T07:00:00.000Z');
    const { delivered_at, ...restUpdated } = updated!;
    const { delivered_at: _origDelivered, ...restOriginal } = row;
    assert.deepEqual(restUpdated, restOriginal);

    // Known-bad case: a comparison that could never fail would be inert
    // (global CLAUDE.md's check-must-be-able-to-fail rule). Prove the exact
    // comparison technique above (destructure delivered_at, deepEqual the
    // rest) DOES catch a row that changed a field other than delivered_at —
    // simulating what a buggy markDelivered (one that also touched, say,
    // `status`) would produce.
    const tampered = { ...row, delivered_at: '2026-09-10T07:00:00.000Z', status: 'answered' as const };
    const { delivered_at: _tamperedDelivered, ...restTampered } = tampered;
    assert.notDeepEqual(restTampered, restOriginal);

    // Known-bad case: markDelivered on an unknown id must NOT silently
    // fabricate a row.
    assert.equal(markDelivered('ir-doesnotexist0', '2026-09-10T07:00:00.000Z'), undefined);
  });

  it('readRow on a missing id returns undefined', () => {
    assert.equal(readRow('ir-000000000000'), undefined);
  });

  it('readRow on a torn JSON file returns undefined and does not throw', () => {
    mkdirSync(requestsDir(), { recursive: true });
    writeFileSync(join(requestsDir(), 'ir-torn00000001.json'), '{not json', 'utf8');
    assert.doesNotThrow(() => readRow('ir-torn00000001'));
    assert.equal(readRow('ir-torn00000001'), undefined);
  });

  it('upsertProfile replaces a provider row whole and loadProfiles on an unparseable file returns {}', () => {
    mkdirSync(authDir(), { recursive: true });
    const first: AuthProfile = {
      shape: 'S2',
      command: 'gh auth login --with-token',
      env: 'GH_TOKEN',
      credential_path: 'keyring',
      expires_days: 0,
      notes: 'first',
      learned_at: '2026-09-10T06:00:00.000Z',
    };
    upsertProfile('github', first);
    assert.deepEqual(loadProfiles()['github'], first);

    // Supersede-by-key: the second write replaces the row WHOLE — a stale
    // field from the first write must not survive a partial merge.
    const second: AuthProfile = {
      shape: 'S4',
      command: 'different command',
      learned_at: '2026-09-10T08:00:00.000Z',
    };
    upsertProfile('github', second);
    const stored = loadProfiles()['github'];
    assert.deepEqual(stored, second);
    assert.equal((stored as any).notes, undefined);

    // Known-bad case: an unparseable file must fail to {} rather than throw.
    writeFileSync(join(dir, 'auth-profiles.yaml'), ':\n  - not: [valid\n', 'utf8');
    assert.doesNotThrow(() => loadProfiles());
    assert.deepEqual(loadProfiles(), {});
  });
});
