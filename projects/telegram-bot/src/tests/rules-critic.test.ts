// AI-165 rules-critic unit tests (SPEC §3.5 step 3) — temp PA_HOME, direct calls.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runRulesCritic } from '../rules-critic.js';
import { addRule } from '../../../../pa/dist/src/lib/feedback-rules.js';

const TEST_HOME = join(tmpdir(), `pa-test-rules-critic-${process.pid}`);

function readViolations(): Array<Record<string, unknown>> {
  const p = join(TEST_HOME, 'rules-violations.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('rules-critic', () => {
  beforeEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
    mkdirSync(TEST_HOME, { recursive: true });
    process.env.PA_HOME = TEST_HOME;
  });

  afterEach(() => {
    if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.PA_HOME;
  });

  it('forbidden_phrase violation is recorded with reply_ref_id and ≤200-char excerpt', async () => {
    await addRule({
      key: 'no-bad-word',
      text: 'Never say the bad word',
      scope: 'global',
      status: 'active',
      check: { kind: 'forbidden_phrase', phrase: 'BadWord' },
      origin: { thread_id: null, message_id: null, refId: null, ts: '2026-08-28T00:00:00.000Z', decision_ids: [] },
    });

    runRulesCritic({ text: `Something something badword in the middle of a reply that goes on ${'x'.repeat(300)}`, chatId: -1009999999999, threadId: 4242, refId: 's-test0001' });

    const rows = readViolations();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].check_kind, 'forbidden_phrase');
    assert.equal(rows[0].reply_ref_id, 's-test0001');
    assert.ok(String(rows[0].excerpt).length <= 200, 'excerpt capped at 200');
  });

  it('must_include violation is recorded; complying text records nothing', async () => {
    await addRule({
      key: 'always-ist',
      text: 'Always timestamp in IST',
      scope: 'global',
      status: 'active',
      check: { kind: 'must_include', phrase: 'IST' },
      origin: { thread_id: null, message_id: null, refId: null, ts: '2026-08-28T00:01:00.000Z', decision_ids: [] },
    });

    runRulesCritic({ text: 'No timezone mention here', chatId: -1009999999999, threadId: 4242, refId: 's-test0002' });
    assert.equal(readViolations().length, 1, 'must_include violation recorded');

    runRulesCritic({ text: 'Done at 10:00 IST', chatId: -1009999999999, threadId: 4242, refId: 's-test0003' });
    assert.equal(readViolations().length, 1, 'complying text adds no record');
  });

  it('max_length violation recorded; never throws on any input', async () => {
    const added = await addRule({
      key: 'short-replies',
      text: 'Keep replies short',
      scope: 'global',
      status: 'active',
      check: { kind: 'max_length', max: 50 }, // validation floor is 50-4000
      origin: { thread_id: null, message_id: null, refId: null, ts: '2026-08-28T00:02:00.000Z', decision_ids: [] },
    });
    assert.equal(added.ok, true, `rule seeded: ${added.error ?? ''}`);

    runRulesCritic({ text: 'x'.repeat(100), chatId: -1009999999999, threadId: 4242, refId: 's-test0004' });
    assert.equal(readViolations().length, 1);

    // Never-throws: garbage inputs must not raise into the send path
    runRulesCritic({ text: '', chatId: 0, threadId: 0, refId: '' });
    assert.doesNotThrow(() => runRulesCritic({ text: 'fine', chatId: -1, threadId: -1, refId: 'x' }));
  });
});
