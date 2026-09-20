/**
 * Pattern-renderer tests (answer-presentation P5, 2026-09-15): the listing,
 * guide and summary views — listingCards/guideSteps/summarySections, their
 * flat-path wrappers, the generalized name-store the guide checks ride on,
 * and the dispatch pins (structuredDetail / renderStructuredAnswer).
 *
 * These execute the REAL function sources, sliced out of public/app.js (the
 * structured-answer.test.ts / form-set.test.ts idiom) with a stubbed
 * h()/localStorage/checkIcon/showNotice/renderLines/renderActionButtons —
 * a partial extraction would test a copy, not the app, so each slice
 * asserts its anchors resolved.
 *
 * APP_JS env var points the source reader at a different app.js — used by the
 * mutation proof (scratch/p5-spec-gate-check/mutate-p5.mjs writes
 * mutated/app-mutated.js), inert otherwise. Node runs each test file in its
 * own subprocess, so a set APP_JS cannot bleed into sibling files.
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

function appSrc(): string {
  const env = process.env.APP_JS;
  const path = env ? resolve(PKG_ROOT, env) : join(PKG_ROOT, 'public', 'app.js');
  return readFileSync(path, 'utf8');
}

/** Extract [startNeedle, …endNeedle) — an explicit boundary, not sliceFn's
 *  `\nfunction` heuristic: the store block holds `const` declarations and the
 *  view block sits between two doc comments (the form-set.test.ts sliceFrom
 *  idiom). */
function sliceFrom(src: string, startNeedle: string, endNeedle: string, label: string): string {
  const start = src.indexOf(startNeedle);
  assert.ok(start !== -1, `${label}: start anchor not found in public/app.js`);
  const end = src.indexOf(endNeedle, start);
  assert.ok(end !== -1, `${label}: end anchor not found in public/app.js`);
  return src.slice(start, end);
}

// ---------------------------------------------------------------- stubs --

interface FakeEl {
  tag: string;
  attrs: Record<string, unknown>;
  children: unknown[];            // getter: init kids + appended (the DOM shape)
  appended: unknown[];
  append: (...kids: unknown[]) => void;
  replaceChildren: (...kids: unknown[]) => void;
  setAttribute: (k: string, v: unknown) => void;
  listeners: Record<string, Array<(...a: unknown[]) => void>>;
  addEventListener: (type: string, fn: (...a: unknown[]) => void) => void;
  click: () => void;
  value: string;
  disabled: boolean;
  hidden: boolean;
}

function makeEl(tag: string, attrs: Record<string, unknown> | null, ...children: unknown[]): FakeEl {
  const init: unknown[] = children.flat(Infinity);
  // Mirror the real h(): falsy attrs are skipped entirely and `true` becomes
  // an empty-string attribute — so `attrs.disabled !== undefined` IS disabled.
  const rec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    rec[k] = v === true ? '' : String(v);
  }
  const el: FakeEl = {
    tag,
    attrs: rec,
    appended: [],
    get children() { return [...init, ...this.appended]; },
    append(this: FakeEl, ...kids: unknown[]) { this.appended.push(...kids.flat(Infinity)); },
    replaceChildren(this: FakeEl, ...kids: unknown[]) {
      init.length = 0;
      this.appended.length = 0;
      this.appended.push(...kids.flat(Infinity));
    },
    setAttribute(this: FakeEl, k: string, v: unknown) { this.attrs[k] = String(v); },
    listeners: {},
    addEventListener(this: FakeEl, type: string, fn: (...a: unknown[]) => void) {
      (this.listeners[type] ??= []).push(fn);
    },
    click(this: FakeEl) { for (const fn of this.listeners['click'] ?? []) fn(); },
    value: '',
    disabled: false,
    hidden: false,
  };
  return el;
}
const makeH = () => makeEl;

function isEl(x: unknown): x is FakeEl {
  return !!x && typeof x === 'object' && typeof (x as FakeEl).tag === 'string';
}

/** Every element in the tree, depth-first (children covers append output). */
function walk(el: FakeEl): FakeEl[] {
  const out: FakeEl[] = [el];
  for (const c of el.children) if (isEl(c)) out.push(...walk(c));
  return out;
}

/** All text under a node, joined. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if ('text' in node) return String((node as { text: unknown }).text);
  if (isEl(node)) return node.children.map(textOf).join('');
  return '';
}

function findAll(root: FakeEl, cls: string): FakeEl[] {
  return walk(root).filter((e) => String(e.attrs['class'] ?? '').split(' ').includes(cls));
}

interface FakeLS {
  store: Map<string, string>;
  failWrites: boolean;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

function makeLS(): FakeLS {
  return {
    store: new Map<string, string>(),
    failWrites: false,
    getItem(this: FakeLS, k) { return this.store.has(k) ? this.store.get(k)! : null; },
    setItem(this: FakeLS, k, v) {
      if (this.failWrites) throw new Error('QuotaExceededError');
      this.store.set(k, v);
    },
    removeItem(this: FakeLS, k) { this.store.delete(k); },
    key(this: FakeLS, i) { return [...this.store.keys()][i] ?? null; },
    get length() { return this.store.size; },
  };
}

interface Env {
  ls: FakeLS;
  notices: string[];
  actionCalls: Array<{ actions: unknown; task: unknown; name: string }>;
  linesCalls: string[];
}

function makeEnv(): Env {
  return { ls: makeLS(), notices: [], actionCalls: [], linesCalls: [] };
}

interface PatternApi {
  LS_SAVED: string;
  LS_GUIDE_DONE: string;
  SAVED_LABEL: string;
  NAME_STORE_MAX_TASKS: number;
  nameStore: (lsKey: string) => Record<string, unknown>;
  nameStoreList: (store: unknown, taskId: string) => string[];
  nameStoreHas: (lsKey: string, task: unknown, itemLabel: string) => boolean;
  toggleNameInStore: (lsKey: string, task: unknown, itemLabel: string, seed?: string[]) => boolean | null;
  isItemSaved: (task: unknown, itemLabel: string) => boolean;
  toggleSavedItem: (task: unknown, itemLabel: string) => boolean | null;
  itemDetailLine: (item: Record<string, unknown>) => string;
  itemLeadLine: (item: Record<string, unknown>) => string;
  itemPoints: (item: Record<string, unknown>) => string[];
  listingCards: (data: unknown, task: unknown) => { node: FakeEl | null; anchors: unknown[] };
  renderListing: (data: unknown, task: unknown) => FakeEl[];
  guideSteps: (data: unknown, task: unknown) => { node: FakeEl | null; anchors: unknown[] };
  renderGuide: (data: unknown, task: unknown) => FakeEl[];
  summarySections: (data: unknown, task: unknown) => { node: FakeEl | null; anchors: unknown[] };
  renderSummary: (data: unknown, task: unknown) => FakeEl[];
}

function patternFns(env: Env): PatternApi {
  const src = appSrc();
  // Region A — the generalized name-store block (consts + helpers + the
  // vi.saved wrappers), between renderActionButtons and the P3 doc comment.
  // applySavedLabel rides the tail and is inert here (never called).
  const storeSlice = sliceFrom(src, 'const LS_SAVED',
    '/**\n * P3: the three action kinds', 'name-store block');
  // Region B — the P5 pattern views between renderFormSet's end and the
  // comparisonCards doc comment.
  const viewSlice = sliceFrom(src, '/**\n * P5: the three remaining pattern views',
    "/**\n * The comparison view's cards", 'pattern views');
  const slice = storeSlice + viewSlice;
  for (const n of ['function nameStore(', 'function nameStoreList(', 'function nameStoreHas(',
    'function toggleNameInStore(', 'function isItemSaved(', 'function toggleSavedItem(',
    'function itemDetailLine(', 'function itemLeadLine(', 'function itemPoints(', 'function listingCards(',
    'function renderListing(', 'function guideSteps(', 'function renderGuide(',
    'function summarySections(', 'function renderSummary(']) {
    assert.ok(slice.includes(n), `pattern slice missing ${n}`);
  }
  const factory = new Function(
    'h', 'localStorage', 'checkIcon', 'showNotice', 'renderLines',
    'renderActionButtons', 'structuredLeadText',
    `${slice}\n; return { LS_SAVED, LS_GUIDE_DONE, SAVED_LABEL, NAME_STORE_MAX_TASKS, nameStore, nameStoreList, nameStoreHas, toggleNameInStore, isItemSaved, toggleSavedItem, itemDetailLine, itemLeadLine, itemPoints, listingCards, renderListing, guideSteps, renderGuide, summarySections, renderSummary };`
  );
  return factory(
    makeH(), env.ls,
    () => makeEl('svg', null),
    (msg: unknown) => { env.notices.push(String(msg)); },
    (t: unknown) => { env.linesCalls.push(String(t)); return [String(t)]; },
    (actions: unknown, task: unknown, name: string) => {
      env.actionCalls.push({ actions, task, name });
      return Array.isArray(actions) && actions.length ? [makeEl('button', { class: 'act' }, 'ACT')] : [];
    },
    (d: unknown) => (d && typeof (d as Record<string, unknown>).recommendation === 'string'
      ? String((d as Record<string, unknown>).recommendation) : ''),
  ) as PatternApi;
}

/** Dispatch fns (structuredDetail/renderStructuredAnswer) sliced with stubs
 *  for every renderer — the point under test is the WIRING, not the renders.
 *  The three P5 views get their own stubs so a missing case is a
 *  ReferenceError, not a silent fallback. */
function dispatchFns() {
  const src = appSrc();
  const slice = sliceFrom(src, 'function structuredDetail(',
    'const EMPTY_TIER', 'dispatch');
  assert.ok(slice.includes('function renderStructuredAnswer('), 'dispatch slice missing renderStructuredAnswer');
  const calls: string[] = [];
  const factory = new Function(
    'comparisonCards', 'renderFormSet', 'renderStructuredFallback', 'renderComparison',
    'listingCards', 'guideSteps', 'summarySections',
    'renderListing', 'renderGuide', 'renderSummary',
    `${slice}\n; return { structuredDetail, renderStructuredAnswer };`
  );
  const view = (name: string) => () => {
    calls.push(name);
    return { node: makeEl('div', null), anchors: [{ text: 'a', node: makeEl('div', null) }] };
  };
  const flat = (name: string) => () => { calls.push(name); return [makeEl('p', null)]; };
  const api = factory(
    () => { calls.push('comparisonCards'); return { node: makeEl('div', null), anchors: [] }; },
    () => { calls.push('renderFormSet'); return makeEl('div', null); },
    () => { calls.push('renderStructuredFallback'); return [makeEl('p', null)]; },
    () => { calls.push('renderComparison'); return [makeEl('div', null)]; },
    view('listingCards'), view('guideSteps'), view('summarySections'),
    flat('renderListing'), flat('renderGuide'), flat('renderSummary'),
  ) as { structuredDetail: Function; renderStructuredAnswer: Function };
  return { api, calls };
}

// ------------------------------------------------------------- fixtures --

const TASK = { task_id: 'vi-abababababab' };
const TASK2 = { task_id: 'vi-cdcdcdcdcdcd' };

// -------------------------------------------------- the generalized store --

describe('P5 store: the generalized name-store (executed)', () => {
  it('pins the keys, the saved label and the per-store bound', () => {
    const env = makeEnv();
    const api = patternFns(env);
    assert.equal(api.LS_SAVED, 'vi.saved');
    assert.equal(api.LS_GUIDE_DONE, 'vi.guide.done');
    assert.equal(api.SAVED_LABEL, 'Saved ✓');
    assert.equal(api.NAME_STORE_MAX_TASKS, 200);
  });

  it('reads a corrupt, wrong-shaped or missing value as no marks, never throwing', () => {
    for (const bad of ['not json', '[]', '"x"', '5', 'null', 'true']) {
      const env = makeEnv();
      env.ls.store.set('vi.saved', bad);
      const api = patternFns(env);
      assert.deepEqual(api.nameStore('vi.saved'), {}, `stored value ${bad} must read as {}`);
      assert.equal(api.isItemSaved(TASK, 'X'), false, `stored value ${bad} must mark nothing`);
    }
    const env = makeEnv();
    assert.deepEqual(patternFns(env).nameStore('vi.saved'), {}, 'a missing key reads as {}');
  });

  it('a non-array task value reads as no marks', () => {
    const env = makeEnv();
    env.ls.store.set('vi.saved', JSON.stringify({ 'vi-a': 'oops' }));
    const api = patternFns(env);
    assert.deepEqual(api.nameStoreList(api.nameStore('vi.saved'), 'vi-a'), []);
    assert.equal(api.isItemSaved({ task_id: 'vi-a' }, 'X'), false);
  });

  it('the saved wrappers still toggle vi.saved round-trip, per task', () => {
    const env = makeEnv();
    const api = patternFns(env);
    assert.equal(api.toggleSavedItem(TASK, 'Maruti Ertiga'), true);
    assert.equal(api.isItemSaved(TASK, 'Maruti Ertiga'), true);
    assert.equal(api.isItemSaved(TASK2, 'Maruti Ertiga'), false);
    assert.equal(api.toggleSavedItem(TASK, 'Maruti Ertiga'), false);
    assert.equal(api.isItemSaved(TASK, 'Maruti Ertiga'), false);
  });

  it('emptying a vi.saved task drops its key; an emptied seeded task keeps []', () => {
    const env = makeEnv();
    const api = patternFns(env);
    api.toggleSavedItem(TASK, 'X');
    api.toggleSavedItem(TASK, 'X');
    const saved = JSON.parse(env.ls.store.get('vi.saved') || '{}');
    assert.equal('vi-abababababab' in saved, false, 'an emptied unseeded list drops the task key');
    // The seeded store keeps the empty array: deleting the key would re-seed
    // the payload's defaults on the next render and resurrect the unchecked
    // step. Uncheck BOTH defaults to reach empty.
    api.toggleNameInStore('vi.guide.done', TASK, 'Do A', ['Do A', 'Do B']);
    api.toggleNameInStore('vi.guide.done', TASK, 'Do B', ['Do A', 'Do B']);
    const guide = JSON.parse(env.ls.store.get('vi.guide.done') || '{}');
    assert.deepEqual(guide['vi-abababababab'], [],
      'unchecking every default keeps an explicit empty list');
  });

  it('the store is authoritative once it exists — the seed never overwrites it', () => {
    const env = makeEnv();
    env.ls.store.set('vi.guide.done', JSON.stringify({ [TASK.task_id!]: ['B'] }));
    const api = patternFns(env);
    // Seed says A; store says B. Toggling A applies to B's list, not the seed.
    assert.equal(api.toggleNameInStore('vi.guide.done', TASK, 'A', ['A']), true);
    const stored = JSON.parse(env.ls.store.get('vi.guide.done') || '{}')[TASK.task_id!];
    assert.deepEqual(stored.sort(), ['A', 'B'], 'the stored list gains A — the seed does not replace it');
  });

  it('the bound drops the oldest task key at 201', () => {
    const env = makeEnv();
    const api = patternFns(env);
    for (let i = 0; i < 201; i++) {
      api.toggleSavedItem({ task_id: `vi-${String(i).padStart(12, '0')}` }, 'X');
    }
    const saved = JSON.parse(env.ls.store.get('vi.saved') || '{}');
    assert.equal(Object.keys(saved).length, 200);
    assert.equal('vi-000000000000' in saved, false, 'the oldest task key is evicted');
  });

  it('a failed write returns null — the caller leaves the control alone', () => {
    const env = makeEnv();
    env.ls.failWrites = true;
    const api = patternFns(env);
    assert.equal(api.toggleSavedItem(TASK, 'X'), null);
    assert.equal(api.toggleNameInStore('vi.guide.done', TASK, 'X', ['Y']), null);
  });
});

// ------------------------------------------------------------- listing ---

describe('P5 listing view', () => {
  const DATA = {
    type: 'listing',
    recommendation: 'Three garages nearby',
    items: [
      { name: 'City Motors', summary: 'Open till 9pm, 4.2 stars' },
      { name: 'QuickFix', description: 'Chain store, app booking' },
      { name: 'Local Garage', attributes: { Distance: '2 km', Open: 'Yes' },
        actions: [{ label: 'Call', kind: 'call', value: '+91…' }] },
    ],
  };

  it('renders one .lst-item per item inside .lst-list, name + detail', () => {
    const { node, anchors } = patternFns(makeEnv()).listingCards(DATA, TASK);
    assert.ok(node, 'the listing must render');
    const rows = findAll(node!, 'lst-item');
    assert.equal(rows.length, 3);
    assert.equal(textOf(findAll(rows[0], 'lst-name')[0]), 'City Motors');
    assert.equal(textOf(findAll(rows[0], 'lst-detail')[0]), 'Open till 9pm, 4.2 stars');
    assert.equal((anchors as Array<{ text: string; node: unknown }>).length, 3);
    assert.equal((anchors as Array<{ text: string; node: unknown }>)[0].text, 'City Motors');
    assert.equal((anchors as Array<{ text: string; node: unknown }>)[0].node, rows[0],
      'each chip lands on the row it names');
  });

  it('the detail line falls back summary → description → attributes', () => {
    const api = patternFns(makeEnv());
    const { node } = api.listingCards(DATA, TASK);
    const rows = findAll(node!, 'lst-item');
    assert.equal(textOf(findAll(rows[1], 'lst-detail')[0]), 'Chain store, app booking');
    assert.equal(textOf(findAll(rows[2], 'lst-detail')[0]), 'Distance: 2 km; Open: Yes');
    assert.equal(api.itemDetailLine({ name: 'x' }), '', 'a name-only item has no detail line');
  });

  it('routes item.actions through renderActionButtons with the item name', () => {
    const env = makeEnv();
    patternFns(env).listingCards(DATA, TASK);
    assert.equal(env.actionCalls.length, 3, 'every item asks for its action row');
    const withActions = env.actionCalls[2];
    assert.equal(withActions.name, 'Local Garage');
    assert.ok(Array.isArray(withActions.actions) && (withActions.actions as unknown[]).length === 1);
  });

  it('skips nameless and non-object items; an empty result is {node: null}', () => {
    const api = patternFns(makeEnv());
    const { node, anchors } = api.listingCards({ type: 'listing', items: [42, {}, { name: '  ' }, { name: 'Real' }] }, TASK);
    assert.ok(node);
    assert.equal(findAll(node!, 'lst-item').length, 1);
    assert.equal((anchors as unknown[]).length, 1);
    const empty = api.listingCards({ type: 'listing', items: [{}, { name: '' }] }, TASK);
    assert.equal(empty.node, null, 'no usable item means the caller falls back');
    assert.deepEqual(empty.anchors, []);
  });

  it('renderListing leads with the recommendation and returns [] on an empty view', () => {
    const api = patternFns(makeEnv());
    const nodes = api.renderListing(DATA, TASK);
    assert.ok(nodes.some((n) => findAll(n, 'cmp-lead').length > 0), 'the lead line precedes the list');
    assert.ok(nodes.some((n) => findAll(n, 'lst-list').length > 0 || n.attrs?.['class'] === 'lst-list'));
    assert.deepEqual(api.renderListing({ type: 'listing', items: [] }, TASK), [],
      'an empty view returns no nodes — the answer falls through to markdown');
  });
});

// ---------------------------------------------------------------- guide ---

describe('P5 guide view', () => {
  const DATA = {
    type: 'guide',
    recommendation: 'Claim the refund in three steps',
    items: [
      { name: 'Gather the invoice', summary: 'PDF from the order page' },
      { name: 'File the claim', done: true, points: ['Use the portal', 'Attach the invoice'] },
      { name: 'Follow up after a week', attributes: { When: 'day 7' } },
    ],
  };

  function stepsOf(node: FakeEl): FakeEl[] {
    return findAll(node, 'gde-step');
  }

  it('renders numbered steps, the head count and the progress bar', () => {
    const { node, anchors } = patternFns(makeEnv()).guideSteps(
      { type: 'guide', items: DATA.items }, TASK);
    assert.ok(node);
    const steps = stepsOf(node!);
    assert.equal(steps.length, 3);
    assert.equal(textOf(findAll(steps[0], 'gde-num')[0]), '1');
    assert.equal(textOf(findAll(node!, 'gde-head')[0]), '1 of 3 done',
      'the worker done:true seeds the initial count');
    const bar = findAll(node!, 'gde-bar')[0];
    assert.equal(bar.attrs['max'], '3');
    assert.equal(bar.attrs['value'], '1');
    assert.equal((anchors as Array<{ text: string }>).map((a) => a.text).join(','),
      'Gather the invoice,File the claim,Follow up after a week');
    // the seeded default paints checked
    const checks = steps.map((s) => findAll(s, 'gde-check')[0]);
    assert.equal(checks[1].attrs['aria-checked'], 'true');
    assert.equal(steps[1].attrs['class'], 'gde-step done');
    assert.equal(checks[0].attrs['aria-checked'], 'false');
  });

  it('renders step detail and points bullets', () => {
    const env = makeEnv();
    const { node } = patternFns(env).guideSteps({ type: 'guide', items: DATA.items }, TASK);
    const steps = stepsOf(node!);
    assert.equal(textOf(findAll(steps[0], 'gde-detail')[0]), 'PDF from the order page');
    const points = findAll(steps[1], 'gde-points')[0];
    assert.ok(points, 'a step with points draws the bullet list');
    const lis = points.children.filter((c) => isEl(c) && c.tag === 'li');
    assert.equal(lis.length, 2);
    assert.equal(textOf(lis[0]), 'Use the portal');
    assert.ok(env.linesCalls.includes('Use the portal'),
      'guide points render through renderLines, same as summary points — inline links stay clickable');
  });

  it('stored marks beat the payload seed', () => {
    const env = makeEnv();
    // Operator checked "Gather the invoice" earlier; the payload still says
    // "File the claim" — the store, not the seed, paints the checkmarks.
    env.ls.store.set('vi.guide.done', JSON.stringify({ [TASK.task_id!]: ['Gather the invoice'] }));
    const { node } = patternFns(env).guideSteps({ type: 'guide', items: DATA.items }, TASK);
    const checks = stepsOf(node!).map((s) => findAll(s, 'gde-check')[0]);
    assert.deepEqual(checks.map((c) => c.attrs['aria-checked']), ['true', 'false', 'false']);
    assert.equal(textOf(findAll(node!, 'gde-head')[0]), '1 of 3 done');
  });

  it('a tap toggles the mark, repaints head+bar, and persists to vi.guide.done', () => {
    const env = makeEnv();
    const api = patternFns(env);
    const { node } = api.guideSteps({ type: 'guide', items: DATA.items }, TASK);
    const steps = stepsOf(node!);
    const check0 = findAll(steps[0], 'gde-check')[0];
    check0.click();
    assert.equal(check0.attrs['aria-checked'], 'true');
    assert.equal(steps[0].attrs['class'], 'gde-step done');
    assert.equal(textOf(findAll(node!, 'gde-head')[0]), '2 of 3 done');
    assert.equal(findAll(node!, 'gde-bar')[0].attrs['value'], '2');
    const stored = JSON.parse(env.ls.store.get('vi.guide.done') || '{}')[TASK.task_id!];
    assert.ok(stored.includes('Gather the invoice'), 'the tap persisted');
  });

  it('unchecking a seeded default stays unchecked on the next render', () => {
    const env = makeEnv();
    const api = patternFns(env);
    const first = api.guideSteps({ type: 'guide', items: DATA.items }, TASK);
    findAll(stepsOf(first.node!)[1], 'gde-check')[0].click();
    // Second render: the key exists (empty list wins over the seed) — the
    // mutation that drops `|| seeded` fails here by resurrecting the step.
    const second = api.guideSteps({ type: 'guide', items: DATA.items }, TASK);
    const checks = stepsOf(second.node!).map((s) => findAll(s, 'gde-check')[0]);
    assert.deepEqual(checks.map((c) => c.attrs['aria-checked']), ['false', 'false', 'false']);
    assert.equal(textOf(findAll(second.node!, 'gde-head')[0]), '0 of 3 done');
  });

  it('a failed toggle leaves the control alone and says so', () => {
    const env = makeEnv();
    env.ls.failWrites = true;
    const api = patternFns(env);
    const { node } = api.guideSteps({ type: 'guide', items: DATA.items }, TASK);
    const steps = stepsOf(node!);
    const check0 = findAll(steps[0], 'gde-check')[0];
    check0.click();
    assert.equal(check0.attrs['aria-checked'], 'false', 'a write that never landed keeps the old state');
    assert.equal(steps[0].attrs['class'], 'gde-step');
    assert.ok(env.notices.some((n) => n.includes('Could not mark')));
  });

  it('a nameless item is skipped and an empty guide is {node: null}', () => {
    const api = patternFns(makeEnv());
    const { node } = api.guideSteps({ type: 'guide', items: [{}, { name: 'Only one' }] }, TASK);
    assert.ok(node);
    assert.equal(stepsOf(node!).length, 1);
    assert.equal(api.guideSteps({ type: 'guide', items: [{}] }, TASK).node, null);
    assert.deepEqual(api.renderGuide({ type: 'guide', items: [] }, TASK), []);
  });

  it('a repeated step name is one identity — the repaint covers every carrier and the head counts painted steps', () => {
    const env = makeEnv();
    const api = patternFns(env);
    // Marks key by NAME: two steps named 'Rest' are one identity. The paint
    // pass must repaint every step from the store (not only the tapped
    // node) and count painted steps, or the twin stays stale and the head
    // under-counts.
    const { node } = api.guideSteps({ type: 'guide', items: [
      { name: 'Rest', done: true },
      { name: 'Eat' },
      { name: 'Rest' },
    ] }, TASK);
    const steps = stepsOf(node!);
    const checks = steps.map((s) => findAll(s, 'gde-check')[0]);
    assert.deepEqual(checks.map((c) => c.attrs['aria-checked']), ['true', 'false', 'true'],
      'both Rest steps paint checked from the same seed mark');
    assert.equal(textOf(findAll(node!, 'gde-head')[0]), '2 of 3 done',
      'the head counts painted steps, not distinct names');
    checks[1].click(); // 'Eat' on → 3 of 3
    assert.equal(textOf(findAll(node!, 'gde-head')[0]), '3 of 3 done');
    assert.equal(findAll(node!, 'gde-bar')[0].attrs['value'], '3');
    checks[0].click(); // 'Rest' off → both twins repaint, head counts 1
    assert.deepEqual(checks.map((c) => c.attrs['aria-checked']), ['false', 'true', 'false'],
      'the untapped twin repaints off too');
    assert.equal(textOf(findAll(node!, 'gde-head')[0]), '1 of 3 done');
  });

  it('guide steps carry their own action rows through renderActionButtons', () => {
    const env = makeEnv();
    patternFns(env).guideSteps({ type: 'guide', items: [
      { name: 'Call the office', actions: [{ label: 'Call', kind: 'call', value: '+91…' }] },
    ] }, TASK);
    assert.equal(env.actionCalls.length, 1);
    assert.equal(env.actionCalls[0].name, 'Call the office');
  });
});

// -------------------------------------------------------------- summary ---

describe('P5 summary view', () => {
  const DATA = {
    type: 'summary',
    recommendation: 'The week in short',
    items: [
      { name: 'Money', summary: 'Two bills paid',
        points: ['Rent cleared on the 3rd', 'Electricity pending'] },
      { name: 'Health', attributes: { Steps: '62k', Sleep: '7h avg' } },
    ],
  };

  it('renders one .sum-card per item; points become bullets through renderLines', () => {
    const env = makeEnv();
    const { node, anchors } = patternFns(env).summarySections(DATA, TASK);
    assert.ok(node);
    const cards = findAll(node!, 'sum-card');
    assert.equal(cards.length, 2);
    const points = findAll(cards[0], 'sum-points')[0];
    const lis = points.children.filter((c) => isEl(c) && c.tag === 'li');
    assert.equal(lis.length, 2);
    assert.equal(textOf(lis[0]), 'Rent cleared on the 3rd');
    assert.ok(env.linesCalls.includes('Rent cleared on the 3rd'),
      'points render through renderLines — inline links stay clickable');
    assert.equal((anchors as Array<{ text: string; node: unknown }>)[1].node, cards[1]);
  });

  it('without points the attributes render as the .cmp-attrs dl through renderLines', () => {
    const env = makeEnv();
    const { node } = patternFns(env).summarySections(DATA, TASK);
    const cards = findAll(node!, 'sum-card');
    const dl = findAll(cards[1], 'cmp-attrs')[0];
    assert.ok(dl, 'an attribute section draws the shared dl');
    const dts = dl.children.filter((c) => isEl(c) && c.tag === 'dt');
    const dds = dl.children.filter((c) => isEl(c) && c.tag === 'dd');
    assert.deepEqual(dts.map(textOf), ['Steps', 'Sleep']);
    assert.deepEqual(dds.map(textOf), ['62k', '7h avg']);
    assert.ok(env.linesCalls.includes('62k'));
    assert.equal(findAll(cards[1], 'sum-points').length, 0);
  });

  it('itemPoints filters to non-empty strings only', () => {
    const api = patternFns(makeEnv());
    assert.deepEqual(api.itemPoints({ points: ['a', 3, ' ', null, 'b'] }), ['a', 'b']);
    assert.deepEqual(api.itemPoints({ points: 'nope' }), []);
    assert.deepEqual(api.itemPoints({}), []);
  });

  it('the detail line renders above the body; actions ride the shared row', () => {
    const env = makeEnv();
    const data = { ...DATA, items: [...DATA.items,
      { name: 'Calls', summary: 'One missed',
        actions: [{ label: 'Ring back', kind: 'task', prompt: 'call back' }] }] };
    const { node } = patternFns(env).summarySections(data, TASK);
    const cards = findAll(node!, 'sum-card');
    assert.equal(textOf(findAll(cards[0], 'sum-detail')[0]), 'Two bills paid');
    assert.equal(env.actionCalls.length, 3);
    assert.equal(env.actionCalls[2].name, 'Calls');
    assert.ok(findAll(cards[2], 'cmp-actions').length === 1);
  });

  it('attributes never print twice on one card — the lead line is prose-only when the dl renders them', () => {
    const api = patternFns(makeEnv());
    const { node } = api.summarySections({ type: 'summary', items: [
      { name: 'Health', attributes: { Steps: '62k', Sleep: '7h avg' } },
    ] }, TASK);
    const cards = findAll(node!, 'sum-card');
    assert.equal(findAll(cards[0], 'sum-detail').length, 0,
      'no attributes-as-lead line when the section already draws the dl');
    assert.equal(api.itemLeadLine({ name: 'x', attributes: { K: 'v' } }), '',
      'itemLeadLine never folds attributes in');
    assert.equal(api.itemDetailLine({ name: 'x', attributes: { K: 'v' } }), 'K: v',
      'the attrs-join stays the fallback for views with no dl');
  });

  it('skips unusable items; empty is {node: null}; renderSummary leads + falls through', () => {
    const api = patternFns(makeEnv());
    const { node } = api.summarySections({ type: 'summary', items: [{}, { name: 'Kept' }] }, TASK);
    assert.equal(findAll(node!, 'sum-card').length, 1);
    assert.equal(api.summarySections({ type: 'summary', items: [null] }, TASK).node, null);
    const nodes = api.renderSummary(DATA, TASK);
    assert.ok(nodes.some((n) => findAll(n, 'cmp-lead').length > 0));
    assert.deepEqual(api.renderSummary({ type: 'summary', items: [] }, TASK), []);
  });
});

// ------------------------------------------------------------- dispatch ---

describe('P5 dispatch (listing/guide/summary wiring)', () => {
  it('structuredDetail routes each pattern type to its view and propagates anchors', () => {
    const { api, calls } = dispatchFns();
    for (const [type, want] of [['listing', 'listingCards'], ['guide', 'guideSteps'],
                                ['summary', 'summarySections']] as const) {
      calls.length = 0;
      const detail = api.structuredDetail({ type }, TASK);
      assert.deepEqual(calls, [want], `${type} must dispatch to ${want}`);
      assert.equal(detail.nodes.length, 1, `${type} detail carries the view`);
      assert.equal(detail.anchors.length, 1, `${type} detail propagates the view's anchors`);
    }
  });

  it('a null pattern view yields empty nodes — the caller falls through to markdown', () => {
    const src = appSrc();
    const slice = sliceFrom(src, 'function structuredDetail(', 'const EMPTY_TIER', 'dispatch');
    const factory = new Function(
      'comparisonCards', 'renderFormSet', 'renderStructuredFallback', 'renderComparison',
      'listingCards', 'guideSteps', 'summarySections',
      'renderListing', 'renderGuide', 'renderSummary',
      `${slice}\n; return { structuredDetail };`
    );
    const api = factory(
      () => ({ node: makeEl('div', null), anchors: [] }),
      () => makeEl('div', null),
      () => [makeEl('p', null)],
      () => [makeEl('div', null)],
      () => ({ node: null, anchors: [] }), // listingCards: nothing usable
      () => ({ node: makeEl('div', null), anchors: [] }),
      () => ({ node: makeEl('div', null), anchors: [] }),
      () => [makeEl('div', null)], () => [makeEl('div', null)], () => [makeEl('div', null)],
    ) as { structuredDetail: Function };
    const detail = api.structuredDetail({ type: 'listing' }, TASK);
    assert.deepEqual(detail.nodes, [], 'an empty listing view is [] — markdown fallthrough, never a blank card');
    assert.deepEqual(detail.anchors, []);
  });

  it('renderStructuredAnswer switches each pattern type to its flat renderer', () => {
    const { api, calls } = dispatchFns();
    api.renderStructuredAnswer({ type: 'listing' }, TASK);
    api.renderStructuredAnswer({ type: 'guide' }, TASK);
    api.renderStructuredAnswer({ type: 'summary' }, TASK);
    assert.deepEqual(calls, ['renderListing', 'renderGuide', 'renderSummary']);
  });

  it('unknown types still fall through to the P1 fallback on both paths', () => {
    const { api, calls } = dispatchFns();
    api.renderStructuredAnswer({ type: 'mystery' }, TASK);
    assert.deepEqual(calls, ['renderStructuredFallback']);
    calls.length = 0;
    api.structuredDetail({ type: 'mystery' }, TASK);
    assert.deepEqual(calls, ['renderStructuredFallback']);
  });
});

// ------------------------------------------------------ known-bad control --

describe('P5 known-bad controls', () => {
  it('the dispatch matcher fails on a dispatch missing the pattern cases', () => {
    const src = appSrc();
    const body = sliceFrom(src, 'function renderStructuredAnswer(',
      'const EMPTY_TIER', 'flat dispatch');
    for (const t of ['listing', 'guide', 'summary']) {
      assert.ok(body.includes(`case '${t}':`), `renderStructuredAnswer must carry case '${t}'`);
    }
    const stub = "function renderStructuredAnswer(data, task) {\n" +
      "  switch (data.type) {\n" +
      "    case 'comparison': return renderComparison(data, task);\n" +
      "    default: return renderStructuredFallback(data);\n" +
      "  }\n" +
      "}";
    for (const t of ['listing', 'guide', 'summary']) {
      assert.equal(stub.includes(`case '${t}':`), false,
        `the same check must fail on a dispatch with no '${t}' case`);
    }
  });

  it('the store slice pins the shared key constants it ships', () => {
    const src = appSrc();
    const storeSlice = sliceFrom(src, 'const LS_SAVED',
      '/**\n * P3: the three action kinds', 'name-store block');
    assert.ok(storeSlice.includes("const LS_SAVED = 'vi.saved';"));
    assert.ok(storeSlice.includes("const LS_GUIDE_DONE = 'vi.guide.done';"));
    assert.ok(storeSlice.includes('const NAME_STORE_MAX_TASKS = 200;'));
  });
});
