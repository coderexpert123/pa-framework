'use strict';

/**
 * Voice Inbox PWA client (2026-09-09 redesign, WP-3).
 *
 * Views: Login, List (the answer sheet), Conversation, Triage. The raw event
 * timeline is collapsed into one quiet expandable line per task — not
 * deleted, every event is still there, one tap away (workBlock). The state
 * machine's nine-word vocabulary never renders raw: STATE_TEXT maps it to
 * plain language everywhere a state would otherwise show. Vanilla JS, no
 * build step, no framework, classic script (every top-level function is a
 * global):
 *   - every dynamic string lands via textContent, never raw markup
 *     injection — this is the client's injection boundary;
 *   - the widget renderer switches ONLY on the six fixed kinds and renders
 *     only the listed fields; anything else is a plain "invalid widget" card;
 *   - on visibilitychange → hidden: speechSynthesis cancels and all polling
 *     pauses, but an in-flight recording KEEPS RUNNING (vi-9c17b02e9171) —
 *     if the OS ends the mic anyway, the partial captured so far is sent,
 *     never silently discarded.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API = '/api/v1';

const LS_TOKEN = 'vi.session_token';
const LS_TENANT = 'vi.tenant_id';

/** §9: detail event poll cadence, while the page is visible. */
const POLL_MS = 4000;
/** vi-ed1d56beebe1 + vi-9c17b02e9171 (2026-09-13): sending is always available,
 *  so the sheet just reminds the operator while a recording runs long. A nudge,
 *  never a stop — the operator decides when done. It fires at 25 minutes and
 *  also at 20 MB captured, which catches a device whose default bitrate is
 *  higher than the ~120 kbps measured baseline. */
const RECORDING_NUDGE_MS = 25 * 60 * 1000;
const RECORDING_NUDGE_BYTES = 20 * 1024 * 1024;
/** Rows never reshuffle under the operator's finger (thread lifecycle,
 *  2026-09-17): a poll re-render waits this long after the last touch, wheel
 *  or scroll, unless the list is scrolled to the top. */
const LIST_IDLE_MS = 2500;
/** The archive view pages 20 at a time via /conversations?offset=
 *  (and &q= when searching) — the design's full-history answer. */
const ARCHIVE_PAGE_SIZE = 20;

const INPUT_KINDS = ['secret', 'text', 'choice', 'oauth', 'file', 'confirm', 'form'];

/** This shell's own version — MUST equal the version inside sw.js's
 *  SHELL_CACHE name (pinned by src/tests/sync-twins.test.ts). Declared on
 *  the SSE connect so the server can replay a `reload` this page missed by
 *  booting from a stale service-worker cache (vi-7790f35108f8). */
const SHELL_VERSION = 'v94';

/** WP-5 §9: cap on the post-send wait for routing to settle. */
const ROUTE_WAIT_MS = 90000;
/** A recording shorter than this is a mis-tap, not a real capture (AI-223:
 *  raised from 400 to 1000 after two sub-second taps became stuck
 *  "Not placed yet" rows instead of being rejected up front). */
const MIN_CAPTURE_MS = 1000;
/** Bars in the recording waveform. */
const WAVE_BARS = 10;
/** Terminal task states — a conversation in one of these is finished. */
const TERMINAL_STATES = ['done', 'failed', 'cancelled', 'transcribe_failed'];

/**
 * Fixed per-kind timeline fallback strings (§5 rendering rule). Owned by
 * src/contracts.ts `EVENT_FALLBACK` — this copy must stay verbatim-identical;
 * contracts.ts is TS and the PWA has no build step, so the client carries the
 * one duplicate. (Sync note in the project brain.)
 */
const EVENT_FALLBACK = {
  'task.received': 'Task received',
  'task.routed': 'Task routed to a topic',
  'task.progress': 'Progress update',
  'task.input_needed': 'Waiting for your input',
  'task.input_received': 'Your input was received',
  'task.result_ready': 'Result ready',
  'task.completed': 'Task completed',
  'task.failed': 'Task failed',
  'task.cancelled': 'Task cancelled',
  'task.rerouted': 'Task rerouted to another topic',
  'task.transcribed': 'Voice transcribed',
};

// ---------------------------------------------------------------------------
// Tiny DOM helpers — text only, never HTML
// ---------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Move keyboard focus to the new view's heading (or back button) after a
 * view transition. `replaceChildren` destroys whatever held focus, dropping
 * it to <body>; keyboard users then have no predictable focus target.
 * Deferred one frame so the fresh DOM has settled; `tabindex="-1"` is set on
 * non-focusable heading elements so .focus() actually lands on them.
 */
function focusViewHeading() {
  requestAnimationFrame(() => {
    const heading = document.querySelector('.topbar-title, .title, .back');
    if (heading) {
      if (heading.tabIndex < 0) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    } else {
      viewRoot()?.focus({ preventScroll: true });
    }
  });
}

/**
 * SVG namespace helper. `h()` uses createElement, which puts an <svg> in the
 * HTML namespace where it parses but renders NOTHING — silently. Every icon
 * in this client is inline SVG, so it goes through here.
 */
function svgEl(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

/** The mic mark that prefixes every spoken turn. `tone` is always
 *  'currentColor'; the optional `cls` (a tone-* class, styles.css theme
 *  helpers) picks the colour, so an OS light/dark flip repaints it. */
function micMark(size, tone, topOffset, cls) {
  const svg = svgEl('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: tone, 'stroke-width': '2', 'stroke-linecap': 'round',
    'aria-hidden': 'true', class: cls,
  },
    svgEl('rect', { x: '9', y: '2', width: '6', height: '11', rx: '3' }),
    svgEl('path', { d: 'M5 11a7 7 0 0 0 14 0' }),
    svgEl('path', { d: 'M12 18v4' }));
  // CSSOM property API, not a style attribute (default-src 'self' CSP — same
  // precedent as copyAnswerText's legacyCopy textarea): a `style` attribute
  // here is silently dropped, which left this icon with no flex-shrink
  // protection — invisible (~2px sliver) next to any long flex sibling, e.g.
  // the earlier-messages recap row.
  svg.style.marginTop = topOffset + 'px';
  svg.style.flex = 'none';
  return svg;
}

/** `d` is the chevron path: 'M15 18l-6-6 6-6' back, 'M9 6l6 6-6 6' disclosure. */
function chevron(size, tone, d, cls) {
  return svgEl('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: tone,
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', class: cls,
  }, svgEl('path', { d }));
}

/**
 * The icon-button pass (2026-09-10): every relatable-glyph icon below shares
 * the mic/chevron construction above (24x24 viewBox, stroke-width 2, round
 * caps/joins, aria-hidden). `tone` is a CSS colour; callers pass
 * 'currentColor' so the glyph always matches whatever colour the button's
 * own class resolves `color` to (accent/quiet/dim/faint), rather than each
 * call site having to look up the right token by hand.
 */
function strokeIcon(size, tone, paths) {
  return svgEl('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: tone,
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, paths.map((d) => svgEl('path', { d })));
}

/** Keyboard — the typing actions ("Type it" / "Type instead"). */
function keyboardIcon(size, tone) {
  return svgEl('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: tone,
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  },
    svgEl('rect', { x: '2', y: '6', width: '20', height: '12', rx: '2' }),
    svgEl('path', { d: 'M6 10h.01M10 10h.01M14 10h.01M18 10h.01' }),
    svgEl('path', { d: 'M7 14h10' }));
}

/**
 * Paper plane — the generic "send" glyph (never the Telegram wordmark/logo).
 * Shared by every "send answer"/"send" submit: they are the same action
 * idiom, so one glyph family reads as one system.
 */
function planeIcon(size, tone) {
  return strokeIcon(size, tone, ['M22 2L11 13', 'M22 2L15 22L11 13L2 9L22 2Z']);
}

/** Door with an outward arrow — sign out. */
function exitIcon(size, tone) {
  return strokeIcon(size, tone, ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9']);
}

/** A simple speedometer/activity glyph — the system status nav entry. */
function gaugeIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M12 12l4-4', 'M12 8v1', 'M16 12h1', 'M12 16v-1', 'M8 12h-1',
  ]);
}

/** An open book — the knowledge-base view's nav entry (vi-19787afc4b2e). */
function bookIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z',
    'M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z',
  ]);
}

/** A magnifier — the search affordance on the list topbar. */
function searchIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
    'M21 21l-4.35-4.35',
  ]);
}

/** A filled square — "stop", matching the app's other solid glyphs (the mic
 *  core, the halo-stop). */
function stopIcon(size, tone) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    svgEl('rect', { x: '6', y: '6', width: '12', height: '12', rx: '2', fill: tone }));
}

/** A filled triangle — "play the original recording", same solid-glyph idiom
 *  as stopIcon. */
function playIcon(size, tone) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    svgEl('path', { d: 'M7 5v14l12-7z', fill: tone }));
}

/** Checkmark — confirm / done. */
function checkIcon(size, tone) {
  return strokeIcon(size, tone, ['M20 6L9 17l-5-5']);
}

/** X — cancel / decline. */
function crossIcon(size, tone) {
  return strokeIcon(size, tone, ['M18 6L6 18', 'M6 6l12 12']);
}

/** Two overlapping rounded rects — "copy this text" (strokeIcon idiom). */
function copyIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M9 11a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z',
    'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  ]);
}

/** Circle with a plus — the row's "created" time chip. */
function createdIcon(size, tone) {
  return strokeIcon(size, tone, ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 8v8', 'M8 12h8']);
}

/** Clock face — the row's "last updated" time chip. */
function updatedIcon(size, tone) {
  return strokeIcon(size, tone, ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3.5 2']);
}

/** Trash can — discarding a capture (destructive: the recording is gone). */
function trashIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M3 6h18',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
    'M10 11v6',
    'M14 11v6',
  ]);
}

/** Arrow into a tray — uploading a file answer. */
function uploadIcon(size, tone) {
  return strokeIcon(size, tone, ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12']);
}

/** A box with an arrow leaving it — an external link (the OAuth continue action). */
function externalLinkIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    'M15 3h6v6',
    'M10 14L21 3',
  ]);
}

/** Four corner arrows pointing outward — "grow this to fill the screen"
 *  (the live pane's Take over action). */
function expandIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7',
  ]);
}

/** Three nodes joined by two lines — "share", distinct from the upload-tray
 *  glyph (already claimed for file-answer uploads) and from externalLinkIcon. */
function shareIcon(size, tone) {
  return svgEl('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: tone,
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  },
    svgEl('circle', { cx: '18', cy: '5', r: '3' }),
    svgEl('circle', { cx: '6', cy: '12', r: '3' }),
    svgEl('circle', { cx: '18', cy: '19', r: '3' }),
    svgEl('path', { d: 'M8.59 13.51L15.42 17.49' }),
    svgEl('path', { d: 'M15.41 6.51L8.59 10.49' }));
}

/** Picture — image attachments (extension-based chip/turn glyphs). */
function imageIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'M8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
    'M21 15l-5-5L5 21',
  ]);
}

/** Document — every non-image, non-audio attachment. */
function docIcon(size, tone) {
  return strokeIcon(size, tone, ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']);
}

/** A flag — "give feedback" on a message or conversation (2026-09-16). */
function flagIcon(size, tone) {
  return strokeIcon(size, tone, [
    'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z',
    'M4 22v-7',
  ]);
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];
const AUDIO_EXTENSIONS = ['webm', 'mp3', 'wav', 'm4a', 'ogg', 'oga', 'aac', 'flac'];

function attachmentExtension(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function attachmentGlyph(name) {
  const ext = attachmentExtension(name);
  if (IMAGE_EXTENSIONS.includes(ext)) return imageIcon(14, 'currentColor');
  if (AUDIO_EXTENSIONS.includes(ext)) return micMark(14, 'currentColor', 0);
  return docIcon(14, 'currentColor');
}

/**
 * Staged attachments for one composer sheet (task attachments, 2026-09-13):
 * a hidden multi-file input pair (media + files), the chip row that mirrors
 * them, and the two buttons that drive each. Files stage client-side only —
 * nothing uploads until the sheet's own send runs.
 */
function makeAttachmentStaging() {
  const mediaInput = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/*,video/*', 'aria-hidden': 'true' });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true' });
  const chips = h('div', { class: 'attach-chips' });
  let files = [];
  function renderChips() {
    chips.replaceChildren(...files.map((f, i) =>
      h('span', { class: 'attach-chip' },
        attachmentGlyph(f.name),
        h('span', { class: 'attach-chip-name clamp1' }, f.name),
        h('span', { class: 'meta' }, fmtBytes(f.size)),
        h('button', {
          class: 'attach-chip-remove', type: 'button',
          'aria-label': 'Remove ' + f.name, title: 'Remove',
          onclick: () => { files.splice(i, 1); renderChips(); },
        }, crossIcon(12, 'currentColor')))));
  }
  function addFiles(list) {
    for (const f of list) files.push(f);
    renderChips();
  }
  mediaInput.addEventListener('change', () => { addFiles(mediaInput.files || []); mediaInput.value = ''; });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files || []); fileInput.value = ''; });
  return {
    row: h('div', { class: 'attach-staging' }, mediaInput, fileInput, chips),
    mediaButton: h('button', {
      class: 'act act-quiet icon-btn', type: 'button',
      'aria-label': 'Attach photos or videos', title: 'Attach photos or videos',
      onclick: () => mediaInput.click(),
    }, imageIcon(18, 'currentColor')),
    fileButton: h('button', {
      class: 'act act-quiet icon-btn', type: 'button',
      'aria-label': 'Attach files', title: 'Attach files',
      onclick: () => fileInput.click(),
    }, docIcon(18, 'currentColor')),
    openMediaPicker: () => mediaInput.click(),
    openFilePicker: () => fileInput.click(),
    files: () => files.slice(),
  };
}

/**
 * One turn's attachments: a chip per entry of task.attachments
 * ({name, bytes}), fetched with the bearer header on tap — a plain img/src
 * or anchor cannot carry it — into a blob URL, then the overlay for images
 * or a download anchor for everything else.
 */
function attachmentsRow(task) {
  const row = h('div', { class: 'turn-assistant attach-row' });
  for (const a of task.attachments || []) {
    row.append(h('button', {
      class: 'attach-chip', type: 'button',
      'aria-label': 'Open attachment ' + a.name, title: a.name + ' · ' + fmtBytes(a.bytes),
      onclick: () => openAttachment(task.task_id, a.name),
    },
      attachmentGlyph(a.name),
      h('span', { class: 'attach-chip-name clamp1' }, a.name),
      h('span', { class: 'meta' }, fmtBytes(a.bytes))));
  }
  return row;
}

async function openAttachment(taskId, name) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(API + '/tasks/' + encodeURIComponent(taskId) + '/attachments/' + encodeURIComponent(name), { headers });
  } catch {
    showNotice('Could not fetch the attachment — check your connection and try again.');
    return;
  }
  if (res.status === 401) { clearSession(); showLogin('Your session expired. Sign in again.'); return; }
  if (!res.ok) { showNotice('The attachment could not be loaded.'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (IMAGE_EXTENSIONS.includes(attachmentExtension(name))) {
    openImageOverlay(url, name);
  } else {
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
  }
}

function openImageOverlay(url, name) {
  const close = () => {
    URL.revokeObjectURL(url);
    document.removeEventListener('keydown', escHandler);
    scrim.remove();
  };
  const escHandler = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
  const scrim = h('div', {
    class: 'scrim attach-overlay', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Image preview: ' + name, tabindex: '-1',
  },
    h('button', {
      class: 'act act-quiet icon-btn', type: 'button',
      'aria-label': 'Close image', title: 'Close',
      onclick: close,
    }, crossIcon(18, 'currentColor')),
    h('img', { class: 'attach-overlay-img', src: url, alt: name }));
  document.addEventListener('keydown', escHandler);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
  scrim.focus();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  view: null,              // 'login' | 'list' | 'conversation' | 'triage' | 'system' | 'archive' | 'kb'
  conversations: [],       // the last GET /conversations payload
  conversationId: null,    // the open conversation, in the conversation view
  conversation: null,      // its last GET /conversations/:id payload
  signature: '',           // the last rendered payload's signature (E14)
  expanded: new Set(),     // task_ids whose working block is open
  expandedRecaps: new Set(), // conversation_ids whose earlier-turns recap is open
  expandedTurns: new Set(),  // task_ids whose earlier full turn content is open
  expandedSteps: new Set(), // 'taskId:eventIndex' keys whose long routed/rerouted reason is expanded
  expandedAnswers: new Set(), // task_ids whose full tiered answer is open
  expandedOriginals: new Set(), // task_ids whose "Your exact words" disclosure is open
  choice: new Map(),       // request_id -> the option selected but not yet sent
  capture: null,           // the live recording, see E19
  awaitRoute: null,        // { taskId, startedAt } — the WP-5 §9 auto-navigate

  total: 0,                // total conversations (GET /conversations `total`, vi-19787afc4b2e) — > payload length means depth history exists
  archive: null,           // the archive view's page state: { rows, total, loading, error, q }
  failedSelect: null,      // a Set of conversation ids while multi-select mode is on (row long-press "Select" or the Failed bar's Select)
  kb: null,                // the knowledge-base payload (GET /kb, loaded once per app session)
  kbError: null,           // its last load error, for the retry state
  offline: false,          // network-down flag (H4): set on the first failed
                           // api() call, cleared on the first success; the
                           // "last known state" notice rides it
};

/**
 * Views are pushed as history entries on the SAME url, so the hardware back
 * button pops one view instead of closing the TWA. The url never changes, so
 * neither the static server nor the service worker needs a route for it.
 */
function navigate(view, id) {
  if (state.view !== null) history.pushState({ v: view, id: id || null }, '');
  renderView(view, id);
}
function renderView(view, id) {
  stopSystemPolling();
  stopLiveWatch();
  // Any explicit navigation cancels a pending auto-navigate: the operator has
  // said where they want to be and the app must not move them again.
  state.awaitRoute = null;
  if (view === 'list') return showList();
  if (view === 'triage') return showTriage();
  if (view === 'conversation') return showConversation(id);
  if (view === 'system') return showSystem();
  if (view === 'archive') return showArchive();
  if (view === 'kb') return showKb();
  return showLogin();
}

function viewRoot() {
  return document.getElementById('view-root');
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function getToken() {
  try { return localStorage.getItem(LS_TOKEN); } catch { return null; }
}

function saveSession(token, tenantId) {
  try {
    localStorage.setItem(LS_TOKEN, token);
    localStorage.setItem(LS_TENANT, tenantId);
  } catch { /* private mode: session lives for the page only */ }
}

function clearSession() {
  try {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_TENANT);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// API helper — bearer auth, 401 → login, never throws raw
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(API + path, Object.assign({}, opts, { headers }));
  } catch (e) {
    if (!state.offline) {
      state.offline = true;
      showNotice('You appear to be offline — showing the last known state.');
    }
    throw new ApiError(0, 'Could not reach the server.');
  }
  if (res.status === 401) {
    clearSession();
    showLogin('Your session expired. Sign in again.');
    throw new ApiError(401, 'unauthorized');
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok || (body && body.ok === false)) {
    if (body && body.error) console.warn('API error:', body.error);
    const userMsg = res.status >= 500 ? 'Something went wrong on the server.'
      : res.status === 404 ? 'Could not find that.'
      : res.status === 403 ? 'You do not have permission to do that.'
      : 'Something went wrong.';
    throw new ApiError(res.status, userMsg);
  }
  if (state.offline) {
    state.offline = false;
    clearNotice();
  }
  return body;
}

/**
 * The original recording, as a same-origin blob: URL. Unlike `api()` this
 * expects a binary body, not JSON — the audio route (GET /tasks/:id/audio)
 * has no other caller. An `<audio src>` attribute can't carry the bearer
 * header the API requires, so playback always goes through this fetch first;
 * the browser's native scrubbing then works on the already-loaded blob with
 * no further network round-trip.
 */
async function fetchAudioUrl(taskId) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    res = await fetch(API + '/tasks/' + taskId + '/audio', { headers });
  } catch (e) {
    throw new ApiError(0, 'Could not reach the server.');
  }
  if (res.status === 401) {
    clearSession();
    showLogin('Your session expired. Sign in again.');
    throw new ApiError(401, 'unauthorized');
  }
  if (!res.ok) throw new ApiError(res.status, 'Something went wrong on the server.');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------------------
// Server view time, the one-time read-mark upload, the list hold (thread lifecycle, 2026-09-17)
// ---------------------------------------------------------------------------

/** Answer keys (`<conversation_id>|<answer_landed_at>`) this page already
 *  posted a view for — one POST per answer per page session. */
const viewPosts = new Set();

/** Records the operator's view of a conversation's current answer on the
 *  server: only while the page is visible (a background tab never marks
 *  anything), only for an answer the server still shows unviewed, once per
 *  answer. The server writes only when the thread is unviewed for that answer,
 *  so a re-open never restarts the Viewed hour. */
function postConversationViewed(conv) {
  if (document.hidden || !conv || !conv.answer_landed_at) return;
  if (conv.viewed_at && Date.parse(conv.viewed_at) >= Date.parse(conv.answer_landed_at)) return;
  const key = conv.conversation_id + '|' + conv.answer_landed_at;
  if (viewPosts.has(key)) return;
  viewPosts.add(key);
  api('/conversations/' + encodeURIComponent(conv.conversation_id) + '/viewed', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).catch(() => { viewPosts.delete(key); });
}

/** The one-time upload's re-entry guard (a poll can land mid-upload). */
const legacyMarks = { uploading: false };

/** One-time migration of this device's pre-wave read marks (`vi.read`: a
 *  `{ seen, at }` object or a legacy updated_at string) to the server's view
 *  time. Each mark whose conversation the server shows with an unviewed answer
 *  is posted with the mark's own open time — the server honours `at` only
 *  where it has no view time — and then the store is removed. A network
 *  failure keeps the store so the next list load retries. */
async function uploadLegacyReadMarks(conversations) {
  if (legacyMarks.uploading) return;
  let raw = null;
  try { raw = localStorage.getItem('vi.read'); } catch { return; }
  if (raw === null) return;
  legacyMarks.uploading = true;
  try {
    let marks = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) marks = parsed;
    } catch { marks = {}; }
    for (const c of conversations) {
      const mark = marks[c.conversation_id];
      if (mark === undefined || mark === null || !c.answer_landed_at || c.viewed_at) continue;
      const atMs = typeof mark === 'object'
        ? (typeof mark.at === 'number' && mark.at > 0 ? mark.at : Date.parse(mark.seen))
        : Date.parse(mark);
      if (!Number.isFinite(atMs)) continue;
      try {
        await api('/conversations/' + encodeURIComponent(c.conversation_id) + '/viewed', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ at: new Date(atMs).toISOString() }),
        });
      } catch (e) {
        if (!e || e.status === 0) return; // offline: keep the store for the next load
      }
    }
    try { localStorage.removeItem('vi.read'); } catch { /* private mode */ }
  } finally {
    legacyMarks.uploading = false;
  }
}

/** The list re-render hold — see LIST_IDLE_MS. */
const listHold = { lastInteractionAt: 0, pending: false, timer: null };

function markListInteraction() {
  listHold.lastInteractionAt = Date.now();
}

/** True while a re-render would move rows under the operator's finger: a
 *  touch, wheel or scroll within LIST_IDLE_MS, with the list scrolled away
 *  from the top. */
function listRenderHeld() {
  return Date.now() - listHold.lastInteractionAt < LIST_IDLE_MS && window.scrollY > 0;
}

/** Applies a held list render once the operator is idle or at the top;
 *  re-checks after LIST_IDLE_MS while still held. */
function flushHeldListRender() {
  if (!listHold.pending) return;
  if (listRenderHeld()) {
    if (listHold.timer === null) {
      listHold.timer = setTimeout(() => {
        listHold.timer = null;
        flushHeldListRender();
      }, LIST_IDLE_MS);
    }
    return;
  }
  listHold.pending = false;
  if (state.view === 'list') renderListBody();
}

function onListScroll() {
  markListInteraction();
  if (window.scrollY <= 0) flushHeldListRender();
}

/** The 'needs you' predicate behind conversationLines' next-action fallback
 *  ("Needs your answer"): awaiting_input state or any open typed input
 *  request. The list's status word and the topbar badge read the server's
 *  status token instead (thread lifecycle, 2026-09-17). */
function conversationNeedsYou(conv) {
  return conv.state === 'awaiting_input' || conv.pending_input_count > 0;
}

// ---------------------------------------------------------------------------
// Browser notifications (vi-08b2360d27b3) — purely client-side. The 4 s poll
// is the event source; the Notifications API (via the service worker) is the
// channel. Fires only while the page is hidden — the visible app already
// shows the change in place — and the first scan seeds without notifying (no
// backlog storm). Best-effort end to end: a notification failure must never
// throw into the poll loop.
// ---------------------------------------------------------------------------

const notifSupported = 'Notification' in window;
/** conversation_id -> { pending, state } as of the last scan. */
const notifSeen = new Map();
let notifFirstScan = true;
/** True once this device holds a working Web Push subscription — the server
 *  then owns OS notifications for answer/input events (it pushes on
 *  completion whether the app is open or not), so the page-side poll must
 *  NOT also post one: two same-event notifications under different tags was
 *  the operator's "notifications as spam" report (2026-09-17). Falls back to
 *  in-app notifications when there is no subscription (push unsupported,
 *  unsubscribed, or the subscribe POST never landed). */
let pushSubscribed = false;

function notificationsOn() {
  return notifSupported && Notification.permission === 'granted';
}

// ---------------------------------------------------------------------------
// Web Push subscription (real push — arrives even with the app closed).
// Best-effort end to end: any failure here (unsupported browser, denied
// permission, network error) must never throw into a caller.
// ---------------------------------------------------------------------------

/** Standard VAPID applicationServerKey conversion: base64url -> Uint8Array. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Subscribes this device to server-sent Web Push, if not already. */
async function subscribeWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) { pushSubscribed = true; return; } // already subscribed — avoid re-hitting /subscribe every launch
    const keyBody = await api('/push/vapid-public-key');
    const publicKey = keyBody && keyBody.publicKey;
    if (!publicKey) return;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await api('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
    });
    pushSubscribed = true;
  } catch (e) {
    console.warn('subscribeWebPush failed', e);
  }
}

/** OS notification body preview cap — mirrors src/contracts.ts
 *  NOTIF_BODY_MAX and the pa dispatcher's copy in pa/src/lib/web-push.ts
 *  (vi-77c9ccd3865e, 2026-09-14). The full text stays in the app; the
 *  notification is a preview. */
const NOTIF_BODY_MAX = 140;

/** Word-boundary cut to the preview cap with an ellipsis — same tail rule
 *  as firstSentence. */
function clipNotifBody(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > NOTIF_BODY_MAX
    ? t.slice(0, NOTIF_BODY_MAX - 1).replace(/\s+\S*$/, '') + '…'
    : t;
}

/** Service-worker notification when possible, page-context otherwise. */
async function showNotif(title, body, tag) {
  const clipped = clipNotifBody(body);
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistration) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, {
          body: clipped,
          tag: tag,
          icon: './icons/icon-192.png',
          // Monochrome status-bar glyph — the colour icon paints as a block
          // on Android and Chrome's badge shows instead (see sw.js).
          badge: './icons/badge-96.png',
          // Tag replacement must never re-sound/re-vibrate.
          renotify: false,
        });
        return;
      }
    }
    new Notification(title, { body: clipped, tag: tag });
  } catch { /* best-effort */ }
}

/**
 * Diff the fresh scan against `notifSeen` and notify on the two triggers: a
 * conversation becomes "needs you" (state → awaiting_input, or
 * pending_input_count increases) and a response lands (state → done or
 * → failed). Titles come from conversationLines — the same derivation the
 * rows use, never a second title source.
 */
function maybeNotify(conversations) {
  const scan = new Map();
  for (const c of conversations) {
    scan.set(c.conversation_id, { pending: c.pending_input_count || 0, state: c.state });
  }
  if (notifFirstScan) {
    notifFirstScan = false;
  } else if (notificationsOn() && document.hidden && !pushSubscribed) {
    for (const c of conversations) {
      const prev = notifSeen.get(c.conversation_id);
      if (!prev) continue;
      const tag = 'pa-' + c.conversation_id;
      if ((c.state === 'awaiting_input' && prev.state !== 'awaiting_input') ||
          ((c.pending_input_count || 0) > prev.pending)) {
        const lines = conversationLines(c);
        showNotif('Needs you — ' + lines.title,
          lines.nextAction || 'Open the inbox to answer.', tag);
      } else if (c.state === 'done' && prev.state !== 'done') {
        const lines = conversationLines(c);
        showNotif('Ready — ' + lines.title,
          firstSentence(c.result_summary || 'Ready.'), tag);
      } else if (c.state === 'failed' && prev.state !== 'failed') {
        const lines = conversationLines(c);
        // Same marker-clean rule as the done branch: a markdown-heavy
        // result_summary must not leak ** or - into the toast. plainAnswerSnippet,
        // not firstSentence — its ':'-clamp would cut a failure like
        // "quota exceeded: 429" down to "quota exceeded".
        showNotif('Didn’t work — ' + lines.title,
          c.result_summary ? plainAnswerSnippet(c.result_summary) : 'Open the inbox for details.', tag);
      }
    }
  }
  notifSeen.clear();
  for (const [id, seen] of scan) notifSeen.set(id, seen);
}

// ---------------------------------------------------------------------------
// The plain-language state vocabulary (E7) — this is the whole mapping table
// and nothing else maps states to words.
// ---------------------------------------------------------------------------

/**
 * The ledger's nine states, mapped to the words the operator thinks in — the
 * TASK-level word (a turn inside a conversation, the triage row). The state
 * MACHINE vocabulary never renders raw (operator brief). Keys are the nine
 * states of TASK_STATES in src/ledger.ts, in that order; a state added there
 * without a key here renders the unknown-state fallback below, which is
 * deliberately non-terminal so the work still looks live. A THREAD's word is
 * never derived here: the server sends its status token (THREAD_STATUS_TEXT).
 */
const STATE_TEXT = {
  received: 'Sent',
  transcribing: 'Sent',
  routed: 'Sent',
  running: 'Running',
  awaiting_input: 'Needs You',
  transcribe_failed: 'Couldn’t hear that',
  done: 'Done',
  failed: 'Didn’t work',
  cancelled: 'Cancelled',
};
const UNKNOWN_STATE_TEXT = 'Working';

/**
 * The thread status words (thread lifecycle, 2026-09-17). The SERVER derives a
 * conversation's status token (src/thread-status.ts); this table only maps the
 * token to its word. Keys and words are pinned byte-equal to
 * THREAD_STATUS_WORDS by src/tests/sync-twins.test.ts — no client copy of the
 * derivation exists.
 */
const THREAD_STATUS_TEXT = {
  recorded: 'Recorded',
  transcribing: 'Transcribing',
  routed: 'Routed',
  needs_you: 'Needs You',
  ready: 'Ready',
  failed: 'Failed',
  running: 'Running',
  viewed: 'Viewed',
  concluded: 'Concluded',
  cancelled: 'Cancelled',
  done: 'Done',
};

/** Statuses a row's long-press sheet treats as in-flight — Stop is offered. */
const ACTIVE_STATUSES = ['running', 'recorded', 'transcribing', 'routed', 'needs_you'];
/** Thread statuses with nothing left to cancel (thread lifecycle). */
const TERMINAL_STATUSES = ['viewed', 'concluded', 'cancelled', 'done'];

/**
 * Waiting substates (status-model design, vi-84aa5bf5085e): a task that has
 * landed but has no worker yet. Only three of the design's four rows are
 * derivable from the list summary — 'received' covers both a typed task
 * fresh off creation and a voice task just back from transcribing, and the
 * API exposes no signal to tell those apart, so both render as 'Recorded'
 * rather than guessing.
 */
const WAITING_SUBSTATE_TEXT = { received: 'Recorded', transcribing: 'Transcribing', routed: 'Routed' };

/**
 * The Running substate word from a worker's task.progress `step` payload.
 * Workers signal planning/building/verifying by starting their step with
 * that word (task_telemetry.py --step); 'started' is the default first
 * checkpoint and is NOT surfaced as a phase — a running row reads plain
 * 'Running' until a substantive substate arrives. Anything else is
 * untagged progress — plain 'Running'.
 */
function phaseFromStep(step) {
  if (typeof step !== 'string' || !step) return null;
  const m = /^(planning|building|verifying)\b/i.exec(step);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

/** The most recent task.progress step for a task's own event log (conversation
 *  header substate — the list summary's precomputed latest_step is only
 *  populated by the list endpoint, not the conversation-detail one). */
function latestProgressStep(task) {
  const events = (task && task.events) || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.kind === 'task.progress' && e.payload && typeof e.payload.step === 'string') {
      return e.payload.step;
    }
  }
  return null;
}

/**
 * The task-level state word. `step` is the latest task.progress step, used
 * only for 'running'. Returns { text, accent } — accent is true for exactly
 * one state, "Needs You".
 */
function stateWord(state, step) {
  if (state === 'awaiting_input') return { text: STATE_TEXT.awaiting_input, accent: true };
  if (state === 'running') return { text: phaseFromStep(step) || STATE_TEXT.running, accent: false };
  if (Object.prototype.hasOwnProperty.call(WAITING_SUBSTATE_TEXT, state)) {
    return { text: WAITING_SUBSTATE_TEXT[state], accent: false };
  }
  const text = Object.prototype.hasOwnProperty.call(STATE_TEXT, state) ? STATE_TEXT[state] : UNKNOWN_STATE_TEXT;
  return { text, accent: false };
}

/**
 * The conversation-detail header word: the server's thread status word, with
 * the running phase appended ("Running · Verifying"). Returns { text, tone }.
 */
function conversationHeaderWord(conv) {
  const text = threadStatusWord(conv);
  if (conv.status === 'running') {
    const tasks = conv.tasks || [];
    const phase = phaseFromStep(latestProgressStep(tasks[tasks.length - 1]));
    return { text: phase ? text + ' · ' + phase : text, tone: statusToneClass(conv.status) };
  }
  return { text, tone: statusToneClass(conv.status) };
}

/** A thread's status word: the server's token through THREAD_STATUS_TEXT. A
 *  row with no token (an older server mid-deploy, or a hidden thread reached
 *  through Older conversations) falls back to its newest task's word. */
function threadStatusWord(conv) {
  if (conv && Object.prototype.hasOwnProperty.call(THREAD_STATUS_TEXT, conv.status)) {
    return THREAD_STATUS_TEXT[conv.status];
  }
  return stateWord(conv ? conv.state : '').text;
}

/** The four tones, not one colour per status: attention, problem, neutral,
 *  muted — styles.css `.state.status-*`. */
function statusToneClass(status) {
  if (status === 'needs_you' || status === 'ready') return 'status-attention';
  if (status === 'failed') return 'status-problem';
  if (status === 'viewed' || status === 'concluded' || status === 'cancelled' || status === 'done') return 'status-muted';
  return 'status-neutral';
}

function isTerminal(taskState) { return TERMINAL_STATES.includes(taskState); }

// ---------------------------------------------------------------------------
// Formatting helpers (E8)
// ---------------------------------------------------------------------------

function relativeTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso ?? '');
  const diff = Date.now() - t;
  if (diff < 45000) return 'just now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return mins + ' min ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  if (hours < 48) return 'yesterday';
  return new Date(t).toLocaleDateString();
}

/**
 * The row's time-chip label — '6m', '1h', '2d' — no "ago", no state word:
 * the chip's own icon (created vs updated) already says which timestamp it
 * is, so the text stays down to the number.
 */
function compactAge(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.round(Math.max(0, Date.now() - t) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h';
  return Math.round(hours / 24) + 'd';
}

/** Spoken length, for the working block: '45s', '5 minutes', '1h 12m'. */
function duration(ms) {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return secs + 's';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins + (mins === 1 ? ' minute' : ' minutes');
  const hours = Math.floor(mins / 60);
  return hours + 'h ' + (mins - hours * 60) + 'm';
}

/** The conversation's compact summary line: the answer's first sentence. */
/**
 * Strip markdown markers FIRST, then detect the sentence end — matching on
 * raw markdown let "domains.**" fail the [.!?](\s|$) test and run the whole
 * match out to the 180-char cap (2026-09-09 follow-up). ':' also terminates
 * a sentence when followed by whitespace (never mid-time, "9:00", since that
 * colon is followed by a digit, not whitespace) but is dropped from the
 * returned text — a trailing colon reads as if the sentence got cut off.
 */
function firstSentence(text) {
  const s = stripInlineMarkers(String(text || '')).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = /^(.{1,180}?[.!?:])(\s|$)/.exec(s);
  let head = m ? m[1] : s;
  if (head.endsWith(':')) head = head.slice(0, -1);
  return head.length > 180 ? head.slice(0, 177).replace(/\s+\S*$/, '') + '…' : head;
}

/** Result copy renders as paragraphs; a blank line is the only separator. */
function paragraphs(text) {
  return String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Answer rendering (WP answer-render, 2026-09-09) — a deterministic,
// no-innerHTML renderer for result_summary / answer text: single newlines
// become <br> (never a collapsed space), an embedded numbered/bulleted run
// promotes to a real <ol>/<ul>, **bold**/*em*/_em_ render, a leading markdown
// heading demotes to a bold lead line, and bare https:// links render as
// <a rel="noopener">. Every node is built with h()/document.createTextNode.
// ---------------------------------------------------------------------------

/**
 * Enumerator match for the list-splitting rule: `1)`, `1.`, `-`, `•` or `*`
 * counts only at the start of the text or immediately after sentence
 * punctuation (. ! ? :) plus whitespace, and only when followed by
 * whitespace itself — this is what keeps "about 13 km" or "6:30-7:30 PM"
 * from being mistaken for a list marker, and "**bold**" from being mistaken
 * for a bullet (the second `*` isn't whitespace).
 */
function findEnumerators(text) {
  const re = /(?:^|(?<=[.!?:]\s))(?:(\d{1,3})[.)]|[-•*])\s+/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: re.lastIndex, ordered: m[1] !== undefined });
  return out;
}

/**
 * Splits a paragraph's raw text into a lead line plus 2+ list items when the
 * enumerator rule fires at least twice; otherwise null (render as prose).
 * Each item's text runs to the next enumerator, or to the end of the
 * paragraph for the last item — a long final item (any trailing prose folds
 * into it) is the accepted shape of this mechanical split, not a bug.
 */
function splitList(text) {
  const marks = findEnumerators(text);
  if (marks.length < 2) return null;
  const ordered = marks[0].ordered;
  const lead = text.slice(0, marks[0].start).trim();
  const items = marks
    .map((mk, i) => text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length).trim())
    .filter((s) => s.length > 0);
  return items.length >= 2 ? { lead, items, ordered } : null;
}

/**
 * Line-start dash item split, mirroring answer-shapes.js's
 * answerLineDashSplit (t-311/D2): a literal `- ` at column 0 of its line is
 * unambiguous, so plainParagraphText tries this FIRST, same as
 * classifyBlock — otherwise a bold-label lead line (never matching
 * findEnumerators' lookbehind) followed by a dash item that itself ends in
 * sentence punctuation folds the label and item 1 into the lead, with a
 * literal `- ` left sitting inside the flattened snippet text.
 */
const LINE_DASH_ITEM_RE = /^-\s/;
function lineDashSplit(para) {
  const lines = para.split('\n');
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (LINE_DASH_ITEM_RE.test(lines[i])) { firstIdx = i; break; }
  }
  if (firstIdx === -1) return null;
  const lead = lines.slice(0, firstIdx).join('\n').trim();
  const items = [];
  for (let i = firstIdx; i < lines.length; i++) {
    if (LINE_DASH_ITEM_RE.test(lines[i])) items.push(lines[i].replace(LINE_DASH_ITEM_RE, '').trim());
    else if (items.length) items[items.length - 1] += '\n' + lines[i].trim();
  }
  return items.length ? { lead, items, ordered: false } : null;
}

/** Bare-URL detector: trims trailing sentence punctuation off the match. */
function extractLinks(text) {
  const re = /https?:\/\/[^\s<>()"']+/g;
  const out = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ link: false, text: text.slice(last, m.index) });
    let url = m[0];
    let trail = '';
    while (url.length && /[.,;:!?)\]]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
    out.push({ link: true, href: url, text: url });
    if (trail) out.push({ link: false, text: trail });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ link: false, text: text.slice(last) });
  return out;
}

/** Word-bounded single star or underscore emphasis: balanced markers only, applied to plain (non-bold, non-link) text. */
const EMPHASIS_RE = /(^|[\s(])([*_])(?!\2)(\S(?:.*?\S)?)\2(?=[\s).,;:!?]|$)/g;
function splitEmphasis(text) {
  const out = [];
  let last = 0, m;
  EMPHASIS_RE.lastIndex = 0;
  while ((m = EMPHASIS_RE.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ em: false, text: text.slice(last, start) });
    out.push({ em: true, text: m[3] });
    last = m.index + m[0].length;
    EMPHASIS_RE.lastIndex = last;
  }
  if (last < text.length) out.push({ em: false, text: text.slice(last) });
  return out;
}

/**
 * Inline markdown for one line of answer text: **bold** -> <strong>, single
 * a single star or underscore pair -> <em> (word-bounded, balanced), bare
 * https:// -> <a>. A stray unbalanced ** is stripped rather than shown; a
 * stray unbalanced single star or underscore is left as a literal character.
 */
function parseInlineText(raw) {
  const boldRe = /\*\*([^*]+?)\*\*/g;
  const segments = [];
  let last = 0, m;
  while ((m = boldRe.exec(raw))) {
    if (m.index > last) segments.push({ bold: false, text: raw.slice(last, m.index) });
    segments.push({ bold: true, text: m[1] });
    last = boldRe.lastIndex;
  }
  if (last < raw.length) segments.push({ bold: false, text: raw.slice(last) });

  const nodes = [];
  for (const seg of segments) {
    if (seg.bold) { nodes.push(h('strong', null, seg.text)); continue; }
    const plain = seg.text.split('**').join(''); // stray unbalanced **, stripped not shown
    for (const part of extractLinks(plain)) {
      if (part.link) { nodes.push(h('a', { href: part.href, target: '_blank', rel: 'noopener' }, part.text)); continue; }
      for (const em of splitEmphasis(part.text)) nodes.push(em.em ? h('em', null, em.text) : document.createTextNode(em.text));
    }
  }
  return nodes.length ? nodes : [document.createTextNode('')];
}

/** One paragraph/list-item's text: single \n as <br> (never collapsed to a space), then inline markdown per line. */
function renderLines(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(h('br'));
    out.push(...parseInlineText(line));
  });
  return out;
}

/**
 * The answer component registry (2026-09-11): public/answer-shapes.js
 * classifies each answer block; these renderers draw it. The kind set is the
 * classifier's vocabulary — a kind added there without a renderer here falls
 * through to prose in the dispatch below. renderParagraphInto is gone: its
 * heading branch became renderHeadingBlock, its list branch renderListBlock,
 * its prose branch renderProseBlock (it had no other caller).
 */
const ANSWER_COMPONENTS = {
  code: renderCodeBlock,
  'raw-html': renderRawHtmlBlock,
  table: renderTableBlock,
  'label-value': renderLabelValueBlock,
  heading: renderHeadingBlock,
  list: renderListBlock,
  prose: renderProseBlock,
};

/** Max label-value/heading re-dispatch depth (pathological-nesting guard). */
const ANSWER_MAX_DEPTH = 2;

function renderBlocks(blocks, nodes, depth, onParagraphStart) {
  for (const block of blocks) {
    if (block.kind === 'code' || block.kind === 'raw-html') {
      ANSWER_COMPONENTS[block.kind](block, nodes, depth);
      continue;
    }
    for (const para of paragraphs(block.text)) {
      const shape = classifyBlock(para);
      if (onParagraphStart) onParagraphStart(shape, para);
      (ANSWER_COMPONENTS[shape.kind] || ANSWER_COMPONENTS.prose)(shape, para, nodes, depth);
    }
  }
}

/**
 * P1: Parse result_structured JSON. Returns the parsed object when it has a
 * valid `type` field, or null on any parse/shape failure (the caller falls
 * through to the markdown path). Unknown fields are allowed (forward-
 * compatible); the server-side validator (task_complete.py) is the strict
 * gate — this client-side parse is a permissive safety check.
 */
function safeParseStructured(text) {
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    if (data && typeof data.type === 'string') return data;
  } catch (e) { /* fall through to markdown */ }
  return null;
}

/**
 * AI-234 chips fix (2026-09-15): tasks.suggested_items is a TEXT column — the
 * API delivers the raw JSON string, so Array.isArray(task.suggested_items) was
 * false for every row and the chips never rendered. Parse it here the same
 * permissive way safeParseStructured does; a string[] of non-empty labels or
 * [] on any failure (fail-closed: no chips, answer untouched).
 */
function suggestedItemLabels(task) {
  const raw = task.suggested_items;
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string' && s.trim());
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s.trim()) : [];
  } catch (e) { return []; }
}

/**
 * P1: Minimal structured-data fallback renderer. Renders items as labeled
 * blocks — a heading per item, attributes as a definition list. It stays the
 * renderer for UNKNOWN types only — every declared type has a dedicated
 * renderer now (comparison P2, form-set P4, listing/guide/summary P5). For
 * form-set it is also the safety net: a malformed `steps` payload (the
 * renderer's normaliser rejects it) still prints each step's label as a
 * readable list instead of a blank card. Hardened past the server validator:
 * a corrupt result_structured row (direct ledger write, a worker bypassing
 * task_complete.py, forward-compat shape drift) must never throw inside
 * renderTurnContent — one bad row would blank the whole conversation view.
 * form-set rows carry `steps`, not `items` — each step's `prompt`/`title`
 * is its block label.
 */
function renderStructuredFallback(data) {
  const nodes = [];
  if (data && typeof data.title === 'string' && data.title) {
    nodes.push(h('p', { class: 'answer' }, h('strong', null, data.title)));
  }
  if (data && typeof data.recommendation === 'string' && data.recommendation) {
    nodes.push(h('p', { class: 'answer' }, data.recommendation));
  }
  const items = Array.isArray(data.items) ? data.items
    : (Array.isArray(data.steps) ? data.steps : []);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const itemNodes = [];
    const label = typeof item.name === 'string' ? item.name
      : (typeof item.prompt === 'string' ? item.prompt
      : (typeof item.title === 'string' ? item.title : ''));
    if (label) itemNodes.push(h('p', { class: 'answer' }, h('strong', null, label)));
    if (item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)) {
      const dl = h('dl', { class: 'struct-attrs' });
      for (const [key, value] of Object.entries(item.attributes)) {
        dl.append(h('dt', null, key), h('dd', null, String(value)));
      }
      itemNodes.push(dl);
    }
    if (itemNodes.length) nodes.push(h('div', { class: 'struct-item' }, ...itemNodes));
  }
  return nodes;
}

/** The comparison payload's one-line verdict, marker-stripped, or '' — the flat
 *  path's lead line and the tiered path's fallback IN SHORT lead (SPEC §1.1:
 *  the recommendation is the verdict the presentation layer surfaces). */
function structuredLeadText(data) {
  const rec = typeof data.recommendation === 'string' ? data.recommendation.trim() : '';
  return rec ? stripAnswerMarkers(rec) : '';
}

/** Comparison items' attribute rows: the union of every item's keys in
 *  first-seen order. A well-formed comparison carries the same keys per item,
 *  and one shared order is what keeps their ROWS aligned across cards — a
 *  per-item Object.entries order lets two cards drift (SPEC §2.2 asks for
 *  scannable rows; this is what the single-DOM card layout can honour). Keys an
 *  item does not carry are skipped in that card, never rendered as an empty
 *  cell. */
function comparisonAttributeKeys(items) {
  const keys = [];
  for (const item of items) {
    const attrs = item && item.attributes;
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) continue;
    for (const key of Object.keys(attrs)) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** One action control. `call` and `link` are anchors — the platform does the
 *  work (dialer, new tab). `task`, `save` and `share` are buttons wired through
 *  runStructuredAction (P3): the handler needs the control itself (a one-shot
 *  disable; a save toggle that rewrites its own label), so the button is built
 *  first and the listener attached to it — an h() onclick attr closure cannot
 *  see the element it sits on. An action with no label, an unknown kind, or a
 *  missing target field renders NOTHING: a control that swallows a tap, or an
 *  anchor with href="tel:undefined", is worse than no control. So does a
 *  `share` action on a device with no navigator.share — the conversation share
 *  sheet's own rule. `itemLabel` names the item the action belongs to — five
 *  cards each carrying "View listing" are five identical links to a screen
 *  reader, so the accessible name carries the item (WCAG 2.5.3 keeps the
 *  visible label). */
function renderActionButton(action, task, itemLabel) {
  // `label` is the DISPLAY label: a save action whose item is already saved
  // shows the saved state instead of the worker's own label, and the
  // accessible name follows the visible text. applySavedLabel() draws the same
  // pair after a toggle.
  let label = typeof action.label === 'string' ? action.label.trim() : '';
  if (!label) return null;
  if (action.kind === 'save' && isItemSaved(task, itemLabel)) label = SAVED_LABEL;
  const aria = itemLabel ? { 'aria-label': label + ', ' + itemLabel } : {};
  if (action.kind === 'call' && typeof action.value === 'string' && action.value.trim()) {
    return h('a', { class: 'act act-quiet cmp-act', href: 'tel:' + action.value.trim(), ...aria }, label);
  }
  // A link action's url must be http(s) — the same scheme rule the markdown
  // renderer keeps (javascript:/data: stay literal text there). The server
  // validator checks label+kind only (C9), so a javascript: url would
  // otherwise become an executable anchor in the app's own origin.
  if (action.kind === 'link' && typeof action.url === 'string' && /^https?:\/\//i.test(action.url.trim())) {
    return h('a', {
      class: 'act act-quiet cmp-act', href: action.url.trim(),
      target: '_blank', rel: 'noopener', ...aria,
    }, label);
  }
  if (action.kind === 'share' && !navigator.share) return null;
  if (action.kind === 'task' || action.kind === 'save' || action.kind === 'share') {
    const control = h('button', { class: 'act act-quiet cmp-act', type: 'button', ...aria }, label);
    control.addEventListener('click', () => runStructuredAction(action, task, control, itemLabel));
    return control;
  }
  return null;
}

/** The action row's controls, in declaration order; [] when there are none
 *  (the caller then adds no row at all). */
function renderActionButtons(actions, task, itemLabel) {
  const list = Array.isArray(actions) ? actions : [];
  const nodes = [];
  for (const action of list) {
    if (!action || typeof action !== 'object') continue;
    const control = renderActionButton(action, task, itemLabel);
    if (control) nodes.push(control);
  }
  return nodes;
}

/**
 * Named-item stores (P3, generalized P5): ONE localStorage key per store
 * holding `{ "<task_id>": ["<item name>", …] }`, the readMarks idiom (one key,
 * one JSON object, permissive parse, bounded). `vi.saved` is the save action's
 * bookmark store; `vi.guide.done` is the guide view's checked-step store —
 * same shape, different key. Keyed by task because the marks belong to the
 * answer they came from, and by the item's NAME because that is the row's
 * identity — the same string the chip anchor and the accessible name carry.
 * Every access is try/catch: private mode throws on localStorage, and a mark
 * must never break a render. A corrupt value fails closed to {} — the
 * operator can lose marks, never the answer.
 */
const LS_SAVED = 'vi.saved';
/** The guide view's checked-step store, same name-list shape as vi.saved. */
const LS_GUIDE_DONE = 'vi.guide.done';
/** A saved save-button's visible label; the render path and the in-place toggle
 *  both draw from this one constant. */
const SAVED_LABEL = 'Saved ✓';
/** Store bound PER KEY — readMarks' 200-entry cap (`vi-<hex>` task keys are
 *  non-numeric, so insertion order holds). */
const NAME_STORE_MAX_TASKS = 200;

function nameStore(lsKey) {
  try {
    const raw = JSON.parse(localStorage.getItem(lsKey) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

/** One task's marked names; a value that is not a string array reads as none
 *  (the same fail-closed rule as the store itself). */
function nameStoreList(store, taskId) {
  const list = store ? store[taskId] : null;
  return Array.isArray(list) ? list.filter((name) => typeof name === 'string' && name) : [];
}

/** Is this name marked for this task in this store? False without a task id
 *  or a name — the two halves of the store key (never a shared '' entry). */
function nameStoreHas(lsKey, task, itemLabel) {
  if (!task || !task.task_id || !itemLabel) return false;
  return nameStoreList(nameStore(lsKey), task.task_id).includes(itemLabel);
}

/**
 * Flip one name's marked state in a store and persist it. Returns the NEW
 * state (true = marked), or null when there is nothing to key on or the write
 * failed — the caller then leaves the control alone rather than showing a
 * state that never reached storage. `seed` carries the payload's own marks
 * (the guide's `done: true` steps): while the task has NO stored list the
 * toggle applies to the seed instead of to an empty list, and whenever the
 * payload carries defaults an emptied list stays kept as [] — a deleted key
 * would re-seed the same defaults on the next render, resurrecting every
 * step the operator unchecked. Once the task's key exists the store is
 * authoritative; the seed is never consulted again (the operator's own marks
 * outrank a regenerated payload's claim). Removing the last name drops the
 * key only for stores with no payload defaults — the store never accumulates
 * empty arrays it has no use for.
 */
function toggleNameInStore(lsKey, task, itemLabel, seed) {
  if (!task || !task.task_id || !itemLabel) return null;
  const store = nameStore(lsKey);
  const has = Object.prototype.hasOwnProperty.call(store, task.task_id);
  // `seed` is the payload's own marks — the guide's `done: true` steps. It
  // applies only while the task has no stored list (once the store has an
  // entry, the operator's marks are authoritative and the seed is never
  // consulted again). A payload WITH defaults also keeps an emptied list:
  // deleting the key would re-seed the same defaults next render and
  // resurrect every step the operator unchecked — an explicit [] IS the
  // answer. With no defaults (vi.saved passes nothing) an emptied list
  // drops its key, so the store never accumulates empty arrays it has no
  // use for.
  const seeded = Array.isArray(seed) && seed.length > 0;
  const list = has ? nameStoreList(store, task.task_id) : (seeded ? seed : []);
  const marked = !list.includes(itemLabel);
  const next = marked ? list.concat(itemLabel) : list.filter((name) => name !== itemLabel);
  if (next.length || seeded) store[task.task_id] = next;
  else delete store[task.task_id];
  const keys = Object.keys(store);
  if (keys.length > NAME_STORE_MAX_TASKS) {
    for (const k of keys.slice(0, keys.length - NAME_STORE_MAX_TASKS)) delete store[k];
  }
  try { localStorage.setItem(lsKey, JSON.stringify(store)); } catch { return null; }
  return marked;
}

/** Is this item already saved? False without a task id or an item name — the
 *  two halves of the store key (never a shared '' entry). */
function isItemSaved(task, itemLabel) {
  return nameStoreHas(LS_SAVED, task, itemLabel);
}

/** The save action's toggle: vi.saved with no seed — an item defaults to
 *  unsaved, so an emptied task list drops its key. */
function toggleSavedItem(task, itemLabel) {
  return toggleNameInStore(LS_SAVED, task, itemLabel);
}

/** Rewrite a save button in place after a toggle — its label and its accessible
 *  name, exactly the pair the render path draws (the conversation body rebuilds
 *  the whole turn log on a signature change, so the two paths must agree). */
function applySavedLabel(control, action, itemLabel, saved) {
  const label = saved ? SAVED_LABEL
    : (typeof action.label === 'string' ? action.label.trim() : '');
  control.replaceChildren(label);
  if (itemLabel) control.setAttribute('aria-label', label + ', ' + itemLabel);
}

/**
 * P3: the three action kinds that need app wiring, behind the P2 seam — the
 * same three kinds renderActionButton builds as buttons. `control` is the
 * button that was tapped and `itemLabel` the item it belongs to. Every branch
 * ends in feedback (a notice, a label change or a disabled control): SPEC §3.2
 * allows no silent tap.
 */
function runStructuredAction(action, task, control, itemLabel) {
  if (action.kind === 'task') return runTaskAction(action, task, control);
  if (action.kind === 'save') return runSaveAction(action, task, control, itemLabel);
  if (action.kind === 'share') return runShareAction(action, task, itemLabel);
}

/**
 * A `task` action (SPEC §3.3): a NEW voice-inbox task from the action's prompt,
 * carrying `feedback_about` — the answer's task — so the receiving worker knows
 * which answer the action came from (route_task.py briefs it from that
 * conversation). Never a continuation: the API rejects `feedback_about` with
 * `continues`, and a card action is its own request, not a reply into the
 * answer's thread. No pollRoute/awaitRoute either — the operator is reading the
 * answer and must not be navigated away from it. One-shot: the control disables
 * on tap (a double-tap must not create two tasks) and re-enables only on
 * failure, where a retry is real.
 */
async function runTaskAction(action, task, control) {
  const prompt = typeof action.prompt === 'string' && action.prompt.trim()
    ? action.prompt.trim()
    : (typeof action.label === 'string' ? action.label.trim() : '');
  if (!prompt) return; // unreachable: renderActionButton drops a label-less action
  control.disabled = true;
  try {
    await createTask({ text: prompt, feedbackAbout: task.task_id });
    showNotice('Sent.');
  } catch (e) {
    control.disabled = false;
    if (e.status !== 401) showNotice('Could not send: ' + e.message);
  }
}

/**
 * A `save` action: bookmark the item locally — the PLAN's decision, no server
 * round-trip and no new column (cross-device sync would need both). The control
 * toggles: a second tap removes the bookmark.
 */
function runSaveAction(action, task, control, itemLabel) {
  const saved = toggleSavedItem(task, itemLabel);
  if (saved === null) { showNotice('Could not save that.'); return; }
  applySavedLabel(control, action, itemLabel, saved);
  showNotice(saved ? 'Saved.' : 'Removed.');
}

/**
 * A `share` action: hand the item to the OS share sheet. The control only
 * exists where `navigator.share` does — renderActionButton drops it otherwise,
 * the answer-card share idiom — so there is no fallback branch here. The URL is
 * the app itself: this PWA keeps one URL for every view (views are history
 * entries on the same URL), so there is no per-answer deep link to share. A
 * dismissal is the operator's own choice, never a failure notice.
 */
async function runShareAction(action, task, itemLabel) {
  const data = task.result_structured ? safeParseStructured(task.result_structured) : null;
  const title = data && typeof data.title === 'string' && data.title.trim()
    ? data.title.trim() : itemLabel;
  try {
    await navigator.share({ title, text: itemLabel, url: location.href });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    showNotice('Could not share: ' + (e && e.message ? e.message : 'unknown error'));
  }
}

/**
 * Form-set drafts (P4, SPEC §4.1): one localStorage key per task holding the
 * in-flight answers — `vi.formset.<task_id>` → `{ answers, at, done, updatedAt }`.
 * The form widget's own `vi.form.<request_id>` idiom, namespaced so the two
 * never collide. `at` is the VIEW pointer (the step index being shown), kept
 * separately from the answers because the visited path is derived, never
 * stored — a changed answer prunes its own stale trail (SPEC §4.2). `done`
 * marks a submitted set so a re-render shows the completion state instead of
 * the form. File answers persist as NAMES ONLY — the File object lives in
 * `formSetFiles` and dies with the page, so a restored file answer is dropped
 * and the step asks for the attachment again (a re-attach is honest; a
 * phantom filename that submits nothing is not).
 */
const FORMSET_DRAFT_PREFIX = 'vi.formset.';
const FORMSET_DRAFT_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
/** taskId -> { stepId -> File }: this page's staged uploads for file steps. */
const formSetFiles = new Map();
/** taskId -> render generation: the turn log's teardown/rebuild runs
 *  renderFormSet again on the SAME task — a tap hop armed on the detached
 *  copy must die with it, or a stale timer can submit behind the rebuilt
 *  card's back (a duplicate task the operator never sent). */
const formSetGenerations = new Map();

function formsetDraftKey(taskId) {
  return FORMSET_DRAFT_PREFIX + taskId;
}

/** The stored draft for a task, or null — the vi.saved/vi.form idiom: every
 *  access is try/catch and anything unrecognised reads as no draft. */
function readFormsetDraft(taskId) {
  try {
    const raw = JSON.parse(localStorage.getItem(formsetDraftKey(taskId)) || 'null');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)) return null;
    return raw;
  } catch { return null; }
}

/** Persist the draft; returns false when the write throws (private mode) so
 *  the caller never claims a save that did not happen. */
function writeFormsetDraft(taskId, draft) {
  try {
    localStorage.setItem(formsetDraftKey(taskId), JSON.stringify(draft));
    return true;
  } catch { return false; }
}

/** Lazy eviction for abandoned drafts — runs once per form-set render, drops
 *  keys older than 30 days (sent drafts too: a done marker is only a UX nicety,
 *  not a record). */
function sweepFormsetDrafts() {
  try {
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(FORMSET_DRAFT_PREFIX)) continue;
      const raw = JSON.parse(localStorage.getItem(key) || 'null');
      const at = raw && typeof raw === 'object' && typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
      if (Date.now() - at > FORMSET_DRAFT_TTL_MS) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch { /* a read-only store sweeps nothing */ }
}

/**
 * Normalise a form-set payload into the renderer's step list, or null when
 * the payload cannot safely render (the caller then falls back to
 * renderStructuredFallback, which prints the steps as a readable list — a
 * malformed form-set is a list, never a blank card and never a half-built
 * decision tree; fail-closed like every other store reader).
 * Step fields, both spellings accepted because the SPEC's own example and the
 * shared form-widget schema disagree (C2): the question text is `prompt`
 * first, `title` second; options are `{label, note}` objects or bare strings;
 * `type` defaults to 'choice' (absent = the widget schema's only kind);
 * `locked`/`answer`/`preselected`/`branch` are optional throughout.
 */
function formsetSteps(data) {
  const rawSteps = data && Array.isArray(data.steps) ? data.steps : null;
  if (!rawSteps || !rawSteps.length) return null;
  const steps = [];
  const ids = new Set();
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const title = typeof raw.prompt === 'string' && raw.prompt.trim() ? raw.prompt.trim()
      : (typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : '');
    // The id must also match the server's declared family — a prototype-named
    // id ('__proto__') would record no answer (the setter ignores strings) and
    // soft-lock the flow on a corrupt row: fail closed to the readable list.
    if (!id || !title || ids.has(id)
        || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return null;
    ids.add(id);
    const step = {
      id,
      title,
      decide: typeof raw.decide === 'string' && raw.decide.trim() ? raw.decide.trim() : '',
      locked: raw.locked === true,
      type: raw.type === undefined || raw.type === null ? 'choice' : raw.type,
      options: [],
      branch: null,
      answer: typeof raw.answer === 'string' ? raw.answer : '',
      preselected: typeof raw.preselected === 'string' ? raw.preselected : '',
    };
    // Fail-closed on the two shapes the renderer has no lane for: a type
    // outside the four kinds (would render as a broken choice) and a locked
    // step without its answer (would dead-end the flow mid-path).
    if (step.type !== 'choice' && step.type !== 'text' && step.type !== 'confirm'
        && step.type !== 'file') return null;
    if (step.locked && !step.answer) return null;
    if (!step.locked && (step.type === 'choice' || step.type === 'confirm')) {
      // A confirm's options are optional — absent means Yes/No.
      const rawOptions = Array.isArray(raw.options)
        ? raw.options
        : (step.type === 'confirm' ? [{ label: 'Yes' }, { label: 'No' }] : []);
      for (const opt of rawOptions) {
        if (typeof opt === 'string' && opt) step.options.push({ label: opt, note: '' });
        else if (opt && typeof opt === 'object' && typeof opt.label === 'string' && opt.label) {
          step.options.push({ label: opt.label, note: typeof opt.note === 'string' ? opt.note : '' });
        }
      }
      if (!step.options.length) return null;
    }
    // A branch rides on option/answer-keyed steps only — a text or file answer
    // is free-form, so branch keys could never match it.
    if (raw.branch && typeof raw.branch === 'object' && !Array.isArray(raw.branch)
        && (step.type === 'choice' || step.type === 'confirm' || step.locked)) {
      // Null-prototype: '__proto__' (or 'constructor') is a legal option
      // label — on a plain object the write is swallowed and the read hits
      // Object.prototype (truthy → falls through to declaration order), so a
      // valid branch would silently never fire.
      step.branch = Object.create(null);
      for (const [key, target] of Object.entries(raw.branch)) {
        if (typeof target === 'string' && target) step.branch[key] = target;
      }
      if (!Object.keys(step.branch).length) step.branch = null;
    }
    steps.push(step);
  }
  return steps;
}

/**
 * The step to visit after `index`: the step's branch on the recorded answer,
 * else the next step in declaration order. Returns -1 when the flow ends —
 * which includes a branch pointing back at the step itself (a self-target is
 * an end, never a loop; SPEC §4.3/risks: never allow cycles). An unknown or
 * duplicate-id target is a worker typo: resilience says continue in
 * declaration order — the server validator (WP-1) now rejects those payloads
 * outright, this is the second net, not the spec.
 */
function formsetNextIndex(steps, index, answers) {
  const step = steps[index];
  if (!step) return -1;
  const answer = step.locked ? step.answer : answers[step.id];
  if (step.branch && typeof answer === 'string' && answer && step.branch[answer]) {
    const target = step.branch[answer];
    const hit = steps.findIndex((s) => s.id === target);
    if (hit === index) return -1;
    if (hit !== -1) return hit;
  }
  return index + 1 < steps.length ? index + 1 : -1;
}

/**
 * The visited path — a list of step INDEXES derived from the answers, never
 * stored. Stops at the first unanswered step (that is the step to show) or at
 * a revisit (a backward-pointing branch is terminal, so A → B → A ends at the
 * second A; SPEC §4.3/risks). Because the path is derived, changing a prior
 * answer prunes its stale trail automatically — the walk just stops earlier.
 */
function formsetPath(steps, answers) {
  const path = [];
  let index = 0;
  while (index >= 0 && index < steps.length && !path.includes(index)) {
    path.push(index);
    const step = steps[index];
    const answered = step.locked ? Boolean(step.answer)
      : typeof answers[step.id] === 'string' && answers[step.id].length > 0;
    if (!answered) break;
    index = formsetNextIndex(steps, index, answers);
  }
  return path;
}

/**
 * The submitted answers as plain text — the new task's request or the
 * follow-up's text, written the way the operator would have said it. One
 * "Title: value" line per VISITED step (skipped branches never appear);
 * file steps report the attachment's name. Locked steps are included — they
 * are answers too, the worker just made them.
 */
function formsetAnswersText(steps, answers, title, path) {
  const lines = [];
  if (typeof title === 'string' && title.trim()) lines.push(title.trim());
  for (const i of path) {
    const step = steps[i];
    const answer = step.locked ? step.answer : answers[step.id];
    if (typeof answer === 'string' && answer) lines.push(step.title + ': ' + answer);
  }
  return lines.join('\n');
}

/**
 * Submit a completed form-set. `mode` comes from the payload's `submit` —
 * 'create-task' (default): a new task carrying feedback_about, the P3 action
 * idiom; 'update-conversation': a follow-up INTO the answer's own
 * conversation via continues (a plain submission, no steer — this is not an
 * interruption); 'save-only': nothing leaves the device, the done-marked
 * draft IS the record (PLAN's localStorage decision; the SPEC's server row is
 * the same deferred enhancement as P3's server-side saved items — a
 * submit-mode that is also unreachable for file sets because a file cannot
 * live in a draft). Returns 'sent' | 'continued' | 'saved' | 'blocked' |
 * 'failed' — the caller maps each to a notice, never a silent tap.
 */
async function submitFormset(mode, steps, answers, data, taskId) {
  // A prior render of this card may already have submitted — a rebuild that
  // landed mid-send restores a pre-done draft and shows a live form, so this
  // copy can still reach Submit. done:true in the draft IS the receipt:
  // re-sending it would file a duplicate task the operator never made.
  if (taskId) {
    const prior = readFormsetDraft(taskId);
    if (prior && prior.done === true) return mode === 'save-only' ? 'saved' : 'sent';
  }
  const path = formsetPath(steps, answers);
  const files = [];
  for (const i of path) {
    const f = formSetFiles.get(taskId + ':' + steps[i].id);
    if (f) files.push(f);
  }
  const text = formsetAnswersText(steps, answers, data && data.title, path);
  try {
    if (mode === 'save-only') {
      if (files.length) return 'blocked';
      if (!taskId) return 'failed'; // no draft key — 'saved' would claim an unrestorable record
      // The done draft IS the record — never persist a file answer without
      // its File (a name that claims an attachment which does not exist is
      // the phantom this mode exists to refuse). A staged file already
      // returned 'blocked' above; what remains is an unstaged name, e.g. an
      // off-path step a changed earlier answer pruned.
      const record = Object.assign({}, answers);
      for (const s of steps) {
        if (s.type === 'file' && !formSetFiles.has(taskId + ':' + s.id)) delete record[s.id];
      }
      return writeFormsetDraft(taskId, { answers: record, at: steps.length - 1, done: true, updatedAt: Date.now() })
        ? 'saved' : 'failed';
    }
    const args = { text, files };
    if (mode === 'update-conversation') args.continuesTaskId = taskId;
    else args.feedbackAbout = taskId;
    await createTask(args);
    return mode === 'update-conversation' ? 'continued' : 'sent';
  } catch (e) {
    return 'failed';
  }
}

/**
 * The form-set renderer (P4, SPEC §4): one step per screen inside the answer
 * card — tap an option and it registers for ~200ms before the next step
 * slides in; text/file steps take an explicit Next; Back is always on screen.
 * Returns null when the payload cannot render (the caller falls back). The
 * whole interactive state lives in the draft + formSetFiles, so the turn
 * log's teardown/rebuild and even a reload restore the operator mid-flow —
 * the same hazard audioPlayerState exists for.
 */
function renderFormSet(data, task) {
  const steps = formsetSteps(data);
  if (!steps) return null;
  const taskId = task && typeof task.task_id === 'string' ? task.task_id : '';
  sweepFormsetDrafts();
  const mode = data && data.submit === 'update-conversation' ? 'update-conversation'
    : (data && data.submit === 'save-only' ? 'save-only' : 'create-task');
  const draft = taskId ? readFormsetDraft(taskId) : null;
  // Plain object is safe here: every key written into it is a step id, and
  // the normaliser's id-family regex already excludes prototype names — a
  // corrupt draft's foreign keys simply match no step.
  const answers = {};
  if (draft) {
    for (const [k, v] of Object.entries(draft.answers)) {
      if (typeof v === 'string' && v) answers[k] = v;
    }
  }
  // Draft first, preselected second — an answer the operator already gave
  // always beats the worker's default. And a preselected that names no option
  // (a payload past the validator) is a ghost answer the operator never made:
  // choice/confirm must match a label; text accepts any default; file steps
  // can never hold one (the file-drop below clears it anyway).
  for (const step of steps) {
    if (step.locked || !step.preselected || typeof answers[step.id] === 'string') continue;
    if ((step.type === 'choice' || step.type === 'confirm')
        && !step.options.some((o) => o.label === step.preselected)) continue;
    answers[step.id] = step.preselected;
  }
  // A restored file answer is a name without a file — drop it so the step
  // asks again (file objects are per-page, formSetFiles only).
  for (const step of steps) {
    if (step.type === 'file' && answers[step.id] && !formSetFiles.has(taskId + ':' + step.id)) {
      delete answers[step.id];
    }
  }

  const root = h('div', { class: 'formset' });
  const stage = h('div', { class: 'formset-stage' });
  root.append(stage);

  const persist = (atIndex) => {
    if (taskId) writeFormsetDraft(taskId, { answers, at: atIndex, done: false, updatedAt: Date.now() });
  };

  const isAnswered = (step) => step.locked ? Boolean(step.answer)
    : typeof answers[step.id] === 'string' && answers[step.id].length > 0;

  // The view pointer — a step INDEX, not a path index; the path itself is
  // derived on every render. Draft `at` wins; a stale or off-path `at` (the
  // answers it rode on were pruned) falls back to the furthest point.
  let atIndex = 0;
  {
    const path = formsetPath(steps, answers);
    const fromDraft = draft && Number.isInteger(draft.at) && draft.at >= 0
      && draft.at < steps.length && path.includes(draft.at);
    atIndex = fromDraft ? draft.at : path[path.length - 1];
  }

  let nextBtn = null;   // the text input's listener reaches it across renders
  let escapeInput = null;
  // A tap schedules its own advance ~200ms out; a second tap (or any manual
  // navigation) inside that window must cancel the first hop, not double it.
  // render() bumps navSeq — a timer that captured an older generation is
  // dead. The SECOND guard is cross-render: navSeq is per-closure, so a
  // rebuild's fresh renderer cannot see this copy's armed hop — the task
  // generation must also still be THIS render's, or the detached timer is
  // firing into a card the DOM already dropped.
  let navSeq = 0;
  const generation = (formSetGenerations.get(taskId) || 0) + 1;
  formSetGenerations.set(taskId, generation);

  /** Recompute the path and keep the view pointer on it — after an answer
   *  changes the walk may stop earlier, and a pointer off the path is a bug
   *  (the step it names may no longer be reachable). */
  const refreshPath = () => {
    const path = formsetPath(steps, answers);
    if (!path.includes(atIndex)) atIndex = path[path.length - 1];
    return path;
  };

  /** Move forward one derived hop — or submit when there is nowhere to go:
   *  the flow ended (next === -1) or the next step sits on the path AT OR
   *  BEHIND the view pointer (a backward branch is terminal — the operator
   *  already visited it; SPEC §4.3/risks: never allow cycles). A FORWARD hop
   *  to a visited step is plain navigation — that is exactly what changing a
   *  prior answer needs, or the flow could never move. */
  const advance = () => {
    const next = formsetNextIndex(steps, atIndex, answers);
    const path = formsetPath(steps, answers);
    if (next === -1 || next >= steps.length) { doSubmit(); return; }
    const atPos = path.indexOf(atIndex);
    const nextPos = path.indexOf(next);
    if (nextPos !== -1 && atPos !== -1 && nextPos <= atPos) { doSubmit(); return; }
    atIndex = next;
    render(1);
  };

  let submitting = false; // Submit and Submit early are two controls for one send
  const doSubmit = async (control) => {
    if (submitting) return;
    submitting = true;
    navSeq++;            // cancel any pending option-tap hop
    if (control) control.disabled = true; // advance() reaches us with none
    const result = await submitFormset(mode, steps, answers, data, taskId);
    if (result === 'sent' || result === 'continued' || result === 'saved') {
      for (const k of [...formSetFiles.keys()]) {
        if (k.startsWith(taskId + ':')) formSetFiles.delete(k);
      }
      if (taskId) writeFormsetDraft(taskId, { answers, at: atIndex, done: true, updatedAt: Date.now() });
      stage.replaceChildren(h('div', { class: 'formset-step' },
        h('div', { class: 'formset-done' },
          checkIcon(16, 'currentColor'),
          mode === 'save-only' ? ' Done — your answers are saved on this device.'
            : ' Done — your answers have been sent.')));
      if (result === 'continued') {
        refreshConversation().then(scrollFollowUpIntoView).catch(() => {});
      }
      showNotice(mode === 'save-only' ? 'Saved.' : 'Sent.');
      return;
    }
    submitting = false;
    if (control) control.disabled = false;
    showNotice(result === 'blocked'
      ? 'Files can’t be saved by this kind of form — remove the attachment to finish.'
      : (mode === 'save-only' ? 'Could not save that.' : 'Could not send — try again.'));
  };

  /**
   * Draw the current step. `dir` is the slide direction: +1 forward, -1 back.
   * One node per step — the transition is a CSS animation on a fresh node, so
   * every navigation animates (a real-DOM clone trick is unnecessary; a fresh
   * node IS the fresh animation).
   */
  const render = (dir) => {
    navSeq++;
    const path = refreshPath();
    const step = steps[atIndex];
    const node = h('div', { class: 'formset-step' + (dir < 0 ? ' back' : '') });
    node.append(h('div', { class: 'formset-progress' },
      'Step ' + (atIndex + 1) + ' of ' + steps.length));
    node.append(h('div', { class: 'formset-title' }, step.title));
    if (step.decide) node.append(h('div', { class: 'formset-decide' }, step.decide));

    escapeInput = null;
    if (step.locked) {
      node.append(h('div', { class: 'form-step-locked' },
        checkIcon(14, 'currentColor'), ' ', step.answer));
    } else if (step.type === 'text') {
      const input = h('input', {
        class: 'field', type: 'text',
        placeholder: 'Type your answer', 'aria-label': step.title,
      });
      if (typeof answers[step.id] === 'string') input.value = answers[step.id];
      input.addEventListener('input', () => {
        const value = input.value.trim();
        if (value) answers[step.id] = value; else delete answers[step.id];
        if (nextBtn) nextBtn.disabled = !value;
        persist(atIndex);
      });
      node.append(input);
    } else if (step.type === 'file') {
      const fileInput = h('input', { type: 'file', hidden: true, 'aria-hidden': 'true' });
      const pickBtn = h('button', {
        class: 'act act-quiet', type: 'button', 'aria-label': 'Choose a file for ' + step.title,
      }, answers[step.id] ? 'Change file' : 'Choose a file');
      const nameLine = h('div', { class: 'formset-file' }, answers[step.id] || 'No file chosen');
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        formSetFiles.set(taskId + ':' + step.id, f);
        answers[step.id] = f.name;
        nameLine.replaceChildren(document.createTextNode(f.name));
        pickBtn.replaceChildren(document.createTextNode('Change file'));
        if (removeBtn) removeBtn.hidden = false;
        if (nextBtn) nextBtn.disabled = false;
        persist(atIndex);
      });
      pickBtn.addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
      // Staged files must be removable — the save-only 'blocked' notice tells
      // the operator to remove the attachment, so the control has to exist
      // (and detaching a staged upload is honest UX in every mode).
      const removeBtn = h('button', {
        class: 'act act-quiet', type: 'button', hidden: !answers[step.id],
        'aria-label': 'Remove the attachment for ' + step.title,
      }, 'Remove');
      removeBtn.addEventListener('click', () => {
        formSetFiles.delete(taskId + ':' + step.id);
        delete answers[step.id];
        nameLine.replaceChildren(document.createTextNode('No file chosen'));
        pickBtn.replaceChildren(document.createTextNode('Choose a file'));
        removeBtn.hidden = true;
        if (nextBtn) nextBtn.disabled = true;
        persist(atIndex);
      });
      node.append(fileInput, pickBtn, removeBtn, nameLine);
    } else {
      // choice / confirm — one tap registers, then the slide. The escape
      // field is a choice step's only text lane (a confirm is a real Yes/No).
      const group = h('div', { class: 'form-options', role: 'radiogroup', 'aria-label': step.title });
      for (const opt of step.options) {
        const row = h('button', {
          class: 'option formset-option', type: 'button', role: 'radio',
          'aria-checked': answers[step.id] === opt.label ? 'true' : 'false',
        },
          h('span', { class: 'option-dot' },
            answers[step.id] === opt.label ? h('span', { class: 'option-dot-fill' }) : null),
          h('span', { class: 'form-option-text' },
            h('span', { class: 'form-option-label' }, opt.label),
            opt.note ? h('span', { class: 'form-option-note' }, opt.note) : null));
        row.addEventListener('click', () => {
          answers[step.id] = opt.label;
          if (escapeInput) escapeInput.value = '';
          persist(atIndex);
          render(1);
          const gen = navSeq;
          setTimeout(() => {
            if (gen === navSeq && formSetGenerations.get(taskId) === generation) advance();
          }, 200);
        });
        group.append(row);
      }
      node.append(group);
      if (step.type === 'choice') {
        escapeInput = h('input', {
          class: 'field form-escape', type: 'text',
          placeholder: 'Or type your own answer',
          'aria-label': step.title + ' — own answer',
        });
        if (answers[step.id] && !step.options.some((o) => o.label === answers[step.id])) {
          escapeInput.value = answers[step.id];
        }
        escapeInput.addEventListener('input', () => {
          const value = escapeInput.value.trim();
          if (value) {
            answers[step.id] = value;
            // a typed answer is the answer — the option rows uncheck
            for (const optRow of group.children) optRow.setAttribute('aria-checked', 'false');
          } else {
            delete answers[step.id];
          }
          if (nextBtn) nextBtn.disabled = !value;
          persist(atIndex);
        });
        node.append(escapeInput);
      }
    }

    const controlsRow = h('div', { class: 'act-row' });
    const backBtn = h('button', {
      class: 'act act-quiet', type: 'button', disabled: path.indexOf(atIndex) <= 0,
      'aria-label': 'Back a step',
    }, 'Back');
    backBtn.addEventListener('click', () => {
      const pos = path.indexOf(atIndex);
      if (pos <= 0) return;
      atIndex = path[pos - 1];
      render(-1);
    });
    controlsRow.append(backBtn);

    const isLast = () => {
      const next = formsetNextIndex(steps, atIndex, answers);
      if (next === -1 || next >= steps.length) return true;
      const p = formsetPath(steps, answers);
      const nextPos = p.indexOf(next);
      return nextPos !== -1 && nextPos <= p.indexOf(atIndex);
    };
    const answered = isAnswered(step);
    if (isLast()) {
      nextBtn = h('button', {
        class: 'act act-primary', type: 'button', disabled: !answered,
        'aria-label': 'Submit answers',
      }, 'Submit');
      nextBtn.addEventListener('click', () => doSubmit(nextBtn));
      controlsRow.append(nextBtn);
    } else {
      nextBtn = h('button', {
        class: 'act act-primary', type: 'button', disabled: !answered,
        'aria-label': 'Next step',
      }, 'Next');
      nextBtn.addEventListener('click', advance);
      controlsRow.append(nextBtn);
      if (data && data.submit_early === true && path.some((i) => isAnswered(steps[i]))) {
        const earlyBtn = h('button', {
          class: 'act act-quiet', type: 'button', 'aria-label': 'Submit early',
        }, 'Submit early');
        earlyBtn.addEventListener('click', () => doSubmit(earlyBtn));
        controlsRow.append(earlyBtn);
      }
    }
    node.append(controlsRow);
    stage.replaceChildren(node);
    persist(atIndex);
  };

  if (draft && draft.done === true) {
    stage.replaceChildren(h('div', { class: 'formset-step' },
      h('div', { class: 'formset-done' },
        checkIcon(16, 'currentColor'),
        // 'sent' would lie about a save-only record — nothing left the device.
        mode === 'save-only' ? ' Done — your answers are saved on this device.'
          : ' Done — your answers have been sent.')));
    return root;
  }
  render(1);
  return root;
}

/**
 * P5: the three remaining pattern views — listing, guide, summary (SPEC
 * §5). Each `*Cards`/`*Steps`/`summarySections` function returns
 * { node, anchors } exactly like comparisonCards: `node` is the container
 * (null when nothing usable renders — the dispatchers then fall back), and
 * `anchors` carry { text, node } so chipRow() lands on the row/step/card it
 * names. Each `render*` function is the flat-path wrapper: the
 * recommendation leads (.cmp-lead, the same lead line the comparison view
 * draws) and the view follows. All three tolerate malformed payloads the way
 * comparison does — items that are not objects, or carry no usable name, are
 * skipped rather than thrown on (the validator's own rules plus the corrupt-
 * row rule renderStructuredFallback documents).
 *
 * Item detail resolution — one helper, three views. `item.summary` is the
 * one-line gloss (the listing's detail line, a section's lead sentence,
 * a step's subtitle); `item.description` is the fallback gloss; `attributes`
 * contribute a "Label: value; …" line when neither is present. `points` is a
 * bullet list and `done` the guide's initial checkmark — each consumed only
 * where the type's convention names it (validator help text is the
 * contract; unknown fields still pass).
 */

/** The item's prose lead: `summary`, else `description` ('' when neither —
 *  a name-only row is fine). Attributes are NOT folded in here: a view that
 *  also renders the attribute dl would print the same values twice. */
function itemLeadLine(item) {
  const sum = typeof item.summary === 'string' ? item.summary.trim() : '';
  if (sum) return sum;
  const desc = typeof item.description === 'string' ? item.description.trim() : '';
  return desc;
}

/** The item's display detail line: the prose lead, else the attribute pairs
 *  joined on one line ('' when none). For views that show no attribute list
 *  (listing rows, guide steps) this is the only place attributes surface.
 *  Attribute values are flattened to text — this line never renders markup,
 *  so no renderLines. */
function itemDetailLine(item) {
  const lead = itemLeadLine(item);
  if (lead) return lead;
  const attrs = item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)
    ? item.attributes : null;
  if (!attrs) return '';
  const parts = [];
  for (const key of Object.keys(attrs)) {
    // Object.keys yields own enumerable names only, so hasOwnProperty is not
    // needed here — unlike comparisonCards' cross-item key union, these keys
    // come from THIS item.
    const value = attrs[key];
    parts.push(key + ': ' + (value === null || value === undefined ? '' : String(value)));
  }
  return parts.join('; ');
}

/** The item's bullet list: `points` filtered to non-empty strings. */
function itemPoints(item) {
  return Array.isArray(item.points)
    ? item.points.filter((p) => typeof p === 'string' && p.trim())
    : [];
}

/**
 * The listing view: one compact row per item — the name, one detail line,
 * and the action row. A listing is a directory (providers, branches,
 * candidates), not a comparison: rows read top-to-bottom and get their own
 * .lst- classes — P6's device layout classes stay comparison-only, and a
 * listing row is never a swipe card.
 */
function listingCards(data, task) {
  const items = Array.isArray(data.items) ? data.items : [];
  const rows = [];
  const anchors = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    const children = [h('p', { class: 'lst-name' }, h('strong', null, name))];
    const detail = itemDetailLine(item);
    if (detail) children.push(h('p', { class: 'lst-detail' }, detail));
    const actions = renderActionButtons(item.actions, task, name);
    if (actions.length) children.push(h('div', { class: 'cmp-actions' }, ...actions));
    const row = h('div', { class: 'lst-item' }, ...children);
    rows.push(row);
    anchors.push({ text: name, node: row });
  }
  if (!rows.length) return { node: null, anchors: [] };
  return { node: h('div', { class: 'lst-list' }, ...rows), anchors };
}

/** P5 flat path: the listing view under its lead line. */
function renderListing(data, task) {
  const nodes = [];
  const lead = structuredLeadText(data);
  if (lead) nodes.push(h('p', { class: 'cmp-lead' }, lead));
  const view = listingCards(data, task);
  if (view.node) nodes.push(view.node);
  return nodes;
}

/**
 * The guide view: a numbered, checkable step list — the answer is a
 * procedure, and the check state is the operator's progress, so it persists
 * at `vi.guide.done` through the same name-store the save action uses
 * (`toggleNameInStore`, seeded by the worker's own `done: true` marks — a
 * guide that arrives half-finished paints that progress, and the operator's
 * later marks are then authoritative). The head reads "N of M done" and the
 * bar repaints on every toggle: a tap that leaves no visible trace is a tap
 * that did nothing (SPEC §3.2's rule, kept).
 */
function guideSteps(data, task) {
  const items = Array.isArray(data.items) ? data.items : [];
  const taskId = task && typeof task.task_id === 'string' ? task.task_id : '';
  const seed = items
    .filter((item) => item && typeof item === 'object' && item.done === true
      && typeof item.name === 'string' && item.name.trim())
    .map((item) => item.name.trim());
  const names = [];
  const steps = [];
  const stepViews = [];
  const anchors = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    names.push(name);
    const n = names.length;
    const check = h('button', {
      class: 'gde-check', type: 'button', role: 'checkbox',
      'aria-checked': 'false',
      'aria-label': 'Done: ' + name,
    }, checkIcon(16, 'currentColor'), h('span', { class: 'gde-num' }, String(n)));
    const children = [check, h('p', { class: 'gde-name' }, h('strong', null, name))];
    const detail = itemDetailLine(item);
    if (detail) children.push(h('p', { class: 'gde-detail' }, detail));
    const points = itemPoints(item);
    if (points.length) {
      children.push(h('ul', { class: 'gde-points' },
        ...points.map((p) => h('li', null, ...renderLines(p)))));
    }
    const actions = renderActionButtons(item.actions, task, name);
    if (actions.length) children.push(h('div', { class: 'cmp-actions' }, ...actions));
    const step = h('div', { class: 'gde-step' }, ...children);
    check.addEventListener('click', () => {
      const state = toggleNameInStore(LS_GUIDE_DONE, task, name, seed);
      if (state === null) { showNotice('Could not mark that.'); return; }
      // Repaint from the store, not from `state` alone: marks key by NAME,
      // so a repeated step name flips every step carrying it — repainting
      // only the tapped node would leave its twin stale and the head count
      // short.
      paintGuideState();
    });
    steps.push(step);
    stepViews.push({ check, step, name });
    anchors.push({ text: name, node: step });
  }
  if (!steps.length) return { node: null, anchors: [] };
  const head = h('p', { class: 'gde-head' });
  const bar = h('progress', { class: 'gde-bar', max: String(steps.length) });
  function readMarks() {
    // nameStoreList yields [] for a missing key too, so presence is decided
    // by hasOwnProperty — without it a task with no stored list reads as []
    // and swallows the worker's done marks (an empty array is truthy).
    const store = taskId ? nameStore(LS_GUIDE_DONE) : null;
    const list = store && Object.prototype.hasOwnProperty.call(store, taskId)
      ? nameStoreList(store, taskId) : null;
    return list || seed;
  }
  // One paint pass for render AND toggle: every step's check state comes
  // from the live marks (initial paint = the seed-or-store snapshot), and
  // the head counts PAINTED steps — a name carried by two steps counts
  // twice, matching the two checks it visibly sets.
  function paintGuideState() {
    const marked = readMarks();
    let doneCount = 0;
    for (const v of stepViews) {
      const on = marked.includes(v.name);
      if (on) doneCount++;
      v.check.setAttribute('aria-checked', on ? 'true' : 'false');
      v.step.setAttribute('class', on ? 'gde-step done' : 'gde-step');
    }
    head.replaceChildren(doneCount + ' of ' + names.length + ' done');
    bar.setAttribute('value', String(doneCount));
  }
  paintGuideState();
  return { node: h('div', { class: 'gde-list' }, head, bar, ...steps), anchors };
}

/** P5 flat path: the guide view under its lead line. */
function renderGuide(data, task) {
  const nodes = [];
  const lead = structuredLeadText(data);
  if (lead) nodes.push(h('p', { class: 'cmp-lead' }, lead));
  const view = guideSteps(data, task);
  if (view.node) nodes.push(view.node);
  return nodes;
}

/**
 * The summary view: one section card per item — a `points` bullet list when
 * the worker structured it, the attribute definition list otherwise (the
 * same .cmp-attrs dl the comparison cards draw), the detail line as the
 * section's lead sentence when both exist. A summary is prose broken into
 * titled blocks; it is never a swipe row.
 */
function summarySections(data, task) {
  const items = Array.isArray(data.items) ? data.items : [];
  const cards = [];
  const anchors = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    const children = [h('p', { class: 'sum-name' }, h('strong', null, name))];
    // The prose lead only — attributes render below as the dl; folding them
    // into this line too would print the same values twice on one card.
    const detail = itemLeadLine(item);
    if (detail) children.push(h('p', { class: 'sum-detail' }, detail));
    const points = itemPoints(item);
    if (points.length) {
      children.push(h('ul', { class: 'sum-points' },
        ...points.map((p) => h('li', null, ...renderLines(p)))));
    } else {
      const attrs = item.attributes && typeof item.attributes === 'object'
        && !Array.isArray(item.attributes) ? item.attributes : null;
      if (attrs) {
        const dl = h('dl', { class: 'cmp-attrs' });
        let rows = 0;
        for (const key of Object.keys(attrs)) {
          // Own keys only (Object.keys) — the cross-item hasOwnProperty guard
          // comparisonCards needs does not apply inside one item's own map.
          dl.append(h('dt', null, key), h('dd', null, ...renderLines(String(attrs[key]))));
          rows++;
        }
        if (rows) children.push(dl);
      }
    }
    const actions = renderActionButtons(item.actions, task, name);
    if (actions.length) children.push(h('div', { class: 'cmp-actions' }, ...actions));
    const card = h('div', { class: 'sum-card' }, ...children);
    cards.push(card);
    anchors.push({ text: name, node: card });
  }
  if (!cards.length) return { node: null, anchors: [] };
  return { node: h('div', { class: 'sum-cards' }, ...cards), anchors };
}

/** P5 flat path: the summary view under its lead line. */
function renderSummary(data, task) {
  const nodes = [];
  const lead = structuredLeadText(data);
  if (lead) nodes.push(h('p', { class: 'cmp-lead' }, lead));
  const view = summarySections(data, task);
  if (view.node) nodes.push(view.node);
  return nodes;
}

/**
 * P6: the layout class a task's `surface` hint contributes to the comparison
 * container. `surface` (schema v13) is the viewport class of the device the
 * QUESTION was asked from, captured once at creation — never the viewport the
 * answer is being read on. It chooses which layout the container STARTS in and
 * nothing else: it never gates content (SPEC §6.3), and the 680px media query
 * takes a desktop grid away again on a narrow screen (styles.css § device
 * surface).
 *
 * Anything other than 'phone' or 'desktop' contributes NO class — including
 * the NULL every pre-v13 row carries, an absent field from an older shell, and
 * a garbage value that somehow got past the server allowlist. No class is the
 * exact pre-P6 rendering, so the fail-open path and the historical path are
 * the same path, and neither is a special case.
 *
 * Comparison only (P5 reserved the `.cmp-` prefix for exactly this). Listing
 * rows, guide steps and summary cards are unaffected this phase — their phone
 * and desktop forms differ by column count, not by layout model, and stay
 * CSS-only.
 */
function surfaceLayoutClass(task) {
  const surface = task && typeof task.surface === 'string' ? task.surface : '';
  if (surface === 'phone') return 'cmp-phone';
  if (surface === 'desktop') return 'cmp-desktop';
  return '';
}

/**
 * The comparison view's cards — ONE DOM for every layout. The CSS media query
 * in styles.css turns the desktop grid into a swipe row under 680px; nothing
 * here branches on the viewport. `cmp-swipe` is a COUNT modifier only (SPEC
 * Risks: two cards read better stacked than as a snap row), and it changes no
 * markup and no desktop layout. `cmp-phone`/`cmp-desktop` (P6) are the
 * ASKING-DEVICE modifier — appended, never substituted, so a task with no
 * surface hint produces the identical class string it produced before P6.
 *
 * Returns { node, anchors }: `node` is the container (null when there is
 * nothing to show, which is what lets the caller fall through to markdown), and
 * `anchors` are what chipRow() jumps to — a chip lands on the item it names.
 */
function comparisonCards(data, task) {
  const items = Array.isArray(data.items) ? data.items : [];
  const keys = comparisonAttributeKeys(items);
  const cards = [];
  const anchors = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    const children = [h('p', { class: 'cmp-name' }, h('strong', null, name))];
    const attrs = item.attributes && typeof item.attributes === 'object' && !Array.isArray(item.attributes)
      ? item.attributes : null;
    if (attrs && keys.length) {
      const dl = h('dl', { class: 'cmp-attrs' });
      for (const key of keys) {
        // hasOwnProperty, not `in`: a sibling card declaring a prototype-named
        // key ('toString') must not leak Object.prototype's function source
        // into THIS card as an attribute value.
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        dl.append(h('dt', null, key), h('dd', null, ...renderLines(String(attrs[key]))));
      }
      children.push(dl);
    }
    const actions = renderActionButtons(item.actions, task, name);
    if (actions.length) children.push(h('div', { class: 'cmp-actions' }, ...actions));
    const card = h('div', { class: 'cmp-card' }, ...children);
    cards.push(card);
    anchors.push({ text: name, node: card });
  }
  if (!cards.length) return { node: null, anchors: [] };
  const device = surfaceLayoutClass(task);
  const node = h('div', {
    class: (cards.length >= 3 ? 'cmp-cards cmp-swipe' : 'cmp-cards') + (device ? ' ' + device : ''),
  }, ...cards);
  return { node, anchors };
}

/**
 * P2: the comparison renderer (SPEC §2), flat path — the recommendation leads
 * and the cards follow. The tiered path uses comparisonCards() directly: there
 * the recommendation is already the IN SHORT lead above the disclosure, and
 * repeating it inside the disclosure reads as a bug. `data.title` is not
 * rendered either — the conversation header already carries the title, and the
 * IN SHORT card leads when the answer is tiered.
 */
function renderComparison(data, task) {
  const nodes = [];
  const lead = structuredLeadText(data);
  if (lead) nodes.push(h('p', { class: 'cmp-lead' }, lead));
  const cards = comparisonCards(data, task);
  if (cards.node) nodes.push(cards.node);
  return nodes;
}

/**
 * The detail region for a structured answer. Comparison gets its cards;
 * form-set gets its interactive flow (P4) — or the P1 fallback's readable
 * step list when the payload cannot safely render (a malformed decision tree
 * is a list, never a blank disclosure and never a half-built tree). The
 * three pattern types (P5) get their dedicated views; an empty pattern view
 * is meaningful, not an error — the caller falls through to the markdown
 * path rather than rendering a blank answer (SPEC Risks: "a bad structured
 * payload doesn't break the answer, it falls through"). Unknown types keep
 * the P1 fallback.
 */
function structuredDetail(data, task) {
  if (data.type === 'comparison') {
    const cards = comparisonCards(data, task);
    return { nodes: cards.node ? [cards.node] : [], anchors: cards.anchors };
  }
  if (data.type === 'form-set') {
    const node = renderFormSet(data, task);
    return { nodes: node ? [node] : renderStructuredFallback(data), anchors: [] };
  }
  if (data.type === 'listing' || data.type === 'guide' || data.type === 'summary') {
    const view = data.type === 'listing' ? listingCards(data, task)
      : data.type === 'guide' ? guideSteps(data, task)
      : summarySections(data, task);
    return { nodes: view.node ? [view.node] : [], anchors: view.anchors };
  }
  return { nodes: renderStructuredFallback(data), anchors: [] };
}

/**
 * Dispatch structured data to the renderer for its type. `comparison`,
 * `form-set`, `listing`, `guide` and `summary` have dedicated renderers
 * (P2, P4, P5); every other type keeps the P1 fallback. A form-set whose
 * steps cannot normalise falls back to the readable step list, not to
 * nothing; a pattern view with nothing usable falls through to the
 * markdown path via an empty node list.
 */
function renderStructuredAnswer(data, task) {
  switch (data.type) {
    case 'comparison': return renderComparison(data, task);
    case 'listing': return renderListing(data, task);
    case 'guide': return renderGuide(data, task);
    case 'summary': return renderSummary(data, task);
    case 'form-set': {
      const node = renderFormSet(data, task);
      return node ? [node] : renderStructuredFallback(data);
    }
    default: return renderStructuredFallback(data);
  }
}

/** The tier shape for a task with no summary text at all (a structured-only
 *  answer): never tiered, so the flat renderer draws it. */
const EMPTY_TIER = { tiered: false, lead: '', words: 0 };

/**
 * P2: the answer region's nodes for one task — the single place the structured
 * and markdown paths meet. Structured data wins when it renders something;
 * absent, unparseable, or EMPTY structured data falls through to the markdown
 * path exactly as before. The tier gate is the markdown path's own gate
 * (answerTier over result_summary), so a short structured answer still shows
 * its cards immediately instead of hiding them behind a disclosure.
 */
function answerRegionParts(task) {
  const tier = task.result_summary ? answerTier(task.result_summary) : EMPTY_TIER;
  const structured = task.result_structured ? safeParseStructured(task.result_structured) : null;
  if (structured) {
    const parts = tier.tiered
      ? tieredStructuredNodes(task, structured, tier)
      : renderStructuredAnswer(structured, task);
    if (parts && parts.length) return parts;
  }
  if (!task.result_summary) return [];
  return tier.tiered ? tieredAnswerNodes(task, tier) : renderAnswerNodes(task.result_summary);
}

/**
 * The ONE default-visible routing surface (router-metadata wave, decision 33,
 * 2026-09-20): a placement CHANGE (diverted / new-conversation / split) says
 * so on the answer card in one plain sentence — never routing jargon. On a
 * diverted turn whose target is a ledger conversation id (vi-<12 hex>) the
 * phrase "another conversation" is a real link that opens the origin
 * conversation; any other target shape renders the same honest text with no
 * link. `continued-here` and NULL render NOTHING — the default view carries
 * no routing words at all.
 */
function answerRoutingLine(task) {
  const placement = task.router_placement;
  if (placement === 'new-conversation') {
    return h('p', { class: 'answer-routing' }, 'This work started a new conversation');
  }
  if (placement === 'split') {
    return h('p', { class: 'answer-routing' }, 'Split across conversations');
  }
  if (placement === 'diverted') {
    const target = task.router_target;
    if (typeof target === 'string' && /^vi-[0-9a-f]{12}$/.test(target)) {
      return h('p', { class: 'answer-routing' }, 'Moved here from ',
        h('a', {
          href: '#',
          onclick: (e) => {
            if (e && e.preventDefault) e.preventDefault();
            navigate('conversation', target);
          },
        }, 'another conversation'));
    }
    return h('p', { class: 'answer-routing' }, 'Moved here from another conversation');
  }
  return null;
}

/**
 * Answer provenance (WS3, 2026-09-18): a quiet chip + expandable details on
 * answered cards. Fail-open — pre-v15 rows (every worker field NULL) get no
 * chip at all and render byte-identically to before. The chip is deliberately
 * NOT the accent tone: gold means "ready"; this is secondary metadata. The
 * detail lines are plain language only. Deviation noted for the operator:
 * the record's own id is rendered as the task reference — the label
 * "Reference" with `task.task_id` as the value — because the operator reads
 * that id back to us in feedback; nothing else identifies the record in
 * plain language.
 *
 * Decision 33 (2026-09-20, router-metadata wave): the collapsed label is the
 * plain inspect phrase — never the raw model/CLI name, which is technical
 * noise on the default view. Model, effort, worker, and the v16 router_*
 * routing rows live ONLY in the expanded details; each routing row renders
 * only when its field is non-NULL, `continued-here` adds no row, and the
 * `Decided by` row exists only for the operator-steer case (a router-decided
 * turn's `Chosen by` row already names the decider).
 */
function answerProvenanceRow(task) {
  // With no model and no CLI nothing was instrumented — there is nothing to
  // inspect and no chip (the WS3 fail-open rule, unchanged).
  if (!task.worker_model && !task.worker_cli) return null;
  const chipLabel = 'How this was answered';
  const rows = [];
  if (task.worker_model) rows.push(['Model', task.worker_model]);
  if (task.worker_effort) rows.push(['Effort', task.worker_effort]);
  if (task.worker_cli) rows.push(['Ran on', task.worker_cli]);
  if (task.source === 'voice') rows.push(['How it was asked', 'spoken']);
  else if (task.source === 'text') rows.push(['How it was asked', 'typed']);
  if (task.task_id) rows.push(['Reference', task.task_id]);
  // Routing rows (v16): expanded view only (decision 33), plain register.
  if (task.router_decision === 'router') rows.push(['Chosen by', 'automatic routing']);
  else if (task.router_decision === 'ladder') rows.push(['Chosen by', 'standard selection']);
  else if (task.router_decision === 'command') rows.push(['Chosen by', 'your instruction']);
  if (task.router_steer === 'steer') rows.push(['Correction', 'sent to the task already running']);
  else if (task.router_steer === 'wait') rows.push(['Timing', 'waited for the running task to finish']);
  if (task.router_steer_by === 'operator' && task.router_steer) rows.push(['Decided by', 'you did']);
  if (task.router_effort_proj === 'nearest') rows.push(['Effort note', 'adjusted to the closest setting']);
  else if (task.router_effort_proj === 'recategorize') rows.push(['Effort note', 'this assistant has no effort control']);
  if (typeof task.router_failovers === 'number' && task.router_failovers >= 1) {
    rows.push(['Attempts', 'tried ' + task.router_failovers + ' other assistant' + (task.router_failovers > 1 ? 's' : '') + ' first']);
  }
  const detailsId = 'answer-provenance-' + task.task_id;
  const details = h('div', { class: 'answer-provenance-details', id: detailsId, hidden: true },
    ...rows.map(([labelText, value]) =>
      h('p', null, h('span', { class: 'ap-label' }, labelText + ': '), h('strong', null, value))));
  const chip = h('button', {
    class: 'answer-provenance-chip', type: 'button',
    'aria-expanded': 'false', 'aria-controls': detailsId,
    onclick: () => {
      const open = chip.getAttribute('aria-expanded') === 'true';
      chip.setAttribute('aria-expanded', String(!open));
      details.hidden = open;
    },
    onkeydown: (e) => {
      if (e && e.key === 'Escape') {
        chip.setAttribute('aria-expanded', 'false');
        details.hidden = true;
      }
    },
  }, strokeIcon(13, 'currentColor', [
    'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    'M12 16v-4', 'M12 8h.01',
  ]), chipLabel);
  return h('div', { class: 'answer-provenance' }, chip, details);
}

/** Result copy, structured: shape-classified blocks, each through its component. */
function renderAnswerNodes(text) {
  const nodes = [];
  renderBlocks(splitAnswerBlocks(text), nodes, 0);
  return nodes;
}

/** Label line as a bold lead (the heading-demotion idiom); the body re-enters
 *  the same dispatch up to ANSWER_MAX_DEPTH, then renders as plain prose. */
function renderLabelValueBlock(shape, para, nodes, depth) {
  nodes.push(h('p', { class: 'answer' }, h('strong', null, shape.label)));
  if (shape.body && depth < ANSWER_MAX_DEPTH) {
    renderBlocks(splitAnswerBlocks(shape.body), nodes, depth + 1);
  } else if (shape.body) {
    nodes.push(h('p', { class: 'answer' }, ...renderLines(shape.body)));
  }
}

function renderHeadingBlock(shape, para, nodes, depth) {
  nodes.push(h('p', { class: 'answer' }, h('strong', null, shape.text)));
  if (shape.rest && depth < ANSWER_MAX_DEPTH) {
    renderBlocks(splitAnswerBlocks(shape.rest), nodes, depth + 1);
  } else if (shape.rest) {
    nodes.push(h('p', { class: 'answer' }, ...renderLines(shape.rest)));
  }
}

function renderListBlock(shape, para, nodes, depth) {
  if (shape.lead) nodes.push(h('p', { class: 'answer' }, ...renderLines(shape.lead)));
  nodes.push(h(shape.ordered ? 'ol' : 'ul', { class: 'answer-list' },
    shape.items.map((item) => h('li', null, ...renderLines(item)))));
}

/** Cells carry their column header as data-label (the CSS card transform's
 *  "Label: value" source; absent on header-less tables) and run through
 *  renderLines so inline markdown (links, bold, emphasis) works in cells. */
function renderTableBlock(shape, para, nodes, depth) {
  const table = h('table', { class: 'answer-table' });
  if (shape.header) {
    table.append(h('thead', null,
      h('tr', null, shape.header.map((cell) => h('th', null, cell)))));
  }
  table.append(h('tbody', null,
    shape.rows.map((row) => h('tr', null,
      row.map((cell, idx) => h('td',
        { 'data-label': shape.header ? shape.header[idx] : null },
        ...renderLines(cell)))))));
  nodes.push(table);
}

function renderProseBlock(shape, para, nodes, depth) {
  if (looksStructured(para)) noteUnhandledShape(para);
  nodes.push(h('p', { class: 'answer' }, ...renderLines(para)));
}

/** Code is the strongest copy-me shape: a monospace pre plus its own copy
 *  button (same helper and feedback as the answer-level one). */
function renderCodeBlock(block, nodes, depth) {
  nodes.push(h('pre', { class: 'answer-pre' }, document.createTextNode(block.code)));
  nodes.push(copyAnswerButton(block.code, 'Copy this code'));
}

/**
 * The free-form lane (2026-09-14, operator freedom architecture): a
 * :::raw-html block from splitAnswerBlocks renders in a SANDBOXED iframe —
 * allow-scripts WITHOUT allow-same-origin, so the frame is an opaque origin
 * that can never touch this app's origin, storage or ledger. The frame
 * document is served by GET /frames/raw (frame-route.ts): a srcdoc frame
 * inherits this page's CSP (index.html, default-src 'self'), which a frame
 * meta can only tighten, so model inline styles/scripts were inert; the
 * route's own response CSP (inline style/script, zero network) makes the
 * dynamism actually run. The session token rides the query (an iframe
 * navigation cannot set Authorization headers — the SSE precedent; the
 * server's request log strips query values). Over the encoded budget the
 * frame falls back to the inert srcdoc render (structure only) behind a
 * plain-language notice. Fixed generous height, scroll INSIDE the frame —
 * no auto-resize gymnastics in v1. width/height ride HTML presentation
 * attributes, not a style attribute (the app CSP blocks inline style
 * attributes — copy-fallback precedent).
 */
function renderRawHtmlBlock(block, nodes, depth) {
  const src = rawHtmlFrameSrc(block.html);
  if (src) {
    const token = getToken();
    nodes.push(h('iframe', {
      class: 'answer-raw-frame',
      sandbox: 'allow-scripts',
      src: token ? src + '&token=' + encodeURIComponent(token) : src,
      width: '100%',
      height: '260',
      title: 'Custom answer view',
    }));
    return;
  }
  nodes.push(h('p', { class: 'answer' },
    'This custom view is too large for its live frame, so it is shown as a static copy.'));
  nodes.push(h('iframe', {
    class: 'answer-raw-frame',
    sandbox: 'allow-scripts',
    srcdoc: rawHtmlFrameDocument(block.html),
    width: '100%',
    height: '260',
    title: 'Custom answer view',
  }));
}

/**
 * Registration of structured shapes the typed components did not capture
 * (operator ask, vi-35a4487d5c04). Detection is automatic and local-only:
 * localStorage key `vi.answer-shapes`, fingerprint -> { count, lastSeen,
 * example (<=200 chars) }, capped at 50 entries. Promotion into
 * ANSWER_COMPONENTS is a human/agent decision — nothing here rewrites
 * rendering by itself. Counts are render-driven: the conversation
 * render-signature guard keeps a stable answer from re-counting on polls.
 */
const LS_SHAPES = 'vi.answer-shapes';
const SHAPES_CAP = 50;
const SHAPES_EXAMPLE_MAX = 200;
const notedFingerprints = new Set();

function noteUnhandledShape(para) {
  const fp = shapeFingerprint(para);
  if (!fp) return;
  let store = {};
  try { store = JSON.parse(localStorage.getItem(LS_SHAPES) || '{}') || {}; } catch { store = {}; }
  if (typeof store !== 'object' || Array.isArray(store)) store = {};
  const isNew = !Object.prototype.hasOwnProperty.call(store, fp);
  store[fp] = isNew
    ? { count: 1, lastSeen: new Date().toISOString(), example: para.slice(0, SHAPES_EXAMPLE_MAX) }
    : { count: (store[fp].count || 0) + 1, lastSeen: new Date().toISOString(), example: store[fp].example };
  const keys = Object.keys(store);
  if (keys.length > SHAPES_CAP) {
    // Evict the least-recurring fingerprint; ties break to the oldest lastSeen.
    keys.sort((a, b) => (store[a].count - store[b].count) ||
      String(store[a].lastSeen).localeCompare(String(store[b].lastSeen)));
    for (const k of keys.slice(0, keys.length - SHAPES_CAP)) delete store[k];
  }
  try { localStorage.setItem(LS_SHAPES, JSON.stringify(store)); } catch { /* private mode */ }
  if (isNew && !notedFingerprints.has(fp)) {
    notedFingerprints.add(fp);
    console.info('[vi] unhandled answer shape registered: ' + fp);
  }
}

/**
 * Copy `text` to the clipboard. navigator.clipboard.writeText in a secure
 * context; on absence OR rejection the synchronous fallback (offscreen
 * textarea -> select() -> execCommand('copy')). Success swaps the glyph to a
 * check + "Copied" for ~1.6 s (restore() puts the original back); failure
 * shows the notice and restores immediately. Byte parity: callers pass the
 * RAW source string, never DOM-flattened text.
 */
function copyAnswerText(text, button, restore) {
  const succeed = () => {
    button.replaceChildren(checkIcon(16, 'currentColor'));
    button.setAttribute('aria-label', 'Copied');
    button.setAttribute('title', 'Copied');
    if (button._copyTimer) clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(restore, 1600);
  };
  const fail = (err) => {
    showNotice('Could not copy: ' + (err && err.message ? err.message : 'unknown error'));
    restore();
  };
  const legacyCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // CSSOM property API, not a style attribute (default-src 'self' CSP —
    // same precedent as signOutBlock's wrap.style.padding).
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(succeed, () => {
      if (legacyCopy()) succeed(); else fail(new Error('clipboard unavailable'));
    });
  } else {
    if (legacyCopy()) succeed(); else fail(new Error('clipboard unavailable'));
  }
}

/** The copy control shared by the answer turn and each code block. */
function copyAnswerButton(text, label) {
  const copyLabel = label || 'Copy this answer';
  const restore = () => {
    btn.replaceChildren(copyIcon(16, 'currentColor'));
    btn.setAttribute('aria-label', copyLabel);
    btn.setAttribute('title', copyLabel);
  };
  const btn = h('button', {
    class: 'linkish icon-btn copy-answer', type: 'button',
    'aria-label': copyLabel, title: copyLabel,
  }, copyIcon(16, 'currentColor'));
  btn.addEventListener('click', () => copyAnswerText(text, btn, restore));
  return btn;
}

// ---------------------------------------------------------------------------
// Tiered answer card (2026-09-13, vi-ffb0a6d3cb44): answers estimated at
// >15 rendered lines collapse behind an IN SHORT lead + section chips + a
// quiet disclosure. Two versions since 2026-09-13 (vi-6ff65d97f391): the lead
// is the stored task.result_short (worker-written, never capped) when present,
// else answerTier()'s uncapped deterministic fallback lead. The detail holds
// the full renderBlocks output (the complete long answer); the Copy button
// stays OUTSIDE it so it works while collapsed. tier/words come from
// answerTier() in answer-shapes.js (loaded before this file).
// ---------------------------------------------------------------------------

function setAnswerOpen(taskId, toggle, labelText, detail, open) {
  if (open) state.expandedAnswers.add(taskId);
  else state.expandedAnswers.delete(taskId);
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  detail.hidden = !open;
  labelText.data = open ? 'Hide full answer' : 'Show full answer';
}

/**
 * The tiered card's section chips: at most four, at least two (fewer than two
 * returns null — a one-chip row is noise). An anchor is either
 * `{ shape, startIndex }` (markdown: the classified block at that index of the
 * detail nodes) or `{ text, node }` (structured: the item card itself), so both
 * detail sources share one chip implementation, one scroll, one flash.
 */
function chipRow(anchors, detailNodes, taskId, toggle, labelText, detail) {
  const chips = [];
  for (const a of anchors) {
    if (chips.length >= 4) break;
    // An anchor carries its own label (structured data: the item name) or a
    // classified shape (markdown: the block the chip jumps to). The count
    // suffix is applied AFTER truncation, exactly as before.
    let text = null;
    let count = '';
    if (a.text) text = a.text;
    else if (a.shape && a.shape.kind === 'heading') text = a.shape.text;
    else if (a.shape && a.shape.kind === 'label-value') text = a.shape.label.replace(/:\s*$/, '');
    else if (a.shape && a.shape.kind === 'list' && a.shape.lead) {
      text = a.shape.lead.replace(/:\s*$/, '');
      count = ' (' + a.shape.items.length + ')';
    } else continue;
    text = stripInlineMarkers(text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > 24) text = text.slice(0, 24).replace(/\s+\S*$/, '') + '…';
    chips.push({ text: text + count, startIndex: a.startIndex, node: a.node });
  }
  if (chips.length < 2) return null;
  return h('div', { class: 'chip-row' }, chips.map((c) => h('button', {
    class: 'chip', type: 'button',
    onclick: () => {
      if (detail.hidden) setAnswerOpen(taskId, toggle, labelText, detail, true);
      // Structured anchors point at the element itself (a card inside the
      // swipe row); markdown anchors point at an index into detailNodes.
      const target = c.node || detailNodes[c.startIndex];
      if (!target) return;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      target.style.transition = 'background-color 0.8s';
      target.classList.add('chip-flash');
      if (target._chipTimer) clearTimeout(target._chipTimer);
      target._chipTimer = setTimeout(() => { target.classList.remove('chip-flash'); }, 1100);
    },
  }, c.text)));
}

/**
 * The tiered card's DOM, shared by both detail sources (markdown blocks and
 * structured data): the IN SHORT card, its section chips, the disclosure toggle
 * and the disclosure itself. Extracted from tieredAnswerNodes in P2 — a second
 * copy of this DOM is how the two paths would drift (aria wiring, open/closed
 * state, chip behaviour).
 */
function tieredCardNodes(task, tier, detailNodes, anchors, lead) {
  // Open/closed comes from state first: the poll re-renders the conversation
  // on signature change, and a hardcoded collapsed state would silently
  // fold an answer the operator already opened (same idiom as workBlock).
  const open = state.expandedAnswers.has(task.task_id);
  const labelText = document.createTextNode(open ? 'Hide full answer' : 'Show full answer');
  const detail = h('div', {
    class: 'answer-detail', id: 'answer-detail-' + task.task_id, hidden: !open,
  }, h('div', { class: 'answer-detail-inner' }, ...detailNodes));
  const toggle = h('button', {
    class: 'linkish answer-toggle', type: 'button',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': 'answer-detail-' + task.task_id,
    onclick: () => setAnswerOpen(task.task_id, toggle, labelText, detail, !state.expandedAnswers.has(task.task_id)),
  },
    chevron(12, 'currentColor', 'M9 6l6 6-6 6', 'answer-chevron'),
    h('span', null, labelText),
    h('span', { class: 'meta' }, ' · ' + tier.words + ' words'));
  const card = h('div', { class: 'tldr' },
    h('p', { class: 'tldr-lead' }, h('span', { class: 'tldr-tag' }, 'IN SHORT'), lead));
  const chips = chipRow(anchors, detailNodes, task.task_id, toggle, labelText, detail);
  if (chips) card.append(chips);
  return [card, toggle, detail];
}

function tieredAnswerNodes(task, tier) {
  const detailNodes = [];
  const anchors = [];
  renderBlocks(splitAnswerBlocks(task.result_summary), detailNodes, 0, (shape) => {
    anchors.push({ shape, startIndex: detailNodes.length });
  });
  // Stored short version first (schema v8): a worker-written standalone
  // summary, never capped. Rows completed before --short existed have no
  // stored value and fall back to the uncapped deterministic lead.
  const lead = task.result_short && task.result_short.trim()
    ? stripAnswerMarkers(task.result_short) : tier.lead;
  return tieredCardNodes(task, tier, detailNodes, anchors, lead);
}

/**
 * P2: the tiered card over a STRUCTURED answer (SPEC §2.5) — the same DOM as
 * tieredAnswerNodes, built by the same tieredCardNodes, with the structured view
 * behind the disclosure instead of the markdown blocks. Returns null when there
 * is nothing to disclose (an empty detail would open onto a blank panel); the
 * caller then renders the answer flat. The lead is the worker's stored short
 * version, else the structured recommendation, else the deterministic lead from
 * the summary — never the recommendation twice.
 */
function tieredStructuredNodes(task, data, tier) {
  const detail = structuredDetail(data, task);
  if (!detail.nodes.length) return null;
  const lead = task.result_short && task.result_short.trim()
    ? stripAnswerMarkers(task.result_short)
    : (structuredLeadText(data) || tier.lead);
  return tieredCardNodes(task, tier, detail.nodes, detail.anchors, lead);
}

/**
 * Playback engines for voice-turn recordings, keyed by task_id and kept
 * outside the DOM entirely. renderConversationBody does a full
 * teardown/rebuild of the turn log (body.replaceChildren) the moment the
 * task's conversationSignature changes — state/updated_at flip the instant
 * transcription finishes, which can land mid-playback. Without this map, that
 * rebuild calls a fresh audioPlayer() that has no idea a recording is already
 * playing, orphaning the old <audio> and the button the user just tapped
 * (the "button disappears mid-playback" bug). Keeping {audio, objectUrl}
 * here means a rebuilt button finds the same live Audio instance and just
 * re-renders its current state instead of restarting or losing it.
 */
const audioPlayerState = new Map(); // taskId -> { audio: HTMLAudioElement, objectUrl: string }

/**
 * "Play recording" for a voice-sourced turn — available the moment the
 * upload lands (state transcribing) and unchanged once transcription
 * finishes, since GET /tasks/:id/audio serves the same file either way.
 * Lazy: the audio is fetched only on tap, not for every voice turn a
 * conversation renders. Renders one compact toggle button (play <-> stop),
 * matching the other .act-row icon buttons — the <audio> element is a
 * playback engine only and is never attached to the visible DOM.
 */
function audioPlayer(taskId) {
  const btn = h('button', {
    class: 'act act-quiet with-icon audio-play-btn', type: 'button',
  }, playIcon(16, 'currentColor'), 'Play recording');

  const setIdleUi = () => { btn.replaceChildren(playIcon(16, 'currentColor'), 'Play recording'); btn.disabled = false; };
  const setPlayingUi = () => { btn.replaceChildren(stopIcon(16, 'currentColor'), 'Stop'); btn.disabled = false; };
  const setLoadingUi = () => { btn.replaceChildren(playIcon(16, 'currentColor'), 'Play recording'); btn.disabled = true; };

  const existing = audioPlayerState.get(taskId);
  if (existing && existing.audio) {
    // A re-render just rebuilt this button while the recording is still
    // loaded (possibly still playing) — reattach to the same Audio instead
    // of fetching again, and rebind the listeners to THIS button since the
    // old button's DOM node is gone.
    const audio = existing.audio;
    audio.onplay = setPlayingUi;
    audio.onpause = setIdleUi;
    audio.onended = setIdleUi;
    (audio.paused ? setIdleUi : setPlayingUi)();
    btn.addEventListener('click', () => {
      if (audio.paused) {
        audio.play().catch(() => showNotice('Could not play the recording — try again.'));
      } else {
        audio.pause();
      }
    });
    return btn;
  }

  btn.addEventListener('click', async () => {
    setLoadingUi();
    try {
      const url = await fetchAudioUrl(taskId);
      const stale = audioPlayerState.get(taskId);
      if (stale && stale.objectUrl) URL.revokeObjectURL(stale.objectUrl);
      const audio = new Audio(url);
      audioPlayerState.set(taskId, { audio, objectUrl: url });
      audio.onplay = setPlayingUi;
      audio.onpause = setIdleUi;
      audio.onended = setIdleUi;
      audio.addEventListener('error', () => {
        audioPlayerState.delete(taskId);
        setIdleUi();
        showNotice('Could not play the recording — try again.');
      });
      await audio.play();
    } catch (e) {
      audioPlayerState.delete(taskId);
      setIdleUi();
      showNotice(e instanceof ApiError && e.status === 404
        ? 'Recording not available.'
        : 'Could not load the recording — try again.');
    }
  });
  return btn;
}

/**
 * Markdown markers stripped to plain text, for spots that cannot hold DOM
 * structure: the list row's clamped snippet and the conversation title's
 * first sentence.
 */
function stripInlineMarkers(text) {
  let s = String(text || '');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '$1').split('**').join('');
  s = s.replace(/(^|[\s(])([*_])(?!\2)(\S(?:.*?\S)?)\2(?=[\s).,;:!?]|$)/g, '$1$3');
  s = s.replace(/^#{1,6}\s+/, '');
  return s;
}

/**
 * The list row's clamped 3-line snippet: same structural read as
 * renderAnswerNodes, flattened to plain text. A detected list becomes its
 * items "; "-joined into one readable run instead of raw numbered markers.
 */
function plainAnswerSnippet(text) {
  return paragraphs(text).map(plainParagraphText).join(' ').replace(/\s+/g, ' ').trim();
}

function plainParagraphText(para) {
  const lines = para.split('\n');
  const heading = /^#{1,6}\s+(.+)$/.exec(lines[0].trim());
  if (heading) {
    const rest = lines.slice(1).join(' ').trim();
    return stripInlineMarkers(heading[1]) + (rest ? ': ' + plainParagraphText(rest) : '');
  }
  const list = lineDashSplit(para) || splitList(para);
  if (list) {
    const lead = list.lead ? stripInlineMarkers(list.lead) + ' ' : '';
    return lead + list.items.map((it) => stripInlineMarkers(it.replace(/\n/g, ' '))).join('; ');
  }
  return stripInlineMarkers(para.replace(/\n/g, ' '));
}

/**
 * The conversation's three summary lines (AI-222). The SERVER never derives:
 * it returns the worker-set values or null, and this is the whole fallback.
 * One helper, two callers (conversationRow, renderConversationBody) — a second
 * derivation is how the row and the header drift apart.
 */
function conversationLines(conv) {
  const setTitle = String(conv.title || '').trim();
  const setRecap = String(conv.recap || '').trim();
  const setNext = String(conv.next_action || '').trim();
  const answer = conv.result_summary && String(conv.result_summary).trim()
    ? plainAnswerSnippet(conv.result_summary) : '';
  const lead = answer ? firstSentence(conv.result_summary) : '';
  const title = setTitle || lead || String(conv.request_text || '').trim();
  const recap = setRecap || (setTitle ? answer : stripLead(answer, lead));
  const nextAction = setNext || (conv.pending_input_count > 0 ? 'Needs your answer' : '');
  return { title: title, recap: recap, nextAction: nextAction, needsYou: conversationNeedsYou(conv) };
}

/** Drop `lead` from the front of `full` so a derived title is not repeated as
 *  the first words of the derived recap. Leaves `full` alone when it does not
 *  start with the lead (a truncated or colon-trimmed first sentence). */
function stripLead(full, lead) {
  const f = String(full || '').trim();
  const l = String(lead || '').trim();
  if (!l) return f;
  for (const candidate of [l, l + ':']) {
    if (f.startsWith(candidate)) {
      return f.slice(candidate.length).replace(/^[\s.:;,\u2013\u2014-]+/, '').trim();
    }
  }
  return f;
}

/** What the operator asked in this turn: the (possibly cleaned) request text,
 *  else the raw transcript, never the plumbing placeholder. A voice turn's raw
 *  words stay one tap away through originalWordsNodes. */
function turnText(task) {
  const request = String(task.request_text || '').trim();
  if (request && request !== '(voice recording)') return request;
  const transcript = typeof task.transcript === 'string' ? task.transcript.trim() : '';
  if (transcript) return transcript;
  return 'Transcribing your recording…';
}

/** True when a voice turn's displayed request differs from what was said —
 *  the routing worker tidied it (task_request.py clean). The transcript is
 *  immutable; the operator keeps it one tap away. */
function hasDistinctOriginal(task) {
  if (!task || task.source !== 'voice') return false;
  const transcript = typeof task.transcript === 'string' ? task.transcript.trim() : '';
  const request = String(task.request_text || '').trim();
  if (!transcript || !request || request === '(voice recording)') return false;
  return transcript !== request;
}

/** "Your exact words" disclosure under a tidied voice turn; [] otherwise.
 *  Open/closed rides state.expandedOriginals so a re-render never folds it. */
function originalWordsNodes(task) {
  if (!hasDistinctOriginal(task)) return [];
  const id = 'said-original-' + task.task_id;
  const open = state.expandedOriginals.has(task.task_id);
  const label = document.createTextNode(open ? 'Hide your exact words' : 'Your exact words');
  const detail = h('p', { class: 'meta said-original', id, hidden: !open }, task.transcript.trim());
  const toggle = h('button', {
    class: 'linkish said-original-toggle', type: 'button',
    'aria-expanded': open ? 'true' : 'false',
    'aria-controls': id,
    onclick: () => {
      const nowOpen = !state.expandedOriginals.has(task.task_id);
      if (nowOpen) state.expandedOriginals.add(task.task_id);
      else state.expandedOriginals.delete(task.task_id);
      toggle.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      detail.hidden = !nowOpen;
      label.data = nowOpen ? 'Hide your exact words' : 'Your exact words';
    },
  }, label);
  return [toggle, detail];
}

function clockTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return String(iso ?? '');
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Reason for a task's failure sentence: the newest `task.failed` event's
 * payload.reason, else that kind's fixed fallback string. Renders from the
 * task row + event payload, never from model-phrased text.
 */
function newestFailureReason(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev || ev.kind !== 'task.failed') continue;
    const p = ev.payload;
    const reason = p && typeof p === 'object' ? p.reason : undefined;
    return typeof reason === 'string' && reason ? reason : EVENT_FALLBACK['task.failed'];
  }
  return EVENT_FALLBACK['task.failed'];
}

// ---------------------------------------------------------------------------
// Chrome builders (E10)
// ---------------------------------------------------------------------------

function doSignOut() {
  clearSession();
  showLogin('Signed out.');
}

function confirmSignOut() {
  if (window.confirm('Sign out?')) doSignOut();
}

function topNavActions(needsYouCount = 0, extraNodes = []) {
  const actions = [];
  if (extraNodes && extraNodes.length) {
    actions.push(...extraNodes);
  }
  if (needsYouCount > 0) {
    actions.push(h('span', { class: 'state state-you' }, needsYouCount === 1 ? '1 needs you' : needsYouCount + ' need you'));
  }
  const isSystem = state.view === 'system';
  const isKb = state.view === 'kb';
  actions.push(
    h('button', {
      class: 'topbar-btn' + (isKb ? ' active' : ''),
      type: 'button',
      'aria-label': 'Knowledge base',
      title: isKb ? 'Refresh knowledge base' : 'Knowledge base',
      onclick: () => {
        // Same idiom as the dashboard button: on the view it refreshes,
        // elsewhere it opens (vi-19787afc4b2e).
        if (state.view === 'kb') loadKb(true);
        else navigate('kb');
      },
    }, bookIcon(16, 'currentColor')),
    h('button', {
      class: 'topbar-btn' + (isSystem ? ' active' : ''),
      type: 'button',
      'aria-label': 'Dashboard',
      title: isSystem ? 'Refresh dashboard' : 'System dashboard',
      onclick: () => {
        if (state.view === 'system') refreshSystemStatus();
        else navigate('system');
      },
    }, gaugeIcon(16, 'currentColor')),
    h('button', {
      class: 'topbar-btn',
      type: 'button',
      'aria-label': 'Sign out',
      title: 'Sign out',
      onclick: confirmSignOut,
    }, exitIcon(16, 'currentColor'))
  );
  return h('div', { class: 'topbar-actions' }, ...actions);
}

/**
 * The brand lockup (mic-glyph task, 2026-09-13): the app's mic mark in the
 * voice colour beside the name, so the logo alone says what the app does —
 * the caption that used to spell this out is gone. One glyph system: this is
 * the same micMark that prefixes every spoken turn, not a second design.
 */
function topBar(titleText, needsYouCount) {
  const searchBtn = h('button', {
    class: 'topbar-btn', type: 'button',
    'aria-label': 'Search conversations', title: 'Search conversations',
    onclick: () => {
      navigate('archive');
      // Focus the search input after the archive view renders.
      requestAnimationFrame(() => {
        document.getElementById('archive-search-input')?.focus();
      });
    },
  }, searchIcon(16, 'currentColor'));
  return h('div', { class: 'topbar' },
    h('div', { class: 'brand' },
      micMark(16, 'currentColor', 0, 'tone-accent'),
      h('span', { class: 'topbar-title' }, titleText)),
    topNavActions(needsYouCount, [searchBtn]));
}

function backBar(pageTitle, backLabel, onBack, rightSlot) {
  return h('div', { class: 'topbar' },
    h('div', { class: 'topbar-left' },
      h('button', {
        class: 'back icon-btn', type: 'button',
        'aria-label': backLabel ? 'Back to ' + backLabel : 'Back',
        title: backLabel ? 'Back to ' + backLabel : 'Back',
        onclick: onBack,
      }, chevron(20, 'currentColor', 'M15 18l-6-6 6-6', 'tone-dim')),
      pageTitle ? h('span', { class: 'topbar-title' }, pageTitle) : null,
    ),
    rightSlot || topNavActions(0));
}

/** Replaces the old `banner`: one .notice element, no error variant, no colour. */
function notice(text) {
  return h('div', { class: 'notice' }, text);
}

function showNotice(text) {
  const id = state.view === 'conversation' ? 'conv-notice-slot'
    : state.view === 'triage' ? 'triage-notice-slot'
      : state.view === 'archive' ? 'archive-notice-slot'
        : state.view === 'kb' ? 'kb-notice-slot'
          : 'list-notice-slot';
  const slot = document.getElementById(id);
  if (slot) slot.replaceChildren(notice(text));
}

function clearNotice() {
  const id = state.view === 'conversation' ? 'conv-notice-slot'
    : state.view === 'triage' ? 'triage-notice-slot'
      : state.view === 'archive' ? 'archive-notice-slot'
        : state.view === 'kb' ? 'kb-notice-slot'
          : 'list-notice-slot';
  const slot = document.getElementById(id);
  if (slot) slot.replaceChildren();
}

function emptyBlock(title, hint) {
  return h('div', { class: 'empty' },
    h('p', { class: 'title' }, title),
    h('p', { class: 'empty-hint' }, hint));
}

// ---------------------------------------------------------------------------
// List view (E11)
// ---------------------------------------------------------------------------

/**
 * "Not placed yet": a single-message conversation that has not been routed. A
 * routing decision may still MOVE it into an existing conversation, so it is
 * not an answer and does not belong on the answer sheet. transcribe_failed
 * joins them because it is the same shape of unfinished business and carries
 * the retype affordance.
 */
function isUnplaced(conv) {
  return conv.task_count === 1 &&
    (conv.state === 'received' || conv.state === 'transcribing' || conv.state === 'transcribe_failed');
}

function conversationRow(conv) {
  const tone = statusToneClass(conv.status);
  const muted = tone === 'status-muted';
  const toneClass = muted ? 'tone-faint' : 'tone-dim';
  const messagesBit = conv.task_count > 1 ? h('span', {}, conv.task_count + ' messages') : null;
  const phase = conv.status === 'running' ? phaseFromStep(conv.latest_step) : null;

  const head = h('div', { class: 'row-head' },
    h('span', { class: 'meta row-time-chips' },
      h('span', { class: 'time-chip', title: 'Created ' + relativeTime(conv.created_at) },
        createdIcon(11, 'currentColor'), compactAge(conv.created_at)),
      h('span', { class: 'time-chip', title: 'Last updated ' + relativeTime(conv.updated_at) },
        updatedIcon(11, 'currentColor'), compactAge(conv.updated_at)),
      messagesBit),
    h('span', { class: 'state ' + tone }, threadStatusWord(conv),
      phase ? h('span', { class: 'state-phase' }, phase) : null));

  const lines = conversationLines(conv);
  const body = [h('div', { class: 'row-said' }, micMark(14, 'currentColor', 3, toneClass),
                  h('div', { class: 'row-title clamp2' }, lines.title))];
  if (lines.recap) body.push(h('p', { class: 'answer clamp3 row-answer' + (muted ? ' quiet' : '') }, lines.recap));
  if (lines.nextAction) body.push(h('p', { class: 'row-next' + (lines.needsYou ? ' row-next-you' : '') }, lines.nextAction));

  // The ellipsis is a SIBLING of the row button inside a .row-wrap div —
  // a <button> inside a <button> is invalid HTML and the parser breaks it out.
  // In multi-select mode (2026-09-18) the WHOLE row toggles selection on
  // tap — the checkbox is gone, the row button carries aria-pressed instead.
  const selecting = state.failedSelect !== null;
  const rowButton = h('button', {
    class: 'row', type: 'button',
    'aria-pressed': selecting ? String(state.failedSelect.has(conv.conversation_id)) : null,
    onclick: () => {
      if (suppressClickOnce) { suppressClickOnce = false; return; }
      if (state.failedSelect !== null) {
        if (state.failedSelect.has(conv.conversation_id)) state.failedSelect.delete(conv.conversation_id);
        else state.failedSelect.add(conv.conversation_id);
        renderListBody();
        return;
      }
      navigate('conversation', conv.conversation_id);
    },
  }, head, ...body);
  wireFeedbackGestures(rowButton, () => {
    if (state.failedSelect !== null) return;
    openRowActionsSheet(conv);
  });
  const ellipsis = h('button', {
    class: 'row-feedback-btn', type: 'button',
    'aria-label': 'Give feedback on this', title: 'Give feedback on this',
    onclick: () => openRowActionsSheet(conv),
  }, flagIcon(18, 'currentColor'));
  const failedHere = conv.status === 'failed' && state.view === 'list';
  const wrapClass = 'row-wrap' + (conv.status === 'ready' ? ' row-ready' : '') + (failedHere ? ' row-failed' : '') +
    (selecting && state.failedSelect.has(conv.conversation_id) ? ' row-selected' : '');
  return h('div', { class: wrapClass }, rowButton, ellipsis,
    failedHere && !selecting ? failedRowActions(conv) : null);
}

/**
 * A quiet disclosure row on the archive surface: the archive's Load-more.
 * Same quiet vocabulary as the tiered answer's "Show full
 * answer" toggle — a pill on the raised surface, never a full
 * conversation row.
 */
function listDisclosureRow(text, ariaLabel, onclick) {
  return h('button', {
    class: 'act act-quiet list-disclosure', type: 'button',
    'aria-label': ariaLabel, title: ariaLabel,
    onclick,
  }, text);
}

function maybeRenderNotifBanner() {
  const slot = document.getElementById('list-notif-slot');
  if (!slot) return;
  if (notifSupported && Notification.permission === 'default') {
    if (document.getElementById('notif-enable')) return;
    const btn = h('button', {
      id: 'notif-enable',
      class: 'notice linkish',
      type: 'button',
      'aria-label': 'Enable notifications',
      title: 'Enable notifications',
      onclick: () => {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') subscribeWebPush();
        }).finally(() => {
          document.getElementById('notif-enable')?.remove();
        });
      },
    }, 'Enable browser notifications for answer alerts');
    btn.classList.add('notif-banner-btn');
    slot.replaceChildren(btn);
  }
}

function showList() {
  state.view = 'list';
  state.conversationId = null;
  state.conversation = null;
  state.signature = '';
  const rows = h('div', { class: 'rows', id: 'list-rows', 'aria-live': 'polite' }, notice('Loading…'));
  viewRoot().replaceChildren(
    h('div', null,
      h('div', { id: 'list-topbar-slot' }, topBar('Voice Inbox', 0)),
      h('div', { id: 'list-notif-slot' }),
      h('div', { id: 'list-notice-slot', 'aria-live': 'polite' }),
      rows,
      recordFooter(null),
    ));
  maybeRenderNotifBanner();
  refreshConversations();
  startPolling();
  if (state.offline) showNotice('You appear to be offline — showing the last known state.');
  focusViewHeading();
}

function renderListBody() {
  const topbarSlot = document.getElementById('list-topbar-slot');
  const rows = document.getElementById('list-rows');
  if (!rows) return;

  const needsYouCount = state.conversations.filter((c) => c.status === 'needs_you').length;
  if (topbarSlot) topbarSlot.replaceChildren(topBar('Voice Inbox', needsYouCount));

  const blocks = [viewSwitch('recent')];
  if (state.conversations.length === 0) {
    blocks.push(state.total > 0
      ? emptyBlock('Nothing recent.', 'Older conversations are one tap away.')
      : emptyBlock(
        'Nothing yet.',
        'Tap the circle below and speak, or tap the keyboard icon to type. Your assistant works on it and sends the answer back here.'));
    rows.replaceChildren(...blocks);
    return;
  }

  // Two header-free bands split by a gap (thread lifecycle, 2026-09-17): live
  // (Recorded/Transcribing/Routed, Needs You, Ready, Failed, Running), then
  // history (Viewed, Concluded, Cancelled). The server already sorted by
  // status rank, then newest update.
  const live = state.conversations.filter((c) => c.band === 'live');
  const history = state.conversations.filter((c) => c.band === 'history');
  const failedIds = live.filter((c) => c.status === 'failed').map((c) => c.conversation_id);
  const visibleIds = state.conversations.map((c) => c.conversation_id);
  const selecting = state.failedSelect !== null;
  if (selecting) {
    for (const id of [...state.failedSelect]) if (!visibleIds.includes(id)) state.failedSelect.delete(id);
  }
  if (live.length) {
    const liveRows = [];
    let barPlaced = false;
    for (const c of live) {
      if (selecting) {
        if (!barPlaced) {
          liveRows.push(failedBulkBar(state.conversations));
          barPlaced = true;
        }
      } else if (c.status === 'failed' && !barPlaced && failedIds.length >= 2) {
        liveRows.push(failedBulkBar(failedIds));
        barPlaced = true;
      }
      liveRows.push(conversationRow(c));
    }
    blocks.push(h('div', { class: 'rows-group list-band', role: 'group', 'aria-label': 'Needs attention or in progress' }, ...liveRows));
  }
  if (history.length) {
    blocks.push(h('div', { class: 'rows-group list-band list-band-history', role: 'group', 'aria-label': 'Recently finished' },
      ...history.map(conversationRow)));
  }
  rows.replaceChildren(...blocks);
}

/** The list's one segmented control (thread lifecycle, 2026-09-17): Recent
 *  (the live and history bands) | Older conversations (the whole-tenant
 *  archive with search). */
function viewSwitch(active) {
  const button = (key, label, onclick) => h('button', {
    class: 'view-switch-btn', type: 'button',
    'aria-pressed': active === key ? 'true' : 'false',
    onclick: active === key ? null : onclick,
  }, label);
  return h('div', { class: 'view-switch', role: 'group', 'aria-label': 'Which conversations' },
    button('recent', 'Recent', () => history.back()),
    button('older', 'Older conversations', () => navigate('archive')));
}

/** The bulk bar over the live band. Not selecting: the slim bar above the
 *  Failed rows (two or more) — Retry all, Cancel all and Select. Selecting
 *  (`state.failedSelect` on — entered from a row's long-press "Select" or the
 *  bar's own Select): any-row multi-select, and the intersection of what the
 *  selection supports — Retry only when EVERY chosen row is failed, Cancel
 *  when any chosen row can still be cancelled — plus Done. Rows may be passed
 *  as conversation ids (strings) or row objects. */
function failedBulkBar(rows) {
  const selecting = state.failedSelect !== null;
  const key = (r) => (typeof r === 'string' ? r : r.conversation_id);
  const chosen = selecting ? [...state.failedSelect] : rows.map(key);
  const chosenRows = selecting ? rows.filter((r) => chosen.includes(key(r))) : rows;
  const allFailed = chosenRows.length > 0 && chosenRows.every((r) => key(r) !== null && r.status === 'failed');
  const anyCancellable = chosenRows.some((r) => !TERMINAL_STATUSES.includes(r.status));
  const act = (label, onclick, disabled) => h('button', {
    class: 'act act-quiet', type: 'button', disabled: disabled ? true : null, onclick,
  }, label);
  const children = [h('span', { class: 'failed-bar-count' },
    selecting ? chosen.length + ' selected' : chosen.length + ' failed')];
  if (selecting) {
    children.push(
      act('Retry selected', () => retryConversations(chosen), !allFailed),
      act('Cancel selected', () => openCancelThreadsSheet(chosen), !anyCancellable),
      act('Done', () => { state.failedSelect = null; renderListBody(); }));
  } else {
    children.push(
      act('Retry all', () => retryConversations(chosen)),
      act('Cancel all', () => openCancelThreadsSheet(chosen)),
      act('Select', () => { state.failedSelect = new Set(); renderListBody(); }));
  }
  return h('div', { class: 'failed-bar', role: 'group', 'aria-label': 'Failed conversations' }, ...children);
}

function failedRowActions(conv) {
  return h('div', { class: 'act-row row-actions' },
    h('button', { class: 'act act-quiet', type: 'button', onclick: () => retryConversations([conv.conversation_id]) }, 'Retry'),
    h('button', { class: 'act act-quiet', type: 'button', onclick: () => openCancelThreadsSheet([conv.conversation_id]) }, 'Cancel'));
}

/** A row's contextual bottom sheet (2026-09-18): feed
 *  `openConversationActionsSheet`'s menu idiom, opened from a row's long-press
 *  or ellipsis. Feedback is always offered; Stop for an in-flight row; Retry
 *  and Cancel for a failed row; and for ANY row, Select — entry into
 *  multi-select, with the row already chosen. The sheet closes itself before
 *  the action runs; the cancel sheet re-presents its own confirm. */
function openRowActionsSheet(conv) {
  if (sheetEl) closeSheet();
  sheetTrigger = document.activeElement;
  const closeThen = (fn) => () => { closeSheet(); fn(); };
  const rows = [
    h('button', {
      class: 'menu-row', type: 'button',
      onclick: closeThen(() => openFeedbackSheet({ about: conv.conversation_id, title: conversationLines(conv).title })),
    }, flagIcon(18, 'currentColor'), h('span', {}, 'Give feedback')),
  ];
  if (ACTIVE_STATUSES.includes(conv.status)) {
    rows.push(h('button', {
      class: 'menu-row', type: 'button',
      onclick: closeThen(() => openStopConfirmSheet(conv)),
    }, stopIcon(18, 'currentColor'), h('span', {}, 'Stop')));
  }
  if (conv.status === 'failed') {
    rows.push(h('button', {
      class: 'menu-row', type: 'button',
      onclick: closeThen(() => retryConversations([conv.conversation_id])),
    }, playIcon(18, 'currentColor'), h('span', {}, 'Retry')));
    rows.push(h('button', {
      class: 'menu-row', type: 'button',
      onclick: closeThen(() => openCancelThreadsSheet([conv.conversation_id])),
    }, trashIcon(18, 'currentColor'), h('span', {}, 'Cancel')));
  }
  rows.push(h('button', {
    class: 'menu-row', type: 'button',
    onclick: closeThen(() => {
      state.failedSelect = new Set([conv.conversation_id]);
      renderListBody();
    }),
  }, checkIcon(18, 'currentColor'), h('span', {}, selectingLabel(conv))));
  scrimEl = h('div', { class: 'scrim' });
  scrimEl.addEventListener('click', closeSheet);
  sheetEl = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Conversation actions', tabindex: '-1',
  },
    h('div', { class: 'pill-row' },
      h('span', { class: 'pill' }, 'Conversation'),
      h('span', { class: 'sheet-secondary' }, 'about ' + sheetTargetQuote(conv))),
    h('div', { class: 'menu-rows' }, ...rows));
  document.body.append(scrimEl, sheetEl);
  armSheetKeyboard();
  sheetEl.focus();
}

/** The row menu's Select entry labels itself once the user is already in
 *  multi-select (the row is picked: "Selected" reads back the state). */
function selectingLabel(conv) {
  if (state.failedSelect !== null && state.failedSelect.has(conv.conversation_id)) return 'Selected';
  return 'Select';
}

/** Retry each thread through POST /conversations/:id/retry, one by one, and
 *  say plainly when some could not be retried. A thread counts as retried
 *  when at least one of its failures was (a 200 can carry only skipped or
 *  refused outcomes, e.g. a lost recording). */
async function retryConversations(ids) {
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const body = await api('/conversations/' + encodeURIComponent(id) + '/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const outcomes = body && Array.isArray(body.retried) ? body.retried : [];
      if (outcomes.some((o) => o && o.outcome === 'retried')) done += 1;
      else failed += 1;
    } catch (e) {
      if (e && e.status === 401) return;
      failed += 1;
    }
  }
  state.failedSelect = null;
  if (failed > 0) {
    showNotice(done === 0 ? 'Could not retry that.' : 'Retried ' + done + ' of ' + ids.length + '. The rest could not be retried.');
  }
  await refreshConversations(true);
}

/** Cancel always confirms: a Failed thread can also hold running work. */
function openCancelThreadsSheet(ids) {
  if (sheetEl) closeSheet();
  sheetTrigger = document.activeElement;
  scrimEl = h('div', { class: 'scrim' });
  scrimEl.addEventListener('click', closeSheet);
  const question = ids.length === 1 ? 'Cancel this conversation?' : 'Cancel ' + ids.length + ' conversations?';
  sheetEl = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-label': question, tabindex: '-1',
  },
    h('div', { class: 'pill-row' }, h('span', { class: 'pill' }, question)),
    h('div', { class: 'act-row' },
      h('button', {
        class: 'act act-quiet', type: 'button',
        onclick: () => { closeSheet(); cancelConversations(ids); },
      }, 'Yes, cancel'),
      h('button', {
        class: 'act act-quiet', type: 'button',
        onclick: closeSheet,
      }, ids.length === 1 ? 'Keep it' : 'Keep them')));
  document.body.append(scrimEl, sheetEl);
  armSheetKeyboard();
  sheetEl.focus();
}

/** Cancel each thread through POST /conversations/:id/cancel. A thread with
 *  any refused task counts as not cancelled; an empty `tasks` list means
 *  nothing was left to cancel, which is success. */
async function cancelConversations(ids) {
  let done = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const body = await api('/conversations/' + encodeURIComponent(id) + '/cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const outcomes = body && Array.isArray(body.tasks) ? body.tasks : [];
      if (outcomes.some((o) => o && o.outcome === 'refused')) failed += 1;
      else done += 1;
    } catch (e) {
      if (e && e.status === 401) return;
      failed += 1;
    }
  }
  state.failedSelect = null;
  if (failed > 0) {
    showNotice(done === 0 ? 'Could not cancel that.' : 'Cancelled ' + done + ' of ' + ids.length + '. The rest could not be cancelled.');
  }
  await refreshConversations(true);
}

async function refreshConversations(force) {
  let conversations;
  let total = 0;
  try {
    const body = await api('/conversations?view=recent');
    // The server hides a thread with no status (a rejected mis-tap recording,
    // or failures already retried) and sorts by status rank, then newest
    // update; `total` stays the whole tenant's count.
    conversations = Array.isArray(body.conversations) ? body.conversations : [];
    if (Number.isInteger(body.total)) total = body.total;
  } catch (e) {
    if (e.status === 401 || e.status === 0) return;
    const slot = document.getElementById('list-notice-slot');
    if (slot) slot.replaceChildren(
      notice('Could not load: ' + e.message),
      h('button', {
        class: 'act act-quiet', type: 'button',
        onclick: () => refreshConversations(),
      }, 'Try again'));
    else showNotice('Could not load: ' + e.message);
    return;
  }
  clearNotice();
  state.conversations = conversations;
  state.total = total || conversations.length;
  maybeNotify(conversations);
  uploadLegacyReadMarks(conversations).catch(() => {});
  const sig = listSignature(conversations);
  if (!force && sig === state.signature) return;
  state.signature = sig;
  if (state.view === 'triage') renderTriageBody();
  else if (state.view === 'list') {
    if (!force && listRenderHeld()) {
      listHold.pending = true;
      flushHeldListRender();
    } else {
      listHold.pending = false;
      renderListBody();
    }
  }
}

// ---------------------------------------------------------------------------
// System status view (operator-only live PA usage dashboard)
// ---------------------------------------------------------------------------

let systemPollTimer = null;

function stopSystemPolling() {
  if (systemPollTimer) clearInterval(systemPollTimer);
  systemPollTimer = null;
}

function showSystem() {
  state.view = 'system';
  state.conversationId = null;
  state.conversation = null;
  stopPolling(); // this view has its own poll loop; the conversations poll is idle here
  disconnectStream();
  const body = h('div', { class: 'rows', id: 'system-body', 'aria-live': 'polite' }, notice('Loading…'));
  viewRoot().replaceChildren(
    h('div', null,
      backBar('System status', 'All answers', () => history.back()),
      body));
  refreshSystemStatus();
  systemPollTimer = setInterval(refreshSystemStatus, 3000);
  if (state.offline) showNotice('You appear to be offline — showing the last known state.');
  focusViewHeading();
}

function statRow(label, value) {
  return h('div', { class: 'row-head' }, h('span', { class: 'meta' }, label), h('span', { class: 'state' }, value));
}

function fmtBytes(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtUptime(secs) {
  if (typeof secs !== 'number' || !isFinite(secs)) return '—';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return (days > 0 ? days + 'd ' : '') + hours + 'h ' + mins + 'm';
}

function renderSystemBody(status) {
  const body = document.getElementById('system-body');
  if (!body) return;
  const disks = Object.entries(status.system.disks || {}).map(([drive, d]) =>
    statRow(drive + ' disk', d ? fmtBytes(d.used) + ' / ' + fmtBytes(d.total) + ' (' + d.percent.toFixed(0) + '%)' : 'unavailable'));
  body.replaceChildren(
    h('section', { class: 'list-block' },
      h('div', { class: 'row-head' }, h('span', { class: 'meta' }, 'Threads')),
      statRow('Running', String(status.threads.running_count)),
      statRow('Queued', String(status.threads.queued_count)),
      statRow('Active topics', status.threads.active_topic_count + ' / ' + status.threads.total_topic_count)),
    h('section', { class: 'list-block' },
      h('div', { class: 'row-head' }, h('span', { class: 'meta' }, 'Workers')),
      statRow('Live workers', String(status.workers.alive_count)),
      statRow('Concurrency slots', status.workers.slot_used + ' / ' + status.workers.slot_ceiling)),
    h('section', { class: 'list-block' },
      h('div', { class: 'row-head' }, h('span', { class: 'meta' }, 'System')),
      statRow('CPU', status.system.cpu_percent.toFixed(0) + '% of ' + (status.system.cpu_count || '?') + ' cores'),
      statRow('Memory', fmtBytes(status.system.mem_used) + ' / ' + fmtBytes(status.system.mem_total) + ' (' + status.system.mem_percent.toFixed(0) + '%)'),
      statRow('Assistant memory', fmtBytes(status.assistant_mem_bytes)),
      ...disks,
      statRow('.pa directory', fmtBytes(status.pa_dir_size.bytes) + ' (' + status.pa_dir_size.files + ' files)'),
      statRow('System uptime', fmtUptime(status.system.uptime_secs)),
      statRow('Bot process', status.health.bot_alive ? 'running' : 'down'),
      statRow('Catch-up loop', status.health.catchup_alive ? 'running' : 'down')));
}

async function refreshSystemStatus() {
  if (state.view !== 'system') return;
  try {
    const res = await api('/system/status');
    if (state.view === 'system') renderSystemBody(res.status);
  } catch (e) {
    if (e.status === 401 || e.status === 0) return;
    document.getElementById('system-body')?.replaceChildren(notice('Could not load system status: ' + e.message));
  }
}

// ---------------------------------------------------------------------------
// Triage view (E12)
// ---------------------------------------------------------------------------

function showTriage() {
  state.view = 'triage';
  state.conversationId = null;
  state.conversation = null;
  state.signature = '';
  const rows = h('div', { class: 'rows', id: 'triage-rows', 'aria-live': 'polite' });
  viewRoot().replaceChildren(
    h('div', null,
      backBar('Not placed yet', 'All answers', () => history.back()),
      h('div', { id: 'triage-notice-slot', 'aria-live': 'polite' }),
      h('div', { class: 'summary' },
        h('p', { class: 'title' }, 'Not placed yet'),
        h('p', { class: 'empty-hint' },
          'These are still finding their conversation. They move on their own once it is clear where they belong.')),
      rows,
      recordFooter(null),
    ));
  renderTriageBody();
  refreshConversations();
  startPolling();
  if (state.offline) showNotice('You appear to be offline — showing the last known state.');
  focusViewHeading();
}

function renderTriageBody() {
  const rows = document.getElementById('triage-rows');
  if (!rows) return;
  const unplaced = state.conversations.filter(isUnplaced);
  if (unplaced.length === 0) {
    rows.replaceChildren(emptyBlock('Nothing yet.', 'Tap the circle below and say what you need.'));
    return;
  }
  rows.replaceChildren(...unplaced.map(triageRow));
}

function triageRow(conv) {
  const isSilent = conv.state === 'transcribe_failed';
  const toneClass = isSilent ? 'tone-faint' : 'tone-dim';
  const said = isSilent
    ? 'The recording came through silent. Type it instead, or record it again.'
    : conv.request_text;
  const word = stateWord(conv.state);
  const head = h('div', { class: 'row-head' },
    h('span', { class: 'meta' }, relativeTime(conv.updated_at)),
    h('span', { class: 'state' + (word.accent ? ' state-you' : '') }, word.text));
  const body = h('div', { class: 'turn-said' }, micMark(14, 'currentColor', 4, toneClass),
    h('div', { class: isSilent ? 'said quiet' : 'said' }, said));

  let trailing = null;
  if (conv.state === 'received' || conv.state === 'transcribing') {
    trailing = h('div', { class: 'turn-assistant' }, h('p', { class: 'meta' }, 'Starting its own conversation'));
  } else if (isSilent) {
    trailing = h('div', { class: 'turn-assistant' },
      h('div', { class: 'act-row' },
        h('button', {
          class: 'act act-quiet icon-btn', type: 'button',
          'aria-label': 'Type it', title: 'Type it',
          onclick: (ev) => { ev.stopPropagation(); openTextSheet({ continuesTaskId: conv.latest_task_id, conv }); },
        }, keyboardIcon(18, 'currentColor')),
        h('button', {
          class: 'act act-quiet icon-btn', type: 'button',
          'aria-label': 'Record again', title: 'Record again',
          onclick: (ev) => { ev.stopPropagation(); startReplyCapture(conv); },
        }, micMark(18, 'currentColor', 0))));
  }

  const tapArea = h('button', {
    class: 'row', type: 'button',
    onclick: () => navigate('conversation', conv.conversation_id),
  }, head, body);
  return trailing ? h('div', null, tapArea, trailing) : tapArea;
}

// ---------------------------------------------------------------------------
// Archive view — every conversation, paged from offset 0 with server-side
// search. Static by design: it renders ledger history that barely moves, so
// it loads on entry, on search submit, and on Load more — no poll, no SSE.
// ---------------------------------------------------------------------------

/** The archive view's search box: a .field text input plus a quiet
 *  submit/clear pair. Submitting sets state.archive.q and re-pages;
 *  clearing restores the unfiltered list. */
function archiveSearchBox() {
  const input = h('input', {
    id: 'archive-search-input',
    class: 'field',
    type: 'search',
    placeholder: 'Search conversations',
    value: state.archive?.q ?? '',
    onkeydown: (ev) => {
      if (ev.key === 'Enter') submitArchiveSearch(input.value);
    },
  });
  const submitBtn = h('button', {
    class: 'act act-quiet', type: 'button',
    onclick: () => submitArchiveSearch(input.value),
  }, 'Search');
  const clearBtn = h('button', {
    class: 'act act-quiet', type: 'button',
    onclick: () => {
      input.value = '';
      clearArchiveSearch();
    },
  }, 'Clear');
  return h('div', { class: 'archive-search' }, input, h('div', { class: 'act-row' }, submitBtn, clearBtn));
}

function submitArchiveSearch(value) {
  const trimmed = (value || '').trim();
  if (!state.archive) return;
  state.archive.q = trimmed.length > 0 ? trimmed : null;
  state.archive.rows = [];
  state.archive.total = 0;
  state.archive.loading = true;
  state.archive.error = null;
  loadArchivePage();
}

function clearArchiveSearch() {
  if (!state.archive) return;
  state.archive.q = null;
  state.archive.rows = [];
  state.archive.total = 0;
  state.archive.loading = true;
  state.archive.error = null;
  loadArchivePage();
}

function showArchive() {
  state.view = 'archive';
  state.conversationId = null;
  state.conversation = null;
  state.signature = '';
  // The archive pages the WHOLE tenant from offset 0,
  // not just the overflow past the 100-row fetch clamp.
  state.archive = { rows: [], total: 0, loading: true, error: null, q: null };
  const rows = h('div', { class: 'rows', id: 'archive-rows' });
  viewRoot().replaceChildren(
    h('div', null,
      backBar('Older conversations', 'All answers', () => history.back()),
      h('div', { id: 'archive-notice-slot', 'aria-live': 'polite' }),
      viewSwitch('older'),
      archiveSearchBox(),
      rows));
  loadArchivePage();
  if (state.offline) showNotice('You appear to be offline — showing the last known state.');
  focusViewHeading();
}

/** Fetches the next archive page (or the first, after a reset/search) and
 *  re-renders. Guarded by state.view — a fast back navigation abandons the
 *  result instead of writing into a gone DOM. */
async function loadArchivePage() {
  const archive = state.archive;
  if (!archive || state.view !== 'archive') return;
  archive.loading = true;
  archive.error = null;
  renderArchiveBody();
  try {
    const offset = archive.rows.length;
    let path = '/conversations?limit=' + ARCHIVE_PAGE_SIZE + '&offset=' + offset;
    if (archive.q) path += '&q=' + encodeURIComponent(archive.q);
    const body = await api(path);
    if (state.view !== 'archive' || state.archive !== archive) return;
    const page = Array.isArray(body.conversations) ? body.conversations : [];
    // Offset paging over live data: a conversation updated since the last
    // page can appear twice — first-wins keeps rows unique.
    const seen = new Set(archive.rows.map((c) => c.conversation_id));
    for (const c of page) if (!seen.has(c.conversation_id)) { archive.rows.push(c); seen.add(c.conversation_id); }
    if (Number.isInteger(body.total)) archive.total = body.total;
    archive.loading = false;
    renderArchiveBody();
  } catch (e) {
    if (e.status === 401 || e.status === 0) return;
    if (state.view !== 'archive' || state.archive !== archive) return;
    archive.loading = false;
    archive.error = e.message || 'load failed';
    renderArchiveBody();
  }
}

function renderArchiveBody() {
  const el = document.getElementById('archive-rows');
  if (!el || !state.archive) return;
  const archive = state.archive;
  const nodes = archive.rows.map(conversationRow);
  if (archive.error) {
    nodes.push(h('div', { class: 'widget' },
      h('p', { class: 'meta' }, 'Could not load: ' + archive.error),
      h('div', { class: 'act-row' },
        h('button', { class: 'act act-quiet', type: 'button', onclick: () => loadArchivePage() }, 'Try again'))));
  } else if (archive.loading) {
    nodes.push(h('p', { class: 'meta', 'aria-live': 'polite' }, 'Loading…'));
  } else if (archive.rows.length === 0) {
    // Empty: either no conversations at all, or no search matches.
    if (archive.q) {
      el.replaceChildren(emptyBlock('Nothing matches.', 'Try different words.'));
    } else {
      el.replaceChildren(emptyBlock('Nothing here yet.', 'Conversations will collect here as they happen.'));
    }
    return;
  }
  const remaining = archive.total - archive.rows.length;
  if (!archive.error && !archive.loading && remaining > 0) {
    nodes.push(listDisclosureRow(
      'Load more · ' + remaining + ' more',
      'Load ' + Math.min(ARCHIVE_PAGE_SIZE, remaining) + ' more conversations',
      // No scroll: rows append below the tap point and the disclosure stays
      // where the finger left it — scrollIntoView used to jump the whole
      // list container back to the viewport top on every page.
      () => { loadArchivePage(); }));
  } else if (!archive.error && !archive.loading && archive.rows.length > 0) {
    nodes.push(h('p', { class: 'meta' }, 'That’s everything.'));
  }
  el.replaceChildren(...nodes);
}

// ---------------------------------------------------------------------------
// Knowledge-base view (vi-19787afc4b2e) — everything the app has learned,
// from GET /api/v1/kb: per-topic brains plus the ecosystem knowledge domains,
// already parsed human-shaped server-side (chrome stripped). Two groups of
// collapsible cards in the recap idiom; loaded once per app session (the
// book button re-loads while the view is open).
// ---------------------------------------------------------------------------

// Card open/closed state for the kb view, keyed '<group>:<doc id>' — module
// state like state.expanded: persists across re-renders, resets only
// by an app reload. Cards start collapsed (60 topics × 20 domains would
// otherwise render a wall).
const kbCardOpen = new Set();

function showKb() {
  state.view = 'kb';
  state.conversationId = null;
  state.conversation = null;
  state.signature = '';
  const rows = h('div', { class: 'rows', id: 'kb-rows', 'aria-live': 'polite' });
  viewRoot().replaceChildren(
    h('div', null,
      backBar('Knowledge base', 'All answers', () => history.back()),
      h('div', { id: 'kb-notice-slot', 'aria-live': 'polite' }),
      rows));
  if (state.kb) renderKbBody();
  else loadKb();
  if (state.offline) showNotice('You appear to be offline — showing the last known state.');
  focusViewHeading();
}

/** Loads GET /kb once per app session; `force` (the book button pressed
 *  while already on the view) refetches. Errors render inside the view with
 *  a retry — the empty/error states are the view's own, not notices. */
async function loadKb(force) {
  const el = document.getElementById('kb-rows');
  if (!el || state.view !== 'kb') return;
  if (state.kb && !force && !state.kbError) { renderKbBody(); return; }
  el.replaceChildren(h('p', { class: 'meta', 'aria-live': 'polite' }, 'Loading…'));
  try {
    const body = await api('/kb');
    if (state.view !== 'kb') return;
    state.kb = body && body.kb ? body.kb : { topics: [], domains: [] };
    state.kbError = null;
    renderKbBody();
  } catch (e) {
    if (e.status === 401 || e.status === 0) return;
    if (state.view !== 'kb') return;
    state.kbError = e.message || 'load failed';
    el.replaceChildren(h('div', { class: 'widget' },
      h('p', { class: 'meta' }, 'Could not load the knowledge base: ' + state.kbError),
      h('div', { class: 'act-row' },
        h('button', { class: 'act act-quiet', type: 'button', onclick: () => loadKb(true) }, 'Try again'))));
  }
}

function renderKbBody() {
  const el = document.getElementById('kb-rows');
  if (!el || !state.kb) return;
  const topics = Array.isArray(state.kb.topics) ? state.kb.topics : [];
  const domains = Array.isArray(state.kb.domains) ? state.kb.domains : [];
  if (topics.length === 0 && domains.length === 0) {
    el.replaceChildren(emptyBlock('Nothing yet.', 'Everything the app learns from your conversations collects here.'));
    return;
  }
  const groups = [];
  if (topics.length) groups.push(kbGroup('topics', 'Topics', topics));
  if (domains.length) groups.push(kbGroup('domains', 'Knowledge base', domains));
  el.replaceChildren(...groups);
}

/** One titled group of kb cards — a static heading (the cards inside are
 *  the collapsible part), in the list-block title vocabulary. */
function kbGroup(key, title, docs) {
  return h('section', { class: 'list-block kb-group' },
    h('div', { class: 'row-head' }, h('span', { class: 'meta' }, title + ' · ' + docs.length)),
    ...docs.map((doc) => kbDocCard(key, doc)));
}

/** One knowledge-base document as a collapsible recap-idiom card: header
 *  carries the title and one-line summary; expanding reveals the document's
 *  sections in the app's inline formatting. */
function kbDocCard(groupKey, doc) {
  const key = groupKey + ':' + doc.id;
  const isOpen = kbCardOpen.has(key);
  const header = h('button', {
    class: 'kb-card-header', type: 'button',
    'aria-expanded': isOpen ? 'true' : 'false',
    'aria-label': (isOpen ? 'Collapse ' : 'Expand ') + doc.title,
    onclick: () => {
      const nowOpen = !kbCardOpen.has(key);
      if (nowOpen) kbCardOpen.add(key); else kbCardOpen.delete(key);
      header.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      body.hidden = !nowOpen;
    },
  },
    h('span', { class: 'kb-card-lead' },
      chevron(14, 'currentColor', 'M9 6l6 6-6 6', 'kb-card-chevron tone-dim'),
      h('span', { class: 'kb-card-summary' },
        h('span', { class: 'kb-card-title clamp1' }, doc.title),
        doc.summary ? h('span', { class: 'kb-card-sub clamp1' }, doc.summary) : null)));
  const sections = (doc.sections || []).map((section) => h('div', { class: 'kb-section' },
    section.heading ? h('p', { class: 'kb-section-heading' }, section.heading) : null,
    ...kbSectionNodes(section)));
  const body = h('div', { class: 'kb-card-body', hidden: !isOpen }, ...sections);
  return h('div', { class: 'kb-card' }, header, body);
}

/** One section's stored markdown lines, human-rendered: consecutive dash
 *  bullets group into a real list, everything else renders with the app's
 *  inline formatting (bold, emphasis, links). The server already dropped
 *  agent chrome, so no stripping happens here. */
function kbSectionNodes(section) {
  const nodes = [];
  let list = null;
  const flush = () => { if (list) { nodes.push(list); list = null; } };
  for (const line of section.lines || []) {
    if (/^\s*[-*]\s+/.test(line)) {
      if (!list) list = h('ul', { class: 'kb-list' });
      list.append(h('li', { class: 'kb-line' }, parseInlineText(line.replace(/^\s*[-*]\s+/, ''))));
    } else {
      flush();
      nodes.push(h('p', { class: 'kb-line' }, renderLines(line)));
    }
  }
  flush();
  return nodes;
}

// ---------------------------------------------------------------------------
// Conversation view (E13)
// ---------------------------------------------------------------------------

function showConversation(id) {
  state.view = 'conversation';
  state.conversationId = id;
  state.conversation = null;
  state.signature = '';
  state.expandedRecaps.delete(id);
  state.expandedTurns.clear();
  state.expandedAnswers.clear();
  state.expandedOriginals.clear();
  stopLiveWatch();
  resetLiveWatchDismissals(); // a fresh view session may re-show a closed pane
  viewRoot().replaceChildren(
    h('div', null,
      backBar(null, 'All answers', () => history.back()),
      h('div', { id: 'conv-notice-slot', 'aria-live': 'polite' }),
      h('div', { id: 'conv-body', 'aria-live': 'polite' }, notice('Loading…')),
    ));
  refreshConversation();
  startPolling();
  if (state.offline) showNotice('You appear to be offline — showing the last known state.');
  focusViewHeading();
}

/** The footer's `More actions` overflow trigger. Everything that used to
 * sit in the extras cluster besides stop — attach media/files, the
 * assistant-chat thread link, share — lives in this sheet (operator
 * 2026-09-15: five icon buttons + the absolutely-centred mic overfilled
 * the 375px row and wrapped under it; four extras still crossed the
 * mic's centred span).
 */
function moreActionsButton(conv) {
  return h('button', {
    class: 'linkish icon-btn', type: 'button',
    'aria-label': 'More actions', title: 'More actions',
    'aria-haspopup': 'dialog',
    onclick: () => openConversationActionsSheet(conv),
  }, '⋯');
}

/**
 * The conversation footer's overflow sheet, in openShareSheet's idiom:
 * attach pickers (same-gesture via openTextSheet's picker option), the
 * assistant-chat thread link, and share. Full-width .menu-row entries —
 * icon + label — not icon buttons.
 */
function openConversationActionsSheet(conv) {
  if (sheetEl) closeSheet();
  sheetTrigger = document.activeElement;
  const steer = replySteerMode(conv);
  const pillChildren = [h('span', { class: 'pill' }, 'Conversation')];
  pillChildren.push(h('span', { class: 'sheet-secondary' }, 'about ' + sheetTargetQuote(conv)));
  scrimEl = h('div', { class: 'scrim' });
  scrimEl.addEventListener('click', closeSheet);
  const rows = [
    h('button', {
      class: 'menu-row', type: 'button',
      onclick: () => openTextSheet({ continuesTaskId: conv.latest_task_id, steer, conv, picker: 'media' }),
    }, imageIcon(18, 'currentColor'), h('span', {}, 'Attach photos or videos')),
    h('button', {
      class: 'menu-row', type: 'button',
      onclick: () => openTextSheet({ continuesTaskId: conv.latest_task_id, steer, conv, picker: 'files' }),
    }, docIcon(18, 'currentColor'), h('span', {}, 'Attach files')),
  ];
  if (conv.telegram_link) {
    rows.push(h('a', {
      class: 'menu-row', href: conv.telegram_link,
      target: '_blank', rel: 'noopener',
    }, externalLinkIcon(18, 'currentColor'), h('span', {}, 'Open this thread in your assistant chat')));
  }
  // Thread-level feedback from inside the conversation (2026-09-16): the same
  // sheet the list row's ⋯/long-press opens, about the conversation id.
  rows.push(h('button', {
    class: 'menu-row', type: 'button',
    onclick: () => openFeedbackSheet({ about: conv.conversation_id, title: conversationLines(conv).title }),
  }, flagIcon(18, 'currentColor'), h('span', {}, 'Give feedback')));
  rows.push(h('button', {
    class: 'menu-row', type: 'button',
    onclick: openShareSheet,
  }, shareIcon(18, 'currentColor'), h('span', {}, 'Share conversation')));
  sheetEl = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Conversation actions', tabindex: '-1',
  },
    h('div', { class: 'pill-row' }, ...pillChildren),
    h('div', { class: 'menu-rows' }, ...rows));
  document.body.append(scrimEl, sheetEl);
  armSheetKeyboard();
  sheetEl.focus();
}

/**
 * The share bottom sheet (vi-19787afc4b2e), in the feedback sheet's idiom.
 * With an active link: the `/s/:token` URL, Share (the Web Share API — the
 * native Android/iOS/desktop system share sheet; the action is HIDDEN
 * entirely where the API is unavailable, so Copy link is a real fallback,
 * never a broken button), Copy link with the same check-glyph feedback as
 * copy elsewhere, and a quiet Stop sharing below. With none: it mints one
 * first (preparing state) and re-renders into the active state; a mint
 * failure renders inside the sheet with a retry. conv.share stays in
 * conversationSignature, so a share made from another device still
 * re-renders the conversation underneath.
 */
function openShareSheet() {
  if (sheetEl) closeSheet();
  sheetTrigger = document.activeElement;
  const conv = state.conversation;
  const pillChildren = [h('span', { class: 'pill' }, 'Share')];
  if (conv) pillChildren.push(h('span', { class: 'sheet-secondary' }, 'about ' + sheetTargetQuote(conv)));
  scrimEl = h('div', { class: 'scrim' });
  scrimEl.addEventListener('click', closeSheet);
  sheetEl = h('div', { class: 'sheet', id: 'share-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Share conversation', tabindex: '-1' },
    h('div', { class: 'pill-row' }, ...pillChildren),
    h('div', { id: 'share-sheet-body' }));
  document.body.append(scrimEl, sheetEl);
  armSheetKeyboard();
  sheetEl.focus();
  const share = conv && conv.share && conv.share.active ? conv.share : null;
  if (share) renderShareSheetActive(share.token);
  else renderShareSheetMinting();
}

/** The sheet's mutable middle; gone once the sheet closes. */
function shareSheetBody() {
  const sheet = document.getElementById('share-sheet');
  return sheet ? sheet.querySelector('#share-sheet-body') : null;
}

async function mintShareLink() {
  const resp = await api('/conversations/' + encodeURIComponent(state.conversationId) + '/share', { method: 'POST' });
  if (state.conversation) state.conversation.share = { active: true, token: resp.token, created_at: resp.created_at };
  return resp.token;
}

function renderShareSheetMinting() {
  const bodyEl = shareSheetBody();
  if (!bodyEl) return;
  bodyEl.replaceChildren(h('p', { class: 'sheet-secondary', 'aria-live': 'polite' }, 'Preparing link…'));
  mintShareLink().then((token) => {
    if (shareSheetBody()) renderShareSheetActive(token);
  }, (e) => {
    renderShareSheetMintError(e && e.message ? e.message : 'unknown error');
  });
}

function renderShareSheetMintError(message) {
  const bodyEl = shareSheetBody();
  if (!bodyEl) return;
  bodyEl.replaceChildren(
    h('p', { class: 'sheet-secondary' }, 'Could not create the link: ' + message),
    h('div', { class: 'act-row share-act-row' },
      h('button', { class: 'act act-quiet', type: 'button', onclick: () => renderShareSheetMinting() }, 'Try again')));
}

/** Share/Stop failures land INSIDE the sheet (vi-19787afc4b2e), never as a
 *  notice behind it — the operator is looking at the sheet. */
function renderShareSheetError(message) {
  const bodyEl = shareSheetBody();
  if (!bodyEl) return;
  let slot = bodyEl.querySelector('#share-sheet-error-slot');
  if (!slot) {
    slot = h('div', { id: 'share-sheet-error-slot' });
    bodyEl.append(slot);
  }
  slot.replaceChildren(h('p', { class: 'sheet-secondary' }, message));
}

function renderShareSheetActive(token) {
  const bodyEl = shareSheetBody();
  if (!bodyEl) return;
  const url = location.origin + '/s/' + token;
  const actions = [];
  if (navigator.share) {
    actions.push(h('button', {
      class: 'act act-primary', type: 'button',
      onclick: async () => {
        try {
          await navigator.share({ title: 'Voice Inbox conversation', url });
        } catch (e) {
          // A dismissal is the operator's own choice, not a failure.
          if (e && e.name === 'AbortError') return;
          renderShareSheetError('Could not share: ' + (e && e.message ? e.message : 'unknown error'));
        }
      },
    }, 'Share'));
  }
  const copy = h('button', {
    class: 'act act-quiet', type: 'button',
    'aria-label': 'Copy link', title: 'Copy link',
  }, 'Copy link');
  copy.addEventListener('click', () => copyAnswerText(url, copy, () => {
    copy.replaceChildren('Copy link');
  }));
  actions.push(copy);
  const stop = h('button', {
    class: 'linkish share-stop', type: 'button',
    'aria-label': 'Stop sharing', title: 'Stop sharing',
  }, 'Stop sharing');
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try {
      await api('/conversations/' + encodeURIComponent(state.conversationId) + '/unshare', { method: 'POST' });
      if (state.conversation) state.conversation.share = { active: false };
      // The link is gone — staying in a sheet whose whole purpose was that
      // link would only tempt a re-mint; close and confirm by notice.
      closeSheet();
      showNotice('Sharing stopped.');
    } catch (e) {
      stop.disabled = false;
      renderShareSheetError('Could not stop sharing: ' + (e && e.message ? e.message : 'unknown error'));
    }
  });
  bodyEl.replaceChildren(
    h('p', { class: 'share-url', 'aria-live': 'polite' }, url),
    h('div', { class: 'act-row share-act-row' }, ...actions),
    stop);
}

async function refreshConversation() {
  const id = state.conversationId;
  if (!id) return;
  let conv;
  try {
    const resp = await api('/conversations/' + encodeURIComponent(id));
    conv = resp.conversation;
  } catch (e) {
    if (e.status === 401 || e.status === 0) return;
    const slot = document.getElementById('conv-notice-slot');
    if (slot) slot.replaceChildren(
      notice('Could not load: ' + e.message),
      h('button', {
        class: 'act act-quiet', type: 'button',
        onclick: () => refreshConversation(),
      }, 'Try again'));
    else showNotice('Could not load: ' + e.message);
    return;
  }
  if (state.conversationId !== id) return; // navigated away meanwhile
  clearNotice();
  postConversationViewed(conv);
  state.conversation = conv;
  const sig = conversationSignature(conv);
  if (sig === state.signature) return;
  state.signature = sig;
  renderConversationBody(conv);
  syncLiveWatch(conv);
}

/**
 * Origin banner (t-3, 2026-09-18): when this conversation carries
 * feedback_about (routes.ts's `feedback` field — inherited across every
 * continuation turn since Option 1, never just the root screen), a chip at
 * the top of the conversation view links back to what the feedback is
 * about. `conv.feedback` is undefined (key omitted) when the thread carries
 * no feedback_about — see publicConversationSummary/conversationDetailHandler.
 */
function feedbackOriginBanner(conv) {
  if (!conv.feedback) return null;
  const target = conv.feedback.title ? '“' + conv.feedback.title + '”' : 'an earlier conversation';
  const lead = conv.feedback.level === 'task' ? 'Feedback on a message in ' : 'Feedback on ';
  return h('button', {
    class: 'origin-banner', type: 'button',
    onclick: () => navigate('conversation', conv.feedback.conversationId),
  }, h('span', { class: 'origin-banner-text' }, lead + target), h('span', { class: 'origin-banner-arrow', 'aria-hidden': 'true' }, '›'));
}

function renderConversationBody(conv) {
  const body = document.getElementById('conv-body');
  if (!body) return;
  const word = conversationHeaderWord(conv);
  const head = h('div', { class: 'row-head' },
    h('span', { class: 'meta' },
      (conv.task_count === 1 ? '1 message' : conv.task_count + ' messages') + ' · ' + relativeTime(conv.updated_at)),
    h('span', { class: 'row-head-state' },
      h('span', { id: 'live-badge-slot', hidden: true }),
      h('span', { class: 'state ' + word.tone }, word.text)));
  const lines = conversationLines(conv);
  const parts = [head, h('p', { class: 'title clamp2' }, lines.title)];
  if (lines.recap) parts.push(h('p', { class: 'answer clamp3' }, lines.recap));
  const summary = h('div', { class: 'summary' }, ...parts);
  const log = h('div', { class: 'log' }, conversationTurns(conv));
  viewRoot().classList.add('compact-footer'); // scroll padding for the one-row footer
  // Sharing lives in the footer's sheet since vi-19787afc4b2e — no inline
  // panel slot above the footer anymore.
  const banner = feedbackOriginBanner(conv);
  body.replaceChildren(...(banner ? [banner] : []), summary, log, recordFooter(conv));
}

/**
 * The newest answered input request across the whole conversation (by
 * answered_at), regardless of which task it belongs to. Used to place the
 * follow-up row exactly once, on the most recent answer, never per-task.
 */
function newestAnsweredRequest(conv) {
  let newest = null;
  for (const task of conv.tasks || []) {
    for (const req of task.input_requests || []) {
      if (req.status !== 'answered' || !req.answered_at) continue;
      if (!newest || Date.parse(req.answered_at) > Date.parse(newest.answered_at)) newest = req;
    }
  }
  return newest;
}

/**
 * Rendered directly under the newest answered request's "Answered" line
 * while the conversation is non-terminal (a widget answer used to strand the
 * operator with no visible way to add more). Reuses the footer's own
 * continue/steer paths (openTextSheet / startReplyCapture, both driven by the
 * same `conv`) rather than forking the payload logic.
 */
function followUpRow(conv) {
  return h('div', { class: 'turn-assistant', id: 'followup-row' },
    h('p', { class: 'meta' }, 'Add your follow-up'),
    h('div', { class: 'act-row' },
      h('button', {
        class: 'act act-quiet icon-btn', type: 'button',
        'aria-label': 'Type it', title: 'Type it',
        onclick: () => openTextSheet({ continuesTaskId: conv.latest_task_id, steer: replySteerMode(conv), conv }),
      }, keyboardIcon(18, 'currentColor')),
      h('button', {
        class: 'act act-quiet icon-btn', type: 'button',
        'aria-label': 'Record it', title: 'Record it',
        onclick: () => startReplyCapture(conv),
      }, micMark(18, 'currentColor', 0))));
}

function turnSummaryText(task) {
  if (task.result_summary) {
    return plainAnswerSnippet(task.result_summary);
  }
  if (task.state === 'failed') {
    return newestFailureReason(task.events || []);
  }
  if (task.state === 'transcribe_failed') {
    return 'Couldn’t hear that.';
  }
  if (task.state === 'awaiting_input') {
    const pending = (task.input_requests || []).find((r) => r.status === 'pending');
    return pending && pending.prompt ? pending.prompt : 'Waiting for your input';
  }
  if (task.state === 'running' || task.state === 'received' || task.state === 'transcribing') {
    return 'Working on this…';
  }
  return stateWord(task.state).text;
}

function renderTurnContent(task, conv, newestAnswered, opts) {
  const hideQuestion = !!(opts && opts.hideQuestion);
  const nodes = [];
  if (!hideQuestion) {
    const said = h('div', { class: 'turn-said' }, micMark(14, 'currentColor', 4, 'tone-dim'), h('div', { class: 'said' }, turnText(task)), messageFeedbackButton(task, conv));
    wireFeedbackGestures(said, () => openFeedbackSheet({ about: task.task_id, title: turnText(task) }));
    nodes.push(said);
    nodes.push(...originalWordsNodes(task));
  }
  // Compact toggle button, styled and grouped like the turn's other action
  // buttons rather than a full-width native player occupying its own row —
  // audioPlayer() itself never swaps out for an <audio controls> element.
  if (task.source === 'voice') nodes.push(h('div', { class: 'turn-audio act-row' }, audioPlayer(task.task_id)));
  if (task.attachments && task.attachments.length > 0) nodes.push(attachmentsRow(task));

  const wb = workBlock(task);
  if (wb) nodes.push(wb);
  // The live-view pane's mount point (AI-246) — kept hidden while the task is
  // not streaming so the empty slot never opens a gap in the turn.
  nodes.push(h('div', { id: 'live-slot-' + task.task_id, hidden: true }));

  const answerParts = answerRegionParts(task);
  // Answer provenance (WS3) rides AFTER the answer content — attached here,
  // the seam's single consumer, because answerRegionParts' body is pinned by
  // comparison-renderer.test.ts and the chip must not disturb the structured
  // /markdown seam itself. NULL worker fields → no row, legacy cards untouched.
  // Answer routing (decision 33) + provenance chip (WS3): both attached here,
  // the seam's single consumer, because answerRegionParts' body is pinned by
  // comparison-renderer.test.ts and neither may disturb the structured
  // /markdown seam itself. NULL router_* fields → no line, no chip rows;
  // legacy cards render byte-identically. Line first, chip second — the
  // placement change is default-visible, the chip is opt-in depth.
  const routingLine = answerRoutingLine(task);
  const provenanceRow = answerProvenanceRow(task);
  // Answered cards only: a running/failed card never shows a metadata-only
  // assistant block mid-run (result_summary is mandatory for a completion).
  if (routingLine && task.result_summary) answerParts.push(routingLine);
  if (provenanceRow && task.result_summary) answerParts.push(provenanceRow);
  if (task.state === 'failed') {
    answerParts.push(h('p', { class: 'answer' }, newestFailureReason(task.events || [])));
  } else if (task.state === 'transcribe_failed') {
    answerParts.push(h('p', { class: 'answer' }, 'Couldn’t hear that.'));
    answerParts.push(h('div', { class: 'act-row' },
      h('button', {
        class: 'act act-quiet icon-btn', type: 'button',
        'aria-label': 'Type it', title: 'Type it',
        onclick: () => openTextSheet({ continuesTaskId: conv.latest_task_id, conv }),
      }, keyboardIcon(18, 'currentColor')),
      h('button', {
        class: 'act act-quiet icon-btn', type: 'button',
        'aria-label': 'Record again', title: 'Record again',
        onclick: () => startReplyCapture(conv),
      }, micMark(18, 'currentColor', 0))));
  }
  // The turn's act-row: Copy beside the message-level flag — the flag is the
  // "this response is wrong" affordance, placed where the answer is being read.
  if (answerParts.length || task.result_summary) {
    const turnActs = task.result_summary ? [copyAnswerButton(task.result_summary)] : [];
    turnActs.push(messageFeedbackButton(task, conv, 'chip'));
    answerParts.push(h('div', { class: 'act-row' }, ...turnActs));
  }
  // AI-234: quick-reply chips under the answer card. Rendered only when the
  // task carries non-empty suggested items AND the conversation is
  // non-terminal (mirror followUpRow's gate — a done/failed conversation has
  // nothing natural to follow with). A chip tap opens the text sheet pre-
  // filled with the chip label over the existing continue/steer path; no new
  // submit route, no new POST /tasks field.
  const suggestedLabels = suggestedItemLabels(task);
  if (suggestedLabels.length && !isTerminal(conv.state)) {
    answerParts.push(h('div', { class: 'suggest-chips' },
      ...suggestedLabels.map((label) =>
        h('button', {
          class: 'chip', type: 'button',
          onclick: () => openTextSheet({
            continuesTaskId: conv.latest_task_id,
            prefill: label, steer: replySteerMode(conv), conv }),
        }, label))));
  }
  if (answerParts.length) nodes.push(h('div', { class: 'turn-assistant' }, ...answerParts));

  for (const req of task.input_requests || []) {
    if (req.status === 'pending') {
      nodes.push(widgetTurn(task.task_id, req));
    } else if (req.status === 'answered') {
      nodes.push(h('div', { class: 'turn-assistant' }, h('p', { class: 'meta' }, 'Answered · ' + clockTime(req.answered_at))));
      if (req === newestAnswered && !isTerminal(conv.state)) {
        nodes.push(followUpRow(conv));
      }
    } else if (req.status === 'expired') {
      nodes.push(h('div', { class: 'turn-assistant' },
        h('p', { class: 'meta faded' }, 'This question expired.')));
    } else if (req.status === 'cancelled') {
      nodes.push(h('div', { class: 'turn-assistant' },
        h('p', { class: 'meta faded' }, 'This question was cancelled.')));
    }
  }
  return nodes;
}

function renderEarlierTurnItem(task, conv, newestAnswered) {
  const taskId = task.task_id;
  const isOpen = state.expandedTurns.has(taskId);

  const prompt = turnText(task);
  const reply = turnSummaryText(task);

  const turnChevron = chevron(12, 'currentColor', 'M9 6l6 6-6 6', 'recap-chevron tone-faint');

  const header = h('button', {
    class: 'recap-item-header', type: 'button',
    'aria-expanded': isOpen ? 'true' : 'false',
    'aria-label': 'Toggle earlier message: ' + prompt,
    onclick: () => {
      if (suppressClickOnce) { suppressClickOnce = false; return; }
      const nowOpen = !state.expandedTurns.has(taskId);
      if (nowOpen) state.expandedTurns.add(taskId);
      else state.expandedTurns.delete(taskId);
      header.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      itemBody.hidden = !nowOpen;
    },
  },
    h('div', { class: 'recap-item-summary' },
      h('div', { class: 'recap-item-said' },
        micMark(14, 'currentColor', 4, 'tone-dim'),
        h('span', { class: 'clamp1' }, prompt)),
      h('div', { class: 'recap-item-reply clamp1' }, reply)),
    h('div', { class: 'recap-item-meta' },
      h('span', { class: 'meta' }, relativeTime(task.created_at || task.updated_at)),
      turnChevron));
  wireFeedbackGestures(header, () => openFeedbackSheet({ about: task.task_id, title: turnText(task) }));

  // The body repeats the question in full: the header clamps it to one line
  // now, so without this the un-truncated question is shown nowhere. (The
  // body once omitted it because the header carried it unclamped.)
  const itemBody = h('div', { class: 'recap-item-body', hidden: !isOpen },
    ...renderTurnContent(task, conv, newestAnswered));

  // The flag is a SIBLING of the header button (a <button> in a <button> is
  // invalid HTML); styles.css positions it top-right over the cleared corner.
  return h('div', { class: 'recap-item' }, header, messageFeedbackButton(task, conv), itemBody);
}

function earlierRecapSection(tasks, conv, newestAnswered) {
  const convId = conv.conversation_id;
  const isOpen = state.expandedRecaps.has(convId);
  const count = tasks.length;
  const countLabel = count === 1 ? '1 earlier message' : count + ' earlier messages';

  const chevronIcon = chevron(12, 'currentColor', 'M9 6l6 6-6 6', 'recap-chevron tone-faint');
  const bar = h('button', {
    class: 'recap-bar', type: 'button',
    'aria-expanded': isOpen ? 'true' : 'false',
    'aria-label': 'Toggle ' + countLabel,
    onclick: () => {
      const nowOpen = !state.expandedRecaps.has(convId);
      if (nowOpen) state.expandedRecaps.add(convId);
      else state.expandedRecaps.delete(convId);
      bar.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      list.hidden = !nowOpen;
    },
  },
    h('div', { class: 'recap-bar-lead' },
      chevronIcon,
      h('span', { class: 'recap-title' }, 'Earlier conversation')),
    h('span', { class: 'recap-count' }, countLabel));

  const list = h('div', { class: 'recap-list', hidden: !isOpen },
    tasks.map((task) => renderEarlierTurnItem(task, conv, newestAnswered)));

  return h('div', { class: 'recap-section' }, bar, list);
}

// A turn has something new to show once it leaves the "still working" states
// (received/transcribing/routed/running) — i.e. it reached a terminal state
// or is asking the operator a question.
function turnHasAnswer(task) {
  return isTerminal(task.state) || task.state === 'awaiting_input';
}

function conversationTurns(conv) {
  const tasks = conv.tasks || [];
  if (!tasks.length) return [];
  const newestAnswered = newestAnsweredRequest(conv);

  // If there is only one turn, show it directly in full.
  if (tasks.length === 1) {
    return renderTurnContent(tasks[0], conv, newestAnswered);
  }

  // Multiple turns: earlier turns collapse into a recap bar (default collapsed).
  // The last turn is always shown in full. The previous turn stays alongside
  // it — uncollapsed — until the last turn actually has an answer; collapsing
  // it the moment a new recording starts would hide the previous answer
  // before there is anything new to look at yet.
  const lastTask = tasks[tasks.length - 1];
  const keepCount = turnHasAnswer(lastTask) ? 1 : Math.min(2, tasks.length);
  const earlierTasks = tasks.slice(0, tasks.length - keepCount);
  const shownTasks = tasks.slice(tasks.length - keepCount);

  const nodes = [];
  if (earlierTasks.length) nodes.push(earlierRecapSection(earlierTasks, conv, newestAnswered));
  for (const task of shownTasks) nodes.push(...renderTurnContent(task, conv, newestAnswered));
  return nodes;
}

function widgetTurn(taskId, req) {
  return h('div', { class: 'turn-assistant' },
    h('p', { class: 'ask' }, 'Your assistant needs you to answer this'),
    h('p', { class: 'answer' }, req.prompt),
    renderWidgetCard(taskId, req));
}

/**
 * The footer's stop trigger — opens the confirm sheet. The confirm used
 * to swap this button's slot for a wider .act-row, which could itself
 * reach under the absolutely-centred mic (operator 2026-09-15).
 */
function stopControl(conv) {
  return h('button', {
    class: 'linkish faded icon-btn', type: 'button',
    'aria-label': 'Stop this', title: 'Stop this',
    onclick: () => openStopConfirmSheet(conv),
  }, stopIcon(16, 'currentColor'));
}

/**
 * The stop confirm sheet. Cancelling really kills a running worker, so
 * the confirm stays mandatory — as a dialog, not an inline footer morph.
 */
function openStopConfirmSheet(conv) {
  async function doStop() {
    try {
      const body = await api('/tasks/' + encodeURIComponent(conv.latest_task_id) + '/cancel', { method: 'POST' });
      await refreshConversation();
      if (body && body.stop_requested === false) {
        showNotice('Marked cancelled. Nothing was running to stop.');
      }
    } catch (e) {
      if (e.status !== 401) showNotice('Could not stop it: ' + e.message);
    }
  }
  if (sheetEl) closeSheet();
  sheetTrigger = document.activeElement;
  scrimEl = h('div', { class: 'scrim' });
  scrimEl.addEventListener('click', closeSheet);
  sheetEl = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Stop this task', tabindex: '-1',
  },
    h('div', { class: 'pill-row' }, h('span', { class: 'pill' }, 'Stop this?')),
    h('div', { class: 'act-row' },
      h('button', {
        class: 'act act-quiet', type: 'button',
        onclick: () => { closeSheet(); doStop(); },
      }, 'Yes, stop'),
      h('button', {
        class: 'act act-quiet', type: 'button',
        onclick: closeSheet,
      }, 'Keep going')));
  document.body.append(scrimEl, sheetEl);
  armSheetKeyboard();
  sheetEl.focus();
}

// ---------------------------------------------------------------------------
// The render-signature guard (E14, mandatory) — a cheap fingerprint of
// everything a view renders. Re-rendering only on a change keeps a 4-second
// poll from clobbering half-typed widget input, a chosen option or an open
// working block.
// ---------------------------------------------------------------------------

function conversationSignature(conv) {
  return [conv.conversation_id, conv.state, conv.status || '', conv.updated_at, conv.request_text || '', conv.task_count,
    conv.result_summary || '', conv.pending_input_count, conv.telegram_link || '',
    conv.title || '', conv.recap || '', conv.next_action || '',
    conv.share && conv.share.active ? 'shared:' + conv.share.token : 'unshared',
    (conv.tasks || []).map((t) => [t.task_id, t.state, t.updated_at, t.request_text || '',
      (t.events || []).length,
      (t.input_requests || []).map((r) => r.request_id + ':' + r.status).join(','),
    ].join('~')).join(';')].join('|');
}
function listSignature(conversations) {
  const minute = Math.floor(Date.now() / 60000);
  return minute + '|' + conversations.map((c) => [c.conversation_id, c.state, c.updated_at,
    c.request_text || '', c.latest_request_text || '', c.task_count,
    c.pending_input_count, c.result_summary || '',
    c.title || '', c.recap || '', c.next_action || '',
    c.status || '', c.band || '', c.failed_unresolved || 0,
    // A mid-run progress event (planning -> building) does not bump the
    // task's updated_at (ledger.ts appendEvent), so latest_step must be its
    // own signature field or a phase change would never re-render the row.
    c.latest_step || ''].join('~')).join(';');
}

// ---------------------------------------------------------------------------
// The collapsed working block (E15) — the operator brief's "collapsed
// thinking": the plumbing is not deleted, it is one tap away.
// ---------------------------------------------------------------------------

/**
 * The real telemetry text for one work-log line. Worker scripts write the
 * human-readable text into payload.step (task.progress) or payload.reason
 * (task.failed / task.routed / task.rerouted) — `summary` is always null for
 * these, so falling back on EVENT_FALLBACK alone rendered nothing but the
 * bare per-kind label for every one of them. Returns { text, meta }: `meta`
 * is an optional second, clamped line (task.routed/rerouted's long
 * model-phrased reason) or null.
 */
function workLineText(ev) {
  const kind = ev && ev.kind;
  const label = EVENT_FALLBACK[kind] || 'Event';
  const payload = ev && ev.payload && typeof ev.payload === 'object' ? ev.payload : null;
  const summary = ev && ev.summary;

  if (kind === 'task.progress') {
    const step = payload ? payload.step : undefined;
    if (typeof step === 'string' && step) return { text: step === 'started' ? 'Started' : step, meta: null };
    if (typeof summary === 'string' && summary) return { text: summary, meta: null };
    return { text: label, meta: null };
  }

  if (kind === 'task.failed') {
    const reason = payload ? payload.reason : undefined;
    if (typeof reason === 'string' && reason) return { text: reason, meta: null };
    if (typeof summary === 'string' && summary) return { text: summary, meta: null };
    return { text: label, meta: null };
  }

  if (kind === 'task.routed' || kind === 'task.rerouted') {
    const reason = payload ? payload.reason : undefined;
    return { text: label, meta: typeof reason === 'string' && reason ? reason : null };
  }

  return { text: (typeof summary === 'string' && summary) || label, meta: null };
}

function workLineMeta(taskId, idx, meta) {
  const key = taskId + ':' + idx;
  const isOpen = state.expandedSteps.has(key);
  const metaSpan = h('span', { class: isOpen ? 'meta' : 'meta clamp1' }, meta);
  const btn = h('button', {
    class: 'work-line-meta-toggle', type: 'button',
    'aria-expanded': isOpen ? 'true' : 'false',
    'aria-label': (isOpen ? 'Collapse' : 'Expand') + ' step detail',
    onclick: () => {
      const nowOpen = !state.expandedSteps.has(key);
      if (nowOpen) state.expandedSteps.add(key); else state.expandedSteps.delete(key);
      btn.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      metaSpan.className = nowOpen ? 'meta' : 'meta clamp1';
    },
  }, metaSpan);
  return btn;
}

function workBlock(task) {
  const events = task.events || [];
  if (events.length === 0) return null;
  const progress = events.filter((e) => e && e.kind === 'task.progress');
  // Span: a finished task measures its own work; a live one counts up.
  const startIso = progress.length ? progress[0].ts : task.created_at;
  const endMs = isTerminal(task.state) ? Date.parse(task.updated_at) : Date.now();
  const startMs = Date.parse(startIso);
  const span = Number.isNaN(startMs) || Number.isNaN(endMs) ? 0 : Math.max(0, endMs - startMs);
  const label = progress.length
    ? 'Worked for ' + duration(span) + ' · ' + progress.length + (progress.length === 1 ? ' update' : ' updates')
    : 'Worked for ' + duration(span);

  const open = state.expanded.has(task.task_id);
  const log = h('div', { class: 'work-log', hidden: !open },
    events.map((ev, idx) => {
      const { text, meta } = workLineText(ev);
      return h('div', { class: 'work-line' },
        h('span', { class: 'work-line-text' }, text, meta ? workLineMeta(task.task_id, idx, meta) : null),
        h('span', { class: 'work-line-time', title: (ev && ev.ts) || '' }, relativeTime(ev && ev.ts)));
    }));
  const toggle = h('button', {
    class: 'work', type: 'button', 'aria-expanded': open ? 'true' : 'false',
    onclick: () => {
      const nowOpen = !state.expanded.has(task.task_id);
      if (nowOpen) state.expanded.add(task.task_id); else state.expanded.delete(task.task_id);
      toggle.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
      log.hidden = !nowOpen;
    },
  }, chevron(12, 'currentColor', 'M9 6l6 6-6 6', 'work-chevron tone-faint'), h('span', { class: 'meta' }, label));
  return h('div', null, toggle, log);
}

// ---------------------------------------------------------------------------
// Widget renderer (E16) — switches ONLY on the seven kinds. Behaviour is
// semantically unchanged from before the redesign; only markup and classes
// change.
// ---------------------------------------------------------------------------

function parseParams(req) {
  if (!req) return {};
  if (req.params && typeof req.params === 'object') return req.params;
  if (typeof req.params_json === 'string' && req.params_json) {
    try { return JSON.parse(req.params_json) || {}; } catch { return {}; }
  }
  return {};
}

function invalidWidgetCard(kind) {
  // vi-7790f35108f8: an unknown kind almost always means this page runs a
  // shell older than the request (a new widget kind shipped). Offer the
  // one-tap update instead of a dead end.
  return h('div', { class: 'widget' },
    h('p', { class: 'answer' }, 'This input request uses a type' +
      (kind ? ' ("' + String(kind) + '")' : '') +
      ' this app version can’t show yet — the app is likely out of date.'),
    h('div', { class: 'act-row' },
      h('button', {
        class: 'act act-primary', type: 'button',
        onclick: () => { updateAndReload(); },
      }, 'Refresh the app')));
}

function widgetError(card, message) {
  const existing = card.querySelector('.widget-error-line');
  if (existing) existing.remove();
  card.append(h('p', { class: 'meta widget-error-line' }, message));
}

async function submitAnswer(taskId, req, body) {
  return api('/tasks/' + encodeURIComponent(taskId) +
    '/inputs/' + encodeURIComponent(req.request_id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function markAnswered(card, req) {
  card.replaceChildren(h('p', { class: 'meta' }, 'Answered ' + clockTime(new Date().toISOString())));
  refreshConversation().then(scrollFollowUpIntoView).catch(() => {});
}

/** After a successful answer, bring the follow-up row (if any) into view
 *  immediately, so the operator sees it without hunting for it. */
function scrollFollowUpIntoView() {
  const row = document.getElementById('followup-row');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/** Display label for an oauth widget's provider. No allowlist is duplicated
 *  here — the server already rejected anything not in OAUTH_PROVIDERS. */
function providerLabel(p) {
  if (p === 'google') return 'Google';
  const s = String(p);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// form widget drafts (vi-6f1d767dd640) — an abandoned sheet survives reload;
// nothing lands server-side until the single Submit.
// ---------------------------------------------------------------------------

const FORM_DRAFT_PREFIX = 'vi.form.';

function formDraftKey(requestId) {
  return FORM_DRAFT_PREFIX + requestId;
}

function readFormDraft(requestId) {
  try {
    const raw = JSON.parse(localStorage.getItem(formDraftKey(requestId)) || 'null');
    return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.answers &&
      typeof raw.answers === 'object' && !Array.isArray(raw.answers) ? raw.answers : {};
  } catch {
    return {};
  }
}

function writeFormDraft(requestId, answers) {
  try {
    localStorage.setItem(formDraftKey(requestId), JSON.stringify({ answers, updatedAt: Date.now() }));
  } catch { /* private mode: the draft lives for the page only */ }
}

function clearFormDraft(requestId) {
  try { localStorage.removeItem(formDraftKey(requestId)); } catch { /* ignore */ }
}

function renderWidgetCard(taskId, req) {
  const kind = req && req.kind;
  const params = parseParams(req);

  // The switch covers exactly the seven kinds; anything else is invalid.
  switch (kind) {
    case 'secret': {
      const input = h('input', {
        class: 'field', type: 'password', autocomplete: 'new-password',
        placeholder: typeof params.placeholder === 'string' ? params.placeholder : '',
        'aria-label': req.prompt,
      });
      const card = h('div', { class: 'widget', dataset: { widgetKind: 'secret' } },
        input,
        h('div', { class: 'act-row' },
          h('button', {
            class: 'act act-primary icon-btn', type: 'button',
            'aria-label': 'Send answer', title: 'Send answer',
            onclick: async () => {
              const value = input.value;
              if (!value) return widgetError(card, 'Enter a value first.');
              if (value.length > 1000) return widgetError(card, 'Value must be at most 1000 characters.');
              try {
                await submitAnswer(taskId, req, { kind: 'secret', value });
                input.value = '';
                markAnswered(card, req);
              } catch (e) {
                if (e.status !== 401) widgetError(card, e.message);
              }
            },
          }, planeIcon(18, 'currentColor'))),
        h('p', { class: 'meta' }, 'Sent through this app only — never as a plain message.'),
      );
      return card;
    }

    case 'text': {
      const multiline = params.multiline === true;
      const input = multiline
        ? h('textarea', {
            class: 'field',
            placeholder: typeof params.placeholder === 'string' ? params.placeholder : '',
            'aria-label': req.prompt,
          })
        : h('input', {
            class: 'field', type: 'text',
            placeholder: typeof params.placeholder === 'string' ? params.placeholder : '',
            'aria-label': req.prompt,
          });
      const card = h('div', { class: 'widget', dataset: { widgetKind: 'text' } },
        input,
        h('div', { class: 'act-row' },
          h('button', {
            class: 'act act-primary icon-btn', type: 'button',
            'aria-label': 'Send answer', title: 'Send answer',
            onclick: async () => {
              const value = input.value;
              if (!value.trim()) return widgetError(card, 'Enter a value first.');
              if (value.length > 4000) return widgetError(card, 'Message is too long — keep it under 4000 characters.');
              try {
                await submitAnswer(taskId, req, { kind: 'text', value });
                input.value = '';
                markAnswered(card, req);
              } catch (e) {
                if (e.status !== 401) widgetError(card, e.message);
              }
            },
          }, planeIcon(18, 'currentColor'))),
      );
      return card;
    }

    case 'choice': {
      const options = Array.isArray(params.options) ? params.options : [];
      if (options.length === 0) return invalidWidgetCard(kind);
      const card = h('div', { class: 'widget', role: 'radiogroup', 'aria-label': req.prompt, dataset: { widgetKind: 'choice' } });
      const sendBtn = h('button', {
        class: 'act act-primary icon-btn', type: 'button', disabled: true,
        'aria-label': 'Send answer', title: 'Send answer',
      }, planeIcon(18, 'currentColor'));
      const optionEls = options.map((opt) => {
        const dot = h('span', { class: 'option-dot' });
        const el = h('button', {
          class: 'option', type: 'button', role: 'radio', 'aria-checked': 'false',
          onclick: () => {
            state.choice.set(req.request_id, opt);
            for (const o of optionEls) {
              const checked = o.dataset.optValue === opt;
              o.setAttribute('aria-checked', checked ? 'true' : 'false');
              // Element.replaceChildren(null) stringifies the argument into a
              // literal "null" text node — DOM APIs called directly (not
              // through the h() helper, which filters falsy children) must
              // never receive null/undefined as an argument.
              const dot = o.querySelector('.option-dot');
              if (checked) dot.replaceChildren(h('span', { class: 'option-dot-fill' }));
              else dot.replaceChildren();
            }
            sendBtn.disabled = false;
          },
        }, dot, opt);
        el.dataset.optValue = opt;
        return el;
      });
      card.append(...optionEls, sendBtn);
      sendBtn.addEventListener('click', async () => {
        const value = state.choice.get(req.request_id);
        if (!value) return;
        try {
          await submitAnswer(taskId, req, { kind: 'choice', value });
          state.choice.delete(req.request_id);
          markAnswered(card, req);
        } catch (e) {
          if (e.status !== 401) widgetError(card, e.message);
        }
      });
      return card;
    }

    case 'confirm': {
      const card = h('div', { class: 'widget', dataset: { widgetKind: 'confirm' } },
        h('div', { class: 'act-row' },
          h('button', {
            class: 'act act-primary with-icon', type: 'button',
            'aria-label': 'Confirm', title: 'Confirm',
            onclick: async () => {
              try {
                await submitAnswer(taskId, req, { kind: 'confirm', confirmed: true });
                markAnswered(card, req);
              } catch (e) {
                if (e.status !== 401) widgetError(card, e.message);
              }
            },
          }, checkIcon(16, 'currentColor'), 'Confirm'),
          h('button', {
            class: 'act act-quiet with-icon', type: 'button',
            'aria-label': "Don't", title: "Don't",
            onclick: async () => {
              try {
                await submitAnswer(taskId, req, { kind: 'confirm', confirmed: false });
                markAnswered(card, req);
              } catch (e) {
                if (e.status !== 401) widgetError(card, e.message);
              }
            },
          }, crossIcon(16, 'currentColor'), "Don't")),
      );
      return card;
    }

    case 'oauth': {
      // auth_url arrives only after the backend mints it; until then the card
      // shows the preparing state and the 4 s poll picks the URL up.
      const authUrl = typeof params.auth_url === 'string' && params.auth_url.startsWith('https://')
        ? params.auth_url
        : null;
      const userCode = typeof params.user_code === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{3,15}$/.test(params.user_code)
        ? params.user_code
        : null;
      const card = h('div', { class: 'widget', dataset: { widgetKind: 'oauth' } },
        userCode ? h('p', { class: 'meta' }, 'Enter this code on the page that opens:') : false,
        userCode ? h('code', { class: 'user-code' }, userCode) : false,
        authUrl
          ? h('div', { class: 'act-row' },
              h('a', {
                class: 'act act-primary with-icon', href: authUrl, target: '_blank', rel: 'noopener',
                'aria-label': 'Continue with ' + providerLabel(params.provider),
                title: 'Continue with ' + providerLabel(params.provider),
                onclick: (ev) => { ev.preventDefault(); window.open(authUrl, '_blank', 'noopener'); },
              }, externalLinkIcon(16, 'currentColor'), 'Continue with ' + providerLabel(params.provider)))
          : h('p', { class: 'meta' }, 'Preparing the ' + providerLabel(params.provider) + ' link…'),
        params.confirmable === true
          ? h('div', { class: 'act-row' },
              h('button', {
                class: 'act act-quiet icon-btn', type: 'button',
                'aria-label': "I've finished", title: "I've finished",
                onclick: async () => {
                  try {
                    await submitAnswer(taskId, req, { kind: 'oauth', confirmed: true });
                    markAnswered(card, req);
                  } catch (e) {
                    if (e.status !== 401) widgetError(card, e.message);
                  }
                },
              }, checkIcon(18, 'currentColor')))
          : false,
        h('p', { class: 'meta' }, 'The task continues automatically once Google authorization completes.'),
      );
      return card;
    }

    case 'file': {
      const accept = Array.isArray(params.accept) && params.accept.length
        ? params.accept.join(',') : '';
      // Request-scoped cap only (vi-39ab14f84f14): when params.max_bytes is
      // absent there is no client-side size limit either — the server mirrors.
      const maxBytes = Number.isInteger(params.max_bytes) ? params.max_bytes : undefined;
      const picker = h('input', {
        class: 'field', type: 'file',
        accept: accept || undefined,
        'aria-label': req.prompt,
      });
      const card = h('div', { class: 'widget', dataset: { widgetKind: 'file' } },
        picker,
        h('div', { class: 'act-row' },
          h('button', {
            class: 'act act-primary icon-btn', type: 'button',
            'aria-label': 'Upload', title: 'Upload',
            onclick: async () => {
              const file = picker.files && picker.files[0];
              if (!file) return widgetError(card, 'Choose a file first.');
              const extOk = !Array.isArray(params.accept) || !params.accept.length ||
                params.accept.some((ext) => file.name.toLowerCase().endsWith(String(ext).toLowerCase()));
              if (!extOk) return widgetError(card, 'Allowed types: ' + params.accept.join(', '));
              if (maxBytes !== undefined && file.size > maxBytes) {
                return widgetError(card, 'File is larger than the ' + Math.round(maxBytes / 1048576) + ' MB limit.');
              }
              const fd = new FormData();
              fd.append('file', file, file.name);
              try {
                await api('/tasks/' + encodeURIComponent(taskId) +
                  '/inputs/' + encodeURIComponent(req.request_id), { method: 'POST', body: fd });
                picker.value = '';
                markAnswered(card, req);
              } catch (e) {
                if (e.status !== 401) widgetError(card, e.message);
              }
            },
          }, uploadIcon(18, 'currentColor'))),
        h('p', { class: 'meta' },
          (maxBytes !== undefined ? 'Up to ' + Math.round(maxBytes / 1048576) + ' MB' : 'No size limit')
            + (accept ? ' · ' + accept : '')),
      );
      return card;
    }

    case 'form': {
      const steps = Array.isArray(params.steps) ? params.steps : null;
      if (!steps || steps.length === 0) return invalidWidgetCard(kind);
      const answerable = steps.filter((s) => s && s.locked !== true);
      const draft = readFormDraft(req.request_id);
      const answers = {};      // stepId -> the effective answer (option label or free text)
      const freeText = {};     // stepId -> the escape-field element
      const optionEls = {};    // stepId -> the option row elements
      let progressEl = null;
      let submitBtn = null;

      const syncStep = (step, value) => {
        answers[step.id] = value;
        writeFormDraft(req.request_id, answers);
        renderProgress();
      };

      const renderProgress = () => {
        if (!progressEl) return;
        if (answerable.length === 0) {
          progressEl.replaceChildren(document.createTextNode(
            'All questions are already decided — review and submit.'));
          if (submitBtn) submitBtn.disabled = false;
          return;
        }
        const done = answerable.filter((s) => (answers[s.id] || '').length > 0).length;
        progressEl.replaceChildren(document.createTextNode(
          steps.length + ' questions · ' + done + ' of ' + answerable.length + ' answered'));
        if (submitBtn) submitBtn.disabled = done < answerable.length;
      };

      const card = h('div', { class: 'widget widget-form', dataset: { widgetKind: 'form' } });
      progressEl = h('p', { class: 'meta form-progress' });
      card.append(progressEl);

      steps.forEach((step, index) => {
        if (!step || typeof step.id !== 'string') return;
        const section = h('div', { class: 'form-step' });
        section.append(
          h('div', { class: 'form-step-head' },
            'Step ' + (index + 1) + ' of ' + steps.length + (step.locked === true ? ' · Decided' : '')),
          h('div', { class: 'form-step-title' }, String(step.title || '')),
          h('div', { class: 'form-step-decide' }, String(step.decide || '')));
        if (step.locked === true) {
          section.append(h('div', { class: 'form-step-locked' },
            checkIcon(14, 'currentColor'), ' ', String(step.answer || '')));
          answers[step.id] = String(step.answer || '');
          card.append(section);
          return;
        }
        const options = Array.isArray(step.options) ? step.options : [];
        const group = h('div', { class: 'form-options', role: 'radiogroup', 'aria-label': String(step.title || '') });
        optionEls[step.id] = [];
        options.forEach((opt) => {
          if (!opt || typeof opt.label !== 'string') return;
          const row = h('button', {
            class: 'option form-option', type: 'button', role: 'radio', 'aria-checked': 'false',
            onclick: () => {
              answers[step.id] = opt.label;
              for (const o of optionEls[step.id]) o.setAttribute('aria-checked', o === row ? 'true' : 'false');
              if (freeText[step.id]) freeText[step.id].value = '';
              syncStep(step, opt.label);
            },
          }, h('span', { class: 'option-dot' }),
             h('span', { class: 'form-option-text' },
               h('span', { class: 'form-option-label' }, opt.label),
               h('span', { class: 'form-option-note' }, String(opt.note || ''))));
          row.dataset.optValue = opt.label;
          optionEls[step.id].push(row);
          group.append(row);
        });
        section.append(group);
        const escape = h('input', {
          class: 'field form-escape', type: 'text',
          placeholder: 'Or type your own answer',
          'aria-label': String(step.title || '') + ' — own answer',
        });
        escape.addEventListener('input', () => {
          const text = escape.value.trim();
          if (text) {
            answers[step.id] = text;
            for (const o of optionEls[step.id]) o.setAttribute('aria-checked', 'false');
          } else {
            delete answers[step.id];
          }
          syncStep(step, answers[step.id] || '');
        });
        freeText[step.id] = escape;
        section.append(escape);
        card.append(section);
        // Preselection / draft restore — draft wins over params.preselected.
        const saved = draft[step.id];
        const pre = typeof saved === 'string' && saved ? saved : step.preselected;
        if (typeof pre === 'string') {
          const match = optionEls[step.id].find((o) => o.dataset.optValue === pre);
          if (match) {
            match.setAttribute('aria-checked', 'true');
            answers[step.id] = pre;
          } else if (saved) {
            escape.value = saved;
            answers[step.id] = saved;
          }
        }
      });

      submitBtn = h('button', {
        class: 'act act-primary form-submit', type: 'button', disabled: true,
        'aria-label': 'Submit answers', title: 'Submit answers',
        onclick: async () => {
          const payload = {};
          for (const step of answerable) {
            if (typeof answers[step.id] === 'string' && answers[step.id]) payload[step.id] = answers[step.id];
          }
          try {
            await submitAnswer(taskId, req, { kind: 'form', answers: payload });
            clearFormDraft(req.request_id);
            markAnswered(card, req);
          } catch (e) {
            if (e.status !== 401) widgetError(card, e.message);
          }
        },
      }, 'Submit answers');
      card.append(submitBtn);
      renderProgress();
      return card;
    }

    default:
      return invalidWidgetCard(kind);
  }
}

// ---------------------------------------------------------------------------
// Creating tasks (E17) — one helper, two entry points.
// ---------------------------------------------------------------------------

/**
 * The single create path. `continuesTaskId` names the conversation to join
 * (§3.2 takes any task id in it, and latest_task_id is the freshest routing).
 * `steer` rides along only for a live conversation — that is what makes a
 * follow-up mean "actually, do it this way" instead of "and also this".
 */
async function createTask({ text, blob, files, continuesTaskId, steer, feedbackAbout }) {
  // P6: the surface hint — which device class the operator ASKED from, read
  // once here because this is the only moment it is knowable. `<= 680` is the
  // CSS phone breakpoint (`@media (max-width: 680px)`), not a second number:
  // at exactly 680 the class and the media query must agree or the answer
  // flips layout on the device that asked for it. Sent UNCONDITIONALLY on both
  // body shapes (the server reads both), which is why not one of the seven
  // createTask call sites changed — the hint is a property of the app, not of
  // any particular caller.
  const surface = window.innerWidth <= 680 ? 'phone' : 'desktop';
  let body;
  if (blob || (files && files.length > 0)) {
    const fd = new FormData();
    if (blob) fd.append('audio', blob, 'task.webm');
    for (const f of files || []) fd.append('files', f, f.name);
    if (text) fd.append('text', text);
    if (continuesTaskId) fd.append('continues', continuesTaskId);
    if (steer) fd.append('steer', steer);
    if (feedbackAbout) fd.append('feedback_about', feedbackAbout);
    fd.append('surface', surface);
    body = await api('/tasks', { method: 'POST', body: fd });
  } else {
    const payload = { text };
    if (continuesTaskId) payload.continues = continuesTaskId;
    if (steer) payload.steer = steer;
    if (feedbackAbout) payload.feedback_about = feedbackAbout;
    payload.surface = surface;
    body = await api('/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  }
  return body;
}

/** A reply into a live conversation interrupts it; into a finished one it is
 *  an ordinary follow-up. The label the operator saw says which (E13). */
function replySteerMode(conv) {
  return conv && !isTerminal(conv.state) ? 'interrupt' : undefined;
}

async function submitCapturedTask(conv, blob, feedback, files = []) {
  // A voice feedback note is its own new conversation about something else —
  // never a reply into the target, never a steer (spec 2026-09-13 §2.5).
  if (feedback) {
    try {
      await createTask({ blob, files, feedbackAbout: feedback.about });
      showNotice('Feedback sent.');
    } catch (e) {
      if (e.status !== 401) showNotice('Could not send: ' + e.message);
    }
    return;
  }
  try {
    const body = await createTask({
      blob,
      files,
      continuesTaskId: conv ? conv.latest_task_id : undefined,
      steer: conv ? replySteerMode(conv) : undefined,
    });
    if (conv) {
      await refreshConversation();
      showNotice(replySteerMode(conv) === 'interrupt' ? 'Sent — interrupting the current run.' : 'Sent.');
    } else {
      state.awaitRoute = { taskId: body.task_id, startedAt: Date.now() };
      pollRoute();
    }
  } catch (e) {
    if (e.status !== 401) showNotice('Could not send: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Auto-navigate (E18, WP-5 §9, implemented exactly)
// ---------------------------------------------------------------------------

/**
 * WP-5 §9: after a recording is sent, wait for ROUTING to settle, then open
 * the conversation. Never navigate on the create response's conversation_id:
 * a plain new recording starts self-rooted and the routing worker may merge it
 * into an existing conversation with --continues. The conversation_id that
 * matters is the one on the task AFTER routing.
 */
async function pollRoute() {
  const pending = state.awaitRoute;
  if (!pending) return;
  if (Date.now() - pending.startedAt > ROUTE_WAIT_MS) {
    state.awaitRoute = null;
    showNotice('Still finding a home for that one — it stays at the top of your list until it is placed.');
    return;
  }
  let task;
  try {
    const body = await api('/tasks/' + encodeURIComponent(pending.taskId));
    task = body.task;
  } catch { return; } // transient; the next tick retries inside the 90 s cap
  if (!task || state.awaitRoute !== pending) return;
  if (task.state === 'received' || task.state === 'transcribing') return;
  state.awaitRoute = null;
  navigate('conversation', task.conversation_id);
}

// ---------------------------------------------------------------------------
// The recording hero (E19) — tap to record, tap again to stop and send.
// ---------------------------------------------------------------------------

const WAVE_STATIC = [14, 28, 40, 22, 36, 12, 26, 18, 32, 10];

let sheetEl = null;
let scrimEl = null;
let sheetTrigger = null;    // the element that opened the sheet — focus returns here on close (L6)
let sheetKeyHandler = null; // the document keydown installed while a sheet is up

/**
 * Sheet keyboard layer (L6): Escape closes (the recording sheet's Escape is
 * Discard — `stopCapture(true)` flows through finalizeCapture, which closes);
 * Tab cycles inside the sheet so focus can never drop to the page behind it.
 */
function onSheetKeyDown(ev) {
  if (!sheetEl) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    if (state.capture) stopCapture(true);
    else closeSheet();
    return;
  }
  if (ev.key === 'Tab') {
    const focusable = sheetEl.querySelectorAll(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }
}

/** Installs the sheet's keydown handler once the sheet is in the DOM. */
function armSheetKeyboard() {
  if (sheetKeyHandler) document.removeEventListener('keydown', sheetKeyHandler);
  sheetKeyHandler = onSheetKeyDown;
  document.addEventListener('keydown', sheetKeyHandler);
}
// One-shot flag set when a long-press/contextmenu fires, checked-and-cleared by
// the wired element's onclick so the release click never also navigates.
let suppressClickOnce = false;

/**
 * The fixed record footer. `conv` is null for the list/triage primary
 * recorder (large button, centred, keyboard-switch pinned left) or the open
 * conversation (small button, still centred, with stop (while running) + a
 * `More actions` overflow pinned right — attach/link/share live in the
 * overflow sheet).
 */
function recordFooter(conv) {
  if (!conv) {
    return h('div', { class: 'footer footer-menu' },
      h('div', { class: 'footer-left-group' },
        h('button', {
          class: 'linkish icon-btn', type: 'button',
          'aria-label': 'Type instead', title: 'Type instead',
          onclick: () => openTextSheet({}),
        }, keyboardIcon(18, 'currentColor'))),
      // (operator 2026-09-12: no visible caption beside the big mic — the
      // button stands alone; the accessible name stays on the button itself)
      h('div', { class: 'footer-centre' }, micButton('lg', null)),
      h('div', { class: 'footer-extras' },
        h('button', {
          class: 'linkish icon-btn', type: 'button',
          'aria-label': 'Attach photos or videos', title: 'Attach photos or videos',
          onclick: () => openTextSheet({ picker: 'media' }),
        }, imageIcon(18, 'currentColor')),
        h('button', {
          class: 'linkish icon-btn', type: 'button',
          'aria-label': 'Attach files', title: 'Attach files',
          onclick: () => openTextSheet({ picker: 'files' }),
        }, docIcon(18, 'currentColor'))));
  }
  // One compact row (operator 2026-09-10: the stacked footer covered the
  // answer text and could not be scrolled past). The state label moves into
  // the mic's accessible name; the Telegram link shortens to one word.
  const interrupt = !isTerminal(conv.state);
  const mic = micButton('sm', conv);
  const micLabel = interrupt ? 'Tap to interrupt with a new instruction' : 'Tap to reply into this conversation';
  mic.setAttribute('aria-label', micLabel);
  mic.setAttribute('title', micLabel);
  const kbButton = h('button', {
    class: 'linkish icon-btn', type: 'button',
    'aria-label': 'Type instead', title: 'Type instead',
    onclick: () => openTextSheet({ continuesTaskId: conv.latest_task_id, steer: replySteerMode(conv), conv }),
  }, keyboardIcon(18, 'currentColor'));
  // Two controls at most on the right: stop while running, then the
  // `More actions` overflow — attach/link/share live in the sheet
  // (operator 2026-09-15: five extras wrapped under the absolute mic).
  const extras = h('div', { class: 'footer-extras' },
    interrupt ? stopControl(conv) : null,
    moreActionsButton(conv));
  const row = h('div', { class: 'footer-row footer-compact-row footer-menu' },
    h('div', { class: 'footer-left-group' },
      kbButton),
    h('div', { class: 'footer-centre' }, mic),
    extras);
  return h('div', { class: 'footer footer-compact' }, row);
}

/**
 * The record control. `size` is 'lg' (primary, list/triage) or 'sm' (the
 * conversation reply row). `conv` is null for a fresh top-level recording, or
 * the open conversation for a reply/interrupt. A tap starts a recording; the
 * same control's semantic "stop and send" lives inside the sheet (E19 below),
 * because once the sheet is open it covers this button — the sheet's own stop
 * control is what the operator actually reaches next.
 *
 * The button carries the micMark glyph itself (operator 2026-09-13: the
 * click-to-speak control must read as a mic on BOTH footer surfaces — the old
 * solid-dot core read as "record" only where it was already familiar). One
 * glyph size for both buttons since both rings are 46px; same mark and
 * currentColor pattern as the "Record again" buttons, so every voice entry
 * point now shows the one mic.
 */
function micButton(size, conv) {
  const label = conv ? 'Tap to reply' : 'Tap to record';
  const btn = h('button', {
    class: 'mic-btn mic-btn-' + size, type: 'button',
    'aria-label': label, title: label,
  }, micMark(24, 'currentColor', 0));
  wireCaptureGesture(btn, conv);
  return btn;
}

/**
 * Tap to start. A plain `<button>` click fires once per tap for mouse, touch
 * and keyboard (Enter/Space) alike, so there is exactly one code path and no
 * custom pointer/keyboard handling. Stopping happens inside the sheet (E19),
 * never on this button — once the sheet is open it visually and functionally
 * replaces the footer's mic control until the recording ends.
 */
function wireCaptureGesture(btn, conv) {
  btn.addEventListener('click', () => {
    if (state.capture) return; // the sheet is already open and owns the stop
    beginCapture(conv);
  });
}

/** Used by the "Record again" buttons (E12/E13): starts a capture
 *  immediately, exactly like tapping the primary record control. */
function startReplyCapture(conv) {
  if (state.capture) return;
  beginCapture(conv);
}

function beginCapture(conv, feedback) {
  state.capture = {
    conv, feedback, stream: null, recorder: null, chunks: [], startedAt: 0,
    nudged: false, bytes: 0, done: false, userStop: false, discarded: false,
    wakeLock: null, tickTimer: null, wave: null,
  };
  openSheet(conv);
  startCapture(conv);
}

async function startCapture(conv) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    state.capture = null;
    closeSheet();
    showNotice('Voice capture is not supported in this browser.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    state.capture = null;
    closeSheet();
    showNotice('Microphone permission denied or unavailable.');
    return;
  }
  if (!state.capture) { // the hold ended (or was discarded) while permission was pending
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const chunks = [];
  // vi-9c17b02e9171 (2026-09-13): bitrate deliberately UNPINNED. The browser
  // default (~120 kbps measured) is speech-transparent and the operator
  // rejected the 32 kbps pin as quality loss; since vi-39ab14f84f14 there is
  // no size cap on the send path, and the size-aware nudge below is a plain
  // send-it reminder instead of a bitrate cut.
  const recorder = new MediaRecorder(stream);
  recorder.addEventListener('dataavailable', (ev) => {
    if (ev.data && ev.data.size) {
      chunks.push(ev.data);
      if (state.capture) state.capture.bytes += ev.data.size;
    }
  });
  // Unexpected-stop salvage (vi-9c17b02e9171): the OS can end the mic track
  // mid-speech (screen lock, call, another app taking the mic). Finalize on
  // the recorder's own stop/error and on track end, so whatever was captured
  // is delivered instead of silently dropped.
  recorder.addEventListener('stop', () => finalizeCapture());
  recorder.addEventListener('error', () => finalizeCapture());
  stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => {
    try { recorder.stop(); } catch { finalizeCapture(); }
  }));
  const startedAt = Date.now();
  const tickTimer = setInterval(() => updateSheetTimer(Date.now() - startedAt), 100);
  Object.assign(state.capture, { stream, recorder, chunks, startedAt, tickTimer });
  recorder.start(1000); // 1 s timeslice: chunks accumulate mid-recording and a partial capture survives
  startWaveform(stream);
  keepScreenAwake();
}

/**
 * Assemble and send (or drop) the finished capture. Runs EXACTLY ONCE per
 * recording, always through the recorder's stop/error events — whether the
 * stop came from the operator's tap (stopCapture sets userStop first) or
 * from the system ending the mic mid-speech. A system stop sends the partial
 * recording with an honest notice, so capture never silently vanishes
 * (vi-9c17b02e9171). A capture under MIN_CAPTURE_MS is always dropped — a
 * mis-tap is not a recording.
 */
function finalizeCapture() {
  const cap = state.capture;
  if (!cap || cap.done) return;
  cap.done = true;
  state.capture = null;
  clearInterval(cap.tickTimer);
  stopWaveform(cap);
  closeSheet();
  releaseWakeLock(cap);
  try { if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
  const elapsed = cap.startedAt ? Date.now() - cap.startedAt : 0;
  const tooShort = elapsed < MIN_CAPTURE_MS;
  if (cap.discarded || tooShort) {
    if (tooShort) showNotice('Too short — nothing was recorded.');
    return;
  }
  const blob = new Blob(cap.chunks, { type: (cap.recorder && cap.recorder.mimeType) || 'audio/webm' });
  if (blob.size <= 0) { showNotice('Recording came back empty — mic permission or a very short tap; try again.'); return; }
  if (!cap.userStop) {
    const secs = Math.floor(elapsed / 1000);
    showNotice('Recording was interrupted after ' + Math.floor(secs / 60) + ':'
      + String(secs % 60).padStart(2, '0') + ' — sending what was captured.');
  }
  submitCapturedTask(cap.conv, blob, cap.feedback, cap.staging ? cap.staging.files() : []);
}

/**
 * Operator stop: mark intent, then stop the recorder — its stop event runs
 * finalizeCapture. `discard` drops the partial recording instead of sending.
 */
function stopCapture(discard) {
  const cap = state.capture;
  if (!cap || cap.done) return;
  cap.discarded = !!discard;
  if (!cap.recorder) { // permission still pending — nothing captured yet
    cap.done = true;
    state.capture = null;
    clearInterval(cap.tickTimer);
    stopWaveform(cap);
    closeSheet();
    releaseWakeLock(cap);
    if (cap.stream) cap.stream.getTracks().forEach((t) => t.stop());
    return;
  }
  cap.userStop = true;
  try { cap.recorder.stop(); } catch { finalizeCapture(); }
}

/**
 * A screen wake lock while recording (vi-9c17b02e9171): the most common
 * mid-speech cutoff on a phone is the screen auto-locking while the operator
 * talks without touching the screen — the OS then suspends the page and ends
 * the mic. Keeping the screen awake keeps the recording alive. Unsupported
 * or denied lock is a silent no-op: recording still works without it.
 */
async function keepScreenAwake() {
  const cap = state.capture;
  if (!cap || !('wakeLock' in navigator)) return;
  // A sentinel the browser auto-released on hide stays truthy — treat it as
  // absent so the re-acquire path (applyVisibility) actually re-arms. Assign
  // first, then check done, so a finalize that ran during the await cannot
  // strand an unreleased sentinel on a dead cap (verifier findings 1+2).
  if (cap.wakeLock && !cap.wakeLock.released) return;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    cap.wakeLock = sentinel;
    if (cap.done) releaseWakeLock(cap);
  } catch { /* unsupported/denied */ }
}

function releaseWakeLock(cap) {
  if (cap && cap.wakeLock) {
    try { cap.wakeLock.release(); } catch { /* already released */ }
    cap.wakeLock = null;
  }
}

function buildWaveBars() {
  return WAVE_STATIC.map((px) => {
    const bar = h('div', { class: 'wave-bar' });
    bar.style.height = px + 'px';
    return bar;
  });
}

/**
 * The quoted target label every sheet header that names a conversation
 * shares (the recording sheet's reply "into" and the typed-input sheet's):
 * the canonical conversationLines title — set title, else the first sentence
 * of the answer, else the request text — capped at 40 characters, so a sheet
 * names its target exactly the way the list and the feedback sheet name it.
 */
function sheetTargetQuote(conv) {
  return '“' + String(conversationLines(conv).title).slice(0, 40) + '”';
}

/**
 * The recording sheet: the pill (context), the live waveform and pulse, the
 * elapsed timer, a stop-and-send control, and an explicit Discard button.
 * There is no gesture here — tapping the halo stops and sends; tapping
 * Discard drops the partial recording. Both are always visible, both are
 * plain buttons, and neither depends on how the operator got here (a fresh
 * tap or a "Record again" tap start the same way, see beginCapture).
 */
function openSheet(conv) {
  sheetTrigger = document.activeElement;
  const isReply = !!conv;
  // Attachments ride along on stop-and-send; staged while recording.
  const staging = state.capture ? (state.capture.staging = makeAttachmentStaging()) : null;
  // A feedback capture (opened via "Record instead" on the feedback sheet)
  // labels the sheet by its target instead of Reply/New conversation.
  const fb = state.capture && state.capture.feedback;
  const pillChildren = [h('span', { class: 'pill' },
    fb ? 'Feedback' : (isReply ? 'Reply' : 'New conversation'))];
  if (fb) {
    const snippet = String(fb.title || '').slice(0, 40);
    pillChildren.push(h('span', { class: 'sheet-secondary' }, 'about “' + snippet + '”'));
  } else if (isReply) {
    pillChildren.push(h('span', { class: 'sheet-secondary' }, 'into ' + sheetTargetQuote(conv)));
  }
  const stopButton = h('button', {
    class: 'halo-core', type: 'button', 'aria-label': 'Stop and send', title: 'Stop and send',
    onclick: () => { if (state.capture) stopCapture(false); },
  }, h('div', { class: 'halo-stop' }));
  const discardButton = h('button', {
    class: 'act act-quiet with-icon', type: 'button',
    'aria-label': 'Discard', title: 'Discard',
    onclick: () => { if (state.capture) stopCapture(true); },
  }, trashIcon(16, 'currentColor'), 'Discard');
  sheetEl = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Recording — tap to stop and send',
  },
    h('div', { class: 'pill-row' }, ...pillChildren),
    h('div', { class: 'wave', id: 'sheet-wave' }, buildWaveBars()),
    h('div', { class: 'halo-wrap' },
      h('div', { class: 'halo', id: 'sheet-halo' }),
      stopButton),
    h('div', { class: 'timer', id: 'sheet-timer' }, '0:00'),
    h('div', { class: 'sheet-labels' },
      h('div', { class: 'sheet-primary', id: 'sheet-nudge' }, 'Tap to stop and send'),
      h('div', { class: 'act-row' }, staging ? staging.mediaButton : null, staging ? staging.fileButton : null, discardButton)),
    staging ? staging.row : null);
  scrimEl = h('div', { class: 'scrim' });
  document.body.append(scrimEl, sheetEl);
  armSheetKeyboard();
  stopButton.focus();
}

function closeSheet() {
  if (scrimEl) scrimEl.remove();
  if (sheetEl) sheetEl.remove();
  scrimEl = null;
  sheetEl = null;
  if (sheetKeyHandler) {
    document.removeEventListener('keydown', sheetKeyHandler);
    sheetKeyHandler = null;
  }
  if (sheetTrigger) {
    const back = sheetTrigger;
    sheetTrigger = null;
    if (back.isConnected && typeof back.focus === 'function') back.focus();
  }
}

function updateSheetTimer(ms) {
  const el = document.getElementById('sheet-timer');
  if (!el) return;
  const totalSecs = Math.floor(ms / 1000);
  const mm = Math.floor(totalSecs / 60);
  const ss = totalSecs % 60;
  el.textContent = mm + ':' + String(ss).padStart(2, '0');
  // Time-or-size nudge (vi-ed1d56beebe1, re-tuned vi-9c17b02e9171): swap the
  // primary label once per recording — at 25 min, or at 20 MB captured when
  // the device's default bitrate accumulates faster than the clock. Nothing
  // is capped and nothing stops automatically (caps are opt-in server-side,
  // vi-39ab14f84f14); this is a plain send-it reminder.
  if (state.capture && !state.capture.nudged
    && (ms >= RECORDING_NUDGE_MS || state.capture.bytes >= RECORDING_NUDGE_BYTES)) {
    state.capture.nudged = true;
    const nudge = document.getElementById('sheet-nudge');
    if (nudge) nudge.textContent = state.capture.bytes >= RECORDING_NUDGE_BYTES
      ? 'Twenty MB captured — send whenever you\'re ready'
      : 'Twenty-five minutes — send whenever you\'re ready';
  }
}

/**
 * Ten bars driven by the live stream. A static waveform during a recording is
 * a lie, so this reads the real signal — and when anything about Web Audio
 * fails, or the operator asked for reduced motion, the bars hold the mockup's
 * fixed pattern rather than pretending.
 */
function startWaveform(stream) {
  const cap = state.capture;
  if (!cap) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return; // keep the static pattern
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bars = document.querySelectorAll('#sheet-wave .wave-bar');
    const tick = () => {
      if (state.capture !== cap) return;
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < bars.length && i < WAVE_BARS; i++) {
        bars[i].style.height = (4 + Math.round((data[i] / 255) * 40)) + 'px';
      }
      cap.wave.raf = requestAnimationFrame(tick);
    };
    cap.wave = { ctx, raf: requestAnimationFrame(tick) };
  } catch { /* keep the static pattern */ }
}

function stopWaveform(cap) {
  if (!cap || !cap.wave) return;
  if (cap.wave.raf) cancelAnimationFrame(cap.wave.raf);
  try { cap.wave.ctx.close(); } catch { /* already closed */ }
  cap.wave = null;
}

// ---------------------------------------------------------------------------
// The text path (E20)
// ---------------------------------------------------------------------------

/**
 * Long-press-to-give-feedback gesture wiring (spec 2026-09-13 §5.1.2): a 500 ms
 * pointerdown timer, cancelled by pointerup/pointercancel/pointermove beyond a
 * 10 px slop (so scrolling never fires it); contextmenu (the mobile
 * long-press/right-click path) preventDefaults and fires it directly. When the
 * gesture fires, `suppressClickOnce` makes the element's own onclick swallow
 * the release click so the press never also navigates.
 */
function wireFeedbackGestures(el, onOpen) {
  let startX = 0, startY = 0, timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    suppressClickOnce = false;                     // a fresh press re-arms the click
    if (e.pointerType === 'mouse' && e.button !== 0) return; // right-click: contextmenu owns it
    startX = e.clientX; startY = e.clientY;
    cancel();
    timer = setTimeout(() => { timer = null; suppressClickOnce = true; onOpen(); }, 500);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel(); // scroll never fires it
  });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    suppressClickOnce = true;                      // mobile long-press path
    onOpen();
  });
}

/**
 * Message-level feedback (2026-09-16): the visible per-turn flag, opening the
 * same sheet the list row's ⋯/long-press opens but with `about` = the task id
 * — POST /tasks + the route pipeline already resolve a task ref to task-level
 * framing briefed from the owning conversation. `variant === 'chip'` gives the
 * 44px icon-btn idiom for the answer's act-row beside Copy; the bare form is
 * the quiet 36px flag on .turn-said and collapsed .recap-item headers.
 * pointerdown is stopPropagation'd so a press on the flag can't also arm the
 * row's long-press timer; contextmenu is left to bubble — right-clicking the
 * flag opens the same sheet through the row's own handler. The sheet's title
 * names the message's own first words so the target is directly identified.
 */
function messageFeedbackButton(task, conv, variant) {
  return h('button', {
    class: variant === 'chip' ? 'linkish icon-btn' : 'turn-fb',
    type: 'button',
    'aria-label': 'Give feedback on this message',
    title: 'Give feedback on this message',
    onpointerdown: (e) => e.stopPropagation(),
    onclick: () => openFeedbackSheet({ about: task.task_id, title: turnText(task) }),
  }, flagIcon(16, 'currentColor'));
}

/**
 * The feedback capture sheet (spec 2026-09-13 §5.1.4): typed feedback about a
 * conversation or task, or "Record instead" to switch to the existing record
 * control flow. Sending creates a NEW conversation carrying `feedback_about` —
 * never a reply into the target — and the operator stays put (no awaitRoute,
 * no pollRoute).
 */
function openFeedbackSheet({ about, title }) {
  if (sheetEl) closeSheet();
  sheetTrigger = document.activeElement;
  const textarea = h('textarea', { class: 'field', 'aria-label': 'What is the feedback about?' });
  const staging = makeAttachmentStaging();
  const send = h('button', {
    class: 'act act-primary icon-btn', type: 'button',
    'aria-label': 'Send feedback', title: 'Send feedback',
  }, planeIcon(18, 'currentColor'));
  const cancel = h('button', {
    class: 'act act-quiet icon-btn', type: 'button',
    'aria-label': 'Cancel', title: 'Cancel',
  }, crossIcon(18, 'currentColor'));
  const record = h('button', {
    class: 'act act-quiet icon-btn', type: 'button',
    'aria-label': 'Record instead', title: 'Record instead',
    onclick: () => { closeSheet(); beginCapture(null, { about, title }); },
  }, micMark(18, 'currentColor', 0));
  scrimEl = h('div', { class: 'scrim' });
  const pillChildren = [h('span', { class: 'pill' }, 'Give feedback on this')];
  if (title) {
    pillChildren.push(h('span', { class: 'sheet-secondary' }, 'about “' + String(title).slice(0, 40) + '”'));
  }
  sheetEl = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-label': 'Send feedback',
  },
    h('div', { class: 'pill-row' }, ...pillChildren),
    textarea,
    staging.row,
    h('div', { class: 'act-row' }, staging.mediaButton, staging.fileButton, send, cancel, record));
  cancel.addEventListener('click', closeSheet);
  scrimEl.addEventListener('click', closeSheet);
  send.addEventListener('click', async () => {
    const value = textarea.value;
    const staged = staging.files();
    if (!value.trim() && staged.length === 0) return;
    closeSheet();
    try {
      await createTask({ text: value.trim() ? value : undefined, files: staged, feedbackAbout: about });
      showNotice('Feedback sent.');
    } catch (e) {
      if (e.status !== 401) showNotice('Could not send: ' + e.message);
    }
  });
  document.body.append(scrimEl, sheetEl);
  armSheetKeyboard();
  textarea.focus();
}

/**
 * The typed-input sheet, opened from "Type it"/"Type instead". `opts` mirrors
 * createTask's continuesTaskId/steer fields for a reply from a conversation;
 * `opts.conv` (the conversation object the call site already holds) labels
 * the header pill — "New conversation" bare, "Reply" plus the shared target
 * quote when sending continues a conversation.
 */
function openTextSheet(opts) {
  if (sheetEl) closeSheet();
  sheetTrigger = document.activeElement;
  const pillChildren = [h('span', { class: 'pill' }, opts.conv ? 'Reply' : 'New conversation')];
  if (opts.conv) {
    pillChildren.push(h('span', { class: 'sheet-secondary' }, 'into ' + sheetTargetQuote(opts.conv)));
  }
  const textarea = h('textarea', { class: 'field', 'aria-label': 'What do you need?' });
  // AI-234: a chip tap pre-fills the sheet with the chip label so the user
  // can edit before sending; the text becomes request_text like any typed
  // follow-up (no new submit route, no new payload field).
  if (opts.prefill) textarea.value = opts.prefill;
  const staging = makeAttachmentStaging();
  const send = h('button', {
    class: 'act act-primary icon-btn', type: 'button',
    'aria-label': 'Send', title: 'Send',
  }, planeIcon(18, 'currentColor'));
  const cancel = h('button', {
    class: 'act act-quiet icon-btn', type: 'button',
    'aria-label': 'Cancel', title: 'Cancel',
  }, crossIcon(18, 'currentColor'));
  scrimEl = h('div', { class: 'scrim' });
  sheetEl = h('div', {
    class: 'sheet', role: 'dialog', 'aria-modal': 'true',
    'aria-label': opts.conv ? 'Reply to this conversation' : 'Type a new request',
  },
    h('div', { class: 'pill-row' }, ...pillChildren),
    textarea,
    staging.row,
    h('div', { class: 'act-row' }, staging.mediaButton, staging.fileButton, send, cancel));
  cancel.addEventListener('click', closeSheet);
  scrimEl.addEventListener('click', closeSheet);
  send.addEventListener('click', async () => {
    const value = textarea.value;
    const staged = staging.files();
    if (!value.trim() && staged.length === 0) return;
    closeSheet();
    try {
      const body = await createTask({
        text: value.trim() ? value : undefined,
        files: staged,
        continuesTaskId: opts.continuesTaskId,
        steer: opts.steer,
      });
      if (opts.continuesTaskId) {
        await refreshConversation();
        showNotice(opts.steer === 'interrupt' ? 'Sent — interrupting the current run.' : 'Sent.');
      } else {
        state.awaitRoute = { taskId: body.task_id, startedAt: Date.now() };
        pollRoute();
      }
    } catch (e) {
      if (e.status !== 401) showNotice('Could not send: ' + e.message);
    }
  });
  document.body.append(scrimEl, sheetEl);
  textarea.focus();
  if (opts.prefill) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  // The footers' media/files buttons open this sheet with the picker already
  // up — called synchronously so it stays inside the same user-gesture task
  // (a deferred picker click is blocked by every browser).
  if (opts.picker === 'media') staging.openMediaPicker();
  else if (opts.picker === 'files') staging.openFilePicker();
}

// ---------------------------------------------------------------------------
// Polling and visibility (E21)
// ---------------------------------------------------------------------------

let pollTimer = null;
let eventSource = null;

/**
 * Live-update SSE (vi-6b1014ea197b): `changed` means inbox data moved (the
 * same signal the 4 s poll would eventually notice — this just makes it
 * near-instant); `reload` means the PWA shell itself changed on disk. POLL_MS
 * stays as-is: the resilience backstop for any intermediary that
 * blocks/buffers `text/event-stream` (this app is reached through a
 * Cloudflare relay/tunnel — see CLAUDE.md "Edge relay").
 */
function connectStream() {
  disconnectStream();
  const token = getToken();
  if (!token || document.hidden || !('EventSource' in window)) return;
  // The Cloudflare pull relay does not support persistent SSE streams; POLL_MS
  // handles polling for it. Only connect SSE on direct/local origins.
  if (window.location.hostname.endsWith('workers.dev')) return;
  try {
    eventSource = new EventSource(API + '/stream?token=' + encodeURIComponent(token) + '&shell=' + SHELL_VERSION);
    eventSource.addEventListener('changed', () => { pollTick().catch(() => {}); });
    eventSource.addEventListener('reload', () => { updateAndReload(); });
    eventSource.onerror = () => {
      // Intermediary closed or rejected the stream; disconnect so we don't
      // spam reconnects. POLL_MS remains the resilient fallback.
      disconnectStream();
    };
  } catch { /* unsupported/blocked — POLL_MS stays the fallback */ }
}

function disconnectStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

/**
 * A new shell is on disk (`reload` SSE event). Ask the service worker to
 * check for it, wait for the new one to take control (it calls
 * self.skipWaiting() + clients.claim() unconditionally — see sw.js), then
 * reload so this tab's in-memory app.js is replaced too. A short fallback
 * timer covers registrations with nothing new to install (e.g. this tab's SW
 * already matches) so the tab still refreshes rather than waiting forever.
 */
function updateAndReload() {
  if (!('serviceWorker' in navigator)) {
    window.location.reload();
    return;
  }
  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
  navigator.serviceWorker.getRegistration()
    .then((reg) => reg && reg.update())
    .catch(() => {});
  setTimeout(reloadOnce, 3000);
}

/**
 * The boot-armed complement to updateAndReload (vi-7790f35108f8): a service
 * worker that installs and claims mid-session fires controllerchange on this
 * page; without a listener the page keeps running pre-update code until its
 * next manual reload. Reload once — except mid-recording, where a reload
 * would destroy the capture; retry until it finalizes.
 */
let shellReloadDone = false;
function reloadForNewShell() {
  if (shellReloadDone) return;
  if (state.capture) {
    setTimeout(reloadForNewShell, 5000);
    return;
  }
  shellReloadDone = true;
  window.location.reload();
}

function startPolling() {
  stopPolling();
  if (document.hidden) return; // resume happens on visible
  pollTimer = setInterval(pollTick, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function pollTick() {
  if (state.awaitRoute) await pollRoute();
  if (state.view === 'conversation') await refreshConversation();
  else if (state.view === 'list' || state.view === 'triage') await refreshConversations();
}

function applyVisibility(hidden) {
  if (hidden) {
    // vi-9c17b02e9171: a recording NO LONGER stops (nor is discarded) when
    // the page hides — it runs until the operator stops it; if the OS kills
    // the mic anyway, finalizeCapture sends the partial.
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();  // read-aloud stops
    stopPolling();                                                     // polls pause while hidden
    pauseLiveWatch();                                                  // …and so does the live pane
    disconnectStream();                                                // …and so does the SSE channel
  } else if (getToken()) {
    startPolling();                                                    // resume + immediate refresh
    resumeLiveWatch();
    connectStream();
    if (state.capture) keepScreenAwake();                              // the OS drops the lock on hide
    if (state.view === 'conversation') refreshConversation().catch(() => {});
    else if (state.view === 'list' || state.view === 'triage') refreshConversations().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Login (E22)
// ---------------------------------------------------------------------------

function showLogin(message) {
  state.view = 'login';
  stopPolling();
  stopLiveWatch();
  disconnectStream();
  const codeInput = h('input', {
    class: 'field', id: 'pair-code', type: 'text',
    maxlength: '8', autocomplete: 'off', spellcheck: 'false',
    placeholder: '8-character code', 'aria-label': 'Pairing code',
  });
  const noticeEl = message ? h('div', { class: 'notice', 'aria-live': 'polite' }, message) : null;
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      const code = codeInput.value.trim();
      if (!code) return;
      // /pair/exchange is the one pre-auth endpoint: handled with raw fetch so
      // ANY failure code surfaces its error here instead of the 401 → login
      // redirect inside api().
      try {
        const res = await fetch(API + '/pair/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body && body.ok && body.session_token) {
          saveSession(body.session_token, body.tenant_id);
          history.replaceState({ v: 'list', id: null }, '');
          showList();
        } else {
          if (body && body.error) console.warn('Pairing error:', body.error);
          showLogin('That code did not work — it may be wrong, already used, or expired.');
        }
      } catch {
        showLogin('Could not reach the server — check your connection and try again.');
      }
    },
  },
    noticeEl,
    codeInput,
    h('div', { class: 'act-row' },
      h('button', { class: 'act act-primary', type: 'submit' }, 'Sign in')),
    h('p', { class: 'login-hint' },
      'Type /pair in your assistant chat to get a code. It works once and expires in 10 minutes.'),
  );
  viewRoot().replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'brand' },
      micMark(24, 'currentColor', 0, 'tone-accent'),
      h('p', { class: 'title' }, 'Voice Inbox')),
    h('p', { class: 'login-hint' }, 'Your personal assistant — speak or type what you need, and get answers back here.'),
    form));
  codeInput.focus();
}

// ---------------------------------------------------------------------------
// Boot (E23)
// ---------------------------------------------------------------------------

async function boot() {
  const root = viewRoot();
  if (root) root.className = 'view-root';

  window.addEventListener('popstate', (ev) => {
    renderView((ev.state && ev.state.v) || 'list', (ev.state && ev.state.id) || null);
  });
  document.addEventListener('visibilitychange', () => applyVisibility(document.hidden));
  // Rows never reshuffle under the operator's finger (listRenderHeld).
  window.addEventListener('touchstart', markListInteraction, { passive: true });
  window.addEventListener('wheel', markListInteraction, { passive: true });
  window.addEventListener('scroll', onListScroll, { passive: true });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* non-secure context */ });
    // vi-7790f35108f8: a shell update that installs while this page runs must
    // not strand the page on pre-update code (the operator then sees newly
    // shipped widget kinds as unsupported-type cards). sw.js always
    // skipWaiting()s and claims, so controllerchange means a new shell took
    // over — reload once, deferred while a recording is in flight.
    navigator.serviceWorker.addEventListener('controllerchange', reloadForNewShell);
  }
  if (!getToken()) {
    showLogin();
    return;
  }
  try {
    await api('/me');
    history.replaceState({ v: 'list', id: null }, '');
    showList();
    connectStream();
    if (notificationsOn()) subscribeWebPush(); // fire-and-forget — never blocks startup
  } catch (e) {
    // 401 already routed to the login view; any other failure (server down)
    // must not leave a blank page either.
    if (!e || e.status !== 401) {
      showLogin('Could not reach the server — check your connection and try again.');
    }
  }
}

boot();
