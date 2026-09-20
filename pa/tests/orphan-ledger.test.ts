import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { createTempPaHome, cleanup } from './helpers.js';
import type { GitRunner } from '../src/lib/tree-drift.js';
import type { OrphanLedgerRecord } from '../src/lib/orphan-ledger.js';
import type { TopicOwnershipRegistry, TopicOwnershipRow } from '../src/lib/topic-ownership.js';
import type { DailyReconDeps } from '../src/lib/maintenance/jobs/daily-recon.js';
import { exclusiveLockKey } from '../src/commands/run.js';
import { BUILD_LOCK_RESOURCE } from '../src/lib/build-lock.js';

// Deterministic clock points. toIST() is machine-TZ-independent (PA_TZ_OFFSET_
// MINUTES unset in the test preload → default +5:30), so UTC stamps map
// exactly: 15:10Z → 20:40 IST, 15:15Z → 20:45 IST, 15:40Z → 21:10 IST.
const INSIDE = Date.parse('2026-09-02T15:15:00Z'); // 20:45 IST — in window
const WINDOW_START = Date.parse('2026-09-02T15:10:00Z'); // 20:40 IST — inclusive bound
const WINDOW_END = Date.parse('2026-09-02T15:40:00Z'); // 21:10 IST — inclusive bound
const OUTSIDE_EARLY = Date.parse('2026-09-02T12:00:00Z'); // 17:30 IST
const OUTSIDE_LATE = Date.parse('2026-09-02T16:00:00Z'); // 21:30 IST
const NEXT_DAY_INSIDE = Date.parse('2026-09-03T15:15:00Z'); // 20:45 IST next day

function ledgerRec(paths: string[], ownerTopic: string | null, ts = '2026-09-02T12:00:00.000Z'): OrphanLedgerRecord {
  return {
    ts,
    paths,
    owner_session: 's-someone',
    owner_topic: ownerTopic,
    source: 'dispatch-close',
    released_at: null,
  };
}

/** Synthetic ids only — the bot test-fixture rule (never real chat/thread
 *  ids in fixtures). */
const CHAT = '-1001234567890';

function registryOf(...rows: Array<[string, TopicOwnershipRow]>): TopicOwnershipRegistry {
  return new Map(rows);
}

interface AppendCall {
  chatId: number;
  threadId: number;
  task: { title: string; prompt: string; createdBy: string };
}

function recorderAppendTask() {
  const calls: AppendCall[] = [];
  const fn = async (
    chatId: number,
    threadId: number,
    input: { title: string; prompt: string; createdBy: string },
  ) => {
    calls.push({ chatId, threadId, task: input });
    return { id: 'tt-recorder', deduped: false };
  };
  return { calls, fn };
}

/** Sequenced status outputs: `statusOutputs[n]` answers the (n+1)th `status`
 *  call, clamped to the last — same convention as worker-edit-audit.test.ts's
 *  sequencedGitRunner. All other git args answer empty/success. */
function sweepGitRunner(...statusOutputs: string[]) {
  const calls: string[][] = [];
  let call = 0;
  const fn: GitRunner = async (_repoRoot: string, args: string[]) => {
    calls.push([...args]);
    if (args[0] === 'status') {
      const out = statusOutputs[Math.min(call, statusOutputs.length - 1)];
      call++;
      return { stdout: Buffer.from(out, 'utf8'), stderr: Buffer.alloc(0), code: 0 };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
  };
  return { calls, fn };
}

function makeDeps(overrides: Partial<DailyReconDeps> = {}): {
  deps: DailyReconDeps;
  git: ReturnType<typeof sweepGitRunner>;
  append: ReturnType<typeof recorderAppendTask>;
} {
  const git = sweepGitRunner('');
  const append = recorderAppendTask();
  const deps: DailyReconDeps = {
    now: INSIDE,
    gitRunner: git.fn,
    readActiveFn: async () => [],
    getActiveLocksFn: async () => [],
    readLedgerFn: async () => [],
    appendTaskFn: append.fn,
    repoRootFn: async () => 'C:/fake/repo',
    loadSupportTopicFn: async () => undefined,
    loadRegistryFn: async () => registryOf(),
    ...overrides,
  };
  return { deps, git, append };
}

async function readStateFile(): Promise<{
  ran_at: string;
  groups: Array<{ owner: string; paths_n: number; filed: boolean; source?: 'ledger' | 'registry' }>;
  unknown_n: number;
  registry_rows?: number;
  catch_all?: string | null;
} | null> {
  const { dailyReconStatePath } = await import('../src/lib/maintenance/jobs/daily-recon.js');
  try {
    return JSON.parse(await readFile(dailyReconStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

describe('orphan-ledger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  describe('store (append/read)', () => {
    it('round-trips records newest last with fields preserved', async () => {
      const { appendOrphanRecord, readOrphanLedger, orphanLedgerPath } = await import('../src/lib/orphan-ledger.js');
      await appendOrphanRecord({
        ts: '2026-09-02T10:00:00.000Z',
        paths: ['a.ts'],
        owner_session: 's-first',
        owner_topic: '7366_42',
        source: 'dispatch-close',
        released_at: '2026-09-02T10:05:00.000Z',
      });
      await appendOrphanRecord({
        ts: '2026-09-02T11:00:00.000Z',
        paths: ['b.ts'],
        owner_session: null,
        owner_topic: null,
        source: 'dispatch-close',
        released_at: null,
      });

      const records = await readOrphanLedger();
      assert.equal(records.length, 2);
      assert.equal(records[0].owner_session, 's-first');
      assert.equal(records[1].owner_session, null, 'the newest record is LAST (file order is chronological)');
      assert.equal(records[1].owner_topic, null);
      assert.equal(records[0].source, 'dispatch-close');
      assert.equal(records[0].released_at, '2026-09-02T10:05:00.000Z');
      // Two appends = two physical lines.
      const raw = await readFile(orphanLedgerPath(), 'utf8');
      assert.equal(raw.split('\n').filter((l) => l.trim()).length, 2);
    });

    it('chunks a path list that would exceed the 4 KB line cap, losing no path', async () => {
      const { appendOrphanRecord, readOrphanLedger, orphanLedgerPath, ORPHAN_LEDGER_MAX_LINE_BYTES } =
        await import('../src/lib/orphan-ledger.js');
      const longPaths = Array.from({ length: 30 }, (_, i) => `very/long/prefix-${i}/${'x'.repeat(280)}.ts`);
      const written = await appendOrphanRecord({
        ts: '2026-09-02T10:00:00.000Z',
        paths: longPaths,
        owner_session: 's-chunk',
        owner_topic: '1_2',
        source: 'dispatch-close',
        released_at: null,
      });
      assert.ok(written > 1, 'a >4 KB path list must be chunked');

      const raw = await readFile(orphanLedgerPath(), 'utf8');
      for (const line of raw.split('\n').filter((l) => l.trim())) {
        assert.ok(
          Buffer.byteLength(line + '\n', 'utf8') <= ORPHAN_LEDGER_MAX_LINE_BYTES,
          'every physical line stays within the cap',
        );
      }
      const records = await readOrphanLedger();
      assert.deepEqual(
        records.flatMap((r) => r.paths).sort(),
        [...longPaths].sort(),
        'chunking loses no path and never splits one',
      );
    });

    it('writes a lone over-long path as its own record rather than dropping it', async () => {
      const { appendOrphanRecord, readOrphanLedger, ORPHAN_LEDGER_MAX_LINE_BYTES } = await import('../src/lib/orphan-ledger.js');
      const huge = `giant/${'y'.repeat(6000)}.ts`;
      const written = await appendOrphanRecord({
        ts: '2026-09-02T10:00:00.000Z',
        paths: [huge],
        owner_session: null,
        owner_topic: null,
        source: 'dispatch-close',
        released_at: null,
      });
      assert.equal(written, 1);
      const records = await readOrphanLedger();
      assert.deepEqual(records.flatMap((r) => r.paths), [huge]);
      assert.ok(ORPHAN_LEDGER_MAX_LINE_BYTES > 0);
    });

    it('skips malformed lines with a warn-once and reads an absent file as []', async () => {
      const { appendOrphanRecord, readOrphanLedger, orphanLedgerPath } = await import('../src/lib/orphan-ledger.js');
      assert.deepEqual(await readOrphanLedger(), [], 'absent ledger reads as empty');

      const { appendFile } = await import('fs/promises');
      await appendOrphanRecord({
        ts: '2026-09-02T10:00:00.000Z',
        paths: ['good.ts'],
        owner_session: null,
        owner_topic: '7366_42',
        source: 'dispatch-close',
        released_at: null,
      });
      await appendFile(orphanLedgerPath(), '{not json\ngarbage line\n', 'utf8');

      const records = await readOrphanLedger();
      assert.equal(records.length, 1, 'the malformed tail line is skipped, the good record kept');
      assert.deepEqual(records[0].paths, ['good.ts']);
    });

    it('readOrphanLedger(0) returns [] and never hits the slice(-0) trap', async () => {
      const { appendOrphanRecord, readOrphanLedger } = await import('../src/lib/orphan-ledger.js');
      await appendOrphanRecord({
        ts: '2026-09-02T10:00:00.000Z',
        paths: ['a.ts'],
        owner_session: null,
        owner_topic: null,
        source: 'dispatch-close',
        released_at: null,
      });
      assert.deepEqual(await readOrphanLedger(0), []);
      assert.equal((await readOrphanLedger(1)).length, 1);
    });
  });

  describe('daily-recon sweep', () => {
    it('daily-recon skips outside 20:40-21:10 window', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      for (const now of [OUTSIDE_EARLY, OUTSIDE_LATE]) {
        const { deps, git, append } = makeDeps({ now });
        const result = await runDailyRecon(deps);
        assert.equal(result.touched, 0);
        assert.equal(result.detail?.skipped, 'outside-window');
        assert.deepEqual(git.calls, [], 'a skipped tick must not even list the tree');
        assert.deepEqual(append.calls, []);
      }
      assert.equal(await readStateFile(), null, 'no once-per-day marker is stamped outside the window');
    });

    it('window bounds 20:40 and 21:10 IST are inclusive', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      {
        const { deps } = makeDeps({ now: WINDOW_END });
        const result = await runDailyRecon(deps);
        assert.notEqual(result.detail?.skipped, 'outside-window', '21:10 IST is inside the window');
      }
      {
        const { deps } = makeDeps({ now: WINDOW_START });
        const result = await runDailyRecon(deps);
        assert.equal(result.detail?.skipped, 'already-ran', '20:40 IST passed the window gate (same-day marker hit)');
      }
    });

    it('daily-recon runs once per IST day', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, git, append } = makeDeps({
        gitRunner: sweepGitRunner(' M proj/a.ts\n').fn,
        readLedgerFn: async () => [ledgerRec(['proj/a.ts'], '7366_42')],
      });

      const first = await runDailyRecon(deps);
      assert.equal(first.touched, 1);
      assert.equal(append.calls.length, 1);
      const state1 = await readStateFile();
      assert.ok(state1);
      assert.equal(state1.ran_at.slice(0, 10), '2026-09-02');

      const second = await runDailyRecon({ ...deps, now: Date.parse('2026-09-02T15:20:00Z') });
      assert.equal(second.touched, 0);
      assert.equal(second.detail?.skipped, 'already-ran');
      assert.equal(append.calls.length, 1, 'the second same-day tick files nothing');

      const third = await runDailyRecon({ ...deps, now: NEXT_DAY_INSIDE });
      assert.equal(third.touched, 1, 'the next IST day runs again');
      assert.equal(append.calls.length, 2);
    });

    it('sweep skips reserved and locked paths', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      // (a) whole-tick stand-down on a git-workflow exclusive lock — the
      // clobber-sentinel idiom; the tree is not even listed.
      {
        const { deps, git } = makeDeps({
          getActiveLocksFn: async () => [{ resource: exclusiveLockKey('git-workflow') }],
        });
        const result = await runDailyRecon(deps);
        assert.equal(result.detail?.skipped, 'lock-held');
        assert.deepEqual(git.calls, []);
        assert.equal(await readStateFile(), null, 'a stood-down tick does not stamp the marker');
      }
      // (b) same for the @build gate lock and for an @build RESERVATION.
      {
        const { deps } = makeDeps({ getActiveLocksFn: async () => [{ resource: BUILD_LOCK_RESOURCE }] });
        assert.equal((await runDailyRecon(deps)).detail?.skipped, 'lock-held');
      }
      {
        const { deps, git } = makeDeps({ readActiveFn: async () => [{ paths: [BUILD_LOCK_RESOURCE] }] });
        assert.equal((await runDailyRecon(deps)).detail?.skipped, 'lock-held');
        assert.deepEqual(git.calls, []);
      }
      // (b2) a FOREIGN catchup lock (a different pa catchup process) still
      // stands the whole tick down — unchanged behavior.
      {
        const { deps, git } = makeDeps({
          getActiveLocksFn: async () => [{ resource: 'catchup', pid: process.pid + 1 }],
        });
        assert.equal((await runDailyRecon(deps)).detail?.skipped, 'lock-held');
        assert.deepEqual(git.calls, []);
      }
      // (c) an ordinary reservation covering ONE dirty path skips that path
      // only — the rest of the sweep still runs.
      {
        const { deps, append } = makeDeps({
          readActiveFn: async () => [{ paths: ['pa/src/kept'] }],
          gitRunner: sweepGitRunner(' M pa/src/kept/child.ts\nA  free.ts\n').fn,
          loadSupportTopicFn: async () => '310_5',
        });
        const result = await runDailyRecon(deps);
        assert.equal(result.touched, 0);
        assert.equal(append.calls.length, 1);
        assert.match(append.calls[0].task.prompt, /free\.ts/);
        assert.doesNotMatch(append.calls[0].task.prompt, /kept/, 'the reserved path is excluded from the sweep');
        const state = await readStateFile();
        assert.equal(state?.unknown_n, 1);
      }
    });

    it('does not self-skip under its own catchup lock (regression: daily-recon was dead 6 days)', async () => {
      // pa catchup acquires the `catchup` (or `catchup:topic:<t>`) blackboard
      // lock, then calls runDueJobs IN-PROCESS from inside that lock region —
      // so this job's own getActiveLocksFn always used to see that SAME lock
      // and stand itself down forever (empirical proof: the live ledger
      // showed lastOutcome:"skipped" every run for 6 days straight). A row
      // whose pid is this process's own pid must not trigger the skip.
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      // makeDeps spreads `overrides` AFTER building its own internal `git`
      // recorder, so an override here would silently detach the returned
      // `git` from `deps.gitRunner` (the existing "runs once per IST day"
      // test does exactly this and simply never asserts on `git.calls`) —
      // build the recorder ourselves and hand its `.fn` in instead.
      const git = sweepGitRunner(' M proj/a.ts\n');
      const { deps, append } = makeDeps({
        gitRunner: git.fn,
        readLedgerFn: async () => [ledgerRec(['proj/a.ts'], '7366_42')],
        getActiveLocksFn: async () => [{ resource: 'catchup', pid: process.pid }],
      });
      const result = await runDailyRecon(deps);
      assert.notEqual(result.detail?.skipped, 'lock-held', 'own-pid catchup lock must not self-skip');
      assert.equal(result.touched, 1, 'the body actually ran and filed the group');
      assert.equal(append.calls.length, 1);
      assert.ok(git.calls.length > 0, 'the tree was actually listed, proving the body executed');
    });

    it('sweep files land-or-discard task per owning topic', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner(' M proj/a.ts\n M proj/b.ts\n?? proj/notes.md\n').fn,
        readLedgerFn: async () => [ledgerRec(['proj/a.ts', 'proj/b.ts'], '7366_42')],
      });

      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 1);
      assert.equal(append.calls.length, 1);
      const call = append.calls[0];
      assert.equal(call.chatId, 7366);
      assert.equal(call.threadId, 42);
      assert.equal(call.task.title, 'Land or discard: 2 file(s)');
      assert.ok(call.task.prompt.length <= 500, 'prompt fits the appendTask validator cap');
      assert.ok(!/[\r\n]/.test(call.task.prompt), 'prompt is a single line');
      assert.ok(!call.task.prompt.startsWith('/'));
      assert.match(call.task.prompt, /proj\/a\.ts/);
      assert.match(call.task.prompt, /proj\/b\.ts/);
      assert.equal(call.task.createdBy, 'session:daily-recon');

      const state = await readStateFile();
      assert.deepEqual(state?.groups, [{ owner: '7366_42', paths_n: 2, filed: true, source: 'ledger' }]);
      assert.equal(state?.unknown_n, 1, 'the never-ledgered untracked file lands in the unknown lane');
    });

    it('newest ledger record wins when several name the same path', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner(' M proj/a.ts\n').fn,
        readLedgerFn: async () => [
          ledgerRec(['proj/a.ts'], '111_1', '2026-09-01T10:00:00.000Z'),
          ledgerRec(['proj/a.ts'], '222_2', '2026-09-02T10:00:00.000Z'),
        ],
      });
      await runDailyRecon(deps);
      assert.equal(append.calls.length, 1);
      assert.equal(append.calls[0].chatId, 222);
      assert.equal(append.calls[0].threadId, 2);
    });

    it('sweep unknowns route to support topic', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner('?? scratch/who-owns-this.ts\n').fn,
        loadSupportTopicFn: async () => '310_5',
      });
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 0);
      assert.equal(append.calls.length, 1);
      assert.equal(append.calls[0].chatId, 310);
      assert.equal(append.calls[0].threadId, 5);
      assert.match(append.calls[0].task.prompt, /scratch\/who-owns-this\.ts/);
      const state = await readStateFile();
      assert.equal(state?.unknown_n, 1);
    });

    it('unset topics.support skips unknown filing with no task and no throw', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner('?? scratch/who-owns-this.ts\n').fn,
        loadSupportTopicFn: async () => undefined,
      });
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 0);
      assert.deepEqual(append.calls, []);
      const state = await readStateFile();
      assert.equal(state?.unknown_n, 1, 'the unknown count is still reported for the digest');
    });

    it('sweep never mutates the tree', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const runner = sweepGitRunner(' M proj/a.ts\n?? scratch/x.ts\n');
      const { deps } = makeDeps({
        gitRunner: runner.fn,
        readLedgerFn: async () => [ledgerRec(['proj/a.ts'], '7366_42')],
        loadSupportTopicFn: async () => '310_5',
      });
      await runDailyRecon(deps);
      assert.ok(runner.calls.length >= 1);
      for (const args of runner.calls) {
        assert.deepEqual(args, ['status', '--porcelain'], `the sweep ran git ${args.join(' ')} — read-only only`);
      }
    });

    it('a malformed owner_topic group is reported filed:false and skips the task', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner(' M proj/a.ts\n').fn,
        readLedgerFn: async () => [ledgerRec(['proj/a.ts'], 'not-a-topic-key')],
      });
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 1, 'the group still counts as touched work');
      assert.deepEqual(append.calls, []);
      const state = await readStateFile();
      assert.deepEqual(state?.groups, [{ owner: 'not-a-topic-key', paths_n: 1, filed: false, source: 'ledger' }]);
    });

    it('registry attributes a dirty path with no ledger record to its owning topic', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner(' M projects/fitness-data-sync/scripts/a.py\n').fn,
        loadRegistryFn: async () => registryOf([`${CHAT}_5002`, { owned: ['projects/fitness-data-sync'] }]),
      });
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 1);
      assert.equal(append.calls.length, 1);
      assert.equal(append.calls[0].chatId, -1001234567890);
      assert.equal(append.calls[0].threadId, 5002);
      const state = await readStateFile();
      assert.equal(state?.groups[0]?.source, 'registry');
    });

    it('ledger wins over the registry for the same path', async () => {
      // Adjudication A: the ledger (who MADE the change) beats the registry
      // (who OWNS the area) even when both name the same path.
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner(' M proj/a.ts\n').fn,
        readLedgerFn: async () => [ledgerRec(['proj/a.ts'], `${CHAT}_5001`)],
        loadRegistryFn: async () => registryOf([`${CHAT}_5002`, { owned: ['proj'] }]),
      });
      await runDailyRecon(deps);
      assert.equal(append.calls.length, 1);
      assert.equal(append.calls[0].chatId, -1001234567890);
      assert.equal(append.calls[0].threadId, 5001, 'the LEDGER topic wins, not the registry row');
      const state = await readStateFile();
      assert.equal(state?.groups[0]?.owner, `${CHAT}_5001`);
      assert.equal(state?.groups[0]?.source, 'ledger');
    });

    it('registry attributes a path whose latest ledger record has a null owner', async () => {
      // The null-record gap is exactly the registry's filling case: a
      // null-owner latest record is no attribution, so the registry's next.
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner(' M proj/a.ts\n').fn,
        readLedgerFn: async () => [
          ledgerRec(['proj/a.ts'], `${CHAT}_5001`, '2026-09-01T10:00:00.000Z'),
          ledgerRec(['proj/a.ts'], null, '2026-09-02T10:00:00.000Z'),
        ],
        loadRegistryFn: async () => registryOf([`${CHAT}_5002`, { owned: ['proj'] }]),
      });
      await runDailyRecon(deps);
      assert.equal(append.calls.length, 1);
      assert.equal(append.calls[0].threadId, 5002);
      const state = await readStateFile();
      assert.equal(state?.groups[0]?.source, 'registry');
    });

    it('unknown lane routes to the registry catch-all via loadSupportTopic', async () => {
      // Real consumer over real producer: the registry file lives on disk in
      // the temp PA_HOME, loadRegistryFn AND loadSupportTopicFn are left at
      // their REAL defaults, and the dirty path (owned by nothing) must reach
      // the catch-all row through the actual loadSupportTopic seam.
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { writeFile } = await import('fs/promises');
      const { topicOwnershipRegistryPath } = await import('../src/lib/topic-ownership.js');
      await writeFile(
        topicOwnershipRegistryPath(),
        JSON.stringify({ [`${CHAT}_5002`]: { role: 'catch-all' } }),
        'utf8',
      );
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner('?? scratch/who-owns-this.ts\n').fn,
      });
      delete deps.loadSupportTopicFn;
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 0);
      assert.equal(append.calls.length, 1);
      assert.equal(append.calls[0].chatId, -1001234567890);
      assert.equal(append.calls[0].threadId, 5002);
    });

    it('no catch-all and no topics.support leaves unknown paths unfiled with the registry-aware warn', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner('?? scratch/who-owns-this.ts\n').fn,
        loadRegistryFn: async () => registryOf([`${CHAT}_5001`, { owned: ['pa/src'] }]),
      });
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 0);
      assert.deepEqual(append.calls, []);
      const state = await readStateFile();
      assert.equal(state?.unknown_n, 1, 'behavior is identical to the pre-registry unset-knob case');
    });

    it('state records registry_rows, catch_all and per-group source', async () => {
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { deps, append } = makeDeps({
        gitRunner: sweepGitRunner(' M ledger/a.ts\n M reg/b.ts\n?? scratch/unclaimed.ts\n').fn,
        readLedgerFn: async () => [ledgerRec(['ledger/a.ts'], `${CHAT}_5001`)],
        loadRegistryFn: async () =>
          registryOf([`${CHAT}_5002`, { owned: ['reg'], role: 'catch-all' }]),
      });
      await runDailyRecon(deps);
      assert.equal(append.calls.length, 2, 'the ledger group and the registry group each file one task');
      const state = await readStateFile();
      assert.equal(state?.registry_rows, 1);
      assert.equal(state?.catch_all, `${CHAT}_5002`);
      assert.equal(state?.unknown_n, 1, 'the unclaimed path stays in the unknown lane (support unset)');
      const byOwner = new Map((state?.groups ?? []).map((g) => [g.owner, g.source]));
      assert.equal(byOwner.get(`${CHAT}_5001`), 'ledger');
      assert.equal(byOwner.get(`${CHAT}_5002`), 'registry');
    });
  });

  describe('land-or-discard prompt', () => {
    it('drops paths until the rendered line fits the 500-char cap', async () => {
      const { buildLandOrDiscardPrompt } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const paths = Array.from({ length: 30 }, (_, i) => `deeply/nested/dir-${i}/${'p'.repeat(60)}.ts`);
      const prompt = buildLandOrDiscardPrompt(paths);
      assert.ok(prompt.length <= 500);
      assert.ok(!/[\r\n]/.test(prompt));
      assert.ok(!prompt.startsWith('/'));
      assert.match(prompt, /dir-0\//, 'the first paths survive truncation');
      assert.doesNotMatch(prompt, /dir-29\//, 'the tail paths are dropped first');
    });

    it('lists at most 6 paths per task prompt', async () => {
      const { buildLandOrDiscardPrompt } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const paths = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
      const prompt = buildLandOrDiscardPrompt(paths);
      for (let i = 0; i < 6; i++) assert.match(prompt, new RegExp(`f${i}\\.ts`));
      assert.doesNotMatch(prompt, /f6\.ts/);
      assert.doesNotMatch(prompt, /f9\.ts/);
    });
  });

  describe('seams (real producer → real consumer)', () => {
    it('filed prompt passes the real appendTask validator and lands in the real queue', async () => {
      const { buildLandOrDiscardPrompt } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { appendTask, listTasks } = await import('../src/lib/topic-tasks.js');
      const { runDailyRecon } = await import('../src/lib/maintenance/jobs/daily-recon.js');

      // Full run with the REAL appendTask (appendTaskFn removed from deps so
      // runDailyRecon falls back to it): the sweep's prompt must satisfy the
      // store's own validators.
      const { deps } = makeDeps({
        gitRunner: sweepGitRunner(' M proj/real.ts\n').fn,
        readLedgerFn: async () => [ledgerRec(['proj/real.ts'], '7366_42')],
        loadSupportTopicFn: async () => undefined,
      });
      delete deps.appendTaskFn;
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 1);

      const tasks = await listTasks(7366, 42);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].title, 'Land or discard: 1 file(s)');
      assert.match(tasks[0].prompt, /proj\/real\.ts/);
      assert.equal(tasks[0].created_by, 'session:daily-recon');
      assert.ok(buildLandOrDiscardPrompt(['proj/real.ts']).length <= 500);
    });

    it('a real dispatch-close ledger record drives a real land-or-discard task (ledger seam)', async () => {
      // Producer side: REAL claim/openWindow/closeWindow writes the REAL
      // ledger via writeOrphanLedgerRecords inside closeWindow.
      const { claim } = await import('../src/lib/reservations.js');
      const { openWindow, closeWindow } = await import('../src/lib/worker-edit-audit.js');
      const { runDailyRecon, dailyReconStatePath } = await import('../src/lib/maintenance/jobs/daily-recon.js');
      const { listTasks } = await import('../src/lib/topic-tasks.js');
      const { readFile: readF } = await import('fs/promises');

      const claimed = await claim({ paths: ['fake/owned.ts'], session: 's-seam', note: 'seam test' });
      assert.equal(claimed.ok, true);

      const git = sweepGitRunner('', ' M fake/owned.ts\n'); // clean at open, dirty at close
      const win = await openWindow({ resource: 'topic-seam_1', gitRunner: git.fn });
      assert.ok(win);
      const close = await closeWindow(win, {
        worker: 'agy',
        gitRunner: git.fn,
        topic: { chatId: 7366, threadId: 42 },
        notifyFn: async () => ({ sent: true }),
      });
      assert.deepEqual(close.findings, [], 'the covered finding alerts nothing');

      // Consumer side: REAL ledger reader AND REAL task store (readLedgerFn /
      // appendTaskFn removed so runDailyRecon falls back to both).
      const { deps } = makeDeps({
        gitRunner: git.fn,
        repoRootFn: async () => 'C:/fake/repo',
        loadSupportTopicFn: async () => undefined,
      });
      delete deps.readLedgerFn;
      delete deps.appendTaskFn;
      const result = await runDailyRecon(deps);
      assert.equal(result.touched, 1);

      const tasks = await listTasks(7366, 42);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].title, 'Land or discard: 1 file(s)');
      assert.match(tasks[0].prompt, /fake\/owned\.ts/);
      assert.equal(tasks[0].created_by, 'session:daily-recon');

      const state = JSON.parse(await readF(dailyReconStatePath(), 'utf8'));
      assert.deepEqual(state.groups, [{ owner: '7366_42', paths_n: 1, filed: true, source: 'ledger' }]);
      assert.equal(state.unknown_n, 0);
    });
  });
});
