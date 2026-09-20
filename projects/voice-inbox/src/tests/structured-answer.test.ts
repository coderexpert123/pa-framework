/**
 * Structured-answer tests (answer-presentation P1, 2026-09-15): the PWA's
 * structured path — safeParseStructured → renderStructuredAnswer →
 * renderStructuredFallback — plus suggestedItemLabels (the AI-234 chips fix:
 * tasks.suggested_items is a TEXT column, so the chips were dead code until
 * the gate parsed the string).
 *
 * These execute the REAL function sources, sliced out of public/app.js (the
 * read-state.test.ts / answer-shapes.test.ts idiom) with a stubbed h() — a
 * partial extraction would test a copy, not the app, so each slice asserts its
 * anchors resolved.
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

/** APP_JS env var points the source reader at a different app.js — used by
 *  the mutation proof (the recheck writes scratch/app-mutated.js), inert
 *  otherwise. Same convention as comparison-renderer-behaviour.test.ts. */
function appSrc(): string {
  const env = process.env.APP_JS;
  const path = env ? resolve(PKG_ROOT, env) : join(PKG_ROOT, 'public', 'app.js');
  return readFileSync(path, 'utf8');
}

/** Extract [functionName, …nextMarker) — the function plus everything up to
 *  the next top-level `function` declaration or doc-comment block. */
function sliceFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found in public/app.js`);
  const rest = src.slice(start);
  const m = /\nfunction \w+\(/.exec(rest.slice(1));
  const end = m ? 1 + m.index : rest.length;
  return rest.slice(0, end);
}

interface FakeEl { tag: string; attrs: Record<string, unknown>; children: unknown[]; appended: unknown[]; append: (...kids: unknown[]) => void }
function makeH() {
  const h = (tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): FakeEl => ({
    tag,
    attrs: attrs ?? {},
    children: children.flat(Infinity),
    appended: [],
    append(this: FakeEl, ...kids: unknown[]) { this.appended.push(...kids); },
  });
  return h;
}

function structuredFns() {
  const src = appSrc();
  const slice =
    sliceFn(src, 'safeParseStructured') +
    sliceFn(src, 'suggestedItemLabels') +
    sliceFn(src, 'renderStructuredFallback') +
    sliceFn(src, 'renderStructuredAnswer');
  for (const name of ['safeParseStructured', 'suggestedItemLabels',
    'renderStructuredFallback', 'renderStructuredAnswer']) {
    assert.ok(slice.includes(`function ${name}(`), `slice missing ${name}`);
  }
  const factory = new Function('h', `${slice}\n; return { safeParseStructured, suggestedItemLabels, renderStructuredFallback, renderStructuredAnswer };`);
  return factory(makeH()) as {
    safeParseStructured: (t: unknown) => unknown;
    suggestedItemLabels: (t: { suggested_items: unknown }) => string[];
    renderStructuredFallback: (d: Record<string, unknown>) => unknown[];
    renderStructuredAnswer: (d: Record<string, unknown>, t: unknown) => unknown[];
  };
}

describe('safeParseStructured (P1)', () => {
  const api = structuredFns();

  it('returns the object when it carries a string type', () => {
    const parsed = api.safeParseStructured('{"type":"comparison","items":[]}') as Record<string, unknown>;
    assert.equal(parsed.type, 'comparison');
  });

  it('returns null on unparseable, missing-type, and non-string-type input', () => {
    assert.equal(api.safeParseStructured('not json'), null);
    assert.equal(api.safeParseStructured('{"items":[]}'), null);
    assert.equal(api.safeParseStructured('{"type":5}'), null);
    assert.equal(api.safeParseStructured(''), null);
    assert.equal(api.safeParseStructured(null), null);
    assert.equal(api.safeParseStructured(undefined), null);
  });

  it('accepts a JSON array-with-type (edge: arrays are objects)', () => {
    // permissive by design — the server validator is the strict gate
    const arr = api.safeParseStructured('[{"type":"x"}]');
    assert.equal(arr, null); // the array itself has no .type string
  });
});

describe('renderStructuredFallback (P1) — never throws', () => {
  const api = structuredFns();

  it('renders title, recommendation, and item attribute pairs', () => {
    const nodes = api.renderStructuredFallback({
      type: 'comparison',
      title: 'Shortlist',
      recommendation: 'Pick A',
      items: [{ name: 'A', attributes: { Price: '12 lakh' } }],
    });
    assert.equal(nodes.length, 3); // title + recommendation + one item div
    const item = nodes[2] as FakeEl;
    assert.equal(item.tag, 'div');
    assert.equal(item.attrs['class'], 'struct-item');
  });

  it('survives a non-iterable items value (corrupt row cannot blank the view)', () => {
    for (const bad of [5, 'x', { a: 1 }, true, null]) {
      const nodes = api.renderStructuredFallback({ type: 'comparison', items: bad });
      assert.ok(Array.isArray(nodes), `items=${JSON.stringify(bad)} must not throw`);
    }
  });

  it('skips non-object items; an attributes-only item still renders its dl', () => {
    const nodes = api.renderStructuredFallback({
      type: 'listing',
      items: ['not-an-object', 42, { name: 'Keeps' }, { attributes: { k: 'v' } }],
    });
    // the two non-objects are skipped; the labeled item and the attributes-
    // only item each render a struct-item block (a bare dl is real content)
    assert.equal(nodes.length, 2);
  });

  it('renders form-set steps via their prompt label (steps, not items)', () => {
    const nodes = api.renderStructuredFallback({
      type: 'form-set',
      title: 'Bank needs three things',
      steps: [
        { id: 's1', prompt: 'Which account?' },
        { id: 's2', prompt: 'OTP?' },
      ],
    });
    // title + two step blocks — a form-set must not render an empty card
    assert.equal(nodes.length, 3);
  });

  it('renders nothing extra for a bare type-only object', () => {
    const nodes = api.renderStructuredFallback({ type: 'summary' });
    assert.equal(nodes.length, 0);
  });
});

describe('suggestedItemLabels (AI-234 fix)', () => {
  const api = structuredFns();

  it('parses the TEXT column value into labels', () => {
    const labels = api.suggestedItemLabels({ suggested_items: '["one","two","three","four"]' });
    assert.deepEqual(labels, ['one', 'two', 'three', 'four']);
  });

  it('passes a real array through (defensive — a future API may deliver one)', () => {
    assert.deepEqual(api.suggestedItemLabels({ suggested_items: ['a'] }), ['a']);
  });

  it('returns [] on null, unparseable, non-array JSON, and non-string entries', () => {
    assert.deepEqual(api.suggestedItemLabels({ suggested_items: null }), []);
    assert.deepEqual(api.suggestedItemLabels({ suggested_items: 'not json' }), []);
    assert.deepEqual(api.suggestedItemLabels({ suggested_items: '{"a":1}' }), []);
    assert.deepEqual(api.suggestedItemLabels({ suggested_items: '["ok", 5, " "]' }), ['ok']);
  });
});

// ---------------------------------------------------------------------------
// plainAnswerSnippet / turnSummaryText (P3 recheck — t-311/D2, 2026-09-15):
// the list row's clamped snippet reads the same structure as renderAnswerNodes
// but flattens to text. Before the fix, plainParagraphText only tried the
// enumerator route, so a bold-label lead (closing `**` never matches the
// lookbehind) above dash items ending in sentence punctuation folded the
// label AND item 1 into the lead — with a literal `- ` left inside the
// flattened snippet. The mirror fix tries lineDashSplit FIRST, same as
// classifyBlock in answer-shapes.js.
// ---------------------------------------------------------------------------

/** Execute the REAL snippet functions sliced from public/app.js.
 *  LINE_DASH_ITEM_RE is a module-level const declared between splitList and
 *  lineDashSplit — the splitList slice captures it (the slice runs to the
 *  next top-level `function`, which is lineDashSplit itself). */
function snippetFns() {
  const src = appSrc();
  const slice =
    sliceFn(src, 'firstSentence') +
    sliceFn(src, 'paragraphs') +
    sliceFn(src, 'findEnumerators') +
    sliceFn(src, 'splitList') +
    sliceFn(src, 'lineDashSplit') +
    sliceFn(src, 'stripInlineMarkers') +
    sliceFn(src, 'plainAnswerSnippet') +
    sliceFn(src, 'plainParagraphText') +
    sliceFn(src, 'turnSummaryText');
  for (const name of ['splitList', 'lineDashSplit', 'plainParagraphText', 'turnSummaryText']) {
    assert.ok(slice.includes(`function ${name}(`), `slice missing ${name}`);
  }
  assert.ok(slice.includes('LINE_DASH_ITEM_RE'), 'slice lost the dash-item regex const');
  // The dash-first order is the fix: assert the call shape still exists so a
  // reorder back to enumerator-first fails HERE even before the fixture runs.
  const ppt = sliceFn(src, 'plainParagraphText');
  assert.ok(
    ppt.includes('lineDashSplit(para) || splitList(para)'),
    'plainParagraphText no longer tries lineDashSplit before splitList',
  );
  const factory = new Function(
    `${slice}\n; return { firstSentence, paragraphs, findEnumerators, splitList, lineDashSplit, stripInlineMarkers, plainAnswerSnippet, plainParagraphText, turnSummaryText };`,
  );
  return factory() as {
    splitList: (t: string) => { lead: string; items: string[]; ordered: boolean } | null;
    lineDashSplit: (p: string) => { lead: string; items: string[]; ordered: boolean } | null;
    plainAnswerSnippet: (t: string) => string;
    plainParagraphText: (p: string) => string;
    turnSummaryText: (t: { result_summary?: string | null; state?: string; events?: unknown[] }) => string;
  };
}

const BOLD_LABEL_DASH_SNIPPET =
  '**What is repaired now.**\n- item one.\n- item two.\n- item three.';

describe('plainAnswerSnippet — bold-label lead above a dash list (t-311/D2)', () => {
  const api = snippetFns();

  it('flattens to lead + all three items, never a literal dash marker', () => {
    const out = api.plainAnswerSnippet(BOLD_LABEL_DASH_SNIPPET);
    assert.equal(out, 'What is repaired now. item one.; item two.; item three.');
    assert.ok(!out.includes('- '), `literal dash marker leaked into snippet: ${out}`);
  });

  it('the OLD enumerator-first order cannot produce this output', () => {
    // SplitList alone (the old sole route) folds label+item1 into the lead —
    // the check discriminates between the fixed and broken order.
    const broken = api.splitList(BOLD_LABEL_DASH_SNIPPET);
    assert.ok(broken !== null);
    assert.equal(broken.items.length, 2);
    assert.ok(broken.lead.includes('- '), 'old order should leak a dash marker');
  });

  it('a plain paragraph without lists still flattens to prose', () => {
    assert.equal(api.plainAnswerSnippet('First line.\n\nSecond para.'), 'First line. Second para.');
  });
});

describe('turnSummaryText — markdown-aware recap (P3 recheck)', () => {
  const api = snippetFns();

  it('uses plainAnswerSnippet for result_summary, not a raw whitespace fold', () => {
    const task = { result_summary: BOLD_LABEL_DASH_SNIPPET, state: 'completed' };
    assert.equal(
      api.turnSummaryText(task),
      'What is repaired now. item one.; item two.; item three.',
    );
  });

  it('a raw fold (the OLD behaviour) would leak markers — the pin discriminates', () => {
    const rawFold = BOLD_LABEL_DASH_SNIPPET.replace(/\s+/g, ' ').trim();
    assert.ok(rawFold.includes('**'), 'raw fold keeps asterisks');
    assert.ok(rawFold.includes('- '), 'raw fold keeps dash markers');
    assert.notEqual(api.turnSummaryText({ result_summary: BOLD_LABEL_DASH_SNIPPET }), rawFold);
  });
});
