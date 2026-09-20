/**
 * Request-log tests (2026-09-08 incident follow-up): formatter exact-string
 * pin, redactPathForLog pins, order + injectability, never-throw console
 * fallback, append-time rotation + prune, and default-append dir creation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRequestLogger,
  formatRequestLogLine,
  redactPathForLog,
  REQUEST_LOG_KEEP_SHARDS,
  REQUEST_LOG_MAX_BYTES,
  type RequestLogEntry,
} from '../request-log.js';

const SHARD_PATTERN = /^requests-\d{8}-\d{6}(-\d+)?\.log$/;

function makeDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-reqlog-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

/**
 * Bounded settle: poll a completion condition in 10ms ticks (2s cap) instead
 * of one flat 20ms sleep — a flat sleep observed missing appends entirely
 * under Windows first-touch AV latency on a fresh temp dir.
 */
async function settleUntil(cond: () => boolean, maxMs = 2000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

function entry(overrides: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return {
    ts: '2026-09-08T06:00:00.000Z',
    method: 'GET',
    path: '/p',
    status: 200,
    bytes_in: 0,
    bytes_out: 0,
    ms: 0,
    session_ok: true,
    ...overrides,
  };
}

describe('request-log', () => {
  it('formats the pinned JSONL field set in the exact pinned order', () => {
    assert.strictEqual(
      formatRequestLogLine(
        entry({ method: 'POST', path: '/api/v1/tasks', status: 200, bytes_in: 24, bytes_out: 51, ms: 12 })
      ),
      '{"ts":"2026-09-08T06:00:00.000Z","method":"POST","path":"/api/v1/tasks","status":200,"bytes_in":24,"bytes_out":51,"ms":12,"session_ok":true}'
    );
    assert.strictEqual(REQUEST_LOG_MAX_BYTES, 5 * 1024 * 1024);
    assert.strictEqual(REQUEST_LOG_KEEP_SHARDS, 4);
  });

  it('redacts query values — keys only', () => {
    assert.strictEqual(
      redactPathForLog('/api/v1/tasks', new URLSearchParams('status=received&limit=50')),
      '/api/v1/tasks?status&limit'
    );
    assert.strictEqual(redactPathForLog('/x', new URLSearchParams('')), '/x');
    assert.strictEqual(redactPathForLog('/x', new URLSearchParams('a b=1')), '/x?a%20b');
    assert.strictEqual(redactPathForLog('/x', new URLSearchParams('a=1&a=2')), '/x?a&a');
  });

  it('preserves line order under rapid fire (injectable append)', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const appended: { path: string; line: string }[] = [];
      const log = createRequestLogger(join(dir, 'requests.log'), {
        appendImpl: async (path, line) => {
          appended.push({ path, line });
        },
      });
      for (let i = 0; i < 5; i++) {
        log(entry({ path: `/p/${i}` }));
      }
      await settleUntil(() => appended.length === 5);
      assert.strictEqual(appended.length, 5);
      appended.forEach((a, i) => {
        assert.strictEqual((JSON.parse(a.line) as { path: string }).path, `/p/${i}`);
      });
    } finally {
      cleanup();
    }
  });

  it('never throws; first failure reports on console.error and the chain survives', async () => {
    const { dir, cleanup } = makeDir();
    const origError = console.error;
    let failures = 0;
    console.error = () => {
      failures++;
    };
    try {
      let calls = 0;
      const appended: string[] = [];
      const log = createRequestLogger(join(dir, 'requests.log'), {
        appendImpl: async (path, line) => {
          void path;
          calls++;
          if (calls === 1) throw new Error('disk full');
          appended.push(line);
        },
      });
      const e = entry();
      log(e);
      log(e);
      await settleUntil(() => failures === 1 && appended.length === 1);
      assert.strictEqual(failures, 1);
      assert.strictEqual(appended.length, 1);
      assert.strictEqual((JSON.parse(appended[0]) as { path: string }).path, '/p');
    } finally {
      console.error = origError;
      cleanup();
    }
  });

  it('rotates at the size cap and prunes to keepShards', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const logPath = join(dir, 'requests.log');
      writeFileSync(logPath, 'x'.repeat(80), 'utf8');
      const log = createRequestLogger(logPath, { maxBytes: 64, keepShards: 1 });
      log(entry({ path: '/one' }));
      await settleUntil(() => {
        try {
          return readFileSync(logPath, 'utf8').includes('"path":"/one"');
        } catch {
          return false;
        }
      });
      log(entry({ path: '/two' }));
      await settleUntil(() => {
        try {
          return readFileSync(logPath, 'utf8').includes('"path":"/two"');
        } catch {
          return false;
        }
      });
      const shards = readdirSync(dir).filter((n) => SHARD_PATTERN.test(n));
      assert.strictEqual(shards.length, 1); // exactly one shard — and ≤ keepShards (1)
      const main = statSync(logPath);
      assert.ok(main.size <= 128, `requests.log should hold one line, got ${main.size} bytes`);
      assert.strictEqual(readLines(logPath).length, 1);
      // Nothing lost across the rotations: both logged lines appear exactly
      // once across shard + requests.log.
      const shardBody = readFileSync(join(dir, shards[0]), 'utf8');
      const total = (shardBody + readFileSync(logPath, 'utf8'));
      assert.strictEqual(
        (total.match(/"path":"\/one"/g) ?? []).length,
        1,
        `line /one must appear exactly once across shard+main, got: ${JSON.stringify(total)}`
      );
      assert.strictEqual(
        (total.match(/"path":"\/two"/g) ?? []).length,
        1
      );
      // The surviving (newest) shard holds the rotated line; the pre-written
      // bytes' shard was older and is what pruning deleted.
      assert.ok(shardBody.includes('"path":"/one"'));
    } finally {
      cleanup();
    }
  });

  it('default append creates missing nested dirs', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const logPath = join(dir, 'nested', 'deeper', 'requests.log');
      const log = createRequestLogger(logPath);
      log(entry({ path: '/deep' }));
      await settleUntil(() => {
        try {
          return readLines(logPath).length === 1;
        } catch {
          return false;
        }
      });
      const lines = readLines(logPath);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual((JSON.parse(lines[0]) as { path: string }).path, '/deep');
    } finally {
      cleanup();
    }
  });
});
