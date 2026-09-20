import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { voiceInboxLedgerPath } from '../src/lib/voice-inbox-ledger.js';
import {
  retryBackoffMs,
  transcribeAttemptDue,
  infraBoundReached,
  defaultRunScript,
  acquireTranscribeClaim,
  transcribeVoiceInboxTask,
  TIMED_OUT_EXIT_CODE,
  type InfraMarkers,
  type TranscribeTaskContext,
} from '../src/lib/voice-inbox-transcribe.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

describe('voice-inbox-transcribe: pacing helpers', () => {
  it('retryBackoffMs paces 0, 2, 5 and 10 minutes by marker count', () => {
    assert.equal(retryBackoffMs(0), 0);
    assert.equal(retryBackoffMs(1), 120_000);
    assert.equal(retryBackoffMs(2), 300_000);
    assert.equal(retryBackoffMs(3), 600_000);
    assert.equal(retryBackoffMs(7), 600_000);
  });

  it('transcribeAttemptDue is due with no markers, not due inside the backoff, due after it', () => {
    const now = Date.now();
    assert.equal(transcribeAttemptDue({ count: 0, newestMs: undefined }, now), true);
    assert.equal(transcribeAttemptDue({ count: 1, newestMs: now - 119_999 }, now), false);
    assert.equal(transcribeAttemptDue({ count: 1, newestMs: now - 120_000 }, now), true);
    assert.equal(transcribeAttemptDue({ count: 2, newestMs: now - 299_999 }, now), false);
  });

  it('infraBoundReached engages at the attempt cap and past the window only with a recorded marker', () => {
    const now = Date.now();
    const markers4: InfraMarkers = { count: 4, newestMs: now };
    assert.equal(infraBoundReached(markers4, new Date(now).toISOString(), now, 4, 45 * 60_000), true);

    const markers3: InfraMarkers = { count: 3, newestMs: now };
    assert.equal(infraBoundReached(markers3, new Date(now).toISOString(), now, 4, 45 * 60_000), false);

    const markers1Old: InfraMarkers = { count: 1, newestMs: now };
    const created46MinAgo = new Date(now - 46 * 60_000).toISOString();
    assert.equal(infraBoundReached(markers1Old, created46MinAgo, now, 4, 45 * 60_000), true);

    const markers0Old: InfraMarkers = { count: 0, newestMs: undefined };
    assert.equal(infraBoundReached(markers0Old, created46MinAgo, now, 4, 45 * 60_000), false);
  });
});

describe('voice-inbox-transcribe: defaultRunScript', () => {
  it('defaultRunScript returns stdout and the exit code of a normal script', async () => {
    const script = join(tempDir, 'ok.py');
    writeFileSync(script, "import sys\nprint('{\"ok\": true}')\nsys.exit(3)\n", 'utf8');
    const result = await defaultRunScript(script, [], process.env, 30_000);
    assert.equal(result.code, 3);
    assert.match(result.stdout, /\{"ok": true\}/);
    assert.notEqual(result.timedOut, true);
  });

  it('defaultRunScript resolves at its timeout and kills the whole process tree by captured PID', { timeout: 90_000 }, async () => {
    const script = join(tempDir, 'tree.py');
    writeFileSync(
      script,
      'import subprocess, sys, time\n' +
        'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])\n' +
        'print(f"child {child.pid}", flush=True)\n' +
        'time.sleep(120)\n',
      'utf8'
    );
    const t0 = Date.now();
    const r = await defaultRunScript(script, [], process.env, 15_000);
    assert.equal(r.timedOut, true);
    assert.equal(r.code, TIMED_OUT_EXIT_CODE);
    assert.ok(Date.now() - t0 < 45_000);
    assert.equal(typeof r.pid, 'number');
    const match = /child (\d+)/.exec(r.stdout);
    assert.ok(match, `expected the script's stdout to report the child pid; got: ${r.stdout}`);
    const childPid = Number(match![1]);

    const deadline = Date.now() + 20_000;
    let parentDead = !isAlive(r.pid!);
    let childDead = !isAlive(childPid);
    while ((!parentDead || !childDead) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      parentDead = !isAlive(r.pid!);
      childDead = !isAlive(childPid);
    }
    assert.ok(parentDead, 'the timed-out parent process must be dead');
    assert.ok(childDead, 'the parent\'s child must be dead too (whole tree killed)');
  });
});

describe('voice-inbox-transcribe: acquireTranscribeClaim', () => {
  it('acquireTranscribeClaim is exclusive per task until released', async () => {
    const c1 = await acquireTranscribeClaim('vi-aaaaaaaaaaaa');
    assert.notEqual(c1, null);
    const c2 = await acquireTranscribeClaim('vi-aaaaaaaaaaaa');
    assert.equal(c2, null);
    const o = await acquireTranscribeClaim('vi-bbbbbbbbbbbb');
    assert.notEqual(o, null);
    await c1!.release();
    const c3 = await acquireTranscribeClaim('vi-aaaaaaaaaaaa');
    assert.notEqual(c3, null);
    await o!.release();
    await c3!.release();
  });
});

// A4 (2026-09-16, WP-1 follow-up): the fallback's own "releases the
// transcription claim after the attempt" test only ever exercises the
// SUCCESS outcome. transcribeVoiceInboxTask's claim release lives in a
// `finally` around the whole attempt, so it must also release on a terminal
// FAILURE outcome and when the attempt THROWS — read back from the real
// blackboard.json, same as the success-path test.
describe('voice-inbox-transcribe: claim release on non-success paths', () => {
  function makeMinimalLedger(taskId: string, tenantId: string, createdAtIso: string): void {
    mkdirSync(join(tempDir, 'voice-inbox'), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    try {
      db.exec(
        'CREATE TABLE tasks (task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL)'
      );
      db.prepare('INSERT INTO tasks (task_id, tenant_id, state, created_at) VALUES (?, ?, ?, ?)').run(
        taskId,
        tenantId,
        'transcribing',
        createdAtIso
      );
    } finally {
      db.close();
    }
  }

  function baseCtx(now: number): TranscribeTaskContext {
    return {
      caller: 'voice-inbox-transcribe-drain',
      now,
      repoRoot: process.cwd(),
      ledgerPath: voiceInboxLedgerPath(),
      infraMaxAttempts: 4,
      infraWindowMs: 45 * 60_000,
    };
  }

  function noLockRemains(): boolean {
    const blackboardData = JSON.parse(readFileSync(join(tempDir, 'blackboard.json'), 'utf8'));
    return !blackboardData.active_locks.some((l: any) => String(l.resource ?? '').startsWith('voice-inbox-transcribe:'));
  }

  it('releases the transcription claim on the FAILURE path (a terminal task_transcribe.py --fail)', async () => {
    const now = Date.now();
    const taskId = 'vi-cccccccccc01';
    const createdAt = new Date(now).toISOString();
    makeMinimalLedger(taskId, 't-claim-fail', createdAt);

    const outcome = await transcribeVoiceInboxTask(
      { task_id: taskId, tenant_id: 't-claim-fail', created_at: createdAt },
      baseCtx(now),
      {
        runScript: async () => ({ stdout: '', stderr: '', code: 0 }),
        transcribeFn: async () => {
          throw new Error('must not be called: audio file is missing, a terminal fail happens first');
        },
        loadSecretsFn: async () => ({}),
        findAudioFileFn: () => undefined, // no audio file -> the terminal audio-missing fail branch
        fileSizeFn: () => undefined,
        loadVoiceInboxModules: async () => {
          throw new Error('must not be called on this branch');
        },
        notifyFn: async () => ({ sent: true, suppressed: false }),
        claimFn: acquireTranscribeClaim,
      }
    );

    assert.equal(outcome.kind, 'failed-terminal');
    assert.equal(outcome.acted, true);
    assert.ok(noLockRemains(), 'the transcription claim must be released after a FAILURE outcome');
  });

  it('releases the transcription claim on the THROW path (the attempt throws)', async () => {
    const now = Date.now();
    const taskId = 'vi-cccccccccc02';
    const createdAt = new Date(now).toISOString();
    makeMinimalLedger(taskId, 't-claim-throw', createdAt);

    await assert.rejects(
      transcribeVoiceInboxTask(
        { task_id: taskId, tenant_id: 't-claim-throw', created_at: createdAt },
        baseCtx(now),
        {
          runScript: async () => ({ stdout: '', stderr: '', code: 0 }),
          transcribeFn: async () => {
            throw new Error('boom');
          },
          loadSecretsFn: async () => ({}),
          findAudioFileFn: () => join(tempDir, 'audio.wav'),
          fileSizeFn: () => 999_999,
          loadVoiceInboxModules: async () => {
            throw new Error('must not be called on this branch');
          },
          notifyFn: async () => ({ sent: true, suppressed: false }),
          claimFn: acquireTranscribeClaim,
        }
      ),
      /boom/
    );

    assert.ok(noLockRemains(), 'the transcription claim must be released after a THROWN error');
  });
});
