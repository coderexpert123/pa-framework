import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const PA_HOME_DIR = join(tmpdir(), `unparseable-log-test-${process.pid}`);
process.env.PA_HOME = PA_HOME_DIR;

import { appendUnparseableRateLimit } from '../src/rate-limit-unparseable-log.js';
import { flushLog } from '../src/lib/log.js';

describe('appendUnparseableRateLimit', () => {
  before(async () => {
    await mkdir(PA_HOME_DIR, { recursive: true });
  });

  after(async () => {
    try { await rm(PA_HOME_DIR, { recursive: true, force: true }); } catch {}
  });

  it('writes one JSONL entry to rate-limit-unparseable.jsonl', async () => {
    const entry = {
      timestamp: '2026-04-18T10:00:00.000Z',
      worker: 'zclaude',
      raw: 'API Error: Request rejected (429)',
      session_id: 'test-session-123',
      reason: 'no-session-evidence' as const,
    };
    await appendUnparseableRateLimit(entry);

    const logPath = join(PA_HOME_DIR, 'rate-limit-unparseable.jsonl');
    const content = await readFile(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.worker, 'zclaude');
    assert.equal(parsed.reason, 'no-session-evidence');
    assert.equal(parsed.session_id, 'test-session-123');
    assert.ok(parsed.raw.includes('429'));
  });

  it('truncates raw to 2000 chars', async () => {
    const longRaw = 'x'.repeat(3000);
    await appendUnparseableRateLimit({
      timestamp: new Date().toISOString(),
      worker: 'gemini',
      raw: longRaw,
      reason: 'no-session-evidence',
    });

    const logPath = join(PA_HOME_DIR, 'rate-limit-unparseable.jsonl');
    const content = await readFile(logPath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const lastLine = JSON.parse(lines[lines.length - 1]);
    assert.equal(lastLine.raw.length, 2000, `raw should be truncated to 2000 chars, got ${lastLine.raw.length}`);
  });

  // The JSONL file alone is write-only in practice: zclaude's terminal 1113 fault
  // landed there four times over eight days and nobody saw it. Every unparseable
  // signal must also reach app.log.jsonl at warn, tagged with the worker name.
  it('also emits a warn-level structured log naming the worker', async () => {
    await appendUnparseableRateLimit({
      timestamp: new Date().toISOString(),
      worker: 'zclaude',
      raw: 'API Error: Request rejected (429) [9999][something new]',
      session_id: 'sess-warn-1',
      reason: 'no-session-evidence',
    });
    await flushLog();

    const content = await readFile(join(PA_HOME_DIR, 'app.log.jsonl'), 'utf8');
    const entries = content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const hit = entries.find((e) => e.level === 'warn' && e.worker === 'zclaude' && e.session_id === 'sess-warn-1');
    assert.ok(hit, 'a warn entry naming the worker must be present in app.log.jsonl');
    assert.equal(hit.module, 'rate-limits');
    assert.equal(hit.reason, 'no-session-evidence');
    assert.ok(String(hit.message).includes('zclaude'), 'message should be greppable by worker name');
  });

  it('does not throw on I/O failure (bad path)', async () => {
    const savedHome = process.env.PA_HOME;
    process.env.PA_HOME = '/dev/null/cannot-write-here';
    try {
      await assert.doesNotReject(
        appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker: 'codex', raw: 'test', reason: 'other' }),
      );
    } finally {
      process.env.PA_HOME = savedHome;
    }
  });
});
