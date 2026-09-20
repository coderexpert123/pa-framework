import { spawn } from 'child_process';
import { loadConfig } from '../config.js';
import { normalizePath, pathsOverlap, readActive } from './reservations.js';
import type { Reservation } from './reservations.js';
import { log } from './log.js';
import { randomBytes } from 'crypto';
import type { PaConfig } from '../types.js';

/** One commit target that collides with a foreign active reservation (AI-243). */
export interface ClaimBlock {
  path: string;
  reservation: Pick<Reservation, 'id' | 'session' | 'note' | 'expiresAt'>;
}

export interface GitGuardResult {
  allowed: boolean;
  reason: string;
  /** Populated only on a claims-gate refusal — the colliding targets plus the
   *  reservation that owns each (for reports/tests; `reason` already names
   *  the holders in prose). */
  claimBlocks?: ClaimBlock[];
}

export interface ClaimsCheckOptions {
  /** Repo-relative paths about to be committed (a pathspec commit's targets —
   *  `git commit -- <paths>` lands exactly these). When omitted/empty, the
   *  whole staged index is checked instead — what a bare `git commit` lands. */
  paths?: string[];
  /** The calling session's claim label (`pa claim --session`). Its own
   *  reservations never block — the wave exception: a builder committing
   *  pathspec'd files under its OWN claim must pass. Falls back to the
   *  PA_SESSION env var (same convention as `pa claim`). Absent both, EVERY
   *  active reservation counts as foreign. */
  session?: string;
}

export interface GitGuardOptions {
  /** Directory for the work-tree check (default: process cwd). */
  cwd?: string;
  /** AI-243 commit-claims gate. Opt-in per call site so non-commit consumers
   *  (the `pa status` probe, the self-improver's `git revert` guard) keep the
   *  legacy two-condition verdict; the `pa git-guard` CLI always sets it. */
  claimsCheck?: ClaimsCheckOptions;
  /** Test-only: replaces config loading. */
  loadConfigFn?: () => Promise<PaConfig>;
  /** Test-only: replaces the `git rev-parse --is-inside-work-tree` probe. */
  isInsideWorkTreeFn?: (cwd: string) => Promise<boolean>;
  /** Test-only: replaces the staged-index enumeration. */
  stagedPathsFn?: (cwd: string) => Promise<string[] | null>;
  /** Test-only: replaces reservations.ts's readActive. */
  readActiveFn?: (now: number) => Promise<Reservation[]>;
  /** Test-only clock (ms epoch) for the reservation-expiry comparison. */
  now?: number;
}

/** `git rev-parse --is-inside-work-tree` — exit 0 AND stdout 'true'. Inside a
 *  bare repo git exits 0 with 'false'; outside a repo it exits 128. Anything
 *  that is not exit-0-'true' means "no" (git-root.ts:20-42 spawn precedent:
 *  windowsHide, piped stdio, never a visible console window). */
async function isInsideWorkTree(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && out.trim() === 'true'));
  });
}

function runGit(cwd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    // stderr is piped but unread — resume() drains it so a chatty stderr can
    // never stall the child behind a full pipe buffer.
    child.stderr?.resume();
    child.on('error', () => resolve({ code: null, out: '' }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** The paths a bare `git commit` would land — index entries that differ from
 *  HEAD (`git diff --cached --name-only -z`; `-z` keeps quoted/spaced paths
 *  unambiguous). On an unborn branch HEAD does not resolve, so fall back to
 *  `git ls-files -z`: there the whole index is staged content and a first
 *  commit lands all of it. `null` = git itself failed (the caller refuses —
 *  a gate that cannot see the index must not wave a commit through). */
async function stagedIndexPaths(cwd: string): Promise<string[] | null> {
  const diff = await runGit(cwd, ['diff', '--cached', '--name-only', '-z']);
  if (diff.code === 0) return diff.out.split('\0').filter(Boolean);
  const ls = await runGit(cwd, ['ls-files', '-z']);
  if (ls.code === 0) return ls.out.split('\0').filter(Boolean);
  return null;
}

/** Normalize a commit target the way `pa claim` normalizes reservation paths;
 *  inputs that can never be repo-relative (absolute, `..` escapes) normalize
 *  to null and simply cannot match a reservation. */
function normalizeTarget(p: string): string | null {
  try {
    return normalizePath(p);
  } catch {
    return null;
  }
}

/**
 * Single guard for "may a skill run git on the user's behalf?" —
 * the 2026-08-31 public-readiness program, WP-B. Allowed only when BOTH:
 *   1. config opted in: `git_workflow.enabled` is true, or the block is absent
 *      (legacy configs predate the knob; only an explicit false opts out), and
 *   2. the target directory is inside a git work tree.
 * Consumers: `pa git-guard` CLI (LLM skills), code-fixer's attemptCodeFix,
 * self-improver's git-revert rollback. Never inline this logic elsewhere.
 *
 * AI-243 claims gate (opt-in via `claimsCheck`; the `pa git-guard` CLI always
 * enables it): additionally REFUSES when a commit target — every staged index
 * path, or the caller's `--path` list — sits under another session's ACTIVE
 * (non-expired) `pa claim` reservation. Three sweep incidents on 2026-09-13/14
 * (a doc paragraph via pathspec, a lint delta via amend, visual-standard hunks
 * via a bare commit) were benign only because the swept text happened to be
 * final. Matching reuses reservations.ts's `pathsOverlap` — identical to
 * `pa claim`'s own conflict check: equal paths, or one beneath the other at a
 * `/` boundary (a directory reservation covers everything under it). Expired
 * reservations, own-session reservations, a missing reservations file, and
 * `@`-prefixed logical resources never block. The refusal names each holder.
 */
export async function checkGitWorkflowAllowed(opts: GitGuardOptions = {}): Promise<GitGuardResult> {
  let config: PaConfig;
  try {
    config = await (opts.loadConfigFn ?? loadConfig)();
  } catch (err: any) {
    return { allowed: false, reason: `config.yaml unreadable (${err?.message ?? err}) — git treated as not opted in` };
  }
  if (config.git_workflow?.enabled === false) {
    return { allowed: false, reason: 'git_workflow.enabled is false in config.yaml (run-only default) — set git_workflow: { enabled: true } to opt in' };
  }
  const cwd = opts.cwd ?? process.cwd();
  let inside: boolean;
  try {
    inside = await (opts.isInsideWorkTreeFn ?? isInsideWorkTree)(cwd);
  } catch {
    inside = false;
  }
  if (!inside) {
    return { allowed: false, reason: `not inside a git work tree (${cwd})` };
  }

  if (opts.claimsCheck) {
    const claimsResult = await checkCommitClaims(cwd, opts);
    if (claimsResult) return claimsResult;
  }

  return { allowed: true, reason: 'opted in (or legacy config) and inside a git work tree' };
}

/** The AI-243 half of the guard. Returns a refusing GitGuardResult, or null
 *  when nothing blocks. Deterministic — no judgment calls. */
async function checkCommitClaims(cwd: string, opts: GitGuardOptions): Promise<GitGuardResult | null> {
  const claimsCheck = opts.claimsCheck!;
  const session = claimsCheck.session ?? process.env.PA_SESSION;

  let targets: string[] | null;
  // `paths` present AND non-empty = pathspec mode; omitted OR empty falls back
  // to the staged index — the documented contract ("omitted/empty → the whole
  // staged index"). An explicit `paths: []` must NOT vacuously pass: a caller
  // meaning "check these paths" whose list came up empty would otherwise sail
  // through with zero targets examined.
  if (claimsCheck.paths !== undefined && claimsCheck.paths.length > 0) {
    targets = claimsCheck.paths;
  } else {
    targets = await (opts.stagedPathsFn ?? stagedIndexPaths)(cwd);
  }
  if (targets === null) {
    return {
      allowed: false,
      reason: `cannot enumerate the staged index in ${cwd} (git failed) — refusing; a commit here cannot be verified against active reservations`,
    };
  }

  const normalized = targets
    .map(normalizeTarget)
    .filter((t): t is string => t !== null);
  if (normalized.length === 0) return null;

  const now = opts.now ?? Date.now();
  let active: Reservation[];
  try {
    // readActive already drops expired rows; the extra filter here is
    // deliberate defense-in-depth — a gate must not trust that contract (or a
    // test double honouring it loosely) for its core expiry decision.
    active = (await (opts.readActiveFn ?? readActive)(now))
      .filter((r) => new Date(r.expiresAt).getTime() > now);
  } catch {
    // An unreadable store must not wedge every commit — reservations are
    // advisory (Rule 3); readActive itself already resets a corrupt store to
    // empty, so reaching this catch is genuinely exceptional.
    active = [];
  }
  const foreign = active.filter((r) => r.session !== session);

  const blocks: ClaimBlock[] = [];
  for (const target of normalized) {
    const hit = foreign.find((r) =>
      // `@`-prefixed logical resources ("@build") can never collide with a
      // filesystem path — same rule as the reservation-guard hook.
      r.paths.some((rp) => !rp.startsWith('@') && pathsOverlap(target, rp))
    );
    if (hit) {
      blocks.push({
        path: target,
        reservation: { id: hit.id, session: hit.session, note: hit.note, expiresAt: hit.expiresAt },
      });
    }
  }
  if (blocks.length === 0) return null;

  log('warn', 'reservations', 'commit-gate refusal', {
    refId: `s-${randomBytes(6).toString('hex')}`,
    session: session ?? '(none)',
    blocks: blocks.map((b) => ({ path: b.path, heldBy: b.reservation.session, reservationId: b.reservation.id })),
  });

  const detail = blocks
    .map((b) => `${b.path} held by "${b.reservation.session}"${b.reservation.note ? ` (${b.reservation.note})` : ''} until ${b.reservation.expiresAt}`)
    .join('; ');
  return {
    allowed: false,
    reason:
      `${blocks.length} commit target(s) sit under another session's ACTIVE reservation: ${detail}. ` +
      `Coordinate with the holder or wait for expiry (\`pa claims\` lists active reservations; never \`pa release --force\` without the holder's agreement).`,
    claimBlocks: blocks,
  };
}
