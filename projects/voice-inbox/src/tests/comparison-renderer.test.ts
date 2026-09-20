/**
 * Comparison renderer tests (answer presentation P2, 2026-09-15): the first
 * dedicated structured-answer renderer — one card per item, one DOM for both
 * layouts (CSS switches grid <-> swipe row at 680px), per-item action controls,
 * and composition with the tiered answer card.
 *
 * The PWA has no DOM harness in this suite (public/app.js is a classic script
 * served raw — no bundler, no jsdom); these are structural source-code
 * assertions (the sync-twins.test.ts / suggest-chips.test.ts idiom): they pin
 * the dispatch case, the class names, the gate conditions and the call shapes,
 * so a drift in any of those surfaces here.
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

/**
 * A top-level `function name(...)`'s source, up to the next top-level
 * declaration or doc comment. Assertions that must not match a mention inside a
 * comment or a different function run against this slice, never the whole file
 * (app.js is 2-space indented, so a column-0 `function` / `const` / `/**`
 * always starts the next top-level item).
 */
function functionSource(src: string, name: string): string {
  const start = src.indexOf('\nfunction ' + name + '(');
  assert.notEqual(start, -1, `app.js must declare function ${name}`);
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n(function |const |\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The comparison section of styles.css, bounded by its own section markers. */
function comparisonCss(): string {
  const css = readPublic('styles.css');
  const start = css.indexOf('/* --- comparison renderer');
  assert.notEqual(start, -1, 'styles.css must carry the comparison renderer section comment');
  const rest = css.slice(start);
  const end = rest.indexOf('\n/* ---', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

const COMPARISON_CASE = /case 'comparison':\s*return renderComparison\(data, task\);/;

describe('P2 comparison renderer: dispatch', () => {
  const src = readPublic('app.js');

  it("renderStructuredAnswer dispatches type 'comparison' to renderComparison", () => {
    assert.ok(
      COMPARISON_CASE.test(functionSource(src, 'renderStructuredAnswer')),
      "renderStructuredAnswer must carry `case 'comparison': return renderComparison(data, task);`"
    );
  });

  it('every other type still falls through to the P1 fallback renderer', () => {
    assert.ok(
      /default:\s*return renderStructuredFallback\(data\);/.test(
        functionSource(src, 'renderStructuredAnswer')
      ),
      'renderStructuredAnswer must default to renderStructuredFallback(data)'
    );
  });

  it('known-bad control: the same matcher rejects a dispatch with no comparison case', () => {
    // The failure this file targets is "the comparison case is missing from the
    // dispatch". Construct one and prove the matcher says no — otherwise the
    // check above is inert.
    const stub =
      'function renderStructuredAnswer(data, task) {\n' +
      '  return renderStructuredFallback(data);\n' +
      '}';
    assert.equal(COMPARISON_CASE.test(stub), false,
      'the dispatch matcher must fail on a dispatch that has no comparison case');
    assert.equal(COMPARISON_CASE.test(functionSource(src, 'renderStructuredAnswer')), true,
      'the same matcher must pass on the real dispatch');
  });
});

describe('P2 comparison renderer: item cards', () => {
  const src = readPublic('app.js');

  it('renders one .cmp-card per item inside a .cmp-cards container', () => {
    const body = functionSource(src, 'comparisonCards');
    assert.ok(body.includes("'cmp-cards cmp-swipe' : 'cmp-cards'"), 'the container must carry class cmp-cards');
    assert.ok(body.includes("class: 'cmp-card'"), 'each item must carry class cmp-card');
    assert.ok(/for \(const item of items\)/.test(body), 'cards must map over data.items');
  });

  it('adds the cmp-swipe modifier only at 3+ items (two cards stack on phone)', () => {
    const body = functionSource(src, 'comparisonCards');
    assert.ok(
      body.includes("cards.length >= 3 ? 'cmp-cards cmp-swipe' : 'cmp-cards'"),
      "the swipe modifier must be gated on cards.length >= 3"
    );
  });

  it('renders attributes as dl.cmp-attrs dt/dd pairs through renderLines', () => {
    const body = functionSource(src, 'comparisonCards');
    assert.ok(body.includes("class: 'cmp-attrs'"), 'attributes must render as a .cmp-attrs list');
    assert.ok(
      /dl\.append\(h\('dt', null, key\), h\('dd', null, \.\.\.renderLines\(String\(attrs\[key\]\)\)\)\);/.test(body),
      'each attribute must render a dt/dd pair with the value through renderLines (inline links work)'
    );
  });

  it('returns chip anchors that point at the card element itself', () => {
    const body = functionSource(src, 'comparisonCards');
    assert.ok(
      body.includes('anchors.push({ text: name, node: card });'),
      'a chip anchor must carry the item name and the card element'
    );
    assert.ok(
      body.includes('return { node, anchors };'),
      'comparisonCards must return { node, anchors }'
    );
  });

  it('returns a null node for an item-less payload so the caller can fall through', () => {
    const body = functionSource(src, 'comparisonCards');
    assert.ok(
      body.includes('if (!cards.length) return { node: null, anchors: [] };'),
      'an item-less comparison must return a null node, never an empty container'
    );
  });

  it('keeps one attribute row order across cards (first-seen union)', () => {
    const keysBody = functionSource(src, 'comparisonAttributeKeys');
    assert.ok(
      keysBody.includes('if (!keys.includes(key)) keys.push(key);'),
      'comparisonAttributeKeys must return the first-seen union of attribute keys'
    );
    const cardsBody = functionSource(src, 'comparisonCards');
    assert.ok(
      cardsBody.includes('if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;'),
      'a card must skip keys the item does not carry (never an empty cell) — own-property, not `in`'
    );
    assert.ok(
      cardsBody.includes('const keys = comparisonAttributeKeys(items);'),
      'the card loop must use the shared key order'
    );
  });

  it('renders the recommendation as the flat path lead line', () => {
    const body = functionSource(src, 'renderComparison');
    assert.ok(
      body.includes("h('p', { class: 'cmp-lead' }, lead)"),
      'the recommendation must render as the .cmp-lead line'
    );
    assert.ok(
      body.includes('const cards = comparisonCards(data, task);'),
      'the flat path must use the shared card core'
    );
    assert.ok(
      body.includes('if (cards.node) nodes.push(cards.node);'),
      'a null card node must not be pushed'
    );
  });
});

describe('P2 action controls', () => {
  const src = readPublic('app.js');

  it('call actions are tel: anchors; link actions open a new tab with noopener', () => {
    const body = functionSource(src, 'renderActionButton');
    assert.ok(body.includes("href: 'tel:' + action.value.trim()"), 'a call action must build a tel: href');
    assert.ok(body.includes("href: action.url.trim()"), 'a link action must use the action url');
    assert.ok(/target: '_blank', rel: 'noopener'/.test(body), 'a link action must open a new tab with rel=noopener');
    assert.ok(
      body.includes("action.kind === 'link' && typeof action.url === 'string' && /^https?:\\/\\//i.test(action.url.trim())"),
      'a link url must be http(s) before it becomes an href — the markdown renderer\'s own scheme rule (javascript:/data: get no control)'
    );
  });

  it('task, save and share render as real buttons with a live handler', () => {
    const body = functionSource(src, 'renderActionButton');
    assert.ok(
      body.includes("action.kind === 'task' || action.kind === 'save' || action.kind === 'share'"),
      'the three wired kinds must share one branch'
    );
    assert.ok(
      /control\.addEventListener\('click', \(\) => runStructuredAction\(action, task, control, itemLabel\)\)/.test(body),
      'the button handler must carry the action, the task, its own control and the item label'
    );
    assert.ok(body.includes("type: 'button'"), 'action buttons must be type=button');
  });

  it('unknown kinds and missing targets render nothing (no dead control)', () => {
    const body = functionSource(src, 'renderActionButton');
    assert.ok(body.includes('if (!label) return null;'), 'a label-less action must render nothing');
    assert.ok(
      body.trimEnd().endsWith('return null;\n}'),
      'the unknown-kind fall-through must return null (never a dead control)'
    );
  });

  it('the wired handler dispatches every kind it renders — none is left unwired', () => {
    const body = functionSource(src, 'runStructuredAction');
    assert.ok(body.includes('runTaskAction(action, task, control)'), 'task must reach runTaskAction');
    assert.ok(body.includes('runSaveAction(action, task, control, itemLabel)'), 'save must reach runSaveAction');
    assert.ok(body.includes('runShareAction(action, task, itemLabel)'), 'share must reach runShareAction');
  });

  it('the accessible name carries the item the action belongs to', () => {
    const body = functionSource(src, 'renderActionButton');
    assert.ok(
      body.includes("label + ', ' + itemLabel"),
      'the aria-label must append the item name so repeated labels stay distinguishable'
    );
  });

  it('the action row is only added when there are controls', () => {
    const body = functionSource(src, 'comparisonCards');
    assert.ok(
      body.includes("if (actions.length) children.push(h('div', { class: 'cmp-actions' }, ...actions));"),
      'an item with no renderable actions must not get an empty .cmp-actions row'
    );
  });
});

describe('P2 tiered integration', () => {
  const src = readPublic('app.js');

  it('one card builder serves both detail sources', () => {
    assert.ok(
      functionSource(src, 'tieredCardNodes').includes("class: 'tldr'"),
      'tieredCardNodes must build the IN SHORT card'
    );
    assert.ok(
      functionSource(src, 'tieredAnswerNodes').includes('return tieredCardNodes(task, tier, detailNodes, anchors, lead);'),
      'the markdown path must delegate to tieredCardNodes'
    );
    assert.ok(
      functionSource(src, 'tieredStructuredNodes').includes('return tieredCardNodes(task, tier, detail.nodes, detail.anchors, lead);'),
      'the structured path must delegate to the same tieredCardNodes'
    );
  });

  it('the structured lead falls back to the recommendation, then the deterministic lead', () => {
    const body = functionSource(src, 'tieredStructuredNodes');
    assert.ok(
      body.includes('structuredLeadText(data) || tier.lead'),
      'the lead chain must be result_short -> recommendation -> tier.lead'
    );
    assert.ok(
      body.includes('? stripAnswerMarkers(task.result_short)'),
      'the stored short version must still win when present'
    );
  });

  it('an empty structured detail returns null so the caller can fall through', () => {
    const body = functionSource(src, 'tieredStructuredNodes');
    assert.ok(
      body.includes('if (!detail.nodes.length) return null;'),
      'an empty detail must return null, never an empty disclosure'
    );
  });

  it('answerRegionParts is the single structured/markdown seam', () => {
    const body = functionSource(src, 'answerRegionParts');
    assert.ok(
      body.includes('if (parts && parts.length) return parts;'),
      'an empty structured render must fall through to the markdown path'
    );
    assert.ok(
      body.includes('return tier.tiered ? tieredAnswerNodes(task, tier) : renderAnswerNodes(task.result_summary);'),
      'the markdown fall-through must keep the original tier gate'
    );
    assert.ok(
      functionSource(src, 'renderTurnContent').includes('const answerParts = answerRegionParts(task);'),
      'renderTurnContent must route through the seam'
    );
    assert.ok(
      body.includes('const tier = task.result_summary ? answerTier(task.result_summary) : EMPTY_TIER;'),
      'the tier gate must be the markdown path\'s own gate'
    );
  });

  it('chipRow accepts a direct-node anchor and still resolves markdown index anchors', () => {
    const body = functionSource(src, 'chipRow');
    assert.ok(body.includes('if (a.text) text = a.text;'), 'chipRow must accept a carried label');
    assert.ok(
      body.includes('const target = c.node || detailNodes[c.startIndex];'),
      'chipRow must prefer a direct node and still fall back to the markdown index'
    );
    assert.ok(
      body.includes("chips.push({ text: text + count, startIndex: a.startIndex, node: a.node });"),
      'both anchor shapes must survive into the chip list'
    );
  });

  it('form-set landed: data.steps readers are the fallback plus the P4 normaliser', () => {
    // P4's renderer reads data.steps through formsetSteps; the only other
    // reader is the P1 fallback (a malformed form-set still lists its steps).
    const readers = src.split('\n').filter((line) => line.includes('data.steps')).length;
    assert.equal(readers, 2,
      'two readers of data.steps: the P1 fallback and formsetSteps (P4)');
    assert.ok(functionSource(src, 'structuredDetail').includes("data.type === 'form-set'"),
      'structuredDetail must dispatch form-set to renderFormSet (P4)');
    assert.equal(/steps/.test(functionSource(src, 'comparisonCards')), false,
      'the comparison renderer must not read steps');
  });

  it('collapsed result_summary consumers stay marker-clean (P3 recheck)', () => {
    // The failed-state toast used to show raw result_summary — ** and -
    // markers leaked into the notification, while the done branch two lines
    // above stripped them via firstSentence. plainAnswerSnippet, never
    // firstSentence here: its ':'-clamp would cut "quota exceeded: 429" down
    // to "quota exceeded". A revert to the raw fold fails this pin.
    const body = functionSource(src, 'maybeNotify');
    assert.ok(
      body.includes('plainAnswerSnippet(c.result_summary)'),
      'the failed notification must flatten result_summary through plainAnswerSnippet'
    );
    assert.equal(
      body.includes("showNotif('Didn’t work — ' + lines.title,\n          c.result_summary ||"),
      false,
      'the failed notification must not pass raw result_summary'
    );
  });
});

describe('P2 comparison styles', () => {
  it('.cmp-cards is a grid by default (desktop)', () => {
    const rule = /\.cmp-cards\s*\{([^}]*)\}/.exec(comparisonCss());
    assert.ok(rule, '.cmp-cards rule not found in the comparison section');
    assert.ok(rule[1].includes('display: grid'), '.cmp-cards must be a grid by default');
    assert.ok(
      /grid-template-columns:\s*repeat\(auto-fit, minmax\(200px, 1fr\)\)/.test(rule[1]),
      '.cmp-cards must use auto-fit minmax(200px, 1fr)'
    );
  });

  it('the phone override turns .cmp-swipe into a snap row', () => {
    const css = comparisonCss();
    assert.ok(
      /@media \(max-width: 680px\)[\s\S]*?\.cmp-cards\.cmp-swipe\s*\{[^}]*scroll-snap-type: x mandatory/.test(css),
      '.cmp-cards.cmp-swipe must get scroll-snap-type: x mandatory inside the 680px media query'
    );
    assert.ok(
      /\.cmp-cards\.cmp-swipe \.cmp-card\s*\{[^}]*flex: 0 0 85%[^}]*scroll-snap-align: center/.test(css),
      'a swipe card must be 85% wide and snap-align'
    );
    assert.ok(
      !/@media \(min-width: 681px\)/.test(css),
      'the phone override belongs in the 680px query (the answer-card convention), not a 681px one'
    );
  });

  it('action anchors and buttons get an explicit flex box and no underline', () => {
    const css = comparisonCss();
    const rule = /a\.cmp-act,\s*button\.cmp-act\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, 'a.cmp-act, button.cmp-act rule not found');
    assert.ok(rule[1].includes('display: inline-flex'), 'a.cmp-act/button.cmp-act must be an inline-flex box');
    assert.ok(rule[1].includes('text-decoration: none'), 'a.cmp-act/button.cmp-act must not be underlined');
  });

  it('action controls declare an accent border and colour under the compound .act.cmp-act selector (2026-09-16)', () => {
    // Action controls carry class `act act-quiet cmp-act`. A bare `.cmp-act`
    // rule (0-1-0) loses the cascade to the later `.act`/`.act-quiet` rules
    // (also 0-1-0, declared further down styles.css) regardless of where it
    // sits in the file — only the compound `.act.cmp-act` selector (0-2-0)
    // reliably wins. Pins the selector itself, not just the declaration
    // text, so a regression back to a bare `.cmp-act` fails here.
    const css = comparisonCss().replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.act\.cmp-act\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule, '.act.cmp-act rule not found — the border/colour fix must live under the compound selector');
    assert.match(rule[1], /border:\s*1px solid var\(--accent-ink\)/, '.act.cmp-act must declare an accent border');
    assert.match(rule[1], /color:\s*var\(--accent-ink\)/, '.act.cmp-act must declare accent text colour');
  });

  it('external-link action controls get a new-tab arrow marker (2026-09-16)', () => {
    const css = comparisonCss().replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(
      css,
      /a\.cmp-act\[target="_blank"\]::after\s*\{[^}]*content:\s*"\\2197"/,
      'a.cmp-act[target="_blank"]::after must render the new-tab arrow'
    );
  });

  it('the file-wide text-decoration:none count is pinned (battery discrimination)', () => {
    // The spec's negative-control mutation "anchor underline restored" removes
    // the FIRST `text-decoration: none;` in styles.css — which is .skip-link's,
    // not a.cmp-act's (the spec's fake package held only the comparison block,
    // so the two coincided there). The rule-scoped assertion above can never
    // see that mutation in the real file; this count pin can. Any single
    // removal — inside the comparison section or before it — fails here.
    const all = readPublic('styles.css');
    const occurrences = all.split('text-decoration: none;').length - 1;
    assert.equal(occurrences, 5,
      'styles.css carries exactly 5 `text-decoration: none;` declarations — a removal anywhere must fail this suite');
  });

  it('attribute-value links carry the answer link colour', () => {
    const css = comparisonCss();
    assert.ok(/\.cmp-attrs a\s*\{[^}]*color: var\(--accent-ink\)/.test(css),
      '.cmp-attrs a must use --accent-ink (the answer link colour), not the UA default');
  });

  it('uses only tokens that exist in :root', () => {
    const all = readPublic('styles.css');
    assert.equal(/var\(--border\)/.test(all), false,
      'var(--border) does not exist — the plan\'s CSS block is the known-bad instance');
    assert.equal(/var\(--text-secondary\)/.test(all), false,
      'var(--text-secondary) does not exist — the plan\'s CSS block is the known-bad instance');
  });
});

describe('P2 shell bump', () => {
  it('app.js SHELL_VERSION equals sw.js SHELL_CACHE and sw.js names the P2 change', () => {
    const appVersion = /const SHELL_VERSION = '(v\d+)';/.exec(readPublic('app.js'))?.[1];
    const swVersion = /const SHELL_CACHE = 'voice-inbox-shell-(v\d+)';/.exec(readPublic('sw.js'))?.[1];
    assert.ok(appVersion, 'SHELL_VERSION not found in public/app.js');
    assert.ok(swVersion, 'SHELL_CACHE not found in public/sw.js');
    assert.equal(appVersion, swVersion, 'app.js and sw.js must carry the same shell version');
    assert.match(readPublic('sw.js'), /^\/\/ v\d+: answer presentation P2/m,
      'sw.js must carry the P2 line in its version log');
  });
});

describe('desktop footer layout (v81 regression pin)', () => {
  // Found by the 2026-09-16 visual pass: at ≥681px the footer shrink-wrapped
  // to its content (~208px) because `right:auto` cancels the full-width
  // fixed stretch and max-width:680px alone does not give the box a definite
  // inline size — the absolutely-centred mic then landed on top of
  // .footer-extras and fully covered the stop button (elementFromPoint
  // returned the mic at every stop pixel; a Playwright click timed out).
  // The fix is width:100% INSIDE the same media query so the box spans the
  // 680px column and space-between has room to work.
  it('.footer gets width:100% inside the ≥681px media query', () => {
    const css = readPublic('styles.css');
    const media = /@media \(min-width: 681px\)\s*\{[\s\S]*?\.footer\s*\{([^}]*)\}/.exec(css);
    assert.ok(media, 'the ≥681px media query must restyle .footer');
    assert.match(media[1], /\bwidth:\s*100%/,
      '.footer inside the ≥681px media query must declare width:100% — without it the box shrink-wraps and the centred mic covers stop/extras');
  });
});
