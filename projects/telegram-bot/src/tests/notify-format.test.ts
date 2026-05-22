import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatFailoverMessage, escapeMd } from '../notify-format.js';

describe('escapeMd', () => {
  it('escapes formatting markers that sanitizeMdV2 does not escape', () => {
    assert.equal(escapeMd('hello_world'), 'hello\\_world');
    assert.equal(escapeMd('*bold*'), '\\*bold\\*');
    assert.equal(escapeMd('`code`'), '\\`code\\`');
    // [ ] are NOT escaped by escapeMd — sanitizeMdV2 step 3 handles them
    assert.equal(escapeMd('[link]'), '[link]');
  });

  it('leaves safe characters untouched', () => {
    assert.equal(escapeMd('claude'), 'claude');
    assert.equal(escapeMd('12.5% usage'), '12.5% usage');
  });
});

describe('formatFailoverMessage — rate-limit variant', () => {
  it('includes classification, from, to, minutes, and IST reset time', () => {
    const msg = formatFailoverMessage({
      from: 'claude',
      to: 'gemini',
      kind: 'rate-limit',
      reasonText: 'Usage limit reached for 5 hour',
      minutes: 47,
      classification: 'usage-limit-session',
      source: 'claude-session',
      resetsAtIST: '2026-04-15 21:43 IST',
    });
    assert.ok(msg.includes('claude'), 'from worker');
    assert.ok(msg.includes('gemini'), 'to worker');
    assert.ok(msg.includes('usage-limit-session'), 'classification');
    assert.ok(msg.includes('47 min'), 'cooldown minutes');
    assert.ok(msg.includes('21:43 IST'), 'resume time');
    assert.ok(msg.includes('claude-session'), 'source');
    assert.ok(msg.includes('📡'), 'failover emoji');
  });

  it('unknown classification annotates duration as default/unparseable', () => {
    const msg = formatFailoverMessage({
      from: 'gemini',
      to: 'codex',
      kind: 'rate-limit',
      reasonText: '429 RESOURCE_EXHAUSTED',
      minutes: 2,
      classification: 'unknown',
      source: 'gemini-stderr',
    });
    assert.ok(msg.includes('(unknown)'));
    assert.ok(msg.includes('2 min'));
    assert.ok(msg.includes('duration unparseable, default'));
  });

  it('computes resumesAt from minutes when resetsAtIST is absent', () => {
    const msg = formatFailoverMessage({
      from: 'gemini',
      to: 'codex',
      kind: 'rate-limit',
      reasonText: 'x',
      minutes: 5,
      classification: 'quota-per-minute',
      source: 'gemini-stderr',
    });
    // Should contain an IST timestamp computed from now+5min
    assert.match(msg, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} IST/);
  });

  it('renders null to as "next available worker"', () => {
    const msg = formatFailoverMessage({
      from: 'claude',
      to: null,
      kind: 'rate-limit',
      reasonText: 'x',
      minutes: 10,
      classification: 'usage-limit-session',
    });
    assert.ok(msg.includes('next available worker'));
  });
});

describe('formatFailoverMessage — unavailable variant', () => {
  it('mentions unavailability and reason text', () => {
    const msg = formatFailoverMessage({
      from: 'zclaude',
      to: 'gemini',
      kind: 'unavailable',
      reasonText: 'zclaude check failed or script missing',
    });
    assert.ok(msg.includes('zclaude'));
    assert.ok(msg.includes('unavailable'));
    assert.ok(msg.includes('gemini'));
    assert.ok(msg.includes('check failed'));
  });
});

describe('formatFailoverMessage — failure variant', () => {
  it('mentions failure and exit code detail', () => {
    const msg = formatFailoverMessage({
      from: 'codex',
      to: 'claude',
      kind: 'failure',
      reasonText: 'exit:1 — unknown',
    });
    assert.ok(msg.includes('codex'));
    assert.ok(msg.includes('failed'));
    assert.ok(msg.includes('exit:1'));
  });
});

describe('formatFailoverMessage — markdown safety', () => {
  it('escapes underscores in worker names', () => {
    const msg = formatFailoverMessage({
      from: 'my_worker',
      to: 'other_worker',
      kind: 'unavailable',
      reasonText: 'plain text',
    });
    assert.ok(msg.includes('my\\_worker'));
    assert.ok(msg.includes('other\\_worker'));
  });

  it('escapes asterisks in reason text', () => {
    const msg = formatFailoverMessage({
      from: 'claude',
      to: null,
      kind: 'failure',
      reasonText: 'error with *stars* and [brackets]',
    });
    assert.ok(msg.includes('\\*stars\\*'));
    // [ ] are left unescaped by escapeMd; sanitizeMdV2 step 3 escapes them when sending
    assert.ok(msg.includes('[brackets]'));
  });
});

// ---------------------------------------------------------------------------
// Debounce semantics — the same Map<string, number> pattern the bot uses.
// Tests the key-building and 10s window, not the actual sendMessage side-effect.
// ---------------------------------------------------------------------------

describe('notify debounce map', () => {
  const NOTIFY_DEBOUNCE_MS = 10_000;

  function debouncer() {
    const map = new Map<string, number>();
    return {
      shouldFire(topic: string, from: string, classification: string | undefined, kind: string, now: number): boolean {
        const key = `${topic}|${from}|${classification ?? kind}`;
        const last = map.get(key);
        if (last !== undefined && now - last < NOTIFY_DEBOUNCE_MS) return false;
        map.set(key, now);
        return true;
      },
    };
  }

  it('first call fires, second identical call within 10s is suppressed', () => {
    const d = debouncer();
    assert.equal(d.shouldFire('topic-1', 'claude', 'usage-limit-session', 'rate-limit', 1000), true);
    assert.equal(d.shouldFire('topic-1', 'claude', 'usage-limit-session', 'rate-limit', 2000), false);
    assert.equal(d.shouldFire('topic-1', 'claude', 'usage-limit-session', 'rate-limit', 9000), false);
  });

  it('same topic-from-classification fires again after 10s window', () => {
    const d = debouncer();
    assert.equal(d.shouldFire('topic-1', 'claude', 'usage-limit-session', 'rate-limit', 1000), true);
    assert.equal(d.shouldFire('topic-1', 'claude', 'usage-limit-session', 'rate-limit', 11001), true);
  });

  it('different topics do not share debounce state', () => {
    const d = debouncer();
    assert.equal(d.shouldFire('topic-1', 'claude', 'usage-limit-session', 'rate-limit', 1000), true);
    assert.equal(d.shouldFire('topic-2', 'claude', 'usage-limit-session', 'rate-limit', 1000), true);
  });

  it('different classifications on the same topic/from fire independently', () => {
    const d = debouncer();
    assert.equal(d.shouldFire('topic-1', 'claude', 'usage-limit-session', 'rate-limit', 1000), true);
    assert.equal(d.shouldFire('topic-1', 'claude', 'server-overload', 'rate-limit', 1000), true);
  });

  it('falls back to kind when classification is undefined', () => {
    const d = debouncer();
    assert.equal(d.shouldFire('topic-1', 'zclaude', undefined, 'unavailable', 1000), true);
    assert.equal(d.shouldFire('topic-1', 'zclaude', undefined, 'unavailable', 2000), false);
    // Different kind with same undefined classification → different key
    assert.equal(d.shouldFire('topic-1', 'zclaude', undefined, 'failure', 1000), true);
  });
});

// ---------------------------------------------------------------------------
// raw code-fence fallback in rate-limit notifications (Phase 3)
// ---------------------------------------------------------------------------

describe('formatFailoverMessage — raw code-fence fallback', () => {
  it('includes raw code-fence when classification is unknown', () => {
    const msg = formatFailoverMessage({
      from: 'zclaude',
      to: 'gemini',
      kind: 'rate-limit',
      reasonText: 'some error',
      minutes: 2,
      classification: 'unknown',
      source: 'claude-session',
      raw: 'API Error: some unparseable 429 response body',
    });
    assert.ok(msg.includes('```'), 'should contain code-fence');
    assert.ok(msg.includes('API Error: some unparseable'), 'should include raw text verbatim');
  });

  it('omits raw code-fence when minutes and resetsAtIST are both present', () => {
    const msg = formatFailoverMessage({
      from: 'zclaude',
      to: 'gemini',
      kind: 'rate-limit',
      reasonText: 'usage-limit',
      minutes: 3000,
      classification: 'usage-limit-session',
      source: 'claude-session',
      resetsAtIST: '2026-04-21 04:37 IST',
      raw: 'API Error: Request rejected (429)',
    });
    assert.ok(!msg.includes('```'), 'should NOT contain code-fence when classification and minutes are parseable');
  });

  it('truncates raw to 500 chars in the rendered message', () => {
    const longRaw = 'E'.repeat(1000);
    const msg = formatFailoverMessage({
      from: 'zclaude',
      to: null,
      kind: 'rate-limit',
      reasonText: 'x',
      minutes: 2,
      classification: 'unknown',
      source: 'claude-session',
      raw: longRaw,
    });
    assert.ok(msg.includes('```'), 'should include code-fence');
    // The raw in the message should be at most 500 chars of E's
    const fenceMatch = msg.match(/```\n([\s\S]*?)\n```/);
    assert.ok(fenceMatch, 'should have a complete code-fence block');
    assert.ok(fenceMatch![1].length <= 500, `raw block should be ≤500 chars, got ${fenceMatch![1].length}`);
  });

  it('sanitizes triple-backticks in raw text to prevent fence escape', () => {
    const raw = 'before ``` after';
    const msg = formatFailoverMessage({
      from: 'zclaude',
      to: null,
      kind: 'rate-limit',
      reasonText: 'x',
      minutes: 2,
      classification: 'unknown',
      source: 'claude-session',
      raw,
    });
    assert.ok(msg.includes("'''"), 'should replace triple-backtick with triple-single-quote');
    assert.ok(!msg.includes('``` after'), 'should not contain original triple-backtick that would break the fence');
  });
});
