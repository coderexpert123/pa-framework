/**
 * D2/D3/D4 (2026-08-23): catchupCommand migrated its lock heartbeat onto
 * startLockRenewal, which detects a purged row mid-tick instead of silently
 * renewing a lock this process may no longer exclusively hold. Two
 * checkpoints in runCatchup() re-check `isLockLost()`: right after the
 * pa-host maintenance pass, and before every per-skill dispatch.
 *
 * Fixture pattern mirrors catchup-backoff-integration.test.ts (real skills
 * dir, real getOverdueSkills, real runCommand, execution proven via a marker
 * file each skill's `cmd:` appends to) — the only unambiguous evidence that a
 * skill actually ran.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, createTempSkill, cleanup } from './helpers.js';
import { flushLog } from '../src/lib/log.js';

let dir: string;

/** Skill YAML uses forward slashes (project convention) and so must the
 * paths baked into a skill's `cmd:` — node accepts them on Windows too. */
const fwd = (p: string) => p.replace(/\\/g, '/');

const runnerPath = () => join(dir, 'marker-writer.cjs');
const markerPath = (name: string) => join(dir, 'markers', `${name}.txt`);

/** Contents of the marker file a skill appends to, or null if it never ran. */
async function readMarker(name: string): Promise<string | null> {
  return readFile(markerPath(name), 'utf8').catch(() => null);
}

/** A skill whose only job is to prove it was executed. Annual cron (never
 * fires on its own during a test run) so it always shows up as overdue
 * against a fresh temp PA_HOME with no run history. */
async function createMarkerSkill(name: string, topic: string): Promise<void> {
  await createTempSkill(dir, name, [
    '---',
    'cron: "0 0 1 1 *"',
    `topic: ${topic}`,
    `cmd: "node \\"${fwd(runnerPath())}\\" \\"${fwd(markerPath(name))}\\" ${name}"`,
    'timeout: 60',
    '---',
    `Marker skill ${name} — appends one line per execution.`,
  ].join('\n'));
}

interface AppLogEntry {
  level?: string;
  module?: string;
  message?: string;
  [key: string]: unknown;
}

async function readAppLog(): Promise<AppLogEntry[]> {
  await flushLog();
  const raw = await readFile(join(dir, 'app.log.jsonl'), 'utf8').catch(() => '');
  const entries: AppLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as AppLogEntry); } catch { /* skip torn line */ }
  }
  return entries;
}

before(async () => {
  // PA_HOME must be set before any module-level Blackboard constructor runs.
  dir = await createTempPaHome();
  await createTempConfig(dir, [
    { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
  ]);
  await mkdir(join(dir, 'markers'), { recursive: true });
  await writeFile(
    runnerPath(),
    'const fs = require("fs");\n' +
    'const [, , markerFile, label] = process.argv;\n' +
    'fs.appendFileSync(markerFile, label + "\\n");\n',
    'utf8',
  );

  await createMarkerSkill('lockloss-a', 'lockloss-topic-1');
  await createMarkerSkill('lockloss-b', 'lockloss-topic-1');
  await createMarkerSkill('lockloss-c', 'lockloss-topic-1');
});

after(async () => {
  await cleanup(dir);
});

describe('catchupCommand lock-loss detection (D2/D3/D4, 2026-08-23)', () => {
  it('a purged catchup row aborts the tick at its next checkpoint and fires exactly one "Catchup aborted (lock lost)" notify', async () => {
    const { blackboard } = await import('../src/blackboard.js');
    const { catchupCommand } = await import('../src/commands/catchup.js');

    const originalRenewMs = process.env.PA_LOCK_RENEW_INTERVAL_MS;
    process.env.PA_LOCK_RENEW_INTERVAL_MS = '50';
    const lockKey = 'catchup:topic:lockloss-topic-1';

    try {
      const runPromise = catchupCommand({ topic: 'lockloss-topic-1' });

      // Poll for the row rather than guessing a fixed delay (see
      // run-exclusive-lock.test.ts's own "purged lock row" test for the same
      // reasoning — acquireLock's completion time isn't guaranteed to beat a
      // fixed sleep). Once confirmed present, purge it: 3 overdue skills with
      // a 1s inter-dispatch stagger give ~2s of natural margin for the purge
      // to be detected before the per-skill checkpoint sees it (a purge
      // colliding with an in-flight renewal tick's lockfile.lock() falls back
      // to proper-lockfile's ~1000-1100ms retry backoff — measured
      // empirically — so anything shorter than that margin flakes).
      // Use a longer timeout on slower CI systems (especially shared macOS runners).
      const deadline = Date.now() + 10000;
      let rowSeen = false;
      while (Date.now() < deadline) {
        const active = await blackboard.getActiveLocks();
        if (active.some((l) => l.resource === lockKey)) { rowSeen = true; break; }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(rowSeen, 'precondition: catchup must have acquired its topic lock before it can be purged');
      await blackboard.releaseLock(lockKey, 'catchup-command');

      await runPromise;

      // At least the already-dispatched skill(s) must have run (proves the
      // harness genuinely executes skills — a dead pipeline would also show
      // "0 ran", which must not be mistaken for the abort working), and at
      // least one of the three must have been skipped once the abort landed.
      const ran = (await Promise.all(
        ['lockloss-a', 'lockloss-b', 'lockloss-c'].map((n) => readMarker(n)),
      )).filter((v) => v !== null).length;
      assert.ok(ran >= 1, 'expected at least one already-dispatched skill to have run to completion');
      assert.ok(ran < 3, `expected at least one skill to be skipped once the lock was lost, but all ${ran} ran`);

      const entries = await readAppLog();
      const aborts = entries.filter((e) => e.module === 'catchup' && e.level === 'warn' && e.message === 'tick aborted — lock lost');
      assert.ok(aborts.length >= 1, `expected at least one abort log line, got: ${JSON.stringify(entries.filter((e) => e.module === 'catchup'))}`);
      assert.equal(aborts[0].lockKey, lockKey);

      const notifyAttempts = entries.filter((e) => e.module === 'notify' && e.message === 'attempting' && e.subject === 'Catchup aborted (lock lost)');
      assert.equal(notifyAttempts.length, 1, `expected exactly one notify attempt, got ${notifyAttempts.length}: ${JSON.stringify(notifyAttempts)}`);
      assert.equal(notifyAttempts[0].dedupKey, `catchup-lock-lost:${lockKey}`);
      assert.equal(notifyAttempts[0].severity, 'error');
    } finally {
      if (originalRenewMs === undefined) delete process.env.PA_LOCK_RENEW_INTERVAL_MS;
      else process.env.PA_LOCK_RENEW_INTERVAL_MS = originalRenewMs;
    }
  });

  it('a healthy tick runs to completion and releases with its own contextId', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');

    // No skills declared for this topic — the loop is a no-op, so this
    // exercises acquire → (no renewal loss) → release cleanly.
    await catchupCommand({ topic: 'lockloss-topic-empty' });

    const raw = await readFile(join(dir, 'blackboard.json'), 'utf8').catch(() => '{"active_locks":[]}');
    const data = JSON.parse(raw);
    const locks = data.active_locks.filter((l: { resource: string }) => l.resource === 'catchup:topic:lockloss-topic-empty');
    assert.equal(locks.length, 0, 'the lock must be released after a healthy, uninterrupted tick');
  });
});
