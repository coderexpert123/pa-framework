export interface SentinelData { mode: 'stop' | 'restart'; ts: number; }

export function parseSentinel(content: string): SentinelData {
  try {
    const obj = JSON.parse(content);
    if (obj.mode === 'stop' || obj.mode === 'restart') return { mode: obj.mode, ts: obj.ts ?? 0 };
  } catch {}
  // Legacy numeric payload (timestamp string) — treat as 'stop'.
  return { mode: 'stop', ts: parseInt(content.trim(), 10) || 0 };
}
