/**
 * Live-pane vm smoke (AI-246 v2/v3, WP-H): public/app.js is a classic script —
 * every top-level function is a global — so the whole file evaluates inside
 * `new Function` against a minimal DOM mock, the same harness pattern as
 * answer-shapes.test.ts (which shadows the DOM globals to undefined). The
 * file's only top-level side effects are the two fullscreenchange listener
 * registrations and the trailing boot() call: the document mock captures the
 * first, and the loader strips the second — the smoke drives the live pane
 * by hand instead of booting the app.
 *
 * The invariant under test (SPEC gate 4): NO input POST leaves the client
 * while the pane is not fullscreen. Two independent checks enforce it — the
 * strictly-remote listeners (pane keydown, type-field input) attach only on
 * fullscreen entry and detach on exit, and postInput() (the single funnel
 * every command exits through) refuses to send while liveInput.on is false.
 * v3 splits the surface: the img's gesture listeners attach at pane MOUNT
 * and serve LOCAL view zoom/pan in both modes — this suite exercises both
 * halves plus the gesture→command mapping and the displayed→page coordinate
 * math through the view transform.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

const TASK = 'vi-livepane01';

// --- minimal DOM mock ----------------------------------------------------------
//
// Just enough surface for the live-pane code to run: listener capture on
// document (fullscreenchange) and on elements (the gesture listeners),
// classList, fullscreen enter/exit that fire fullscreenchange like a real
// browser, getBoundingClientRect + naturalWidth/Height for the coordinate
// math, and focus/blur on the type field.

interface MockElement {
  tagName: string;
  listeners: Record<string, Array<{ fn: (e: any) => void; opts: unknown }>>;
  classes: Set<string>;
  classList: {
    add: (c: string) => void;
    remove: (c: string) => void;
    contains: (c: string) => boolean;
  };
  attrs: Record<string, string>;
  children: unknown[];
  value: string;
  focused: boolean;
  rect: { left: number; top: number; width: number; height: number };
  naturalWidth: number;
  naturalHeight: number;
  isConnected: boolean;
  className: string;
  style: Record<string, string>;
  // v3 view math reads transform-immune layout values, not the client rect
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
  clientWidth: number;
  clientHeight: number;
  firstChild: unknown;
  addEventListener: (type: string, fn: (e: any) => void, opts?: unknown) => void;
  removeEventListener: (type: string, fn: (e: any) => void) => void;
  dispatch: (type: string, ev: unknown) => void;
  setAttribute: (k: string, v: string) => void;
  append: (...kids: unknown[]) => void;
  replaceChildren: (...kids: unknown[]) => void;
  focus: () => void;
  blur: () => void;
  getBoundingClientRect: () => MockElement['rect'];
  closest: () => null;
  querySelector: (sel: string) => MockElement | null;
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void>;
  listenerCount: () => number;
}

function makeElement(tag: string, doc: MockDocument, fullscreenCapable: boolean): MockElement {
  const el = {
    tagName: tag.toUpperCase(),
    listeners: {} as MockElement['listeners'],
    classes: new Set<string>(),
    attrs: {} as Record<string, string>,
    children: [] as unknown[],
    value: '',
    focused: false,
    rect: { left: 0, top: 0, width: 400, height: 200 },
    naturalWidth: 800,
    naturalHeight: 400,
    isConnected: true,
    className: '',
    style: {} as Record<string, string>,
    // The default element box: 400×200 at (0,0) — matches the pre-v3 rect
    // fixture so the coordinate math keeps its clean 2× scale on an 800×400
    // page.
    offsetLeft: 0,
    offsetTop: 0,
    offsetWidth: 400,
    offsetHeight: 200,
    clientWidth: 400,
    clientHeight: 200,
  } as MockElement;
  Object.defineProperty(el, 'firstChild', {
    get: () => el.children[0] ?? null,
    configurable: true,
  });
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    contains: (c) => el.classes.has(c),
  };
  el.addEventListener = (type, fn, opts) => {
    (el.listeners[type] ||= []).push({ fn, opts });
  };
  el.removeEventListener = (type, fn) => {
    el.listeners[type] = (el.listeners[type] || []).filter((l) => l.fn !== fn);
  };
  el.dispatch = (type, ev) => {
    for (const l of [...(el.listeners[type] || [])]) l.fn(ev);
  };
  el.setAttribute = (k, v) => {
    el.attrs[k] = String(v);
  };
  el.append = (...kids) => {
    el.children.push(...kids);
  };
  el.replaceChildren = (...kids) => {
    el.children = kids;
  };
  el.focus = () => {
    el.focused = true;
  };
  el.blur = () => {
    el.focused = false;
  };
  el.getBoundingClientRect = () => el.rect;
  el.closest = () => null;
  // Real enough for the live pane's remount path: a recursive className
  // search over children (h() assigns className, not a class attribute).
  el.querySelector = (sel: string) => {
    const want = sel.replace(/^\./, '');
    const walk = (kids: unknown[]): MockElement | null => {
      for (const k of kids) {
        const c = k as MockElement;
        if (!c || typeof c !== 'object' || !Array.isArray(c.children)) continue;
        if (String(c.className || '').split(/\s+/).includes(want)) return c;
        const found = walk(c.children);
        if (found) return found;
      }
      return null;
    };
    return walk(el.children);
  };
  el.listenerCount = () =>
    Object.values(el.listeners).reduce((n, arr) => n + arr.length, 0);
  if (fullscreenCapable) {
    // Mirrors the real browser: the promise resolves, fullscreenElement is
    // set, and a fullscreenchange event fires — entering is a request, not a
    // flag, and app.js arms capture from the event.
    el.requestFullscreen = () => {
      doc.fullscreenElement = el;
      doc.fire('fullscreenchange');
      return Promise.resolve();
    };
  }
  return el;
}

interface MockDocument {
  fullscreenElement: MockElement | null;
  hidden: boolean;
  listeners: Record<string, Array<(e?: any) => void>>;
  byId: Map<string, MockElement>;
  addEventListener: (type: string, fn: (e?: any) => void) => void;
  removeEventListener: (type: string, fn: (e?: any) => void) => void;
  fire: (type: string) => void;
  exitFullscreen: () => Promise<void>;
  getElementById: (id: string) => MockElement | null;
  createElement: (tag: string) => MockElement;
  createElementNS: (ns: string, tag: string) => MockElement;
  createTextNode: (t: string) => { nodeType: number; textContent: string };
  documentElement: MockElement;
}

function makeDocument(): MockDocument {
  const doc = {
    fullscreenElement: null,
    hidden: false,
    listeners: {} as MockDocument['listeners'],
    byId: new Map<string, MockElement>(),
    documentElement: null,
  } as unknown as MockDocument;
  doc.addEventListener = (type, fn) => {
    (doc.listeners[type] ||= []).push(fn);
  };
  doc.removeEventListener = (type, fn) => {
    doc.listeners[type] = (doc.listeners[type] || []).filter((f) => f !== fn);
  };
  doc.fire = (type) => {
    for (const fn of [...(doc.listeners[type] || [])]) fn();
  };
  doc.exitFullscreen = () => {
    doc.fullscreenElement = null;
    doc.fire('fullscreenchange');
    return Promise.resolve();
  };
  // The v3 arm() drives the real mountLivePane, which needs the live-slot
  // element the conversation render would have made — tests register one.
  doc.getElementById = (id) => doc.byId.get(id) ?? null;
  doc.createElement = (tag) => makeElement(tag, doc, false);
  // h() builds the pane's buttons with inline SVG icons (expandIcon,
  // crossIcon) — svgEl goes through createElementNS.
  doc.createElementNS = (_ns, tag) => makeElement(tag, doc, false);
  doc.createTextNode = (t) => ({ nodeType: 3, textContent: t });
  doc.documentElement = makeElement('html', doc, false);
  return doc;
}

// --- the harness ----------------------------------------------------------------

interface Harness {
  app: any;
  doc: MockDocument;
  win: { fire: (type: string) => void };
  calls: Array<{ url: string; opts: { method?: string; headers?: Record<string, string>; body?: string } }>;
  bodies: () => Array<Record<string, unknown>>;
  arm: (opts?: { fullscreenApi?: boolean; dims?: { w: number; h: number } | null }) => {
    img: MockElement;
    pane: MockElement;
    viewport: MockElement;
    typeInput: MockElement;
    urlInput: MockElement;
  };
}

function loadApp(): Harness {
  const paneSrc = readFileSync(join(PKG_ROOT, 'public', 'live-pane.js'), 'utf8');
  const appSrc = readFileSync(join(PKG_ROOT, 'public', 'app.js'), 'utf8');
  // Strip the boot() call — the one top-level entry point the smoke does not
  // want (it would run the login view against the mock). Everything else at
  // top level is declarations plus the fullscreenchange registrations, which
  // the document mock captures for the native-path tests.
  const stripped = appSrc.replace(/\nboot\(\);\s*$/, '\n');
  assert.notEqual(stripped.length, appSrc.length, 'the trailing boot() call was not found to strip');
  // Browser order: live-pane.js evals before app.js (the pane's globals must
  // exist when app.js's own top-level code could reach stopLiveWatch()).
  const src = paneSrc + '\n;\n' + stripped;

  const factory = new Function(
    'document',
    'window',
    'localStorage',
    'navigator',
    'history',
    'location',
    'fetch',
    'getComputedStyle',
    'EventSource',
    'WebSocket',
    'Image',
    'Notification',
    src +
      '\n; return { liveInput, liveWatch, liveView, state, postInput, toPagePoint,' +
      ' livePageDims, livePaintedRect, liveDeltaScale, enterLiveFullscreen,' +
      ' enterCssFullscreen, exitLiveFullscreen, onLiveFullscreenChange,' +
      ' setLiveInputActive, attachLiveInput, attachLiveView, detachLiveInput,' +
      ' teardownLiveInput, noteLiveDims,' +
      ' onLiveTouchStart, onLiveTouchMove, onLiveTouchEnd, onLiveTouchCancel,' +
      ' onLiveMouseDown, onLiveMouseMove, onLiveMouseUp, onLiveWheel,' +
      ' onLiveDblClick, onLiveTypeInput, onLiveKeyDown, sendLiveKey,' +
      ' sendLiveScroll, insertedDelta, mountLivePane, deactivateLive,' +
      ' LIVE_KEYS, LIVE_TAP_MAX_PX, LIVE_TAP_MAX_MS, LIVE_LONGPRESS_MS,' +
      ' LIVE_SCROLL_FLUSH_MS, LIVE_INPUT_INFLIGHT_MAX, LIVE_DBLTAP_MS,' +
      ' LIVE_DBLTAP_ZOOM };'
  );

  const doc = makeDocument();
  const calls: Harness['calls'] = [];
  const fetchMock = (url: string, opts: Harness['calls'][number]['opts']) => {
    calls.push({ url, opts });
    return Promise.resolve({
      status: 200,
      ok: true,
      json: () => Promise.resolve({ ok: true, seq: calls.length }),
    });
  };
  const storage = new Map<string, string>([['vi.session_token', 'sess-tok']]);
  const localStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  };
  // The window mock captures listeners the same way the document mock does —
  // v3 arms a resize listener on it while the view is zoomed.
  const winListeners: Record<string, Array<() => void>> = {};
  const win = {
    addEventListener: (t: string, fn: () => void) => {
      (winListeners[t] ||= []).push(fn);
    },
    removeEventListener: (t: string, fn: () => void) => {
      winListeners[t] = (winListeners[t] || []).filter((f) => f !== fn);
    },
    fire: (t: string) => {
      for (const fn of [...(winListeners[t] || [])]) fn();
    },
  };
  const app = factory(
    doc,
    win,
    localStorageMock,
    {}, // navigator
    {}, // history
    {}, // location
    fetchMock,
    () => ({ getPropertyValue: () => '' }), // getComputedStyle
    class {}, // EventSource
    class {}, // WebSocket
    class {}, // Image
    class {} // Notification
  );

  return {
    app,
    doc,
    win,
    calls,
    bodies: () => calls.map((c) => JSON.parse(String(c.opts.body))),
    arm: (opts = {}) => {
      // v3 arms the pane for real: the slot element the conversation render
      // would have created is registered, and mountLivePane builds the pane —
      // viewport wrapper, img, toolbar, type field — attaching the view-gesture
      // listeners exactly as production does.
      const slot = makeElement('div', doc, false);
      doc.byId.set('live-slot-' + TASK, slot);
      app.liveWatch.active = TASK;
      app.liveWatch.dims.set(TASK, opts.dims === undefined ? { w: 800, h: 400 } : opts.dims);
      // livePageDims keys the status dims off liveInput.taskId (the task being
      // driven), which enterLiveFullscreen sets — the pure mapping tests skip
      // fullscreen, so arm() seeds it to mirror the driven state.
      app.liveInput.taskId = TASK;
      app.mountLivePane(TASK);
      const img = app.liveWatch.img as MockElement;
      const pane = app.liveInput.pane as MockElement;
      const viewport = app.liveWatch.viewport as MockElement;
      const typeInput = app.liveInput.typeInput as MockElement;
      const urlInput = app.liveInput.urlInput as MockElement;
      if (opts.fullscreenApi !== false) {
        // h()-built elements are not fullscreen-capable in the mock — give the
        // pane the same requestFullscreen a real one carries.
        pane.requestFullscreen = () => {
          doc.fullscreenElement = pane;
          doc.fire('fullscreenchange');
          return Promise.resolve();
        };
      }
      return { img, pane, viewport, typeInput, urlInput };
    },
  };
}

// --- event fixtures ---------------------------------------------------------------

const ev = (over: Record<string, unknown> = {}) => ({ preventDefault() {}, ...over });
const pt = (x: number, y: number) => ({ clientX: x, clientY: y });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- the fullscreen gate (SPEC gate 4) ----------------------------------------------

describe('fullscreen gating — no input POST while not fullscreen', () => {
  it('liveInput.on starts false and every gesture path stays silent', () => {
    const { app, calls, arm } = loadApp();
    arm(); // pane + img wired, but fullscreen never entered
    assert.equal(app.liveInput.on, false);
    const touch = { ...ev(), touches: [pt(100, 50)], changedTouches: [pt(100, 50)] };
    app.onLiveTouchStart(touch);
    app.onLiveTouchMove({ ...ev(), touches: [pt(100, 20)] });
    app.onLiveTouchEnd({ ...ev(), touches: [], changedTouches: [pt(100, 50)] });
    app.onLiveMouseDown(ev({ clientX: 100, clientY: 50 }));
    app.onLiveMouseUp(ev({ clientX: 100, clientY: 50 }));
    app.onLiveWheel(ev({ clientX: 100, clientY: 50, deltaX: 0, deltaY: 120, deltaMode: 0 }));
    app.onLiveDblClick(ev({ clientX: 100, clientY: 50 }));
    app.onLiveKeyDown(ev({ key: 'Enter', code: 'Enter', target: app.liveInput.typeInput }));
    app.onLiveTypeInput();
    app.sendLiveScroll(100, 50, 0, 40);
    app.postInput({ type: 'tap', x: 1, y: 1 }); // the funnel itself, bypassing gestures
    assert.equal(calls.length, 0, 'no input POST may leave the client outside fullscreen');
  });

  it('postInput also refuses when the driven task does not match the watched one', () => {
    const { app, calls, arm } = loadApp();
    arm();
    app.enterLiveFullscreen(TASK);
    assert.equal(app.liveInput.on, true);
    app.liveInput.taskId = 'vi-other-task'; // gate half two: taskId must equal liveWatch.active
    app.postInput({ type: 'tap', x: 1, y: 1 });
    assert.equal(calls.length, 0);
    app.liveInput.taskId = TASK;
    app.postInput({ type: 'tap', x: 1, y: 1 });
    assert.equal(calls.length, 1);
    app.exitLiveFullscreen();
  });
});

// --- fullscreen entry/exit -----------------------------------------------------------

describe('expand → fullscreen → exit lifecycle', () => {
  it('native Fullscreen API path: view listeners attach at mount; enter arms remote capture, exit detaches only it', async () => {
    const { app, arm } = loadApp();
    const { img, pane, typeInput } = arm();
    // v3: the img's gesture surface attaches at MOUNT and works in watch-only
    // — view gestures are not input. Only the strictly-remote listeners wait
    // for fullscreen.
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mousemove', 'mouseup', 'wheel', 'dblclick']) {
      assert.ok((img.listeners[type] || []).length > 0, `img must listen for ${type} from mount`);
    }
    assert.equal(pane.listenerCount(), 0, 'no remote-input listeners before fullscreen');
    assert.equal(typeInput.listenerCount(), 0, 'no type-field listener before fullscreen');
    app.enterLiveFullscreen(TASK);
    assert.equal(app.liveInput.on, true, 'fullscreenchange armed the input gate');
    assert.equal(app.liveInput.fallback, false);
    assert.ok((pane.listeners['keydown'] || []).length > 0, 'pane must listen for keydown');
    assert.ok((typeInput.listeners['input'] || []).length > 0, 'type field must listen for input');
    assert.equal(typeInput.focused, true, 'entering focuses the type field to raise the keyboard');
    app.exitLiveFullscreen();
    assert.equal(app.liveInput.on, false);
    assert.equal(img.listenerCount(), 9, 'exit leaves the mount-attached view listeners in place');
    assert.equal(pane.listenerCount(), 0, 'exit detached the pane keydown listener');
    assert.equal(typeInput.listenerCount(), 0, 'exit detached the type-field listener');
    assert.deepEqual(app.liveInput.detach, []);
    assert.equal(typeInput.value, '', 'the type field clears on exit');
  });

  it('CSS fallback path (API absent): live-fullscreen class toggles with the gate', () => {
    const { app, arm } = loadApp();
    const { pane } = arm({ fullscreenApi: false });
    app.enterLiveFullscreen(TASK);
    assert.equal(app.liveInput.on, true);
    assert.equal(app.liveInput.fallback, true);
    assert.ok(pane.classes.has('live-fullscreen'));
    app.exitLiveFullscreen();
    assert.equal(app.liveInput.on, false);
    assert.equal(app.liveInput.fallback, false);
    assert.ok(!pane.classes.has('live-fullscreen'));
  });

  it('a denied fullscreen request lands on the CSS fallback', async () => {
    const { app, doc, arm } = loadApp();
    const { pane } = arm();
    pane.requestFullscreen = () => Promise.reject(new Error('denied'));
    app.enterLiveFullscreen(TASK);
    await sleep(0); // let the rejection reach .catch(enterCssFullscreen)
    assert.equal(app.liveInput.on, true);
    assert.equal(app.liveInput.fallback, true);
    assert.ok(pane.classes.has('live-fullscreen'));
    app.exitLiveFullscreen();
    assert.equal(doc.fullscreenElement, null);
  });
});

// --- gesture → command mapping --------------------------------------------------------

describe('gesture → command mapping', () => {
  // Pane fixture: img paints 400×200 CSS px at (0,0); the page is 800×400, so
  // displayed→page is a clean 2× scale in both axes.
  function armedFullscreen() {
    const h = loadApp();
    h.arm();
    h.app.enterLiveFullscreen(TASK);
    return h;
  }

  it('tap → POST {type:tap, x, y} in page pixels with the bearer header, after the double-tap delay', async () => {
    const { app, calls, bodies } = armedFullscreen();
    app.onLiveTouchStart(ev({ touches: [pt(100, 50)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(100, 50)] }));
    // v3: the tap waits out the ~280ms double-tap window before posting.
    assert.equal(calls.length, 0, 'the tap must not post before the disambiguation window closes');
    await sleep(app.LIVE_DBLTAP_MS + 30);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/live/' + TASK + '/input');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers?.['Authorization'], 'Bearer sess-tok');
    assert.deepEqual(bodies()[0], { type: 'tap', x: 200, y: 100 });
    app.exitLiveFullscreen();
  });

  it('mouse click under 10px is a tap too', async () => {
    const { app, calls, bodies } = armedFullscreen();
    app.onLiveMouseDown(ev({ clientX: 40, clientY: 40 }));
    app.onLiveMouseUp(ev({ clientX: 44, clientY: 43 }));
    await sleep(app.LIVE_DBLTAP_MS + 30);
    assert.equal(calls.length, 1);
    assert.deepEqual(bodies()[0], { type: 'tap', x: 88, y: 86 });
    app.exitLiveFullscreen();
  });

  it('swipe past 10px becomes a scroll carrying page-pixel deltas', () => {
    const { app, calls, bodies } = armedFullscreen();
    app.onLiveTouchStart(ev({ touches: [pt(100, 100)] }));
    app.onLiveTouchMove(ev({ touches: [pt(100, 60)] })); // finger up 40 → content down 40
    assert.equal(calls.length, 1);
    assert.deepEqual(bodies()[0], {
      type: 'scroll',
      x: 200, // toPagePoint(100, 60)
      y: 120,
      deltaX: 0,
      deltaY: 80, // 40 displayed px × 2 page scale
    });
    app.exitLiveFullscreen();
  });

  it('rapid scrolls collapse into the <=20/s flush', async () => {
    const { app, calls, bodies } = armedFullscreen();
    app.onLiveWheel(ev({ clientX: 100, clientY: 100, deltaX: 0, deltaY: 120, deltaMode: 0 }));
    app.onLiveWheel(ev({ clientX: 100, clientY: 100, deltaX: 0, deltaY: 120, deltaMode: 0 }));
    assert.equal(calls.length, 1, 'the first of the burst sends immediately');
    await sleep(app.LIVE_SCROLL_FLUSH_MS + 30);
    assert.equal(calls.length, 2, 'the merged remainder flushes once');
    assert.deepEqual(bodies()[1], { type: 'scroll', x: 200, y: 200, deltaX: 0, deltaY: 240 });
    app.exitLiveFullscreen();
  });

  it('two-finger spread zooms the LOCAL view — the img transform tracks live and no remote pinch leaves', () => {
    const { app, calls, arm } = loadApp();
    const { img } = arm();
    app.enterLiveFullscreen(TASK);
    app.onLiveTouchStart(ev({ touches: [pt(100, 100), pt(200, 100)] })); // dist0 100, mid (150,100)
    app.onLiveTouchMove(ev({ touches: [pt(100, 100), pt(300, 100)] })); // dist 200, mid (200,100)
    assert.equal(calls.length, 0, 'pinch is a view gesture — no remote pinch command');
    // s' = s0 * dist/dist0 = 2; anchored on the current midpoint:
    // tx' = f.x - (fPrev.x - tx) * s'/s = 200 - 150*2 = -100
    assert.equal(app.liveView.s, 2);
    assert.equal(app.liveView.tx, -100);
    assert.equal(app.liveView.ty, -100);
    assert.match(img.style.transform, /translate3d\(-100px,-100px,0\) scale\(2\)/);
    app.onLiveTouchEnd(ev({ touches: [pt(100, 100)], changedTouches: [pt(300, 100)] }));
    assert.equal(calls.length, 0);
    app.exitLiveFullscreen();
  });

  it('double-click toggles LOCAL zoom instead of a remote doubletap', () => {
    const { app, calls, arm } = loadApp();
    const { img } = arm();
    app.enterLiveFullscreen(TASK);
    app.onLiveDblClick(ev({ clientX: 50, clientY: 25 }));
    assert.equal(calls.length, 0, 'no remote doubletap leaves the client');
    assert.equal(app.liveView.s, app.LIVE_DBLTAP_ZOOM);
    assert.match(img.style.transform, /scale\(2\.5\)/);
    app.exitLiveFullscreen();
  });

  it('typing in the field sends only the inserted delta as {type:type}', () => {
    const { app, calls, bodies, arm: _arm } = armedFullscreen();
    void _arm;
    app.liveInput.typeInput.value = 'he';
    app.onLiveTypeInput();
    app.liveInput.typeInput.value = 'hello';
    app.onLiveTypeInput();
    assert.deepEqual(bodies(), [
      { type: 'type', text: 'he' },
      { type: 'type', text: 'llo' },
    ]);
    assert.equal(calls.length, 2);
    app.exitLiveFullscreen();
  });

  it('a non-printable keydown forwards a {type:key} command with modifiers', () => {
    const { app, calls, bodies } = armedFullscreen();
    app.onLiveKeyDown(
      ev({ key: 'Enter', code: 'Enter', target: app.liveInput.typeInput, ctrlKey: true })
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(bodies()[0], {
      type: 'key',
      key: 'Enter',
      code: 'Enter',
      modifiers: ['Control'],
    });
    app.exitLiveFullscreen();
  });

  it('Enter in the address field navigates; its other keys stay local', () => {
    const { app, calls, bodies } = armedFullscreen();
    app.liveInput.urlInput.value = 'https://example.com/';
    app.onLiveKeyDown(ev({ key: 'a', target: app.liveInput.urlInput }));
    assert.equal(calls.length, 0, 'address-field typing must not reach the page');
    app.onLiveKeyDown(ev({ key: 'Enter', target: app.liveInput.urlInput }));
    assert.equal(calls.length, 1);
    assert.deepEqual(bodies()[0], { type: 'navigate', url: 'https://example.com/' });
    app.exitLiveFullscreen();
  });
});

// --- escape → exit ---------------------------------------------------------------------

describe('Escape key', () => {
  it('sends the key to the page AND exits fullscreen, detaching listeners', () => {
    const { app, calls, bodies, arm } = loadApp();
    const { img, pane, typeInput } = arm();
    app.enterLiveFullscreen(TASK);
    app.onLiveKeyDown(ev({ key: 'Escape', code: 'Escape', target: typeInput }));
    assert.equal(calls.length, 1);
    assert.deepEqual(bodies()[0], {
      type: 'key',
      key: 'Escape',
      code: 'Escape',
      modifiers: [],
    });
    assert.equal(app.liveInput.on, false, 'Escape left fullscreen');
    // The img's view-gesture listeners are mount-attached — only the
    // fullscreen-scoped remote listeners (pane keydown, type-field input)
    // detach on exit.
    assert.equal(pane.listenerCount() + typeInput.listenerCount(), 0);
    assert.equal(img.listenerCount(), 9, 'view listeners persist — they are not input capture');
    // And the gate holds again: a tap after the exit sends nothing.
    app.onLiveTouchStart(ev({ touches: [pt(10, 10)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(10, 10)] }));
    assert.equal(calls.length, 1);
  });
});

// --- coordinate mapping ------------------------------------------------------------------

describe('toPagePoint coordinate mapping', () => {
  it('maps displayed px to page px through the painted rect (status dims)', () => {
    const { app, arm } = loadApp();
    arm({ dims: { w: 1600, h: 800 } }); // status dims override natural size
    assert.deepEqual(app.toPagePoint(200, 100), { x: 800, y: 400 });
  });

  it('falls back to the img natural size when no dims were reported', () => {
    const { app, arm } = loadApp();
    const { img } = arm({ dims: null });
    app.liveWatch.dims.delete(TASK);
    img.naturalWidth = 1000;
    img.naturalHeight = 500;
    assert.deepEqual(app.toPagePoint(200, 100), { x: 500, y: 250 });
  });

  it('object-fit:contain letterboxing: the painted rect, not the element box, maps', () => {
    const { app, arm } = loadApp();
    const { img } = arm({ dims: null });
    app.liveWatch.dims.delete(TASK);
    // v3: the painted rect comes from transform-immune layout values — the
    // img is 400×200 offset in the viewport, the square frame letterboxes to
    // 200×200 centered inside it.
    img.naturalWidth = 800;
    img.naturalHeight = 800;
    assert.deepEqual(app.toPagePoint(200, 100), { x: 400, y: 400 });
  });

  it('a tap in the letterbox clamps onto the page edge, never a 400', () => {
    const { app, arm } = loadApp();
    const { img } = arm({ dims: null });
    app.liveWatch.dims.delete(TASK);
    img.naturalWidth = 800;
    img.naturalHeight = 800; // painted 200×200 at left=100: x<100 is outside the frame
    assert.deepEqual(app.toPagePoint(50, 100), { x: 0, y: 400 });
    assert.deepEqual(app.toPagePoint(350, 100), { x: 800, y: 400 });
  });

  it('returns null before any frame paints (zero-size layout box)', () => {
    const { app, arm } = loadApp();
    const { img } = arm({ dims: null });
    app.liveWatch.dims.delete(TASK);
    img.offsetWidth = 0;
    img.offsetHeight = 0;
    assert.equal(app.toPagePoint(10, 10), null);
  });
});

// --- local view-zoom (AI-246 v3) ------------------------------------------------
//
// The frame image owns pinch/pan/double-tap/ctrl-wheel — they move the LOCAL
// view transform and must never become remote commands. The pane fixture:
// viewport/img 400×200 CSS px at (0,0), page 800×400 — 2× at scale 1.

describe('local view-zoom (AI-246 v3)', () => {
  it('double-tap toggles zoom and swallows the pending tap — zero POSTs', async () => {
    const { app, calls, arm } = loadApp();
    const { img } = arm();
    app.enterLiveFullscreen(TASK);
    app.onLiveTouchStart(ev({ touches: [pt(150, 100)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(150, 100)] }));
    app.onLiveTouchStart(ev({ touches: [pt(150, 100)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(150, 100)] }));
    assert.equal(app.liveView.s, app.LIVE_DBLTAP_ZOOM, 'the second tap in the window zooms to 2.5x');
    assert.match(img.style.transform, /scale\(2\.5\)/);
    await sleep(app.LIVE_DBLTAP_MS + 40);
    assert.equal(calls.length, 0, 'the first tap\'s delayed send was cancelled — neither tap reached the page');
    app.exitLiveFullscreen();
  });

  it('a tap while zoomed maps to page coords through the inverse transform', async () => {
    const { app, calls, bodies, arm } = loadApp();
    arm();
    app.enterLiveFullscreen(TASK);
    // A known view: s=2, tx=-200, ty=-100 — client (200,100) inverts to
    // layout ((200+200)/2, (100+100)/2) = (200,100); painted 400×200 at (0,0)
    // over an 800×400 page → (400,200) page px.
    app.liveView.s = 2;
    app.liveView.tx = -200;
    app.liveView.ty = -100;
    app.onLiveTouchStart(ev({ touches: [pt(200, 100)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(200, 100)] }));
    await sleep(app.LIVE_DBLTAP_MS + 30);
    assert.equal(calls.length, 1);
    assert.deepEqual(bodies()[0], { type: 'tap', x: 400, y: 200 });
    app.exitLiveFullscreen();
  });

  it('one-finger drag pans while zoomed (zero POSTs) and remote-scrolls at 1x', () => {
    const { app, calls, bodies, arm } = loadApp();
    arm();
    app.enterLiveFullscreen(TASK);
    // At 1x the drag is the unchanged v2 remote scroll.
    app.onLiveTouchStart(ev({ touches: [pt(100, 100)] }));
    app.onLiveTouchMove(ev({ touches: [pt(100, 60)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(100, 60)] }));
    assert.equal(calls.length, 1);
    assert.equal(bodies()[0].type, 'scroll');
    // Zoomed, the same drag is a local pan: finger +20/+10 moves the view.
    app.liveView.s = 2;
    app.liveView.tx = -50;
    app.liveView.ty = -50;
    calls.length = 0;
    app.onLiveTouchStart(ev({ touches: [pt(100, 100)] }));
    app.onLiveTouchMove(ev({ touches: [pt(120, 110)] }));
    assert.equal(app.liveView.tx, -30);
    assert.equal(app.liveView.ty, -40);
    assert.equal(calls.length, 0, 'a pan is a view gesture — nothing POSTs');
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(120, 110)] }));
    assert.equal(calls.length, 0);
    app.exitLiveFullscreen();
  });

  it('watch-only: pinch and double-tap zoom locally, zero input POSTs of any kind', async () => {
    const { app, calls, arm } = loadApp();
    arm(); // never enters fullscreen — liveInput.on stays false
    app.onLiveTouchStart(ev({ touches: [pt(100, 100), pt(200, 100)] }));
    app.onLiveTouchMove(ev({ touches: [pt(100, 100), pt(300, 100)] }));
    app.onLiveTouchEnd(ev({ touches: [pt(100, 100)], changedTouches: [pt(300, 100)] }));
    assert.equal(app.liveView.s, 2, 'pinch zooms the local view in watch-only');
    app.onLiveTouchStart(ev({ touches: [pt(150, 100)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(150, 100)] }));
    app.onLiveTouchStart(ev({ touches: [pt(150, 100)] }));
    app.onLiveTouchEnd(ev({ touches: [], changedTouches: [pt(150, 100)] }));
    assert.equal(app.liveView.s, 1, 'double-tap toggles a zoomed view back to 1x');
    await sleep(app.LIVE_DBLTAP_MS + 40);
    assert.equal(calls.length, 0, 'watch-only produced no input POSTs of any kind');
  });

  it('ctrl+wheel zooms locally at the cursor — the desktop trackpad-pinch path', () => {
    const { app, calls, arm } = loadApp();
    arm();
    app.enterLiveFullscreen(TASK);
    app.onLiveWheel(ev({ clientX: 200, clientY: 100, deltaX: 0, deltaY: -120, deltaMode: 0, ctrlKey: true }));
    assert.ok(app.liveView.s > 1, 'ctrl+wheel zoomed the local view');
    assert.equal(calls.length, 0, 'ctrl+wheel is a view gesture — no remote scroll');
    app.exitLiveFullscreen();
  });

  it('a plain wheel still remote-scrolls while zoomed', () => {
    const { app, calls, bodies, arm } = loadApp();
    arm();
    app.enterLiveFullscreen(TASK);
    app.liveView.s = 2;
    app.onLiveWheel(ev({ clientX: 100, clientY: 100, deltaX: 0, deltaY: 120, deltaMode: 0 }));
    assert.equal(calls.length, 1);
    assert.equal(bodies()[0].type, 'scroll');
    app.exitLiveFullscreen();
  });

  it('zoom resets on a reported dims change, a task switch, and window resize', () => {
    const { app, arm, doc, win } = loadApp();
    arm();
    app.liveView.s = 3;
    app.liveView.tx = -50;
    app.noteLiveDims(TASK, 800, 400); // identical dims — no reset
    assert.equal(app.liveView.s, 3);
    app.noteLiveDims(TASK, 1024, 768); // the remote page navigated/resized
    assert.equal(app.liveView.s, 1);
    assert.equal(app.liveView.tx, 0);
    // Task switch: mounting a different task's pane drops the saved view.
    app.liveView.s = 4;
    doc.byId.set('live-slot-vi-other', makeElement('div', doc, false));
    app.mountLivePane('vi-other');
    assert.equal(app.liveView.s, 1);
    assert.equal(app.liveView.taskId, 'vi-other');
    // Window resize while zoomed: the listener arms only while s > 1.
    app.onLiveDblClick(ev({ clientX: 100, clientY: 50 }));
    assert.equal(app.liveView.s, app.LIVE_DBLTAP_ZOOM);
    win.fire('resize');
    assert.equal(app.liveView.s, 1, 'a window resize while zoomed resets the view');
  });

  it('the zoom is view state, not input state — it survives fullscreen enter/exit', () => {
    const { app, arm } = loadApp();
    arm();
    app.liveView.s = 2;
    app.enterLiveFullscreen(TASK);
    app.exitLiveFullscreen();
    assert.equal(app.liveView.s, 2, 'exitLiveFullscreen must not reset liveView');
  });
});
