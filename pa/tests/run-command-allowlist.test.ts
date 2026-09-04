import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, createTempConfig, cleanup } from './helpers.js';
import { runCommand } from '../src/commands/run.js';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'fs/promises';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// See run.test.ts for why this must be set before any notifyUser call fires
// in a bare `node --test` run (not needed under real `npm test`, which sets
// it via --require, but harmless and required for direct invocation).
process.env.PA_NOTIFY_DISABLED = '1';

/**
 * AI-187 (2026-09-03): `pa run commit -- <paths>` committed ALL 13 dirty paths
 * against a 9-path operator allowlist (AI-185 wave, 2026-09-02; runs
 * 20260902-043752-21b847 and 20260902-051044-d65671). The `--` args never
 * reached the skill prompt — they rode the worker CLI inert — so the commit
 * skill's binding-allowlist rule ("when NO operator-args block names files,
 * the survey-everything behavior applies") fired instead and swept everything.
 *
 * These tests pin the runner-side contract through the REAL runner path:
 * real runCommand → real prompt construction → real executeWorker spawn →
 * real `git add`/`git commit` in a fixture repo. The "worker" is a
 * deterministic stub that plays the skill's binding rule by reading the
 * ACTUAL delivered prompt — it consumes the real producer artifact, not a
 * hand-built fixture of it. A stub that sees no operator-args block falls
 * back to staging every dirty path (the survey-everything behavior), which
 * is exactly how the pre-fix failure mode manifests here: Test 1 was RED
 * before the AI-187 bridge landed and is GREEN after.
 */

let tempDir: string;
let scriptDir: string;
let fixtureRepo: string;

const ALLOW = [
  'allow-1.txt', 'allow-2.txt', 'allow-3.txt', 'allow-4.txt', 'allow-5.txt',
  'allow-6.txt', 'allow-7.txt', 'allow-8.txt', 'nested/allow-9.txt',
];
const FOREIGN = ['foreign-1.txt', 'foreign-2.txt', 'foreign-3.txt', 'foreign-4.txt'];

beforeEach(async () => {
  tempDir = await createTempPaHome();
  scriptDir = join(tmpdir(), `pa-ai187-scripts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(scriptDir, { recursive: true });
  fixtureRepo = await mkdtemp(join(tmpdir(), 'pa-ai187-repo-'));
  execSync('git init -q', { cwd: fixtureRepo });
  execSync('git config user.name "test" && git config user.email "test@test"', { cwd: fixtureRepo });
  execSync('git commit -q --allow-empty -m init', { cwd: fixtureRepo });
  await mkdir(join(fixtureRepo, 'nested'), { recursive: true });
  for (const f of [...ALLOW, ...FOREIGN]) {
    await writeFile(join(fixtureRepo, f), `content of ${f}\n`, 'utf8');
  }
});

afterEach(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
  try { await rm(fixtureRepo, { recursive: true, force: true }); } catch {}
});

function gitOut(args: string): string {
  return execSync(`git ${args}`, { cwd: fixtureRepo, encoding: 'utf8' });
}

/** The committed path set of the fixture repo's HEAD commit. */
function committedPaths(): string[] {
  return gitOut('show --name-only --format=').split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Paths still dirty (untracked or modified) after the run. */
function dirtyPaths(): string[] {
  return gitOut('status --porcelain')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\S+\s+/, ''));
}

/**
 * The "obedient worker": reads the ACTUAL prompt a real worker would receive,
 * extracts the operator-arguments block, and stages exactly the listed paths.
 * With no block it falls back to staging every dirty path (the skill's
 * survey-everything NO-ARGS behavior — named explicitly, never `git add -A`,
 * mirroring the live skill.md). This is the same judgment boundary a real
 * worker faces; making it deterministic is what lets the invariant be pinned.
 */
async function installObedientWorker(): Promise<void> {
  const stubPath = join(scriptDir, 'obedient-worker.js');
  await writeFile(stubPath, `
    const fs = require('fs');
    const { execSync } = require('child_process');
    const a = process.argv[2] || '';
    const prompt = a.startsWith('@') ? fs.readFileSync(a.slice(1), 'utf8') : a;
    const header = '## Operator arguments (this run)';
    const idx = prompt.lastIndexOf(header);
    let listed = null;
    if (idx >= 0) {
      let rest = prompt.slice(idx + header.length).replace(/\\r\\n/g, '\\n');
      rest = rest.slice(rest.indexOf('\\n') + 1);
      const stop = rest.indexOf('\\nTreat these as if');
      if (stop >= 0) rest = rest.slice(0, stop);
      listed = rest.split('\\n').map((s) => s.trim()).filter(Boolean);
    }
    let targets;
    if (listed) {
      // An obedient worker commits only listed paths that actually exist;
      // prose lines in a free-text operator-args block are not paths.
      targets = listed.filter((t) => fs.existsSync(t));
    } else {
      targets = execSync('git status --porcelain', { encoding: 'utf8' })
        .split('\\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.replace(/^\\S+\\s+/, ''));
    }
    if (!targets.length) { process.stdout.write('(nothing staged)'); process.exit(0); }
    for (const t of targets) execSync('git add ' + JSON.stringify(t), { stdio: 'ignore' });
    execSync('git commit -q -m "stub"', { stdio: 'ignore' });
    process.stdout.write(execSync('git show --name-only --format=', { encoding: 'utf8' }));
  `, 'utf8');

  await createTempConfig(tempDir, [
    { name: 'w1', command: 'node', args: [stubPath, '{prompt}'], check: 'echo ok', priority: 1 },
  ]);
  await createTempSkill(tempDir, 'scoped-commit', [
    '---',
    `cwd: ${fixtureRepo.replace(/\\/g, '/')}`,
    'timeout: 60',
    '---',
    'survey the tree and commit per the operator arguments block',
  ].join('\n'));
}

describe('AI-187: operator-args runs never stage an unlisted dirty path', () => {
  it('THE PIN — `-- <paths>` (the failing form) commits exactly the allowlist, nothing unlisted', async () => {
    await installObedientWorker();
    const result = await runCommand('scoped-commit', ALLOW);

    assert.equal(result.success, true, `run failed: ${result.error ?? '(no error)'}`);
    assert.deepEqual(
      committedPaths().sort(),
      [...ALLOW].sort(),
      'committed set must equal the 9-path allowlist exactly',
    );
    assert.deepEqual(
      dirtyPaths().sort(),
      [...FOREIGN].sort(),
      'every unlisted dirty path must be left uncommitted',
    );
  });

  it('`--prompt-args` (the documented form) still binds the same way', async () => {
    await installObedientWorker();
    const three = ['allow-1.txt', 'allow-2.txt', 'nested/allow-9.txt'];
    const result = await runCommand('scoped-commit', [], 0, undefined, `Commit ONLY these files this run:\n${three.join('\n')}`);

    assert.equal(result.success, true, `run failed: ${result.error ?? '(no error)'}`);
    assert.deepEqual(committedPaths().sort(), [...three].sort());
  });

  it('no args at all → survey-everything fallback is intact (all 13 dirty paths committed)', async () => {
    await installObedientWorker();
    const result = await runCommand('scoped-commit');

    assert.equal(result.success, true, `run failed: ${result.error ?? '(no error)'}`);
    assert.deepEqual(committedPaths().sort(), [...ALLOW, ...FOREIGN].sort());
  });

  it('cmd skills still take `--` args as shell-command arguments (bridge exempt)', async () => {
    const argEchoScript = join(scriptDir, 'cmd-echo.js');
    await writeFile(argEchoScript, `process.stdout.write('CMD:' + process.argv.slice(2).join(' '));`, 'utf8');
    await createTempSkill(tempDir, 'cmd-scoped', [
      '---',
      `cmd: node ${JSON.stringify(argEchoScript)}`,
      'timeout: 30',
      '---',
      'unused',
    ].join('\n'));

    const result = await runCommand('cmd-scoped', ['--flag', 'val']);

    assert.equal(result.success, true, `run failed: ${result.error ?? '(no error)'}`);
    assert.equal(result.output, 'CMD:--flag val');
  });

  it('the bridged block is well-formed: header, one path per line, trailing instruction', async () => {
    // A prompt-echo worker makes the delivered prompt itself observable.
    const echoPromptScript = join(scriptDir, 'echo-prompt.js');
    await writeFile(echoPromptScript, `
      const fs = require('fs');
      const a = process.argv[2] || '';
      process.stdout.write(a.startsWith('@') ? fs.readFileSync(a.slice(1), 'utf8') : a);
    `, 'utf8');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [echoPromptScript, '{prompt}'], check: 'echo ok', priority: 1 },
    ]);
    await createTempSkill(tempDir, 'scoped-commit', [
      '---',
      'timeout: 60',
      '---',
      'base prompt',
    ].join('\n'));

    const result = await runCommand('scoped-commit', ['a.txt', 'b.txt']);

    assert.equal(result.success, true, `run failed: ${result.error ?? '(no error)'}`);
    assert.ok(result.output.includes('## Operator arguments (this run)'), 'block header present');
    assert.ok(result.output.includes('a.txt\nb.txt\nTreat these as if the operator typed them alongside the skill trigger; they scope and constrain this run only.'), 'paths one per line + trailing instruction');
  });
});
