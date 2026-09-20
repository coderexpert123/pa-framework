/**
 * Voice-inbox API server (AI-201 WP-B, §6): node:http — no web framework, no
 * bundler. Binds 127.0.0.1 ONLY (the tunnel dials it locally; never
 * 0.0.0.0). Serves the PWA's static shell from `public/` and forwards
 * `/api/v1/*` to the router in routes.ts.
 *
 * `--check` mode: validates config + opens/creates the ledger, prints
 *   voice-inbox: config ok, ledger ok (schema v9)
 * and exits 0 (the §12 gate string — an exact-match assertion, so any
 * fallback text is a failure).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  answersDir,
  CONFIG_DEFAULTS,
  filesDir,
  ledgerPath,
  loadConfig,
  pairingCodesPath,
  routeQueuePath,
  requestLogPath,
  splitTopicKey,
  topicNamesPath,
  voiceInboxDir,
} from './config.js';
import { LEDGER_SCHEMA_VERSION, openLedger } from './ledger.js';
import { createRouter, type ApiRequest, type RouteDeps } from './routes.js';
import { createScreencastStore } from './screencast-store.js';
import { createScreencastInputStore } from './screencast-input-store.js';
import { createRequestLogger, redactPathForLog } from './request-log.js';
import { authenticateSession, sha256Hex } from './identity.js';
import {
  createEventHub,
  createShellNudge,
  createShellVersionReader,
  startChangeWatcher,
  startShellWatcher,
  type EventHub,
} from './event-stream.js';
import { decodeRawFrameParam, RAW_FRAME_CSP_HEADER } from './frame-route.js';
import { repoRootFromModule } from './repo-root.js';

// dist is FLAT (tsconfig pins rootDir: ./src → compiled server is dist/server.js,
// not dist/src/server.js) — the package root is ONE level up from the module.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url)); // dist
const PKG_ROOT = resolve(MODULE_DIR, '..'); // projects/voice-inbox
const STATIC_ROOT = join(PKG_ROOT, 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** AI-236: repo root is TWO levels above this package (…/<repo>/projects/voice-inbox). */
const REPO_ROOT = repoRootFromModule(import.meta.url);

interface RequestRecord {
  status: number;
  bytesOut: number;
}

function serveStatic(pathname: string, res: ServerResponse, record: RequestRecord): void {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(STATIC_ROOT, relative);
  // Traversal guard: the resolved path must stay inside public/.
  if (target !== STATIC_ROOT && !target.startsWith(STATIC_ROOT + sep)) {
    record.status = 404;
    record.bytesOut = Buffer.byteLength(JSON.stringify({ ok: false, error: 'not found' }));
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    record.status = 404;
    record.bytesOut = Buffer.byteLength(JSON.stringify({ ok: false, error: 'not found' }));
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  const type = MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  record.status = 200;
  record.bytesOut = statSync(target).size;
  createReadStream(target).pipe(res);
}

/** Buffer the request body with a hard cap; resolve null when over it. */
function readBody(req: IncomingMessage, capBytes: number): Promise<Buffer | null> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > capBytes) {
        over = true;
        chunks.length = 0;
        req.destroy();
        resolvePromise(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolvePromise(Buffer.concat(chunks));
    });
    req.on('error', () => resolvePromise(null));
    req.on('close', () => {
      if (!over) resolvePromise(Buffer.concat(chunks));
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, record?: RequestRecord): void {
  // body == null (or undefined) → an EMPTY payload, not the text "null": a
  // 204 (the live-frame pull's no-frame answer) must not carry a body, and
  // Node refuses non-empty writes on one (ERR_HTTP_BODY_NOT_ALLOWED).
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  if (record) {
    record.status = status;
    record.bytesOut = Buffer.byteLength(payload);
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** C1: the callback's phone-facing landing page — an exact HTML string, no
 * CSS, no script, no external asset (§3.5). */
function sendHtml(res: ServerResponse, status: number, html: string, record?: RequestRecord): void {
  if (record) {
    record.status = status;
    record.bytesOut = Buffer.byteLength(html);
  }
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

/** The audio-playback route (`GET /tasks/:id/audio`): streams the file the
 * router already resolved and tenant-checked. A stat failure between
 * resolution and streaming (file removed mid-request) degrades to 404 rather
 * than a 500 — the same not-found shape the router itself would have sent. */
function sendFile(res: ServerResponse, file: { path: string; contentType: string }, record: RequestRecord): void {
  let size: number;
  try {
    size = statSync(file.path).size;
  } catch {
    record.status = 404;
    record.bytesOut = Buffer.byteLength(JSON.stringify({ ok: false, error: 'not found' }));
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  record.status = 200;
  record.bytesOut = size;
  res.writeHead(200, {
    'content-type': file.contentType,
    'content-length': size,
    'cache-control': 'no-store',
  });
  createReadStream(file.path).pipe(res);
}

/** AI-246: the ApiResponse.buffer shape — raw in-memory bytes (the live
 * screencast frame pull's JPEG) with an explicit content-type + length +
 * no-store. Not a file: nothing touches disk. */
function sendBuffer(
  res: ServerResponse,
  status: number,
  buffer: { data: Buffer; contentType: string },
  record?: RequestRecord
): void {
  if (record) {
    record.status = status;
    record.bytesOut = buffer.data.length;
  }
  res.writeHead(status, {
    'content-type': buffer.contentType,
    'content-length': buffer.data.length,
    'cache-control': 'no-store',
  });
  res.end(buffer.data);
}

async function main(): Promise<number> {
  const check = process.argv.includes('--check');

  // §6: the server refuses to start without voice_inbox.inbox_topic — the
  // ConfigError message names the key. Nothing prints to stdout on failure.
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const db = openLedger(ledgerPath());

  if (check) {
    db.close();
    console.log(`voice-inbox: config ok, ledger ok (schema v${LEDGER_SCHEMA_VERSION})`);
    return 0;
  }

  const routeDeps: RouteDeps = {
    db,
    config,
    repoRoot: REPO_ROOT,
    pairingCodesPath: pairingCodesPath(),
    routeQueuePath: routeQueuePath(),
    topicNamesPath: topicNamesPath(),
    answersDir: answersDir(),
    filesDir: filesDir(),
    pushStorageDir: voiceInboxDir(),
    // AI-246: the live-screencast frame store — in-memory only, never disk.
    screencastStore: createScreencastStore({
      ttlMs: (config.screencastFrameTtlSeconds ?? CONFIG_DEFAULTS.screencastFrameTtlSeconds) * 1000,
      maxBytes: config.screencastMaxFrameBytes ?? CONFIG_DEFAULTS.screencastMaxFrameBytes,
    }),
    // AI-246 v2: the operator-input command queue — in-memory only, never
    // disk. Constructed unconditionally like the frame store; the routes
    // 503 when screencast_input_enabled is false.
    screencastInputStore: createScreencastInputStore({
      maxQueuePerTask: config.screencastInputMaxQueue ?? CONFIG_DEFAULTS.screencastInputMaxQueue,
      maxTextLen: config.screencastInputMaxText ?? CONFIG_DEFAULTS.screencastInputMaxText,
      maxUrlLen: config.screencastInputMaxUrl ?? CONFIG_DEFAULTS.screencastInputMaxUrl,
      rateLimitPerSec: config.screencastInputRatePerSec ?? CONFIG_DEFAULTS.screencastInputRatePerSec,
    }),
  };
  const handle = createRouter(routeDeps);
  const logRequest = createRequestLogger(requestLogPath());

  // Live-update SSE (vi-6b1014ea197b, event-stream.ts): 'changed' fires on any
  // ledger write (this process's own or an out-of-process Python worker's —
  // see that file's module doc for why the watcher needs its own connection);
  // 'reload' fires when the PWA shell itself changed on disk, independent of
  // whether the server process restarted (a public/-only deploy never
  // touches dist/.build-stamp).
  const eventHub: EventHub = createEventHub();
  const changeWatcher = startChangeWatcher(ledgerPath(), () => eventHub.broadcast('changed'));
  const shellWatcher = startShellWatcher(join(STATIC_ROOT, 'sw.js'), () => eventHub.broadcast('reload'));
  // vi-7790f35108f8: replay the `reload` a client missed by connecting after
  // the sw.js edit (or reconnecting after a restart). The reader and the nudge
  // map are per-process; see event-stream.ts for the policy.
  const shellNudge = createShellNudge(createShellVersionReader(join(STATIC_ROOT, 'sw.js')));

  // Transport cap (vi-39ab14f84f14): 1 MB JSON slack plus whatever attachment
  // knobs are explicitly set; when NEITHER is set the cap is Infinity — no
  // transport limit at all, matching the no-cap default (size > Infinity is
  // never true). Accepted trade-off: the body buffers in memory before this
  // check, so an unbounded request is bounded only by the machine — fine for
  // a 127.0.0.1-only bind under an operator-directed no-cap default.
  const bodyCap =
    config.maxUploadMb === undefined && config.maxAttachmentTotalMb === undefined
      ? Infinity
      : (config.maxUploadMb !== undefined ? config.maxUploadMb * 1024 * 1024 : 0) +
        (config.maxAttachmentTotalMb !== undefined ? config.maxAttachmentTotalMb * 1024 * 1024 : 0) +
        1024 * 1024;

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? '?';
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      url = undefined; // logging never affects serving; the 500 below matches today's behavior
    }
    const loggedPath = url ? redactPathForLog(url.pathname, url.searchParams) : '(unparsed)';
    const isApi = url !== undefined && url.pathname.startsWith('/api/');
    const record: RequestRecord = { status: 0, bytesOut: 0 };
    let bytesIn = 0;
    try {
      if (!url) throw new Error('unparseable request target');
      if (url.pathname === '/api/v1/stream') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, record);
          return;
        }
        // EventSource cannot set an Authorization header — the query token is
        // the standard workaround (MDN / whatwg EventSource has no headers
        // option). redactPathForLog already strips query VALUES, so it never
        // reaches logs/requests.log; residual exposure (devtools network tab,
        // an intermediary's own access log) is equivalent to any other
        // credential a browser holds, and is accepted for this Bearer-only,
        // localhost-bound app.
        const token = url.searchParams.get('token');
        if (token === null) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' }, record);
          return;
        }
        const tenant = authenticateSession(db, `Bearer ${token}`);
        if (!tenant) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' }, record);
          return;
        }
        record.status = 200;
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        const unsubscribe = eventHub.addClient((chunk) => {
          res.write(chunk);
        });
        // vi-7790f35108f8: the stale-shell replay — the client declares its
        // shell version as `?shell=vNN`; a stale or absent declaration gets
        // exactly one `reload` per (session, on-disk version). Sessions key
        // by the token (hashed — same shape identity.ts stores) so separate
        // devices nudge independently.
        if (shellNudge.shouldNudge(sha256Hex(token), url.searchParams.get('shell'))) {
          res.write('event: reload\ndata: {}\n\n');
        }
        const heartbeat = setInterval(() => {
          try {
            res.write(': hb\n\n');
          } catch {
            /* connection already gone; 'close' below cleans up */
          }
        }, 20_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }
      // AI-227: /s/:token — the public share page shell. A static HTML file
      // (public/share.html); share.js does the actual fetch of
      // /api/v1/share/:token client-side. Matched before the generic static
      // dispatch below because share.html itself does not live at this path.
      if (/^\/s\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, record);
          return;
        }
        const html = readFileSync(join(STATIC_ROOT, 'share.html'), 'utf8');
        sendHtml(res, 200, html, record);
        return;
      }
      // Raw-html frames (2026-09-14, the freedom lane made interactive): the
      // PWA's sandboxed iframes load the model-authored frame document from
      // THIS route instead of srcdoc, because a srcdoc frame inherits the
      // shell page CSP (index.html, default-src 'self') that a frame meta can
      // only tighten — inline styles/scripts stayed inert. The response
      // carries its own inline-only CSP header (frame-route.ts): the
      // dynamism runs, `default-src 'none'` keeps the frame network-dead.
      // The query token mirrors /api/v1/stream (an iframe navigation cannot
      // set Authorization headers; redactPathForLog strips query VALUES) —
      // without it any public page could embed this URL and reach the app
      // origin's storage from inside an UNSANDBOXED frame.
      if (url.pathname === '/frames/raw') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, record);
          return;
        }
        const frameToken = url.searchParams.get('token');
        const frameTenant =
          frameToken === null ? null : authenticateSession(db, `Bearer ${frameToken}`);
        if (!frameTenant) {
          sendJson(res, 401, { ok: false, error: 'unauthorized' }, record);
          return;
        }
        const frame = decodeRawFrameParam(url.searchParams.get('d'));
        if (!frame.ok) {
          sendJson(res, frame.status, {
            ok: false,
            error: frame.status === 413 ? 'payload too large' : 'bad request',
          }, record);
          return;
        }
        record.status = 200;
        record.bytesOut = Buffer.byteLength(frame.html);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': RAW_FRAME_CSP_HEADER,
        });
        res.end(frame.html);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          serveStatic(url.pathname, res, record);
        } else {
          sendJson(res, 405, { ok: false, error: 'method not allowed' }, record);
        }
        return;
      }
      const body = await readBody(req, bodyCap);
      if (body === null) {
        sendJson(res, 413, { ok: false, error: 'payload too large' }, record);
        return;
      }
      bytesIn = body.length;
      const apiReq: ApiRequest = {
        method: req.method ?? 'GET',
        pathname: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        remoteAddress: req.socket.remoteAddress ?? undefined,
      };
      const apiRes = await handle(apiReq);
      if (apiRes.file !== undefined) {
        sendFile(res, apiRes.file, record);
      } else if (apiRes.html !== undefined) {
        sendHtml(res, apiRes.status, apiRes.html, record);
      } else if (apiRes.buffer !== undefined) {
        sendBuffer(res, apiRes.status, apiRes.buffer, record);
      } else {
        sendJson(res, apiRes.status, apiRes.body, record);
      }
    } catch {
      // Last-resort guard: the router maps its own errors; nothing should
      // reach here.
      sendJson(res, 500, { ok: false, error: 'internal error' }, record);
    } finally {
      logRequest({
        ts: new Date(startedAt).toISOString(),
        method,
        path: loggedPath,
        status: record.status,
        bytes_in: bytesIn,
        bytes_out: record.bytesOut,
        ms: Date.now() - startedAt,
        session_ok: isApi && record.status !== 401,
      });
    }
  });

  // 127.0.0.1 ONLY (§6) — the tunnel dials it locally; never 0.0.0.0.
  server.listen(config.port, '127.0.0.1', () => {
    const inbox = splitTopicKey(config.inboxTopic);
    console.log(
      `voice-inbox: listening on 127.0.0.1:${config.port} (inbox topic ${config.inboxTopic}` +
        `${inbox ? `, chat ${inbox.chatId}` : ''})`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`voice-inbox: ${signal} — closing`);
    changeWatcher.stop();
    shellWatcher.stop();
    routeDeps.screencastStore?.stop();
    routeDeps.screencastInputStore?.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Idle keep-alive sockets must not hold the process open past 5 s.
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 5_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return 0;
}

main().then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (e) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  }
);
