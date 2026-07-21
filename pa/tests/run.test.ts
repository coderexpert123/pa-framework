import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTempPaHome, createTempSkill, createTempConfig, createTempSecrets, cleanup } from './helpers.js';
import { runCommand, isSilentNoOp, describeSendFailure } from '../src/commands/run.js';
import { writeFile, mkdir, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Several tests below write a live-looking TELEGRAM_BOT_TOKEN into their temp
// secrets.env, and handleSkillResult's failure path calls notifyUser with an
// explicit `topic` override that bypasses notify.ts's empty-chat-id guard.
// `npm test` sets this flag globally via tests/test-env-setup.ts (--require),
// but a bare `node --test dist/tests/*.test.js` does NOT — without it those
// tests would fire REAL outbound Telegram sends. Set at module scope and NEVER
// restored: those notifyUser calls are fire-and-forget, so unsetting the flag in
// a test's finally() would race the in-flight promises straight onto the network.
process.env.PA_NOTIFY_DISABLED = '1';

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

// ---------------------------------------------------------------------------
// Silent no-op detection: a skill declaring telegram_output that exits 0 with
// empty stdout used to be recorded 'success' while delivering nothing (audit
// 2026-07-16..21: oracle wrote a 0-byte log after 436s, status success).
// ---------------------------------------------------------------------------

const TELEGRAM_FRONTMATTER = [
  'secrets:',
  '- TELEGRAM_BOT_TOKEN',
  'telegram_output:',
  "  chat_id: '-1001234567890'",
  '  thread_id: 29',
  '  token_secret: TELEGRAM_BOT_TOKEN',
].join('\n');

/** Read the single run's .meta for a skill out of the temp PA_HOME. */
async function readRunMeta(dir: string, skillName: string): Promise<any> {
  const logDir = join(dir, 'logs', skillName);
  const files = await readdir(logDir);
  const metaFile = files.find((f) => f.endsWith('.meta'));
  assert.ok(metaFile, `Meta file should exist for ${skillName}`);
  return JSON.parse(await readFile(join(logDir, metaFile!), 'utf8'));
}

async function readLatestPointer(dir: string, skillName: string): Promise<any> {
  return JSON.parse(await readFile(join(dir, 'logs', skillName, 'latest.json'), 'utf8'));
}

describe('isSilentNoOp', () => {
  const telegramOutput = { chat_id: '-1001234567890', thread_id: 29, token_secret: 'TELEGRAM_BOT_TOKEN' };

  it('is true for empty output when telegram_output is declared', () => {
    assert.equal(isSilentNoOp(true, '', telegramOutput), true);
  });

  it('treats whitespace-only output as empty', () => {
    assert.equal(isSilentNoOp(true, '   \n\t\r\n  ', telegramOutput), true);
    assert.equal(isSilentNoOp(true, undefined, telegramOutput), true);
  });

  it('SCOPE GUARD: is false for empty output when telegram_output is NOT declared', () => {
    // This is the `reminders` case — cron "* * * * *", 1440 runs/day, no output
    // by design. Flipping this assertion manufactures a daily 1440-failure storm.
    assert.equal(isSilentNoOp(true, '', undefined), false);
    assert.equal(isSilentNoOp(true, '   ', undefined), false);
  });

  it('is false when the run already failed (nothing to reclassify)', () => {
    assert.equal(isSilentNoOp(false, '', telegramOutput), false);
  });

  it('is false for any non-empty output, including the NO_OUTPUT sentinel', () => {
    assert.equal(isSilentNoOp(true, 'NO_OUTPUT', telegramOutput), false);
    assert.equal(isSilentNoOp(true, 'real report', telegramOutput), false);
  });
});

/** Records outbound Telegram sends without touching the network. */
function stubFetch(
  response: { ok: boolean; status?: number; text?: string } = { ok: true },
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    calls.push(String(input));
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 400),
      text: async () => response.text ?? '',
      json: async () => ({ ok: response.ok }),
    } as any;
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

/** Replaces global fetch with one that always throws — the network-error path. */
function stubFetchThrowing(message: string): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (input: any) => {
    calls.push(String(input));
    throw new Error(message);
  };
  return { calls, restore: () => { (globalThis as any).fetch = original; } };
}

describe('runCommand — silent no-op detection', () => {
  async function configureSilentWorker(): Promise<void> {
    const silentScript = await writeScript('silent.js', 'process.exit(0);');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [silentScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
  }

  it('records an empty-output run as error when the skill declares telegram_output', async () => {
    // secrets.env is deliberately EMPTY (same convention as run-silent-sites.test.ts):
    // this test's failure path calls notifyUser with an explicit topic override, which
    // bypasses notify.ts's empty-chat-id guard — with a live-looking token written here
    // a bare `node --test dist/tests/*.test.js` (no --require test-env-setup, so no
    // PA_NOTIFY_DISABLED) would fire a REAL outbound send.
    await createTempSecrets(tempDir, '');
    await configureSilentWorker();
    await createTempSkill(tempDir, 'silent-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const result = await runCommand('silent-tg-skill');

    // Asserted on the persisted verdict rather than on a fetch count: the two
    // notifyUser calls in handleSkillResult are fire-and-forget, so a
    // stub.calls.length assertion taken the instant runCommand resolves races
    // them and passes only because PA_NOTIFY_DISABLED happens to short-circuit
    // first. result/meta are written before runCommand returns — deterministic.
    assert.equal(result.success, false, 'empty output + telegram_output must be a failure');
    assert.ok((result.error ?? '').includes('silent no-op'), 'error should name the silent no-op');
    const meta = await readRunMeta(tempDir, 'silent-tg-skill');
    assert.equal(meta.status, 'error');
    assert.ok((meta.error ?? '').includes('silent no-op'), 'the meta must carry the reason');
  });

  it('feeds the silent no-op into consecutiveFailures (AI-098 backoff input)', async () => {
    await createTempSecrets(tempDir, '');
    await configureSilentWorker();
    await createTempSkill(tempDir, 'silent-backoff-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    await runCommand('silent-backoff-skill');

    const pointer = await readLatestPointer(tempDir, 'silent-backoff-skill');
    assert.equal(pointer.consecutiveFailures, 1, 'a silent no-op must count as a consecutive failure');
    assert.equal(pointer.latestSuccess, undefined, 'it must not be recorded as the latest success');
  });

  it('REGRESSION GUARD (reminders): empty output WITHOUT telegram_output stays success', async () => {
    // `reminders` runs on "* * * * *" and legitimately produces no output on
    // almost every run. If this test ever fails, the telegram_output scope guard
    // in isSilentNoOp has been widened and the scheduler is about to record
    // ~1440 bogus failures per day.
    await createTempSecrets(tempDir, '');
    await configureSilentWorker();
    await createTempSkill(tempDir, 'silent-plain-skill', ['---', '---', 'prompt'].join('\n'));

    const result = await runCommand('silent-plain-skill');

    assert.equal(result.success, true, 'a skill with no telegram_output may be silent');
    const meta = await readRunMeta(tempDir, 'silent-plain-skill');
    assert.equal(meta.status, 'success');
    const pointer = await readLatestPointer(tempDir, 'silent-plain-skill');
    assert.equal(pointer.consecutiveFailures, 0);
  });

  it('treats whitespace-only output as empty for a telegram_output skill', async () => {
    await createTempSecrets(tempDir, '');
    const wsScript = await writeScript('ws.js', 'process.stdout.write("  \\n\\t \\n ");');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [wsScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    await createTempSkill(tempDir, 'ws-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const result = await runCommand('ws-tg-skill');

    assert.equal(result.success, false);
    const meta = await readRunMeta(tempDir, 'ws-tg-skill');
    assert.equal(meta.status, 'error');
  });

  it('NO_OUTPUT sentinel stays a success and still suppresses the Telegram send', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=test-token\n');
    const sentinelScript = await writeScript('sentinel.js', 'process.stdout.write("NO_OUTPUT");');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [sentinelScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    await createTempSkill(tempDir, 'sentinel-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const stub = stubFetch();
    const result = await runCommand('sentinel-tg-skill').finally(() => stub.restore());

    assert.equal(result.success, true, 'the sentinel is the designed escape hatch — not a failure');
    const meta = await readRunMeta(tempDir, 'sentinel-tg-skill');
    assert.equal(meta.status, 'success');
    assert.equal(stub.calls.length, 0, 'the sentinel must suppress delivery');
  });

  it('leaves a normal telegram_output run untouched (success + delivered)', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=test-token\n');
    const reportScript = await writeScript('report.js', 'process.stdout.write("Daily briefing: all good");');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [reportScript], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
    await createTempSkill(tempDir, 'normal-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const stub = stubFetch();
    const result = await runCommand('normal-tg-skill').finally(() => {
      stub.restore();
    });

    assert.equal(result.success, true);
    assert.equal(result.output, 'Daily briefing: all good');
    const meta = await readRunMeta(tempDir, 'normal-tg-skill');
    assert.equal(meta.status, 'success');
    assert.equal(stub.calls.length, 1, 'a real report should be delivered exactly once');
    assert.ok(stub.calls[0].includes('/sendMessage'), 'delivery should hit sendMessage');
  });
});

// ---------------------------------------------------------------------------
// Rejected-delivery detection: a skill that produced real output but whose
// Telegram send was REJECTED used to be recorded 'success' — run.ts discarded
// sendToTelegram's SendResult entirely. Same "recorded success, delivered
// nothing" class as the silent no-op above, one branch away from it.
// ---------------------------------------------------------------------------

describe('describeSendFailure', () => {
  it('renders reason, status and detail for an HTTP rejection', () => {
    assert.equal(
      describeSendFailure({ ok: false, reason: 'http', status: 400, detail: 'Bad Request: chat not found' }),
      'http: status 400: Bad Request: chat not found',
    );
  });

  it('renders a bare reason when there is no status or detail', () => {
    assert.equal(describeSendFailure({ ok: false, reason: 'no-chat-id' }), 'no-chat-id');
  });

  it('renders reason + detail for a network failure', () => {
    assert.equal(
      describeSendFailure({ ok: false, reason: 'network', detail: 'socket hang up' }),
      'network: socket hang up',
    );
  });

  it('truncates an oversized detail so it stays log-safe', () => {
    const out = describeSendFailure({ ok: false, reason: 'http', status: 502, detail: 'x'.repeat(500) });
    assert.equal(out, `http: status 502: ${'x'.repeat(200)}`);
  });
});

describe('runCommand — rejected Telegram delivery', () => {
  /** A worker that emits a real report — the delivery, not the run, is what fails. */
  async function configureReportingWorker(name: string): Promise<void> {
    const script = await writeScript(name, 'process.stdout.write("Daily briefing: all good");');
    await createTempConfig(tempDir, [
      { name: 'w1', command: 'node', args: [script], check: 'echo ok', priority: 1, rate_limit_patterns: [] },
    ]);
  }

  it('records an HTTP-rejected delivery as a failed run', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=test-token\n');
    await configureReportingWorker('reject-http.js');
    await createTempSkill(tempDir, 'rejected-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const stub = stubFetch({ ok: false, status: 400, text: 'Bad Request: chat not found' });
    const result = await runCommand('rejected-tg-skill').finally(() => {
      stub.restore();
    });

    assert.equal(stub.calls.length, 1, 'the delivery should have been attempted exactly once');
    assert.equal(result.success, false, 'a rejected delivery must not be recorded as success');
    assert.ok((result.error ?? '').includes('Telegram delivery failed'), 'error should name the delivery failure');
    assert.ok((result.error ?? '').includes('status 400'), 'error should carry the Telegram status');

    const meta = await readRunMeta(tempDir, 'rejected-tg-skill');
    assert.equal(meta.status, 'error', 'the persisted meta must reflect the undelivered run');
    assert.ok((meta.error ?? '').includes('Telegram delivery failed'), 'the meta must carry the reason');
  });

  it('feeds a rejected delivery into consecutiveFailures (AI-098 backoff input)', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=test-token\n');
    await configureReportingWorker('reject-backoff.js');
    await createTempSkill(tempDir, 'rejected-backoff-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const stub = stubFetch({ ok: false, status: 403, text: 'Forbidden: bot was kicked' });
    await runCommand('rejected-backoff-skill').finally(() => {
      stub.restore();
    });

    const pointer = await readLatestPointer(tempDir, 'rejected-backoff-skill');
    assert.equal(pointer.consecutiveFailures, 1, 'an undelivered run must count as a consecutive failure');
    assert.equal(pointer.latestSuccess, undefined, 'it must not be recorded as the latest success');
  });

  it('records a network failure during delivery as a failed run', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=test-token\n');
    await configureReportingWorker('reject-network.js');
    await createTempSkill(tempDir, 'network-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const stub = stubFetchThrowing('socket hang up');
    const result = await runCommand('network-tg-skill').finally(() => {
      stub.restore();
    });

    assert.equal(result.success, false);
    assert.ok((result.error ?? '').includes('network'), 'error should name the network failure');
    const meta = await readRunMeta(tempDir, 'network-tg-skill');
    assert.equal(meta.status, 'error');
  });

  it('records an empty chat_id as a failed run without issuing the doomed HTTP call', async () => {
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=test-token\n');
    await configureReportingWorker('reject-nochat.js');
    await createTempSkill(tempDir, 'nochat-tg-skill', [
      '---',
      'secrets:',
      '- TELEGRAM_BOT_TOKEN',
      'telegram_output:',
      "  chat_id: ''",
      '  thread_id: 29',
      '  token_secret: TELEGRAM_BOT_TOKEN',
      '---',
      'prompt',
    ].join('\n'));

    const stub = stubFetch();
    const result = await runCommand('nochat-tg-skill').finally(() => {
      stub.restore();
    });

    assert.equal(stub.calls.length, 0, 'an empty chat_id is undeliverable by construction — no HTTP call');
    assert.equal(result.success, false);
    assert.ok((result.error ?? '').includes('no-chat-id'), 'error should name the empty chat_id');
    const meta = await readRunMeta(tempDir, 'nochat-tg-skill');
    assert.equal(meta.status, 'error');
  });

  it('records a missing token secret as a failed run (nothing can ever be delivered)', async () => {
    // Empty secrets.env — the skill declares telegram_output but TELEGRAM_BOT_TOKEN
    // is absent, so delivery is impossible. Previously a console.warn and a
    // 'success' record; on an unattended scheduled run that is indistinguishable
    // from silence.
    await createTempSecrets(tempDir, '');
    await configureReportingWorker('reject-notoken.js');
    await createTempSkill(tempDir, 'notoken-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const stub = stubFetch();
    const result = await runCommand('notoken-tg-skill').finally(() => stub.restore());

    assert.equal(stub.calls.length, 0, 'no token means no send was even attempted');
    assert.equal(result.success, false);
    assert.ok((result.error ?? '').includes('missing-token'), 'error should name the missing secret');
    const meta = await readRunMeta(tempDir, 'notoken-tg-skill');
    assert.equal(meta.status, 'error');
    const pointer = await readLatestPointer(tempDir, 'notoken-tg-skill');
    assert.equal(pointer.consecutiveFailures, 1);
  });

  it('SCOPE GUARD: a delivered run is still a success (no false delivery failures)', async () => {
    // The mirror of the above: if this ever fails, every telegram_output skill in
    // the system has just started recording failures on healthy runs.
    await createTempSecrets(tempDir, 'TELEGRAM_BOT_TOKEN=test-token\n');
    await configureReportingWorker('accept-ok.js');
    await createTempSkill(tempDir, 'delivered-tg-skill', ['---', TELEGRAM_FRONTMATTER, '---', 'prompt'].join('\n'));

    const stub = stubFetch({ ok: true });
    const result = await runCommand('delivered-tg-skill').finally(() => {
      stub.restore();
    });

    assert.equal(result.success, true);
    assert.equal(stub.calls.length, 1);
    const meta = await readRunMeta(tempDir, 'delivered-tg-skill');
    assert.equal(meta.status, 'success');
    const pointer = await readLatestPointer(tempDir, 'delivered-tg-skill');
    assert.equal(pointer.consecutiveFailures, 0);
  });

  it('a skill with NO telegram_output is never affected by delivery outcomes', async () => {
    // Delivery only exists for telegram_output skills; a plain skill must not be
    // reclassified by anything in this path.
    await createTempSecrets(tempDir, '');
    await configureReportingWorker('plain-ok.js');
    await createTempSkill(tempDir, 'plain-skill', ['---', '---', 'prompt'].join('\n'));

    const stub = stubFetch({ ok: false, status: 500, text: 'Internal Server Error' });
    const result = await runCommand('plain-skill').finally(() => stub.restore());

    assert.equal(stub.calls.length, 0, 'no telegram_output means no delivery attempt');
    assert.equal(result.success, true);
    const meta = await readRunMeta(tempDir, 'plain-skill');
    assert.equal(meta.status, 'success');
  });
});
