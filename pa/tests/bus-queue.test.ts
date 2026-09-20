import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { paHome } from '../src/paths.js';
import {
  BUS_MAX_BODY_CHARS,
  BUS_DELIVERED_RING,
  validateAddress,
  validateBody,
  busQueuePath,
  busCursorPath,
  busRegistryPath,
  sendBusMessage,
  deliverBusMessage,
  sessionBusAddress,
  markBusDelivered,
  listBusMessages,
  peekBusMessage,
  peekBusMessages,
  ackBusMessage,
  popBusMessage,
  touchBusCursor,
  readBusCursor,
  registerBusAddress,
  markBusRead,
  resolveSessionBusAddress,
  detectBusProvider,
  readBusRegistry,
  pruneBusQueue,
  _resetBusQueueForTest,
  type BusEnvelope,
} from '../src/lib/bus-queue.js';
import { busCommand } from '../src/commands/bus.js';
import type { ExecFn } from '../src/process-tree.js';

describe('bus-queue', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    _resetBusQueueForTest();
  });

  afterEach(async () => {
    _resetBusQueueForTest();
    await cleanup(dir);
  });

  it('validateAddress accepts the five address forms and rejects garbage', () => {
    const valid = [
      'claude@personal-assistant', // provider@repo (human-started, cwd-derived)
      'devin:tt-abc123', //           provider:task-id (dispatcher-assigned)
      'gemini:profile', //           provider:profile (durable headless mailbox)
      'topic:13052', //              topic:<id> (telegram)
      'chan:voice-inbox', //         chan:<name>
      'claude@personal-assistant#1', // registry collision discriminator
    ];
    for (const addr of valid) {
      assert.deepEqual(validateAddress(addr), { ok: true }, addr);
    }
    const invalid = [
      '',
      '   ',
      'noseparator',
      '@missing-name',
      ':missing-name',
      'name@',
      'name:',
      'has space@repo',
      'a@b/c',
      'a@@b',
      'a:b:c',
      'a@b#x',
      'a@b#',
      '1name@repo', // name must start with a letter
      `a@${'x'.repeat(65)}`, // slug over 64 chars
    ];
    for (const addr of invalid) {
      assert.equal(validateAddress(addr).ok, false, addr);
    }
  });

  it('validateBody rejects empty/oversize bodies and accepts normal', () => {
    assert.equal(
      (validateBody('') as { ok: false; error: string }).error,
      'bus.body must not be empty',
    );
    assert.equal(validateBody('   ').ok, false);
    const over = validateBody('x'.repeat(BUS_MAX_BODY_CHARS + 1));
    assert.equal(
      (over as { ok: false; error: string }).error,
      `bus.body exceeds ${BUS_MAX_BODY_CHARS} characters`,
    );
    assert.deepEqual(validateBody('x'.repeat(BUS_MAX_BODY_CHARS)), { ok: true });
    // multiline bodies are legal — JSONL escaping keeps one envelope per line
    assert.deepEqual(validateBody('line one\nline two'), { ok: true });
  });

  it('sendBusMessage appends one envelope; listBusMessages returns it', async () => {
    const { id, deduped } = await sendBusMessage({
      from: 'cli@alpha',
      to: 'devin:task-1',
      body: 'hello bus',
    });
    assert.equal(deduped, false);
    assert.match(id, /^bus-[0-9a-f]{12}$/);

    const msgs = await listBusMessages('devin:task-1');
    assert.equal(msgs.length, 1);
    const env = msgs[0];
    assert.equal(env.id, id);
    assert.equal(env.from, 'cli@alpha');
    assert.equal(env.to, 'devin:task-1');
    assert.equal(env.body, 'hello bus');
    assert.equal(env.hops, 0);
    assert.equal(env.reply_to, undefined);
    assert.match(env.hash, /^[0-9a-f]{16}$/);
    assert.ok(!Number.isNaN(Date.parse(env.ts)), 'ts is ISO 8601');

    // On disk: one JSON object per line at the frozen path.
    const path = busQueuePath('devin:task-1');
    assert.equal(path, join(paHome(), 'queues', 'devin+task-1.jsonl'));
    const lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]) as BusEnvelope).id, id);
  });

  it('dedups by content hash; a different reply_to does NOT dedup', async () => {
    const first = await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'same body' });
    const again = await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'same body' });
    assert.equal(again.deduped, true);
    assert.equal(again.id, first.id);
    assert.equal((await listBusMessages('devin:b')).length, 1);

    // A reply carrying the same body but a reply_to hashes differently.
    const reply = await sendBusMessage({
      from: 'cli@a',
      to: 'devin:b',
      body: 'same body',
      reply_to: first.id,
    });
    assert.equal(reply.deduped, false);
    assert.notEqual(reply.id, first.id);
    const msgs = await listBusMessages('devin:b');
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].reply_to, first.id);
  });

  it('popBusMessage returns FIFO oldest, removes it, second pop returns next', async () => {
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'one' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'two' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'three' });

    const first = await popBusMessage('devin:b');
    assert.equal(first?.body, 'one');
    // The remainder is persisted before pop returns.
    const raw = (await readFile(busQueuePath('devin:b'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim());
    assert.equal(raw.length, 2);

    assert.equal((await popBusMessage('devin:b'))?.body, 'two');
    assert.equal((await popBusMessage('devin:b'))?.body, 'three');
    assert.equal(await popBusMessage('devin:b'), null);
  });

  it('popBusMessage on an empty queue returns null', async () => {
    assert.equal(await popBusMessage('devin:nothing'), null);
    assert.deepEqual(await listBusMessages('devin:nothing'), []);
  });

  it('peekBusMessage returns oldest without consuming; ackBusMessage removes it', async () => {
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'one' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'two' });

    const p1 = await peekBusMessage('devin:b');
    assert.equal(p1?.body, 'one');
    const p2 = await peekBusMessage('devin:b');
    assert.equal(p2?.id, p1?.id, 'second peek returns the same envelope — not consumed');
    assert.equal((await listBusMessages('devin:b')).length, 2);

    await ackBusMessage('devin:b', p1!.id);
    const p3 = await peekBusMessage('devin:b');
    assert.equal(p3?.body, 'two', 'after ack the next envelope surfaces');
    assert.equal((await listBusMessages('devin:b')).length, 1);
  });

  it('ackBusMessage on an absent id throws', async () => {
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'one' });
    await assert.rejects(
      ackBusMessage('devin:b', 'bus-000000000000'),
      /no bus message with id bus-000000000000/,
    );
    // The real envelope is untouched.
    assert.equal((await listBusMessages('devin:b')).length, 1);
  });

  it('touchBusCursor writes the cursor; readBusCursor returns it; absent → null', async () => {
    assert.equal(await readBusCursor('devin:b'), null);
    assert.equal(
      busCursorPath('devin:b'),
      join(paHome(), 'queues', 'devin+b.cursor.json'),
    );

    await touchBusCursor('devin:b', 'wait', 4242);
    const c1 = await readBusCursor('devin:b');
    assert.equal(c1?.last_event, 'wait');
    assert.equal(c1?.pid, 4242);
    assert.ok(c1?.last_event_at && !Number.isNaN(Date.parse(c1.last_event_at)));

    // A touch without a pid preserves the previous one.
    await touchBusCursor('devin:b', 'inbox');
    const c2 = await readBusCursor('devin:b');
    assert.equal(c2?.last_event, 'inbox');
    assert.equal(c2?.pid, 4242, 'pid survives a touch that does not restamp it');
  });

  it('registerBusAddress writes a registry entry; a colliding profile mints #1', async () => {
    const r1 = await registerBusAddress('claude@repo', { capabilities: ['hooks'] });
    assert.deepEqual(r1, { address: 'claude@repo' });
    assert.equal(busRegistryPath(), join(paHome(), 'queues', 'registry.json'));

    // Same profile re-registers idempotently — no discriminator minted.
    const r2 = await registerBusAddress('claude@repo', { capabilities: ['hooks'] });
    assert.deepEqual(r2, { address: 'claude@repo' });

    // A different profile claiming the same address is a collision → #1.
    const r3 = await registerBusAddress('claude@repo', {
      capabilities: ['acp'],
      spawn: { worker: 'agy' },
    });
    assert.deepEqual(r3, { address: 'claude@repo#1', discriminator: 1 });

    const registry = await readBusRegistry();
    assert.ok(registry['claude@repo'], 'base address registered');
    assert.ok(registry['claude@repo#1'], 'discriminated address registered');
    const entry = registry['claude@repo'] as { capabilities: string[] };
    assert.deepEqual(entry.capabilities, ['hooks']);
  });

  it('pruneBusQueue removes envelopes older than the window and keeps recent', async () => {
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'fresh' });
    const stale: BusEnvelope = {
      id: 'bus-stale0000001',
      from: 'cli@a',
      to: 'devin:b',
      ts: new Date(Date.now() - 48 * 60 * 60_000).toISOString(),
      hops: 0,
      body: 'stale',
      hash: 'deadbeefdeadbeef',
    };
    await appendFile(busQueuePath('devin:b'), `${JSON.stringify(stale)}\n`, 'utf8');

    const res = await pruneBusQueue('devin:b', { maxAgeMs: 24 * 60 * 60_000 });
    assert.equal(res.pruned, 1);
    const msgs = await listBusMessages('devin:b');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body, 'fresh');

    // Second prune is a no-op.
    assert.deepEqual(await pruneBusQueue('devin:b'), { pruned: 0 });
  });

  it('popBusMessage and peekBusMessage throw on a corrupt queue file', async () => {
    await mkdir(dirname(busQueuePath('devin:b')), { recursive: true });
    await writeFile(busQueuePath('devin:b'), '{not json\n', 'utf8');
    await assert.rejects(popBusMessage('devin:b'), /bus queue is corrupt/);
    await assert.rejects(peekBusMessage('devin:b'), /bus queue is corrupt/);
  });

  it('peekBusMessages returns the oldest N in file order without consuming', async () => {
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'one' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'two' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'three' });

    const two = await peekBusMessages('devin:b', 2);
    assert.equal(two.length, 2);
    assert.equal(two[0].body, 'one');
    assert.equal(two[1].body, 'two');
    assert.equal((await listBusMessages('devin:b')).length, 3, 'a peek batch consumes nothing');

    const all = await peekBusMessages('devin:b', 10);
    assert.equal(all.length, 3, 'a limit above the queue length returns all');
  });

  it('peekBusMessages clamps non-positive limits to 1 and reads a missing file as []', async () => {
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'one' });
    await sendBusMessage({ from: 'cli@a', to: 'devin:b', body: 'two' });

    const zero = await peekBusMessages('devin:b', 0);
    assert.equal(zero.length, 1);
    assert.equal(zero[0].body, 'one', 'a clamped read returns the oldest');
    assert.equal((await peekBusMessages('devin:b', -3)).length, 1);
    assert.deepEqual(await peekBusMessages('devin:absent', 5), []);
  });

  it('peekBusMessages throws on a corrupt queue file', async () => {
    await mkdir(dirname(busQueuePath('devin:b')), { recursive: true });
    await writeFile(busQueuePath('devin:b'), '{not json\n', 'utf8');
    await assert.rejects(peekBusMessages('devin:b', 5), /bus queue is corrupt/);
  });

  it('listBusMessages fails to empty on absent or corrupt queue files', async () => {
    assert.deepEqual(await listBusMessages('devin:absent'), []);
    await mkdir(dirname(busQueuePath('devin:b')), { recursive: true });
    await writeFile(busQueuePath('devin:b'), '{not json\n', 'utf8');
    assert.deepEqual(await listBusMessages('devin:b'), []);
    // An invalid address reads as empty too — read paths never throw.
    assert.deepEqual(await listBusMessages('not an address'), []);
  });
});

describe('bus-queue — AI-255 per-session discriminators + fan-out', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    _resetBusQueueForTest();
  });

  afterEach(async () => {
    _resetBusQueueForTest();
    await cleanup(dir);
  });

  it('sessionBusAddress is deterministic, numeric-discriminated, key-sensitive', () => {
    const a1 = sessionBusAddress('devin@repo', 'session-A');
    assert.match(a1, /^devin@repo#\d+$/, 'base#<n> form');
    assert.equal(a1, sessionBusAddress('devin@repo', 'session-A'), 'stable for the same key');
    assert.notEqual(a1, sessionBusAddress('devin@repo', 'session-B'), 'distinct keys discriminate');
    assert.equal(validateAddress(a1).ok, true, 'validates under the address grammar');
  });

  it('deliverBusMessage fans a bare base address out to every LIVE discriminated child', async () => {
    const a1 = sessionBusAddress('claude@repo', 'sess-1');
    const a2 = sessionBusAddress('claude@repo', 'sess-2');
    await registerBusAddress(a1, { capabilities: ['hooks'], worker: 'claude' });
    await registerBusAddress(a2, { capabilities: ['hooks'], worker: 'claude' });
    await touchBusCursor(a1, 'hook', 111);
    await touchBusCursor(a2, 'hook', 222);

    const res = await deliverBusMessage({ from: 'cli@x', to: 'claude@repo', body: 'broadcast' });
    assert.deepEqual(res.delivered?.sort(), [a1, a2].sort(), 'both live children received it');
    assert.equal((await listBusMessages(a1)).length, 1);
    assert.equal((await listBusMessages(a2)).length, 1);
    assert.deepEqual(await listBusMessages('claude@repo'), [], 'base queue stays empty on live fan-out');
    assert.equal(res.queuedForDrain, undefined);
  });

  it('a stale child cursor is not live — the message queues at the base for the drain', async () => {
    const stale = sessionBusAddress('claude@repo', 'sess-stale');
    await registerBusAddress(stale, { capabilities: ['hooks'], worker: 'claude' });
    await mkdir(dirname(busCursorPath(stale)), { recursive: true });
    await writeFile(
      busCursorPath(stale),
      JSON.stringify({ last_event: 'hook', last_event_at: new Date(Date.now() - 10 * 60_000).toISOString(), pid: 1 }),
      'utf8',
    );

    const res = await deliverBusMessage({ from: 'cli@x', to: 'claude@repo', body: 'offline delivery' });
    assert.equal(res.queuedForDrain, true, 'reports the offline-mailbox outcome');
    assert.equal((await listBusMessages(stale)).length, 0, 'stale child not written');
    assert.equal((await listBusMessages('claude@repo')).length, 1, 'base queue is the offline mailbox');
  });

  it('deliverBusMessage appends directly to # / : / topic: / chan: addresses', async () => {
    const direct = sessionBusAddress('claude@repo', 'sess-direct');
    const r1 = await deliverBusMessage({ from: 'cli@x', to: direct, body: 'direct' });
    assert.equal(r1.delivered, undefined);
    assert.equal((await listBusMessages(direct)).length, 1);

    const r2 = await deliverBusMessage({ from: 'cli@x', to: 'topic:13052', body: 'topic mail' });
    assert.equal(r2.delivered, undefined);
    assert.equal((await listBusMessages('topic:13052')).length, 1);
  });

  it('deliverBusMessage reports delivered addresses so send output can be truthful', async () => {
    const a1 = sessionBusAddress('agy@repo', 'sess-1');
    await registerBusAddress(a1, { capabilities: ['hooks'], worker: 'agy' });
    await touchBusCursor(a1, 'hook', 333);
    const res = await deliverBusMessage({ from: 'cli@x', to: 'agy@repo', body: 'hi' });
    assert.deepEqual(res.delivered, [a1]);
    assert.ok(res.id.startsWith('bus-'));
  });

  it('markBusDelivered ring-records ids and preserves cursor liveness fields', async () => {
    const addr = sessionBusAddress('claude@repo', 'sess-ring');
    await touchBusCursor(addr, 'hook', 777);
    await markBusDelivered(addr, ['bus-aaa', 'bus-bbb']);

    const cur = await readBusCursor(addr);
    assert.deepEqual(cur?.delivered, ['bus-aaa', 'bus-bbb']);
    assert.equal(cur?.last_event, 'hook', 'liveness event preserved');
    assert.equal(cur?.pid, 777, 'pid preserved');

    await markBusDelivered(addr, ['bus-aaa', 'bus-ccc']);
    const cur2 = await readBusCursor(addr);
    assert.deepEqual(cur2?.delivered, ['bus-aaa', 'bus-bbb', 'bus-ccc'], 'dup id is a no-op');
  });

  it('markBusDelivered keeps only the last BUS_DELIVERED_RING ids', async () => {
    const addr = sessionBusAddress('claude@repo', 'sess-cap');
    const ids = Array.from({ length: BUS_DELIVERED_RING + 5 }, (_, i) => `bus-${i}`);
    await markBusDelivered(addr, ids);
    const cur = await readBusCursor(addr);
    assert.equal(cur?.delivered?.length, BUS_DELIVERED_RING);
    assert.equal(cur?.delivered?.includes('bus-0'), false, 'oldest id evicted');
    assert.equal(cur?.delivered?.includes(`bus-${BUS_DELIVERED_RING + 4}`), true, 'newest id kept');
  });

  it('registerBusAddress persists nativeSessionId + pid; a re-register with new pid updates them', async () => {
    const addr = sessionBusAddress('claude@repo', 'sess-id');
    const r = await registerBusAddress(addr, {
      capabilities: ['hooks'], worker: 'claude', nativeSessionId: 'native-1', pid: 4242,
    });
    assert.deepEqual(r, { address: addr });
    let reg = await readBusRegistry();
    assert.equal(reg[addr]?.nativeSessionId, 'native-1');
    assert.equal(reg[addr]?.pid, 4242);

    // Same profile, new session pid (restart) → identity fields refresh, no discriminator.
    const r2 = await registerBusAddress(addr, {
      capabilities: ['hooks'], worker: 'claude', nativeSessionId: 'native-1', pid: 5555,
    });
    assert.deepEqual(r2, { address: addr });
    reg = await readBusRegistry();
    assert.equal(reg[addr]?.pid, 5555, 'pid updated on re-registration');
    assert.equal(reg[`${addr}#1`], undefined, 'no collision discriminator minted');
  });
});

describe('bus-queue — AI-261 whoami==hook parity (image-first host match)', () => {
  let dir: string;

  const HOST = 7000;

  beforeEach(async () => {
    dir = await createTempPaHome();
    _resetBusQueueForTest();
  });

  afterEach(async () => {
    _resetBusQueueForTest();
    await cleanup(dir);
  });

  /** Canned process tree: process.ppid → pwsh(5000) → cmd(6000) → claude.exe
   *  (7000, the session host). Answers both the win32 CIM shapes and the
   *  POSIX `ps` shapes so the test runs on the whole CI matrix. */
  function fakeTree(extra: Array<[number, { ppid: number; cmd: string }]> = []) {
    const table = new Map<number, { ppid: number; cmd: string }>([
      [process.ppid, { ppid: 5000, cmd: 'node dist\\tests\\run.js' }],
      [5000, { ppid: 6000, cmd: 'powershell.exe -NoProfile -Command python hook.py' }],
      [6000, { ppid: HOST, cmd: 'cmd.exe /c python "…\\bus-inject-claude.py"' }],
      [HOST, { ppid: 4, cmd: '"C:\\Program Files\\claude\\claude.exe"' }],
      [4, { ppid: 0, cmd: '' }],
      ...extra,
    ]);
    return async (cmd: string) => {
      if (cmd.includes('Get-CimInstance')) {
        const filter = [...cmd.matchAll(/ProcessId = (\d+)/g)].map((m) => Number(m[1]));
        const rows = [...table]
          .filter(([pid]) => filter.length === 0 || filter.includes(pid))
          .map(([pid, r]) => ({ ProcessId: pid, ParentProcessId: r.ppid, CommandLine: r.cmd }));
        return { stdout: JSON.stringify(rows), stderr: '' };
      }
      if (/-o pid=,command=/.test(cmd)) {
        const list = (/-p ([\d,]+)/.exec(cmd)?.[1] ?? '').split(',').map(Number);
        const out = [...table]
          .filter(([pid]) => list.includes(pid))
          .map(([pid, r]) => `${pid} ${r.cmd}`)
          .join('\n');
        return { stdout: out, stderr: '' };
      }
      const out = [...table].map(([pid, r]) => `${pid} ${r.ppid}`).join('\n');
      return { stdout: out, stderr: '' };
    };
  }

  async function seedRegistry(entries: Record<string, unknown>) {
    await mkdir(dirname(busRegistryPath()), { recursive: true });
    await writeFile(busRegistryPath(), JSON.stringify(entries), 'utf8');
  }

  it('whoami resolves the address the hook watches — freshest same-pid registration wins', async () => {
    const sid = 'session-native-42';
    const hookAddr = sessionBusAddress('claude@repo', sid); // exactly what the hook derives
    const staleAddr = sessionBusAddress('claude@repo', 'superseded-session-key');
    await seedRegistry({
      // Same host pid, older registration (session restarted / key changed)
      [staleAddr]: { capabilities: ['hooks'], worker: 'claude', pid: HOST, createdAt: '2020-01-01T00:00:00.000Z' },
      // The live registration — the hook's own address
      [hookAddr]: { capabilities: ['hooks'], worker: 'claude', pid: HOST, createdAt: '2026-09-17T00:00:00.000Z', nativeSessionId: sid },
      // A different session's registration on an unrelated pid — must not interfere
      'claude@repo#999': { capabilities: ['hooks'], worker: 'claude', pid: 31337, createdAt: '2026-09-16T00:00:00.000Z' },
    });

    const ident = await resolveSessionBusAddress({ provider: 'claude', repo: 'repo', execFn: fakeTree() });
    assert.equal(ident.address, hookAddr, 'whoami resolves the address the hook watches');
    assert.equal(ident.pid, HOST, 'claim records the real claude.exe host pid, not the shim');
    assert.equal(ident.via, 'registry-match');
  });

  it('a registered non-host ancestor pid cannot win over the true host image', async () => {
    // Pre-fix failure shape: a registration whose pid sits in the chain but is
    // NOT a claude.exe (a recycled pid or a stale hook-parent entry). The
    // image match must reach claude.exe 7000 and ignore it.
    const foreignAddr = 'claude@repo#1462237725';
    await seedRegistry({
      [foreignAddr]: { capabilities: ['hooks'], worker: 'claude', pid: 5000, createdAt: '2026-09-17T01:00:00.000Z' },
    });

    const ident = await resolveSessionBusAddress({ provider: 'claude', repo: 'repo', execFn: fakeTree() });
    assert.notEqual(ident.address, foreignAddr, 'the pwsh-registered row is not the session');
    assert.equal(ident.pid, HOST, 'the true host pid is still found');
    assert.equal(ident.via, 'ppid-fallback', 'no registration for pid 7000 → stable host-derived fallback');
    assert.equal(ident.address, sessionBusAddress('claude@repo', String(HOST)), 'fallback discriminant is the host pid — stable across calls');
  });

  it('kgclaude resolves the shared claude.exe host under its own provider base', async () => {
    // kgclaude is a wrapper around the same claude.exe — PROVIDER_HOST_IMAGE
    // maps it to the same image so the image-first host match still finds
    // pid 7000, while the provider label keeps its addresses distinct from
    // a plain claude session's.
    const sid = 'kg-session-7';
    const hookAddr = sessionBusAddress('kgclaude@repo', sid);
    const claudeAddr = 'claude@repo#555'; // a plain claude session must not win
    await seedRegistry({
      [claudeAddr]: { capabilities: ['hooks'], worker: 'claude', pid: 31337, createdAt: '2026-09-17T00:00:00.000Z' },
      [hookAddr]: { capabilities: ['hooks'], worker: 'kgclaude', pid: HOST, createdAt: '2026-09-17T00:00:00.000Z', nativeSessionId: sid },
    });

    const ident = await resolveSessionBusAddress({ provider: 'kgclaude', repo: 'repo', execFn: fakeTree() });
    assert.equal(ident.address, hookAddr, 'kgclaude resolves the address registered under kgclaude@');
    assert.equal(ident.pid, HOST, 'the claude.exe host is found via the shared image');
    assert.equal(ident.via, 'registry-match');
  });

  it('detectBusProvider returns opencode for the OPENCODE ambient marker', () => {
    // opencode sessions export OPENCODE=1 (+OPENCODE_PID) live; with every
    // other marker unset the provider must resolve to opencode, not cli.
    const keys = ['PA_BUS_PROVIDER', 'PA_WORKER', 'KGCLAUDE_SESSION', 'CLAUDECODE',
      'ANTIGRAVITY_AGENT', 'CHISEL_SESSION_DB', 'CODEX_CLI_PATH',
      'GEMINI_SESSION_ID', 'GEMINI_CLI_PATH', 'OPENCODE'];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) delete process.env[k];
    try {
      process.env.OPENCODE = '1';
      assert.equal(detectBusProvider(), 'opencode', 'OPENCODE=1 alone resolves opencode');
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('detectBusProvider ordering: OPENCODE first among ambient, pin still wins', () => {
    const keys = ['PA_BUS_PROVIDER', 'PA_WORKER', 'KGCLAUDE_SESSION', 'CLAUDECODE',
      'ANTIGRAVITY_AGENT', 'CHISEL_SESSION_DB', 'CODEX_CLI_PATH',
      'GEMINI_SESSION_ID', 'GEMINI_CLI_PATH', 'OPENCODE'];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) delete process.env[k];
    try {
      process.env.OPENCODE = '1';
      process.env.KGCLAUDE_SESSION = 'x';
      process.env.CLAUDECODE = '1';
      assert.equal(detectBusProvider(), 'opencode', 'live opencode marker shadows inherited foreign markers');
      process.env.PA_WORKER = 'devin';
      assert.equal(detectBusProvider(), 'devin', 'explicit PA_WORKER pin outranks ambient');
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('opencode resolves the opencode.exe host under its own provider base', async () => {
    // PROVIDER_HOST_IMAGE maps opencode to opencode.exe so the image-first
    // host match finds pid 7000, while the provider label keeps its addresses
    // distinct from a plain claude session's. The stale shim registration on
    // pid 5000 (nearer in the chain but no opencode.exe image) must not win —
    // without the image entry the legacy nearest-ancestor match picks it.
    const sid = 'op-session-9';
    const hookAddr = sessionBusAddress('opencode@repo', sid);
    const claudeAddr = 'claude@repo#555'; // a plain claude session must not win
    const foreignAddr = sessionBusAddress('opencode@repo', 'stale-shim-key');
    await seedRegistry({
      [claudeAddr]: { capabilities: ['hooks'], worker: 'claude', pid: 31337, createdAt: '2026-09-17T00:00:00.000Z' },
      [foreignAddr]: { capabilities: ['hooks'], worker: 'opencode', pid: 5000, createdAt: '2026-09-17T01:00:00.000Z' },
      [hookAddr]: { capabilities: ['hooks'], worker: 'opencode', pid: HOST, createdAt: '2026-09-17T00:00:00.000Z', nativeSessionId: sid },
    });

    const tree = fakeTree([[HOST, { ppid: 4, cmd: 'opencode.exe' }]]);
    const ident = await resolveSessionBusAddress({ provider: 'opencode', repo: 'repo', execFn: tree });
    assert.equal(ident.address, hookAddr, 'opencode resolves the address registered under opencode@');
    assert.equal(ident.pid, HOST, 'the opencode.exe host is found via its image');
    assert.equal(ident.via, 'registry-match');
  });
});

describe('bus-queue — soft-read receipts (readBy)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    _resetBusQueueForTest();
  });

  afterEach(async () => {
    _resetBusQueueForTest();
    await cleanup(dir);
  });

  it('markBusRead appends the reader WITHOUT removing the envelope', async () => {
    const { id } = await sendBusMessage({ from: 'cli@x', to: 'topic:t1', body: 'hello' });
    const marked = await markBusRead('topic:t1', id, 'devin@repo#1');
    assert.deepEqual(marked?.readBy, ['devin@repo#1']);
    const queued = await listBusMessages('topic:t1');
    assert.equal(queued.length, 1, 'the envelope stays queued — a read is not a consume');
    assert.deepEqual(queued[0].readBy, ['devin@repo#1'], 'receipt persisted in the queue file');
  });

  it('distinct readers accumulate; the same reader never duplicates', async () => {
    const { id } = await sendBusMessage({ from: 'cli@x', to: 'topic:t2', body: 'shared mail' });
    await markBusRead('topic:t2', id, 'claude@repo#1');
    await markBusRead('topic:t2', id, 'devin@repo#2');
    await markBusRead('topic:t2', id, 'claude@repo#1'); // re-read
    const env = (await listBusMessages('topic:t2'))[0];
    assert.deepEqual(env.readBy, ['devin@repo#2', 'claude@repo#1'], 'idempotent per reader, most-recent last');
  });

  it('a foreign read leaves the envelope unread-for-the-owner — the accidental-read fix', async () => {
    // The scenario this exists for: session B reads session A's queue. The
    // owner's read picks are driven by "readBy lacks MY address" — B's receipt
    // must not hide the message from A.
    const { id } = await sendBusMessage({ from: 'cli@x', to: 'claude@repo#777', body: 'for A only' });
    await markBusRead('claude@repo#777', id, 'devin@repo#2'); // B's accidental read
    const env = (await listBusMessages('claude@repo#777'))[0];
    assert.ok(env, 'envelope still queued for the owner');
    assert.equal(env.readBy!.includes('claude@repo#777'), false, 'owner has no receipt — still unread-for-owner');
    assert.equal(env.readBy!.includes('devin@repo#2'), true, "B's read is declared, not silent");
  });

  it('markBusRead returns null for an absent id and rejects empty args', async () => {
    assert.equal(await markBusRead('topic:t3', 'bus-nope', 'cli@x'), null);
    await assert.rejects(() => markBusRead('topic:t3', '', 'cli@x'));
    await assert.rejects(() => markBusRead('topic:t3', 'bus-x', ''));
  });

  it('touchBusCursor preserves the delivered ring across touches', async () => {
    const addr = 'claude@repo#55';
    await touchBusCursor(addr, 'hook', 111);
    await markBusDelivered(addr, ['bus-aaa']);
    await touchBusCursor(addr, 'inbox', 111); // an inbox read used to wipe the ring
    const cur = await readBusCursor(addr);
    assert.deepEqual(cur?.delivered, ['bus-aaa'], 'the peek-dedup ring survives an inbox touch');
    assert.equal(cur?.last_event, 'inbox');
  });
});

// AI-272 problem 3: the npm `pa` sh-shim execs node through an MSYS2 exec —
// the stub's recorded Win32 parent is the caller's pre-exec image, already
// dead. The ancestor walk dead-ends one hop up and whoami falls to a
// per-invocation ppid hash. The registry's termKey (terminal-session env,
// inherited across exec) is the non-ancestry channel that restores the match.
describe('bus-queue — AI-272 severed-ancestry resolution + busInbox owner guard', () => {
  let dir: string;
  const HOST = 7000;
  const OTHER = 8888;

  beforeEach(async () => {
    dir = await createTempPaHome();
    _resetBusQueueForTest();
  });

  afterEach(async () => {
    _resetBusQueueForTest();
    await cleanup(dir);
  });

  /** Severed chain: process.ppid is the shim's sh.exe stub; its recorded
   *  parent is absent from the table (the exec'd caller's win32 image was
   *  reaped). The host pids in `extra` exist but are unreachable by ancestry. */
  function severedTree(extra: Array<[number, { ppid: number; cmd: string }]> = []) {
    const table = new Map<number, { ppid: number; cmd: string }>([
      [process.ppid, { ppid: 9009, cmd: 'sh.exe /d/npm-global/pa bus whoami' }],
      // 9009 deliberately absent — the dead exec-boundary link.
      ...extra,
    ]);
    return async (cmd: string) => {
      if (cmd.includes('Get-CimInstance')) {
        const filter = [...cmd.matchAll(/ProcessId = (\d+)/g)].map((m) => Number(m[1]));
        const rows = [...table]
          .filter(([pid]) => filter.length === 0 || filter.includes(pid))
          .map(([pid, r]) => ({ ProcessId: pid, ParentProcessId: r.ppid, CommandLine: r.cmd }));
        return { stdout: JSON.stringify(rows), stderr: '' };
      }
      if (/-o pid=,command=/.test(cmd)) {
        const list = (/-p ([\d,]+)/.exec(cmd)?.[1] ?? '').split(',').map(Number);
        const out = [...table]
          .filter(([pid]) => list.includes(pid))
          .map(([pid, r]) => `${pid} ${r.cmd}`)
          .join('\n');
        return { stdout: out, stderr: '' };
      }
      const out = [...table].map(([pid, r]) => `${pid} ${r.ppid}`).join('\n');
      return { stdout: out, stderr: '' };
    };
  }

  /** Intact chain: process.ppid → pwsh(5000) → cmd(6000) → claude.exe(7000). */
  function intactTree() {
    const table = new Map<number, { ppid: number; cmd: string }>([
      [process.ppid, { ppid: 5000, cmd: 'node dist\\tests\\run.js' }],
      [5000, { ppid: 6000, cmd: 'powershell.exe -NoProfile -Command x' }],
      [6000, { ppid: HOST, cmd: 'cmd.exe /c python hook.py' }],
      [HOST, { ppid: 4, cmd: '"C:\\Program Files\\claude\\claude.exe"' }],
      [4, { ppid: 0, cmd: '' }],
    ]);
    return async (cmd: string) => {
      if (cmd.includes('Get-CimInstance')) {
        const filter = [...cmd.matchAll(/ProcessId = (\d+)/g)].map((m) => Number(m[1]));
        const rows = [...table]
          .filter(([pid]) => filter.length === 0 || filter.includes(pid))
          .map(([pid, r]) => ({ ProcessId: pid, ParentProcessId: r.ppid, CommandLine: r.cmd }));
        return { stdout: JSON.stringify(rows), stderr: '' };
      }
      if (/-o pid=,command=/.test(cmd)) {
        const list = (/-p ([\d,]+)/.exec(cmd)?.[1] ?? '').split(',').map(Number);
        const out = [...table]
          .filter(([pid]) => list.includes(pid))
          .map(([pid, r]) => `${pid} ${r.cmd}`)
          .join('\n');
        return { stdout: out, stderr: '' };
      }
      const out = [...table].map(([pid, r]) => `${pid} ${r.ppid}`).join('\n');
      return { stdout: out, stderr: '' };
    };
  }

  async function seedRegistry(entries: Record<string, unknown>) {
    await mkdir(dirname(busRegistryPath()), { recursive: true });
    await writeFile(busRegistryPath(), JSON.stringify(entries), 'utf8');
  }

  /** Run fn with a controlled env: the provider markers, the bus identity
   *  vars and every termKey source are set/deleted exactly as given. */
  async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const KEYS = ['PA_BUS_PROVIDER', 'PA_WORKER', 'OPENCODE', 'KGCLAUDE_SESSION', 'CLAUDECODE',
      'ANTIGRAVITY_AGENT', 'CHISEL_SESSION_DB', 'CODEX_CLI_PATH', 'GEMINI_SESSION_ID', 'GEMINI_CLI_PATH',
      'PA_BUS_ADDRESS', 'PA_BUS_SESSION', 'PA_SESSION', 'PA_BUS_REPO',
      'WT_SESSION', 'WEZTERM_PANE', 'TERM_SESSION_ID', 'KONSOLE_DBUS_SESSION', 'TMUX'];
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      if (k in vars) {
        if (vars[k] === undefined) delete process.env[k];
        else process.env[k] = vars[k];
      } else {
        delete process.env[k];
      }
    }
    try {
      return await fn();
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('(g) a severed msys-shim chain still resolves the registered address via termKey', async () => {
    const hookAddr = sessionBusAddress('claude@repo', 'sess-term');
    await seedRegistry({
      [hookAddr]: { capabilities: ['hooks'], worker: 'claude', pid: HOST, termKey: 'WT_SESSION=wt-abc', createdAt: '2026-09-17T00:00:00.000Z' },
    });
    const tree = severedTree([[HOST, { ppid: 4, cmd: 'claude.exe' }]]);

    const ident = await withEnv({ CLAUDECODE: '1', WT_SESSION: 'wt-abc' }, () =>
      resolveSessionBusAddress({ provider: 'claude', repo: 'repo', execFn: tree }));
    assert.equal(ident.address, hookAddr, 'registry termKey match restores the session address');
    assert.equal(ident.pid, HOST, 'the registered host pid is recovered');
    assert.equal(ident.via, 'registry-match');
  });

  it('(h) busInbox stamps the owner address when its registry pid is the caller ancestor', async () => {
    const owner = sessionBusAddress('claude@repo', 'sess-owner');
    await seedRegistry({
      [owner]: { capabilities: ['hooks'], worker: 'claude', pid: HOST, createdAt: '2026-09-17T00:00:00.000Z' },
    });
    await sendBusMessage({ from: 'cli@x', to: owner, body: 'owner mail' });

    // Caller's own resolution is deliberately foreign (a stray session key) —
    // the owner row's pid is still an ancestor, so the receipt lands on the
    // owner address, not the caller's derived one.
    const bus = busCommand as unknown as (args: string[], opts?: { execFn?: ExecFn }) => Promise<number>;
    await withEnv(
      { CLAUDECODE: '1', PA_BUS_REPO: 'repo', PA_BUS_SESSION: 'foreign-session-key' },
      () => bus(['inbox', owner], { execFn: intactTree() }),
    );

    const envs = await listBusMessages(owner);
    assert.ok(envs[0].readBy?.includes(owner), 'the owner address is stamped, not the caller identity');
  });

  it('(i) busInbox stamps the caller resolved address for a non-ancestor target', async () => {
    const mine = sessionBusAddress('claude@repo', 'sess-mine');
    const foreign = sessionBusAddress('claude@repo', 'sess-foreign');
    await seedRegistry({
      [mine]: { capabilities: ['hooks'], worker: 'claude', pid: HOST, termKey: 'WT_SESSION=wt-abc', createdAt: '2026-09-17T00:00:00.000Z' },
      [foreign]: { capabilities: ['hooks'], worker: 'claude', pid: OTHER, termKey: 'WT_SESSION=wt-zzz', createdAt: '2026-09-17T01:00:00.000Z' },
    });
    await sendBusMessage({ from: 'cli@x', to: foreign, body: 'foreign mail' });

    const bus = busCommand as unknown as (args: string[], opts?: { execFn?: ExecFn }) => Promise<number>;
    const tree = severedTree([[HOST, { ppid: 4, cmd: 'claude.exe' }], [OTHER, { ppid: 4, cmd: 'claude.exe' }]]);
    await withEnv(
      { CLAUDECODE: '1', PA_BUS_REPO: 'repo', WT_SESSION: 'wt-abc' },
      () => bus(['inbox', foreign], { execFn: tree }),
    );

    const envs = await listBusMessages(foreign);
    assert.deepEqual(envs[0].readBy, [mine], 'the caller stamps its own resolved address');
  });
});
