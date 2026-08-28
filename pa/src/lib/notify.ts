/**
 * Notifier substrate for the PA platform.
 *
 * Single function (`notifyUser`) that all subsystems call when something goes wrong.
 * Default-routed to PA_ALERTS_CHAT_ID / PA_ALERTS_THREAD_ID, read from
 * process.env FIRST and then from ~/.pa/secrets.env (falls back to the first
 * TELEGRAM_CHAT_ID entry if PA_ALERTS_CHAT_ID is unset in both).
 * Dedup keeps noise bounded (1 h default window).
 *
 * DO NOT REGRESS the secrets lookup back to env-only: `loadSecrets()` never
 * writes process.env, and PA_ALERTS_CHAT_ID lives in secrets.env — so the
 * env-only resolver silently produced an EMPTY chat_id for 93% of alerts
 * (2026-07 audit: 2195 of 2354 `notify` rows had `topic.chat_id: ""`, Telegram
 * answered "400 Bad Request: chat_id is empty" 293 times, and ~97 alerts were
 * logged `sent:true` while never arriving). Two other invariants hold that
 * class of bug shut: the topic is resolved BEFORE the forensic 'attempting'
 * log line, and dedup state is written ONLY on a CONFIRMED successful send.
 *
 * Dedup state: ~/.pa/alert-state/<sha1(key).slice(0,16)>.json
 * Format: { "timestamp": "<ISO>", "key": "<raw>", "windowMs": <number>,
 *           "count": <number>, "bodyHash": "<sha1(body).slice(0,16)>" }
 *
 * GC reads the stored windowMs and only deletes if now - timestamp > windowMs.
 * Files without windowMs (legacy) fall back to GC_MAX_AGE_MS (24 h).
 *
 * Escalating dedup (2026-08-23): a confirmed send whose body is UNCHANGED
 * from the stored record doubles the dedup window each time (base → 2x → 4x
 * → ... capped at ESCALATION_CAP_MS/24h), tracked via `count`. A permanently
 * failing condition used to page every flat window forever — restore-drill
 * alone sent 180 alerts in 7.5 days — because the window never grew. A
 * CHANGED body (different bodyHash) resets count to 1 and the window to the
 * caller's base: new information should not wait behind an old alert's
 * escalated window. Legacy records with no `count`/`bodyHash` are treated as
 * same-body (escalate from 1) so the migration is silent. `NotifyOpts.escalate
 * === false` opts a caller out entirely: flat window, count pinned at 1.
 * A send that TIMES OUT (unknown outcome, not confirmed) writes a short
 * TIMEOUT_DEDUP_MS mute instead of the escalated window, without advancing
 * count — see the timeout branch below.
 */

import { createHash } from 'crypto';
import { mkdirSync, readdirSync, existsSync } from 'fs';
import { readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { sendToTelegram } from '../telegram.js';
import { loadSecrets } from '../secrets.js';
import { log } from './log.js';
import { paHome } from '../paths.js';

// The dedicated topic for automated PA alerts. NOT the human-conversation
// topic — pa-support remains separate so user replies don't get drowned
// by skill-failure / worker-exit / rate-limit notifications.
// Env-driven so the framework is portable. Falls back to TELEGRAM_CHAT_ID's
// first entry if PA_ALERTS_CHAT_ID is unset.
//
// These are RESOLVED LAZILY (read at call time, not at module-load time)
// because CLI commands (e.g. `pa notify`) may run loadSecrets() AFTER the
// module is imported. The exported `PA_ALERTS_CHAT_ID` value is a snapshot
// at module-init time and may be empty for CLI invocations — use
// `getPaAlertsChatId()` for fresh values.
//
// NOTE: these two are ENV-ONLY and therefore incomplete. `loadSecrets()` never
// populates process.env, so they only resolve for callers that copied secrets
// into the environment first — which is exactly why 93% of in-process alerts
// went out with an empty chat_id. They are retained as compatibility exports
// (public framework surface) and are NOT used inside this repo any more:
// `notifyUser` resolves via the async `resolveAlertRoute()` below, and callers
// that need a caller-specific topic use `resolveNotifyTopic()`.
//
// DO NOT reintroduce them as a route source. An env-only *chat* lookup was
// repaired by `resolveAlertRoute`'s empty-chat_id fallback, but an env-only
// *thread* lookup was not — that asymmetry silently routed the nightly
// self-improver report into pa-alerts instead of the self-improvement-loop
// topic (PA_SELF_IMPROVER_THREAD_ID lives only in secrets.env, and the
// self-improver runs as a `cmd:` skill with no `secrets:` frontmatter, so its
// child process inherits none of it).
export function getPaAlertsChatId(): string {
  return (
    process.env.PA_ALERTS_CHAT_ID ||
    process.env.TELEGRAM_CHAT_ID?.split(',')[0] ||
    ''
  );
}
export function getPaAlertsThreadId(): number {
  return Number(process.env.PA_ALERTS_THREAD_ID ?? 0);
}
export const PA_ALERTS_CHAT_ID = getPaAlertsChatId();   // snapshot — may be stale
export const PA_ALERTS_THREAD_ID = getPaAlertsThreadId();

export interface AlertRoute {
  topic: { chat_id: string; thread_id: number };
  token: string;
}

/**
 * Caller-specific route keys checked BEFORE the generic pa-alerts pair, e.g.
 * the self-improver's PA_SELF_IMPROVER_CHAT_ID / PA_SELF_IMPROVER_THREAD_ID.
 * Both are optional and independent — a deployment that configures only the
 * thread key (the real ~/.pa/secrets.env does exactly that) still gets the
 * pa-alerts chat with its own thread.
 */
export interface TopicKeys {
  chatKey?: string;
  threadKey?: string;
}

async function readSecrets(): Promise<Record<string, string>> {
  try {
    return await loadSecrets();
  } catch {
    return {}; // unreadable secrets.env — env-only resolution still applies
  }
}

/**
 * Pure route resolution over an already-loaded secrets record, so a caller that
 * needs both the topic and the token (`resolveAlertRoute`) reads secrets.env once.
 *
 * Precedence is per-key process.env → secrets.env → empty: an env var always
 * beats the same key in secrets (existing env-based deployments and tests are
 * unaffected), but the SPECIFIC key always beats the generic one, so a
 * PA_ALERTS_CHAT_ID that only exists in secrets.env still wins over a
 * TELEGRAM_CHAT_ID that workers inject into the environment. Chat and thread
 * resolve SYMMETRICALLY — see the do-not-regress note on the sync getters above.
 */
function resolveTopicFrom(
  secrets: Record<string, string>,
  keys?: TopicKeys,
): { chat_id: string; thread_id: number } {
  const pick = (key: string): string => process.env[key] || secrets[key] || '';
  const pickOptional = (key?: string): string => (key ? pick(key) : '');

  return {
    chat_id:
      pickOptional(keys?.chatKey) ||
      pick('PA_ALERTS_CHAT_ID') ||
      pick('TELEGRAM_CHAT_ID').split(',')[0] ||
      '',
    // Each `||` also absorbs a non-numeric value (Number('x') is NaN), matching
    // the pre-existing PA_ALERTS_THREAD_ID behavior: an unusable thread id
    // degrades to the next source rather than poisoning the send with NaN.
    thread_id:
      Number(pickOptional(keys?.threadKey)) ||
      Number(pick('PA_ALERTS_THREAD_ID')) ||
      0,
  };
}

/**
 * Async, secrets-aware topic resolution for callers that own a dedicated topic
 * (`self-improver.ts`, `commands/notify-cmd.ts`). Await this and pass the
 * result to `notifyUser` as a `topic` override.
 *
 * Callers MUST NOT hand-roll `process.env.X || getPaAlertsThreadId()`: that
 * reads the caller-specific key from the environment only, and skills spawned
 * as `cmd:` without `secrets:` frontmatter get no secrets in their environment.
 */
export async function resolveNotifyTopic(
  keys?: TopicKeys,
): Promise<{ chat_id: string; thread_id: number }> {
  return resolveTopicFrom(await readSecrets(), keys);
}

/**
 * Full route (topic + token) for `notifyUser`. A `topic` override whose chat_id
 * is empty is treated as a thread hint only and falls back to the resolved
 * alerts chat.
 */
export async function resolveAlertRoute(
  override?: { chat_id: string; thread_id?: number },
): Promise<AlertRoute> {
  const secrets = await readSecrets();
  const resolved = resolveTopicFrom(secrets);
  const overrideChatId = String(override?.chat_id || '').trim();

  return {
    topic: overrideChatId
      ? { chat_id: overrideChatId, thread_id: override?.thread_id || 0 }
      : { chat_id: resolved.chat_id, thread_id: override?.thread_id || resolved.thread_id },
    // Token stays secrets-ONLY (unlike the chat/thread ids, which gain an env
    // fallback above). Skill workers inherit secrets.env as environment
    // variables, so an env fallback here would let a test process that happens
    // to be spawned by a skill run fire a REAL Telegram send. Behavior is
    // identical to pre-2026-07-21 for every deployment.
    token: secrets['TELEGRAM_BOT_TOKEN'] || '',
  };
}

export const DEFAULT_DEDUP_WINDOW_MS = 3_600_000; // 1 hour
export const ESCALATION_CAP_MS = 24 * 3_600_000;   // an unchanged alert never waits longer than a day
export const TIMEOUT_DEDUP_MS = 10 * 60_000;       // short mute after timeout-unknown-outcome
export const GC_MAX_AGE_MS = 86_400_000; // 24 hours
export const DEFAULT_SEND_TIMEOUT_MS = 5_000; // hard cap on a single alert send

function sendTimeoutMs(): number {
  // Overridable so tests can exercise the timeout path without a 5 s wait.
  return Number(process.env.PA_NOTIFY_TIMEOUT_MS) || DEFAULT_SEND_TIMEOUT_MS;
}

interface NotifyOpts {
  dedupKey?: string;
  dedupWindowMs?: number;
  topic?: { chat_id: string; thread_id?: number };
  severity?: 'info' | 'warn' | 'error';
  runbook?: string; // Optional runbook slug to append as "Runbook: <slug>"
  /** Default true. Set false to opt out of the escalating-window behavior for
   *  this call: the dedup window stays flat at dedupWindowMs and count stays
   *  pinned at 1 regardless of repetition. */
  escalate?: boolean;
  /** Inline keyboard attached to the LAST chunk of the alert. Undefined = no keyboard
   *  (byte-identical to pre-2026-08-24 behaviour for every existing caller). */
  replyMarkup?: Record<string, unknown>;
}

interface NotifyResult {
  sent: boolean;
  suppressed: boolean;
  /** Same value as the `reason` field on the 'result' log line. Additive — existing callers read only sent/suppressed. */
  reason?: NotifyReason;
}

export type NotifyReason =
  | 'sent'
  | 'dedup-suppressed'
  | 'disabled'
  | 'missing-token'
  | 'no-chat-id'
  | 'send-failed'
  | 'timeout-unknown-outcome'
  | 'telegram-error';

function alertStateDir(): string {
  return join(paHome(), 'alert-state');
}

function dedupFilePath(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(alertStateDir(), `${hash}.json`);
}

function bodyHashOf(body: string): string {
  return createHash('sha1').update(body ?? '').digest('hex').slice(0, 16);
}

/** Doubles baseMs per confirmed repeat of an unchanged body (count-1 doublings),
 *  capped at ESCALATION_CAP_MS so no dedup record outlives its GC entitlement. */
function escalatedWindowMs(baseMs: number, count: number): number {
  return Math.min(baseMs * Math.pow(2, Math.max(0, count - 1)), ESCALATION_CAP_MS);
}

// --- Staleness migration (one-time) ---
let migrated = false;

export async function migrateStalenessAlertFile(): Promise<void> {
  if (migrated) return;
  migrated = true;

  const oldPath = join(paHome(), 'last-staleness-alert.json');
  const newPath = dedupFilePath('staleness');

  try {
    if (!existsSync(oldPath)) return;

    const oldExists = existsSync(oldPath);
    const newExists = existsSync(newPath);

    if (oldExists && !newExists) {
      const raw = await readFile(oldPath, 'utf8');
      const parsed = JSON.parse(raw);
      mkdirSync(alertStateDir(), { recursive: true });
      await writeFile(newPath, JSON.stringify({ timestamp: parsed.timestamp, key: 'staleness' }), 'utf8');
    }

    // In all cases where old exists, try to delete it
    if (oldExists) {
      await unlink(oldPath).catch(() => {}); // ENOENT race is fine
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && err?.code !== 'EEXIST') {
      log('warn', 'notify', 'Staleness migration error', { error: err?.message });
    }
  }
}

// --- Dedup GC ---
/** Returns the number of dedup state files unlinked (including malformed
 * files, which are always treated as stale and removed). */
export async function gcAlertState(): Promise<number> {
  const dir = alertStateDir();
  let removed = 0;
  try {
    const files = readdirSync(dir);
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(dir, file);

      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const ts = new Date(parsed.timestamp).getTime();

        const storedWindow = typeof parsed.windowMs === 'number' ? parsed.windowMs : GC_MAX_AGE_MS;
        if (isNaN(ts) || now - ts > storedWindow) {
          try {
            await unlink(filePath);
            removed++;
          } catch {
            // ENOENT race is fine — file already gone
          }
        }
      } catch {
        // Malformed or corrupt file — treat as stale and delete
        try {
          await unlink(filePath);
          removed++;
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // Directory doesn't exist yet — nothing to GC
  }
  return removed;
}

/**
 * Send an alert to the user. Default route: the pa-alerts chat/thread resolved
 * by `resolveAlertRoute()` (env first, then ~/.pa/secrets.env).
 * Never throws. Returns { sent, suppressed, reason } to indicate outcome —
 * `sent: true` means Telegram CONFIRMED the send, never merely "we tried".
 *
 * When dedupKey is undefined: skip dedup entirely, always attempt send.
 * This is used by callers that manage their own suppression (e.g. Phase 4's
 * per-PID lastRepeatBucket gate).
 */
export async function notifyUser(
  subject: string,
  body: string,
  opts?: NotifyOpts,
): Promise<NotifyResult> {
  const dedupKey = opts?.dedupKey;
  const dedupWindowMs = opts?.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const severity = opts?.severity ?? 'warn';

  // Route resolution happens FIRST — before the forensic 'attempting' line, so
  // that line records the REAL topic the message will go to (it used to record
  // an env-only topic whose chat_id was empty, which is how the outage stayed
  // invisible in app.log.jsonl for weeks).
  const { topic, token } = await resolveAlertRoute(opts?.topic);

  // Forensic trail: phase 1 — attempting
  log('info', 'notify', 'attempting', { subject, dedupKey, severity, topic });

  // --- Dedup check (only when dedupKey is provided) ---
  // prevCount/sameBody/newHash are carried forward to the WRITE step below so
  // the dedup file is read exactly once per call.
  let prevCount = 0;
  let sameBody = true;
  const newHash = bodyHashOf(body);
  if (dedupKey !== undefined) {
    try {
      const filePath = dedupFilePath(dedupKey);
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        const ts = new Date(parsed.timestamp).getTime();
        sameBody = typeof parsed.bodyHash === 'string' ? parsed.bodyHash === newHash : true;
        const storedWindow = typeof parsed.windowMs === 'number' ? parsed.windowMs : dedupWindowMs;
        // A CHANGED body resets to the caller's base window (it is new information),
        // but never bypasses that base window — otherwise a body carrying a
        // timestamp would defeat dedup entirely.
        const effectiveWindow = sameBody ? storedWindow : Math.min(storedWindow, dedupWindowMs);
        prevCount = Number(parsed.count) || 0;
        if (!isNaN(ts) && Date.now() - ts < effectiveWindow) {
          log('info', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: true, reason: 'dedup-suppressed' });
          return { sent: false, suppressed: true, reason: 'dedup-suppressed' };
        }
      } catch {
        // File doesn't exist or is corrupt — proceed to send
      }
    } catch {
      // Dedup check failure — proceed to send anyway
    }
  }

  // --- Send ---
  if (process.env.PA_NOTIFY_DISABLED === '1') {
    log('info', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason: 'disabled' });
    return { sent: false, suppressed: false, reason: 'disabled' };
  }

  if (!token) {
    log('info', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason: 'missing-token' });
    return { sent: false, suppressed: false, reason: 'missing-token' };
  }

  // Hard guard: an empty chat_id is undeliverable by construction. Loud (error
  // level) and NO dedup state — suppressing an alert we never even attempted
  // would re-create the silent outage this guard exists to end.
  if (!topic.chat_id) {
    log('error', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason: 'no-chat-id' });
    return { sent: false, suppressed: false, reason: 'no-chat-id' };
  }

  const fullText = body ? `${subject}\n\n${body}` : subject;

  // Append runbook link if provided
  const textWithRunbook = opts?.runbook
    ? `${fullText}\n\nRunbook: ${opts.runbook}`
    : fullText;

  try {
    const sendPromise = sendToTelegram(
      textWithRunbook,
      { chat_id: topic.chat_id, thread_id: topic.thread_id, token_secret: 'TELEGRAM_BOT_TOKEN' },
      token,
      'MarkdownV2', // sendToTelegram routes the body through sanitizeMdV2 — alert bodies (paths, snake_case identifiers, parens) are escaped, italic `_Ref: <id>_` trailer renders as italic.
      opts?.replyMarkup,
    );

    // Hard timeout so a wedged send can't hang a skill run. The race does NOT
    // cancel the underlying request, so a timeout means UNKNOWN OUTCOME, not
    // failure — 3 of the 30 'timeout' rows in the 2026-07 audit window were
    // provably delivered anyway. Hence the honest reason string.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), sendTimeoutMs());
    });

    const outcome = await Promise.race([sendPromise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer); // don't hold the event loop open for a CLI run
    });

    if (outcome === 'timeout') {
      // Short mute (2026-08-23), NOT the escalated window and NOT a no-op: the
      // notifier races the send against a 5 s timeout (sendTimeoutMs) while
      // telegram.ts honours real retry_after waits of 27-61 s on a 429, so a
      // timed-out send used to re-fire on every per-minute catchup tick into an
      // already-throttled chat (the 429 loop of review §5.4) because dedup was
      // written only on confirmed success. `count` is deliberately NOT
      // incremented — a timeout is not a confirmed send, so it must not
      // consume an escalation step — and TIMEOUT_DEDUP_MS (10 min) is short
      // enough that a genuinely new condition is never silenced for long.
      if (dedupKey !== undefined) {
        try {
          mkdirSync(alertStateDir(), { recursive: true });
          await writeFile(dedupFilePath(dedupKey), JSON.stringify({
            timestamp: new Date().toISOString(), key: dedupKey, windowMs: TIMEOUT_DEDUP_MS, count: prevCount ?? 0, bodyHash: newHash,
          }), 'utf8');
        } catch {
          // Dedup write failure — non-critical
        }
      }
      log('warn', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason: 'timeout-unknown-outcome' });
      return { sent: false, suppressed: false, reason: 'timeout-unknown-outcome' };
    }

    if (!outcome.ok) {
      log('error', 'notify', 'result', {
        subject,
        dedupKey,
        sent: false,
        suppressed: false,
        reason: 'send-failed',
        failure: outcome.reason,
        status: outcome.status,
        detail: outcome.detail,
      });
      return { sent: false, suppressed: false, reason: 'send-failed' };
    }

    // Write dedup state ONLY on a confirmed send (only when dedupKey is provided).
    // Escalating window (2026-08-23): an UNCHANGED body (same bodyHash) doubles
    // its dedup window on every confirmed repeat, capped at ESCALATION_CAP_MS —
    // a permanently failing condition used to page every flat window forever
    // (restore-drill: 180 sends in 7.5 days, review §3.1). A CHANGED body resets
    // count to 1 and the window to the caller's base. Callers already passing a
    // 24h dedupWindowMs (skill-parked, maintenance-skipped, public-sync) are
    // unaffected: min(24h * 2^n, 24h) === 24h. `escalate: false` opts out
    // entirely (flat window, count pinned at 1).
    if (dedupKey !== undefined) {
      try {
        mkdirSync(alertStateDir(), { recursive: true });
        const count = opts?.escalate === false ? 1 : (sameBody ? prevCount + 1 : 1);
        const windowMs = opts?.escalate === false ? dedupWindowMs : escalatedWindowMs(dedupWindowMs, count);
        await writeFile(dedupFilePath(dedupKey), JSON.stringify({
          timestamp: new Date().toISOString(), key: dedupKey, windowMs, count, bodyHash: newHash,
        }), 'utf8');
      } catch {
        // Dedup write failure — non-critical
      }
    }

    log('info', 'notify', 'result', { subject, dedupKey, sent: true, suppressed: false, reason: 'sent', chunks: outcome.chunks });
    return { sent: true, suppressed: false, reason: 'sent' };
  } catch (err: any) {
    // sendToTelegram never throws, so this is a belt-and-braces path only.
    log('error', 'notify', 'result', { subject, dedupKey, sent: false, suppressed: false, reason: 'telegram-error', detail: err?.message });
    return { sent: false, suppressed: false, reason: 'telegram-error' };
  }
}
