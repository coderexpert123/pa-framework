/**
 * Device-surface tests (answer-presentation P6, 2026-09-16): the `surface`
 * hint's whole path through the client — `createTask`'s capture on both body
 * shapes, `surfaceLayoutClass`'s mapping, the comparison container's class
 * string, and the CSS cascade that makes the media query win back a grid on a
 * narrow screen.
 *
 * The renderer tests execute the REAL function sources, sliced out of
 * public/app.js (the comparison-renderer-behaviour.test.ts idiom) with a
 * stubbed h()/renderLines/showNotice — a partial extraction would test a copy,
 * not the app, so the slice asserts every anchor resolved.
 *
 * On the CSS: node cannot compute a cascade, so these tests do not claim to.
 * They assert the two mechanical properties that DECIDE the cascade for this
 * rule pair — equal specificity (both selectors carry exactly two classes) and
 * source order (the media-query copy is later) — plus the declarations on each
 * side. A blind instrument would be worse than none here, so the honest
 * boundary is stated: the pixel-level proof is the §Manual smoke test at
 * 390px, and these assertions are what fails automatically when the ordering
 * or the selector form regresses.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function readPublic(name: string): string {
  return readFileSync(join(PKG_ROOT, 'public', name), 'utf8');
}

/** One function's source, `function <name>(` up to the next top-level
 *  `\nfunction ` — the comparison-renderer-behaviour.test.ts helper. */
function sliceFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in public/app.js`);
  const end = src.indexOf('\nfunction ', start + 1);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

// ---------------------------------------------------------------- stubs --

interface FakeEl {
  tag: string;
  attrs: Record<string, string>;
  children: unknown[];
  append: (...kids: unknown[]) => void;
  addEventListener: (type: string, fn: () => void) => void;
}

function makeEl(tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): FakeEl {
  const rec: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    rec[k] = v === true ? '' : String(v);
  }
  const kids: unknown[] = children.flat(Infinity);
  return {
    tag,
    attrs: rec,
    children: kids,
    append(...more: unknown[]) { kids.push(...more.flat(Infinity)); },
    addEventListener() { /* no wired control is exercised here */ },
  };
}

/** The comparison chain, executed for real against a stubbed DOM. The slice
 *  list mirrors comparison-renderer-behaviour.test.ts's plus P6's
 *  surfaceLayoutClass — comparisonCards calls it, so omitting it here would
 *  ReferenceError at call time rather than at slice time. */
function comparisonFns() {
  const src = readPublic('app.js');
  const names = [
    'structuredLeadText', 'comparisonAttributeKeys', 'renderActionButton',
    'renderActionButtons', 'nameStore', 'nameStoreList', 'nameStoreHas',
    'toggleNameInStore', 'isItemSaved', 'toggleSavedItem',
    'runStructuredAction', 'runSaveAction',
    'surfaceLayoutClass', 'comparisonCards', 'renderComparison',
  ];
  const slice = names.map((n) => sliceFn(src, n)).join('');
  for (const n of names) assert.ok(slice.includes(`function ${n}(`), `slice missing ${n}`);
  const factory = new Function(
    'h', 'renderLines', 'stripAnswerMarkers', 'showNotice', 'state', 'navigator',
    `${slice}\n; return { surfaceLayoutClass, comparisonCards, renderComparison };`
  );
  return factory(
    makeEl,
    (t: unknown) => [String(t)],
    (t: unknown) => t,
    () => { /* notice spy not needed here */ },
    {},
    { share: () => Promise.resolve() }
  ) as {
    surfaceLayoutClass: (task: unknown) => string;
    comparisonCards: (data: unknown, task: unknown) => { node: FakeEl | null; anchors: unknown[] };
    renderComparison: (data: unknown, task: unknown) => FakeEl[];
  };
}

const THREE = {
  type: 'comparison',
  recommendation: 'The Ertiga wins on running cost.',
  items: [
    { name: 'Maruti Ertiga', attributes: { Price: '12 lakh' } },
    { name: 'Mahindra XL6', attributes: { Price: '14 lakh' } },
    { name: 'Toyota Innova', attributes: { Price: '19 lakh' } },
  ],
};
const TWO = { ...THREE, items: THREE.items.slice(0, 2) };

// ------------------------------------------------- surfaceLayoutClass ----

describe('surfaceLayoutClass — the hint maps to one class or none', () => {
  const api = comparisonFns();

  it("maps 'phone' and 'desktop' and nothing else", () => {
    assert.equal(api.surfaceLayoutClass({ surface: 'phone' }), 'cmp-phone');
    assert.equal(api.surfaceLayoutClass({ surface: 'desktop' }), 'cmp-desktop');
  });

  it('a NULL, absent, empty or unknown surface contributes NO class — the pre-P6 path', () => {
    // Every one of these is a real shape: NULL is every pre-v13 row, absent is
    // an older shell, and the garbage cases are the fail-open contract. All
    // four must reach the SAME answer as a task with no hint at all.
    for (const task of [
      { surface: null },
      { surface: undefined },
      {},
      { surface: '' },
      { surface: 'tablet' },
      { surface: 'PHONE' },
      { surface: 680 },
      { surface: { width: 390 } },
      null,
      undefined,
    ]) {
      assert.equal(api.surfaceLayoutClass(task), '', `unexpected class for ${JSON.stringify(task)}`);
    }
  });
});

// ------------------------------------------- the container class string --

describe('comparisonCards — the device class is appended, never substituted', () => {
  const api = comparisonFns();

  it('a task with NO surface produces the exact pre-P6 class string', () => {
    // The regression this pins is the one that would silently change every
    // historical answer: a pre-v13 row must render byte-identically.
    const three = api.comparisonCards(THREE, { task_id: 'vi-000000000001' });
    assert.ok(three.node);
    assert.equal(three.node.attrs['class'], 'cmp-cards cmp-swipe');
    const two = api.comparisonCards(TWO, { task_id: 'vi-000000000001', surface: null });
    assert.ok(two.node);
    assert.equal(two.node.attrs['class'], 'cmp-cards');
  });

  it('a phone-sourced task adds cmp-phone after the count modifier', () => {
    const three = api.comparisonCards(THREE, { task_id: 'vi-a', surface: 'phone' });
    assert.ok(three.node);
    assert.equal(three.node.attrs['class'], 'cmp-cards cmp-swipe cmp-phone');
    const two = api.comparisonCards(TWO, { task_id: 'vi-a', surface: 'phone' });
    assert.ok(two.node);
    assert.equal(two.node.attrs['class'], 'cmp-cards cmp-phone');
  });

  it('a desktop-sourced task adds cmp-desktop after the count modifier', () => {
    const three = api.comparisonCards(THREE, { task_id: 'vi-b', surface: 'desktop' });
    assert.ok(three.node);
    assert.equal(three.node.attrs['class'], 'cmp-cards cmp-swipe cmp-desktop');
    const two = api.comparisonCards(TWO, { task_id: 'vi-b', surface: 'desktop' });
    assert.ok(two.node);
    assert.equal(two.node.attrs['class'], 'cmp-cards cmp-desktop');
  });

  it('an unknown surface value adds nothing — the class string is unchanged', () => {
    const three = api.comparisonCards(THREE, { task_id: 'vi-c', surface: 'tablet' });
    assert.ok(three.node);
    assert.equal(three.node.attrs['class'], 'cmp-cards cmp-swipe');
  });

  it('the flat path carries the device class too (both dispatch sites see it)', () => {
    const nodes = api.renderComparison(THREE, { task_id: 'vi-d', surface: 'phone' });
    assert.equal(nodes.length, 2, 'lead line + cards container');
    assert.equal(nodes[1].attrs['class'], 'cmp-cards cmp-swipe cmp-phone');
  });

  it('the count ternary survives verbatim — the P2 source pins must keep matching', () => {
    const body = sliceFn(readPublic('app.js'), 'comparisonCards');
    assert.ok(
      body.includes("cards.length >= 3 ? 'cmp-cards cmp-swipe' : 'cmp-cards'"),
      'the P2 count ternary must be appended to, never rewritten'
    );
  });
});

// ------------------------------------------------- createTask's capture --

describe('createTask — the surface hint rides BOTH body shapes', () => {
  const body = sliceFn(readPublic('app.js'), 'createTask');

  it('detects the surface once, at the CSS phone breakpoint', () => {
    assert.ok(
      body.includes("const surface = window.innerWidth <= 680 ? 'phone' : 'desktop';"),
      'createTask must read the surface at <= 680 (the @media (max-width: 680px) breakpoint)'
    );
    assert.equal(body.split('window.innerWidth').length - 1, 1,
      'the viewport is read exactly once — a second read is a second breakpoint');
  });

  it('sends it on the multipart body AND the JSON body', () => {
    // The 1-of-N call-site defect: a hint wired into one branch is invisible
    // for every voice task (multipart) or every typed task (JSON).
    assert.ok(body.includes("fd.append('surface', surface);"), 'multipart branch must send surface');
    assert.ok(body.includes('payload.surface = surface;'), 'JSON branch must send surface');
  });

  it('sends it unconditionally — never behind an `if`', () => {
    for (const line of body.split('\n')) {
      if (!line.includes('surface')) continue;
      assert.equal(/^\s*if\s*\(/.test(line), false,
        `the surface hint must not be conditional: ${line.trim()}`);
    }
  });
});

// ----------------------------------------------------------- the CSS ----

/** The P6 section of styles.css, bounded by its own section marker. */
function deviceCss(): string {
  const css = readPublic('styles.css');
  const start = css.indexOf('/* --- device surface (answer presentation P6)');
  assert.notEqual(start, -1, 'styles.css must carry the device-surface section comment');
  const rest = css.slice(start);
  const end = rest.indexOf('\n/* ---', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Class count of a compound selector — the specificity component that
 *  decides this rule pair (no ids, no elements on either side). */
function classCount(selector: string): number {
  return selector.split('.').length - 1;
}

describe('device-surface CSS — the media query wins the grid back', () => {
  const css = deviceCss();
  const mqIdx = css.indexOf('@media (max-width: 680px)');

  it('the section carries exactly one 680px media query, and it is LAST', () => {
    assert.notEqual(mqIdx, -1, 'the P6 section must carry the 680px media query');
    assert.equal(css.split('@media').length - 1, 1, 'exactly one media query in this section');
  });

  it('above the media query, .cmp-cards.cmp-desktop is a grid', () => {
    const above = css.slice(0, mqIdx);
    const rule = /\.cmp-cards\.cmp-desktop\s*\{([^}]*)\}/.exec(above);
    assert.ok(rule, '.cmp-cards.cmp-desktop must be declared above the media query');
    assert.ok(rule[1].includes('display: grid'),
      'the desktop hint must assert the grid — otherwise the override below overrides nothing');
  });

  it('inside the media query, the SAME two-class selector takes the grid away', () => {
    const inside = css.slice(mqIdx);
    const rule = /\.cmp-cards\.cmp-desktop\s*\{([^}]*)\}/.exec(inside);
    assert.ok(rule, '.cmp-cards.cmp-desktop must be re-declared inside the media query');
    assert.ok(rule[1].includes('display: flex'),
      'a narrow viewport must flatten a desktop-sourced grid to the phone stack');
    assert.ok(rule[1].includes('flex-direction: column'), 'and stack it, not leave it a row');
  });

  it('the two selectors tie on specificity, so SOURCE ORDER decides — and the override is later', () => {
    // This is the whole mechanism. Equal specificity + later source position
    // is exactly what makes the media query win; either half alone does not.
    // The known-bad states this discriminates: writing the media-query rule as
    // bare `.cmp-cards` (loses the tie, 1 < 2), or appending this section
    // ABOVE the P2 media query (loses the order).
    assert.equal(classCount('.cmp-cards.cmp-desktop'), 2);
    const above = css.slice(0, mqIdx).indexOf('.cmp-cards.cmp-desktop {');
    const inside = css.slice(mqIdx).indexOf('.cmp-cards.cmp-desktop {');
    assert.notEqual(above, -1, 'the grid declaration must come first');
    assert.notEqual(inside, -1, 'the override must come second');
    assert.ok(mqIdx + inside > above, 'the media-query copy must be LATER in the file');
    // And the P6 section itself must sit after the P2 media query, or the P2
    // phone override would be re-overridden by this section's base rules.
    const all = readPublic('styles.css');
    assert.ok(
      all.indexOf('/* --- device surface (answer presentation P6)') >
        all.indexOf('/* --- comparison renderer (answer presentation P2)'),
      'the P6 section must come after the P2 comparison section'
    );
  });

  it('there is deliberately NO min-width rule taking the stack away from cmp-phone', () => {
    // C4/C15: the override is one-directional. A min-width rule here would
    // make a phone-sourced answer reflow to a grid on desktop, which is the
    // source SPEC §6.2 wording the PLAN's "Done when" supersedes. Strip
    // comments before searching — the section's own explanatory prose says
    // "deliberately NO min-width rule", and a bare /min-width/ against the
    // raw text matches that comment on a CORRECT tree too, so it could never
    // have discriminated the regression it exists to catch (operator
    // 2026-09-09: a check with the same answer for the good and bad state is
    // worse than none).
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/min-width/.test(rules), false,
      'a min-width override would defeat the phone-first rule the phase exists for');
    assert.ok(/\.cmp-cards\.cmp-phone\s*\{[^}]*display: flex/.test(css.slice(0, mqIdx)),
      'cmp-phone must hold the stack at every width');
  });
});

describe('P6 shell bump', () => {
  it('app.js SHELL_VERSION equals sw.js SHELL_CACHE and sw.js names the P6 change', () => {
    const appVersion = /const SHELL_VERSION = '(v\d+)';/.exec(readPublic('app.js'))?.[1];
    const swVersion = /const SHELL_CACHE = 'voice-inbox-shell-(v\d+)';/.exec(readPublic('sw.js'))?.[1];
    assert.ok(appVersion, 'SHELL_VERSION not found in public/app.js');
    assert.ok(swVersion, 'SHELL_CACHE not found in public/sw.js');
    assert.equal(appVersion, swVersion, 'app.js and sw.js must carry the same shell version');
    assert.match(readPublic('sw.js'), /^\/\/ v\d+: answer presentation P6/m,
      'sw.js must carry the P6 line in its version log');
  });
});
