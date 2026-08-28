import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REAUTH_PATTERN,
  handleReauthCommand,
  parseReauthCallback,
  RESET_PATTERN,
  REF_PATTERN,
  AUTH_PATTERN,
} from '../logic.js';

// ---------------------------------------------------------------------------
// REAUTH_PATTERN, handleReauthCommand (WP-G2, 2026-08-23, AI-147)
// Pure-parser only — the spawn (pa/scripts/start_google_telegram_reauth.py)
// is not unit-tested here; see plans/2026-08-23-alerts-wave-SPEC.md §WP-G2.
// ---------------------------------------------------------------------------

describe('REAUTH_PATTERN', () => {
  it('matches bare /reauth with no skill', () => {
    const m = REAUTH_PATTERN.exec('/reauth');
    assert.ok(m);
    assert.equal(m![1], undefined);
  });

  it('matches /reauth@mybot with no skill', () => {
    const m = REAUTH_PATTERN.exec('/reauth@mybot');
    assert.ok(m);
    assert.equal(m![1], undefined);
  });

  it('matches /reauth daily-mail-brief and captures the skill', () => {
    const m = REAUTH_PATTERN.exec('/reauth daily-mail-brief');
    assert.ok(m);
    assert.equal(m![1], 'daily-mail-brief');
  });

  it('matches /reauth with trailing spaces and no skill', () => {
    const m = REAUTH_PATTERN.exec('/reauth   ');
    assert.ok(m);
    assert.equal(m![1], undefined);
  });

  it('rejects /reauth followed by free text', () => {
    assert.ok(!REAUTH_PATTERN.test('/reauth Some Free Text'));
  });

  it('rejects /reauth_public (not a word boundary)', () => {
    assert.ok(!REAUTH_PATTERN.test('/reauth_public'));
  });

  // Mutual exclusivity — same construction as the other deterministic
  // command patterns (logic.test.ts's REF_PATTERN/COMMIT_PATTERN suites).
  it('does not match /reset', () => assert.ok(!REAUTH_PATTERN.test('/reset')));
  it('does not match /ref abc', () => assert.ok(!REAUTH_PATTERN.test('/ref abc')));
  it('does not match /auth <code>', () => assert.ok(!REAUTH_PATTERN.test('/auth abc123')));

  it('RESET_PATTERN/REF_PATTERN/AUTH_PATTERN do not match /reauth', () => {
    assert.ok(!RESET_PATTERN.test('/reauth'));
    assert.ok(!REF_PATTERN.test('/reauth'));
    assert.ok(!AUTH_PATTERN.test('/reauth'));
  });
});

describe('handleReauthCommand', () => {
  it('returns matched:false for unrelated text', () => {
    const result = handleReauthCommand('hello there');
    assert.equal(result.matched, false);
  });

  it('returns matched:true with skill undefined for bare /reauth', () => {
    const result = handleReauthCommand('/reauth');
    assert.ok(result.matched);
    assert.equal(result.skill, undefined);
  });

  it('returns matched:true and the skill for /reauth <skill>', () => {
    const result = handleReauthCommand('/reauth daily-mail-brief');
    assert.ok(result.matched);
    assert.equal(result.skill, 'daily-mail-brief');
  });

  it('returns matched:true with skill undefined for /reauth@botname', () => {
    const result = handleReauthCommand('/reauth@mybot');
    assert.ok(result.matched);
    assert.equal(result.skill, undefined);
  });
});

// ---------------------------------------------------------------------------
// parseReauthCallback (WP-1, 2026-08-23, reauth-button-SPEC)
// Pure-parser only for the reauth:google[:skill] inline-button callback_data.
// ---------------------------------------------------------------------------

describe('parseReauthCallback', () => {
  it('parses bare reauth:google with no skill', () => {
    const result = parseReauthCallback('reauth:google');
    assert.deepEqual(result, { provider: 'google', skill: undefined });
  });

  it('parses reauth:google:<skill> and captures the skill', () => {
    const result = parseReauthCallback('reauth:google:daily-mail-brief');
    assert.deepEqual(result, { provider: 'google', skill: 'daily-mail-brief' });
  });

  it('rejects an unknown provider', () => {
    assert.equal(parseReauthCallback('reauth:microsoft'), null);
  });

  it('rejects a skill name with disallowed characters', () => {
    assert.equal(parseReauthCallback('reauth:google:Some_Skill!'), null);
  });

  it('returns null for undefined callback data', () => {
    assert.equal(parseReauthCallback(undefined), null);
  });

  it('rejects unrelated callback data (e.g. pm: HITL buttons)', () => {
    assert.equal(parseReauthCallback('pm:abc123:approve'), null);
  });
});
