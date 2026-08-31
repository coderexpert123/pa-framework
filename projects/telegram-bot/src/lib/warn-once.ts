/**
 * warnOnce — emit a given warning at most once per process for each key.
 * Outage fix 2026-08-28 (integrator): the thread-310 button-ack wave imports
 * this module but had not created it yet, which crash-blocked the bot build
 * and the live restart. Semantics follow the name; if the owning wave lands a
 * richer implementation, theirs wins — keep the export signature compatible.
 */

const warned = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[warn-once] ${message}`);
}
