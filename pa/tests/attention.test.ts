/**
 * Attention channel tests (2026-09-11, vi-6018671b5f37).
 *
 * Hermetic by construction: the toast leg is exercised through the injected
 * execFn (never a real powershell spawn), the ping leg through a globalThis.fetch
 * stub + a temp PA_HOME secrets.env, and every gating case sets the same env
 * vars the production gates read (PA_NOTIFY_DISABLED / PA_TOAST_DISABLED /
 * PA_PING_DISABLED). The child process type is passed as `any` because the seam
 * only ever touches `.on`/`kill` in these tests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildToastScript,
  fireWindowsToast,
  notifyAttention,
  pingOperatorPrivate,
} from '../src/lib/attention.js';
import { flushLog } from '../src/lib/log.js';

/** The ping body travels through sanitizeMdV2, so assertions match on the
 *  UNESCAPED text (backslashes stripped) rather than the raw payload. */
function unescaped(text: string): string {
  return text.replace(/\\/g, '');
}

interface FakeChild {
  on: (event: string, cb: (...args: any[]) => void) => void;
  kill: () => void;
}

function fakeChildFactory(events: Map<string, (...args: any[]) => void>): any {
  const child: FakeChild = {
    on: (event, cb) => {
      events.set(event, cb);
      return child;
    },
    kill: () => {},
  };
  return child;
}

function decodeEncodedCommand(spawnArgs: string[]): string {
  const idx = spawnArgs.indexOf('-EncodedCommand');
  assert.notEqual(idx, -1, 'spawn args must carry -EncodedCommand');
  return Buffer.from(spawnArgs[idx + 1], 'base64').toString('utf16le');
}

describe('buildToastScript', () => {
  it('XML-escapes model-authored title/body text', () => {
    const script = buildToastScript('Task <done> & "gone"', "it's a'tick");
    assert.ok(script.includes('Task &lt;done&gt; &amp; &quot;gone&quot;'));
    assert.ok(script.includes('it&apos;s a&apos;tick'));
  });

  it('clamps long body text to the toast budget', () => {
    const script = buildToastScript('T', 'x'.repeat(500));
    const textNode = script.split('\n').find((l) => l.includes('CreateTextNode') && l.includes('xxx'));
    assert.ok(textNode);
    assert.ok(textNode!.length < 400, 'clamped text node must stay small');
  });

  it('targets the Start-Menu PowerShell AUMID', () => {
    const script = buildToastScript('T', 'B');
    assert.ok(script.includes('CreateToastNotifier'));
    assert.ok(script.includes('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}'));
    assert.ok(script.includes('ToastText02'));
  });
});

describe('fireWindowsToast', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['PA_ATTENTION_ENABLED', 'PA_NOTIFY_DISABLED', 'PA_TOAST_DISABLED'];

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is disabled under PA_NOTIFY_DISABLED=1 and PA_TOAST_DISABLED=1', async () => {
    process.env.PA_NOTIFY_DISABLED = '1';
    assert.equal((await fireWindowsToast('T', 'B', { execFn: (() => null) as any })).reason, 'disabled');
    delete process.env.PA_NOTIFY_DISABLED;
    process.env.PA_TOAST_DISABLED = '1';
    assert.equal((await fireWindowsToast('T', 'B', { execFn: (() => null) as any })).reason, 'disabled');
  });

  it('spawns powershell hidden with an EncodedCommand payload and resolves ok on exit 0', async () => {
    process.env.PA_ATTENTION_ENABLED = '1'; // opt in — the channel is retired to opt-in by default
    // Holder object: TS closure flow analysis never sees the inner assignment,
    // so a bare `let` narrows to `never` after the assert.
    const holder: { captured: { exe: string; args: string[]; opts: any } | null } = { captured: null };
    const events = new Map<string, (...args: any[]) => void>();
    const execFn = ((exe: string, args: string[], opts: any) => {
      holder.captured = { exe, args, opts };
      const child = fakeChildFactory(events);
      // async settle — the promise must wait for the exit event
      setTimeout(() => events.get('exit')?.(0), 5);
      return child;
    }) as any;

    // platformFn pins the Windows leg — the dispatcher is per-OS since WP-C6,
    // and without the pin a POSIX runner would (correctly) spawn notify-send
    // instead of powershell (2026-09-20 public-mirror CI fail on ubuntu/macos).
    const result = await fireWindowsToast('Hello toast', 'Body text', { execFn, platformFn: () => 'win32' });
    assert.equal(result.ok, true);
    const captured = holder.captured;
    assert.ok(captured);
    assert.match(captured.exe, /powershell\.exe$/);
    assert.equal(captured.opts.windowsHide, true, 'repo invariant: every spawn hides its window');
    const script = decodeEncodedCommand(captured.args);
    assert.ok(script.includes('Hello toast'));
    assert.ok(script.includes('Body text'));
    assert.ok(captured.args.includes('-NoProfile'));
    assert.ok(captured.args.includes('-NonInteractive'));
  });

  it('reports no-powershell when the spawn errors (never throws)', async () => {
    process.env.PA_ATTENTION_ENABLED = '1'; // opt in — the channel is retired to opt-in by default
    const events = new Map<string, (...args: any[]) => void>();
    const execFn = (() => {
      const child = fakeChildFactory(events);
      setTimeout(() => events.get('error')?.(new Error('ENOENT')), 5);
      return child;
    }) as any;
    const result = await fireWindowsToast('T', 'B', { execFn, platformFn: () => 'win32' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-powershell');
  });
});

describe('fireWindowsToast per-OS legs + loud-degraded (WP-C6 branch table)', () => {
  let paHomeDir: string;
  let outboxDir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['PA_ATTENTION_ENABLED', 'PA_NOTIFY_DISABLED', 'PA_TOAST_DISABLED', 'PA_HOME'];

  beforeEach(async () => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    paHomeDir = await mkdtemp(join(tmpdir(), 'pa-attention-os-'));
    outboxDir = join(paHomeDir, 'outbox');
    process.env.PA_HOME = paHomeDir;
    process.env.PA_ATTENTION_ENABLED = '1'; // opt in — exercising the OS legs
  });
  afterEach(async () => {
    await flushLog();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(paHomeDir, { recursive: true, force: true });
  });

  it('macOS leg spawns osascript with a display-notification script and resolves ok', async () => {
    const holder: { captured: { exe: string; args: string[]; opts: any } | null } = { captured: null };
    const events = new Map<string, (...args: any[]) => void>();
    const execFn = ((exe: string, args: string[], opts: any) => {
      holder.captured = { exe, args, opts };
      const child = fakeChildFactory(events);
      setTimeout(() => events.get('exit')?.(0), 5);
      return child;
    }) as any;
    const result = await fireWindowsToast('mac title', 'mac body', { execFn, platformFn: () => 'darwin' });
    assert.equal(result.ok, true);
    assert.ok(holder.captured);
    assert.equal(holder.captured.exe, 'osascript');
    assert.ok(holder.captured.args[0] === '-e');
    assert.ok(holder.captured.args[1].includes('display notification'));
    assert.ok(holder.captured.args[1].includes('mac title'));
    assert.equal(holder.captured.opts.windowsHide, true, 'repo invariant: every spawn hides its window');
  });

  it('Linux leg spawns notify-send; on spawn error it degrades LOUDLY — outbox file lands, never silence', async () => {
    const events = new Map<string, (...args: any[]) => void>();
    const execFn = ((exe: string, args: string[], _opts: any) => {
      assert.equal(exe, 'notify-send');
      const child = fakeChildFactory(events);
      setTimeout(() => events.get('error')?.(new Error('ENOENT: notify-send')), 5);
      return child;
    }) as any;
    const result = await fireWindowsToast('linux title', 'linux body', { execFn, platformFn: () => 'linux', outboxDir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'degraded-outbox');
    // Wait out the fire-and-forget outbox write, then require a non-empty file.
    await new Promise((r) => setTimeout(r, 50));
    const files = (await import('fs')).readdirSync(outboxDir);
    assert.ok(files.length >= 1, 'degraded path must leave an outbox file (the loud trace)');
    const body = (await import('fs/promises')).readFile(join(outboxDir, files[0]), 'utf8');
    assert.ok((await body).includes('linux title'));
  });

  it('an unsupported platform degrades LOUDLY to the outbox with a message-bearing file', async () => {
    const result = await fireWindowsToast('unsup title', 'unsup body', {
      platformFn: () => 'sunos' as any,
      outboxDir,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported-platform');
    const files = (await import('fs')).readdirSync(outboxDir);
    assert.ok(files.length >= 1, 'the degraded floor must write a local outbox file');
    const body = await (await import('fs/promises')).readFile(join(outboxDir, files[0]), 'utf8');
    assert.ok(body.includes('unsup title'));
    assert.ok(body.includes('unsup body'));
  });
});

describe('pingOperatorPrivate + notifyAttention', () => {
  let paHomeDir: string;
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'PA_ATTENTION_ENABLED',
    'PA_NOTIFY_DISABLED',
    'PA_TOAST_DISABLED',
    'PA_PING_DISABLED',
    'PA_WEBPUSH_DISABLED',
    'PA_HOME',
    'PA_OPERATOR_USER_ID',
  ];
  let fetchCalls: Array<{ url: string; body: any }> = [];
  let realFetch: typeof globalThis.fetch | undefined;

  beforeEach(async () => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    paHomeDir = await mkdtemp(join(tmpdir(), 'pa-attention-'));
    await mkdir(paHomeDir, { recursive: true });
    await writeFile(join(paHomeDir, 'secrets.env'),
      'TELEGRAM_BOT_TOKEN=123:abc\nPA_OPERATOR_USER_ID=555000111\n');
    process.env.PA_HOME = paHomeDir;
    process.env.PA_TOAST_DISABLED = '1'; // toast leg off unless a test opts in
    realFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = (async (url: any, init: any) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
    }) as any;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch as any;
    // attention's own log line is fire-and-forget — flush it before the dir
    // goes away or the late write lands inside the rm (ENOTEMPTY).
    await flushLog();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(paHomeDir, { recursive: true, force: true });
  });

  it('mirrors the ping to the operator PRIVATE chat (no thread id), MarkdownV2', async () => {
    process.env.PA_ATTENTION_ENABLED = '1'; // opt in — the channel is retired to opt-in by default
    const result = await pingOperatorPrivate('Task done — Demo', 'The answer is 4.');
    assert.equal(result.sent, true);
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.includes('/bot123:abc/sendMessage'));
    assert.equal(fetchCalls[0].body.chat_id, '555000111');
    assert.equal(fetchCalls[0].body.message_thread_id, undefined, 'private chat has no topic');
    assert.equal(fetchCalls[0].body.parse_mode, 'MarkdownV2');
    assert.ok(fetchCalls[0].body.text.includes('Task done'));
    assert.ok(unescaped(fetchCalls[0].body.text).includes('The answer is 4.'));
    assert.ok(unescaped(fetchCalls[0].body.text).includes('_Ref: s-'), 'ref trailer must ride the send');
  });

  it('reports no-operator-id when neither env nor secrets carry PA_OPERATOR_USER_ID', async () => {
    process.env.PA_ATTENTION_ENABLED = '1'; // opt in — exercising the operator-id check, not the retired gate
    await writeFile(join(paHomeDir, 'secrets.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n');
    const result = await pingOperatorPrivate('S', 'B');
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no-operator-id');
    assert.equal(fetchCalls.length, 0);
  });

  it('notifyAttention gates all legs under PA_NOTIFY_DISABLED=1', async () => {
    process.env.PA_NOTIFY_DISABLED = '1';
    delete process.env.PA_TOAST_DISABLED;
    delete process.env.PA_PING_DISABLED;
    delete process.env.PA_WEBPUSH_DISABLED;
    const result = await notifyAttention('S', 'B', { execFn: (() => null) as any });
    assert.equal(result.toast.ok, false);
    assert.equal(result.toast.reason, 'disabled');
    assert.equal(result.ping.sent, false);
    assert.equal(result.ping.reason, 'disabled');
    assert.equal(result.webPush.sent, 0);
    assert.equal(result.webPush.reason, 'disabled');
    assert.equal(fetchCalls.length, 0);
  });

  it('notifyAttention toast and ping are disabled by DEFAULT (retired to opt-in) while webPush is enabled', async () => {
    // No PA_ATTENTION_ENABLED — toast and ping report disabled, webPush executes (no subscriptions in temp dir)
    let spawnCalls = 0;
    const execFn = (() => {
      spawnCalls += 1;
      return fakeChildFactory(new Map());
    }) as any;
    const result = await notifyAttention('S', 'B', { execFn });
    assert.deepEqual(result, {
      toast: { ok: false, reason: 'disabled' },
      ping: { sent: false, reason: 'disabled' },
      webPush: { sent: 0, failed: 0, pruned: 0, reason: 'no-subscriptions' },
    });
    assert.equal(spawnCalls, 0, 'spawn stub must NEVER be called when gated off');
    assert.equal(fetchCalls.length, 0);
  });

  it('notifyAttention gates webPush under PA_WEBPUSH_DISABLED=1', async () => {
    process.env.PA_WEBPUSH_DISABLED = '1';
    const result = await notifyAttention('S', 'B', { execFn: (() => null) as any });
    assert.equal(result.webPush.sent, 0);
    assert.equal(result.webPush.reason, 'disabled');
  });

  it('notifyAttention stays disabled with PA_ATTENTION_ENABLED=1 under the PA_NOTIFY_DISABLED kill switch', async () => {
    process.env.PA_ATTENTION_ENABLED = '1';
    process.env.PA_NOTIFY_DISABLED = '1';
    const result = await notifyAttention('S', 'B', { execFn: (() => null) as any });
    assert.equal(result.toast.ok, false);
    assert.equal(result.toast.reason, 'disabled');
    assert.equal(result.ping.sent, false);
    assert.equal(result.ping.reason, 'disabled');
    assert.equal(result.webPush.sent, 0);
    assert.equal(result.webPush.reason, 'disabled');
    assert.equal(fetchCalls.length, 0);
  });

  it('notifyAttention fires toast, ping, and webPush together and never throws', async () => {
    process.env.PA_ATTENTION_ENABLED = '1'; // opt in — toast & ping
    delete process.env.PA_TOAST_DISABLED;
    let toastScript = '';
    const events = new Map<string, (...args: any[]) => void>();
    const execFn = ((_exe: string, args: string[], _opts: any) => {
      toastScript = decodeEncodedCommand(args);
      const child = fakeChildFactory(events);
      setTimeout(() => events.get('exit')?.(0), 5);
      return child;
    }) as any;
    // platformFn pins the Windows toast leg — on POSIX the dispatcher maps to
    // notify-send, whose args carry no -EncodedCommand for decodeEncodedCommand
    // to read (same 2026-09-20 CI fail class).
    const result = await notifyAttention('All legs', 'deliver', { execFn, platformFn: () => 'win32' });
    assert.equal(result.toast.ok, true);
    assert.equal(result.ping.sent, true);
    assert.equal(result.webPush.sent, 0); // No subscriptions in empty temp dir
    assert.equal(result.webPush.reason, 'no-subscriptions');
    assert.ok(toastScript.includes('All legs'));
  });
});
