import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, createTempConfig, cleanup } from './helpers.js';
import { join } from 'path';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { tmpdir } from 'os';

let tempDir: string;
let scriptDir: string;

before(async () => {
  tempDir = await createTempPaHome();
  scriptDir = join(tmpdir(), `pa-test-topic-scripts-${Date.now()}`);
  await mkdir(scriptDir, { recursive: true });
});

after(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
});

async function writeScript(name: string, code: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

describe('Topic-Based Partitioning and Concurrency', () => {
  it('filters skills by topic in catchupCommand', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const { writeLog } = await import('../src/logger.js');

    await createTempConfig(tempDir, [{ name: 'test', command: 'node', args: ['-v'], check: 'node -v', priority: 1 }]);

    const echoScript = await writeScript('echo.js', 'console.log("ok")');

    // Create skills with different topics
    await createTempSkill(tempDir, 'skill-default', [
      '---',
      'cron: "* * * * *"',
      'topic: default',
      `cmd: "node ${echoScript.replace(/\\/g, '/')}"`,
      '---',
      'Prompt',
    ].join('\n'));

    await createTempSkill(tempDir, 'skill-reminders', [
      '---',
      'cron: "* * * * *"',
      'topic: reminders',
      `cmd: "node ${echoScript.replace(/\\/g, '/')}"`,
      '---',
      'Prompt',
    ].join('\n'));

    // Set last run to 2 hours ago so they are overdue
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeLog('skill-default', 'out', { worker: 'test', status: 'success', exitCode: 0, duration: 10, timestamp: twoHoursAgo });
    await writeLog('skill-reminders', 'out', { worker: 'test', status: 'success', exitCode: 0, duration: 10, timestamp: twoHoursAgo });

    // Run catchup for reminders topic
    await catchupCommand({ topic: 'reminders' });
    
    // Check logs to see what ran
    const reminderLogs = (await readdir(join(tempDir, 'logs', 'skill-reminders')).catch(() => [])).filter(f => f.endsWith('.log'));
    const defaultLogs = (await readdir(join(tempDir, 'logs', 'skill-default')).catch(() => [])).filter(f => f.endsWith('.log'));
    
    assert.equal(reminderLogs.length, 2, 'skill-reminders should have run once (plus initial log)');
    assert.equal(defaultLogs.length, 1, 'skill-default should NOT have run');

    // Run catchup for default topic
    await catchupCommand({ topic: 'default' });
    const defaultLogsAfter = (await readdir(join(tempDir, 'logs', 'skill-default')).catch(() => [])).filter(f => f.endsWith('.log'));
    assert.equal(defaultLogsAfter.length, 2, 'skill-default should have run now');
  });

  it('respects concurrency_limit across multiple topics', async () => {
    const { catchupCommand } = await import('../src/commands/catchup.js');
    const { blackboard } = await import('../src/blackboard.js');
    const { writeLog } = await import('../src/logger.js');

    const sleepScript = await writeScript('sleep.js', 'setTimeout(() => console.log("done"), 5000)');

    await createTempConfig(tempDir, [{ name: 'test', command: 'node', args: ['-v'], check: 'node -v', priority: 1 }], {
      concurrency_limit: 1
    });

    await createTempSkill(tempDir, 'skill-concurrency', [
      '---',
      'cron: "* * * * *"',
      'topic: topic-concurrency',
      `cmd: "node ${sleepScript.replace(/\\/g, '/')}"`,
      '---',
      'Prompt',
    ].join('\n'));

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeLog('skill-concurrency', 'out', { worker: 'test', status: 'success', exitCode: 0, duration: 10, timestamp: twoHoursAgo });

    // Acquire a "skill-" lock manually to simulate another skill running
    const foreignPid = process.ppid;
    await blackboard.acquireLock('skill-other', 'test-agent', foreignPid, 1000);

    const startTime = Date.now();
    
    // Start catchup in background (it should wait)
    const catchupPromise = catchupCommand({ topic: 'topic-concurrency' });
    
    // Wait a bit and verify it hasn't finished (it's waiting for the lock)
    await new Promise(r => setTimeout(r, 2000));
    
    const logsDuringWait = (await readdir(join(tempDir, 'logs', 'skill-concurrency')).catch(() => [])).filter(f => f.endsWith('.log'));
    assert.equal(logsDuringWait.length, 1, 'Skill should not have started yet');

    // Release the lock
    await blackboard.releaseLock('skill-other', 'test-agent');

    // Now it should proceed
    await catchupPromise;
    const duration = Date.now() - startTime;
    assert.ok(duration >= 2000, 'Catchup should have waited at least 2 seconds');
    
    const logsAfter = (await readdir(join(tempDir, 'logs', 'skill-concurrency')).catch(() => [])).filter(f => f.endsWith('.log'));
    assert.equal(logsAfter.length, 2, 'Skill should have run after lock release');
  });

  it('correctly maps priority: high to reminders topic', async () => {
    const { loadSkill } = await import('../src/skills.js');
    
    await createTempSkill(tempDir, 'high-pri', [
      '---',
      'priority: high',
      '---',
      'Prompt',
    ].join('\n'));

    const skill = await loadSkill('high-pri');
    assert.equal(skill.frontmatter.topic, 'reminders');
  });
});
