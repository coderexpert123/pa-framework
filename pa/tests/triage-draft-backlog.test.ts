import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempDraft, cleanup } from './helpers.js';
import { computeFingerprint } from '../src/drafts.js';
import { triageDraftBacklog } from '../src/scripts/triage-draft-backlog.js';
import type { DraftMeta } from '../src/types.js';

let dir: string;

beforeEach(async () => {
  dir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(dir);
});

function pendingMeta(overrides: Partial<DraftMeta> = {}): DraftMeta {
  return {
    proposed_at: new Date().toISOString(),
    reason: 'test reason',
    source_turns: [],
    status: 'pending',
    fingerprint: computeFingerprint('x', 'x'),
    source_type: 'failure',
    ...overrides,
  };
}

async function readAuditRecords(): Promise<any[]> {
  try {
    const raw = await readFile(join(dir, 'self-improver-audit.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('triageDraftBacklog (2026-07-11 backlog reset)', () => {
  it('marks every pending draft rejected_stale and returns the count', async () => {
    await createTempDraft(dir, 'a-fix', 'Prompt A.', pendingMeta({ target_skill: 'a' }));
    await createTempDraft(dir, 'b-fix', 'Prompt B.', pendingMeta({ target_skill: 'b' }));

    const count = await triageDraftBacklog();
    assert.equal(count, 2);

    const metaA: DraftMeta = JSON.parse(await readFile(join(dir, 'skill-drafts', 'a-fix', 'draft.meta.json'), 'utf8'));
    const metaB: DraftMeta = JSON.parse(await readFile(join(dir, 'skill-drafts', 'b-fix', 'draft.meta.json'), 'utf8'));
    assert.equal(metaA.status, 'rejected_stale');
    assert.equal(metaB.status, 'rejected_stale');
  });

  it('leaves already-approved and already-rejected drafts untouched', async () => {
    await createTempDraft(dir, 'approved-one', 'Prompt.', pendingMeta({ status: 'approved' }));
    await createTempDraft(dir, 'rejected-one', 'Prompt.', pendingMeta({ status: 'rejected' }));

    const count = await triageDraftBacklog();
    assert.equal(count, 0);

    const metaApproved: DraftMeta = JSON.parse(await readFile(join(dir, 'skill-drafts', 'approved-one', 'draft.meta.json'), 'utf8'));
    const metaRejected: DraftMeta = JSON.parse(await readFile(join(dir, 'skill-drafts', 'rejected-one', 'draft.meta.json'), 'utf8'));
    assert.equal(metaApproved.status, 'approved');
    assert.equal(metaRejected.status, 'rejected');
  });

  it('appends one audit record per triaged draft with the backlog-reset reason', async () => {
    await createTempDraft(dir, 'c-fix', 'Prompt C.', pendingMeta({ target_skill: 'c', source_type: 'conversation', risk_flags: ['critical-skill'] }));

    await triageDraftBacklog();

    const records = await readAuditRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].draft, 'c-fix');
    assert.equal(records[0].action, 'rejected_stale');
    assert.equal(records[0].target_skill, 'c');
    assert.equal(records[0].source_type, 'conversation');
    assert.deepEqual(records[0].risk_flags, ['critical-skill']);
    assert.match(records[0].reason, /^backlog-reset-2026-07-11:/);
  });

  it('returns 0 and writes no audit records when there are no pending drafts', async () => {
    const count = await triageDraftBacklog();
    assert.equal(count, 0);
    assert.deepEqual(await readAuditRecords(), []);
  });

  it('handles a target-less (new-skill) pending draft without a target_skill field', async () => {
    await createTempDraft(dir, 'new-skill-draft', 'Prompt.', pendingMeta());

    const count = await triageDraftBacklog();
    assert.equal(count, 1);

    const records = await readAuditRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].target_skill, undefined);
  });
});
