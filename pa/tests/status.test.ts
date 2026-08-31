/**
 * D2 (2026-08-31): `pa status` command — one-screen overview with 7 sections.
 *
 * Test harness mirrors catchup-lock.test.ts: createTempPaHome + createTempConfig
 * + createTempSkill from helpers.js, console.log mocking via node:test,
 * gitGuardFn injection to avoid real git probes, minimal fixtures for DLQ,
 * maintenance ledger, and reservations store.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { hostname } from 'os';
import { createTempPaHome, createTempConfig, createTempSkill, cleanup } from './helpers.js';

let dir: string;
const outputLines: string[] = [];

before(async () => {
  dir = await createTempPaHome();
  await createTempConfig(dir, [
    { name: 'claude', command: 'node', args: ['-e', '0'], check: 'node -e "0"' },
  ]);
});

after(async () => {
  await cleanup(dir);
});

describe('statusCommand (D2, 2026-08-31)', () => {
  it('prints all 7 section headers with empty temp home and allowed git', async () => {
    const { statusCommand } = await import('../src/commands/status.js');

    outputLines.length = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      outputLines.push(String(args[0] ?? ''));
    };

    try {
      await statusCommand({
        gitGuardFn: async () => ({ allowed: true, reason: 'test override' }),
      });
    } finally {
      console.log = originalLog;
    }

    const output = outputLines.join('\n');
    assert.match(output, /health:/);
    assert.match(output, /git:/);
    assert.match(output, /skills:/);
    assert.match(output, /next due:/);
    assert.match(output, /claims:/);
    assert.match(output, /dlq:/);
    assert.match(output, /maintenance:/);
  });

  it('shows "not allowed" when gitGuardFn returns allowed:false', async () => {
    const { statusCommand } = await import('../src/commands/status.js');

    outputLines.length = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      outputLines.push(String(args[0] ?? ''));
    };

    try {
      await statusCommand({
        gitGuardFn: async () => ({ allowed: false, reason: 'git_workflow.enabled is false' }),
      });
    } finally {
      console.log = originalLog;
    }

    const gitLine = outputLines.find((l) => l.startsWith('  git:'));
    assert.ok(gitLine, 'git line should exist');
    assert.match(gitLine, /not allowed/);
  });

  it('reports DLQ counts from telegram-dlq.jsonl fixture', async () => {
    const { statusCommand } = await import('../src/commands/status.js');

    // Write DLQ fixture: one quarantined, one not
    const dlqPath = join(dir, 'telegram-dlq.jsonl');
    await writeFile(
      dlqPath,
      JSON.stringify({
        chatId: 1,
        threadId: 1,
        text: 'quarantined entry',
        timestamp: new Date().toISOString(),
        updateId: 1,
        quarantined: true,
      }) +
        '\n' +
        JSON.stringify({
          chatId: 2,
          threadId: 2,
          text: 'normal entry',
          timestamp: new Date().toISOString(),
          updateId: 2,
        }) +
        '\n',
      'utf8',
    );

    outputLines.length = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      outputLines.push(String(args[0] ?? ''));
    };

    try {
      await statusCommand({
        gitGuardFn: async () => ({ allowed: true, reason: 'test' }),
      });
    } finally {
      console.log = originalLog;
    }

    const dlqLine = outputLines.find((l) => l.startsWith('  dlq:'));
    assert.ok(dlqLine, 'dlq line should exist');
    assert.match(dlqLine, /2 entry\(ies\), 1 quarantined/);
  });

  it('reports overdue skills and next-due from cron fixtures', async () => {
    const { statusCommand } = await import('../src/commands/status.js');

    // Annual skill — always overdue in fresh temp home
    await createTempSkill(
      dir,
      'marker-annual',
      [
        '---',
        'cron: "0 0 1 1 *"',
        'cmd: "node -e 0"',
        'timeout: 60',
        '---',
        'Annual marker skill — always overdue.',
      ].join('\n'),
    );

    // Near-future skill (5 minutes from now) - handle hour/day rollover correctly
    const futureMinutes = 5;
    const now = new Date();
    const futureTime = new Date(now.getTime() + futureMinutes * 60_000);
    const futureHour = futureTime.getUTCHours();
    const futureMinute = futureTime.getUTCMinutes();
    await createTempSkill(
      dir,
      'near-future',
      [
        '---',
        `cron: "${futureMinute} ${futureHour} * * *"`,
        'cmd: "node -e 0"',
        'timeout: 60',
        '---',
        'Near-future skill — next-due candidate.',
      ].join('\n'),
    );

    outputLines.length = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      outputLines.push(String(args[0] ?? ''));
    };

    try {
      await statusCommand({
        gitGuardFn: async () => ({ allowed: true, reason: 'test' }),
      });
    } finally {
      console.log = originalLog;
    }

    const skillsLine = outputLines.find((l) => l.startsWith('  skills:'));
    assert.ok(skillsLine, 'skills line should exist');
    assert.match(skillsLine, /2 total \(2 scheduled\), 2 overdue/);

    const nextDueLine = outputLines.find((l) => l.startsWith('  next due:'));
    assert.ok(nextDueLine, 'next due line should exist');
    // The near-future skill should appear in the next-due output (format varies by cron calculation)
    assert.match(nextDueLine, /near-future/);
  });

  it('reports failing jobs from maintenance-state.json fixture', async () => {
    const { statusCommand } = await import('../src/commands/status.js');

    // Write minimal ledger with one failed job
    const ledgerPath = join(dir, 'maintenance-state.json');
    await writeFile(
      ledgerPath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            'test-job': {
              firstSeenAt: new Date().toISOString(),
              lastOutcome: 'failed',
              consecutiveFailures: 3,
              consecutiveSkips: 0,
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    outputLines.length = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      outputLines.push(String(args[0] ?? ''));
    };

    try {
      await statusCommand({
        gitGuardFn: async () => ({ allowed: true, reason: 'test' }),
      });
    } finally {
      console.log = originalLog;
    }

    const maintenanceLine = outputLines.find((l) => l.startsWith('  maintenance:'));
    assert.ok(maintenanceLine, 'maintenance line should exist');
    assert.match(maintenanceLine, /1 failing/);
  });

  it('reports active reservations from reservations.json fixture', async () => {
    const { statusCommand } = await import('../src/commands/status.js');

    // Write reservations store with one active entry (expires 1h from now)
    const reservationsPath = join(dir, 'reservations.json');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await writeFile(
      reservationsPath,
      JSON.stringify(
        {
          reservations: [
            {
              id: 'r-test123',
              paths: ['pa/tests/status.test.ts'],
              session: 'test-session',
              note: 'test reservation',
              claimedAt: new Date().toISOString(),
              expiresAt,
            },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    outputLines.length = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      outputLines.push(String(args[0] ?? ''));
    };

    try {
      await statusCommand({
        gitGuardFn: async () => ({ allowed: true, reason: 'test' }),
      });
    } finally {
      console.log = originalLog;
    }

    const claimsLine = outputLines.find((l) => l.startsWith('  claims:'));
    assert.ok(claimsLine, 'claims line should exist');
    assert.match(claimsLine, /1 active/);
  });
});
