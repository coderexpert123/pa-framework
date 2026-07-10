import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { initCommand } from '../src/commands/init.js';
import { configPath } from '../src/paths.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('initCommand default config — worker rate_limit_patterns', () => {
  it('codex worker includes "hit your usage limit"', async () => {
    await initCommand();
    const config = parseYaml(await readFile(configPath(), 'utf8'));
    const codex = config.workers.find((w: any) => w.name === 'codex');
    assert.ok(codex, 'codex worker should exist in default config');
    assert.ok(
      codex.rate_limit_patterns.includes('hit your usage limit'),
      `Expected codex patterns to include 'hit your usage limit', got: ${JSON.stringify(codex.rate_limit_patterns)}`
    );
  });

  it('gemini worker includes "RESOURCE_EXHAUSTED"', async () => {
    await initCommand();
    const config = parseYaml(await readFile(configPath(), 'utf8'));
    const gemini = config.workers.find((w: any) => w.name === 'gemini');
    assert.ok(gemini, 'gemini worker should exist in default config');
    assert.ok(
      gemini.rate_limit_patterns.includes('RESOURCE_EXHAUSTED'),
      `Expected gemini patterns to include 'RESOURCE_EXHAUSTED', got: ${JSON.stringify(gemini.rate_limit_patterns)}`
    );
  });
});

describe('initCommand vs examples/config.yaml.example — drift guard', () => {
  it("every init worker's rate_limit_patterns is a subset of the example's same-named worker", async () => {
    await initCommand();
    const initConfig = parseYaml(await readFile(configPath(), 'utf8'));

    // Compiled to pa/dist/tests/init-defaults.test.js — __dirname is that
    // file's dir; 3 levels up (dist/tests -> dist -> pa -> repo root) reaches
    // examples/ (same convention as setup-topics.ts's __dirname resolution).
    const examplePath = join(__dirname, '..', '..', '..', 'examples', 'config.yaml.example');
    const exampleConfig = parseYaml(await readFile(examplePath, 'utf8'));
    const exampleByName = new Map<string, any>(exampleConfig.workers.map((w: any) => [w.name, w]));

    for (const initWorker of initConfig.workers) {
      const exampleWorker = exampleByName.get(initWorker.name);
      assert.ok(exampleWorker, `examples/config.yaml.example is missing a '${initWorker.name}' worker that init.ts scaffolds`);
      const initPatterns: string[] = initWorker.rate_limit_patterns ?? [];
      const examplePatterns: string[] = exampleWorker.rate_limit_patterns ?? [];
      for (const pattern of initPatterns) {
        assert.ok(
          examplePatterns.includes(pattern),
          `init.ts's ${initWorker.name} worker has rate_limit_pattern '${pattern}' that examples/config.yaml.example's ${initWorker.name} worker lacks — drift detected`
        );
      }
    }
  });
});
