import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildAlertCensus,
  censusFamilyKey,
  censusOwnerOf,
  classifyFamily,
} from '../src/lib/alert-census.js';
import type { AlertCensus, CensusFamily } from '../src/lib/alert-census.js';
import { runAlertCensus } from '../src/lib/maintenance/jobs/alert-census.js';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

// Fixed test clock: 7-day window is [2026-08-16T12:00:00Z, 2026-08-23T12:00:00Z].
const NOW = new Date('2026-08-23T12:00:00.000Z');

/** Builds a temp PA_HOME with real-shaped app.log.jsonl / archive shard /
 *  per-skill latest.json / maintenance-state.json fixtures, matching the
 *  exact subject/dedupKey shapes read from the live source (run.ts,
 *  catchup.ts, maintenance/runner.ts, maintenance/jobs/staleness-check.ts,
 *  worker-exec.ts pre-2026-08-23) — not invented text. */
async function buildFixturePaHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pa-alert-census-'));
  await mkdir(join(dir, 'archive'), { recursive: true });
  await mkdir(join(dir, 'logs', 'beepkart-followup'), { recursive: true });
  await mkdir(join(dir, 'logs', 'daily-mail-brief'), { recursive: true });

  // --- archive/2026-08-18-134211-app.log.jsonl ------------------------------
  // restore-drill maintenance-job failure (real shape: maintenance/runner.ts
  // `notify(\`Maintenance job failed: ${job.name}\`, errorMessage, { dedupKey:
  // \`maintenance-failed-${job.name}\`, severity: 'error' })`), plus one
  // bg-leak occurrence and a Stale Skills Detected pair (staleness-check.ts:
  // subject fixed 'Stale Skills Detected', dedupKey stalenessDedupKey(...)).
  const archiveLines = [
    line({
      timestamp: '2026-08-18T10:00:00.000Z', level: 'info', module: 'notify', message: 'attempting',
      subject: 'Maintenance job failed: restore-drill', dedupKey: 'maintenance-failed-restore-drill',
      severity: 'error', topic: { chat_id: '1000000002', thread_id: 200 },
    }),
    line({
      timestamp: '2026-08-18T10:00:00.500Z', level: 'info', module: 'notify', message: 'result',
      subject: 'Maintenance job failed: restore-drill', dedupKey: 'maintenance-failed-restore-drill',
      sent: true, suppressed: false, reason: 'sent',
    }),
    // bg-leak, real pre-fix shape (worker-exec.ts, no dedupKey — per-PID
    // lastRepeatBucket gate was the dedup mechanism): subject embeds count+pid.
    line({
      timestamp: '2026-08-18T11:00:00.000Z', level: 'info', module: 'notify', message: 'attempting',
      subject: 'bg-leak: 2 long-running descendant(s) of agy (pid 17800)',
      severity: 'warn', topic: { chat_id: '1000000002', thread_id: 200 },
    }),
    line({
      timestamp: '2026-08-18T11:00:00.500Z', level: 'info', module: 'notify', message: 'result',
      subject: 'bg-leak: 2 long-running descendant(s) of agy (pid 17800)',
      sent: true, suppressed: false, reason: 'sent',
    }),
    line({
      timestamp: '2026-08-18T12:00:00.000Z', level: 'warn', module: 'notify', message: 'attempting',
      subject: 'Stale Skills Detected', dedupKey: 'staleness:a1b2c3d4e5f6a7b8',
      severity: 'warn', topic: { chat_id: '1000000002', thread_id: 200 },
    }),
    line({
      timestamp: '2026-08-18T12:00:00.500Z', level: 'warn', module: 'notify', message: 'result',
      subject: 'Stale Skills Detected', dedupKey: 'staleness:a1b2c3d4e5f6a7b8',
      sent: true, suppressed: false, reason: 'sent',
    }),
  ];
  await writeFile(join(dir, 'archive', '2026-08-18-134211-app.log.jsonl'), archiveLines.join(''), 'utf8');

  // --- app.log.jsonl (live) --------------------------------------------------
  // Two more bg-leak occurrences with DIFFERENT pids (must collapse into the
  // same family as the archived one), the beepkart-followup dedup-suppressed
  // park notice (real shape: catchup.ts `Skill parked after repeated
  // failures: ${name}`, dedupKey `skill-parked-${name}`), one telegram
  // skill-message-sent row (MarkdownV2-escaped, attaches to restore-drill),
  // and two malformed lines that must be skipped silently.
  const liveLines = [
    line({
      timestamp: '2026-08-22T09:00:00.000Z', level: 'info', module: 'notify', message: 'attempting',
      subject: 'bg-leak: 2 long-running descendant(s) of agy (pid 18811)',
      severity: 'warn', topic: { chat_id: '1000000002', thread_id: 200 },
    }),
    line({
      timestamp: '2026-08-22T09:00:00.500Z', level: 'info', module: 'notify', message: 'result',
      subject: 'bg-leak: 2 long-running descendant(s) of agy (pid 18811)',
      sent: true, suppressed: false, reason: 'sent',
    }),
    line({
      timestamp: '2026-08-22T09:01:00.000Z', level: 'info', module: 'notify', message: 'attempting',
      subject: 'bg-leak: 3 long-running descendant(s) of agy (pid 19233)',
      severity: 'warn', topic: { chat_id: '1000000002', thread_id: 200 },
    }),
    line({
      timestamp: '2026-08-22T09:01:00.500Z', level: 'info', module: 'notify', message: 'result',
      subject: 'bg-leak: 3 long-running descendant(s) of agy (pid 19233)',
      sent: true, suppressed: false, reason: 'sent',
    }),
    line({
      timestamp: '2026-08-22T10:00:00.000Z', level: 'error', module: 'notify', message: 'attempting',
      subject: 'Skill parked after repeated failures: beepkart-followup',
      dedupKey: 'skill-parked-beepkart-followup', severity: 'error',
      topic: { chat_id: '1000000002', thread_id: 200 },
    }),
    line({
      timestamp: '2026-08-22T10:00:00.500Z', level: 'error', module: 'notify', message: 'result',
      subject: 'Skill parked after repeated failures: beepkart-followup',
      dedupKey: 'skill-parked-beepkart-followup', sent: false, suppressed: true, reason: 'dedup-suppressed',
    }),
    line({
      timestamp: '2026-08-22T09:05:00.000Z', level: 'info', module: 'telegram', message: 'skill message sent',
      refId: 's-abc123def456', chatId: 1000000001, threadId: 100, chunkIndex: 0,
      textPreview: 'Maintenance job failed\\: restore\\-drill',
    }),
    'this is not json at all\n',
    '{"unterminated": \n',
  ];
  await writeFile(join(dir, 'app.log.jsonl'), liveLines.join(''), 'utf8');

  // --- logs/beepkart-followup/latest.json (human-gated: invalid_grant) ------
  await writeFile(
    join(dir, 'logs', 'beepkart-followup', 'latest.json'),
    JSON.stringify({
      latest: {
        worker: 'agy', status: 'error', exitCode: 1, duration: 5000,
        timestamp: '2026-08-21T08:00:00.000Z',
        error: 'Google OAuth error: invalid_grant: Token has been expired or revoked.',
      },
      consecutiveFailures: 44,
    }),
    'utf8',
  );

  // --- logs/daily-mail-brief/ — exit-0-masked failure -----------------------
  await writeFile(
    join(dir, 'logs', 'daily-mail-brief', 'latest.json'),
    JSON.stringify({
      latest: {
        worker: 'agy', status: 'success', exitCode: 0, duration: 12000,
        timestamp: '2026-08-20T05:00:00.000Z',
      },
    }),
    'utf8',
  );
  await writeFile(
    join(dir, 'logs', 'daily-mail-brief', '20260820-050000-a1b2c3.log'),
    'Some earlier output line\n' +
    '[INFO]  [notify] attempting {"subject":"Auth needed","dedupKey":"x","severity":"error","topic":{"chat_id":"1000000002"}}\n' +
    'trailing output\n',
    'utf8',
  );

  // --- maintenance-state.json — restore-drill failing (ENOENT) -------------
  await writeFile(
    join(dir, 'maintenance-state.json'),
    JSON.stringify({
      version: 1,
      jobs: {
        'restore-drill': {
          firstSeenAt: '2026-08-17T00:00:00.000Z',
          lastOutcome: 'failed',
          consecutiveFailures: 5,
          lastAttemptAt: '2026-08-22T00:00:00.000Z',
          lastError: "ENOENT: no such file or directory, open 'C:\\\\Windows\\\\System32\\\\pa\\\\scripts\\\\run_restore_drill.py'",
          consecutiveSkips: 0,
        },
      },
    }),
    'utf8',
  );

  return dir;
}

describe('buildAlertCensus (fixture-driven, real log-row shapes)', () => {
  let paHome: string;

  beforeEach(async () => {
    paHome = await buildFixturePaHome();
  });

  afterEach(async () => {
    await rm(paHome, { recursive: true, force: true });
  });

  it('collapses three bg-leak occurrences (different PIDs, both shards) into one family', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    const bgLeak = census.families.find((f) => f.family === 'bg-leak');
    assert.ok(bgLeak, `expected a 'bg-leak' family, got: ${census.families.map((f) => f.family).join(', ')}`);
    assert.equal(bgLeak!.sent, 3, 'all three bg-leak sends (1 archived + 2 live) should collapse into one family');
  });

  it('reads both the live file and the archive shard', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    const restoreDrill = census.families.find((f) => f.family === 'maintenance-failed-restore-drill');
    const beepkart = census.families.find((f) => f.family === 'skill-parked-beepkart-followup');
    assert.ok(restoreDrill, 'restore-drill family (archive-only) must be present — proves the archive shard was read');
    assert.ok(beepkart, 'beepkart-followup family (live-only) must be present — proves app.log.jsonl was read');
  });

  it('attributes owner kind and name per family', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    const byFamily = new Map(census.families.map((f) => [f.family, f]));

    assert.deepEqual(
      { ownerKind: byFamily.get('maintenance-failed-restore-drill')!.ownerKind, owner: byFamily.get('maintenance-failed-restore-drill')!.owner },
      { ownerKind: 'maintenance-job', owner: 'restore-drill' },
    );
    assert.deepEqual(
      { ownerKind: byFamily.get('skill-parked-beepkart-followup')!.ownerKind, owner: byFamily.get('skill-parked-beepkart-followup')!.owner },
      { ownerKind: 'skill', owner: 'beepkart-followup' },
    );
    assert.equal(byFamily.get('bg-leak')!.ownerKind, 'system');
    assert.equal(byFamily.get('staleness:a1b2c3d4e5f6a7b8')!.ownerKind, 'system');
  });

  it('classifies restore-drill as deterministic-defect (ENOENT in ledger lastError)', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    const restoreDrill = census.families.find((f) => f.family === 'maintenance-failed-restore-drill');
    assert.equal(restoreDrill?.classification, 'deterministic-defect');
  });

  it('classifies beepkart-followup as human-gated (invalid_grant in latest.json error)', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    const beepkart = census.families.find((f) => f.family === 'skill-parked-beepkart-followup');
    assert.equal(beepkart?.classification, 'human-gated');
  });

  it('unescapes the MarkdownV2 telegram body and attaches it to the restore-drill family only', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    const restoreDrill = census.families.find((f) => f.family === 'maintenance-failed-restore-drill');
    const bgLeak = census.families.find((f) => f.family === 'bg-leak');

    assert.equal(restoreDrill?.bodySample, 'Maintenance job failed: restore-drill', 'backslash escapes must be removed');
    assert.equal(restoreDrill?.distinctBodies, 1);
    assert.equal(bgLeak?.distinctBodies, 0, 'the telegram body must not attach to an unrelated family');
  });

  it('reports the daily-mail-brief exit-0-masked failure', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    assert.equal(census.maskedFailures.length, 1);
    assert.equal(census.maskedFailures[0].skill, 'daily-mail-brief');
    assert.equal(census.maskedFailures[0].lastRunAt, '2026-08-20T05:00:00.000Z');
    assert.match(census.maskedFailures[0].marker, /\[notify\] attempting/);
  });

  it('produces a well-formed topLine', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome });
    assert.match(census.topLine, /^\d+ alerts \/ \d+ families in 7d( — top: .+)?$/);
    assert.equal(census.families.length, 4);
    assert.equal(census.totalSent, 5); // 1 restore-drill + 3 bg-leak + 1 staleness (beepkart was suppressed)
  });

  it('never throws on the two malformed lines in the fixture', async () => {
    await assert.doesNotReject(() => buildAlertCensus({ days: 7, now: NOW, paHome }));
  });
});

describe('buildAlertCensus (empty PA_HOME)', () => {
  let emptyHome: string;

  beforeEach(async () => {
    emptyHome = await mkdtemp(join(tmpdir(), 'pa-alert-census-empty-'));
  });

  afterEach(async () => {
    await rm(emptyHome, { recursive: true, force: true });
  });

  it('returns a well-formed zero census rather than throwing', async () => {
    const census = await buildAlertCensus({ days: 7, now: NOW, paHome: emptyHome });
    assert.deepEqual(census.families, []);
    assert.deepEqual(census.maskedFailures, []);
    assert.equal(census.totalSent, 0);
    assert.equal(census.totalSuppressed, 0);
    assert.match(census.topLine, /^0 alerts \/ 0 families in 7d$/);
  });
});

describe('censusFamilyKey', () => {
  it('prefers dedupKey over subject when present', () => {
    assert.equal(censusFamilyKey('my-dedup-key', 'Some Subject'), 'my-dedup-key');
  });

  it('falls back to subject when dedupKey is undefined', () => {
    assert.equal(censusFamilyKey(undefined, 'Some Subject'), 'Some Subject');
  });

  it('normalizes PIDs', () => {
    assert.equal(censusFamilyKey(undefined, 'bg-orphan: reaped (pid 4242)'), 'bg-orphan: reaped (pid N)');
  });

  it('normalizes descendant counts', () => {
    assert.equal(
      censusFamilyKey(undefined, 'x: 7 long-running descendant(s) of y'),
      'x: N long-running descendant(s) of y',
    );
  });

  it('normalizes topic ids', () => {
    assert.equal(censusFamilyKey(undefined, 'lock busy: topic-123456_7822'), 'lock busy: topic-*');
  });

  it('collapses a trailing numeric id on skill-fail-topic-*', () => {
    assert.equal(censusFamilyKey('skill-fail-topic-oracle-42', 'x'), 'skill-fail-topic-oracle-*');
  });

  it('collapses a trailing numeric id on worker-exit-*', () => {
    assert.equal(censusFamilyKey('worker-exit-agy-99', 'x'), 'worker-exit-agy-*');
  });

  it('collapses ANY bg-leak-prefixed key to the literal "bg-leak" (last rule, overrides prior normalizations)', () => {
    assert.equal(censusFamilyKey(undefined, 'bg-leak: 4 long-running descendant(s) of agy (pid 555)'), 'bg-leak');
    assert.equal(censusFamilyKey('bg-leak-anything', 'ignored'), 'bg-leak');
  });
});

describe('censusOwnerOf', () => {
  it('matches Skill failed:', () => {
    assert.deepEqual(censusOwnerOf('Skill failed: oracle'), { ownerKind: 'skill', owner: 'oracle' });
  });

  it('matches Skill parked after repeated failures:', () => {
    assert.deepEqual(censusOwnerOf('Skill parked after repeated failures: beepkart-followup'), { ownerKind: 'skill', owner: 'beepkart-followup' });
  });

  it('matches Skill exhausted:', () => {
    assert.deepEqual(censusOwnerOf('Skill exhausted: reminders'), { ownerKind: 'skill', owner: 'reminders' });
  });

  it('matches Maintenance job failed:/suppressed:', () => {
    assert.deepEqual(censusOwnerOf('Maintenance job failed: restore-drill'), { ownerKind: 'maintenance-job', owner: 'restore-drill' });
    assert.deepEqual(censusOwnerOf('Maintenance job suppressed: alert-state-gc'), { ownerKind: 'maintenance-job', owner: 'alert-state-gc' });
  });

  it('matches Worker exited with code N:', () => {
    assert.deepEqual(censusOwnerOf('Worker exited with code 1: agy'), { ownerKind: 'worker', owner: 'agy' });
  });

  it('matches "<name>: auth/gemini/llm failure"', () => {
    assert.deepEqual(censusOwnerOf('daily-mail-brief: auth failure'), { ownerKind: 'skill', owner: 'daily-mail-brief' });
    assert.deepEqual(censusOwnerOf('oracle: gemini failure'), { ownerKind: 'skill', owner: 'oracle' });
    assert.deepEqual(censusOwnerOf('oracle: llm failure'), { ownerKind: 'skill', owner: 'oracle' });
  });

  it('matches the system catch-all set', () => {
    for (const subject of ['Stale Skills Detected', 'Cadence Audit stalled', 'bg-leak: x', 'bg-orphan: y', 'public-sync failed', 'All workers rate-limited', 'Alert census (7d)']) {
      assert.equal(censusOwnerOf(subject).ownerKind, 'system', subject);
    }
  });

  it('falls back to unknown', () => {
    assert.deepEqual(censusOwnerOf('Something entirely unrecognized'), { ownerKind: 'unknown' });
  });
});

describe('classifyFamily', () => {
  function base(overrides: Partial<Omit<CensusFamily, 'classification'>> = {}): Omit<CensusFamily, 'classification'> {
    return {
      family: 'f', subjectSample: 'f', sent: 1, suppressed: 0, other: 0,
      firstSeen: '2026-08-20T00:00:00.000Z', lastSeen: '2026-08-20T00:00:00.000Z',
      ownerKind: 'unknown', distinctBodies: 0,
      ...overrides,
    };
  }

  it('human-gated wins even when the error also looks like a traceback (order is the contract)', () => {
    const f = base({
      ownerStatus: { lastError: 'Traceback ... raise Exception("invalid_grant: Token has been expired or revoked.")' },
    });
    assert.equal(classifyFamily(f), 'human-gated');
  });

  it('classifies deterministic-defect from lastError', () => {
    const f = base({ ownerStatus: { lastError: "ENOENT: no such file or directory" } });
    assert.equal(classifyFamily(f), 'deterministic-defect');
  });

  it('classifies deterministic-defect from bodySample when lastError is absent', () => {
    const f = base({ bodySample: 'ModuleNotFoundError: No module named foo' });
    assert.equal(classifyFamily(f), 'deterministic-defect');
  });

  it('classifies repeat-unchanged at sent >= 10 and distinctBodies <= 2', () => {
    const f = base({ sent: 12, distinctBodies: 2 });
    assert.equal(classifyFamily(f), 'repeat-unchanged');
  });

  it('does not classify repeat-unchanged when distinctBodies > 2', () => {
    const f = base({ sent: 12, distinctBodies: 3 });
    assert.notEqual(classifyFamily(f), 'repeat-unchanged');
  });

  it('classifies transient at sent <= 2 and a healthy owner', () => {
    const f = base({ sent: 2, ownerStatus: { consecutiveFailures: 0 } });
    assert.equal(classifyFamily(f), 'transient');
  });

  it('does not classify transient when the owner has active consecutive failures', () => {
    const f = base({ sent: 1, ownerStatus: { consecutiveFailures: 3 } });
    assert.notEqual(classifyFamily(f), 'transient');
  });

  it('falls back to informational', () => {
    const f = base({ sent: 5, distinctBodies: 5 });
    assert.equal(classifyFamily(f), 'informational');
  });
});

describe('runAlertCensus (job)', () => {
  let originalPaHome: string | undefined;
  let originalThreshold: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'pa-alert-census-job-'));
    originalPaHome = process.env.PA_HOME;
    originalThreshold = process.env.PA_ALERT_CENSUS_NOTIFY_PER_DAY;
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    if (originalThreshold === undefined) delete process.env.PA_ALERT_CENSUS_NOTIFY_PER_DAY;
    else process.env.PA_ALERT_CENSUS_NOTIFY_PER_DAY = originalThreshold;
    await rm(tempDir, { recursive: true, force: true });
  });

  function fakeCensus(totalSent: number): AlertCensus {
    return {
      generatedAt: NOW.toISOString(),
      windowDays: 7,
      since: '2026-08-16T12:00:00.000Z',
      until: NOW.toISOString(),
      totalSent,
      totalSuppressed: 0,
      sentPerDay: {},
      families: [
        {
          family: 'maintenance-failed-restore-drill', subjectSample: 'Maintenance job failed: restore-drill',
          sent: totalSent, suppressed: 0, other: 0,
          firstSeen: '2026-08-18T00:00:00.000Z', lastSeen: '2026-08-22T00:00:00.000Z',
          ownerKind: 'maintenance-job', owner: 'restore-drill',
          ownerStatus: { status: 'failed', consecutiveFailures: 5 },
          distinctBodies: 1, classification: 'deterministic-defect',
        },
      ],
      maskedFailures: [],
      topLine: `${totalSent} alerts / 1 families in 7d — top: maintenance-failed-restore-drill ${totalSent}`,
    };
  }

  it('writes the census JSON to disk via the real atomic writer (no writeFn override)', async () => {
    let notifyCalls = 0;
    const census = fakeCensus(10); // 10/7 ≈ 1.4/day — below the default 50/day threshold
    const result = await runAlertCensus({
      buildFn: async () => census,
      notifyFn: async () => { notifyCalls++; return { sent: true, suppressed: false }; },
      now: NOW.getTime(),
    });

    const written = await readFile(join(tempDir, 'alert-census.json'), 'utf8');
    const parsed = JSON.parse(written);
    assert.equal(parsed.totalSent, 10);
    assert.equal(parsed.topLine, census.topLine);
    assert.equal(notifyCalls, 0, 'below-threshold volume must not notify');
    assert.equal(result.touched, 1);
    assert.deepEqual(result.detail, { totalSent: 10, families: 1, masked: 0 });
  });

  it('does not notify below the default 50/day threshold', async () => {
    let notifyCalls = 0;
    // 300 sent / 7 days ≈ 42.9/day — below default 50.
    await runAlertCensus({
      buildFn: async () => fakeCensus(300),
      writeFn: async () => {},
      notifyFn: async () => { notifyCalls++; return { sent: true, suppressed: false }; },
      now: NOW.getTime(),
    });
    assert.equal(notifyCalls, 0);
  });

  it('notifies once sent/day crosses the default 50/day threshold', async () => {
    let notifyCalls = 0;
    let notifiedSubject = '';
    // 400 sent / 7 days ≈ 57.1/day — above default 50.
    await runAlertCensus({
      buildFn: async () => fakeCensus(400),
      writeFn: async () => {},
      notifyFn: async (subject) => { notifyCalls++; notifiedSubject = subject; return { sent: true, suppressed: false }; },
      now: NOW.getTime(),
    });
    assert.equal(notifyCalls, 1);
    assert.equal(notifiedSubject, 'Alert census (7d)');
  });

  it('honours PA_ALERT_CENSUS_NOTIFY_PER_DAY on both sides of a custom threshold', async () => {
    process.env.PA_ALERT_CENSUS_NOTIFY_PER_DAY = '10';
    // 50 sent / 7 days ≈ 7.1/day — below the custom threshold of 10.
    let notifyCalls = 0;
    await runAlertCensus({
      buildFn: async () => fakeCensus(50),
      writeFn: async () => {},
      notifyFn: async () => { notifyCalls++; return { sent: true, suppressed: false }; },
      now: NOW.getTime(),
    });
    assert.equal(notifyCalls, 0, 'below the custom threshold must not notify');

    // 100 sent / 7 days ≈ 14.3/day — above the custom threshold of 10.
    await runAlertCensus({
      buildFn: async () => fakeCensus(100),
      writeFn: async () => {},
      notifyFn: async () => { notifyCalls++; return { sent: true, suppressed: false }; },
      now: NOW.getTime(),
    });
    assert.equal(notifyCalls, 1, 'above the custom threshold must notify');
  });
});
