/**
 * `pa auth request|wait|answer|learn` (auth broker Phase A, 2026-09-10 build
 * spec §3.8) — the CLI a worker (or a human, via the bot / interactive
 * shell) uses when a tool needs a URL opened, a code typed, a key supplied,
 * or a yes/no it cannot answer itself: `pa auth request` mints the widget
 * (§3.1 shape → kind mapping, `../lib/auth/shapes.js`), `pa auth wait` polls
 * for the answer, `pa auth answer` lets the bot/interactive-shell path
 * deliver a value, and `pa auth learn` records a provider profile for later
 * reuse (`../lib/auth/profiles.js`).
 *
 * This file never writes `secrets.env` (C14) and never prints an answered
 * SECRET value — only its pointer. It reaches the voice-inbox ledger
 * through the D10 dynamic-import seam (`../lib/auth/ledger-bridge.js`); the
 * broker's own short-lived state (§3.3) lives in `../lib/auth/store.js`.
 *
 * Exit codes, identical to `watch.ts`'s documented contract: 0 success · 2
 * usage/argument error · 3 rejected by a validator, the store, or a missing
 * precondition · 4 `wait` timed out or the request expired.
 *
 * Judgment calls made here that the spec's ordered edit list (D-E6) did not
 * pin — flagged for the dispatcher to overrule:
 *   (1) `--prompt` is documented as optional with no stated default text;
 *       when absent, a generic per-shape sentence is used
 *       (`defaultPromptForShape`).
 *   (2) `--url` has no destination in any frozen contract (not a key of
 *       `OauthParams`, not a field of the §3.3 broker row) — an S2 "display"
 *       request (D6: the caller already ran its own device-flow exchange)
 *       needs *some* way to carry the URL it wants shown. This mirrors the
 *       existing precedent at `oauth-mint.ts:211-213` ("the backend writes
 *       [auth_url] into params_json AFTER validation"): when `--url` is
 *       given, it is merged into the just-created request's `params_json`
 *       as `auth_url` via a direct SQL UPDATE, the same statement shape
 *       `oauth-mint.ts`'s `updateParams` uses.
 *   (3) `pa auth wait`'s "never reads the answer file's contents" is
 *       enforced literally only for the `secret` kind (the one C7(a)
 *       protects) — the required JSON shape for `choice` needs the chosen
 *       option's text and for `confirm` needs the boolean, neither of which
 *       is sensitive, so those two kinds' pointer files ARE read to build
 *       the answer. `oauth`'s `approved` is always `true` when answered (the
 *       validator rejects any other value), so no file read is needed there.
 */

import { readFileSync } from 'node:fs';
import { AUTH_SHAPES, SHAPE_DEFAULT_EXPIRY_SECONDS, widgetForShape, type AuthShape } from '../lib/auth/shapes.js';
import { readRow, readStanding, writeRow, writeStanding, markDelivered, type AuthRequestRow } from '../lib/auth/store.js';
import { upsertProfile, type AuthProfile } from '../lib/auth/profiles.js';
import { loadVoiceInboxModules as defaultLoadVoiceInboxModules, type VoiceInboxLedgerModules } from '../lib/auth/ledger-bridge.js';
import { repoRootFromModule } from '../lib/git-root.js';
import { resolveNotifyTopic } from '../lib/notify.js';
import { notifyAttention } from '../lib/attention.js';

const USAGE = `Usage:
  pa auth request --shape S1|S2|S3|S4|S5 --provider <name> [--prompt <text>]
                  [--url <https url>] [--code <user code>] [--option <label>]...
                  [--task <vi-id>] [--tenant <t-id>] [--expires <seconds>]
                  [--confirmable] [--json]
  pa auth wait <request-id> [--timeout <seconds>] [--json]
  pa auth answer --request <request-id> [--tenant <t-id>]      # value on stdin, never argv
  pa auth learn --provider <name> --shape S1..S5 --command <text>
                [--env <VAR>] [--credential-path <path>] [--expires-days <n>] [--notes <text>]`;

const REQUEST_FLAGS = new Set([
  '--shape',
  '--provider',
  '--prompt',
  '--url',
  '--code',
  '--option',
  '--task',
  '--tenant',
  '--expires',
  '--confirmable',
  '--json',
]);
const WAIT_FLAGS = new Set(['--timeout', '--json']);
const ANSWER_FLAGS = new Set(['--request', '--tenant']);
const LEARN_FLAGS = new Set([
  '--provider',
  '--shape',
  '--command',
  '--env',
  '--credential-path',
  '--expires-days',
  '--notes',
]);

interface ParsedFlags {
  values: Record<string, string>;
  positionals: string[];
  unknown: string[];
}

/** Copied verbatim from `pa/src/commands/watch.ts:50-69` (D-E5). */
function parseFlags(args: string[], known: Set<string>): ParsedFlags {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (!known.has(arg)) {
        unknown.push(arg);
        continue;
      }
      values[arg] = args[++i];
      continue;
    }
    positionals.push(arg);
  }

  return { values, positionals, unknown };
}

/** `--option <label>` is the one repeatable flag (§3.8: `[--option <label>]...`) —
 * `parseFlags` above keeps only the last occurrence of any flag, so a
 * repeatable one is collected separately, straight off the raw args. */
function collectRepeated(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) out.push(args[++i]);
  }
  return out;
}

async function readStdinTrimmed(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  let text = Buffer.concat(chunks).toString('utf8');
  if (text.endsWith('\r\n')) text = text.slice(0, -2);
  else if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

export interface AuthCommandDeps {
  loadVoiceInboxModules: (repoRoot: string) => Promise<VoiceInboxLedgerModules>;
  repoRootFn: () => Promise<string>;
  readStdin: () => Promise<string>;
}

function defaultPromptForShape(shape: AuthShape): string {
  switch (shape) {
    case 'S1':
      return 'Authorization needed — open the link and approve.';
    case 'S2':
      return 'Authorization needed — open the link and enter the code shown.';
    case 'S3':
      return 'Enter the code shown on your other device.';
    case 'S4':
      return 'Provide the requested value.';
    case 'S5':
      return 'Please respond.';
    default:
      return 'Authorization needed.';
  }
}

async function resolveFallbackTopic(): Promise<string> {
  const { chat_id, thread_id } = await resolveNotifyTopic();
  return `${chat_id}_${thread_id}`;
}

function resolveTenant(db: any, tenantFlag: string | undefined): string | undefined {
  if (tenantFlag) return tenantFlag;
  if (process.env.PA_AUTH_TENANT) return process.env.PA_AUTH_TENANT;
  const rows = db.prepare('SELECT tenant_id FROM tenants').all() as Array<{ tenant_id: string }>;
  if (rows.length === 1) return rows[0].tenant_id;
  return undefined;
}

async function openModulesAndDb(
  deps: Partial<AuthCommandDeps>
): Promise<{ modules: VoiceInboxLedgerModules; db: any }> {
  const repoRootFn = deps.repoRootFn ?? (() => repoRootFromModule(__filename));
  const loadModulesFn = deps.loadVoiceInboxModules ?? defaultLoadVoiceInboxModules;
  const repoRoot = await repoRootFn();
  const modules = await loadModulesFn(repoRoot);
  const db = modules.ledger.openLedger(modules.config.ledgerPath());
  return { modules, db };
}

async function requestSubcommand(args: string[], deps: Partial<AuthCommandDeps>): Promise<number> {
  const parsed = parseFlags(args, REQUEST_FLAGS);
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const shapeFlag = parsed.values['--shape'];
  if (!shapeFlag || !(AUTH_SHAPES as readonly string[]).includes(shapeFlag)) {
    console.error(USAGE);
    console.error(`Error: --shape must be one of ${AUTH_SHAPES.join('|')}`);
    return 2;
  }
  const shape = shapeFlag as AuthShape;

  const provider = parsed.values['--provider'];
  if (!provider) {
    console.error(USAGE);
    console.error('Error: --provider is required');
    return 2;
  }

  const confirmable = args.includes('--confirmable') ? true : undefined;
  const options = collectRepeated(args, '--option');
  const userCode = parsed.values['--code'];
  const url = parsed.values['--url'];
  const prompt = parsed.values['--prompt'] ?? defaultPromptForShape(shape);

  const { modules, db } = await openModulesAndDb(deps);
  try {
    const tenantId = resolveTenant(db, parsed.values['--tenant']);
    if (!tenantId) {
      console.error('pa auth: cannot resolve a tenant — pass --tenant <t-id>');
      return 3;
    }

    let taskId: string;
    const taskFlag = parsed.values['--task'];
    if (taskFlag) {
      const task = modules.ledger.getTask(db, tenantId, taskFlag);
      if (!task) {
        console.error(`pa auth: task ${taskFlag} not found for tenant ${tenantId}`);
        return 3;
      }
      if (task.state !== 'running') {
        console.error(`pa auth: task ${taskFlag} is ${task.state}; input requests are created from running`);
        return 3;
      }
      taskId = taskFlag;
    } else {
      const standing = readStanding();
      const existing = standing[tenantId];
      const task = modules.ledger.createTask(db, tenantId, {
        source: 'text',
        requestText: prompt,
        conversationId: existing?.conversation_id,
      });
      taskId = task.task_id;
      if (!existing) {
        standing[tenantId] = { conversation_id: task.conversation_id };
        writeStanding(standing);
      }
      const fallbackTopic = await resolveFallbackTopic();
      modules.ledger.transitionTask(db, tenantId, taskId, 'routed', {
        eventKind: 'task.routed',
        routedTo: fallbackTopic,
      });
      modules.ledger.transitionTask(db, tenantId, taskId, 'running', {
        eventKind: 'task.progress',
        eventPayload: { step: 'auth' },
      });
    }

    const widget = widgetForShape(shape, { provider, userCode, confirmable, options });
    const created = modules.ledger.createInputRequest(db, tenantId, taskId, {
      kind: widget.kind,
      prompt,
      params: widget.params,
    });

    if (url) {
      const paramsObj = JSON.parse(created.request.params_json);
      paramsObj.auth_url = url;
      db.prepare('UPDATE input_requests SET params_json = ? WHERE request_id = ? AND tenant_id = ?').run(
        JSON.stringify(paramsObj),
        created.request.request_id,
        tenantId
      );
    }

    const expiresFlag = parsed.values['--expires'];
    const expirySeconds = expiresFlag !== undefined ? Number(expiresFlag) : SHAPE_DEFAULT_EXPIRY_SECONDS[shape];
    const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

    const row: AuthRequestRow = {
      request_id: created.request.request_id,
      task_id: taskId,
      tenant_id: tenantId,
      shape,
      provider,
      kind: widget.kind,
      status: 'pending',
      created_at: created.request.created_at,
      expires_at: expiresAt,
      state: null,
      code_verifier: null,
      redirect_uri: null,
      auth_id: null,
      answer_pointer: null,
      delivered_at: null,
    };
    writeRow(row);

    // Attention channel — retired to opt-in (2026-09-11, vi-08b2360d27b3):
    // the operator-facing surface for "action needed" is now the web app's
    // browser notifications, and this code-driven page no-ops unless
    // PA_ATTENTION_ENABLED=1. Kept so a deliberate re-enable pages auth/input
    // requests too. Best-effort: the request exists either way; a toast/ping
    // failure never fails the request. quiet:true — this stdout is the §3.8
    // one-JSON-line contract, and log() echoes info lines to stdout.
    await notifyAttention(
      `Authorization needed — ${provider}`,
      prompt,
      { quiet: true },
    ).catch(() => {});

    console.log(
      JSON.stringify({
        ok: true,
        request_id: created.request.request_id,
        task_id: taskId,
        shape,
        provider,
        expires_at: expiresAt,
      })
    );
    return 0;
  } catch (err) {
    console.error(`pa auth: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  } finally {
    db.close();
  }
}

function buildAnsweredResult(ir: any): Record<string, unknown> {
  switch (ir.kind) {
    case 'secret':
      return { ok: true, status: 'answered', kind: 'secret', pointer: ir.answer_pointer };
    case 'choice': {
      let value = '';
      try {
        if (ir.answer_pointer) value = readFileSync(ir.answer_pointer, 'utf8');
      } catch {
        // pointer file missing — degrade to empty rather than throw
      }
      return { ok: true, status: 'answered', kind: 'choice', value };
    }
    case 'confirm': {
      let approved = false;
      try {
        if (ir.answer_pointer) approved = readFileSync(ir.answer_pointer, 'utf8').trim() === 'true';
      } catch {
        // pointer file missing — degrade to false rather than throw
      }
      return { ok: true, status: 'answered', kind: 'confirm', approved };
    }
    case 'oauth':
      // The validator only ever accepts `{confirmed: true}` for oauth (§3.2),
      // so an answered oauth request is always approved — no file read needed.
      return { ok: true, status: 'answered', kind: 'oauth', approved: true };
    default:
      return { ok: true, status: 'answered', kind: ir.kind, pointer: ir.answer_pointer ?? null };
  }
}

function printWaitResult(
  asJson: boolean,
  result: Record<string, unknown>,
  requestId: string,
  modules: VoiceInboxLedgerModules
): void {
  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.ok === false) {
    console.log(`pa auth: request ${requestId} ${result.status as string}.`);
    return;
  }
  if (result.kind === 'secret') {
    console.log(
      modules.bridgeWriter.buildAnswerPointerText({ requestId, answerPointer: result.pointer as string })
    );
    return;
  }
  if (result.kind === 'choice') {
    console.log(`Answered: ${result.value as string}`);
    return;
  }
  console.log(`Answered: approved=${String(result.approved)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitSubcommand(args: string[], deps: Partial<AuthCommandDeps>): Promise<number> {
  const parsed = parseFlags(args, WAIT_FLAGS);
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const requestId = parsed.positionals[0];
  if (!requestId) {
    console.error(USAGE);
    return 2;
  }

  const timeoutSeconds = parsed.values['--timeout'] !== undefined ? Number(parsed.values['--timeout']) : 300;
  const asJson = parsed.values['--json'] !== undefined || args.includes('--json');

  const brokerRow = readRow(requestId);
  if (!brokerRow) {
    console.error(`pa auth: unknown request ${requestId}`);
    return 3;
  }

  const { modules, db } = await openModulesAndDb(deps);
  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const expiresAtMs = Date.parse(brokerRow.expires_at);

    for (;;) {
      if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) {
        printWaitResult(asJson, { ok: false, status: 'expired' }, requestId, modules);
        return 4;
      }

      const ir = modules.ledger.getInputRequest(db, brokerRow.tenant_id, brokerRow.task_id, requestId);
      if (ir && ir.status !== 'pending') {
        if (ir.status === 'answered') {
          markDelivered(requestId, new Date().toISOString());
          printWaitResult(asJson, buildAnsweredResult(ir), requestId, modules);
          return 0;
        }
        // 'expired' / 'cancelled' on the ledger row itself — same outward
        // shape as a broker-side expiry (§3.8 defines no third variant).
        printWaitResult(asJson, { ok: false, status: 'expired' }, requestId, modules);
        return 4;
      }

      if (Date.now() >= deadline) {
        printWaitResult(asJson, { ok: false, status: 'timeout' }, requestId, modules);
        return 4;
      }

      await sleep(Math.max(0, Math.min(2000, deadline - Date.now())));
    }
  } finally {
    db.close();
  }
}

async function answerSubcommand(args: string[], deps: Partial<AuthCommandDeps>): Promise<number> {
  const parsed = parseFlags(args, ANSWER_FLAGS);
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const requestId = parsed.values['--request'];
  if (!requestId) {
    console.error(USAGE);
    return 2;
  }

  const readStdin = deps.readStdin ?? readStdinTrimmed;
  const value = await readStdin();
  if (!value) {
    console.error('pa auth: no value on stdin');
    return 3;
  }

  const brokerRow = readRow(requestId);
  if (!brokerRow) {
    console.error(`pa auth: unknown request ${requestId}`);
    return 3;
  }
  const tenantId = parsed.values['--tenant'] ?? brokerRow.tenant_id;

  const { modules, db } = await openModulesAndDb(deps);
  try {
    await modules.answerResume.answerAndResume(
      db,
      tenantId,
      brokerRow.task_id,
      requestId,
      { kind: 'value', value },
      { routeQueuePath: modules.config.routeQueuePath(), answersDir: modules.config.answersDir() }
    );
    // Never the value — only the fixed ack (D-E8).
    console.log(JSON.stringify({ ok: true, status: 'answered', request_id: requestId }));
    return 0;
  } catch (err) {
    console.error(`pa auth: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  } finally {
    db.close();
  }
}

async function learnSubcommand(args: string[]): Promise<number> {
  const parsed = parseFlags(args, LEARN_FLAGS);
  if (parsed.unknown.length > 0) {
    console.error(USAGE);
    console.error(`Unrecognized option(s): ${parsed.unknown.join(', ')}`);
    return 2;
  }

  const provider = parsed.values['--provider'];
  const shapeFlag = parsed.values['--shape'];
  const command = parsed.values['--command'];
  if (!provider || !command) {
    console.error(USAGE);
    return 2;
  }
  if (!shapeFlag || !(AUTH_SHAPES as readonly string[]).includes(shapeFlag)) {
    console.error(USAGE);
    console.error(`Error: --shape must be one of ${AUTH_SHAPES.join('|')}`);
    return 2;
  }

  const expiresDaysFlag = parsed.values['--expires-days'];
  const profile: AuthProfile = {
    shape: shapeFlag as AuthShape,
    command,
    env: parsed.values['--env'],
    credential_path: parsed.values['--credential-path'],
    expires_days: expiresDaysFlag !== undefined ? Number(expiresDaysFlag) : undefined,
    notes: parsed.values['--notes'],
    learned_at: new Date().toISOString(),
  };
  upsertProfile(provider, profile);
  console.log(JSON.stringify({ ok: true, provider, shape: profile.shape }));
  return 0;
}

export async function authCommand(args: string[], deps: Partial<AuthCommandDeps> = {}): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case 'request':
      return requestSubcommand(args.slice(1), deps);
    case 'wait':
      return waitSubcommand(args.slice(1), deps);
    case 'answer':
      return answerSubcommand(args.slice(1), deps);
    case 'learn':
      return learnSubcommand(args.slice(1));
    default:
      console.error(USAGE);
      return 2;
  }
}
