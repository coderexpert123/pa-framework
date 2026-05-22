import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMdV2 } from '../src/lib/mdv2.js';

// Port-correctness smoke tests. The conversation bot's 839-test suite at
// `projects/telegram-bot/src/tests/telegram.test.ts` is the canonical spec.
// These tests verify the port is faithful enough to ship — the goal is to
// catch a copy-paste mistake or a missing line, not to re-test the regex.

describe('sanitizeMdV2 (ported)', () => {
  it('escapes bg-leak-style alert body: paths, identifiers, parens, dots', () => {
    const input = 'Resource: topic--1001234567890_3246\n  PID 66884 (age 325s)';
    const out = sanitizeMdV2(input);
    // Underscore in identifier escaped — no rogue italic span.
    assert.ok(out.includes('topic\\-\\-1001234567890\\_3246'), 'underscore escaped');
    // Dash, parens, period all escaped.
    assert.ok(out.includes('\\(age 325s\\)'), 'parens escaped');
  });

  it('preserves *bold* and _italic_ markers when used as formatting', () => {
    const out = sanitizeMdV2('*Status* is _ready_ now.');
    assert.ok(out.includes('*Status*'), 'bold preserved');
    assert.ok(out.includes('_ready_'), 'italic preserved');
    assert.ok(out.includes('now\\.'), 'plain-text dot escaped');
  });

  it('escapes glob asterisks (commands/* not paired as bold)', () => {
    const out = sanitizeMdV2('files in commands/* and pa/*');
    assert.ok(out.includes('commands/\\*'), 'glob asterisk escaped');
    assert.ok(out.includes('pa/\\*'), 'second glob asterisk escaped');
  });

  it('end-to-end: trailing _Ref: <id>_ trailer survives raw when appended after sanitize', () => {
    const body = sanitizeMdV2('node_modules/x (y).');
    const full = `${body}\n\n_Ref: s-abcd_`;
    // Body has identifiers/specials escaped.
    assert.ok(full.includes('node\\_modules/x \\(y\\)\\.'), 'body sanitized');
    // Trailer's italic markers are raw — they will render as italic.
    assert.match(full, /\n\n_Ref: s-abcd_$/);
  });

  it('escapes Windows path with backslashes', () => {
    const out = sanitizeMdV2('"D:\\npm-global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"');
    // Each `\` in the path is doubled to `\\` (literal escaped backslash for MdV2).
    // Underscore in `node_modules` is escaped to `\_` (escaped underscore).
    // So the substring is: `\\` (doubled path slash) + `node` + `\_` (escaped _) + `modules`.
    assert.ok(out.includes('\\\\node\\_modules'), 'path backslash doubled, underscore escaped');
  });
});
