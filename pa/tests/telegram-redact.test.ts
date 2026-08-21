// pii-scan:ignore-start
/**
 * Tests for telegram.ts redaction integration
 *
 * Tests that sendToTelegram applies redaction to message text.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendToTelegram } from '../src/telegram.js';
import { resetRedactCache } from '../src/lib/redact.js';

const TEST_PA_HOME = join(tmpdir(), `pa-test-telegram-redact-${process.pid}`);

describe('telegram.ts redaction', () => {
  beforeEach(() => {
    // Clean up any existing test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    mkdirSync(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
    resetRedactCache();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_PA_HOME)) {
      rmSync(TEST_PA_HOME, { recursive: true, force: true });
    }
    delete process.env.PA_HOME;
  });

  it('should redact secrets in message text before sending', async () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz');

    const mockFetch = mock.fn(async (_url: unknown, _init: unknown) =>
      ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => '{"ok":true}',
      } as Response)
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const text = 'The bot token is 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz';
    const config = { chat_id: '123', thread_id: 456, token_secret: 'TEST_TOKEN_VAR' };
    const token = 'test-token';

    const result = await sendToTelegram(text, config, token, 'MarkdownV2');

    assert.equal(result.ok, true);
    // Verify the redacted text was sent, not the original. NOTE: this test sends
    // with parseMode 'MarkdownV2', so sanitizeMdV2 escapes the tag's angle
    // brackets — the wire form is \<redacted:BOT_TOKEN\>.
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    assert.ok(sentBody.text.includes('<redacted:BOT\\_TOKEN\\>'), `expected escaped redaction tag in: ${sentBody.text}`);
    assert.ok(!sentBody.text.includes('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz'));

    mockFetch.mock.restore();
  });

  it('should apply generic shape patterns to message text', async () => {
    const mockFetch = mock.fn(async (_url: unknown, _init: unknown) =>
      ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => '{"ok":true}',
      } as Response)
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const text = 'API key: sk-live_1234567890abcdefghijklmnop and GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyz';
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };
    const token = 'test-token';

    const result = await sendToTelegram(text, config, token);

    assert.equal(result.ok, true);
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    assert.ok(sentBody.text.includes('<redacted:token>'));
    assert.ok(!sentBody.text.includes('sk-live_1234567890abcdefghijklmnop'));

    mockFetch.mock.restore();
  });

  it('should not redact ordinary text', async () => {
    const mockFetch = mock.fn(async (_url: unknown, _init: unknown) =>
      ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => '{"ok":true}',
      } as Response)
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const text = 'The quick brown fox jumps over the lazy dog. Contact support@example.com';
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };
    const token = 'test-token';

    const result = await sendToTelegram(text, config, token);

    assert.equal(result.ok, true);
    const sentBody = JSON.parse((mockFetch.mock.calls[0]!.arguments[1] as { body: string }).body);
    assert.ok(sentBody.text.includes('quick brown fox'));
    assert.ok(!sentBody.text.includes('<redacted:'));

    mockFetch.mock.restore();
  });

  it('should handle empty chat_id before redaction', async () => {
    const text = 'Message with token sk-1234567890abcdefghijklmnop';
    const config = { chat_id: '', thread_id: 456, token_secret: 'TEST_TOKEN_VAR' };
    const token = 'test-token';

    const result = await sendToTelegram(text, config, token);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-chat-id');
  });

  it('should handle empty text after redaction gracefully', async () => {
    const secretsPath = join(TEST_PA_HOME, 'secrets.env');
    writeFileSync(secretsPath, 'SHORT_TOKEN=ab'); // Too short to redact

    const text = '   '; // Whitespace only
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };
    const token = 'test-token';

    const result = await sendToTelegram(text, config, token);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty-text');
  });

  it('should preserve ref-ID trailer after redaction', async () => {
    const mockFetch = mock.fn(async (_url: unknown, _init: unknown) =>
      ({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => '{"ok":true}',
      } as Response)
    );
    global.fetch = mockFetch as unknown as typeof fetch;

    const text = 'Message with key abcdef1234567890abcdef12';
    const config = { chat_id: '123', token_secret: 'TEST_TOKEN_VAR' };
    const token = 'test-token';

    const result = await sendToTelegram(text, config, token, 'MarkdownV2');

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
