import {
  deliverBusMessage,
  resolveSessionBusAddress,
  listBusMessages,
  markBusRead,
  popBusMessage,
  peekBusMessage,
  touchBusCursor,
  readBusCursor,
  readBusRegistry,
  registerBusAddress,
  type BusEnvelope,
} from '../lib/bus-queue.js';
import type { ExecFn } from '../process-tree.js';

const POLL_INTERVAL_MS = 2000;
const DEFAULT_WAIT_TIMEOUT_S = 60;

const BUS_USAGE =
  'Usage: pa bus send <to> --from <addr> --body <text> [--reply-to <id>]\n' +
  '       pa bus inbox <address> [--peek | --consume] [--as <reader-addr>]\n' +
  '       pa bus list <address>\n' +
  '       pa bus wait <address> [--timeout <seconds>]\n' +
  '       pa bus register <address> --capabilities <csv> [--worker <name>]\n' +
  '       pa bus registry\n' +
  '       pa bus whoami [--provider <name>] [--repo <name>]\n' +
  'Protocol: pa/docs/bus.md';

const SEND_USAGE = 'Usage: pa bus send <to> --from <addr> --body <text> [--reply-to <id>]';
const INBOX_USAGE = 'Usage: pa bus inbox <address> [--peek | --consume] [--as <reader-addr>]';
const LIST_USAGE = 'Usage: pa bus list <address>';
const WAIT_USAGE = 'Usage: pa bus wait <address> [--timeout <seconds>]';
const REGISTER_USAGE = 'Usage: pa bus register <address> --capabilities <csv> [--worker <name>] [--session-id <id>] [--pid <n>]';
const WHOAMI_USAGE = 'Usage: pa bus whoami [--provider <name>] [--repo <name>] [--session-key <key>]';

function formatBody(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function printEnvelope(e: BusEnvelope): void {
  const receipts = e.readBy?.length ? `  read-by=${e.readBy.join(',')}` : '';
  console.log(`${e.id}  from=${e.from}  ${formatBody(e.body)}${e.consumed ? '  (consumed)' : ''}${receipts}`);
}

/**
 * `pa bus send <to> --from <addr> --body <text> [--reply-to <id>]`
 *
 * Prints the envelope id. A content-hash duplicate appends " (deduped)" —
 * the bus dedups on sha256(to|body|reply_to), so a retried send reports the
 * original id rather than minting a second envelope.
 */
async function busSend(args: string[]): Promise<number> {
  let to: string | undefined;
  let from: string | undefined;
  let body: string | undefined;
  let replyTo: string | undefined;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from') { from = args[++i]; continue; }
    if (arg === '--body') { body = args[++i]; continue; }
    if (arg === '--reply-to') { replyTo = args[++i]; continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    if (to === undefined) { to = arg; continue; }
  }

  if (unknownFlags.length > 0) {
    console.error(SEND_USAGE);
    console.error(`Unrecognized option(s): ${unknownFlags.join(', ')}`);
    return 1;
  }
  if (!to || !from || body === undefined) {
    console.error(SEND_USAGE);
    return 1;
  }

  // deliverBusMessage fans a bare provider@repo target out to every LIVE
  // discriminated child (<base>#<n> with a fresh cursor); with no live
  // children it queues at the base address for the drain's spawn arm —
  // reported so the sender knows the delivery mode (AI-255: senders must
  // learn whether a headed session got it or it's waiting for a spawn).
  const result = await deliverBusMessage({ from, to, body, reply_to: replyTo ?? null });
  if (result.delivered?.length) {
    console.log(`${result.id} → ${result.delivered.join(', ')}`);
  } else {
    const suffix = result.queuedForDrain ? ' (queued for drain — no live sessions)' : '';
    console.log(result.deduped ? `${result.id} (deduped)${suffix}` : `${result.id}${suffix}`);
  }
  return 0;
}

/**
 * `pa bus inbox <address> [--peek | --consume] [--as <reader-addr>]` —
 * read the next message for an address; touches the cursor. Prints the
 * envelope or '(empty)' when nothing is unread.
 *
 * Default is a SOFT read: the oldest envelope without the caller's address
 * in `readBy` is returned and the caller is added to its receipts — the
 * message stays queued for every other consumer and for the queue's owner
 * when the reader is foreign (accidental-read resilience). `--as` overrides
 * the reader identity (default: this session's resolved bus address).
 * `--peek` returns the oldest envelope without marking anything.
 * `--consume` is the legacy destructive pop — the envelope is removed.
 * The cursor is touched either way so the drain's liveness check sees the
 * inbox read.
 */
async function busInbox(args: string[], execFn?: ExecFn): Promise<number> {
  let address: string | undefined;
  let mode: 'read' | 'peek' | 'consume' = 'read';
  let reader: string | undefined;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--peek') { mode = 'peek'; continue; }
    if (arg === '--consume') { mode = 'consume'; continue; }
    if (arg === '--as') { reader = args[++i]; continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    if (address === undefined) { address = arg; continue; }
  }

  if (unknownFlags.length > 0) {
    console.error(INBOX_USAGE);
    console.error(`Unrecognized option(s): ${unknownFlags.join(', ')}`);
    return 1;
  }
  if (!address) {
    console.error(INBOX_USAGE);
    return 1;
  }

  let envelope: BusEnvelope | null;
  let alreadyRead = 0;
  if (mode === 'consume') {
    envelope = await popBusMessage(address);
  } else if (mode === 'peek') {
    envelope = await peekBusMessage(address);
  } else {
    const ident = await resolveSessionBusAddress({ execFn });
    reader = reader ?? ident.address;
    // AI-272 owner-stamp guard: a tool shell running `pa bus inbox <own-addr>`
    // resolves through the MSYS-shim exec boundary to a per-invocation address,
    // so its receipts never land on the address the hooks announce. When the
    // requested mailbox is REGISTERED to a pid that is this process's own host
    // or ancestor, the caller is demonstrably a descendant OF that session —
    // stamp the owner address so the session's reads count for itself. `--as`
    // stays the explicit override; a foreign (non-ancestor) mailbox stamps the
    // caller's own resolved identity.
    if (reader === ident.address) {
      const entry = (await readBusRegistry())[address];
      const ownerPid = typeof entry?.pid === 'number' ? entry.pid : undefined;
      if (ownerPid !== undefined && ownerPid !== ident.pid) {
        const { getAncestorPids } = await import('../process-tree.js');
        const ancestors = await getAncestorPids(process.ppid, execFn).catch(() => [] as number[]);
        if (ancestors.includes(ownerPid)) reader = address;
      } else if (ownerPid !== undefined && ownerPid === ident.pid) {
        reader = address;
      }
    }
    const envelopes = await listBusMessages(address);
    envelope = envelopes.find((e) => !(e.readBy ?? []).includes(reader!)) ?? null;
    alreadyRead = envelopes.length - (envelope ? 1 : 0);
    if (envelope) envelope = await markBusRead(address, envelope.id, reader);
  }
  await touchBusCursor(address, 'inbox', process.pid);
  if (!envelope) {
    console.log(alreadyRead > 0
      ? `(empty — ${alreadyRead} already read by you; 'pa bus list ${address}' shows all)`
      : '(empty)');
    return 0;
  }
  printEnvelope(envelope);
  const others = (envelope.readBy ?? []).filter((r) => r !== reader);
  if (mode === 'read' && others.length > 0) {
    console.log(`  also read by: ${others.join(', ')}`);
  }
  return 0;
}

/** `pa bus list <address>` — every queued envelope, oldest first (no consume). */
async function busList(args: string[]): Promise<number> {
  let address: string | undefined;
  const unknownFlags: string[] = [];

  for (const arg of args) {
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    if (address === undefined) { address = arg; continue; }
  }

  if (unknownFlags.length > 0) {
    console.error(LIST_USAGE);
    console.error(`Unrecognized option(s): ${unknownFlags.join(', ')}`);
    return 1;
  }
  if (!address) {
    console.error(LIST_USAGE);
    return 1;
  }

  const envelopes = await listBusMessages(address);
  if (envelopes.length === 0) {
    console.log('(empty)');
    return 0;
  }
  for (const e of envelopes) printEnvelope(e);
  return 0;
}

/**
 * `pa bus wait <address> [--timeout <seconds>]` — poll until an envelope
 * newer than the cursor's last_event_at arrives (default 60s). Non-destructive:
 * the message stays for `pa bus inbox`. Exit 1 on timeout. A non-numeric
 * --timeout behaves as if it were never given (same NaN-guard as
 * `pa claim --wait`). Uses the cursor's last_event_at to filter to messages
 * that arrived AFTER the last inbox/wait/spawn — not the never-set `consumed`
 * field.
 */
async function busWait(args: string[]): Promise<number> {
  let address: string | undefined;
  let timeoutSeconds: number | undefined;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--timeout') { timeoutSeconds = Number(args[++i]); continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    if (address === undefined) { address = arg; continue; }
  }

  if (unknownFlags.length > 0) {
    console.error(WAIT_USAGE);
    console.error(`Unrecognized option(s): ${unknownFlags.join(', ')}`);
    return 1;
  }
  if (!address) {
    console.error(WAIT_USAGE);
    return 1;
  }

  const timeout = timeoutSeconds !== undefined && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? timeoutSeconds
    : DEFAULT_WAIT_TIMEOUT_S;
  const deadline = Date.now() + timeout * 1000;
  const cursor = await readBusCursor(address);
  const sinceTs = cursor?.last_event_at ?? new Date(0).toISOString();

  for (;;) {
    const fresh = (await listBusMessages(address)).filter((e) => e.ts > sinceTs);
    if (fresh.length > 0) {
      for (const e of fresh) printEnvelope(e);
      return 0;
    }
    if (Date.now() >= deadline) {
      console.error(`pa bus wait: no message for ${address} within ${timeout}s`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** `pa bus register <address> --capabilities <csv>` */
async function busRegister(args: string[]): Promise<number> {
  let address: string | undefined;
  let capsCsv: string | undefined;
  let worker: string | undefined;
  let sessionId: string | undefined;
  let pid: number | undefined;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--capabilities') { capsCsv = args[++i]; continue; }
    if (arg === '--worker') { worker = args[++i]; continue; }
    if (arg === '--session-id') { sessionId = args[++i]; continue; }
    if (arg === '--pid') { pid = Number(args[++i]); continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
    if (address === undefined) { address = arg; continue; }
  }

  if (unknownFlags.length > 0) {
    console.error(REGISTER_USAGE);
    console.error(`Unrecognized option(s): ${unknownFlags.join(', ')}`);
    return 1;
  }
  if (!address || capsCsv === undefined) {
    console.error(REGISTER_USAGE);
    return 1;
  }

  const capabilities = capsCsv.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  const result = await registerBusAddress(address, {
    capabilities,
    worker,
    nativeSessionId: sessionId,
    pid: Number.isFinite(pid) ? pid : undefined,
  });
  console.log(
    result.discriminator !== undefined
      ? `Registered ${result.address} (discriminator #${result.discriminator})`
      : `Registered ${result.address}`
  );
  return 0;
}

/** `pa bus registry` — the address registry, one line per entry. */
async function busRegistry(): Promise<number> {
  const registry = await readBusRegistry();
  const entries = Object.entries(registry);
  if (entries.length === 0) {
    console.log('(none)');
    return 0;
  }
  for (const [address, entry] of entries) {
    const worker = entry.worker ? `  worker=${entry.worker}` : '';
    console.log(`${address}  capabilities=[${entry.capabilities.join(', ')}]${worker}`);
  }
  return 0;
}

/**
 * `pa bus whoami [--provider <name>] [--repo <name>] [--session-key <key>]`
 * — prints this session's bus address via resolveSessionBusAddress():
 * PA_BUS_ADDRESS pin → --session-key/PA_BUS_SESSION/PA_SESSION → registered
 * ancestor match → `base#<ppid>` per-invocation fallback. The registry match
 * is what makes a bare `pa bus whoami` in a session shell resolve to the
 * SAME address the session's hooks registered. Pass a stable --session-key
 * (e.g. the `pa claim --session` label) when the result must survive across
 * calls.
 */
async function busWhoami(args: string[], execFn?: ExecFn): Promise<number> {
  let provider: string | undefined;
  let repo: string | undefined;
  let sessionKey: string | undefined;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--provider') { provider = args[++i]; continue; }
    if (arg === '--repo') { repo = args[++i]; continue; }
    if (arg === '--session-key') { sessionKey = args[++i]; continue; }
    if (arg.startsWith('-')) { unknownFlags.push(arg); continue; }
  }

  if (unknownFlags.length > 0) {
    console.error(WHOAMI_USAGE);
    console.error(`Unrecognized option(s): ${unknownFlags.join(', ')}`);
    return 1;
  }

  const ident = await resolveSessionBusAddress({ provider, repo, sessionKey, execFn });
  console.log(ident.address);
  return 0;
}

/** `pa bus <send|inbox|list|wait|register|registry|whoami>` — agent-bus CLI.
 *  `opts.execFn` is a test seam forwarded into session-host resolution (the
 *  ancestor walk + termKey liveness snapshot) so tests can pose a canned
 *  process table without touching WMI. */
export async function busCommand(args: string[], opts?: { execFn?: ExecFn }): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === '--help' || sub === '-h') {
    console.log(BUS_USAGE);
    return 0;
  }
  if (sub === undefined) {
    console.error(BUS_USAGE);
    return 1;
  }

  try {
    switch (sub) {
      case 'send':
        return await busSend(rest);
      case 'inbox':
        return await busInbox(rest, opts?.execFn);
      case 'list':
        return await busList(rest);
      case 'wait':
        return await busWait(rest);
      case 'register':
        return await busRegister(rest);
      case 'registry':
        return await busRegistry();
      case 'whoami':
        return await busWhoami(rest, opts?.execFn);
      default:
        console.error(`Unknown bus subcommand: ${sub}`);
        console.error(BUS_USAGE);
        return 1;
    }
  } catch (err: any) {
    console.error(`pa bus ${sub}: ${err.message}`);
    return 1;
  }
}
