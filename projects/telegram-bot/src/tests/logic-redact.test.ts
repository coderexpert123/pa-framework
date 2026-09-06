// pii-scan:ignore-start
/**
 * Tests for AI-184 redaction relocation (2026-09-03).
 *
 * Redaction moved OFF the send path (logic.ts formatWorkerReply /
 * buildWorkerResponse) ONTO the persistence/worker-read boundary:
 * conversation.ts addTurn (turn store + conversation-history.jsonl archive)
 * and dlq.ts appendDlq (DLQ at-rest copy). BOTH directions are pinned here:
 *  - the operator's DELIVERED reply keeps real text (name PRESENT) — the
 *    operator's own private chat and name-bearing third-party drafts
 *    (wa.me prefill) must survive in full; and
 *  - the archived/worker-readable/DLQ copies keep the scrub (name ABSENT).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildWorkerResponse, formatWorkerReply } from '../logic.js';
import { addTurn } from '../conversation.js';
import { appendDlq, loadDlq, clearDlq, type DlqEntry } from '../dlq.js';
import type { ConversationState } from '../types.js';
import { resetRedactCache } from '../../../../pa/dist/src/lib/redact.js';
import { waitForDrain } from './test-teardown-guard.js';

const TEST_PA_HOME = join(tmpdir(), `pa-test-logic-redact-${process.pid}`);

// Synthetic ≥8-char secrets.env literal exercising the PA_USER_NAME defect class
// (the operator's name is in every worker's secret_allowlist) without embedding
// a real name in the tree.
const OPERATOR_NAME = 'OperatorNameFixture';

function writeSecrets(): void {
  writeFileSync(join(TEST_PA_HOME, 'secrets.env'), `PA_USER_NAME=${OPERATOR_NAME}\n`);
}

function makeState(): ConversationState {
  return { chat_id: 123, last_update_id: 0, thread_id: 0, turns: [] };
}

describe('AI-184: send path delivers unredacted text', () => {
  beforeEach(() => {
    resetRedactCache();
    if (existsSync(TEST_PA_HOME)) rmSync(TEST_PA_HOME, { recursive: true, force: true });
    mkdirSync(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
    writeSecrets();
  });

  afterEach(async () => {
    resetRedactCache();
    if (existsSync(TEST_PA_HOME)) rmSync(TEST_PA_HOME, { recursive: true, force: true });
    await waitForDrain();
    delete process.env.PA_HOME;
  });

  it('delivered worker reply keeps a secrets.env literal (operator name PRESENT)', () => {
    const result = {
      success: true,
      output: `Hi ${OPERATOR_NAME}, your monthly transfer draft is ready.`,
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.ok(response.includes(OPERATOR_NAME), 'delivered reply must keep the operator name');
    assert.ok(!response.includes('<redacted:'), 'delivered reply must carry no redaction placeholder');
  });

  it('delivered worker reply keeps generic token shapes (draft-corruption parity case)', () => {
    const apiToken = 'sk-' + 'TESTSECRET123456abcdefghijklmn';
    const result = {
      success: true,
      output: `Use ${apiToken} for the API.`,
    };

    const response = formatWorkerReply(result.output, 'claude');
    assert.ok(response.includes(apiToken), 'delivered reply must keep token-shaped text intact');
  });

  it('delivered evaluatorSummary keeps the literal (failure path)', () => {
    const result = {
      success: false,
      output: '',
      evaluatorSummary: `Loop involved ${OPERATOR_NAME} config`,
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.ok(response.includes(OPERATOR_NAME), 'delivered failure summary must keep real text');
  });

  it('still normalizes markdown and strips planning noise on the delivered text', () => {
    const result = {
      success: true,
      output: `**Bold** with name ${OPERATOR_NAME} and *italic* text`,
    };

    const response = buildWorkerResponse(result, 'claude');
    assert.ok(response.includes('*Bold*'), 'markdown still normalized');
    assert.ok(response.includes(OPERATOR_NAME), 'name still present post-normalization');
  });
});

describe('AI-184: persistence/worker-read copies stay redacted', () => {
  beforeEach(() => {
    resetRedactCache();
    if (existsSync(TEST_PA_HOME)) rmSync(TEST_PA_HOME, { recursive: true, force: true });
    mkdirSync(TEST_PA_HOME, { recursive: true });
    process.env.PA_HOME = TEST_PA_HOME;
    writeSecrets();
  });

  afterEach(async () => {
    resetRedactCache();
    if (existsSync(TEST_PA_HOME)) rmSync(TEST_PA_HOME, { recursive: true, force: true });
    await waitForDrain();
    delete process.env.PA_HOME;
  });

  it('turn store (worker-readable via buildResumedPrompt) redacts assistant turns', () => {
    const state = makeState();
    addTurn(state, { role: 'assistant', text: `Reply for ${OPERATOR_NAME} here`, timestamp: new Date().toISOString() });
    assert.ok(!state.turns[0].text.includes(OPERATOR_NAME), 'worker-readable copy must NOT keep the name');
    assert.ok(state.turns[0].text.includes('<redacted:PA_USER_NAME>'), 'placeholder recorded instead');
  });

  it('assistant-turn metadata (worker, timestamp) survives the redaction copy', () => {
    const state = makeState();
    const turn = { role: 'assistant' as const, text: `x ${OPERATOR_NAME}`, timestamp: '2026-09-03T10:00:00.000Z', worker: 'claude', refId: 's-test0001' };
    addTurn(state, turn);
    assert.equal(state.turns[0].worker, 'claude');
    assert.equal(state.turns[0].timestamp, '2026-09-03T10:00:00.000Z');
    assert.equal(state.turns[0].refId, 's-test0001');
  });

  it('user turns are NOT redacted (never passed the old send path — pre-existing behavior)', () => {
    const state = makeState();
    addTurn(state, { role: 'user', text: `from ${OPERATOR_NAME}`, timestamp: new Date().toISOString() });
    assert.ok(state.turns[0].text.includes(OPERATOR_NAME), 'user turns were never redacted; AI-184 does not change that');
  });

  it('DLQ at-rest copy is redacted (appendDlq)', async () => {
    await clearDlq();
    const entry: DlqEntry = {
      chatId: 123, threadId: 0, text: `Hi ${OPERATOR_NAME}, unsent reply`, timestamp: new Date().toISOString(), updateId: 1,
    };
    await appendDlq(entry);
    const rows = await loadDlq();
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].text.includes(OPERATOR_NAME), 'DLQ at-rest copy must NOT keep the name');
    assert.ok(rows[0].text.includes('<redacted:PA_USER_NAME>'), 'placeholder recorded instead');
    await clearDlq();
  });
});
// pii-scan:ignore-end
