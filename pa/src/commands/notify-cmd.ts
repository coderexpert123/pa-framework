import { readFile } from 'fs/promises';
import { notifyUser, getPaAlertsChatId } from '../lib/notify.js';
import { loadSecrets } from '../secrets.js';

/**
 * `pa notify` CLI — thin wrapper around notifyUser.
 *
 * Exit codes:
 *  0 — notifyUser returned (sent or suppressed)
 *  1 — unreachable (notifyUser never throws)
 *  2 — argument parse error
 */
export async function notifyCommand(args: string[] = process.argv.slice(2)): Promise<void> {
  // CLI invocations don't auto-load secrets.env (only the bot does at startup).
  // Load them into process.env now so PA_ALERTS_CHAT_ID, TELEGRAM_BOT_TOKEN,
  // etc. are available to notifyUser's lazy resolvers.
  const secrets = await loadSecrets();
  for (const [k, v] of Object.entries(secrets)) {
    if (!(k in process.env)) process.env[k] = v;
  }

  const subjectIdx = args.indexOf('--subject');
  const bodyIdx = args.indexOf('--body');
  const bodyFileIdx = args.indexOf('--body-file');
  const bodyStdinIdx = args.indexOf('--body-stdin');
  const dedupKeyIdx = args.indexOf('--dedup-key');
  const topicThreadIdx = args.indexOf('--topic-thread');
  const severityIdx = args.indexOf('--severity');

  if (subjectIdx === -1 || !args[subjectIdx + 1]) {
    console.error('Error: --subject <s> is required');
    process.exit(2);
  }

  const subject = args[subjectIdx + 1];
  const bodySources = [
    bodyIdx !== -1 ? 'arg' : null,
    bodyFileIdx !== -1 ? 'file' : null,
    bodyStdinIdx !== -1 ? 'stdin' : null,
  ].filter(Boolean);

  if (bodySources.length > 1) {
    console.error('Error: only one of --body, --body-file, --body-stdin may be specified');
    process.exit(2);
  }

  let body = '';
  if (bodyIdx !== -1) {
    body = args[bodyIdx + 1] ?? '';
  } else if (bodyFileIdx !== -1) {
    const filePath = args[bodyFileIdx + 1];
    if (!filePath) {
      console.error('Error: --body-file requires a path argument');
      process.exit(2);
    }
    body = await readFile(filePath, 'utf8');
  } else if (bodyStdinIdx !== -1) {
    body = await readStdin();
  } else {
    console.error('Error: one of --body, --body-file, --body-stdin is required');
    process.exit(2);
  }

  const dedupKey = dedupKeyIdx !== -1 ? args[dedupKeyIdx + 1] : undefined;
  const topicThread = topicThreadIdx !== -1 ? parseInt(args[topicThreadIdx + 1]!, 10) : undefined;
  const severity = severityIdx !== -1 ? args[severityIdx + 1] as 'info' | 'warn' | 'error' : undefined;

  if (severity && !['info', 'warn', 'error'].includes(severity)) {
    console.error('Error: --severity must be info, warn, or error');
    process.exit(2);
  }

  const result = await notifyUser(subject, body, {
    dedupKey,
    ...(topicThread !== undefined && !isNaN(topicThread)
      ? { topic: { chat_id: getPaAlertsChatId(), thread_id: topicThread } }
      : {}),
    severity,
  });

  if (result.sent) {
    console.log(`Alert sent.`);
  } else if (result.suppressed) {
    console.log(`Alert suppressed (dedup).`);
  } else {
    console.log(`Alert not sent (missing token or delivery failure).`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
