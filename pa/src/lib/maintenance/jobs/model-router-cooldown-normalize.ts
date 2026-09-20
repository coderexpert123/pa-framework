/**
 * model-router-cooldown-normalize — daily housekeeping for the model-router wave.
 *
 * Two duties, one declared job (AI-100):
 *  1. Cooldown normalize — rate-limit entries whose cooldown has been over for
 *     24h+ (i.e. expired a full day ago) are stale residue. Self-healing
 *     classifications are cleared so the state file does not accumulate dead
 *     entries. Terminal faults ('account-exhausted') are NEVER cleared here —
 *     only a successful dispatch may override those (rate-limits.ts). Entries
 *     with classification 'unknown' are recorded as unknown and left exactly
 *     as they are — never rewritten to zero/available (model-router decision 5:
 *     the job records, it never probes).
 *  2. Shadow + telemetry prune — both model-router JSONL files (the shadow
 *     would-have-chosen routing lines and the per-dispatch worker telemetry
 *     lines) age out at 90 days, per-line, atomically. Same retention, same
 *     mechanism: the telemetry file grows one line per successful stream-json
 *     dispatch, so without a target it is unbounded (the wave shipped the
 *     shadow target and missed this one; deep-recheck 2026-09-19).
 *
 * All cooldown writes go through the rate-limits module's own exported
 * helpers (getCooldownStatus / clearWorkerCooldown), which carry the
 * bounded queue + cross-process file lock — this job is NOT a second
 * independent writer to rate-limit-state.json.
 */
import { readFile, rename, stat, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import { clearWorkerCooldown, getCooldownStatus } from '../../../rate-limits.js';
import type { MaintenanceJob, MaintenanceJobContext, MaintenanceJobResult } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHADOW_RETENTION_MS = 90 * DAY_MS;
/** A cooldown this far past its own end is stale residue, not a live cooldown. */
const STALE_COOLDOWN_AFTER_MS = DAY_MS;

/** Terminal (non-self-healing) classifications the job must never clear. */
const TERMINAL_CLASSIFICATIONS = new Set(['account-exhausted']);

export const modelRouterCooldownNormalizeJob: MaintenanceJob = {
  name: 'model-router-cooldown-normalize',
  host: 'pa',
  everyMs: DAY_MS,
  description:
    'Daily: clear rate-limit cooldowns that expired >24h ago for self-healing classifications (terminal faults and unknown-class entries are recorded, never cleared), and prune model-router shadow + telemetry JSONL lines older than 90 days.',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: () => join(paHome(), 'model-router-shadow.jsonl'),
      match: /model-router-shadow\.jsonl$/,
      maxAgeMs: SHADOW_RETENTION_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: 'shadow JSONL retention, model-router wave 2026-09-18 (AI-100)',
      note: 'Selection is PER-LINE inside the shadow file: lines whose `at` is older than 90d are dropped and the file is rewritten atomically (tmp+rename). The file-level dry-run preview (by mtime) therefore understates what is removed.',
    },
    {
      resolve: () => join(paHome(), 'model-router-telemetry.jsonl'),
      match: /model-router-telemetry\.jsonl$/,
      maxAgeMs: SHADOW_RETENTION_MS,
      action: 'delete',
      ownership: 'pa-owned',
      evidence: 'worker telemetry JSONL retention, model-router wave 2026-09-18 (AI-100; telemetry target added by the 2026-09-19 deep-recheck — the writer shipped with no retention)',
      note: 'Same per-line atomic rewrite as the shadow target: telemetry lines whose `at` is older than 90d are dropped.',
    },
  ],
  async run(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
    const normalized = await normalizeCooldowns(ctx);
    const prunedShadow = await pruneJsonlLines(join(paHome(), 'model-router-shadow.jsonl'), ctx);
    const prunedTelemetry = await pruneJsonlLines(join(paHome(), 'model-router-telemetry.jsonl'), ctx);
    return {
      touched: normalized.touched + prunedShadow.touched + prunedTelemetry.touched,
      detail: { cooldowns: normalized.detail, shadow: prunedShadow.detail, telemetry: prunedTelemetry.detail },
    };
  },
};

/** Duty 1 — see the header comment. Uses ONLY rate-limits' own lock path. */
async function normalizeCooldowns(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
  let status: Record<string, { cooldown_until: string; classification?: string }>;
  try {
    status = (await getCooldownStatus()) as typeof status;
  } catch {
    return { touched: 0, detail: { error: 'cooldown state unreadable' } };
  }
  const cleared: string[] = [];
  const keptUnknown: string[] = [];
  const keptTerminal: string[] = [];
  for (const [worker, entry] of Object.entries(status)) {
    let untilMs: number;
    try {
      untilMs = new Date(entry.cooldown_until).getTime();
    } catch {
      continue; // unparseable timestamp — fail closed, leave in place
    }
    if (Number.isNaN(untilMs)) continue;
    if (untilMs > ctx.now - STALE_COOLDOWN_AFTER_MS) continue; // not stale yet
    const classification = entry.classification;
    if (classification != null && TERMINAL_CLASSIFICATIONS.has(classification)) {
      keptTerminal.push(worker); // only a successful dispatch overrides these
      continue;
    }
    if (classification === 'unknown') {
      keptUnknown.push(worker); // decision 5: recorded as unknown, never rewritten
      continue;
    }
    // Unclassified entries are treated as self-healing (they are ordinary
    // cooldowns without a recorded class) — same as classified self-healing.
    try {
      if (await clearWorkerCooldown(worker)) cleared.push(worker);
    } catch {
      // lock contention or write failure — leave the entry; next pass retries
    }
  }
  return {
    touched: cleared.length,
    detail: {
      cleared: cleared.sort(),
      kept_unknown: keptUnknown.sort(),
      kept_terminal: keptTerminal.sort(),
    },
  };
}

/** Duty 2 — drop JSONL lines whose `at` is older than 90d, atomically. Shared
 *  by the shadow and telemetry files (same `at`-keyed schema, same retention). */
async function pruneJsonlLines(path: string, ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { touched: 0 }; // no file yet — nothing to prune
  }
  const lines = raw.split('\n');
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (line === '') continue; // preserve-structure: rejoin adds the trailing newline
    let drop = false;
    try {
      const parsed = JSON.parse(line) as { at?: string };
      if (typeof parsed.at === 'string') {
        const atMs = new Date(parsed.at).getTime();
        if (!Number.isNaN(atMs) && atMs < ctx.now - SHADOW_RETENTION_MS) drop = true;
      }
    } catch {
      // unparseable line — fail closed, keep it
    }
    if (drop) dropped++;
    else kept.push(line);
  }
  if (dropped === 0) return { touched: 0, detail: { dropped: 0 } };
  // Atomic rewrite, unique per-write tmp name (rate-limits saveState idiom —
  // a fixed tmp path races concurrent writers on Windows).
  const tmp = `${path}.${process.pid.toString(36)}-${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
  await rename(tmp, path);
  try {
    await stat(path); // read-back verify the rename landed
  } catch {
    return { touched: dropped, detail: { dropped, verify: 'rename-target-missing' } };
  }
  return { touched: dropped, detail: { dropped } };
}
