import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { readRecentFailures, buildFailurePrompt } from '../src/failure-analyzer.js';
import type { FailureRecord } from '../src/failure-analyzer.js';
import { createTempPaHome, cleanup } from './helpers.js';
import type { RunMeta } from '../src/types.js';

async function createTempMeta(dir: string, skillName: string, meta: RunMeta): Promise<void> {
  const logDir = join(dir, 'logs', skillName);
  await mkdir(logDir, { recursive: true });
  const ts = meta.timestamp.replace(/[:.]/g, '-').slice(0, 19);
  await writeFile(join(logDir, `${ts}-abc123.meta`), JSON.stringify(meta, null, 2), 'utf8');
}

function makeErrorMeta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    worker: 'gemini',
    status: 'error',
    exitCode: -1,
    duration: 300000,
    timestamp: new Date().toISOString(),
    error: 'Killed: exceeded max timeout of 600s',
    ...overrides,
  };
}

describe('failure-analyzer', () => {
  let dir: string;

  before(async () => {
    dir = await createTempPaHome();
  });

  after(async () => {
    await cleanup(dir);
  });

  describe('readRecentFailures', () => {
    it('reads meta files and filters to errors within date range', async () => {
      await createTempMeta(dir, 'my-skill', makeErrorMeta({ error: 'Timed out' }));

      const failures = await readRecentFailures(7);
      const skillFailures = failures.filter((f) => f.skillName === 'my-skill');
      assert.ok(skillFailures.length >= 1);
      assert.equal(skillFailures[0].error, 'Timed out');
    });

    it('excludes old failures outside the date window', async () => {
      const oldTimestamp = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
      await createTempMeta(dir, 'old-skill', makeErrorMeta({ timestamp: oldTimestamp, error: 'Old error' }));

      const failures = await readRecentFailures(7);
      const oldFailures = failures.filter((f) => f.skillName === 'old-skill');
      assert.equal(oldFailures.length, 0);
    });

    it('excludes successful runs', async () => {
      await createTempMeta(dir, 'success-skill', {
        worker: 'claude',
        status: 'success',
        exitCode: 0,
        duration: 1000,
        timestamp: new Date().toISOString(),
      });

      const failures = await readRecentFailures(7);
      const successRuns = failures.filter((f) => f.skillName === 'success-skill');
      assert.equal(successRuns.length, 0);
    });

    it('returns empty array when logs dir does not exist', async () => {
      const origHome = process.env.PA_HOME;
      try {
        process.env.PA_HOME = join(dir, 'no-such-subdir');
        const failures = await readRecentFailures(7);
        assert.deepEqual(failures, []);
      } finally {
        process.env.PA_HOME = origHome;
      }
    });
  });

  describe('buildFailurePrompt', () => {
    it('groups failures by skill and includes counts', () => {
      const failures: FailureRecord[] = [
        { skillName: 'my-skill', error: 'Timeout', timestamp: new Date().toISOString(), duration: 600000, worker: 'gemini' },
        { skillName: 'my-skill', error: 'Timeout', timestamp: new Date().toISOString(), duration: 600000, worker: 'gemini' },
        { skillName: 'other-skill', error: 'Auth error', timestamp: new Date().toISOString(), duration: 1000, worker: 'claude' },
        { skillName: 'other-skill', error: 'Auth error', timestamp: new Date().toISOString(), duration: 1000, worker: 'claude' },
      ];

      const prompt = buildFailurePrompt(failures, [], []);
      assert.match(prompt, /my-skill/);
      assert.match(prompt, /other-skill/);
      assert.match(prompt, /2 failures/);
      assert.match(prompt, /Timeout/);
      assert.match(prompt, /Auth error/);
    });

    it('excludes skills with only 1 failure', () => {
      const failures: FailureRecord[] = [
        { skillName: 'one-off', error: 'Fluke', timestamp: new Date().toISOString(), duration: 100, worker: 'gemini' },
      ];

      const prompt = buildFailurePrompt(failures, [], []);
      assert.doesNotMatch(prompt, /one-off/);
      assert.match(prompt, /no qualifying failures/);
    });

    it('includes existing skills in exclusion context', () => {
      const prompt = buildFailurePrompt([], ['daily-mail-brief'], []);
      assert.match(prompt, /daily-mail-brief/);
    });
  });
});
