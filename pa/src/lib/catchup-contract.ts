/**
 * Strings and paths the catchup loop shares with the watchdog launchers that
 * `pa schedules sync` generates (catchup-lane-wedge wave, 2026-09-16): the lane
 * list and its check order, the lane progress breadcrumb, the store-stall
 * marker, the restart page's subject/first line/dedup key, the drill-wedge
 * file, the launcher script path and the stall exit code. One owner for every
 * value both sides must agree on. Imports nothing that logs or locks, and
 * nothing from commands/ or scheduler.ts, so both sides of the
 * scheduler <-> catchup import cycle may use it at module top level.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { paHome } from '../paths.js';

/** The loop's lanes, in the order the launchers check them. */
export const CATCHUP_LOOP_LANES: readonly string[] = ['default', 'reminders', 'maintenance'];

/** Exit code of a loop that stops itself after a store stall. 3 stays budget-exceeded. */
export const CATCHUP_STALL_EXIT_CODE = 4;

export const CATCHUP_LOOP_STALLED_DEDUP_KEY = 'catchup-loop-stalled';
export const CATCHUP_LOOP_PAGE_SUBJECT = 'Catchup loop restarted';
export const CATCHUP_LOOP_PAGE_FIRST_LINE = 'Catchup loop restarted by its watchdog.';
export const CATCHUP_LAUNCHER_UV_THREADPOOL_SIZE = 16;
export const BREADCRUMB_FIELD_MAX_CHARS = 120;

/** Stamps one lane's progress file; `detail` is optional. */
export type LaneProgressFn = (phase: string, detail?: string) => void;

export function catchupLanesDir(): string {
  return join(paHome(), 'catchup-lanes');
}

export function catchupLaneProgressPath(lane: string): string {
  return join(catchupLanesDir(), lane);
}

export function catchupStallMarkerPath(): string {
  return join(paHome(), 'catchup-loop.stalled');
}

export function catchupPageBodyPath(): string {
  return join(paHome(), 'catchup-loop-page.txt');
}

export function catchupDrillWedgePath(): string {
  return join(paHome(), 'catchup-drill-wedge');
}

export function catchupWatchdogScriptPath(): string {
  return join(paHome(), 'run-catchup-watchdog.sh');
}

/** Keeps breadcrumbs safe to embed in VBScript, shell and JSON without escaping. */
export function sanitizeBreadcrumbField(value: string | undefined): string {
  return (value ?? '').replace(/[^A-Za-z0-9 ._:\/@,+=-]/g, '_').slice(0, BREADCRUMB_FIELD_MAX_CHARS);
}

export function formatLaneBreadcrumb(isoTs: string, lane: string, phase: string, detail?: string): string {
  return `${isoTs}|${sanitizeBreadcrumbField(lane)}|${sanitizeBreadcrumbField(phase)}|${sanitizeBreadcrumbField(detail)}`;
}

export function formatStallMarker(store: string, target: string): string {
  const cleanTarget = sanitizeBreadcrumbField(target);
  return `store stall: ${sanitizeBreadcrumbField(store)}${cleanTarget ? ` (${cleanTarget})` : ''}`;
}

/** Synchronous by contract: must keep working when async fs in the process is stuck.
 *  Creates the lanes directory on first failure. Returns false instead of throwing. */
export function writeLaneProgress(lane: string, phase: string, detail?: string, now: Date = new Date()): boolean {
  const path = catchupLaneProgressPath(lane);
  const content = formatLaneBreadcrumb(now.toISOString(), lane, phase, detail);
  try {
    writeFileSync(path, content, 'utf8');
    return true;
  } catch {
    try {
      mkdirSync(catchupLanesDir(), { recursive: true });
      writeFileSync(path, content, 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}
