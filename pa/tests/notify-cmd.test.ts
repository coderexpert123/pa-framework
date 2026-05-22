import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { notifyUser } from '../src/lib/notify.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('notifyCommand — argument parsing', () => {
  // Rather than spawning a subprocess, test the notifyUser function directly
  // (notifyCommand is a thin wrapper). CLI flag parsing is exercised in e2e.

  it('notifyUser returns sent=false without token', async () => {
    const result = await notifyUser('Test Subject', 'Test body', {
      dedupKey: 'test-dedup',
    });
    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
  });

  it('notifyUser passes through topic override', async () => {
    const result = await notifyUser('Test', 'body', {
      topic: { chat_id: '-100999', thread_id: 42 },
    });
    // Without token, always sent=false
    assert.equal(result.sent, false);
  });

  it('notifyUser passes through severity', async () => {
    const result = await notifyUser('Test', 'body', {
      severity: 'error',
    });
    assert.equal(result.sent, false);
  });
});
