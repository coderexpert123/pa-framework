/**
 * relay-poller.test.mjs — pure unit tests for scripts/relay_poller.mjs
 * (edge-relay wave WP-R2). NO network, NO wrangler, NO ports: the lock tests
 * use a private mkdtemp dir, the request-builder tests are pure, and the
 * import test asserts the module starts no loop on import.
 *
 * Header-filter coverage rides the poller's OWN request-builder, which calls
 * the shared protocol.js filters (§1.4) — the real consumer over the real
 * producer output, never a local reimplementation.
 *
 * Machine rule: this file is plain .mjs registered as a real node:test suite
 * (the dark-file detector fails a zero-test file) — see § Node tests in
 * ~/.claude/machine-notes.md and the repo's scoped-run convention
 * (`PA_BUILD_LOCK=0 npm test -- relay-poller.test.mjs`).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The no-leaked-timer check must observe the module RIGHT AFTER its first
// import, before the test runner arms anything of its own — so it is
// evaluated here, at module scope, and asserted inside a test below.
const pollerUrl = new URL('../../scripts/relay_poller.mjs', import.meta.url);
const {
  MISSING_SECRET_MESSAGE,
  acquireLock,
  backoffDelayMs,
  buildHomeRequest,
  executeAndDeliver,
  loadConfig,
  lockIsLive,
  readLock,
  writeLock,
} = await import(pollerUrl.href);
const leakedTimersAfterImport = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'relay-poller-test-'));
}

// A GUARANTEED-dead PID: spawn a node that exits, await its exit.
function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', () => resolve(child.pid));
    child.on('error', reject);
  });
}

// A genuinely LIVE, FOREIGN process — distinct from this test's own pid.
// process.pid is no longer a valid stand-in for "a live pid" in these tests:
// acquireLock now treats a lock naming OUR OWN pid as the launcher's
// placeholder, not a foreign holder to contest (2026-09-10 pile-up fix).
// Callers must `child.kill()` when done — a PID we spawned ourselves, never
// an image-name kill.
function liveChild() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

// Runs the real relay_poller.mjs script as a subprocess (main()'s actual
// entry path, not just the exported pure functions) so the lock-gate exit
// behavior is proven end-to-end rather than only at the acquireLock() unit
// level.
function spawnPollerOnce(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(pollerUrl)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('exit', (code) => resolve({ code, stderr }));
    child.on('error', reject);
  });
}

test('importing the poller module starts no loop (no leaked Timeout)', () => {
  assert.deepEqual(
    leakedTimersAfterImport,
    [],
    `module import left timers running: ${leakedTimersAfterImport.join(',')}`
  );
});

test('backoffDelayMs follows the exact 1/2/5/10/30 s ladder and caps at 30 s', () => {
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 5000);
  assert.equal(backoffDelayMs(4), 10000);
  assert.equal(backoffDelayMs(5), 30000, 'fifth consecutive failure reaches the cap');
  assert.equal(backoffDelayMs(9), 30000, 'cap holds past the ladder end');
});

test('backoffDelayMs clamps nonsense attempts to the first rung', () => {
  assert.equal(backoffDelayMs(0), 1000);
  assert.equal(backoffDelayMs(undefined), 1000);
});

test('buildHomeRequest applies the §1.4 request filters and forces identity', () => {
  const envelope = {
    id: 7,
    method: 'POST',
    path: '/api/v1/tasks?x=1',
    headers: [
      ['host', 'relay.example'],
      ['connection', 'keep-alive'],
      ['keep-alive', 'timeout=5'],
      ['transfer-encoding', 'chunked'],
      ['upgrade', 'websocket'],
      ['te', 'trailers'],
      ['trailer', 'x-sum'],
      ['proxy-connection', 'keep-alive'],
      ['proxy-authorization', 'Basic zzz'],
      ['proxy-authenticate', 'Basic'],
      ['content-length', '123'],
      ['accept-encoding', 'gzip, br'],
      ['content-type', 'application/json'],
      ['authorization', 'Bearer app-session'],
    ],
    body: { inline_b64: Buffer.from('{"a":1}').toString('base64') },
  };
  const built = buildHomeRequest(envelope, 'http://127.0.0.1:8787/');
  assert.equal(built.url, 'http://127.0.0.1:8787/api/v1/tasks?x=1', 'home_base_url + path, trailing slash stripped');
  assert.equal(built.method, 'POST');
  const headers = Object.fromEntries(built.headers);
  for (const dropped of [
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
    'proxy-connection',
    'proxy-authorization',
    'proxy-authenticate',
    'content-length',
  ]) {
    assert.ok(!(dropped in headers), `${dropped} must be dropped by the §1.4 request filter`);
  }
  assert.equal(headers['accept-encoding'], 'identity', 'the localhost leg pins identity');
  assert.equal(headers['content-type'], 'application/json', 'app headers preserved verbatim');
  assert.equal(headers['authorization'], 'Bearer app-session', 'app headers preserved verbatim');
});

test('buildHomeRequest classifies the §1.3 body forms', () => {
  const base = { id: 1, method: 'GET', path: '/x' };
  assert.deepEqual(buildHomeRequest({ ...base }, 'http://h').body, { kind: 'none' }, 'absent body -> none');
  const bytes = buildHomeRequest(
    { ...base, body: { inline_b64: Buffer.from('hi').toString('base64') } },
    'http://h'
  ).body;
  assert.equal(bytes.kind, 'bytes');
  assert.equal(Buffer.from(bytes.bytes).toString('utf8'), 'hi', 'inline_b64 decoded to bytes');
  const r2 = buildHomeRequest({ ...base, body: { r2_key: 'req/42.bin' } }, 'http://h').body;
  assert.deepEqual(r2, { kind: 'r2', key: 'req/42.bin' });
});

test('buildHomeRequest defaults a missing method/path and normalizes path', () => {
  const built = buildHomeRequest({}, 'http://h');
  assert.equal(built.method, 'GET');
  assert.equal(built.url, 'http://h/');
});

test('lock write/read roundtrip; corrupt and missing files read as null', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'relay-poller.lock');
    assert.equal(readLock(path), null, 'missing lock reads as null');
    writeLock(path, 4242);
    { const lock = readLock(path); assert.equal(lock.pid, 4242); assert.equal(typeof lock.ts, 'number'); }
    writeFileSync(path, 'not json at all', 'utf8');
    assert.equal(readLock(path), null, 'corrupt lock reads as null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lockIsLive: own pid is live, nonsense pids are not', () => {
  assert.equal(lockIsLive(process.pid), true);
  assert.equal(lockIsLive(0), false);
  assert.equal(lockIsLive(-5), false);
  assert.equal(lockIsLive(null), false);
});

test('acquireLock blocks on a genuinely foreign live holder and steals a dead holder', async () => {
  const dir = tempDir();
  const child = liveChild();
  try {
    const path = join(dir, 'relay-poller.lock');

    // Foreign, genuinely live holder (a real different process) blocks
    // acquisition.
    writeLock(path, child.pid);
    const blocked = acquireLock(path);
    assert.equal(blocked.acquired, false, 'a live foreign holder must block acquisition');
    assert.equal(blocked.holder.pid, child.pid);

    // Dead holder's lock is stolen (at-most-once claims make this safe).
    const dead = await deadPid();
    writeLock(path, dead);
    const stolen = acquireLock(path);
    assert.equal(stolen.acquired, true, 'a dead holder must be stolen from');
    assert.equal(stolen.stole, true);
    assert.equal(readLock(path).pid, process.pid, 'the lock now names this process');

    // A missing lock is simply taken.
    const fresh = join(dir, 'fresh.lock');
    const taken = acquireLock(fresh);
    assert.equal(taken.acquired, true);
    assert.equal(taken.stole, false);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

// relay_start.ps1 (2026-09-10 pile-up fix) now writes {pid,ts} SYNCHRONOUSLY
// via Start-Process -PassThru the instant it spawns this process — before
// this process has executed a single line. On startup the poller must
// recognize that placeholder as OUR OWN registration, not a foreign holder
// to steal from or exit against.
test('acquireLock recognizes a lock the launcher wrote naming our own pid and proceeds without stealing', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'relay-poller.lock');
    writeLock(path, process.pid);
    const gate = acquireLock(path);
    assert.equal(gate.acquired, true, 'our own launcher-registered pid must not block us');
    assert.equal(gate.stole, false, 'recognizing our own placeholder is not theft');
    assert.equal(gate.ownedByLauncher, true);
    assert.equal(readLock(path).pid, process.pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// main() end-to-end: a genuinely foreign LIVE holder must still make the
// poller exit 0 without ever reaching the network, exactly as before this
// fix.
test('main(): a genuinely foreign LIVE holder makes the poller exit 0 without starting', async () => {
  const paHome = tempDir();
  const child = liveChild();
  try {
    const stateDir = join(paHome, 'voice-inbox');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'relay.json'),
      JSON.stringify({ worker_base_url: 'https://example.workers.dev', home_base_url: 'http://127.0.0.1:8787' }),
      'utf8'
    );
    writeLock(join(stateDir, 'relay-poller.lock'), child.pid);
    const { code, stderr } = await spawnPollerOnce({
      PA_HOME: paHome,
      VOICE_INBOX_RELAY_SECRET: 'secret-value',
    });
    assert.equal(code, 0, `expected exit 0, stderr: ${stderr}`);
    assert.match(stderr, /already running/);
  } finally {
    child.kill();
    rmSync(paHome, { recursive: true, force: true });
  }
});

function writeRelayConfig(dir, config) {
  const path = join(dir, 'relay.json');
  writeFileSync(path, JSON.stringify(config), 'utf8');
  return path;
}

const GOOD_CONFIG = {
  worker_base_url: 'https://voice-inbox-relay.example-subdomain.workers.dev/',
  home_base_url: 'http://127.0.0.1:8787/',
  poll_wait_ms: 25000,
  request_deadline_ms: 55000,
  localhost_timeout_ms: 50000,
};

test('loadConfig happy path: five keys + secret, trailing slashes stripped', () => {
  const dir = tempDir();
  try {
    const path = writeRelayConfig(dir, GOOD_CONFIG);
    const cfg = loadConfig(path, { VOICE_INBOX_RELAY_SECRET: 'secret-value' });
    assert.equal(cfg.worker_base_url, 'https://voice-inbox-relay.example-subdomain.workers.dev');
    assert.equal(cfg.home_base_url, 'http://127.0.0.1:8787');
    assert.equal(cfg.secret, 'secret-value');
    assert.equal(cfg.poll_wait_ms, 25000);
    assert.equal(cfg.request_deadline_ms, 55000);
    assert.equal(cfg.localhost_timeout_ms, 50000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig applies the example defaults when timing keys are absent', () => {
  const dir = tempDir();
  try {
    const path = writeRelayConfig(dir, {
      worker_base_url: 'https://w.workers.dev',
      home_base_url: 'http://127.0.0.1:8787',
    });
    const cfg = loadConfig(path, { VOICE_INBOX_RELAY_SECRET: 's' });
    assert.equal(cfg.poll_wait_ms, 25000);
    assert.equal(cfg.request_deadline_ms, 55000);
    assert.equal(cfg.localhost_timeout_ms, 50000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig fails with the human message when the secret is missing', () => {
  const dir = tempDir();
  try {
    const path = writeRelayConfig(dir, GOOD_CONFIG);
    assert.throws(() => loadConfig(path, {}), (e) => {
      assert.match(e.message, /VOICE_INBOX_RELAY_SECRET/);
      assert.equal(e.message, MISSING_SECRET_MESSAGE, 'the pinned human message text is stable');
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig fails with a human message on a missing file and on missing URLs', () => {
  const dir = tempDir();
  try {
    assert.throws(
      () => loadConfig(join(dir, 'absent.json'), { VOICE_INBOX_RELAY_SECRET: 's' }),
      /relay_setup\.mjs/
    );
    const path = writeRelayConfig(dir, { worker_base_url: 'https://w.workers.dev' });
    assert.throws(() => loadConfig(path, { VOICE_INBOX_RELAY_SECRET: 's' }), /home_base_url/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeAndDeliver: SSE stream requests immediately deliver 204 No Content without touching home app', async () => {
  let deliveredBody = null;
  let deliveredHeaders = null;
  const mockWorker = createServer((req, res) => {
    if (req.url === '/resp?id=42') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        deliveredBody = JSON.parse(body);
        deliveredHeaders = req.headers;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => mockWorker.listen(0, '127.0.0.1', resolve));
  const workerPort = mockWorker.address().port;

  try {
    const cfg = {
      worker_base_url: `http://127.0.0.1:${workerPort}`,
      home_base_url: 'http://127.0.0.1:59999', // dummy port that would fail if fetched
      secret: 'test-secret',
      request_deadline_ms: 5000,
      localhost_timeout_ms: 5000,
    };
    const envelope = {
      id: 42,
      method: 'GET',
      path: '/api/v1/stream?token=abc',
    };
    const res = await executeAndDeliver(cfg, envelope);
    assert.equal(res.status, 204);
    assert.equal(res.bytes, 0);
    assert.equal(res.deliverStatus, 200);
    assert.deepEqual(deliveredBody, { status: 204, headers: [] });
    assert.equal(deliveredHeaders['x-relay-secret'], 'test-secret');
  } finally {
    await new Promise((resolve) => mockWorker.close(resolve));
  }
});

