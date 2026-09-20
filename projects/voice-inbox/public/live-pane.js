'use strict';

/**
 * Live-view pane (AI-246): watch polling, frame pump, pane mount,
 * fullscreen take-over, gesture layer, local view-zoom, coordinate math and
 * input posting. A classic script like app.js — globals, not imports:
 * consumes h/api/state/isTerminal/expandIcon/crossIcon from app.js as
 * globals at call time; index.html loads this file BEFORE app.js (both
 * defer) because app.js's top-level boot() can reach stopLiveWatch()
 * synchronously. Evaluated by src/tests/screencast-live-pane.test.ts
 * against its DOM mock.
 */

// ---------------------------------------------------------------------------
// The live-view pane (AI-246) — while a worker streams the screen its browser
// is on, the open conversation shows it. Liveness comes from the cheap status
// route (GET /live/:taskId, ~2 s) rather than the conversation payload: `live`
// exists on taskDetail only, never on the detail's embedded tasks. A live
// task's pane then pulls the newest frame at ~5 fps.
// ---------------------------------------------------------------------------

const LIVE_FRAME_MS = 200;
const LIVE_STATUS_MS = 2000;
const LIVE_MISS_STOP = 2;

const liveWatch = {
  tasks: [],              // task_ids the status poll asks about
  misses: new Map(),      // task_id -> consecutive not-live answers
  dismissed: new Set(),   // task_ids whose pane the operator closed this view
  active: null,           // the task_id streaming into the pane right now
  img: null,              // the pane's <img> — re-found after every re-render
  viewport: null,         // the .live-viewport wrapper — the transform-immune
                          // screen-space anchor for the v3 view math
  blobUrl: null,          // exactly one live object URL — revoked on replace/stop
  statusTimer: null,
  frameTimer: null,
  statusBusy: false,      // a status round in flight — overlapping beats drop
  frameBusy: false,       // a frame fetch in flight — the interval drops, never queues
  dims: new Map(),        // task_id -> { w, h } — the page dims the status
                          // route reports; the take-over mapper scales
                          // displayed pixels up to these (v2)
};

/**
 * The frame pull is a raw fetch for the same reason as fetchAudioUrl: it
 * needs the bearer header api() adds, but the response is binary and the
 * 200/204/404 distinction matters — none of which api() exposes.
 */
async function fetchLiveFrame(taskId) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(API + '/live/' + encodeURIComponent(taskId) + '/frame', { headers });
  } catch (e) {
    throw new ApiError(0, 'Could not reach the server.');
  }
  if (res.status === 401) {
    clearSession();
    showLogin('Your session expired. Sign in again.');
    throw new ApiError(401, 'unauthorized');
  }
  return res;
}

/**
 * Candidates for the status poll: the conversation's unfinished turns, plus
 * the active task — it can go terminal while its frames still stream, so only
 * the status answer itself may declare the stream over.
 */
function liveCandidates(conv) {
  const ids = [];
  for (const t of (conv && conv.tasks) || []) {
    if (!isTerminal(t.state) && !liveWatch.dismissed.has(t.task_id)) ids.push(t.task_id);
  }
  if (liveWatch.active && !ids.includes(liveWatch.active) && !liveWatch.dismissed.has(liveWatch.active)) {
    ids.push(liveWatch.active);
  }
  return ids;
}

/**
 * Runs after every conversation-body render — the signature guard means the
 * payload actually changed — to re-derive the watch set and re-hang the pane
 * the re-render just tore down.
 */
function syncLiveWatch(conv) {
  liveWatch.tasks = liveCandidates(conv);
  for (const id of liveWatch.misses.keys()) {
    if (!liveWatch.tasks.includes(id)) liveWatch.misses.delete(id);
  }
  for (const id of liveWatch.dims.keys()) {
    if (!liveWatch.tasks.includes(id)) liveWatch.dims.delete(id);
  }
  if (!liveWatch.tasks.length) { stopLiveWatch(); return; }
  if (liveWatch.active) {
    mountLivePane(liveWatch.active);
    mountLiveBadge();
  }
  if (!liveWatch.statusTimer && !document.hidden) {
    liveWatch.statusTimer = setInterval(liveStatusTick, LIVE_STATUS_MS);
    liveStatusTick();
  }
}

async function liveStatusTick() {
  if (liveWatch.statusBusy) return;
  liveWatch.statusBusy = true;
  try {
    for (const taskId of liveWatch.tasks.slice()) {
      if (!liveWatch.tasks.length) return;
      let body = null;
      try {
        body = await api('/live/' + encodeURIComponent(taskId));
      } catch (e) {
        if (e && e.status === 401) { stopLiveWatch(); return; }
        if (e && e.status === 404) registerLiveMiss(taskId);
        continue; // transient (0/other): neither live nor a strike
      }
      if (body && typeof body.width === 'number' && body.width > 0 &&
          typeof body.height === 'number' && body.height > 0) {
        noteLiveDims(taskId, body.width, body.height);
      }
      if (body && body.live === true) {
        liveWatch.misses.delete(taskId);
        activateLive(taskId);
      } else {
        registerLiveMiss(taskId);
      }
    }
  } catch { /* a bad beat skips; the interval keeps its cadence */ }
  finally { liveWatch.statusBusy = false; }
}

/** Two consecutive not-live answers retire the task's watch and pane. */
function registerLiveMiss(taskId) {
  const n = (liveWatch.misses.get(taskId) || 0) + 1;
  if (n < LIVE_MISS_STOP) { liveWatch.misses.set(taskId, n); return; }
  liveWatch.misses.delete(taskId);
  liveWatch.tasks = liveWatch.tasks.filter((id) => id !== taskId);
  deactivateLive(taskId);
  if (!liveWatch.tasks.length) stopLiveWatch();
}

function activateLive(taskId) {
  if (state.view !== 'conversation' || liveWatch.dismissed.has(taskId)) return;
  if (!liveWatch.tasks.includes(taskId)) return; // torn down / re-synced mid-check
  if (liveWatch.active && liveWatch.active !== taskId) deactivateLive(liveWatch.active);
  liveWatch.active = taskId;
  mountLivePane(taskId);
  mountLiveBadge();
  if (!liveWatch.frameTimer && !document.hidden) {
    liveWatch.frameTimer = setInterval(liveFrameTick, LIVE_FRAME_MS);
    liveFrameTick(); // the first frame now, not a beat late
  }
}

function mountLivePane(taskId) {
  const slot = document.getElementById('live-slot-' + taskId);
  if (!slot) return;
  // View state is per-task: mounting a DIFFERENT task's pane drops any zoom
  // left over from the last one (v3).
  if (liveView.taskId !== taskId) { resetLiveView(); liveView.taskId = taskId; }
  if (slot.firstChild) {
    liveWatch.img = slot.querySelector('.live-frame');
    liveWatch.viewport = slot.querySelector('.live-viewport');
    liveInput.pane = slot.querySelector('.live-pane');
    liveInput.typeInput = slot.querySelector('.live-type');
    liveInput.urlInput = slot.querySelector('.live-url');
    return;
  }
  const img = h('img', { class: 'live-frame', alt: '' });
  if (liveWatch.blobUrl) img.src = liveWatch.blobUrl;
  liveWatch.img = img;
  // View gestures (pinch/pan/double-tap/ctrl+wheel) are NOT page input — they
  // attach at mount and live until the pane is rebuilt, so they work in
  // watch-only. Remote-input listeners stay fullscreen-gated
  // (attachLiveInput).
  attachLiveView(img);
  const viewport = h('div', { class: 'live-viewport' }, img);
  liveWatch.viewport = viewport;
  // The take-over furniture (v2): the nav toolbar and the type field are in
  // the DOM always but render only in fullscreen — the CSS keeps them
  // display:none while the pane is an inline card. Their input listeners
  // attach/detach with the fullscreen state itself (attachLiveInput).
  const urlInput = h('input', {
    class: 'live-url', type: 'url', placeholder: 'Address',
    'aria-label': 'Address', autocomplete: 'off', spellcheck: 'false',
    enterkeyhint: 'go',
  });
  const typeInput = h('input', {
    class: 'live-type', type: 'text', placeholder: 'Type into the page',
    'aria-label': 'Type into the page', autocomplete: 'off',
    autocapitalize: 'none', spellcheck: 'false',
  });
  const pane = h('div', { class: 'live-pane' },
    h('div', { class: 'live-pane-head' },
      h('span', { class: 'live-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'live-label' }, 'Watching the screen your assistant is on'),
      h('button', {
        class: 'linkish live-expand with-icon', type: 'button',
        'aria-label': 'Take over', title: 'Take over',
        onclick: () => enterLiveFullscreen(taskId),
      }, expandIcon(16, 'currentColor'), 'Take over'),
      h('button', {
        class: 'linkish icon-btn', type: 'button',
        'aria-label': 'Stop watching', title: 'Stop watching',
        onclick: () => dismissLive(taskId),
      }, crossIcon(16, 'currentColor'))),
    h('div', { class: 'live-toolbar' },
      h('button', {
        class: 'live-nav', type: 'button',
        onclick: () => postInput({ type: 'back' }),
      }, 'Back'),
      h('button', {
        class: 'live-nav', type: 'button',
        onclick: () => postInput({ type: 'forward' }),
      }, 'Forward'),
      h('button', {
        class: 'live-nav', type: 'button',
        onclick: () => postInput({ type: 'reload' }),
      }, 'Reload'),
      urlInput,
      h('button', {
        class: 'live-exit', type: 'button',
        onclick: () => exitLiveFullscreen(),
      }, 'Stop taking over')),
    viewport,
    typeInput);
  liveInput.pane = pane;
  liveInput.typeInput = typeInput;
  liveInput.urlInput = urlInput;
  slot.replaceChildren(pane);
  slot.hidden = false;
  // Re-apply a persisted zoom onto the freshly built img — a same-task
  // remount (re-render) keeps liveView, and the new element needs it. At 1×
  // this just writes the identity transform.
  applyLiveView();
  // A conversation re-render rebuilds this slot under the take-over: the
  // fresh nodes carry neither the fallback class nor any listener, so the
  // still-active state re-arms onto them (native fullscreen cannot survive
  // the DOM swap at all — the browser exits it and fullscreenchange does
  // the teardown; this branch is the CSS-fallback path only).
  if (liveInput.on && liveInput.taskId === taskId) {
    if (liveInput.fallback) pane.classList.add('live-fullscreen');
    attachLiveInput();
  }
}

function mountLiveBadge() {
  const slot = document.getElementById('live-badge-slot');
  if (!slot) return;
  if (!slot.firstChild) slot.replaceChildren(h('span', { class: 'live-badge' }, 'Live'));
  slot.hidden = false;
}

async function liveFrameTick() {
  const taskId = liveWatch.active;
  if (!taskId || liveWatch.frameBusy) return;
  const img = liveWatch.img;
  if (!img || !img.isConnected || img.closest('[hidden]')) return; // not on screen — hold, don't fetch
  liveWatch.frameBusy = true;
  try {
    const res = await fetchLiveFrame(taskId);
    if (liveWatch.active !== taskId) return;
    if (res.status === 200) {
      const blob = await res.blob();
      if (liveWatch.active !== taskId) return;
      if (liveWatch.blobUrl) URL.revokeObjectURL(liveWatch.blobUrl);
      liveWatch.blobUrl = URL.createObjectURL(blob);
      if (liveWatch.img) liveWatch.img.src = liveWatch.blobUrl;
    } else if (res.status === 404) {
      liveWatch.tasks = liveWatch.tasks.filter((id) => id !== taskId);
      deactivateLive(taskId);
      if (!liveWatch.tasks.length) stopLiveWatch();
    }
    // 204 (no or stale frame) and anything else: keep the last frame, keep polling.
  } catch (e) {
    if (e && e.status === 401) stopLiveWatch();
    // a network miss holds the last frame; the next beat retries
  } finally {
    liveWatch.frameBusy = false;
  }
}

function dismissLive(taskId) {
  liveWatch.dismissed.add(taskId);
  liveWatch.tasks = liveWatch.tasks.filter((id) => id !== taskId);
  liveWatch.misses.delete(taskId);
  deactivateLive(taskId);
  if (!liveWatch.tasks.length) stopLiveWatch();
}

function deactivateLive(taskId) {
  if (liveWatch.active !== taskId) return;
  if (liveInput.taskId === taskId) teardownLiveInput();
  detachLiveInput(); // drop any in-flight gesture state the dead pane held
  liveWatch.active = null;
  liveWatch.img = null;
  liveWatch.viewport = null;
  if (liveWatch.frameTimer) { clearInterval(liveWatch.frameTimer); liveWatch.frameTimer = null; }
  if (liveWatch.blobUrl) { URL.revokeObjectURL(liveWatch.blobUrl); liveWatch.blobUrl = null; }
  const slot = document.getElementById('live-slot-' + taskId);
  if (slot) { slot.replaceChildren(); slot.hidden = true; }
  const badge = document.getElementById('live-badge-slot');
  if (badge) { badge.replaceChildren(); badge.hidden = true; }
}

function pauseLiveWatch() {
  if (liveWatch.statusTimer) { clearInterval(liveWatch.statusTimer); liveWatch.statusTimer = null; }
  if (liveWatch.frameTimer) { clearInterval(liveWatch.frameTimer); liveWatch.frameTimer = null; }
}

function resumeLiveWatch() {
  if (state.view !== 'conversation' || document.hidden) return;
  if (liveWatch.tasks.length && !liveWatch.statusTimer) {
    liveWatch.statusTimer = setInterval(liveStatusTick, LIVE_STATUS_MS);
    liveStatusTick();
  }
  if (liveWatch.active && !liveWatch.frameTimer) {
    liveWatch.frameTimer = setInterval(liveFrameTick, LIVE_FRAME_MS);
    liveFrameTick();
  }
}

function stopLiveWatch() {
  if (liveWatch.statusTimer) { clearInterval(liveWatch.statusTimer); liveWatch.statusTimer = null; }
  liveWatch.tasks = [];
  liveWatch.misses.clear();
  liveWatch.dims.clear();
  if (liveWatch.active) deactivateLive(liveWatch.active);
}

/** A fresh conversation view may re-show a pane the operator closed —
 *  app.js calls this instead of reaching into liveWatch.dismissed. */
function resetLiveWatchDismissals() {
  liveWatch.dismissed.clear();
}

// ---------------------------------------------------------------------------
// Take-over (AI-246 v2) + local view-zoom (v3): the pane's expand button
// turns watch-only into remote control, and fullscreen is the gate for
// INPUT — remote commands leave only while the pane fills the screen
// (native Fullscreen API, or the .live-fullscreen CSS fallback where the API
// is missing or denied). View manipulation (v3) is not input: the img's
// gesture listeners attach at pane mount and serve local zoom/pan in both
// modes. Two independent checks still enforce the input invariant: the
// strictly-remote listeners (pane keydown, type-field input) attach only on
// entry and detach on exit, and postInput — the single funnel every send
// goes through — refuses to fire while liveInput.on is false. NO input POST
// leaves this client unless the operator is looking at a fullscreen pane.
// ---------------------------------------------------------------------------

const LIVE_TAP_MAX_PX = 10;      // beyond this a press reads as a scroll
const LIVE_TAP_MAX_MS = 300;     // beyond this a held press is no tap
const LIVE_LONGPRESS_MS = 600;   // a no-movement hold this long is a longpress
const LIVE_SCROLL_FLUSH_MS = 50; // scroll sends collapse to <= 20/s
const LIVE_INPUT_INFLIGHT_MAX = 8;
const LIVE_VIEW_MIN_S = 1;       // local view-zoom scale bounds (v3)
const LIVE_VIEW_MAX_S = 6;
const LIVE_DBLTAP_MS = 280;      // double-tap window — also the tap POST delay
const LIVE_DBLTAP_ZOOM = 2.5;    // a double-tap at 1x zooms to this on the point

/**
 * The LOCAL view transform (AI-246 v3): pinch, two-finger/one-finger drags
 * while zoomed, double-tap and ctrl/cmd+wheel scale and translate the frame
 * IMAGE — the Chrome Remote Desktop / VNC mobile model. The remote page is
 * never touched by a view gesture (a remote `pinch` used to leave the page
 * stuck at visualViewport.scale=4). `s` is the zoom scale, `tx`/`ty` the
 * translation, all in CSS px of the .live-viewport's coordinate space
 * (transform-origin 0 0 on the img). View state, not input state: it
 * persists across fullscreen enter/exit and resets only on a task switch, a
 * reported dims change, or a window resize while zoomed.
 */
const liveView = { s: 1, tx: 0, ty: 0, taskId: null };

/** Non-printable keys forwarded as `key` commands; printables reach the
 *  page through the type field's `input` event instead. */
const LIVE_KEYS = new Set([
  'Enter', 'Tab', 'Backspace', 'Escape', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

const liveInput = {
  on: false,           // the fullscreen gate — the one bit everything keys on
  fallback: false,     // .live-fullscreen CSS mode (API absent or denied)
  taskId: null,        // the task being driven
  pane: null,          // the live .live-pane root — rebuilt per render, refs refresh in mountLivePane
  typeInput: null,     // the hidden field focused to raise the mobile keyboard
  urlInput: null,      // the toolbar's address field — its keys stay local
  detach: [],          // [target, type, fn, opts] rows removed on exit
  inFlight: 0,         // concurrent input POSTs — the flood cap
  pendingScroll: null, // scroll deltas coalesced between flushes
  scrollTimer: null,
  touch: null,         // the one-finger gesture in progress
  pinch: null,         // the two-finger gesture in progress (local view zoom)
  mouse: null,         // the mouse drag in progress
  pendingTap: null,    // { at, timer } — a tap held for double-tap disambiguation
  dblTapAt: 0,         // last manual double-tap — dedupes a synthesized dblclick
  typeValue: '',       // the type field's last value — `type` sends the delta
};

/**
 * Entering is a request, not a flag: the native path resolves through the
 * fullscreenchange event; a missing API or a denied promise lands on the
 * CSS fallback instead. Either way setLiveInputActive(true) is what turns
 * capture on.
 */
function enterLiveFullscreen(taskId) {
  if (liveWatch.active !== taskId || !liveInput.pane) return;
  liveInput.taskId = taskId;
  const pane = liveInput.pane;
  const req = pane.requestFullscreen || pane.webkitRequestFullscreen;
  if (!req) { enterCssFullscreen(pane); return; }
  try {
    Promise.resolve(req.call(pane)).catch(() => enterCssFullscreen(pane));
  } catch {
    enterCssFullscreen(pane);
  }
}

/** iOS Safari and denied requests land here: the pane goes fixed-viewport. */
function enterCssFullscreen(pane) {
  if (liveInput.on) return; // the native path already won
  liveInput.fallback = true;
  pane.classList.add('live-fullscreen');
  setLiveInputActive(true);
}

function exitLiveFullscreen() {
  if (!liveInput.on) return;
  if (liveInput.fallback) {
    liveInput.fallback = false;
    if (liveInput.pane) liveInput.pane.classList.remove('live-fullscreen');
    setLiveInputActive(false);
    return;
  }
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (document.fullscreenElement && exit) {
    try {
      Promise.resolve(exit.call(document))
        .catch(() => setLiveInputActive(false));
    } catch {
      setLiveInputActive(false);
    }
    // the normal way out is the fullscreenchange event on success
  } else {
    setLiveInputActive(false);
  }
}

function onLiveFullscreenChange() {
  const el = document.fullscreenElement || document.webkitFullscreenElement;
  if (el && el === liveInput.pane) setLiveInputActive(true);
  else if (!el && liveInput.on && !liveInput.fallback) setLiveInputActive(false);
}

// The native half of the gate reports through this listener; the CSS
// fallback never fires it (it toggles setLiveInputActive directly). Always
// armed — entering fullscreen is how capture turns on.
document.addEventListener('fullscreenchange', onLiveFullscreenChange);
document.addEventListener('webkitfullscreenchange', onLiveFullscreenChange);

function setLiveInputActive(on) {
  if (on === liveInput.on) return;
  liveInput.on = on;
  if (on) {
    attachLiveInput();
    const field = liveInput.typeInput;
    liveInput.typeValue = field ? field.value : '';
    try { if (field) field.focus({ preventScroll: true }); } catch { /* unfocusable — keyboard stays down */ }
  } else {
    detachLiveInput();
    liveInput.fallback = false;
    if (liveInput.pane) liveInput.pane.classList.remove('live-fullscreen');
    const field = liveInput.typeInput;
    if (field) {
      try { field.blur(); } catch { /* nothing to blur */ }
      field.value = '';
    }
    liveInput.typeValue = '';
  }
}

/** The stream going away while the operator holds it: full reset. */
function teardownLiveInput() {
  setLiveInputActive(false);
  liveInput.taskId = null;
  const el = document.fullscreenElement || document.webkitFullscreenElement;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (el && el === liveInput.pane && exit) {
    try { exit.call(document); } catch { /* the pane is leaving anyway */ }
  }
}

function listen(target, type, fn, opts) {
  target.addEventListener(type, fn, opts);
  liveInput.detach.push([target, type, fn, opts]);
}

/**
 * View-gesture listeners — attached at pane mount, living until the pane is
 * rebuilt. View manipulation is not page interaction: pinch, drags-while-
 * zoomed, double-tap and ctrl/cmd+wheel must work in watch-only, so these
 * are never gated on liveInput.on. The handlers themselves decide what is
 * the browser's (single-finger at 1x watch-only = conversation scroll) and
 * what is ours.
 */
function attachLiveView(img) {
  img.addEventListener('touchstart', onLiveTouchStart, { passive: false });
  img.addEventListener('touchmove', onLiveTouchMove, { passive: false });
  img.addEventListener('touchend', onLiveTouchEnd, { passive: false });
  img.addEventListener('touchcancel', onLiveTouchCancel, { passive: false });
  img.addEventListener('mousedown', onLiveMouseDown);
  img.addEventListener('mousemove', onLiveMouseMove);
  img.addEventListener('mouseup', onLiveMouseUp);
  img.addEventListener('wheel', onLiveWheel, { passive: false });
  img.addEventListener('dblclick', onLiveDblClick);
}

function attachLiveInput() {
  detachLiveInput(); // re-arm onto a rebuilt pane without stacking listeners
  const pane = liveInput.pane;
  if (!pane) return;
  // The fullscreen-only half of the split: keys on the pane and the type
  // field are remote input — everything on the img attached at mount.
  listen(pane, 'keydown', onLiveKeyDown);
  if (liveInput.typeInput) listen(liveInput.typeInput, 'input', onLiveTypeInput);
}

function detachLiveInput() {
  for (const [target, type, fn, opts] of liveInput.detach) {
    target.removeEventListener(type, fn, opts);
  }
  liveInput.detach = [];
  if (liveInput.scrollTimer) { clearTimeout(liveInput.scrollTimer); liveInput.scrollTimer = null; }
  liveInput.pendingScroll = null;
  liveInput.touch = null;
  liveInput.pinch = null;
  liveInput.mouse = null;
  cancelLivePendingTap();
}

/**
 * Every operator command exits through here — the second half of the
 * fullscreen-only invariant. Fire-and-forget with a small in-flight cap:
 * past the cap a scroll folds into the pending merge, anything else drops.
 * A dropped command simply never reaches the page; the stream stays
 * watchable. 401 lands in api() itself (clearSession + showLogin).
 */
function postInput(cmd) {
  if (!liveInput.on || liveInput.taskId !== liveWatch.active) return;
  const taskId = liveInput.taskId;
  if (liveInput.inFlight >= LIVE_INPUT_INFLIGHT_MAX) {
    if (cmd.type === 'scroll') {
      mergeLiveScroll(cmd);
      if (!liveInput.scrollTimer) {
        liveInput.scrollTimer = setTimeout(liveScrollFlush, LIVE_SCROLL_FLUSH_MS);
      }
    }
    return;
  }
  liveInput.inFlight++;
  api('/live/' + encodeURIComponent(taskId) + '/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  }).catch(() => { /* a dropped command never reaches the page */ })
    .finally(() => { liveInput.inFlight--; });
}

/**
 * Scrolls merge into <= 20/s sends: the first of a burst goes out
 * immediately, the rest accumulate into one flush per window.
 */
function sendLiveScroll(clientX, clientY, deltaX, deltaY) {
  const pt = toPagePoint(clientX, clientY);
  if (!pt) return;
  const scale = liveDeltaScale();
  const cmd = {
    type: 'scroll', x: pt.x, y: pt.y,
    deltaX: deltaX * scale.x, deltaY: deltaY * scale.y,
  };
  if (liveInput.scrollTimer) { mergeLiveScroll(cmd); return; }
  postInput(cmd);
  liveInput.scrollTimer = setTimeout(liveScrollFlush, LIVE_SCROLL_FLUSH_MS);
}

function mergeLiveScroll(cmd) {
  const p = liveInput.pendingScroll;
  if (p) {
    p.deltaX += cmd.deltaX;
    p.deltaY += cmd.deltaY;
    p.x = cmd.x;
    p.y = cmd.y;
  } else {
    liveInput.pendingScroll = cmd;
  }
}

function liveScrollFlush() {
  liveInput.scrollTimer = null;
  const cmd = liveInput.pendingScroll;
  liveInput.pendingScroll = null;
  if (cmd) postInput(cmd);
}

/**
 * Displayed → page coordinates. object-fit:contain can letterbox the frame
 * INSIDE the img element (a fullscreen aspect mismatch), so the mapping
 * runs over the painted rect, not the element box — identical to the plain
 * element mapping when the image fills it edge to edge. Coords clamp into
 * the page so a tap in the letterbox lands on the page edge, never a 400.
 */
function livePageDims() {
  const dims = liveWatch.dims.get(liveInput.taskId) || {};
  const img = liveWatch.img;
  return {
    w: dims.w || (img && img.naturalWidth) || 0,
    h: dims.h || (img && img.naturalHeight) || 0,
  };
}

/**
 * The painted rect in VIEWPORT space, computed from layout values — the
 * img's getBoundingClientRect would carry the live view transform, but
 * offsetLeft/offsetTop/offsetWidth/offsetHeight are transform-immune (the
 * .live-viewport is the img's offsetParent, and the viewport itself never
 * transforms, so its own client rect is the stable screen-space anchor).
 * object-fit:contain can still letterbox the frame INSIDE the img element,
 * so the mapping runs over the painted rect, not the element box.
 */
function livePaintedRect() {
  const img = liveWatch.img;
  if (!img) return null;
  const ix = img.offsetLeft, iy = img.offsetTop;
  const iw = img.offsetWidth, ih = img.offsetHeight;
  if (!iw || !ih) return null;
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return { left: ix, top: iy, width: iw, height: ih };
  const s2 = Math.min(iw / nw, ih / nh); // contain fit
  const pw = nw * s2, ph = nh * s2;
  return {
    left: ix + (iw - pw) / 2,
    top: iy + (ih - ph) / 2,
    width: pw, height: ph,
  };
}

function toPagePoint(clientX, clientY) {
  const r = livePaintedRect();
  const vp = liveWatch.viewport;
  const page = livePageDims();
  if (!r || !vp || !page.w || !page.h) return null;
  // Invert the view transform first: client space → layout (viewport) space.
  const v = vp.getBoundingClientRect();
  const ex = (clientX - v.left - liveView.tx) / liveView.s;
  const ey = (clientY - v.top - liveView.ty) / liveView.s;
  const x = Math.round((ex - r.left) / r.width * page.w);
  const y = Math.round((ey - r.top) / r.height * page.h);
  // Coords clamp into the page so a tap in the letterbox lands on the page
  // edge, never a 400.
  return {
    x: Math.min(Math.max(x, 0), page.w),
    y: Math.min(Math.max(y, 0), page.h),
  };
}

/** Gesture deltas arrive in screen pixels; the page needs page pixels. The
 *  view scale divides in too — at s=1 this is the plain painted-rect ratio. */
function liveDeltaScale() {
  const r = livePaintedRect();
  const page = livePageDims();
  if (!r || !page.w || !page.h) return { x: 1, y: 1 };
  return { x: page.w / (r.width * liveView.s), y: page.h / (r.height * liveView.s) };
}

// --- the local view transform (AI-246 v3) -----------------------------------
// The remote `pinch`/`doubletap` commands stay in the input contract (bridge
// and server still accept them) but no default gesture emits them anymore —
// those gestures own the local view now.

/** Client px → the viewport's coordinate space (its never-transformed box). */
function liveViewPoint(clientX, clientY) {
  const vp = liveWatch.viewport;
  if (!vp) return { x: clientX, y: clientY };
  const v = vp.getBoundingClientRect();
  return { x: clientX - v.left, y: clientY - v.top };
}

/**
 * Clamp tx/ty so the painted image never leaves a container edge showing a
 * gap: when the scaled image covers the axis (pw*s >= cw) the leading edge
 * must stay <= 0 and the trailing edge >= cw; when it is narrower than the
 * container it centers. At s===1 the transform is identity by fiat.
 */
function clampLiveAxis(t, off, len, s, container) {
  if (len * s >= container) {
    const tMin = container - (off + len) * s;
    const tMax = -off * s;
    return Math.min(Math.max(t, tMin), tMax);
  }
  return (container - len * s) / 2 - off * s;
}

function clampLiveView() {
  if (liveView.s <= LIVE_VIEW_MIN_S) {
    liveView.s = LIVE_VIEW_MIN_S;
    liveView.tx = 0;
    liveView.ty = 0;
    return;
  }
  const vp = liveWatch.viewport;
  const r = livePaintedRect();
  if (!vp || !r) { liveView.tx = 0; liveView.ty = 0; return; }
  liveView.tx = clampLiveAxis(liveView.tx, r.left, r.width, liveView.s, vp.clientWidth || 0);
  liveView.ty = clampLiveAxis(liveView.ty, r.top, r.height, liveView.s, vp.clientHeight || 0);
}

let liveViewResizeArmed = false;

/** A window resize invalidates the geometry the clamps were computed
 *  against — while zoomed, the saved view no longer maps, so reset. The
 *  listener exists only for the zoomed interval. */
function onLiveWindowResize() {
  resetLiveView();
}

function armLiveViewResize(on) {
  if (on === liveViewResizeArmed) return;
  liveViewResizeArmed = on;
  if (on) window.addEventListener('resize', onLiveWindowResize);
  else window.removeEventListener('resize', onLiveWindowResize);
}

function applyLiveView() {
  const img = liveWatch.img;
  if (img) {
    img.style.transform =
      'translate3d(' + liveView.tx + 'px,' + liveView.ty + 'px,0) scale(' + liveView.s + ')';
  }
  const vp = liveWatch.viewport;
  if (vp) {
    if (liveView.s > LIVE_VIEW_MIN_S) vp.classList.add('live-zoomed');
    else vp.classList.remove('live-zoomed');
  }
  armLiveViewResize(liveView.s > LIVE_VIEW_MIN_S);
}

function resetLiveView() {
  liveView.s = LIVE_VIEW_MIN_S;
  liveView.tx = 0;
  liveView.ty = 0;
  applyLiveView();
}

/**
 * Scale to `sNew` anchored at viewport-space point (fx,fy): the content
 * under the anchor stays under it across the scale change
 * (tx' = f - (f - tx) * s'/s — the spec's focal-anchor formula).
 */
function liveZoomAt(fx, fy, sNew) {
  const s0 = liveView.s;
  const s1 = Math.min(Math.max(sNew, LIVE_VIEW_MIN_S), LIVE_VIEW_MAX_S);
  if (s1 === s0) return;
  liveView.tx = fx - (fx - liveView.tx) * s1 / s0;
  liveView.ty = fy - (fy - liveView.ty) * s1 / s0;
  liveView.s = s1;
  clampLiveView();
  applyLiveView();
}

/** Double-tap (touch pairing or native dblclick): 1x → zoom on the tapped
 *  point, zoomed → back to 1x. Local view only — nothing reaches the page. */
function toggleLiveZoom(clientX, clientY) {
  if (liveView.s > LIVE_VIEW_MIN_S) {
    resetLiveView();
    return;
  }
  const f = liveViewPoint(clientX, clientY);
  liveZoomAt(f.x, f.y, LIVE_DBLTAP_ZOOM);
}

/** The status route's dims double as the frame's natural-size signal: a
 *  change means the remote page navigated or resized, so a saved view no
 *  longer maps onto the new frame — drop it. */
function noteLiveDims(taskId, w, h) {
  const prev = liveWatch.dims.get(taskId);
  liveWatch.dims.set(taskId, { w, h });
  if (taskId === liveView.taskId && prev && (prev.w !== w || prev.h !== h)) {
    resetLiveView();
  }
}

function cancelLivePendingTap() {
  const p = liveInput.pendingTap;
  if (!p) return;
  clearTimeout(p.timer);
  liveInput.pendingTap = null;
}

/**
 * A tap does not POST immediately — it waits out the ~280ms double-tap
 * window first. The delay is the disambiguation price: without it the first
 * half of a zoom double-tap would already be a remote tap — a stray click
 * on whatever sits under the finger (a Pay button, a CAPTCHA checkbox).
 * Single taps still land, just delayed. The send rides postInput, so the
 * fullscreen gate still applies at fire time.
 */
function queueLiveTap(clientX, clientY) {
  const now = Date.now();
  const pending = liveInput.pendingTap;
  if (pending && now - pending.at <= LIVE_DBLTAP_MS) {
    // Second tap inside the window = a double-tap: cancel the first tap's
    // delayed send and toggle LOCAL zoom instead — the page sees neither tap.
    clearTimeout(pending.timer);
    liveInput.pendingTap = null;
    liveInput.dblTapAt = now; // dedupe a browser-synthesized dblclick
    toggleLiveZoom(clientX, clientY);
    return;
  }
  const pt = toPagePoint(clientX, clientY);
  if (!pt) return;
  const timer = setTimeout(() => {
    liveInput.pendingTap = null;
    postInput({ type: 'tap', x: pt.x, y: pt.y });
  }, LIVE_DBLTAP_MS);
  liveInput.pendingTap = { at: now, timer };
}

function liveTouchDist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}
function liveTouchMid(a, b) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * One finger: a sub-10px press under 300 ms is a tap (held ~280ms against a
 * possible double-tap), crossing 10px becomes a local pan while zoomed or a
 * remote scroll at 1x (take-over only), a no-movement hold of 600 ms fires a
 * longpress early so the page reacts while the finger is still down. Two
 * fingers is always a VIEW gesture — local pinch zoom + midpoint pan, never
 * page input, in take-over and watch-only alike.
 *
 * preventDefault discipline: two-finger gestures are always ours — always
 * prevented (pan-x/pan-y leaves pinch to us and the browser must not
 * page-zoom the PWA). Single-finger gestures are prevented only in
 * take-over: watch-only at 1x is the browser's conversation scroll, and
 * zoomed watch-only is already ours via the live-zoomed touch-action:none.
 */
function onLiveTouchStart(e) {
  const ts = e.touches || [];
  if (ts.length >= 2) {
    e.preventDefault();
    if (liveInput.touch && liveInput.touch.longTimer) clearTimeout(liveInput.touch.longTimer);
    liveInput.touch = null;
    const mid = liveTouchMid(ts[0], ts[1]);
    liveInput.pinch = {
      dist0: liveTouchDist(ts[0], ts[1]) || 1,
      s0: liveView.s,
      mid: liveViewPoint(mid.x, mid.y),
    };
    return;
  }
  if (liveInput.pinch) { e.preventDefault(); return; } // pinch winding down: ignore the leftover finger
  const t = ts[0];
  if (!t) return;
  if (liveInput.on) e.preventDefault();
  liveInput.touch = {
    x0: t.clientX, y0: t.clientY, lastX: t.clientX, lastY: t.clientY,
    t0: Date.now(), moved: false, panning: false, scrolling: false,
    browser: false, consumed: false,
    // The longpress is remote input — it only arms in take-over.
    longTimer: liveInput.on ? setTimeout(onLiveLongPress, LIVE_LONGPRESS_MS) : null,
  };
}

function onLiveTouchMove(e) {
  const ts = e.touches || [];
  const p = liveInput.pinch;
  if (p) {
    if (ts.length < 2) return;
    e.preventDefault();
    const mid = liveTouchMid(ts[0], ts[1]);
    const f = liveViewPoint(mid.x, mid.y);
    const d = liveTouchDist(ts[0], ts[1]);
    const s1 = Math.min(Math.max(p.s0 * d / p.dist0, LIVE_VIEW_MIN_S), LIVE_VIEW_MAX_S);
    // One update covers both two-finger gestures: the distance ratio zooms
    // (focal-anchored on the CURRENT midpoint), and the midpoint's own drift
    // is the two-finger drag — the content point under the last midpoint
    // lands under this one at the new scale. Pure drift reduces to a pan.
    liveView.tx = f.x - (p.mid.x - liveView.tx) * s1 / liveView.s;
    liveView.ty = f.y - (p.mid.y - liveView.ty) * s1 / liveView.s;
    liveView.s = s1;
    p.mid = f;
    clampLiveView();
    applyLiveView();
    return;
  }
  const g = liveInput.touch;
  if (!g || ts.length !== 1) return;
  const t = ts[0];
  const dx = t.clientX - g.x0;
  const dy = t.clientY - g.y0;
  if (!g.moved) {
    if (Math.hypot(dx, dy) <= LIVE_TAP_MAX_PX) return;
    g.moved = true;
    if (g.longTimer) clearTimeout(g.longTimer);
    if (liveView.s > LIVE_VIEW_MIN_S) {
      g.panning = true;
      if (liveInput.on) e.preventDefault();
      // carry the accumulated sub-threshold travel, same as the scroll path
      liveView.tx += dx;
      liveView.ty += dy;
      clampLiveView();
      applyLiveView();
    } else if (liveInput.on) {
      g.scrolling = true;
      e.preventDefault();
      // Finger up = content up = the page scrolling down — the send carries
      // the accumulated displacement, not just this move's slice.
      sendLiveScroll(t.clientX, t.clientY, -dx, -dy);
    } else {
      // Watch-only at 1x: the browser's conversation scroll — never ours.
      g.browser = true;
      return;
    }
  } else if (g.panning) {
    if (liveInput.on) e.preventDefault();
    liveView.tx += t.clientX - g.lastX;
    liveView.ty += t.clientY - g.lastY;
    clampLiveView();
    applyLiveView();
  } else if (g.scrolling) {
    e.preventDefault();
    sendLiveScroll(t.clientX, t.clientY, g.lastX - t.clientX, g.lastY - t.clientY);
  } else {
    return; // g.browser — the browser owns this drag; do not preventDefault
  }
  g.lastX = t.clientX;
  g.lastY = t.clientY;
}

function onLiveTouchEnd(e) {
  const ts = e.touches || [];
  const p = liveInput.pinch;
  if (p) {
    if (ts.length >= 2) return;
    e.preventDefault();
    liveInput.pinch = null;
    refocusLiveType();
    return;
  }
  const g = liveInput.touch;
  if (!g) return;
  liveInput.touch = null;
  if (g.longTimer) clearTimeout(g.longTimer);
  if (liveInput.on) e.preventDefault();
  refocusLiveType();
  if (g.consumed || g.moved) return;
  if (Date.now() - g.t0 >= LIVE_TAP_MAX_MS) return;
  const t = (e.changedTouches && e.changedTouches[0]) || { clientX: g.lastX, clientY: g.lastY };
  queueLiveTap(t.clientX, t.clientY);
}

function onLiveTouchCancel() {
  if (liveInput.touch) clearTimeout(liveInput.touch.longTimer);
  liveInput.touch = null;
  liveInput.pinch = null;
}

function onLiveLongPress() {
  const g = liveInput.touch;
  if (!g || g.consumed || g.moved) return;
  g.consumed = true;
  const pt = toPagePoint(g.x0, g.y0);
  if (pt) {
    postInput({ type: 'longpress', x: pt.x, y: pt.y, durationMs: Date.now() - g.t0 });
  }
}

/** The soft keyboard drops when focus jumps to the frame; re-raise it after
 *  each completed gesture so typing keeps working mid-take-over. */
function refocusLiveType() {
  const field = liveInput.typeInput;
  if (field && liveInput.on) {
    try { field.focus({ preventScroll: true }); } catch { /* unfocusable */ }
  }
}

/** Mouse mirrors touch: click under 10px is a (delayed) tap, a held drag
 *  pans while zoomed or remote-scrolls at 1x, wheel scrolls, ctrl/cmd+wheel
 *  zooms locally, double-click toggles the local zoom. The drag is tracked
 *  whenever take-over OR zoomed gives it something to drive. */
function onLiveMouseDown(e) {
  if (!liveInput.on && liveView.s <= LIVE_VIEW_MIN_S) return;
  e.preventDefault();
  liveInput.mouse = {
    x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY,
    moved: false, panning: false, scrolling: false,
  };
}

function onLiveMouseMove(e) {
  const g = liveInput.mouse;
  if (!g) return;
  if (!e.buttons) { liveInput.mouse = null; return; } // released off-frame
  const dx = e.clientX - g.x0;
  const dy = e.clientY - g.y0;
  if (!g.moved) {
    if (Math.hypot(dx, dy) <= LIVE_TAP_MAX_PX) {
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      return;
    }
    g.moved = true;
    if (liveView.s > LIVE_VIEW_MIN_S) {
      g.panning = true;
      liveView.tx += dx;
      liveView.ty += dy;
      clampLiveView();
      applyLiveView();
    } else if (liveInput.on) {
      g.scrolling = true;
      sendLiveScroll(e.clientX, e.clientY, -dx, -dy);
    }
  } else if (g.panning) {
    liveView.tx += e.clientX - g.lastX;
    liveView.ty += e.clientY - g.lastY;
    clampLiveView();
    applyLiveView();
  } else if (g.scrolling) {
    sendLiveScroll(e.clientX, e.clientY, g.lastX - e.clientX, g.lastY - e.clientY);
  }
  g.lastX = e.clientX;
  g.lastY = e.clientY;
}

function onLiveMouseUp(e) {
  const g = liveInput.mouse;
  liveInput.mouse = null;
  if (!g) return;
  if (liveInput.on) e.preventDefault();
  refocusLiveType();
  if (g.moved) return;
  if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > LIVE_TAP_MAX_PX) return;
  queueLiveTap(e.clientX, e.clientY);
}

function onLiveWheel(e) {
  // ctrl/cmd+wheel — the browser's own pinch-zoom gesture, which is how
  // desktop trackpads report pinch — is a LOCAL view zoom at the cursor.
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const f = liveViewPoint(e.clientX, e.clientY);
    liveZoomAt(f.x, f.y, liveView.s * Math.exp(-e.deltaY * unit * 0.002));
    return;
  }
  if (!liveInput.on) return;
  e.preventDefault();
  // deltaMode: 0 pixels, 1 lines (~33px), 2 pages — normalize to pixels.
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  sendLiveScroll(e.clientX, e.clientY, e.deltaX * unit, e.deltaY * unit);
}

/** Native dblclick = the desktop double-tap: local zoom toggle. A dblclick
 *  synthesized from a touch pair we already toggled on is dropped via the
 *  dblTapAt window so the same gesture never double-toggles. */
function onLiveDblClick(e) {
  e.preventDefault();
  if (Date.now() - liveInput.dblTapAt <= LIVE_DBLTAP_MS * 2) return;
  cancelLivePendingTap();
  liveInput.dblTapAt = Date.now();
  toggleLiveZoom(e.clientX, e.clientY);
}

function onLiveTypeInput() {
  if (!liveInput.on || !liveInput.typeInput) return;
  const v = liveInput.typeInput.value;
  const delta = insertedDelta(liveInput.typeValue, v);
  liveInput.typeValue = v;
  if (delta) postInput({ type: 'type', text: delta });
}

/**
 * The inserted span between two field values (common prefix + common
 * suffix, send the middle). A Backspace-shrunk value yields '' — the
 * deletion already left as a `key` command, so nothing double-removes.
 */
function insertedDelta(prev, next) {
  let p = 0;
  const maxP = Math.min(prev.length, next.length);
  while (p < maxP && prev[p] === next[p]) p++;
  let s = 0;
  const maxS = Math.min(prev.length - p, next.length - p);
  while (s < maxS && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s++;
  return next.slice(p, next.length - s);
}

/**
 * One keydown listener on the pane root catches keys from the type field,
 * the address field, and the toolbar buttons through bubbling. The address
 * field's typing stays in its box (only Enter navigates, Escape exits);
 * a button's Enter/Space stays local; everything else non-printable
 * forwards as a `key` command. Escape also leaves fullscreen — both the
 * page and the operator see the same exit.
 */
function onLiveKeyDown(e) {
  if (!liveInput.on) return;
  const target = e.target;
  if (target === liveInput.urlInput) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const url = liveInput.urlInput.value.trim();
      if (url) postInput({ type: 'navigate', url });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      exitLiveFullscreen();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    sendLiveKey(e);
    exitLiveFullscreen();
    return;
  }
  if (target && target.tagName === 'BUTTON') return;
  if (!LIVE_KEYS.has(e.key)) return;
  e.preventDefault();
  sendLiveKey(e);
}

function sendLiveKey(e) {
  const modifiers = [];
  if (e.altKey) modifiers.push('Alt');
  if (e.ctrlKey) modifiers.push('Control');
  if (e.metaKey) modifiers.push('Meta');
  if (e.shiftKey) modifiers.push('Shift');
  postInput({ type: 'key', key: e.key, code: e.code || e.key, modifiers });
}
