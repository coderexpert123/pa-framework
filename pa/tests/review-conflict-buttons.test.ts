import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  reviewConflictButtonsJob,
  runReviewConflictButtons,
  buildConflictBody,
  conflictKeyboard,
} from '../src/lib/maintenance/jobs/review-conflict-buttons.js';
import type { ReviewDigestConflict } from '../src/lib/maintenance/jobs/review-conflict-buttons.js';

// Tests use the runReviewConflictButtons(deps) DI seam (notifyFn injected) —
// the pattern the other maintenance jobs' tests follow (alert-census.test.ts,
// clobber-sentinel.test.ts) since ESM module namespaces are read-only.

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

function conflict(overrides: Partial<ReviewDigestConflict> = {}): ReviewDigestConflict {
  return {
    id: 'cf-20260824010101-000',
    created_at: '2026-08-24T01:01:01.000Z',
    resolved: false,
    resolved_at: null,
    resolution: null,
    key: 'user.favorite_color',
    new_text: 'blue',
    existing_text: 'green',
    existing_valid_from: '2026-01-01T00:00:00.000Z',
    category: 'preferences',
    source: 'conversation',
    source_ref: 'turn-123',
    ...overrides,
  };
}

describe('review-conflict-buttons job metadata', () => {
  it('has the correct job metadata', () => {
    assert.equal(reviewConflictButtonsJob.name, 'review-conflict-buttons');
    assert.equal(reviewConflictButtonsJob.host, 'pa');
    assert.equal(reviewConflictButtonsJob.everyMs, 24 * 60 * 60 * 1000);
    assert.equal(reviewConflictButtonsJob.destructive, false);
    assert.equal(reviewConflictButtonsJob.shedWhenDegraded, true);
    assert.deepEqual(reviewConflictButtonsJob.targets, []);
  });
});

describe('buildConflictBody (pure)', () => {
  it('truncates new_text and existing_text at 200 chars', () => {
    const longNew = 'N'.repeat(250);
    const longExisting = 'E'.repeat(250);
    const body = buildConflictBody(conflict({ new_text: longNew, existing_text: longExisting }));

    const newLine = body.split('\n').find((l) => l.startsWith('New: '))!;
    const existingLine = body.split('\n').find((l) => l.startsWith('Existing: '))!;
    assert.equal(newLine, `New: ${'N'.repeat(200)}`);
    assert.equal(existingLine, `Existing: ${'E'.repeat(200)}`);
  });

  it('includes the typed fallback line naming the resolution script', () => {
    const body = buildConflictBody(conflict({ id: 'cf-abc' }));
    assert.match(
      body,
      /Resolve with: pa\/scripts\/review_digest_action\.py --conflict-id cf-abc --action accept\|reject\|ignore/,
    );
  });

  it('includes key, category and created_at', () => {
    const body = buildConflictBody(conflict({ key: 'user.city', category: 'location', created_at: '2026-08-01T00:00:00.000Z' }));
    assert.match(body, /Key: user\.city/);
    assert.match(body, /Category: location/);
    assert.match(body, /Created: 2026-08-01T00:00:00\.000Z/);
  });

  it('does not throw on missing optional fields', () => {
    assert.doesNotThrow(() => buildConflictBody({ id: 'cf-bare' }));
  });
});

describe('conflictKeyboard (pure)', () => {
  it('returns undefined for a 33-char id', () => {
    const id = 'x'.repeat(33);
    assert.equal(conflictKeyboard(id), undefined);
  });

  it('emits all three mc: callback strings, each <= 64 bytes, for a valid id', () => {
    const id = 'cf-20260824010101-000';
    const kb = conflictKeyboard(id)!;
    assert.ok(kb, 'expected a keyboard');
    const buttons = kb.inline_keyboard.flat();
    const callbackData = buttons.map((b) => b.callback_data);
    assert.deepEqual(new Set(callbackData), new Set([`mc:${id}:a`, `mc:${id}:r`, `mc:${id}:x`]));
    for (const cb of callbackData) {
      assert.ok(Buffer.byteLength(cb, 'utf8') <= 64, `${cb} must be <= 64 bytes`);
    }
  });

  it('accepts a 32-char id (the boundary)', () => {
    const id = 'y'.repeat(32);
    const kb = conflictKeyboard(id);
    assert.notEqual(kb, undefined);
  });

  it('rejects an id containing characters outside [A-Za-z0-9-]', () => {
    assert.equal(conflictKeyboard('cf_has_underscore'), undefined);
  });
});

describe('runReviewConflictButtons (job, real file I/O)', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-review-conflict-buttons-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns touched:0 when review-digest-pending.jsonl does not exist', async () => {
    let notifyCalls = 0;
    const result = await runReviewConflictButtons({
      notifyFn: async () => { notifyCalls++; return { sent: true, suppressed: false }; },
    });
    assert.equal(result.touched, 0);
    assert.deepEqual(result.detail, { unresolved: 0, sent: 0, capped: false });
    assert.equal(notifyCalls, 0);
  });

  it('counts unresolved entries and skips resolved ones', async () => {
    const lines = [
      line(conflict({ id: 'cf-a-000000000000-001', resolved: false })),
      line(conflict({ id: 'cf-a-000000000000-002', resolved: true })),
      line(conflict({ id: 'cf-a-000000000000-003', resolved: false })),
    ].join('');
    await writeFile(join(tempDir, 'review-digest-pending.jsonl'), lines, 'utf8');

    const notified: Array<{ subject: string; dedupKey?: string }> = [];
    const result = await runReviewConflictButtons({
      notifyFn: async (subject, _body, opts) => {
        notified.push({ subject, dedupKey: opts?.dedupKey });
        return { sent: true, suppressed: false };
      },
    });

    assert.equal(result.detail.unresolved, 2);
    assert.equal(result.detail.sent, 2);
    assert.equal(result.detail.capped, false);
    assert.equal(result.touched, 2);
    assert.equal(notified.length, 2);
    assert.deepEqual(
      new Set(notified.map((n) => n.dedupKey)),
      new Set(['review-conflict-cf-a-000000000000-001', 'review-conflict-cf-a-000000000000-003']),
    );
  });

  it('does not throw on a torn/blank line and still processes valid entries around it', async () => {
    const lines = [
      line(conflict({ id: 'cf-b-000000000000-001' })),
      '{not valid json\n',
      '\n',
      '   \n',
      line(conflict({ id: 'cf-b-000000000000-002' })),
    ].join('');
    await writeFile(join(tempDir, 'review-digest-pending.jsonl'), lines, 'utf8');

    const result = await runReviewConflictButtons({
      notifyFn: async () => ({ sent: true, suppressed: false }),
    });

    assert.equal(result.detail.unresolved, 2);
    assert.equal(result.detail.sent, 2);
  });

  it('caps sends at 10 per run and reports capped:true', async () => {
    const lines = Array.from({ length: 15 }, (_, i) =>
      line(conflict({ id: `cf-c-000000000000-${String(i).padStart(3, '0')}` })),
    ).join('');
    await writeFile(join(tempDir, 'review-digest-pending.jsonl'), lines, 'utf8');

    let notifyCalls = 0;
    const result = await runReviewConflictButtons({
      notifyFn: async () => { notifyCalls++; return { sent: true, suppressed: false }; },
    });

    assert.equal(result.detail.unresolved, 15);
    assert.equal(result.detail.sent, 10);
    assert.equal(result.detail.capped, true);
    assert.equal(result.touched, 10);
    assert.equal(notifyCalls, 10);
  });

  it('passes dedupWindowMs=30d, escalate:false, severity:info and a replyMarkup on each send', async () => {
    const lines = line(conflict({ id: 'cf-d-000000000000-001' }));
    await writeFile(join(tempDir, 'review-digest-pending.jsonl'), lines, 'utf8');

    const opts: any[] = [];
    await runReviewConflictButtons({
      notifyFn: async (_subject, _body, o) => { opts.push(o); return { sent: true, suppressed: false }; },
    });

    assert.equal(opts.length, 1);
    assert.equal(opts[0].dedupKey, 'review-conflict-cf-d-000000000000-001');
    assert.equal(opts[0].dedupWindowMs, 30 * 24 * 60 * 60 * 1000);
    assert.equal(opts[0].escalate, false);
    assert.equal(opts[0].severity, 'info');
    assert.ok(opts[0].replyMarkup, 'expected a replyMarkup');
    const callbackData = opts[0].replyMarkup.inline_keyboard.flat().map((b: any) => b.callback_data);
    assert.deepEqual(
      new Set(callbackData),
      new Set(['mc:cf-d-000000000000-001:a', 'mc:cf-d-000000000000-001:r', 'mc:cf-d-000000000000-001:x']),
    );
  });

  it('skips an entry whose id is malformed (never sent, not counted as unresolved)', async () => {
    const lines = [
      line(conflict({ id: 'cf has spaces' })),
      line(conflict({ id: 'cf-e-000000000000-001' })),
    ].join('');
    await writeFile(join(tempDir, 'review-digest-pending.jsonl'), lines, 'utf8');

    let notifyCalls = 0;
    const result = await runReviewConflictButtons({
      notifyFn: async () => { notifyCalls++; return { sent: true, suppressed: false }; },
    });

    assert.equal(result.detail.unresolved, 1);
    assert.equal(notifyCalls, 1);
  });
});
