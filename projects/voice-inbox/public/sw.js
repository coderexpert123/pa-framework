/**
 * Voice Inbox service worker (AI-201 WP-E, spec §9).
 *
 * Cache policy, pinned by the spec: versioned cache name, skipWaiting,
 * cache-first for the static shell, network-only for /api/*.
 */

// Bump the version whenever the shell files change so clients pick up the new
// shell on their next load. v39: AI-230 nested step-reason toggles in app.js
// (rides above t-235-spacing's uncommitted v38 bump so installed clients that
// already cached v38 re-fetch the shell with the toggles).
// v40: feedback long-press, ellipsis button, feedback sheet (app.js, styles.css).
// v41: both footer record buttons carry the mic glyph (app.js, styles.css);
// rides above the uncommitted v40 bump above so installed clients re-fetch.
// v43: list status model v2 — five sections (Action needed/Ready/In
// progress/Viewed/Done), ready cue ring + viewed phase (app.js, styles.css);
// installed clients re-fetch the changed shell.
// v44: no 2-min recording cap; 32 kbps capture; 25 MB pre-send check; 30-min send nudge (app.js).
// v45: tiered answer card + long-URL overflow-wrap fix (answer-shapes.js,
// app.js, styles.css); installed clients re-fetch the changed shell.
// v46: quality restored — capture bitrate unpinned (browser default, ~120 kbps);
// recorder survives backgrounding; unexpected-stop salvage sends the partial;
// screen wake lock while recording; nudge at 25 min or 20 MB (app.js).
// v47: task attachments — paperclip in both footers + all three sheets, staged-file chips, per-turn attachment chips with image overlay (app.js, styles.css, index.html CSP img-src blob:).
// v48: InShort two uncapped versions — stored result_short lead, cap-free fallback lead (answer-shapes.js, app.js).
// v50: typed-input sheet gains the context pill header ("New conversation" /
// "Reply" + target label) and the recording sheet's reply label now uses the
// canonical conversation title (app.js only); rides above the uncommitted
// v49 uncapped-create bump so installed clients re-fetch the shell.
// v51: status-model design built (vi-84aa5bf5085e) — "In progress" retired
// for Running (substate: Planning/Building/Verifying from workers'
// task.progress step tags; the default 'started' checkpoint is not shown)
// above its own Waiting block (substate: Recorded/Transcribing/Routed);
// conversation header shows "State · Substate";
// approval widget for the design closed (app.js only).
// v52: uncapped-create residue — the recording nudge's 25 MB send-limit
// framing is gone (no cap by default, vi-39ab14f84f14); the nudge stays as a
// plain send-it reminder (app.js only).
// v53: vi-19787afc4b2e design build, client half — Done block capped at 10
// with Show more (+10) and an Older-conversations paginated view (20/page);
// book-icon knowledge-base view (collapsible cards over GET /api/v1/kb);
// share is now a bottom sheet (Web Share API Share action, Copy link with
// check feedback, mint-on-open, Stop sharing) replacing the inline panel
// (app.js, styles.css).
// v54: form widget kind — one-sheet questionnaire card with per-step options, notes, free-text escape, draft persistence and a single Submit (app.js, styles.css).
// v55: stale-shell recovery (vi-7790f35108f8) — SSE shell-version handshake
// with a server-side replay of missed reloads, boot-time controllerchange
// reload, and a Refresh action on the unsupported-type fallback card
// (app.js, server.ts, event-stream.ts).
// v56: raw-html answer shape — the free-form lane; a :::raw-html fenced block
// in an answer renders in a sandboxed iframe (app.js, answer-shapes.js,
// styles.css).
// v57: raw-html frames made interactive — the frame document is served by
// GET /frames/raw under the route's own inline-only CSP response header
// (a srcdoc frame could only inherit the shell CSP, so styles/scripts stayed
// inert), and the SW passes frame fetches straight to the network (app.js,
// answer-shapes.js, sw.js, server.ts, frame-route.ts).
// v59: notification body preview cap (vi-77c9ccd3865e) — every notification,
// in-app or push-delivered, shows a short word-boundary preview with an
// ellipsis instead of the full text (app.js, sw.js; the pa dispatcher's own
// copy lives in pa/src/lib/web-push.ts).
// v60: AI-246 live-view pane — a task streaming its browser screen shows it
// in the open conversation (app.js, styles.css).
// v61: AI-246 v2 live take-over — responsive pane fit plus fullscreen remote
// control (tap/scroll/pinch/type/key/nav) gated to fullscreen only
// (app.js, styles.css); the same shell also carries the design-audit pass —
// Telegram refs removed, share page structured rendering + plain labels +
// social meta + noscript, loading states, offline detection, sheet
// accessibility, backBar label split, manifest theme_color fix, plain error
// messages, first-run explanation, status subtitles, widget framing,
// WCAG AA contrast, ARIA live regions, focus management, touch targets,
// skip link (app.js, share.js, share.html, index.html, styles.css,
// manifest.webmanifest).
// v62: design-audit follow-up — row-ready padding, footer relayout with
// true-center mic, separate media/files attachment buttons in all footers
// and sheets, KB view padding + font fix, aria-live on notice slots and
// system body, attachment overlay dialog semantics (app.js, styles.css).
// v63: AI-246 v3 — local view-zoom on the live pane (pinch/double-tap zoom
// the IMAGE, not the remote page) + modularization: the pane subsystem
// moved out of app.js into live-pane.js (index.html, app.js, styles.css,
// live-pane.js).
// v64: answer presentation P0 — table cells carry data-label + inline
// markdown, and tables collapse to "Label: value" cards under 680px
// (app.js, styles.css).
// v65: P1 structured-data presentation layer dispatch (app.js).
// v66: concurrent share-surface wave + hardened structured fallback (app.js,
// share.js, share.html, manifest.webmanifest).
// v67: AI-234 chips fix — suggested_items is a TEXT column; the PWA now parses
// it (suggestedItemLabels) instead of testing the raw string with Array.isArray,
// so the quick-reply chips actually render (app.js).
// v68: answer presentation P2 — the comparison renderer: item cards (swipe row
// under 680px, grid above), per-item action controls, and the structured tiered
// card (app.js, styles.css).
// v69: archive + search + header-free list + footer fix — "All conversations"
// archive with server-side ?q= search, header-free list groups, finished pile,
// stateWord 'Finished', footer extras collapse to stop+More sheet (app.js, styles.css).
// v70: answer presentation P3 — the action controls wired: task (a new task
// carrying feedback_about), save (vi.saved bookmarks, toggling), share
// (navigator.share; the control is dropped where it is absent) (app.js).
// v71: P3 deep-recheck hardening — comparison attribute rows read own
// properties only (a prototype-named key like 'toString' no longer leaks
// Object.prototype source into sibling cards) and attributes must be a
// plain object (an array no longer renders index-number rows) (app.js).
// v72: P3 deep-recheck hardening — a `link` action's url must be http(s)
// before it becomes an href (the markdown renderer's own scheme rule);
// javascript:/data: urls render no control (app.js).
// v73: P3 deep-recheck — list classification tries line-start dash items
// BEFORE the enumerator route (t-311/D2): a bold-label lead above dash items
// ending in sentence punctuation no longer folds the label and item 1 into
// the lead with a literal `- ` left inside. The recap snippet now reads the
// same structure (plainAnswerSnippet) instead of a raw whitespace fold
// (answer-shapes.js, app.js).
// v74: P3 deep-recheck — the failed-state toast flattens result_summary
// through plainAnswerSnippet (markers no longer leak into the notification;
// never firstSentence — its ':'-clamp would truncate "quota exceeded: 429")
// (app.js).
// v75: answer presentation P4 — interactive form-sets: one step per screen
// inside the answer card, tap-tap options, branching, drafts, three submit
// modes (app.js, styles.css, task_complete.py).
// v76: answer presentation P5 — dedicated views for the last three
// structured types: listing rows, the checkable guide (vi.guide.done on
// the generalized name-store) and summary section cards (app.js,
// styles.css, task_complete.py).
// v77: P5 recheck pass-1 — the guide check's toggle repaints every step's
// state from the store (a repeated step name used to leave its twin
// checked-looking while the head counted it once); head now counts
// painted steps (app.js).
// v78: P5 recheck pass-2 — guide step bullets render through renderLines
// like summary points, so a URL inside a step stays a link (app.js).
// v79: P5 recheck pass-3 — a summary section's attributes printed twice
// (once as the itemDetailLine lead, once as the dl): itemLeadLine is the
// prose-only lead; itemDetailLine's attrs join stays the fallback for
// views with no dl (app.js).
// v80: answer-shapes LINE_DASH_ITEM_RE renamed ANSWER_LINE_DASH_ITEM_RE —
// a module-global regex with the same name silently clashed (44c6395)
// (answer-shapes.js).
// v81: desktop footer fix — the ≥681px .footer box needed width:100%
// inside its max-width:680px column; with right:auto it shrink-wrapped
// to ~208px of content and the absolutely-centred mic covered the stop
// button entirely (elementFromPoint = mic at every stop pixel). Found by
// the visual browser pass (styles.css).
// v82: answer presentation P6 — device awareness: POST /tasks carries a
// `surface` hint (phone|desktop, the creating viewport at <= 680px), stored
// on the task row at schema v13, and the comparison container starts in that
// device's layout (cmp-phone / cmp-desktop). The 680px media query still
// takes a desktop grid away on a narrow screen, and a task with no surface
// renders exactly as before (app.js, styles.css, ledger.ts, routes.ts).
// v83: answer presentation action buttons — .cmp-act action controls (link,
// call, task, save, share) get an accent border/text so they read as
// clickable on --raised cards instead of plain bold text (operator report
// 2026-09-16). Compound .act.cmp-act selectors beat the later .act/
// .act-quiet rules on specificity (styles.css).
// v84: light and dark themes — the app follows the device's light/dark setting
// in CSS alone (two token blocks in styles.css, no toggle). Icons draw with
// currentColor plus tone classes and the section-chip flash is a class, so an
// OS flip repaints an open page; scheme-aware color-scheme and theme-color
// metas; manifest colours follow the new dark ground (styles.css, app.js,
// share.js, index.html, share.html, manifest.webmanifest).
// v86: one feedback glyph everywhere — the list row's ⋯ affordance now draws
// the same flagIcon as the per-turn and act-row flags, so the feedback mark
// is uniform across list and conversation surfaces (app.js, styles.css).
// v87: cleaned request_text over the raw transcript — a voice turn shows the
// routing worker's tidied request, with the raw words one tap away behind a
// "Your exact words" disclosure when the two differ (app.js, styles.css).
// v88: thread lifecycle — the list shows the server's thread status in two
// bands (live, history) with four tones, Recent | Older conversations, Failed
// rows with Retry and Cancel plus a bulk bar, a view time recorded on the
// server instead of per-device read marks (uploaded once), and no reshuffle
// under the finger (app.js, styles.css).
// v89: notification fixes (operator report 2026-09-17) — a real monochrome
// badge icon (badge-96.png; Android's status-bar glyph needs alpha-only, and
// a colour icon was rendering as the Chrome fallback), renotify:false so a
// replaced 'pa-attention' notification never re-alerts, and the archive
// view's duplicated title block removed (app.js, sw.js, icons/badge-96.png).
// v90: the default 'started' worker checkpoint no longer surfaces as a
// Running substate — a running row reads plain 'Running' until a substantive
// phase (Planning/Building/Verifying) arrives (app.js only).
// v91: list rows — long-press opens a per-row actions sheet (Give feedback,
// Stop/Retry/Cancel, Select) instead of jumping straight to feedback; any-row
// multi-select entered from a row or the Failed bar, tapping a row toggles it
// (violet ring/glow), the bulk bar gates Retry/Cancel on the selection, and
// the feedback sheet + message flag reworded (app.js, styles.css only).
const SHELL_CACHE = 'voice-inbox-shell-v94';

const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './answer-shapes.js',
  './live-pane.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/badge-96.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // API writes always go to the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-only for /api/* — telemetry and answers are never served from cache.
  if (url.pathname.startsWith('/api/')) return;

  // Network-only for raw-html frames (v57): per-response server documents
  // with their own CSP header — never cached under their payload URL, never
  // the offline shell fallback (a navigate-mode miss would otherwise render
  // index.html INSIDE the sandboxed frame).
  if (url.pathname === '/frames/raw') return;

  // Cache-first for the static shell.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      const fetched = fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      });
      // Navigation requests fall back to the cached shell when offline.
      if (req.mode === 'navigate') {
        return fetched.catch(() =>
          caches.match('./index.html').then((shell) => shell || Response.error())
        );
      }
      return fetched;
    })
  );
});

// Notification body preview cap (vi-77c9ccd3865e) — mirrors src/contracts.ts
// NOTIF_BODY_MAX, the app.js showNotif copy, and the pa dispatcher's copy in
// pa/src/lib/web-push.ts. Catch-all: whatever the server sent still renders
// as a preview.
const NOTIF_BODY_MAX = 140;

function clipNotifBody(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > NOTIF_BODY_MAX
    ? t.slice(0, NOTIF_BODY_MAX - 1).replace(/\s+\S*$/, '') + '…'
    : t;
}

// A push from the server (delivered even with no tab open) surfaces as an OS
// notification — except while the operator is already looking at the app: a
// visible window gets the row update live, and an OS notification over it
// reads as spam (2026-09-17). Payload is JSON when the server can encrypt it
// that way; plain text is a fallback so a malformed/unencrypted payload
// still shows something instead of throwing.
self.addEventListener('push', (event) => {
  let data = { title: 'Personal Assistant', body: 'New notification' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'Personal Assistant', body: event.data.text() };
    }
  }
  const title = data.title || 'Personal Assistant';
  const options = {
    body: clipNotifBody(data.body || ''),
    icon: data.icon || './icons/icon-192.png',
    // Android's status-bar badge is rendered alpha-only — the colour launcher
    // icon painted as a solid block, so Chrome's own badge showed instead.
    badge: data.badge || './icons/badge-96.png',
    tag: data.tag || 'pa-attention',
    // Same-tag pushes replace the one notification; never re-sound/re-vibrate
    // a replacement (the operator flagged repeated pings as spam).
    renotify: false,
    data: data.data || {},
  };
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const visible = clientList.some((c) => c.visibilityState === 'visible');
        if (visible) return;
        return self.registration.showNotification(title, options);
      })
  );
});

// A tap on one of the app's notifications brings the app forward: an existing
// window on this origin is focused (and navigated to the notification's
// target url, when given); with none open, a fresh one opens at that url.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            return client.focus().then((focused) => {
              try {
                if (focused && 'navigate' in focused) return focused.navigate(targetUrl);
              } catch { /* navigate unsupported or failed — focus already happened */ }
              return focused;
            });
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
