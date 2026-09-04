import './test-env-guard.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectRawTelegramSends } from '../src/worker-exec.js';

// Raw-send guard (2026-09-04, plans/2026-09-04-raw-send-guard-SPEC.md WP2.5).
// detectRawTelegramSends is a pure function over the TraceCollector's collected
// command strings, so these cases exercise it directly — no spawn, no PA_HOME.
// The acceptance class is deliberate: api.telegram.org URLs (the shape the
// 2026-09-04 scratch send into pa-support used) and telegramFetch( (the
// repo's own sanctioned HTTP helper name, caught so a hand-rolled re-implementation
// of it still lights up). Dev greps/edits that merely CONTAIN these substrings
// are a known accepted false-positive class (alert-only in main.ts).

describe('detectRawTelegramSends', () => {
  it('flags a node -e fetch to api.telegram.org/bot.../sendMessage', () => {
    const cmd = `node -e "fetch('https://api.telegram.org/bot123:ABC/sendMessage?chat_id=1&text=hi')"`;
    assert.deepEqual(detectRawTelegramSends([cmd]), [cmd]);
  });

  it('flags a command containing telegramFetch(', () => {
    const cmd = `python scratch/send.py  # uses telegramFetch(chat_id, text)`;
    assert.deepEqual(detectRawTelegramSends([cmd]), [cmd]);
  });

  it('does not flag the sanctioned pa notify path', () => {
    assert.deepEqual(detectRawTelegramSends(['pa notify --topic-thread 310 hello']), []);
  });

  it('does not flag prose/plain commands', () => {
    assert.deepEqual(
      detectRawTelegramSends(['git status', 'npm run build', 'List the topics that changed today']),
      []
    );
  });

  it('truncates a match longer than 200 chars to 200', () => {
    const filler = 'x'.repeat(250);
    const cmd = `curl https://api.telegram.org/bot123/sendMessage?text=${filler}`;
    const out = detectRawTelegramSends([cmd]);
    assert.equal(out.length, 1);
    assert.equal(out[0].length, 200);
    assert.ok(out[0].startsWith('curl https://api.telegram.org/bot123/sendMessage?text='));
  });

  it('caps matches at 3', () => {
    const cmds = [
      'cmd1 api.telegram.org',
      'cmd2 telegramFetch(',
      'cmd3 api.telegram.org',
      'cmd4 telegramFetch(',
      'cmd5 api.telegram.org',
      'pa notify --topic-thread 310 hello',
    ];
    const out = detectRawTelegramSends(cmds);
    assert.equal(out.length, 3);
    assert.deepEqual(out, ['cmd1 api.telegram.org', 'cmd2 telegramFetch(', 'cmd3 api.telegram.org']);
  });

  it('returns [] for an empty command list', () => {
    assert.deepEqual(detectRawTelegramSends([]), []);
  });
});
