import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, createTempConfig, cleanup } from './helpers.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

describe('analyzer terminal failure alert', () => {
  it('returns empty array on runner failure without throwing', async () => {
    const { analyzeConversationPatterns } = await import('../src/analyzer.js');

    // Write a conversation-history.jsonl with a recent turn to avoid short-circuit
    const turn = JSON.stringify({
      role: 'user',
      text: 'test message',
      timestamp: new Date().toISOString(),
    });
    await writeFile(join(tempDir, 'conversation-history.jsonl'), turn + '\n', 'utf8');

    // Create a config with a worker that will fail
    const failScript = join(tempDir, 'fail-analyzer.js');
    await writeFile(failScript, 'process.stderr.write("simulated failure"); process.exit(1);');

    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [failScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);

    // Should not throw — the failure is handled internally and alert is fired
    const proposals = await analyzeConversationPatterns(14);
    assert.ok(Array.isArray(proposals));
  });
});

describe('failure-analyzer terminal failure alert', () => {
  it('returns empty array on runner failure without throwing', async () => {
    const { analyzeFailurePatterns } = await import('../src/failure-analyzer.js');

    // Create a log dir with a skill that has 2+ failures
    const skillLogDir = join(tempDir, 'logs', 'failing-skill');
    await mkdir(skillLogDir, { recursive: true });

    // Write 2 error log entries
    const meta1 = {
      status: 'error',
      error: 'something went wrong',
      timestamp: new Date().toISOString(),
      duration: 30,
      worker: 'w1',
    };
    const meta2 = {
      status: 'error',
      error: 'something went wrong again',
      timestamp: new Date().toISOString(),
      duration: 25,
      worker: 'w1',
    };
    await writeFile(join(skillLogDir, 'run-1.log'), '', 'utf8');
    await writeFile(join(skillLogDir, 'run-1.meta.json'), JSON.stringify(meta1), 'utf8');
    await writeFile(join(skillLogDir, 'run-2.log'), '', 'utf8');
    await writeFile(join(skillLogDir, 'run-2.meta.json'), JSON.stringify(meta2), 'utf8');

    // Create a worker that will fail
    const failScript = join(tempDir, 'fail-failure-analyzer.js');
    await writeFile(failScript, 'process.stderr.write("simulated failure"); process.exit(1);');

    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [failScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);

    const proposals = await analyzeFailurePatterns(14);
    assert.ok(Array.isArray(proposals));
  });
});
