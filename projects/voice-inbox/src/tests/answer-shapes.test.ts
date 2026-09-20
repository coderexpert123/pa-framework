/**
 * Answer shape layer tests (2026-09-11, vi-35a4487d5c04): public/
 * answer-shapes.js is a DOM-free classic script evaluated with the DOM
 * globals shadowed to undefined; the corpus below is pinned verbatim from the
 * real ledger answers (Strava vi-f150dc700e5b, Swiggy prose vi-682a17c7e13)
 * plus the time/range anti-regression strings. The enumerator regex is pinned
 * as an exact string because scripts/migrate_answer_format.py mirrors it and
 * app.js carries the untouched original — three copies, one rule.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

// --- verbatim ledger corpus ------------------------------------------------

const STRAVA_LABEL = 'Strava Title:\nHills + Strides 7K';
const STRAVA_MAIN = 'Main\n- 25m 163-189w\n- 4x (20s 221-252w / 100s 142-163w)';
const STRAVA_WARMUP = 'Warmup\n- 10m 142-163w';

const SWIGGY_INTRO =
  'The underlying reason Swiggy blocks automated sessions is not the language model being used, ' +
  'but the networking and security perimeter of the website itself:';
const SWIGGY_NUMBERED_LIST =
  '1) The language model never sees your session cookies.\n' +
  '2) The website fingerprints the browser and blocks automated logins.';
const SWIGGY_SAME_PARA = SWIGGY_INTRO + '\n' + SWIGGY_NUMBERED_LIST;
const SINGLE_MID_PROSE = 'There are three reasons: 1) cookies, 2) fingerprints, 3) automation.';
const SINGLE_NUMBERED_ALONE = '1) Only one item here.';

const TIME_SAFE_A = 'about 13 km';
const TIME_SAFE_B = '6:30-7:30 PM';
const TIME_SAFE_FULL = 'The walk is about 13 km, meet 6:30-7:30 PM.';

const CODE_FENCE_FULL = 'Here is the script:\n```python\nprint(1)\n\nprint(2)\n```\nRun it twice.';
const TABLE_WITH_HEADER = '| Day | Km |\n|---|---|\n| Mon | 6.3 |';
const TABLE_HEADERLESS = '| A | B |\n| 1 | 2 |';

// Phrase-style numbered list, no trailing periods (vi-4b9ccc9da3c6): the
// enumerator rule alone only recognizes item 2+ when the prior item ends in
// [.!?:], so this fell through to prose before answerLineDigitSplit existed.
const SHORT_NUMBERED_LIST = '1. Buy milk\n2. Walk the dog\n3. Call mom';
const LED_NUMBERED_LIST = 'Next steps\n1. Buy milk\n2. Walk the dog';

// Bold-label lead line above a dash list, items ending in sentence
// punctuation (t-311/D2, filed 2026-09-14 while fixing vi-296bede58299): the
// label's closing `**` never matches the enumerator lookbehind, but each
// dash item ends in `.` — so the OLD enumerator-first order found marks
// starting at item 2 only, folding the label and item 1 into `lead` (with a
// literal `- ` left inside it) and reporting just 2 items instead of 3.
const BOLD_LABEL_DASH_LIST =
  '**What is repaired now.**\n- item one.\n- item two.\n- item three.';

// --- tier estimation fixtures (vi-ffb0a6d3cb44) ------------------------------

const QUEUE_ONE_LINER =
  'It pages at **5,000 pending messages**. During the incident the retry loop ' +
  'kept the queue between 3,000 and 4,500, so it never fired.';

const TIER_BOUNDARY_NOT_TIERED = 'Fix plan\n' + Array.from({ length: 14 }, (_, i) => `- Step ${i + 1}`).join('\n');
const TIER_ONE_OVER = 'Fix plan\n' + Array.from({ length: 15 }, (_, i) => `- Step ${i + 1}`).join('\n');

const CODE_ESTIMATE = 'Run this:\n\n```bash\ncurl -X POST https://example.com/book\n```\n\nDone.';

const LEAD_STUMP =
  'Analysis complete. I investigated the failing deploy pipeline for the ' +
  'payments service by first reproducing the failure locally with a pinned checkout.';
const LEAD_MERGE =
  'The deploy did not fail from bad code this time. A rotated webhook secret ' +
  'never reached the running service. Redeploy now.';
const LEAD_UNTERMINATED = 'word '.repeat(52).trim();
const LEAD_MARKERS = '**Bold start.** Then `code` and *emphasis* here.';

// --- loader -----------------------------------------------------------------

function loadShapes(): Record<string, any> {
  const src = readFileSync(join(PKG_ROOT, 'public', 'answer-shapes.js'), 'utf8');
  // Shadow the DOM globals to undefined: the layer must run with none of them.
  const factory = new Function(
    'document', 'window', 'localStorage',
    src + '\n; return { splitAnswerBlocks, classifyBlock, looksStructured, shapeFingerprint, stripAnswerMarkers, answerWordCount, estimateAnswerLines, answerLead, answerTier, rawHtmlFrameDocument, rawHtmlFrameSrc, RAW_FRAME_CSP, RAW_FRAME_BASE_CSS, RAW_HTML_ESTIMATE_LINES, RAW_ROUTE_MAX_ENCODED };'
  );
  return factory(undefined, undefined, undefined);
}

const shapes = loadShapes();

// --- DOM-free + twin pins ---------------------------------------------------

describe('answer-shapes: purity and pinned regex', () => {
  it('contains no DOM, window or storage references', () => {
    const src = readFileSync(join(PKG_ROOT, 'public', 'answer-shapes.js'), 'utf8');
    for (const banned of ['document.', 'window.', 'localStorage']) {
      assert.ok(!src.includes(banned), `answer-shapes.js must not contain "${banned}"`);
    }
  });

  it('carries the app.js findEnumerators regex byte-exactly', () => {
    const src = readFileSync(join(PKG_ROOT, 'public', 'answer-shapes.js'), 'utf8');
    assert.ok(
      src.includes('(?:^|(?<=[.!?:]\\s))(?:(\\d{1,3})[.)]|[-•*])\\s+'),
      'the enumerator regex copy drifted from app.js findEnumerators'
    );
  });

  it('exposes exactly the four consumed globals as functions', () => {
    for (const name of ['splitAnswerBlocks', 'classifyBlock', 'looksStructured', 'shapeFingerprint']) {
      assert.equal(typeof shapes[name], 'function', `${name} must be a function`);
    }
  });
});

// --- splitAnswerBlocks -------------------------------------------------------

describe('splitAnswerBlocks', () => {
  it('empty input yields no blocks', () => {
    assert.deepEqual(shapes.splitAnswerBlocks(''), []);
  });

  it('extracts a fenced run with language, spanning a blank line, prose around it', () => {
    assert.deepEqual(shapes.splitAnswerBlocks(CODE_FENCE_FULL), [
      { kind: 'text', text: 'Here is the script:' },
      { kind: 'code', lang: 'python', code: 'print(1)\n\nprint(2)' },
      { kind: 'text', text: 'Run it twice.' },
    ]);
  });

  it('an unterminated fence takes the rest of the text as code', () => {
    assert.deepEqual(shapes.splitAnswerBlocks('before\n```\ncode line'), [
      { kind: 'text', text: 'before' },
      { kind: 'code', lang: '', code: 'code line' },
    ]);
  });

  it('a mid-line triple backtick is inline text, not a fence', () => {
    assert.deepEqual(shapes.splitAnswerBlocks('use ```x``` inline'), [
      { kind: 'text', text: 'use ```x``` inline' },
    ]);
  });

  it('CRLF normalizes to LF before any line logic', () => {
    assert.deepEqual(shapes.splitAnswerBlocks('a\r\n\r\nb'), [
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
    const blocks = shapes.splitAnswerBlocks(STRAVA_WARMUP.replace('\n', '\r\n'));
    assert.equal(blocks.length, 1);
    assert.equal(shapes.classifyBlock(blocks[0].text).kind, 'list');
  });

  it('a table stays one text block for classifyBlock', () => {
    const blocks = shapes.splitAnswerBlocks(TABLE_WITH_HEADER);
    assert.deepEqual(blocks, [{ kind: 'text', text: TABLE_WITH_HEADER }]);
  });
});

// --- classifyBlock -----------------------------------------------------------

describe('classifyBlock: real corpus', () => {
  it('Strava label paragraph -> label-value', () => {
    assert.deepEqual(shapes.classifyBlock(STRAVA_LABEL), {
      kind: 'label-value', label: 'Strava Title:', body: 'Hills + Strides 7K',
    });
  });

  it('Strava Main two-dash block -> unordered list with lead', () => {
    assert.deepEqual(shapes.classifyBlock(STRAVA_MAIN), {
      kind: 'list', lead: 'Main',
      items: ['25m 163-189w', '4x (20s 221-252w / 100s 142-163w)'],
      ordered: false,
    });
  });

  it('Strava Warmup introduced single bullet -> unordered list', () => {
    assert.deepEqual(shapes.classifyBlock(STRAVA_WARMUP), {
      kind: 'list', lead: 'Warmup', items: ['10m 142-163w'], ordered: false,
    });
  });

  it('Swiggy intro+numbered list in one paragraph -> label-value whose body is an ordered list', () => {
    const shape = shapes.classifyBlock(SWIGGY_SAME_PARA);
    assert.equal(shape.kind, 'label-value');
    assert.equal(shape.label, SWIGGY_INTRO);
    const body = shapes.classifyBlock(shape.body);
    assert.equal(body.kind, 'list');
    assert.equal(body.ordered, true);
    assert.equal(body.items.length, 2);
  });

  it('the numbered list alone keeps classifying as an ordered list', () => {
    const shape = shapes.classifyBlock(SWIGGY_NUMBERED_LIST);
    assert.equal(shape.kind, 'list');
    assert.equal(shape.ordered, true);
    assert.equal(shape.items.length, 2);
  });

  it('the intro sentence alone is prose (label-value needs >=2 lines)', () => {
    assert.equal(shapes.classifyBlock(SWIGGY_INTRO).kind, 'prose');
  });
});

describe('classifyBlock: anti-regression', () => {
  it('a single mid-prose "1)" run never becomes a list', () => {
    assert.equal(shapes.classifyBlock(SINGLE_MID_PROSE).kind, 'prose');
  });

  it('a single numbered item alone never promotes (line-start rule is dash-only)', () => {
    assert.equal(shapes.classifyBlock(SINGLE_NUMBERED_ALONE).kind, 'prose');
  });

  it('times and distances never produce list marks', () => {
    assert.equal(shapes.classifyBlock(TIME_SAFE_A).kind, 'prose');
    assert.equal(shapes.classifyBlock(TIME_SAFE_B).kind, 'prose');
    const blocks = shapes.splitAnswerBlocks(TIME_SAFE_FULL);
    assert.equal(blocks.length, 1);
    assert.equal(shapes.classifyBlock(blocks[0].text).kind, 'prose');
  });

  it('a bold lead is not a bullet', () => {
    assert.equal(shapes.classifyBlock('**bold** text stays prose').kind, 'prose');
  });

  it('a dash glued to a number is not an item', () => {
    assert.equal(shapes.classifyBlock('Temperature was -5 degrees today').kind, 'prose');
  });

  it('a heading line is never a label even when it ends with a colon', () => {
    assert.deepEqual(shapes.classifyBlock('## Summary:\nbody text'), {
      kind: 'heading', text: 'Summary:', rest: 'body text',
    });
  });
});

describe('classifyBlock: line-start numbered lists (vi-4b9ccc9da3c6)', () => {
  it('a phrase-style numbered list with no trailing periods still promotes', () => {
    assert.deepEqual(shapes.classifyBlock(SHORT_NUMBERED_LIST), {
      kind: 'list', lead: '', items: ['Buy milk', 'Walk the dog', 'Call mom'], ordered: true,
    });
  });

  it('a lead line before a phrase-style numbered list is kept as the lead', () => {
    assert.deepEqual(shapes.classifyBlock(LED_NUMBERED_LIST), {
      kind: 'list', lead: 'Next steps', items: ['Buy milk', 'Walk the dog'], ordered: true,
    });
  });

  it('a single numbered item alone still never promotes (>=2 marks required)', () => {
    assert.equal(shapes.classifyBlock(SINGLE_NUMBERED_ALONE).kind, 'prose');
  });

  it('mid-line digit marks (not at column 0) never promote', () => {
    assert.equal(shapes.classifyBlock(SINGLE_MID_PROSE).kind, 'prose');
  });
});

describe('classifyBlock: bold-label lead above a dash list (t-311/D2)', () => {
  it('keeps the full label as lead and never folds item 1 into it', () => {
    assert.deepEqual(shapes.classifyBlock(BOLD_LABEL_DASH_LIST), {
      kind: 'list',
      lead: '**What is repaired now.**',
      items: ['item one.', 'item two.', 'item three.'],
      ordered: false,
    });
  });
});

describe('classifyBlock: tables and headings', () => {
  it('table with a separator row -> header + data rows', () => {
    assert.deepEqual(shapes.classifyBlock(TABLE_WITH_HEADER), {
      kind: 'table', header: ['Day', 'Km'], rows: [['Mon', '6.3']],
    });
  });

  it('headerless two-row table -> no header, both rows are data', () => {
    assert.deepEqual(shapes.classifyBlock(TABLE_HEADERLESS), {
      kind: 'table', header: null, rows: [['A', 'B'], ['1', '2']],
    });
  });

  it('heading with a rest line splits text and rest', () => {
    assert.deepEqual(shapes.classifyBlock('## Summary\nBody text here.'), {
      kind: 'heading', text: 'Summary', rest: 'Body text here.',
    });
  });

  it('empty paragraph classifies as prose', () => {
    assert.equal(shapes.classifyBlock('').kind, 'prose');
  });
});

// --- looksStructured ---------------------------------------------------------

describe('looksStructured (the registration trigger)', () => {
  it('two colon-ending lines are structured', () => {
    assert.equal(shapes.looksStructured('A:\nB:'), true);
  });

  it('one line is never structured', () => {
    assert.equal(shapes.looksStructured('A:'), false);
    assert.equal(shapes.looksStructured(''), false);
  });

  it('a >=30% line-start item run in a prose block is structured (star bullets stay prose today)', () => {
    assert.equal(shapes.looksStructured('plain one\n* a\n* b'), true);
  });

  it('pipe-heavy prose is structured', () => {
    assert.equal(shapes.looksStructured('x | y | z | w\na | b | c | d'), true);
  });

  it('consistent indentation is structured', () => {
    assert.equal(shapes.looksStructured('  indented line\n  another one'), true);
  });

  it('ordinary two-line prose is not structured', () => {
    assert.equal(shapes.looksStructured('hello there\nsecond line'), false);
  });
});

// --- shapeFingerprint --------------------------------------------------------

describe('shapeFingerprint', () => {
  it('same shape, different words -> equal fingerprints', () => {
    const a = shapes.shapeFingerprint('A:\nsome words here\n- item one');
    const b = shapes.shapeFingerprint('B:\nother words go\n- item two');
    assert.equal(a, b);
    assert.equal(a, 'L1|P1|I1');
  });

  it('different shapes -> different fingerprints', () => {
    assert.notEqual(shapes.shapeFingerprint('plain words'), shapes.shapeFingerprint('Title:\nbody'));
  });

  it('run-length collapses repeats and is pipe-joined', () => {
    assert.equal(shapes.shapeFingerprint('x\ny\nz'), 'P3');
    assert.equal(shapes.shapeFingerprint('| a | b |\n| c | d |'), 'T2');
  });

  it('empty paragraph has an empty fingerprint', () => {
    assert.equal(shapes.shapeFingerprint(''), '');
  });
});

// --- stripAnswerMarkers ------------------------------------------------------

describe('stripAnswerMarkers', () => {
  it('unwraps bold, code and word-bounded emphasis', () => {
    assert.equal(shapes.stripAnswerMarkers('**bold** stays'), 'bold stays');
    assert.equal(shapes.stripAnswerMarkers('run `npm install` now'), 'run npm install now');
    assert.equal(shapes.stripAnswerMarkers('*em* and _em_'), 'em and em');
  });

  it('unwraps markdown links to their text', () => {
    assert.equal(shapes.stripAnswerMarkers('See [the guide](https://example.com/guide) now'), 'See the guide now');
    assert.equal(shapes.stripAnswerMarkers('[A](https://a.example) and [B](https://b.example)'), 'A and B');
    assert.equal(shapes.stripAnswerMarkers('empty [x]() parens still unwrap'), 'empty x parens still unwrap');
  });

  it('answerLead over a markdown link shows the link text, never the url', () => {
    assert.equal(
      shapes.answerLead('[Full itinerary](https://example.com/itinerary) covering both days is ready. Second sentence.'),
      'Full itinerary covering both days is ready. Second sentence.'
    );
  });

  it('drops stray ** and leaves unbalanced single markers literal', () => {
    assert.equal(shapes.stripAnswerMarkers('**stray** then ** strays'), 'stray then strays');
    assert.equal(shapes.stripAnswerMarkers('a * b * c stays literal'), 'a * b * c stays literal');
  });

  it('removes heading marks on any line and collapses whitespace', () => {
    assert.equal(shapes.stripAnswerMarkers('## Summary\nBody text'), 'Summary Body text');
    assert.equal(shapes.stripAnswerMarkers('Intro\n## Details\nMore'), 'Intro Details More');
    assert.equal(shapes.stripAnswerMarkers('a\n\nb\r\n\nc'), 'a b c');
  });

  it('removes line-start bullet markers (dash, dot, star) — the TIER_ONE_OVER lead depends on it', () => {
    assert.equal(shapes.stripAnswerMarkers('Fix plan\n- Step 1\n- Step 2'), 'Fix plan Step 1 Step 2');
    assert.equal(shapes.stripAnswerMarkers('• one\n• two'), 'one two');
    assert.equal(shapes.stripAnswerMarkers('* star bullet'), 'star bullet');
    assert.equal(shapes.stripAnswerMarkers('Temperature was -5 degrees'), 'Temperature was -5 degrees');
  });

  it('empty input stays empty', () => {
    assert.equal(shapes.stripAnswerMarkers(''), '');
    assert.equal(shapes.stripAnswerMarkers(null), '');
  });
});

// --- answerWordCount ---------------------------------------------------------

describe('answerWordCount', () => {
  it('counts whitespace-split words; empty input is 0', () => {
    assert.equal(shapes.answerWordCount(''), 0);
    assert.equal(shapes.answerWordCount('   \n  '), 0);
    assert.equal(shapes.answerWordCount('one two  three\nfour'), 4);
  });

  it('the queue one-liner has 23 words', () => {
    assert.equal(shapes.answerWordCount(QUEUE_ONE_LINER), 23);
  });

  it('the one-over boundary fixture has 47 words', () => {
    assert.equal(shapes.answerWordCount(TIER_ONE_OVER), 47);
  });
});

// --- estimateAnswerLines -------------------------------------------------------

describe('estimateAnswerLines', () => {
  it('queue one-liner: one prose paragraph of 129 stripped chars -> ceil(129/46) = 3', () => {
    assert.equal(shapes.estimateAnswerLines(QUEUE_ONE_LINER), 3);
  });

  it('code block counts raw lines; surrounding prose counts wrapped lines -> 3', () => {
    assert.equal(shapes.estimateAnswerLines(CODE_ESTIMATE), 3);
  });

  it('tables count header?1:0 + data rows', () => {
    assert.equal(shapes.estimateAnswerLines(TABLE_WITH_HEADER), 2);
    assert.equal(shapes.estimateAnswerLines(TABLE_HEADERLESS), 2);
  });

  it('lists count lead + one line per item', () => {
    assert.equal(shapes.estimateAnswerLines(LED_NUMBERED_LIST), 3);
  });

  it('boundary fixtures: lead + 14 items = 15; lead + 15 items = 16', () => {
    assert.equal(shapes.estimateAnswerLines(TIER_BOUNDARY_NOT_TIERED), 15);
    assert.equal(shapes.estimateAnswerLines(TIER_ONE_OVER), 16);
  });
});

// --- answerLead ----------------------------------------------------------------

describe('answerLead', () => {
  it('skips a stump opener (<40 chars) and stops at >=110 chars', () => {
    assert.equal(shapes.answerLead(LEAD_STUMP),
      'I investigated the failing deploy pipeline for the payments service by first reproducing the failure locally with a pinned checkout.');
  });

  it('merges sentences while lead <110 chars and total <=240', () => {
    assert.equal(shapes.answerLead(LEAD_MERGE),
      'The deploy did not fail from bad code this time. A rotated webhook secret never reached the running service. Redeploy now.');
  });

  it('an unterminated fragment is taken WHOLE — no cut, no ellipsis', () => {
    assert.equal(shapes.answerLead(LEAD_UNTERMINATED), LEAD_UNTERMINATED);
  });

  it('markers are stripped before the fragment walk', () => {
    assert.equal(shapes.answerLead(LEAD_MARKERS), 'Then code and emphasis here.');
  });

  it('empty input yields an empty lead', () => {
    assert.equal(shapes.answerLead(''), '');
  });

  it('a first sentence longer than 160 chars splits at its true end and is taken whole (no ellipsis)', () => {
    const longFirst = ('word ' + 'x'.repeat(200)).trim() + '. Second sentence here.';
    // "word xxxxx...xxx." is 206 chars; terminator beyond the old 160 window.
    assert.equal(shapes.answerLead(longFirst), longFirst.slice(0, longFirst.indexOf('. ') + 1));
    assert.ok(!shapes.answerLead(longFirst).includes('…'));
  });

  it('no fixture lead ever ends with a trimming ellipsis', () => {
    for (const fx of [LEAD_STUMP, LEAD_MERGE, LEAD_UNTERMINATED, LEAD_MARKERS]) {
      assert.ok(!shapes.answerLead(fx).endsWith('…'));
    }
  });
});

// --- answerTier ----------------------------------------------------------------

describe('answerTier', () => {
  it('empty input never tiers', () => {
    assert.deepEqual(shapes.answerTier(''), { tiered: false, lead: '', words: 0 });
  });

  it('3 estimated lines is not tiered; lead/words stay unpopulated', () => {
    assert.deepEqual(shapes.answerTier(QUEUE_ONE_LINER), { tiered: false, lead: '', words: 0 });
  });

  it('exactly at the threshold (15) is not tiered', () => {
    assert.deepEqual(shapes.answerTier(TIER_BOUNDARY_NOT_TIERED), { tiered: false, lead: '', words: 0 });
  });

  it('one line over the threshold (16) tiers, with lead and words populated', () => {
    assert.deepEqual(shapes.answerTier(TIER_ONE_OVER), {
      tiered: true,
      lead: 'Fix plan Step 1 Step 2 Step 3 Step 4 Step 5 Step 6 Step 7 Step 8 Step 9 Step 10 Step 11 Step 12 Step 13 Step 14 Step 15',
      words: 47,
    });
  });
});

// --- raw-html lane (2026-09-14, the free-form lane) ---------------------------

const RAW_HTML_ONE = 'Before the chart\n:::raw-html\n<p class="price">Hi</p>\n:::\nafter all';
const RAW_HTML_UNTERMINATED = 'lead\n:::raw-html\n<p>never closed';
const RAW_HTML_TWICE =
  ':::raw-html\n<p>one</p>\n:::\nmiddle\n\n:::raw-html\n<table class="matrix"><tr><td>2</td></tr></table>\n:::';

describe('splitAnswerBlocks: :::raw-html fences', () => {
  it('extracts a raw-html run, prose around it renders as text blocks', () => {
    assert.deepEqual(shapes.splitAnswerBlocks(RAW_HTML_ONE), [
      { kind: 'text', text: 'Before the chart' },
      { kind: 'raw-html', html: '<p class="price">Hi</p>' },
      { kind: 'text', text: 'after all' },
    ]);
  });

  it('a second marker renders a second frame block', () => {
    const blocks = shapes.splitAnswerBlocks(RAW_HTML_TWICE);
    assert.deepEqual(blocks, [
      { kind: 'raw-html', html: '<p>one</p>' },
      { kind: 'text', text: 'middle' },
      { kind: 'raw-html', html: '<table class="matrix"><tr><td>2</td></tr></table>' },
    ]);
  });

  it('non-marker content is untouched — ::: alone and :::raw-html+suffix stay text', () => {
    assert.deepEqual(shapes.splitAnswerBlocks('a\n:::\nb'), [{ kind: 'text', text: 'a\n:::\nb' }]);
    assert.deepEqual(shapes.splitAnswerBlocks(':::raw-htmlx'), [{ kind: 'text', text: ':::raw-htmlx' }]);
    assert.deepEqual(shapes.splitAnswerBlocks('plain prose only'), [{ kind: 'text', text: 'plain prose only' }]);
  });

  it('the html body is kept verbatim, including fenced backtick lines', () => {
    const blocks = shapes.splitAnswerBlocks(':::raw-html\n<p>a</p>\n```\ncode\n```\n:::\ntail');
    assert.deepEqual(blocks, [
      { kind: 'raw-html', html: '<p>a</p>\n```\ncode\n```' },
      { kind: 'text', text: 'tail' },
    ]);
  });

  it('an unterminated raw-html fence takes the rest of the text as html', () => {
    assert.deepEqual(shapes.splitAnswerBlocks(RAW_HTML_UNTERMINATED), [
      { kind: 'text', text: 'lead' },
      { kind: 'raw-html', html: '<p>never closed' },
    ]);
  });

  it('CRLF normalizes before raw-html line logic too', () => {
    const blocks = shapes.splitAnswerBlocks(':::raw-html\r\n<b>x</b>\r\n:::\r\ntail');
    assert.deepEqual(blocks, [
      { kind: 'raw-html', html: '<b>x</b>' },
      { kind: 'text', text: 'tail' },
    ]);
  });
});

describe('rawHtmlFrameDocument (the route payload and over-cap srcdoc fallback)', () => {
  it('carries the frame CSP meta: inline style/script only, zero network', () => {
    const doc = shapes.rawHtmlFrameDocument('<p>x</p>');
    assert.ok(doc.includes('http-equiv="Content-Security-Policy"'));
    assert.ok(doc.includes(shapes.RAW_FRAME_CSP));
    assert.equal(shapes.RAW_FRAME_CSP, "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    // Offline guarantee: no external reference of any kind is emitted.
    assert.ok(!/https?:\/\//.test(doc));
  });

  it('wraps the model html VERBATIM (never escaped) after the base style', () => {
    const html = '<div class="w"><script>1</script></div>';
    const doc = shapes.rawHtmlFrameDocument(html);
    assert.ok(doc.endsWith('</body></html>'));
    assert.ok(doc.includes('<body>' + html + '</body>'));
  });

  it('the base style is dark-mode aware: color-scheme + transparent background', () => {
    assert.ok(shapes.RAW_FRAME_BASE_CSS.includes('color-scheme:light dark'));
    assert.ok(shapes.RAW_FRAME_BASE_CSS.includes('background:transparent'));
  });
});

describe('rawHtmlFrameSrc (the /frames/raw route payload)', () => {
  const D_PREFIX = '/frames/raw?d=';

  it('builds a route src whose d decodes back to the full frame document', () => {
    const src = shapes.rawHtmlFrameSrc('<p class="price">Hi</p>');
    assert.ok(typeof src === 'string' && src.startsWith(D_PREFIX));
    const encoded = src.slice(D_PREFIX.length);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(encoded), 'd must be URL-safe base64url, unpadded');
    const doc = Buffer.from(encoded, 'base64url').toString('utf8');
    assert.equal(doc, shapes.rawHtmlFrameDocument('<p class="price">Hi</p>'),
      'the payload is the frame document verbatim');
    assert.ok(doc.includes('<p class="price">Hi</p>'));
  });

  it('encodes utf8 safely — non-ascii round-trips', () => {
    const src = shapes.rawHtmlFrameSrc('<p>π · ✓</p>');
    const doc = Buffer.from(String(src).slice(D_PREFIX.length), 'base64url').toString('utf8');
    assert.ok(doc.includes('<p>π · ✓</p>'));
  });

  it('returns null over the encoded budget — the inert srcdoc fallback takes over', () => {
    assert.equal(shapes.rawHtmlFrameSrc('a'.repeat(20000)), null);
    assert.ok(shapes.rawHtmlFrameSrc('a'.repeat(8000)),
      'a clearly-in-budget document must still take the route');
    assert.ok(shapes.RAW_ROUTE_MAX_ENCODED > 0);
  });
});

describe('raw-html tier accounting and lead stripping', () => {
  it('one frame counts as its fixed line estimate and does NOT tier alone', () => {
    assert.equal(shapes.RAW_HTML_ESTIMATE_LINES, 12);
    assert.equal(shapes.estimateAnswerLines(':::raw-html\n<p>x</p>\n:::'), 12);
    assert.deepEqual(shapes.answerTier(':::raw-html\n<p>x</p>\n:::'), { tiered: false, lead: '', words: 0 });
  });

  it('two frames tier', () => {
    assert.ok(shapes.answerTier(RAW_HTML_TWICE).tiered);
  });

  it('stripAnswerMarkers drops a raw-html fence whole — the lead never carries frame html', () => {
    assert.equal(shapes.stripAnswerMarkers('Before\n:::raw-html\n<p>Big</p>\n:::\nafter'), 'Before after');
    assert.equal(shapes.stripAnswerMarkers(RAW_HTML_UNTERMINATED), 'lead');
    assert.equal(shapes.stripAnswerMarkers('only\n:::raw-html\n<b>x</b>\n:::'), 'only');
  });
});

describe('renderRawHtmlBlock (app.js) builds the sandboxed frame element', () => {
  // The app page has no DOM harness in this suite (no jsdom dependency), so
  // this executes the REAL function source, sliced out of public/app.js,
  // against a minimal createElement/setAttribute recorder — the same
  // setAttribute contract app.js's h() helper implements.
  function buildFrames(html: string): any[] {
    const appSrc = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
    const start = appSrc.indexOf('function renderRawHtmlBlock');
    assert.ok(start !== -1, 'renderRawHtmlBlock not found in public/app.js');
    const end = appSrc.indexOf('\n}', start);
    assert.ok(end !== -1, 'renderRawHtmlBlock closing brace not found');
    const slice = appSrc.slice(start, end + 2);
    assert.ok(slice.includes('sandbox'), 'slice extraction grabbed the wrong region');
    assert.ok(slice.includes('rawHtmlFrameSrc'), 'slice must cover the route-src branch');
    const made: any[] = [];
    // A FRESH recorder per element — the fallback path pushes two nodes, and
    // a shared recorder would let the second h() call overwrite the first's
    // recorded attrs (both entries would read as the last element).
    const makeRecorder = () => ({
      attrs: {} as Record<string, string>,
      className: '',
      children: [] as any[],
      setAttribute(k: string, v: string) { this.attrs[k] = String(v); },
    });
    const h = (_tag: string, attrs: Record<string, any>, ...children: any[]) => {
      const el: any = makeRecorder();
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v as string;
        else el.setAttribute(k, v as string);
      }
      el.children = children;
      made.push(el);
      return el;
    };
    const fn = new Function('h', 'document', 'rawHtmlFrameDocument', 'rawHtmlFrameSrc', 'getToken',
      slice + '\n; return renderRawHtmlBlock;');
    const render = fn(h, { createElement: () => makeRecorder() }, shapes.rawHtmlFrameDocument,
      shapes.rawHtmlFrameSrc, () => 'sess-token-123');
    const nodes: any[] = [];
    render({ html }, nodes, 0);
    assert.ok(made.length >= 1, 'renderRawHtmlBlock must push at least the frame');
    return made;
  }

  it('routes in-budget html: sandbox=allow-scripts WITHOUT allow-same-origin, src=/frames/raw, size, title', () => {
    const made = buildFrames('<p class="price">Hi</p>');
    assert.equal(made.length, 1, 'the route path pushes exactly the frame');
    const el = made[0];
    assert.equal(el.attrs['sandbox'], 'allow-scripts');
    assert.ok(!el.attrs['sandbox'].includes('allow-same-origin'), 'the frame must stay origin-less');
    assert.equal(el.attrs['width'], '100%');
    assert.equal(el.attrs['height'], '260');
    assert.ok(el.attrs['title'] && el.attrs['title'].length > 0);
    const src = el.attrs['src'];
    assert.ok(typeof src === 'string' && src.startsWith('/frames/raw?d='),
      'the frame loads from the dedicated route');
    assert.ok(src.includes('&token=sess-token-123'),
      'the session token rides the query (SSE precedent)');
    assert.equal(el.attrs['srcdoc'], undefined, 'the route path must not carry a srcdoc');
  });

  it('falls back over budget: plain-language notice + the inert srcdoc render', () => {
    const made = buildFrames('a'.repeat(20000));
    assert.equal(made.length, 2, 'the fallback pushes the notice + the frame');
    const [note, el] = made;
    assert.equal(el.className, 'answer-raw-frame');
    assert.equal(el.attrs['sandbox'], 'allow-scripts');
    assert.ok(!el.attrs['sandbox'].includes('allow-same-origin'));
    assert.equal(el.attrs['src'], undefined, 'the fallback must not point at the route');
    const srcdoc = el.attrs['srcdoc'];
    assert.ok(srcdoc.startsWith('<!doctype html>'));
    assert.ok(srcdoc.includes("default-src 'none'"));
    assert.ok(srcdoc.includes('a'.repeat(50)), 'model html rides verbatim in the srcdoc');
    assert.equal(note.className, 'answer');
    const noticeText = note.children.join(' ');
    assert.ok(/static copy/.test(noticeText), 'the notice is plain language: ' + noticeText);
  });

  it('the registry routes raw-html to its component next to code', () => {
    const appSrc = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
    assert.ok(/'raw-html':\s*renderRawHtmlBlock/.test(appSrc), 'ANSWER_COMPONENTS must carry raw-html');
    assert.ok(/block\.kind === 'code' \|\| block\.kind === 'raw-html'/.test(appSrc),
      'renderBlocks must dispatch raw-html at block level');
  });
});
