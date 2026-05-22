import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, createTempConfig, cleanup } from './helpers.js';
import { runCommand } from '../src/commands/run.js';
import { writeFile, mkdir, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

let tempDir: string;
let scriptDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
  scriptDir = join(tmpdir(), `pa-test-run-scripts-${Date.now()}`);
  await mkdir(scriptDir, { recursive: true });
});

afterEach(async () => {
  await cleanup(tempDir);
  const { rm } = await import('fs/promises');
  try { await rm(scriptDir, { recursive: true, force: true }); } catch {}
});

async function writeScript(name: string, code: string): Promise<string> {
  const path = join(scriptDir, name);
  await writeFile(path, code, 'utf8');
  return path;
}

describe('runCommand', () => {
  it('injects triggers from other skills when inject_triggers is true', async () => {
    await createTempSkill(tempDir, 'other-skill', [
      '---',
      'trigger_description: "Trigger when bill mentioned"',
      '---',
      'other prompt',
    ].join('\n'));

    // Script that reads the prompt file if @path is provided
    const echoScript = await writeScript('echo.js', `
      const fs = require('fs');
      let arg = process.argv[2];
      if (arg.startsWith('@')) {
        process.stdout.write(fs.readFileSync(arg.slice(1), 'utf8'));
      } else {
        process.stdout.write(arg);
      }
    `);
    
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [echoScript, '{prompt}'], check: 'echo ok', priority: 1 },
    ]);

    await createTempSkill(tempDir, 'main-skill', [
      '---',
      'inject_triggers: true',
      '---',
      'main prompt',
    ].join('\n'));

    await runCommand('main-skill');
    
    const logDir = join(tempDir, 'logs', 'main-skill');
    const files = await readdir(logDir);
    const logFile = files.find(f => f.endsWith('.log'));
    
    assert.ok(logFile, 'Log file should exist');
    const output = await readFile(join(logDir, logFile), 'utf8');
    assert.ok(output.includes('Trigger System: Available Skills'), 'Should include trigger system header');
    assert.ok(output.includes('[other-skill] Trigger when bill mentioned'), 'Should include other skill trigger');
  });

  it('automatically executes triggered skills without recursion', async () => {
    // 1. Create a skill that will be triggered
    await createTempSkill(tempDir, 'triggered-skill', [
      '---',
      '---',
      'triggered prompt',
    ].join('\n'));

    // 2. Create a script that ONLY triggers if the prompt contains "main prompt"
    const triggerOutputScript = await writeScript('trigger.js', `
      const fs = require('fs');
      let arg = process.argv[2];
      let prompt = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;
      
      if (prompt.includes('main prompt')) {
        process.stdout.write("Some output\\n[pa run triggered-skill]\\nMore output");
      } else {
        process.stdout.write("TRIGGERED_SUCCESS");
      }
    `);
    
    await createTempConfig(tempDir, [
      { 
        name: 'w1', 
        command: 'node', 
        args: [triggerOutputScript, '{prompt}'],
        check: 'echo ok', 
        priority: 1 
      }
    ]);

    await createTempSkill(tempDir, 'main-skill', [
      '---',
      '---',
      'main prompt',
    ].join('\n'));

    // Execute
    await runCommand('main-skill');

    const mainLogDir = join(tempDir, 'logs', 'main-skill');
    const mainFiles = await readdir(mainLogDir);
    assert.ok(mainFiles.some(f => f.endsWith('.log')), 'Main skill log should exist');

    const triggeredLogDir = join(tempDir, 'logs', 'triggered-skill');
    const triggeredFiles = await readdir(triggeredLogDir);
    const triggeredLog = triggeredFiles.find(f => f.endsWith('.log'));
    assert.ok(triggeredLog, 'Triggered skill log should exist');
    
    const triggeredContent = await readFile(join(triggeredLogDir, triggeredLog), 'utf8');
    assert.equal(triggeredContent, 'TRIGGERED_SUCCESS', 'Triggered skill should have run correctly');
  });

  it('passes extra arguments through to the worker', async () => {
    // Script that echoes its arguments
    const argEchoScript = await writeScript('arg-echo.js', `
      process.stdout.write(process.argv.slice(2).join(' '));
    `);
    
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [argEchoScript], check: 'echo ok', priority: 1 },
    ]);

    await createTempSkill(tempDir, 'arg-skill', 'prompt');

    await runCommand('arg-skill', ['--flag1', 'val1']);

    const logDir = join(tempDir, 'logs', 'arg-skill');
    const files = await readdir(logDir);
    const logFile = files.find(f => f.endsWith('.log'));
    const output = await readFile(join(logDir, logFile!), 'utf8');
    
    assert.equal(output, '--flag1 val1');
  });

  it('supports triggers with their own extra arguments', async () => {
    // 1. Skill B expects an argument
    await createTempSkill(tempDir, 'skill-b', 'prompt b');

    // 2. Skill A triggers Skill B with an argument
    const triggerWithArgsScript = await writeScript('trigger-args.js', `
      const fs = require('fs');
      let arg = process.argv[2];
      // node trigger-args.js <script-path> ...
      // Wait, in my config I use {prompt} which becomes @path
      let prompt = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;
      
      if (prompt.includes('trigger me')) {
        process.stdout.write("triggering\\n[pa run skill-b --flag-for-b]");
      } else {
        // This runs for skill-b
        process.stdout.write("B_RECEIVED: " + process.argv.slice(2).join(' '));
      }
    `);
    
    await createTempConfig(tempDir, [
      { 
        name: 'w1', 
        command: 'node', 
        args: [triggerWithArgsScript, '{prompt}'],
        check: 'echo ok', 
        priority: 1 
      }
    ]);

    await createTempSkill(tempDir, 'skill-a', 'trigger me');

    // Execute
    await runCommand('skill-a');

    const bLogDir = join(tempDir, 'logs', 'skill-b');
    const bFiles = await readdir(bLogDir);
    const bLog = bFiles.find(f => f.endsWith('.log'));
    assert.ok(bLog, 'Skill B log should exist');
    
    const bContent = await readFile(join(bLogDir, bLog), 'utf8');
    // Result should contain the prompt file path AND the extra flag
    assert.ok(bContent.includes('B_RECEIVED:'), 'Should have received data');
    assert.ok(bContent.includes('--flag-for-b'), 'Should have received the flag');
  });
});
