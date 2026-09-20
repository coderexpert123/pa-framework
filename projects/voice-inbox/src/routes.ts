/**
 * HTTPS API routes (AI-201 WP-B, §6 endpoint table).
 *
 * `createRouter(deps)` returns a socket-free handler: the server (server.ts)
 * adapts node:http onto it, and the tests drive it directly. Every task /
 * request / event access flows through the ledger's tenant-scoped queries, so
 * a cross-tenant id is indistinguishable from a missing one (404).
 *
 * Pinned bodies (§6): 401 is exactly {"ok":false,"error":"unauthorized"};
 * the answer ack is exactly {"ok":true,"status":"answered"}. Voice uploads
 * store the audio under files/<task_id>/, create the task in transcribing,
 * and queue a transcribe-first entry — the topic worker transcribes; this
 * server holds no transcription secrets. The spec pins no other error
 * strings — the remaining short lowercase reasons below are this WP's
 * choice, each paired with the least-surprising status.
 *
 * Auth is `Authorization: Bearer` on everything except `/health` and
 * `/pair/exchange`. `/pair/exchange` is rate-limited (5/min per remote IP).
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  validateInputAnswer,
  type InputKind,
  type InputRequest,
} from './contracts.js';
import { CONFIG_DEFAULTS, splitTopicKey, type VoiceInboxConfig } from './config.js';
import {
  appendRouteEntry,
  buildAttachmentsSegment,
  buildInboxInjectionText,
  buildVoiceInboxInjectionText,
  type ContinuationRef,
  type FeedbackRef,
  type TopicRef,
} from './bridge-writer.js';
import {
  INBOX_BRIEFING_MAX,
  buildConversationBriefing,
  buildTargetInjectionTextWithBriefing,
  ledgerPathOf,
} from './conversation-briefing.js';
import { answerAndResume, type AnswerInput } from './answer-resume.js';
import {
  defaultWriteTokenFile,
  handleAuthCallback,
  makeScriptRunner,
  type AuthCallbackDeps,
} from './auth-callback.js';
import { readAuthRequestRowByState, writeAuthRequestRow } from './auth-providers.js';
import {
  appendEvent,
  ATTACHMENTS_PLACEHOLDER,
  conversationWorkerResource,
  createTask,
  getConversationMeta,
  getInputRequest,
  getTask,
  getTenant,
  LedgerError,
  listConversationTasks,
  listConversations,
  listConversationsPage,
  countConversations,
  listEvents,
  listInputRequests,
  listCancellableTasks,
  listOpenConversations,
  listRecentConversations,
  listRetryableFailures,
  listTasks,
  mintConversationShare,
  revokeConversationShare,
  resolveConversationShareToken,
  getActiveConversationShare,
  setConversationViewed,
  summarizeConversationById,
  TASK_STATES,
  transitionTask,
  VOICE_TRANSCRIBING_PLACEHOLDER,
  type ConversationSummaryRow,
  type InputRequestRow,
  type LedgerEventRow,
  type TaskRow,
} from './ledger.js';
import {
  exchangePairingCode,
  authenticateSession,
} from './identity.js';
import { mintOauthAuthUrl, pollOauthResolutions } from './oauth-mint.js';
import {
  getOrCreateVapidPublicKey,
  removeSubscription,
  saveSubscription,
  type PushSubscriptionKeys,
} from './web-push-store.js';
import { getSystemStatus, type SystemStatus } from './system-status.js';
import { readKnowledgeBase, type KbRoots } from './kb.js';
import type { ScreencastStore } from './screencast-store.js';
import type { ScreencastInputStore } from './screencast-input-store.js';
import { handleLiveRoute } from './routes-live.js';

// --- Public row shaping ---------------------------------------------------------

interface PublicEventRow {
  event_id: number;
  ref_id: string;
  kind: string;
  summary: string | null;
  payload: Record<string, unknown>;
  ts: string;
}

function publicEvent(e: LedgerEventRow): PublicEventRow {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(e.payload_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return {
    event_id: e.event_id,
    ref_id: e.ref_id,
    kind: e.kind,
    summary: e.summary,
    payload,
    ts: e.ts,
  };
}

/** §3.1: the stored task row minus internal plumbing that never leaves the
 * server. `conversation_id` and `steer_mode` are already on TaskRow, so no
 * addition is needed here — only the drop.
 * Both are internal plumbing and never leave the server: worker_resource
 * names the lane, worker_dispatch_id names the dispatch. steer_mode DOES
 * leave — it is operator-set metadata the PWA renders.
 * The v16 router_* metadata fields flow through this rest-spread — they are
 * AUTHENTICATED-ONLY surface and are dropped by publicShareTask below. */
function publicTask(row: TaskRow) {
  const { worker_resource: _dropResource, worker_dispatch_id: _dropDispatch, ...rest } = row;
  return rest;
}

/** §3.6: from `routed_to = "<chatId>_<threadId>"`, a `t.me/c/...` deep link
 * to a `-100…` supergroup topic; null when routed_to is null, unparseable,
 * or not a -100… chat (no message anchor this wave — follow-up F1). */
function telegramLink(routedTo: string | null): string | null {
  if (routedTo === null) return null;
  const target = splitTopicKey(routedTo);
  if (!target) return null;
  const chatStr = String(target.chatId);
  if (!chatStr.startsWith('-100')) return null;
  return `https://t.me/c/${chatStr.slice(4)}/${target.threadId}`;
}

/** WP-5 §3.2: a SNAPSHOT of what the conversation currently offers to steer.
 *  Never a promise about routing time, and "none" never means the steer will
 *  fail — the bot folds before start and retries. */
function steerTarget(db: Database.Database, tenantId: string, conversationId: string): 'thread' | 'topic' | 'none' {
  const resource = conversationWorkerResource(db, tenantId, conversationId);
  if (resource === null) return 'none';
  if (/^topic-(-?\d+)_(\d+)-th(\d+)$/.test(resource)) return 'thread';
  if (/^topic-(-?\d+)_(\d+)$/.test(resource)) return 'topic';
  return 'none';
}

/**
 * AI-223: true when `row`'s own state is `transcribe_failed` AND the newest
 * `task.failed` event on its latest task carries `payload.code ===
 * "too_short"`. Computed here (a direct, tenant-scoped query) rather than in
 * ledger.ts's `ConversationSummaryRow` — that shape carries no per-task event
 * data, and this flag exists only to drive one client-side hiding decision
 * (the list and the triage count), not a durable ledger concept. Fail-closed
 * to `false` on any read/parse error — a query hiccup must never hide a real
 * failure the operator needs to see.
 */
function isTooShortFailure(db: Database.Database, tenantId: string, row: ConversationSummaryRow): boolean {
  if (row.state !== 'transcribe_failed') return false;
  try {
    const event = db
      .prepare(
        `SELECT payload_json FROM events
         WHERE tenant_id = ? AND task_id = ? AND kind = 'task.failed'
         ORDER BY event_id DESC LIMIT 1`
      )
      .get(tenantId, row.latest_task_id) as { payload_json: string } | undefined;
    if (!event) return false;
    const parsed: unknown = JSON.parse(event.payload_json);
    return (
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>)['code'] === 'too_short'
    );
  } catch {
    return false;
  }
}

// §3 of the feedback spec (2026-09-13): level resolution. A feedback task
// whose `feedback_about` names a mid-conversation task renders task-level
// framing; a conversation root (or an unknown id) renders conversation-level.
// Title comes from conversation_meta of the resolved conversation.
function resolveFeedbackRef(db: Database.Database, tenantId: string, about: string): FeedbackRef {
  const refTask = getTask(db, tenantId, about);
  if (refTask && refTask.conversation_id !== about) {
    const meta = getConversationMeta(db, tenantId, refTask.conversation_id);
    return { about, title: meta?.title ?? null, level: 'task', conversationId: refTask.conversation_id };
  }
  const meta = getConversationMeta(db, tenantId, about);
  return { about, title: meta?.title ?? null, level: 'conversation', conversationId: about };
}

/** A conversation summary row plus its derived telegram_link (§3.4/§3.5),
 * too_short flag (AI-223 — see isTooShortFailure), and (t-3, 2026-09-18)
 * resolved feedback origin — undefined when the conversation carries no
 * feedback_about, so every pre-existing response shape stays byte-identical. */
function publicConversationSummary(
  db: Database.Database,
  tenantId: string,
  row: ConversationSummaryRow
): ConversationSummaryRow & { telegram_link: string | null; too_short: boolean; feedback: FeedbackRef | undefined } {
  return {
    ...row,
    telegram_link: telegramLink(row.routed_to),
    too_short: isTooShortFailure(db, tenantId, row),
    feedback: row.feedback_about === null ? undefined : resolveFeedbackRef(db, tenantId, row.feedback_about),
  };
}

/**
 * §4's answer-privacy rule: a request that has been answered surfaces ONLY
 * its status + answered_at — never the pointer, never the value. Pending
 * requests carry the widget fields the PWA renders (params include the
 * backend-minted `auth_url`/`auth_id` for oauth when present).
 */
function publicInputRequest(r: InputRequestRow): Record<string, unknown> {
  if (r.status !== 'pending') {
    return {
      request_id: r.request_id,
      kind: r.kind,
      status: r.status,
      created_at: r.created_at,
      answered_at: r.answered_at,
    };
  }
  let params: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(r.params_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      params = parsed as Record<string, unknown>;
    }
  } catch {
    params = {};
  }
  return {
    request_id: r.request_id,
    kind: r.kind,
    prompt: r.prompt,
    params,
    status: r.status,
    created_at: r.created_at,
  };
}

/**
 * AI-227: the public share view's task shaping — strictly stricter than
 * `publicTask` above. Drops everything internal-routing-shaped
 * (`tenant_id`, `routed_to`, `routing_reason`, `worker_resource`,
 * `worker_dispatch_id`) since an unauthenticated viewer must never learn
 * which tenant, chat, or worker lane a conversation belongs to.
 * Schema v16: the six `router_*` metadata columns join the drop list —
 * `router_target` is routing internals of exactly the class AI-227 drops
 * (a `routed_to`-shaped conversation id), and the rest are worker-selection
 * internals an unauthenticated viewer has no business seeing.
 */
function publicShareTask(task: TaskRow): Record<string, unknown> {
  const {
    tenant_id: _dropTenant,
    routed_to: _dropRoutedTo,
    routing_reason: _dropRoutingReason,
    worker_resource: _dropResource,
    worker_dispatch_id: _dropDispatch,
    router_decision: _dropRouterDecision,
    router_placement: _dropRouterPlacement,
    router_target: _dropRouterTarget,
    router_steer: _dropRouterSteer,
    router_steer_by: _dropRouterSteerBy,
    router_effort_proj: _dropRouterEffortProj,
    router_failovers: _dropRouterFailovers,
    ...rest
  } = task;
  return rest;
}

/**
 * AI-227: task.routed / task.rerouted event payloads carry `routed_to` /
 * `from` / `to` / `reason` (see contracts.ts's TaskRoutedPayload /
 * TaskReroutedPayload) — routing internals the spec's overview explicitly
 * forbids on the public share view alongside the row-level `routed_to`
 * column. The spec's WP2 mechanical instruction names plain `publicEvent`
 * for turn assembly, but that passes the raw payload through and would leak
 * exactly what the overview forbids; this wrapper is the deviation that
 * keeps the two consistent — see the builder report for AI-227 WP2.
 */
const SHARE_ROUTING_EVENT_KINDS: ReadonlySet<string> = new Set(['task.routed', 'task.rerouted']);

function publicShareEvent(e: LedgerEventRow): PublicEventRow {
  const base = publicEvent(e);
  if (SHARE_ROUTING_EVENT_KINDS.has(e.kind)) {
    return { ...base, payload: {} };
  }
  return base;
}

/**
 * AI-227: the public share view's input-request shaping. A pending request
 * carries ONLY `{request_id, kind, status, created_at}` — no `prompt`, no
 * `params` — because a pending oauth/secret request's prompt or params can
 * carry a live consent URL or other sensitive detail not meant for an
 * unauthenticated viewer. An answered/expired/cancelled request is safe to
 * show its prompt (the ask is resolved) but never its answer value/pointer.
 */
function publicShareInputRequest(input: InputRequestRow): Record<string, unknown> {
  if (input.status === 'pending') {
    return {
      request_id: input.request_id,
      kind: input.kind,
      status: input.status,
      created_at: input.created_at,
    };
  }
  return {
    request_id: input.request_id,
    kind: input.kind,
    prompt: input.prompt,
    status: input.status,
    created_at: input.created_at,
    answered_at: input.answered_at,
  };
}

// --- Shared readers ----------------------------------------------------------------

/** `~/.pa/telegram-topic-names.json` → [{key,label}]; fail-to-absent = []. */
export function readTopics(topicNamesPath: string): TopicRef[] {
  let raw: string;
  try {
    raw = readFileSync(topicNamesPath, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const out: TopicRef[] = [];
    for (const [chatId, threads] of Object.entries(parsed as Record<string, unknown>)) {
      if (threads === null || typeof threads !== 'object' || Array.isArray(threads)) continue;
      for (const [threadId, info] of Object.entries(threads as Record<string, unknown>)) {
        const label =
          info !== null && typeof info === 'object' && typeof (info as Record<string, unknown>)['name'] === 'string'
            ? ((info as Record<string, unknown>)['name'] as string)
            : threadId;
        out.push({ key: `${chatId}_${threadId}`, label });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// --- Multipart (single-file uploads: voice tasks + file-kind answers) --------------

export interface MultipartPart {
  name?: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function parseMultipart(body: Buffer, contentType: string | undefined): MultipartPart[] | null {
  if (!contentType) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  if (!boundary) return null;
  const dash = `--${boundary}`;
  const parts: MultipartPart[] = [];

  let pos = body.indexOf(dash);
  if (pos === -1) return null;
  while (pos !== -1) {
    const next = body.indexOf(dash, pos + dash.length);
    if (next === -1) break;
    // Part payload sits between the CRLF after the boundary line and the CRLF
    // that precedes the next boundary.
    let start = pos + dash.length;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    let end = next;
    if (end >= 2 && body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;
    if (end < start) break;
    const chunk = body.subarray(start, end);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      pos = next;
      continue;
    }
    const headerText = chunk.subarray(0, headerEnd).toString('utf8');
    const data = chunk.subarray(headerEnd + 4);
    const disposition = /content-disposition:\s*form-data;([^\r\n]*)/i.exec(headerText)?.[1] ?? '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1];
    const partContentType = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim();
    parts.push({
      name,
      filename: filename && filename.length > 0 ? filename : undefined,
      contentType: partContentType,
      data,
    });
    pos = next;
  }
  return parts;
}

function fileNameExtension(filename: string | undefined): string {
  if (!filename) return '';
  const match = /\.([A-Za-z0-9]+)$/.exec(filename);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function sanitizeUploadName(filename: string | undefined): string {
  const base = (filename ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'upload.bin';
  return cleaned;
}

const AUDIO_MIME_TYPES: Record<string, string> = {
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

/** The one audio file a voice task stores, `files/<task_id>/audio.<ext>` — the
 * extension varies by upload (§1.9 keeps whatever the client sent), so the
 * directory is read rather than assumed. undefined when the task has no audio
 * on disk (a text task, or a voice task that failed before the write). */
function findAudioFile(filesDir: string, taskId: string): { path: string; contentType: string } | undefined {
  let entries: string[];
  try {
    entries = readdirSync(join(filesDir, taskId));
  } catch {
    return undefined;
  }
  const name = entries.find((f) => /^audio\./i.test(f));
  if (!name) return undefined;
  return {
    path: join(filesDir, taskId, name),
    contentType: AUDIO_MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
  };
}

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ATTACHMENTS_DIR_CAP = 10;

/** Sanitize + de-conflict one attachment's stored name inside `dir`: the
 * existing sanitizeUploadName, then — because the audio route treats ANY
 * audio.* as the recording — a stored attachment must never match /^audio\./i
 * (prefix `file-`), and a name already on disk gets -2, -3, … appended before
 * the extension. */
function storedAttachmentName(dir: string, filename: string | undefined): string {
  let base = sanitizeUploadName(filename);
  if (/^audio\./i.test(base)) base = 'file-' + base;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let candidate = base;
  let n = 2;
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem}-${n}${ext}`;
    n += 1;
  }
  return candidate;
}

interface AttachmentEntry { name: string; bytes: number; }

/** The task's attachment listing: [{name, bytes}] sorted by name ascending,
 * excluding audio.* and tmp-*, non-files skipped, [] when the dir is missing.
 * This listing is the truth for what a task carries — and the membership
 * check against it IS the serving route's traversal guard. */
function attachmentEntries(filesDir: string, taskId: string): AttachmentEntry[] {
  const dir = join(filesDir, taskId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AttachmentEntry[] = [];
  for (const name of entries.filter((f) => !/^tmp-/i.test(f) && !/^audio\./i.test(f)).sort()) {
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, bytes: st.size });
    } catch {
      continue;
    }
  }
  return out;
}

/** Eligible attachment paths (absolute, forward-slashed, sorted by name) for
 * the injection-text segment — the logic twin of route_task.py's
 * task_attachment_paths (not byte-pinned). */
function taskAttachmentPaths(filesDir: string, taskId: string): string[] {
  const dir = join(filesDir, taskId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.filter((f) => !/^tmp-/i.test(f) && !/^audio\./i.test(f)).sort()) {
    try {
      if (!statSync(join(dir, name)).isFile()) continue;
    } catch {
      continue;
    }
    out.push(join(dir, name).replace(/\\/g, '/'));
  }
  return out;
}

/** The dir listing as a display list for the injection-text segment: capped
 * at ATTACHMENTS_DIR_CAP with a trailing `… and <k> more in <dir>` element
 * when the dir holds more (defensive — the API caps at 10, so this fires only
 * for out-of-band files). Logic twin of route_task.py's
 * attachments_display_paths. */
function attachmentsDisplayPaths(filesDir: string, taskId: string): string[] {
  const all = taskAttachmentPaths(filesDir, taskId);
  if (all.length <= ATTACHMENTS_DIR_CAP) return all;
  const dir = join(filesDir, taskId).replace(/\\/g, '/');
  return [...all.slice(0, ATTACHMENTS_DIR_CAP), `… and ${all.length - ATTACHMENTS_DIR_CAP} more in ${dir}`];
}

// --- Router ------------------------------------------------------------------------

export interface ApiRequest {
  method: string;
  /** Pathname beginning `/api/`. */
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  remoteAddress?: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** When present, server.ts serves this HTML verbatim and ignores `body`
   * (C1 — the callback's phone-facing landing page, §3.5). */
  html?: string;
  /** When present, server.ts streams this file verbatim and ignores `body`
   * (the original-recording playback route). */
  file?: { path: string; contentType: string };
  /** When present, server.ts writes these bytes verbatim with the given
   * content-type + no-store and ignores `body` (AI-246: the live-screencast
   * frame pull — a raw in-memory JPEG, never a file). */
  buffer?: { data: Buffer; contentType: string };
}

export interface RouteDeps {
  db: Database.Database;
  config: VoiceInboxConfig;
  /** Repo root — python worker scripts are referenced at
   * `<repoRoot>/projects/voice-inbox/scripts/…` in injection texts. */
  repoRoot: string;
  pairingCodesPath: string;
  routeQueuePath: string;
  topicNamesPath: string;
  answersDir: string;
  filesDir: string;
  /** Web Push storage-dir override (WP2, AI-201-follow-on): tests point this
   * at a temp dir so push-subscriptions.json/vapid.json never touch the
   * operator's real ~/.pa/voice-inbox. Omitted in production — server.ts
   * wires it to voiceInboxDir(), the same default web-push-store.ts's own
   * functions fall back to. */
  pushStorageDir?: string;
  now?: () => Date;
  /** Test seam: overrides the real spawn-and-parse in system-status.ts so
   * route tests don't fork a python process. Omitted in production —
   * server.ts leaves it undefined and the router falls back to the real
   * getSystemStatus(deps.repoRoot). */
  systemStatusFn?: () => Promise<SystemStatus>;
  /** Knowledge-base root override (vi-19787afc4b2e): tests point this at
   * fixture dirs so route tests never read the operator's real topic brains
   * or Ecosystem KB. Omitted in production — server.ts leaves it undefined
   * and the router falls back to kb.ts's defaultKbRoots() (the
   * web-push-store.ts seam pattern). */
  kbRoots?: KbRoots;
  /** AI-246: the in-memory screencast frame store (screencast-store.ts),
   * injected per-router so tests isolate — NOT a global. server.ts always
   * constructs it; a hand-built RouteDeps that omits it gets disabled-shaped
   * answers (ingest 503, pull 204, status live:false, taskDetail live:false). */
  screencastStore?: ScreencastStore;
  /** AI-246 v2: the in-memory screencast INPUT queue
   * (screencast-input-store.ts) — same optional/disabled-shape contract as
   * the frame store: absent (or screencast_input_enabled:false) answers
   * POST /live/:id/input and GET /live/:id/input with 503. In-memory only,
   * never on disk. */
  screencastInputStore?: ScreencastInputStore;
}

export const UNAUTHORIZED = { ok: false, error: 'unauthorized' } as const;

const EXCHANGE_RATE_LIMIT = 5;
const EXCHANGE_WINDOW_MS = 60_000;

export function json(value: unknown, status = 200): ApiResponse {
  return { status, body: value };
}

export function errorBody(status: number, error: string): ApiResponse {
  return { status, body: { ok: false, error } };
}

/** LedgerError → HTTP status. */
function statusForLedgerError(e: LedgerError): number {
  switch (e.code) {
    case 'task-not-found':
    case 'request-not-found':
      return 404;
    case 'illegal-transition':
    case 'request-already-answered':
      return 409;
    case 'tenant-not-found':
    case 'invalid-input':
    default:
      return 400;
  }
}

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

function contentTypeOf(headers: ApiRequest['headers']): string | undefined {
  const raw = headers['content-type'];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * POST /api/push/test: this package never duplicates pa/src/lib/web-push.ts's
 * RFC 8291/8292 encryption + dispatch engine (drift risk) — instead it shells
 * out to the already-built `pa ping` CLI (`<repoRoot>/pa/dist/bin/pa.js`),
 * the same compiled entry point package.json's `bin` names, with
 * `--no-toast --no-ping` so only the webPush leg fires. `pa ping` reads its
 * payload from a `--payload-file` (the injection-proof path, mirroring
 * ping-cmd.ts's own documented convention) and prints one JSON line —
 * `{toast, ping, webPush: {sent, failed, pruned, reason?}}` — on stdout.
 * Never throws: a spawn failure, timeout, or unparseable stdout all resolve
 * to `sent: 0` (logged via console.error since this file has no other
 * logger), matching the same "the JSON outcome carries the honest per-leg
 * result, exit 0 either way" contract ping-cmd.ts documents.
 */
async function runPushTest(repoRoot: string): Promise<number> {
  const payloadPath = join(tmpdir(), `pa-ping-test-${randomUUID()}.json`);
  try {
    writeFileSync(
      payloadPath,
      JSON.stringify({ title: 'Test Notification', body: 'Web Push is working correctly.' }),
      'utf8'
    );
  } catch (err) {
    console.error('push/test: failed to write payload file', err);
    return 0;
  }

  return new Promise<number>((resolvePromise) => {
    let settled = false;
    const finish = (sent: number): void => {
      if (settled) return;
      settled = true;
      try {
        rmSync(payloadPath, { force: true });
      } catch {
        /* best effort */
      }
      resolvePromise(sent);
    };

    let child;
    try {
      child = spawn(
        process.execPath,
        [join(repoRoot, 'pa', 'dist', 'bin', 'pa.js'), 'ping', '--payload-file', payloadPath, '--no-toast', '--no-ping'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (err) {
      console.error('push/test: failed to spawn pa ping', err);
      finish(0);
      return;
    }

    let stdout = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
      console.error('push/test: pa ping timed out');
      finish(0);
    }, 60_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('push/test: pa ping process error', err);
      finish(0);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length === 0) {
        console.error('push/test: pa ping produced no stdout');
        finish(0);
        return;
      }
      try {
        const parsed = JSON.parse(lines[lines.length - 1]) as { webPush?: { sent?: unknown } };
        const sent = typeof parsed.webPush?.sent === 'number' ? parsed.webPush.sent : 0;
        finish(sent);
      } catch (err) {
        console.error('push/test: pa ping stdout was not valid JSON', err);
        finish(0);
      }
    });
  });
}

export function createRouter(deps: RouteDeps): (req: ApiRequest) => Promise<ApiResponse> {
  // Sliding-window rate limiter state lives per-router (one per server).
  const exchangeHits = new Map<string, number[]>();

  // B-E8: the callback's deps, built once, sharing this router's db/repoRoot/
  // answersDir/routeQueuePath rather than re-resolving them per request.
  const authCallbackDeps: AuthCallbackDeps = {
    readRow: readAuthRequestRowByState,
    writeRow: writeAuthRequestRow,
    spawnFn: makeScriptRunner(deps.repoRoot),
    fetchFn: fetch,
    writeTokenFile: defaultWriteTokenFile,
    answerFn: async (tenantId, taskId, requestId, pointer) => {
      await answerAndResume(deps.db, tenantId, taskId, requestId, { kind: 'pointer', pointer }, {
        routeQueuePath: deps.routeQueuePath,
        answersDir: deps.answersDir,
        inputStore: deps.screencastInputStore,
      });
    },
    now: deps.now ?? (() => new Date()),
  };

  return async function handle(req: ApiRequest): Promise<ApiResponse> {
    const segments = req.pathname.split('/').filter(Boolean);
    // segments: ['api','v1', ...]
    if (segments[0] !== 'api' || segments[1] !== 'v1') {
      return errorBody(404, 'not found');
    }
    const rest = segments.slice(2);
    const method = req.method.toUpperCase();

    // --- No-auth endpoints (§6) ---------------------------------------------

    if (rest.length === 1 && rest[0] === 'health') {
      if (method !== 'GET') return errorBody(405, 'method not allowed');
      return json({ ok: true, service: 'voice-inbox' });
    }

    if (rest.length === 2 && rest[0] === 'pair' && rest[1] === 'exchange' && method === 'POST') {
      const rateKey = req.remoteAddress ?? 'unknown';
      const nowMs = (deps.now ?? (() => new Date()))().getTime();
      const hits = (exchangeHits.get(rateKey) ?? []).filter((t) => nowMs - t < EXCHANGE_WINDOW_MS);
      if (hits.length >= EXCHANGE_RATE_LIMIT) {
        exchangeHits.set(rateKey, hits);
        return errorBody(429, 'rate limited');
      }
      hits.push(nowMs);
      exchangeHits.set(rateKey, hits);

      const body = asObject(req.body);
      if (!body) return errorBody(400, 'invalid json');
      const result = exchangePairingCode(deps.db, body['code'], {
        pairingCodesPath: deps.pairingCodesPath,
        sessionTtlHours: deps.config.sessionTtlHours,
        now: deps.now,
      });
      if (!result.ok) {
        const reason =
          result.error === 'used-code' ? 'code already used'
          : result.error === 'expired-code' ? 'code expired'
          : 'invalid code';
        return errorBody(401, reason);
      }
      return json({ ok: true, session_token: result.token, tenant_id: result.tenantId });
    }

    if (rest.length === 2 && rest[0] === 'auth' && rest[1] === 'callback') {
      if (method !== 'GET') return errorBody(405, 'method not allowed');
      const r = await handleAuthCallback(
        { state: req.query.get('state'), code: req.query.get('code'), error: req.query.get('error') },
        authCallbackDeps,
      );
      return { status: r.status, body: null, html: r.html };
    }

    // AI-227: GET /api/v1/share/:token — public, unauthenticated, strictly
    // read-only. Placed above the authenticateSession gate on purpose: an
    // unguessable token IS the auth for this one endpoint, not a bearer
    // session.
    if (rest.length === 2 && rest[0] === 'share' && method === 'GET') {
      return publicShareHandler(rest[1]);
    }

    // AI-246: /api/v1/live — the screencast frame + input endpoints. Mounted
    // above the session gate because the bridge routes authenticate on the
    // shared ingest token (the bridge carries no paired-device session), not
    // a Bearer session: POST .../frame, DELETE .../, and GET .../input. The
    // operator routes authenticate a session themselves (paired-device
    // Bearer, tenant-scoped as usual): GET .../frame, GET .../, and
    // POST .../input — the auth split is deliberate (v2): a paired-device
    // token cannot drain input and the ingest token cannot enqueue it.
    if (rest[0] === 'live') {
      // The /live/* family lives in routes-live.ts (extracted AI-246 v3).
      return handleLiveRoute(req, method, rest, deps);
    }

    // --- Authenticated endpoints ---------------------------------------------

    const tenant = authenticateSession(deps.db, headerOf(req.headers, 'authorization'), deps.now);
    if (!tenant) return { status: 401, body: UNAUTHORIZED };

    if (rest.length === 1 && rest[0] === 'me' && method === 'GET') {
      return json({ ok: true, tenant_id: tenant.tenant_id, display_name: tenant.display_name });
    }

    if (rest.length === 1 && rest[0] === 'topics' && method === 'GET') {
      return json({ ok: true, topics: readTopics(deps.topicNamesPath) });
    }

    if (rest.length === 2 && rest[0] === 'system' && rest[1] === 'status') {
      if (method !== 'GET') return errorBody(405, 'method not allowed');
      try {
        const status = await (deps.systemStatusFn ? deps.systemStatusFn() : getSystemStatus(deps.repoRoot));
        return json({ ok: true, status });
      } catch {
        return errorBody(500, 'system status unavailable');
      }
    }

    // vi-19787afc4b2e: GET /api/v1/kb — Bearer-gated but NOT tenant-scoped
    // (same precedent as /system/status: machine-global knowledge, not
    // tenant data). Roots are fixed server-side; no request input reaches a
    // path. readKnowledgeBase fails soft on missing dirs, so a 500 here is
    // an unexpected read/parse failure only.
    if (rest.length === 1 && rest[0] === 'kb') {
      if (method !== 'GET') return errorBody(405, 'method not allowed');
      try {
        return json({ ok: true, kb: readKnowledgeBase(deps.kbRoots) });
      } catch {
        return errorBody(500, 'knowledge base unavailable');
      }
    }

    // Web Push (WP2): subscription storage + VAPID public key are owned by
    // web-push-store.ts; the actual encrypt+send engine is pa/src/lib/web-push.ts
    // (WP1) — see runPushTest's doc for why /test shells out rather than
    // duplicating it.
    if (rest[0] === 'push') {
      if (rest.length === 2 && rest[1] === 'vapid-public-key') {
        if (method !== 'GET') return errorBody(405, 'method not allowed');
        return json({ ok: true, publicKey: getOrCreateVapidPublicKey(deps.pushStorageDir) });
      }
      if (rest.length === 2 && rest[1] === 'subscribe') {
        if (method !== 'POST') return errorBody(405, 'method not allowed');
        const body = asObject(req.body);
        const subscription = body?.['subscription'];
        const endpoint =
          subscription !== null && typeof subscription === 'object'
            ? (subscription as Record<string, unknown>)['endpoint']
            : undefined;
        const keys =
          subscription !== null && typeof subscription === 'object'
            ? (subscription as Record<string, unknown>)['keys']
            : undefined;
        const p256dh = keys !== null && typeof keys === 'object' ? (keys as Record<string, unknown>)['p256dh'] : undefined;
        const auth = keys !== null && typeof keys === 'object' ? (keys as Record<string, unknown>)['auth'] : undefined;
        if (
          typeof endpoint !== 'string' || endpoint.length === 0 ||
          typeof p256dh !== 'string' || p256dh.length === 0 ||
          typeof auth !== 'string' || auth.length === 0
        ) {
          return errorBody(400, 'invalid subscription');
        }
        const userAgentRaw = body?.['userAgent'];
        const userAgent = typeof userAgentRaw === 'string' ? userAgentRaw : undefined;
        saveSubscription(
          {
            endpoint,
            keys: { p256dh, auth } satisfies PushSubscriptionKeys,
            tenantId: tenant.tenant_id,
            userAgent,
          },
          deps.pushStorageDir
        );
        return json({ ok: true });
      }
      if (rest.length === 2 && rest[1] === 'unsubscribe') {
        if (method !== 'POST') return errorBody(405, 'method not allowed');
        const body = asObject(req.body);
        const endpoint = body?.['endpoint'];
        if (typeof endpoint !== 'string' || endpoint.length === 0) {
          return errorBody(400, 'endpoint must be a non-empty string');
        }
        removeSubscription(endpoint, deps.pushStorageDir);
        return json({ ok: true });
      }
      if (rest.length === 2 && rest[1] === 'test') {
        if (method !== 'POST') return errorBody(405, 'method not allowed');
        const sent = await runPushTest(deps.repoRoot);
        return json({ ok: true, sent });
      }
      return errorBody(404, 'not found');
    }

    // GET /conversations, GET /conversations/:id (§3.4/§3.5) — resolved
    // before the tasks-only guard below, which would otherwise 404 them.
    if (rest[0] === 'conversations') {
      if (rest.length === 1) {
        if (method !== 'GET') return errorBody(405, 'method not allowed');
        return conversationsListHandler(req, tenant);
      }
      if (rest.length === 2) {
        if (method !== 'GET') return errorBody(405, 'method not allowed');
        return conversationDetailHandler(tenant, rest[1]);
      }
      // AI-227: POST /conversations/:id/share and .../unshare — authenticated,
      // tenant-scoped mint/revoke of the public read-only share link.
      if (rest.length === 3 && rest[2] === 'share') {
        if (method !== 'POST') return errorBody(405, 'method not allowed');
        try {
          const share = mintConversationShare(deps.db, tenant.tenant_id, rest[1]);
          return json({ ok: true, token: share.token, created_at: share.created_at });
        } catch (e) {
          return ledgerErrorResponse(e);
        }
      }
      if (rest.length === 3 && rest[2] === 'unshare') {
        if (method !== 'POST') return errorBody(405, 'method not allowed');
        revokeConversationShare(deps.db, tenant.tenant_id, rest[1]);
        return json({ ok: true, revoked: true });
      }
      // v14 thread lifecycle: POST /conversations/:id/viewed | /retry | /cancel —
      // authenticated, tenant-scoped thread actions.
      if (rest.length === 3 && (rest[2] === 'viewed' || rest[2] === 'retry' || rest[2] === 'cancel')) {
        if (method !== 'POST') return errorBody(405, 'method not allowed');
        if (rest[2] === 'viewed') return conversationViewedHandler(req, tenant, rest[1]);
        if (rest[2] === 'retry') return conversationRetryHandler(tenant, rest[1]);
        return conversationCancelHandler(tenant, rest[1]);
      }
      return errorBody(404, 'not found');
    }

    if (rest[0] !== 'tasks') return errorBody(404, 'not found');

    // POST /tasks — create (text JSON or multipart audio)
    if (rest.length === 1 && method === 'POST') {
      return createTaskHandler(req, tenant);
    }

    // GET /tasks — list (no id). Must resolve BEFORE any per-task lookup.
    if (rest.length === 1 && method === 'GET') {
      const statusParam = req.query.get('status') ?? undefined;
      let status: TaskRow['state'] | undefined;
      if (statusParam !== undefined) {
        if (!(TASK_STATES as readonly string[]).includes(statusParam)) {
          return errorBody(400, `status must be one of ${TASK_STATES.join(', ')}`);
        }
        status = statusParam as TaskRow['state'];
      }
      const limitParam = req.query.get('limit');
      let limit = 100;
      if (limitParam !== null) {
        const n = Number(limitParam);
        if (!Number.isInteger(n) || n < 1) return errorBody(400, 'limit must be a positive integer');
        limit = Math.min(n, 100); // §6: limit ≤ 100 — clamp, not reject
      }
      return json({ ok: true, tasks: listTasks(deps.db, tenant.tenant_id, { status, limit }).map(publicTask) });
    }

    const taskId = rest[1];
    if (!taskId) return errorBody(404, 'not found');
    const task = getTask(deps.db, tenant.tenant_id, taskId);
    if (!task) return errorBody(404, 'not found');

    // GET /tasks/:id — detail with embedded events + input_requests
    if (rest.length === 2 && method === 'GET') {
      return taskDetail(task);
    }

    // GET /tasks/:id/events?after=
    if (rest.length === 3 && rest[2] === 'events' && method === 'GET') {
      return eventsHandler(req, task);
    }

    // GET /tasks/:id/audio — the original recording, voice tasks only.
    // Playable both mid-transcription and after: the file is written
    // synchronously in createTaskHandler, before the task ever queues.
    if (rest.length === 3 && rest[2] === 'audio' && method === 'GET') {
      if (task.source !== 'voice') return errorBody(404, 'not found');
      const file = findAudioFile(deps.filesDir, task.task_id);
      if (!file) return errorBody(404, 'not found');
      return { status: 200, body: null, file };
    }

    // GET /tasks/:id/attachments/:name — one stored attachment. The name must
    // EQUAL an entry of the task's own attachment listing (percent-decoded
    // first; a malformed escape is a 404) — the listing check IS the
    // traversal guard, and the served path is built from the LISTED name.
    // (Method check INSIDE the block, not in the condition, so a POST to this
    // path is a 405 rather than falling through to the final 404.)
    if (rest.length === 4 && rest[2] === 'attachments') {
      if (method !== 'GET') return errorBody(405, 'method not allowed');
      let wanted: string;
      try {
        wanted = decodeURIComponent(rest[3] ?? '');
      } catch {
        return errorBody(404, 'not found');
      }
      const entry = attachmentEntries(deps.filesDir, task.task_id).find((a) => a.name === wanted);
      if (!entry) return errorBody(404, 'not found');
      return {
        status: 200,
        body: null,
        file: {
          path: join(deps.filesDir, task.task_id, entry.name),
          contentType: ATTACHMENT_MIME_TYPES[extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
        },
      };
    }

    // POST /tasks/:id/inputs/:requestId
    if (rest.length === 4 && rest[2] === 'inputs' && method === 'POST') {
      return answerHandler(req, tenant, task, rest[3]);
    }

    // POST /tasks/:id/cancel
    if (rest.length === 3 && rest[2] === 'cancel' && method === 'POST') {
      try {
        transitionTask(deps.db, tenant.tenant_id, task.task_id, 'cancelled', {
          eventKind: 'task.cancelled',
          eventPayload: { by: 'operator' },
        });
      } catch (e) {
        return ledgerErrorResponse(e);
      }
      // The ledger flip has landed and must stay visible: a failed or
      // impossible stop degrades to stop_requested:false, never to a 500.
      const stopRequested = await appendCancelEntry(tenant.tenant_id, task);
      return json({ ok: true, state: 'cancelled', stop_requested: stopRequested });
    }

    // POST /tasks/:id/reroute
    if (rest.length === 3 && rest[2] === 'reroute' && method === 'POST') {
      return rerouteHandler(req, tenant, task);
    }

    return errorBody(404, 'not found');
  };

  // --- handlers (closures over deps) ---------------------------------------

  function ledgerErrorResponse(e: unknown): ApiResponse {
    if (e instanceof LedgerError) return errorBody(statusForLedgerError(e), e.message);
    throw e;
  }

  /** The `kind:"cancel"` verb entry for a task with worker identity — shared
   *  by POST /tasks/:id/cancel and the v14 thread cancel. Returns whether a
   *  stop was requested; a failed or impossible append is false, never a throw
   *  (the ledger flip has already landed). */
  async function appendCancelEntry(tenantId: string, task: TaskRow): Promise<boolean> {
    const target = task.routed_to ? splitTopicKey(task.routed_to) : null;
    const resource = (task.worker_resource ?? '').trim();
    const dispatchId = (task.worker_dispatch_id ?? '').trim();
    if (resource === '' || !target) return false;
    try {
      await appendRouteEntry(deps.routeQueuePath, {
        taskId: task.task_id,
        tenantId,
        chatId: target.chatId,
        threadId: target.threadId,
        text: `[Voice inbox task ${task.task_id} cancelled by the operator]`,
        kind: 'cancel',
        workerResource: resource,
        ...(dispatchId !== '' ? { workerDispatchId: dispatchId } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The create pipeline's tail, shared by POST /tasks and the v14 thread
   * Retry: read the topics, offer recent conversations (none for a feedback
   * task or a known continuation), build the continuation briefing, render
   * the voice inbox text (a recording still to transcribe) or the typed inbox
   * text, and append the inbox route entry (§6/§7). A lost append on a voice
   * task writes the AI-239 non-terminal infra marker; a text task stays
   * `received` for the fallback. 'invalid-inbox' = the configured inbox topic
   * does not parse (nothing queued). A LedgerError from the marker write
   * propagates to the caller.
   */
  async function enqueueInboxEntry(
    tenantId: string,
    task: TaskRow,
    input: {
      requestText: string;
      audioPath: string | undefined;
      attachments: string[];
      continuation: ContinuationRef | undefined;
      feedbackAbout: string | undefined;
    }
  ): Promise<'queued' | 'queue-failed' | 'invalid-inbox'> {
    const topics = readTopics(deps.topicNamesPath);
    const inbox = splitTopicKey(deps.config.inboxTopic);
    if (!inbox) return 'invalid-inbox';
    // Design §2.1: a feedback task must never be invited to merge into the
    // conversation it is about; a known continuation gets the continuation
    // segment instead of an offer.
    const openConversations = input.feedbackAbout !== undefined || input.continuation !== undefined
      ? []
      : listOpenConversations(deps.db, tenantId, {
          excludeConversationId: task.conversation_id,
        }).map((c) => ({ taskId: c.conversationId, snippet: c.snippet }));
    const feedbackRef = input.feedbackAbout === undefined
      ? undefined
      : resolveFeedbackRef(deps.db, tenantId, input.feedbackAbout);
    const conversationBriefing =
      input.continuation === undefined
        ? ''
        : buildConversationBriefing(deps.db, tenantId, {
            conversationId: input.continuation.conversationId,
            excludeTaskId: task.task_id,
            ledgerPath: ledgerPathOf(deps.db),
            maxChars: INBOX_BRIEFING_MAX,
          });
    const queueText =
      input.audioPath !== undefined
        ? buildVoiceInboxInjectionText({
            taskId: task.task_id,
            audioPath: input.audioPath,
            attachments: input.attachments,
            topics,
            repoRoot: deps.repoRoot,
            openConversations,
            continuation: input.continuation,
            conversationBriefing,
            feedback: feedbackRef,
          })
        : buildInboxInjectionText({
            taskId: task.task_id,
            requestText: input.requestText,
            attachments: input.attachments,
            topics,
            repoRoot: deps.repoRoot,
            openConversations,
            continuation: input.continuation,
            conversationBriefing,
            feedback: feedbackRef,
          });
    try {
      await appendRouteEntry(deps.routeQueuePath, {
        taskId: task.task_id,
        tenantId,
        chatId: inbox.chatId,
        threadId: inbox.threadId,
        text: queueText,
      });
      return 'queued';
    } catch {
      // The task exists in the ledger; a lost queue append must be VISIBLE
      // (§1.9). AI-239: for a voice task the audio is already on disk and the
      // queue write is pure infrastructure — this is recoverable, not a dead
      // recording. It gets a NON-TERMINAL infra marker (a task.failed event
      // with code 'infra' and NO state change — the same marker the
      // deterministic fallback writes for transcription-infra failures) and
      // stays `transcribing`; the voice-inbox-fallback job then transcribes it
      // and routes the result, re-creating the queue entry — the same
      // recovery a text task already gets by staying `received`. If the
      // fallback is disabled the marker still records the failure in the
      // task's event log instead of a silent loss.
      if (input.audioPath !== undefined) {
        appendEvent(deps.db, tenantId, task.task_id, 'task.failed', {
          payload: { reason: 'route queue write failed', code: 'infra' },
        });
      }
      return 'queue-failed';
    }
  }

  async function createTaskHandler(req: ApiRequest, tenant: { tenant_id: string }): Promise<ApiResponse> {
    const ctype = contentTypeOf(req.headers) ?? '';
    let source: 'voice' | 'text';
    let requestText: string;
    let audio: MultipartPart | undefined;
    let fileParts: MultipartPart[] = [];
    let continuesId: string | undefined;
    let steerRaw: string | undefined;
    let steerMode: 'queue' | 'interrupt' | undefined;
    let feedbackAbout: string | undefined;
    // P6: the client's layout hint. `surfaceRaw` holds whatever arrived on
    // either body shape; `surface` holds it only after the allowlist below.
    let surfaceRaw: string | undefined;
    let surface: 'phone' | 'desktop' | undefined;

    if (ctype.includes('multipart/form-data')) {
      const parts = parseMultipart(req.body, ctype);
      if (!parts) return errorBody(400, 'multipart body must carry an "audio" file part');
      // Strict part naming (task attachments, 2026-09-13): "audio" = the
      // recording, "files" (with filename) = attachments, "text" = typed text,
      // continues/steer/feedback_about as today. A file part with any other
      // name is a client bug — the old loose any-file-part fallback would
      // misread a screenshot as audio. POST /tasks ONLY: the file-kind ANSWER
      // handler keeps its own loose first-file-part rule by design.
      const strayFilePart = parts.find(
        (p) => p.filename !== undefined && p.data.length > 0 && p.name !== 'audio' && p.name !== 'files'
      );
      if (strayFilePart) return errorBody(400, `unexpected file part "${strayFilePart.name}"`);
      const foundAudio = parts.find((p) => p.name === 'audio' && p.data.length > 0);
      fileParts = parts.filter((p) => p.name === 'files' && p.filename !== undefined && p.data.length > 0);
      let textPart: string | undefined;
      const textValue = parts.find((p) => p.name === 'text')?.data.toString('utf8');
      if (textValue !== undefined) textPart = textValue;
      // Text cap is opt-in (2026-09-13): unset/0 = no limit; only `length < 1`
      // always rejects. N interpolates the knob when it is set.
      const maxTextChars = deps.config.maxTextChars;
      if (
        textPart !== undefined &&
        (textPart.length < 1 || (maxTextChars !== undefined && textPart.length > maxTextChars))
      ) {
        return errorBody(400, `text must be a string of 1..${maxTextChars ?? 1} chars`);
      }
      if (!foundAudio && fileParts.length === 0 && textPart === undefined) {
        return errorBody(400, 'multipart body must carry an "audio" file part');
      }
      if (foundAudio) {
        // AI-223 floor (junk-recordings, still defaulted) + the §4 upload cap,
        // now OPT-IN (2026-09-13): unset = no limit. Both gate only the audio part.
        const minAudioBytes = deps.config.minAudioBytes ?? CONFIG_DEFAULTS.minAudioBytes;
        if (foundAudio.data.length < minAudioBytes) {
          return errorBody(400, 'recording too short');
        }
        if (
          deps.config.maxUploadMb !== undefined &&
          foundAudio.data.length > deps.config.maxUploadMb * 1024 * 1024
        ) {
          return errorBody(413, `audio upload exceeds max_upload_mb (${deps.config.maxUploadMb})`);
        }
      }
      // Attachment caps — OPT-IN (2026-09-13): enforced only when the knob is
      // set, and all rejected BEFORE the row exists (no task, no event, no
      // files). Order: count, per-file, total.
      if (deps.config.maxTaskAttachments !== undefined && fileParts.length > deps.config.maxTaskAttachments) {
        return errorBody(
          400,
          `at most ${deps.config.maxTaskAttachments} attachments per task (max_task_attachments)`
        );
      }
      for (const part of fileParts) {
        if (
          deps.config.maxUploadMb !== undefined &&
          part.data.length > deps.config.maxUploadMb * 1024 * 1024
        ) {
          return errorBody(
            413,
            `attachment "${sanitizeUploadName(part.filename)}" exceeds max_upload_mb (${deps.config.maxUploadMb})`
          );
        }
      }
      if (deps.config.maxAttachmentTotalMb !== undefined) {
        const totalBytes = fileParts.reduce((s, p) => s + p.data.length, 0);
        if (totalBytes > deps.config.maxAttachmentTotalMb * 1024 * 1024) {
          return errorBody(
            413,
            `attachments exceed max_attachment_total_mb (${deps.config.maxAttachmentTotalMb})`
          );
        }
      }
      // §1.9: uploads are held in memory — the row is created FIRST, so every
      // storage failure is a VISIBLE transition instead of a silent error.
      source = foundAudio ? 'voice' : 'text';
      requestText = foundAudio
        ? VOICE_TRANSCRIBING_PLACEHOLDER
        : (textPart ?? ATTACHMENTS_PLACEHOLDER);
      audio = foundAudio;
      const continuesPart = parts.find((p) => p.name === 'continues');
      if (continuesPart) {
        const value = continuesPart.data.toString('utf8').trim();
        if (value.length > 0) continuesId = value;
      }
      const steerPart = parts.find((p) => p.name === 'steer');
      if (steerPart) {
        const value = steerPart.data.toString('utf8').trim();
        if (value.length > 0) steerRaw = value;
      }
      const feedbackPart = parts.find((p) => p.name === 'feedback_about');
      if (feedbackPart) {
        const value = feedbackPart.data.toString('utf8').trim();
        if (value.length > 0) feedbackAbout = value;
      }
      // P6: a plain value part, not a file part — the strayFilePart check
      // above only rejects unexpected FILE parts, so an older shell that
      // sends no surface part is still a valid request.
      const surfacePart = parts.find((p) => p.name === 'surface');
      if (surfacePart) {
        const value = surfacePart.data.toString('utf8').trim();
        if (value.length > 0) surfaceRaw = value;
      }
    } else {
      const body = asObject(req.body);
      if (!body) return errorBody(400, 'invalid json');
      const text = body['text'];
      // Same opt-in text cap as the multipart text part (2026-09-13).
      const maxTextChars = deps.config.maxTextChars;
      if (
        typeof text !== 'string' ||
        text.length < 1 ||
        (maxTextChars !== undefined && text.length > maxTextChars)
      ) {
        return errorBody(400, `text must be a string of 1..${maxTextChars ?? 1} chars`);
      }
      source = 'text';
      requestText = text;
      const continues = body['continues'];
      if (continues !== undefined) {
        if (typeof continues !== 'string' || continues.length < 1) {
          return errorBody(400, 'continues must be a non-empty string when present');
        }
        continuesId = continues;
      }
      const steer = body['steer'];
      if (steer !== undefined) {
        steerRaw = typeof steer === 'string' ? steer : String(steer);
      }
      const feedbackAboutRaw = body['feedback_about'];
      if (feedbackAboutRaw !== undefined && feedbackAboutRaw !== null && feedbackAboutRaw !== '') {
        if (typeof feedbackAboutRaw !== 'string') {
          return errorBody(400, 'feedback_about must be a "vi-<12 hex>" task or conversation id');
        }
        feedbackAbout = feedbackAboutRaw;
      }
      const surfaceValue = body['surface'];
      if (surfaceValue !== undefined && surfaceValue !== null && surfaceValue !== '') {
        // Stringified like `steer` above, so a non-string reaches the SAME
        // allowlist message instead of a shape message — one error text for
        // one field.
        surfaceRaw = typeof surfaceValue === 'string' ? surfaceValue : String(surfaceValue);
      }
    }

    if (feedbackAbout !== undefined && !/^vi-[0-9a-f]{12}$/.test(feedbackAbout)) {
      return errorBody(400, 'feedback_about must be a "vi-<12 hex>" task or conversation id');
    }
    if (feedbackAbout !== undefined && continuesId !== undefined) {
      return errorBody(400, 'feedback_about cannot be combined with continues');
    }

    if (steerRaw !== undefined) {
      if (steerRaw !== 'queue' && steerRaw !== 'interrupt') {
        return errorBody(400, 'steer must be "queue" or "interrupt"');
      }
      if (continuesId === undefined) return errorBody(400, 'steer requires continues');
      steerMode = steerRaw;
    }

    // P6: `surface` is a layout PREFERENCE and never gates content (SPEC
    // §6.3), but it is still allowlisted at the edge — a free-text column
    // would let a future renderer branch on an arbitrary string, which is
    // exactly the content gate the phase forbids. Absent stays undefined and
    // the row stores NULL: that is what every pre-v13 task carries and what
    // the PWA reads as "no preference".
    if (surfaceRaw !== undefined) {
      if (surfaceRaw !== 'phone' && surfaceRaw !== 'desktop') {
        return errorBody(400, 'surface must be "phone" or "desktop"');
      }
      surface = surfaceRaw;
    }

    // §2.5: feedback must reference an existing task/conversation in THIS
    // tenant — same convention as `continues`' parent lookup below.
    if (feedbackAbout !== undefined && !getTask(deps.db, tenant.tenant_id, feedbackAbout)) {
      return errorBody(404, 'not found');
    }

    // §3.2/D2: the explicit "reply into this thread" path — allowed into ANY
    // conversation, terminal included. `continues` names a task id in the
    // target conversation; the new task inherits that conversation and the
    // worker is told the routing decision outright (continuationSegment),
    // never offered the open-conversations menu for it.
    let continuation: ContinuationRef | undefined;
    let conversationId: string | undefined;
    if (continuesId !== undefined) {
      const parent = getTask(deps.db, tenant.tenant_id, continuesId);
      if (!parent) return errorBody(404, 'not found');
      conversationId = parent.conversation_id;
      continuation = { conversationId, topicKey: parent.routed_to };
      // t-3 (2026-09-18): feedback_about is client-writable only at
      // conversation creation (rejected above when combined with continues),
      // so a turn 2+ task would otherwise carry NULL and drop the "this
      // thread is feedback about X" marker the root turn set. Inherit the
      // conversation root's stored value — never overrides an explicit
      // client value, which the 400 above already guarantees is absent here.
      const root = getTask(deps.db, tenant.tenant_id, conversationId);
      feedbackAbout = root?.feedback_about ?? undefined;
    }

    let task: TaskRow;
    try {
      task = createTask(
        deps.db,
        tenant.tenant_id,
        source === 'voice'
          ? { source, requestText, initialState: 'transcribing', conversationId, steerMode, feedbackAbout, surface }
          : { source, requestText, conversationId, steerMode, feedbackAbout, surface }
      );
    } catch (e) {
      return ledgerErrorResponse(e);
    }

    // §3.2: a SNAPSHOT of what was recorded — omitted entirely when `steer`
    // was not supplied, so every existing response assertion stays green.
    const steerFields = steerMode === undefined
      ? {}
      : { steer_mode: steerMode, steer_target: steerTarget(deps.db, tenant.tenant_id, task.conversation_id) };

    // Voice: store the audio under files/<task_id>/, AFTER the row exists.
    // tmp-then-rename — a crash never leaves a partial final file. Any storage
    // failure moves the task VISIBLY to transcribe_failed (§1.9).
    let audioPath: string | undefined;
    if (audio) {
      const ext = fileNameExtension(audio.filename) || '.webm';
      const taskDir = join(deps.filesDir, task.task_id);
      const tmpPath = join(deps.filesDir, `tmp-${randomUUID()}.${ext.replace(/^\./, '')}`);
      audioPath = join(taskDir, `audio${ext}`);
      try {
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(tmpPath, audio.data);
        renameSync(tmpPath, audioPath);
      } catch {
        try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
        try {
          transitionTask(deps.db, tenant.tenant_id, task.task_id, 'transcribe_failed', {
            eventKind: 'task.failed',
            eventPayload: { reason: 'audio storage failed' },
          });
        } catch (e) {
          return ledgerErrorResponse(e);
        }
        return json({ ok: true, task_id: task.task_id, state: 'transcribe_failed', conversation_id: task.conversation_id, ...steerFields });
      }
    }

    // Attachments: store each files part under files/<task_id>/, tmp-then-
    // rename, AFTER the row exists (§1.9). A failure moves the task VISIBLY —
    // a voice task to transcribe_failed, a text task to failed with a
    // task.failed event — and the response reports that state, never a 500.
    const storedAttachmentPaths: string[] = [];
    if (fileParts.length > 0) {
      const taskDir = join(deps.filesDir, task.task_id);
      let tmpPath: string | undefined;
      try {
        mkdirSync(taskDir, { recursive: true });
        for (const part of fileParts) {
          const storedName = storedAttachmentName(taskDir, part.filename);
          const finalPath = join(taskDir, storedName);
          tmpPath = join(deps.filesDir, `tmp-${randomUUID()}.attach`);
          writeFileSync(tmpPath, part.data);
          renameSync(tmpPath, finalPath);
          tmpPath = undefined;
          storedAttachmentPaths.push(finalPath.replace(/\\/g, '/'));
        }
      } catch {
        if (tmpPath !== undefined) {
          try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
        }
        const failedState = audio !== undefined ? 'transcribe_failed' : 'failed';
        try {
          transitionTask(deps.db, tenant.tenant_id, task.task_id, failedState, {
            eventKind: 'task.failed',
            eventPayload: { reason: 'attachment storage failed' },
          });
        } catch (e) {
          return ledgerErrorResponse(e);
        }
        return json({
          ok: true,
          task_id: task.task_id,
          state: failedState,
          conversation_id: task.conversation_id,
          ...steerFields,
        });
      }
    }

    // §6: task creation then appends the route entry (§7) — the shared create
    // pipeline tail (enqueueInboxEntry), which the v14 thread Retry reuses.
    let enqueued: 'queued' | 'queue-failed' | 'invalid-inbox';
    try {
      enqueued = await enqueueInboxEntry(tenant.tenant_id, task, {
        requestText,
        audioPath,
        attachments: storedAttachmentPaths,
        continuation,
        feedbackAbout,
      });
    } catch (e) {
      return ledgerErrorResponse(e);
    }
    if (enqueued === 'invalid-inbox') return errorBody(500, 'configured inbox topic is invalid');
    return json({ ok: true, task_id: task.task_id, state: task.state, conversation_id: task.conversation_id, ...steerFields });
  }

  async function taskDetail(task: TaskRow): Promise<ApiResponse> {
    // §4 oauth plumbing runs on serve: mint a missing auth_url, then answer
    // any request whose minted session has resolved. Both are best-effort.
    await serviceOauth(task);
    const fresh = getTask(deps.db, task.tenant_id, task.task_id) ?? task;
    // AI-246 v2 WP-J: the operator-input record — present only once the
    // operator has an accepted input on this task (key omitted while null,
    // same conditional-presence convention as the live-status route).
    const operatorInputAt = deps.screencastInputStore?.lastInputAt(task.task_id) ?? null;
    return json({
      ok: true,
      task: {
        ...publicTask(fresh),
        // AI-246: routes-derived liveness (the in-memory store, TTL-checked) —
        // not a ledger column.
        live: deps.screencastStore?.has(task.task_id) ?? false,
        ...(operatorInputAt !== null ? { operator_input_at: operatorInputAt } : {}),
        attachments: attachmentEntries(deps.filesDir, task.task_id),
        events: listEvents(deps.db, task.tenant_id, task.task_id).map(publicEvent),
        input_requests: listInputRequests(deps.db, task.tenant_id, task.task_id).map(publicInputRequest),
      },
    });
  }

  async function conversationsListHandler(
    req: ApiRequest,
    tenant: { tenant_id: string }
  ): Promise<ApiResponse> {
    const limitParam = req.query.get('limit');
    let limit = 100;
    if (limitParam !== null) {
      const n = Number(limitParam);
      if (!Number.isInteger(n) || n < 1) return errorBody(400, 'limit must be a positive integer');
      limit = Math.min(n, 100); // clamped, not rejected — same convention as GET /tasks
    }
    // vi-19787afc4b2e: `total` is ALWAYS present (COUNT(DISTINCT
    // conversation_id) for the tenant); `offset` pages depth history —
    // absent/0 keeps the existing listConversations path, >= 1 walks
    // listConversationsPage (correct beyond the 500-task grouping window).
    const offsetParam = req.query.get('offset');
    let offset: number | null = null;
    if (offsetParam !== null) {
      const n = Number(offsetParam);
      if (!Number.isInteger(n) || n < 0) return errorBody(400, 'offset must be a non-negative integer');
      offset = n;
    }
    // Archive search (2026-09-15): `q` filters the list server-side —
    // whitespace-tokenized AND-terms, each a contains-match LIKE across
    // request_text / result_summary / meta title / recap (CONTRACTS.md). The
    // >200 check runs on the RAW string (pre-trim); empty after trim means
    // unfiltered. q present forces the paged path even at offset 0 —
    // listConversations has no filter support.
    const qParam = req.query.get('q');
    let q: string | null = null;
    if (qParam !== null) {
      if (typeof qParam !== 'string' || qParam.length > 200) {
        return errorBody(400, 'q must be a string of at most 200 characters');
      }
      const trimmed = qParam.trim();
      if (trimmed.length > 0) q = trimmed;
    }
    const now = (deps.now ?? (() => new Date()))();
    // v14: `view=recent` is the PWA's Recent list — every live/history-band
    // thread, rank-sorted, with NO row cap (an unviewed answer of any age is
    // never lost to a limit). It takes no q and no offset.
    const viewParam = req.query.get('view');
    if (viewParam !== null) {
      if (viewParam !== 'recent') return errorBody(400, 'view must be "recent" when present');
      if (qParam !== null || offsetParam !== null) return errorBody(400, 'view=recent takes no q or offset');
      const recent = listRecentConversations(deps.db, tenant.tenant_id, { now });
      return json({
        ok: true,
        conversations: recent.map((row) => publicConversationSummary(deps.db, tenant.tenant_id, row)),
        total: countConversations(deps.db, tenant.tenant_id),
      });
    }
    const hasFilter = q !== null;
    const total = hasFilter
      ? countConversations(deps.db, tenant.tenant_id, q)
      : countConversations(deps.db, tenant.tenant_id);
    const rows = (hasFilter || (offset !== null && offset > 0))
      ? listConversationsPage(deps.db, tenant.tenant_id, {
          limit,
          offset: offset ?? 0,
          q,
          now,
        })
      : listConversations(deps.db, tenant.tenant_id, { limit, now });
    const conversations = rows.map((row) => publicConversationSummary(deps.db, tenant.tenant_id, row));
    return json({ ok: true, conversations, total });
  }

  async function conversationDetailHandler(
    tenant: { tenant_id: string },
    conversationId: string
  ): Promise<ApiResponse> {
    // summarizeConversationById reads the FULL task list by conversation_id
    // (no 500-row cap), so this stays correct even for a tenant beyond
    // listConversations' grouping window; v14 adds the thread status fields.
    const summary = summarizeConversationById(
      deps.db,
      tenant.tenant_id,
      conversationId,
      (deps.now ?? (() => new Date()))()
    );
    if (summary === undefined) return errorBody(404, 'not found');
    const tasksAsc = listConversationTasks(deps.db, tenant.tenant_id, conversationId);
    const tasks: Array<Record<string, unknown>> = [];
    for (const t of tasksAsc) {
      await serviceOauth(t);
      const fresh = getTask(deps.db, tenant.tenant_id, t.task_id) ?? t;
      tasks.push({
        ...publicTask(fresh),
        attachments: attachmentEntries(deps.filesDir, t.task_id),
        events: listEvents(deps.db, tenant.tenant_id, t.task_id).map(publicEvent),
        input_requests: listInputRequests(deps.db, tenant.tenant_id, t.task_id).map(publicInputRequest),
      });
    }
    const share = getActiveConversationShare(deps.db, tenant.tenant_id, conversationId);
    return json({
      ok: true,
      conversation: {
        ...summary,
        telegram_link: telegramLink(summary.routed_to),
        // t-3 (2026-09-18): the origin banner's data — undefined (key
        // omitted) when this thread carries no feedback_about, matching
        // publicConversationSummary's list-endpoint shape.
        feedback: summary.feedback_about === null ? undefined : resolveFeedbackRef(deps.db, tenant.tenant_id, summary.feedback_about),
        tasks,
        share: share ? { active: true, token: share.token, created_at: share.created_at } : { active: false },
      },
    });
  }

  /**
   * AI-227: GET /api/v1/share/:token — unauthenticated, strictly read-only.
   * Deliberately does NOT call serviceOauth (forbidden on the public route —
   * §1 of the spec): a passive share viewer must never trigger backend
   * side-effects like minting an oauth auth_url.
   */
  async function publicShareHandler(token: string): Promise<ApiResponse> {
    const resolved = resolveConversationShareToken(deps.db, token);
    if (!resolved) return errorBody(404, 'not found');
    const { tenant_id: tenantId, conversation_id: conversationId } = resolved;
    const fullSummary = summarizeConversationById(
      deps.db,
      tenantId,
      conversationId,
      (deps.now ?? (() => new Date()))()
    );
    if (fullSummary === undefined) return errorBody(404, 'not found');
    const tasksAsc = listConversationTasks(deps.db, tenantId, conversationId);
    const meta = getConversationMeta(deps.db, tenantId, conversationId);
    // Strict privacy: routed_to (and the telegram_link publicConversationSummary
    // would derive from it) never reaches the public payload, and neither does
    // the operator's view time or the status derived from it (v14).
    const {
      routed_to: _dropRoutedTo,
      viewed_at: _dropViewedAt,
      status: _dropStatus,
      status_rank: _dropStatusRank,
      band: _dropBand,
      answer_landed_at: _dropAnswerLandedAt,
      failed_unresolved: _dropFailedUnresolved,
      ...summary
    } = fullSummary;
    const turns = tasksAsc.map((t) => ({
      ...publicShareTask(t),
      events: listEvents(deps.db, tenantId, t.task_id).map(publicShareEvent),
      input_requests: listInputRequests(deps.db, tenantId, t.task_id).map(publicShareInputRequest),
    }));
    // ConversationMetaRow carries tenant_id — drop it, same rule as
    // publicShareTask's task-row stripping (§1 overview: no tenant_id
    // anywhere in the public payload).
    const publicMeta = meta ? { conversation_id: meta.conversation_id, title: meta.title, recap: meta.recap, next_action: meta.next_action, updated_at: meta.updated_at } : null;
    return json({ ok: true, conversation: { summary, meta: publicMeta, turns } });
  }

  /** POST /conversations/:id/viewed (v14): body `{}` or `{"at": "<ISO>"}`.
   *  `at` is normalized, clamped to now, and honoured by the ledger only when
   *  the thread has no view time (the PWA's one-time read-mark upload). */
  async function conversationViewedHandler(
    req: ApiRequest,
    tenant: { tenant_id: string },
    conversationId: string
  ): Promise<ApiResponse> {
    const body = asObject(req.body);
    if (!body) return errorBody(400, 'invalid json');
    const now = (deps.now ?? (() => new Date()))();
    const atRaw = body['at'];
    let at: string | undefined;
    if (atRaw !== undefined && atRaw !== null) {
      const ms = typeof atRaw === 'string' ? Date.parse(atRaw) : Number.NaN;
      if (Number.isNaN(ms)) return errorBody(400, 'at must be an ISO-8601 timestamp');
      at = new Date(Math.min(ms, now.getTime())).toISOString();
    }
    try {
      const result = setConversationViewed(deps.db, tenant.tenant_id, conversationId, { at, now });
      return json({ ok: true, changed: result.changed, viewed_at: result.viewed_at });
    } catch (e) {
      return ledgerErrorResponse(e);
    }
  }

  type RetryOutcome =
    | { task_id: string; outcome: 'retried'; new_task_id: string; state: string; queued: boolean }
    | { task_id: string; outcome: 'skipped' | 'refused'; reason: string };

  /** POST /conversations/:id/retry (v14): one retry per unresolved failure,
   *  OLDEST first, so the retries keep the operator's send order and the
   *  newest original request is still the thread's newest task. */
  async function conversationRetryHandler(
    tenant: { tenant_id: string },
    conversationId: string
  ): Promise<ApiResponse> {
    const failures = listRetryableFailures(deps.db, tenant.tenant_id, conversationId);
    if (failures === null) return errorBody(404, 'not found');
    if (failures.length === 0) return errorBody(409, 'nothing to retry');
    const retried: RetryOutcome[] = [];
    for (const failed of failures) {
      try {
        retried.push(await retryOneFailure(tenant.tenant_id, failed));
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        retried.push({ task_id: failed.task_id, outcome: 'refused', reason: e.message });
      }
    }
    return json({ ok: true, retried });
  }

  /** The operator's attachments on a failed task, to copy onto its retry: the
   *  attachment listing minus worker-written files (blocker-* screenshots,
   *  result-* artifacts). */
  function retryAttachmentNames(taskId: string): string[] {
    return attachmentEntries(deps.filesDir, taskId)
      .map((entry) => entry.name)
      .filter((name) => !/^(blocker|result)-/i.test(name));
  }

  /** A retry's storage failure moves the NEW task visibly to its failure
   *  state (transcribe_failed for a recording still to transcribe, else
   *  failed), exactly like the create path. Returns that state. */
  function markRetryStorageFailed(tenantId: string, task: TaskRow, reason: string): 'transcribe_failed' | 'failed' {
    const failedState = task.state === 'transcribing' ? 'transcribe_failed' : 'failed';
    try {
      transitionTask(deps.db, tenantId, task.task_id, failedState, {
        eventKind: 'task.failed',
        eventPayload: { reason },
      });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
    }
    return failedState;
  }

  /** One retry: a NEW task in the same conversation carrying the failed
   *  task's inputs (never steer_mode), its recording and the operator's
   *  attachments, created with retryOf (the failed row's retried_by is stamped
   *  in the same transaction), then queued through the create pipeline's tail
   *  with the continuation segment. A transcribe_failed recording re-enters
   *  `transcribing` (the bot's transcription drain picks it up); a
   *  transcribe_failed task with no recording on file is skipped. */
  async function retryOneFailure(tenantId: string, failed: TaskRow): Promise<RetryOutcome> {
    const untranscribed = failed.state === 'transcribe_failed';
    const sourceAudio = failed.source === 'voice' ? findAudioFile(deps.filesDir, failed.task_id) : undefined;
    if (untranscribed && sourceAudio === undefined) {
      return { task_id: failed.task_id, outcome: 'skipped', reason: 'no recording on file' };
    }
    const requestText = untranscribed ? VOICE_TRANSCRIBING_PLACEHOLDER : failed.request_text;
    const feedbackAbout = failed.feedback_about ?? undefined;
    const continuation: ContinuationRef = { conversationId: failed.conversation_id, topicKey: failed.routed_to };
    let task: TaskRow;
    try {
      task = createTask(deps.db, tenantId, {
        source: failed.source,
        requestText,
        ...(failed.source === 'voice' && !untranscribed && failed.transcript !== null
          ? { transcript: failed.transcript }
          : {}),
        ...(untranscribed ? { initialState: 'transcribing' as const } : {}),
        conversationId: failed.conversation_id,
        ...(feedbackAbout !== undefined ? { feedbackAbout } : {}),
        ...(failed.surface !== null ? { surface: failed.surface } : {}),
        retryOf: failed.task_id,
      });
    } catch (e) {
      if (e instanceof LedgerError) return { task_id: failed.task_id, outcome: 'refused', reason: e.message };
      throw e;
    }
    let audioPath: string | undefined;
    if (sourceAudio !== undefined) {
      const ext = extname(sourceAudio.path) || '.webm';
      const taskDir = join(deps.filesDir, task.task_id);
      const tmpPath = join(deps.filesDir, `tmp-${randomUUID()}.${ext.replace(/^\./, '')}`);
      try {
        mkdirSync(taskDir, { recursive: true });
        copyFileSync(sourceAudio.path, tmpPath);
        renameSync(tmpPath, join(taskDir, `audio${ext}`));
        if (untranscribed) audioPath = join(taskDir, `audio${ext}`);
      } catch {
        try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
        if (untranscribed) {
          const state = markRetryStorageFailed(tenantId, task, 'audio storage failed');
          return { task_id: failed.task_id, outcome: 'retried', new_task_id: task.task_id, state, queued: false };
        }
        // A transcribed retry loses playback only; routing proceeds.
      }
    }
    const storedAttachmentPaths: string[] = [];
    const names = retryAttachmentNames(failed.task_id);
    if (names.length > 0) {
      const taskDir = join(deps.filesDir, task.task_id);
      let tmpPath: string | undefined;
      try {
        mkdirSync(taskDir, { recursive: true });
        for (const name of names) {
          const finalPath = join(taskDir, name);
          tmpPath = join(deps.filesDir, `tmp-${randomUUID()}.attach`);
          copyFileSync(join(deps.filesDir, failed.task_id, name), tmpPath);
          renameSync(tmpPath, finalPath);
          tmpPath = undefined;
          storedAttachmentPaths.push(finalPath.replace(/\\/g, '/'));
        }
      } catch {
        if (tmpPath !== undefined) {
          try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
        }
        const state = markRetryStorageFailed(tenantId, task, 'attachment storage failed');
        return { task_id: failed.task_id, outcome: 'retried', new_task_id: task.task_id, state, queued: false };
      }
    }
    const enqueued = await enqueueInboxEntry(tenantId, task, {
      requestText,
      audioPath,
      attachments: storedAttachmentPaths,
      continuation,
      feedbackAbout,
    });
    return { task_id: failed.task_id, outcome: 'retried', new_task_id: task.task_id, state: task.state, queued: enqueued === 'queued' };
  }

  /** POST /conversations/:id/cancel (v14): every live task and every
   *  unresolved failure moves to cancelled through transitionTask. A stop is
   *  requested only for a task whose pre-cancel state was running or
   *  awaiting_input — a failed row's worker identity is history and must never
   *  aim a kill. Idempotent. */
  async function conversationCancelHandler(
    tenant: { tenant_id: string },
    conversationId: string
  ): Promise<ApiResponse> {
    const targets = listCancellableTasks(deps.db, tenant.tenant_id, conversationId);
    if (targets === null) return errorBody(404, 'not found');
    const tasks: Array<Record<string, unknown>> = [];
    for (const target of targets) {
      try {
        transitionTask(deps.db, tenant.tenant_id, target.task_id, 'cancelled', {
          eventKind: 'task.cancelled',
          eventPayload: { by: 'operator' },
        });
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        tasks.push({ task_id: target.task_id, outcome: 'refused', stop_requested: false, reason: e.message });
        continue;
      }
      const stopRequested = target.state === 'running' || target.state === 'awaiting_input'
        ? await appendCancelEntry(tenant.tenant_id, target)
        : false;
      tasks.push({ task_id: target.task_id, outcome: 'cancelled', stop_requested: stopRequested });
    }
    return json({ ok: true, tasks });
  }

  async function eventsHandler(req: ApiRequest, task: TaskRow): Promise<ApiResponse> {
    await serviceOauth(task);
    const afterParam = req.query.get('after');
    let afterEventId: number | undefined;
    if (afterParam !== null) {
      const n = Number(afterParam);
      if (!Number.isInteger(n) || n < 0) return errorBody(400, 'after must be a non-negative integer');
      afterEventId = n;
    }
    const events = listEvents(deps.db, task.tenant_id, task.task_id, { afterEventId }).map(publicEvent);
    return json({ ok: true, events });
  }

  /** Mint missing oauth auth_urls, then fold resolved sessions into answers. */
  async function serviceOauth(task: TaskRow): Promise<void> {
    try {
      const pending = listInputRequests(deps.db, task.tenant_id, task.task_id, { status: 'pending' })
        .filter((r) => r.kind === ('oauth' satisfies InputKind));
      const mintable = pending.filter((r) => {
        try {
          const parsed: unknown = JSON.parse(r.params_json);
          return !(parsed !== null && typeof parsed === 'object' &&
            typeof (parsed as Record<string, unknown>)['auth_url'] === 'string');
        } catch {
          return true;
        }
      });
      if (mintable.length > 0) {
        const tenantRow = getTenant(deps.db, task.tenant_id);
        if (tenantRow) {
          for (const request of mintable) {
            await mintOauthAuthUrl(deps.db, { tenant: tenantRow, request }, {
              repoRoot: deps.repoRoot,
              env: process.env,
            });
          }
        }
      }
      await pollOauthResolutions(deps.db, { tenantId: task.tenant_id, taskId: task.task_id }, {
        repoRoot: deps.repoRoot,
        env: process.env,
        answersDir: deps.answersDir,
        // C2: route the oauth auto-answer through the ONE answer-and-resume
        // path so a real worker waiting on this request also gets steered.
        onAnswered: async (taskId, requestId, pointer) => {
          await answerAndResume(deps.db, task.tenant_id, taskId, requestId, { kind: 'pointer', pointer }, {
            routeQueuePath: deps.routeQueuePath,
            answersDir: deps.answersDir,
            inputStore: deps.screencastInputStore,
          });
        },
      });
    } catch {
      // Telemetry/detail serving must never fail because of oauth plumbing.
    }
  }

  async function answerHandler(
    req: ApiRequest,
    tenant: { tenant_id: string },
    task: TaskRow,
    requestId: string
  ): Promise<ApiResponse> {
    const request = getInputRequest(deps.db, tenant.tenant_id, task.task_id, requestId);
    if (!request) return errorBody(404, 'not found');
    if (request.status !== 'pending') {
      return errorBody(409, `request is ${request.status}, not pending`);
    }
    const ctype = contentTypeOf(req.headers) ?? '';

    let answer: AnswerInput;
    if (request.kind === 'file') {
      if (!ctype.includes('multipart/form-data')) {
        return errorBody(400, 'file answers are multipart uploads');
      }
      const parts = parseMultipart(req.body, ctype);
      const upload = parts?.find((p) => p.filename !== undefined && p.data.length > 0);
      if (!parts || !upload) return errorBody(400, 'multipart body must carry a file part');

      let params: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(request.params_json);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          params = parsed as Record<string, unknown>;
        }
      } catch {
        params = {};
      }
      const accept = Array.isArray(params['accept']) ? (params['accept'] as unknown[]).filter(
        (v): v is string => typeof v === 'string'
      ) : undefined;
      // Request-scoped max_bytes wins when the request sets it; otherwise the
      // config fallback is the OPT-IN upload knob (2026-09-13) — unset means
      // no size check at all on this path.
      const maxBytes =
        typeof params['max_bytes'] === 'number' && Number.isInteger(params['max_bytes'])
          ? (params['max_bytes'] as number)
          : deps.config.maxUploadMb !== undefined
            ? deps.config.maxUploadMb * 1024 * 1024
            : undefined;
      const ext = fileNameExtension(upload.filename);
      if (accept && accept.length > 0 && !accept.map((a) => a.toLowerCase()).includes(ext)) {
        return errorBody(400, `file extension ${ext || '(none)'} is not allowed (accept: ${accept.join(', ')})`);
      }
      if (maxBytes !== undefined && upload.data.length > maxBytes) {
        return errorBody(413, `upload exceeds max_bytes (${maxBytes})`);
      }
      const dir = join(deps.filesDir, task.task_id);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, sanitizeUploadName(upload.filename));
      writeFileSync(target, upload.data);
      answer = { kind: 'pointer', pointer: target };
    } else {
      const contract = { kind: request.kind, prompt: request.prompt, params: safeParams(request) };
      const body = asObject(req.body);
      if (!body) return errorBody(400, 'invalid json');
      const validated = validateInputAnswer(contract as InputRequest, body);
      if (!validated.ok) return errorBody(400, validated.error);
      // confirm/oauth answers carry {confirmed}, not {value} — serialize the
      // boolean; every other kind's answer carries the value directly.
      const storedValue =
        validated.value.kind === 'confirm' || validated.value.kind === 'oauth'
          ? String(validated.value.confirmed)
          : validated.value.value;
      answer = { kind: 'value', value: storedValue };
    }

    try {
      // C2: the ONE path that answers AND resumes a real waiting worker —
      // never call answerInputRequest directly (the AI-221 bug).
      await answerAndResume(deps.db, tenant.tenant_id, task.task_id, requestId, answer, {
        routeQueuePath: deps.routeQueuePath,
        answersDir: deps.answersDir,
        inputStore: deps.screencastInputStore,
      });
    } catch (e) {
      return ledgerErrorResponse(e);
    }
    return json({ ok: true, status: 'answered' });
  }

  async function rerouteHandler(
    req: ApiRequest,
    tenant: { tenant_id: string },
    task: TaskRow
  ): Promise<ApiResponse> {
    const body = asObject(req.body);
    if (!body) return errorBody(400, 'invalid json');
    const topic = body['topic'];
    if (typeof topic !== 'string' || !splitTopicKey(topic)) {
      return errorBody(400, 'topic must be a "<chatId>_<threadId>" key');
    }
    const topics = readTopics(deps.topicNamesPath);
    if (!topics.some((t) => t.key === topic)) {
      return errorBody(400, `unknown topic: ${topic}`);
    }
    const target = splitTopicKey(topic);
    if (!target) return errorBody(400, 'topic must be a "<chatId>_<threadId>" key');
    const reason = 'operator reroute';
    try {
      transitionTask(deps.db, tenant.tenant_id, task.task_id, 'routed', {
        eventKind: 'task.rerouted',
        routedTo: topic,
        routingReason: reason,
        eventPayload: { from: task.routed_to ?? '', to: topic, reason },
      });
    } catch (e) {
      return ledgerErrorResponse(e);
    }
    // §6: reroute writes a new route entry targeting the new topic; the prior
    // topic's work is NOT aborted (§14) — /stop there remains the hard stop.
    try {
      await appendRouteEntry(deps.routeQueuePath, {
        taskId: task.task_id,
        tenantId: tenant.tenant_id,
        chatId: target.chatId,
        threadId: target.threadId,
        text: buildTargetInjectionTextWithBriefing(deps.db, tenant.tenant_id, {
          taskId: task.task_id,
          requestText: task.request_text,
          reason,
          repoRoot: deps.repoRoot,
          attachments: attachmentsDisplayPaths(deps.filesDir, task.task_id),
          conversationId: task.conversation_id,
          feedback: task.feedback_about === null
            ? undefined
            : resolveFeedbackRef(deps.db, tenant.tenant_id, task.feedback_about),
        }),
      });
    } catch {
      // State + event landed; a lost append leaves the task `routed` to the
      // new topic without a queued injection — visible, re-routable.
    }
    return json({ ok: true, state: 'routed', routed_to: topic });
  }
}

// --- small helpers -----------------------------------------------------------------

export function headerOf(headers: ApiRequest['headers'], name: string): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function safeParams(request: InputRequestRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(request.params_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}
