/**
 * PA's WingmanPlugin implementation for jev-browser-wingman (WP-P1).
 *
 * Wires PA's own Jev client (askSystemOne), the browser-session blackboard
 * lock, and PA's structured logger into the shape jev-browser-wingman's
 * `plugin` config value expects (`P/src/contract/types.ts` WingmanPlugin).
 * PA code never imports the package at runtime (§ 3.16) — this module only
 * exports values the package loads by path from the machine-local config.
 */

import { askSystemOne } from './typesafe-client.js';
import { blackboard } from '../blackboard.js';
import { log } from './log.js';

export const WINGMAN_BROWSER_LOCK = 'skill-exclusive:browser-session';
export const WINGMAN_LOCK_CONTEXT_ENV = 'PA_BROWSER_SESSION_LOCK_CONTEXT';

type LockCheckResult = { ok: true } | { ok: false; reason: 'lock-held' };

let wingmanLogOverride: typeof log | null = null;

/** Test seam: routes wingmanLog through a fake instead of PA's real log().
 *  `null` restores PA's log. */
export function _setWingmanLogForTest(fn: typeof log | null): void {
  wingmanLogOverride = fn;
}

export async function wingmanLockCheck(
  env: NodeJS.ProcessEnv = process.env,
  getLocks: () => Promise<Array<{ resource: string; contextId?: string }>> = () => blackboard.getActiveLocks(),
): Promise<LockCheckResult> {
  try {
    const locks = await getLocks();
    const row = locks.find((l) => l.resource === WINGMAN_BROWSER_LOCK);
    if (!row) return { ok: true };
    const ourContext = env[WINGMAN_LOCK_CONTEXT_ENV];
    if (ourContext && row.contextId === ourContext) return { ok: true };
    return { ok: false, reason: 'lock-held' };
  } catch {
    // Fail closed, as browser-launcher.ts:346-354 does for the same lock.
    return { ok: false, reason: 'lock-held' };
  }
}

export function wingmanLog(record: object): void {
  const fn = wingmanLogOverride ?? log;
  fn('info', 'jev-browser-wingman', 'wingman call', record as Record<string, unknown>);
}

export const wingmanPlugin = {
  name: 'pa',
  ask: askSystemOne,
  lockCheck: () => wingmanLockCheck(),
  log: wingmanLog,
};
