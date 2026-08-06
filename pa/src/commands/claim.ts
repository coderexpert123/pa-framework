import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { join } from 'path';
import fs from 'fs-extra';
import { claim, release, renew, readActive } from '../lib/reservations.js';
import { resolveRepoRoot } from '../lib/git-root.js';

const RECENT_WINDOW_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

interface ParsedClaimArgs {
  paths: string[];
  session?: string;
  note?: string;
  ttlMinutes?: number;
  force: boolean;
  waitSeconds?: number;
  renewId?: string;
}

function parseClaimArgs(args: string[]): ParsedClaimArgs {
  const paths: string[] = [];
  let session: string | undefined;
  let note: string | undefined;
  let ttlMinutes: number | undefined;
  let force = false;
  let waitSeconds: number | undefined;
  let renewId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session') { session = args[++i]; continue; }
    if (arg === '--note') { note = args[++i]; continue; }
    if (arg === '--ttl') { ttlMinutes = Number(args[++i]); continue; }
    if (arg === '--force') { force = true; continue; }
    if (arg === '--wait') { waitSeconds = Number(args[++i]); continue; }
    if (arg === '--renew') { renewId = args[++i]; continue; }
    paths.push(arg);
  }

  return { paths, session: session ?? process.env.PA_SESSION, note, ttlMinutes, force, waitSeconds, renewId };
}

/**
 * `pa claim <path...> --session <label> --note "<text>" [--ttl <minutes>]
 *   [--force] [--wait <seconds>]`
 * `pa claim --renew <id> [--ttl <minutes>]`
 *
 * Claude Code's Bash tool does not persist environment variables between
 * calls, so `export PA_SESSION=...` silently does nothing — a session must
 * pass `--session` on every invocation (or accept the generated label this
 * prints, and reuse it).
 */
export async function claimCommand(args: string[]): Promise<number> {
  const parsed = parseClaimArgs(args);

  if (parsed.renewId) {
    const result = await renew(parsed.renewId, { ttlMinutes: parsed.ttlMinutes });
    if (!result) {
      console.error(`No active reservation found with id ${parsed.renewId}`);
      return 1;
    }
    console.log(`Renewed ${result.id} — now expires ${result.expiresAt}`);
    return 0;
  }

  if (parsed.paths.length === 0) {
    console.error(
      'Usage: pa claim <path...> --session <label> --note "<what you are doing>" [--ttl <minutes>] [--force] [--wait <seconds>]'
    );
    return 1;
  }

  let session = parsed.session;
  if (!session) {
    session = `s-${randomBytes(3).toString('hex')}`;
    console.log(`No --session given (and PA_SESSION unset) — generated "${session}". Reuse it on every subsequent call.`);
  }

  const note = parsed.note ?? '';
  const deadline = parsed.waitSeconds !== undefined ? Date.now() + parsed.waitSeconds * 1000 : undefined;

  for (;;) {
    const result = await claim({
      paths: parsed.paths,
      session,
      note,
      ttlMinutes: parsed.ttlMinutes,
      force: parsed.force,
    });

    if (result.ok) {
      const r = result.reservation!;
      console.log(`Claimed ${r.id} — ${r.paths.join(', ')} (expires ${r.expiresAt})`);
      return 0;
    }

    const conflictLines = (result.conflicts ?? [])
      .map((c) => `  ${c.paths.join(', ')} held by "${c.session}" (${c.note}) until ${c.expiresAt}`)
      .join('\n');

    const now = Date.now();
    if (deadline === undefined || now >= deadline) {
      console.error(`Claim conflicts with an active reservation:\n${conflictLines}`);
      return 1;
    }

    console.log(`Waiting on:\n${conflictLines}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** `pa release <id>` */
export async function releaseCommand(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    console.error('Usage: pa release <id>');
    return 1;
  }
  const { released } = await release({ id });
  if (released === 0) {
    console.error(`No reservation found with id ${id}`);
    return 1;
  }
  console.log(`Released ${id}.`);
  return 0;
}

/**
 * `pa claims` — always prints both coordination layers (plan §4.5):
 * explicit reservations (cooperation required), and mtime-derived recent
 * activity from `git status --porcelain` (zero cooperation required, so it
 * catches the Telegram bot and any non-participating editor too).
 */
export async function claimsCommand(): Promise<number> {
  const active = await readActive();
  console.log('Active reservations:');
  if (active.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of active) {
      console.log(`  ${r.id}  ${r.paths.join(', ')}  session=${r.session}  note="${r.note}"  expires=${r.expiresAt}`);
    }
  }

  console.log('');
  console.log('Recently modified (last 15 minutes, git status + mtime):');
  const recent = await recentActivity();
  if (recent.length === 0) {
    console.log('  (none)');
  } else {
    for (const path of recent) {
      console.log(`  ${path}`);
    }
  }

  return 0;
}

async function recentActivity(): Promise<string[]> {
  // Must be the true repo root, not process.cwd() — git status --porcelain
  // returns root-relative paths regardless of invoking cwd, so joining them
  // onto anything else produces a non-existent path (see lib/git-root.ts).
  let repoRoot: string;
  try {
    repoRoot = await resolveRepoRoot();
  } catch {
    return []; // not inside a git repo — nothing to report, not a crash
  }
  const changed = await gitStatusPaths(repoRoot);
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent: string[] = [];
  for (const rel of changed) {
    try {
      const stat = await fs.stat(join(repoRoot, rel));
      if (stat.mtimeMs >= cutoff) recent.push(rel);
    } catch {
      // deleted/renamed between `git status` and stat — skip
    }
  }
  return recent;
}

function gitStatusPaths(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('git', ['status', '--porcelain'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', () => {
      const paths = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.slice(3).trim())
        .map((p) => (p.includes(' -> ') ? p.split(' -> ')[1] : p));
      resolve(paths);
    });
    child.on('error', () => resolve([]));
  });
}
