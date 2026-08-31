import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';
import { initCommand } from '../src/commands/init.js';
import { configPath } from '../src/paths.js';
import { parseGitWorkflow } from '../src/config.js';
import { checkGitWorkflowAllowed } from '../src/lib/git-guard.js';
import { resolveRepoRoot } from '../src/lib/git-root.js';
import type { PaConfig } from '../src/types.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

// Resolves correctly whether running compiled in pa/dist/tests or source in pa/tests.
const repoRoot = join(__dirname.includes('dist') ? join(__dirname, '..', '..', '..') : join(__dirname, '..', '..'));

describe('parseGitWorkflow', () => {
  it('undefined → undefined', () => {
    assert.strictEqual(parseGitWorkflow(undefined), undefined);
  });

  it('null → undefined', () => {
    assert.strictEqual(parseGitWorkflow(null), undefined);
  });

  it('{enabled:false} → {enabled:false}', () => {
    assert.deepEqual(parseGitWorkflow({ enabled: false }), { enabled: false });
  });

  it('{enabled:true} → {enabled:true}', () => {
    assert.deepEqual(parseGitWorkflow({ enabled: true }), { enabled: true });
  });

  it('{enabled:"yes"} → undefined (warn-and-skip)', () => {
    assert.strictEqual(parseGitWorkflow({ enabled: 'yes' }), undefined);
  });

  it('[] → undefined (array is not a mapping)', () => {
    assert.strictEqual(parseGitWorkflow([]), undefined);
  });

  it('{} → undefined (no enabled field)', () => {
    assert.strictEqual(parseGitWorkflow({}), undefined);
  });
});

describe('checkGitWorkflowAllowed — config half', () => {
  it('git_workflow.enabled:false → allowed:false, reason mentions git_workflow', async () => {
    await createTempConfig(tempDir, [], { git_workflow: { enabled: false } });
    const result = await checkGitWorkflowAllowed({
      isInsideWorkTreeFn: async () => true,
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.match(/git_workflow/), `reason should mention git_workflow: ${result.reason}`);
  });

  it('config WITHOUT git_workflow block → allowed:true (legacy)', async () => {
    await createTempConfig(tempDir, []);
    const result = await checkGitWorkflowAllowed({
      isInsideWorkTreeFn: async () => true,
    });
    assert.strictEqual(result.allowed, true);
    assert.ok(result.reason.match(/legacy config|opted in/), `reason should mention legacy: ${result.reason}`);
  });

  it('loadConfigFn that throws → allowed:false, reason mentions config', async () => {
    const result = await checkGitWorkflowAllowed({
      loadConfigFn: async () => { throw new Error('simulated config error'); },
      isInsideWorkTreeFn: async () => true,
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.match(/config.yaml unreadable/), `reason should mention config: ${result.reason}`);
  });
});

describe('checkGitWorkflowAllowed — work-tree half', () => {
  it('isInsideWorkTreeFn returns false → allowed:false, reason mentions work tree', async () => {
    await createTempConfig(tempDir, []);
    const result = await checkGitWorkflowAllowed({
      isInsideWorkTreeFn: async () => false,
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.match(/work tree/i), `reason should mention work tree: ${result.reason}`);
  });

  it('isInsideWorkTreeFn that throws → allowed:false (catch path)', async () => {
    await createTempConfig(tempDir, []);
    const result = await checkGitWorkflowAllowed({
      isInsideWorkTreeFn: async () => { throw new Error('git command failed'); },
    });
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason.match(/work tree/i), `reason should mention work tree: ${result.reason}`);
  });
});

describe('checkGitWorkflowAllowed — allowed path', () => {
  it('config without block + inside work tree → allowed:true', async () => {
    await createTempConfig(tempDir, []);
    const result = await checkGitWorkflowAllowed({
      isInsideWorkTreeFn: async () => true,
    });
    assert.strictEqual(result.allowed, true);
    assert.ok(result.reason.match(/opted in.*work tree/i), `reason should mention both conditions: ${result.reason}`);
  });
});

describe('checkGitWorkflowAllowed — real git integration', () => {
  it('actual repo checkout + legacy config → allowed:true', async (t) => {
    let repoRootPath: string;
    try {
      repoRootPath = await resolveRepoRoot(join(__dirname, '..'));
    } catch (err: any) {
      t.skip('no git checkout: ' + err.message);
      return;
    }

    await createTempConfig(tempDir, []);
    const loadConfigFn = async (): Promise<PaConfig> => {
      const configContent = await readFile(configPath(), 'utf8');
      return parseYaml(configContent);
    };

    const result = await checkGitWorkflowAllowed({
      cwd: repoRootPath,
      loadConfigFn,
      isInsideWorkTreeFn: async () => true,
    });
    assert.strictEqual(result.allowed, true);
  });
});

describe('Scaffold drift — init and config files', () => {
  it('initCommand scaffolds git_workflow.enabled:false', async () => {
    await initCommand();
    const configContent = await readFile(configPath(), 'utf8');
    const config = parseYaml(configContent);
    assert.deepEqual(config.git_workflow, { enabled: false }, 'init should scaffold git_workflow with enabled:false');
  });

  it('config.example.yaml contains git_workflow with enabled:false', () => {
    const configExamplePath = join(repoRoot, 'config.example.yaml');
    if (!existsSync(configExamplePath)) {
      return; // Skip if file doesn't exist (may not exist in all environments)
    }
    const content = readFileSync(configExamplePath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(content.includes('git_workflow:'), 'config.example.yaml should mention git_workflow');
    assert.ok(content.includes('enabled: false'), 'config.example.yaml should have enabled: false');
    const config = parseYaml(content);
    assert.strictEqual(config.git_workflow?.enabled, false, 'config.example.yaml git_workflow.enabled should be false');
  });

  it('examples/config.yaml.example contains git_workflow with enabled:false', () => {
    const exampleConfigPath = join(repoRoot, 'examples', 'config.yaml.example');
    if (!existsSync(exampleConfigPath)) {
      return; // Skip if file doesn't exist (may not exist in all environments)
    }
    // Normalize CRLF: on Windows checkouts the file carries \r line endings and a
    // raw slice parses `enabled: false\r` as the STRING 'false\r' (PR #33 CI, 2026-08-31).
    const content = readFileSync(exampleConfigPath, 'utf8').replace(/\r\n/g, '\n');
    assert.ok(content.includes('git_workflow:'), 'examples/config.yaml.example should mention git_workflow');
    assert.ok(content.includes('enabled: false'), 'examples/config.yaml.example should have enabled: false');
    // Parse only from git_workflow: through next blank line (to handle commented demo blocks)
    const lines = content.split('\n');
    const gitWorkflowLineIndex = lines.findIndex((l) => l.trim().startsWith('git_workflow:'));
    assert.ok(gitWorkflowLineIndex >= 0, 'should find git_workflow: line');
    // Find the next blank line (empty line) after git_workflow:
    let blankLineIndex = gitWorkflowLineIndex + 1;
    while (blankLineIndex < lines.length && lines[blankLineIndex].trim() !== '') {
      blankLineIndex++;
    }
    const slice = lines.slice(gitWorkflowLineIndex, blankLineIndex).join('\n');
    const sliceConfig = parseYaml(slice);
    assert.strictEqual(sliceConfig.git_workflow?.enabled, false, 'examples/config.yaml.example git_workflow.enabled should be false');
  });
});

describe('Skill-text presence', () => {
  it('update-brain/skill.md contains pa git-guard and file-only', async () => {
    const skillPath = join(repoRoot, 'examples', 'skills', 'update-brain', 'skill.md');
    const content = await readFile(skillPath, 'utf8');
    assert.ok(content.includes('node "$root/pa/dist/bin/pa.js" git-guard'), 'update-brain should invoke pa git-guard');
    assert.ok(content.includes('file-only'), 'update-brain should mention file-only mode');
  });

  it('self-improver/skill.md contains pa git-guard', async () => {
    const skillPath = join(repoRoot, 'examples', 'skills', 'self-improver', 'skill.md');
    const content = await readFile(skillPath, 'utf8');
    assert.ok(content.includes('pa git-guard'), 'self-improver should mention pa git-guard');
  });
});
