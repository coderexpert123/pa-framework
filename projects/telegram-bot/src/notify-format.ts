import type { FailoverNotifyPayload } from '../../../pa/dist/src/types.js';
import { formatIST } from '../../../pa/dist/src/ist.js';

/**
 * Escape Telegram markdown special chars in user-controlled strings
 * (worker names, error text, etc.) before interpolation.
 */
export function escapeMd(s: string): string {
  // Escape formatting markers that sanitizeMdV2 intentionally does NOT escape.
  // [ ] ( ) . ! - etc. are handled by sanitizeMdV2 step 3 — do NOT pre-escape them
  // here, or they'll be double-escaped when the output flows through sendMessage.
  return s.replace(/[_*`~]/g, (c) => `\\${c}`);
}

/**
 * Format a failover notification payload as a Telegram markdown message.
 * Four variants: rate-limit (classified), unavailable, failure, proactive-warning.
 */
export function formatFailoverMessage(payload: FailoverNotifyPayload): string {
  const from = escapeMd(payload.from);
  const to = payload.to ? escapeMd(payload.to) : 'next available worker';

  if (payload.kind === 'rate-limit') {
    const cls = payload.classification ?? 'unknown';
    const header = `📡 _*${from}* rate limited (${escapeMd(cls)})_ — switching to _*${to}*_`;
    const lines: string[] = [header];
    if (payload.minutes !== undefined) {
      const resetsAt = payload.resetsAtIST
        ?? formatIST(new Date(Date.now() + payload.minutes * 60_000));
      const note = cls === 'unknown' ? ' (duration unparseable, default)' : '';
      lines.push(`⏱ Cooldown: ${payload.minutes} min${note}, resumes ~${escapeMd(resetsAt)}`);
    } else if (payload.resetsAtIST) {
      lines.push(`⏱ Resumes ~${escapeMd(payload.resetsAtIST)}`);
    }
    if (payload.source) {
      lines.push(`🔎 Source: ${escapeMd(payload.source)} — ${escapeMd(payload.reasonText)}`);
    }
    if (payload.raw && (payload.classification === 'unknown' || payload.minutes === undefined || !payload.resetsAtIST)) {
      const safeRaw = payload.raw.slice(0, 500).replace(/```/g, "'''");
      lines.push('```');
      lines.push(safeRaw);
      lines.push('```');
    }
    return lines.join('\n');
  }

  if (payload.kind === 'unavailable') {
    return `📡 _*${from}* unavailable_ — switching to _*${to}*_\n🔎 ${escapeMd(payload.reasonText)}`;
  }

  if (payload.kind === 'failure') {
    return `📡 _*${from}* failed_ — switching to _*${to}*_\n🔎 ${escapeMd(payload.reasonText)}`;
  }

  return `📡 _*${from}*_ — ${escapeMd(payload.reasonText)}`;
}
