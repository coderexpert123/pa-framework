// Availability cache (2026-09-19 router-as-orchestrator SPEC §7, intent
// decision 27). One TTL cache entry over the TWO expensive reads in the
// router's default availability: the `loadConfig()` parse and the cooldown
// snapshot (ONE getCooldownStatus() read serving ALL workers per refresh,
// instead of a lock+read per worker). Fault semantics unchanged: unknown =
// unavailable, never guessed-available (decision 2). What stays uncached:
// runWithFailover's per-attempt autoDispatchEligibility + checkWorker (the
// stale-probability guard) and the stickiness/peak-window evaluation (pure).
// This cache is consumed ONLY by the router's resolve path.

import type { WorkerConfig } from '../../types.js';

export const DEFAULT_AVAILABILITY_TTL_MS = 5000;

/** Injectable IO — tests stub this wholesale; production builds the real
 *  reader lazily via dynamic imports (kept next to the cache so the router's
 *  resolve path stays a single `getCachedAvailability` call). */
export interface AvailabilityIo {
  loadConfig: () => Promise<{ workers?: Array<Partial<WorkerConfig>>; model_router?: { availability_ttl_ms?: number } }>;
  /** ONE cooldown snapshot per refresh — read-only, no lock+write cleanup. */
  cooldown: () => Promise<Record<string, { cooldown_until?: string }>>;
  now?: () => number;
}

interface CacheEntry {
  atMs: number;
  values: Map<string, boolean>;
}

let cache: CacheEntry | undefined;
let inflight: Promise<CacheEntry> | undefined;
let ttlFromConfig: number | undefined;
let io: AvailabilityIo | undefined;

/** Test seam: replace the production IO (undefined restores it). */
export function setAvailabilityIoForTests(override: AvailabilityIo | undefined): void {
  io = override;
}

/** Test seam: forget the cache, the in-flight refresh and the config TTL. */
export function resetAvailabilityCacheForTests(): void {
  cache = undefined;
  inflight = undefined;
  ttlFromConfig = undefined;
}

function nowMs(): number {
  try {
    return io?.now ? io.now() : Date.now();
  } catch {
    return Date.now();
  }
}

function envTtl(): number | undefined {
  const raw = Number(process.env.PA_MODEL_ROUTER_AVAILABILITY_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function resolveTtlMs(): number {
  const env = envTtl();
  if (env !== undefined) return env;
  if (ttlFromConfig !== undefined) return ttlFromConfig;
  return DEFAULT_AVAILABILITY_TTL_MS;
}

// The eligibility predicate mirrors the availability-relevant arms of
// rate-limits.autoDispatchEligibility, evaluated against the SNAPSHOT so a
// refresh stays one config read + one cooldown read total. manual_only
// workers (kgclaude/agyc) stay auto-ineligible; an expired cooldown entry is
// NOT cooling (the cached path is read-only — it never deletes the entry;
// the next isWorkerCoolingDown call or prune job cleans it up).
function evaluate(wc: Partial<WorkerConfig> | undefined, cooldownUntil: string | undefined, atMs: number): boolean {
  if (!wc) return false;
  if (wc.manual_only) return false;
  if (cooldownUntil !== undefined && new Date(cooldownUntil).getTime() > atMs) return false;
  return true;
}

async function doRefresh(workerNames: string[]): Promise<CacheEntry> {
  const reader = io ?? productionIo();
  const values = new Map<string, boolean>();
  let cfg: Awaited<ReturnType<AvailabilityIo['loadConfig']>> | undefined;
  let cooldown: Record<string, { cooldown_until?: string }> | undefined;
  try {
    [cfg, cooldown] = await Promise.all([reader.loadConfig(), reader.cooldown()]);
    // Adopt the config TTL for subsequent windows (env override keeps
    // precedence; a bad value falls back to the default at resolve time).
    const cfgTtl = Number(cfg?.model_router?.availability_ttl_ms);
    if (Number.isFinite(cfgTtl) && cfgTtl >= 0) ttlFromConfig = cfgTtl;
  } catch {
    // A config/cooldown read fault means EVERY queried worker's availability
    // is UNKNOWN, and unknown never auto-picks — recorded unavailable, never
    // guessed available (decision 2). Pin dispatch is unaffected (the pin
    // path never consults this predicate).
    for (const w of workerNames) values.set(w, false);
    return { atMs: nowMs(), values };
  }
  const atMs = nowMs();
  for (const w of workerNames) {
    try {
      const wc = cfg?.workers?.find((x) => x?.name === w);
      const entry = cooldown?.[w];
      values.set(w, evaluate(wc, entry?.cooldown_until, atMs));
    } catch {
      values.set(w, false);
    }
  }
  return { atMs, values };
}

function productionIo(): AvailabilityIo {
  return {
    loadConfig: async () => {
      const { loadConfig } = await import('../../config.js');
      return loadConfig();
    },
    cooldown: async () => {
      const rl = await import('../../rate-limits.js');
      return rl.getCooldownStatus();
    },
  };
}

/**
 * Cached availability for one worker. `workerNames` bounds the fleet: a
 * worker outside it is unavailable without any I/O. TTL =
 * PA_MODEL_ROUTER_AVAILABILITY_TTL_MS env, else
 * model_router.availability_ttl_ms from the (cached) config read, else
 * 5000 ms; `0` disables caching (always fresh, still one refresh per call
 * wave via coalescing). Concurrent refreshes share one in-flight promise.
 */
export async function getCachedAvailability(worker: string, workerNames: string[]): Promise<boolean> {
  if (!workerNames.includes(worker)) return false;
  const ttl = resolveTtlMs();
  const now = nowMs();
  if (ttl > 0 && cache && now - cache.atMs < ttl) {
    return cache.values.get(worker) ?? false;
  }
  if (!inflight) {
    inflight = doRefresh(workerNames).then((entry) => {
      cache = entry;
      return entry;
    }).finally(() => {
      inflight = undefined;
    });
  }
  const entry = await inflight;
  return entry.values.get(worker) ?? false;
}
