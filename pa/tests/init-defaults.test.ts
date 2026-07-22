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

// Compiled to pa/dist/tests/init-defaults.test.js — __dirname is that file's
// dir; 3 levels up (dist/tests -> dist -> pa -> repo root) reaches examples/
// (same convention as setup-topics.ts's __dirname resolution).
const EXAMPLE_CONFIG_PATH = join(__dirname, '..', '..', '..', 'examples', 'config.yaml.example');

/**
 * Structural invariants every scaffolded worker block must satisfy.
 *
 * Why this exists (2026-07-22): the scaffolded `agy` worker shipped for an
 * unknown length of time declaring state_pattern "*.pb" with a comment claiming
 * protobuf transcripts, while agy actually writes SQLite (*.db, WAL mode) — so a
 * fresh `pa init` configured a glob matching zero files. Nothing asserted the
 * scaffold's CONTENTS, only that it parsed. These checks encode what a worker
 * block can and cannot say about itself, so a block that declares a transport or
 * a flag its CLI does not have fails here rather than in production.
 */
function assertWorkerSelfConsistent(worker: any, source: string): void {
  const where = `${source}: worker '${worker.name}'`;
  const args: string[] = worker.args ?? [];
  const argsText = args.join(' ');

  // input_mode / output_format must be values the loader actually understands
  // (WorkerConfig in pa/src/types.ts).
  const inputMode: string = worker.input_mode ?? 'arg';
  assert.ok(
    ['arg', 'stdin-json', 'stdin-text'].includes(inputMode),
    `${where} declares unknown input_mode '${inputMode}'`
  );
  if (worker.output_format !== undefined) {
    assert.ok(
      ['stream-json', 'plain-text'].includes(worker.output_format),
      `${where} declares unknown output_format '${worker.output_format}'`
    );
  }

  // Prompt transport: arg mode substitutes {prompt}/{prompt_file} (worker-exec.ts),
  // stdin modes send the prompt over stdin and must NOT carry the placeholder.
  const hasPlaceholder = args.some((a) => a.includes('{prompt}') || a.includes('{prompt_file}'));
  if (inputMode === 'arg') {
    assert.ok(
      hasPlaceholder,
      `${where} uses input_mode 'arg' but its args contain no {prompt}/{prompt_file} placeholder — the prompt would never reach the CLI`
    );
  } else {
    assert.ok(
      !hasPlaceholder,
      `${where} uses input_mode '${inputMode}' (prompt goes over stdin) but its args still carry a {prompt} placeholder, which is never substituted`
    );
  }

  // A plain-text worker must not claim stream-json anywhere: no JSON-output
  // flags in args, and no stdin-json input mode. This is the check that would
  // have caught a worker declaring flags its CLI does not have.
  if (worker.output_format === 'plain-text') {
    assert.ok(
      !argsText.includes('stream-json'),
      `${where} declares output_format 'plain-text' but passes stream-json in its args: ${JSON.stringify(args)}`
    );
    assert.ok(
      !args.includes('--output-format') && !args.includes('--json'),
      `${where} declares output_format 'plain-text' but requests structured output via ${JSON.stringify(args)}`
    );
    assert.notEqual(
      inputMode,
      'stdin-json',
      `${where} declares output_format 'plain-text' but input_mode 'stdin-json' — a CLI without stream-json output does not accept a stream-json stdin stream either`
    );
  }

  // Conversely: claiming stream-json output means the args must actually ask the
  // CLI for it, otherwise pa parses NDJSON that will never arrive (and silently
  // loses the session id it only reads off stream-json events).
  if (worker.output_format === 'stream-json') {
    assert.ok(
      argsText.includes('stream-json') || args.includes('--json'),
      `${where} declares output_format 'stream-json' but its args never request JSON output: ${JSON.stringify(args)}`
    );
  }

  // stdin-json is the strictest transport: it implies both directions are JSON.
  if (inputMode === 'stdin-json') {
    assert.equal(
      worker.output_format,
      'stream-json',
      `${where} uses input_mode 'stdin-json' but does not declare output_format 'stream-json'`
    );
    assert.ok(
      args.includes('--input-format'),
      `${where} uses input_mode 'stdin-json' but never passes --input-format: ${JSON.stringify(args)}`
    );
  }

  // state_dir / state_pattern travel together, and the pattern must be one that
  // findLatestStateFile (state-monitor.ts) can actually match: it reduces the
  // pattern with pattern.replace('*', '') and does a suffix test, so anything
  // other than a bare filename or a leading-'*' glob silently matches nothing
  // (e.g. 'session-*.jsonl' becomes 'session-.jsonl').
  if (worker.state_dir !== undefined) {
    assert.ok(
      typeof worker.state_pattern === 'string' && worker.state_pattern.length > 0,
      `${where} declares state_dir but no state_pattern — stuck-detection would scan nothing`
    );
  }
  if (worker.state_pattern !== undefined) {
    const pattern: string = worker.state_pattern;
    assert.ok(
      typeof worker.state_dir === 'string' && worker.state_dir.length > 0,
      `${where} declares state_pattern '${pattern}' but no state_dir`
    );
    const starCount = (pattern.match(/\*/g) ?? []).length;
    assert.ok(starCount <= 1, `${where} state_pattern '${pattern}' has multiple '*' — unsupported by findLatestStateFile`);
    assert.ok(
      starCount === 0 || pattern.startsWith('*'),
      `${where} state_pattern '${pattern}' places '*' mid-pattern; findLatestStateFile strips the '*' and suffix-matches, so this matches nothing`
    );
    assert.ok(
      pattern.includes('.'),
      `${where} state_pattern '${pattern}' has no file extension to suffix-match on`
    );
    assert.ok(
      !pattern.includes('/') && !pattern.includes('\\'),
      `${where} state_pattern '${pattern}' contains a path separator; it is matched against bare filenames`
    );
  }
}

describe('initCommand default config — worker block self-consistency', () => {
  it('every scaffolded worker declares a coherent transport, flag set, and state pattern', async () => {
    await initCommand();
    const config = parseYaml(await readFile(configPath(), 'utf8'));
    assert.ok(Array.isArray(config.workers) && config.workers.length > 0, 'default config should scaffold workers');
    for (const worker of config.workers) {
      assertWorkerSelfConsistent(worker, 'init.ts DEFAULT_CONFIG');
    }
  });

  it('examples/config.yaml.example workers are self-consistent too', async () => {
    const exampleConfig = parseYaml(await readFile(EXAMPLE_CONFIG_PATH, 'utf8'));
    assert.ok(Array.isArray(exampleConfig.workers) && exampleConfig.workers.length > 0, 'example should document workers');
    for (const worker of exampleConfig.workers) {
      assertWorkerSelfConsistent(worker, 'examples/config.yaml.example');
    }
  });

  it('worker priorities are unique so failover order is deterministic', async () => {
    await initCommand();
    const config = parseYaml(await readFile(configPath(), 'utf8'));
    const priorities = config.workers.map((w: any) => w.priority);
    assert.equal(
      new Set(priorities).size,
      priorities.length,
      `duplicate worker priorities in init.ts DEFAULT_CONFIG: ${JSON.stringify(
        config.workers.map((w: any) => [w.name, w.priority])
      )}`
    );
  });

  // Pinned against a live inspection of the machine's state dirs on 2026-07-22:
  // ~/.gemini/antigravity-cli/conversations held 38 *.db SQLite files (plus
  // -shm/-wal siblings) and ZERO *.pb; the gemini chats dir held 69 *.jsonl and
  // nothing else. Changing either value should be a deliberate act backed by a
  // fresh inspection, not a silent edit.
  it('agy and gemini state patterns match the formats those CLIs actually write', async () => {
    await initCommand();
    const config = parseYaml(await readFile(configPath(), 'utf8'));
    const agy = config.workers.find((w: any) => w.name === 'agy');
    assert.ok(agy, 'agy worker should exist in default config');
    assert.equal(agy.state_pattern, '*.db', 'agy writes SQLite conversation DBs, not protobuf (*.pb matches nothing)');
    assert.equal(agy.output_format, 'plain-text', 'agy has no --output-format flag');
    assert.equal(agy.input_mode, 'arg', 'agy takes its prompt via -p, not stdin');

    const gemini = config.workers.find((w: any) => w.name === 'gemini');
    assert.ok(gemini, 'gemini worker should exist in default config');
    assert.equal(gemini.state_pattern, '*.jsonl', 'gemini-cli writes session-*.jsonl chat files');
  });
});

describe('initCommand vs examples/config.yaml.example — drift guard', () => {
  it("every init worker's rate_limit_patterns is a subset of the example's same-named worker", async () => {
    await initCommand();
    const initConfig = parseYaml(await readFile(configPath(), 'utf8'));

    const exampleConfig = parseYaml(await readFile(EXAMPLE_CONFIG_PATH, 'utf8'));
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

  it('the two scaffolds agree on args, transport, priority, and state files per worker', async () => {
    await initCommand();
    const initConfig = parseYaml(await readFile(configPath(), 'utf8'));
    const exampleConfig = parseYaml(await readFile(EXAMPLE_CONFIG_PATH, 'utf8'));
    const exampleByName = new Map<string, any>(exampleConfig.workers.map((w: any) => [w.name, w]));

    // Both scaffolds were wrong about agy in the SAME way, so a same-value
    // comparison alone cannot catch a bad fact — that is what the pinned-fact
    // test above is for. This one stops a HALF-fix: correcting one scaffold and
    // leaving the other stale.
    for (const initWorker of initConfig.workers) {
      const exampleWorker = exampleByName.get(initWorker.name);
      assert.ok(exampleWorker, `examples/config.yaml.example is missing a '${initWorker.name}' worker that init.ts scaffolds`);
      for (const field of ['args', 'input_mode', 'output_format', 'priority', 'state_dir', 'state_pattern']) {
        assert.deepEqual(
          initWorker[field],
          exampleWorker[field],
          `${initWorker.name}.${field} differs between init.ts and examples/config.yaml.example — ` +
            `init=${JSON.stringify(initWorker[field])} example=${JSON.stringify(exampleWorker[field])}`
        );
      }
    }
  });
});
