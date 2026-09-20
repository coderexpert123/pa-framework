/**
 * Suggest-chips tests (AI-234, 2026-09-14): the PWA renders quick-reply chips
 * under the answer card when the task carries suggested_items and the
 * conversation is non-terminal. A chip tap opens the text sheet pre-filled
 * with the chip label over the existing continue/steer path — no new submit
 * route, no new POST /tasks field.
 *
 * The PWA has no DOM harness in this suite; these are structural source-code
 * assertions (the sync-twins.test.ts idiom): they pin the rendering gate, the
 * CSS class, the click handler's openTextSheet call shape, and the prefill
 * support in openTextSheet — so a drift in any of those surfaces here.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function readAppJs(): string {
  return readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
}

describe('AI-234 suggest-chips: renderTurnContent chip row', () => {
  const src = readAppJs();

  it('renders a .suggest-chips row from parsed suggested items', () => {
    // 2026-09-15 fix: tasks.suggested_items is a TEXT column — the API
    // delivers the raw JSON string, so the old Array.isArray(task
    // .suggested_items) gate was false for every row and the chips never
    // rendered. The gate now runs on the PARSED labels.
    assert.ok(
      src.includes('suggestedItemLabels(task)'),
      'renderTurnContent must parse suggested_items via suggestedItemLabels(task)'
    );
    assert.ok(
      src.includes('suggestedLabels.length'),
      'the chip gate must check the parsed label count'
    );
    assert.ok(
      src.includes("'suggest-chips'"),
      'the chip container must use class "suggest-chips"'
    );
  });

  it('hides chips for terminal conversations (mirrors followUpRow gate)', () => {
    // The gate must include !isTerminal(conv.state) — a done/failed
    // conversation has nothing natural to follow with.
    assert.ok(
      src.includes('!isTerminal(conv.state)'),
      'chip rendering must be gated on !isTerminal(conv.state)'
    );
    // Verify the gate is in the chip block, not just elsewhere in the file.
    const chipBlock = src.match(
      /suggestedLabels\.length[\s\S]*?\)\)\)\);/
    );
    assert.ok(chipBlock, 'chip rendering block not found');
    assert.ok(
      chipBlock[0].includes('!isTerminal(conv.state)'),
      'the !isTerminal gate must be inside the chip rendering block'
    );
  });

  it('renders one .chip button per suggested item', () => {
    const chipBlock = src.match(
      /suggestedLabels\.length[\s\S]*?\)\)\)\);/
    );
    assert.ok(chipBlock);
    assert.ok(
      chipBlock[0].includes("'chip'"),
      'each chip must use class "chip"'
    );
    assert.ok(
      chipBlock[0].includes('suggestedLabels.map'),
      'chips must map over the parsed labels'
    );
  });

  it('chip click calls openTextSheet with prefill, continuesTaskId, and steer', () => {
    const chipBlock = src.match(
      /suggestedLabels\.length[\s\S]*?\)\)\)\);/
    );
    assert.ok(chipBlock);
    assert.ok(
      chipBlock[0].includes('openTextSheet'),
      'chip click must call openTextSheet'
    );
    assert.ok(
      chipBlock[0].includes('prefill:'),
      'chip click must pass prefill to openTextSheet'
    );
    assert.ok(
      chipBlock[0].includes('continuesTaskId:'),
      'chip click must pass continuesTaskId to openTextSheet'
    );
    assert.ok(
      chipBlock[0].includes('steer:'),
      'chip click must pass steer to openTextSheet'
    );
  });

  it('does not introduce a new submit route or POST /tasks field for chips', () => {
    const chipBlock = src.match(
      /suggestedLabels\.length[\s\S]*?\)\)\)\);/
    );
    assert.ok(chipBlock);
    assert.ok(
      !chipBlock[0].includes('createTask'),
      'chip click must not call createTask directly — it goes through openTextSheet'
    );
    assert.ok(
      !chipBlock[0].includes('POST'),
      'chip rendering must not introduce a new POST route'
    );
  });
});

describe('AI-234 suggest-chips: openTextSheet prefill support', () => {
  const src = readAppJs();

  it('openTextSheet reads opts.prefill and sets the textarea value', () => {
    assert.ok(
      src.includes('opts.prefill'),
      'openTextSheet must reference opts.prefill'
    );
    // The prefill must set textarea.value, not just append text.
    assert.ok(
      /if\s*\(\s*opts\.prefill\s*\)\s*textarea\.value\s*=\s*opts\.prefill/.test(src),
      'openTextSheet must set textarea.value = opts.prefill when prefill is provided'
    );
  });

  it('openTextSheet places the cursor at the end when pre-filled', () => {
    assert.ok(
      src.includes('setSelectionRange(textarea.value.length, textarea.value.length)'),
      'openTextSheet must place the cursor at the end of pre-filled text'
    );
  });
});

describe('AI-234 suggest-chips: CSS .suggest-chips styling', () => {
  it('styles.css defines .suggest-chips as a flex row', () => {
    const css = readFileSync(join(PKG_ROOT, 'public', 'styles.css'), 'utf8');
    assert.ok(
      css.includes('.suggest-chips'),
      'styles.css must define .suggest-chips'
    );
    // Verify it's a flex container (the chip row layout).
    const match = /\.suggest-chips\s*\{([^}]*)\}/.exec(css);
    assert.ok(match, '.suggest-chips rule not found in styles.css');
    assert.ok(
      match[1].includes('display: flex'),
      '.suggest-chips must be display: flex'
    );
  });
});
