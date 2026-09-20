import './test-env-guard.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempPaHome, createTempConfig, createTempSecrets, cleanup } from './helpers.js';
import { executeWorker } from '../src/workers.js';
import { isMtimeFresh, isStateFreshForKillDecision, EVALUATOR_MTIME_FRESH_MS } from '../src/worker-exec.js';
import type { WorkerConfig } from '../src/types.js';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  // Write empty secrets.env to prevent real Telegram alerts during tests
  await createTempSecrets(tempDir, '');
  scriptDir = join(tmpdir(), `pa-test-wexec-mtime-${Date.now()}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
});

function makeWorker(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    name: 'test',
    command: 'node',
    args: ['{prompt}'],
    check: 'echo ok',
    rate_limit_patterns: [],
    priority: 1,
    input_mode: 'arg',
    check_timeout: 5,
    ...overrides,
  };
}

// Write a small node script to a file (avoids -e shell escaping on Windows)
async function writeScript(name: string, code: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

describe('isMtimeFresh boundaries', () => {
  it('1s-old mtime is fresh in a 60s window', () => {
    const now = Date.now();
    assert.equal(isMtimeFresh(new Date(now - 1000), now, 60000), true);
  });

  it('mtime exactly at the window edge is stale (strict <)', () => {
    const now = Date.now();
    assert.equal(isMtimeFresh(new Date(now - 60000), now, 60000), false);
  });

  it('stale mtime is not fresh', () => {
    const now = Date.now();
    assert.equal(isMtimeFresh(new Date(now - 120000), now, 60000), false);
  });

  it('null mtime is not fresh', () => {
    assert.equal(isMtimeFresh(null, Date.now(), 60000), false);
  });

  it('future mtime reads fresh (safe direction)', () => {
    const now = Date.now();
    assert.equal(isMtimeFresh(new Date(now + 5000), now, 60000), true);
  });

  it('EVALUATOR_MTIME_FRESH_MS is the spec-fixed 60s const', () => {
    assert.equal(EVALUATOR_MTIME_FRESH_MS, 60_000);
  });
});

describe('isStateFreshForKillDecision', () => {
  it('fresh file reads true', async () => {
    const stateDir = join(tempDir, 'state-fresh');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.jsonl'), '{"a":1}\n', 'utf8');
    assert.equal(await isStateFreshForKillDecision(stateDir, '*.jsonl', Date.now(), 60000), true);
  });

  it('utimes-backdated 120s file reads false', async () => {
    const stateDir = join(tempDir, 'state-stale');
    await mkdir(stateDir, { recursive: true });
    const file = join(stateDir, 'session.jsonl');
    await writeFile(file, '{"a":1}\n', 'utf8');
    const backdate = new Date(Date.now() - 120000);
    await utimes(file, backdate, backdate);
    assert.equal(await isStateFreshForKillDecision(stateDir, '*.jsonl', Date.now(), 60000), false);
  });

  it('null dir reads false', async () => {
    assert.equal(await isStateFreshForKillDecision(null, '*.jsonl', Date.now(), 60000), false);
  });

  it('missing dir reads false (never throws)', async () => {
    assert.equal(
      await isStateFreshForKillDecision(join(tempDir, 'does-not-exist'), '*.jsonl', Date.now(), 60000),
      false,
    );
  });
});

describe('mtime-freshness shortcut behavioral', () => {
  it('fresh state extends without spawning the judge (judge-spawns-avoided marker)', async () => {
    const stateDir = join(tempDir, 'state-shortcut');
    await mkdir(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'session.json');
    const markerFile = join(stateDir, 'judge-spawned.marker');
    const body = JSON.stringify({ messages: [{ type: 'gemini', content: 'working' }] });
    await writeFile(stateFile, body, 'utf8');

    // Worker rewrites its state file every 1s (silently — no stdout, so the
    // idle timer fires) then hangs. mtime age stays ≤ ~1s < 2s window.
    const workerScript = await writeScript('rewrite-hang.js', `
      const fs = require('fs');
      const p = ${JSON.stringify(stateFile)};
      const body = ${JSON.stringify(body)};
      fs.writeFileSync(p, body);
      setInterval(() => { fs.writeFileSync(p, body); }, 1000);
      setTimeout(() => {}, 60000);
    `);

    // Evaluator appends Date.now() per spawn (kill verdict), so each judge
    // spawn is one timestamped line in the marker file.
    const evalScript = await writeScript('evaluator-marker.js', `
      const fs = require('fs');
      fs.appendFileSync(${JSON.stringify(markerFile)}, Date.now() + ${JSON.stringify('\n')});
      process.stdout.write(JSON.stringify({verdict:"kill",summary:"Stop now",reason:"stuck"}));
    `);

    await createTempConfig(tempDir, [
      { name: 'worker-under-test', command: 'node', args: [workerScript], check: 'echo ok', priority: 1 },
      { name: 'evaluator', command: 'node', args: [evalScript], check: 'echo ok', priority: 2 },
    ], { evaluator: { worker: 'evaluator', timeout: 10 } });

    const worker = makeWorker({
      name: 'worker-under-test',
      command: 'node',
      args: [workerScript],
      state_dir: stateDir,
      state_pattern: 'session.json',
    });

    // window = min(60s, 2s) = 2s; mtime age ≤ ~1s → the shortcut extends every
    // idle fire without consulting the judge. onMaxTimeout consults the judge
    // before a max kill, so exactly one spawn at max-timeout is expected:
    // zero marker entries before t≈7s, exactly one entry at max-timeout.
    const resultPromise = executeWorker(worker, 'unused', { timeout: 8, idleTimeout: 2 });

    // Poll the marker for ~7s: any idle-path judge spawn fails here (the
    // shortcut must have fired on every idle check so far).
    const pollStart = Date.now();
    const { readFile } = await import('fs/promises');
    while (Date.now() - pollStart < 7000) {
      if (existsSync(markerFile)) {
        const early = await readFile(markerFile, 'utf8');
        assert.equal(early.trim(), '', `judge spawned before max-timeout (idle shortcut failed): ${early}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const result = await resultPromise;

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('exceeded max timeout'), `Expected max timeout, got: ${result.error}`);
    const markerContent = await readFile(markerFile, 'utf8');
    const entries = markerContent.trim().split('\n').filter((l) => l.trim().length > 0);
    assert.equal(entries.length, 1, `expected exactly one judge spawn at max-timeout, got ${entries.length}: ${markerContent}`);
    assert.ok(/^\d+$/.test(entries[0].trim()), `marker entry must be a Date.now() timestamp, got: ${entries[0]}`);
  });

  it('stale state abstains from the shortcut and runs the ladder (kill verdict)', async () => {
    const stateDir = join(tempDir, 'state-ladder');
    await mkdir(stateDir, { recursive: true });
    const stateFile = join(stateDir, 'session.json');
    await writeFile(stateFile, JSON.stringify({
      messages: [{ type: 'gemini', content: 'working' }],
    }), 'utf8');
    const backdate = new Date(Date.now() - 120000);
    await utimes(stateFile, backdate, backdate);

    const evalScript = await writeScript('evaluator-kill.js',
      'process.stdout.write(JSON.stringify({verdict:"kill",summary:"Stop now",reason:"stuck"}));'
    );
    const workerScript = await writeScript('hang-ladder.js', 'setTimeout(()=>{}, 60000);');

    await createTempConfig(tempDir, [
      { name: 'worker-under-test', command: 'node', args: [workerScript], check: 'echo ok', priority: 1 },
      { name: 'evaluator', command: 'node', args: [evalScript], check: 'echo ok', priority: 2 },
    ], { evaluator: { worker: 'evaluator', timeout: 10 } });

    const worker = makeWorker({
      name: 'worker-under-test',
      command: 'node',
      args: [workerScript],
      state_dir: stateDir,
      state_pattern: 'session.json',
    });

    const result = await executeWorker(worker, 'unused', { timeout: 30, idleTimeout: 2 });

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('LLM evaluator decided to stop'), `Shortcut must abstain on stale state, got: ${result.error}`);
  });
});

describe('lean evaluator env shed behavioral', () => {
  const SHED_KEYS = ['PLAYWRIGHT_MCP_CDP_ENDPOINT', 'PA_BROWSER_CDP_PORT', 'VOICE_INBOX_PORT'] as const;

  it('isEvaluator run sheds the three overlay keys; plain run inherits them', async () => {
    const saved = new Map<string, string | undefined>();
    for (const k of SHED_KEYS) {
      saved.set(k, process.env[k]);
      process.env[k] = 'probe';
    }
    try {
      const echoScript = await writeScript('echo-env.js', `
        const keys = ${JSON.stringify(SHED_KEYS)};
        for (const k of keys) {
          process.stdout.write(k + '=' + (process.env[k] ?? 'ABSENT') + '\\n');
        }
      `);

      const worker = makeWorker({ name: 'echo-worker', command: 'node', args: [echoScript] });

      const evalResult = await executeWorker(worker, 'unused', { timeout: 10, isEvaluator: true });
      assert.equal(evalResult.success, true, `evaluator run should succeed, got: ${evalResult.error}`);
      for (const k of SHED_KEYS) {
        assert.ok(evalResult.output.includes(`${k}=ABSENT`), `evaluator run must shed ${k}, got: ${evalResult.output}`);
      }

      const plainResult = await executeWorker(worker, 'unused', { timeout: 10 });
      assert.equal(plainResult.success, true, `plain run should succeed, got: ${plainResult.error}`);
      for (const k of SHED_KEYS) {
        assert.ok(plainResult.output.includes(`${k}=probe`), `plain run must inherit ${k}, got: ${plainResult.output}`);
      }
    } finally {
      for (const k of SHED_KEYS) {
        const prev = saved.get(k);
        if (prev === undefined) delete process.env[k];
        else process.env[k] = prev;
      }
    }
  });
});
