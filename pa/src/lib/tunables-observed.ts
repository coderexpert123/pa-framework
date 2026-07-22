/**
 * OBSERVED tunable values — the zero-maintenance half of discoverability.
 *
 * `values:` in config.yaml is a hand-written hint list and goes stale (agy
 * renamed its model from "Gemini 3.5 Flash" to "Gemini 3.6 Flash" within one
 * afternoon). Every `pa run` already writes its extraArgs into the run metadata
 * at ~/.pa/logs/<skill>/<ts>-<hex>.meta (RunMeta.extraArgs — see
 * pa/src/commands/logs.ts, which prints them), so history is a free, always-
 * current record of values that were ACTUALLY used. This module mines it.
 *
 * THIS IS THE ONLY TUNABLES MODULE THAT TOUCHES THE FILESYSTEM. The resolution
 * logic in `tunables.ts` stays pure; template semantics live there too
 * (extractTunableValues) so parsing history can never drift from emitting args.
 *
 * FAILS SOFT, ALWAYS. A missing logs directory, an unreadable skill folder, a
 * truncated or non-JSON .meta — every one of them contributes nothing and
 * throws nothing. This feeds a help message; it must never break a command.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { logsDir } from '../paths.js';
import type { RunMeta, WorkerConfig } from '../types.js';
import { extractTunableValues, getTunableSpec, listTunables, normalizeTunableName } from './tunables.js';

export interface ObservedValuesOptions {
  /** Override the logs root (tests). Defaults to paths.logsDir(). */
  dir?: string;
  /** Cap on .meta files read, newest first. Default 300. */
  maxFiles?: number;
  /** Ignore runs older than this many days, by the filename's YYYYMMDD prefix. Default 90. */
  maxAgeDays?: number;
  /** Injectable clock for maxAgeDays (ms since epoch). Default Date.now(). */
  now?: number;
}

const DEFAULT_MAX_FILES = 300;
const DEFAULT_MAX_AGE_DAYS = 90;

/** `20260722-141759-ab12cd.meta` -> 20260722; undefined when the name is not in that form. */
function dateKeyFromName(name: string): number | undefined {
  const m = /^(\d{8})-/.exec(name);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function cutoffDateKey(now: number, maxAgeDays: number): number {
  const d = new Date(now - maxAgeDays * 24 * 60 * 60 * 1000);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${y}${mo}${day}`);
}

/**
 * Collect recent runs' extraArgs for one worker, newest first.
 * Exported for tests and for callers that want several settings at once.
 */
export async function readRecentExtraArgs(
  workerName: string | undefined,
  opts: ObservedValuesOptions = {},
): Promise<string[][]> {
  if (!workerName) return [];
  const root = opts.dir ?? logsDir();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const cutoff = cutoffDateKey(opts.now ?? Date.now(), opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS);

  let skillDirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];   // no logs dir yet, or unreadable: nothing observed, no error
  }

  const files: Array<{ name: string; path: string }> = [];
  for (const skill of skillDirs) {
    let names: string[];
    try {
      names = await readdir(join(root, skill));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.meta')) continue;
      const key = dateKeyFromName(name);
      if (key !== undefined && key < cutoff) continue;
      files.push({ name, path: join(root, skill, name) });
    }
  }

  // Filenames start with a sortable YYYYMMDD-HHMMSS stamp, so a name sort is a
  // time sort — and costs no stat() calls.
  files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const selected = files.slice(0, Math.max(0, maxFiles));

  const metas = await Promise.all(selected.map(async ({ path }) => {
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as RunMeta;
    } catch {
      return undefined;   // truncated / mid-write / not JSON — skip it
    }
  }));

  const out: string[][] = [];
  for (const meta of metas) {
    if (!meta || meta.worker !== workerName) continue;
    if (!Array.isArray(meta.extraArgs) || meta.extraArgs.length === 0) continue;
    out.push(meta.extraArgs.filter((a): a is string => typeof a === 'string'));
  }
  return out;
}

/**
 * Distinct values previously used for one setting on this worker, newest first.
 * [] when the worker does not declare the setting, when nothing was ever
 * recorded, or on ANY read error.
 */
export async function readObservedTunableValues(
  worker: WorkerConfig | undefined,
  setting: string,
  opts: ObservedValuesOptions = {},
): Promise<string[]> {
  const spec = getTunableSpec(worker, setting);
  if (!spec) return [];
  try {
    const runs = await readRecentExtraArgs(worker?.name, opts);
    const seen: string[] = [];
    for (const args of runs) {
      for (const v of extractTunableValues(spec, args)) {
        if (!seen.includes(v)) seen.push(v);
      }
    }
    return seen;
  } catch {
    return [];
  }
}

/**
 * Same, for every setting the worker declares — one pass over the logs.
 * Returns a map keyed by normalized setting name; settings with no history map
 * to an empty array (never missing), so callers can render without guards.
 */
export async function readObservedTunableValuesForWorker(
  worker: WorkerConfig | undefined,
  opts: ObservedValuesOptions = {},
): Promise<Record<string, string[]>> {
  const settings = listTunables(worker);
  const out: Record<string, string[]> = {};
  for (const s of settings) out[normalizeTunableName(s)] = [];
  if (settings.length === 0) return out;

  try {
    const runs = await readRecentExtraArgs(worker?.name, opts);
    for (const setting of settings) {
      const spec = getTunableSpec(worker, setting);
      const key = normalizeTunableName(setting);
      for (const args of runs) {
        for (const v of extractTunableValues(spec, args)) {
          if (!out[key].includes(v)) out[key].push(v);
        }
      }
    }
  } catch {
    // fall through with whatever was collected (possibly nothing)
  }
  return out;
}
