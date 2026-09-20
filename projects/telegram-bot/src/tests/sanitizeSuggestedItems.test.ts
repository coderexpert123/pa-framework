/**
 * AI-234 — sanitizeSuggestedItems unit tests (SPEC §7a).
 * Fail-OPEN: drops non-plain chips, keeps survivors, warn-logs drops.
 * Caps: SUGGESTED_ITEM_MAX=4, SUGGESTED_ITEM_LABEL_MAX=40.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSuggestedItems,
  SUGGESTED_ITEM_MAX,
  SUGGESTED_ITEM_LABEL_MAX,
} from '../logic.js';

describe('sanitizeSuggestedItems — caps', () => {
  it('SUGGESTED_ITEM_MAX is 4', () => {
    assert.equal(SUGGESTED_ITEM_MAX, 4);
  });
  it('SUGGESTED_ITEM_LABEL_MAX is 40', () => {
    assert.equal(SUGGESTED_ITEM_LABEL_MAX, 40);
  });
});

describe('sanitizeSuggestedItems — empty / missing', () => {
  it('undefined → []', () => {
    assert.deepEqual(sanitizeSuggestedItems(undefined), []);
  });
  it('null → []', () => {
    assert.deepEqual(sanitizeSuggestedItems(null), []);
  });
  it('non-array → []', () => {
    assert.deepEqual(sanitizeSuggestedItems('hello'), []);
    assert.deepEqual(sanitizeSuggestedItems(42), []);
    assert.deepEqual(sanitizeSuggestedItems({ a: 1 }), []);
  });
  it('empty array → []', () => {
    assert.deepEqual(sanitizeSuggestedItems([]), []);
  });
});

describe('sanitizeSuggestedItems — keeps plain prose', () => {
  it('single plain chip', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Tell me more']), ['Tell me more']);
  });
  it('multiple plain chips', () => {
    assert.deepEqual(
      sanitizeSuggestedItems(['Yes', 'No', 'Maybe', 'Tell me more']),
      ['Yes', 'No', 'Maybe', 'Tell me more'],
    );
  });
  it('trims whitespace', () => {
    assert.deepEqual(sanitizeSuggestedItems(['  Hello  ']), ['Hello']);
  });
  it('plain prose with periods (sentence-final) survives', () => {
    // A trailing period is plain prose, not a file extension.
    assert.deepEqual(sanitizeSuggestedItems(['That looks good.']), ['That looks good.']);
  });
  it('plain prose with commas survives', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Yes, please go ahead']), ['Yes, please go ahead']);
  });
  it('plain prose with apostrophes survives', () => {
    assert.deepEqual(sanitizeSuggestedItems(["Don't do that"]), ["Don't do that"]);
  });
  it('plain prose with question marks survives', () => {
    assert.deepEqual(sanitizeSuggestedItems(['What about the other option?']), ['What about the other option?']);
  });
});

describe('sanitizeSuggestedItems — drops code symbols (fail-open)', () => {
  it('drops backticks', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Use `npm install`', 'Tell me more']), ['Tell me more']);
  });
  it('drops braces', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Set {key: value}', 'Yes']), ['Yes']);
  });
  it('drops brackets', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Array [1, 2, 3]', 'No']), ['No']);
  });
  it('drops angle brackets', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Use <div>', 'Maybe']), ['Maybe']);
  });
  it('drops equals sign', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Set x=1', 'Go ahead']), ['Go ahead']);
  });
  it('drops pipe', () => {
    assert.deepEqual(sanitizeSuggestedItems(['a | b', 'Try again']), ['Try again']);
  });
  it('drops double slash (//)', () => {
    assert.deepEqual(sanitizeSuggestedItems(['path // comment', 'Yes']), ['Yes']);
  });
  it('drops backslash', () => {
    assert.deepEqual(sanitizeSuggestedItems(['C:\\tools\\file', 'No']), ['No']);
  });
  it('drops file extensions (dot + word chars at word boundary)', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Open file.txt', 'Yes']), ['Yes']);
    assert.deepEqual(sanitizeSuggestedItems(['Run script.py', 'No']), ['No']);
    assert.deepEqual(sanitizeSuggestedItems(['See config.json', 'Maybe']), ['Maybe']);
  });
  it('drops http', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Visit https://example.com', 'Yes']), ['Yes']);
    assert.deepEqual(sanitizeSuggestedItems(['See http://foo.com', 'No']), ['No']);
  });
  it('drops 0x hex runs', () => {
    assert.deepEqual(sanitizeSuggestedItems(['Value 0xDEADBEEF', 'Yes']), ['Yes']);
    assert.deepEqual(sanitizeSuggestedItems(['0x1a2b', 'No']), ['No']);
  });
});

describe('sanitizeSuggestedItems — caps at 4', () => {
  it('keeps only 4 when more are given', () => {
    const result = sanitizeSuggestedItems(['One', 'Two', 'Three', 'Four', 'Five', 'Six']);
    assert.equal(result.length, 4);
    assert.deepEqual(result, ['One', 'Two', 'Three', 'Four']);
  });
});

describe('sanitizeSuggestedItems — caps at 40 chars', () => {
  it('drops chips longer than 40 chars', () => {
    const long = 'A'.repeat(41);
    assert.deepEqual(sanitizeSuggestedItems([long, 'Short']), ['Short']);
  });
  it('keeps chips exactly 40 chars', () => {
    const exact = 'A'.repeat(40);
    assert.deepEqual(sanitizeSuggestedItems([exact]), [exact]);
  });
  it('drops empty strings after trim', () => {
    assert.deepEqual(sanitizeSuggestedItems(['   ', 'Real']), ['Real']);
  });
  it('drops non-string entries', () => {
    assert.deepEqual(sanitizeSuggestedItems([42, null, 'Real', undefined, true]), ['Real']);
  });
});

describe('sanitizeSuggestedItems — all dropped → [] (no throw)', () => {
  it('all non-plain → []', () => {
    assert.deepEqual(sanitizeSuggestedItems(['`code`', '{json}', '[arr]']), []);
  });
  it('all over-cap → []', () => {
    assert.deepEqual(sanitizeSuggestedItems([`${'X'.repeat(41)}`, `${'Y'.repeat(50)}`]), []);
  });
  it('mixed drops and survivors keeps survivors in order', () => {
    assert.deepEqual(
      sanitizeSuggestedItems(['`bad`', 'Good one', '0xdead', 'Also good']),
      ['Good one', 'Also good'],
    );
  });
});
