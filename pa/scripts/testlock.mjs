#!/usr/bin/env node
// Suite-serialization lock helper (suite-lock holder identity, 2026-09-13):
// makes the machine-global test-suite lock holder-identifiable so a waiter or
// a human can see WHO holds it without process archaeology. The lock is a
// directory; the HOLDER file inside it carries {session, pid, at}.
//
// Public-tree script: no repo paths, no PII — the only literal path is the
// machine-global lock directory itself.
//
// Usage:
//   node testlock.mjs acquire <session-label> [--remove-stale]
//   node testlock.mjs release [<session-label>] [--force]
//   node testlock.mjs status
//
// Exit codes: 0 = success (including "free / nothing to release");
// 1 = failure (acquire timeout, release refusal, usage error).
//
// Acquire waits for a held lock, printing the holder, and exits 1 on timeout.
// Release clears the lock only when the caller IS the holder: the calling
// process's pid matches HOLDER.pid, or the caller names the exact session
// label stored in HOLDER, or the lock has no HOLDER file at all
// (pre-convention lock). Anything else needs --force, which prints a lead
// sanction note — the caller asserts the sanction by passing the flag.
//
// AI-255 C1 (2026-09-16): HOLDER also carries `beat` (ISO, refreshed by the
// bus-inject hooks on every tool call while the owning session is alive —
// `pid` is the short-lived acquirer, NOT the session, so a dead `pid` alone
// never proves staleness) and `sessionPid` when the owner can be resolved
// (explicit --owner-pid, or the session label matches a bus-registry entry's
// address/nativeSessionId → that entry's pid, which IS the session host).
// `acquire --remove-stale` clears a held lock when beat/at has aged past
// PA_TESTLOCK_STALE_MS (default 30 min — an idle-but-alive holder) OR when a
// resolved sessionPid is dead (the owning session is gone outright). On
// acquire timeout the holder's session, when it resolves to a live bus
// address, gets a best-effort `pa bus send` nudge; PA_TESTLOCK_NO_NUDGE=1
// disables it.
//
// Destructive no-HOLDER decisions (acquire --remove-stale, bare release)
// re-read once after a short grace beat: a lock directory can legitimately
// exist for a few hundred ms without a HOLDER while its acquirer is still
// setting up, and the grace means such a lock is never mistaken for stale.
// A genuinely stale pre-convention lock has been sitting for hours, so the
// grace cannot resurrect it. --remove-stale then does rmdir + mkdir in this
// single invocation (the race Rule 18 warns about is two tool-call
// round-trips, not two syscalls in one process) and prints an evidence line.
//
// Test injection: PA_TESTLOCK_DIR overrides the lock directory (tests always
// set it; they never touch the default). PA_TESTLOCK_POLL_MS,
// PA_TESTLOCK_WAIT_MS and PA_TESTLOCK_GRACE_MS override the timing constants
// for the same reason — tests must not wait real minutes. Production defaults:
// poll 60 s, give up after 30 min, grace 250 ms.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const LOCK_DIR_ENV = 'PA_TESTLOCK_DIR';
const POLL_MS_ENV = 'PA_TESTLOCK_POLL_MS';
const WAIT_MS_ENV = 'PA_TESTLOCK_WAIT_MS';
const GRACE_MS_ENV = 'PA_TESTLOCK_GRACE_MS';
const STALE_MS_ENV = 'PA_TESTLOCK_STALE_MS';
const NO_NUDGE_ENV = 'PA_TESTLOCK_NO_NUDGE';
const POLL_MS_DEFAULT = 60_000;
const WAIT_MS_DEFAULT = 30 * 60_000;
const GRACE_MS_DEFAULT = 250;
const STALE_MS_DEFAULT = 30 * 60_000;

const DEFAULT_LOCK_DIR = 'C:/wt/test.lock';

function lockDir() {
  return process.env[LOCK_DIR_ENV] || DEFAULT_LOCK_DIR;
}

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read + parse the HOLDER file. Kinds:
//   free               — lock directory absent
//   no-holder          — directory present, no HOLDER file (pre-convention,
//                        or an acquirer mid-setup — hence the grace re-read)
//   holder             — HOLDER present and valid JSON ({session, pid, at})
//   holder-unreadable  — HOLDER present but not valid JSON; treated as
//                        foreign: refuse without --force
export function readHolder(dir = lockDir()) {
  if (!existsSync(dir)) return { kind: 'free' };
  const holderPath = join(dir, 'HOLDER');
  if (!existsSync(holderPath)) return { kind: 'no-holder' };
  try {
    return { kind: 'holder', holder: JSON.parse(readFileSync(holderPath, 'utf8')) };
  } catch {
    return { kind: 'holder-unreadable' };
  }
}

// True only when the lock is STILL bare after the grace beat. Returns false
// when it became held meanwhile (caller re-reads for the reason).
async function stillBareAfterGrace(dir, graceMs) {
  if (readHolder(dir).kind !== 'no-holder') return false;
  await sleep(graceMs);
  return readHolder(dir).kind === 'no-holder';
}

// ---- AI-255 C1: session-liveness staleness + re-wake nudge ----

function busRegistry() {
  try {
    const home = process.env.PA_HOME || join(homedir(), '.pa');
    const data = JSON.parse(readFileSync(join(home, 'queues', 'registry.json'), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

// Map a HOLDER.session label to its live bus-registry entry: the label may BE
// a registered address, match an entry's nativeSessionId, or match an entry's
// pid (a raw session-pid label). Returns { address, pid } or null.
function resolveHolderBusEntry(session) {
  if (typeof session !== 'string' || session === '') return null;
  const reg = busRegistry();
  if (reg[session] && typeof reg[session] === 'object') {
    return { address: session, pid: typeof reg[session].pid === 'number' ? reg[session].pid : undefined };
  }
  for (const [address, entry] of Object.entries(reg)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.nativeSessionId === session) {
      return { address, pid: typeof entry.pid === 'number' ? entry.pid : undefined };
    }
  }
  return null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true; // unprobeable ⇒ assume alive
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // EPERM = exists, no signal rights; ESRCH/other = dead
  }
}

// Resolve the owning session's host pid: explicit --owner-pid wins, else the
// bus-registry entry for the session label carries it (WP-A hooks register
// the session's pid). Absent both = no pid signal; staleness falls back to
// beat-age only — a CLI-invoked `acquire`'s own pid dies with the command and
// must NEVER be used as the liveness probe.
function resolveSessionPid(session, explicit) {
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return resolveHolderBusEntry(session)?.pid;
}

// A held lock is stale when its heartbeat/acquire age exceeds staleMs, OR a
// resolved sessionPid is dead (the owning session exited — orphaned lock,
// age-independent). `at` is the fallback timestamp for pre-heartbeat HOLDERs.
function holderStaleness(holder, staleMs, now = Date.now()) {
  const beatMs = Date.parse(holder?.beat ?? '') || Date.parse(holder?.at ?? '');
  const age = Number.isFinite(beatMs) ? now - beatMs : Number.POSITIVE_INFINITY;
  const sessionPid = Number.isInteger(holder?.sessionPid) ? holder.sessionPid : undefined;
  const pidDead = sessionPid !== undefined && !pidAlive(sessionPid);
  return {
    stale: age > staleMs || pidDead,
    ageMs: age,
    sessionPid,
    pidDead,
  };
}

// Default re-wake nudge: `pa bus send` to the holder's resolved address. Never
// blocks the timeout exit — sync spawn with a hard timeout, every failure
// swallowed. Tests inject opts.nudge or set PA_TESTLOCK_NO_NUDGE.
function defaultNudge(toAddress, body) {
  const pa = process.env.PA_CLI || 'pa';
  execFileSync(pa, ['bus', 'send', toAddress, '--from', 'testlock', '--body', body], {
    shell: true,
    windowsHide: true,
    timeout: 10_000,
    stdio: 'ignore',
  });
}

function holderLine(state) {
  if (state.kind === 'holder') return `lock held — HOLDER: ${JSON.stringify(state.holder)}`;
  if (state.kind === 'no-holder') return 'lock held — no HOLDER file (pre-convention lock)';
  return 'lock held — HOLDER present but unreadable';
}

// Poll until the lock is free (or --remove-stale clears a bare one), then
// claim it. The mkdir→HOLDER window is real: the directory IS the lock, the
// HOLDER file is metadata written right after.
export async function acquireLock(session, opts = {}) {
  const dir = opts.dir ?? lockDir();
  const pollMs = opts.pollMs ?? envMs(POLL_MS_ENV, POLL_MS_DEFAULT);
  const waitMs = opts.waitMs ?? envMs(WAIT_MS_ENV, WAIT_MS_DEFAULT);
  const graceMs = opts.graceMs ?? envMs(GRACE_MS_ENV, GRACE_MS_DEFAULT);
  const removeStale = opts.removeStale === true;
  const notice = opts.notice ?? ((line) => console.log(line));
  const deadline = Date.now() + waitMs;
  let lastNotice = '';

  for (;;) {
    // Ensure the parent exists, then claim with a NON-recursive mkdir: the
    // EEXIST (or any) failure is the contention signal.
    const parent = dirname(dir);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    let claimed = false;
    try {
      mkdirSync(dir);
      claimed = true;
    } catch {
      claimed = false;
    }
    if (claimed) {
      const nowIso = new Date().toISOString();
      const holder = {
        session,
        pid: process.pid,
        at: nowIso,
        beat: nowIso,
        sessionPid: resolveSessionPid(session, opts.ownerPid),
      };
      writeFileSync(join(dir, 'HOLDER'), JSON.stringify(holder) + '\n', 'utf8');
      return { ok: true, holder };
    }

    const state = readHolder(dir);
    if (state.kind === 'no-holder' && removeStale && (await stillBareAfterGrace(dir, graceMs))) {
      let contents;
      try {
        contents = readdirSync(dir).join(', ') || '(empty)';
      } catch {
        contents = '(unreadable)';
      }
      notice(`removed stale no-HOLDER lock at ${dir} (contents: ${contents}) — re-acquiring in one invocation`);
      rmSync(dir, { recursive: true, force: true });
      continue; // next iteration's mkdir claims it, still inside THIS invocation
    }

    // AI-255 C1: a HELD lock can also be stale — heartbeat aged out (idle
    // holder) or its resolved session pid is dead (session gone). Evidence
    // line names which signal fired; never removes on the short-lived
    // acquirer `pid` alone.
    if (state.kind === 'holder' && removeStale) {
      const staleMs = envMs(STALE_MS_ENV, STALE_MS_DEFAULT);
      const staleness = holderStaleness(state.holder, staleMs);
      if (staleness.stale) {
        const why = staleness.pidDead
          ? `session pid ${staleness.sessionPid} is dead`
          : `heartbeat/acquire age ${Math.round(staleness.ageMs / 1000)}s > ${Math.round(staleMs / 1000)}s`;
        notice(`removed stale held lock (HOLDER ${JSON.stringify(state.holder)}) — ${why} — re-acquiring`);
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
    }

    const line = holderLine(state);
    if (line !== lastNotice) {
      notice(line);
      lastNotice = line;
    }
    if (Date.now() >= deadline) {
      // Re-wake nudge: the holder's session resolves to a live bus address →
      // ask it to release or keep heartbeating. Best-effort, never blocks.
      if (state.kind === 'holder' && opts.nudge !== false && !process.env[NO_NUDGE_ENV]) {
        const entry = resolveHolderBusEntry(state.holder?.session);
        if (entry) {
          const body = `You hold the test-suite lock (session "${state.holder.session}", acquired ${state.holder.at}) — release it or keep working so its heartbeat stays fresh; a waiter just timed out.`;
          try {
            await (opts.nudge ?? defaultNudge)(entry.address, body);
            notice(`nudged ${entry.address} on the bus to release the test lock`);
          } catch {
            /* best-effort — a nudge failure must not shadow the timeout */
          }
        }
      }
      return { ok: false, reason: 'timeout', state };
    }
    await sleep(Math.max(Math.min(pollMs, deadline - Date.now()), 1));
  }
}

// Release only what this caller is entitled to release. See the header
// comment for the entitlement rules.
export async function releaseLock(opts = {}) {
  const dir = opts.dir ?? lockDir();
  const graceMs = opts.graceMs ?? envMs(GRACE_MS_ENV, GRACE_MS_DEFAULT);
  const force = opts.force === true;
  const session = typeof opts.session === 'string' ? opts.session : undefined;
  const notice = opts.notice ?? ((line) => console.log(line));

  const state = readHolder(dir);
  if (state.kind === 'free') {
    return { ok: true, action: 'nothing-to-release' };
  }
  if (state.kind === 'holder') {
    const pidMatch = state.holder?.pid === process.pid;
    const sessionMatch = session !== undefined && state.holder?.session === session;
    if (!pidMatch && !sessionMatch && !force) {
      return { ok: false, reason: 'foreign-holder', holder: state.holder };
    }
  } else if (state.kind === 'no-holder') {
    if (!(await stillBareAfterGrace(dir, graceMs))) {
      const now = readHolder(dir);
      if (now.kind === 'holder') return { ok: false, reason: 'foreign-holder', holder: now.holder };
      return { ok: false, reason: 'holder-unreadable' };
    }
  } else if (!force) {
    // holder-unreadable: could be a live holder mid-write of garbage-free
    // JSON that we failed to parse — never clear it without force.
    return { ok: false, reason: 'holder-unreadable' };
  }

  if (force) notice('FORCE release — lead sanction asserted by this invocation');
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, action: 'released' };
}

// One-line holder report: the HOLDER JSON, or the fixed free/stale shapes.
export function statusLock(dir = lockDir()) {
  const state = readHolder(dir);
  if (state.kind === 'free') return { text: 'free', state };
  if (state.kind === 'no-holder') return { text: 'held-no-holder (pre-convention)', state };
  if (state.kind === 'holder-unreadable') return { text: 'held — HOLDER present but unreadable', state };
  return { text: JSON.stringify(state.holder), state };
}

function usage(stream) {
  stream.write('usage: node testlock.mjs acquire <session-label> [--remove-stale] [--owner-pid <pid>] [--no-nudge]\n');
  stream.write('       node testlock.mjs release [<session-label>] [--force]\n');
  stream.write('       node testlock.mjs status\n');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  // Value-taking flags are consumed with their value so they never show up as
  // bare flags or positionals.
  const flags = new Set();
  let positional;
  let ownerPid;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--owner-pid') {
      const v = Number(rest[++i]);
      ownerPid = Number.isInteger(v) && v > 0 ? v : undefined;
      continue;
    }
    if (a.startsWith('--')) { flags.add(a); continue; }
    if (positional === undefined) positional = a;
  }

  if (cmd === 'status' && rest.length === 0) {
    console.log(statusLock().text);
    return 0;
  }
  if (cmd === 'acquire') {
    if (!positional || [...flags].some((f) => f !== '--remove-stale' && f !== '--no-nudge')) {
      usage(process.stderr);
      return 1;
    }
    const result = await acquireLock(positional, {
      removeStale: flags.has('--remove-stale'),
      ownerPid,
      nudge: flags.has('--no-nudge') ? false : undefined,
    });
    if (!result.ok) {
      const holder =
        result.state?.kind === 'holder' ? ` HOLDER: ${JSON.stringify(result.state.holder)}` : '';
      process.stderr.write(`testlock: acquire timed out waiting for the lock (${result.reason}).${holder}\n`);
      return 1;
    }
    return 0;
  }
  if (cmd === 'release') {
    if ([...flags].some((f) => f !== '--force')) {
      usage(process.stderr);
      return 1;
    }
    const result = await releaseLock({ session: positional, force: flags.has('--force') });
    if (!result.ok) {
      if (result.reason === 'foreign-holder') {
        process.stderr.write(
          `testlock: refusing to release — held by session "${result.holder?.session}" pid ${result.holder?.pid}. ` +
            'Name that exact session label, run as the holder process, or use --force with lead sanction.\n'
        );
      } else {
        process.stderr.write(`testlock: refusing to release — ${result.reason} (use --force with lead sanction)\n`);
      }
      return 1;
    }
    console.log(result.action === 'nothing-to-release' ? 'free (nothing to release)' : 'released');
    return 0;
  }
  usage(process.stderr);
  return 1;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
