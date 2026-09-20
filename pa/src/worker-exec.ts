import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { paHome } from './paths.js';
import { tmpdir } from 'os';
import { randomBytes, randomUUID } from 'crypto';
import { DEFAULT_TIMEOUT, DEFAULT_IDLE_TIMEOUT } from './types.js';
import type { WorkerConfig, CommandResult, RunOptions } from './types.js';
import { blackboard } from './blackboard.js';
import { resolveStateDir, getLatestStateMtime, analyzeAgentState } from './state-monitor.js';
import { hasChildProcesses, killProcessTree, getDescendantPids, getCommandLines, areProcessesAlive, getProcessSnapshot, partitionVerifiedTreeMembers } from './process-tree.js';
import type { ProcessRecord } from './process-tree.js';
import { evaluateWorkerState } from './worker-evaluator.js';
import { addWorkerPid, removeWorkerPid, updateWorkerPidDescendants, isProcessAlive } from './worker-pids.js';
import { logger } from './lib/log.js';
import { effectiveSlotCount, resolveCeiling } from './lib/dynamic-slots.js';
import { recordRateLimit } from './rate-limits.js';
import { notifyUser } from './lib/notify.js';
import { release as releaseReservations } from './lib/reservations.js';
import { getSkillTranslationPatterns } from './lib/skill-translations.js';
import { appendUsage, extractUsageFromEvent, type UsageRecord } from './lib/usage-ledger.js';
import { appendTelemetryRecord } from './lib/model-router/telemetry.js';
import { loadConfig } from './config.js';
import {
  TraceCollector,
  appendTurnTrace,
  classifyOrigin,
  classifyOutcome,
  parseBotResource,
  skillFromResource,
  taskRefFromResource,
  type TurnTraceV1,
} from './lib/turn-trace.js';

function sanitizeCmdline(cmdline: string): string {
  return cmdline.replace(/([?&](api_key|token|password|secret)=)[^\s&]*/gi, '$1<redacted>').slice(0, 200);
}

/**
 * Raw-send guard (2026-09-04, plans/2026-09-04-raw-send-guard-SPEC.md WP2.1):
 * pure detector over a run's collected tool commands. A command matches iff it
 * contains `api.telegram.org` OR `telegramFetch(` — the two shapes the
 * hand-written scratch send into pa-support used. Deterministic, no I/O;
 * returns at most 3 matches, each truncated to 200 chars. Accepted
 * false-positive class (alert-only, never blocking): dev commands that grep or
 * edit source containing these strings.
 */
export function detectRawTelegramSends(commands: string[]): string[] {
  const matches: string[] = [];
  for (const c of commands) {
    if (typeof c !== 'string') continue;
    if (c.includes('api.telegram.org') || c.includes('telegramFetch(')) {
      matches.push(c.slice(0, 200));
      if (matches.length >= 3) break;
    }
  }
  return matches;
}

/**
 * Auth-prompt sentinel (auth broker Phase A, 2026-09-10 build spec §5 WP-G,
 * decisions C6/D8): pure detector over a worker turn's raw stdout, looking
 * for shapes a human has to act on by hand — an auth-looking URL, a
 * device-style XXXX-XXXX code, or an "enter/paste the code" instruction —
 * that the worker printed instead of raising a proper `pa auth request`.
 * Deterministic, no I/O; returns at most 3 matching lines, each truncated to
 * 200 chars. Accepted false-positive class (nudge-only, never blocking): a
 * worker discussing auth prompts in prose without actually being stuck on
 * one.
 */
export const AUTH_PROMPT_PATTERNS: readonly RegExp[] = [
  /https?:\/\/\S*(?:oauth|authorize|device|login|verify)\S*/i,
  /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/,
  /\benter the code\b/i,
  /\bpaste (?:the |this )?(?:code|token|url)\b/i,
  /\bone-time code\b/i,
];

export function detectAuthPrompts(output: string): string[] {
  const matches: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    for (const pattern of AUTH_PROMPT_PATTERNS) {
      if (pattern.test(line)) {
        matches.push(line.slice(0, 200));
        break;
      }
    }
    if (matches.length >= 3) break;
  }
  return matches;
}

export interface BgEntry {
  firstSeen: number;
  cmdline?: string;
  lastRepeatBucket: number;
}

export interface BgAlertEntry {
  pid: number;
  ageSec: number;
  cmdline: string;
}

/**
 * Decides which bg-task entries have aged past `alertMs` AND crossed into a
 * new repeat bucket (age divided into `repeatMs`-wide windows) since they
 * were last alerted on. Mutates `lastRepeatBucket` in place on every entry
 * it returns — the per-PID bucket IS the dedup mechanism (no separate
 * dedupKey), so this can't be pure-functional about entry state, but it has
 * no I/O and calls no notifier itself; the caller decides what to do with
 * the returned list.
 */
export function collectBgAlerts(
  bgTaskMap: Map<number, BgEntry>,
  now: number,
  alertMs: number,
  repeatMs: number
): BgAlertEntry[] {
  const alerting: BgAlertEntry[] = [];
  for (const [pid, entry] of bgTaskMap) {
    const ageMs = now - entry.firstSeen;
    if (ageMs > alertMs) {
      const bucket = Math.floor(ageMs / repeatMs);
      if (bucket > entry.lastRepeatBucket) {
        entry.lastRepeatBucket = bucket;
        alerting.push({ pid, ageSec: Math.round(ageMs / 1000), cmdline: entry.cmdline ?? '(unknown)' });
      }
    }
  }
  return alerting;
}

// With shell:true, Node joins command + args into a shell string on all platforms.
// Quote args containing spaces or metacharacters to prevent word-splitting.
function quoteArg(a: string): string {
  if (process.platform === 'win32') {
    // SECURITY (do not regress, 2026-07-22): this used to quote only on
    // whitespace or '"' (/[\s"]/). Worker tunables (/llm, /effort) are
    // deliberately "free on value" — a value is NEVER rejected, only the
    // setting NAME is validated, because model catalogues move faster than
    // an allowlist could track — so a Telegram message like "/effort
    // high&calc.exe" (no whitespace around '&') reached spawn(shell:true)
    // UNQUOTED, and cmd.exe treats a bare '&' as a command separator: a live
    // command-injection path from a chat message. Quote UNCONDITIONALLY
    // rather than enumerating cmd.exe's metacharacters (&|<>^%!()) one by
    // one — that enumeration is exactly how the original gap happened.
    // '%' needs its OWN escape: cmd.exe expands %VAR% (including secrets
    // this worker's env carries, e.g. TELEGRAM_BOT_TOKEN) even inside a
    // quoted span — quoting alone does not suppress it. Doubling ("%%")
    // does NOT work either at this "cmd /c <line>" call shape (verified
    // empirically 2026-07-22: %%PATH%% still expanded, just with stray
    // literal '%' around the leaked value) — that folklore is for escaping
    // '%' inside a .bat file's own body, a different parsing context.
    // The escape that DOES work here is the close-quote/caret/reopen-quote
    // splice ("^%"): it forces the '%' outside any quoted span so cmd.exe's
    // caret-escape actually applies, while the surrounding quotes still
    // protect against whitespace/'&'/'|' etc. Verified end-to-end via a
    // real spawned process, not just reasoned about (see
    // pa/tests/worker-exec-arg-injection.test.ts).
    const escaped = a.replace(/"/g, '\\"').split('%').join('"^%"');
    return `"${escaped}"`;
  }
  // POSIX sh: wrap in single quotes, escape embedded single quotes via '\''
  return /[\s'"\\$`!|&;()<>]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
}

/**
 * Remove configured flags for ONE run (RunOptions.stripArgs). Bare form drops
 * the flag and the token AFTER it unconditionally — a stripped bare flag is
 * assumed value-bearing, so '--flag --other x' also drops '--other'. '=form'
 * drops only the token carrying it. Repeats all drop. A stripped flag at the
 * end drops itself. Unset/empty strip ⇒ the input array is returned unchanged
 * (byte-identical contents). extraArgs are never passed here and are appended
 * after stripping — they are never stripped.
 */
export function stripConfiguredArgs(args: string[], strip: string[] | undefined): string[] {
  if (!strip || strip.length === 0) return args;
  const flags = new Set(strip);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a)) { i++; continue; } // bare form: consume flag + following token
    const eq = a.indexOf('=');
    if (eq > 0 && flags.has(a.slice(0, eq))) continue; // =form: drop the token
    out.push(a);
  }
  return out;
}

/**
 * Mtime-freshness window for the kill-decision shortcut (OD-5, 2026-09-18
 * slow-machine RCA): a state file written inside the firing timer's silence
 * window proves the worker is alive without consulting the judge. Fixed
 * const, no env knob.
 */
export const EVALUATOR_MTIME_FRESH_MS = 60_000;

/**
 * Pure mtime-freshness predicate. False on null/non-Date/NaN; otherwise
 * strict `nowMs - mtime < windowMs` — future mtimes read fresh (the safe
 * direction: a clock-skewed fresh write must extend, never kill).
 */
export function isMtimeFresh(mtime: Date | null, nowMs: number, windowMs: number): boolean {
  if (!(mtime instanceof Date) || Number.isNaN(mtime.getTime())) return false;
  return nowMs - mtime.getTime() < windowMs;
}

/**
 * Kill-decision freshness probe: true when the latest state file under
 * `stateDir`/`statePattern` was written inside `windowMs`. False on null
 * dir; getLatestStateMtime never throws (state-monitor catches to null),
 * so a missing dir resolves to null → false.
 */
export async function isStateFreshForKillDecision(
  stateDir: string | null,
  statePattern: string,
  nowMs: number,
  windowMs: number,
): Promise<boolean> {
  if (!stateDir) return false;
  return isMtimeFresh(await getLatestStateMtime(stateDir, statePattern), nowMs, windowMs);
}

// agy and agyc are the SAME binary (agy.exe via the gemini-shim) emitting the
// SAME stream-json dialect — `event.event` as discriminator, response in
// result events, text_delta on step_update. agyc only pins a non-Gemini-family
// model. Gating dialect parsing on the literal name 'agy' silently discarded
// every agyc reply: exit 0, parsed output '' — the "silent no-op" that
// failed three commit runs (2026-08-18 ×2, 2026-08-21; the agent's completed
// report was in the tee file, unparse-gated). Any future worker that shells
// through the agy shim must be added here.
function isAgyStreamWorker(worker: WorkerConfig): boolean {
  return worker.name === 'agy' || worker.name === 'agyc';
}

/**
 * Consecutive agy `step_update` events with `step_type: 'error_message'` and
 * no intervening event that produced usable output (a non-empty, non-
 * whitespace `text_delta` on an `agent_response` step, or a `result` event
 * carrying a real response) before a run is judged to be spinning rather than
 * working and killed outright (2026-09-10 incident: an agy dispatch
 * alternated `agent_response`/`error_message` steps — each `agent_response`
 * carrying an empty `text_delta` — for 11+ minutes without ever exiting,
 * holding the only worker slot and starving `pa catchup` for 38 minutes).
 *
 * Consecutive-`error_message` count alone is NOT a safe discriminator on its
 * own — a run legitimately recovering from one bad tool call also emits an
 * `error_message` step — so the counter resets on ANY usable output in
 * between (narration-only text_deltas excluded via isNarrationOnly — an
 * error/narration alternation still trips the counter); only an unbroken run
 * of them with nothing getting through counts.
 * N was 3 (the real production tee corpus for this account's prior
 * quota-exhaustion episodes: every sampled occurrence of this exact
 * empty-agent_response/error_message alternation, without exception, turned
 * out to be the account's quota exhausted, and the shortest of those episodes
 * had already reached 3 rounds before either recovering or giving up).
 * Lowered to 2 (Oracle, 2026-09-17): waiting for a 3rd occurrence burned most
 * of the run's time budget on a worker already shown to be looping — the 2nd
 * consecutive `error_message` step is itself the stuck signal. The
 * reset-on-usable-output guard is what keeps this from firing on a single
 * self-healing blip, independent of N, so lowering N does not reopen that
 * false-positive risk.
 */
const AGY_ERROR_LOOP_THRESHOLD = 2;

const NARRATION_PATTERNS: readonly RegExp[] = [
  /\bwaiting\b/i,
  /\bstand\s?by\b/i,
  /\bpolling\b/i,
  /\bchecking\s+(back|on|status)\b[\s\p{P}\p{N}]*$/iu,
  /\bstill\s+(running|going|working)\b/i,
];

/** Narration-only worker chatter (P8, 2026-09-18): "waiting for X" style turns that
 *  describe waiting without delivering anything (the six text_deltas of the 668 s
 *  incident). Conservative by construction: EVERY non-empty line must match, empty /
 *  whitespace-only is NOT narration (that stays "no output", caught elsewhere), and a
 *  single substantive line makes the whole delta usable. Misclassification escalates to
 *  the liveness ladder (live child => extend, bounded by NO_PROGRESS_MAX_EXTENDS), never
 *  to a summary kill. */
export function isNarrationOnly(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => NARRATION_PATTERNS.some((p) => p.test(l)));
}

const DEFAULT_WORKER_FAULT_COOLDOWN_MS = 600_000; // 10 min

// The fault cooldown is a "we saw it fail, stop asking for a while" reflex, not a
// parsed provider limit. recordRateLimit takes MINUTES and drops anything <= 0, so
// round UP to at least one minute or the cooldown is silently skipped.
function workerFaultCooldownMinutes(): number {
  const n = parseInt(process.env.PA_WORKER_FAULT_COOLDOWN_MS ?? '', 10);
  const ms = Number.isFinite(n) && n > 0 ? n : DEFAULT_WORKER_FAULT_COOLDOWN_MS;
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * Wall-clock companion to the counter above: fires when a run has produced no
 * *usable* output for this long, regardless of whether it is emitting
 * error_message steps at all. The existing idle timer cannot catch this
 * class — it resets on ANY stdout byte, and a spinning agy stream never
 * stops emitting step_update JSON, so idle timeout keeps extending forever
 * while genuinely no progress is made. Configurable (PA_AGY_NO_PROGRESS_TIMEOUT_MS,
 * milliseconds) because "usable output" can legitimately be sparse on a long
 * single-tool-call step; default sits well under the ~9-11 minute spins
 * observed in production while giving real slow steps room to finish. Read at
 * call time (like workerSlotCount() below) so tests can override the env var
 * per-case.
 *
 * vi-2638f25056ba (2026-09-11): the fire is no longer a summary execution.
 * A bare kill here discarded 5+ minutes of real work every time agy ran slow
 * but alive on the starved D: HDD — 7 such kills in one day, each followed by
 * a full failover re-run. The fire now goes through the same check-before-kill
 * ladder the idle timer uses (state analyzer → evaluator → process tree) and
 * kills outright only when that ladder finds no liveness signal or the
 * NO_PROGRESS_MAX_EXTENDS cap below is exhausted. The error-loop counter above
 * still kills its own signature in seconds, untouched. Narration-only
 * text_deltas ("waiting for X" chatter, isNarrationOnly) do NOT count as
 * usable output here — a run emitting nothing but that still trips this guard.
 */
function agyNoProgressTimeoutMs(): number {
  const n = parseInt(process.env.PA_AGY_NO_PROGRESS_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
}

/**
 * Consecutive no-progress fires answered with "extend" before the run is
 * force-killed anyway. Every fire re-verifies liveness (evaluator verdict or
 * a live subprocess tree), so reaching this cap means the run produced zero
 * usable output for ~cap × the window (3 × 5 min default ≈ 15 min base,
 * plus per-fire evaluator latency) with no evaluator willing to call it done.
 * That is a deliberate loosening versus the old flat 5-minute kill: the
 * 2026-09-10 spin class this does NOT cover — alternating empty
 * agent_response / error_message steps — is still killed in seconds by the
 * AGY_ERROR_LOOP_THRESHOLD counter above, independent of these timers, so
 * the extra window is spent only on runs that are alive but silent (the
 * starved-D: pattern). Tune PA_AGY_NO_PROGRESS_TIMEOUT_MS, not this cap,
 * if the total feels too long.
 */
const NO_PROGRESS_MAX_EXTENDS = 3;

async function writeTempPrompt(prompt: string): Promise<string> {
  const id = randomBytes(8).toString('hex');
  const tmpPath = join(tmpdir(), `pa-prompt-${id}.txt`);
  await writeFile(tmpPath, prompt, 'utf8');
  return tmpPath;
}

/**
 * Which PIDs a kill should actually target: the wrapper (`rootPid`) plus every
 * live tracked descendant, deduped, root-first. Deliberately does NOT bail out
 * when the root is dead — a dead wrapper with a live descendant is exactly the
 * AI-112 bug (shell:true wrapper dies/gets killed while the real CLI child it
 * spawned keeps running), so a live descendant must still be returned.
 */
export function selectKillTargets(
  rootPid: number | undefined,
  descendants: number[],
  alive: (pid: number) => boolean = isProcessAlive
): number[] {
  if (rootPid === undefined) return [];
  const seen = new Set<number>();
  const targets: number[] = [];
  for (const pid of [rootPid, ...descendants]) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (alive(pid)) targets.push(pid);
  }
  return targets;
}

/** Test-only module-wide dep override for the orphan-sweep / kill-verification
 *  seams (AI-328 — mirrors browser-launcher's _setBrowserLauncherDepsForTest).
 *  _bgTaskHooks remains the per-dispatch injection surface; the sweep's
 *  snapshot + kill calls need a module seam because tests must observe kills
 *  without taskkilling real processes. Pass null to restore. */
export interface OrphanSweepTestDeps {
  getProcessSnapshot?: (fresh?: boolean) => Promise<Map<number, ProcessRecord>>;
  killProcessTree?: (pid: number) => void;
}
let _sweepDeps: OrphanSweepTestDeps | null = null;
export function _setOrphanSweepDepsForTest(deps: OrphanSweepTestDeps | null): void {
  _sweepDeps = deps;
}

export async function executeWorker(
  worker: WorkerConfig,
  prompt: string,
  options: RunOptions
): Promise<CommandResult> {
  const resource = options.resource || worker.name;
  const agentName = options.agentName || worker.name;
  const contextId = options.contextId;
  const maxTimeoutMs = (options.timeout || DEFAULT_TIMEOUT) * 1000;
  const runId = randomUUID();
  const tsStartMs = Date.now();

  // Codex Translation Layer: Translate /skill -> $skill for pass-through commands.
  // Skill list is loaded from ~/.pa/codex-skill-translations.json (scaffolded by `pa init`)
  // with an embedded fallback if the file is missing or malformed.
  let effectivePrompt = prompt;
  if (worker.name === 'codex') {
    const skills = getSkillTranslationPatterns();
    const pattern = new RegExp(`^\\/(${skills.join('|')})\\b`, 'gm');
    effectivePrompt = prompt.replace(pattern, '$$$1');
  }

  // 1. Acquire lock on resource
  const acquired = await blackboard.acquireLock(resource, agentName, process.pid, maxTimeoutMs, contextId);
  if (!acquired) {
    return {
      success: false,
      output: '',
      error: `Failed to acquire lock for resource: ${resource} after ${maxTimeoutMs / 1000}s`,
      exitCode: -1,
      runId,
    };
  }

  // 1b. Admission control (AI-096 item 3): heavyweight CLI workers all hit the
  // same disk — unbounded concurrency is what collapsed the machine on
  // 2026-07-04. Acquire one of PA_MAX_CONCURRENT_WORKERS blackboard slots
  // (cross-process: bot + catchup share the pool) or queue until one frees.
  // Slot AFTER resource: slot holders never wait on resources → no deadlock.
  // Evaluators are exempt: they run WHILE a slot-holding worker awaits their
  // verdict — making them queue for a slot would be a circular wait.
  const slotHandle = options.isEvaluator
    ? ('disabled' as const)
    : await acquireWorkerSlot(agentName, maxTimeoutMs, blackboard, undefined, async () => {
        // Keep the already-held resource lock fresh while queued — a slot wait
        // can exceed HEARTBEAT_STALE_MS, and a purged topic lock would let a
        // concurrent same-topic dispatch through.
        await blackboard.updateHeartbeat(resource, agentName, contextId).catch(err => logger.warn('worker-exec', 'heartbeat update failed during slot queue', { error: err?.message ?? String(err) }));
      },
      options.slotPriority ? { priority: options.slotPriority } : undefined);
  if (slotHandle === null) {
    await blackboard.releaseLock(resource, agentName, contextId);
    return {
      success: false,
      output: '',
      error: `All worker slots busy after ${maxTimeoutMs / 1000}s (PA_MAX_CONCURRENT_WORKERS=${workerSlotCount()}) — dispatch queued too long`,
      exitCode: -1,
      runId,
    };
  }

  // Minted at function scope so the settle `finally` can release reservations
  // tagged with it (see the dispatch-identity comment where mergedEnv is built).
  const dispatchId = randomBytes(6).toString('hex');

  try {
    const idleTimeoutMs = Math.min((options.idleTimeout || DEFAULT_IDLE_TIMEOUT) * 1000, maxTimeoutMs);

    const useStdinJson = worker.input_mode === 'stdin-json';
    const useStdinText = worker.input_mode === 'stdin-text';
    const useStdin = useStdinJson || useStdinText;
    let promptFile: string | null = null;

    // Build args:
    // - stdin modes (json, text): no {prompt} substitution, prompt sent via stdin
    // - arg mode: write prompt to temp file and substitute {prompt}/{prompt_file}
    let args: string[];
    const extraArgs = options.extraArgs || [];
    const configuredArgs = stripConfiguredArgs(worker.args, options.stripArgs);
    if (useStdin) {
      // Codex uses a trailing bare '-' as its stdin marker, and (on resume)
      // subcommand syntax ('resume', no dashes) ahead of it. Anything appended
      // AFTER that trailing '-' is not a valid position for codex args, so both
      // a resume subcommand and/or worker tunables (e.g. `-c model_reasoning_effort=high`
      // from a fresh, non-resume dispatch) must be spliced in BEFORE it instead
      // of appended after. This must fire for ANY non-empty extraArgs — not just
      // when extraArgs[0] === 'resume' — otherwise a fresh (non-resume) dispatch
      // carrying only tunable args falls into the `else` branch below and lands
      // after the stdin marker, where codex silently ignores or errors on it.
      // buildDispatchExtraArgs (telegram-bot/src/main.ts) already orders extraArgs
      // as [...baseArgs (e.g. resume args), ...tunableArgs], so no reordering is
      // needed here — the whole array goes in before the trailing '-' as-is.
      if (extraArgs.length > 0 && configuredArgs[configuredArgs.length - 1] === '-') {
        args = [...configuredArgs.slice(0, -1), ...extraArgs, '-'];
      } else {
        args = [...configuredArgs, ...extraArgs];
      }
    } else {
      promptFile = await writeTempPrompt(prompt);
      const substitutedArgs = configuredArgs.map((a) => {
        if (a === '{prompt}') return `@${promptFile}`;
        if (a === '{prompt_file}') return promptFile!;
        return a.replace('{prompt}', `@${promptFile}`).replace('{prompt_file}', promptFile!);
      });
      args = [...substitutedArgs, ...extraArgs]; // APPEND extra args
    }

    // shell:true runs on all platforms — quote args that contain spaces or
    // shell metacharacters so they aren't word-split by cmd.exe / sh.
    args = args.map(quoteArg);

    // PA_WORKER_RESOURCE is the worker's own identity. For every dispatch
    // that carries a resource — every topic and thread dispatch, and
    // therefore every voice-inbox task — it is byte-identical to the `skill`
    // key this dispatch registers in worker-pids (see addWorkerPid below,
    // `options.resource || 'unknown'`), so a process holding it can record
    // exactly the string that later identifies its process tree. When no
    // resource is supplied the env is deliberately EMPTY rather than
    // 'unknown': 'unknown' would be a killable-looking placeholder that
    // could later match an unrelated worker's registry entry. Deliberately
    // NOT the local `resource` const (which falls back to worker.name) and
    // deliberately always present: spreading process.env first means an
    // unset value would otherwise inherit a parent's.
    //
    // Dispatch identity (WP-5 D12). `resource` names a LANE; a bare topic
    // resource is reused by every message in that topic, so a later kill that
    // matched on the resource alone could hit a stranger. This id names THIS
    // dispatch. Minted BEFORE the env is built and written onto the
    // worker-pids entry AFTER the spawn, so the worker is HANDED its identity
    // and never has to look one up — addWorkerPid runs after spawn and is not
    // awaited, so a lookup would race, and its key would be the same reused
    // `skill` string whose reuse is the problem. Declared at FUNCTION scope
    // (below the slot acquisition, before this `try`): AI-255 B4's settle
    // `finally` releases reservations by this id, and a `const` inside
    // `try {}` is a sibling block — invisible to `finally`.
    const mergedEnv = {
      ...process.env,
      ...(options.env || {}),
      // Per-hop env hook (WS3 answer provenance, 2026-09-18): evaluated with
      // THIS hop's WorkerConfig inside the per-candidate construction, so a
      // failover hop stamps its own identity — and lands AFTER options.env,
      // which runWithFailover replaces with the secret_allowlist-filtered
      // subset (an allowlisted worker drops every non-allowlisted key, so
      // framework-stamped env like PA_WORKER_CLI must ride this post-filter
      // hook or it never reaches the child).
      ...(options.getEnv?.(worker) ?? {}),
      PA_BOT_PID: String(process.pid),
      PA_WORKER_RESOURCE: options.resource ?? '',
      PA_WORKER_DISPATCH_ID: dispatchId,
    } as NodeJS.ProcessEnv;

    // Lean evaluator spawn (C4, 2026-09-18 slow-machine RCA): drop the three
    // browserSessionEnvOverlay pointer keys (Playwright CDP endpoint, browser
    // CDP port, voice-inbox port) — the judge never drives a browser, so it
    // must not inherit them. Secrets filtering is untouched (that stays the
    // dispatcher's job). Const-object property delete — no reassignment.
    if (options.isEvaluator) {
      delete mergedEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT;
      delete mergedEnv.PA_BROWSER_CDP_PORT;
      delete mergedEnv.VOICE_INBOX_PORT;
    }

    // Tee stdout for all workers: for agy, the shim wraps agy with the tee
    // helper when AGY_TEE_OUT is set, capturing output to disk so the orphan
    // reaper can recover sessionless workers' replies after a bot crash.
    // For non-agy workers, we tee stdout here in Node.js so the tee file is
    // universally available for recovery.
    let teePath: string | undefined;
    const teeDir = join(paHome(), 'logs', 'worker-tee');
    await mkdir(teeDir, { recursive: true });
    const safeName = options.contextId || `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const teeFilePath = join(teeDir, `${safeName}.out`);
    if (worker.name === 'agy') {
      teePath = mergedEnv.AGY_TEE_OUT || teeFilePath;
      mergedEnv.AGY_TEE_OUT = teePath;
    } else {
      teePath = teeFilePath;
    }

    // Snapshot state dir mtime before spawning so we can detect new activity
    const stateDir = worker.state_dir ? resolveStateDir(worker.state_dir) : null;
    const statePattern = worker.state_pattern || '*.jsonl';
    let lastKnownMtime = stateDir ? await getLatestStateMtime(stateDir, statePattern) : null;

    const result = await new Promise<CommandResult>((resolve) => {
      let resolved = false;
      let pidTracked: Promise<void> | undefined;
      const done = (r: CommandResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        clearTimeout(noProgressTimer);
        clearInterval(heartbeatInterval);
        if (child.pid) {
          (pidTracked || Promise.resolve()).then(() => removeWorkerPid(child.pid!)).catch(err => logger.warn('worker-exec', 'removeWorkerPid failed on done', { error: err?.message ?? String(err) }));
        }
        if (teeWriteStream) { teeWriteStream.end(); }
        const outcome = classifyOutcome({
          exitCode: r.exitCode,
          cancelled: (() => { try { return options.isCancelled?.() === true; } catch { return false; } })(),
          suppressExitAlert: options.suppressExitAlert === true,
          error: r.error,
        });
        const bot = parseBotResource(options.resource);
        const taskRef = taskRefFromResource(options.resource);
        const h = trace.harvest();
        // Raw-send guard (2026-09-04): scan this run's collected tool commands
        // for direct Telegram Bot API sends; attached to the result only when
        // non-empty (optional field — the bot alerts pa-support, never blocks).
        const rawSends = detectRawTelegramSends(h.commands);
        // Auth-prompt sentinel (auth broker Phase A, 2026-09-10, C6/D8): scan
        // this run's raw stdout for auth-shaped lines; attached to the result
        // only when non-empty (optional field — the bot nudges once and never
        // blocks the reply on it).
        const authHits = detectAuthPrompts(r.output ?? '');
        void appendTurnTrace({
          v: 1,
          run_id: runId,
          ts_start: new Date(tsStartMs).toISOString(),
          ts_end: new Date().toISOString(),
          duration_ms: Date.now() - tsStartMs,
          origin: classifyOrigin(options.resource),
          ...(bot ? { chat_id: bot.chatId, thread_id: bot.threadId } : {}),
          ...(options.updateId !== undefined ? { update_id: options.updateId } : {}),
          ...(taskRef ? { task_ref: taskRef } : {}),
          ...(skillFromResource(options.resource) ? { skill: skillFromResource(options.resource) } : {}),
          worker: worker.name,
          ...(trace.model ? { model: trace.model } : {}),
          ...(r.sessionId ?? capturedSessionId ? { session_id: r.sessionId ?? capturedSessionId } : {}),
          exit_code: r.exitCode,
          outcome,
          parsed: trace.parsed,
          tool_calls: h.tool_calls,
          commands: h.commands,
          files: h.files,
          errors: h.errors,
          retries: 0,
          ...(trace.tokens ? { tokens: trace.tokens } : {}),
          bytes_out: Buffer.byteLength(r.output ?? '', 'utf8'),
          truncated: h.truncated,
        } satisfies TurnTraceV1);
        resolve({ ...r, teePath: r.teePath ?? teePath, runId, ...(rawSends.length > 0 ? { rawTelegramSends: rawSends } : {}), ...(authHits.length > 0 ? { authPrompts: authHits } : {}) });
      };

      let stdout = '';
      let stderr = '';
      let capturedSessionId: string | undefined;
      let lastCodexTelemetry: { usedPercent: number; windowMinutes: number; resetsAt: number } | undefined;
      let codexStreamError = ''; // captures {"type":"error",...} events from codex NDJSON stream
      let agyStreamError = ''; // captures error text from agy result events with status !== SUCCESS
      let agyResultSeen = false; // tracks whether an agy result event was parsed (for fallback logic)
      let capturedUsage: { tokensIn: number; tokensOut: number; tokensThinking?: number; tokensCacheRead?: number } | undefined; // tracks usage from stream events
      // Error-loop / no-progress guard (2026-09-10 incident, agy/agyc only —
      // see AGY_ERROR_LOOP_THRESHOLD / agyNoProgressTimeoutMs above).
      let agyConsecutiveErrorSteps = 0; // resets on any usable output
      let agyStepsSeen = 0; // total step_update events observed; heartbeat progress marker only
      let lastUsableOutputAt = Date.now(); // wall-clock anchor for the no-progress guard
      const isStreamJson = worker.output_format === 'stream-json';
      const trace = new TraceCollector({ isAgyDialect: isAgyStreamWorker(worker) });

      const child = spawn(worker.command, args, {
        cwd: options.cwd || process.cwd(),
        shell: true,
        env: mergedEnv,
        stdio: useStdin ? ['pipe', 'pipe', 'pipe'] : undefined,
        // POSIX only: makes the child a process-group leader so killProcessTree's
        // `process.kill(-pid, ...)` can reach its whole subtree. Windows keeps
        // taskkill /T (detached there can flash a console window). No unref() —
        // we still want this process tracked as a normal child for waiting/reaping.
        detached: process.platform !== 'win32',
        // windowsHide: shell:true spawns a real cmd.exe console on Windows;
        // without this every worker invocation flashes a visible window.
        windowsHide: true,
      });

      // Hoisted above the kill helpers below (AI-112) — killWorkerTree reads
      // bgTaskMap, so declaring it after them would be a TDZ error.
      const bgTaskMap = new Map<number, BgEntry>();

      // Node.js stdout tee for non-agy workers. Agy uses the shim-based
      // AGY_TEE_OUT tee which writes from the shim process; duplicating
      // that here would be wasteful. For other workers, we tee stdout
      // here so the orphan reaper can recover the reply even when the
      // worker-pids registry entry is cleaned up by the worker's own
      // done() callback.
      const teeWriteStream = (teePath && worker.name !== 'agy')
        ? createWriteStream(teePath, { flags: 'a' })
        : null;

      pidTracked = child.pid
        ? addWorkerPid({
            pid: child.pid,
            spawnedBy: process.pid,
            worker: worker.name,
            skill: options.resource || 'unknown',
            dispatchId,
            startedAt: new Date().toISOString(),
            ...(options.harvestWindowMs
              ? { harvestUntil: new Date(Date.now() + options.harvestWindowMs).toISOString() }
              : {}),
            ...(teePath ? { teePath } : {}),
          }).catch((err) => {
            logger.warn('worker-pids', 'Failed to register worker pid', {
              pid: child.pid, worker: worker.name, error: String(err),
            });
          })
        : undefined;

      // Handle prompt injection via stdin
      if (useStdin && child.stdin) {
        // A shell-exec failure (e.g. command not found) can close the pipe before or during
        // this write, throwing an uncaught EPIPE that crashes the process. child.on('error')/
        // ('close') below already produce the correct failure CommandResult — this just stops
        // the stream-level error from escaping as an unhandled exception.
        child.stdin.on('error', () => {});
        if (useStdinJson) {
          // Claude Code stream-json expects: {"type":"user","message":{"role":"user","content":"..."}}
          const message = JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: prompt,
            },
          });
          child.stdin.write(message + '\n');
        } else {
          // Plain text injection (useStdinText)
          child.stdin.write(prompt);
        }
        child.stdin.end();
      }

      const mergeKillError = (reason: string) =>
        [codexStreamError, agyStreamError].filter(Boolean).join('\n') ? `${reason}\n${[codexStreamError, agyStreamError].filter(Boolean).join('\n')}` : reason;

      // Kills the wrapper PID (child.pid) AND every live tracked descendant
      // (bgTaskMap — refreshed each heartbeat from the real OS process tree).
      // AI-112: the wrapper can die/be killed while the real CLI child it
      // spawned keeps running (shell:true always spawns a wrapper), so killing
      // only child.pid left that child alive while done() still deregistered
      // the worker-pids row unconditionally — /stop looked like it worked but
      // did nothing to the actual process.
      const killWorkerTree = (reason: string) => {
        void killWorkerTreeInner(reason).catch(err =>
          logger.warn('worker-exec', 'killWorkerTree failed', { error: err?.message ?? String(err) }));
      };
      const killWorkerTreeInner = async (reason: string) => {
        const candidates = selectKillTargets(child.pid, [...bgTaskMap.keys()]);
        let targets = candidates;
        // Stale-PPID verification (AI-328): bgTaskMap can contain phantoms —
        // Windows ParentProcessId is immutable, so pid reuse mis-attributes
        // foreign/system processes into the tree (observed: 211 "descendants"
        // incl. svchost on a commit run). Verify before taskkill: a verified
        // member was created during this run AND has no live ancestor outside
        // the family. On snapshot failure/emptiness we cannot verify — kill
        // candidates anyway: failing to kill a runaway worker is worse than
        // the phantom risk (taskkill on SYSTEM services fails as non-admin).
        if (candidates.length > 0) {
          try {
            const snapshot = await bgGetSnapshot(true);
            if (snapshot.size > 0) {
              const { verified, foreign } = partitionVerifiedTreeMembers(
                candidates, child.pid, new Set(bgTaskMap.keys()), snapshot, tsStartMs - 5_000,
              );
              if (foreign.length > 0) {
                logger.warn('worker-exec', 'killWorkerTree skipping non-family pids (stale-PPID mis-attribution)', {
                  worker: worker.name, resource, pid: child.pid, foreign,
                });
              }
              targets = verified;
            }
          } catch { /* snapshot unavailable → kill unverified (pre-AI-328 behavior) */ }
        }
        const level = reason === 'evaluator-done' ? 'info' : 'warn';
        logger[level]('worker-exec', 'Killing worker tree', {
          worker: worker.name, resource, pid: child.pid, targets, tracked: bgTaskMap.size,
        });
        if (targets.length > 0) {
          for (const pid of targets) bgKillTree(pid);
        } else if (!child.pid) {
          child.kill();
        }
      };

      const killWithMessage = (reason: string) => {
        // S8: an agy fault guard fired. Remember it instead of re-probing on the
        // next dispatch. Ordinary kills (idle, absolute timeout, evaluator-done)
        // must NOT cool anything down, hence the prefix gate.
        if (reason.startsWith('Killed: agy-error-loop') || reason.startsWith('Killed: agy-no-progress')) {
          void recordRateLimit(worker.name, workerFaultCooldownMinutes(), '[error-loop] agy-error-loop');
        }
        killWorkerTree(reason);
        done({
          success: false,
          output: stdout,
          error: mergeKillError(reason),
          exitCode: -1,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      };

      const killWithSummary = (reason: string, summary: string) => {
        killWorkerTree(reason);
        done({
          success: false,
          output: stdout,
          error: mergeKillError(reason),
          exitCode: -1,
          evaluatorSummary: summary,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      };

      const killWithSuccess = (summary: string) => {
        killWorkerTree('evaluator-done');
        done({
          success: true,
          output: stdout || summary,
          exitCode: 0,
          evaluatorSummary: summary,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      };

      // Shared tail of every "the run looks alive, keep going" verdict in
      // checkAndMaybeKill. The idle trigger keeps its original semantics:
      // reset the idle timer, unbounded. The no-progress trigger (vi-2638f25056ba,
      // 2026-09-11) counts its extensions and force-kills at
      // NO_PROGRESS_MAX_EXTENDS — a run that keeps answering "alive" while
      // producing nothing usable for ~cap × the window is a spin the
      // error-loop counter cannot see, and unbounded extension would regress
      // the 2026-09-10 slot-starvation protection. The kill reason keeps the
      // greppable `agy-no-progress` marker.
      let noProgressExtends = 0;
      const extendAfterCheck = (trigger: 'idle' | 'no-progress', status: string): void => {
        if (trigger === 'no-progress') {
          noProgressExtends++;
          if (noProgressExtends >= NO_PROGRESS_MAX_EXTENDS) {
            const ageSec = Math.round((Date.now() - lastUsableOutputAt) / 1000);
            killWithMessage(`Killed: agy-no-progress — no usable output for ${ageSec}s (${noProgressExtends} liveness extensions without progress; forcing termination)`);
            return;
          }
          resetNoProgressTimer();
        } else {
          resetIdleTimer();
        }
        process.stdout.write(`\r  [check] ${worker.name}: ${status}    `);
      };

      // --- Idle timeout with "check before kill" ---
      // When idle timer fires, don't kill immediately. First analyze the conversation
      // state to see if the agent is actually working (pending tool call, active thinking)
      // or genuinely stuck (asking a question, retry loop).
      // If heuristics are inconclusive, escalate to a separate LLM evaluator.

      // Guard against concurrent evaluator invocations (heartbeat can reschedule the
      // idle timer while an evaluator call is already in flight).
      let evaluating = false;
      let maxExtensions = 0;
      // Track consecutive extend verdicts for the same stuck evaluation (P2-17)
      let consecutiveExtends = 0;

      const checkAndMaybeKill = async (trigger: 'idle' | 'no-progress' = 'idle') => {
        if (resolved) return;
        // An evaluation already in flight must not swallow a no-progress fire:
        // the one-shot timer is consumed either way, so re-arm it — if the
        // in-flight evaluation extends via extendAfterCheck it re-arms again,
        // which is harmless (clearTimeout + fresh setTimeout).
        if (evaluating) {
          if (trigger === 'no-progress') resetNoProgressTimer();
          return;
        }
        evaluating = true;

        try {
          // Mtime-freshness shortcut (2026-09-18 slow-machine RCA): a state
          // file written inside the firing timer's silence window proves the
          // worker is alive — extend without consulting the judge. The window
          // is min(60s, firing timer's duration) so pre-spawn fixtures (older
          // than their own timer by construction) always run the ladder below.
          const freshWindowMs = Math.min(
            EVALUATOR_MTIME_FRESH_MS,
            trigger === 'no-progress' ? agyNoProgressTimeoutMs() : idleTimeoutMs,
          );
          if (await isStateFreshForKillDecision(stateDir, statePattern, Date.now(), freshWindowMs)) {
            extendAfterCheck(trigger, 'state file updated inside the silence window — extending without judge...');
            return;
          }

          // Check 1: analyze conversation state file (high-signal heuristics)
          if (stateDir) {
            const state = await analyzeAgentState(stateDir, statePattern, worker.name);

            if (state.verdict === 'stuck') {
              // Stuck verdict resets the consecutive-extend counter
              consecutiveExtends = 0;
              killWithMessage(`Killed: ${state.status}`);
              return;
            }

            // Heuristic says "alive" or "unknown" — escalate to LLM evaluation
            // unless this worker IS the evaluator (prevents recursion)
            if (!options.isEvaluator) {
              process.stdout.write(`\r  [check] ${worker.name}: ${state.status} — consulting evaluator...    `);
              const verdict = await evaluateWorkerState(stateDir, statePattern, worker.name, options.env, executeWorker);
              if (verdict) {
                if (verdict.verdict === 'done') {
                  consecutiveExtends = 0;
                  killWithSuccess(verdict.summary);
                  return;
                }
                if (verdict.verdict === 'kill') {
                  consecutiveExtends = 0;
                  killWithSummary(
                    `Killed: LLM evaluator decided to stop (${verdict.reason})`,
                    verdict.summary,
                  );
                  return;
                }
                // verdict === 'extend'
                consecutiveExtends++;
                if (consecutiveExtends >= 3) {
                  killWithMessage(`Killed: ${consecutiveExtends} consecutive extend verdicts — forcing termination`);
                  return;
                }
                extendAfterCheck(trigger, `evaluator extending (${consecutiveExtends}/3) — ${verdict.summary}`);
                return;
              }
              // Evaluator unavailable/failed — fall through to heuristic result
              consecutiveExtends = 0;
              if (state.verdict === 'alive') {
                extendAfterCheck(trigger, `${state.status} — extending (no evaluator)...`);
                return;
              }
            } else if (state.verdict === 'alive') {
              // This IS the evaluator — use heuristic only, no recursion
              consecutiveExtends = 0;
              extendAfterCheck(trigger, `${state.status} — extending...`);
              return;
            }
          }

          // Check 2: process tree — if children exist, definitely alive
          // (For shell:true, we look for grandchildren, as the direct child is the worker itself)
          // fresh:true — this is a kill/extend DECISION: a ≤300ms-stale cached snapshot can
          // list a just-exited child as present and wrongly extend instead of killing (2026-08-31).
          if (child.pid && await hasChildProcesses(child.pid, true, undefined, true)) {
            extendAfterCheck(trigger, 'subprocess still running, extending...');
            return;
          }
        } catch {
          // Check failed — fall through to kill
        } finally {
          evaluating = false;
        }

        // No signal either way — kill. The no-progress trigger keeps its
        // greppable marker here too: a spin with no state file and no live
        // tool process must still show up as agy-no-progress in the logs
        // (vi-2638f25056ba, 2026-09-11).
        if (trigger === 'no-progress') {
          const ageSec = Math.round((Date.now() - lastUsableOutputAt) / 1000);
          killWithMessage(`Killed: agy-no-progress — no usable output for ${ageSec}s (no liveness signal from state or process tree)`);
        } else {
          killWithMessage(`Killed: no activity for ${idleTimeoutMs / 1000}s (idle timeout)`);
        }
      };

      let idleTimer = setTimeout(checkAndMaybeKill, idleTimeoutMs);

      const resetIdleTimer = (source?: string) => {
        clearTimeout(idleTimer);
        if (resolved) return;
        if (source) {
          process.stdout.write(`\r  [heartbeat] ${worker.name}: ${source}    `);
        }
        idleTimer = setTimeout(checkAndMaybeKill, idleTimeoutMs);
      };

      // 2026-09-10 incident: "[heartbeat] <worker>: subprocess running" reports
      // LIVENESS, not progress — a spinning agy stream keeps producing stdout
      // bytes forever, so this line alone made an 11-minute error loop look
      // identical to a healthy long-running task. Adds a progress marker for
      // the agy/agyc dialect only (steps seen, age of the last USABLE output);
      // unchanged for every other worker.
      const agyProgressMarker = (): string => {
        if (!isAgyStreamWorker(worker)) return 'subprocess running';
        const ageSec = Math.round((Date.now() - lastUsableOutputAt) / 1000);
        return `subprocess running (agy steps seen=${agyStepsSeen}, last-usable-output=${ageSec}s ago)`;
      };

      // BG-task tracking state
      const bgCfg = options.bgTasksConfig ?? { alert_seconds: 300, alert_repeat_seconds: 1800 };
      const bgAlertMs = bgCfg.alert_seconds * 1000;
      const bgRepeatMs = bgCfg.alert_repeat_seconds * 1000;
      const bgHooks = options._bgTaskHooks ?? {};
      const bgGetDescendants = bgHooks.getDescendantPids ?? getDescendantPids;
      const bgGetCmdlines = bgHooks.getCommandLines ?? getCommandLines;
      const bgAreAlive = bgHooks.areProcessesAlive ?? areProcessesAlive;
      const bgNotify = bgHooks.notifyUser ?? notifyUser;
      const bgGetSnapshot = _sweepDeps?.getProcessSnapshot ?? ((fresh?: boolean) => getProcessSnapshot(undefined, fresh));
      const bgKillTree = _sweepDeps?.killProcessTree ?? killProcessTree;
      const heartbeatMs = bgHooks.heartbeatIntervalMs ?? 30_000;
      const startedAt = Date.now();

      // Periodic heartbeat: checks process tree AND state file mtime
      // Re-entrancy guard (2026-09-12, 4th storm variant): under WMI pressure a
      // tick's async body (snapshot query + BFS) can outlast the interval
      // period. Without this guard, ticks stack and each stacked tick spawns
      // its own snapshot query, compounding the very storm the timed/cached
      // exec in process-tree.ts was meant to bound. tickInFlight is scoped to
      // this one worker's heartbeat (this whole block runs per executeWorker
      // invocation, not globally).
      let tickInFlight = false;
      let consecutiveSkippedTicks = 0;
      let warnedStuckHeartbeatTick = false;
      const heartbeatInterval = setInterval(() => {
        if (resolved || !child.pid) return;

        if (tickInFlight) {
          consecutiveSkippedTicks++;
          if (consecutiveSkippedTicks >= 3 && !warnedStuckHeartbeatTick) {
            warnedStuckHeartbeatTick = true;
            logger.info('worker-exec', 'heartbeat tick skipped — previous tick still in flight', {
              worker: worker.name,
              pid: child.pid,
              resource,
              consecutiveSkippedTicks,
            });
          }
          return;
        }
        tickInFlight = true;

        (async () => {
          if (resolved) return; // guard: done() may have fired while we were awaiting
          try {
            // Update blackboard heartbeat
            if (resolved) return;
            await blackboard.updateHeartbeat(resource, agentName, contextId);
            if (slotHandle !== 'disabled') {
              await blackboard.updateHeartbeat(slotHandle.slot, agentName, slotHandle.ctx).catch(err => logger.warn('worker-exec', 'heartbeat update failed during periodic heartbeat', { error: err?.message ?? String(err) }));
            }

            // BG-task tracking: one OS query → BFS in memory
            const rawDescendants = await bgGetDescendants(child.pid!);
            if (resolved) return; // guard: worker may have exited while querying OS
            // Stale-PPID guard (AI-328): Windows ParentProcessId is set at spawn
            // and never updated — a dead ancestor's pid can be reused by an
            // unrelated process, and BFS then pulls phantoms into the tree
            // (observed: 211 "descendants" incl. svchost/WUDFHost/fontdrvhost).
            // A process created BEFORE this run cannot be its descendant —
            // drop it here so bgTaskMap, bg-leak and the persisted reaper list
            // stay honest. The snapshot query coalesces with the one
            // getDescendantPids just issued (300ms TTL) → ~free.
            let descendants = rawDescendants;
            try {
              const snap = await bgGetSnapshot();
              if (snap.size > 0) {
                descendants = rawDescendants.filter(d => {
                  const rec = snap.get(d.pid);
                  return rec?.createdMs === undefined || rec.createdMs >= tsStartMs - 5_000;
                });
              }
            } catch { /* snapshot unavailable → keep raw list (pre-AI-328 behavior) */ }
            if (resolved) return;
            // Persist the live worker tree so the orphan reaper can check liveness
            // even after the shell wrapper (child.pid) dies with a crashed spawner.
            updateWorkerPidDescendants(child.pid!, descendants.map(d => d.pid)).catch(err => logger.warn('worker-exec', 'updateWorkerPidDescendants failed', { error: err?.message ?? String(err) }));
            const now = Date.now();
            const currentPids = new Set(descendants.map(d => d.pid));

            // Add new entries
            for (const { pid } of descendants) {
              if (!bgTaskMap.has(pid)) bgTaskMap.set(pid, { firstSeen: now, lastRepeatBucket: -1 });
            }
            // Drop gone PIDs
            for (const pid of bgTaskMap.keys()) {
              if (!currentPids.has(pid)) bgTaskMap.delete(pid);
            }
            // Batch-fetch cmdlines for new entries
            const needCmdline = [...bgTaskMap.entries()].filter(([, e]) => !e.cmdline).map(([pid]) => pid);
            if (needCmdline.length > 0) {
              const cmdlines = await bgGetCmdlines(needCmdline);
              for (const [pid, cmdline] of cmdlines) {
                const entry = bgTaskMap.get(pid);
                if (entry) entry.cmdline = sanitizeCmdline(cmdline);
              }
            }
            // Collect entries whose age bucket advanced — batched into one alert per heartbeat
            const alerting = collectBgAlerts(bgTaskMap, now, bgAlertMs, bgRepeatMs);
            if (alerting.length > 0) {
              const lines = alerting.map(a => `  PID ${a.pid} (age ${a.ageSec}s): ${a.cmdline}`);
              // Log only — no Telegram (2026-08-23). 88 of the week's 548 alerts were
              // bg-leak pages, and all 153 sampled bodies resolved to conhost.exe, pa's
              // own worker_stdout_tee.js wrapper, the worker binary, or its in-flight
              // tool call (npm test, a gh check-runs CI wait). Descendants ARE reaped
              // (killWorkerTree on every exit path); the real-leak detector is bg-orphan
              // below, which is post-exit and HAS a dedupKey — one occurrence ever.
              // The subject embedded a PID, so its dedup could never apply, and it is
              // not a threshold problem: CI waits legitimately exceed 30 minutes.
              // (plans/2026-08-23-alerts-week-review.md §5.1.)
              logger.info('worker-exec', 'bg-leak', {
                worker: worker.name,
                pid: child.pid,
                resource,
                descendants: alerting.length,
                detail: lines.join('\n').slice(0, 3500),
              });
            }

            // Check 1: process tree (idle-timer reset) — fresh read: kill/extend decision (2026-08-31)
            const hasChildren = await hasChildProcesses(child.pid!, true, undefined, true);
            if (hasChildren) {
              resetIdleTimer(agyProgressMarker());
              return;
            }

            // Check 2: state file mtime changed since last check
            if (stateDir) {
              const currentMtime = await getLatestStateMtime(stateDir, statePattern);
              if (currentMtime && (!lastKnownMtime || currentMtime > lastKnownMtime)) {
                lastKnownMtime = currentMtime;
                const state = await analyzeAgentState(stateDir, statePattern, worker.name);
                resetIdleTimer(state.status);
                return;
              }
            }
          } catch {
            // Heartbeat check failed — don't crash, just let idle timer continue
          }
        })().finally(() => {
          // Reset regardless of which path the tick exited through — including
          // the `if (resolved) return;` guard above, which runs BEFORE the
          // try/catch. An internal try/finally would miss that early-return
          // path and leave tickInFlight stuck true forever.
          tickInFlight = false;
          consecutiveSkippedTicks = 0;
          warnedStuckHeartbeatTick = false;
        });
      }, heartbeatMs);

      // Hard max timeout: absolute safety net with "check before kill" escalation
      const onMaxTimeout = async () => {
        if (resolved || evaluating) {
          // If evaluator is already running (via idle timer), wait for it
          maxTimer = setTimeout(onMaxTimeout, 30_000);
          return;
        }

        if (maxExtensions >= 2) {
          killWithMessage(`Killed: absolute timeout exceeded after ${maxExtensions} extensions`);
          return;
        }

        evaluating = true;
        try {
          // Escalate to LLM evaluation (skip heuristic check for hard timeout)
          if (!options.isEvaluator && stateDir) {
            process.stdout.write(`\r  [timeout] ${worker.name}: absolute timeout reached — consulting evaluator...    `);
            const verdict = await evaluateWorkerState(stateDir, statePattern, worker.name, options.env, executeWorker);
            if (verdict && verdict.verdict === 'extend') {
              maxExtensions++;
              process.stdout.write(`\r  [timeout] ${worker.name}: evaluator extending (extension ${maxExtensions}/2) — ${verdict.summary}    `);
              maxTimer = setTimeout(onMaxTimeout, maxTimeoutMs);
              return;
            }
          }
        } catch {
          // Check failed — fall through to kill
        } finally {
          evaluating = false;
        }

        killWithMessage(`Killed: exceeded max timeout of ${maxTimeoutMs / 1000}s`);
      };

      let maxTimer = setTimeout(onMaxTimeout, maxTimeoutMs);

      // Buffer for incomplete NDJSON lines across chunks
      let ndjsonBuffer = '';
      // For agy (Gemini-format events): track the stdout position after the last tool_result event.
      // On exit, we trim stdout to only keep content accumulated after this point,
      // discarding all intermediate planning narration from multi-step tool use.
      let lastToolBoundary = 0;

      // Wall-clock no-progress guard (agy/agyc only, see agyNoProgressTimeoutMs
      // above): reset whenever usable output arrives; fires when none has for
      // that long, even if the stream keeps emitting bytes (which is exactly
      // what a spinning agy run does, and why the plain idle timer never
      // catches it — see AGY_ERROR_LOOP_THRESHOLD's comment for the incident).
      // vi-2638f25056ba (2026-09-11): the fire escalates through
      // checkAndMaybeKill (state analyzer → evaluator → process tree) instead
      // of killing outright — a run that is merely slow on the starved D: HDD
      // gets extended (bounded by NO_PROGRESS_MAX_EXTENDS) instead of having
      // minutes of real work discarded; the kill-reason `agy-no-progress`
      // marker now only appears when the ladder finds no liveness or the cap
      // is exhausted.
      let noProgressTimer: NodeJS.Timeout | undefined;
      const resetNoProgressTimer = () => {
        if (!isAgyStreamWorker(worker) || resolved) return;
        clearTimeout(noProgressTimer);
        noProgressTimer = setTimeout(() => {
          void checkAndMaybeKill('no-progress');
        }, agyNoProgressTimeoutMs());
      };
      resetNoProgressTimer();

      // UTF-8 decoders that survive pipe-chunk boundaries (ai246 WP-E,
      // 2026-09-15): data.toString() decodes each chunk on its own, so a
      // multi-byte char split across two OS reads (an em-dash inside a
      // PA_META envelope was the live casualty — U+FFFD fragments broke
      // JSON.parse and silently dropped spawn_thread actions) corrupts at
      // every boundary. StringDecoder holds the trailing partial sequence
      // until the rest arrives; the close handler flushes any remainder.
      // The tee still writes the raw Buffer — byte-exact, unaffected.
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');

      child.stdout?.on('data', (data: Buffer) => {
        if (teeWriteStream) teeWriteStream.write(data);
        const chunk = stdoutDecoder.write(data);
        if (isStreamJson) {
          // Buffer chunks and process complete lines only
          ndjsonBuffer += chunk;
          const lines = ndjsonBuffer.split('\n');
          // Keep the last element (may be incomplete) in the buffer
          ndjsonBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              trace.observe(event);

              // Session ID detection
              if (event.sessionId) capturedSessionId = event.sessionId;
              if (event.session_id) capturedSessionId = event.session_id;
              if (event.type === 'init' && event.session_id) capturedSessionId = event.session_id;
              // Codex: { type: 'thread.started', thread_id: '...' }
              if (event.type === 'thread.started' && event.thread_id) capturedSessionId = event.thread_id;

              // Codex error events: {"type":"error","message":"..."} — capture for rate-limit detection
              if (event.type === 'error' && typeof event.message === 'string' && worker.name === 'codex') {
                codexStreamError += (codexStreamError ? '\n' : '') + event.message;
              }

              // Codex proactive rate-limit telemetry from token_count events.
              if (event.type === 'event_msg'
                  && event.payload?.type === 'token_count'
                  && event.payload?.rate_limits?.primary) {
                const p = event.payload.rate_limits.primary;
                if (typeof p.used_percent === 'number'
                    && typeof p.window_minutes === 'number'
                    && typeof p.resets_at === 'number') {
                  lastCodexTelemetry = {
                    usedPercent: p.used_percent,
                    windowMinutes: p.window_minutes,
                    resetsAt: p.resets_at,
                  };
                }
              }

              // Tool boundary tracking (agy): record stdout position after each tool_result
              // so we can discard intermediate planning narration on exit.
              if (event.type === 'tool_result' && isAgyStreamWorker(worker)) {
                lastToolBoundary = stdout.length;
              }

              // Codex: { type: 'item.completed', item: { type: 'agent_message', text: '...' } }
              if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
                stdout += event.item.text;
              }

              // Result (final output)
              if (event.type === 'result' && event.result) {
                stdout = event.result; // result replaces accumulated assistant text
              } else if (event.type === 'assistant' || (event.type === 'message' && event.role === 'assistant')) {
                // Accumulate streaming content
                // Claude: { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
                // agy (Gemini format): { type: 'message', role: 'assistant', content: '...' }
                const content = event.message?.content || event.content;
                if (typeof content === 'string') {
                  stdout += content;
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'text' && block.text) {
                      stdout += block.text;
                    }
                  }
                }
              }

              // agy stream-json: uses event.event (not event.type) as discriminator.
              // Gated on worker name to prevent non-agy workers from matching.
              if (isAgyStreamWorker(worker) && event.event) {
                // Session ID from init event (belt) and result event (suspenders)
                if ((event.event === 'init' || event.event === 'result') && typeof event.conversation_id === 'string') {
                  capturedSessionId = event.conversation_id;
                }
                // Also capture from event.result.conversation_id for result events (belt-and-suspenders)
                if (event.event === 'result' && event.result && typeof event.result === 'object' && typeof event.result.conversation_id === 'string') {
                  capturedSessionId = event.result.conversation_id;
                }
                // Result event: extract final response
                if (event.event === 'result' && event.result && typeof event.result === 'object') {
                  agyResultSeen = true;
                  if (typeof event.result.response === 'string') {
                    stdout = event.result.response;
                  }
                  // 2026-09-10 fix: the quota-exhaustion phrase (and any other
                  // terminal-fault text) lives on `.error`, NOT `.response` — a
                  // real "Individual quota reached..." result event carries
                  // status:"ERROR", response:"" (or unrelated narration text)
                  // and the actual message on `.error`. Reading only `.response`
                  // silently dropped the phrase before it ever reached the
                  // rate-limit classifier (verified against real production agy
                  // result events — every sampled quota-exhaustion terminal
                  // event had status:"ERROR" with the quota text exclusively on
                  // `.error`). Fall back to `.response` when `.error` is absent
                  // so the pre-existing (synthetic) shape keeps working.
                  if (event.result.status && event.result.status !== 'SUCCESS') {
                    const errText = typeof event.result.error === 'string' && event.result.error
                      ? event.result.error
                      : (typeof event.result.response === 'string' ? event.result.response : '');
                    if (errText) agyStreamError += (agyStreamError ? '\n' : '') + errText;
                  } else if (typeof event.result.response === 'string' && event.result.response.trim()) {
                    lastUsableOutputAt = Date.now();
                    resetNoProgressTimer();
                  }
                }
                // step_update: track error-loop/no-progress state (see
                // AGY_ERROR_LOOP_THRESHOLD/agyNoProgressTimeoutMs above) and
                // accumulate text_delta as fallback (used if no result event).
                if (event.event === 'step_update') {
                  agyStepsSeen++;
                  const su = event.step_update;
                  const usableText = typeof su?.text_delta === 'string' && su.text_delta.trim().length > 0 && !isNarrationOnly(su.text_delta);
                  if (su?.step_type === 'error_message') {
                    agyConsecutiveErrorSteps++;
                  } else if (usableText) {
                    agyConsecutiveErrorSteps = 0;
                  }
                  if (usableText) {
                    lastUsableOutputAt = Date.now();
                    resetNoProgressTimer();
                  }
                  if (su?.text_delta && !agyResultSeen) {
                    stdout += su.text_delta;
                  }
                  if (!resolved && agyConsecutiveErrorSteps >= AGY_ERROR_LOOP_THRESHOLD) {
                    killWithMessage(`Killed: agy-error-loop after ${agyConsecutiveErrorSteps} consecutive error_message steps — no usable output (worker: ${worker.name})`);
                    return;
                  }
                }

                // Extract usage from agy events
                const usage = extractUsageFromEvent(event, worker.name);
                if (usage) capturedUsage = usage;
              }
            } catch {
              // Malformed JSON line — skip
            }
          }
        } else {
          stdout += chunk;
        }
        resetIdleTimer();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += stderrDecoder.write(data);
        resetIdleTimer();
      });

      child.on('error', (err: Error) => {
        logger.warn('worker-exec', 'spawn-failed', { worker: worker.name, exitCode: -1, stderr_excerpt: err.message });
        notifyUser(
          `Worker spawn failed: ${worker.name}`,
          `Failed to start ${worker.name}: ${err.message}\nResource: ${resource}`,
          { dedupKey: `worker-spawn-${worker.name}`, severity: 'error' },
        ).catch(err => logger.warn('worker-exec', 'notifyUser failed for spawn error', { error: err?.message ?? String(err) }));
        done({
          success: false,
          output: stdout,
          error: `Failed to start ${worker.name}: ${err.message}`,
          exitCode: -1,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      });

      child.on('close', (code: number | null) => {
        // Flush the decoders first — a multi-byte char split across the final
        // chunk boundary is still buffered inside them (see the StringDecoder
        // comment at the stdout handler).
        const stdoutTail = stdoutDecoder.end();
        const stderrTail = stderrDecoder.end();
        if (stderrTail) stderr += stderrTail;
        if (stdoutTail) {
          if (isStreamJson) ndjsonBuffer += stdoutTail;
          else stdout += stdoutTail;
        }
        // Flush any remaining NDJSON buffer content
        if (isStreamJson && ndjsonBuffer.trim()) {
          try {
            const event = JSON.parse(ndjsonBuffer);
            trace.observe(event);
            if (event.type === 'thread.started' && event.thread_id) capturedSessionId = event.thread_id;
            // Codex error events in trailing buffer (no terminating newline)
            if (event.type === 'error' && typeof event.message === 'string' && worker.name === 'codex') {
              codexStreamError += (codexStreamError ? '\n' : '') + event.message;
            }
            // Codex telemetry in trailing buffer
            if (event.type === 'event_msg'
                && event.payload?.type === 'token_count'
                && event.payload?.rate_limits?.primary) {
              const p = event.payload.rate_limits.primary;
              if (typeof p.used_percent === 'number'
                  && typeof p.window_minutes === 'number'
                  && typeof p.resets_at === 'number') {
                lastCodexTelemetry = {
                  usedPercent: p.used_percent,
                  windowMinutes: p.window_minutes,
                  resetsAt: p.resets_at,
                };
              }
            }
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
              stdout += event.item.text;
            } else if (event.type === 'tool_result' && isAgyStreamWorker(worker)) {
              lastToolBoundary = stdout.length;
            } else if (event.type === 'result' && event.result) {
              stdout = event.result;
            } else if (event.type === 'assistant' || (event.type === 'message' && event.role === 'assistant')) {
              const content = event.message?.content || event.content;
              if (typeof content === 'string') {
                stdout += content;
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) {
                    stdout += block.text;
                  }
                }
              }
            }

            // agy stream-json: trailing buffer flush (same logic as stdout handler)
            if (isAgyStreamWorker(worker) && event.event) {
              if ((event.event === 'init' || event.event === 'result') && typeof event.conversation_id === 'string') {
                capturedSessionId = event.conversation_id;
              }
              if (event.event === 'result' && event.result && typeof event.result === 'object' && typeof event.result.conversation_id === 'string') {
                capturedSessionId = event.result.conversation_id;
              }
              if (event.event === 'result' && event.result && typeof event.result === 'object') {
                agyResultSeen = true;
                if (typeof event.result.response === 'string') {
                  stdout = event.result.response;
                }
                // Same `.error`-preferring fix as the live stdout handler above.
                if (event.result.status && event.result.status !== 'SUCCESS') {
                  const errText = typeof event.result.error === 'string' && event.result.error
                    ? event.result.error
                    : (typeof event.result.response === 'string' ? event.result.response : '');
                  if (errText) agyStreamError += (agyStreamError ? '\n' : '') + errText;
                }
              }
              if (event.event === 'step_update' && event.step_update?.text_delta && !agyResultSeen) {
                stdout += event.step_update.text_delta;
              }

              // Extract usage from agy events in trailing buffer
              const usage = extractUsageFromEvent(event, worker.name);
              if (usage) capturedUsage = usage;
            }
          } catch {
            // Final buffer wasn't valid JSON — ignore
          }
        }

        // agy tool-boundary trim: discard all content accumulated before the last
        // tool_result. This strips intermediate planning narration from multi-step
        // tool-use conversations, keeping only the final response segment.
        //
        // DO NOT REGRESS the "trimmed still has content" guard. lastToolBoundary is
        // reset to stdout.length after EVERY tool_result, so any run whose final stream
        // event is a tool call with no assistant text after it ends with
        // lastToolBoundary === stdout.length — an unguarded slice then yields '' and pa
        // deletes the model's entire output. That is the likeliest explanation for the
        // 0-byte ~/.pa/logs/oracle/20260717-081242-b56c4e.log after a 436s run recorded
        // as success. It became actively dangerous once run.ts started treating empty
        // stdout from a telegram_output skill as a hard failure: a CORRECT agy
        // run would be scored a failure, and three of those in a row park the skill via
        // the AI-098 backoff and page the user — a self-inflicted outage. A NO_OUTPUT
        // sentinel in the skill prompt cannot defend against this, because the trim
        // happens downstream of whatever the model actually printed.
        //
        // Whitespace-only trims fall back too, not just empty ones: every downstream
        // consumer compares on trimmed output, so a "\n\n" survivor is indistinguishable
        // from '' — and whitespace is not a final response segment worth paying the
        // whole output for. Runs that DID emit text after the last tool call are
        // unaffected; they trim exactly as before.
        if (isAgyStreamWorker(worker) && lastToolBoundary > 0) {
          const trimmed = stdout.slice(lastToolBoundary);
          if (trimmed.trim()) stdout = trimmed;
        }

        // Clear the heartbeat line
        if (stateDir) process.stdout.write('\r' + ' '.repeat(60) + '\r');
        // Merge codex and agy stream errors into the error field so rate-limit detection can see them
        const combinedError = [codexStreamError, agyStreamError, stderr, code !== 0 && !codexStreamError && !agyStreamError && !stderr ? `Exited with code ${code}` : '']
          .filter(Boolean).join('\n') || undefined;
        if (code !== 0) {
          logger.warn('worker-exec', 'spawn-failed', { worker: worker.name, exitCode: code, stderr_excerpt: (combinedError ?? '').slice(0, 1000) });
          // Alert on non-zero exit (suppressed during mid-failover when
          // suppressExitAlert is set, and when the caller cancelled the run —
          // a /stop-killed worker is a user action, not an outage worth paging).
          // A throwing predicate must not escape this close handler.
          let exitWasCancelled = false;
          try { exitWasCancelled = options.isCancelled?.() === true; } catch { /* page as normal */ }
          if (!options.suppressExitAlert && !exitWasCancelled) {
            const resourceKey = options.resource ?? 'unknown';
            notifyUser(
              `Worker exited with code ${code}: ${worker.name}`,
              `Worker: ${worker.name}\nResource: ${resourceKey}\nExit code: ${code}\nError: ${(combinedError ?? '').slice(0, 500)}`,
              { dedupKey: `worker-exit-${worker.name}-${resourceKey}`, severity: 'error' },
            ).catch(err => logger.warn('worker-exec', 'notifyUser failed for exit alert', { error: err?.message ?? String(err) }));
          }
        }
        done({
          success: code === 0,
          output: stdout,
          error: combinedError,
          exitCode: code,
          sessionId: capturedSessionId,
          teePath,
          rateLimitTelemetry: lastCodexTelemetry,
        });

        // Post-run hook: append usage to ledger if available (best-effort, never breaks the dispatch)
        if (capturedUsage) {
          const usageRecord: UsageRecord = {
            ts: new Date().toISOString(),
            worker: worker.name,
            resource,
            tokensIn: capturedUsage.tokensIn,
            tokensOut: capturedUsage.tokensOut,
            tokensThinking: capturedUsage.tokensThinking,
            tokensCacheRead: capturedUsage.tokensCacheRead,
          };
          // Best-effort append — fire-and-forget, don't await
          appendUsage(usageRecord).catch(err => logger.warn('worker-exec', 'Failed to append usage record', { error: err?.message ?? String(err) }));
        }

        // Model-router telemetry (WP-G, plans/2026-09-18-model-router-SPEC.md §8.2):
        // ONE line per SUCCESSFUL stream-json dispatch while a model_router block
        // exists — token usage + latency for shadow disagreement joins. Fire-and-
        // forget, never alters the exit path, no turn text in the record.
        if (code === 0 && isStreamJson) {
          const telemModel = trace.model;
          const telemDurationMs = Date.now() - tsStartMs;
          const telemInput = capturedUsage?.tokensIn;
          const telemOutput = capturedUsage?.tokensOut;
          void (async () => {
            try {
              const cfg = await loadConfig();
              if (!cfg?.model_router) return;
              await appendTelemetryRecord({
                at: new Date().toISOString(),
                worker: worker.name,
                ...(telemModel !== undefined ? { model: telemModel } : {}),
                durationMs: telemDurationMs,
                ...(telemInput !== undefined ? { inputTokens: telemInput } : {}),
                ...(telemOutput !== undefined ? { outputTokens: telemOutput } : {}),
              });
            } catch {
              // best-effort — never alters the exit path
            }
          })();
        }

        // Post-exit orphan sweep: fire-and-forget, does not block the result.
        // AI-328: verified survivors are REAPED, not just alerted on — done()
        // already removed the worker-pids registry entry, so the periodic
        // cleanupOrphanedWorkers reaper never learns about them; without the
        // kill here they persist (the bg-orphan alerts this produced were the
        // symptom). partitionVerifiedTreeMembers strips stale-PPID phantoms
        // and pid-reuse victims from the kill set — a survivor whose live
        // ancestry or creation time doesn't belong to this run's family is
        // skipped and only logged, never taskkilled.
        if (bgTaskMap.size > 0 && child.pid) {
          const workerPid = child.pid;
          const tracked = Array.from(bgTaskMap.keys());
          bgAreAlive(tracked).then(async alive => {
            const orphans = tracked.filter(pid => alive.get(pid));
            if (orphans.length === 0) return;
            // verified: partitioned OK → reaped. unverifiable: snapshot
            // missing/failed → never killed, but still alert-worthy (the
            // pre-AI-328 alert-only contract survives as the degraded path).
            let reaped: number[] = [];
            let foreign: number[] = [];
            let unverifiable = false;
            try {
              const snapshot = await bgGetSnapshot(true);
              if (snapshot.size > 0) {
                const part = partitionVerifiedTreeMembers(
                  orphans, workerPid, tracked, snapshot, tsStartMs - 5_000,
                );
                reaped = part.verified;
                foreign = part.foreign;
              } else {
                unverifiable = true;
              }
            } catch { unverifiable = true; }
            for (const pid of reaped) bgKillTree(pid);
            if (foreign.length > 0) {
              logger.info('worker-exec', 'orphan sweep skipped non-family survivors', {
                worker: worker.name, resource, pid: workerPid, skipped: foreign,
              });
            }
            // Alert on what was ours (reaped) or what we cannot rule out
            // (unverifiable). foreign-only survivors are not this worker's
            // mess — log-only above, no page.
            const reported = unverifiable ? orphans : reaped;
            if (reported.length > 0) {
              const tag = (pid: number) => reaped.includes(pid) ? 'reaped'
                : foreign.includes(pid) ? 'skipped: not verified as this worker\'s descendant'
                : 'unverifiable: no snapshot — left running';
              const lines = reported.map(pid => {
                const entry = bgTaskMap.get(pid);
                return `  PID ${pid} (${tag(pid)}): ${entry?.cmdline ?? '(unknown)'}`;
              });
              const body = `Worker: ${worker.name} (pid ${workerPid}) exited with ${orphans.length} descendant(s) still running — reaped ${reaped.length}, skipped ${foreign.length} non-family${unverifiable ? ', snapshot unavailable — nothing killed' : ''}:\n${lines.join('\n')}`;
              bgNotify(
                `bg-orphan: ${reported.length} orphaned descendant(s) of ${worker.name}`,
                body.slice(0, 3500),
                { dedupKey: `bg-orphan-${startedAt}-${workerPid}` },
              ).catch(err => logger.warn('worker-exec', 'bgNotify failed for bg-orphan alert', { error: err?.message ?? String(err) }));
            }
          }).catch(err => logger.warn('worker-exec', 'orphan sweep failed', { error: err?.message ?? String(err) }));
        }
      });
    });

    if (promptFile) {
      try { await unlink(promptFile); } catch {}
    }

    return result;
  } finally {
    // AI-255 B4: reservations a dispatched worker claimed (they carry
    // PA_WORKER_DISPATCH_ID via `pa claim`'s auto-fill) release on dispatch
    // settlement — claims must not outlive the work they guarded. Awaited
    // but .catch-swallowed: a ~10ms store write that can't fail the result,
    // and a fire-and-forget write would race callers tearing down PA_HOME.
    await releaseReservations({ dispatchId }).catch((err) =>
      logger.warn('worker-exec', 'reservation release by dispatchId failed', {
        dispatchId, error: err?.message ?? String(err),
      }));
    await blackboard.releaseLock(resource, agentName, contextId);
    if (slotHandle !== 'disabled') {
      await blackboard.releaseLock(slotHandle.slot, agentName, slotHandle.ctx).catch(err => logger.warn('worker-exec', 'releaseLock failed for slot', { error: err?.message ?? String(err) }));
    }
  }
}

// ---------------------------------------------------------------------------
// Worker admission control (AI-096 item 3)
// ---------------------------------------------------------------------------

const SLOT_RETRY_MS = 5_000;
const ROUTING_SLOT_RETRY_MS = 250;

export function workerSlotCount(): number {
  const { ceiling, origin } = resolveCeiling();
  if (ceiling <= 0) return ceiling;
  return effectiveSlotCount(ceiling, origin);
}

export interface WorkerSlotHandle { slot: string; ctx: string }

/**
 * Acquire one of N machine-wide worker slots via the blackboard (cross-process).
 * Returns 'disabled' when PA_MAX_CONCURRENT_WORKERS <= 0 (no limiting), a
 * handle when a slot was acquired, or null when maxWaitMs elapsed with every
 * slot busy. Each acquisition uses a fresh contextId so same-PID concurrent
 * spawns (the bot) still exclude each other. opts.priority === 'routing' waits
 * at the 250ms cadence instead of the 5s normal one — for short-lived routing
 * dispatches only. The slot-scan bound re-reads the EFFECTIVE slot count at the
 * top of every pass, so a queue that outlives a cap change adopts it next pass.
 */
export async function acquireWorkerSlot(
  agent: string,
  maxWaitMs: number,
  bb: Pick<typeof blackboard, 'acquireLock'> = blackboard,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onRetry?: () => Promise<void>,
  opts?: { priority?: 'routing' | 'normal' },
): Promise<WorkerSlotHandle | 'disabled' | null> {
  // Hoisted disabled check: a cap <= 0 never enters the dynamic path. With
  // ceiling > 0 the dynamic effective is always >= 1, so it can never regress
  // to disabled mid-wait — the loop re-reads the effective count per pass.
  if (workerSlotCount() <= 0) return 'disabled';
  const ctx = randomUUID();
  const start = Date.now();
  do {
    const n = workerSlotCount();
    for (let i = 0; i < n; i++) {
      const slot = `worker-slot-${i}`;
      // timeoutMs=50 → effectively a single acquisition attempt per slot (the
      // acquire loop's internal retry sleeps 1s, past the budget), while giving
      // enough headroom that a stray 1ms clock tick can't zero out the attempt.
      if (await bb.acquireLock(slot, agent, process.pid, 50, ctx)) return { slot, ctx };
    }
    if (onRetry) await onRetry();
    await sleepFn(opts?.priority === 'routing' ? ROUTING_SLOT_RETRY_MS : SLOT_RETRY_MS);
  } while (Date.now() - start < maxWaitMs);
  return null;
}
