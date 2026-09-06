/**
 * Topic-ownership registry loader (AI-194, 2026-09-05).
 *
 * `~/.pa/topic-ownership-registry.json` is a hand-maintained JSON object
 * keyed `"<chatId>_<threadId>"` — the TOPIC_KEY_RE form shared with the
 * orphan ledger's owner_topic and the config `topics.support` knob. Each
 * row: `{ label?, domain?, role, projects?, owned? }` — label/domain/
 * projects are informational; the only honored `role` is `"catch-all"`;
 * `owned` lists repo-relative posix PREFIX paths matched with segment
 * semantics (exact or children — never ancestors, never partial-segment
 * strings).
 *
 * Precedence everywhere (adjudicated 2026-09-05): the orphan ledger answers
 * WHO MADE a change and is consulted FIRST; this registry answers WHO OWNS
 * an area and fills only the paths the ledger leaves unattributed; the
 * config `topics.support` knob stays the final fallback after the catch-all
 * row.
 *
 * The file is read per lookup, never cached beyond the process-level
 * warn/info flags: missing/corrupt/invalid content degrades to an empty
 * registry with ONE warn-once per process (the orphan-ledger reader's
 * fail-to-empty discipline) — the loader never throws, so a bad hand edit
 * can only degrade routing to the pre-registry behavior, never break it.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { configPath, paHome } from '../paths.js';
import { log } from './log.js';

/** The one topic-key grammar: `"<chatId>_<threadId>"`, both numeric. */
export const TOPIC_KEY_RE = /^(-?\d+)_(\d+)$/;

export interface TopicOwnershipRow {
  label?: string;
  domain?: string;
  role?: string;
  projects?: string[];
  owned?: string[];
}

export type TopicOwnershipRegistry = Map<string, TopicOwnershipRow>;

export function topicOwnershipRegistryPath(): string {
  return join(paHome(), 'topic-ownership-registry.json');
}

// Warn-once per process (orphan-ledger reader pattern): every failure class
// — unreadable/unparseable/non-object file, dropped rows, overlapping owned
// prefixes — folds into this ONE warn so a broken file nags once, not per
// lookup.
let warnedBroken = false;

function warnOnceBroken(context: Record<string, unknown>): void {
  if (warnedBroken) return;
  warnedBroken = true;
  log(
    'warn',
    'topic-ownership',
    'topic-ownership registry missing/corrupt or carries invalid/overlapping rows; affected entries dropped (warn-once per process)',
    context,
  );
}

// Success artifact: ONE info line per process naming the row count and the
// catch-all key — the live-verification signature of a registry-fed run.
let loggedLoaded = false;

/**
 * Read and validate the registry. Absent/corrupt/unparseable/non-object →
 * empty Map (+ the warn-once). Rows failing the key grammar, non-object
 * rows, and rows whose `owned` is present but not string[] are DROPPED and
 * folded into the single warn-once with a dropped count. Two rows with
 * intersecting `owned` prefixes fold into the same warn-once; resolution
 * keeps the first row in parse order — the maintained invariant is "keep
 * `owned` lists disjoint across rows".
 */
export async function loadTopicOwnershipRegistry(): Promise<TopicOwnershipRegistry> {
  let raw: string;
  try {
    raw = await readFile(topicOwnershipRegistryPath(), 'utf8');
  } catch (err) {
    warnOnceBroken({ reason: 'unreadable', error: String(err) });
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnOnceBroken({ reason: 'unparseable', error: String(err) });
    return new Map();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnOnceBroken({ reason: 'not-an-object' });
    return new Map();
  }

  const reg: TopicOwnershipRegistry = new Map();
  let dropped = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!TOPIC_KEY_RE.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      dropped++;
      continue;
    }
    const row = value as Record<string, unknown>;
    if (
      row.owned !== undefined &&
      (!Array.isArray(row.owned) || !row.owned.every((p) => typeof p === 'string'))
    ) {
      dropped++;
      continue;
    }
    reg.set(key, value as TopicOwnershipRow);
  }
  if (dropped > 0) warnOnceBroken({ dropped });

  // Overlap check, O(n²) over the ≤ tens of rows a hand-maintained file has.
  const entries = [...reg.entries()];
  let overlap: [string, string] | null = null;
  for (let i = 0; i < entries.length && !overlap; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i][1].owned ?? [];
      const b = entries[j][1].owned ?? [];
      if (a.some((pa) => b.some((pb) => pathUnderPrefix(pa, pb) || pathUnderPrefix(pb, pa)))) {
        overlap = [entries[i][0], entries[j][0]];
        break;
      }
    }
  }
  if (overlap) warnOnceBroken({ overlap });

  if (reg.size > 0 && !loggedLoaded) {
    loggedLoaded = true;
    log('info', 'topic-ownership', `registry loaded: ${reg.size} rows, catch-all ${resolveCatchAll(reg) ?? 'none'}`);
  }
  return reg;
}

/** First `role: "catch-all"` row in parse order, or undefined. */
export function resolveCatchAll(reg: TopicOwnershipRegistry): string | undefined {
  for (const [key, row] of reg) {
    if (row.role === 'catch-all') return key;
  }
  return undefined;
}

/** Segment-prefix match (adjudication D): exact or under `prefix/` — an
 *  ancestor or partial-segment string never matches. Case-sensitive. */
function pathUnderPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
}

/** First row (parse order) whose `owned` prefixes segment-match `p`, or
 *  null when no row owns it. */
export function resolveOwnerForPath(reg: TopicOwnershipRegistry, p: string): string | null {
  for (const [key, row] of reg) {
    if ((row.owned ?? []).some((prefix) => pathUnderPrefix(p, prefix))) return key;
  }
  return null;
}

/** `topics.support` from config.yaml — "<chatId>_<threadId>" or undefined.
 *  The EXACT fallback body `loadSupportTopic` used to inline, exported so
 *  tests exercise the fallback chain directly. */
export async function readConfigSupportTopic(): Promise<string | undefined> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = parseYaml(raw) as { topics?: { support?: unknown } } | null;
    const v = parsed?.topics?.support;
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The routing resolution order: registry catch-all row, then config
 *  `topics.support`, then undefined. */
export async function resolveRoutingTarget(): Promise<string | undefined> {
  return resolveCatchAll(await loadTopicOwnershipRegistry()) ?? (await readConfigSupportTopic());
}
