import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const PA_HOME_DIR = join(tmpdir(), `unparseable-log-test-${process.pid}`);
process.env.PA_HOME = PA_HOME_DIR;

import { appendUnparseableRateLimit } from '../src/rate-limit-unparseable-log.js';

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
