import { lookupRefId } from '../lib/ref-lookup.js';

export async function refCommand(refId: string | undefined): Promise<void> {
  if (!refId || !refId.trim()) {
    throw new Error('usage: pa ref <refId>');
  }

  const record = await lookupRefId(refId.trim());
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
  lines.push(`source:     ${record.source}`);
  lines.push('---');
  lines.push(record.text ?? '(no text recorded for this entry — likely a legacy log line that pre-dates refId text-preview logging)');

  console.log(lines.join('\n'));
}
