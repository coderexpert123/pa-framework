/**
 * Form-set tests (answer-presentation P4, 2026-09-15): the PWA's interactive
 * form-set path — formsetSteps → formsetPath → renderFormSet → submitFormset —
 * plus the dispatch pins (structuredDetail / renderStructuredAnswer) and the
 * draft localStorage idiom.
 *
 * These execute the REAL function sources, sliced out of public/app.js (the
 * structured-answer.test.ts / comparison-renderer-behaviour.test.ts idiom)
 * with a stubbed h()/localStorage/setTimeout/document — a partial extraction
 * would test a copy, not the app, so each slice asserts its anchors resolved.
 *
 * APP_JS env var points the source reader at a different app.js — used by the
 * mutation proof (scratch/mutate-p4.mjs writes scratch/app-mutated.js), inert
 * otherwise. Node runs each test file in its own subprocess, so a set APP_JS
 * cannot bleed into sibling files.
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
 *  `\nfunction` heuristic: this block holds `const` declarations (sibling
 *  tests' boundary regex would clip them) and one `async function` (sibling
 *  tests' start anchor would drop the `async`). */
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
  files: unknown[];
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
    files: [],
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

/** All text under a node, joined — text nodes arrive as strings (h) or as
 *  {text} (document.createTextNode stub). */
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
function findBtn(root: FakeEl, label: string): FakeEl | undefined {
  return walk(root).find((e) => e.tag === 'button' && textOf(e) === label);
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
  // this-bound throughout: a test swaps `.store` to simulate the same device
  // across two factory instances — a closure-captured Map would make the
  // swap invisible (and that bug once hid a whole restore test).
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
  timers: Array<() => void>;
  notices: string[];
  calls: Array<Record<string, unknown>>;
  createTaskImpl: (args: Record<string, unknown>) => Promise<unknown>;
  refreshed: number;
  scrolled: number;
}

function makeEnv(): Env {
  return {
    ls: makeLS(),
    timers: [],
    notices: [],
    calls: [],
    createTaskImpl: async () => ({ ok: true }),
    refreshed: 0,
    scrolled: 0,
  };
}

interface FormsetApi {
  formsetSteps: (data: unknown) => unknown;
  formsetNextIndex: (steps: unknown[], index: number, answers: Record<string, string>) => number;
  formsetPath: (steps: unknown[], answers: Record<string, string>) => number[];
  formsetAnswersText: (steps: unknown[], answers: Record<string, string>, title: unknown, path: number[]) => string;
  submitFormset: (mode: string, steps: unknown[], answers: Record<string, string>, data: unknown, taskId: string) => Promise<string>;
  renderFormSet: (data: unknown, task: unknown) => FakeEl | null;
  readFormsetDraft: (taskId: string) => unknown;
  writeFormsetDraft: (taskId: string, draft: unknown) => boolean;
  sweepFormsetDrafts: () => void;
}

function formsetFns(env: Env): FormsetApi {
  const src = appSrc();
  // One contiguous block: consts → helpers → renderFormSet, inserted between
  // runShareAction and the comparisonCards doc comment.
  const slice = sliceFrom(src, 'const FORMSET_DRAFT_PREFIX',
    "/**\n * The comparison view's cards", 'formset block');
  for (const n of ['function formsetSteps(', 'async function submitFormset(',
    'function renderFormSet(', 'function formsetPath(', 'function formsetAnswersText(']) {
    assert.ok(slice.includes(n), `formset slice missing ${n}`);
  }
  const factory = new Function(
    'h', 'localStorage', 'setTimeout', 'document',
    'createTask', 'checkIcon', 'showNotice', 'refreshConversation', 'scrollFollowUpIntoView',
    `${slice}\n; return { formsetSteps, formsetNextIndex, formsetPath, formsetAnswersText, submitFormset, renderFormSet, readFormsetDraft, writeFormsetDraft, sweepFormsetDrafts };`
  );
  return factory(
    makeH(), env.ls,
    (fn: () => void) => { env.timers.push(fn); return 0; },
    { createTextNode: (t: string) => ({ text: t }) },
    (args: Record<string, unknown>) => { env.calls.push(args); return env.createTaskImpl(args); },
    () => makeEl('svg', null),
    (msg: unknown) => { env.notices.push(String(msg)); },
    () => { env.refreshed++; return Promise.resolve(); },
    () => { env.scrolled++; },
  ) as FormsetApi;
}

/** Dispatch fns (structuredDetail/renderStructuredAnswer) sliced with stubs
 *  for the renderers — the point under test is the WIRING, not the renders.
 *  `formSetResult` stubs renderFormSet's return — null exercises the
 *  fail-closed path back to the readable fallback. */
function dispatchFns(formSetResult: unknown = undefined) {
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
  const api = factory(
    () => { calls.push('comparisonCards'); return { node: makeEl('div', null), anchors: [] }; },
    () => { calls.push('renderFormSet'); return formSetResult === undefined ? makeEl('div', null) : formSetResult; },
    () => { calls.push('renderStructuredFallback'); return [makeEl('p', null)]; },
    () => { calls.push('renderComparison'); return [makeEl('div', null)]; },
    () => { calls.push('listingCards'); return { node: makeEl('div', null), anchors: [] }; },
    () => { calls.push('guideSteps'); return { node: makeEl('div', null), anchors: [] }; },
    () => { calls.push('summarySections'); return { node: makeEl('div', null), anchors: [] }; },
    () => { calls.push('renderListing'); return [makeEl('div', null)]; },
    () => { calls.push('renderGuide'); return [makeEl('div', null)]; },
    () => { calls.push('renderSummary'); return [makeEl('div', null)]; },
  ) as { structuredDetail: Function; renderStructuredAnswer: Function };
  return { api, calls };
}

// ------------------------------------------------------------- fixtures --

const TASK = { task_id: 'vi-abababababab' };

function choiceData(extra?: Record<string, unknown>) {
  return {
    type: 'form-set',
    title: 'Bank needs three things',
    steps: [
      { id: 'account', prompt: 'Which account?', options: [{ label: 'Savings' }, { label: 'Current' }] },
      { id: 'otp', prompt: 'OTP from the bank?', type: 'text' },
    ],
    ...extra,
  };
}

/** The .formset-stage child the renderer swaps per step. */
function stage(root: FakeEl): FakeEl {
  const s = findAll(root, 'formset-stage')[0];
  assert.ok(s, 'root must carry a .formset-stage');
  return s;
}
function progressText(root: FakeEl): string {
  const p = findAll(stage(root), 'formset-progress')[0];
  assert.ok(p, 'step must carry .formset-progress');
  return textOf(p);
}
function optionRows(root: FakeEl): FakeEl[] {
  return walk(stage(root)).filter((e) => e.attrs['role'] === 'radio');
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ------------------------------------------------------------ normaliser --

describe('formsetSteps (P4 normaliser)', () => {
  const api = formsetFns(makeEnv());

  it('normalises a minimal choice payload; type defaults to choice', () => {
    const steps = api.formsetSteps(choiceData()) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(steps) && steps.length === 2);
    assert.equal(steps[0].type, 'choice');
    assert.equal(steps[0].title, 'Which account?');
    assert.equal((steps[0].options as Array<{ label: string }>)[1].label, 'Current');
    assert.equal(steps[1].type, 'text');
  });

  it('accepts `title` when prompt is absent, and bare-string options', () => {
    const steps = api.formsetSteps({
      type: 'form-set',
      steps: [{ id: 's1', title: 'Pick one', options: ['A', 'B'] }],
    }) as Array<Record<string, unknown>>;
    assert.equal(steps[0].title, 'Pick one');
    assert.deepEqual(
      (steps[0].options as Array<{ label: string }>).map((o) => o.label), ['A', 'B']);
  });

  it('prompt wins over title when both are present', () => {
    const steps = api.formsetSteps({
      type: 'form-set',
      steps: [{ id: 's1', prompt: 'The question', title: 'fallback', options: ['A'] }],
    }) as Array<Record<string, unknown>>;
    assert.equal(steps[0].title, 'The question');
  });

  it('returns null on the malformed shapes the renderer cannot carry', () => {
    const bad = [
      {},
      { type: 'form-set' },
      { type: 'form-set', steps: [] },
      { type: 'form-set', steps: 'nope' },
      { type: 'form-set', steps: [42] },
      { type: 'form-set', steps: [{ prompt: 'no id' }] },
      { type: 'form-set', steps: [{ id: 'x' }] },                        // no question text
      { type: 'form-set', steps: [{ id: 'x', options: ['a'] }] },        // options, no question
      { type: 'form-set', steps: [{ id: 'x', prompt: '  ' }] },          // blank question
      { type: 'form-set', steps: [{ id: 'x', prompt: 'p', options: [] }] }, // no options
      { type: 'form-set', steps: [{ id: 'x', prompt: 'p' }, { id: 'x', prompt: 'p2', options: ['A'] }] }, // dup id
      { type: 'form-set', steps: [{ id: 'x', prompt: 'p', type: 'weird', options: ['A'] }] }, // unknown type
      { type: 'form-set', steps: [{ id: 'x', prompt: 'p', locked: true }] }, // locked, no answer
      { type: 'form-set', steps: [{ id: 'x', prompt: 'p', type: 7 }] },   // non-string type
      { type: 'form-set', steps: [{ id: 'x', prompt: 'p', type: 7, options: ['a'] }] }, // non-string type WITH options
      { type: 'form-set', steps: [{ id: 'BAD!', prompt: 'p', options: ['a'] }] }, // id outside the declared family
      { type: 'form-set', steps: [{ id: '__proto__', prompt: 'p', options: ['a'] }] }, // prototype-named id
      { type: 'form-set', steps: [{ id: 'a'.repeat(41), prompt: 'p', options: ['a'] }] }, // over-length id
    ];
    for (const d of bad) assert.equal(api.formsetSteps(d), null, JSON.stringify(d));
  });

  it('confirm defaults to Yes/No options; explicit options are honoured', () => {
    const steps = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'ok', prompt: 'Proceed?', type: 'confirm' },
        { id: 'sure', prompt: 'Really?', type: 'confirm', options: ['Do it', 'Stop'] },
      ],
    }) as Array<Record<string, unknown>>;
    assert.deepEqual((steps[0].options as Array<{ label: string }>).map((o) => o.label), ['Yes', 'No']);
    assert.deepEqual((steps[1].options as Array<{ label: string }>).map((o) => o.label), ['Do it', 'Stop']);
  });

  it('branch survives on choice/confirm/locked steps, is dropped on text/file', () => {
    const steps = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'c', prompt: 'p', options: ['A'], branch: { A: 't' } },
        { id: 'y', prompt: 'p', type: 'confirm', branch: { Yes: 't' } },
        { id: 'l', prompt: 'p', locked: true, answer: 'the-answer', branch: { 'the-answer': 't' } },
        { id: 't', prompt: 'p', type: 'text', branch: { anything: 't' } },
        { id: 'f', prompt: 'p', type: 'file', branch: { anything: 't' } },
      ],
    }) as Array<Record<string, unknown>>;
    // Null-prototype maps — '__proto__' is a legal option label, and a plain
    // object's setter swallows the write while its read hits Object.prototype
    // (truthy → silently falls through to declaration order: a valid branch
    // that never fires). Compare contents, not the literal.
    const b0 = steps[0].branch as Record<string, string>;
    const b1 = steps[1].branch as Record<string, string>;
    const b2 = steps[2].branch as Record<string, string>;
    assert.deepEqual({ ...b0 }, { A: 't' });
    assert.deepEqual({ ...b1 }, { Yes: 't' });
    assert.deepEqual({ ...b2 }, { 'the-answer': 't' });
    assert.equal(steps[3].branch, null);
    assert.equal(steps[4].branch, null);
  });
});

// ---------------------------------------------------------- derived path --

describe('formsetNextIndex / formsetPath (derived navigation)', () => {
  const api = formsetFns(makeEnv());
  const steps = api.formsetSteps({
    type: 'form-set',
    steps: [
      { id: 'a', prompt: 'A?', options: ['yes', 'no'], branch: { yes: 'c' } },
      { id: 'b', prompt: 'B?', options: ['b1', 'b2'] },
      { id: 'c', prompt: 'C?', options: ['c1'] },
    ],
  }) as Array<Record<string, unknown>>;

  it('a branch key on the answer jumps to the target step', () => {
    assert.equal(api.formsetNextIndex(steps, 0, { a: 'yes' }), 2);
    assert.equal(api.formsetNextIndex(steps, 0, { a: 'no' }), 1);
  });

  it('an unknown branch target falls back to declaration order', () => {
    const s = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['x'], branch: { x: 'ghost' } },
        { id: 'b', prompt: 'B?', options: ['y'] },
      ],
    }) as Array<Record<string, unknown>>;
    assert.equal(api.formsetNextIndex(s, 0, { a: 'x' }), 1);
  });

  it('a self-targeting branch ends the flow (never loops)', () => {
    const s = api.formsetSteps({
      type: 'form-set',
      steps: [{ id: 'a', prompt: 'A?', options: ['x'], branch: { x: 'a' } }],
    }) as Array<Record<string, unknown>>;
    assert.equal(api.formsetNextIndex(s, 0, { a: 'x' }), -1);
  });

  it('the path stops at the first unanswered step', () => {
    assert.deepEqual(api.formsetPath(steps, {}), [0]);
    assert.deepEqual(api.formsetPath(steps, { a: 'no' }), [0, 1]);
    assert.deepEqual(api.formsetPath(steps, { a: 'no', b: 'b1' }), [0, 1, 2]);
    assert.deepEqual(api.formsetPath(steps, { a: 'no', b: 'b1', c: 'c1' }), [0, 1, 2]);
  });

  it('a backward-pointing branch is terminal — A -> B -> A ends at the second A', () => {
    const s = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['go'] },
        { id: 'b', prompt: 'B?', options: ['back'], branch: { back: 'a' } },
        { id: 'c', prompt: 'C?', options: ['tail'] },
      ],
    }) as Array<Record<string, unknown>>;
    // answers complete: the walk visits a then b, and b's branch back to a
    // is terminal (the second A is a revisit — the path ends at b, c unreachable).
    assert.deepEqual(api.formsetPath(s, { a: 'go', b: 'back' }), [0, 1]);
    assert.deepEqual(api.formsetPath(s, { a: 'go' }), [0, 1]);
    // the guard is revisit-detection, not a length cap: a long acyclic path
    // walks every step.
    const acyclic = api.formsetSteps({
      type: 'form-set',
      steps: [0, 1, 2, 3, 4].map((i) => (
        { id: 's' + i, prompt: 'Q' + i + '?', options: ['x'] })),
    }) as Array<Record<string, unknown>>;
    assert.deepEqual(
      api.formsetPath(acyclic, { s0: 'x', s1: 'x', s2: 'x', s3: 'x', s4: 'x' }),
      [0, 1, 2, 3, 4]);
  });

  it('changing a prior answer prunes its stale trail', () => {
    // 'yes' branches past b to c; flip to 'no' and c's answer is a dead leaf.
    assert.deepEqual(api.formsetPath(steps, { a: 'yes', c: 'c1' }), [0, 2]);
    assert.deepEqual(api.formsetPath(steps, { a: 'no', c: 'c1' }), [0, 1]);
  });

  it('a __proto__ option label still fires its branch', () => {
    // Server-valid payload: a legal label + matching key. A plain-object
    // branch map would swallow the write and read Object.prototype instead —
    // the branch must land on 'c' (index 2), not fall through to 'b'.
    // JSON.parse (what real payloads go through) DOES create an own
    // '__proto__' property. An object LITERAL never does — `__proto__: v`
    // with a non-object value is a silent no-op — so the fixture must be
    // parsed from a raw string, not round-tripped through a literal.
    const s = api.formsetSteps(JSON.parse(
      '{"type":"form-set","steps":[' +
      '{"id":"a","prompt":"A?","options":["__proto__","x"],"branch":{"__proto__":"c"}},' +
      '{"id":"b","prompt":"B?","options":["y"]},' +
      '{"id":"c","prompt":"C?","options":["z"]}]}')) as Array<Record<string, unknown>>;
    assert.equal(api.formsetNextIndex(s, 0, { a: '__proto__' }), 2);
    assert.equal(api.formsetNextIndex(s, 0, { a: 'x' }), 1); // declaration order
    // 'constructor' on a plain map is inherited (a function, not a step id)
    // — the lookup must miss cleanly, not treat it as a target.
    const s2 = api.formsetSteps(JSON.parse(
      '{"type":"form-set","steps":[' +
      '{"id":"a","prompt":"A?","options":["constructor","x"],"branch":{"constructor":"c"}},' +
      '{"id":"b","prompt":"B?","options":["y"]},' +
      '{"id":"c","prompt":"C?","options":["z"]}]}')) as Array<Record<string, unknown>>;
    assert.equal(api.formsetNextIndex(s2, 0, { a: 'constructor' }), 2);
  });

  it('a locked step counts as answered by its own answer', () => {
    const s = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'l', prompt: 'Known', locked: true, answer: 'it is known' },
        { id: 'q', prompt: 'Q?', options: ['a'] },
      ],
    }) as Array<Record<string, unknown>>;
    assert.deepEqual(api.formsetPath(s, {}), [0, 1]);
  });
});

// --------------------------------------------------------- answers text ---

describe('formsetAnswersText (the submission body)', () => {
  const api = formsetFns(makeEnv());

  it('emits title + one "Question: answer" line per VISITED step only', () => {
    const steps = api.formsetSteps({
      type: 'form-set',
      title: 'Bank needs things',
      steps: [
        { id: 'a', prompt: 'A?', options: ['yes', 'no'], branch: { yes: 'c' } },
        { id: 'b', prompt: 'B?', options: ['b1'] },
        { id: 'c', prompt: 'C?', options: ['c1'] },
      ],
    }) as Array<Record<string, unknown>>;
    const answers = { a: 'yes', c: 'c1' };
    const path = api.formsetPath(steps, answers);
    const text = api.formsetAnswersText(steps, answers, 'Bank needs things', path);
    assert.equal(text, 'Bank needs things\nA?: yes\nC?: c1');
    // a stale answer on an unvisited step stays out of the submission —
    // the 'yes' branch jumps a→c, so b is skipped: its recorded answer
    // (left over from an earlier traversal) must not appear.
    const stale = { a: 'yes', b: 'b1', c: 'c1' };
    const path2 = api.formsetPath(steps, stale);
    assert.deepEqual(path2, [0, 2]);
    assert.equal(api.formsetAnswersText(steps, stale, undefined, path2), 'A?: yes\nC?: c1');
  });

  it('locked steps appear in the text (they are answers too)', () => {
    const steps = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'l', prompt: 'Known', locked: true, answer: 'it is known' },
        { id: 'q', prompt: 'Q?', options: ['a'] },
      ],
    }) as Array<Record<string, unknown>>;
    const path = api.formsetPath(steps, { q: 'a' });
    const text = api.formsetAnswersText(steps, { q: 'a' }, undefined, path);
    assert.equal(text, 'Known: it is known\nQ?: a');
  });
});

// ------------------------------------------------------------ submit -----

describe('submitFormset (three modes)', () => {
  it('create-task mode sends feedback_about + the answers text', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const steps = api.formsetSteps(choiceData()) as unknown[];
    const result = await api.submitFormset('create-task', steps,
      { account: 'Savings', otp: '123456' }, choiceData(), TASK.task_id);
    assert.equal(result, 'sent');
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].feedbackAbout, TASK.task_id);
    assert.equal(env.calls[0].continuesTaskId, undefined);
    assert.equal(env.calls[0].text,
      'Bank needs three things\nWhich account?: Savings\nOTP from the bank?: 123456');
  });

  it('update-conversation mode sends continues, never feedback_about', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const steps = api.formsetSteps(choiceData()) as unknown[];
    const result = await api.submitFormset('update-conversation', steps,
      { account: 'Savings', otp: '1' }, choiceData(), TASK.task_id);
    assert.equal(result, 'continued');
    assert.equal(env.calls[0].continuesTaskId, TASK.task_id);
    assert.equal(env.calls[0].feedbackAbout, undefined);
  });

  it('save-only writes the done-marked draft and never calls createTask', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const steps = api.formsetSteps(choiceData()) as unknown[];
    const result = await api.submitFormset('save-only', steps,
      { account: 'Savings', otp: '1' }, choiceData(), TASK.task_id);
    assert.equal(result, 'saved');
    assert.equal(env.calls.length, 0);
    const draft = api.readFormsetDraft(TASK.task_id) as Record<string, unknown>;
    assert.ok(draft && draft.done === true);
    assert.deepEqual(draft.answers, { account: 'Savings', otp: '1' });
  });

  it('save-only + a staged file is blocked, not silently dropped', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const steps = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['x'] },
        { id: 'f', prompt: 'Attach', type: 'file' },
      ],
    }) as unknown[];
    // stage a file by driving the real renderer's change listener
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['x'] },
        { id: 'f', prompt: 'Attach', type: 'file' },
      ],
    }, TASK)!;
    optionRows(root)[0].click();          // answer a
    for (const t of env.timers.splice(0)) t();
    const fileInput = walk(stage(root)).find((e) => e.attrs['type'] === 'file')!;
    fileInput.files = [{ name: 'po.pdf' }];
    for (const fn of fileInput.listeners['change'] ?? []) fn();
    const result = await api.submitFormset('save-only', steps,
      { a: 'x', f: 'po.pdf' }, { type: 'form-set' }, TASK.task_id);
    assert.equal(result, 'blocked');
    assert.equal(env.calls.length, 0);
  });

  it('task modes pass staged files through to createTask', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [{ id: 'f', prompt: 'Attach', type: 'file' }],
    }, TASK)!;
    const fileInput = walk(stage(root)).find((e) => e.attrs['type'] === 'file')!;
    const file = { name: 'po.pdf' };
    fileInput.files = [file];
    for (const fn of fileInput.listeners['change'] ?? []) fn();
    const steps = api.formsetSteps({ type: 'form-set', steps: [{ id: 'f', prompt: 'Attach', type: 'file' }] }) as unknown[];
    const result = await api.submitFormset('create-task', steps, { f: 'po.pdf' },
      { type: 'form-set' }, TASK.task_id);
    assert.equal(result, 'sent');
    assert.deepEqual(env.calls[0].files, [file]);
  });

  it('a createTask failure reports failed, never throws', async () => {
    const env = makeEnv();
    env.createTaskImpl = async () => { throw new Error('network down'); };
    const api = formsetFns(env);
    const steps = api.formsetSteps(choiceData()) as unknown[];
    const result = await api.submitFormset('create-task', steps,
      { account: 'Savings', otp: '1' }, choiceData(), TASK.task_id);
    assert.equal(result, 'failed');
  });

  it('save-only with a dead localStorage reports failed, never throws', async () => {
    const env = makeEnv();
    env.ls.failWrites = true;
    const api = formsetFns(env);
    const steps = api.formsetSteps(choiceData()) as unknown[];
    const result = await api.submitFormset('save-only', steps,
      { account: 'Savings', otp: '1' }, choiceData(), TASK.task_id);
    assert.equal(result, 'failed');
  });

  it('the save-only record never keeps a file name without its File', async () => {
    // Off-path file step: staged once, then a changed earlier answer pruned
    // it — the done draft must not claim an attachment that does not exist
    // (the phantom-filename rule the renderer already enforces on restore).
    const env = makeEnv();
    const api = formsetFns(env);
    const steps = api.formsetSteps({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['x', 'skip'], branch: { skip: 'end' } },
        { id: 'f', prompt: 'Attach', type: 'file' },
        { id: 'end', prompt: 'Done?', options: ['y'] },
      ],
    }) as unknown[];
    const result = await api.submitFormset('save-only', steps,
      { a: 'skip', f: 'ghost.pdf', end: 'y' }, { type: 'form-set' }, TASK.task_id);
    assert.equal(result, 'saved');
    const draft = api.readFormsetDraft(TASK.task_id) as Record<string, unknown>;
    const rec = draft.answers as Record<string, string>;
    assert.equal(rec.f, undefined, 'a file name without its File is never recorded');
    assert.equal(rec.end, 'y');
  });

  it('a done draft suppresses a second in-flight submit — no duplicate task', async () => {
    // Rebuild landing mid-send: the detached copy's submitFormset wrote
    // done:true; the rebuilt card (restored from the pre-done draft) can
    // still reach Submit. The second submit must no-op, not file a twin.
    const env = makeEnv();
    const api = formsetFns(env);
    const steps = api.formsetSteps(choiceData()) as unknown[];
    const answers = { account: 'Savings', otp: '1' };
    const first = await api.submitFormset('create-task', steps, answers, choiceData(), TASK.task_id);
    assert.equal(first, 'sent');
    assert.equal(env.calls.length, 1);
    // doSubmit's post-success write — what the detached copy lands.
    api.writeFormsetDraft(TASK.task_id, { answers, at: 1, done: true, updatedAt: Date.now() });
    const again = await api.submitFormset('create-task', steps, answers, choiceData(), TASK.task_id);
    assert.equal(again, 'sent', 'a done draft is the receipt — report sent, send nothing');
    assert.equal(env.calls.length, 1, 'no duplicate task');
  });

  it('save-only on a taskless card fails rather than writing a dead key', async () => {
    // task_id '' → the read side is taskId-guarded, so a draft written under
    // 'vi.formset.' could never be restored — 'saved' would lie. Fail instead.
    const env = makeEnv();
    const api = formsetFns(env);
    const steps = api.formsetSteps(choiceData()) as unknown[];
    const result = await api.submitFormset('save-only', steps,
      { account: 'Savings', otp: '1' }, choiceData(), '');
    assert.equal(result, 'failed');
    assert.equal(env.ls.store.size, 0, 'no phantom vi.formset. key written');
  });
});

// ------------------------------------------------------------ render -----

describe('renderFormSet (the interactive flow)', () => {
  it('renders step 1 with its options; malformed payloads return null', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    assert.ok(root);
    assert.equal(progressText(root), 'Step 1 of 2');
    assert.equal(optionRows(root).length, 2);
    assert.equal(api.renderFormSet({ type: 'form-set', steps: [] }, TASK), null);
    assert.equal(api.renderFormSet({ type: 'form-set', steps: [{ id: 'x' }] }, TASK), null);
  });

  it('a tap checks the option, then slides to the next step ~200ms later', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    const rows = optionRows(root);
    rows[0].click();
    // the fresh node already shows the selection…
    assert.equal(optionRows(root)[0].attrs['aria-checked'], 'true');
    // …but the view is still step 1 until the timer fires
    assert.equal(progressText(root), 'Step 1 of 2');
    assert.equal(env.timers.length, 1);
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 2 of 2');
    assert.ok(textOf(stage(root)).includes('OTP from the bank?'));
  });

  it('a pending tap hop dies when the operator navigates first', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['1', '2'] },
        { id: 'b', prompt: 'B?', options: ['x', 'y'] },
        { id: 'c', prompt: 'C?', options: ['z'] },
      ],
    }, TASK)!;
    optionRows(root)[0].click();                    // answer a, hop to b
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 2 of 3');
    optionRows(root)[0].click();                    // answer b — a hop arms
    assert.equal(env.timers.length, 1);
    findBtn(root, 'Back')!.click();                 // …but the operator goes Back first
    assert.equal(progressText(root), 'Step 1 of 3');
    for (const t of env.timers.splice(0)) t();      // the stale hop must stay dead
    assert.equal(progressText(root), 'Step 1 of 3',
      'a superseded tap hop must not drag the operator forward again');
  });

  it('a rebuild kills a pending hop — the detached timer never submits', () => {
    // The turn log's teardown/rebuild runs renderFormSet again on the same
    // task. A tap armed on the DETACHED copy must die with it — without the
    // per-task generation guard its timer still fires advance()→doSubmit()
    // behind the rebuilt card's back: a duplicate task the operator never
    // sent (the factory shares the module-level formSetGenerations map, so
    // two renderFormSet calls on one env see each other exactly as the app's
    // rebuild does).
    const env = makeEnv();
    const api = formsetFns(env);
    const data = {
      type: 'form-set',
      steps: [{ id: 'a', prompt: 'A?', options: ['x'] }],
    };
    const root = api.renderFormSet(data, TASK)!;
    optionRows(root)[0].click();                 // hop armed on the old render
    assert.equal(env.timers.length, 1);
    api.renderFormSet(data, TASK);               // the rebuild — old copy detaches
    for (const t of env.timers.splice(0)) t();   // the stale timer fires…
    assert.equal(env.calls.length, 0, 'a detached hop must never submit');
    // …and the rebuilt card is a working form, not a corpse
    const root2 = api.renderFormSet(data, TASK)!;
    optionRows(root2)[0].click();
    for (const t of env.timers.splice(0)) t();
    assert.equal(env.calls.length, 1, 'the rebuilt card still submits');
  });

  it('a second tap inside the window re-selects and hops ONCE, not twice', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['1', '2'] },
        { id: 'b', prompt: 'B?', options: ['x', 'y'] },
        { id: 'c', prompt: 'C?', options: ['z'] },
      ],
    }, TASK)!;
    optionRows(root)[0].click();              // tap "1"
    optionRows(root)[1].click();              // change mind to "2" <200ms
    assert.equal(env.timers.length, 2);       // two timers armed, first is dead
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 2 of 3'); // landed on b, not past it
    // and the answer kept is the second tap
    assert.equal(optionRows(root).length, 2); // step b's own options render
  });

  it('Back walks the derived path; Next on an answered step moves forward', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['1'] },
        { id: 'b', prompt: 'B?', options: ['x'] },
      ],
    }, TASK)!;
    optionRows(root)[0].click();
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 2 of 2');
    const back = findBtn(root, 'Back')!;
    assert.ok(back && back.attrs['disabled'] === undefined, 'Back enabled mid-flow');
    back.click();
    assert.equal(progressText(root), 'Step 1 of 2');
    const next = findBtn(root, 'Next') ?? findBtn(root, 'Submit');
    // step 1 is already answered — Next is enabled and walks forward again
    assert.ok(next, 'a forward control must exist');
    next!.click();
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 2 of 2');
  });

  it('Back on the first step is disabled', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    const back = findBtn(root, 'Back')!;
    assert.ok(back.attrs['disabled'] !== undefined, 'Back must start disabled');
  });

  it('a backward branch submits at the revisit, not re-navigates', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['go'] },
        { id: 'b', prompt: 'B?', options: ['back'], branch: { back: 'a' } },
      ],
    }, TASK)!;
    optionRows(root)[0].click();                 // a answered
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 2 of 2');
    // b's forward hop points BACK at a — the step is terminal, so the
    // forward control is Submit (disabled until answered), never Next.
    assert.ok(findBtn(root, 'Submit'), 'a backward-terminal step shows Submit');
    assert.equal(findBtn(root, 'Next'), undefined);
    optionRows(root)[0].click();                 // b: 'back' -> a
    for (const t of env.timers.splice(0)) t();
    await tick(); await tick();
    // the backward hop was terminal: submit ran, done state drawn
    assert.ok(findAll(root, 'formset-done').length === 1, 'done state after backward-branch submit');
    assert.equal(env.calls.length, 1);
  });

  it('a restored step whose next hop is backward offers Submit, not Next', () => {
    const env = makeEnv();
    env.ls.setItem('vi.formset.' + TASK.task_id, JSON.stringify({
      answers: { a: 'go', b: 'back' }, at: 1, done: false, updatedAt: Date.now(),
    }));
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['go'] },
        { id: 'b', prompt: 'B?', options: ['back'], branch: { back: 'a' } },
        { id: 'c', prompt: 'C?', options: ['tail'] },
      ],
    }, TASK)!;
    // b is answered and its branch points back at a — the only honest
    // forward control is Submit (a Next would re-walk visited ground).
    assert.equal(progressText(root), 'Step 2 of 3');
    assert.ok(findBtn(root, 'Submit'), 'backward-terminal restored step shows Submit');
    assert.equal(findBtn(root, 'Next'), undefined);
  });

  it('changing an earlier answer prunes the trail and still walks forward', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['yes', 'no'], branch: { yes: 'c' } },
        { id: 'b', prompt: 'B?', options: ['b1'] },
        { id: 'c', prompt: 'C?', options: ['c1'] },
      ],
    }, TASK)!;
    optionRows(root)[0].click();                 // a=yes -> c
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 3 of 3'); // c
    findBtn(root, 'Back')!.click();
    assert.equal(progressText(root), 'Step 1 of 3'); // back to a (path [0,2] pos 1 -> 0)
    optionRows(root)[1].click();                 // change a to 'no'
    for (const t of env.timers.splice(0)) t();
    assert.equal(progressText(root), 'Step 2 of 3'); // now lands on b
  });

  it('Submit sends and draws the done state; draft is marked done', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    optionRows(root)[0].click();
    for (const t of env.timers.splice(0)) t();
    const input = walk(stage(root)).find((e) => e.tag === 'input')!;
    input.value = '123456';
    for (const fn of input.listeners['input'] ?? []) fn();
    const submit = findBtn(root, 'Submit')!;
    assert.equal(submit.disabled, false);
    submit.click();
    await tick(); await tick(); await tick();
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].feedbackAbout, TASK.task_id);
    assert.ok(findAll(root, 'formset-done').length === 1);
    assert.ok(env.notices.includes('Sent.'));
    const draft = api.readFormsetDraft(TASK.task_id) as Record<string, unknown>;
    assert.equal(draft.done, true);
  });

  it('Submit is disabled until the step is answered; text input enables it', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [{ id: 't', prompt: 'Type it', type: 'text' }],
    }, TASK)!;
    const submit = findBtn(root, 'Submit')!;
    assert.ok(submit.attrs['disabled'] !== undefined || submit.disabled === true);
    const input = walk(stage(root)).find((e) => e.tag === 'input')!;
    input.value = 'answer';
    for (const fn of input.listeners['input'] ?? []) fn();
    assert.equal(submit.disabled, false);
    input.value = '';
    for (const fn of input.listeners['input'] ?? []) fn();
    assert.equal(submit.disabled, true);
  });

  it('Submit early appears only with submit_early + an answered step, and sends', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set', title: 'Bank needs three things', submit_early: true,
      steps: [
        { id: 'account', prompt: 'Which account?', options: [{ label: 'Savings' }, { label: 'Current' }] },
        { id: 'otp', prompt: 'OTP?', type: 'text' },
        { id: 'done', prompt: 'All set?', type: 'confirm' },
      ],
    }, TASK)!;
    assert.equal(findBtn(root, 'Submit early'), undefined, 'nothing answered yet');
    optionRows(root)[0].click();
    for (const t of env.timers.splice(0)) t();
    const early = findBtn(root, 'Submit early')!;
    assert.ok(early, 'early submit visible once a step is answered mid-flow');
    early.click();
    await tick(); await tick(); await tick();
    assert.equal(env.calls.length, 1);
    assert.ok(findAll(root, 'formset-done').length === 1);
    // the partial submission carries only visited answers
    assert.equal(env.calls[0].text, 'Bank needs three things\nWhich account?: Savings');
  });

  it('Submit early is absent on the last step (Submit is right there)', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData({ submit_early: true }), TASK)!;
    optionRows(root)[0].click();
    for (const t of env.timers.splice(0)) t();
    assert.ok(findBtn(root, 'Submit'), 'last step submits directly');
    assert.equal(findBtn(root, 'Submit early'), undefined);
  });

  it('double-submit is one send (the submitting flag)', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set', submit_early: true,
      steps: [
        { id: 'a', prompt: 'A?', options: ['x'] },
        { id: 'b', prompt: 'B?', type: 'text' },
        { id: 'c', prompt: 'C?', options: ['z'] },
      ],
    }, TASK)!;
    optionRows(root)[0].click();
    for (const t of env.timers.splice(0)) t();
    const early = findBtn(root, 'Submit early')!;
    early.click();
    early.click();           // a second tap inside the in-flight send
    await tick(); await tick(); await tick();
    assert.equal(env.calls.length, 1, 'one send despite two submits');
    assert.equal(early.disabled, true);
  });

  it('a failed send re-enables the control and shows the send notice', async () => {
    const env = makeEnv();
    env.createTaskImpl = async () => { throw new Error('down'); };
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set', steps: [{ id: 'a', prompt: 'A?', options: ['x'] }],
    }, TASK)!;
    const submit = findBtn(root, 'Submit')!;
    submit.click();
    await tick(); await tick(); await tick();
    assert.ok(env.notices.includes('Could not send — try again.'));
    assert.equal(submit.disabled, false);
  });

  it('update-conversation mode refreshes + scrolls the follow-up into view', async () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData({ submit: 'update-conversation' }), TASK)!;
    optionRows(root)[0].click();
    for (const t of env.timers.splice(0)) t();
    const input = walk(stage(root)).find((e) => e.tag === 'input')!;
    input.value = '1';
    for (const fn of input.listeners['input'] ?? []) fn();
    findBtn(root, 'Submit')!.click();
    await tick(); await tick(); await tick(); await tick();
    assert.equal(env.calls[0].continuesTaskId, TASK.task_id);
    assert.equal(env.refreshed, 1);
    assert.equal(env.scrolled, 1);
  });
});

// ------------------------------------------------------------- drafts ----

describe('formset drafts (vi.formset. idiom)', () => {
  it('a mid-flow draft restores answers and the view pointer', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    optionRows(root)[0].click();                      // answer + persist(at=0)
    for (const t of env.timers.splice(0)) t();        // the slide lands step 2
    const draft = api.readFormsetDraft(TASK.task_id) as Record<string, unknown>;
    assert.ok(draft, 'draft written on tap');
    assert.deepEqual(draft.answers, { account: 'Savings' });
    assert.equal(draft.at, 1, 'the view pointer persists with the answers');
    // a fresh render (rebuild/reload) resumes mid-flow
    const env2 = makeEnv();
    env2.ls.store = env.ls.store;                     // same device
    const api2 = formsetFns(env2);
    const root2 = api2.renderFormSet(choiceData(), TASK)!;
    assert.equal(progressText(root2), 'Step 2 of 2');
    assert.ok(textOf(stage(root2)).includes('OTP from the bank?'));
  });

  it('a draft view pointer on a pruned step falls back to the furthest point', () => {
    const env = makeEnv();
    // at=1 points at a step the current answers cannot reach (nothing
    // answered → path is [0]) — the restore must clamp, not trust it.
    env.ls.setItem('vi.formset.' + TASK.task_id, JSON.stringify({
      answers: {}, at: 1, done: false, updatedAt: Date.now(),
    }));
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    assert.equal(progressText(root), 'Step 1 of 2');
  });

  it('a done draft renders the completion state, never the form', () => {
    const env = makeEnv();
    env.ls.setItem('vi.formset.' + TASK.task_id, JSON.stringify({
      answers: { account: 'Savings' }, at: 0, done: true, updatedAt: Date.now(),
    }));
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    assert.ok(findAll(root, 'formset-done').length === 1);
    assert.equal(optionRows(root).length, 0);
  });

  it('a restored save-only done draft says saved, not sent', () => {
    const env = makeEnv();
    env.ls.setItem('vi.formset.' + TASK.task_id, JSON.stringify({
      answers: { account: 'Savings' }, at: 0, done: true, updatedAt: Date.now(),
    }));
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData({ submit: 'save-only' }), TASK)!;
    const done = findAll(root, 'formset-done')[0];
    assert.ok(done, 'the done card must render');
    assert.ok(textOf(done).includes('saved on this device'),
      'a record that never left the device must not claim it was sent');
  });

  it('a corrupt draft reads as no draft (fail-closed)', () => {
    const env = makeEnv();
    env.ls.setItem('vi.formset.' + TASK.task_id, '{not json');
    env.ls.setItem('vi.formset.other', JSON.stringify(['array-is-bad']));
    const api = formsetFns(env);
    assert.equal(api.readFormsetDraft(TASK.task_id), null);
    const root = api.renderFormSet(choiceData(), TASK)!;
    assert.equal(progressText(root), 'Step 1 of 2');
  });

  it('a restored file answer is dropped — the File object is per-page', () => {
    const env = makeEnv();
    env.ls.setItem('vi.formset.' + TASK.task_id, JSON.stringify({
      answers: { f: 'ghost.pdf' }, at: 0, done: false, updatedAt: Date.now(),
    }));
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set', steps: [{ id: 'f', prompt: 'Attach', type: 'file' }],
    }, TASK)!;
    assert.ok(textOf(stage(root)).includes('No file chosen'),
      'a filename without its File must ask again');
  });

  it('a ghost preselected on a choice step is dropped, not applied', () => {
    // Validator-bypassed payload: preselected names no option. Applying it
    // writes an answer the operator never made — and for choice it even shows
    // in the escape lane as if typed. The second net drops it.
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [{ id: 'a', prompt: 'A?', options: ['x', 'y'], preselected: 'ghost' }],
    }, TASK)!;
    assert.equal(progressText(root), 'Step 1 of 1', 'still the first unanswered step');
    for (const row of optionRows(root)) {
      assert.equal(row.attrs['aria-checked'], 'false', 'no option may light up for a ghost');
    }
    const draft = api.readFormsetDraft(TASK.task_id) as Record<string, unknown>;
    assert.equal((draft.answers as Record<string, string>).a, undefined);
    // a preselected that DOES name an option still applies
    const env2 = makeEnv();
    const api2 = formsetFns(env2);
    const root2 = api2.renderFormSet({
      type: 'form-set',
      steps: [{ id: 'a', prompt: 'A?', options: ['x', 'y'], preselected: 'y' },
              { id: 'b', prompt: 'B?', type: 'text' }],
    }, TASK)!;
    assert.equal(progressText(root2), 'Step 2 of 2');
  });

  it('preselected fills an unanswered step, loses to a draft answer', () => {    const data = {
      type: 'form-set',
      steps: [
        { id: 'a', prompt: 'A?', options: ['x', 'y'], preselected: 'y' },
        { id: 'b', prompt: 'B?', type: 'text' },
      ],
    };
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(data, TASK)!;
    assert.equal(progressText(root), 'Step 2 of 2'); // a counts answered (preselected)
    const env2 = makeEnv();
    env2.ls.setItem('vi.formset.' + TASK.task_id, JSON.stringify({
      answers: { a: 'x' }, at: 0, done: false, updatedAt: Date.now(),
    }));
    const api2 = formsetFns(env2);
    const root2 = api2.renderFormSet(data, TASK)!;
    const rows = optionRows(root2);
    assert.equal(rows[0].attrs['aria-checked'], 'true'); // draft's 'x' wins
    assert.equal(rows[1].attrs['aria-checked'], 'false');
  });

  it('drafts older than 30 days sweep; fresh ones survive', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const old = { answers: {}, at: 0, done: false, updatedAt: Date.now() - 31 * 24 * 3600 * 1000 };
    const fresh = { answers: {}, at: 0, done: false, updatedAt: Date.now() };
    env.ls.setItem('vi.formset.old', JSON.stringify(old));
    env.ls.setItem('vi.formset.fresh', JSON.stringify(fresh));
    env.ls.setItem('vi.saved.untouched', '{}');
    api.sweepFormsetDrafts();
    assert.equal(env.ls.getItem('vi.formset.old'), null);
    assert.ok(env.ls.getItem('vi.formset.fresh') !== null);
    assert.ok(env.ls.getItem('vi.saved.untouched') !== null, 'other prefixes never swept');
  });

  it('a staged file is removable — the control the blocked notice names', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet({
      type: 'form-set',
      steps: [{ id: 'f', prompt: 'Attach', type: 'file' }],
    }, TASK)!;
    const removeBtn = findBtn(root, 'Remove')!;
    assert.ok(removeBtn, 'a file step must offer Remove');
    assert.ok(removeBtn.attrs['hidden'] !== undefined, 'hidden until a file is staged');
    const fileInput = walk(stage(root)).find((e) => e.attrs['type'] === 'file')!;
    fileInput.files = [{ name: 'po.pdf' }];
    for (const fn of fileInput.listeners['change'] ?? []) fn();
    assert.equal(removeBtn.hidden, false, 'Remove appears once a file is staged');
    removeBtn.click();
    assert.equal(removeBtn.hidden, true, 'Remove hides again after detach');
    const draft = api.readFormsetDraft(TASK.task_id) as Record<string, unknown>;
    assert.equal((draft.answers as Record<string, string>).f, undefined,
      'the detached file leaves no answer behind');
    const submit = findBtn(root, 'Submit')!;
    assert.equal(submit.disabled, true, 'Submit re-disables once the only answer is gone');
  });

  it('the escape field accepts a typed answer on a choice step', () => {
    const env = makeEnv();
    const api = formsetFns(env);
    const root = api.renderFormSet(choiceData(), TASK)!;
    const escape = walk(stage(root)).find(
      (e) => e.tag === 'input' && String(e.attrs['class'] ?? '').includes('form-escape'))!;
    assert.ok(escape, 'choice step carries an escape field');
    escape.value = 'Joint account';
    for (const fn of escape.listeners['input'] ?? []) fn();
    for (const t of env.timers.splice(0)) t();
    const draft = api.readFormsetDraft(TASK.task_id) as Record<string, unknown>;
    assert.deepEqual(draft.answers, { account: 'Joint account' });
    // typing into the escape lane unchecks the option rows — one answer, one
    // visual state
    for (const row of optionRows(root)) {
      assert.equal(row.attrs['aria-checked'], 'false', 'escape text must uncheck the option');
    }
  });
});

// ----------------------------------------------------------- dispatch ----

describe('form-set dispatch (P4 wiring)', () => {
  it('structuredDetail routes form-set to renderFormSet, null falls back', () => {
    const { api, calls } = dispatchFns();
    const detail = api.structuredDetail({ type: 'form-set' }, TASK);
    assert.deepEqual(calls, ['renderFormSet']);
    assert.ok(Array.isArray(detail.nodes) && detail.nodes.length === 1);
    assert.deepEqual(detail.anchors, []);
    // renderFormSet returning null falls through to the readable fallback —
    // the malformed-payload safety net (a half-built decision tree never
    // renders; the P1 list does).
    const { api: api2, calls: calls2 } = dispatchFns(null);
    const detail2 = api2.structuredDetail({ type: 'form-set' }, TASK);
    assert.deepEqual(calls2, ['renderFormSet', 'renderStructuredFallback'],
      'a null render must reach the fallback');
    assert.equal(detail2.nodes.length, 1);
  });

  it('renderStructuredAnswer switches form-set to renderFormSet, null falls back', () => {
    const { api, calls } = dispatchFns();
    api.renderStructuredAnswer({ type: 'form-set' }, TASK);
    assert.deepEqual(calls, ['renderFormSet']);
    api.renderStructuredAnswer({ type: 'comparison' }, TASK);
    assert.deepEqual(calls, ['renderFormSet', 'renderComparison']);
    api.renderStructuredAnswer({ type: 'listing' }, TASK);
    assert.deepEqual(calls, ['renderFormSet', 'renderComparison', 'renderListing']);
    // Unknown types still reach the P1 fallback (P5: listing has its own
    // renderer now — the fallback pin lives in pattern-renderers.test.ts).
    api.renderStructuredAnswer({ type: 'mystery' }, TASK);
    assert.deepEqual(calls,
      ['renderFormSet', 'renderComparison', 'renderListing', 'renderStructuredFallback']);
    // the flat path's own null net — same contract as structuredDetail
    const { api: api2, calls: calls2 } = dispatchFns(null);
    const nodes2 = api2.renderStructuredAnswer({ type: 'form-set' }, TASK);
    assert.deepEqual(calls2, ['renderFormSet', 'renderStructuredFallback']);
    assert.equal(nodes2.length, 1);
  });
});

// ------------------------------------------------- fallback safety net ---

describe('renderStructuredFallback on form-sets (the safety net)', () => {
  // The fallback is the malformed-payload path — every step must still print
  // as a labelled block. C2 binds BOTH question spellings, so the label chain
  // is name → prompt → title: a `title:`-spelled set that fails normalisation
  // must not vanish (P4-recheck: it used to drop every step's label).
  function fallbackFns() {
    const src = appSrc();
    const slice = sliceFrom(src, 'function renderStructuredFallback(',
      "/** The comparison payload's one-line verdict", 'fallback');
    const factory = new Function('h', `${slice}\n; return { renderStructuredFallback };`);
    return factory(makeH()) as { renderStructuredFallback: (d: unknown) => FakeEl[] };
  }

  it('a title-spelled step still labels its block — both spellings bind', () => {
    const { renderStructuredFallback } = fallbackFns();
    const nodes = renderStructuredFallback({
      type: 'form-set', title: 'Bank needs things',
      steps: [
        { id: 's1', title: 'Pick one' },
        { id: 's2', title: 'Attach?' },
      ],
    });
    const text = nodes.map(textOf).join('\n');
    assert.ok(text.includes('Bank needs things'), 'structured title renders');
    assert.ok(text.includes('Pick one'), 'a title-only step must not vanish');
    assert.ok(text.includes('Attach?'), 'a title-only step must not vanish');
  });

  it('name and prompt keep their precedence over title', () => {
    const { renderStructuredFallback } = fallbackFns();
    const nodes = renderStructuredFallback({
      type: 'listing',
      items: [{ name: 'TheName', prompt: 'ThePrompt', title: 'TheTitle' }],
    });
    assert.ok(nodes.map(textOf).join('').includes('TheName'));
    const steps = renderStructuredFallback({
      type: 'form-set',
      steps: [{ id: 's', prompt: 'ThePrompt', title: 'TheTitle' }],
    });
    assert.ok(steps.map(textOf).join('').includes('ThePrompt'));
  });
});

// ------------------------------------------------- structural pins (P4) --

describe('P4 structural pins', () => {
  const src = appSrc();

  it('the formset block, its consts and its helpers exist once', () => {
    assert.equal(src.split("const FORMSET_DRAFT_PREFIX = 'vi.formset.';").length - 1, 1);
    assert.equal(src.split('function renderFormSet(').length - 1, 1);
    assert.equal(src.split('async function submitFormset(').length - 1, 1);
    assert.equal(src.split('function formsetSteps(').length - 1, 1);
    assert.ok(src.includes('const FORMSET_DRAFT_TTL_MS = 30 * 24 * 3600 * 1000;'));
  });

  it('dispatch carries exactly one form-set case in each router', () => {
    const detail = sliceFrom(src, 'function structuredDetail(', 'const EMPTY_TIER', 'detail');
    assert.equal(detail.split("data.type === 'form-set'").length - 1, 1);
    const answer = sliceFrom(src, 'function renderStructuredAnswer(', 'const EMPTY_TIER', 'answer');
    assert.equal(answer.split("case 'form-set'").length - 1, 1);
  });

  it('submit modes are the P3 idioms — feedbackAbout / continuesTaskId, never a steer', () => {
    const submit = sliceFrom(src, 'async function submitFormset(', 'function renderFormSet(', 'submit');
    assert.ok(submit.includes('args.continuesTaskId = taskId'));
    assert.ok(submit.includes('args.feedbackAbout = taskId'));
    assert.equal(submit.includes('steer'), false, 'a form-set submit never steers');
  });
});
