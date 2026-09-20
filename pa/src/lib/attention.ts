/**
 * Attention channel — RETIRED to opt-in (2026-09-11, vi-08b2360d27b3). The
 * operator-facing channel for "action needed" / "response ready" is now the
 * voice-inbox web app's own browser notifications (client-side, `public/app.js`
 * + `public/sw.js`); nothing fires here unless `PA_ATTENTION_ENABLED=1`. The
 * original two-leg channel is kept intact below so a deliberate re-enable
 * pages over both legs that survive a MUTED Telegram group:
 *
 *  1. Windows toast (desktop) — a native toast via Windows Runtime, raised by
 *     spawning Windows PowerShell 5.1 (`powershell.exe`, NOT pwsh — the WinRT
 *     projection via `ContentType = WindowsRuntime` only loads on 5.1). The
 *     sender AUMID is the Start-Menu PowerShell shortcut
 *     (`{1AC14E77-...}\WindowsPowerShell\v1.0\powershell.exe`), the one
 *     unpackaged AUMID every Windows build accepts; without a registered AUMID
 *     Windows silently drops the toast. The script text rides `-EncodedCommand`
 *     (base64 UTF-16LE) so model-authored titles/bodies can never break quoting.
 *     On macOS the same leg maps to `osascript display notification`; on Linux
 *     to `notify-send`. Where no local channel can fire (unsupported platform,
 *     or a failed POSIX notification), the leg degrades LOUDLY to the log file
 *     plus a local outbox file under `~/.pa/outbox/` — never silent.
 *  2. Private-chat mirror (phone) — a SHORT message to the operator's private
 *     Telegram chat (PA_OPERATOR_USER_ID). Private chats notify by default, so
 *     the push reaches the phone (and Telegram Desktop) even though the group —
 *     at ~30 alerts/day across 50+ topics — is necessarily muted. The group
 *     message itself stays where it already is; this is a mirror, not a move.
 *
 * Routing discipline: the ping goes out through `sendToTelegram` (ref-minted,
 * logged, `pa ref`-traceable) — the same sanctioned send path `notifyUser` uses.
 * It never calls the Bot API directly and never bypasses the delivery log.
 *
 * Gating (mirrors the PA_NOTIFY_DISABLED convention — "blocks the REAL fetch"):
 *   PA_ATTENTION_ENABLED=1 OPTS IN (default off — the retired default)
 *   PA_NOTIFY_DISABLED=1   gates BOTH legs (absolute kill switch; test suites
 *                          set this globally)
 *   PA_TOAST_DISABLED=1    gates the toast only
 *   PA_PING_DISABLED=1     gates the private mirror only
 * A gated leg reports `{ok:false, reason:'disabled'}` — never a throw, never a
 * silent success, so callers can log the honest outcome.
 *
 * Every leg is individually best-effort: a toast failure never blocks the ping
 * and neither ever throws into the caller (worker scripts call this on their
 * finish line — the ledger write must stay the source of truth).
 */

import { spawn } from 'child_process';
import { platform } from 'os';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { sendToTelegram } from '../telegram.js';
import { loadSecrets } from '../secrets.js';
import { log } from './log.js';
import { dispatchWebPushToAll } from './web-push.js';
import { paHome } from '../paths.js';

const POWERSHELL_EXE = process.env.WINDIR
  ? `${process.env.WINDIR}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe';

/** Start-Menu Windows PowerShell AUMID — the unpackaged toast sender Windows accepts. */
const TOAST_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const TOAST_TIMEOUT_MS = 8_000;
const PING_TIMEOUT_MS = 6_000;
const TOAST_TITLE_MAX = 60;
const TOAST_BODY_MAX = 200;
const PING_BODY_MAX = 500;

export interface ToastResult {
  ok: boolean;
  reason?: 'disabled' | 'spawn-failed' | 'timeout' | 'no-powershell'
    | 'unsupported-platform' | 'degraded-outbox';
}
export interface PingResult {
  sent: boolean;
  reason?: 'disabled' | 'no-operator-id' | 'no-token' | 'no-chat-id' | 'send-failed' | 'timeout' | 'telegram-error';
}
export interface WebPushResult {
  sent: number;
  failed: number;
  pruned: number;
  reason?: 'disabled' | 'no-subscriptions' | 'error';
}
export interface AttentionResult {
  toast: ToastResult;
  ping: PingResult;
  webPush: WebPushResult;
}

export interface AttentionOpts {
  toast?: boolean;
  ping?: boolean;
  webPush?: boolean;
  /** Test seam — the default spawns powershell.exe with windowsHide:true. */
  execFn?: typeof spawn;
  /** Test seam — overrides the OS dispatch (WP-C6 branch: the toast leg is
   *  per-OS; the degraded path is forced per-OS in tests). */
  platformFn?: () => NodeJS.Platform;
  /** Skip the final info-level result log. Callers whose stdout is a parsed
   *  JSON contract (`pa auth request --json` prints ONE §3.8 line) must pass
   *  false — log() echoes info lines to stdout, which would corrupt it. */
  quiet?: boolean;
  /** Storage directory for push-subscriptions and vapid keys (test seam). */
  storageDir?: string;
  /** Custom fetch implementation (test seam). */
  fetchFn?: typeof fetch;
  /** Overrides the degraded-mode outbox directory (test seam). */
  outboxDir?: string;
}

function toastEnabled(): boolean {
  return process.env.PA_ATTENTION_ENABLED === '1'
    && process.env.PA_NOTIFY_DISABLED !== '1'
    && process.env.PA_TOAST_DISABLED !== '1';
}

function pingEnabled(): boolean {
  return process.env.PA_ATTENTION_ENABLED === '1'
    && process.env.PA_NOTIFY_DISABLED !== '1'
    && process.env.PA_PING_DISABLED !== '1';
}

export function webPushEnabled(): boolean {
  return process.env.PA_NOTIFY_DISABLED !== '1'
    && process.env.PA_WEBPUSH_DISABLED !== '1';
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The PowerShell toast script for (title, body). Exposed for the sync test —
 *  the payload is XML-escaped text inside a ToastText02 template, and the
 *  caller base64-encodes it as UTF-16LE for -EncodedCommand. */
export function buildToastScript(title: string, body: string): string {
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t = $xml.GetElementsByTagName('text')",
    `$null = $t.Item(0).AppendChild($xml.CreateTextNode('${xmlEscape(clamp(title, TOAST_TITLE_MAX))}'))`,
    `$null = $t.Item(1).AppendChild($xml.CreateTextNode('${xmlEscape(clamp(body, TOAST_BODY_MAX))}'))`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_AUMID}').Show($toast)`,
  ].join('\n');
}

/** Raise one Windows toast. Never throws. */
export async function fireWindowsToast(title: string, body: string, opts?: AttentionOpts): Promise<ToastResult> {
  if (!toastEnabled()) return { ok: false, reason: 'disabled' };
  if (!title.trim() && !body.trim()) return { ok: false, reason: 'spawn-failed' };

  // WP-C6 branch: the local-notification leg is per-OS. Windows keeps the
  // PowerShell WinRT toast; macOS maps to osascript; Linux maps to notify-send.
  // Everywhere none of those can fire (an unsupported platform, or a spawn
  // failure on a POSIX desktop), the leg degrades LOUDLY to the log file plus
  // a local outbox file — never a missing feature silently (WB row: attention).
  const os = opts?.platformFn ? opts.platformFn() : platform();
  if (os === 'win32') return fireToastWindows(title, body, opts);
  if (os === 'darwin') {
    const escaped = (t: string) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${escaped(clamp(body, TOAST_BODY_MAX))}" with title "${escaped(clamp(title, TOAST_TITLE_MAX))}"`;
    return fireToastPosix(title, body, opts, 'osascript', ['-e', script], `osascript notification failed`);
  }
  if (os === 'linux') {
    return fireToastPosix(title, body, opts, 'notify-send',
      [clamp(title, TOAST_TITLE_MAX), clamp(body, TOAST_BODY_MAX)], 'notify-send failed');
  }
  await loudDegradedToOutbox(title, body, `unsupported platform "${os}" — no local notification channel`, opts?.outboxDir);
  return { ok: false, reason: 'unsupported-platform' };
}

/** Loud-degraded floor (WP-C6): write the attention text to the local outbox
 *  and WARN to the log file. Never throws; the outbox write failing still
 *  leaves the warn in the log, so the degradation is never silent. */
async function loudDegradedToOutbox(title: string, body: string, detail: string, outboxDir?: string): Promise<void> {
  log('warn', 'attention', `local notification unavailable (${detail}) — degraded to the local outbox`, { title });
  try {
    const dir = outboxDir ?? join(paHome(), 'outbox');
    await mkdir(dir, { recursive: true });
    const safe = title.replace(/[^a-z0-9-_.]+/gi, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'attention';
    await writeFile(join(dir, `attention-${Date.now()}-${safe}.md`), `${title}\n\n${body}\n`, 'utf8');
  } catch (err: any) {
    log('warn', 'attention', 'degraded outbox write failed', { error: err?.message });
  }
}

async function fireToastWindows(title: string, body: string, opts?: AttentionOpts): Promise<ToastResult> {
  const script = buildToastScript(title, body);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const execFn = opts?.execFn ?? spawn;

  return await new Promise<ToastResult>((resolve) => {
    let settled = false;
    const done = (r: ToastResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const child = execFn(POWERSHELL_EXE, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
      ], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => {
        done({ ok: false, reason: 'timeout' });
        try { child.kill(); } catch { /* already gone */ }
      }, TOAST_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        log('warn', 'attention', 'toast spawn failed', { error: err.message });
        done({ ok: false, reason: 'no-powershell' });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) done({ ok: true });
        else {
          log('warn', 'attention', 'toast script exited non-zero', { code });
          done({ ok: false, reason: 'spawn-failed' });
        }
      });
    } catch (err: any) {
      log('warn', 'attention', 'toast spawn threw', { error: err?.message });
      done({ ok: false, reason: 'spawn-failed' });
    }
  });
}

/** Fire one POSIX desktop notification (osascript / notify-send). Never throws;
 *  a spawn failure degrades LOUDLY to the log + outbox. */
async function fireToastPosix(title: string, body: string, opts: AttentionOpts | undefined,
  exe: string, args: string[], detail: string): Promise<ToastResult> {
  const execFn = opts?.execFn ?? spawn;
  return await new Promise<ToastResult>((resolve) => {
    let settled = false;
    const done = (r: ToastResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const degrade = () => {
      loudDegradedToOutbox(title, body, detail, opts?.outboxDir).catch(() => {});
      done({ ok: false, reason: 'degraded-outbox' });
    };
    try {
      const child = execFn(exe, args, { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => {
        done({ ok: false, reason: 'timeout' });
        try { child.kill(); } catch { /* already gone */ }
      }, TOAST_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        log('warn', 'attention', detail, { error: err.message });
        degrade();
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) done({ ok: true });
        else {
          log('warn', 'attention', `${exe} exited non-zero`, { code });
          degrade();
        }
      });
    } catch (err: any) {
      log('warn', 'attention', `${exe} spawn threw`, { error: err?.message });
      degrade();
    }
  });
}

async function readSecrets(): Promise<Record<string, string>> {
  try {
    return await loadSecrets();
  } catch {
    return {};
  }
}

/** Mirror a SHORT notification into the operator's private Telegram chat.
 *  Never throws; `sent:true` means Telegram CONFIRMED delivery. */
export async function pingOperatorPrivate(subject: string, body: string): Promise<PingResult> {
  if (!pingEnabled()) return { sent: false, reason: 'disabled' };

  const secrets = await readSecrets();
  const chatId = (process.env.PA_OPERATOR_USER_ID || secrets['PA_OPERATOR_USER_ID'] || '').trim();
  const token = secrets['TELEGRAM_BOT_TOKEN'] || '';
  if (!chatId) {
    log('warn', 'attention', 'ping skipped — PA_OPERATOR_USER_ID is not set', {});
    return { sent: false, reason: 'no-operator-id' };
  }
  if (!token) return { sent: false, reason: 'no-token' };

  const text = body.trim() ? `${subject.trim()}\n\n${clamp(body, PING_BODY_MAX)}` : subject.trim();

  const sendPromise = sendToTelegram(
    text,
    { chat_id: chatId, thread_id: 0, token_secret: 'TELEGRAM_BOT_TOKEN' },
    token,
    'MarkdownV2',
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), PING_TIMEOUT_MS);
  });
  const outcome = await Promise.race([sendPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });

  if (outcome === 'timeout') return { sent: false, reason: 'timeout' };
  if (!outcome.ok) {
    log('warn', 'attention', 'private ping failed', { reason: outcome.reason, status: outcome.status });
    return { sent: false, reason: 'send-failed' };
  }
  return { sent: true };
}

/**
 * Fire Web Push to all active subscriptions. Never throws.
 */
export async function fireWebPush(subject: string, body: string, opts?: AttentionOpts): Promise<WebPushResult> {
  if (!webPushEnabled()) return { sent: 0, failed: 0, pruned: 0, reason: 'disabled' };
  try {
    const res = await dispatchWebPushToAll(subject, body, {
      storageDir: opts?.storageDir,
      fetchFn: opts?.fetchFn,
    });
    return {
      sent: res.sent,
      failed: res.failed,
      pruned: res.pruned,
      reason: res.reason,
    };
  } catch (err: any) {
    log('warn', 'attention', 'web push dispatch threw', { error: err?.message });
    return { sent: 0, failed: 1, pruned: 0, reason: 'error' };
  }
}

/**
 * Fire attention legs for one event (Web Push enabled by default; Windows toast
 * and private Telegram ping remain opt-in under PA_ATTENTION_ENABLED=1). Never throws.
 */
export async function notifyAttention(subject: string, body: string, opts?: AttentionOpts): Promise<AttentionResult> {
  const wantToast = opts?.toast !== false;
  const wantPing = opts?.ping !== false;
  const wantWebPush = opts?.webPush !== false;
  const [toast, ping, webPush] = await Promise.all([
    wantToast ? fireWindowsToast(subject, body, opts) : Promise.resolve({ ok: false, reason: 'disabled' as const }),
    wantPing ? pingOperatorPrivate(subject, body) : Promise.resolve({ sent: false, reason: 'disabled' as const }),
    wantWebPush ? fireWebPush(subject, body, opts) : Promise.resolve({ sent: 0, failed: 0, pruned: 0, reason: 'disabled' as const }),
  ]);
  if (!opts?.quiet) {
    log('info', 'attention', 'result', {
      subject,
      toastOk: toast.ok,
      pingSent: ping.sent,
      toastReason: toast.reason,
      pingReason: ping.reason,
      webPushSent: webPush.sent,
      webPushFailed: webPush.failed,
      webPushPruned: webPush.pruned,
      webPushReason: webPush.reason,
    });
  }
  return { toast, ping, webPush };
}
