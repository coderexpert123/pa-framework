import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'node:child_process';
import { existsSync } from 'fs';
import { cleanup } from './helpers.js';
import { sessionBusAddress } from '../src/lib/bus-queue.js';
import { repoRootFromModule } from '../src/lib/git-root.js';

// AI-255 WP-B gate: the REAL hook script, spawned with stdin payloads and an
// env-injected PA_HOME. The peek-deliver-ack contract only means anything if
// the script itself honors it — unit-shimming the hook would test a fiction.

const HOOK = join(__dirname, '..', '..', 'scripts', 'hooks', 'bus-inject-claude.py');
const HOOK_GEMINI = join(__dirname, '..', '..', 'scripts', 'hooks', 'bus-inject-gemini.py');
const PYTHON = process.env.PA_TEST_PYTHON || 'python';

interface HookResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runHook(paHome: string, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<HookResult> {
  return runHookFile(HOOK, paHome, payload, extraEnv);
}

function runHookFile(hookPath: string, paHome: string, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): Promise<HookResult> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PA_HOME: paHome,
      PA_BUS_SESSION: 'test-session-key',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    // Provider-env hygiene: the hook detects its CLI family from env — a
    // devin-launched test would inherit CHISEL_SESSION_DB and self-address
    // as devin@…, not the claude path under test. extraEnv applies LAST so
    // a test can deliberately set e.g. PA_WORKER_DISPATCH_ID.
    for (const k of ['PA_WORKER', 'PA_WORKER_DISPATCH_ID', 'PA_WORKER_RESOURCE',
      'OPENCODE', 'OPENCODE_PID',
      'ANTIGRAVITY_AGENT', 'CHISEL_SESSION_DB', 'CODEX_CLI_PATH',
      'GEMINI_SESSION_ID', 'GEMINI_CLI_PATH', 'PA_BUS_ADDRESS']) {
      delete env[k];
    }
    Object.assign(env, extraEnv);
    const child = spawn(PYTHON, [hookPath], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function emitted(res: HookResult): { hookEventName: string; additionalContext: string } | null {
  const line = res.stdout.trim();
  if (!line) return null;
  const parsed = JSON.parse(line);
  return parsed?.hookSpecificOutput ?? null;
}

/** Seed one envelope on an address's queue (the queue file IS the store). */
async function seedQueue(paHome: string, address: string, env: Record<string, unknown>): Promise<void> {
  const qf = join(paHome, 'queues', `${address.replace(/:/g, '+')}.jsonl`);
  await mkdir(join(paHome, 'queues'), { recursive: true });
  await writeFile(qf, `${JSON.stringify(env)}\n`, 'utf8');
}

const queuePathOf = (paHome: string, address: string) =>
  join(paHome, 'queues', `${address.replace(/:/g, '+')}.jsonl`);
const cursorPathOf = (paHome: string, address: string) =>
  join(paHome, 'queues', `${address.replace(/:/g, '+')}.cursor.json`);

describe('bus-inject-claude.py — AI-255 peek-deliver-ack (real spawned hook)', () => {
  let paHome: string;
  let repoRoot: string;
  let selfAddr: string;

  beforeEach(async () => {
    paHome = await mkdtemp(join(tmpdir(), 'pa-bushook-'));
    repoRoot = await repoRootFromModule(__filename);
    // The hook derives the repo slug from the git root's directory NAME
    // (bus-inject-claude.py _repo_slug), so a worktree checkout like
    // C:/wt/gate-push self-addresses as claude@gate-push — derive, don't
    // hardcode, or this suite only passes in a dir named personal-assistant.
    const slug = repoRoot.split(/[\\/]/).pop()!.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    selfAddr = sessionBusAddress(`claude@${slug}`, 'test-session-key');
  });

  afterEach(async () => {
    await cleanup(paHome);
  });

  it('Stop peeks the oldest undelivered envelope and NEVER consumes it', async () => {
    const env = { id: 'bus-peek0001', from: 'devin@x#1', to: selfAddr, ts: new Date().toISOString(), hops: 0, body: 'read me but keep me', hash: 'h1' };
    await seedQueue(paHome, selfAddr, env);

    const res = await runHook(paHome, { hook_event_name: 'Stop', session_id: 's-1', cwd: repoRoot });
    assert.equal(res.code, 0, res.stderr);
    const out = emitted(res);
    assert.ok(out, 'hook emitted context');
    assert.equal(out.hookEventName, 'Stop');
    assert.ok(out.additionalContext.includes('bus-peek0001'), 'envelope id injected');
    assert.ok(out.additionalContext.includes('read me but keep me'), 'body injected');
    assert.ok(out.additionalContext.includes('NOT consumed'), 'peek semantics stated');
    assert.ok(out.additionalContext.includes('UNTRUSTED'), 'untrusted-payload warning present');

    const queue = await readFile(queuePathOf(paHome, selfAddr), 'utf8');
    assert.ok(queue.includes('bus-peek0001'), 'envelope still queued — the hook does not consume');

    const cursor = JSON.parse(await readFile(cursorPathOf(paHome, selfAddr), 'utf8'));
    assert.deepEqual(cursor.delivered, ['bus-peek0001'], 'delivered ring recorded');
  });

  it('a second Stop is silent — delivery stamps readBy so nothing is unread', async () => {
    const env = { id: 'bus-seen0002', from: 'devin@x#1', to: selfAddr, ts: new Date().toISOString(), hops: 0, body: 'already shown', hash: 'h2' };
    await seedQueue(paHome, selfAddr, env);

    const first = await runHook(paHome, { hook_event_name: 'Stop', session_id: 's-1', cwd: repoRoot });
    assert.ok(emitted(first)?.additionalContext.includes('bus-seen0002'));

    const second = await runHook(paHome, { hook_event_name: 'Stop', session_id: 's-1', cwd: repoRoot });
    assert.equal(second.stdout.trim(), '', 'no re-injection and no nudge — the delivered envelope is read');
  });

  it('SessionEnd takes the peek-deliver path and echoes the real event name', async () => {
    // agy's session-close event is SessionEnd (HOOK_ON_SESSION_END); the bus
    // hooks stamp PA_HOOK_EVENT because agy payloads carry no
    // hook_event_name. Deliver semantics must match Stop AND the echoed
    // hookEventName must be 'SessionEnd', not the literal 'Stop'.
    const env = { id: 'bus-send0005', from: 'devin@x#1', to: selfAddr, ts: new Date().toISOString(), hops: 0, body: 'close-out delivery', hash: 'h5' };
    await seedQueue(paHome, selfAddr, env);

    const res = await runHook(paHome, { session_id: 's-1', cwd: repoRoot }, { PA_HOOK_EVENT: 'SessionEnd' });
    assert.equal(res.code, 0, res.stderr);
    const out = emitted(res);
    assert.ok(out, 'hook emitted context');
    assert.equal(out.hookEventName, 'SessionEnd', 'real event echoed back, not Stop');
    assert.ok(out.additionalContext.includes('bus-send0005'), 'envelope id injected');
    assert.ok(out.additionalContext.includes('close-out delivery'), 'body injected');
    const queue = await readFile(queuePathOf(paHome, selfAddr), 'utf8');
    assert.ok(queue.includes('bus-send0005'), 'envelope still queued — peek semantics');
    const cursor = JSON.parse(await readFile(cursorPathOf(paHome, selfAddr), 'utf8'));
    assert.deepEqual(cursor.delivered, ['bus-send0005'], 'delivered ring recorded');
  });

  it('oversize bodies truncate with an explicit fetch instruction — no silent loss', async () => {
    const big = 'X'.repeat(5000);
    const env = { id: 'bus-big00003', from: 'devin@x#1', to: selfAddr, ts: new Date().toISOString(), hops: 0, body: big, hash: 'h3' };
    await seedQueue(paHome, selfAddr, env);

    const res = await runHook(paHome, { hook_event_name: 'Stop', session_id: 's-1', cwd: repoRoot });
    const out = emitted(res);
    assert.ok(out);
    assert.ok(out.additionalContext.includes('TRUNCATED'), 'explicit truncation marker');
    assert.ok(out.additionalContext.includes(`pa bus inbox ${selfAddr}`), 'fetch instruction names the inbox command');
    assert.ok(out.additionalContext.length <= 1200, 'injection stays inside the context budget');
  });

  it('PostToolUse injects the pending count and never consumes', async () => {
    const env = { id: 'bus-ptu00004', from: 'devin@x#1', to: selfAddr, ts: new Date().toISOString(), hops: 0, body: 'waiting', hash: 'h4' };
    await seedQueue(paHome, selfAddr, env);

    const res = await runHook(paHome, { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: repoRoot });
    const out = emitted(res);
    assert.equal(out?.hookEventName, 'PostToolUse');
    assert.ok(out?.additionalContext.includes('1 pending message(s)'), 'count injected');
    const queue = await readFile(queuePathOf(paHome, selfAddr), 'utf8');
    assert.ok(queue.includes('bus-ptu00004'), 'message left for explicit consume');
  });

  it('registers the discriminated address with nativeSessionId + the session pid', async () => {
    const res = await runHook(paHome, { hook_event_name: 'PostToolUse', session_id: 'native-abc', cwd: repoRoot });
    assert.equal(res.code, 0, res.stderr);
    const reg = JSON.parse(await readFile(join(paHome, 'queues', 'registry.json'), 'utf8'));
    const entry = reg[selfAddr];
    assert.ok(entry, `registry gained ${selfAddr}`);
    assert.deepEqual(entry.capabilities, ['hooks']);
    assert.equal(entry.worker, 'claude');
    assert.equal(entry.nativeSessionId, 'native-abc');
    assert.equal(typeof entry.pid, 'number', 'session pid recorded (hook parent, not the subprocess)');
  });

  it('registers under opencode@ when the OPENCODE ambient marker is set', async () => {
    // opencode sessions export OPENCODE=1 live; the hook must self-address
    // as opencode@…, never the claude default.
    const res = await runHook(paHome, { hook_event_name: 'PostToolUse', session_id: 'op-sess-1', cwd: repoRoot }, { OPENCODE: '1' });
    assert.equal(res.code, 0, res.stderr);
    const reg = JSON.parse(await readFile(join(paHome, 'queues', 'registry.json'), 'utf8'));
    const slug = repoRoot.split(/[\\/]/).pop()!.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    const opAddr = sessionBusAddress(`opencode@${slug}`, 'test-session-key');
    const entry = reg[opAddr];
    assert.ok(entry, `registry gained ${opAddr}`);
    assert.equal(entry.worker, 'opencode');
    assert.equal(entry.nativeSessionId, 'op-sess-1');
  });

  it('PA-dispatched workers no-op entirely — no registration, no injection', async () => {
    const res = await runHook(paHome, { hook_event_name: 'Stop', session_id: 's-1', cwd: repoRoot }, { PA_WORKER_DISPATCH_ID: 'd-1' });
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trim(), '', 'no output for fleet workers');
    assert.equal(existsSync(join(paHome, 'queues', 'registry.json')), false, 'worker fire registered nothing');
  });

  it('PA_BUS_ADDRESS pins the self address verbatim (drain-spawned worker contract)', async () => {
    const res = await runHook(paHome, { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: repoRoot }, { PA_BUS_ADDRESS: 'pinned@repo#7' });
    assert.equal(res.code, 0, res.stderr);
    const reg = JSON.parse(await readFile(join(paHome, 'queues', 'registry.json'), 'utf8'));
    assert.ok(reg['pinned@repo#7'], 'the pinned address registered');
    assert.equal(reg[selfAddr], undefined, 'the derived address was NOT used');
  });

  it('refreshes HOLDER.beat on a test lock this session owns (AI-255 C1)', async () => {
    // The hook fires per tool call — the beat is free liveness evidence for
    // testlock --remove-stale. PA_BUS_ADDRESS pins identity so HOLDER.session
    // matches one of the hook's known labels.
    const lockDir = await mkdtemp(join(tmpdir(), 'pa-testlock-beat-'));
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeFile(
      join(lockDir, 'HOLDER'),
      JSON.stringify({ session: 'pinned@repo#7', pid: 1, at: old, beat: old }) + '\n',
      'utf8'
    );

    const res = await runHook(
      paHome,
      { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: repoRoot },
      { PA_BUS_ADDRESS: 'pinned@repo#7', PA_TESTLOCK_DIR: lockDir }
    );
    assert.equal(res.code, 0, res.stderr);
    const holder = JSON.parse(await readFile(join(lockDir, 'HOLDER'), 'utf8'));
    const beatMs = Date.parse(holder.beat);
    assert.ok(Date.now() - beatMs < 60_000, `beat refreshed (got ${holder.beat})`);
    assert.equal(holder.session, 'pinned@repo#7', 'holder fields preserved');
    await cleanup(lockDir);
  });

  it('does NOT touch a HOLDER owned by another session', async () => {
    const lockDir = await mkdtemp(join(tmpdir(), 'pa-testlock-beat-'));
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeFile(
      join(lockDir, 'HOLDER'),
      JSON.stringify({ session: 'someone-else', pid: 1, at: old, beat: old }) + '\n',
      'utf8'
    );

    const res = await runHook(
      paHome,
      { hook_event_name: 'PostToolUse', session_id: 's-1', cwd: repoRoot },
      { PA_BUS_ADDRESS: 'pinned@repo#7', PA_TESTLOCK_DIR: lockDir }
    );
    assert.equal(res.code, 0, res.stderr);
    const holder = JSON.parse(await readFile(join(lockDir, 'HOLDER'), 'utf8'));
    assert.equal(holder.beat, old, 'a foreign holder\u2019s beat is never refreshed');
    await cleanup(lockDir);
  });
});

// AI-272: the hooks must treat an envelope whose readBy contains the session's
// own address as READ — excluded from pending counts, "(k new)" math and Stop
// delivery — and Stop/SessionEnd/AfterAgent delivery must stamp self into
// readBy. Cases a–f run against BOTH inject hooks (same contract, different
// event names).
describe('bus-inject hooks — AI-272 readBy receipts (real spawned hooks)', () => {
  let paHome: string;
  let repoRoot: string;

  const ARMS = [
    { name: 'claude', hook: HOOK, pendingEvent: 'PostToolUse', deliverEvent: 'Stop' },
    { name: 'gemini', hook: HOOK_GEMINI, pendingEvent: 'AfterTool', deliverEvent: 'AfterAgent' },
  ];

  beforeEach(async () => {
    paHome = await mkdtemp(join(tmpdir(), 'pa-bushook-'));
    repoRoot = await repoRootFromModule(__filename);
  });

  afterEach(async () => {
    await cleanup(paHome);
  });

  const slugOf = (root: string) => root.split(/[\\/]/).pop()!.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  const selfAddrFor = (provider: string) =>
    sessionBusAddress(`${provider}@${slugOf(repoRoot)}`, 'test-session-key');
  const envFor = (id: string, to: string, extra: Record<string, unknown> = {}) => ({
    id, from: 'devin@x#1', to, ts: new Date().toISOString(), hops: 0,
    body: `body-${id}`, hash: `h-${id}`, ...extra,
  });
  const queueLines = async (addr: string) =>
    (await readFile(queuePathOf(paHome, addr), 'utf8')).split('\n').filter((l) => l.trim());

  for (const arm of ARMS) {
    const run = (payload: Record<string, unknown>, extraEnv: Record<string, string> = {}) =>
      runHookFile(arm.hook, paHome, payload, extraEnv);

    it(`[${arm.name}] (a) ${arm.pendingEvent} prints nothing when the only envelope is already read by self`, async () => {
      const self = selfAddrFor(arm.name);
      await seedQueue(paHome, self, envFor('bus-aaa00001', self, { readBy: [self] }));
      const res = await run({ hook_event_name: arm.pendingEvent, session_id: 's-1', cwd: repoRoot });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout.trim(), '', 'an envelope read by this session is not pending');
    });

    it(`[${arm.name}] (b) ${arm.pendingEvent} counts only envelopes unread by self`, async () => {
      const self = selfAddrFor(arm.name);
      const qf = queuePathOf(paHome, self);
      await mkdir(join(paHome, 'queues'), { recursive: true });
      await writeFile(
        qf,
        JSON.stringify(envFor('bus-bbb00001', self, { readBy: [self] })) + '\n' +
        JSON.stringify(envFor('bus-bbb00002', self)) + '\n',
        'utf8',
      );
      const res = await run({ hook_event_name: arm.pendingEvent, session_id: 's-1', cwd: repoRoot });
      const out = emitted(res);
      assert.ok(out, 'unread mail is announced');
      assert.ok(out.additionalContext.includes('1 pending message(s)'), `expected 1 pending, got: ${out.additionalContext}`);
    });

    it(`[${arm.name}] (c) ${arm.deliverEvent} prints nothing when every envelope is read by self`, async () => {
      const self = selfAddrFor(arm.name);
      await seedQueue(paHome, self, envFor('bus-ccc00001', self, { readBy: [self] }));
      const res = await run({ hook_event_name: arm.deliverEvent, session_id: 's-1', cwd: repoRoot });
      assert.equal(res.code, 0, res.stderr);
      assert.equal(res.stdout.trim(), '', 'read-by-self mail is not re-delivered');
    });

    it(`[${arm.name}] (d) ${arm.deliverEvent} skips a self-read envelope and delivers the next unread one`, async () => {
      const self = selfAddrFor(arm.name);
      const qf = queuePathOf(paHome, self);
      await mkdir(join(paHome, 'queues'), { recursive: true });
      await writeFile(
        qf,
        // Older envelope already read by self sits FIRST — queue order must not
        // resurrect it ahead of the genuinely unread one.
        JSON.stringify(envFor('bus-ddd00001', self, { readBy: [self] })) + '\n' +
        JSON.stringify(envFor('bus-ddd00002', self, { readBy: ['someone-else@x#9'] })) + '\n',
        'utf8',
      );
      const res = await run({ hook_event_name: arm.deliverEvent, session_id: 's-1', cwd: repoRoot });
      const out = emitted(res);
      assert.ok(out, 'the unread envelope is delivered');
      assert.ok(out.additionalContext.includes('bus-ddd00002'), 'delivers the unread envelope');
      assert.ok(!out.additionalContext.includes('bus-ddd00001'), 'the self-read envelope is skipped');
      assert.ok(!out.additionalContext.includes('body-bus-ddd00001'), 'its body is not injected either');
      // And the delivered envelope gained a self receipt.
      const lines = await queueLines(self);
      const deliveredEnv = JSON.parse(lines.find((l) => l.includes('bus-ddd00002'))!);
      assert.ok(deliveredEnv.readBy.includes(self), 'delivery stamps a self readBy receipt');
    });

    it(`[${arm.name}] (e) ${arm.deliverEvent} stamps self into readBy, preserving other fields and lines`, async () => {
      const self = selfAddrFor(arm.name);
      const qf = queuePathOf(paHome, self);
      await mkdir(join(paHome, 'queues'), { recursive: true });
      const e1 = envFor('bus-eee00001', self, { reply_to: 'bus-parent', body: 'deliver and mark me' });
      const e2 = envFor('bus-eee00002', self, { body: 'do not touch' });
      const e2Line = JSON.stringify(e2);
      await writeFile(qf, `${JSON.stringify(e1)}\n${e2Line}\n`, 'utf8');

      const res = await run({ hook_event_name: arm.deliverEvent, session_id: 's-1', cwd: repoRoot });
      assert.equal(res.code, 0, res.stderr);
      assert.ok(emitted(res)?.additionalContext.includes('bus-eee00001'), 'envelope delivered');

      const lines = await queueLines(self);
      assert.equal(lines.length, 2, 'both envelopes remain queued');
      const stamped = JSON.parse(lines.find((l) => l.includes('bus-eee00001'))!);
      assert.deepEqual(stamped.readBy, [self], 'self receipt stamped');
      assert.equal(stamped.body, 'deliver and mark me', 'body preserved');
      assert.equal(stamped.reply_to, 'bus-parent', 'other fields preserved');
      assert.equal(stamped.hash, e1.hash, 'hash preserved');
      const otherLine = lines.find((l) => l.includes('bus-eee00002'))!;
      assert.equal(otherLine, e2Line, 'other lines byte-identical');
    });

    it(`[${arm.name}] (f) a second ${arm.deliverEvent} after delivery prints nothing`, async () => {
      const self = selfAddrFor(arm.name);
      await seedQueue(paHome, self, envFor('bus-fff00001', self));

      const first = await run({ hook_event_name: arm.deliverEvent, session_id: 's-1', cwd: repoRoot });
      assert.ok(emitted(first)?.additionalContext.includes('bus-fff00001'), 'first fire delivers');

      const second = await run({ hook_event_name: arm.deliverEvent, session_id: 's-1', cwd: repoRoot });
      assert.equal(second.stdout.trim(), '', 'delivered mail is read mail — silence, no nudge');
    });
  }
});
