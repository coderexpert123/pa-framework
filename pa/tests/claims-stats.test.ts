import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';

// D11 — coordinationStats() / `pa claims --stats`. These tests build a
// synthetic app.log.jsonl (plus a rotated archive shard) directly rather than
// driving reservations.ts's claim()/release()/etc, so every CoordinationStats
// field, the window filter, the session cap/ordering and the auto-session-id
// regex can be exercised precisely and independently of the writer side.

function jsonLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry) + '\n';
}

describe('coordinationStats (D11)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  it('rolls up every field from app.log.jsonl plus an archive shard, within the window, skipping other modules/files', async () => {
    const { coordinationStats } = await import('../src/commands/claim.js');
    const now = Date.parse('2026-08-23T12:00:00.000Z');
    const recentTs = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago — inside a 7d window
    const oldTs = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago — outside a 7d window
    const base = { level: 'info', module: 'reservations' };

    const currentLines =
      jsonLine({ ...base, timestamp: recentTs, message: 'claim granted', refId: 's-000000000001', id: 'r-1', session: 'coord-audit', paths: ['a.ts'], ttlMinutes: 45, forced: false }) +
      jsonLine({ ...base, timestamp: recentTs, message: 'claim granted', refId: 's-000000000002', id: 'r-2', session: 'coord-audit', paths: ['b.ts'], ttlMinutes: 45, forced: true }) +
      jsonLine({ ...base, level: 'warn', timestamp: recentTs, message: 'claim denied', refId: 's-000000000003', session: 'pa-47', paths: ['c.ts'], conflicts: [] }) +
      jsonLine({ ...base, timestamp: recentTs, message: 'reservation released', refId: 's-000000000004', id: 'r-1', session: 'coord-audit', releasedCount: 1 }) +
      jsonLine({ ...base, level: 'warn', timestamp: recentTs, message: "forced release of another session's reservation", refId: 's-000000000005', id: 'r-9', owner: 'coord-audit', releasedBy: 'pa-47' }) +
      jsonLine({ ...base, timestamp: recentTs, message: 'reservation renewed', refId: 's-000000000006', id: 'r-3', expiresAt: recentTs }) +
      jsonLine({ ...base, timestamp: recentTs, message: 'reservations gc-expired', refId: 's-000000000007', removed: 4 }) +
      jsonLine({ ...base, level: 'warn', timestamp: recentTs, message: 'hook warning', refId: 's-00000000000c', reservationId: 'r-1', holder: 'coord-audit', path: 'a.ts', toolName: 'Edit', hookSessionId: 'claude-session-1' }) +
      jsonLine({ ...base, level: 'warn', timestamp: recentTs, message: 'hook warning', refId: 's-00000000000d', reservationId: 'r-2', holder: 'coord-audit', path: 'b.ts', toolName: 'Write', hookSessionId: 'claude-session-2' }) +
      'this line is not JSON at all\n' + // torn/partial write — must be skipped, not thrown
      jsonLine({ ...base, timestamp: oldTs, message: 'claim granted', refId: 's-000000000008', id: 'r-old', session: 'ancient', paths: ['old.ts'], ttlMinutes: 45, forced: false }); // outside window

    await writeFile(join(dir, 'app.log.jsonl'), currentLines, 'utf8');

    await mkdir(join(dir, 'archive'), { recursive: true });
    const archiveTs = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const archiveLines =
      jsonLine({ ...base, timestamp: archiveTs, message: 'claim granted', refId: 's-000000000009', id: 'r-4', session: 'push-skill', paths: ['d.ts'], ttlMinutes: 45, forced: false }) +
      jsonLine({ level: 'info', module: 'catchup', timestamp: archiveTs, message: 'tick', refId: 's-00000000000a' }); // different module — must be excluded
    await writeFile(join(dir, 'archive', '2026-08-20-app.log.jsonl'), archiveLines, 'utf8');

    // A non-matching archive filename (does not end in "-app.log.jsonl") must
    // never even be opened, regardless of its content.
    await writeFile(
      join(dir, 'archive', '2026-08-20-telegram-bot.log'),
      jsonLine({ ...base, timestamp: recentTs, message: 'claim granted', refId: 's-00000000000b', id: 'r-should-not-count', session: 'wrong-file', paths: ['x.ts'], ttlMinutes: 45, forced: false }),
      'utf8'
    );

    const stats = await coordinationStats({ days: 7, now });

    assert.equal(stats.days, 7);
    assert.equal(stats.claims, 3, 'r-1 + r-2 from app.log.jsonl, r-4 from the archive shard — r-old is outside the window, r-should-not-count is in a non-matching filename');
    assert.equal(stats.forced, 1);
    assert.equal(stats.denied, 1);
    assert.equal(stats.released, 1);
    assert.equal(stats.forcedReleases, 1);
    assert.equal(stats.renewed, 1);
    assert.equal(stats.gcExpired, 4);
    assert.equal(stats.hookWarnings, 2, 'two "hook warning" lines from the reservation-guard hook');
    assert.equal(stats.distinctSessions, 2, 'coord-audit and push-skill — pa-47 only appears on a "claim denied" line, never a "claim granted" one');
    assert.equal(stats.autoSessionIds, 0, 'neither coord-audit nor push-skill matches the s-xxxxxx auto-generated pattern');
    assert.deepEqual(stats.sessions, [
      { session: 'coord-audit', claims: 2 },
      { session: 'push-skill', claims: 1 },
    ]);
  });

  it('counts auto-generated session ids and caps/orders the sessions list at 10', async () => {
    const { coordinationStats } = await import('../src/commands/claim.js');
    const now = Date.now();
    const ts = new Date(now - 60_000).toISOString();
    const base = { level: 'info', module: 'reservations', timestamp: ts, message: 'claim granted', refId: 's-000000000000', ttlMinutes: 45, forced: false };

    // 11 distinct sessions with decreasing claim counts 11..1 — only the top
    // 10 by count should survive the cap. Exactly one session label matches
    // the auto-generated s-xxxxxx shape ("s-abc123"); the rest are human labels.
    const lines: string[] = [];
    for (let count = 11; count >= 1; count--) {
      const session = count === 11 ? 's-abc123' : `session-${count}`;
      for (let n = 0; n < count; n++) {
        lines.push(jsonLine({ ...base, id: `r-${count}-${n}`, session, paths: [`f${count}-${n}.ts`] }));
      }
    }
    await writeFile(join(dir, 'app.log.jsonl'), lines.join(''), 'utf8');

    const stats = await coordinationStats({ days: 7, now });

    assert.equal(stats.distinctSessions, 11);
    assert.equal(stats.autoSessionIds, 1, 'only "s-abc123" matches /^s-[0-9a-f]{6}$/');
    assert.equal(stats.sessions.length, 10, 'capped at 10 even though 11 distinct sessions exist');
    assert.equal(stats.sessions[0].session, 's-abc123');
    assert.equal(stats.sessions[0].claims, 11);
    for (let i = 1; i < stats.sessions.length; i++) {
      assert.ok(stats.sessions[i].claims <= stats.sessions[i - 1].claims, 'sessions must be sorted descending by claim count');
    }
    assert.equal(stats.sessions.some((s) => s.session === 'session-1'), false, 'the lowest (count=1) session must be excluded by the cap');
  });

  it('respects the --days window', async () => {
    const { coordinationStats } = await import('../src/commands/claim.js');
    const now = Date.now();
    const insideTs = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const outsideTs = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const base = { level: 'info', module: 'reservations', message: 'claim granted', session: 's-a', paths: ['x.ts'], ttlMinutes: 45, forced: false, refId: 's-000000000000' };

    await writeFile(
      join(dir, 'app.log.jsonl'),
      jsonLine({ ...base, timestamp: insideTs, id: 'r-inside' }) + jsonLine({ ...base, timestamp: outsideTs, id: 'r-outside' }),
      'utf8'
    );

    const stats3d = await coordinationStats({ days: 3, now });
    assert.equal(stats3d.claims, 1, 'only the 2-day-old entry falls inside a 3-day window');

    const stats7d = await coordinationStats({ days: 7, now });
    assert.equal(stats7d.claims, 2, 'both entries fall inside a 7-day window');
  });

  it('defaults to 7 days and clamps a non-finite or non-positive --days back to 7', async () => {
    const { coordinationStats } = await import('../src/commands/claim.js');
    const noOpts = await coordinationStats();
    assert.equal(noOpts.days, 7);

    const zeroDays = await coordinationStats({ days: 0 });
    assert.equal(zeroDays.days, 7);

    const nanDays = await coordinationStats({ days: NaN });
    assert.equal(nanDays.days, 7);
  });

  it('zero activity produces a fully-zeroed block, not an error', async () => {
    const { coordinationStats } = await import('../src/commands/claim.js');
    const stats = await coordinationStats({ days: 7 });
    assert.deepEqual(stats, {
      days: 7,
      claims: 0,
      forced: 0,
      denied: 0,
      released: 0,
      forcedReleases: 0,
      renewed: 0,
      gcExpired: 0,
      hookWarnings: 0,
      distinctSessions: 0,
      autoSessionIds: 0,
      sessions: [],
    });
  });

  it('skips an unparseable line without throwing', async () => {
    const { coordinationStats } = await import('../src/commands/claim.js');
    await writeFile(join(dir, 'app.log.jsonl'), 'this is not json\n{"truncated\n', 'utf8');
    const stats = await coordinationStats({ days: 7 });
    assert.equal(stats.claims, 0);
  });

  it('a missing archive directory does not throw', async () => {
    const { coordinationStats } = await import('../src/commands/claim.js');
    // No archive/ dir was ever created for this temp PA_HOME.
    const stats = await coordinationStats({ days: 7 });
    assert.equal(stats.claims, 0);
  });

  it('a window with only "hook warning" lines counts them and is reported as activity (C1c)', async () => {
    const { coordinationStats, claimsCommand } = await import('../src/commands/claim.js');
    const now = Date.now();
    const ts = new Date(now - 60_000).toISOString();
    const base = { level: 'warn', module: 'reservations', timestamp: ts, message: 'hook warning' };

    await writeFile(
      join(dir, 'app.log.jsonl'),
      jsonLine({ ...base, refId: 's-000000000010', reservationId: 'r-1', holder: 'coord-audit', path: 'a.ts', toolName: 'Edit', hookSessionId: 'claude-session-1' }) +
      jsonLine({ ...base, refId: 's-000000000011', reservationId: 'r-2', holder: 'coord-audit', path: 'b.ts', toolName: 'Write', hookSessionId: 'claude-session-2' }),
      'utf8'
    );

    const stats = await coordinationStats({ days: 7, now });
    assert.equal(stats.hookWarnings, 2);
    assert.equal(stats.claims, 0);

    const originalLog = console.log;
    let captured = '';
    console.log = ((msg?: unknown) => { captured += String(msg); }) as typeof console.log;
    try {
      const exitCode = await claimsCommand(['--stats']);
      assert.equal(exitCode, 0);
    } finally {
      console.log = originalLog;
    }
    assert.match(captured, /hook warnings:\s+2/);
    assert.doesNotMatch(captured, /no reservation activity logged in this window/, 'hook-warning-only activity must not be reported as "no reservation activity"');
  });
});

describe('pa claims --stats CLI layer', () => {
  let dir: string;
  let originalLog: typeof console.log;
  let captured: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    originalLog = console.log;
    captured = '';
    console.log = ((msg?: unknown) => { captured += String(msg); }) as typeof console.log;
  });

  afterEach(async () => {
    console.log = originalLog;
    await cleanup(dir);
  });

  it('pa claims --stats --json emits the CoordinationStats shape from synthetic log lines', async () => {
    const { claimsCommand } = await import('../src/commands/claim.js');
    const { claim } = await import('../src/lib/reservations.js');

    console.log = originalLog; // the claim() info-log printout must not pollute stdout capture below
    await claim({ paths: ['pa/src/cli-stats.ts'], session: 'coord-audit', note: 'stats smoke' });
    captured = '';
    console.log = ((msg?: unknown) => { captured += String(msg); }) as typeof console.log;

    const exitCode = await claimsCommand(['--stats', '--json']);
    assert.equal(exitCode, 0);

    const parsed = JSON.parse(captured);
    assert.equal(parsed.claims, 1);
    assert.equal(parsed.days, 7);
    assert.ok(Array.isArray(parsed.sessions));
  });

  it('pa claims --stats (human render) prints the fixed-format zero-activity block', async () => {
    const { claimsCommand } = await import('../src/commands/claim.js');
    const exitCode = await claimsCommand(['--stats']);
    assert.equal(exitCode, 0);
    assert.match(captured, /^Coordination stats \(last 7 days\):/);
    assert.match(captured, /claims granted:\s+0\s+\(0 forced\)/);
    assert.match(captured, /\(no reservation activity logged in this window\)/);
  });

  it('pa claims --stats --days 3 honors the --days flag', async () => {
    const { claimsCommand } = await import('../src/commands/claim.js');
    const exitCode = await claimsCommand(['--stats', '--days', '3', '--json']);
    assert.equal(exitCode, 0);
    const parsed = JSON.parse(captured);
    assert.equal(parsed.days, 3);
  });

  it('pa claims --stats --unknown-flag exits 2', async () => {
    const { claimsCommand } = await import('../src/commands/claim.js');
    const exitCode = await claimsCommand(['--stats', '--unknown-flag']);
    assert.equal(exitCode, 2);
  });
});
