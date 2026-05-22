import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';
import { loadConfig } from '../src/config.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('loadConfig', () => {
  it('loads valid config with 2 workers', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: ['hello'], check: 'echo ok', priority: 1 },
      { name: 'w2', command: 'echo', args: ['world'], check: 'echo ok', priority: 2 },
    ]);
    const config = await loadConfig();
    assert.equal(config.workers.length, 2);
    assert.equal(config.workers[0].name, 'w1');
    assert.equal(config.workers[1].name, 'w2');
  });

  it('sorts workers by priority', async () => {
    await createTempConfig(tempDir, [
      { name: 'low', command: 'echo', args: ['x'], check: 'echo ok', priority: 10 },
      { name: 'high', command: 'echo', args: ['x'], check: 'echo ok', priority: 1 },
    ]);
    const config = await loadConfig();
    assert.equal(config.workers[0].name, 'high');
    assert.equal(config.workers[1].name, 'low');
  });

  it('applies default values for optional fields', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: ['x'], check: 'echo ok' },
    ]);
    const config = await loadConfig();
    const w = config.workers[0];
    assert.equal(w.priority, 1); // defaults to index + 1
    assert.equal(w.input_mode, 'arg');
    assert.equal(w.check_timeout, 30);
    assert.deepEqual(w.rate_limit_patterns, []);
    assert.equal(w.output_format, undefined);
    assert.equal(w.state_dir, undefined);
  });

  it('rejects missing config file', async () => {
    // tempDir has no config.yaml
    await assert.rejects(loadConfig(), /Config not found/);
  });

  it('rejects empty YAML file', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    await writeFile(join(tempDir, 'config.yaml'), '', 'utf8');
    await assert.rejects(loadConfig(), /workers.*must be an array/);
  });

  it('rejects YAML with no workers key', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    await writeFile(join(tempDir, 'config.yaml'), 'foo: bar\n', 'utf8');
    await assert.rejects(loadConfig(), /workers.*must be an array/);
  });

  it('rejects worker missing required fields', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1' }, // missing command, args, check
    ]);
    await assert.rejects(loadConfig(), /Worker #1 missing required fields/);
  });

  it('coerces non-array args to array', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: 'single', check: 'echo ok' },
    ]);
    const config = await loadConfig();
    assert.deepEqual(config.workers[0].args, ['single']);
  });

  it('validates rate_limit_patterns is array — string becomes empty', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: ['x'], check: 'echo ok', rate_limit_patterns: 'not-an-array' },
    ]);
    const config = await loadConfig();
    assert.deepEqual(config.workers[0].rate_limit_patterns, []);
  });

  it('parses evaluator config when present', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: ['x'], check: 'echo ok' },
    ], { evaluator: { worker: 'gemini', timeout: 30 } });
    const config = await loadConfig();
    assert.deepEqual(config.evaluator, { worker: 'gemini', timeout: 30 });
  });

  it('evaluator is undefined when not in config', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: ['x'], check: 'echo ok' },
    ]);
    const config = await loadConfig();
    assert.equal(config.evaluator, undefined);
  });

  it('evaluator applies defaults for missing fields', async () => {
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'echo', args: ['x'], check: 'echo ok' },
    ], { evaluator: {} });
    const config = await loadConfig();
    assert.deepEqual(config.evaluator, { worker: 'claude', timeout: 60 });
  });
});
