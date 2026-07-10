import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';
import { checkSecrets } from '../src/commands/health.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('checkSecrets (pa health)', () => {
  it('reports FAIL when secrets.env does not exist', async () => {
    const result = await checkSecrets();
    assert.equal(result.status, 'FAIL');
    assert.match(result.detail, /not found/);
  });

  it('reports FAIL (not a false-positive OK) for the exact pa init scaffold — commented placeholder lines only', async () => {
    // Mirrors init.ts's DEFAULT_SECRETS scaffold: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
    // only ever appear inside comment lines, never as real assignments. The old
    // substring check (`content.includes('TELEGRAM_BOT_TOKEN=')`) matched this
    // comment text and reported OK on a totally unconfigured install.
    const scaffold = [
      '# KEY=VALUE pairs injected into worker environment.',
      '#',
      '# Minimum required keys:',
      '#   TELEGRAM_BOT_TOKEN=<your bot token from @BotFather>',
      '#   TELEGRAM_CHAT_ID=<destination chat id; see docs/BOT_GUIDE.md>',
      '',
    ].join('\n');
    await createTempSecrets(tempDir, scaffold);
    const result = await checkSecrets();
    assert.equal(result.status, 'FAIL', 'a totally unconfigured scaffold must not report OK');
    assert.match(result.detail, /TELEGRAM_BOT_TOKEN/);
    assert.match(result.detail, /TELEGRAM_CHAT_ID/);
  });

  it('reports FAIL and lists only the empty key in the "missing in" prefix when one key is present-but-empty', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=\nTELEGRAM_CHAT_ID=123\n');
    const result = await checkSecrets();
    assert.equal(result.status, 'FAIL');
    // Only check the "missing in ...:" prefix — the trailing "Fix:" guidance
    // mentions both key names generically regardless of which is missing.
    const missingPrefix = result.detail.split('Fix:')[0];
    assert.match(missingPrefix, /TELEGRAM_BOT_TOKEN/);
    assert.doesNotMatch(missingPrefix, /TELEGRAM_CHAT_ID/);
  });

  it('reports OK when both required keys have real, non-empty values', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=abc123\nTELEGRAM_CHAT_ID=456\n');
    const result = await checkSecrets();
    assert.equal(result.status, 'OK');
    assert.equal(result.detail, 'required keys present');
  });

  it("reports OK for a quoted value (matches loadSecrets' own quote-stripping)", async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN="abc123"\nTELEGRAM_CHAT_ID=456\n');
    const result = await checkSecrets();
    assert.equal(result.status, 'OK');
  });
});
