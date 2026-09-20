import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  RECENT_MS,
  runBrainSweep,
  isManagedBrainPath,
  brainSweepDeferralDedupKey,
  type DeferredPath,
} from '../src/lib/brain-sweep.js';
import { toIST } from '../src/ist.js';
import type { TreeSnapshot } from '../src/lib/worker-edit-audit.js';

const HOUR = 60 * 60 * 1000;
// Wall clock is "now", not a fixed epoch: the real-repo commit paths stat
// REAL files, so a past frozen epoch would misread every fresh mtime as
// recently-edited. Everything mtime-relative is constructed FROM NOW.
const NOW = Date.now();

function istDate(nowMs: number): string {
  const ist = toIST(new Date(nowMs));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

interface NotifyCall {
  subject: string;
  body: string;
  opts?: { dedupKey?: string; severity?: string };
}

function captureNotify(): { calls: NotifyCall[]; fn: (s: string, b: string, o?: NotifyCall['opts']) => Promise<unknown> } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    fn: async (subject, body, opts) => {
      calls.push({ subject, body, opts });
      return { sent: true, suppressed: false };
    },
  };
}

function snap(entries: Record<string, { xy: string; mtimeMs: number; size: number }>): TreeSnapshot {
  return { headSha: 'deadbeef', entries };
}

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

const ledgerRec = (paths: string[], owner_session: string | null, owner_topic: string | null) => ({
  ts: new Date(NOW - HOUR).toISOString(),
  paths,
  owner_session,
  owner_topic,
  source: 'dispatch-close',
  released_at: null,
});

describe('brain-sweep', () => {
  let paDir: string;
  let repo: string;

  beforeEach(async () => {
    paDir = await createTempPaHome();
  });

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
    repo = '';
    await cleanup(paDir);
  });

  /** Real temp repo with tracked, dirty CLAUDE.md + inventory/x.md. */
  async function dirtyManagedRepo(): Promise<string> {
    repo = await mkdtemp(join(tmpdir(), 'brain-sweep-repo-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    await mkdir(join(repo, 'inventory'), { recursive: true });
    await writeFile(join(repo, 'CLAUDE.md'), 'brain\n', 'utf8');
    await writeFile(join(repo, 'inventory', 'x.md'), 'inv\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(join(repo, 'CLAUDE.md'), 'brain — changed\n', 'utf8');
    await writeFile(join(repo, 'inventory', 'x.md'), 'inv — changed\n', 'utf8');
    // Back-date the dirty mtimes past RECENT_MS — a just-written file is
    // correctly "recently-edited" and would defer instead of committing.
    const old = new Date(NOW - HOUR);
    await utimes(join(repo, 'CLAUDE.md'), old, old);
    await utimes(join(repo, 'inventory', 'x.md'), old, old);
    return repo;
  }

  /** Real temp repo with tracked, dirty BACKLOG.md only (the drain safety-net
   *  managed path). Same back-dating pattern as dirtyManagedRepo. */
  async function dirtyBacklogRepo(): Promise<string> {
    repo = await mkdtemp(join(tmpdir(), 'brain-sweep-backlog-repo-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'test']);
    await writeFile(join(repo, 'BACKLOG.md'), '# Open Items\n', 'utf8');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'base']);
    await writeFile(join(repo, 'BACKLOG.md'), '# Open Items\n- new item\n', 'utf8');
    const old = new Date(NOW - HOUR);
    await utimes(join(repo, 'BACKLOG.md'), old, old);
    return repo;
  }

  it('isManagedBrainPath: exact CLAUDE.md and inventory/ children only (boundary rule)', () => {
    assert.equal(isManagedBrainPath('CLAUDE.md'), true);
    assert.equal(isManagedBrainPath('inventory/a.md'), true);
    assert.equal(isManagedBrainPath('inventory/sub/b.md'), true);
    assert.equal(isManagedBrainPath('pa/CLAUDE.md'), false);
    assert.equal(isManagedBrainPath('inventory-x/a.md'), false);
    assert.equal(isManagedBrainPath('inventories/a.md'), false);
  });

  it('isManagedBrainPath: BACKLOG.md exact only (boundary rule)', () => {
    assert.equal(isManagedBrainPath('BACKLOG.md'), true);
    assert.equal(isManagedBrainPath('backlog/foo.md'), false);
    assert.equal(isManagedBrainPath('docs/BACKLOG.md'), false);
  });

  it('isManagedBrainPath: backlog/open- prefix manages section files only (2026-09-18, AI-316)', () => {
    // The sole-writer safety net's new surface: drain-written section files.
    assert.equal(isManagedBrainPath('backlog/open-bugs.md'), true);
    assert.equal(isManagedBrainPath('backlog/open-qa.md'), true);
    // Boundary rules — never a bare prefix match.
    assert.equal(isManagedBrainPath('backlog/open.md'), false, 'no hyphen after open');
    assert.equal(isManagedBrainPath('backlog/opener.md'), false, 'opener is not open-');
    // The other backlog/*.md classes stay deliberately unmanaged.
    assert.equal(isManagedBrainPath('backlog/programs-2026-08.md'), false);
    assert.equal(isManagedBrainPath('backlog/completed-2026-09-18.md'), false);
    assert.equal(isManagedBrainPath('backlog/completed-index.md'), false);
    assert.equal(isManagedBrainPath('backlog/archive-2026-09.md'), false);
    assert.equal(isManagedBrainPath('backlog/not-valid.md'), false);
  });

  it('commits attributed groups with the exact per-owner message (ledger-seeded owner)', async () => {
    const r = await dirtyManagedRepo();
    const notify = captureNotify();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [ledgerRec(['CLAUDE.md', 'inventory/x.md'], 'alice', null)],
      notifyFn: notify.fn,
    });

    assert.equal(res.committed.length, 1);
    assert.deepEqual(res.committed[0].label, 'alice');
    assert.deepEqual([...res.committed[0].paths].sort(), ['CLAUDE.md', 'inventory/x.md']);
    assert.equal(res.deferred.length, 0);
    assert.equal(res.alertSent, false);
    assert.match(res.refId, /^s-[0-9a-f]{12}$/);
    assert.deepEqual(Object.keys(res).sort(), ['alertSent', 'committed', 'deferred', 'refId']);

    const message = git(r, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(message, `update-brain: pre-update snapshot ${istDate(NOW)} — alice\n`);
    assert.equal(git(r, ['status', '--porcelain']).trim(), '');
    assert.equal(notify.calls.length, 0, 'zero deferrals ⇒ no alert');
  });

  it('registry fallback attribution (ledger empty; registry owns inventory/)', async () => {
    const r = await dirtyManagedRepo();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [ledgerRec(['CLAUDE.md'], 'alice', null)],
      loadRegistryFn: async () => new Map([['5_6', { owned: ['inventory'] }]]),
      notifyFn: captureNotify().fn,
    });

    assert.deepEqual(res.committed.map((g) => g.label), ['alice', 'topic 5_6']);
    assert.deepEqual(res.deferred, []);
    const subjects = git(r, ['log', '--format=%s']).trim().split('\n');
    assert.deepEqual(
      subjects,
      [
        `update-brain: pre-update snapshot ${istDate(NOW)} — topic 5_6`,
        `update-brain: pre-update snapshot ${istDate(NOW)} — alice`,
        'base',
      ],
    );
  });

  it('C3 regression: unattributed managed paths are DEFERRED, never committed (HEAD unchanged)', async () => {
    const r = await dirtyManagedRepo();
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [],
      notifyFn: notify.fn,
    });

    assert.equal(res.committed.length, 0);
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'no empty/any commit may appear');
    assert.equal(git(r, ['status', '--porcelain']).trim().split('\n').length, 2, 'still dirty');
    assert.deepEqual(res.deferred, [
      { path: 'CLAUDE.md', reason: 'unattributed' },
      { path: 'inventory/x.md', reason: 'unattributed' },
    ]);

    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].subject, 'update-brain sweep deferred 2 path(s)');
    assert.equal(notify.calls[0].opts?.dedupKey, brainSweepDeferralDedupKey(res.deferred));
    assert.match(notify.calls[0].opts?.dedupKey ?? '', /^update-brain-deferral:[0-9a-f]{12}$/);
    assert.equal(notify.calls[0].opts?.severity, 'warn');
    assert.ok(notify.calls[0].body.includes('CLAUDE.md — unattributed'));
    assert.ok(
      notify.calls[0].body.includes(
        'Unattributed paths are never auto-committed; the nightly orphan-edit watch dispatches a completion agent for paths stable ≥6h.',
      ),
    );
    assert.match(notify.calls[0].body, /_Ref: s-[0-9a-f]{12}_/);
  });

  it('held reasons: reservation-held:<session> then recently-edited', async () => {
    const notify = captureNotify();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => 'C:/not-a-repo',
      snapshotFn: async () =>
        snap({
          'CLAUDE.md': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 },
          'inventory/x.md': { xy: ' M', mtimeMs: NOW - 60 * 1000, size: 10 },
        }),
      readActiveFn: async () => [{ paths: ['CLAUDE.md'], session: 'other-session' }],
      readLedgerFn: async () => [ledgerRec(['CLAUDE.md'], 'alice', null)],
      notifyFn: notify.fn,
    });

    assert.equal(res.committed.length, 0);
    const deferred: DeferredPath[] = res.deferred as never;
    assert.ok(deferred.some((d) => d.path === 'CLAUDE.md' && d.reason === 'reservation-held:other-session'));
    assert.ok(deferred.some((d) => d.path === 'inventory/x.md' && d.reason === 'recently-edited'));
    assert.ok(NOW - (NOW - 60 * 1000) < RECENT_MS);
  });

  it('lock-held without the flag: commits skipped, alert lists the reason', async () => {
    const r = await dirtyManagedRepo();
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [ledgerRec(['CLAUDE.md', 'inventory/x.md'], 'alice', null)],
      getActiveLocksFn: async () => [{ resource: 'skill-exclusive:git-workflow' }],
      notifyFn: notify.fn,
    });

    assert.equal(res.committed.length, 0);
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.deepEqual(res.deferred, [
      { path: 'CLAUDE.md', reason: 'lock-held' },
      { path: 'inventory/x.md', reason: 'lock-held' },
    ]);
    assert.equal(notify.calls.length, 1);
    assert.ok(notify.calls[0].body.includes('CLAUDE.md — lock-held'));
  });

  it('--skill-held-lock bypasses the lock gate (C7) and commits', async () => {
    const r = await dirtyManagedRepo();
    const notify = captureNotify();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [ledgerRec(['CLAUDE.md', 'inventory/x.md'], 'alice', null)],
      getActiveLocksFn: async () => [{ resource: 'skill-exclusive:git-workflow' }],
      notifyFn: notify.fn,
      skillHeldLock: true,
    });

    assert.equal(res.committed.length, 1);
    assert.equal(res.deferred.length, 0);
    assert.equal(res.alertSent, false);
    assert.equal(notify.calls.length, 0);
    assert.equal(git(r, ['status', '--porcelain']).trim(), '');
  });

  it('non-managed dirty paths are ignored entirely', async () => {
    const r = await dirtyManagedRepo();
    await writeFile(join(r, 'src.ts'), 'code — changed\n', 'utf8');
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [],
      notifyFn: captureNotify().fn,
    });
    assert.equal(res.committed.length, 0);
    assert.equal(res.deferred.length, 2, 'only the two managed paths defer');
  });

  it('BACKLOG.md safety net: dirty BACKLOG.md with no attribution is DEFERRED as unattributed + alerted', async () => {
    const r = await dirtyBacklogRepo();
    const headBefore = git(r, ['rev-parse', 'HEAD']).trim();
    const notify = captureNotify();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [],
      loadRegistryFn: async () => new Map(),
      notifyFn: notify.fn,
    });

    assert.equal(res.committed.length, 0);
    assert.equal(git(r, ['rev-parse', 'HEAD']).trim(), headBefore, 'unattributed BACKLOG.md is never committed');
    assert.deepEqual(res.deferred, [{ path: 'BACKLOG.md', reason: 'unattributed' }]);
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].subject, 'update-brain sweep deferred 1 path(s)');
    assert.equal(notify.calls[0].opts?.dedupKey, brainSweepDeferralDedupKey(res.deferred));
    assert.equal(notify.calls[0].opts?.severity, 'warn');
    assert.ok(notify.calls[0].body.includes('BACKLOG.md — unattributed'));
  });

  it('BACKLOG.md safety net: attributed BACKLOG.md is committed in the owner group', async () => {
    const r = await dirtyBacklogRepo();
    const notify = captureNotify();
    const res = await runBrainSweep({
      now: NOW,
      repoRootFn: async () => r,
      readLedgerFn: async () => [ledgerRec(['BACKLOG.md'], 'alice', null)],
      notifyFn: notify.fn,
    });

    assert.equal(res.committed.length, 1);
    assert.deepEqual(res.committed[0].label, 'alice');
    assert.deepEqual(res.committed[0].paths, ['BACKLOG.md']);
    assert.deepEqual(res.deferred, []);
    assert.equal(notify.calls.length, 0);

    const message = git(r, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
    assert.equal(message, `update-brain: pre-update snapshot ${istDate(NOW)} — alice\n`);
    assert.equal(git(r, ['status', '--porcelain']).trim(), '');
  });
});
