/**
 * AI-100 enforcement gate: no NEW hidden timer / due-check idiom may be added
 * to pa/src or pa/bin outside the declared maintenance framework
 * (src/lib/maintenance/) without either (a) becoming a declared job in
 * registry.ts, or (b) an explicit, justified TIMER_ALLOWLIST entry below.
 *
 * This exists because the old architecture hid destructive scheduling logic
 * behind ad-hoc setInterval/next*At/Date.now()>= idioms scattered across the
 * codebase — one such hidden timer (the bot's 24h session GC, since replaced
 * by the declared `session-gc` job) deleted 248 real Claude Code transcripts
 * on 2026-08-02. See the session-gc scoping plan.
 */
import { readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// This file lands at <pa>/dist/tests/timer-inventory.test.js after build, so
// __dirname there is pa/dist/tests — walk back up to the pa/ package root,
// then one more level to the repo root so the bot's source tree (a sibling
// package, not under pa/) can be scanned too.
const PA_ROOT = join(__dirname, '..', '..');
const REPO_ROOT = join(PA_ROOT, '..');
const SCAN_ROOTS = [
  join(PA_ROOT, 'src'),
  join(PA_ROOT, 'bin'),
  join(REPO_ROOT, 'projects', 'telegram-bot', 'src'),
];
const SKIP_DIR_SEGMENTS = new Set(['node_modules', 'dist', 'tests']);

const PATTERNS = [
  { id: 'setInterval', re: /\bsetInterval\s*\(/g },
  { id: 'next-at-idiom', re: /\bnext[A-Z]\w*At\b/g },
  { id: 'due-check', re: /Date\.now\(\)\s*>=/g },
] as const;

interface TimerAllowlistEntry { file: string; pattern: string; count: number; reason: string; }

export const TIMER_ALLOWLIST: TimerAllowlistEntry[] = [
  { file: 'pa/src/worker-exec.ts', pattern: 'setInterval', count: 1,
    reason: 'In-flight only: 30s heartbeat for ONE worker process; cleared when the child exits.' },
  { file: 'pa/src/blackboard.ts', pattern: 'setInterval', count: 1,
    reason: 'AI-113: startLockRenewal() heartbeats ONE (resource, agent, contextId) lock row for the lifetime of a single long-running holder (e.g. one Telegram dispatch), stopped via its own stop() or the maxMs cap (default 6h). No durable side effect beyond refreshing an existing lock\'s heartbeat field. Now the ONLY lock-heartbeat timer in the codebase — run.ts, catchup.ts and code-fixer.ts were migrated onto this helper on 2026-08-23 so a purged row fires onLost instead of being silently discarded.' },
  { file: 'pa/src/lib/telegram-proxy.ts', pattern: 'due-check', count: 1,
    reason: 'In-memory circuit-breaker re-probe gate for the direct/proxy failover decision — no ledger, no disk writes, resets on every call. Not a durable schedule.' },
  { file: 'projects/telegram-bot/src/health.ts', pattern: 'setInterval', count: 1,
    reason: 'DELIBERATELY NOT a declared job (AI-100 Wave 2). The self-health probe measures event-loop lag as the delta between when its own timer fires and when it was scheduled to; driven from the poll loop that delta would be the 30s long-poll (poll.ts LONG_POLL_TIMEOUT), so the bot would enter DEGRADED on the first pass and never leave. Its only disk write is ~/.pa/.health-probe, unlinked in the same call — no durable state to retain.' },
  { file: 'projects/telegram-bot/src/main.ts', pattern: 'setInterval', count: 2,
    reason: 'In-flight only, both cleared in a finally: the 4s typing keep-alive for ONE dispatch, and the 1s stop-sentinel watcher that aborts a slow getUpdates for ONE runPollLoop call. Neither writes durable state.' },
  { file: 'projects/telegram-bot/src/main.ts', pattern: 'due-check', count: 2,
    reason: 'AI-100 Wave 2: throttles how often runDueJobs("bot", ...) itself gets KICKED (maintenanceKickDueAt, 20s) — deliberately NOT a nextXAt-named variable, so it does not also trip next-at-idiom. It does no maintenance work of its own and touches no file; every actual retention decision happens inside the declared jobs it invokes, whose own due-checks live in decideJob() under pa/src/lib/maintenance/ (exempt by construction). Kept a plain in-process throttle, not a job, because kicking the runner is infrastructure for the framework, not itself durable-state-mutating work. SECOND occurrence (2026-08-17, Wave B P2-3): watchdogStaleJobs gating (5-min cadence) — clears stale in-flight markers the maintenance runner leaves when a job promise never settles; in-process liveness repair for the runner itself, writes no durable state beyond the runner\'s own ledger which the declared jobs own.' },
  { file: 'projects/telegram-bot/src/voice.ts', pattern: 'setInterval', count: 1,
    reason: 'In-flight only: the 4s typing keep-alive for ONE voice transcription, cleared in a finally on every exit path. Mirrors the dispatch typing keep-alive already allowlisted for main.ts. Writes no durable state.' },
  { file: 'projects/telegram-bot/src/task-executor.ts', pattern: 'setInterval', count: 1,
    reason: 'task-executor pending-dispatch activity pump: scoped to one in-flight dispatch, interval cleared in the dispatch\'s finally; the durable lastActivityAt write IS the feature (activity-gated demotion), not outliving side work; added retroactively when the full pa suite first ran it (5435153).' },
  { file: 'projects/telegram-bot/src/thread-executor.ts', pattern: 'setInterval', count: 1,
    reason: 'thread-executor pending-dispatch activity pump: scoped to one in-flight thread run, cleared in the run\'s finally; mirrors the task-executor pump entry (AI-203 first increment).' },
  { file: 'projects/telegram-bot/src/orphan-reaper.ts', pattern: 'setInterval', count: 1,
    reason: 'AI-228 detached give-up watcher (armOrphanedThreadWatcher): one shared interval for the thread records still orphaned-live past the reaper\'s wait window — re-checks liveness and settles each record until every one exits or the process ends (pa\'s orphan sweep kills the worker at harvestUntil, bounding the watch). unref()\'d so it is never an exit-blocking handle, and cleared the moment its last record settles. Not a maintenance job: it performs no scheduled durable-state mutation — it finishes in-flight crash recovery the startup pass could not wait out.' },
  { file: 'pa/src/commands/auth.ts', pattern: 'due-check', count: 2,
    reason: 'Auth broker Phase A (2026-09-10), `pa auth wait`\'s foreground poll loop: bounded to ONE CLI invocation (returns on answer/expiry/--timeout, default 300s) and exits the process — no setInterval, no persistent daemon, nothing left running after the command returns. First due-check (line ~407) is the broker row\'s own expires_at past the loop deadline; second (line ~425) is the --timeout deadline itself. Neither writes durable state beyond the answer it was already polling for (markDelivered on the SAME row `pa auth answer`/`answerAndResume` already own) — it is a CLI wait idiom, the same class as any `poll every N seconds until done` command-line tool, not a hidden background schedule of the kind this gate exists to catch.' },
  { file: 'pa/src/commands/catchup.ts', pattern: 'setInterval', count: 1,
    reason: 'The catchup loop\'s lane timer (2026-09-10 launch-cadence wave). Not a hidden schedule: it is the process\'s ONLY reason to stay alive, it drives the two topic lanes that used to be two per-minute Task Scheduler tasks, it writes no durable state of its own beyond re-asserting its own PID file, and it is cleared in the loop\'s shutdown path on a signal or a lost lock. Deliberately NOT unref\'d — startLockRenewal\'s interval is, so nothing else would hold the event loop open.' },
  { file: 'pa/src/commands/bus.ts', pattern: 'due-check', count: 1,
    reason: '`pa bus wait`\'s foreground poll loop (agent-bus wave, 2026-09-15): bounded to ONE CLI invocation (returns on first fresh message or the --timeout deadline, default wait) and exits the process — the same CLI-wait idiom as `pa auth wait` (see the auth.ts entry above), no setInterval, no daemon, no durable state beyond the inbox cursor the command already owns. Not a hidden background schedule.' },
];

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    let st: Stats;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
}

function toRelKey(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join('/');
}

/** Conservative comment stripper: removes /*...*\/ blocks and lines that
 * (after trimming) start with // or *. Can produce false negatives on an
 * inline trailing comment, but never a false positive that blocks a build. */
function stripComments(src: string): string {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlockComments
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*'));
    })
    .join('\n');
}

const files: string[] = [];
for (const root of SCAN_ROOTS) walk(root, files);

function countPattern(stripped: string, id: (typeof PATTERNS)[number]['id']): number {
  const pattern = PATTERNS.find((p) => p.id === id)!;
  return (stripped.match(pattern.re) ?? []).length;
}

describe('timer inventory (AI-100 enforcement gate)', () => {
  it('scans a sane number of source files (guards against broken path resolution)', () => {
    assert.ok(files.length > 90, `expected > 90 .ts files under pa/src + pa/bin + projects/telegram-bot/src, got ${files.length}`);
  });

  it('every TIMER_ALLOWLIST entry is real: reason is justified and the count matches the source exactly', () => {
    for (const entry of TIMER_ALLOWLIST) {
      assert.ok(
        entry.reason.length >= 40,
        `TIMER_ALLOWLIST entry for '${entry.file}' (${entry.pattern}) needs a real justification (>=40 chars), not a placeholder.`,
      );
      assert.ok(
        PATTERNS.some((p) => p.id === entry.pattern),
        `TIMER_ALLOWLIST entry for '${entry.file}' references unknown pattern id '${entry.pattern}'.`,
      );

      const absPath = join(REPO_ROOT, ...entry.file.split('/'));
      let src: string;
      try {
        src = readFileSync(absPath, 'utf8');
      } catch {
        assert.fail(`stale TIMER_ALLOWLIST entry for '${entry.file}' (${entry.pattern}); remove it.`);
        continue;
      }

      const actual = countPattern(stripComments(src), entry.pattern as (typeof PATTERNS)[number]['id']);
      assert.equal(
        actual,
        entry.count,
        `stale TIMER_ALLOWLIST entry for '${entry.file}' (${entry.pattern}); remove it.`,
      );
    }
  });

  it('every hidden-timer pattern outside src/lib/maintenance/ is declared in TIMER_ALLOWLIST with the exact count', () => {
    for (const absPath of files) {
      const relKey = toRelKey(absPath);
      // Declared jobs live here by construction — this is where the
      // framework's own decision logic (decideJob/resolveEveryMs and
      // similar due-check-shaped comparisons) is allowed to live.
      if (relKey.startsWith('pa/src/lib/maintenance/')) continue;

      const stripped = stripComments(readFileSync(absPath, 'utf8'));

      for (const pattern of PATTERNS) {
        const count = countPattern(stripped, pattern.id);
        if (count === 0) continue;

        const entry = TIMER_ALLOWLIST.find((e) => e.file === relKey && e.pattern === pattern.id);
        const allowedCount = entry?.count ?? 0;

        assert.equal(
          count,
          allowedCount,
          `${relKey}: found ${count} occurrence(s) of '${pattern.id}' but TIMER_ALLOWLIST allows ${allowedCount}. ` +
          `Declare this as a maintenance job in pa/src/lib/maintenance/registry.ts, or add a TIMER_ALLOWLIST entry with a written reason (see AI-100).`,
        );
      }
    }
  });
});
