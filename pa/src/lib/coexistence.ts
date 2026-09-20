import { createHash } from 'crypto';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { paHome } from '../paths.js';
import { writeFileAtomic } from './atomic-write.js';

/**
 * Coexistence engine (Wave C / WP-C2, spec plans/2026-09-17-public-install-package-WAVE-C-SPEC.md).
 *
 * Registry-and-restore coexistence for every CLI pa touches: before any
 * in-place edit of a user's CLI config, the whole pre-edit file is snapshotted
 * under ~/.pa/coexistence-snapshots/ and one registry row is appended to
 * ~/.pa/coexistence-registry.json, so every edit is byte-reversible via
 * `pa coexistence restore <id>` (and visible via `pa doctor` / `pa coexistence list`).
 *
 * D2 hard rule: PA NEVER overwrites an existing key in a user's config.
 * `applyAdditive` throws KeyCollisionError on any existing-key collision and
 * writes nothing in that case — the caller routes to the ask flow (WP-C3).
 *
 * Config format note: JSON is the native format; a .jsonc surface (opencode)
 * is parsed tolerantly (comments + trailing commas stripped) and rewritten as
 * plain JSON. Restoration is always byte-identical because restore copies the
 * snapshot bytes back verbatim.
 */

export type CoexistenceCli = 'claude' | 'codex' | 'opencode' | 'devin';

export interface CoexistenceEntry {
  id: string;
  cli: CoexistenceCli;
  /** Absolute path of the touched config file. */
  surface: string;
  mode: 'registry-restore';
  /** Path under ~/.pa/coexistence-snapshots/ holding the pre-edit bytes.
   *  A 0-byte snapshot marks a surface that did not exist pre-edit; restoring
   *  such an entry removes the surface file (absence restore). */
  snapshot: string;
  addedKeys: string[];
  timestamp: string;
}

export class KeyCollisionError extends Error {
  readonly surface: string;
  readonly keys: string[];
  constructor(surface: string, keys: string[]) {
    super(
      `refusing to overwrite existing key(s) ${keys.map((k) => JSON.stringify(k)).join(', ')} in ${surface}` +
        ' — PA never overwrites a user-configured key; route to the ask flow (pa coexistence list / restore)',
    );
    this.name = 'KeyCollisionError';
    this.surface = surface;
    this.keys = keys;
  }
}

export function coexistenceRegistryPath(): string {
  return join(paHome(), 'coexistence-registry.json');
}

export function coexistenceSnapshotsDir(): string {
  return join(paHome(), 'coexistence-snapshots');
}

function sanitizeSurface(surface: string): string {
  return surface.replace(/[^A-Za-z0-9._-]/g, '-');
}

function hash12(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/** Registry row id: `<cli>-<surface>-<keyhash>` per the spec schema. */
function entryId(cli: CoexistenceCli, surface: string, addedKeys: string[]): string {
  return `${cli}-${sanitizeSurface(surface)}-${hash12(addedKeys.join(','))}`;
}

/** Minimal JSONC tolerance: strip // and /* *\/ comments and trailing commas
 *  so an opencode-style surface parses; output is rewritten as plain JSON. */
function parseConfig(raw: string): Record<string, unknown> {
  const noComments = raw
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const noTrailing = noComments.replace(/,(\s*[}\]])/g, '$1');
  const parsed: unknown = JSON.parse(noTrailing.trim().length === 0 ? '{}' : noTrailing);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config surface is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Dotted-path get: returns {present, value}. A key whose value is undefined
 *  counts as absent (JSON has no undefined; present means the key EXISTS). */
function getKey(obj: Record<string, unknown>, dotted: string): { present: boolean; value: unknown } {
  let node: unknown = obj;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return { present: false, value: undefined };
    if (!(part in (node as Record<string, unknown>))) return { present: false, value: undefined };
    node = (node as Record<string, unknown>)[part];
    if (node === undefined) return { present: false, value: undefined };
  }
  return { present: true, value: node };
}

/** Dotted-path set, creating intermediate objects as needed. */
function setKey(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let node: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = node[parts[i]];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[parts[i]] = {};
    }
    node = node[parts[i]] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

export interface AdditiveEntry {
  /** Dotted key path into the config object, e.g. "mcpServers.pa-mcp". */
  key: string;
  value: unknown;
}

export interface ApplyResult {
  added: string[];
  collided: string[];
}

/**
 * Snapshot a config surface's pre-edit bytes into the snapshots dir.
 * A surface that does not exist is snapshotted as a 0-byte marker file.
 * Returns the snapshot file path.
 */
export async function snapshotConfig(surface: string): Promise<string> {
  const dir = coexistenceSnapshotsDir();
  await mkdir(dir, { recursive: true });
  const snapshotPath = join(dir, `${sanitizeSurface(surface)}.snap`);
  if (existsSync(surface)) {
    await copyFile(surface, snapshotPath);
  } else {
    await writeFile(snapshotPath, '', 'utf8');
  }
  return snapshotPath;
}

/** Read the registry; a missing registry is an empty list. */
export async function list(): Promise<CoexistenceEntry[]> {
  try {
    const raw = await readFile(coexistenceRegistryPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const entries = (parsed as { entries?: unknown })?.entries;
    return Array.isArray(entries) ? (entries as CoexistenceEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeRegistry(entries: CoexistenceEntry[]): Promise<void> {
  await writeFileAtomic(coexistenceRegistryPath(), JSON.stringify({ entries }, null, 2) + '\n');
}

/**
 * Apply additive entries to a config surface, with the never-overwrite rule
 * enforced mechanically: snapshot the pre-edit bytes FIRST, then throw
 * KeyCollisionError (writing nothing) if ANY entry key already exists in the
 * config. On success every entry lands as a NEW key beside existing content,
 * one registry row is appended, and the added keys are returned.
 *
 * `cli` labels the registry row; `surface` is the absolute config path.
 */
export async function applyAdditive(
  cli: CoexistenceCli,
  surface: string,
  entries: AdditiveEntry[],
): Promise<ApplyResult> {
  const raw = existsSync(surface) ? await readFile(surface, 'utf8') : '';
  const parsed = parseConfig(raw);

  // Collision pre-check BEFORE any mutation: one existing key fails the whole
  // apply (all-or-nothing), so a partial write can never split the entries.
  const collided: string[] = [];
  for (const e of entries) {
    if (getKey(parsed, e.key).present) collided.push(e.key);
  }
  if (collided.length > 0) throw new KeyCollisionError(surface, collided);

  // Snapshot precedes the byte write (D2: every in-place edit is preceded by
  // a snapshot row so the edit is byte-reversible).
  const snapshot = await snapshotConfig(surface);
  const addedKeys: string[] = [];
  for (const e of entries) {
    setKey(parsed, e.key, e.value);
    addedKeys.push(e.key);
  }
  await writeFileAtomic(surface, JSON.stringify(parsed, null, 2) + '\n');

  const entry: CoexistenceEntry = {
    id: entryId(cli, surface, addedKeys),
    cli,
    surface,
    mode: 'registry-restore',
    snapshot,
    addedKeys,
    timestamp: new Date().toISOString(),
  };
  const existing = await list();
  await writeRegistry([...existing, entry]);
  return { added: addedKeys, collided: [] };
}

/**
 * Restore a registry entry's surface to its pre-edit bytes and verify the
 * result byte-identically (sha256 of the live file vs the snapshot; a 0-byte
 * snapshot requires the surface file to be absent again). The registry row is
 * removed after a successful restore (the change is undone; nothing PA wrote
 * remains applied). Returns the byte-identical verdict; a `false` verdict is
 * a failed restore, not a success.
 */
export async function restore(id: string): Promise<{ surface: string; byteIdentical: boolean }> {
  const entries = await list();
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no coexistence registry entry with id ${JSON.stringify(id)}`);
  const snapshotBytes = await readFile(entry.snapshot);
  const empty = snapshotBytes.length === 0;
  let byteIdentical = false;
  if (empty) {
    // Absence restore: the surface did not exist pre-edit.
    if (existsSync(entry.surface)) await unlink(entry.surface);
    byteIdentical = !existsSync(entry.surface);
  } else {
    // Snapshot bytes are decoded utf8 for the atomic write — every config
    // surface here is JSON/JSONC text; the byte-identical check still compares
    // the RAW re-read bytes against the raw snapshot bytes.
    await writeFileAtomic(entry.surface, snapshotBytes.toString('utf8'));
    const live = await readFile(entry.surface);
    byteIdentical = live.equals(snapshotBytes);
  }
  if (byteIdentical) {
    await writeRegistry(entries.filter((e) => e.id !== id));
  }
  return { surface: entry.surface, byteIdentical };
}

/** Summary shape `pa doctor` reports (never the raw snapshot paths). */
export interface CoexistenceEntrySummary {
  id: string;
  cli: CoexistenceCli;
  surface: string;
  addedKeys: string[];
  timestamp: string;
}

export function summarize(entries: CoexistenceEntry[]): CoexistenceEntrySummary[] {
  return entries.map(({ id, cli, surface, addedKeys, timestamp }) => ({
    id,
    cli,
    surface,
    addedKeys,
    timestamp,
  }));
}

/** Doctor arm: PA-touched entries per the registry. Degrades to [] on any
 *  read failure — a probe failure never fails the doctor report. */
export async function listForDoctor(): Promise<CoexistenceEntrySummary[]> {
  try {
    return summarize(await list());
  } catch {
    return [];
  }
}

/** Stat helper used by tests and callers that want snapshot liveness. */
export async function snapshotExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
