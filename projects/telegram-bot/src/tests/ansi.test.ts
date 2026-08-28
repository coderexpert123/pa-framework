import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi } from '../ansi.js';

describe('stripAnsi', () => {
  it('strips SGR color sequences', () => {
    const colored = '\x1b[31mRed text\x1b[0m and normal';
    assert.equal(stripAnsi(colored), 'Red text and normal');
  });

  it('strips SGR bold sequences', () => {
    const bold = '\x1b[1mBold text\x1b[0m and normal';
    assert.equal(stripAnsi(bold), 'Bold text and normal');
  });

  it('strips reset sequences', () => {
    const reset = '\x1b[0mReset\x1b[0m';
    assert.equal(stripAnsi(reset), 'Reset');
  });

  it('strips cursor-move CSI sequences', () => {
    const cursor = '\x1b[2J\x1b[HText';
    assert.equal(stripAnsi(cursor), 'Text');
  });

  it('strips erase CSI sequences', () => {
    const erase = '\x1b[KText';
    assert.equal(stripAnsi(erase), 'Text');
  });

  it('leaves normal text byte-identical', () => {
    const normal = 'Hello world! 🎉 Box: ── `code`';
    assert.equal(stripAnsi(normal), normal);
  });

  it('leaves emoji unchanged', () => {
    const emoji = 'Test ✅ check 👍 status';
    assert.equal(stripAnsi(emoji), emoji);
  });

  it('leaves box-drawing characters unchanged', () => {
    const box = '┌───┐\n│   │\n└───┘';
    assert.equal(stripAnsi(box), box);
  });

  it('leaves backticks unchanged', () => {
    const backticks = '`code` and ``double``';
    assert.equal(stripAnsi(backticks), backticks);
  });

  it('is idempotent', () => {
    const input = '\x1b[31mColored\x1b[0m text';
    const first = stripAnsi(input);
    const second = stripAnsi(first);
    assert.equal(second, first);
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });

  it('strips mixed ANSI sequences', () => {
    const mixed = '\x1b[1;31m\x1b[4mBold red underline\x1b[0m';
    assert.equal(stripAnsi(mixed), 'Bold red underline');
  });

  it('strips orphaned ESC bytes', () => {
    const orphaned = 'Text\x1bMore\x1b';
    assert.equal(stripAnsi(orphaned), 'TextMore');
  });
});
