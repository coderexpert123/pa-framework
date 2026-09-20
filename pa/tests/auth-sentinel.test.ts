import './test-env-guard.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectAuthPrompts, AUTH_PROMPT_PATTERNS } from '../src/worker-exec.js';

// Auth-prompt sentinel (auth broker Phase A, 2026-09-10 build spec §5 WP-G,
// decisions C6/D8). detectAuthPrompts is a pure function over a worker turn's
// raw stdout, so these cases exercise it directly — no spawn, no PA_HOME.
// The four negative controls are the point of this file: they prove the
// detector discriminates rather than always firing. Per the spec, if any of
// them did not hold as written it would be a spec defect (STOP and report,
// never weaken the test or the regex) — verified by hand against
// AUTH_PROMPT_PATTERNS before this file was written; all four hold.

describe('detectAuthPrompts — auth-shaped worker output', () => {
  it('matches an oauth-shaped authorize URL', () => {
    const line = 'https://accounts.google.com/o/oauth2/auth?client_id=x';
    assert.deepEqual(detectAuthPrompts(line), [line]);
  });

  it('matches a WDJB-MJHT style device code', () => {
    const line = 'Your device code is WDJB-MJHT — enter it at the link above.';
    assert.deepEqual(detectAuthPrompts(line), [line]);
  });

  it('matches "enter the code"', () => {
    const line = 'Enter the code shown on your phone.';
    assert.deepEqual(detectAuthPrompts(line), [line]);
  });

  it('matches "paste the code"', () => {
    const line = 'Paste the code here';
    assert.deepEqual(detectAuthPrompts(line), [line]);
  });

  it('caps at 3 matches even when more lines qualify', () => {
    const lines = [
      'Enter the code shown on your phone.',
      'Paste the code here',
      'one-time code: 555222',
      'Another one-time code follows',
      'https://example.com/oauth2/authorize?x=1',
    ];
    const out = detectAuthPrompts(lines.join('\n'));
    assert.equal(out.length, 3);
    assert.deepEqual(out, lines.slice(0, 3));
  });

  it('truncates a matching line longer than 200 chars to 200', () => {
    const filler = 'x'.repeat(250);
    const line = `Enter the code shown on your phone: ${filler}`;
    const out = detectAuthPrompts(line);
    assert.equal(out.length, 1);
    assert.equal(out[0].length, 200);
    assert.equal(out[0], line.slice(0, 200));
  });

  // Negative controls — every one of these must return [] against the exact
  // AUTH_PROMPT_PATTERNS list, or the spec's regex set is wrong.
  it('does not flag prose with no URL, no code, no keyword', () => {
    assert.deepEqual(detectAuthPrompts('Logged in as some-user'), []);
  });

  it('does not flag a URL whose path contains "verification" (not "verify")', () => {
    assert.deepEqual(
      detectAuthPrompts('Read https://example.com/docs/verification-guide for details'),
      []
    );
  });

  it('does not flag a date-and-time line that looks like a dashed code', () => {
    assert.deepEqual(detectAuthPrompts('Deployed on 2026-09-10 at 06:00'), []);
  });

  it('returns [] for the empty string', () => {
    assert.deepEqual(detectAuthPrompts(''), []);
  });

  it('AUTH_PROMPT_PATTERNS has exactly the five frozen patterns', () => {
    assert.equal(AUTH_PROMPT_PATTERNS.length, 5);
  });
});
