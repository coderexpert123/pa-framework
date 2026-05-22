/**
 * End-to-end session resumption tests.
 *
 * These tests spawn REAL Claude and Gemini CLI processes to verify the full
 * fresh → resume round-trip works. They make actual API calls and take ~30-60s.
 *
 * Run explicitly (not part of default npm test):
 *   node --test dist/tests/e2e-session.test.js
 *
 * Requires ~/.pa/config.yaml and ~/.pa/secrets.env to be present.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../../../pa/dist/src/config.js';
import { executeWorker } from '../../../../pa/dist/src/workers.js';
import { loadSecrets } from '../../../../pa/dist/src/secrets.js';
import { discoverGeminiSessionId } from '../session.js';

// E2E uses the user's actual project root via BOT_CWD env var (defaults to cwd).
// These tests require ~/.pa/config.yaml + secrets.env with real worker setup —
// run only from inside an active pa-framework deployment.
const BOT_CWD = process.env.BOT_CWD || process.cwd();
const GEMINI_PROJECT_DIR = 'personal-assistant';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadWorker(name: 'claude' | 'gemini') {
  const config = await loadConfig();
  const worker = config.workers.find((w) => w.name === name);
  if (!worker) throw new Error(`Worker '${name}' not found in config`);
  return worker;
}

describe('E2E: Claude session resumption', () => {
  it('fresh session returns valid sessionId in result', async () => {
    const worker = await loadWorker('claude');
    const secrets = await loadSecrets();

    const result = await executeWorker(
      worker,
      'Reply with exactly the word MEMORIZE and nothing else.',
      { cwd: BOT_CWD, env: secrets, timeout: 120 }
    );

    assert.ok(result.success, `Expected success but got error: ${result.error}`);
    assert.ok(result.sessionId, 'Expected sessionId to be captured from NDJSON stream');
    assert.match(result.sessionId!, UUID_RE, 'sessionId should be a UUID');
  });

  it('resumes session and recalls prior context', async () => {
    const worker = await loadWorker('claude');
    const secrets = await loadSecrets();

    // Step 1: fresh session with a memorable message
    const fresh = await executeWorker(
      worker,
      'Reply with exactly the word MEMORIZE and nothing else.',
      { cwd: BOT_CWD, env: secrets, timeout: 120 }
    );
    assert.ok(fresh.success, `Fresh session failed: ${fresh.error}`);
    assert.ok(fresh.sessionId, 'Fresh session must return sessionId');

    // Step 2: resume and ask what was said
    const resumed = await executeWorker(
      worker,
      'What exact word did I ask you to reply with in the previous message? Answer in one word.',
      { cwd: BOT_CWD, env: secrets, timeout: 120, extraArgs: ['--resume', fresh.sessionId!] }
    );
    assert.ok(resumed.success, `Resume failed: ${resumed.error}`);
    assert.ok(
      resumed.output.toUpperCase().includes('MEMORIZE'),
      `Expected "MEMORIZE" in response, got: ${resumed.output}`
    );
  });

  it('resume with invalid UUID fails gracefully (success=false)', async () => {
    const worker = await loadWorker('claude');
    const secrets = await loadSecrets();

    const result = await executeWorker(
      worker,
      'say hello',
      { cwd: BOT_CWD, env: secrets, timeout: 60, extraArgs: ['--resume', '00000000-0000-0000-0000-nonexistent00'] }
    );
    assert.equal(result.success, false, 'Resume with invalid UUID should fail');
  });
});

describe('E2E: Gemini session resumption', () => {
  it('fresh session returns valid sessionId in NDJSON init event', async () => {
    const worker = await loadWorker('gemini');
    const secrets = await loadSecrets();

    const result = await executeWorker(
      worker,
      'Reply with exactly the word MEMORIZE and nothing else.',
      { cwd: BOT_CWD, env: secrets, timeout: 120 }
    );

    assert.ok(result.success, `Expected success but got error: ${result.error}`);
    assert.ok(result.sessionId, 'Expected sessionId from Gemini init event');
    assert.match(result.sessionId!, UUID_RE, 'sessionId should be a UUID');
  });

  it('resumes session and recalls prior context', async () => {
    const worker = await loadWorker('gemini');
    const secrets = await loadSecrets();

    // Step 1: fresh session
    const fresh = await executeWorker(
      worker,
      'Reply with exactly the word MEMORIZE and nothing else.',
      { cwd: BOT_CWD, env: secrets, timeout: 120 }
    );
    assert.ok(fresh.success, `Fresh Gemini session failed: ${fresh.error}`);

    // Prefer result.sessionId; fall back to disk discovery
    const sessionId = fresh.sessionId
      ?? (await discoverGeminiSessionId(GEMINI_PROJECT_DIR).catch(() => null))
      ?? undefined;
    assert.ok(sessionId, 'Must have a Gemini session ID to resume');
    assert.match(sessionId!, UUID_RE, 'sessionId should be a UUID');

    // Step 2: resume using the specific UUID
    const resumed = await executeWorker(
      worker,
      'What exact word did I ask you to reply with in the previous message? Answer in one word.',
      { cwd: BOT_CWD, env: secrets, timeout: 120, extraArgs: ['--resume', sessionId!] }
    );
    assert.ok(resumed.success, `Gemini resume failed: ${resumed.error}`);
    assert.ok(
      resumed.output.toUpperCase().includes('MEMORIZE'),
      `Expected "MEMORIZE" in response, got: ${resumed.output}`
    );

    // The resumed session should return the same session_id in the init event
    assert.equal(resumed.sessionId, sessionId, 'Resumed session should report the same session_id');
  });

  it('resume with invalid UUID fails gracefully (success=false)', async () => {
    const worker = await loadWorker('gemini');
    const secrets = await loadSecrets();

    const result = await executeWorker(
      worker,
      'say hello',
      { cwd: BOT_CWD, env: secrets, timeout: 60, extraArgs: ['--resume', '00000000-0000-0000-0000-nonexistent00'] }
    );
    assert.equal(result.success, false, 'Gemini resume with invalid UUID should fail');
  });
});
