/**
 * Multi-session coordination — explicit path/logical-resource reservations.
 *
 * Reuses blackboard.ts's PATTERN (file-backed JSON + proper-lockfile), not
 * its store: blackboard's liveness model is "the holding PID is alive",
 * which is wrong here — a `pa claim` invocation is a short-lived process
 * that exits within a second, so a PID-liveness check would drop the
 * reservation instantly. Reservations use an expiresAt TTL instead.
 *
 * Advisory only (Git LFS / Perforce / SVN precedent: mandatory locking's
 * dominant real-world failure is the abandoned lock, not the contended
 * one). See plans/2026-08-05-concurrent-session-safety.md §4.5.
 */

import { randomBytes } from 'crypto';
import { dirname, join } from 'path';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from '../paths.js';
import { safeLockOptions } from './safe-lock.js';
import { log } from './log.js';

export interface Reservation {
  id: string;          // "r-" + 8 hex
  paths: string[];     // normalized repo-relative, forward slashes; or "@<logical>"
  session: string;     // human label, e.g. "claude-voice-refactor"
  note: string;        // what the session is doing — shown to whoever collides
  claimedAt: string;   // ISO 8601 UTC
  expiresAt: string;   // ISO 8601 UTC
}

export interface ReservationStore {
  reservations: Reservation[];
}

export interface ClaimOptions {
  paths: string[];
  session: string;
  note: string;
  /** Minutes, default 45, clamped to the 240-minute hard max. */
  ttlMinutes?: number;
  /** Claim over a conflict anyway; the conflict is still logged with a ref-ID. */
  force?: boolean;
  /** Injectable clock for tests. Defaults to Date.now(). */
  now?: number;
}

export interface ClaimResult {
  ok: boolean;
  reservation?: Reservation;
  conflicts?: Reservation[];
}

export interface ReleaseOptions {
  /** Release exactly this reservation. Takes priority over `session` if both are set. */
  id?: string;
  /** Release every reservation held by this session. */
  session?: string;
}

export const DEFAULT_TTL_MINUTES = 45;
export const MAX_TTL_MINUTES = 240;
const MINUTE_MS = 60_000;

export function reservationsPath(): string {
  return join(paHome(), 'reservations.json');
}

/**
 * Normalize a claim path: backslashes to forward slashes, strip a leading
 * `./` and trailing `/`, reject absolute paths and `..` escapes. A path
 * starting with `@` is a logical resource (e.g. "@build") and is returned
 * unchanged — it can never collide with a filesystem path.
 */
export function normalizePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('reservation path must be a non-empty string');
  }

  if (input.startsWith('@')) {
    if (input.length < 2) {
      throw new Error(`invalid logical resource: "${input}"`);
    }
    return input;
  }

  let p = input.replace(/\\/g, '/');
  p = p.replace(/^(\.\/)+/, '');
  p = p.replace(/\/+$/, '');

  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new Error(`reservation path must be repo-relative, not absolute: "${input}"`);
  }

  if (p.split('/').some((segment) => segment === '..')) {
    throw new Error(`reservation path escapes the repo root: "${input}"`);
  }

  if (p === '' || p === '.') {
    throw new Error(`reservation path must not be empty: "${input}"`);
  }

  return p;
}

/**
 * Two normalized paths overlap iff one is the other, or one is a path
 * prefix of the other at a `/` boundary. Deliberately NOT a raw
 * string-prefix check: "pa/src/a.ts" vs "pa/src/ab.ts" must be false.
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return b.startsWith(a + '/') || a.startsWith(b + '/');
}

function clampTtlMinutes(ttlMinutes: number | undefined): number {
  const v = ttlMinutes ?? DEFAULT_TTL_MINUTES;
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_TTL_MINUTES;
  return Math.min(v, MAX_TTL_MINUTES);
}

async function ensureFile(path: string): Promise<void> {
  let exists = await fs.pathExists(path);
  if (exists) {
    try {
      const stats = await fs.stat(path);
      if (stats.size === 0) exists = false;
    } catch {
      exists = false;
    }
  }

  if (!exists) {
    await fs.ensureDir(dirname(path));
    try {
      await fs.writeJson(path, { reservations: [] }, { flag: 'wx' });
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

async function readStore(path: string): Promise<ReservationStore> {
  try {
    const data = await fs.readJson(path);
    if (!data || !Array.isArray(data.reservations)) return { reservations: [] };
    return data;
  } catch (err) {
    console.warn('[reservations] Failed to read reservations.json, resetting:', err);
    return { reservations: [] };
  }
}

/**
 * Read-modify-write a fresh copy of the store under the file lock. `fn`
 * mutates `store` in place (or reassigns `store.reservations`); whatever it
 * returns becomes the lock's result. The store is always written back,
 * even when `fn` reports a logical failure (e.g. a conflict) — this keeps
 * the write unconditional and the accept/reject decision purely in `fn`.
 *
 * In-process calls are additionally serialized through `mutateQueue` before
 * ever touching proper-lockfile (same pattern as log.ts's appendQueue).
 * proper-lockfile's own retry/backoff is built for cross-process contention
 * (~1s-then-exponential) and is far too slow for N same-process calls
 * racing the same mkdir-based lock — that races each other into ELOCKED and
 * pays a multi-second backoff instead of just waiting their turn.
 */
let mutateQueue: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (store: ReservationStore) => T): Promise<T> {
  const run = async (): Promise<T> => {
    const path = reservationsPath();
    await ensureFile(path);
    const release = await lockfile.lock(path, safeLockOptions('reservations', { retries: 5 }));
    try {
      const store = await readStore(path);
      const result = fn(store);
      await fs.writeJson(path, store, { spaces: 2 });
      return result;
    } finally {
      await release();
    }
  };

  const task = mutateQueue.catch(() => {}).then(run);
  mutateQueue = task.catch(() => {});
  return task;
}

/** Reservations whose expiresAt is still in the future relative to `now`. */
export async function readActive(now: number = Date.now()): Promise<Reservation[]> {
  const path = reservationsPath();
  await ensureFile(path);
  const store = await readStore(path);
  return store.reservations.filter((r) => new Date(r.expiresAt).getTime() > now);
}

export async function claim(opts: ClaimOptions): Promise<ClaimResult> {
  const now = opts.now ?? Date.now();
  const paths = opts.paths.map(normalizePath);
  const ttlMinutes = clampTtlMinutes(opts.ttlMinutes);

  return mutate((store) => {
    const active = store.reservations.filter((r) => new Date(r.expiresAt).getTime() > now);
    const conflicts = active.filter(
      (r) => r.session !== opts.session && paths.some((p) => r.paths.some((rp) => pathsOverlap(p, rp)))
    );

    if (conflicts.length > 0 && !opts.force) {
      return { ok: false, conflicts };
    }

    const reservation: Reservation = {
      id: `r-${randomBytes(4).toString('hex')}`,
      paths,
      session: opts.session,
      note: opts.note,
      claimedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMinutes * MINUTE_MS).toISOString(),
    };
    store.reservations.push(reservation);

    if (conflicts.length > 0 && opts.force) {
      log('warn', 'reservations', 'force-claim over active conflict', {
        refId: `s-${randomBytes(6).toString('hex')}`,
        session: opts.session,
        newReservationId: reservation.id,
        paths,
        conflicts: conflicts.map((c) => ({ id: c.id, session: c.session, note: c.note })),
      });
    }

    return { ok: true, reservation };
  });
}

/** Extend an existing reservation's expiresAt. Leaves claimedAt and id unchanged. */
export async function renew(
  id: string,
  opts?: { ttlMinutes?: number; now?: number }
): Promise<Reservation | null> {
  const now = opts?.now ?? Date.now();
  const ttlMinutes = clampTtlMinutes(opts?.ttlMinutes);

  return mutate((store) => {
    const entry = store.reservations.find((r) => r.id === id);
    if (!entry) return null;
    entry.expiresAt = new Date(now + ttlMinutes * MINUTE_MS).toISOString();
    return entry;
  });
}

export async function release(opts: ReleaseOptions): Promise<{ released: number }> {
  return mutate((store) => {
    const before = store.reservations.length;
    store.reservations = store.reservations.filter((r) => {
      if (opts.id !== undefined) return r.id !== opts.id;
      if (opts.session !== undefined) return r.session !== opts.session;
      return true;
    });
    return { released: before - store.reservations.length };
  });
}

/** Drop every reservation whose expiresAt has passed. Returns the count removed. */
export async function gcExpired(now: number = Date.now()): Promise<number> {
  return mutate((store) => {
    const before = store.reservations.length;
    store.reservations = store.reservations.filter((r) => new Date(r.expiresAt).getTime() > now);
    return before - store.reservations.length;
  });
}
