/**
 * Structured-action tests (answer presentation P3, 2026-09-15): the three
 * action kinds that need app wiring — `task` (a new task carrying
 * feedback_about provenance), `save` (the vi.saved bookmark store and its
 * toggling control) and `share` (navigator.share, dropped where it is absent).
 *
 * Two vehicles, chosen per assertion. The saved-item store is DOM-free, so it
 * is EXECUTED — sliced out of public/app.js and run against a fake
 * localStorage (the structured-answer.test.ts idiom: a partial extraction
 * would test a copy, not the app). Everything that touches DOM or navigator is
 * a STRUCTURAL source assertion against a one-function slice (the
 * comparison-renderer.test.ts idiom) — this package has no DOM harness
 * (public/app.js is a classic script served raw; no bundler, no jsdom).
 */

import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

/** PUBLIC_DIR env var points the reader at a different public/ dir — used by
 *  the mutation proof (scratch/p5-spec-gate-check/mutate-p5.mjs), inert
 *  otherwise. */
function readPublic(name: string): string {
  const env = process.env.PUBLIC_DIR;
  const path = env ? resolve(PKG_ROOT, env, name) : join(PKG_ROOT, 'public', name);
  return readFileSync(path, 'utf8');
}

/**
 * A top-level `function name(...)`'s source, up to the next top-level
 * declaration or doc comment (app.js is 2-space indented, so a column-0
 * `function` / `async function` / `const` / `/**` always starts the next
 * top-level item). `async function` must count as a boundary in BOTH
 * directions: the P3 runners are async, and a slice that ran past one would
 * let a call-site assertion match the callee's own definition line — an inert
 * check that passes with the call removed.
 */
function functionSource(src: string, name: string): string {
  const start = src.search(new RegExp('\\n(?:async )?function ' + name + '\\('));
  assert.notEqual(start, -1, `app.js must declare function ${name}`);
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n(?:async function |function |const |\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** One top-level `const NAME = …;` line, asserted present and unique. */
function constLine(src: string, name: string): string {
  const re = new RegExp('^const ' + name + ' = .*;$', 'gm');
  const found = src.match(re);
  assert.equal(found?.length, 1, `app.js must declare ${name} exactly once`);
  return found![0];
}

interface FakeStorage {
  data: Map<string, string>;
  throwOnWrite: boolean;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function fakeStorage(): FakeStorage {
  const data = new Map<string, string>();
  const store: FakeStorage = {
    data,
    throwOnWrite: false,
    getItem: (key) => (data.has(key) ? data.get(key) ?? null : null),
    setItem: (key, value) => {
      if (store.throwOnWrite) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
  };
  return store;
}

/**
 * The name-store block — the LS consts, the generalized nameStore helpers
 * (P5) and the two vi.saved wrappers, sliced out of public/app.js and
 * executed with a fake localStorage injected as a parameter (so the slice
 * resolves it lexically, like `h` in the structured-answer tests).
 */
function storeFns() {
  const src = readPublic('app.js');
  const consts = ['LS_SAVED', 'SAVED_LABEL', 'NAME_STORE_MAX_TASKS'].map((n) => constLine(src, n));
  const fns = ['nameStore', 'nameStoreList', 'nameStoreHas', 'isItemSaved',
    'toggleSavedItem', 'toggleNameInStore']
    .map((n) => functionSource(src, n));
  const slice = consts.join('\n') + '\n' + fns.join('\n');
  const factory = new Function(
    'localStorage',
    `${slice}\n; return { LS_SAVED, SAVED_LABEL, NAME_STORE_MAX_TASKS, nameStore, nameStoreList, isItemSaved, toggleSavedItem };`
  ) as (ls: FakeStorage) => {
    LS_SAVED: string;
    SAVED_LABEL: string;
    NAME_STORE_MAX_TASKS: number;
    nameStore: (lsKey: string) => Record<string, unknown>;
    nameStoreList: (store: unknown, taskId: string) => string[];
    isItemSaved: (task: unknown, itemLabel: string) => boolean;
    toggleSavedItem: (task: unknown, itemLabel: string) => boolean | null;
  };
  return factory;
}

const TASK_A = { task_id: 'vi-aaaaaaaaaaaa' };
const TASK_B = { task_id: 'vi-bbbbbbbbbbbb' };

describe('P3 save: the vi.saved store (executed)', () => {
  const make = storeFns();

  it('pins the storage key, the saved label and the bound', () => {
    const api = make(fakeStorage());
    // The key is the contract: a rename orphans every bookmark the operator
    // has already made, silently.
    assert.equal(api.LS_SAVED, 'vi.saved');
    assert.equal(api.SAVED_LABEL, 'Saved ✓');
    assert.equal(api.NAME_STORE_MAX_TASKS, 200);
  });

  it('reads a corrupt, wrong-shaped or missing value as no bookmarks, never throwing', () => {
    for (const bad of ['not json', '[]', '"x"', '5', 'null', 'true']) {
      const ls = fakeStorage();
      ls.data.set('vi.saved', bad);
      const api = make(ls);
      assert.deepEqual(api.nameStore(api.LS_SAVED), {}, `stored value ${bad} must read as {}`);
      assert.equal(api.isItemSaved(TASK_A, 'Maruti Ertiga'), false, `stored value ${bad} must save nothing`);
    }
    assert.deepEqual(make(fakeStorage()).nameStore('vi.saved'), {}, 'a missing key reads as {}');
    // A JSON object of the wrong shape is kept by the permissive parse and
    // filtered at the list level — still no bookmarks, still no throw.
    const wrongShape = fakeStorage();
    wrongShape.data.set('vi.saved', '{"a":5}');
    const api = make(wrongShape);
    assert.deepEqual(api.nameStoreList(api.nameStore(api.LS_SAVED), 'a'), [], 'a non-array value reads as no items');
    assert.equal(api.isItemSaved(TASK_A, 'X'), false);
  });

  it('toggles an item on and off, stores { taskId: [name] }, and drops an emptied task', () => {
    const ls = fakeStorage();
    const api = make(ls);
    assert.equal(api.toggleSavedItem(TASK_A, 'Maruti Ertiga'), true, 'the first tap saves');
    assert.equal(api.isItemSaved(TASK_A, 'Maruti Ertiga'), true);
    assert.deepEqual(
      JSON.parse(ls.data.get('vi.saved')!),
      { 'vi-aaaaaaaaaaaa': ['Maruti Ertiga'] },
      'the stored shape is { taskId: [item name] }'
    );
    assert.equal(api.toggleSavedItem(TASK_A, 'Maruti Ertiga'), false, 'the second tap unsaves');
    assert.equal(api.isItemSaved(TASK_A, 'Maruti Ertiga'), false);
    assert.deepEqual(
      JSON.parse(ls.data.get('vi.saved')!),
      {},
      'unsaving the last item drops the task key — no empty arrays accumulate'
    );
  });

  it('scopes bookmarks per task: the same item name in another answer is not saved', () => {
    const ls = fakeStorage();
    const api = make(ls);
    api.toggleSavedItem(TASK_A, 'Maruti Ertiga');
    assert.equal(api.isItemSaved(TASK_A, 'Maruti Ertiga'), true);
    assert.equal(api.isItemSaved(TASK_B, 'Maruti Ertiga'), false, 'a bookmark belongs to the answer it came from');
  });

  it('keeps two items of one task independently saved', () => {
    const ls = fakeStorage();
    const api = make(ls);
    api.toggleSavedItem(TASK_A, 'Ertiga');
    api.toggleSavedItem(TASK_A, 'Carens');
    api.toggleSavedItem(TASK_A, 'Ertiga');
    assert.deepEqual(api.nameStoreList(api.nameStore(api.LS_SAVED), 'vi-aaaaaaaaaaaa'), ['Carens']);
  });

  it('returns null when the write throws and stores nothing half-applied', () => {
    const ls = fakeStorage();
    const api = make(ls);
    ls.throwOnWrite = true;
    assert.equal(api.toggleSavedItem(TASK_A, 'X'), null, 'a failed write must not claim success');
    assert.equal(ls.data.has('vi.saved'), false, 'a failed write must not half-apply');
  });

  it('writes nothing without a task id or an item name', () => {
    const ls = fakeStorage();
    const api = make(ls);
    assert.equal(api.toggleSavedItem(null, 'X'), null);
    assert.equal(api.toggleSavedItem({ task_id: '' }, 'X'), null);
    assert.equal(api.toggleSavedItem(TASK_A, ''), null);
    assert.equal(api.isItemSaved(TASK_A, ''), false);
    assert.equal(ls.data.has('vi.saved'), false, 'no key parts, no write — never a shared empty entry');
  });

  it('bounds the store at 200 task keys, oldest first', () => {
    const ls = fakeStorage();
    const api = make(ls);
    for (let i = 0; i < 201; i++) {
      api.toggleSavedItem({ task_id: 'vi-' + String(i).padStart(12, '0') }, 'item');
    }
    const store = JSON.parse(ls.data.get('vi.saved')!) as Record<string, string[]>;
    assert.equal(Object.keys(store).length, 200, 'the store stays bounded');
    assert.equal(store['vi-000000000000'], undefined, 'the oldest entry is evicted first');
    assert.deepEqual(store['vi-000000000200'], ['item'], 'the newest entry survives');
  });

  it('is the only reader/writer of vi.saved in app.js', () => {
    // A markdown-only answer must never touch the store: the key appears
    // exactly three times — the declaration and the two vi.saved wrappers
    // (isItemSaved, toggleSavedItem).
    const src = readPublic('app.js');
    const lines = src.split('\n').filter((line) => line.includes('LS_SAVED'));
    assert.equal(lines.length, 3, 'LS_SAVED must appear exactly 3 times (const + the two wrappers)');
    // The literal count pins the same invariant the other way: a second
    // reader could reach for localStorage.getItem('vi.saved') directly and
    // the symbol count above would never see it.
    const literal = src.split("'vi.saved'").length - 1;
    assert.equal(literal, 1, "the 'vi.saved' literal must appear exactly once — inside the LS_SAVED declaration");
    // The generalized store's own invariant (P5): ONE read site and ONE
    // write site serve every name-store key — a second implementation of
    // the same store is the defect this pins.
    const reads = src.split('localStorage.getItem(lsKey)').length - 1;
    const writes = src.split('localStorage.setItem(lsKey,').length - 1;
    assert.equal(reads, 1, 'nameStore is the only reader');
    assert.equal(writes, 1, 'toggleNameInStore is the only writer');
  });
});

describe('P3 save: the rendered control (structural)', () => {
  const src = readPublic('app.js');

  it('a saved item renders the saved label instead of the worker label', () => {
    const body = functionSource(src, 'renderActionButton');
    assert.ok(
      body.includes("if (action.kind === 'save' && isItemSaved(task, itemLabel)) label = SAVED_LABEL;"),
      'the render path must draw the saved state from the store (state lives outside the DOM — the turn log is rebuilt)'
    );
    assert.ok(
      body.includes("let label = typeof action.label === 'string' ? action.label.trim() : '';"),
      'label must be the display label (reassigned), so the accessible name follows it'
    );
    assert.ok(
      body.indexOf('isItemSaved(task, itemLabel)') < body.indexOf("const aria ="),
      'the saved state must be resolved before the accessible name is built'
    );
  });

  it('the toggle rewrites the same label pair in place', () => {
    const body = functionSource(src, 'applySavedLabel');
    assert.ok(body.includes('control.replaceChildren(label);'), 'the toggle must rewrite the visible label');
    assert.ok(
      body.includes("control.setAttribute('aria-label', label + ', ' + itemLabel);"),
      'the toggle must keep the accessible name in step with the visible label'
    );
    assert.ok(body.includes('const label = saved ? SAVED_LABEL'), 'the toggle draws the saved label from the same constant');
    assert.ok(body.includes("? action.label.trim() : ''"), 'unsaving restores the worker label');
  });

  it('shows a notice both ways and never claims a state it failed to store', () => {
    const body = functionSource(src, 'runSaveAction');
    assert.ok(
      body.includes("if (saved === null) { showNotice('Could not save that.'); return; }"),
      'a failed write must be visible, and the control must be left alone'
    );
    assert.ok(
      body.includes("applySavedLabel(control, action, itemLabel, saved);"),
      'the toggle must repaint the control from the new state'
    );
    assert.ok(body.includes("showNotice(saved ? 'Saved.' : 'Removed.');"), 'both directions must be announced');
  });
});

describe('P3 task action (structural)', () => {
  const src = readPublic('app.js');

  it('creates a new task carrying feedback_about, never a continuation', () => {
    const body = functionSource(src, 'runTaskAction');
    assert.ok(
      body.includes('await createTask({ text: prompt, feedbackAbout: task.task_id });'),
      'the task action must create a task that points back at the answer it came from'
    );
    assert.equal(/continuesTaskId|continues:/.test(body), false,
      'a feedback task is its own request — the API rejects feedback_about with continues');
    assert.equal(/pollRoute|awaitRoute/.test(body), false,
      'the operator is reading the answer — a card action must not navigate away');
  });

  it('falls back to the action label when the payload carries no prompt', () => {
    // The server validator requires label + kind only (task_complete.py), so a
    // prompt-less task action is legal payload and must still do something.
    const body = functionSource(src, 'runTaskAction');
    assert.ok(
      body.includes("? action.prompt.trim()\n    : (typeof action.label === 'string' ? action.label.trim() : '');"),
      'a prompt-less task action must fall back to the worker label'
    );
  });

  it('disables the control on tap and re-enables it only after a failure', () => {
    const body = functionSource(src, 'runTaskAction');
    const disableAt = body.indexOf('control.disabled = true;');
    assert.notEqual(disableAt, -1, 'the control must be disabled on tap (one-shot)');
    assert.ok(
      disableAt < body.indexOf('await createTask('),
      'the disable must land BEFORE the await — a double-tap must not create two tasks'
    );
    assert.ok(body.includes('control.disabled = false;'), 'a failed send must be retryable');
    assert.ok(body.includes("showNotice('Sent.');"), 'a sent task must be announced (the text sheet\'s own notice)');
    assert.ok(
      body.includes("if (e.status !== 401) showNotice('Could not send: ' + e.message);"),
      'the failure notice must mirror submitCapturedTask (401 is already handled by api())'
    );
  });
});

describe('P3 share action (structural)', () => {
  const src = readPublic('app.js');

  it('hands the item to the OS share sheet with the answer title', () => {
    const body = functionSource(src, 'runShareAction');
    assert.ok(
      body.includes('await navigator.share({ title, text: itemLabel, url: location.href });'),
      'the share payload must carry the answer title, the item name and the app URL'
    );
    assert.ok(
      body.includes('data && typeof data.title === \'string\' && data.title.trim()'),
      'the title must come from the answer payload, falling back to the item name'
    );
    assert.ok(
      body.includes('safeParseStructured(task.result_structured)'),
      'the payload is re-read from the task (the handler never receives `data`)'
    );
  });

  it('treats a dismissal as the operator\'s choice, not a failure', () => {
    const body = functionSource(src, 'runShareAction');
    assert.ok(body.includes("if (e && e.name === 'AbortError') return;"), 'an AbortError must be swallowed');
    assert.ok(body.includes("showNotice('Could not share: '"), 'any other failure must be visible');
  });

  it('renders no share control where navigator.share does not exist', () => {
    const body = functionSource(src, 'renderActionButton');
    assert.ok(
      body.includes("if (action.kind === 'share' && !navigator.share) return null;"),
      'a device with no OS share sheet gets no control at all (the conversation share sheet\'s own rule)'
    );
    assert.ok(
      body.indexOf("!navigator.share") < body.indexOf("action.kind === 'task' || action.kind === 'save'"),
      'the hide rule must run before the button branch — a share button is never built without the API'
    );
  });
});

describe('P3 dispatch + shell bump', () => {
  const src = readPublic('app.js');

  it('dispatches every kind it renders — none is left unwired', () => {
    const body = functionSource(src, 'runStructuredAction');
    assert.ok(body.includes('runTaskAction(action, task, control)'), 'task must reach runTaskAction');
    assert.ok(body.includes('runSaveAction(action, task, control, itemLabel)'), 'save must reach runSaveAction');
    assert.ok(body.includes('runShareAction(action, task, itemLabel)'), 'share must reach runShareAction');
  });

  it('known-bad control: the dispatch matcher rejects a handler with no branches', () => {
    const stub =
      'function runStructuredAction(action, task, control, itemLabel) {\n' +
      '  return undefined;\n' +
      '}';
    const matcher = /runSaveAction\(action, task, control, itemLabel\)/;
    assert.equal(matcher.test(stub), false, 'the dispatch matcher must fail on an unwired handler');
    assert.equal(matcher.test(functionSource(src, 'runStructuredAction')), true,
      'the same matcher must pass on the real dispatch');
  });

  it('app.js SHELL_VERSION equals sw.js SHELL_CACHE and sw.js names the P3 change', () => {
    const appVersion = /const SHELL_VERSION = '(v\d+)';/.exec(readPublic('app.js'))?.[1];
    const swVersion = /const SHELL_CACHE = 'voice-inbox-shell-(v\d+)';/.exec(readPublic('sw.js'))?.[1];
    assert.ok(appVersion, 'SHELL_VERSION not found in public/app.js');
    assert.ok(swVersion, 'SHELL_CACHE not found in public/sw.js');
    assert.equal(appVersion, swVersion, 'app.js and sw.js must carry the same shell version');
    assert.match(readPublic('sw.js'), /^\/\/ v\d+: answer presentation P3/m,
      'sw.js must carry the P3 line in its version log');
  });
});
