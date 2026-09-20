/**
 * Addressable append-only message bus — one JSONL queue file per address:
 * `~/.pa/queues/<address>.jsonl`, plus a `<address>.cursor.json` read cursor
 * and a shared `registry.json` of address capabilities.
 *
 * Reads are soft by default: `pa bus inbox` marks the caller's address on
 * the envelope's `readBy` receipts instead of deleting — an accidental
 * foreign read no longer destroys the owner's mail, and `bus list` exposes
 * the receipt trail. `popBusMessage`/`ackBusMessage` still REMOVE envelopes
 * (delete-on-ack) for the drain's at-most-once delivery path and explicit
 * `inbox --consume`. `pruneBusQueue` drops envelopes older than `maxAgeMs`
 * (24h default — read receipts or not, stale coordination mail expires) or
 * keeps only the newest `maxEntries`; the bus-prune maintenance job runs it
 * on every queue file daily, which is also what bounds phantom-address
 * queues nobody ever reads.
 *
 * Concurrency: the reservations/topic-tasks pattern — an in-process promise
 * mutex serializes same-process callers, then proper-lockfile with
 * safeLockOptions on the store file itself covers cross-process producers,
 * and every rewrite goes through writeFileAtomic/writeJsonAtomic.
 */
import { createHash, randomBytes } from 'crypto';
import { basename, dirname, join } from 'path';
import fs from 'fs-extra';
import lockfile from 'proper-lockfile';
import { paHome } from '../paths.js';
import { safeLockOptions } from './safe-lock.js';
import { writeFileAtomic, writeJsonAtomic } from './atomic-write.js';
import { _resetBoundedQueueForTest, withBoundedQueue } from './stall.js';

/** Addresses are single path-safe tokens: `telegram:-1001:3376`, `#general`,
 *  `worker@host`. No separators, so an address can never escape ~/.pa/queues. */
export const BUS_ADDRESS_RE = /^[a-z0-9@#:._-]{1,64}$/i;
export type BusAddress = string;

export interface BusEnvelope {
  /** "bus-" + 12 hex. */
  id: string;
  from: BusAddress;
  to: BusAddress;
  /** ISO 8601 send time. */
  ts: string;
  /** Forward hop count; 0 on the originating append. */
  hops: number;
  /** Correlation id of the envelope this replies to, else null. */
  reply_to?: string | null;
  body: unknown;
  /** sha256("<to>|<json(body)>|<reply_to>"), first 16 hex — dedup key. */
  hash: string;
  consumed?: boolean;
  /** ISO 8601, set when consumed flips true. */
  consumedAt?: string;
  /** Consumer addresses that have marked this envelope read (soft-read
   *  receipts). A read never removes the envelope — the intended recipient
   *  still sees it unread-for-them after an accidental foreign read. Bounded
   *  by BUS_READBY_RING. */
  readBy?: string[];
}

export interface BusCursor {
  last_event: string;
  /** ISO 8601. */
  last_event_at: string;
  pid?: number;
  /** WP-B peek-dedup: envelope ids already injected into the session by a
   *  delivery arm (ring, capped at BUS_DELIVERED_RING). NOT consumption —
   *  the envelopes stay queued until an explicit `pa bus inbox` pops them. */
  delivered?: string[];
}

export interface BusRegistryEntry {
  capabilities: string[];
  worker?: string;
  nativeSessionId?: string;
  /** WP-A: the owning session's process id (hook's parent pid) — claim labels
   *  and lock holders resolve to a live address through this. */
  pid?: number;
  /** AI-272: the session's terminal-window identity (`<VAR>=<value>`), recorded
   *  at registration. Env vars survive exec boundaries where the Win32 parent
   *  chain does not — the npm `pa` sh-shim's MSYS2 exec leaves node's ancestry
   *  pointing at a reaped pid, so descendants of a registered session resolve
   *  through this when the ancestor walk dead-ends. */
  termKey?: string;
  /** ISO 8601. */
  createdAt: string;
}

export type BusRegistry = Record<string, BusRegistryEntry>;

const CONSUMED_RETENTION_MS = 24 * 60 * 60_000;
const CONSUMED_MAX_ENTRIES = 200;
/** Cap on per-envelope read receipts — a shared (topic:/chan:) queue could
 *  otherwise accumulate one entry per reader forever. */
const BUS_READBY_RING = 32;

function busDir(): string {
  return join(paHome(), 'queues');
}

/** Sanitize an address for filesystem use — ':' → '+' (invalid in Windows
 *  filenames and not in the bus address grammar, so the encoding is
 *  reversible). The address grammar keeps ':' as the separator; only the
 *  filename encoding changes. */
function sanitizeForPath(address: string): string {
  return address.replace(/:/g, '+');
}

function queuePath(address: string): string {
  return join(busDir(), `${sanitizeForPath(address)}.jsonl`);
}

function cursorPath(address: string): string {
  return join(busDir(), `${sanitizeForPath(address)}.cursor.json`);
}

function registryPath(): string {
  return join(busDir(), 'registry.json');
}

export const BUS_MAX_BODY_CHARS = 16384;

/** Validate an address against the bus grammar — returns {ok} not throws.
 *  Grammar: <name>@<repo> | <name>:<id> | <name>@<repo>#<n> | topic:<id> | chan:<name>
 *  Name must start with a letter, contain only [a-z0-9._-]. Repo/id: [a-z0-9._-]+. */
export function validateAddress(addr: string): { ok: true } | { ok: false; error: string } {
  if (typeof addr !== 'string' || addr.length === 0) return { ok: false, error: 'address must be a non-empty string' };
  if (addr.length > 64) return { ok: false, error: 'address exceeds 64 characters' };
  // Split on # discriminator first.
  const hashIdx = addr.indexOf('#');
  let base = addr;
  let disc: string | undefined;
  if (hashIdx >= 0) {
    base = addr.slice(0, hashIdx);
    disc = addr.slice(hashIdx + 1);
    if (disc === '' || !/^\d+$/.test(disc)) return { ok: false, error: `invalid discriminator "#${disc ?? ''}"` };
  }
  const atIdx = base.indexOf('@');
  const colonIdx = base.indexOf(':');
  if (atIdx >= 0 && colonIdx >= 0) return { ok: false, error: 'address must not contain both @ and :' };
  if (atIdx < 0 && colonIdx < 0) return { ok: false, error: 'address must contain @ or : separator' };
  const sepIdx = atIdx >= 0 ? atIdx : colonIdx;
  const name = base.slice(0, sepIdx);
  const rest = base.slice(sepIdx + 1);
  if (!name || !/^[a-z][a-z0-9._-]*$/i.test(name)) return { ok: false, error: `invalid name "${name}" — must start with a letter` };
  if (!rest || !/^[a-z0-9._-]+$/i.test(rest)) return { ok: false, error: `invalid identifier "${rest}"` };
  return { ok: true };
}

/** Validate a message body — non-empty string under BUS_MAX_BODY_CHARS. */
export function validateBody(body: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof body !== 'string') return { ok: false, error: 'bus.body must be a string' };
  if (body.length === 0 || !body.trim()) return { ok: false, error: 'bus.body must not be empty' };
  if (body.length > BUS_MAX_BODY_CHARS) return { ok: false, error: `bus.body exceeds ${BUS_MAX_BODY_CHARS} characters` };
  return { ok: true };
}

/** Public path helpers — thin wrappers over the internal ones. */
export function busQueuePath(address: BusAddress): string { return queuePath(address); }
export function busCursorPath(address: BusAddress): string { return cursorPath(address); }
export function busRegistryPath(): string { return registryPath(); }

function assertAddress(address: string, field: string): void {
  if (typeof address !== 'string' || !BUS_ADDRESS_RE.test(address)) {
    throw new Error(`${field} must match ${BUS_ADDRESS_RE}`);
  }
}

function isBusEnvelope(t: unknown): t is BusEnvelope {
  if (!t || typeof t !== 'object') return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.from === 'string' &&
    typeof r.to === 'string' &&
    typeof r.ts === 'string' &&
    typeof r.hops === 'number' &&
    (r.reply_to === undefined || r.reply_to === null || typeof r.reply_to === 'string') &&
    'body' in r &&
    typeof r.hash === 'string'
  );
}

function busContentHash(to: string, body: unknown, replyTo: string | null): string {
  return createHash('sha256')
    .update(`${to}|${JSON.stringify(body)}|${replyTo ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

async function ensureQueueFile(path: string): Promise<void> {
  await fs.ensureDir(dirname(path));
  await fs.appendFile(path, '', { flag: 'a' });
}

async function ensureJsonFile(path: string, seed: unknown): Promise<void> {
  await fs.ensureDir(dirname(path));
  try {
    await fs.writeJson(path, seed, { flag: 'wx' });
  } catch (err: any) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function readCursorFile(path: string): Promise<BusCursor | null> {
  try {
    const data = await fs.readJson(path);
    return data && typeof data.last_event === 'string' ? (data as BusCursor) : null;
  } catch {
    return null;
  }
}

function parseJsonl(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function serializeJsonl(envelopes: BusEnvelope[]): string {
  return envelopes.map((e) => JSON.stringify(e)).join('\n') + (envelopes.length ? '\n' : '');
}

/** Read-only path: absent or corrupt reads as an empty queue, never throws. */
async function readEnvelopesTolerant(path: string): Promise<BusEnvelope[]> {
  try {
    return parseJsonl(await fs.readFile(path, 'utf8')).filter(isBusEnvelope);
  } catch {
    return [];
  }
}

/** Read INSIDE a locked mutation: a corrupt line throws so a mutation can
 *  never wipe the queue on a parse failure (readQueueStrict precedent). */
async function readEnvelopesStrict(path: string): Promise<BusEnvelope[]> {
  let parsed: unknown[];
  try {
    parsed = parseJsonl(await fs.readFile(path, 'utf8'));
  } catch (err: any) {
    throw new Error(`bus queue is corrupt: ${path}: ${err.message}`);
  }
  return parsed.filter(isBusEnvelope);
}

// In-process bounded queue (lib/stall.ts, key 'bus-queue'): same-process
// callers serialize BEFORE touching proper-lockfile, whose retry/backoff is
// built for cross-process contention, not N in-process racers.

/** Serialize a read-modify-write on one store file (the lock target must
 *  exist before locking — proper-lockfile lstats it). `ensure` creates the
 *  right kind of seed for the file being mutated. */
async function withBusLock<T>(
  path: string,
  ensure: () => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> => {
    await ensure();
    const release = await lockfile.lock(path, safeLockOptions('bus-queue', { retries: 5 }));
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  return withBoundedQueue('bus-queue', run, { store: 'bus-queue', target: basename(path) });
}

export const BUS_MAX_HOPS = 8;

/**
 * Append one envelope to an address's queue. If an UNCONSUMED envelope with
 * the same content hash (to + body + reply_to) is already queued, returns
 * `{ id: existing.id, deduped: true }` and writes nothing — the same message
 * can be re-sent once the earlier copy was consumed, but double-queueing is
 * impossible. Throws on invalid input.
 *
 * Hops cap: when input.hops >= BUS_MAX_HOPS, the message is dead-lettered —
 * a notification envelope is sent back to input.from instead of enqueuing
 * to input.to. The dead-letter envelope has hops=0 so it can itself be
 * delivered normally.
 */
export async function appendBusMessage(input: {
  from: BusAddress;
  to: BusAddress;
  body: unknown;
  reply_to?: string | null;
  hops?: number;
}): Promise<{ id: string; deduped: boolean; deadLettered?: boolean }> {
  if (!input || typeof input !== 'object') throw new Error('bus envelope must be an object');
  assertAddress(input.to, 'envelope.to');
  assertAddress(input.from, 'envelope.from');
  if (input.body === undefined) throw new Error('envelope.body must be defined');
  const bodyCheck = validateBody(input.body);
  if (!bodyCheck.ok) throw new Error(bodyCheck.error);
  if (input.reply_to !== undefined && input.reply_to !== null && typeof input.reply_to !== 'string') {
    throw new Error('envelope.reply_to must be a string or null');
  }
  if (input.hops !== undefined && (!Number.isInteger(input.hops) || input.hops < 0)) {
    throw new Error('envelope.hops must be a non-negative integer');
  }

  // Dead-letter: hops cap exceeded — notify the sender instead of delivering.
  const hops = input.hops ?? 0;
  if (hops >= BUS_MAX_HOPS) {
    const dlResult = await appendBusMessage({
      from: input.to,
      to: input.from,
      body: `DEAD-LETTER: message to "${input.to}" exceeded BUS_MAX_HOPS (${BUS_MAX_HOPS}). Original body: ${typeof input.body === 'string' ? input.body.slice(0, 200) : '[object]'}`,
      hops: 0,
    });
    return { id: dlResult.id, deduped: false, deadLettered: true };
  }

  const replyTo = input.reply_to ?? null;
  const hash = busContentHash(input.to, input.body, replyTo);
  const path = queuePath(input.to);
  return withBusLock(path, () => ensureQueueFile(path), async () => {
    const envelopes = await readEnvelopesStrict(path);
    const existing = envelopes.find((e) => e.hash === hash);
    if (existing) return { id: existing.id, deduped: true };
    const record: BusEnvelope = {
      id: `bus-${randomBytes(6).toString('hex')}`,
      from: input.from,
      to: input.to,
      ts: new Date().toISOString(),
      hops,
      ...(replyTo !== null ? { reply_to: replyTo } : {}),
      body: input.body,
      hash,
    };
    await fs.appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
    return { id: record.id, deduped: false };
  });
}

/** Send a message — the user-facing append path. Same as appendBusMessage. */
export const sendBusMessage = appendBusMessage;

/** All envelopes for an address (consumed included), file order.
 *  Absent/corrupt/invalid-address → []. Read paths never throw. */
export async function listBusMessages(address: BusAddress): Promise<BusEnvelope[]> {
  if (typeof address !== 'string' || !BUS_ADDRESS_RE.test(address)) return [];
  return readEnvelopesTolerant(queuePath(address));
}

/** Oldest envelope WITHOUT removing it; null when the queue is empty.
 *  Throws on a corrupt queue file (strict read — corruption is not silently
 *  swallowed on the read path). */
export async function peekBusMessage(address: BusAddress): Promise<BusEnvelope | null> {
  assertAddress(address, 'address');
  const path = queuePath(address);
  if (!(await fs.pathExists(path))) return null;
  const envelopes = await readEnvelopesStrict(path);
  return envelopes[0] ?? null;
}

/** Oldest N envelopes WITHOUT removing them, file order; [] when empty.
 *  Strict read — throws on a corrupt queue file, mirroring peekBusMessage
 *  (a tolerant batch read would silently swallow corruption the single-peek
 *  path throws on). Limit clamps to min 1; a missing file reads as []. */
export async function peekBusMessages(address: BusAddress, limit: number): Promise<BusEnvelope[]> {
  assertAddress(address, 'address');
  const n = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const path = queuePath(address);
  if (!(await fs.pathExists(path))) return [];
  const envelopes = await readEnvelopesStrict(path);
  return envelopes.slice(0, n);
}

/**
 * Destructive read: removes and returns the oldest envelope (FIFO).
 * Null when the queue is empty.
 */
export async function popBusMessage(address: BusAddress): Promise<BusEnvelope | null> {
  assertAddress(address, 'address');
  const path = queuePath(address);
  return withBusLock(path, () => ensureQueueFile(path), async () => {
    const envelopes = await readEnvelopesStrict(path);
    if (envelopes.length === 0) return null;
    const [next, ...rest] = envelopes;
    await writeFileAtomic(path, serializeJsonl(rest));
    return next;
  });
}

/** Soft-read receipt: record `reader` on the envelope's readBy list without
 *  removing it — the queue's owner still sees it unread-for-them after a
 *  foreign session's accidental `bus inbox`. Returns the marked envelope,
 *  null when the id is absent. Idempotent for a repeated reader; the list is
 *  bounded at BUS_READBY_RING (oldest receipts drop off). */
export async function markBusRead(
  address: BusAddress,
  id: string,
  reader: string,
): Promise<BusEnvelope | null> {
  assertAddress(address, 'address');
  if (typeof id !== 'string' || !id) throw new Error('id must be a non-empty string');
  if (typeof reader !== 'string' || !reader) throw new Error('reader must be a non-empty string');
  const path = queuePath(address);
  return withBusLock(path, () => ensureQueueFile(path), async () => {
    const envelopes = await readEnvelopesStrict(path);
    const env = envelopes.find((e) => e.id === id);
    if (!env) return null;
    const readBy = (env.readBy ?? []).filter((r) => r !== reader);
    readBy.push(reader);
    env.readBy = readBy.slice(-BUS_READBY_RING);
    await writeFileAtomic(path, serializeJsonl(envelopes));
    return env;
  });
}

/** Remove one envelope by id. Throws when no envelope with that id exists. */
export async function ackBusMessage(address: BusAddress, id: string): Promise<void> {
  assertAddress(address, 'address');
  if (typeof id !== 'string' || !id) throw new Error('id must be a non-empty string');
  const path = queuePath(address);
  return withBusLock(path, () => ensureQueueFile(path), async () => {
    const envelopes = await readEnvelopesStrict(path);
    const idx = envelopes.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`no bus message with id ${id} at ${address}`);
    envelopes.splice(idx, 1);
    await writeFileAtomic(path, serializeJsonl(envelopes));
  });
}

/** Advance an address's read cursor. */
export async function touchBusCursor(address: BusAddress, lastEvent: string, pid?: number): Promise<BusCursor> {
  assertAddress(address, 'address');
  if (typeof lastEvent !== 'string' || !lastEvent) {
    throw new Error('last_event must be a non-empty string');
  }
  const path = cursorPath(address);
  return withBusLock(path, () => ensureJsonFile(path, {}), async () => {
    const existing = await readCursorFile(path);
    // Spread `existing`: dropping `delivered` on every touch erased the
    // peek-dedup ring, so a hook re-injected an already-delivered envelope
    // after any inbox/wait/spawn touch.
    const cursor: BusCursor = {
      ...existing,
      last_event: lastEvent,
      last_event_at: new Date().toISOString(),
      pid: pid ?? existing?.pid ?? process.pid,
    };
    await writeJsonAtomic(path, cursor, { spaces: 2 });
    return cursor;
  });
}

/** Read an address's cursor; absent/corrupt → null. */
export async function readBusCursor(address: BusAddress): Promise<BusCursor | null> {
  assertAddress(address, 'address');
  try {
    const data = await fs.readJson(cursorPath(address));
    if (
      !data ||
      typeof data !== 'object' ||
      typeof (data as BusCursor).last_event !== 'string' ||
      typeof (data as BusCursor).last_event_at !== 'string'
    ) {
      return null;
    }
    return data as BusCursor;
  } catch {
    return null;
  }
}

/** Whole address registry; absent/corrupt → {}. Entries with a malformed
 *  shape are dropped rather than failing the read. */
export async function readBusRegistry(): Promise<BusRegistry> {
  try {
    const data = await fs.readJson(registryPath());
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: BusRegistry = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!BUS_ADDRESS_RE.test(key)) continue;
      const v = value as Partial<BusRegistryEntry> | null;
      if (!v || typeof v !== 'object' || !Array.isArray(v.capabilities) || typeof v.createdAt !== 'string') {
        continue;
      }
      out[key] = {
        capabilities: v.capabilities.filter((c): c is string => typeof c === 'string'),
        ...(typeof v.worker === 'string' ? { worker: v.worker } : {}),
        ...(typeof v.nativeSessionId === 'string' ? { nativeSessionId: v.nativeSessionId } : {}),
        ...(typeof v.pid === 'number' ? { pid: v.pid } : {}),
        ...(typeof v.termKey === 'string' ? { termKey: v.termKey } : {}),
        createdAt: v.createdAt,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** Replace the whole address registry. Every key must be a valid address. */
export async function writeBusRegistry(registry: BusRegistry): Promise<void> {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('registry must be an object keyed by address');
  }
  for (const [key, value] of Object.entries(registry)) {
    assertAddress(key, 'registry key');
    const v = value as Partial<BusRegistryEntry> | null;
    if (!v || typeof v !== 'object' || !Array.isArray(v.capabilities) || typeof v.createdAt !== 'string') {
      throw new Error(`registry entry for ${key} needs capabilities[] and createdAt`);
    }
  }
  const path = registryPath();
  return withBusLock(path, () => ensureJsonFile(path, {}), async () => {
    await writeJsonAtomic(path, registry, { spaces: 2 });
  });
}

/** Register an address — idempotent when the entry matches, mints #n on collision.
 *  The read-modify-write runs under the registry lock so two concurrent
 *  registrations can't overwrite each other's entries (the unlocked
 *  readBusRegistry + locked writeBusRegistry path was a race). */
export async function registerBusAddress(
  address: BusAddress,
  entry: { capabilities: string[]; worker?: string; spawn?: { worker: string }; nativeSessionId?: string; pid?: number; termKey?: string },
): Promise<{ address: BusAddress; discriminator?: number }> {
  const valid = validateAddress(address);
  if (!valid.ok) throw new Error(valid.error);
  const path = registryPath();
  return withBusLock(path, () => ensureJsonFile(path, {}), async () => {
    // Read the registry INSIDE the lock — the unlocked readBusRegistry +
    // locked writeBusRegistry path was a race where two concurrent
    // registrations could both miss the other's entry.
    let registry: BusRegistry;
    try {
      const data = await fs.readJson(path);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        registry = {};
      } else {
        registry = data as BusRegistry;
      }
    } catch {
      registry = {};
    }
    // AI-272: the registering process runs in the session's environment —
    // record the terminal-window key it inherited so later CLI descendants
    // whose ancestry is severed (MSYS exec shim) can still resolve this row.
    const termKey = entry.termKey ?? sessionTermKey();
    const existing = registry[address];
    if (existing) {
      // Idempotent: same capabilities + same worker → return base address.
      const sameCaps =
        existing.capabilities.length === entry.capabilities.length &&
        existing.capabilities.every((c) => entry.capabilities.includes(c));
      const sameWorker = (existing.worker ?? undefined) === (entry.worker ?? entry.spawn?.worker ?? undefined);
      if (sameCaps && sameWorker) {
        // Idempotent on the profile — but a re-registration may still be the
        // first to carry identity fields (WP-A): persist them rather than
        // silently dropping the session→address link.
        if (
          (entry.nativeSessionId && existing.nativeSessionId !== entry.nativeSessionId) ||
          (entry.pid !== undefined && existing.pid !== entry.pid) ||
          (termKey !== undefined && existing.termKey !== termKey)
        ) {
          registry[address] = {
            ...existing,
            ...(entry.nativeSessionId ? { nativeSessionId: entry.nativeSessionId } : {}),
            ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
            ...(termKey !== undefined ? { termKey } : {}),
          };
          await writeJsonAtomic(path, registry, { spaces: 2 });
        }
        return { address };
      }
      // Collision: different profile claiming the same base address → mint #n.
      let n = 1;
      while (registry[`${address}#${n}`]) n++;
      const discriminated = `${address}#${n}`;
      registry[discriminated] = {
        capabilities: [...entry.capabilities],
        ...(entry.worker ?? entry.spawn?.worker ? { worker: entry.worker ?? entry.spawn?.worker } : {}),
        ...(entry.nativeSessionId ? { nativeSessionId: entry.nativeSessionId } : {}),
        ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
        ...(termKey !== undefined ? { termKey } : {}),
        createdAt: new Date().toISOString(),
      };
      await writeJsonAtomic(path, registry, { spaces: 2 });
      return { address: discriminated, discriminator: n };
    }
    registry[address] = {
      capabilities: [...entry.capabilities],
      ...(entry.worker ?? entry.spawn?.worker ? { worker: entry.worker ?? entry.spawn?.worker } : {}),
      ...(entry.nativeSessionId ? { nativeSessionId: entry.nativeSessionId } : {}),
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      ...(termKey !== undefined ? { termKey } : {}),
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(path, registry, { spaces: 2 });
    return { address };
  });
}

/** Reap dead registry rows. Registry entries are TTL-free, so without this
 *  a dead session's address row lingers forever: sends to `provider@repo`
 *  keep fanning out to it, and a reused pid can later mis-resolve to the
 *  stale identity. A row is reapable when:
 *    1. its recorded host pid is DEAD and its own cursor is not fresh — the
 *       owning session's host process is gone; OR
 *    2. its pid is ALIVE but a DIFFERENT address on the same pid holds the
 *       fresh cursor — the row's session generation was superseded (the
 *       same rule as sweepDeadOwners' spawned-context arm).
 *  Fail-safes mirror that sweep: a fresh cursor on the row's own address
 *  vetoes; pid-less rows (agy-class, no host pid) and silent-host rows are
 *  kept as unprovable. Queue files are NOT touched — a reaped address's
 *  envelopes still expire on the 24h/200 bound and remain manually
 *  drainable until then. */
export async function reapBusRegistry(opts?: {
  isAlive?: (pid: number) => boolean;
  now?: number;
}): Promise<{ reaped: string[] }> {
  const { isProcessAlive } = await import('../worker-pids.js');
  const isAlive = opts?.isAlive ?? isProcessAlive;
  const now = opts?.now ?? Date.now();
  const cursorFresh = async (addr: string): Promise<boolean> => {
    const c = await readBusCursor(addr).catch(() => null);
    return !!c?.last_event_at && now - Date.parse(c.last_event_at) < BUS_CURSOR_FRESH_MS;
  };
  const registry = await readBusRegistry();
  const reapable = new Set<string>();
  for (const [addr, e] of Object.entries(registry)) {
    if (e.pid === undefined) continue; // pid-less: unprovable — keep
    if (await cursorFresh(addr)) continue; // own cursor still fires — live
    if (!isAlive(e.pid)) {
      reapable.add(addr);
      continue;
    }
    // Live pid, silent own cursor: superseded only when the pid hosts a
    // DIFFERENT live address (new session generation on the same host).
    for (const [other, o] of Object.entries(registry)) {
      if (other === addr || o.pid !== e.pid) continue;
      if (await cursorFresh(other)) {
        reapable.add(addr);
        break;
      }
    }
  }
  if (reapable.size === 0) return { reaped: [] };
  const path = registryPath();
  return withBusLock(path, () => ensureJsonFile(path, {}), async () => {
    // Re-read inside the lock and re-check the candidate's identity fields —
    // a row re-registered since the unlocked read is a NEW generation and
    // must be kept (mirrors sweepDeadOwners' candidate-set/mutate split).
    let current: BusRegistry;
    try {
      const data = await fs.readJson(path);
      current = data && typeof data === 'object' && !Array.isArray(data) ? (data as BusRegistry) : {};
    } catch {
      current = {};
    }
    const removed: string[] = [];
    for (const addr of reapable) {
      const live = current[addr];
      if (!live || live.createdAt !== registry[addr]?.createdAt || live.pid !== registry[addr]?.pid) continue;
      delete current[addr];
      removed.push(addr);
    }
    if (removed.length > 0) await writeJsonAtomic(path, current, { spaces: 2 });
    return { reaped: removed };
  });
}

// ---------------------------------------------------------------------------
// Per-session discriminated addresses + fan-out delivery (AI-255 WP-A/WP-B,
// 2026-09-16). Every headed session of a provider in a repo used to share ONE
// address (provider@repo): replies landed in whichever session popped first,
// and the Stop hook consumed messages meant for another session. The address
// now derives deterministically as `base#<sha256(sessionKey)[0:8]>` — numeric
// (the grammar's \d+ discriminator), stable per session, zero-lock (no
// registry round-trip inside the 50 ms hook budget).
// ---------------------------------------------------------------------------

/** Liveness window shared with bus-drain: a cursor touched inside this window
 *  counts as a live arm (a headed session's hooks firing, an active
 *  inbox/wait reader). Exported here so drain and fan-out share ONE value. */
export const BUS_CURSOR_FRESH_MS = 5 * 60_000;

/** How many envelope ids the `delivered` ring keeps (WP-B peek-dedup). */
export const BUS_DELIVERED_RING = 20;

/**
 * The session's own bus address: `base#<n>` where n derives deterministically
 * from the session key (hook session_id, PA_BUS_SESSION, a claim label, or a
 * caller pid). Numeric-only discriminator — the address grammar's `#\d+`
 * rule. `PA_BUS_ADDRESS` pins remain an explicit override handled by callers
 * BEFORE this is consulted.
 */
export function sessionBusAddress(base: BusAddress, sessionKey: string): BusAddress {
  const n = parseInt(createHash('sha256').update(sessionKey).digest('hex').slice(0, 8), 16);
  return `${base}#${n}`;
}

/** The resolved session identity: the bus address a headed session's hooks
 *  registered (or would register), plus the matched session pid when the
 *  answer came from the registry's ancestor match. `pa bus whoami` and
 *  `pa claim` (bus/pid auto-fill) share this — never fork the chain. */
export interface SessionBusIdentity {
  address: BusAddress;
  /** The session process's pid — present when the registry ancestor-match
   *  resolved the address, or process.ppid on the fallback path. */
  pid?: number;
  /** How the address was resolved — surfaced in verbose/diag contexts. */
  via: 'pin' | 'key' | 'registry-match' | 'ppid-fallback';
}

export function detectBusProvider(): string {
  return (
    process.env.PA_BUS_PROVIDER ??
    process.env.PA_WORKER ??
    // opencode sessions export OPENCODE=1 (+OPENCODE_PID) live — checked
    // first so an inherited foreign marker can never shadow the live session.
    (process.env.OPENCODE ? 'opencode'
    // kgclaude sessions carry BOTH KGCLAUDE_SESSION (its wrapper exports it)
    // and CLAUDECODE (it is the same claude.exe) — the kgclaude marker must
    // win or every TPU-backed session registers as plain 'claude'.
    : process.env.KGCLAUDE_SESSION ? 'kgclaude'
      : process.env.CLAUDECODE ? 'claude'
      : process.env.ANTIGRAVITY_AGENT ? 'agy'
      : process.env.CHISEL_SESSION_DB ? 'devin'
      : process.env.CODEX_CLI_PATH ? 'codex'
      : (process.env.GEMINI_SESSION_ID || process.env.GEMINI_CLI_PATH) ? 'gemini'
      : 'cli')
  );
}

/** Terminal-window identity vars, checked in order. Unlike process ancestry,
 *  an env var survives an MSYS2 `exec` — which is exactly where the npm `pa`
 *  sh-shim severs the Win32 parent chain (AI-272). The Python hooks mirror
 *  this list in `bus-session-start.py`/`bus-inject-*.py` (_term_key) — the
 *  ORDER is the contract; keep both sides in sync. */
const TERM_KEY_VARS = ['WT_SESSION', 'WEZTERM_PANE', 'TERM_SESSION_ID', 'KONSOLE_DBUS_SESSION', 'TMUX'];

/** This process's terminal-window key (`<VAR>=<value>`), or undefined when no
 *  known var is set. Same value in the session host, its hooks and every
 *  descendant shell — the non-ancestry identity channel. */
export function sessionTermKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const k of TERM_KEY_VARS) {
    const v = env[k];
    if (v) return `${k}=${v}`;
  }
  return undefined;
}

/**
 * Resolve THIS process's session bus address. Order:
 *   1. PA_BUS_ADDRESS pin (verbatim — drain-spawned workers ride it)
 *   2. explicit session key: opts.sessionKey > PA_BUS_SESSION > PA_SESSION
 *   3. host match: nearest ancestor running the provider's CLI image
 *      (claude.exe/devin.exe/codex.exe); the registry translates that pid to a
 *      `base#*` address when the hook registered it. Image-less providers
 *      (gemini/agy shims) match the nearest ancestor pid a hook registered.
 *   4. `base#<hostPid>` when the host is known but unregistered, else
 *      `base#<ppid-derived>` — per-invocation fallback, unstable across calls
 * `repo` callers pass the repo slug; when omitted it's derived from the git
 * root (repoRootFromModule) or 'unknown'.
 */
export async function resolveSessionBusAddress(opts?: {
  provider?: string;
  repo?: string;
  sessionKey?: string;
  /** Test seam: injected into getAncestorPids/getCommandLines so a test can
   *  pose a canned process table (AI-261 whoami==hook parity). */
  execFn?: import('../process-tree.js').ExecFn;
}): Promise<SessionBusIdentity> {
  const provider = opts?.provider ?? detectBusProvider();
  let repo = opts?.repo ?? process.env.PA_BUS_REPO;
  if (!repo) {
    try {
      const { repoRootFromModule } = await import('./git-root.js');
      const root = await repoRootFromModule(__filename);
      repo = root.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    } catch {
      repo = 'unknown';
    }
  }
  const base = `${provider}@${repo}`;

  // Host resolution answers two questions at once: which registered address
  // this process runs under, and WHICH PID hosts it (the claim's dead-owner
  // signal). It runs even when a pin/key already fixes the address — a headed
  // session that sets PA_SESSION still wants its real host pid recorded.
  // AI-260: before this, the key path returned pid-less and the fallback
  // returned process.ppid — a per-invocation shell dead within seconds — so
  // every plain `pa claim` became dead-owner-sweepable inside one GC cadence.
  const host = await resolveSessionHost(provider, base, opts?.execFn).catch(() => undefined);

  const pinned = process.env.PA_BUS_ADDRESS;
  if (pinned) return { address: pinned, pid: host?.pid, via: 'pin' };

  const key = opts?.sessionKey ?? process.env.PA_BUS_SESSION ?? process.env.PA_SESSION;
  if (key) return { address: sessionBusAddress(base, key), pid: host?.pid, via: 'key' };

  if (host?.address) return { address: host.address, pid: host.pid, via: 'registry-match' };

  // No registered address for this host. process.ppid is the caller's
  // transient shell, NEVER a session pid — it is not reported as `pid`
  // (a recorded-dead pid is what the dead-owner sweep keys on), and it only
  // supplies the fallback discriminant when no real host pid was found. A
  // known-but-unregistered host pid gives the session a stable fallback
  // address instead of a per-invocation one.
  const fallbackKey = host ? String(host.pid) : String(process.ppid);
  return { address: sessionBusAddress(base, fallbackKey), pid: host?.pid, via: 'ppid-fallback' };
}

/** CLI session-host image basenames by provider. Matched against each
 *  ancestor's executable token — never args (a `pwsh -c "devin …"` ancestor
 *  is pwsh, not a devin session). agy.exe is a real console host (1.2.4);
 *  node-launched providers (gemini) have no recognizable host image and
 *  keep the legacy registry match. */
const PROVIDER_HOST_IMAGE: Record<string, RegExp> = {
  claude: /^(claude|claude\.exe)$/i,
  // kgclaude execs the same claude.exe — same host image; KGCLAUDE_SESSION
  // (ambient env marker) is what split it out in detectBusProvider.
  kgclaude: /^(claude|claude\.exe)$/i,
  agy: /^(agy|agy\.exe)$/i,
  devin: /^(devin|devin\.exe)$/i,
  codex: /^(codex|codex\.exe)$/i,
  opencode: /^(opencode|opencode\.exe)$/i,
};

function cmdlineImage(cmdline: string): string {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmdline);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').split(/[\\/]/).pop() ?? '';
}

/** The session's host process: the nearest ancestor running the provider's
 *  CLI image, with the registry translating pid → discriminated address when
 *  an entry exists. Providers without a recognizable host image fall back to
 *  the nearest ancestor pid a hook registered under `<base>#*`.
 *  AI-260: registry-pid-only matching misfires — a stale registration whose
 *  pid was recycled into this process's chain wins over the true host (seen
 *  live: whoami inside a Claude Code Bash tool resolved another session).
 *  Image-first ordering makes the true host authoritative. */
async function resolveSessionHost(
  provider: string,
  base: string,
  execFn?: import('../process-tree.js').ExecFn,
): Promise<{ address?: BusAddress; pid: number } | undefined> {
  const { getAncestorPids, getCommandLines } = await import('../process-tree.js');
  const image = PROVIDER_HOST_IMAGE[provider];

  // Image providers still walk ancestors even with zero registrations — the
  // host pid is load-bearing (claim dead-owner signal + fallback discriminant).
  if (image) {
    const ancestors = await getAncestorPids(process.ppid, execFn);
    if (ancestors.length > 0) {
      const cmdlines = await getCommandLines(ancestors, execFn);
      const hostPid = ancestors.find((pid) => image.test(cmdlineImage(cmdlines.get(pid) ?? '')));
      if (hostPid !== undefined) {
        // One pid can hold several registrations — a restarted session re-registers
        // under a new session key while the old address lingers. The live inbox is
        // the freshest entry (AI-261).
        const registry = await readBusRegistry();
        const children = Object.keys(registry).filter((a) => a.startsWith(`${base}#`));
        const samePid = children
          .filter((a) => registry[a]?.pid === hostPid)
          .sort((a, b) => (Date.parse(registry[b]?.createdAt ?? '') || 0) - (Date.parse(registry[a]?.createdAt ?? '') || 0));
        return { pid: hostPid, address: samePid[0] };
      }
    }
    // The walk found no host image: either the chain is genuinely hostless, or
    // it was severed below the host — the npm `pa` sh-shim's MSYS2 `exec`
    // leaves the stub's recorded parent pointing at a reaped pid, truncating
    // the walk before it can reach claude.exe (AI-272). Terminal identity
    // survives exec where the process table does not — try it before
    // concluding there is no host.
    return matchRegistryByTermKey(base, execFn);
  }

  // Image-less providers (cli, node-launched) can only resolve through a
  // registered `<base>#*` child's pid landing on the ancestor chain — with no
  // children the walk returns undefined unconditionally, so the full process
  // snapshot it costs (~1s+ under load on win32) is pure waste. Registry read
  // first, early-out before the snapshot (2026-09-17 claim-latency fix).
  const registry = await readBusRegistry();
  const children = Object.keys(registry).filter((a) => a.startsWith(`${base}#`));
  if (children.length === 0) return undefined;
  const ancestors = await getAncestorPids(process.ppid, execFn);
  if (ancestors.length > 0) {
    const rank = new Map<number, number>();
    ancestors.forEach((pid, i) => { if (!rank.has(pid)) rank.set(pid, i); });
    const top = children
      .filter((a) => typeof registry[a]?.pid === 'number' && rank.has(registry[a].pid!))
      .sort((a, b) => rank.get(registry[a].pid!)! - rank.get(registry[b].pid!)!)[0];
    if (top) return { address: top, pid: registry[top].pid! };
  }
  return matchRegistryByTermKey(base, execFn, registry);
}

/** Registry fallback when ancestry can't prove the host (AI-272): match the
 *  caller's terminal-window key — inherited across the MSYS `exec` that severs
 *  the Win32 parent chain — against registered rows. A row only counts when
 *  its recorded pid is ALIVE in the same process snapshot, so a dead session's
 *  stale row in a reused terminal window cannot mis-resolve; freshest
 *  createdAt wins among live candidates (two live sessions sharing one
 *  terminal key is possible under tmux — the newest registration is the
 *  better guess, and ancestry would have won had it been intact). */
async function matchRegistryByTermKey(
  base: string,
  execFn: import('../process-tree.js').ExecFn | undefined,
  registry?: BusRegistry,
): Promise<{ address?: BusAddress; pid: number } | undefined> {
  const tk = sessionTermKey();
  if (!tk) return undefined;
  const reg = registry ?? (await readBusRegistry());
  const candidates = Object.keys(reg).filter(
    (a) => a.startsWith(`${base}#`) && reg[a]?.termKey === tk && typeof reg[a]?.pid === 'number',
  );
  if (candidates.length === 0) return undefined;
  const { getProcessSnapshot } = await import('../process-tree.js');
  const snapshot = await getProcessSnapshot(execFn);
  const live = candidates
    .filter((a) => snapshot.has(reg[a]!.pid!))
    .sort((a, b) => (Date.parse(reg[b]?.createdAt ?? '') || 0) - (Date.parse(reg[a]?.createdAt ?? '') || 0));
  const top = live[0];
  return top ? { address: top, pid: reg[top]!.pid! } : undefined;
}

/**
 * Fan-out send: `pa bus send <base>` delivers to every LIVE discriminated
 * child (`<base>#*` registry entries with a cursor touched inside
 * BUS_CURSOR_FRESH_MS) and does NOT write the base queue. With zero live
 * children it appends to the base queue exactly like appendBusMessage — the
 * drain's spawn arm is the offline mailbox. Addresses that already carry a
 * `#` discriminator, or `:`/`topic:`/`chan:` forms, are always direct
 * appends — fan-out exists only for the shared provider@repo base form.
 */
export async function deliverBusMessage(input: {
  from: BusAddress;
  to: BusAddress;
  body: unknown;
  reply_to?: string | null;
  hops?: number;
}): Promise<{ id: string; deduped: boolean; delivered?: BusAddress[]; queuedForDrain?: boolean; deadLettered?: boolean }> {
  const to = input.to;
  const isBase = !to.includes('#') && !to.includes(':');
  if (isBase) {
    const registry = await readBusRegistry();
    const children = Object.keys(registry).filter((k) => k.startsWith(`${to}#`));
    const live: BusAddress[] = [];
    const now = Date.now();
    for (const child of children) {
      const cursor = await readBusCursor(child);
      if (cursor?.last_event_at && now - Date.parse(cursor.last_event_at) < BUS_CURSOR_FRESH_MS) {
        live.push(child);
      }
    }
    if (live.length > 0) {
      const delivered: BusAddress[] = [];
      let firstId = '';
      for (const child of live) {
        const r = await appendBusMessage({ ...input, to: child });
        if (!r.deadLettered) delivered.push(child);
        if (!firstId) firstId = r.id;
      }
      if (delivered.length > 0) {
        return { id: firstId, deduped: false, delivered };
      }
      // Every live child dead-lettered — fall through to base queue so the
      // message is never dropped silently.
    }
    const base = await appendBusMessage(input);
    return { ...base, queuedForDrain: true };
  }
  return appendBusMessage(input);
}

/**
 * WP-B peek-dedup: record envelope ids the delivery arm has already surfaced
 * (injected into a session) without consuming them. Ring-kept at
 * BUS_DELIVERED_RING; missing ids append, present ids are no-ops.
 */
export async function markBusDelivered(address: BusAddress, ids: string[]): Promise<void> {
  assertAddress(address, 'address');
  if (!Array.isArray(ids) || ids.length === 0) return;
  const path = cursorPath(address);
  await withBusLock(path, () => ensureJsonFile(path, {}), async () => {
    const existing = (await readCursorFile(path)) ?? {
      last_event: 'delivered',
      last_event_at: new Date(0).toISOString(),
    };
    const ring = [...(existing.delivered ?? [])];
    for (const id of ids) {
      if (!ring.includes(id)) ring.push(id);
    }
    while (ring.length > BUS_DELIVERED_RING) ring.shift();
    const cursor: BusCursor = { ...existing, delivered: ring };
    await writeJsonAtomic(path, cursor, { spaces: 2 });
  });
}

/** Test-only: reset the in-process mutex so tests can isolate. */
export function _resetBusQueueForTest(): void {
  _resetBoundedQueueForTest('bus-queue');
}

/**
 * Drop envelopes older than maxAgeMs (by ts), or keep only the newest
 * maxEntries when the queue exceeds it — whichever bound hits first.
 * Returns {pruned: number}.
 */
export async function pruneBusQueue(
  address: BusAddress,
  opts?: { maxAgeMs?: number; maxEntries?: number },
): Promise<{ pruned: number }> {
  assertAddress(address, 'address');
  const maxAgeMs = opts?.maxAgeMs ?? CONSUMED_RETENTION_MS;
  const maxEntries = opts?.maxEntries ?? CONSUMED_MAX_ENTRIES;
  const path = queuePath(address);
  const pruned = await withBusLock(path, () => ensureQueueFile(path), async () => {
    const envelopes = await readEnvelopesStrict(path);
    const cutoff = Date.now() - maxAgeMs;
    let kept = envelopes.filter((e) => (Date.parse(e.ts) || 0) >= cutoff);
    if (kept.length > maxEntries) {
      kept = kept.slice(kept.length - maxEntries);
    }
    const removed = envelopes.length - kept.length;
    if (removed > 0) await writeFileAtomic(path, serializeJsonl(kept));
    return removed;
  });
  return { pruned };
}
