import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve as resolvePath } from 'path';
import { createTempPaHome, cleanup, createTempSecrets } from './helpers.js';
import { resetRedactCache } from '../src/lib/redact.js';
import type { WatchInput, WatchNotifyFn } from '../src/lib/watch-jobs.js';

const T0 = Date.parse('2026-08-31T00:00:00.000Z');

// Portable absolute path for validation-only fixture args: `C:/...` is only
// absolute on win32 (path.isAbsolute('C:/x') is false on ubuntu/macos, which
// made every "should validate" case in the section below fail with
// "check.path must be absolute" on the public CI's non-Windows legs). The
// file need not exist for these cases — only validateWatchInput's
// isAbsolute() check runs, never real I/O.
const absPath = (name: string) => join(tmpdir(), 'ai170-fixtures', name);

function baseSource(): WatchInput['source'] {
  return { kind: 'cli', chatId: '12345', threadId: 0, refId: null };
}

/** Records every call; always resolves { sent: true, suppressed: false } unless overridden. */
function recordingNotify(
  impl?: (subject: string, body: string, opts?: any) => Promise<{ sent: boolean; suppressed: boolean }>,
): { fn: WatchNotifyFn; calls: Array<{ subject: string; body: string; opts?: any }> } {
  const calls: Array<{ subject: string; body: string; opts?: any }> = [];
  const fn: WatchNotifyFn = async (subject, body, opts) => {
    calls.push({ subject, body, opts });
    if (impl) return impl(subject, body, opts);
    return { sent: true, suppressed: false };
  };
  return { fn, calls };
}

describe('watch-jobs', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    resetRedactCache();
  });

  afterEach(async () => {
    await cleanup(dir);
  });

  describe('validateWatchInput (pure, no I/O)', () => {
    it('rejects a missing description', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: '', check: { type: 'file_exists', path: absPath('x.txt') }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'description is required');
    });

    it('rejects a blank (whitespace-only) description', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: '   ', check: { type: 'file_exists', path: absPath('x.txt') }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'description is required');
    });

    it('rejects a 201-char description and accepts 200', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const too_long = 'x'.repeat(201);
      const exact = 'x'.repeat(200);
      const r1 = validateWatchInput(
        { description: too_long, check: { type: 'file_exists', path: absPath('x.txt') }, source: baseSource() } as WatchInput,
        T0,
      );
      assert.equal(r1.ok, false);
      assert.equal((r1 as { ok: false; error: string }).error, 'description exceeds 200 characters');

      const r2 = validateWatchInput(
        { description: exact, check: { type: 'file_exists', path: absPath('x.txt') }, source: baseSource() } as WatchInput,
        T0,
      );
      assert.equal(r2.ok, true);
    });

    it('rejects a missing source.chatId', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = {
        description: 'ok',
        check: { type: 'file_exists', path: absPath('x.txt') },
        source: { kind: 'cli', chatId: '', threadId: 0, refId: null },
      };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'source.chatId is required');
    });

    it('rejects an unknown check type', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: 'ok', check: { type: 'delete_everything' }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal(
        (r as { ok: false; error: string }).error,
        'unknown check type: delete_everything (allowed: file_exists, file_gone, file_newer_than, file_contains, process_gone)',
      );
    });

    it('rejects a missing path for a path type', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: 'ok', check: { type: 'file_exists' }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'check.path is required for file_exists');
    });

    it('rejects a relative path', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: 'ok', check: { type: 'file_exists', path: 'relative/path.txt' }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'check.path must be absolute');
    });

    it('rejects a missing pattern for file_contains', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: 'ok', check: { type: 'file_contains', path: absPath('x.txt') }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'check.pattern is required for file_contains');
    });

    it('rejects a pattern over 200 chars', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = {
        description: 'ok',
        check: { type: 'file_contains', path: absPath('x.txt'), pattern: 'x'.repeat(201) },
        source: baseSource(),
      };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'check.pattern exceeds 200 characters');
    });

    it('rejects an uncompilable regex pattern', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = {
        description: 'ok',
        check: { type: 'file_contains', path: absPath('x.txt'), pattern: '(unclosed' },
        source: baseSource(),
      };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.ok((r as { ok: false; error: string }).error.startsWith('check.pattern is not a valid regular expression:'));
    });

    it('rejects a bad sinceIso for file_newer_than', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = {
        description: 'ok',
        check: { type: 'file_newer_than', path: absPath('x.txt'), sinceIso: 'not-a-date' },
        source: baseSource(),
      };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'check.sinceIso is not a valid ISO timestamp');
    });

    it('defaults sinceIso to now for file_newer_than when omitted', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: 'ok', check: { type: 'file_newer_than', path: absPath('x.txt') }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, true);
      assert.equal((r as any).value.check.sinceIso, new Date(T0).toISOString());
    });

    it('rejects a non-positive-integer pid for process_gone', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      for (const pid of [0, -1, 1.5, 'abc']) {
        const input = { description: 'ok', check: { type: 'process_gone', pid }, source: baseSource() };
        const r = validateWatchInput(input as unknown as WatchInput, T0);
        assert.equal(r.ok, false, `pid=${pid} should be rejected`);
        assert.equal((r as { ok: false; error: string }).error, 'check.pid must be a positive integer');
      }
    });

    it('accepts a valid process_gone check', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: 'ok', check: { type: 'process_gone', pid: 4242 }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, true);
    });

    it('boundary: interval_seconds 60/3600 accepted, 59/3601 rejected', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const mk = (s: number) => ({
        description: 'ok',
        check: { type: 'file_exists', path: absPath('x.txt') },
        intervalSeconds: s,
        source: baseSource(),
      });
      assert.equal(validateWatchInput(mk(60) as WatchInput, T0).ok, true);
      assert.equal(validateWatchInput(mk(3600) as WatchInput, T0).ok, true);
      const r1 = validateWatchInput(mk(59) as WatchInput, T0);
      assert.equal(r1.ok, false);
      assert.equal((r1 as { ok: false; error: string }).error, 'interval_seconds must be between 60 and 3600');
      const r2 = validateWatchInput(mk(3601) as WatchInput, T0);
      assert.equal(r2.ok, false);
      assert.equal((r2 as { ok: false; error: string }).error, 'interval_seconds must be between 60 and 3600');
    });

    it('boundary: deadline_minutes 1/10080 accepted, 0/10081 rejected', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const mk = (m: number) => ({
        description: 'ok',
        check: { type: 'file_exists', path: absPath('x.txt') },
        deadlineMinutes: m,
        source: baseSource(),
      });
      assert.equal(validateWatchInput(mk(1) as WatchInput, T0).ok, true);
      assert.equal(validateWatchInput(mk(10080) as WatchInput, T0).ok, true);
      const r1 = validateWatchInput(mk(0) as WatchInput, T0);
      assert.equal(r1.ok, false);
      assert.equal((r1 as { ok: false; error: string }).error, 'deadline_minutes must be between 1 and 10080');
      const r2 = validateWatchInput(mk(10081) as WatchInput, T0);
      assert.equal(r2.ok, false);
      assert.equal((r2 as { ok: false; error: string }).error, 'deadline_minutes must be between 1 and 10080');
    });

    it('applies defaults: intervalMs 60000, deadlineAt = now + 24h', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = { description: 'ok', check: { type: 'file_exists', path: absPath('x.txt') }, source: baseSource() };
      const r = validateWatchInput(input as WatchInput, T0);
      assert.equal(r.ok, true);
      const v = (r as any).value;
      assert.equal(v.intervalMs, 60_000);
      assert.equal(v.deadlineAt, new Date(T0 + 24 * 3_600_000).toISOString());
    });

    it('normalized check carries only its own type\'s fields', async () => {
      const { validateWatchInput } = await import('../src/lib/watch-jobs.js');
      const input = {
        description: 'ok',
        check: { type: 'file_exists', path: absPath('x.txt'), pattern: 'should be dropped', pid: 999 },
        source: baseSource(),
      };
      const r = validateWatchInput(input as unknown as WatchInput, T0);
      assert.equal(r.ok, true);
      const check = (r as any).value.check;
      // normalizeWatchPath applies path.resolve() — compare against the
      // resolved form (identical to absPath('x.txt') here since it's already
      // absolute, but resolvePath is the source of truth), not the raw input.
      assert.deepEqual(check, { type: 'file_exists', path: resolvePath(absPath('x.txt')) });
      assert.equal('pattern' in check, false);
      assert.equal('pid' in check, false);
    });
  });

  describe('evaluateCheck (real temp files)', () => {
    it('file_exists: met when present, not-met and "does not exist" when absent', async () => {
      const { evaluateCheck } = await import('../src/lib/watch-jobs.js');
      const p = join(dir, 'exists.txt');
      await writeFile(p, 'hi', 'utf8');
      const ev = await evaluateCheck({ type: 'file_exists', path: p }, Date.now());
      assert.equal(ev.met, true);
      assert.match(ev.observation, /^exists \(\d+ bytes, mtime .+\)$/);

      const evAbsent = await evaluateCheck({ type: 'file_exists', path: join(dir, 'nope.txt') }, Date.now());
      assert.equal(evAbsent.met, false);
      assert.equal(evAbsent.observation, 'does not exist');
    });

    it('file_gone: met ("gone") when absent, not-met ("still exists ...") when present', async () => {
      const { evaluateCheck } = await import('../src/lib/watch-jobs.js');
      const evAbsent = await evaluateCheck({ type: 'file_gone', path: join(dir, 'nope.txt') }, Date.now());
      assert.equal(evAbsent.met, true);
      assert.equal(evAbsent.observation, 'gone');

      const p = join(dir, 'stillhere.txt');
      await writeFile(p, 'hi', 'utf8');
      const evPresent = await evaluateCheck({ type: 'file_gone', path: p }, Date.now());
      assert.equal(evPresent.met, false);
      assert.match(evPresent.observation, /^still exists \(\d+ bytes, mtime .+\)$/);
    });

    it('file_newer_than: met/not-met against sinceIso, "does not exist" when absent', async () => {
      const { evaluateCheck } = await import('../src/lib/watch-jobs.js');
      const p = join(dir, 'newer.txt');
      await writeFile(p, 'hi', 'utf8');

      const past = new Date(Date.now() - 60_000).toISOString();
      const evMet = await evaluateCheck({ type: 'file_newer_than', path: p, sinceIso: past }, Date.now());
      assert.equal(evMet.met, true);
      assert.match(evMet.observation, /^modified at .+ \(after .+\)$/);

      const future = new Date(Date.now() + 60_000).toISOString();
      const evNotMet = await evaluateCheck({ type: 'file_newer_than', path: p, sinceIso: future }, Date.now());
      assert.equal(evNotMet.met, false);
      assert.match(evNotMet.observation, /^unchanged since .+ \(mtime .+\)$/);

      const evAbsent = await evaluateCheck(
        { type: 'file_newer_than', path: join(dir, 'nope.txt'), sinceIso: past },
        Date.now(),
      );
      assert.equal(evAbsent.met, false);
      assert.equal(evAbsent.observation, 'does not exist');
    });

    it('file_contains: match found, no match, absent, empty file, snippet truncation, tail-only scan', async () => {
      const { evaluateCheck, CONTAINS_TAIL_BYTES, CONTAINS_SNIPPET_CHARS } = await import('../src/lib/watch-jobs.js');

      const p = join(dir, 'contains.txt');
      await writeFile(p, 'line one\nline two has NEEDLE right here\nline three', 'utf8');
      const evMatch = await evaluateCheck({ type: 'file_contains', path: p, pattern: 'NEEDLE' }, Date.now());
      assert.equal(evMatch.met, true);
      assert.match(evMatch.observation, /^matched in last \d+ bytes of \d+$/);
      assert.equal(evMatch.detail, 'Match: line two has NEEDLE right here');

      const evNoMatch = await evaluateCheck({ type: 'file_contains', path: p, pattern: 'NOT_THERE' }, Date.now());
      assert.equal(evNoMatch.met, false);
      assert.match(evNoMatch.observation, /^no match in last \d+ bytes of \d+$/);

      const evAbsent = await evaluateCheck(
        { type: 'file_contains', path: join(dir, 'nope.txt'), pattern: 'x' },
        Date.now(),
      );
      assert.equal(evAbsent.met, false);
      assert.equal(evAbsent.observation, 'does not exist');

      const empty = join(dir, 'empty.txt');
      await writeFile(empty, '', 'utf8');
      const evEmpty = await evaluateCheck({ type: 'file_contains', path: empty, pattern: 'x' }, Date.now());
      assert.equal(evEmpty.met, false);
      assert.equal(evEmpty.observation, 'no match in last 0 bytes of 0');

      // snippet truncation: a matching line far longer than CONTAINS_SNIPPET_CHARS
      const longLine = 'HEAD_NEEDLE' + 'y'.repeat(400);
      const longPath = join(dir, 'longline.txt');
      await writeFile(longPath, longLine, 'utf8');
      const evLong = await evaluateCheck({ type: 'file_contains', path: longPath, pattern: 'HEAD_NEEDLE' }, Date.now());
      assert.equal(evLong.met, true);
      assert.equal((evLong.detail as string).length, 'Match: '.length + CONTAINS_SNIPPET_CHARS);

      // tail-only scan: a token at byte 0 of a file > 256 KB is NOT found; a token
      // in the last bytes IS found.
      const bigPath = join(dir, 'big.txt');
      const filler = 'z'.repeat(CONTAINS_TAIL_BYTES + 50_000);
      await writeFile(bigPath, 'HEAD_TOKEN\n' + filler + '\nTAIL_TOKEN', 'utf8');
      const evHead = await evaluateCheck({ type: 'file_contains', path: bigPath, pattern: 'HEAD_TOKEN' }, Date.now());
      assert.equal(evHead.met, false, 'a token beyond the 256 KB tail must not be found');
      const evTail = await evaluateCheck({ type: 'file_contains', path: bigPath, pattern: 'TAIL_TOKEN' }, Date.now());
      assert.equal(evTail.met, true, 'a token within the 256 KB tail must be found');
    });

    it('process_gone: met/not-met via an injected aliveFn, never the OS', async () => {
      const { evaluateCheck } = await import('../src/lib/watch-jobs.js');
      let calls = 0;
      const aliveFn = async (pids: number[]) => {
        calls++;
        return new Map(pids.map((p) => [p, p === 111]));
      };
      const evGone = await evaluateCheck({ type: 'process_gone', pid: 222 }, Date.now(), { aliveFn });
      assert.equal(evGone.met, true);
      assert.equal(evGone.observation, 'pid 222 is no longer running');

      const evAlive = await evaluateCheck({ type: 'process_gone', pid: 111 }, Date.now(), { aliveFn });
      assert.equal(evAlive.met, false);
      assert.equal(evAlive.observation, 'pid 111 is still running');
      assert.equal(calls, 2);
    });
  });

  describe('store', () => {
    it('addWatchJob mints w- + 8 hex and lists it as active', async () => {
      const { addWatchJob, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const r = await addWatchJob({
        description: 'watch a',
        check: { type: 'file_exists', path: join(dir, 'a.txt') },
        source: baseSource(),
      });
      assert.equal(r.ok, true);
      assert.match((r as any).watch.id, /^w-[0-9a-f]{8}$/);
      const all = await listWatchJobs();
      assert.equal(all.length, 1);
      assert.equal(all[0].status, 'active');
    });

    it('rejects a 26th active registration with the frozen cap string; the 25 survive', async () => {
      const { addWatchJob, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      for (let i = 0; i < 25; i++) {
        const r = await addWatchJob({
          description: `watch ${i}`,
          check: { type: 'file_exists', path: join(dir, `f${i}.txt`) },
          source: baseSource(),
        });
        assert.equal(r.ok, true, `watch ${i} should succeed`);
      }
      const r26 = await addWatchJob({
        description: 'watch 26',
        check: { type: 'file_exists', path: join(dir, 'f26.txt') },
        source: baseSource(),
      });
      assert.equal(r26.ok, false);
      assert.equal(
        (r26 as { ok: false; error: string }).error,
        'watch limit reached (25 active) — cancel one with `pa watch rm <id>`',
      );
      const all = await listWatchJobs();
      assert.equal(all.filter((w) => w.status === 'active').length, 25);
    });

    it('cancelWatchJob sets cancelled (no notify dependency to exercise — D3: cancel never sends)', async () => {
      const { addWatchJob, cancelWatchJob, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const r = await addWatchJob({
        description: 'to cancel',
        check: { type: 'file_exists', path: join(dir, 'c.txt') },
        source: baseSource(),
      });
      const id = (r as any).watch.id;
      const cr = await cancelWatchJob(id);
      assert.equal(cr.ok, true);
      const all = await listWatchJobs();
      const row = all.find((w) => w.id === id)!;
      assert.equal(row.status, 'cancelled');
      assert.ok(row.terminalAt);
    });

    it('cancelWatchJob on an unknown id returns the frozen error', async () => {
      const { cancelWatchJob } = await import('../src/lib/watch-jobs.js');
      const r = await cancelWatchJob('w-deadbeef');
      assert.equal(r.ok, false);
      assert.equal(r.error, 'no watch with id w-deadbeef');
    });

    it('cancelWatchJob on an already-terminal id returns the frozen error', async () => {
      const { addWatchJob, cancelWatchJob } = await import('../src/lib/watch-jobs.js');
      const r = await addWatchJob({
        description: 'twice',
        check: { type: 'file_exists', path: join(dir, 'twice.txt') },
        source: baseSource(),
      });
      const id = (r as any).watch.id;
      await cancelWatchJob(id);
      const r2 = await cancelWatchJob(id);
      assert.equal(r2.ok, false);
      assert.equal(r2.error, `watch ${id} is already cancelled`);
    });

    it('a truncated/garbage watch-jobs.json is reset to empty rather than throwing', async () => {
      const { watchJobsPath, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      await mkdir(dir, { recursive: true });
      await writeFile(watchJobsPath(), '{not valid json', 'utf8');
      const all = await listWatchJobs();
      assert.deepEqual(all, []);
    });
  });

  describe('runWatchTick', () => {
    it('condition true: sends the COMPLETE report and terminals the row as reported', async () => {
      const { addWatchJob, runWatchTick } = await import('../src/lib/watch-jobs.js');
      const target = join(dir, 'done.txt');
      const reg = await addWatchJob({
        description: 'finish the download',
        check: { type: 'file_exists', path: target },
        source: { kind: 'cli', chatId: '999', threadId: 42, refId: null },
      });
      const id = (reg as any).watch.id;
      await writeFile(target, 'x', 'utf8');

      const { fn, calls } = recordingNotify();
      const result = await runWatchTick({ now: Date.now(), notify: fn });
      assert.equal(result.checked, 1);
      assert.equal(result.reported, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].subject, '✅ Watch complete: finish the download');
      assert.equal(calls[0].opts.dedupKey, `watch:${id}:reported`);
      assert.deepEqual(calls[0].opts.topic, { chat_id: '999', thread_id: 42 });

      const { listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'reported');
      assert.ok(row.terminalAt);
      assert.ok(row.outcome && row.outcome.length > 0);
    });

    // AI-184 (2026-09-03): the report body reaches the operator's own chat
    // UNREDACTED; the scrub survives on the persistence side (the stored row
    // outcome). BOTH directions pinned on the real runWatchTick → sendReport
    // → notify seam, with the name riding the BODY (file_contains Match line),
    // not just the subject.
    it('terminal report delivers the body raw; the stored outcome stays redacted (AI-184)', async () => {
      const OPERATOR_NAME = 'OperatorNameFixture';
      await createTempSecrets(dir, `PA_USER_NAME=${OPERATOR_NAME}\n`);
      resetRedactCache();
      try {
        const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
        const target = join(dir, 'ai184-done.log');
        const reg = await addWatchJob({
          description: 'watch report delivery shape (AI-184)',
          check: { type: 'file_contains', path: target, pattern: OPERATOR_NAME },
          source: baseSource(),
        });
        const id = (reg as any).watch.id;
        await writeFile(target, `status: ${OPERATOR_NAME} signed off\n`, 'utf8');

        const { fn, calls } = recordingNotify();
        const result = await runWatchTick({ now: Date.now(), notify: fn });
        assert.equal(result.reported, 1);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].body.includes(OPERATOR_NAME), 'delivered body keeps the name');
        assert.ok(!calls[0].body.includes('<redacted:'), 'delivered body carries no placeholder');

        const row = (await listWatchJobs()).find((w) => w.id === id)!;
        assert.ok(!row.outcome!.includes(OPERATOR_NAME), 'stored outcome must NOT keep the name');
        assert.ok(row.outcome!.includes('<redacted:PA_USER_NAME>'), 'stored outcome records the placeholder');
      } finally {
        resetRedactCache();
      }
    });

    it('send-then-persist: a not-sent/not-suppressed result leaves the row active and re-sends next tick', async () => {
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const target = join(dir, 'donenotsent.txt');
      const reg = await addWatchJob({
        description: 'donotsend',
        check: { type: 'file_exists', path: target },
        source: baseSource(),
      });
      const id = (reg as any).watch.id;
      await writeFile(target, 'x', 'utf8');

      const failing = recordingNotify(async () => ({ sent: false, suppressed: false }));
      const now1 = Date.now();
      const r1 = await runWatchTick({ now: now1, notify: failing.fn });
      assert.equal(r1.reported, 0);
      let row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'active');
      assert.equal(row.terminalAt, undefined);

      const succeeding = recordingNotify();
      const now2 = now1 + 61_000;
      const r2 = await runWatchTick({ now: now2, notify: succeeding.fn });
      assert.equal(r2.reported, 1);
      row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'reported');
    });

    it('send-then-persist: suppressed:true still counts as delivered', async () => {
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const target = join(dir, 'suppressed.txt');
      const reg = await addWatchJob({
        description: 'suppressed case',
        check: { type: 'file_exists', path: target },
        source: baseSource(),
      });
      const id = (reg as any).watch.id;
      await writeFile(target, 'x', 'utf8');

      const suppressed = recordingNotify(async () => ({ sent: false, suppressed: true }));
      await runWatchTick({ now: Date.now(), notify: suppressed.fn });
      const row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'reported');
      assert.ok(row.terminalAt);
    });

    it('deadline passed, condition false: sends EXPIRED with the last observation', async () => {
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const reg = await addWatchJob(
        {
          description: 'never finishes',
          check: { type: 'file_exists', path: join(dir, 'neverexists.txt') },
          deadlineMinutes: 1,
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;

      const { fn, calls } = recordingNotify();
      const past = T0 + 2 * 60_000; // 1 minute deadline, tick at +2 minutes
      const result = await runWatchTick({ now: past, notify: fn });
      assert.equal(result.expired, 1);
      assert.equal(calls[0].subject, '⏰ Watch expired without completing: never finishes');
      assert.match(calls[0].body, /does not exist/);

      const row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'expired');
    });

    it('error ladder: 4 silent ticks then a check-failed report + terminal on tick 5', async () => {
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const reg = await addWatchJob(
        {
          description: 'always errors',
          check: { type: 'process_gone', pid: 1 },
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;
      const failingAlive = async () => {
        throw new Error('simulated OS failure');
      };

      const { fn, calls } = recordingNotify();
      let now = T0;
      for (let tick = 1; tick <= 4; tick++) {
        now += 61_000;
        const r = await runWatchTick({ now, notify: fn, aliveFn: failingAlive });
        assert.equal(r.failed, 0, `tick ${tick} must not terminal`);
        assert.equal(calls.length, 0, `tick ${tick} must send nothing`);
      }
      now += 61_000;
      const r5 = await runWatchTick({ now, notify: fn, aliveFn: failingAlive });
      assert.equal(r5.failed, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].subject, '⚠️ Watch check failing: always errors');
      assert.match(calls[0].body, /simulated OS failure/);

      const row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'check-failed');
      assert.equal(row.consecutiveErrors, 5);
    });

    // --- WP-D2 B.7 + ADDITION (2026-09-02, the topic-handover WAVE2 spec):
    // terminal reports carry the wt: re-register keyboard, and terminal outcomes ACT —
    // wave_done event on success; task_failed event + auto-filed reaction task on failure.

    async function readTopicEventsFile(): Promise<Array<{ kind: string; ref: string | null; detail: string }>> {
      const { readFile } = await import('fs/promises');
      try {
        const raw = await readFile(join(dir, 'topic-events', '12345_0.jsonl'), 'utf8');
        return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    }

    async function readTopicTaskQueue(): Promise<Array<{ id: string; title: string; prompt: string; created_by: string }>> {
      const { readFile } = await import('fs/promises');
      try {
        const raw = await readFile(join(dir, 'topic-tasks', '12345_0.json'), 'utf8');
        return JSON.parse(raw);
      } catch {
        return [];
      }
    }

    it('watch check-failed report carries re-register button', async () => {
      const { addWatchJob, runWatchTick } = await import('../src/lib/watch-jobs.js');
      const reg = await addWatchJob(
        {
          description: 'keyboard ladder',
          check: { type: 'process_gone', pid: 1 },
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;
      const failingAlive = async () => {
        throw new Error('simulated OS failure');
      };
      const { fn, calls } = recordingNotify();
      let now = T0;
      for (let tick = 1; tick <= 5; tick++) {
        now += 61_000;
        await runWatchTick({ now, notify: fn, aliveFn: failingAlive });
      }
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].opts?.replyMarkup, {
        inline_keyboard: [[{ text: '🔁 Re-register watch', callback_data: `wt:${id}:r` }]],
      });

      // ADDITION failure lane: task_failed event, the auto-filed reaction task
      // (verbatim prompt, watch-system provenance), then a task_queued event.
      const events = await readTopicEventsFile();
      assert.deepEqual(events.map((e) => e.kind), ['task_failed', 'task_queued']);
      assert.equal(events[0].ref, id);
      assert.match(events[0].detail, /simulated OS failure/);
      const tasks = await readTopicTaskQueue();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].prompt, `Your watch ${id} failed its check — diagnose, retry, or ask the operator`);
      assert.equal(tasks[0].created_by, 'watch-system');
      assert.match(tasks[0].title, new RegExp(`^Watch ${id} failed: keyboard ladder$`));
      assert.equal(events[1].ref, tasks[0].id);
    });

    it('watch completion writes wave_done and files NO task (the report suffices)', async () => {
      const { addWatchJob, runWatchTick } = await import('../src/lib/watch-jobs.js');
      const target = join(dir, 'wavedone.txt');
      const reg = await addWatchJob(
        {
          description: 'completes cleanly',
          check: { type: 'file_exists', path: target },
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;
      await writeFile(target, 'x', 'utf8');
      const { fn } = recordingNotify();
      const result = await runWatchTick({ now: T0 + 61_000, notify: fn });
      assert.equal(result.reported, 1);
      const events = await readTopicEventsFile();
      assert.deepEqual(events.map((e) => e.kind), ['wave_done']);
      assert.equal(events[0].ref, id, 'ref carries the watch id');
      assert.deepEqual(await readTopicTaskQueue(), [], 'success files no reaction task');
    });

    it('expired report carries the re-register button and files the reaction task', async () => {
      const { addWatchJob, runWatchTick } = await import('../src/lib/watch-jobs.js');
      const reg = await addWatchJob(
        {
          description: 'never finishes',
          check: { type: 'file_exists', path: join(dir, 'neverexists-kb.txt') },
          deadlineMinutes: 1,
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;
      const { fn, calls } = recordingNotify();
      const result = await runWatchTick({ now: T0 + 2 * 60_000, notify: fn });
      assert.equal(result.expired, 1);
      assert.deepEqual(calls[0].opts?.replyMarkup, {
        inline_keyboard: [[{ text: '🔁 Re-register watch', callback_data: `wt:${id}:r` }]],
      });
      const events = await readTopicEventsFile();
      assert.deepEqual(events.map((e) => e.kind), ['task_failed', 'task_queued']);
      const tasks = await readTopicTaskQueue();
      assert.equal(tasks.length, 1);
      assert.match(tasks[0].prompt, new RegExp(`^Your watch ${id} failed its check`));
    });

    it('met wins over an already-passed deadline (reports complete, not expired)', async () => {
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const target = join(dir, 'metpastdeadline.txt');
      const reg = await addWatchJob(
        {
          description: 'finishes late',
          check: { type: 'file_exists', path: target },
          deadlineMinutes: 1,
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;
      await writeFile(target, 'x', 'utf8');

      const { fn } = recordingNotify();
      const past = T0 + 5 * 60_000; // well past the 1-minute deadline
      const result = await runWatchTick({ now: past, notify: fn });
      assert.equal(result.reported, 1);
      assert.equal(result.expired, 0);
      const row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'reported');
    });

    it('pacing: a 30s-old row on a 60s interval is not selected; 61s-old is', async () => {
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const reg = await addWatchJob(
        {
          description: 'pacing test',
          check: { type: 'file_exists', path: join(dir, 'pacing.txt') },
          intervalSeconds: 60,
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;

      const { fn } = recordingNotify();
      // First tick establishes lastCheckedAt at T0.
      await runWatchTick({ now: T0, notify: fn });
      let row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.lastCheckedAt, new Date(T0).toISOString());

      const r30 = await runWatchTick({ now: T0 + 30_000, notify: fn });
      assert.equal(r30.checked, 0, '30s-old row on a 60s interval must not be selected');

      const r61 = await runWatchTick({ now: T0 + 61_000, notify: fn });
      assert.equal(r61.checked, 1, '61s-old row must be selected');
    });

    it('MAX_CHECKS_PER_TICK: 15 due rows -> checked === 10, oldest lastCheckedAt first', async () => {
      const { addWatchJob, runWatchTick } = await import('../src/lib/watch-jobs.js');
      for (let i = 0; i < 15; i++) {
        await addWatchJob(
          {
            description: `bulk ${i}`,
            check: { type: 'file_exists', path: join(dir, `bulk${i}.txt`) },
            source: baseSource(),
          },
          T0,
        );
      }
      const { fn } = recordingNotify();
      const result = await runWatchTick({ now: T0, notify: fn });
      assert.equal(result.checked, 10);
    });

    it('prune: a terminal row 15 days old is removed, 13 days old is kept; active is never pruned', async () => {
      const { addWatchJob, cancelWatchJob, listWatchJobs, runWatchTick } = await import('../src/lib/watch-jobs.js');
      const now = T0 + 30 * 24 * 3_600_000; // the tick's own clock — fixed anchor
      const oldTerminalAt = now - 15 * 24 * 3_600_000; // 15 days before the tick
      const recentTerminalAt = now - 13 * 24 * 3_600_000; // 13 days before the tick

      const old = await addWatchJob(
        { description: 'old cancelled', check: { type: 'file_exists', path: join(dir, 'old.txt') }, source: baseSource() },
        T0,
      );
      const oldId = (old as any).watch.id;
      await cancelWatchJob(oldId, oldTerminalAt);

      const recent = await addWatchJob(
        { description: 'recent cancelled', check: { type: 'file_exists', path: join(dir, 'recent.txt') }, source: baseSource() },
        T0,
      );
      const recentId = (recent as any).watch.id;
      await cancelWatchJob(recentId, recentTerminalAt);

      // Registered AT the tick's own `now` (default 24h deadline still ahead of
      // the tick) so it stays genuinely 'active' through the same tick instead
      // of expiring — a row created back at T0 would already be past every
      // possible deadline (max 7 days) by the time `now` (T0+30d) arrives.
      const stillActive = await addWatchJob(
        { description: 'still active', check: { type: 'file_exists', path: join(dir, 'active.txt') }, source: baseSource() },
        now,
      );
      const activeId = (stillActive as any).watch.id;

      const { fn } = recordingNotify();
      const result = await runWatchTick({ now, notify: fn });
      assert.equal(result.pruned, 1);

      const all = await listWatchJobs();
      assert.equal(all.find((w) => w.id === oldId), undefined, '15-day-old terminal row must be pruned');
      assert.ok(all.find((w) => w.id === recentId), 'a row not yet 14 days past terminalAt must survive');
      const activeRow = all.find((w) => w.id === activeId);
      assert.ok(activeRow, 'an active row must never be pruned');
      assert.equal(activeRow!.status, 'active');
    });

    it('force-terminal: 3 days + 1 minute past deadline with sends never confirmed', async () => {
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const reg = await addWatchJob(
        {
          description: 'never confirms',
          check: { type: 'file_exists', path: join(dir, 'neverconfirms.txt') },
          deadlineMinutes: 1,
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;

      const { fn, calls } = recordingNotify();
      const now = T0 + 60_000 /* deadline */ + 3 * 24 * 3_600_000 + 60_000; // deadline + 3d + 1m
      const result = await runWatchTick({ now, notify: fn });
      assert.equal(result.forced, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].subject, `Watch force-terminaled: ${id}`);
      assert.equal(calls[0].opts.topic, undefined, 'force-terminal must NOT carry a topic override');

      const row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.equal(row.status, 'check-failed');
    });

    it('never throws when the store path is a directory', async () => {
      const { watchJobsPath, runWatchTick } = await import('../src/lib/watch-jobs.js');
      await mkdir(watchJobsPath(), { recursive: true });
      const { fn } = recordingNotify();
      const result = await runWatchTick({ now: Date.now(), notify: fn });
      assert.deepEqual(result, { checked: 0, reported: 0, expired: 0, failed: 0, forced: 0, pruned: 0 });
    });
  });

  describe('redaction', () => {
    it('delivered body keeps the matched text raw (AI-184); the scrub survives in the stored outcome', async () => {
      await createTempSecrets(dir, 'MY_TEST_SECRET=sk_live_verylongsecretvalue123\n');
      resetRedactCache();
      const { addWatchJob, runWatchTick, listWatchJobs } = await import('../src/lib/watch-jobs.js');
      const target = join(dir, 'secretfile.txt');
      const reg = await addWatchJob(
        {
          description: 'secret leak check',
          check: { type: 'file_contains', path: target, pattern: 'sk_live_verylongsecretvalue123' },
          source: baseSource(),
        },
        T0,
      );
      const id = (reg as any).watch.id;
      await writeFile(target, 'token=sk_live_verylongsecretvalue123 end', 'utf8');

      const { fn, calls } = recordingNotify();
      await runWatchTick({ now: T0, notify: fn });
      assert.equal(calls.length, 1);
      // AI-184: the report reaches the operator's own chat — raw text, no placeholder.
      assert.ok(calls[0].body.includes('sk_live_verylongsecretvalue123'), 'delivered body keeps real text (AI-184)');
      assert.ok(!calls[0].body.includes('<redacted:'), 'delivered body carries no placeholder');
      // The scrub survives where the report PERSISTS: the row outcome.
      const row = (await listWatchJobs()).find((w) => w.id === id)!;
      assert.ok(!row.outcome!.includes('sk_live_verylongsecretvalue123'), 'stored outcome must not carry the raw secret');
      assert.ok(row.outcome!.includes('<redacted:MY_TEST_SECRET>'), 'stored outcome records the placeholder');
    });
  });
});
