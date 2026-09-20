import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtemp, rm, writeFile, mkdir, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  ORPHAN_MIN_AGE_MS,
  SNOOZE_MS,
  STORE_PRUNE_MS,
  ALERT_AFTER_MS,
  AGENT_CLAIM_TTL_MS,
  AGENT_CLAIM_SESSION,
  GROUP_CAP,
  DIFF_MAX_CHARS,
  orphanGid,
  orphanKeyboard,
  buildOrphanBody,
  buildAgentPrompt,
  splitForDispatch,
  readOrphanStore,
  runOrphanEditWatch,
  landOrphanGroup,
  hasTreeChurnLock,
  type OrphanWatchStore,
  type NumstatByPath,
} from '../src/lib/orphan-watch.js';
import { validateKeyboardRequest } from '../src/lib/callback-grammar.js';
import { validateTaskPrompt } from '../src/lib/topic-tasks.js';
import { BUILD_LOCK_RESOURCE } from '../src/lib/build-lock.js';
import type { TreeSnapshot } from '../src/lib/worker-edit-audit.js';

const HOUR = 60 * 60 * 1000;
// Wall clock is "now", not a fixed epoch: real temp-repo files carry real
// mtimes; a past frozen epoch would misread every fresh mtime as
// recently-edited. Everything mtime-relative is constructed FROM NOW.
const NOW = Date.now();

interface NotifyCall {
  subject: string;
  body: string;
  opts?: { dedupKey?: string; severity?: string; escalate?: boolean; replyMarkup?: Record<string, unknown> };
}

type NotifyFn = (subject: string, body: string, opts?: NotifyCall['opts']) => Promise<unknown>;

function captureNotify(): { calls: NotifyCall[]; fn: NotifyFn } {
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

const emptyScan = { hitsByPath: new Map(), budgetExhausted: false, scannedFiles: 0 };

function baseDeps(paDir: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    now: NOW,
    repoRootFn: async () => paDir,
    gitRunner: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 1 }),
    readActiveFn: async () => [],
    getActiveLocksFn: async () => [],
    readLedgerFn: async () => [],
    loadRegistryFn: async () => new Map(),
    loadSupportTopicFn: async () => undefined,
    scanTranscriptsFn: async () => ({ hitsByPath: new Map(), budgetExhausted: false, scannedFiles: 0 }),
    claimFn: async () => ({ ok: true } as never),
    appendTaskFn: async () => ({ id: 'tt-' + '0'.repeat(12), deduped: false }),
    notifyFn: async () => ({ sent: true, suppressed: false }),
    ...overrides,
  };
}

describe('orphan-watch', () => {
  let paDir: string;

  beforeEach(async () => {
    paDir = await createTempPaHome();
  });

  afterEach(async () => {
    await cleanup(paDir);
  });

  describe('pure helpers', () => {
    it('orphanGid is stable across runs and order-insensitive, 12 hex', () => {
      const a = orphanGid(['b.ts', 'a.ts']);
      const b = orphanGid(['a.ts', 'b.ts']);
      assert.equal(a, b);
      assert.match(a, /^[0-9a-f]{12}$/);
      assert.notEqual(a, orphanGid(['a.ts']));
    });

    it('orphanKeyboard returns the 3-button keyboard for a valid gid, undefined otherwise', () => {
      const gid = orphanGid(['a.ts']);
      const kb = orphanKeyboard(gid);
      assert.ok(kb);
      assert.deepEqual(kb!.inline_keyboard.map((row) => row.map((b) => b.callback_data)), [
        [`ow:${gid}:l`, `ow:${gid}:k`],
        [`ow:${gid}:d`],
      ]);
      assert.ok(validateKeyboardRequest({ buttons: kb!.inline_keyboard.flat() }).ok);
      assert.equal(orphanKeyboard('NOT-A-GID'), undefined);
    });

    it('buildOrphanBody renders the v2 lane-3 body (dispatch line, cap, ref)', () => {
      const numstat: NumstatByPath = new Map([
        ['tracked.ts', { added: 3, removed: 1 }],
        ['new.txt', { added: null, removed: null, bytes: 42 }],
      ]);
      const body = buildOrphanBody(
        {
          gid: '0123abcd4567',
          paths: ['tracked.ts', 'new.txt'],
          agent: { dispatchedAt: NOW - HOUR, topicKey: '1_2', taskIds: ['tt-x'] },
          ref: 's-abcdef123456',
        },
        numstat,
      );
      assert.ok(body.includes('**Orphaned working-tree edits need your decision**'));
      assert.ok(
        body.includes(
          `A completion agent was dispatched ${new Date(NOW - HOUR).toISOString()}, topic 1_2 and the paths are still dirty after 48h — it declined or could not complete them.`,
        ),
      );
      assert.ok(body.includes('tracked.ts  (+3/-1)'));
      assert.ok(body.includes('new.txt  (new file, 42 bytes)'));
      assert.ok(body.includes('Stable ≥6h, no active reservation.'));
      assert.ok(body.includes('Land as-is commits verbatim. Keep dirty snoozes this family 24h.'));
      assert.ok(body.includes('_Ref: s-abcdef123456_'));

      const never = buildOrphanBody(
        { gid: '0123abcd4567', paths: ['tracked.ts'], agent: null, ref: 's-abcdef123456' },
        new Map(),
      );
      assert.ok(never.includes('No completion agent could be dispatched (no resolvable topic)'));
    });

    it('buildAgentPrompt renders the EXACT §1.5 text and validates; overflow drops path count (C13)', () => {
      const one = buildAgentPrompt(['src/a.ts']);
      assert.equal(
        one,
        'Orphan completion agent: decide + finish or land verbatim these dirty edits (no live owner): src/a.ts. ' +
          'If a transcript under the Claude projects dir names them, read it for intent. ' +
          'Unambiguous and small: finish. Else: git add src/a.ts then git commit -m "chore: land orphaned working-tree edits (completion agent)". ' +
          'Never delete, never touch other paths, never push/stash/reset/clean. Report what you did and why.',
      );
      assert.ok(validateTaskPrompt(one).ok);

      // 4 normal paths fit.
      const four = splitForDispatch(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
      assert.equal(four.length, 1);
      assert.equal(four[0].length, 4);
      // 4 moderately-long paths overflow the 500-char cap → the splitter
      // drops that task to fewer paths and starts a new chunk with the
      // remainder. (Paths so long that even ONE cannot render throw — the
      // undispatchable-gid guard — so the fixture stays renderable.)
      const long = 'dir/with-16chars-x.ts';
      const chunks = splitForDispatch([long, long + '2', long + '3', long + '4']);
      assert.ok(chunks.length >= 2, 'long 4-path set must split');
      for (const chunk of chunks) {
        assert.ok(validateTaskPrompt(buildAgentPrompt(chunk)).ok, 'every chunk render must validate');
        assert.ok(chunk.length <= 4);
      }
      assert.throws(() => buildAgentPrompt(['dir/' + 'x'.repeat(60) + '/a.ts']), /render rejected/);
    });
  });

  describe('hasTreeChurnLock (self-pid exclusion — the catchup self-skip bug)', () => {
    it('a catchup lock held by THIS process does not stand the job down (regression pin)', async () => {
      const held = await hasTreeChurnLock(async () => [{ resource: 'catchup', pid: process.pid }]);
      assert.equal(held, false, 'the caller\'s own catchup tick lock must never self-skip the job it invoked');
    });

    it('a catchup lock held by a FOREIGN process still stands the job down', async () => {
      const held = await hasTreeChurnLock(async () => [{ resource: 'catchup', pid: process.pid + 1 }]);
      assert.equal(held, true);
    });

    it('the topic-suffixed catchup:topic:* prefix follows the same self-pid rule', async () => {
      const own = await hasTreeChurnLock(async () => [{ resource: 'catchup:topic:default', pid: process.pid }]);
      assert.equal(own, false);
      const foreign = await hasTreeChurnLock(async () => [
        { resource: 'catchup:topic:default', pid: process.pid + 1 },
      ]);
      assert.equal(foreign, true);
    });

    it('the maintenance lane lock (catchup:maintenance) follows the same self-pid rule (2026-09-11)', async () => {
      const own = await hasTreeChurnLock(async () => [{ resource: 'catchup:maintenance', pid: process.pid }]);
      assert.equal(own, false);
      const foreign = await hasTreeChurnLock(async () => [
        { resource: 'catchup:maintenance', pid: process.pid + 1 },
      ]);
      assert.equal(foreign, true);
    });

    it('git-workflow / git-public-workflow / @build rows stand the job down regardless of pid (unchanged)', async () => {
      const rows = [
        { resource: 'skill-exclusive:git-workflow', pid: process.pid },
        { resource: 'skill-exclusive:git-public-workflow', pid: process.pid },
        { resource: BUILD_LOCK_RESOURCE, pid: process.pid },
      ];
      for (const row of rows) {
        const held = await hasTreeChurnLock(async () => [row]);
        assert.equal(held, true, `${row.resource} must still stand the job down even when pid === self`);
      }
    });

    it('a row with no pid at all is treated as foreign (defaults preserve pre-fix behavior)', async () => {
      const held = await hasTreeChurnLock(async () => [{ resource: 'catchup' }]);
      assert.equal(held, true);
    });

    it('the selfPid parameter is injectable, so a test never depends on the real process.pid', async () => {
      const held = await hasTreeChurnLock(async () => [{ resource: 'catchup', pid: 999999 }], 999999);
      assert.equal(held, false);
      const foreign = await hasTreeChurnLock(async () => [{ resource: 'catchup', pid: 1 }], 999999);
      assert.equal(foreign, true);
    });
  });

  describe('runOrphanEditWatch — ladder', () => {
    function row(paths: string[], firstSeenAt: number, extra: Partial<OrphanWatchStore['groups'][string]> = {}) {
      return {
        paths,
        firstSeenAt,
        lastAlertedAt: 0,
        snoozedUntil: 0,
        landedAt: 0,
        landedSha: '',
        alertRef: '',
        agent: null,
        ...extra,
      };
    }

    it('age gate boundary: 5h59m59s excluded, 6h00m01s included', async () => {
      const { calls, fn } = captureNotify();
      const young = snap({ 'young.ts': { xy: ' M', mtimeMs: NOW - ORPHAN_MIN_AGE_MS + 1000, size: 10 } });
      const youngRes = await runOrphanEditWatch(baseDeps(paDir, { snapshotFn: async () => young, notifyFn: fn }));
      assert.equal(youngRes.touched, 0);

      const old = snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - ORPHAN_MIN_AGE_MS - 1000, size: 10 } });
      const oldRes = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => old,
          notifyFn: fn,
          loadSupportTopicFn: async () => '5_6',
          appendTaskFn: async () => ({ id: 'tt-000000000000', deduped: false }),
          claimFn: async () => ({ ok: true }) as never,
        }),
      );
      // No prior row: the fresh family's firstSeenAt = now → lane 2 dispatch.
      assert.equal(oldRes.touched, 1);
      assert.equal((oldRes.detail as { dispatched: number }).dispatched, 1);
      const gid = orphanGid(['old.ts']);
      assert.equal((await readOrphanStore()).groups[gid].agent?.topicKey, '5_6');
    });

    it('reservation-overlapping paths are excluded silently; mtimeMs=0 excluded and counted', async () => {
      const scanSpyCalls: string[][] = [];
      const s = snap({
        'claimed.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 },
        'nostat.ts': { xy: ' M', mtimeMs: 0, size: -1 },
        'free.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 },
      });
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          readActiveFn: async () => [{ paths: ['claimed.ts'], session: 'bot-session' }],
          scanTranscriptsFn: async (_r: string, paths: string[]) => {
            scanSpyCalls.push(paths);
            return { hitsByPath: new Map(), budgetExhausted: false, scannedFiles: 0 };
          },
        }),
      );
      assert.equal(res.touched, 0);
      assert.equal((res.detail as { groups: number }).groups, 1);
      assert.equal((res.detail as { statFailed: number }).statFailed, 1);
      assert.deepEqual(scanSpyCalls, [['free.ts']], 'scan sees only unreserved candidates');
    });

    it('transcript scan is never invoked when there are no candidates', async () => {
      let scanCalls = 0;
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => snap({}),
          scanTranscriptsFn: async () => {
            scanCalls++;
            return { hitsByPath: new Map(), budgetExhausted: false, scannedFiles: 0 };
          },
        }),
      );
      assert.equal(res.touched, 0);
      assert.equal(scanCalls, 0);
    });

    it('lane 1: all paths owned by an ALIVE owner defer silently (no alert, no task)', async () => {
      const { calls, fn } = captureNotify();
      let taskCalls = 0;
      const s = snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          notifyFn: fn,
          scanTranscriptsFn: async () => ({
            hitsByPath: new Map([['old.ts', [{ file: 't.jsonl', fileMtimeMs: NOW - 60_000, newestMatchTs: NOW - 60_000 }]]]),
            budgetExhausted: false,
            scannedFiles: 1,
          }),
          appendTaskFn: async () => {
            taskCalls++;
            return { id: 'tt-000000000000', deduped: false };
          },
        }),
      );
      assert.equal(res.touched, 0);
      assert.equal((res.detail as { deferredAlive: number }).deferredAlive, 1);
      assert.equal(calls.length, 0);
      assert.equal(taskCalls, 0);
    });

    it('lane 2: dead owner dispatches exactly once — claim (TTL+session) then task; re-run defers', async () => {
      const { calls, fn } = captureNotify();
      const claims: Array<{ paths: string[]; session?: string; ttlMinutes?: number }> = [];
      const tasks: Array<{ title: string; prompt: string; createdBy: string }> = [];
      const s = snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const gid = orphanGid(['old.ts']);
      const seed: OrphanWatchStore = { version: 2, groups: { [gid]: row(['old.ts'], NOW - HOUR) } };

      const deps = () =>
        baseDeps(paDir, {
          snapshotFn: async () => s,
          notifyFn: fn,
          readStoreFn: async () => seed,
          loadSupportTopicFn: async () => '5_6',
          claimFn: async (opts: never) => {
            claims.push(opts as never);
            return { ok: true } as never;
          },
          appendTaskFn: (async (
            _chatId: number,
            _threadId: number,
            input: { title: string; prompt: string; createdBy: string },
          ) => {
            tasks.push(input);
            return { id: 'tt-000000000000', deduped: false };
          }) as never,
        });

      const res = await runOrphanEditWatch(deps());
      assert.equal(res.touched, 1);
      assert.equal((res.detail as { dispatched: number }).dispatched, 1);
      assert.equal(claims.length, 1);
      assert.equal(claims[0].session, AGENT_CLAIM_SESSION);
      assert.equal(claims[0].ttlMinutes, AGENT_CLAIM_TTL_MS / 60_000);
      assert.deepEqual([...claims[0].paths], ['old.ts']);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].title, 'Complete orphaned edits: 1 file(s)');
      assert.equal(tasks[0].prompt, buildAgentPrompt(['old.ts']));
      assert.equal(tasks[0].createdBy, 'session:orphan-edit-watch');
      assert.equal(seed.groups[gid].agent?.topicKey, '5_6');
      assert.deepEqual(seed.groups[gid].agent?.taskIds, ['tt-000000000000']);
      assert.equal(calls.length, 0, 'lane 2 never alerts');

      // Re-run: the dispatch record defers — no second claim, no second task.
      const res2 = await runOrphanEditWatch(deps());
      assert.equal(res2.touched, 0);
      assert.equal(claims.length, 1, 'no second claim');
      assert.equal(tasks.length, 1, 'no second task');
    });

    it('lane 3: ALERT_AFTER_MS boundary fires the operator alert with keyboard + dedupKey', async () => {
      const { calls, fn } = captureNotify();
      let taskCalls = 0;
      const s = snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const gid = orphanGid(['old.ts']);
      const seed: OrphanWatchStore = { version: 2, groups: { [gid]: row(['old.ts'], NOW - ALERT_AFTER_MS) } };
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          notifyFn: fn,
          readStoreFn: async () => seed,
          appendTaskFn: async () => {
            taskCalls++;
            return { id: 'tt-000000000000', deduped: false };
          },
        }),
      );
      assert.equal((res.detail as { alerted: number }).alerted, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].subject, 'Orphaned working-tree edits unresolved: 1 path(s)');
      assert.equal(calls[0].opts?.dedupKey, `orphan-edit:${gid}`);
      assert.equal(calls[0].opts?.severity, 'warn');
      assert.ok(calls[0].opts?.replyMarkup);
      assert.ok(validateKeyboardRequest({ buttons: (calls[0].opts!.replyMarkup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard.flat() }).ok);
      assert.equal(taskCalls, 0, 'lane 3 never dispatches');
      const after = await readOrphanStore();
      assert.equal(after.groups[gid].lastAlertedAt, NOW);
      assert.equal(after.groups[gid].alertRef, calls[0].body.match(/_Ref: (s-[0-9a-f]{12})_/)![1]);

      // 1s before the boundary (agent already dispatched) → defer, no alert.
      const { calls: calls2, fn: fn2 } = captureNotify();
      const seed2: OrphanWatchStore = {
        version: 2,
        groups: { [gid]: row(['old.ts'], NOW - ALERT_AFTER_MS + 1000, { agent: { dispatchedAt: NOW - HOUR, topicKey: '5_6', taskIds: ['tt-x'] } }) },
      };
      const res2 = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          notifyFn: fn2,
          readStoreFn: async () => seed2,
        }),
      );
      assert.equal(res2.touched, 0);
      assert.equal(calls2.length, 0);
    });

    it('unattributed + no resolvable topic → no dispatch; ages to the lane-3 alert', async () => {
      const { calls, fn } = captureNotify();
      const s = snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          notifyFn: fn,
          loadSupportTopicFn: async () => undefined,
        }),
      );
      assert.equal((res.detail as { skipped: { noTopic: number } }).skipped.noTopic, 1);
      assert.equal((res.detail as { dispatched: number }).dispatched, 0);

      // After ALERT_AFTER_MS the same gid alerts even though dispatch never happened.
      const gid = orphanGid(['old.ts']);
      const seed: OrphanWatchStore = { version: 2, groups: { [gid]: row(['old.ts'], NOW - ALERT_AFTER_MS) } };
      const { calls: calls2, fn: fn2 } = captureNotify();
      await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          notifyFn: fn2,
          readStoreFn: async () => seed,
          loadSupportTopicFn: async () => undefined,
        }),
      );
      assert.equal(calls2.length, 1);
    });

    it('lane 2 routing: ledger owner_topic wins, registry next, catch-all/support last', async () => {
      const topics: string[] = [];
      const s = snap({
        'led.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 },
        'reg.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 },
      });
      const gidLed = orphanGid(['led.ts']);
      const gidReg = orphanGid(['reg.ts']);
      const seed: OrphanWatchStore = {
        version: 2,
        groups: { [gidLed]: row(['led.ts'], NOW - HOUR), [gidReg]: row(['reg.ts'], NOW - HOUR) },
      };
      await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          readStoreFn: async () => seed,
          readLedgerFn: async () => [
            {
              ts: new Date(NOW - HOUR).toISOString(),
              paths: ['led.ts'],
              owner_session: null,
              owner_topic: '7_7',
              source: 'dispatch-close',
              released_at: null,
            },
          ],
          loadRegistryFn: async () => new Map([['8_8', { owned: ['reg.ts'] }]]),
          claimFn: async () => ({ ok: true }) as never,
          appendTaskFn: (async (_c: number, _t: number, input: { title: string }) => {
            topics.push(input.title);
            return { id: 'tt-000000000000', deduped: false };
          }) as never,
        }),
      );
      assert.deepEqual(topics.length, 2);
      assert.equal(seed.groups[gidLed].agent?.topicKey, '7_7');
      assert.equal(seed.groups[gidReg].agent?.topicKey, '8_8');
    });

    it('lane 2 routing: conflicting ledger records for the same path pick the NEWEST by ts, not array order', async () => {
      // readOrphanLedger returns its window oldest-first; a naive first-match
      // walk would pick the stale owner. Seed the OLDER record first (as the
      // real reader would) so a regression to first-match is caught.
      const s = snap({ 'multi.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const gid = orphanGid(['multi.ts']);
      const seed: OrphanWatchStore = { version: 2, groups: { [gid]: row(['multi.ts'], NOW - HOUR) } };
      await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          readStoreFn: async () => seed,
          readLedgerFn: async () => [
            {
              ts: new Date(NOW - 3 * HOUR).toISOString(),
              paths: ['multi.ts'],
              owner_session: null,
              owner_topic: '1_1',
              source: 'dispatch-close',
              released_at: null,
            },
            {
              ts: new Date(NOW - HOUR).toISOString(),
              paths: ['multi.ts'],
              owner_session: null,
              owner_topic: '2_2',
              source: 'dispatch-close',
              released_at: null,
            },
          ],
          claimFn: async () => ({ ok: true }) as never,
          appendTaskFn: async () => ({ id: 'tt-000000000000', deduped: false }),
        }),
      );
      assert.equal(seed.groups[gid].agent?.topicKey, '2_2', 'the newer ledger record must win over array order');
    });

    it('lock stand-down: any tree-churn holder skips the whole pass without notifying', async () => {
      const { calls, fn } = captureNotify();
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } }),
          getActiveLocksFn: async () => [{ resource: 'skill-exclusive:git-workflow' }],
          notifyFn: fn,
        }),
      );
      assert.equal(res.touched, 0);
      assert.equal((res.detail as { skipped: { lockHeld: number } }).skipped.lockHeld, 1);
      assert.equal(calls.length, 0);
    });

    it('GROUP_CAP processes at most 10 gids per run; overflow counted, not thrown', async () => {
      const { calls, fn } = captureNotify();
      const paths = Array.from({ length: GROUP_CAP + 1 }, (_, i) => `p${i}.ts`);
      const entries: Record<string, { xy: string; mtimeMs: number; size: number }> = {};
      const seed: OrphanWatchStore = { version: 2, groups: {} };
      for (const p of paths) {
        entries[p] = { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 };
        seed.groups[orphanGid([p])] = row([p], NOW - ALERT_AFTER_MS); // lane 3
      }
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => snap(entries),
          notifyFn: fn,
          readStoreFn: async () => seed,
        }),
      );
      assert.equal(res.touched, GROUP_CAP);
      assert.equal((res.detail as { overflow: number }).overflow, 1);
      assert.equal(calls.length, GROUP_CAP);
    });

    it('snooze suppresses re-alerts until expired; store row keeps firstSeenAt and gains lastAlertedAt/alertRef', async () => {
      const { calls, fn } = captureNotify();
      const gid = orphanGid(['old.ts']);
      const s = snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const seed: OrphanWatchStore = {
        version: 2,
        groups: {
          [gid]: row(['old.ts'], NOW - 3 * 24 * HOUR, { snoozedUntil: NOW + HOUR, lastAlertedAt: NOW - 3 * 24 * HOUR, alertRef: 's-old00000000' }),
        },
      };
      const snoozedRes = await runOrphanEditWatch(
        baseDeps(paDir, { snapshotFn: async () => s, notifyFn: fn, readStoreFn: async () => seed }),
      );
      assert.equal(snoozedRes.touched, 0);
      assert.equal(calls.length, 0);

      const expired = structuredClone(seed);
      expired.groups[gid].snoozedUntil = NOW - HOUR;
      const res = await runOrphanEditWatch(
        baseDeps(paDir, { snapshotFn: async () => s, notifyFn: fn, readStoreFn: async () => expired }),
      );
      assert.equal(res.touched, 1);
      const after = await readOrphanStore();
      assert.equal(after.groups[gid].firstSeenAt, NOW - 3 * 24 * HOUR);
      assert.equal(after.groups[gid].lastAlertedAt, NOW);
      assert.equal(after.groups[gid].alertRef, calls[0].body.match(/_Ref: (s-[0-9a-f]{12})_/)![1]);
    });

    it('prune drops rows whose paths all went clean, or whose snooze expired +7d', async () => {
      const { calls, fn } = captureNotify();
      const gidClean = orphanGid(['clean.ts']);
      const gidPruneAge = orphanGid(['still-dirty.ts']);
      const seed: OrphanWatchStore = {
        version: 2,
        groups: {
          [gidClean]: row(['clean.ts'], NOW - 2 * 24 * HOUR),
          [gidPruneAge]: row(['still-dirty.ts'], NOW - 2 * 24 * HOUR, { snoozedUntil: NOW - STORE_PRUNE_MS - 1000 }),
        },
      };
      const s = snap({ 'still-dirty.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const res = await runOrphanEditWatch(
        baseDeps(paDir, { snapshotFn: async () => s, notifyFn: fn, readStoreFn: async () => seed }),
      );
      // v2's pinned detail shape carries no `pruned` key — pruning is
      // asserted through the store state below.
      assert.equal(res.touched, 0);
      const after = await readOrphanStore();
      // Prune runs BEFORE the ladder (§1.2 bookkeeping; the §1.9 last-place
      // order crashes against its own upsert — reported): the clean-path row
      // is gone for good; the still-dirty path's row was pruned and then
      // RE-CREATED as a fresh family (same path set ⇒ same gid) whose
      // firstSeenAt restarts — a snooze long expired re-surfaces rather than
      // staying silent, on later cycles.
      assert.equal(calls.length, 0, 'the re-created fresh family defers this run');
      assert.equal(after.groups[gidClean], undefined);
      assert.ok(after.groups[gidPruneAge]);
      assert.equal(after.groups[gidPruneAge].firstSeenAt, NOW);
      assert.equal(after.groups[gidPruneAge].snoozedUntil, 0);
    });

    it('budget exhaustion is counted in detail.skipped.budget', async () => {
      const s = snap({ 'old.ts': { xy: ' M', mtimeMs: NOW - 8 * HOUR, size: 10 } });
      const res = await runOrphanEditWatch(
        baseDeps(paDir, {
          snapshotFn: async () => s,
          scanTranscriptsFn: async () => ({ hitsByPath: new Map(), budgetExhausted: true, scannedFiles: 0 }),
        }),
      );
      assert.equal((res.detail as { skipped: { budget: number } }).skipped.budget, 1);
    });
  });

  describe('landOrphanGroup — disposition (real temp git repos)', () => {
    let repo: string;

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), 'orphan-watch-repo-'));
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'test']);
      await writeFile(join(repo, 'a.ts'), 'base\n', 'utf8');
      await mkdir(join(repo, 'sub'), { recursive: true });
      await writeFile(join(repo, 'sub', 'b.ts'), 'base\n', 'utf8');
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '-m', 'base']);
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    function storeWith(paths: string[]): { store: OrphanWatchStore; gid: string } {
      const gid = orphanGid(paths);
      return {
        gid,
        store: {
          version: 2,
          groups: {
            [gid]: {
              paths,
              firstSeenAt: NOW - 2 * 24 * HOUR,
              lastAlertedAt: 0,
              snoozedUntil: 0,
              landedAt: 0,
              landedSha: '',
              alertRef: '',
              agent: null,
            },
          },
        },
      };
    }

    it('keep writes snoozedUntil and sends NO notify', async () => {
      const { calls, fn } = captureNotify();
      const { gid, store } = storeWith(['a.ts']);
      await landOrphanGroup('keep', gid, {
        now: NOW,
        repoRootFn: async () => repo,
        readStoreFn: async () => store,
        writeStoreFn: async () => {},
        notifyFn: fn,
      });
      assert.equal(store.groups[gid].snoozedUntil, NOW + SNOOZE_MS);
      assert.equal(calls.length, 0);
    });

    it('land refusals: unknown-gid, reserved (incl. the job OWN agent claim), lock-held, all-clean', async () => {
      const { store, gid } = storeWith(['a.ts']);
      const base = {
        now: NOW,
        repoRootFn: async () => repo,
        readStoreFn: async () => store,
        writeStoreFn: async () => {},
        readActiveFn: async () => [] as Array<{ paths: string[]; session: string }>,
        getActiveLocksFn: async () => [] as Array<{ resource: string }>,
        notifyFn: async () => ({}),
      };
      await assert.rejects(landOrphanGroup('land', '000000000000', base), /unknown-gid/);
      const covering: Array<{ paths: string[]; session: string }> = [
        { paths: ['a.ts'], session: AGENT_CLAIM_SESSION },
      ];
      await assert.rejects(
        landOrphanGroup('land', gid, { ...base, readActiveFn: async () => covering }),
        /reserved:orphan-edit-watch/,
      );
      const other: Array<{ paths: string[]; session: string }> = [{ paths: ['a.ts'], session: 'bot-session' }];
      await assert.rejects(
        landOrphanGroup('land', gid, { ...base, readActiveFn: async () => other }),
        /reserved:bot-session/,
      );
      await assert.rejects(
        landOrphanGroup('land', gid, {
          ...base,
          getActiveLocksFn: async () => [{ resource: 'skill-exclusive:git-workflow' }],
        }),
        /lock-held/,
      );
      const { gid: cleanGid, store: cleanStore } = storeWith(['nothing-dirty.ts']);
      await assert.rejects(
        landOrphanGroup('land', cleanGid, { ...base, readStoreFn: async () => cleanStore }),
        /clean/,
      );
    });

    it('land happy path: exact commit message, untracked added first, sha + store row, outcome notify', async () => {
      const { calls, fn } = captureNotify();
      await writeFile(join(repo, 'a.ts'), 'changed\n', 'utf8');
      await writeFile(join(repo, 'new.txt'), 'hello\n', 'utf8');
      const { gid, store } = storeWith(['a.ts', 'new.txt']);
      const res = await landOrphanGroup('land', gid, {
        now: NOW,
        repoRootFn: async () => repo,
        readStoreFn: async () => store,
        writeStoreFn: async () => {},
        readActiveFn: async () => [],
        getActiveLocksFn: async () => [],
        notifyFn: fn,
      });

      const message = git(repo, ['log', '-1', '--format=%B']).replace(/\s+$/, '\n');
      assert.equal(
        message,
        `chore: land orphaned working-tree edits (${gid})\n` +
          `\na.ts\nnew.txt\n\n` +
          `These edits sat uncommitted with no active reservation and no live owner\n` +
          `(stable >=6h); landed verbatim from the orphan-edit alert for preservation.\n` +
          `\nCo-Authored-By: Claude Code <noreply@anthropic.com>\n`,
      );
      assert.equal(git(repo, ['status', '--porcelain']).trim(), '');
      assert.equal(res.sha, git(repo, ['rev-parse', '--short', 'HEAD']).trim());
      assert.equal(res.skipped.length, 0);
      assert.equal(store.groups[gid].landedAt, NOW);
      assert.equal(store.groups[gid].landedSha, res.sha);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].subject, `Orphaned edits landed: ${gid}`);
      assert.equal(calls[0].opts?.dedupKey, `orphan-edit-outcome:${gid}`);
      assert.equal(calls[0].opts?.escalate, false);
      assert.ok(calls[0].body.includes(res.sha!));
    });

    it('diff: truncated body names the full-patch option, dedupKey + escalate:false', async () => {
      const { calls, fn } = captureNotify();
      await writeFile(join(repo, 'a.ts'), 'x\n'.repeat(2000), 'utf8');
      const { gid, store } = storeWith(['a.ts']);
      await landOrphanGroup('diff', gid, {
        now: NOW,
        repoRootFn: async () => repo,
        readStoreFn: async () => store,
        writeStoreFn: async () => {},
        notifyFn: fn,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].subject, `Orphaned edits diff: ${gid}`);
      assert.equal(calls[0].opts?.dedupKey, `orphan-edit-diff:${gid}`);
      assert.equal(calls[0].opts?.escalate, false);
      assert.ok(calls[0].body.length > DIFF_MAX_CHARS);
      assert.ok(calls[0].body.length < DIFF_MAX_CHARS + 400);
      assert.ok(calls[0].body.includes('truncated at 3200 chars'));
    });

    it('diff notes untracked paths as new file with bytes (git diff HEAD skips them)', async () => {
      const { calls, fn } = captureNotify();
      await writeFile(join(repo, 'new.txt'), 'hello\n', 'utf8');
      const { gid, store } = storeWith(['new.txt']);
      await landOrphanGroup('diff', gid, {
        now: NOW,
        repoRootFn: async () => repo,
        readStoreFn: async () => store,
        writeStoreFn: async () => {},
        notifyFn: fn,
      });
      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.includes('new.txt — new file, 6 bytes'));
    });
  });
});
