#!/usr/bin/env node
/**
 * Localhost smoke (AI-201 WP-B §12 gate): boots the REAL compiled server in
 * an isolated PA_HOME, mints a pairing code with the real dev script, and
 * drives the §6 endpoints over real HTTP. On success prints EXACTLY:
 *
 *   SMOKE OK: exchange=1 task=received routed-entry=1 events>=1
 *
 * (stdout carries that one line; every diagnostic goes to stderr.)
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');

const TOPIC_KEY = '-1001234567890_1040';
const SMOKE_OK = 'SMOKE OK: exchange=1 task=received routed-entry=1 events>=1';

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
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

function runChild(cmd, args, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: pkgRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function main() {
  // NOTE: the spec's gate text says dist/src/server.js, but the WP-A tsconfig
  // (bot copy, rootDir ./src) emits dist/server.js — same layout as the bot's
  // dist/tests. The real compiled path is used here; discrepancy reported.
  const serverJs = join(pkgRoot, 'dist', 'server.js');
  const mintJs = join(pkgRoot, 'scripts', 'mint_pairing.mjs');
  const fs = await import('node:fs');
  if (!fs.existsSync(serverJs)) fail('dist/src/server.js missing — run npm run build first');

  // Isolated runtime state: PA_HOME in a temp dir (repo test convention).
  const tmpRoot = mkdtempSync(join(tmpdir(), 'voice-inbox-smoke-'));
  const paHome = join(tmpRoot, 'pa-home');
  const fsSync = await import('node:fs');
  fsSync.mkdirSync(join(paHome, 'voice-inbox'), { recursive: true });
  // inbox_topic comes from the CONFIG FILE (the production path); only the
  // port rides an env override — both §6 override rules get exercised.
  writeFileSync(
    join(paHome, 'config.yaml'),
    `voice_inbox:\n  inbox_topic: "${TOPIC_KEY}"\n`,
    'utf8'
  );
  writeFileSync(
    join(paHome, 'telegram-topic-names.json'),
    JSON.stringify({
      '-1001234567890': {
        0: { name: 'General', description: '' },
        1040: { name: 'Inbox', description: '' },
        2002: { name: 'Errands', description: '' },
      },
    }),
    'utf8'
  );

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // Boot the real server; its stdout is forwarded to OUR stderr so this
  // process's stdout stays exactly one line.
  const server = spawn(process.execPath, [serverJs], {
    cwd: pkgRoot,
    env: { ...process.env, PA_HOME: paHome, VOICE_INBOX_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverErr = '';
  server.stdout.on('data', (c) => process.stderr.write(`[server] ${c}`));
  server.stderr.on('data', (c) => {
    serverErr += c.toString();
    process.stderr.write(`[server:err] ${c}`);
  });
  let serverExit = new Promise((resolve) => server.on('exit', (code) => resolve(code)));
  let stopped = false;
  const stopServer = async () => {
    if (stopped) return;
    stopped = true;
    server.kill();
    await Promise.race([serverExit, new Promise((r) => setTimeout(r, 5000))]);
  };

  try {
    server.on('exit', (code) => {
      if (!stopped && code !== null && code !== 0) {
        fail(`server exited early (code ${code}): ${serverErr.slice(-400)}`);
      }
    });

    // 1. Wait for /health (no auth).
    const deadline = Date.now() + 15_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/v1/health`);
        if (res.status === 200) {
          const body = await res.json();
          if (body.ok === true && body.service === 'voice-inbox') { healthy = true; break; }
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!healthy) fail('server never became healthy on /api/v1/health');

    // 2. Mint a pairing code with the REAL dev script.
    const mint = await runChild(process.execPath, [mintJs, '--user-id', '424242', '--chat-id', TOPIC_KEY.split('_')[0]],
      { PA_HOME: paHome }, 15_000);
    if (mint.code !== 0) fail(`mint_pairing exited ${mint.code}: ${mint.stderr.slice(-300)}`);
    const codeMatch = /PAIRING CODE: ([A-Z0-9]{8})/.exec(mint.stdout);
    if (!codeMatch) fail(`could not parse minted code from: ${mint.stdout.slice(-200)}`);
    const code = codeMatch[1];

    // 3. Exchange the code for a session (exchange=1).
    const exchangeRes = await fetch(`${base}/api/v1/pair/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (exchangeRes.status !== 200) fail(`exchange returned ${exchangeRes.status}`);
    const exchange = await exchangeRes.json();
    if (exchange.ok !== true || !exchange.session_token || exchange.tenant_id !== 't-424242') {
      fail(`unexpected exchange body: ${JSON.stringify(exchange)}`);
    }
    const auth = { authorization: `Bearer ${exchange.session_token}` };

    // 4. Create a text task (task=received).
    const taskRes = await fetch(`${base}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ text: `Smoke task ${randomUUID().slice(0, 8)}: confirm the inbox loop` }),
    });
    if (taskRes.status !== 200) fail(`task creation returned ${taskRes.status}`);
    const task = await taskRes.json();
    if (task.ok !== true || task.state !== 'received' || !/^vi-[0-9a-f]{12}$/.test(task.task_id)) {
      fail(`unexpected task body: ${JSON.stringify(task)}`);
    }

    // 5. The inbox route entry landed (routed-entry=1).
    const queuePath = join(paHome, 'voice-inbox', 'route-queue.jsonl');
    let entries = [];
    try {
      entries = readFileSync(queuePath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l));
    } catch {
      fail('route-queue.jsonl missing or unreadable');
    }
    if (entries.length !== 1) fail(`expected 1 route entry, got ${entries.length}`);
    if (entries[0].task_id !== task.task_id) fail('route entry task_id mismatch');
    if (entries[0].chat_id !== -1001234567890 || entries[0].thread_id !== 1040) {
      fail(`route entry topic mismatch: ${entries[0].chat_id}_${entries[0].thread_id}`);
    }
    if (!String(entries[0].text).startsWith(`[Voice inbox task ${task.task_id}]`)) {
      fail('route entry text is not the inbox injection');
    }
    if (!/^s-[0-9a-f]{12}$/.test(String(entries[0].ref_id))) fail('route entry ref_id malformed');

    // 6. Events stream has the received event (events>=1).
    const eventsRes = await fetch(`${base}/api/v1/tasks/${task.task_id}/events`, { headers: auth });
    if (eventsRes.status !== 200) fail(`events returned ${eventsRes.status}`);
    const events = await eventsRes.json();
    if (events.ok !== true || !Array.isArray(events.events) || events.events.length < 1) {
      fail(`unexpected events body: ${JSON.stringify(events).slice(0, 200)}`);
    }
    if (events.events[0].kind !== 'task.received') fail('first event is not task.received');

    await stopServer();
    rmSync(tmpRoot, { recursive: true, force: true });
    // The §12 gate string — stdout carries exactly this line.
    console.log(SMOKE_OK);
    process.exitCode = 0;
  } catch (e) {
    await stopServer();
    fail(e?.message ?? String(e));
  }
}

main().catch(async (e) => {
  fail(e?.message ?? String(e));
});
