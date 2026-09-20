#!/usr/bin/env node
/**
 * Live screencast bridge (AI-246 WP-C) — the zero-dep sidecar a WORKER spawns
 * when the operator should watch the headed Chrome a browser-session dispatch
 * is driving:
 *
 *   node scripts/screencast_bridge.mjs --task <vi-id>
 *     [--cdp-port <p>] [--vi-port <p>] [--quality 60]
 *     [--max-width 1024] [--max-height 768] [--fps 10] [--target-id <id>]
 *
 * It opens a WebSocket to a Chrome DevTools Protocol page target, starts
 * Page.startScreencast (jpeg), and POSTs each kept frame to the voice-inbox
 * ingest endpoint:
 *
 *   POST http://127.0.0.1:<vi-port>/api/v1/live/<task>/frame
 *     Authorization: Bearer $PA_SCREENCAST_INGEST_TOKEN
 *     content-type: image/jpeg — body = raw JPEG bytes
 *
 * It also long-polls the input endpoint and injects each queued operator
 * command over the SAME CDP socket (Input/Page/Runtime methods, ids >= 100;
 * touch emulation is enabled first so taps surface as touch events):
 *
 *   GET http://127.0.0.1:<vi-port>/api/v1/live/<task>/input?since=<seq>
 *     Authorization: Bearer $PA_SCREENCAST_INGEST_TOKEN
 *
 * A 404/503 means the server has no input endpoint — the loop exits quietly
 * and screencast continues; a 401 is fatal (bad token).
 *
 * Env: PA_BROWSER_CDP_PORT (default 9222, else config.yaml cdp_port),
 * VOICE_INBOX_PORT (default 8787 — env-only, a bare `port:` key is
 * ambiguous in config), PA_SCREENCAST_INGEST_TOKEN (REQUIRED — PA injects
 * it into browser-session dispatches; when the env is absent the bridge
 * falls back to screencast_ingest_token in ~/.pa/config.yaml).
 *
 * Frames are sensitive by design: decoded, throttled (DROPPED past --fps,
 * never queued), POSTed, forgotten — nothing is ever written to disk.
 * SIGINT/SIGTERM sends Page.stopScreencast, closes the socket, best-effort
 * DELETEs the live entry, and exits 0. A fatal error prints one
 * {"ok":false,"error":...} JSON line to stderr, best-effort DELETEs, exit 1.
 * Zero npm deps — Node 22 global WebSocket + fetch + Buffer only.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE =
  'usage: screencast_bridge.mjs --task <vi-id> [--cdp-port N] [--vi-port N] ' +
  '[--quality 60] [--max-width 1024] [--max-height 768] [--fps 10] [--target-id <id>]';

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function pickNumber(argVal, envVal, dflt, name, integer) {
  const raw = argVal !== undefined && argVal !== true ? argVal : envVal !== undefined ? envVal : dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} (got "${raw}")`);
  }
  return n;
}

// Config fallback (AI-246 v4 WP-C): a task-lane worker does not get the
// bridge env injected by `pa run`, so when an env var is absent the bridge
// flat-scans $PA_HOME/config.yaml (or ~/.pa/config.yaml) for the documented
// keys. Raw string scan, no YAML parser — `screencast_ingest_token` and
// `cdp_port` are unique keys anywhere in the file, so a line matching
// `<key>:` (any indentation, inside any block) is unambiguous. A bare
// `port:` is NOT unique (spec S4), so the VI port is never looked up here.
// The config is operator-owned YAML; values are hex strings or integers.
// Any failure — missing file, missing key, unreadable file — returns
// undefined and the caller falls through to its default or the fatal.
export function readConfigKey(key, env = process.env) {
  const paHome = env.PA_HOME || join(homedir(), '.pa');
  let text;
  try {
    text = readFileSync(join(paHome, 'config.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const m = text.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1] : undefined;
}

export function resolveConfig(args, env = process.env) {
  const task = typeof args.task === 'string' && args.task.length > 0 ? args.task : null;
  if (!task) throw new Error(`--task is required. ${USAGE}`);
  const token = env.PA_SCREENCAST_INGEST_TOKEN ?? readConfigKey('screencast_ingest_token', env);
  if (!token) {
    throw new Error(
      'PA_SCREENCAST_INGEST_TOKEN is not set and ~/.pa/config.yaml has no ' +
        'screencast_ingest_token — PA injects the env into browser-session ' +
        'dispatches and the bridge falls back to the config key; without ' +
        'either, the ingest endpoint refuses every frame.'
    );
  }
  const cdpPort = pickNumber(
    args['cdp-port'],
    env.PA_BROWSER_CDP_PORT ?? readConfigKey('cdp_port', env),
    9222,
    '--cdp-port',
    true
  );
  const viPort = pickNumber(args['vi-port'], env.VOICE_INBOX_PORT, 8787, '--vi-port', true);
  for (const [name, p] of [['--cdp-port', cdpPort], ['--vi-port', viPort]]) {
    if (p < 1 || p > 65535) throw new Error(`${name} must be 1..65535 (got ${p})`);
  }
  const quality = pickNumber(args.quality, undefined, 60, '--quality', true);
  if (quality < 0 || quality > 100) throw new Error(`--quality must be 0..100 (got ${quality})`);
  const maxWidth = pickNumber(args['max-width'], undefined, 1024, '--max-width', true);
  const maxHeight = pickNumber(args['max-height'], undefined, 768, '--max-height', true);
  if (maxWidth < 1 || maxHeight < 1) throw new Error('--max-width/--max-height must be positive');
  const fps = pickNumber(args.fps, undefined, 10, '--fps', false);
  if (!(fps > 0)) throw new Error(`--fps must be > 0 (got ${args.fps})`);
  return {
    task,
    token,
    cdpPort,
    viPort,
    quality,
    maxWidth,
    maxHeight,
    fps,
    targetId: typeof args['target-id'] === 'string' ? args['target-id'] : undefined,
  };
}

// CDP /json lists page targets in recency order, so the first type:"page" is
// the most recently active tab.
export function pickTarget(targets, targetId) {
  if (!Array.isArray(targets)) throw new Error('CDP /json did not return a target list');
  const target = targetId
    ? targets.find((t) => t && t.id === targetId)
    : targets.find((t) => t && t.type === 'page');
  if (!target) {
    throw new Error(
      targetId
        ? `no CDP target with id "${targetId}" (${targets.length} targets listed)`
        : 'no page target on the CDP endpoint — is a tab open?'
    );
  }
  if (typeof target.webSocketDebuggerUrl !== 'string' || !target.webSocketDebuggerUrl) {
    throw new Error(
      `CDP target ${target.id || '(no id)'} has no webSocketDebuggerUrl — ` +
        'a debugger may already be attached'
    );
  }
  return target;
}

// Throttle by DROPPING: a frame is kept only when at least 1/fps has elapsed
// since the last POST attempt. lastPostAtMs=0 (never posted) always keeps.
export function shouldSendFrame(lastPostAtMs, nowMs, fps) {
  return nowMs - lastPostAtMs >= 1000 / fps;
}

// Keepalive decision (AI-246 follow-up): while the stream is starved (no
// screencastFrame for longer than thresholdMs — static page or occluded
// window) re-POST the last kept frame so the store TTL never evicts the
// pane; when NO frame has ever arrived (occluded at launch) take a
// Page.captureScreenshot instead to seed it. A non-open socket means the
// bridge is dying — the zombie-WS guard owns that exit, so do nothing here.
export function shouldKeepalive(lastFrameAtMs, nowMs, thresholdMs, hasLastFrame, wsOpen) {
  if (!wsOpen) return 'none';
  if (nowMs - lastFrameAtMs <= thresholdMs) return 'none';
  return hasLastFrame ? 'repost' : 'screenshot';
}

export function decodeFrameData(data) {
  return Buffer.from(String(data ?? ''), 'base64');
}

// The ack carries no id — Chrome stops sending frames entirely if an ack is
// missed, so this goes out for EVERY screencastFrame, kept or dropped.
export function screencastAckMessage(sessionId) {
  return { method: 'Page.screencastFrameAck', params: { sessionId } };
}

export function startScreencastMessage(id, { quality, maxWidth, maxHeight }) {
  return {
    id,
    method: 'Page.startScreencast',
    params: { format: 'jpeg', quality, maxWidth, maxHeight },
  };
}

export function frameUrl(cfg) {
  return `http://127.0.0.1:${cfg.viPort}/api/v1/live/${encodeURIComponent(cfg.task)}/frame`;
}

export function liveUrl(cfg) {
  return `http://127.0.0.1:${cfg.viPort}/api/v1/live/${encodeURIComponent(cfg.task)}`;
}

// Touch emulation makes Input.dispatchMouseEvent taps surface as touch events
// on the page (mobile-faithful control). ids 4/5 — errors are NON-fatal
// (older Chrome lacks these methods) and only get logged.
export function emulationEnableMessages() {
  return [
    {
      id: 4,
      method: 'Emulation.setTouchEmulationEnabled',
      params: { enabled: true, configuration: 'mobile' },
    },
    {
      id: 5,
      method: 'Emulation.setEmitTouchEventsForMouse',
      params: { enabled: true },
    },
  ];
}

export function inputPollUrl(cfg, since) {
  return `http://127.0.0.1:${cfg.viPort}/api/v1/live/${encodeURIComponent(cfg.task)}/input?since=${since}`;
}

// body may be raw JSON text, an already-parsed object, or empty (204 / no
// body). Anything unreadable degrades to "nothing new" — never throws.
export function parseInputPollResponse(body, since = 0) {
  const empty = { cmds: [], maxSeq: since };
  if (body === null || body === undefined || body === '') return empty;
  let obj = body;
  if (typeof body === 'string') {
    try {
      obj = JSON.parse(body);
    } catch {
      return empty;
    }
  }
  if (!obj || typeof obj !== 'object') return empty;
  const cmds = Array.isArray(obj.cmds) ? obj.cmds : [];
  if (Number.isFinite(obj.maxSeq)) return { cmds, maxSeq: obj.maxSeq };
  let maxSeq = since;
  for (const c of cmds) {
    if (c && Number.isFinite(c.seq) && c.seq > maxSeq) maxSeq = c.seq;
  }
  return { cmds, maxSeq };
}

const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

// CDP takes modifiers as a bitmask (Alt=1 Ctrl=2 Meta=4 Shift=8); the wire
// schema sends a name list.
function modifierBits(mods) {
  if (Number.isFinite(mods)) return mods;
  if (!Array.isArray(mods)) return 0;
  let bits = 0;
  for (const m of mods) bits |= MODIFIER_BITS[String(m).toLowerCase()] || 0;
  return bits;
}

// Maps one queued operator command to the CDP wire messages that inject it.
// ids are handed out sequentially from idStart (main uses 100+; 1-5 are
// screencast/emulation). `awaits` lists the {id, method} responses the sender
// should wait for; an entry may carry sleepAfterMs — sleep that long AFTER
// its response arrives (longpress holds the press before the release).
// Unknown command shapes map to nothing — the caller logs and skips them.
export function injectCommandMessages(cmd, idStart) {
  const empty = { messages: [], awaits: [] };
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return empty;
  let id = idStart;
  const msg = (method, params) => ({ id: id++, method, params });
  const single = (method, params) => {
    const m = msg(method, params);
    return { messages: [m], awaits: [{ id: m.id, method }] };
  };
  // AI-246: Input.dispatchMouseEvent hangs on Chrome 151 when the browser
  // window is backgrounded (the operator's normal case — PWA in the
  // foreground, Chrome behind it). Input.emulateTouchFromMouseEvent is
  // synthetic and does not require a foreground window, so it works
  // reliably in the backgrounded case. Verified live 2026-09-14: a tap
  // via emulateTouchFromMouseEvent incremented the target page's counter
  // while dispatchMouseEvent timed out at 8s on the same target.
  const mouse = (type, extra) =>
    msg('Input.emulateTouchFromMouseEvent', { type, x: cmd.x, y: cmd.y, button: 'left', timestamp: Date.now(), ...extra });
  const tapPair = (clickCount) => [
    mouse('mousePressed', { buttons: 1, clickCount }),
    mouse('mouseReleased', { buttons: 0, clickCount }),
  ];
  switch (cmd.type) {
    case 'tap': {
      const [pressed, released] = tapPair(1);
      return { messages: [pressed, released], awaits: [{ id: released.id, method: released.method }] };
    }
    case 'doubletap': {
      const [p1, r1] = tapPair(1);
      const [p2, r2] = tapPair(2);
      return { messages: [p1, r1, p2, r2], awaits: [{ id: r2.id, method: r2.method }] };
    }
    case 'longpress': {
      const [pressed, released] = tapPair(1);
      return {
        messages: [pressed, released],
        awaits: [
          { id: pressed.id, method: pressed.method, sleepAfterMs: Number(cmd.durationMs) || 0 },
          { id: released.id, method: released.method },
        ],
      };
    }
    case 'scroll': {
      // mouseWheel also hangs on a backgrounded Chrome 151 window; scroll
      // via Runtime.evaluate instead (synthetic, no window requirement).
      // Find the scrollable element at (x,y) and scroll it; fall back to window.
      const dx = Number(cmd.deltaX) || 0;
      const dy = Number(cmd.deltaY) || 0;
      const sx = Number(cmd.x) || 0;
      const sy = Number(cmd.y) || 0;
      const expr = `(function(x,y,dx,dy){var el=document.elementFromPoint(x,y);while(el){var s=getComputedStyle(el);if((s.overflowY==='auto'||s.overflowY==='scroll')&&el.scrollHeight>el.clientHeight){el.scrollBy(dx,dy);return true}el=el.parentElement}window.scrollBy(dx,dy);return false})(${sx},${sy},${dx},${dy})`;
      return single('Runtime.evaluate', { expression: expr });
    }
    case 'pinch': {
      // synthesizePinchGesture fails "Position out of bounds" on desktop
      // Chrome 151 — it requires a real touchscreen. Use two dispatchTouchEvent
      // fingers instead: touchStart at distance d, touchMove to d*scaleFactor,
      // touchEnd. scaleFactor>1 = zoom in (fingers apart), <1 = zoom out.
      const px = Number(cmd.x) || 0;
      const py = Number(cmd.y) || 0;
      const sf = Number(cmd.scaleFactor) || 1;
      const d = 40; // initial finger distance in px
      const half = d / 2;
      const endHalf = half * sf;
      const start = msg('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: px - half, y: py, id: 0 },
          { x: px + half, y: py, id: 1 },
        ],
      });
      const move = msg('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: px - endHalf, y: py, id: 0 },
          { x: px + endHalf, y: py, id: 1 },
        ],
      });
      const end = msg('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      return {
        messages: [start, move, end],
        awaits: [{ id: end.id, method: end.method }],
      };
    }
    case 'type':
      return single('Input.insertText', { text: String(cmd.text ?? '') });
    case 'key': {
      const modifiers = modifierBits(cmd.modifiers);
      const base = { key: cmd.key, code: cmd.code, modifiers };
      const messages = [msg('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })];
      // A single printable key emits a char event — but not under ctrl/meta/
      // alt, where the chord is a shortcut, not text input (shift still is).
      if (typeof cmd.key === 'string' && cmd.key.length === 1 && !(modifiers & 7)) {
        messages.push(
          msg('Input.dispatchKeyEvent', { type: 'char', ...base, text: cmd.text ?? cmd.key })
        );
      }
      const up = msg('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      messages.push(up);
      return { messages, awaits: [{ id: up.id, method: up.method }] };
    }
    case 'navigate':
      return single('Page.navigate', { url: String(cmd.url ?? '') });
    case 'back':
      return single('Runtime.evaluate', { expression: 'history.back()' });
    case 'forward':
      return single('Runtime.evaluate', { expression: 'history.forward()' });
    case 'reload':
      return single('Page.reload', {});
    default:
      return empty;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(e) {
  return e && e.message ? e.message : String(e);
}

async function fetchJson(url, deadlineMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postFrame(cfg, buf) {
  const res = await fetch(frameUrl(cfg), {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'image/jpeg' },
    body: buf,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function deleteLive(cfg) {
  try {
    await fetch(liveUrl(cfg), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${cfg.token}` },
    });
  } catch {
    // best-effort — a stale live entry TTL-evicts on the server anyway
  }
}

function waitForOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no open within ${timeoutMs}ms`)), timeoutMs);
    const fail = (why) => () => {
      clearTimeout(timer);
      reject(new Error(why));
    };
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', fail('socket error before open'), { once: true });
    ws.addEventListener('close', fail('closed before open'), { once: true });
  });
}

async function main() {
  let cfg = null;
  const fatal = async (message) => {
    console.error(JSON.stringify({ ok: false, error: message }));
    if (cfg) await deleteLive(cfg);
    process.exit(1);
  };

  try {
    cfg = resolveConfig(parseArgs(process.argv.slice(2)));
  } catch (e) {
    await fatal(e.message);
  }
  if (typeof WebSocket !== 'function') {
    await fatal('the Node global WebSocket is unavailable — the bridge requires Node 22+');
  }

  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${cfg.cdpPort}/json`, 5000);
  } catch (e) {
    await fatal(
      `cannot reach Chrome CDP on 127.0.0.1:${cfg.cdpPort} (${describe(e)}) — ` +
        `is Chrome running with --remote-debugging-port=${cfg.cdpPort}?`
    );
  }

  let target;
  try {
    target = pickTarget(targets, cfg.targetId);
  } catch (e) {
    await fatal(e.message);
  }

  let ws;
  try {
    ws = new WebSocket(target.webSocketDebuggerUrl);
  } catch (e) {
    await fatal(`bad webSocketDebuggerUrl "${target.webSocketDebuggerUrl}" (${describe(e)})`);
  }

  let stopping = false;
  let lastPostAt = 0;
  // AI-246 keepalive: lastFrameAt stamps EVERY screencastFrame receipt (kept
  // or throttled); lastFrameData holds the base64 of the most recent KEPT
  // frame so a starved stream can re-POST it to refresh the 30s store TTL.
  let lastFrameAt = 0;
  let lastFrameData = null;
  let lastErrLogAt = 0;
  // CDP responses the input loop is waiting on, keyed by message id.
  const pending = new Map();
  // AI-246: Page.screencastFrameAck is a CDP command and must carry an integer
  // id — Chrome rejects an id-less message with "Message must have integer 'id'
  // property", which the v1 fatal-on-error path treated as a stream-ending
  // fault. Acks are fire-and-forget; use a high id range (10000+) so they never
  // collide with screencast (1-3), Emulation (4-5), or input (100+) ids, and so
  // any ack error response falls under the >= 100 non-fatal guard below.
  let nextAckId = 10000;

  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    try { ws.send(JSON.stringify({ id: 3, method: 'Page.stopScreencast' })); } catch { /* closing anyway */ }
    await sleep(100); // let the stop frame flush before the close handshake
    try { ws.close(); } catch { /* already gone */ }
    await deleteLive(cfg);
    console.error(`screencast_bridge: ${signal} — stopped (task ${cfg.task}).`);
    process.exit(0);
  };

  try {
    await waitForOpen(ws, 10000);
  } catch (e) {
    await fatal(`CDP WebSocket to target ${target.id} did not open (${describe(e)})`);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  ws.addEventListener('error', () => {
    if (!stopping) void fatal('CDP WebSocket error');
  });
  ws.addEventListener('close', () => {
    if (!stopping) void fatal('CDP WebSocket closed — the page target went away');
  });
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.error) {
      // Emulation (ids 4/5) and un-awaited input messages (ids >= 100) are
      // non-fatal: older Chrome lacks the Emulation methods, and one bad
      // operator command must not kill the stream.
      if (msg.id === 4 || msg.id === 5 || (Number.isInteger(msg.id) && msg.id >= 100)) {
        const t = Date.now();
        if (t - lastErrLogAt >= 5000) {
          lastErrLogAt = t;
          console.error(
            `screencast_bridge: CDP id ${msg.id} failed, ignored ` +
              `(${msg.error.message || JSON.stringify(msg.error)})`
          );
        }
        return;
      }
      void fatal(`CDP command failed: ${msg.error.message || JSON.stringify(msg.error)}`);
      return;
    }
    if (msg.method !== 'Page.screencastFrame') return;
    const params = msg.params || {};
    try {
      ws.send(JSON.stringify({ id: nextAckId++, ...screencastAckMessage(params.sessionId) }));
    } catch {
      // socket mid-close — the shutdown path owns the exit
    }
    const now = Date.now();
    lastFrameAt = now;
    if (!shouldSendFrame(lastPostAt, now, cfg.fps)) return;
    lastPostAt = now;
    lastFrameData = params.data;
    postFrame(cfg, decodeFrameData(params.data)).catch((e) => {
      const t = Date.now();
      if (t - lastErrLogAt >= 5000) {
        lastErrLogAt = t;
        console.error(`screencast_bridge: frame POST failed (${describe(e)})`);
      }
    });
  });

  const sendAndAwait = (m, timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(m.id);
        reject(new Error(`${m.method} (id ${m.id}) timed out`));
      }, timeoutMs);
      pending.set(m.id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        ws.send(JSON.stringify(m));
      } catch (e) {
        pending.delete(m.id);
        clearTimeout(timer);
        reject(e);
      }
    });

  // Concurrent operator-input loop: long-polls the ingest-token endpoint and
  // injects each queued command over this same socket (ids from 100 up —
  // 1-3 screencast, 4-5 emulation). Exits quietly on 404/503 (server has no
  // input endpoint); 401 is fatal (bad token); anything else retries.
  let lastInputErrLogAt = 0;
  const logInputErr = (text) => {
    const t = Date.now();
    if (t - lastInputErrLogAt >= 5000) {
      lastInputErrLogAt = t;
      console.error(`screencast_bridge: ${text}`);
    }
  };
  const inputPollLoop = async () => {
    let lastSeq = 0;
    let nextCmdId = 100;
    while (!stopping) {
      let res;
      try {
        res = await fetch(inputPollUrl(cfg, lastSeq), {
          headers: { authorization: `Bearer ${cfg.token}` },
          signal: AbortSignal.timeout(30000), // the server holds ~25s
        });
      } catch (e) {
        if (stopping) break;
        logInputErr(`input poll failed (${describe(e)})`);
        await sleep(1000);
        continue;
      }
      if (res.status === 401) {
        await fatal('input poll returned 401 — bad PA_SCREENCAST_INGEST_TOKEN');
        return;
      }
      if (res.status === 404 || res.status === 503) break;
      if (!res.ok) {
        logInputErr(`input poll returned HTTP ${res.status}`);
        await sleep(1000);
        continue;
      }
      const { cmds, maxSeq } = parseInputPollResponse(await res.text(), lastSeq);
      for (const cmd of cmds) {
        if (stopping) break;
        // AI-246 zombie-WS guard: a second page-level CDP client can evict
        // this socket without 'close' ever firing; a dead bridge must not
        // keep draining the input queue into the void. Defence-in-depth on
        // top of the 'close' → fatal() listener above.
        if (ws.readyState !== WebSocket.OPEN) {
          await fatal('CDP WebSocket is not open — refusing to drain the input queue');
          return;
        }
        const { messages, awaits } = injectCommandMessages(cmd, nextCmdId);
        nextCmdId += messages.length;
        if (nextCmdId > 1_000_000 && pending.size === 0) nextCmdId = 100;
        if (messages.length === 0) {
          logInputErr(`input command ignored — unknown type "${cmd && cmd.type}"`);
          continue;
        }
        for (const m of messages) {
          const aw = awaits.find((a) => a.id === m.id);
          try {
            if (aw) await sendAndAwait(m);
            else ws.send(JSON.stringify(m));
          } catch (e) {
            logInputErr(`input ${cmd.type} failed (${describe(e)})`);
            break; // skip the rest of this command's messages
          }
          if (aw && aw.sleepAfterMs > 0) await sleep(aw.sleepAfterMs);
        }
      }
      lastSeq = maxSeq;
    }
  };

  ws.send(JSON.stringify({ id: 1, method: 'Page.enable' }));
  for (const m of emulationEnableMessages()) ws.send(JSON.stringify(m));
  ws.send(JSON.stringify(startScreencastMessage(2, cfg)));
  console.error(
    `screencast_bridge: streaming "${target.title || target.id}" → ${frameUrl(cfg)} ` +
      `at <=${cfg.fps}fps (task ${cfg.task}).`
  );

  // AI-246 keepalive: Page.startScreencast only emits on repaint, so a static
  // (login wall / CAPTCHA) or occluded page starves the stream and the 30s
  // store TTL evicts the pane — exactly when the operator needs it. Every 5s
  // (unref'd — never blocks exit): starved + kept frame → re-POST it; starved
  // + never framed → Page.captureScreenshot and POST that. Failures only log;
  // the next tick retries.
  const KEEPALIVE_MS = 12000; // store TTL is 30s — ~2.5x margin
  // Keepalive screenshot ids live above the input wrap ceiling (1M) and clear
  // of the unbounded ack counter (10000+); errors on them are non-fatal via
  // the >= 100 guard in the message handler.
  let nextKeepaliveId = 2000000;
  const keepalive = setInterval(() => {
    if (stopping) return;
    const action = shouldKeepalive(
      lastFrameAt,
      Date.now(),
      KEEPALIVE_MS,
      lastFrameData !== null,
      ws.readyState === WebSocket.OPEN
    );
    if (action === 'repost') {
      postFrame(cfg, decodeFrameData(lastFrameData)).catch((e) => {
        const t = Date.now();
        if (t - lastErrLogAt >= 5000) {
          lastErrLogAt = t;
          console.error(`screencast_bridge: keepalive repost failed (${describe(e)})`);
        }
      });
    } else if (action === 'screenshot') {
      sendAndAwait({
        id: nextKeepaliveId++,
        method: 'Page.captureScreenshot',
        params: { format: 'jpeg', quality: cfg.quality, fromSurface: true },
      })
        .then((result) => {
          const data = result && result.data;
          if (typeof data !== 'string' || data.length === 0) {
            throw new Error('Page.captureScreenshot returned no data');
          }
          return postFrame(cfg, decodeFrameData(data));
        })
        .catch((e) => {
          console.error(`screencast_bridge: keepalive screenshot failed (${describe(e)})`);
        });
    }
  }, 5000);
  keepalive.unref();

  void inputPollLoop();
}

// main() runs ONLY on direct entry — importing this module (tests) must not
// open sockets. realpathSync guards the Windows drive-letter/realpath variants.
function isMainEntry() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: describe(e) }));
    process.exit(1);
  });
}
