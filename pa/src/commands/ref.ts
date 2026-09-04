import { lookupRefId, lookupTrace, lookupTraceByUpdate, type TraceLine } from '../lib/ref-lookup.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_CAP = 10;

function formatDuration(ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms ?? 0);
  return `${(n / 1000).toFixed(1)}s`;
}

function formatToolsLine(toolCalls: Array<{ name?: unknown }>): string {
  const counts = new Map<string, number>();
  for (const tc of toolCalls) {
    const name = String(tc?.name ?? 'unknown');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const summary = sorted.map(([name, n]) => `${name}×${n}`).join(', ');
  return `tools:   ${toolCalls.length} (${summary})`;
}

function formatListSection(label: string, values: unknown[]): string[] {
  if (values.length === 0) return [];
  const lines = [`${label}:`];
  const shown = values.slice(0, LIST_CAP);
  for (const v of shown) lines.push(`  - ${v}`);
  if (values.length > LIST_CAP) lines.push(`  … +${values.length - LIST_CAP} more`);
  return lines;
}

/**
 * `--- trace (turn-traces.jsonl) ---` block, per
 * the 2026-08-24 recall-traces spec §3.1/A5. Header fields are
 * space-joined on one line; commands/files/errors render as `  - value`
 * lists capped at 10 entries; errors prints `(none)` when empty (the only
 * section that renders when empty — commands/files are omitted entirely).
 */
function renderTraceBlock(trace: TraceLine): string[] {
  const lines: string[] = ['--- trace (turn-traces.jsonl) ---'];

  const header: string[] = [];
  header.push(`outcome: ${trace.outcome}`);
  header.push(`worker: ${trace.worker}`);
  if (typeof trace.model === 'string' && trace.model) header.push(`model: ${trace.model}`);
  header.push(`duration: ${formatDuration(trace.duration_ms)}`);
  header.push(`exit: ${trace.exit_code}`);
  header.push(`parsed: ${trace.parsed}`);
  lines.push(header.join('  '));

  const toolCalls = Array.isArray(trace.tool_calls) ? (trace.tool_calls as Array<{ name?: unknown }>) : [];
  if (toolCalls.length > 0) lines.push(formatToolsLine(toolCalls));

  const commands = Array.isArray(trace.commands) ? trace.commands : [];
  lines.push(...formatListSection('commands', commands));

  const files = Array.isArray(trace.files) ? trace.files : [];
  lines.push(...formatListSection('files', files));

  const errors = Array.isArray(trace.errors) ? trace.errors : [];
  if (errors.length === 0) {
    lines.push('errors:  (none)');
  } else {
    lines.push(...formatListSection('errors', errors));
  }

  return lines;
}

export async function refCommand(refId: string | undefined): Promise<void> {
  if (!refId || !refId.trim()) {
    throw new Error('usage: pa ref <refId>');
  }
  const arg = refId.trim();

  // A bare uuid is a run_id, not a minted refId — look it up directly in the
  // trace sidecar before falling through to the refId path (D1.6/A5).
  if (UUID_RE.test(arg)) {
    const trace = await lookupTrace(arg);
    if (trace) {
      const lines = [`run_id:     ${arg}`, ...renderTraceBlock(trace)];
      console.log(lines.join('\n'));
      return;
    }
    // No hit — fall through so the error message below is unchanged.
  }

  const record = await lookupRefId(arg);
  if (!record) {
    throw new Error(
      'Ref not found within recent history (scanned last 10k entries of conversation-history.jsonl and app.log.jsonl).',
    );
  }

  const lines: string[] = [];
  lines.push(`refId:      ${record.refId}`);
  lines.push(`kind:       ${record.kind}`);
  lines.push(`timestamp:  ${record.timestamp}`);
  if (record.worker) lines.push(`worker:     ${record.worker}`);
  if (record.chatId !== undefined || record.threadId !== undefined) {
    lines.push(`chat/thread: ${record.chatId ?? '?'} / ${record.threadId ?? '?'}`);
  }
  if (record.messageId !== undefined) {
    lines.push(`message_id: ${record.messageId}`);
    // Generate a direct Telegram link for supergroup messages (chatId starts with -100)
    const chatStr = String(record.chatId ?? '');
    if (chatStr.startsWith('-100') && record.messageId) {
      const groupId = chatStr.slice(4); // strip leading "-100"
      lines.push(`telegram:   https://t.me/c/${groupId}/${record.messageId}`);
    }
  }
  if (record.sessionId) lines.push(`session_id: ${record.sessionId}`);
  if (record.runId) lines.push(`run_id:     ${record.runId}`);
  lines.push(`source:     ${record.source}`);
  lines.push('---');
  lines.push(record.text ?? '(no text recorded for this entry — likely a legacy log line that pre-dates refId text-preview logging)');

  // Resolve the sidecar trace: by run_id when the archive row carries one
  // (not the normal bot case — C24), else by the bot-origin (thread_id,
  // update_id) join key when both are present. Never errors — either lookup
  // resolves null on any failure.
  const trace = record.runId
    ? await lookupTrace(record.runId)
    : (record.threadId !== undefined && record.updateId !== undefined
        ? await lookupTraceByUpdate(record.threadId, record.updateId)
        : null);

  if (trace) {
    lines.push('');
    if (!record.runId && typeof trace.run_id === 'string') {
      lines.push(`run_id:     ${trace.run_id}`);
    }
    lines.push(...renderTraceBlock(trace));
  }

  console.log(lines.join('\n'));
}
