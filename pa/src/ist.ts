// Timezone utilities shared across pa and telegram-bot.
//
// Default = IST (UTC+5:30). Override via PA_TZ_OFFSET_MINUTES env var
// (e.g., PA_TZ_OFFSET_MINUTES=-480 for PST). All helpers call getTzOffsetMs()
// at invocation time so changing the env var takes effect on the next call.

/** @deprecated Use getTzOffsetMs() for env-aware behavior. Kept for any
 * external callers that imported the constant directly. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getTzOffsetMs(): number {
  const raw = process.env.PA_TZ_OFFSET_MINUTES;
  if (raw === undefined || raw === '') return IST_OFFSET_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return IST_OFFSET_MS;
  return minutes * 60 * 1000;
}

export function toIST(date: Date): Date {
  return new Date(date.getTime() + getTzOffsetMs());
}

export function todayIST(): string {
  // Returns YYYY-MM-DD in the configured timezone (default IST)
  const ist = toIST(new Date());
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function tzSuffix(): string {
  const offsetMin = getTzOffsetMs() / 60000;
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `${sign}${h}:${m}`;
}

export function nowIST(): string {
  // Returns ISO-8601 timestamp in configured timezone (default IST → +05:30)
  const ist = toIST(new Date());
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const min = String(ist.getUTCMinutes()).padStart(2, '0');
  const s = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}${tzSuffix()}`;
}

export function formatIST(date: Date): string {
  // Returns human-readable "YYYY-MM-DD HH:MM IST" (label remains "IST" for
  // backward-compatibility of log messages; the actual offset honors env var)
  const ist = toIST(date);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  const h = String(ist.getUTCHours()).padStart(2, '0');
  const min = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min} IST`;
}
