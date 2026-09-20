/**
 * AI-246 v4 (WP-B): pins the bot-side merge of pa's browserSessionEnvOverlay
 * into the worker-dispatch secrets record — the single seam in main() that
 * covers all three lanes (dispatchMessage, executeTopicTask and
 * dispatchOrchestratorTurn each receive the same `secrets` object built once
 * after loadSecrets).
 *
 * The merge must be:
 * - complete: all three overlay vars land on the record, values keyed off
 *   browser.cdp_port / voice_inbox.port in config.yaml
 * - additive-only: a real secrets.env key is never overridden
 * - non-fatal: a config-load failure leaves the record untouched
 * - token-free: no PA_SCREENCAST_INGEST_TOKEN — the bridge reads config
 *   itself (WP-C)
 */
import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyBrowserSessionEnvOverlay } from '../main.js';
import { waitForDrain } from './test-teardown-guard.js';

let paHomeDir: string;
const savedPaHome = process.env.PA_HOME;

beforeEach(async () => {
  paHomeDir = await mkdtemp(join(tmpdir(), 'browser-env-overlay-'));
  process.env.PA_HOME = paHomeDir;
});

afterEach(async () => {
  await waitForDrain();
  if (savedPaHome === undefined) delete process.env.PA_HOME;
  else process.env.PA_HOME = savedPaHome;
  await rm(paHomeDir, { recursive: true, force: true });
});

function writeConfig(body: string): Promise<void> {
  return writeFile(join(paHomeDir, 'config.yaml'), body, 'utf8');
}

describe('applyBrowserSessionEnvOverlay (AI-246 v4 WP-B)', () => {
  it('merges the three CDP vars into an empty secrets record', async () => {
    await writeConfig('workers: []\n');
    const secrets: Record<string, string> = {};
    await applyBrowserSessionEnvOverlay(secrets);
    assert.equal(secrets.PLAYWRIGHT_MCP_CDP_ENDPOINT, 'http://127.0.0.1:9222');
    assert.equal(secrets.PA_BROWSER_CDP_PORT, '9222');
    assert.equal(secrets.VOICE_INBOX_PORT, '8787');
  });

  it('honours configured browser.cdp_port and voice_inbox.port', async () => {
    await writeConfig('workers: []\nbrowser:\n  cdp_port: 9333\nvoice_inbox:\n  port: 8999\n');
    const secrets: Record<string, string> = {};
    await applyBrowserSessionEnvOverlay(secrets);
    assert.equal(secrets.PLAYWRIGHT_MCP_CDP_ENDPOINT, 'http://127.0.0.1:9333');
    assert.equal(secrets.PA_BROWSER_CDP_PORT, '9333');
    assert.equal(secrets.VOICE_INBOX_PORT, '8999');
  });

  it('never overrides a real secrets.env key (additive-only)', async () => {
    await writeConfig('workers: []\n');
    const secrets: Record<string, string> = {
      PLAYWRIGHT_MCP_CDP_ENDPOINT: 'custom',
      PA_BROWSER_CDP_PORT: '1111',
    };
    await applyBrowserSessionEnvOverlay(secrets);
    assert.equal(secrets.PLAYWRIGHT_MCP_CDP_ENDPOINT, 'custom');
    assert.equal(secrets.PA_BROWSER_CDP_PORT, '1111');
    // Keys absent from secrets.env are still filled by the overlay.
    assert.equal(secrets.VOICE_INBOX_PORT, '8787');
  });

  it('a config-load failure leaves secrets untouched and never throws', async () => {
    // No config.yaml written — loadConfig throws inside the seam.
    const secrets: Record<string, string> = { TELEGRAM_BOT_TOKEN: 'x' };
    await assert.doesNotReject(applyBrowserSessionEnvOverlay(secrets));
    assert.deepEqual(secrets, { TELEGRAM_BOT_TOKEN: 'x' });
  });

  it('injects no screencast token (the bridge reads config itself — WP-C)', async () => {
    await writeConfig('workers: []\nvoice_inbox:\n  screencast_ingest_token: deadbeef\n');
    const secrets: Record<string, string> = {};
    await applyBrowserSessionEnvOverlay(secrets);
    assert.equal(secrets.PA_SCREENCAST_INGEST_TOKEN, undefined);
  });
});
