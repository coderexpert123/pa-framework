#!/usr/bin/env node
/**
 * Voice-inbox edge relay — real-runtime smoke (edge-relay wave WP-R2, §2e).
 *
 * Modes:
 *   node scripts/relay_smoke.mjs
 *     — LOCAL: generates a temp wrangler config (the example PLUS a
 *       smoke-only [vars] block: RELAY_TEST_MODE arms the x-relay-deadline-ms
 *       clamp and RELAY_SECRET is a throwaway local value — neither ever
 *       appears in wrangler.toml.example or a live config), spawns
 *       `npx -y wrangler@4.129.0 dev` (workerd simulates the DO + R2
 *       locally — NO Cloudflare account, and the spawn env strips any
 *       Cloudflare token vars so the smoke never touches live credentials),
 *       and starts a mock home HTTP server. The script plays BOTH sides:
 *       the browser (fetches against the worker) and the poller (a driven
 *       pump that claims /work and executes + delivers with the REAL poller
 *       execution path, executeAndDeliver from relay_poller.mjs).
 *   node scripts/relay_smoke.mjs --live <stable-url>
 *     — LIVE: against the DEPLOYED worker and the REAL home app (the real
 *       poller must be running). Runs the mode-independent scenarios and
 *       ENFORCES the ≤1000 ms added-latency budget on S9.
 *
 * Scenarios (local runs S1–S9; live runs S1, S8, S9 — the mock-home and
 * test-mode scenarios are local-only):
 *   S1 healthz answers {"ok":true}
 *   S2 GET preservation: status + body bytes + custom header preserved
 *   S3 small POST JSON round-trip: byte count exact
 *   S4 5 MiB upload → R2 request path → byte count exact
 *   S5 2 MiB response → R2 response path → byte count + header preservation
 *   S6 short-deadline park (test mode) → exact 504 body
 *   S7 two parks claim in id order (FIFO, monotonic)
 *   S8 /work without the secret → exact 401 body
 *   S9 latency: 20 sequential small GETs, median relay-vs-direct delta
 *      (informational locally; ENFORCED ≤1000 ms in --live)
 *
 * Every passing scenario prints exactly one "S<n> <name>: ok" line, and on
 * success the run ends with "RELAY SMOKE OK (mode=local|live)" on stdout and
 * exit 0. Any failure names the scenario on stderr and exits 1. Temp-dir
 * cleanup is best-effort (bounded retries; a residual Windows lock warns and
 * continues) — the verdict reflects the scenarios only.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeAndDeliver } from './relay_poller.mjs';
import { SECRET_HEADER, TEST_DEADLINE_HEADER } from '../relay/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');

const SMOKE_SECRET = 'relay-smoke-secret';
// POSIX-slash form for paths embedded in the TOML text (a Windows backslash
// is an invalid TOML escape; and no literal backslash lives in this source).
const toPosix = (p) => p.split(sep).join('/');
const MOCK_ECHO_BODY = 'mock-home-echo-body';
const WRANGLER_VERSION = '4.129.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(scenario, message) {
  throw new Error(`${scenario}: ${message}`);
}

function scenarioOk(name) {
  console.log(`${name}: ok`);
}

function describe(e) {
  return e && e.message ? e.message : String(e);
}

async function drainBody(response) {
  try {
    if (response && response.body) await response.arrayBuffer();
  } catch {
    // best effort
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Kills the spawned wrangler process TREE (npx → wrangler → workerd):
// child.kill() first, then the Windows tree-kill, both best-effort.
function killTree(wr) {
  const child = wr?.child;
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    // best effort
  }
  if (process.platform === 'win32' && child.pid) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } catch {
      // best effort — the process may already be gone
    }
  }
}

// Temp-dir teardown is BEST-EFFORT: on Windows the just-killed workerd tree
// can still hold locks on the state dir for a moment after taskkill returns
// (EBUSY), so wait a grace period for the locks to release, then retry the
// removal a bounded number of times. A residual failure warns and continues —
// cleanup NEVER fails the run, whose verdict reflects the scenarios only.
async function cleanupTempDir(tmpRoot) {
  await sleep(1500); // lock-release grace after the tree kill
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt === 3) {
        console.error(`RELAY SMOKE WARNING: temp cleanup incomplete (${tmpRoot}) — remove manually (${describe(e)})`);
        return;
      }
      await sleep(750);
    }
  }
}

// The smoke-only wrangler config: the example text with `main` rewritten to
// the absolute worker path (the temp config does not live in relay/), PLUS
// the [vars] block that exists ONLY here — never in the example or a live
// config.
function buildTempWranglerConfig(exampleText, workerJsPath) {
  const mainAbs = toPosix(workerJsPath); // POSIX form — a literal backslash is an invalid TOML escape
  if (!exampleText.includes('main = "worker.js"')) {
    throw new Error('buildConfig: wrangler.toml.example has no `main = "worker.js"` line to rewrite');
  }
  const rewritten = exampleText.replace('main = "worker.js"', `main = "${mainAbs}"`);
  return `${rewritten}
# Smoke-only [vars] (temp config, deleted on exit): RELAY_TEST_MODE arms the
# test-only x-relay-deadline-ms clamp; RELAY_SECRET is a throwaway local
# value — neither line ever appears in wrangler.toml.example or a live config.
[vars]
RELAY_TEST_MODE = "1"
RELAY_SECRET = "relay-smoke-secret"
`;
}

function spawnWranglerDev(cfgPath, port, cwd) {
  const env = { ...process.env };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_ACCOUNT_ID']) {
    delete env[key];
  }
  env.CI = 'true';
  const configArg = toPosix(cfgPath); // POSIX form for the spawned command line
  const command = `npx -y wrangler@${WRANGLER_VERSION} dev --port ${port} --config "${configArg}"`;
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let output = '';
  child.stdout.on('data', (c) => {
    output += c.toString();
    process.stderr.write(`[wrangler] ${c}`);
  });
  child.stderr.on('data', (c) => {
    output += c.toString();
    process.stderr.write(`[wrangler:err] ${c}`);
  });
  return { child, output: () => output.slice(-2000) };
}

async function waitHealthy(url, wr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wr.child.exitCode !== null) {
      fail('dev', `wrangler dev exited early (code ${wr.child.exitCode}):\n${wr.output()}`);
    }
    try {
      const res = await fetch(url);
      await drainBody(res);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  fail('dev', `dev server never answered /healthz within ${timeoutMs / 1000}s:\n${wr.output()}`);
}

// The mock home: the ONLY home-side server in any relay test (the real
// poller is never pointed at a live app from a test).
function startMockHome(port) {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/echo') {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-mock-home': 'echo-1' });
      res.end(MOCK_ECHO_BODY);
      return;
    }
    if (path === '/up') {
      let received = 0;
      req.on('data', (c) => {
        received += c.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ bytes: received }));
      });
      return;
    }
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-mock-home': 'big-1' });
      res.end(Buffer.alloc(2 * 1024 * 1024, 0x5a));
      return;
    }
    if (path === '/hang') {
      // Never responds — the request is left hanging (manual probing only).
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'mock home: no such route' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function stopMockHome(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

// Plays the poller side for one parked request: claims /work, executes with
// the REAL poller execution path, delivers to /resp. Retries briefly on 204
// so a park still in flight is never missed.
async function pumpUntilClaimed(workerBase, homeBase, { tries = 25, waitMs = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const id = await pumpOnce(workerBase, homeBase, waitMs);
    if (id !== null) return id;
    await sleep(150);
  }
  fail('pump', 'no work claimed after repeated polls');
}

async function pumpOnce(workerBase, homeBase, waitMs) {
  const res = await fetch(`${workerBase}/work?wait=${waitMs}`, {
    method: 'POST',
    headers: { [SECRET_HEADER]: SMOKE_SECRET },
  });
  if (res.status === 204) {
    await drainBody(res);
    return null;
  }
  if (res.status !== 200) fail('pump', `/work returned ${res.status}`);
  const envelope = await res.json();
  await drainBody(res);
  const outcome = await executeAndDeliver(
    {
      worker_base_url: workerBase,
      home_base_url: homeBase,
      secret: SMOKE_SECRET,
      poll_wait_ms: waitMs,
      request_deadline_ms: 55000,
      localhost_timeout_ms: 15000,
    },
    envelope
  );
  if (outcome.deliverStatus >= 400) {
    fail('pump', `/resp for id=${envelope.id} returned ${outcome.deliverStatus}`);
  }
  return envelope.id;
}

// Raw secret-authenticated claim (S7 drives claims directly, no delivery).
async function claimOnce(workerBase, scenario) {
  const res = await fetch(`${workerBase}/work?wait=1000`, {
    method: 'POST',
    headers: { [SECRET_HEADER]: SMOKE_SECRET },
  });
  if (res.status !== 200) fail(scenario, `/work claim returned ${res.status}`);
  const envelope = await res.json();
  await drainBody(res);
  return envelope.id;
}

function park(workerBase, path, { method = 'GET', headers, body } = {}) {
  return fetch(`${workerBase}${path}`, { method, headers, body });
}

async function runLocal() {
  const relayDir = join(pkgRoot, 'relay');
  const workerJs = join(relayDir, 'worker.js');
  const examplePath = join(relayDir, 'wrangler.toml.example');
  if (!existsSync(workerJs)) {
    fail('dev', 'relay/worker.js missing — the relay core (WP-R1) must exist to run the local smoke');
  }
  const exampleText = readFileSync(examplePath, 'utf8');
  const tmpRoot = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
  const cfgPath = join(tmpRoot, 'wrangler.toml');
  writeFileSync(cfgPath, buildTempWranglerConfig(exampleText, workerJs), 'utf8');

  const workerPort = await freePort();
  const homePort = await freePort();
  const workerBase = `http://127.0.0.1:${workerPort}`;
  const homeBase = `http://127.0.0.1:${homePort}`;

  const mock = await startMockHome(homePort);
  const wr = spawnWranglerDev(cfgPath, workerPort, relayDir);
  try {
    await waitHealthy(`${workerBase}/healthz`, wr, 60000);

    // S1 — healthz (re-asserted after the readiness probe).
    {
      const res = await fetch(`${workerBase}/healthz`);
      const body = await res.json();
      if (res.status !== 200 || body.ok !== true) {
        fail('S1', `healthz -> ${res.status} ${JSON.stringify(body)}`);
      }
      scenarioOk('S1 healthz');
    }

    // S2 — GET preservation: status + body bytes + custom header preserved.
    {
      const browser = park(workerBase, '/echo');
      await pumpUntilClaimed(workerBase, homeBase);
      const res = await browser;
      if (res.status !== 200) fail('S2', `status ${res.status}`);
      const text = await res.text();
      if (text !== MOCK_ECHO_BODY) fail('S2', `body not preserved: ${JSON.stringify(text.slice(0, 50))}`);
      if (res.headers.get('x-mock-home') !== 'echo-1') fail('S2', 'custom header not preserved');
      scenarioOk('S2 get-preservation');
    }

    // S3 — small POST JSON round-trip: the body arrives byte-exact.
    {
      const payload = JSON.stringify({ hello: 'relay', n: 42 });
      const browser = park(workerBase, '/up', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      });
      await pumpUntilClaimed(workerBase, homeBase);
      const res = await browser;
      if (res.status !== 200) fail('S3', `status ${res.status}`);
      const body = await res.json();
      if (body.bytes !== Buffer.byteLength(payload)) {
        fail('S3', `byte count ${body.bytes} != ${Buffer.byteLength(payload)}`);
      }
      scenarioOk('S3 post-roundtrip');
    }

    // S4 — 5 MiB upload: the worker must stream it through R2 (request path).
    {
      const payload = new Uint8Array(5 * 1024 * 1024);
      payload[0] = 0x3c;
      payload[payload.length - 1] = 0x3e;
      const browser = park(workerBase, '/up', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: payload,
      });
      await pumpUntilClaimed(workerBase, homeBase);
      const res = await browser;
      if (res.status !== 200) fail('S4', `status ${res.status}`);
      const body = await res.json();
      if (body.bytes !== payload.length) fail('S4', `byte count ${body.bytes} != ${payload.length}`);
      scenarioOk('S4 upload-5mib');
    }

    // S5 — 2 MiB response: the poller must stream it to R2 (response path).
    {
      const browser = park(workerBase, '/big');
      await pumpUntilClaimed(workerBase, homeBase);
      const res = await browser;
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status !== 200) fail('S5', `status ${res.status}`);
      if (buf.length !== 2 * 1024 * 1024) fail('S5', `byte count ${buf.length} != ${2 * 1024 * 1024}`);
      if (res.headers.get('x-mock-home') !== 'big-1') fail('S5', 'custom header not preserved');
      scenarioOk('S5 response-2mib');
    }

    // S6 — deadline expiry (needs RELAY_TEST_MODE): exact 504 body, no pump.
    {
      const browser = park(workerBase, '/echo', { headers: { [TEST_DEADLINE_HEADER]: '1500' } });
      const res = await browser;
      if (res.status !== 504) fail('S6', `status ${res.status}`);
      const text = await res.text();
      if (text !== '{"ok":false,"error":"relay deadline exceeded"}') {
        fail('S6', `504 body mismatch: ${JSON.stringify(text.slice(0, 80))}`);
      }
      scenarioOk('S6 deadline-park');
    }

    // S7 — two parks claim in id order (FIFO, monotonic ids); the claimed
    // items are never delivered, so both parks expire to the exact 504.
    {
      const first = park(workerBase, '/echo', { headers: { [TEST_DEADLINE_HEADER]: '4000' } });
      const second = park(workerBase, '/echo', { headers: { [TEST_DEADLINE_HEADER]: '4000' } });
      const idA = await claimOnce(workerBase, 'S7');
      const idB = await claimOnce(workerBase, 'S7');
      if (!(idB > idA)) fail('S7', `claims not in id order (${idA} then ${idB})`);
      for (const [name, pending] of [['first', first], ['second', second]]) {
        const res = await pending;
        if (res.status !== 504) fail('S7', `${name} expired park -> ${res.status}`);
      }
      scenarioOk('S7 fifo-claims');
    }

    // S8 — /work without the secret: exact 401 body. POST (the §1.2 claim
    // method) so this exercises the 401 path, not the 405 method check.
    {
      const res = await fetch(`${workerBase}/work?wait=100`, { method: 'POST' });
      const text = await res.text();
      if (res.status !== 401) fail('S8', `status ${res.status}`);
      if (text !== '{"ok":false,"error":"unauthorized"}') fail('S8', `401 body mismatch: ${text.slice(0, 80)}`);
      scenarioOk('S8 unauthorized');
    }

    // S9 — latency: informational locally (median relay-vs-direct delta).
    {
      const relayTimes = [];
      for (let i = 0; i < 20; i++) relayTimes.push(await timeThroughRelay(workerBase, homeBase));
      const directTimes = [];
      for (let i = 0; i < 20; i++) directTimes.push(await timeDirect(`${homeBase}/echo`));
      const relayMedian = median(relayTimes);
      const directMedian = median(directTimes);
      const delta = relayMedian - directMedian;
      console.error(
        `S9 latency (local, informational): relay median ${relayMedian.toFixed(1)} ms, ` +
          `direct median ${directMedian.toFixed(1)} ms, delta ${delta.toFixed(1)} ms` +
          ' (enforced only in --live)'
      );
      scenarioOk('S9 latency');
    }
  } finally {
    killTree(wr);
    await stopMockHome(mock);
    await cleanupTempDir(tmpRoot);
  }
}

async function timeThroughRelay(workerBase, homeBase) {
  const started = performance.now();
  const browser = park(workerBase, '/echo');
  await pumpUntilClaimed(workerBase, homeBase);
  const res = await browser;
  await res.arrayBuffer();
  return performance.now() - started;
}

async function timeDirect(url) {
  const started = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  return performance.now() - started;
}

// Live mode: the DEPLOYED worker + the REAL home app; the real poller does
// the claiming. Only the mode-independent scenarios run here (S1 healthz,
// S8 unauthorized, S9 latency ENFORCED).
async function runLive(url) {
  // S1 — healthz.
  {
    const res = await fetch(`${url}/healthz`);
    const body = await res.json().catch(() => null);
    if (res.status !== 200 || body?.ok !== true) {
      fail('S1', `healthz -> ${res.status} ${JSON.stringify(body)}`);
    }
    scenarioOk('S1 healthz');
  }

  // S8 — /work without the secret: exact 401 body (POST, per §1.2).
  {
    const res = await fetch(`${url}/work?wait=100`, { method: 'POST' });
    const text = await res.text();
    if (res.status !== 401) fail('S8', `status ${res.status}`);
    if (text !== '{"ok":false,"error":"unauthorized"}') fail('S8', `401 body mismatch: ${text.slice(0, 80)}`);
    scenarioOk('S8 unauthorized');
  }

  // S9 — latency, ENFORCED: the relay leg goes through the deployed worker
  // and the running poller; the direct leg hits the same app on localhost.
  {
    const homeBase = readLiveHomeBase();
    const relayUrl = `${url}/api/v1/health`;
    const directUrl = `${homeBase}/api/v1/health`;
    const directProbe = await fetch(directUrl);
    await drainBody(directProbe);
    if (directProbe.status !== 200) {
      fail('S9', `the home app did not answer ${directUrl} (${directProbe.status}) — start it and the poller first`);
    }
    const relayTimes = [];
    for (let i = 0; i < 20; i++) relayTimes.push(await timeDirect(relayUrl));
    const directTimes = [];
    for (let i = 0; i < 20; i++) directTimes.push(await timeDirect(directUrl));
    const relayMedian = median(relayTimes);
    const directMedian = median(directTimes);
    const delta = relayMedian - directMedian;
    console.error(
      `S9 latency (live, ENFORCED <=1000 ms): relay median ${relayMedian.toFixed(1)} ms, ` +
        `direct median ${directMedian.toFixed(1)} ms, delta ${delta.toFixed(1)} ms`
    );
    if (!(delta <= 1000)) {
      fail('S9', `median added latency ${delta.toFixed(1)} ms exceeds the 1000 ms budget`);
    }
    scenarioOk('S9 latency');
  }
}

// Live S9 needs the home app's port — the same relay.json the poller uses.
function readLiveHomeBase() {
  const paHome = process.env.PA_HOME ? process.env.PA_HOME : join(homedir(), '.pa');
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(paHome, 'voice-inbox', 'relay.json'), 'utf8'));
  } catch (e) {
    fail('S9', `cannot read relay.json (${describe(e)}) — run scripts/relay_setup.mjs first`);
  }
  if (typeof parsed.home_base_url !== 'string' || parsed.home_base_url.length === 0) {
    fail('S9', 'relay.json has no home_base_url');
  }
  return parsed.home_base_url.replace(/\/+$/, '');
}

async function main() {
  const args = process.argv.slice(2);
  let liveUrl = null;
  const liveIdx = args.indexOf('--live');
  if (liveIdx !== -1) {
    liveUrl = args[liveIdx + 1];
    if (!liveUrl) fail('args', '--live requires the stable worker URL');
    liveUrl = liveUrl.replace(/\/+$/, '');
  }
  try {
    if (liveUrl) await runLive(liveUrl);
    else await runLocal();
  } catch (e) {
    console.error(`RELAY SMOKE FAIL: ${describe(e)}`);
    process.exit(1);
  }
  console.log(`RELAY SMOKE OK (mode=${liveUrl ? 'live' : 'local'})`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error(`RELAY SMOKE FAIL: ${describe(e)}`);
  process.exit(1);
});
