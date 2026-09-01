import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import type { GitRunner } from '../src/lib/tree-drift.js';
import type { EditFinding, TreeEntry, TreeSnapshot } from '../src/lib/worker-edit-audit.js';

// __dirname here is pa/dist/tests once compiled — walk back up to the pa/
// package root, same convention as tests/timer-inventory.test.ts.
const PA_ROOT = join(__dirname, '..', '..');

function snap(entries: Record<string, TreeEntry>, headSha = 'sha-1'): TreeSnapshot {
  return { headSha, entries };
}

/** A GitRunner whose `git status --porcelain` output changes on every call —
 *  `statusOutputs[n]` is returned on the (n+1)th `status` invocation (clamped
 *  to the last entry once exhausted). `git rev-parse HEAD` always answers
 *  `headSha`. No real files are touched — paths never need to exist on disk;
 *  a `fs.stat` failure just yields the module's documented {mtimeMs:0,size:-1}
 *  fallback consistently on both sides of a diff. */
function sequencedGitRunner(statusOutputs: string[], headSha = 'deadbeefdead'): GitRunner {
  let call = 0;
  return async (_repoRoot: string, args: string[]) => {
    if (args[0] === 'status') {
      const out = statusOutputs[Math.min(call, statusOutputs.length - 1)];
      call++;
      return { stdout: Buffer.from(out, 'utf8'), stderr: Buffer.alloc(0), code: 0 };
    }
    if (args[0] === 'rev-parse') {
      return { stdout: Buffer.from(`${headSha}\n`, 'utf8'), stderr: Buffer.alloc(0), code: 0 };
    }
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
  };
}

const failingGitRunner: GitRunner = async () => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from('fatal: not a git repository'),
  code: 128,
});

async function listWindowFiles(windowDir: string): Promise<string[]> {
  try {
    return (await readdir(windowDir)).filter((f) => f.startsWith('w-'));
  } catch {
    return [];
  }
}

describe('worker-edit-audit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
  });

  afterEach(async () => {
    delete process.env.PA_WORKER_EDIT_AUDIT;
    delete process.env.PA_WORKER_EDIT_AUDIT_IGNORE;
    delete process.env.PA_WORKER_EDIT_AUDIT_MAX_ALERTS_PER_DAY;
    await cleanup(dir);
  });

  describe('diffSnapshots (frozen §3.4)', () => {
    it('reports an appeared entry', async () => {
      const { diffSnapshots } = await import('../src/lib/worker-edit-audit.js');
      const before = snap({});
      const after = snap({ 'a.ts': { xy: '??', mtimeMs: 1, size: 1 } });
      assert.deepEqual(diffSnapshots(before, after), [{ path: 'a.ts', kind: 'appeared' }]);
    });

    it('reports modified via a changed mtimeMs alone (same xy, same size)', async () => {
      const { diffSnapshots } = await import('../src/lib/worker-edit-audit.js');
      const before = snap({ 'a.ts': { xy: ' M', mtimeMs: 1, size: 10 } });
      const after = snap({ 'a.ts': { xy: ' M', mtimeMs: 2, size: 10 } });
      assert.deepEqual(diffSnapshots(before, after), [{ path: 'a.ts', kind: 'modified' }]);
    });

    it('reports modified via a changed size alone (same xy, same mtimeMs)', async () => {
      const { diffSnapshots } = await import('../src/lib/worker-edit-audit.js');
      const before = snap({ 'a.ts': { xy: ' M', mtimeMs: 1, size: 10 } });
      const after = snap({ 'a.ts': { xy: ' M', mtimeMs: 1, size: 20 } });
      assert.deepEqual(diffSnapshots(before, after), [{ path: 'a.ts', kind: 'modified' }]);
    });

    it('reports modified via a changed xy code alone', async () => {
      const { diffSnapshots } = await import('../src/lib/worker-edit-audit.js');
      const before = snap({ 'a.ts': { xy: ' M', mtimeMs: 1, size: 10 } });
      const after = snap({ 'a.ts': { xy: 'MM', mtimeMs: 1, size: 10 } });
      assert.deepEqual(diffSnapshots(before, after), [{ path: 'a.ts', kind: 'modified' }]);
    });

    it('reports a vanished entry when HEAD is unchanged', async () => {
      const { diffSnapshots } = await import('../src/lib/worker-edit-audit.js');
      const before = snap({ 'a.ts': { xy: ' M', mtimeMs: 1, size: 10 } });
      const after = snap({});
      assert.deepEqual(diffSnapshots(before, after), [{ path: 'a.ts', kind: 'vanished' }]);
    });

    it('suppresses vanished findings wholesale when headSha differs (C5 — a commit landed inside the window)', async () => {
      const { diffSnapshots } = await import('../src/lib/worker-edit-audit.js');
      const before = snap({ 'a.ts': { xy: ' M', mtimeMs: 1, size: 10 } }, 'sha-1');
      const after = snap({}, 'sha-2');
      assert.deepEqual(diffSnapshots(before, after), []);
    });

    it('reports a file dirty before and FURTHER modified during the window, even with an identical status code (C3 — the AI-172 specimen)', async () => {
      const { diffSnapshots } = await import('../src/lib/worker-edit-audit.js');
      // A status-code-only comparison would see " M" both before and after and
      // wrongly report nothing here — this is exactly the AI-172 failure mode.
      const before = snap({ 'shared.ts': { xy: ' M', mtimeMs: 1000, size: 500 } });
      const after = snap({ 'shared.ts': { xy: ' M', mtimeMs: 2000, size: 550 } });
      assert.deepEqual(diffSnapshots(before, after), [{ path: 'shared.ts', kind: 'modified' }]);
    });
  });

  describe('filterUnreserved', () => {
    it('drops a path under a directory reservation and respects the pathsOverlap sibling boundary', async () => {
      const { filterUnreserved } = await import('../src/lib/worker-edit-audit.js');
      const findings: EditFinding[] = [
        { path: 'pa/src/sub/child.ts', kind: 'modified' },
        { path: 'pa/src/a.ts', kind: 'modified' },
        { path: 'pa/src/ab.ts', kind: 'modified' },
      ];
      const result = filterUnreserved(findings, ['pa/src/sub', 'pa/src/a.ts']);
      assert.deepEqual(result, [{ path: 'pa/src/ab.ts', kind: 'modified' }]);
    });
  });

  describe('applyIgnoreList', () => {
    it('drops a path under an ignore prefix and respects the directory boundary', async () => {
      const { applyIgnoreList } = await import('../src/lib/worker-edit-audit.js');
      const findings: EditFinding[] = [
        { path: 'plans/x.md', kind: 'modified' },
        { path: 'plansmith/x.md', kind: 'modified' },
      ];
      assert.deepEqual(applyIgnoreList(findings, ['plans']), [{ path: 'plansmith/x.md', kind: 'modified' }]);
    });

    it('returns findings unchanged when the prefix list is empty', async () => {
      const { applyIgnoreList } = await import('../src/lib/worker-edit-audit.js');
      const findings: EditFinding[] = [{ path: 'a.ts', kind: 'modified' }];
      assert.deepEqual(applyIgnoreList(findings, []), findings);
    });
  });

  describe('findingsDedupKey', () => {
    it('is order-independent', async () => {
      const { findingsDedupKey } = await import('../src/lib/worker-edit-audit.js');
      const a: EditFinding[] = [{ path: 'a.ts', kind: 'modified' }, { path: 'b.ts', kind: 'appeared' }];
      const b: EditFinding[] = [{ path: 'b.ts', kind: 'appeared' }, { path: 'a.ts', kind: 'modified' }];
      assert.equal(findingsDedupKey(a), findingsDedupKey(b));
    });

    it('changes when the finding set changes', async () => {
      const { findingsDedupKey } = await import('../src/lib/worker-edit-audit.js');
      const a: EditFinding[] = [{ path: 'a.ts', kind: 'modified' }];
      const b: EditFinding[] = [{ path: 'a.ts', kind: 'appeared' }];
      assert.notEqual(findingsDedupKey(a), findingsDedupKey(b));
    });

    it('is prefixed with the worker-edit-audit: family name (12 hex chars)', async () => {
      const { findingsDedupKey } = await import('../src/lib/worker-edit-audit.js');
      assert.match(findingsDedupKey([{ path: 'a.ts', kind: 'modified' }]), /^worker-edit-audit:[0-9a-f]{12}$/);
    });
  });

  describe('openWindow', () => {
    it('returns null and writes nothing when PA_WORKER_EDIT_AUDIT=0', async () => {
      process.env.PA_WORKER_EDIT_AUDIT = '0';
      const { openWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      const win = await openWindow({ resource: 'topic-disabled_1' });
      assert.equal(win, null);
      assert.deepEqual(await listWindowFiles(windowDir()), []);
    });

    it('returns null (does not throw) when the injected gitRunner fails', async () => {
      const { openWindow } = await import('../src/lib/worker-edit-audit.js');
      const win = await openWindow({ resource: 'topic-gitfail_1', gitRunner: failingGitRunner });
      assert.equal(win, null);
    });
  });

  describe('closeWindow', () => {
    it('closeWindow(null) returns skipped: "no-window"', async () => {
      const { closeWindow } = await import('../src/lib/worker-edit-audit.js');
      const result = await closeWindow(null, { worker: 'agy' });
      assert.deepEqual(result, { findings: [], notified: false, concurrentWindows: 0, skipped: 'no-window' });
    });

    it('deletes the window file on the clean path (findings reported, notify succeeds)', async () => {
      const { openWindow, closeWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      const gitRunner = sequencedGitRunner([
        ' M fake/clean-a.ts\n',
        ' M fake/clean-a.ts\nA  fake/clean-b.ts\n',
      ]);

      const win = await openWindow({ resource: 'topic-clean_1', gitRunner });
      assert.ok(win);
      assert.equal((await listWindowFiles(windowDir())).length, 1);

      let notifyCalls = 0;
      const result = await closeWindow(win, {
        worker: 'agy',
        gitRunner,
        notifyFn: async () => { notifyCalls++; return { sent: true }; },
      });

      assert.deepEqual(result.findings, [{ path: 'fake/clean-b.ts', kind: 'appeared' }]);
      assert.equal(result.notified, true);
      assert.equal(notifyCalls, 1);
      assert.deepEqual(await listWindowFiles(windowDir()), []);
    });

    it('deletes the window file on the no-findings path', async () => {
      const { openWindow, closeWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      const gitRunner = sequencedGitRunner(['', '']);

      const win = await openWindow({ resource: 'topic-nofind_1', gitRunner });
      assert.ok(win);

      const result = await closeWindow(win, { worker: 'agy', gitRunner });
      assert.deepEqual(result, { findings: [], notified: false, concurrentWindows: 0 });
      assert.deepEqual(await listWindowFiles(windowDir()), []);
    });

    it('deletes the window file on the git-failed path', async () => {
      const { openWindow, closeWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      const openRunner = sequencedGitRunner([' M fake/x.ts\n']);

      const win = await openWindow({ resource: 'topic-gitfail2_1', gitRunner: openRunner });
      assert.ok(win);

      const result = await closeWindow(win, { worker: 'agy', gitRunner: failingGitRunner });
      assert.deepEqual(result.findings, []);
      assert.equal(result.skipped, 'git-failed');
      assert.deepEqual(await listWindowFiles(windowDir()), []);
    });

    it('deletes the window file even when the notify double throws', async () => {
      const { openWindow, closeWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      const gitRunner = sequencedGitRunner(['', 'A  fake/notify-throws.ts\n']);

      const win = await openWindow({ resource: 'topic-throws_1', gitRunner });
      assert.ok(win);

      const result = await closeWindow(win, {
        worker: 'agy',
        gitRunner,
        notifyFn: async () => { throw new Error('simulated notify failure'); },
      });

      assert.equal(result.findings.length, 1);
      assert.equal(result.notified, false);
      assert.deepEqual(await listWindowFiles(windowDir()), []);
    });

    it('drops a finding whose path was claimed and released inside the window (coverage item 3 / C2)', async () => {
      const { openWindow, closeWindow } = await import('../src/lib/worker-edit-audit.js');
      const { claim, release } = await import('../src/lib/reservations.js');
      const gitRunner = sequencedGitRunner(['', 'A  fake/released.ts\n']);

      const win = await openWindow({ resource: 'topic-released_1', gitRunner });
      assert.ok(win);

      const claimed = await claim({ paths: ['fake/released.ts'], session: 's-well-behaved', note: 'well behaved' });
      assert.equal(claimed.ok, true);
      await release({ id: claimed.reservation!.id });

      const result = await closeWindow(win, { worker: 'agy', gitRunner });
      assert.deepEqual(result.findings, []);
    });

    it('counts a second open window overlapping the span and excludes the window being closed', async () => {
      const { openWindow, closeWindow } = await import('../src/lib/worker-edit-audit.js');
      const gitRunner = sequencedGitRunner([
        ' M fake/concurrent-a.ts\n',
        ' M fake/concurrent-a.ts\n',
        ' M fake/concurrent-a.ts\nA  fake/concurrent-b.ts\n',
      ]);

      const win1 = await openWindow({ resource: 'topic-conc_1', gitRunner });
      const win2 = await openWindow({ resource: 'topic-conc_2', gitRunner });
      assert.ok(win1 && win2);

      const result = await closeWindow(win1, { worker: 'agy', gitRunner });
      assert.equal(result.concurrentWindows, 1);

      await closeWindow(win2, { worker: 'agy', gitRunner }); // drain the remaining window file
    });

    it('renders the bot-restarted fallback when worker is null, and carries a _Ref: s- token', async () => {
      const { openWindow, closeWindow } = await import('../src/lib/worker-edit-audit.js');
      const gitRunner = sequencedGitRunner(['', 'A  fake/body.ts\n']);

      let capturedSubject = '';
      let capturedBody = '';
      const win = await openWindow({ resource: 'topic-null-worker_1', gitRunner });
      const result = await closeWindow(win, {
        worker: null,
        gitRunner,
        notifyFn: async (subject: string, body: string) => {
          capturedSubject = subject;
          capturedBody = body;
          return { sent: true };
        },
      });

      assert.equal(result.findings.length, 1);
      assert.equal(capturedSubject, 'Unreserved worker edits: 1 path(s)');
      assert.match(capturedBody, /worker: `unknown \(bot restarted mid-dispatch\)`/);
      assert.match(capturedBody, /_Ref: s-[0-9a-f]{12}_/);
    });
  });

  describe('day cap (C7)', () => {
    it('skips notifyUser once the day-cap is already exhausted, without incrementing further', async () => {
      const { openWindow, closeWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      await mkdir(windowDir(), { recursive: true });
      const todayKey = new Date().toISOString().slice(0, 10);
      await writeFile(join(windowDir(), 'alert-count.json'), JSON.stringify({ day: todayKey, count: 10 }), 'utf8');

      const gitRunner = sequencedGitRunner(['', 'A  fake/cap.ts\n']);
      let notifyCalls = 0;
      const win = await openWindow({ resource: 'topic-cap_1', gitRunner });
      const result = await closeWindow(win, {
        worker: 'agy',
        gitRunner,
        notifyFn: async () => { notifyCalls++; return { sent: true }; },
      });

      assert.equal(result.skipped, 'alert-cap');
      assert.equal(result.notified, false);
      assert.equal(notifyCalls, 0, 'notifyFn must not be called once the day-cap is exhausted');
    });

    it('resets to zero for today when the stored counter is from a stale day', async () => {
      const { openWindow, closeWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      await mkdir(windowDir(), { recursive: true });
      await writeFile(join(windowDir(), 'alert-count.json'), JSON.stringify({ day: '2000-01-01', count: 10 }), 'utf8');

      const gitRunner = sequencedGitRunner(['', 'A  fake/reset.ts\n']);
      let notifyCalls = 0;
      const win = await openWindow({ resource: 'topic-reset_1', gitRunner });
      const result = await closeWindow(win, {
        worker: 'agy',
        gitRunner,
        notifyFn: async () => { notifyCalls++; return { sent: true }; },
      });

      assert.equal(result.skipped, undefined);
      assert.equal(notifyCalls, 1);
    });

    it('respects PA_WORKER_EDIT_AUDIT_MAX_ALERTS_PER_DAY when set to a custom value', async () => {
      process.env.PA_WORKER_EDIT_AUDIT_MAX_ALERTS_PER_DAY = '1';
      const { openWindow, closeWindow, windowDir } = await import('../src/lib/worker-edit-audit.js');
      await mkdir(windowDir(), { recursive: true });
      const todayKey = new Date().toISOString().slice(0, 10);
      await writeFile(join(windowDir(), 'alert-count.json'), JSON.stringify({ day: todayKey, count: 1 }), 'utf8');

      const gitRunner = sequencedGitRunner(['', 'A  fake/custom-cap.ts\n']);
      let notifyCalls = 0;
      const win = await openWindow({ resource: 'topic-customcap_1', gitRunner });
      const result = await closeWindow(win, {
        worker: 'agy',
        gitRunner,
        notifyFn: async () => { notifyCalls++; return { sent: true }; },
      });

      assert.equal(result.skipped, 'alert-cap');
      assert.equal(notifyCalls, 0);
    });
  });

  describe('listOpenWindows', () => {
    it('skips an unparseable window file without deleting it', async () => {
      const { listOpenWindows, windowDir } = await import('../src/lib/worker-edit-audit.js');
      await mkdir(windowDir(), { recursive: true });
      await writeFile(join(windowDir(), 'w-deadbeef0000.json'), '{ not valid json', 'utf8');

      const windows = await listOpenWindows();
      assert.deepEqual(windows, []);

      const filesAfter = await readdir(windowDir());
      assert.ok(filesAfter.includes('w-deadbeef0000.json'), 'the unparseable file must not be deleted');
    });
  });

  // ---------------------------------------------------------------------
  // C17 — the topic-7366 live specimen. Real reservation IDs/sessions and
  // (for four of the five) real, currently-held path lists captured via
  // `pa claims` at the start of this wave's execution. r-9839a079
  // (pa73-voice-echo) had already been released by the time WP-1 was built —
  // its ONE concretely-stated path from the spec's own C20 is used for it
  // (projects/telegram-bot/src/main.ts). Eleven of the thirteen dirty paths
  // below are drawn from those real reservations' real path lists (trimmed
  // to eleven entries to match the spec's exact count); the remaining two —
  // `README.md` (modified) and `docs/DEVELOPMENT.md` (appeared) — are the
  // exact two the spec names as uncovered.
  // ---------------------------------------------------------------------
  describe('topic-7366 fixture (C17)', () => {
    it('yields exactly the two unreserved findings and none of the eleven reserved ones', async () => {
      const { diffSnapshots, filterUnreserved } = await import('../src/lib/worker-edit-audit.js');

      const reservedDirtyPaths = [
        // r-4981572c (pa73-e2-buildlock)
        'pa/src/lib/build-lock.ts',
        'pa/tests/build-lock.test.ts',
        'docs/multi-session-protocol.md',
        // r-076b1994 (pa73-e3-postmortem)
        'pa/src/lib/postmortem.ts',
        'pa/src/self-improver.ts',
        'pa/tests/self-improver.test.ts',
        'plans/INDEX.md',
        // r-13d3507d (pa73-e3-postmortem, sibling reservation)
        'pa/tests/postmortem.test.ts',
        // r-da6a3a63 (pa73-ai171-families12) — trimmed to 3 of its 4 real
        // paths to land the fixture on the spec's exact "eleven" figure.
        'projects/telegram-bot/src/logic.ts',
        'projects/telegram-bot/src/tests/poll-loop.test.ts',
        'projects/telegram-bot/src/tests/poll-loop-maintenance.test.ts',
      ];
      assert.equal(reservedDirtyPaths.length, 11);

      const coveredPaths = [
        ...reservedDirtyPaths,
        // r-9839a079 (pa73-voice-echo) — reconstructed from C20's one stated
        // fact; not itself dirty in this fixture, which is realistic (a
        // reservation can cover ground the current window never touches).
        'projects/telegram-bot/src/main.ts',
      ];

      const beforeEntries: Record<string, TreeEntry> = {};
      const afterEntries: Record<string, TreeEntry> = {};
      for (const p of reservedDirtyPaths) {
        beforeEntries[p] = { xy: ' M', mtimeMs: 1000, size: 100 };
        afterEntries[p] = { xy: ' M', mtimeMs: 2000, size: 200 }; // actively edited, but reserved
      }
      beforeEntries['README.md'] = { xy: ' M', mtimeMs: 1000, size: 100 };
      afterEntries['README.md'] = { xy: ' M', mtimeMs: 2000, size: 200 };
      // docs/DEVELOPMENT.md exists only in `after` — appeared during the window.
      afterEntries['docs/DEVELOPMENT.md'] = { xy: '??', mtimeMs: 3000, size: 50 };

      const before = snap(beforeEntries);
      const after = snap(afterEntries);

      const rawFindings = diffSnapshots(before, after);
      assert.equal(rawFindings.length, 13, 'thirteen dirty paths total (C17)');

      const findings = filterUnreserved(rawFindings, coveredPaths);
      assert.deepEqual(
        findings.slice().sort((a, b) => a.path.localeCompare(b.path)),
        [
          { path: 'README.md', kind: 'modified' },
          { path: 'docs/DEVELOPMENT.md', kind: 'appeared' },
        ].sort((a, b) => a.path.localeCompare(b.path)),
      );
    });
  });

  describe('module-string discipline (C19)', () => {
    it('every log() call in the module uses module "worker-edit-audit", never "reservations"', async () => {
      const source = await readFile(join(PA_ROOT, 'src', 'lib', 'worker-edit-audit.ts'), 'utf8');
      const moduleNames = [...source.matchAll(/log\(\s*'(?:debug|info|warn|error)'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
      assert.ok(moduleNames.length > 0, 'expected at least one log() call in the module');
      for (const name of moduleNames) {
        assert.equal(name, 'worker-edit-audit', `log() call used module "${name}", expected "worker-edit-audit"`);
      }
    });
  });
});
