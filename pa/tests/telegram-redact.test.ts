// pii-scan:ignore-start
/**
 * Tests for AI-184 (2026-09-03): redaction relocation on the pa-side send path.
 *
 * sendToTelegram delivers to the OPERATOR'S OWN CHAT (alerts, `pa notify`,
 * every skill's telegram_output), so the sent body keeps real text — the
 * operator's name must be deliverable, and name-bearing outbound drafts must
 * survive in full. The scrub lives on the LOG side: the app.log.jsonl
 * delivery row's textPreview context must keep it. BOTH directions pinned:
 *  - name PRESENT in the delivered body (fetch-stub capture), and
 *  - name ABSENT from the logged copy (real app.log.jsonl read-back).
 */

import './test-env-guard.js';

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendToTelegram } from '../src/telegram.js';
import { flushLog } from '../src/lib/log.js';
import { resetRedactCache } from '../src/lib/redact.js';

const TEST_PA_HOME = join(tmpdir(), `pa-test-telegram-redact-${process.pid}`);

// Synthetic ≥8-char secrets.env literal exercising the PA_USER_NAME defect class
// without embedding a real name in the tree.
const OPERATOR_NAME = 'OperatorNameFixture';

function writeSecrets(): void {
  writeFileSync(join(TEST_PA_HOME, 'secrets.env'), `PA_USER_NAME=${OPERATOR_NAME}\n`);
}

function stubFetch(): ReturnType<typeof mock.fn> {
  const mockFetch = mock.fn(async (_url: unknown, _init: unknown) =>
    ({
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
    } as Response)
  );
  global.fetch = mockFetch as unknown as typeof fetch;
  return mockFetch;
}

function lastDeliveryRow(): Record<string, unknown> | undefined {
  const p = join(TEST_PA_HOME, 'app.log.jsonl');
  if (!existsSync(p)) return undefined;
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = JSON.parse(lines[i]) as Record<string, unknown>;
    if (row.message === 'skill message sent') return row;
  }
  return undefined;
}

describe('telegram.ts redaction (AI-184: delivered raw, logged scrubbed)', () => {
  beforeEach(() => {
    // Clean up any existing test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    mkdirSync(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
    writeSecrets();
    resetRedactCache();
  });

  afterEach(() => {
    resetRedactCache();
    // Clean up test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    delete process.env.PA_HOME;
  });

  it('delivered body keeps a secrets.env literal (operator name PRESENT)', async () => {
    const mockFetch = stubFetch();

    const text = `Hi ${OPERATOR_NAME}, your monthly transfer draft is ready.`;
    const config = { chat_id: '123', thread_id: 456, token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token');

    assert.equal(result.ok, true);
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    assert.ok(sentBody.text.includes(OPERATOR_NAME), `delivered body must keep the name, got: ${sentBody.text}`);
    assert.ok(!sentBody.text.includes('<redacted:'), 'delivered body must carry no redaction placeholder');

    mockFetch.mock.restore();
  });

  it('delivered body keeps generic token shapes (draft-corruption parity case)', async () => {
    const mockFetch = stubFetch();

    const apiToken = 'sk-' + 'TESTSECRET123456abcdefghijklmnop';
    const text = `API key: ${apiToken}`;
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token');

    assert.equal(result.ok, true);
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    assert.ok(sentBody.text.includes(apiToken), 'delivered body must keep token-shaped text intact');

    mockFetch.mock.restore();
  });

  it('delivered body keeps the literal under MarkdownV2 too (escape-free fixture)', async () => {
    const mockFetch = stubFetch();

    const text = `Name ${OPERATOR_NAME} and a _Ref: s-abcdef123456_`;
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token', 'MarkdownV2');

    assert.equal(result.ok, true);
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    assert.ok(sentBody.text.includes(OPERATOR_NAME), 'MdV2 sanitize must not eat the name');
    assert.ok(/_Ref: s\\?-abcdef123456_/.test(sentBody.text), 'caller-stamped ref reused');

    mockFetch.mock.restore();
  });

  it('logged copy stays scrubbed: app.log textPreview has the placeholder, never the literal', async () => {
    const mockFetch = stubFetch();

    const text = `Hi ${OPERATOR_NAME}, delivery notice`;
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token');
    assert.equal(result.ok, true);
    await flushLog();

    const row = lastDeliveryRow();
    assert.ok(row, 'delivery log row written');
    const preview = String(row!['textPreview']);
    assert.ok(!preview.includes(OPERATOR_NAME), 'logged copy must NOT keep the name');
    assert.ok(preview.includes('<redacted:PA_USER_NAME>'), 'placeholder recorded in the log');

    mockFetch.mock.restore();
  });

  it('should not redact ordinary text', async () => {
    const mockFetch = stubFetch();

    const text = 'The quick brown fox jumps over the lazy dog. Contact support@example.com';
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token');

    assert.equal(result.ok, true);
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    assert.ok(sentBody.text.includes('quick brown fox'));
    assert.ok(!sentBody.text.includes('<redacted:'));

    mockFetch.mock.restore();
  });

  it('should handle empty chat_id before redaction', async () => {
    const text = 'Message with token sk-1234567890abcdefghijklmnop';
    const config = { chat_id: '', thread_id: 456, token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-chat-id');
  });

  it('should handle empty text gracefully', async () => {
    const text = '   '; // Whitespace only
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty-text');
  });

  it('should preserve ref-ID trailer after redaction relocation', async () => {
    const mockFetch = stubFetch();

    const text = 'Message with key abcdef1234567890abcdef12';
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };

    const result = await sendToTelegram(text, config, 'test-token', 'MarkdownV2');

    assert.equal(result.ok, true);
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    // Ref-ID trailer should still be present
    // MarkdownV2 escapes the '-' inside the ref trailer (s\-abcdef…) and
    // randomBytes(6) renders as 12 hex chars — allow both.
    assert.ok(sentBody.text.match(/_Ref: s\\?-[0-9a-f]{6,12}_/));
    // Bare hex is NOT a known token shape — deliberately left unredacted
    // (zero-false-positive bar; only sk-/xox/AIza/ghp_/Bearer shapes match).
    assert.ok(sentBody.text.includes('abcdef1234567890abcdef12'));

    mockFetch.mock.restore();
  });
});
// pii-scan:ignore-end
