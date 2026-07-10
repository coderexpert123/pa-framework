import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { stringify as stringifyYaml } from 'yaml';

let sharedTempDir: string;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'dashboard-test-'));
  process.env.PA_HOME = sharedTempDir;
  
  // 1. Mock config.yaml
  const config = {
    workers: [
      { name: 'claude', priority: 1, command: 'c', args: [], check: 'c', rate_limit_patterns: [] },
      { name: 'gemini', priority: 2, command: 'g', args: [], check: 'c', rate_limit_patterns: [] }
    ]
  };
  await writeFile(join(sharedTempDir, 'config.yaml'), stringifyYaml(config), 'utf8');
  
  // 2. Mock telegram-keepawake.json
  const ka = {
    active: true,
    since: '2026-04-22T10:00:00.000Z',
    pid: process.pid // use our own PID so it's "alive"
  };
  await writeFile(join(sharedTempDir, 'telegram-keepawake.json'), JSON.stringify(ka), 'utf8');
  
  // 3. Mock skills directory
  const skillsPath = join(sharedTempDir, 'skills');
  await mkdir(skillsPath);
  const briefPath = join(skillsPath, 'daily-mail-brief');
  await mkdir(briefPath);
  const briefContent = `---
cron: "45 7 * * *"
---
p`;
  await writeFile(join(briefPath, 'skill.md'), briefContent, 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rm(sharedTempDir, { recursive: true, force: true });
});

// Dynamic import after setting PA_HOME
const { getDashboardContent } = await import('../dashboard.js');

describe('Dashboard', () => {
  it('generates correct dashboard content', async () => {
    const content = await getDashboardContent();
    
    assert.ok(content.includes('SYSTEM DASHBOARD'));
    assert.ok(content.includes('Keep-awake**: on since 15:30 IST'));
    assert.ok(content.includes('Model Failover Order'));
    assert.ok(content.includes('1. claude (priority 1)'));
    assert.ok(content.includes('2. gemini (priority 2)'));
    assert.ok(content.includes('Skill Schedule'));
    assert.ok(content.includes('daily-mail-brief**: `45 7 * * *`'));
  });

  it('handles off keep-awake', async () => {
    // Modify keep-awake state on disk
    await writeFile(join(sharedTempDir, 'telegram-keepawake.json'), JSON.stringify({ active: false }), 'utf8');
    
    const content = await getDashboardContent();
    assert.ok(content.includes('Keep-awake**: off'));
  });
});
