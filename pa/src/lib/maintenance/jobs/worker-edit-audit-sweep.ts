/**
 * Worker-edit-audit sweeper — closes dispatch edit-audit windows the bot
 * never closed (crash/restart mid-dispatch) and reports unreserved edits.
 * Design: the AI-175 worker-edit-enforcement spec (2026-09-01).
 *
 * A window whose bot PID is dead closes immediately; one whose PID still
 * looks alive closes once its age exceeds PA_WORKER_EDIT_WINDOW_MAX_MS (2h).
 * A false-alive PID (reuse) only delays the sweep — bounded lateness, never
 * a wrong action, unlike AI-174's fail-closed PID-reuse guard (spec C15).
 */
import { listOpenWindows, closeWindow, windowDir, type DispatchWindow, type CloseResult } from '../../worker-edit-audit.js';
import { areProcessesAlive } from '../../../process-tree.js';
import { log } from '../../log.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../types.js';

const DEFAULT_MAX_WINDOW_MS = 7_200_000; // 2h

function maxWindowMs(): number {
  const raw = Number(process.env.PA_WORKER_EDIT_WINDOW_MAX_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_WINDOW_MS;
}

/** Injectable dependencies for tests (the DI pattern the maintenance jobs use —
 *  ESM module namespaces are read-only, so callers override via deps, not mocks). */
export interface SweepDeps {
  listOpenWindowsFn?: () => Promise<DispatchWindow[]>;
  closeWindowFn?: (win: DispatchWindow, opts: { worker: string | null }) => Promise<CloseResult>;
  areProcessesAliveFn?: (pids: number[]) => Promise<Map<number, boolean>>;
  now?: number;
}

export async function runWorkerEditAuditSweep(deps: SweepDeps = {}): Promise<MaintenanceJobResult> {
  const listOpenWindowsDep = deps.listOpenWindowsFn ?? listOpenWindows;
  const closeWindowDep = deps.closeWindowFn ?? closeWindow;
  const areProcessesAliveDep = deps.areProcessesAliveFn ?? areProcessesAlive;
  const now = deps.now ?? Date.now();

  const windows = await listOpenWindowsDep();
  if (windows.length === 0) {
    return { touched: 0 };
  }

  // One OS query for the whole pass (process-tree snapshot invariant, spec C15).
  const uniquePids = [...new Set(windows.map((w) => w.botPid))];
  const aliveByPid = await areProcessesAliveDep(uniquePids);

  const maxAge = maxWindowMs();
  let closed = 0;
  let notified = 0;

  for (const win of windows) {
    const alive = aliveByPid.get(win.botPid) ?? false;
    const aged = now - win.startedAt > maxAge;
    if (alive && !aged) continue;

    try {
      const result = await closeWindowDep(win, { worker: null });
      closed++;
      if (result.notified) notified++;
    } catch (err) {
      // One bad window must not strand the rest — failure isolation is the
      // runner's contract, so log and continue rather than throw.
      log('warn', 'worker-edit-audit', 'sweep: closeWindow failed for one window; continuing', {
        windowId: win.id,
        resource: win.resource,
        error: String(err),
      });
    }
  }

  return { touched: closed, detail: { open: windows.length, closed, notified } };
}

export const workerEditAuditSweepJob: MaintenanceJob = {
  name: 'worker-edit-audit-sweep',
  host: 'pa',
  everyMs: 15 * 60 * 1000,
  description: "Closes dispatch edit-audit windows the bot never closed (crash/restart mid-dispatch) and reports unreserved edits.",
  destructive: true,
  shedWhenDegraded: true,
  targets: [{
    resolve: () => windowDir(),
    match: /^(w-[0-9a-f]{12}|alert-count)\.json$/,
    maxAgeMs: 24 * 60 * 60 * 1000,
    action: 'delete',
    ownership: 'pa-owned',
    evidence: 'PA writes these dispatch edit-audit windows and is their sole reader (AI-175, 2026-09-01); a window is deleted the moment it is reconciled, and this 24h target is the backstop for one the sweeper could not parse.',
    note: 'Selection is NOT plain mtime-vs-maxAgeMs: a window is normally closed as soon as its bot PID is dead, or after PA_WORKER_EDIT_WINDOW_MAX_MS (2h) while it is alive.',
  }],
  async run(ctx) { return runWorkerEditAuditSweep({ now: ctx.now }); },
};
