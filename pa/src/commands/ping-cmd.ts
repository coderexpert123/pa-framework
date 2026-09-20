import { readFile, unlink } from 'fs/promises';
import { notifyAttention } from '../lib/attention.js';

/**
 * `pa ping` — fire the attention channel (Windows toast + operator private-chat
 * mirror) for one "action needed" / "response ready" event. RETIRED to opt-in
 * (2026-09-11, vi-08b2360d27b3): the channel no-ops unless
 * PA_ATTENTION_ENABLED=1 — otherwise both legs honestly report `disabled`
 * on stdout; the operator-facing channel is now the web app's own browser
 * notifications. The call is kept so a deliberate re-enable pages here too.
 * The worker-side finish lines (task_complete.py, task_input.py) and any skill
 * can call it; args are read from --payload-file (JSON, the injection-proof
 * path for model-authored copy) or inline --title/--body.
 *
 * Exit codes:
 *  0 — invoked correctly (even when a leg is disabled or fails; the JSON
 *      outcome on stdout carries the honest per-leg result)
 *  2 — argument parse error
 */
export async function pingCommand(args: string[] = process.argv.slice(2)): Promise<void> {
  const titleIdx = args.indexOf('--title');
  const bodyIdx = args.indexOf('--body');
  const payloadIdx = args.indexOf('--payload-file');
  const noToast = args.includes('--no-toast');
  const noPing = args.includes('--no-ping');
  const noWebPush = args.includes('--no-webpush');
  const cleanup = args.includes('--cleanup');

  let title = '';
  let body = '';
  if (payloadIdx !== -1) {
    const payloadPath = args[payloadIdx + 1];
    if (!payloadPath) {
      console.error('Error: --payload-file requires a path argument');
      process.exitCode = 2;
      return;
    }
    try {
      const parsed = JSON.parse(await readFile(payloadPath, 'utf8')) as {
        title?: unknown; body?: unknown;
      };
      if (typeof parsed.title === 'string') title = parsed.title;
      if (typeof parsed.body === 'string') body = parsed.body;
    } catch (err: any) {
      console.error(`Error: cannot read --payload-file ${payloadPath}: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    if (cleanup) {
      await unlink(payloadPath).catch(() => {});
    }
  } else if (titleIdx !== -1) {
    title = args[titleIdx + 1] ?? '';
    if (bodyIdx !== -1) body = args[bodyIdx + 1] ?? '';
  } else {
    console.error('Usage: pa ping --title <t> [--body <b>] | --payload-file <path.json> [--cleanup] [--no-toast] [--no-ping] [--no-webpush]');
    process.exitCode = 2;
    return;
  }

  if (!title.trim()) {
    console.error('Error: --title (or payload.title) must not be empty');
    process.exitCode = 2;
    return;
  }

  const result = await notifyAttention(title, body, {
    toast: !noToast,
    ping: !noPing,
    webPush: !noWebPush,
  });
  console.log(JSON.stringify(result));
}
