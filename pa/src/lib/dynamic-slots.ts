/**
 * Dynamic worker-slot governor, simplified (2026-09-11). The whole module in
 * one sentence: run up to the ceiling; if the machine is visibly struggling,
 * cut the pool by a quarter per pressured minute; once it has been clean for
 * two minutes, climb back.
 *
 * The ceiling derives from cores when PA_MAX_CONCURRENT_WORKERS is unset
 * (resolveCeiling below); PA_DYNAMIC_SLOTS=0 is the bit-for-bit legacy kill
 * switch — the static ceiling passes through untouched, no sampling, no
 * cuts, no state touched. There is NO memory-headroom sizing gate: free
 * physical memory is only one of three pressure INPUTS (alongside CPU and
 * disk-queue length), never a capacity formula, which is how pagefile
 * capacity is counted by construction. ZERO timers of any kind.
 */

import { readPressureSampleCached, type PressureSample } from './pressure-sample.js';
import { cpus } from 'os';
import { logger } from './log.js';

const LOG_MIN_INTERVAL_MS = 60000; // log rate limit: >=60s between change logs

const DEFAULT_SLOTS_MIN = 3;
export const DEFAULT_PHYSICAL_BRAKE_MB = 400;
export const DEFAULT_CPU_BRAKE_PCT = 90;
export const DEFAULT_DISK_QUEUE_BRAKE = 8;
const CUT_DIVISOR = 4;          // a quarter, constant (S4)
const RECOVERY_SAMPLES = 2;     // two clean samples, constant (S4)
const LEGACY_STATIC_CEILING = 3;
const DERIVED_CEILING_MIN = 4;
const DERIVED_CEILING_MAX = 64;
const DERIVED_CEILING_PER_CORE = 4;

export type CeilingOrigin = 'env' | 'derived' | 'legacy';

// Injected deps — production defaults; tests override via _setDepsForTest.
let clock: () => number = Date.now;
let log: (msg: string) => void = (msg) => logger.info('worker-exec', msg);
let readSample: () => PressureSample | null = readPressureSampleCached;
let cpuCount: () => number = () => cpus().length;

// Module-scope state.
let currentEffective: number | null = null;
let episodeActive = false;
let lastCut: number | null = null;
let cleanCount = 0;
let lastEvaluatedSampleMs: number | null = null;
let lastLoggedEffective: number | null = null;
let lastLogMs = 0;

// Numeric knob reader mirroring workerSlotCount's Number.isFinite idiom:
// any non-finite or <= 0 value falls back to its default.
function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Zero-meaningful knob reader: unlike envInt, 0 is a VALUE -- it disables
// that pressure input (S3) -- so the accept test is >= 0, not > 0.
function envIntZeroOk(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveCeiling(): { ceiling: number; origin: CeilingOrigin } {
  const raw = process.env.PA_MAX_CONCURRENT_WORKERS;
  const n = parseInt(raw ?? '', 10);
  // An explicit operator number always wins, including <= 0 which means disabled.
  if (raw !== undefined && raw !== '' && Number.isFinite(n)) return { ceiling: n, origin: 'env' };
  // Unset or garbage. The kill switch means EXACTLY the old behavior, so the
  // derived ceiling applies only on the dynamic path.
  if (process.env.PA_DYNAMIC_SLOTS === '0') return { ceiling: LEGACY_STATIC_CEILING, origin: 'legacy' };
  const derived = Math.min(
    DERIVED_CEILING_MAX,
    Math.max(DERIVED_CEILING_MIN, cpuCount() * DERIVED_CEILING_PER_CORE),
  );
  return { ceiling: derived, origin: 'derived' };
}

function isPressured(s: PressureSample): boolean {
  const brakeMb  = envIntZeroOk('PA_SLOTS_PHYSICAL_BRAKE_MB', DEFAULT_PHYSICAL_BRAKE_MB);
  const cpuBrake = envIntZeroOk('PA_SLOTS_CPU_BRAKE_PCT', DEFAULT_CPU_BRAKE_PCT);
  const dqBrake  = envIntZeroOk('PA_SLOTS_DISK_QUEUE_BRAKE', DEFAULT_DISK_QUEUE_BRAKE);
  return (brakeMb  > 0 && s.physFreeMb !== null && s.physFreeMb <  brakeMb)
      || (cpuBrake > 0 && s.cpuPct     !== null && s.cpuPct     >= cpuBrake)
      || (dqBrake  > 0 && s.diskQueue  !== null && s.diskQueue  >= dqBrake);
}

function pressuredSuffix(sample: PressureSample): string {
  const p = sample.physFreeMb !== null ? String(sample.physFreeMb) : 'n/a';
  const cpuText = sample.cpuPct !== null ? `${sample.cpuPct}%` : 'n/a';
  const dqText = sample.diskQueue !== null ? String(sample.diskQueue) : 'n/a';
  return `pressured: physFreeMB ${p}, cpu ${cpuText}, diskQ ${dqText}`;
}

// First emitted line always logs (seeding lastLoggedEffective); afterwards
// only when the effective changed AND at least LOG_MIN_INTERVAL_MS passed
// since the last log line.
function maybeLog(effective: number, ceiling: number, suffix: string, now: number): void {
  if (lastLoggedEffective !== null) {
    if (effective === lastLoggedEffective) return;
    if (now - lastLogMs < LOG_MIN_INTERVAL_MS) return;
  }
  lastLoggedEffective = effective;
  lastLogMs = now;
  log(`dynamic-slots: effective ${effective}/${ceiling} (${suffix})`);
}

export function effectiveSlotCount(ceiling: number, origin: CeilingOrigin = 'env'): number {
  if (process.env.PA_DYNAMIC_SLOTS === '0') return ceiling; // kill switch: no sampling, no state touch
  if (ceiling <= 0) return ceiling;                          // disabled passthrough
  const now = clock();
  const floor = Math.min(envInt('PA_SLOTS_MIN', DEFAULT_SLOTS_MIN), ceiling);

  // No episode in progress means the pool sits at the ceiling (S4 line 1).
  let effective = episodeActive ? (currentEffective ?? ceiling) : ceiling;

  const sample = readSample();
  if (sample !== null && sample.sampledAtMs !== lastEvaluatedSampleMs) {
    lastEvaluatedSampleMs = sample.sampledAtMs;                        // A1: once per sample
    if (isPressured(sample)) {
      const from = effective;
      cleanCount = 0;
      episodeActive = true;
      lastCut = from;                                                  // A4
      effective = Math.max(floor, from - Math.max(1, Math.ceil(from / CUT_DIVISOR)));
      maybeLog(effective, ceiling, pressuredSuffix(sample), now);
    } else if (episodeActive) {
      cleanCount += 1;
      if (cleanCount === RECOVERY_SAMPLES) {
        effective = Math.max(floor, (lastCut ?? ceiling) - 1);         // S4: back to lastCut - 1
      } else if (cleanCount > RECOVERY_SAMPLES) {
        effective = effective + Math.max(1, Math.ceil(effective / CUT_DIVISOR));
      }
      if (cleanCount >= RECOVERY_SAMPLES) {
        if (effective >= ceiling) {
          effective = ceiling;
          episodeActive = false;
          lastCut = null;
          cleanCount = 0;
          maybeLog(effective, ceiling, 'clear', now);
        } else {
          maybeLog(effective, ceiling, 'recovering', now);
        }
      }
    }
  }

  effective = Math.max(floor, Math.min(ceiling, effective));
  currentEffective = effective;
  return effective;
}

/**
 * Quota-burst shed (operator ruling 2026-09-13): a burst-shaped 429
 * ('quota-per-minute', recorded by rate-limits.ts) is evidence the fleet is
 * over-running the provider's per-request rate, so capacity is cut — one
 * quarter of the CURRENT pool per burst event, same shape as a pressured
 * sample. Stated-end-time quota events never call this: waiting out a stated
 * reset is the correct response, not shedding. The burst event is
 * sample-independent (it fires between sampler ticks), so it drives the same
 * episode state directly; recovery is then the existing rule — two clean
 * samples return the pool to lastCut - 1 and each further clean sample
 * climbs a quarter. Floor: the existing PA_SLOTS_MIN floor (default 3),
 * never below 2. No-op under the kill switch or a disabled (<= 0) ceiling.
 */
export function noteQuotaBurst(): void {
  if (process.env.PA_DYNAMIC_SLOTS === '0') return;
  const { ceiling } = resolveCeiling();
  if (ceiling <= 0) return;
  const burstFloor = Math.max(2, Math.min(envInt('PA_SLOTS_MIN', DEFAULT_SLOTS_MIN), ceiling));
  const from = episodeActive ? (currentEffective ?? ceiling) : ceiling;
  cleanCount = 0;
  episodeActive = true;
  lastCut = from;
  const effective = Math.max(burstFloor, from - Math.max(1, Math.ceil(from / CUT_DIVISOR)));
  currentEffective = effective;
  maybeLog(effective, ceiling, 'quota-burst', clock());
}

export function _setDepsForTest(deps: { clock?: () => number; log?: (msg: string) => void; readSample?: () => PressureSample | null; cpuCount?: () => number }): void {
  if (deps.clock !== undefined) clock = deps.clock;
  if (deps.log !== undefined) log = deps.log;
  if (deps.readSample !== undefined) readSample = deps.readSample;
  if (deps.cpuCount !== undefined) cpuCount = deps.cpuCount;
}

export function _governorForTest(): { episodeActive: boolean; lastCut: number | null; cleanCount: number; currentEffective: number | null } {
  return { episodeActive, lastCut, cleanCount, currentEffective };
}

export function _resetForTest(): void {
  clock = Date.now;
  log = (msg) => logger.info('worker-exec', msg);
  readSample = readPressureSampleCached;
  cpuCount = () => cpus().length;
  currentEffective = null;
  episodeActive = false;
  lastCut = null;
  cleanCount = 0;
  lastEvaluatedSampleMs = null;
  lastLoggedEffective = null;
  lastLogMs = 0;
}
