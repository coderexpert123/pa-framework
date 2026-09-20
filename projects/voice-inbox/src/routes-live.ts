/**
 * /api/v1/live/* — the screencast frame + input route family (AI-246),
 * extracted from routes.ts. Pure move: the dispatch returns the same
 * responses byte-for-byte. routes.ts mounts this above its session gate
 * because auth is split by design (v2): the bridge routes (POST .../frame,
 * DELETE .../, GET .../input) authenticate on the shared ingest token — the
 * bridge carries no paired-device session — while the operator routes
 * (GET .../frame, GET .../, POST .../input) authenticate a paired-device
 * Bearer session, tenant-scoped as usual. A paired-device token cannot drain
 * input and the ingest token cannot enqueue it.
 */

import { timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CONFIG_DEFAULTS } from './config.js';
import { authenticateSession } from './identity.js';
import { getTask } from './ledger.js';
import {
  UNAUTHORIZED,
  errorBody,
  headerOf,
  json,
  type ApiRequest,
  type ApiResponse,
  type RouteDeps,
} from './routes.js';
import type {
  ScreencastInputCommand,
  ScreencastInputType,
} from './screencast-input-store.js';

// --- live screencast (AI-246) ----------------------------------------------

/** AI-246 v2: the accepted input command `type`s (the spec's injection
 *  table — one JSON object per POST). */
const INPUT_TYPES: ReadonlySet<string> = new Set([
  'tap',
  'doubletap',
  'longpress',
  'scroll',
  'pinch',
  'type',
  'key',
  'navigate',
  'back',
  'forward',
  'reload',
]);
/** Coordinate bound when the live frame's real page dims are unknown
 *  (spec: a generous 4096×4096). */
const INPUT_COORD_MAX = 4096;
/** GET input long-poll ceiling — ~25 s per the spec; the `wait_ms` query
 *  param only ever shortens it. */
const INPUT_POLL_WAIT_MS = 25_000;
/** Schemes a `navigate` command may carry (spec: http/https/data). */
const INPUT_NAVIGATE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'data:']);

/** AI-246: cross-tenant task existence for the screencast ingest/clear paths
 * ONLY — the shared ingest token (not a tenant session) is those routes'
 * authority, so the question is "does this task id exist at all". Private to
 * routes-live.ts: the ledger deliberately exposes no un-scoped accessor, and
 * this is the one sanctioned exception — it yields a boolean, never task
 * data. */
function taskExistsAnyTenant(db: Database.Database, taskId: string): boolean {
  return db.prepare('SELECT task_id FROM tasks WHERE task_id = ? LIMIT 1').get(taskId) !== undefined;
}

/** AI-246: minimal JPEG SOF scan — {width, height} from the first SOF marker
 * (C0..CF except C4 DHT / C8 JPG / CC DAC), undefined when the buffer is not
 * a parseable JPEG. Frames arrive untrusted: a malformed one still stores and
 * serves its bytes, just with null dims on the status route. The bridge POSTs
 * raw JPEG only, so the bytes themselves are the dimension source. */
function jpegDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined; // SOI
  let pos = 2;
  while (pos + 3 < buf.length) {
    if (buf[pos] !== 0xff) return undefined;
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos += 1; // fill byte — markers may be preceded by runs of 0xFF
      continue;
    }
    // Standalone markers carry no length field: TEM (01), RSTn (D0-D7),
    // SOI (D8), EOI (D9).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(pos + 2);
    if (segLen < 2) return undefined;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (pos + 9 > buf.length) return undefined;
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + segLen;
  }
  return undefined;
}

// Same body as routes.ts's private asObject — duplicated here rather than
// widening routes.ts's export surface (the WP pins exactly four exports).
function asObject(body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ingest-token check: constant-time compare of the Bearer token against
 * config.screencastIngestToken. The bridge's authority is this shared
 * secret — it carries no paired-device session, so authenticateSession is
 * never involved on the write paths. */
function ingestTokenOk(req: ApiRequest, deps: RouteDeps): boolean {
  const expected = deps.config.screencastIngestToken;
  if (expected === undefined || expected === '') return false;
  const header = headerOf(req.headers, 'authorization');
  const presented =
    header === undefined ? undefined : /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
  if (!presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /live/:taskId/frame — the bridge's ingest. NOT tenant-scoped: the
 * ingest token is the authority, so the task check is by id alone
 * (taskExistsAnyTenant). The frame is stored in memory only — never under
 * files/<task_id>/ (the never-on-disk rule). */
function liveFrameIngest(req: ApiRequest, taskId: string, deps: RouteDeps): ApiResponse {
  const store = deps.screencastStore;
  if (!deps.config.screencastIngestToken || store === undefined) {
    return errorBody(503, 'screencast disabled');
  }
  if (!ingestTokenOk(req, deps)) return { status: 401, body: UNAUTHORIZED };
  if (!taskExistsAnyTenant(deps.db, taskId)) return errorBody(404, 'not found');
  if (!store.putFrame(taskId, req.body, jpegDimensions(req.body))) {
    return errorBody(
      413,
      `frame exceeds screencast_max_frame_bytes (${deps.config.screencastMaxFrameBytes ?? CONFIG_DEFAULTS.screencastMaxFrameBytes})`
    );
  }
  return json({ ok: true });
}

/** GET /live/:taskId/frame — the PWA's pull. Session + tenant check happen
 * in the mount dispatch below. Returns the newest frame as ApiResponse.buffer
 * (server.ts's sendBuffer: image/jpeg, content-length, no-store); no fresh
 * frame → 204 No Content. */
function liveFramePull(taskId: string, deps: RouteDeps): ApiResponse {
  const frame = deps.screencastStore?.getFrame(taskId);
  if (frame === undefined) return { status: 204, body: null };
  return { status: 200, body: null, buffer: { data: frame.buf, contentType: 'image/jpeg' } };
}

/** GET /live/:taskId — the PWA's cheap liveness status poll. */
function liveStatus(taskId: string, deps: RouteDeps): ApiResponse {
  const meta =
    deps.screencastStore?.meta(taskId) ?? { live: false, ts: null, width: null, height: null };
  // WP-J: omitted until the operator's first accepted input on the task —
  // lets the PWA badge an in-progress takeover if wanted later.
  const operatorInputAt = deps.screencastInputStore?.lastInputAt(taskId) ?? null;
  return json({
    ok: true,
    live: meta.live,
    ts: meta.ts,
    width: meta.width,
    height: meta.height,
    ...(operatorInputAt !== null ? { operator_input_at: operatorInputAt } : {}),
  });
}

/** DELETE /live/:taskId — ingest-token auth; the bridge's best-effort
 * shutdown clear. Idempotent: clearing an absent frame still answers ok. */
function liveClear(req: ApiRequest, taskId: string, deps: RouteDeps): ApiResponse {
  if (!deps.config.screencastIngestToken) return errorBody(503, 'screencast disabled');
  if (!ingestTokenOk(req, deps)) return { status: 401, body: UNAUTHORIZED };
  deps.screencastStore?.clear(taskId);
  // v2: a departing bridge also retires the task's pending operator
  // input — undelivered commands must not outlive the only consumer that
  // could drain them. Idempotent like the frame clear (and independent
  // of screencast_input_enabled: a disabled queue clears silently).
  deps.screencastInputStore?.clear(taskId);
  return json({ ok: true });
}

// --- live screencast input (AI-246 v2) ------------------------------------

/** The feature flag — absent config field reads as the default (true),
 *  same fixture-compat contract as the v1 screencast knobs. */
function screencastInputEnabled(deps: RouteDeps): boolean {
  return deps.config.screencastInputEnabled ?? CONFIG_DEFAULTS.screencastInputEnabled;
}

/** Coordinate bound for input validation: the live frame's real page dims
 *  when the status route knows them, else the spec's generous 4096 cap. */
function inputCoordBounds(taskId: string, deps: RouteDeps): { maxX: number; maxY: number } {
  const meta = deps.screencastStore?.meta(taskId);
  return {
    maxX:
      meta?.live === true && typeof meta.width === 'number' && meta.width > 0
        ? meta.width
        : INPUT_COORD_MAX,
    maxY:
      meta?.live === true && typeof meta.height === 'number' && meta.height > 0
        ? meta.height
        : INPUT_COORD_MAX,
  };
}

/** Normalize + validate one POSTed input command. Anything off-shape is a
 *  400 reason; the returned command carries ONLY the fields its type
 *  needs — stray body keys never reach the queue. */
function validateInputCommand(
  body: Record<string, unknown>,
  bounds: { maxX: number; maxY: number },
  deps: RouteDeps
): { ok: true; cmd: ScreencastInputCommand } | { ok: false; error: string } {
  const type = body['type'];
  if (typeof type !== 'string' || !INPUT_TYPES.has(type)) {
    return { ok: false, error: `type must be one of ${[...INPUT_TYPES].join(', ')}` };
  }
  const t = type as ScreencastInputType;
  const coord = (v: unknown, max: number): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
  const coords = (): { x: number; y: number } | { error: string } => {
    const x = body['x'];
    const y = body['y'];
    if (!coord(x, bounds.maxX) || !coord(y, bounds.maxY)) {
      return { error: `x and y must be numbers within 0..${bounds.maxX} / 0..${bounds.maxY}` };
    }
    return { x, y };
  };
  switch (t) {
    case 'tap':
    case 'doubletap': {
      const c = coords();
      if ('error' in c) return { ok: false, error: c.error };
      return { ok: true, cmd: { type: t, x: c.x, y: c.y } };
    }
    case 'longpress': {
      const c = coords();
      if ('error' in c) return { ok: false, error: c.error };
      const d = body['durationMs'];
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 60_000) {
        return { ok: false, error: 'durationMs must be an integer 1..60000' };
      }
      return { ok: true, cmd: { type: t, x: c.x, y: c.y, durationMs: d } };
    }
    case 'scroll': {
      const c = coords();
      if ('error' in c) return { ok: false, error: c.error };
      const dx = body['deltaX'];
      const dy = body['deltaY'];
      const finite = (v: unknown): v is number =>
        typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1_000_000;
      if (!finite(dx) || !finite(dy)) {
        return { ok: false, error: 'deltaX and deltaY must be finite numbers within ±1000000' };
      }
      return { ok: true, cmd: { type: t, x: c.x, y: c.y, deltaX: dx, deltaY: dy } };
    }
    case 'pinch': {
      const c = coords();
      if ('error' in c) return { ok: false, error: c.error };
      const s = body['scaleFactor'];
      if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > 1000) {
        return { ok: false, error: 'scaleFactor must be a number greater than 0 and at most 1000' };
      }
      return { ok: true, cmd: { type: t, x: c.x, y: c.y, scaleFactor: s } };
    }
    case 'type': {
      const text = body['text'];
      const maxText = deps.config.screencastInputMaxText ?? CONFIG_DEFAULTS.screencastInputMaxText;
      if (typeof text !== 'string' || text.length < 1 || text.length > maxText) {
        return { ok: false, error: `text must be a string of 1..${maxText} chars` };
      }
      return { ok: true, cmd: { type: t, text } };
    }
    case 'key': {
      const key = body['key'];
      if (typeof key !== 'string' || key.length < 1 || key.length > 64) {
        return { ok: false, error: 'key must be a string of 1..64 chars' };
      }
      const cmd: ScreencastInputCommand = { type: t, key };
      const code = body['code'];
      if (code !== undefined) {
        if (typeof code !== 'string' || code.length < 1 || code.length > 64) {
          return { ok: false, error: 'code must be a string of 1..64 chars when present' };
        }
        cmd.code = code;
      }
      const modifiers = body['modifiers'];
      if (modifiers !== undefined) {
        if (
          !Array.isArray(modifiers) ||
          modifiers.length > 8 ||
          modifiers.some((m) => typeof m !== 'string' || m.length < 1 || m.length > 32)
        ) {
          return { ok: false, error: 'modifiers must be an array of up to 8 strings of 1..32 chars' };
        }
        cmd.modifiers = modifiers as string[];
      }
      return { ok: true, cmd };
    }
    case 'navigate': {
      const url = body['url'];
      const maxUrl = deps.config.screencastInputMaxUrl ?? CONFIG_DEFAULTS.screencastInputMaxUrl;
      if (typeof url !== 'string' || url.length < 1 || url.length > maxUrl) {
        return { ok: false, error: `url must be a string of 1..${maxUrl} chars` };
      }
      let protocol: string;
      try {
        protocol = new URL(url).protocol;
      } catch {
        return { ok: false, error: 'url must be a valid URL' };
      }
      if (!INPUT_NAVIGATE_SCHEMES.has(protocol)) {
        return { ok: false, error: 'url scheme must be http, https, or data' };
      }
      return { ok: true, cmd: { type: t, url } };
    }
    case 'back':
    case 'forward':
    case 'reload':
      return { ok: true, cmd: { type: t } };
  }
  return { ok: false, error: 'unsupported input type' }; // unreachable — INPUT_TYPES gates t
}

/** POST /live/:taskId/input — the operator's input enqueue. Paired-device
 *  Bearer + tenant-scoped task (the same pattern as the frame pull): the
 *  input path is the OPERATOR's, so the ingest token is NOT valid here.
 *  Disabled → 503 before auth, same ordering as the frame ingest. */
function liveInputEnqueue(req: ApiRequest, taskId: string, deps: RouteDeps): ApiResponse {
  const store = deps.screencastInputStore;
  if (!screencastInputEnabled(deps) || store === undefined) {
    return errorBody(503, 'screencast input disabled');
  }
  const tenant = authenticateSession(deps.db, headerOf(req.headers, 'authorization'), deps.now);
  if (!tenant) return { status: 401, body: UNAUTHORIZED };
  if (!getTask(deps.db, tenant.tenant_id, taskId)) return errorBody(404, 'not found');
  const body = asObject(req.body);
  if (!body) return errorBody(400, 'invalid json');
  const validated = validateInputCommand(body, inputCoordBounds(taskId, deps), deps);
  if (!validated.ok) return errorBody(400, validated.error);
  const result = store.enqueue(taskId, validated.cmd);
  if (result === 'invalid') return errorBody(400, 'invalid command');
  if (result === 'rate-limited') {
    // The spec's "413 overflow": the per-task per-second input budget
    // overflowed. (Queue-full can never fire — a full queue drops its
    // oldest entry and still accepts.)
    return errorBody(
      413,
      `input rate limit exceeded (screencast_input_rate_per_sec ${deps.config.screencastInputRatePerSec ?? CONFIG_DEFAULTS.screencastInputRatePerSec})`
    );
  }
  return json({ ok: true, seq: result });
}

/** GET /live/:taskId/input?since=<seq>&wait_ms=<ms> — the bridge's
 *  long-poll drain. Ingest-token auth, NOT a session: the shared secret
 *  is the authority, so the task check is by id alone
 *  (taskExistsAnyTenant), same as the frame ingest — a paired-device
 *  token is refused here. Answers {ok:true, cmds, maxSeq} as soon as a
 *  command newer than `since` exists, else 204 when the wait expires
 *  (≤25 s; wait_ms only shortens — the tests' fast path). `since`
 *  defaults to 0. */
async function liveInputPoll(req: ApiRequest, taskId: string, deps: RouteDeps): Promise<ApiResponse> {
  const store = deps.screencastInputStore;
  if (!screencastInputEnabled(deps) || store === undefined) {
    return errorBody(503, 'screencast input disabled');
  }
  if (!ingestTokenOk(req, deps)) return { status: 401, body: UNAUTHORIZED };
  if (!taskExistsAnyTenant(deps.db, taskId)) return errorBody(404, 'not found');
  const sinceParam = req.query.get('since');
  let since = 0;
  if (sinceParam !== null) {
    const n = Number(sinceParam);
    if (!Number.isInteger(n) || n < 0) return errorBody(400, 'since must be a non-negative integer');
    since = n;
  }
  const waitParam = req.query.get('wait_ms');
  let waitMs = INPUT_POLL_WAIT_MS;
  if (waitParam !== null) {
    const n = Number(waitParam);
    if (!Number.isInteger(n) || n < 0) return errorBody(400, 'wait_ms must be a non-negative integer');
    waitMs = Math.min(n, INPUT_POLL_WAIT_MS);
  }
  const drained = await store.drainSinceWait(taskId, since, waitMs);
  if (drained === null) return { status: 204, body: null };
  return json({ ok: true, cmds: drained.cmds, maxSeq: drained.maxSeq });
}

/** The /live/* matcher — the body of routes.ts's former
 * `if (rest[0] === 'live') { ... }` mount block, unchanged: same path split,
 * same method dispatch, same auth order. */
export async function handleLiveRoute(
  req: ApiRequest,
  method: string,
  rest: string[],
  deps: RouteDeps
): Promise<ApiResponse> {
  const liveTaskId = rest[1];
  const isFramePath = rest.length === 3 && rest[2] === 'frame';
  const isInputPath = rest.length === 3 && rest[2] === 'input';
  const isTaskPath = rest.length === 2;
  if (liveTaskId === undefined || (!isFramePath && !isTaskPath && !isInputPath)) {
    return errorBody(404, 'not found');
  }
  if (method === 'POST' && isFramePath) return liveFrameIngest(req, liveTaskId, deps);
  if (method === 'POST' && isInputPath) return liveInputEnqueue(req, liveTaskId, deps);
  if (method === 'GET' && isInputPath) return liveInputPoll(req, liveTaskId, deps);
  if (method === 'DELETE' && isTaskPath) return liveClear(req, liveTaskId, deps);
  if (method === 'GET') {
    const liveTenant = authenticateSession(deps.db, headerOf(req.headers, 'authorization'), deps.now);
    if (!liveTenant) return { status: 401, body: UNAUTHORIZED };
    if (!getTask(deps.db, liveTenant.tenant_id, liveTaskId)) return errorBody(404, 'not found');
    return isFramePath ? liveFramePull(liveTaskId, deps) : liveStatus(liveTaskId, deps);
  }
  return errorBody(405, 'method not allowed');
}
