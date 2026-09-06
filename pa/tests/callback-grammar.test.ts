import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCallbackData,
  parseReauthCallback,
  gateFor,
  validateKeyboardRequest,
} from '../src/lib/callback-grammar.js';

// The single-source callback grammar (moved 2026-09-02 from the bot's callbacks.ts,
// SPEC §3.4). The bot's own suite (projects/telegram-bot/src/tests/callbacks.test.ts)
// keeps its full describe set unchanged against the re-exports — those are the
// drift alarm for the move; this file pins the pa-side additions (q:, and
// validateKeyboardRequest) plus one row per grammar line so a regression here is
// caught without a bot build.

describe('parseCallbackData — moved-grammar canary (one row each)', () => {
  it('reauth:google[:skill]', () => {
    assert.deepEqual(parseCallbackData('reauth:google'), { prefix: 'reauth', provider: 'google', skill: undefined, raw: 'reauth:google' });
    assert.deepEqual(parseCallbackData('reauth:google:daily-mail-brief'), { prefix: 'reauth', provider: 'google', skill: 'daily-mail-brief', raw: 'reauth:google:daily-mail-brief' });
  });

  it('cf:y / cf:n', () => {
    assert.deepEqual(parseCallbackData('cf:y'), { prefix: 'cf', answer: 'y', raw: 'cf:y' });
    assert.deepEqual(parseCallbackData('cf:n'), { prefix: 'cf', answer: 'n', raw: 'cf:n' });
  });

  it('sk:run:<skill> / dq:replay:<index> (operator rows unchanged)', () => {
    assert.deepEqual(parseCallbackData('sk:run:fitness-sync'), { prefix: 'sk', kind: 'run', name: 'fitness-sync', confirmed: false, raw: 'sk:run:fitness-sync' });
    assert.deepEqual(parseCallbackData('dq:replay:7:c'), { prefix: 'dq', index: 7, confirmed: true, raw: 'dq:replay:7:c' });
  });

  it('parses q:0 through q:3 and rejects q:4', () => {
    for (let i = 0; i <= 3; i++) {
      assert.deepEqual(parseCallbackData(`q:${i}`), { prefix: 'q', index: i, raw: `q:${i}` });
    }
    assert.equal(parseCallbackData('q:4'), null);
    assert.equal(parseCallbackData('q:12'), null);
    assert.equal(parseCallbackData('q:'), null);
    assert.equal(parseCallbackData('q:-1'), null);
  });

  it('still rejects over-64-byte and unrecognised data', () => {
    assert.equal(parseCallbackData('x'.repeat(65)), null);
    assert.equal(parseCallbackData(undefined), null);
    assert.equal(parseCallbackData('not-a-callback!!'), null);
  });
});

describe('gateFor', () => {
  it('q: is chat-gated (same class as cf:)', () => {
    assert.equal(gateFor(parseCallbackData('q:0')!), 'chat');
    assert.equal(gateFor(parseCallbackData('cf:y')!), 'chat');
    assert.equal(gateFor(parseCallbackData('sk:run:fitness-sync')!), 'operator');
  });
});

// AI-210 (2026-09-06): picker Submit/Discard — two new chat-gated cc simple actions.
describe('cc:submit / cc:discard — picker stage-then-apply (AI-210)', () => {
  it('parses both as simple cc actions', () => {
    assert.deepEqual(parseCallbackData('cc:submit'), { prefix: 'cc', action: 'submit', raw: 'cc:submit' });
    assert.deepEqual(parseCallbackData('cc:discard'), { prefix: 'cc', action: 'discard', raw: 'cc:discard' });
  });

  it('rejects extra segments (anchored simple form, like cc:back)', () => {
    assert.equal(parseCallbackData('cc:submit:x'), null);
    assert.equal(parseCallbackData('cc:discard:y'), null);
  });

  it('both are chat-gated (same class as cc:back)', () => {
    assert.equal(gateFor(parseCallbackData('cc:submit')!), 'chat');
    assert.equal(gateFor(parseCallbackData('cc:discard')!), 'chat');
  });
});

describe('parseReauthCallback (moved from the bot logic.ts — re-exported there)', () => {
  it('parses provider and optional skill', () => {
    assert.deepEqual(parseReauthCallback('reauth:google'), { provider: 'google', skill: undefined });
    assert.deepEqual(parseReauthCallback('reauth:google:daily-mail-brief'), { provider: 'google', skill: 'daily-mail-brief' });
    assert.equal(parseReauthCallback('reauth:microsoft'), null);
    assert.equal(parseReauthCallback(undefined), null);
  });
});

describe('validateKeyboardRequest', () => {
  it('accepts a valid request and builds one row per button', () => {
    const res = validateKeyboardRequest({
      buttons: [
        { text: 'Run again', callback_data: 'sk:run:fitness-form-check:c' },
        { text: 'Prefer A', callback_data: 'q:0' },
      ],
    });
    assert.ok(res.ok);
    assert.deepEqual(res.keyboard, {
      inline_keyboard: [
        [{ text: 'Run again', callback_data: 'sk:run:fitness-form-check:c' }],
        [{ text: 'Prefer A', callback_data: 'q:0' }],
      ],
    });
  });

  it('rejects zero buttons and more than six', () => {
    assert.equal(validateKeyboardRequest({ buttons: [] }).ok, false);
    const seven = Array.from({ length: 7 }, (_, i) => ({ text: `b${i}`, callback_data: 'q:0' }));
    assert.equal(validateKeyboardRequest({ buttons: seven }).ok, false);
  });

  it('rejects buttons with extra or missing keys', () => {
    assert.equal(validateKeyboardRequest({ buttons: [{ text: 'A', callback_data: 'q:0', url: 'https://x' }] }).ok, false);
    assert.equal(validateKeyboardRequest({ buttons: [{ text: 'A' }] }).ok, false);
    assert.equal(validateKeyboardRequest({ buttons: [{ callback_data: 'q:0' }] }).ok, false);
  });

  it('rejects labels over 40 chars', () => {
    assert.equal(validateKeyboardRequest({ buttons: [{ text: 'x'.repeat(41), callback_data: 'q:0' }] }).ok, false);
    assert.ok(validateKeyboardRequest({ buttons: [{ text: 'x'.repeat(40), callback_data: 'q:0' }] }).ok);
  });

  it('rejects callback_data outside the grammar (which also caps at 64 bytes)', () => {
    assert.equal(validateKeyboardRequest({ buttons: [{ text: 'A', callback_data: 'made:up' }] }).ok, false);
    assert.equal(validateKeyboardRequest({ buttons: [{ text: 'A', callback_data: 'x'.repeat(65) }] }).ok, false);
    assert.equal(validateKeyboardRequest({ buttons: [{ text: 'A', callback_data: 42 }] }).ok, false);
  });

  it('never throws on hostile input shapes', () => {
    for (const input of [null, undefined, 'x', 42, [], { buttons: 'no' }, { buttons: [null] }, { buttons: [[]] }]) {
      assert.equal(validateKeyboardRequest(input).ok, false);
    }
  });
});

// Wave 2 (SPEC §3.1 A.3): the executor lane's task-question press.
describe('qt: — task-question grammar (chat-gated, Wave 2)', () => {
  it('qt parses 12-hex task ids', () => {
    assert.deepEqual(parseCallbackData('qt:tt-0123456789ab:0'), {
      prefix: 'qt',
      taskId: 'tt-0123456789ab',
      index: 0,
      raw: 'qt:tt-0123456789ab:0',
    });
    for (let i = 0; i <= 3; i++) {
      const parsed = parseCallbackData(`qt:tt-0123456789ab:${i}`);
      assert.equal(parsed?.prefix, 'qt');
      assert.equal(parsed && 'index' in parsed ? parsed.index : -1, i);
    }
    // Rejects: wrong id shapes, uppercase hex, out-of-range index, truncated data,
    // and the q: sibling grammar is untouched.
    assert.equal(parseCallbackData('qt:tt-0123456789a:0'), null, '11 hex');
    assert.equal(parseCallbackData('qt:tt-0123456789abc:0'), null, '13 hex');
    assert.equal(parseCallbackData('qt:tt-0123456789gg:0'), null, 'non-hex');
    assert.equal(parseCallbackData('qt:tt-0123456789AB:0'), null, 'uppercase');
    assert.equal(parseCallbackData('qt:xx-0123456789ab:0'), null, 'bad id prefix');
    assert.equal(parseCallbackData('qt:abc123def456:0'), null, 'missing tt- prefix');
    assert.equal(parseCallbackData('qt:tt-0123456789ab:4'), null, 'index 4');
    assert.equal(parseCallbackData('qt:tt-0123456789ab'), null, 'missing index');
    assert.equal(parseCallbackData('qt:'), null);
    assert.equal(parseCallbackData('q:0')?.prefix, 'q', 'the q: sibling grammar is untouched');
  });

  it('gateFor(qt) is chat (same class as q:)', () => {
    const parsed = parseCallbackData('qt:tt-0123456789ab:2');
    if (!parsed) throw new Error('qt:tt-...:2 must parse');
    assert.equal(gateFor(parsed), 'chat');
  });

  it('a qt: button passes validateKeyboardRequest (executor keyboards use the one grammar)', () => {
    assert.ok(
      validateKeyboardRequest({ buttons: [{ text: 'Option A', callback_data: 'qt:tt-0123456789ab:0' }] }).ok,
    );
  });
});

// Wave 2 Phase 2 (SPEC §3.4 WP-D2): the four pa-side conversion prefixes.
describe('WP-D2 prefixes — ru/si/ch/wt (operator-gated)', () => {
  it('ru parses accept and reject', () => {
    assert.deepEqual(parseCallbackData('ru:rule-feedback-a1:a'), {
      prefix: 'ru', ruleId: 'rule-feedback-a1', action: 'a', raw: 'ru:rule-feedback-a1:a',
    });
    assert.deepEqual(parseCallbackData('ru:rule-feedback-a1:x'), {
      prefix: 'ru', ruleId: 'rule-feedback-a1', action: 'x', raw: 'ru:rule-feedback-a1:x',
    });
    // Charset: [A-Za-z0-9_-]{1,40}; anything else falls through to null, and the
    // q:/qt: siblings are untouched.
    assert.equal(parseCallbackData('ru:has.dot:a'), null, 'dot outside the ru charset');
    assert.equal(parseCallbackData('ru:has:colon:a'), null, 'extra segment');
    assert.equal(parseCallbackData('ru:' + 'x'.repeat(41) + ':a'), null, '41-char id');
    assert.equal(parseCallbackData('ru:short:b'), null, 'action outside a|x');
    assert.equal(parseCallbackData('ru:short'), null, 'missing action');
    assert.equal(parseCallbackData('ru:'), null);
    assert.equal(parseCallbackData('q:0')?.prefix, 'q', 'the q: sibling grammar is untouched');
  });

  it('si parses mute with and without confirm', () => {
    assert.deepEqual(parseCallbackData('si:bg-leak:m'), {
      prefix: 'si', family: 'bg-leak', confirmed: false, raw: 'si:bg-leak:m',
    });
    assert.deepEqual(parseCallbackData('si:bg-leak:m:c'), {
      prefix: 'si', family: 'bg-leak', confirmed: true, raw: 'si:bg-leak:m:c',
    });
    // Family charset [A-Za-z0-9._-]{1,40} — census keys are dotted/hyphenated.
    assert.deepEqual(parseCallbackData('si:oauth.invalid_grant-42:m'), {
      prefix: 'si', family: 'oauth.invalid_grant-42', confirmed: false, raw: 'si:oauth.invalid_grant-42:m',
    });
    assert.equal(parseCallbackData('si:bg leak:m'), null, 'space outside the si charset');
    assert.equal(parseCallbackData('si:bg-leak:a'), null, 'action outside m');
    assert.equal(parseCallbackData('si:bg-leak'), null, 'missing action');
    assert.equal(parseCallbackData('si:bg-leak:c'), null, 'confirm without the m step');
    assert.equal(parseCallbackData('si:' + 'f'.repeat(41) + ':m'), null, '41-char family');
  });

  it('ch parses chain retry with confirm', () => {
    assert.deepEqual(parseCallbackData('ch:r:nightly-sync'), {
      prefix: 'ch', chain: 'nightly-sync', confirmed: false, raw: 'ch:r:nightly-sync',
    });
    assert.deepEqual(parseCallbackData('ch:r:nightly-sync:c'), {
      prefix: 'ch', chain: 'nightly-sync', confirmed: true, raw: 'ch:r:nightly-sync:c',
    });
    // Chain names follow the SK_NAME_RE charset (lowercase start, [a-z0-9-]).
    assert.equal(parseCallbackData('ch:r:-leading'), null, 'name must start alphanumeric');
    assert.equal(parseCallbackData('ch:r:HasCaps'), null, 'uppercase outside the chain charset');
    assert.equal(parseCallbackData('ch:r:'), null);
    assert.equal(parseCallbackData('ch:x:name'), null, 'only ch:r is a retry');
    assert.equal(parseCallbackData('ch:r:' + 'n'.repeat(41)), null, '41-char name');
  });

  it('wt parses watch re-register', () => {
    assert.deepEqual(parseCallbackData('wt:w-0123abcd:r'), {
      prefix: 'wt', watchId: 'w-0123abcd', raw: 'wt:w-0123abcd:r',
    });
    assert.deepEqual(parseCallbackData('wt:my-watch-1:r'), {
      prefix: 'wt', watchId: 'my-watch-1', raw: 'wt:my-watch-1:r',
    });
    // No two-tap on wt: (re-registering is idempotent and side-effect-light).
    assert.equal(parseCallbackData('wt:w-0123abcd:r:c'), null);
    assert.equal(parseCallbackData('wt:w_underscore:r'), null, 'underscore outside the wt charset');
    assert.equal(parseCallbackData('wt:w-0123abcd'), null, 'missing :r');
    assert.equal(parseCallbackData('wt:' + 'w'.repeat(33) + ':r'), null, '33-char id');
  });

  it('all four are operator-gated (same class as sk:/dq:)', () => {
    for (const data of ['ru:r1:a', 'si:f:m:c', 'ch:r:chain', 'wt:w-0123abcd:r']) {
      const parsed = parseCallbackData(data);
      if (!parsed) throw new Error(`${data} must parse`);
      assert.equal(gateFor(parsed), 'operator', data);
    }
  });

  it('WP-D2 buttons pass validateKeyboardRequest', () => {
    assert.ok(validateKeyboardRequest({
      buttons: [
        { text: '✅ Accept', callback_data: 'ru:rule-1:a' },
        { text: '✖ Reject', callback_data: 'ru:rule-1:x' },
        { text: '🔇 Mute alerts', callback_data: 'si:bg-leak:m' },
        { text: '🔁 Re-run chain', callback_data: 'ch:r:nightly-sync' },
        { text: '🔁 Re-register watch', callback_data: 'wt:w-0123abcd:r' },
      ],
    }).ok);
  });
});
