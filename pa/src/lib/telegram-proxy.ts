/**
 * Telegram-scoped SOCKS5 proxy support with a health-checked failover pool.
 *
 * Why this exists: Telegram is blocked in some networks. This module lets the
 * bot, the `pa` CLI sender, and (via shared state) the Python notifier route
 * ONLY Telegram API traffic through one or more SOCKS5 proxies, with automatic
 * failover when a proxy dies. It deliberately does NOT touch any other traffic
 * and does NOT inherit OS/environment proxy settings — the proxy set is read
 * explicitly from `secrets.env` (TELEGRAM_PROXY_URLS) plus the auto-refresh
 * pool file at ~/.pa/telegram-proxies.json.
 *
 * Safety invariants (see the guardrail table in the design notes):
 *  - TLS certificate validation is NEVER disabled. The bot↔Telegram TLS session
 *    is end-to-end through the proxy, so a hostile proxy cannot read, alter, or
 *    inject payloads. We refuse to start if cert validation has been turned off.
 *  - SOCKS5 only. Names are resolved at the proxy (socks5h semantics) so a
 *    censored local DNS does not leak or break resolution.
 *  - Proxy is applied to Telegram traffic only — callers opt in by routing
 *    through telegramFetch(); nothing else is affected.
 *  - When the pool is empty, telegramFetch() is a transparent pass-through to
 *    the global fetch() — i.e. byte-identical to the pre-proxy behavior.
 */
import { fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { loadSecrets } from '../secrets.js';
import { paHome } from '../paths.js';
import { log } from './log.js';

const TELEGRAM_HOST = 'api.telegram.org';
const PROBE_TIMEOUT_MS = 8_000;
const COOLDOWN_MS = 60_000;
const MAX_POOL = 30;

export interface ParsedProxy {
  /** Normalized canonical form, e.g. socks5://host:port (no credentials). */
  url: string;
  host: string;
  port: number;
  userId?: string;
  password?: string;
}

/**
 * Parse and validate a SOCKS5 proxy URL. Returns null for anything that is not
 * a well-formed socks5/socks5h URL with a sane host and port. Pure — no I/O.
 *
 * Accepts: socks5://host:port, socks5h://host:port, socks5://user:pass@host:port
 * Rejects: http(s):// (we require SOCKS5), missing port, out-of-range port,
 *          garbage. http proxies are intentionally unsupported here so we never
 *          fall back to a CONNECT proxy that could see more than we want.
 */
export function parseProxyUrl(raw: string): ParsedProxy | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }

  if (u.protocol !== 'socks5:' && u.protocol !== 'socks5h:') return null;
  const host = u.hostname;
  if (!host) return null;

  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const userId = u.username ? decodeURIComponent(u.username) : undefined;
  const password = u.password ? decodeURIComponent(u.password) : undefined;

  return {
    url: `socks5://${host}:${port}`,
    host,
    port,
    ...(userId ? { userId } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * SSRF guardrail: reject hosts that point at the local machine or private
 * networks. Applied to AUTO-FETCHED candidates only — a manually configured
 * proxy may legitimately be a localhost SSH tunnel (socks5://127.0.0.1:1080).
 * Pure — no DNS, structural checks only (a hostname that later resolves to a
 * private IP is a residual risk we accept; the realistic threat is a fetched
 * list explicitly handing us 127.0.0.1 / 10.x to probe internal services).
 */
export function isPublicHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return false;

  // IPv6 loopback / link-local / unique-local.
  if (h === '::1' || h === '[::1]') return false;
  const v6 = h.replace(/^\[|\]$/g, '');
  if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return false;

  // IPv4 dotted-quad ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false; // malformed
    const [a, b] = o;
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // loopback
    if (a === 0) return false; // 0.0.0.0/8
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
  }
  return true;
}

/**
 * Refuse to operate if TLS verification has been globally disabled — that is the
 * single misconfiguration that would let a hostile proxy MITM the connection and
 * steal the bot token. Throws so the failure is loud, not silent.
 */
export function assertTlsValidationOn(): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error(
      'telegram-proxy: refusing to use a proxy while NODE_TLS_REJECT_UNAUTHORIZED=0 ' +
        '(TLS validation disabled). A hostile proxy could steal the bot token. ' +
        'Unset it and restart.',
    );
  }
}

/** Build an undici SOCKS5 dispatcher for a parsed proxy. */
export function buildDispatcher(p: ParsedProxy): Dispatcher {
  assertTlsValidationOn();
  return socksDispatcher(
    {
      type: 5,
      host: p.host,
      port: p.port,
      ...(p.userId ? { userId: p.userId } : {}),
      ...(p.password ? { password: p.password } : {}),
    },
    // Keep TLS strict; reasonable connect timeout so a black-holing proxy fails fast.
    { connect: { timeout: PROBE_TIMEOUT_MS } },
  );
}

/**
 * Health-check a proxy by performing a real getMe through it. Returns true only
 * if Telegram answers ok:true — proving SOCKS5 + end-to-end TLS + Telegram
 * reachability all work. The token travels inside TLS, so an unvetted proxy
 * never sees it in plaintext.
 */
export async function healthCheckProxy(
  proxyUrl: string,
  token: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const parsed = parseProxyUrl(proxyUrl);
  if (!parsed) return false;
  let dispatcher: Dispatcher;
  try {
    dispatcher = buildDispatcher(parsed);
  } catch {
    return false;
  }
  try {
    const res = await undiciFetch(`https://${TELEGRAM_HOST}/bot${token}/getMe`, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  } finally {
    dispatcher.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Source auto-refresh (fetch a public proxy list → validate → health-check)
// ---------------------------------------------------------------------------

const SOURCE_MAX_CANDIDATES = 400;

/**
 * Strictly extract SOCKS5 candidates from an untrusted proxy-list page/file.
 * The source text is treated as hostile data: we only pull out well-formed
 * `ip:port` (or `socks5://…`) tokens, normalize them, drop anything that fails
 * parseProxyUrl, and drop private/loopback hosts (SSRF guardrail). Pure — no I/O.
 */
export function parseProxyListText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of (text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let candidate: string | null = null;
    if (/^socks5h?:\/\//i.test(line)) {
      candidate = line;
    } else {
      // Extract the first IPv4:port token on the line (tolerant of surrounding
      // markup/whitespace) — never eval, never follow, just structural match.
      const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/);
      if (m) candidate = `socks5://${m[1]}:${m[2]}`;
    }
    if (!candidate) continue;

    const p = parseProxyUrl(candidate);
    if (!p) continue;
    if (!isPublicHost(p.host)) continue; // SSRF: reject loopback/private from a fetched list
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    out.push(p.url);
    if (out.length >= SOURCE_MAX_CANDIDATES) break;
  }
  return out;
}

export interface RefreshResult {
  source: string;
  candidates: number;
  tested: number;
  healthy: string[];
}

/**
 * Fetch a proxy-list source, validate + health-check candidates concurrently,
 * and persist the healthy ones to the pool file (~/.pa/telegram-proxies.json).
 * Stops early once `targetHealthy` proxies pass, so a fresh pool is found
 * quickly without probing the whole list. Every candidate must pass a real
 * getMe through the tunnel — so only proxies that genuinely reach Telegram
 * survive.
 */
export async function refreshPoolFromSource(
  sourceUrl: string,
  token: string,
  opts: { concurrency?: number; targetHealthy?: number; perProbeMs?: number; maxTested?: number } = {},
): Promise<RefreshResult> {
  const concurrency = opts.concurrency ?? 30;
  const targetHealthy = opts.targetHealthy ?? 8;
  const perProbeMs = opts.perProbeMs ?? 6_000;
  const maxTested = opts.maxTested ?? SOURCE_MAX_CANDIDATES;

  assertTlsValidationOn();
  const res = await undiciFetch(sourceUrl, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`proxy source fetch failed: ${res.status}`);
  const text = await res.text();
  const candidates = parseProxyListText(text).slice(0, maxTested);

  const healthy: string[] = [];
  let idx = 0;
  let tested = 0;
  let stop = false;
  async function probeWorker(): Promise<void> {
    while (!stop) {
      const i = idx++;
      if (i >= candidates.length) return;
      tested++;
      const url = candidates[i];
      const ok = await healthCheckProxy(url, token, perProbeMs);
      if (ok && !healthy.includes(url)) {
        healthy.push(url);
        if (healthy.length >= targetHealthy) stop = true;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length || 1) }, () => probeWorker()),
  );

  // Never clobber a working pool with an empty result: a source outage or a
  // network blip that yields 0 healthy must leave the existing pool intact.
  if (healthy.length > 0) {
    await writeFile(
      proxyPoolFilePath(),
      JSON.stringify({ updatedAt: new Date().toISOString(), source: sourceUrl, healthy }, null, 2),
      'utf8',
    );
    invalidatePool();
    log('info', 'telegram-proxy', 'pool refreshed from source', {
      source: sourceUrl,
      candidates: candidates.length,
      tested,
      healthy: healthy.length,
    });
  } else {
    log('warn', 'telegram-proxy', 'refresh found 0 healthy proxies — keeping existing pool', {
      source: sourceUrl,
      candidates: candidates.length,
      tested,
    });
  }
  return { source: sourceUrl, candidates: candidates.length, tested, healthy };
}

// ---------------------------------------------------------------------------
// Failover pool
// ---------------------------------------------------------------------------

interface PoolState {
  urls: string[]; // ordered candidate proxies (canonical socks5://host:port)
  badUntil: Map<string, number>; // url -> epoch ms until which it's in cooldown
  dispatchers: Map<string, Dispatcher>;
  loaded: boolean;
}

const pool: PoolState = { urls: [], badUntil: new Map(), dispatchers: new Map(), loaded: false };
let loadPromise: Promise<void> | null = null;

// Credentials for proxies that carry them (manual seed, e.g. a commercial
// SOCKS5), keyed by the credential-less canonical url. Kept OUT of pool.urls so
// secrets never reach logs, the pool file, or Map keys; applied only at dispatch.
const proxyCreds = new Map<string, { userId?: string; password?: string }>();

/** Path of the auto-refresh pool file maintained by the bot's refresh loop. */
export function proxyPoolFilePath(): string {
  return join(paHome(), 'telegram-proxies.json');
}

/**
 * Dedupe-preserving merge of proxy URLs into canonical (credential-less) form,
 * capturing any credentials into `proxyCreds` for use at dispatch time. Rebuilds
 * proxyCreds from scratch on each call (full pool reload).
 */
function mergeUrls(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  proxyCreds.clear();
  for (const list of lists) {
    for (const raw of list) {
      const p = parseProxyUrl(raw);
      if (!p || seen.has(p.url)) continue;
      seen.add(p.url);
      out.push(p.url);
      if (p.userId || p.password) proxyCreds.set(p.url, { userId: p.userId, password: p.password });
      if (out.length >= MAX_POOL) return out;
    }
  }
  return out;
}

async function loadPool(): Promise<void> {
  const sources: string[][] = [];

  // 1. Static seed from secrets.env (TELEGRAM_PROXY_URLS, comma-separated).
  try {
    const secrets = await loadSecrets(); // all keys — avoids per-key "not found" warnings
    const seed = secrets['TELEGRAM_PROXY_URLS'];
    if (seed) sources.push(seed.split(',').map((s) => s.trim()).filter(Boolean));
  } catch {
    /* no secrets — fine, pool stays empty */
  }

  // 2. Auto-refresh pool file (healthy proxies written by the bot refresh loop).
  try {
    const raw = await readFile(proxyPoolFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { healthy?: string[] };
    if (Array.isArray(parsed.healthy)) sources.push(parsed.healthy);
  } catch {
    /* no pool file yet — fine */
  }

  pool.urls = mergeUrls(...sources);

  // Reconcile transient state with the (possibly just-refreshed) pool:
  //  - close + drop cached dispatchers for proxies no longer in the pool
  //    (otherwise every 30-min refresh leaks an undici Agent + sockets), and
  //  - clear cooldowns so a refresh that re-validated a proxy gives it a fresh
  //    attempt instead of leaving it stuck in a stale 60s cooldown.
  const urlSet = new Set(pool.urls);
  for (const [u, d] of pool.dispatchers) {
    if (!urlSet.has(u)) {
      pool.dispatchers.delete(u);
      d.close().catch(() => {});
    }
  }
  pool.badUntil.clear();

  pool.loaded = true;
  if (pool.urls.length > 0) {
    assertTlsValidationOn();
    log('info', 'telegram-proxy', 'proxy pool loaded', { count: pool.urls.length });
  }
}

async function ensurePool(): Promise<void> {
  if (pool.loaded) return;
  if (!loadPromise) loadPromise = loadPool();
  await loadPromise;
}

/** Force a reload of the pool on next use (e.g. after the refresh loop writes). */
export function invalidatePool(): void {
  pool.loaded = false;
  loadPromise = null;
}

function nextAvailableUrl(now: number): string | null {
  for (const url of pool.urls) {
    const until = pool.badUntil.get(url) ?? 0;
    if (until <= now) return url;
  }
  return null;
}

function getDispatcher(url: string): Dispatcher | null {
  let d = pool.dispatchers.get(url);
  if (d) return d;
  const parsed = parseProxyUrl(url);
  if (!parsed) return null;
  const creds = proxyCreds.get(url); // re-attach credentials stripped from the canonical url
  d = buildDispatcher(creds ? { ...parsed, ...creds } : parsed);
  pool.dispatchers.set(url, d);
  return d;
}

function markBad(url: string, now: number): void {
  pool.badUntil.set(url, now + COOLDOWN_MS);
  const d = pool.dispatchers.get(url);
  if (d) {
    pool.dispatchers.delete(url);
    d.close().catch(() => {});
  }
}

/**
 * Whether an error happened at the CONNECT stage — i.e. the request bytes
 * never reached Telegram, so re-sending through another proxy is idempotent
 * (cannot cause a duplicate). This is the only class we auto-fail-over on.
 *
 * Ambiguous failures (ECONNRESET mid-flight, socket errors after send, the
 * caller's own AbortSignal timeout) are deliberately NOT treated as connect-
 * stage: a resend there could double-deliver, so we surface them to the caller,
 * whose retry/DLQ/dedup policy decides. This is what keeps failover compatible
 * with effectively-once delivery.
 */
export function isConnectStageError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return false; // ambiguous — request may have been sent
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = (err as { code?: string })?.code ?? cause?.code;
  // Connection never established → safe to try another proxy.
  const connectStage = ['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'];
  if (code && connectStage.includes(code)) return true;
  // SOCKS proxy handshake/connect failures (from fetch-socks/socks) — the
  // tunnel to/through the proxy failed before our request was forwarded.
  const msg = String(cause?.message ?? (err as { message?: string })?.message ?? '');
  if (/socks/i.test(msg) || /proxy connection|connect timeout|connection refused/i.test(msg)) return true;
  // Anything else (ECONNRESET, UND_ERR_SOCKET, post-send failures) is ambiguous.
  return false;
}

// Direct-first routing with a circuit breaker. The direct (no-proxy) route is
// ALWAYS preferred and is used whenever the network isn't blocking Telegram. We
// fall back to the SOCKS5 pool only after a real connectivity failure, and we
// re-probe direct every DIRECT_COOLDOWN_MS so we auto-switch back the moment a
// block lifts.
const DIRECT_COOLDOWN_MS = 60_000;
let directHealthy = true; // assume direct works until proven otherwise
let directNextProbe = 0; // epoch ms; re-probe direct once we pass this
let refreshToken: string | null = null; // set by startProxyAutoRefresh; enables on-demand refresh

/**
 * Telegram-scoped fetch — DIRECT-FIRST. Tries the direct connection (preferred)
 * and falls back to the SOCKS5 failover pool only on a real connectivity failure
 * (the network blocking Telegram). Auto-recovers to direct by re-probing every
 * DIRECT_COOLDOWN_MS. Reroute happens ONLY on connect-stage errors — app errors
 * and caller aborts/timeouts surface to the caller (preserving effectively-once).
 * Drop-in for global fetch() at Telegram call sites.
 */
export async function telegramFetch(input: string, init?: RequestInit): Promise<Response> {
  // Test mode: never hit the network through real proxies.
  if (process.env.PA_NOTIFY_DISABLED === '1') return fetch(input, init);

  // 1. DIRECT route (preferred) — tried whenever healthy, or when it's time to
  //    re-probe after a prior failure.
  if (directHealthy || Date.now() >= directNextProbe) {
    try {
      const res = await fetch(input, init);
      if (!directHealthy) {
        directHealthy = true;
        log('info', 'telegram-proxy', 'direct route recovered — Telegram reachable directly again');
      }
      return res;
    } catch (err) {
      // Only a connect-stage failure means "Telegram is blocked, use a proxy".
      // App errors / ambiguous post-send / caller aborts surface to the caller.
      if (!isConnectStageError(err)) throw err;
      if (directHealthy) {
        log('warn', 'telegram-proxy', 'direct route blocked — falling back to proxy pool', {
          error: (err as Error)?.message,
        });
        // Kick a background pool refresh so a fresh proxy is ready for fallback.
        if (refreshToken) void ensureFreshPool(refreshToken).catch(() => {});
      }
      directHealthy = false;
      directNextProbe = Date.now() + DIRECT_COOLDOWN_MS;
      // fall through to the proxy pool
    }
  }

  // 2. PROXY fallback — only reached while the direct route is failing.
  await ensurePool();
  if (pool.urls.length === 0) return fetch(input, init); // no proxies → last-resort direct

  let lastErr: unknown;
  // Try each currently-available proxy once.
  for (let attempt = 0; attempt < pool.urls.length; attempt++) {
    const url = nextAvailableUrl(Date.now());
    if (!url) break; // everything is in cooldown
    const dispatcher = getDispatcher(url);
    if (!dispatcher) {
      markBad(url, Date.now());
      continue;
    }
    try {
      const res = await undiciFetch(input, { ...(init as any), dispatcher });
      return res as unknown as Response;
    } catch (err) {
      lastErr = err;
      if (isConnectStageError(err)) {
        // Request never reached Telegram → idempotent to try the next proxy.
        log('warn', 'telegram-proxy', 'proxy connect failure, failing over (no duplicate risk)', {
          proxy: url,
          error: (err as Error)?.message,
        });
        markBad(url, Date.now());
        continue;
      }
      // Ambiguous (possibly-delivered) failure: mark the proxy suspect but do
      // NOT silently resend — surface to the caller so its dedup/DLQ policy
      // decides, preserving effectively-once semantics.
      markBad(url, Date.now());
      throw err;
    }
  }

  // Pool exhausted: every proxy is dead/cooling down. Fall back to a direct
  // connection so we at least try, and log loudly (this is the alert signal).
  log('error', 'telegram-proxy', 'all proxies unavailable — falling back to direct connection', {
    poolSize: pool.urls.length,
    lastError: (lastErr as Error)?.message,
  });
  return fetch(input, init);
}

// ---------------------------------------------------------------------------
// Auto-refresh orchestration (used by the bot to stay self-reliant)
// ---------------------------------------------------------------------------

const DEFAULT_REFRESH_MIN = 30;

/** Read the auto-refresh source + interval from secrets.env. */
async function getSourceConfig(): Promise<{ sourceUrl?: string; intervalMs: number }> {
  let sourceUrl: string | undefined;
  let intervalMs = DEFAULT_REFRESH_MIN * 60_000;
  try {
    const s = await loadSecrets(); // all keys — avoids per-key "not found" warnings
    const url = s['TELEGRAM_PROXY_SOURCE_URL']?.trim();
    if (url) sourceUrl = url;
    const min = Number(s['TELEGRAM_PROXY_REFRESH_MIN']);
    if (Number.isFinite(min) && min >= 1) intervalMs = min * 60_000;
  } catch {
    /* no secrets — auto-refresh stays disabled */
  }
  return { sourceUrl, intervalMs };
}

/**
 * Refresh the pool only if it is missing, empty, or older than the refresh
 * interval. No-op when no source is configured. Returns the healthy count.
 */
export async function ensureFreshPool(token: string): Promise<number> {
  const { sourceUrl, intervalMs } = await getSourceConfig();
  if (!sourceUrl) return 0;

  let healthyCount = 0;
  let stale = true;
  try {
    const parsed = JSON.parse(await readFile(proxyPoolFilePath(), 'utf8')) as {
      healthy?: string[];
      updatedAt?: string;
    };
    healthyCount = Array.isArray(parsed.healthy) ? parsed.healthy.length : 0;
    const age = Date.now() - new Date(parsed.updatedAt ?? 0).getTime();
    stale = !(healthyCount > 0 && age < intervalMs);
  } catch {
    stale = true;
  }
  if (!stale) return healthyCount;

  const r = await refreshPoolFromSource(sourceUrl, token);
  return r.healthy.length || healthyCount;
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Arm the bot's self-reliant proxy maintenance. No-op when
 * TELEGRAM_PROXY_SOURCE_URL is unset, so default deployments are unaffected.
 *
 * Direct-first: does NOT scan at startup (the direct route is preferred and
 * usually works). Instead it registers the token so telegramFetch can trigger an
 * on-demand pool refresh the moment direct first fails, and the periodic timer
 * below scans ONLY while direct is down — so a working direct route costs zero
 * proxy scans.
 */
export async function startProxyAutoRefresh(token: string): Promise<void> {
  if (process.env.PA_NOTIFY_DISABLED === '1') return; // never scan the network in tests
  const { sourceUrl, intervalMs } = await getSourceConfig();
  if (!sourceUrl) return;
  refreshToken = token; // enable on-demand refresh when the direct route fails

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (directHealthy) return; // direct works → don't waste scans on proxies
    refreshPoolFromSource(sourceUrl, token).catch((e) =>
      log('warn', 'telegram-proxy', 'scheduled pool refresh failed', { error: String(e) }),
    );
  }, intervalMs);
  refreshTimer.unref?.();
  log('info', 'telegram-proxy', 'proxy auto-refresh armed (direct-first; scans only while direct is blocked)', {
    source: sourceUrl,
    intervalMin: Math.round(intervalMs / 60_000),
  });
}
