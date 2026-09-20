#!/usr/bin/env node
/**
 * Voice-inbox edge relay — home-side long-poll poller (edge-relay wave WP-R2).
 *
 * The home machine makes OUTBOUND connections only: this process long-polls
 * the relay worker's /work long-poll endpoint, executes each claimed request
 * against the local app (home_base_url) and delivers the response back to
 * /resp. Nothing here listens on a socket, so nothing inbound can reach the
 * home network.
 *
 * Claims are AT-MOST-ONCE (the worker never re-queues a claimed item): if
 * this process dies mid-request, the browser sees the worker's 504 at the
 * request deadline and the user retries. That trade is deliberate —
 * re-delivery would re-EXECUTE a POST against the app. It is also why the
 * PID lock below is a convenience, not a correctness mutex: a stolen lock
 * (dead holder) is always safe, and even two live pollers would only split
 * claims, never duplicate one.
 *
 * Zero npm dependencies (wave adjudication (b)): config arrives via
 * <PA_HOME>/voice-inbox/relay.json (written by scripts/relay_setup.mjs) and
 * the secret via the VOICE_INBOX_RELAY_SECRET environment variable.
 * Relay constants and the §1.4 header filters have ONE source:
 * ../relay/protocol.js — the poller never redefines them.
 *
 * Logging: one JSONL line per proxied request to
 * <PA_HOME>/voice-inbox/logs/relay-poller.log —
 *   {"ts","id","method","path","status","ms","bytes"}
 * plus start/stop event lines, and a status:0 + "error" line when a proxied
 * request never produced a response. bytes is -1 when the response was too
 * large to inline and was streamed to R2 (its true size is unknown to the
 * poller). Human progress and failures go to stderr (the launcher lands them
 * in relay-poller.err). stdout stays silent: the launcher redirects stdout
 * onto the SAME log file, so non-JSON stdout would corrupt the JSONL stream.
 * No ref-IDs: these lines are not operator-facing messages (the app's own
 * events already carry them).
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SECRET_HEADER,
  RESPONSE_META_HEADER,
  INLINE_BODY_MAX_BYTES,
  POLL_WAIT_MAX_MS,
  REQUEST_DEADLINE_MS,
  base64ToBytes,
  bytesToBase64,
  filterRequestHeaders,
  filterResponseHeaders,
  encodeResponseMeta,
  LOCAL_REQUEST_OVERRIDES,
} from '../relay/protocol.js';

// Config defaults mirror the example file's three timing keys and derive from
// the protocol constants (ONE source, §1.1): the 50 s localhost timeout is 5 s
// under the worker's request deadline.
const DEFAULTS = {
  poll_wait_ms: POLL_WAIT_MAX_MS,
  request_deadline_ms: REQUEST_DEADLINE_MS,
  localhost_timeout_ms: REQUEST_DEADLINE_MS - 5000,
};

// §WP-R3 human-message shape: cause + next action, never a stack dump.
export const MISSING_SECRET_MESSAGE =
  'voice-inbox relay: VOICE_INBOX_RELAY_SECRET is not set. ' +
  'Start the poller via scripts/relay_start.ps1 (it loads the secret from ' +
  '~/.pa/secrets.env), or re-run "node scripts/relay_setup.mjs" to create it.';

const missingConfigMessage = (path) =>
  `voice-inbox relay: config not found at ${path}. ` +
  'Run "node scripts/relay_setup.mjs" first — it writes relay.json.';

function humanConfigError(path, detail) {
  return (
    `voice-inbox relay: config at ${path} is unusable (${detail}). ` +
    'Fix relay.json or re-run "node scripts/relay_setup.mjs".'
  );
}

function stripTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

// §1.4: all names lowercased, repeated names last-wins. Accepts anything
// iterable over [name, value] pairs (array of pairs, Headers, Map) or a
// plain object, so the shared protocol filters' exact return shape can be
// consumed without co-versioning.
function toPairs(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [String(name).toLowerCase(), String(value)]);
  }
  if (typeof headers.entries === 'function') {
    return [...headers.entries()].map(([name, value]) => [String(name).toLowerCase(), String(value)]);
  }
  return Object.entries(headers).map(([name, value]) => [String(name).toLowerCase(), String(value)]);
}

export function loadConfig(path, env = process.env) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(missingConfigMessage(path));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(humanConfigError(path, `not valid JSON: ${e.message}`));
  }
  const secret = env.VOICE_INBOX_RELAY_SECRET;
  if (!secret) throw new Error(MISSING_SECRET_MESSAGE);
  for (const key of ['worker_base_url', 'home_base_url']) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new Error(humanConfigError(path, `missing "${key}"`));
    }
  }
  const cfg = {
    worker_base_url: stripTrailingSlash(parsed.worker_base_url),
    home_base_url: stripTrailingSlash(parsed.home_base_url),
    secret,
  };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = Number(parsed[key]);
    cfg[key] = Number.isFinite(value) && value > 0 ? value : fallback;
  }
  return cfg;
}

// PID+timestamp lock at <PA_HOME>/voice-inbox/relay-poller.lock. Liveness via
// process.kill(pid, 0); a dead holder's lock is stolen. EPERM means the PID
// exists but cannot be signalled — treat as live.
export function lockIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function writeLock(path, pid) {
  writeFileSync(path, `${JSON.stringify({ pid, ts: Date.now() })}\n`, 'utf8');
}

export function readLock(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Takes the lock for this process. Three cases:
//  - the lock already names OUR OWN pid: relay_start.ps1 (2026-09-10
//    pile-up fix) writes {pid,ts} SYNCHRONOUSLY via Start-Process -PassThru
//    the instant it spawns us, before this process has run a single line —
//    so finding our own pid here on startup is the launcher's placeholder,
//    not a foreign holder to contest. We take ownership; nothing is stolen.
//  - a LIVE, FOREIGN pid holds it (the launcher's ensure-running tick reads
//    the same file): refuse.
//  - anything else (missing, corrupt, or a dead pid): steal it.
// Returns {acquired:true, stole, ownedByLauncher?} or {acquired:false, holder}.
//
// Non-atomicity: readLock-then-writeLock has no OS-level exclusivity, so two
// processes can both observe "no live holder" and both proceed to write.
// Re-reading immediately after our own write catches a concurrent writer
// that landed after ours — when the file no longer names us we correctly
// report that we lost the race instead of believing we hold a lock we do
// not (narrowest correct fix short of a real cross-process mutex).
export function acquireLock(path) {
  const existing = readLock(path);
  if (existing && existing.pid === process.pid) {
    return claimAndVerify(path, existing, { stole: false, ownedByLauncher: true });
  }
  if (existing && lockIsLive(existing.pid)) return { acquired: false, holder: existing };
  return claimAndVerify(path, existing, { stole: Boolean(existing) });
}

function claimAndVerify(path, existing, fields) {
  writeLock(path, process.pid);
  const verify = readLock(path);
  if (!verify || verify.pid !== process.pid) return { acquired: false, holder: verify || existing };
  return { acquired: true, ...fields };
}

// Backoff ladder 1 s → 2 s → 5 s → 10 s → 30 s cap. `attempt` counts
// CONSECUTIVE failures starting at 1; the loop resets it to 0 on success.
const BACKOFF_LADDER_MS = [1000, 2000, 5000, 10000, 30000];
export function backoffDelayMs(attempt) {
  const rung = Math.max(1, Math.floor(Number(attempt) || 1)) - 1;
  return BACKOFF_LADDER_MS[Math.min(rung, BACKOFF_LADDER_MS.length - 1)];
}

// Pure request-builder for the home leg (unit seam): applies the §1.4
// request filters through the shared protocol filter, forces the
// deterministic `accept-encoding: identity` guard, and classifies the
// envelope body so the caller resolves the R2 stream.
export function buildHomeRequest(envelope, homeBaseUrl) {
  const filtered = new Map(toPairs(filterRequestHeaders(toPairs(envelope?.headers))));
  for (const [name, value] of LOCAL_REQUEST_OVERRIDES) filtered.set(name, value);
  let path = typeof envelope?.path === 'string' ? envelope.path : '/';
  if (!path.startsWith('/')) path = `/${path}`;
  const body = classifyBody(envelope?.body);
  return {
    url: `${stripTrailingSlash(homeBaseUrl)}${path}`,
    method: typeof envelope?.method === 'string' && envelope.method ? envelope.method : 'GET',
    headers: [...filtered.entries()],
    body,
  };
}

// §1.3: body is exactly one of {inline_b64} | {r2_key}; absent means no body.
function classifyBody(body) {
  if (!body || typeof body !== 'object') return { kind: 'none' };
  if (typeof body.inline_b64 === 'string') {
    return { kind: 'bytes', bytes: base64ToBytes(body.inline_b64) };
  }
  if (typeof body.r2_key === 'string') return { kind: 'r2', key: body.r2_key };
  return { kind: 'none' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// fetch + AbortController deadline covering the HEADERS only. Callers that
// must also bound body consumption own the controller instead (see
// executeAndDeliver): clearing this timer at the headers is correct only when
// nothing further is read from the response.
async function fetchWithDeadline(url, init, deadlineMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Reads the home response up to INLINE_BODY_MAX_BYTES + 1 so a body exactly
// at the threshold stays inline. On overflow the already-read prefix is kept
// for the streaming /resp path (nothing is re-read or lost).
async function readUpTo(response, maxBytes) {
  if (!response.body) return { prefix: new Uint8Array(0), overflow: false, reader: null };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { prefix: concatChunks(chunks, total), overflow: false, reader: null };
    chunks.push(value);
    total += value.byteLength;
    if (total > maxBytes) break;
  }
  return { prefix: concatChunks(chunks, total), overflow: true, reader };
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Constructs the streamed /resp request body: the already-read prefix bytes,
// then the remainder of the home response.
function prependPrefixStream(prefix, reader) {
  return new ReadableStream({
    start(controller) {
      if (prefix.length > 0) controller.enqueue(prefix);
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (e) {
          controller.error(e);
        }
      })();
    },
  });
}


// Executes a claimed envelope against the home app and delivers the response
// to the relay. Redirects are forwarded verbatim (redirect: 'manual'); the
// localhost leg carries the deterministic identity accept-encoding guard.
// Returns {status, bytes, deliverStatus}; throws when the home leg fails.
export async function executeAndDeliver(cfg, envelope) {
  // §1.5: The pull relay cannot proxy open-ended SSE event streams. Returning HTTP 204
  // No Content satisfies WHATWG EventSource §9.2.6 ("If the status code was 204 or
  // 205, fail the connection and do not re-establish the connection") — the client
  // permanently closes the connection without reconnecting, falling back to POLL_MS.
  const reqPath = typeof envelope?.path === 'string' ? envelope.path : '';
  if (reqPath.startsWith('/api/v1/stream')) {
    const envelopeOut = { status: 204, headers: [] };
    const delivered = await fetchWithDeadline(
      `${cfg.worker_base_url}/resp?id=${envelope.id}`,
      {
        method: 'POST',
        headers: { [SECRET_HEADER]: cfg.secret, 'content-type': 'application/json' },
        body: JSON.stringify(envelopeOut),
      },
      cfg.request_deadline_ms
    );
    const deliverStatus = delivered.status;
    await drain(delivered);
    return { status: 204, bytes: 0, deliverStatus };
  }

  const built = buildHomeRequest(envelope, cfg.home_base_url);
  const init = {
    method: built.method,
    headers: Object.fromEntries(built.headers),
    redirect: 'manual',
  };
  if (built.body.kind === 'bytes') {
    init.body = built.body.bytes;
  } else if (built.body.kind === 'r2') {
    const bodyRes = await fetchWithDeadline(
      `${cfg.worker_base_url}/body/${built.body.key}`,
      { headers: { [SECRET_HEADER]: cfg.secret } },
      cfg.request_deadline_ms
    );
    if (!bodyRes.ok) {
      throw new Error(`body fetch for ${built.body.key} returned ${bodyRes.status}`);
    }
    init.body = bodyRes.body;
    init.duplex = 'half';
  }
  // The localhost deadline must cover BODY consumption, not just the response
  // headers: a home server that sends headers and then stalls would otherwise
  // wedge the poller forever on this one request. The controller therefore
  // stays armed until the body is fully read (inline path) or the streamed
  // /resp delivery has settled (overflow path — the raw fetch carries its own
  // request_deadline_ms, and an abort here errors the prepend stream, which
  // ends the pump).
  const homeController = new AbortController();
  const homeTimer = setTimeout(() => homeController.abort(), cfg.localhost_timeout_ms);
  try {
    const homeRes = await fetch(built.url, { ...init, signal: homeController.signal });
    const contentType = homeRes.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      if (homeRes.body) await homeRes.body.cancel().catch(() => {});
      const envelopeOut = { status: 204, headers: [] };
      const delivered = await fetchWithDeadline(
        `${cfg.worker_base_url}/resp?id=${envelope.id}`,
        {
          method: 'POST',
          headers: { [SECRET_HEADER]: cfg.secret, 'content-type': 'application/json' },
          body: JSON.stringify(envelopeOut),
        },
        cfg.request_deadline_ms
      );
      const deliverStatus = delivered.status;
      await drain(delivered);
      return { status: 204, bytes: 0, deliverStatus };
    }
    const headers = toPairs(filterResponseHeaders(toPairs(homeRes.headers)));
    const { prefix, overflow, reader } = await readUpTo(homeRes, INLINE_BODY_MAX_BYTES);
    if (!overflow) {
      // §1.3: an absent body key means no body — an empty home response
      // (204/304/HEAD/empty 200) must OMIT body entirely, because the
      // envelope decoder rejects an empty inline_b64 string.
      const envelopeOut = { status: homeRes.status, headers };
      if (prefix.length > 0) envelopeOut.body = { inline_b64: bytesToBase64(prefix) };
      const delivered = await fetchWithDeadline(
        `${cfg.worker_base_url}/resp?id=${envelope.id}`,
        {
          method: 'POST',
          headers: { [SECRET_HEADER]: cfg.secret, 'content-type': 'application/json' },
          body: JSON.stringify(envelopeOut),
        },
        cfg.request_deadline_ms
      );
      const deliverStatus = delivered.status;
      await drain(delivered);
      return { status: homeRes.status, bytes: prefix.length, deliverStatus };
    }
    const raw = await fetchWithDeadline(
      `${cfg.worker_base_url}/resp?id=${envelope.id}`,
      {
        method: 'POST',
        headers: {
          [SECRET_HEADER]: cfg.secret,
          [RESPONSE_META_HEADER]: encodeResponseMeta({ status: homeRes.status, headers, to_r2: true }),
        },
        body: prependPrefixStream(prefix, reader),
        duplex: 'half',
      },
      cfg.request_deadline_ms
    );
    const deliverStatus = raw.status;
    await drain(raw);
    return { status: homeRes.status, bytes: -1, deliverStatus };
  } finally {
    clearTimeout(homeTimer);
  }
}

// Consumes a /resp response body so the connection is released cleanly.
async function drain(response) {
  try {
    if (response && response.body) await response.arrayBuffer();
  } catch {
    // best effort — the deliver status is already captured
  }
}

export async function main() {
  const paHome = process.env.PA_HOME ? process.env.PA_HOME : join(homedir(), '.pa');
  const stateDir = join(paHome, 'voice-inbox');
  const logDir = join(stateDir, 'logs');
  const lockPath = join(stateDir, 'relay-poller.lock');
  const logPath = join(logDir, 'relay-poller.log');

  let cfg;
  try {
    cfg = loadConfig(join(stateDir, 'relay.json'));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  mkdirSync(logDir, { recursive: true });
  const gate = acquireLock(lockPath);
  if (!gate.acquired) {
    console.error(
      `voice-inbox relay: already running (pid ${gate.holder ? gate.holder.pid : 'unknown'}) — exiting.`
    );
    process.exit(0);
  }
  if (gate.ownedByLauncher) {
    console.error('voice-inbox relay: lock already registered by our own launcher — continuing.');
  } else if (gate.stole) {
    console.error('voice-inbox relay: stole a stale lock (its holder is dead) — continuing.');
  }

  appendLogLine(logPath, { ts: new Date().toISOString(), event: 'start', pid: process.pid });
  console.error(`voice-inbox relay: polling ${cfg.worker_base_url} (pid ${process.pid}).`);

  let stopping = false;
  let abortPoll = null;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`voice-inbox relay: ${signal} — finishing the in-flight request, then exiting.`);
    // An in-flight /work long-poll is aborted for a prompt exit (an unclaimed
    // poll is dropped, which is free); an in-flight EXECUTION is never
    // aborted — the loop finishes it, releases the lock and exits 0. The
    // unref'd backstop bounds a hung execution (server.ts shutdown pattern).
    if (abortPoll) abortPoll.abort();
    setTimeout(() => process.exit(0), cfg.localhost_timeout_ms + 15000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  let attempt = 0;
  while (!stopping) {
    abortPoll = new AbortController();
    let outcome;
    try {
      outcome = await pollOnce(cfg, abortPoll.signal);
    } catch (e) {
      if (stopping) break;
      attempt += 1;
      console.error(
        `voice-inbox relay: poll failed (${describe(e)}) — retrying in ${backoffDelayMs(attempt) / 1000}s.`
      );
      await sleep(backoffDelayMs(attempt));
      continue;
    }
    if (stopping) break;
    if (outcome.ok) {
      attempt = 0;
      if (outcome.envelope) {
        await handleClaimed(cfg, outcome.envelope, logPath);
      }
      continue; // 204 or delivered — immediate re-poll, NO sleep (spec-pinned)
    }
    if (outcome.status === 401) {
      console.error(
        'voice-inbox relay: 401 unauthorized from the worker — the relay secret does not ' +
          'match (VOICE_INBOX_RELAY_SECRET here vs the worker\'s RELAY_SECRET). Holding 30s.'
      );
      await sleep(backoffDelayMs(5));
      continue;
    }
    attempt += 1;
    console.error(
      `voice-inbox relay: poll returned ${outcome.status} — backing off ${backoffDelayMs(attempt) / 1000}s.`
    );
    await sleep(backoffDelayMs(attempt));
  }

  appendLogLine(logPath, { ts: new Date().toISOString(), event: 'stop', pid: process.pid });
  releaseLock(lockPath);
  process.exit(0);
}

// One POST /work?wait=<poll_wait_ms> long-poll (§1.2 routing table: POST is
// the claim method, other methods → 405). Bounded by request_deadline_ms
// (the 25 s wait + margin); a shutdown signal aborts it promptly.
async function pollOnce(cfg, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.request_deadline_ms);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const res = await fetch(`${cfg.worker_base_url}/work?wait=${cfg.poll_wait_ms}`, {
      method: 'POST',
      headers: { [SECRET_HEADER]: cfg.secret },
      signal: controller.signal,
    });
    if (res.status === 200) {
      const envelope = await res.json();
      await drain(res);
      return { ok: true, envelope };
    }
    await drain(res);
    if (res.status === 204) return { ok: true, envelope: null };
    return { ok: false, status: res.status };
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}

async function handleClaimed(cfg, envelope, logPath) {
  const started = Date.now();
  const base = {
    ts: new Date().toISOString(),
    id: envelope?.id ?? null,
    method: envelope?.method ?? null,
    path: envelope?.path ?? null,
  };
  try {
    const { status, bytes, deliverStatus } = await executeAndDeliver(cfg, envelope);
    appendLogLine(logPath, { ...base, status, ms: Date.now() - started, bytes });
    if (deliverStatus === 410) {
      console.error(`dropped late response id=${base.id}`);
    } else if (deliverStatus >= 400) {
      console.error(
        `voice-inbox relay: /resp for id=${base.id} returned ${deliverStatus} — the browser ` +
          'will see the worker\'s 504 at the deadline.'
      );
    }
  } catch (e) {
    appendLogLine(logPath, {
      ...base,
      status: 0,
      ms: Date.now() - started,
      bytes: 0,
      error: describe(e),
    });
    console.error(
      `voice-inbox relay: request id=${base.id} (${base.method} ${base.path}) failed: ${describe(e)}`
    );
  }
}

function releaseLock(lockPath) {
  try {
    const lock = readLock(lockPath);
    if (lock && lock.pid === process.pid) unlinkSync(lockPath);
  } catch {
    // best effort — a leftover lock is stolen by the next start
  }
}

function appendLogLine(path, obj) {
  try {
    appendFileSync(path, `${JSON.stringify(obj)}\n`, 'utf8');
  } catch (e) {
    console.error(`voice-inbox relay: log write failed (${describe(e)}).`);
  }
}

function describe(e) {
  return e && e.message ? e.message : String(e);
}

// main() runs ONLY on direct entry — importing this module must not start
// the loop. realpathSync guards the Windows drive-letter/realpath variants.
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
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });
}
