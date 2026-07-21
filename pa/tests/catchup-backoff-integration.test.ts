/**
 * AI-098 INTEGRATION tests: failure backoff must gate what catchup actually
 * EXECUTES, not merely compute a partition nobody reads.
 *
 * Why this file exists: partitionOverdueByFailureBackoff() already has 19 pure
 * unit tests (scheduler-backoff.test.ts) and every one of them passes even if
 * catchup never consults the result. A 2026-07-21 audit mutation proved it —
 * commenting out the single `overdue = partition.runnable;` assignment in
 * commands/catchup.ts left the ENTIRE 699-test suite green, and that mutated
 * build then sat in pa/dist with AI-098 silently disabled in production.
 *
 * So every test below drives the REAL catchup code path (real skills dir, real
 * getOverdueSkills, real runCommand, real cmd spawn, real logger) and observes
 * execution through a marker file that each skill's `cmd:` appends to — the
 * only unambiguous evidence that runCommand() actually ran for that skill.
 * Removing the assignment makes the parked/deferred skills execute, and these
 * tests go red.
 *
 * Fixture notes:
 * - Dynamic import of catchup.js AFTER createTempPaHome(), because the
 *   Blackboard singleton bakes PA_HOME at module-load time (same reason as
 *   catchup.test.ts).
 * - Every skill uses cron `0 0 1 1 *` (annual, 1 Jan 00:00 UTC) so missedAt is
 *   a fixed point months in the past. Seeded failure timestamps are then placed
 *   deliberately before/after it — no wall-clock boundary race, unlike a
 *   minutely cron whose missedAt moves under the test.
 * - Each test owns a distinct `topic:` and calls catchupCommand({ topic }), so
 *   sibling tests' skills are filtered out and the default-topic tail
 *   (staleness / rotation / prune / weekly learn) is skipped.
 * - PA_NOTIFY_DISABLED=1 is set globally by tests/test-env-setup.ts, so the
 *   park page never reaches the network; the call itself is observed through
 *   notify's own forensic log line in app.log.jsonl.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, createTempSkill, cleanup } from './helpers.js';
import { writeLog } from '../src/logger.js';
import { flushLog } from '../src/lib/log.js';
import type { RunMeta } from '../src/types.js';

type CatchupCommand = (opts?: { topic?: string }) => Promise<void>;

let dir: string;
let catchupCommand: CatchupCommand;

/** Skill YAML uses forward slashes (project convention) and so must the paths
 * we bake into a skill's `cmd:` — node accepts them on Windows too. */
const fwd = (p: string) => p.replace(/\\/g, '/');

const runnerPath = () => join(dir, 'marker-writer.cjs');
const markerPath = (name: string) => join(dir, 'markers', `${name}.txt`);

/** Contents of the marker file a skill appends to, or null if it never ran. */
async function readMarker(name: string): Promise<string | null> {
  return readFile(markerPath(name), 'utf8').catch(() => null);
}

/** A skill whose only job is to prove it was executed. */
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

function errorMeta(timestamp: string): RunMeta {
  return { worker: 'shell', status: 'error', exitCode: 1, duration: 10, timestamp };
}

/**
 * Seed `count` consecutive failed runs ending at `lastAttemptAtMs` (one per
 * minute, oldest first) so latest.json carries consecutiveFailures === count
 * and lastAttemptAt === the newest of them.
 */
async function seedFailures(name: string, count: number, lastAttemptAtMs: number): Promise<void> {
  for (let i = count - 1; i >= 0; i--) {
    await writeLog(name, 'seeded failure', errorMeta(new Date(lastAttemptAtMs - i * 60_000).toISOString()));
  }
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

/** The last Jan-1-00:00 UTC before now — exactly the missedAt getOverdueSkills
 * derives for a `0 0 1 1 *` skill that has never succeeded. */
function lastAnnualOccurrenceMs(): number {
  const now = new Date();
  const thisYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  return thisYear < now.getTime() ? thisYear : Date.UTC(now.getUTCFullYear() - 1, 0, 1);
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

  await createMarkerSkill('ai098-parked', 'ai098-park');
  await createMarkerSkill('ai098-control', 'ai098-park');
  await createMarkerSkill('ai098-fresh', 'ai098-fresh');
  await createMarkerSkill('ai098-deferred', 'ai098-defer');
  await createMarkerSkill('ai098-one-failure', 'ai098-immediate');

  const mod = await import('../src/commands/catchup.js');
  catchupCommand = mod.catchupCommand;
});

after(async () => {
  await cleanup(dir);
});

describe('AI-098 integration: catchup honours the failure-backoff partition', () => {
  it('does NOT execute a parked skill, while a healthy sibling in the same topic still runs', async () => {
    // 5 consecutive failures, the last one AFTER the missed cron occurrence →
    // no fresh occurrence to grant an attempt → park.
    await seedFailures('ai098-parked', 5, Date.now() - 60_000);
    assert.ok(
      Date.now() - 60_000 > lastAnnualOccurrenceMs(),
      'fixture sanity: last attempt must post-date the missed occurrence for park to apply',
    );

    await catchupCommand({ topic: 'ai098-park' });

    // Control proves the harness really does execute skills on this path — so
    // "no marker" for the parked skill cannot be a false pass from a dead pipeline.
    assert.equal(
      (await readMarker('ai098-control'))?.trim(),
      'ai098-control',
      'the healthy skill in the same topic must have been executed',
    );

    // THE mutation detector: if `overdue = partition.runnable;` is removed from
    // commands/catchup.ts, `overdue` keeps the full pre-partition list and this
    // parked skill executes anyway.
    assert.equal(
      await readMarker('ai098-parked'),
      null,
      'parked skill must NOT be executed — catchup must use partition.runnable, not the raw overdue list',
    );
  });

  it('logs the park decision and pages the user via notifyUser (nothing sent — PA_NOTIFY_DISABLED=1)', async () => {
    const entries = await readAppLog();

    const parkLog = entries.find(
      (e) => e.module === 'catchup' && e.skill === 'ai098-parked' && String(e.message).includes('parked'),
    );
    assert.ok(parkLog, 'a catchup log line must record the park decision');
    assert.equal(parkLog.level, 'warn');
    assert.equal(parkLog.consecutiveFailures, 5);
    assert.ok(typeof parkLog.lastAttemptAt === 'string' && parkLog.lastAttemptAt.length > 0);

    // notifyUser's own forensic trail is the observation channel: PA_NOTIFY_DISABLED=1
    // stops the send, so the call is asserted rather than the delivery. Keyed on
    // dedupKey (a catchup.ts-owned value) rather than notify's message wording.
    const notifyCalls = entries.filter(
      (e) => e.module === 'notify' && e.dedupKey === 'skill-parked-ai098-parked',
    );
    assert.ok(notifyCalls.length > 0, 'the park path must call notifyUser with the per-skill dedup key');
    assert.ok(
      notifyCalls.some((e) => e.severity === 'error'),
      'the park page must be raised at severity=error',
    );
    assert.ok(
      notifyCalls.every((e) => e.sent !== true),
      'PA_NOTIFY_DISABLED=1 must keep the park page off the network',
    );
  });

  it('keeps the parked skill parked on a second pass (park is not a one-shot)', async () => {
    await catchupCommand({ topic: 'ai098-park' });

    assert.equal(await readMarker('ai098-parked'), null, 'parked skill must stay unexecuted across passes');
    // The control skill succeeded on pass 1, so its annual cron is no longer
    // overdue — it must not run a second time either.
    assert.equal(
      (await readMarker('ai098-control'))?.split('\n').filter(Boolean).length,
      1,
      'control skill should have executed exactly once',
    );
  });

  it('does NOT execute a deferred skill, and logs the retryAt it is waiting for', async () => {
    // 2 consecutive failures → ladder rung 30m; last attempt 5 min ago → defer.
    const lastAttemptAtMs = Date.now() - 5 * 60_000;
    await seedFailures('ai098-deferred', 2, lastAttemptAtMs);

    await catchupCommand({ topic: 'ai098-defer' });

    assert.equal(
      await readMarker('ai098-deferred'),
      null,
      'deferred skill must NOT be executed — it is mid-backoff, 25 min short of its 30 min rung',
    );

    const entries = await readAppLog();
    const deferLog = entries.find(
      (e) => e.module === 'catchup' && e.skill === 'ai098-deferred' && String(e.message).includes('deferred'),
    );
    assert.ok(deferLog, 'a catchup log line must record the defer decision');
    assert.equal(deferLog.consecutiveFailures, 2);
    const retryAtRaw = String(deferLog.retryAt);
    const retryAtMs = new Date(retryAtRaw).getTime();
    assert.ok(
      Math.abs(retryAtMs - (lastAttemptAtMs + 30 * 60_000)) < 60_000,
      `retryAt ${retryAtRaw} should be ~30 min after the last attempt`,
    );
  });
});

describe('AI-098 integration: backoff never throttles a skill below its own schedule', () => {
  it('executes a 5-failure skill anyway when the missed cron occurrence post-dates the last attempt', async () => {
    // Same 5 consecutive failures as the parked skill above — the ONLY
    // difference is that they all happened BEFORE the missed occurrence, i.e.
    // the cron has fired fresh since. That must always grant one attempt,
    // otherwise backoff would suppress a skill below its own cron cadence.
    const beforeOccurrenceMs = lastAnnualOccurrenceMs() - 30 * 24 * 3_600_000;
    await seedFailures('ai098-fresh', 5, beforeOccurrenceMs);

    await catchupCommand({ topic: 'ai098-fresh' });

    assert.equal(
      (await readMarker('ai098-fresh'))?.trim(),
      'ai098-fresh',
      'a fresh cron occurrence must grant one attempt even past the park threshold',
    );

    const entries = await readAppLog();
    assert.ok(
      !entries.some((e) => e.module === 'catchup' && e.skill === 'ai098-fresh'),
      'a runnable skill must produce neither a defer nor a park log line',
    );
  });

  it('executes immediately after a SINGLE failure (ladder rung 0 = no delay)', async () => {
    await seedFailures('ai098-one-failure', 1, Date.now() - 1000);

    await catchupCommand({ topic: 'ai098-immediate' });

    assert.equal(
      (await readMarker('ai098-one-failure'))?.trim(),
      'ai098-one-failure',
      'one transient failure must retry on the very next catchup pass — ladder[0] is 0 ms',
    );
  });
});
