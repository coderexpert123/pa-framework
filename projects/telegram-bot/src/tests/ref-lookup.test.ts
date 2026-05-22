import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { findSessionForRefId } from '../ref-lookup.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tgbot-reflookup-'));
  process.env.PA_HOME = tempDir;
});

afterEach(async () => {
  delete process.env.PA_HOME;
  await rm(tempDir, { recursive: true, force: true });
});

function makeLogLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    module: 'bot',
    message: 'message sent',
    ...fields,
  });
}

describe('findSessionForRefId', () => {
  it('returns null when log file does not exist', async () => {
    const result = await findSessionForRefId('z-1a2b');
    assert.equal(result, null);
  });

  it('returns null when refId is not in log', async () => {
    const logPath = join(tempDir, 'app.log.jsonl');
    await writeFile(logPath, makeLogLine({ refId: 'c-9999', session_id: 'sess-other' }) + '\n', 'utf8');
    const result = await findSessionForRefId('z-1a2b');
    assert.equal(result, null);
  });

  it('returns session_id for a matching refId', async () => {
    const logPath = join(tempDir, 'app.log.jsonl');
    const lines = [
      makeLogLine({ refId: 'z-aabb', session_id: 'sess-abc' }),
      makeLogLine({ refId: 'c-1234', session_id: 'sess-xyz' }),
    ].join('\n') + '\n';
    await writeFile(logPath, lines, 'utf8');
    const result = await findSessionForRefId('c-1234');
    assert.equal(result, 'sess-xyz');
  });

  it('returns the most recent match when refId appears multiple times', async () => {
    // In practice refIds are random, but if somehow duplicated, return the last one found
    const logPath = join(tempDir, 'app.log.jsonl');
    const lines = [
      makeLogLine({ refId: 'z-aabb', session_id: 'sess-old' }),
      makeLogLine({ refId: 'z-aabb', session_id: 'sess-new' }),
    ].join('\n') + '\n';
    await writeFile(logPath, lines, 'utf8');
    // Scans in reverse so the last matching line wins
    const result = await findSessionForRefId('z-aabb');
    assert.equal(result, 'sess-new');
  });

  it('skips non-bot log entries', async () => {
    const logPath = join(tempDir, 'app.log.jsonl');
    const lines = [
      JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', module: 'workers', message: 'starting', refId: 'z-1a2b', session_id: 'wrong' }),
      makeLogLine({ refId: 'z-1a2b', session_id: 'correct' }),
    ].join('\n') + '\n';
    await writeFile(logPath, lines, 'utf8');
    const result = await findSessionForRefId('z-1a2b');
    assert.equal(result, 'correct');
  });

  it('returns null when session_id is missing from matching entry', async () => {
    const logPath = join(tempDir, 'app.log.jsonl');
    await writeFile(logPath, makeLogLine({ refId: 'z-1a2b' }) + '\n', 'utf8');
    const result = await findSessionForRefId('z-1a2b');
    assert.equal(result, null);
  });

  it('handles malformed JSON lines gracefully', async () => {
    const logPath = join(tempDir, 'app.log.jsonl');
    const good = makeLogLine({ refId: 'z-1a2b', session_id: 'sess-ok' });
    await writeFile(logPath, `{bad json}\n${good}\n`, 'utf8');
    const result = await findSessionForRefId('z-1a2b');
    assert.equal(result, 'sess-ok');
  });
});
