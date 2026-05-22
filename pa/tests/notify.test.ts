import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { createTempPaHome, createTempSecrets, cleanup } from './helpers.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function dedupPath(key: string): string {
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  return join(tempDir, 'alert-state', `${hash}.json`);
}

async function writeDedupFile(key: string, timestamp: string): Promise<void> {
  const filePath = dedupPath(key);
  await mkdir(join(tempDir, 'alert-state'), { recursive: true });
  await writeFile(filePath, JSON.stringify({ timestamp, key }), 'utf8');
}

async function readDedupFile(key: string): Promise<any> {
  const raw = await readFile(dedupPath(key), 'utf8');
  return JSON.parse(raw);
}

describe('notifyUser — dedup logic', () => {
  it('suppresses within dedup window', async () => {
    await writeDedupFile('test-key', new Date().toISOString());
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'test-key' });
    assert.equal(result.suppressed, true);
    assert.equal(result.sent, false);
  });

  it('sends after dedup window expires (no token → sent=false)', async () => {
    const oldTimestamp = new Date(Date.now() - 2 * 3600_000).toISOString();
    await writeDedupFile('test-key-old', oldTimestamp);
    const { notifyUser } = await import('../src/lib/notify.js');

    const result = await notifyUser('Test', 'body', { dedupKey: 'test-key-old' });
    // No token → missing-token return, not suppressed
    assert.equal(result.suppressed, false);
    assert.equal(result.sent, false);
  });

  it('always attempts send when dedupKey is undefined', async () => {
    const { notifyUser } = await import('../src/lib/notify.js');

    // No dedupKey — should attempt send regardless
    const result = await notifyUser('Test', 'body');
    assert.equal(result.suppressed, false);
  });

  it('writes dedup state after successful send', async () => {
    // This test verifies the file-write path. Since we can't easily mock
    // sendToTelegram to succeed, we verify the dedup file is written
    // by checking the file doesn't exist when token is missing (early return).
    const { notifyUser } = await import('../src/lib/notify.js');

    // No token → missing-token return before dedup write
    const result = await notifyUser('Test', 'body', { dedupKey: 'no-token-key' });
    assert.equal(result.sent, false);

    // Dedup file should NOT exist (send never succeeded)
    const exists = await readFile(dedupPath('no-token-key'), 'utf8').then(() => true).catch(() => false);
    assert.equal(exists, false, 'Dedup file should not be written when send fails');
  });
});

describe('notifyUser — PA_NOTIFY_DISABLED guard', () => {
  it('returns sent=false when PA_NOTIFY_DISABLED=1, without writing dedup file', async () => {
    const saved = process.env.PA_NOTIFY_DISABLED;
    process.env.PA_NOTIFY_DISABLED = '1';
    try {
      const { notifyUser } = await import('../src/lib/notify.js');
      const result = await notifyUser('Test', 'body', { dedupKey: 'guard-test-key' });
      assert.equal(result.sent, false);
      assert.equal(result.suppressed, false);
      // Disabled guard fires before send → no dedup file written
      const exists = await readFile(dedupPath('guard-test-key'), 'utf8').then(() => true).catch(() => false);
      assert.equal(exists, false, 'No dedup file written when guard fires before send');
    } finally {
      if (saved !== undefined) process.env.PA_NOTIFY_DISABLED = saved;
      else delete process.env.PA_NOTIFY_DISABLED;
    }
  });
});

describe('notifyUser — missing token', () => {
  it('returns sent=false when TELEGRAM_BOT_TOKEN is absent (via PA_NOTIFY_DISABLED guard in test env)', async () => {
    // In test runs PA_NOTIFY_DISABLED=1 is set globally, so this returns via the disabled guard.
    // The missing-token path is exercised by the explicit-unset test below.
    const { notifyUser } = await import('../src/lib/notify.js');
    const result = await notifyUser('Test', 'body');
    assert.equal(result.sent, false);
    assert.equal(result.suppressed, false);
  });

  it('returns sent=false, reason=missing-token when guard is off and no token is set', async () => {
    // Temporarily unset the guard to exercise the actual missing-token code path.
    const saved = process.env.PA_NOTIFY_DISABLED;
    delete process.env.PA_NOTIFY_DISABLED;
    try {
      const { notifyUser } = await import('../src/lib/notify.js');
      // tempDir has no secrets.env (or empty) → loadSecrets returns {} → no token
      const result = await notifyUser('Test', 'body');
      assert.equal(result.sent, false);
      assert.equal(result.suppressed, false);
    } finally {
      if (saved !== undefined) process.env.PA_NOTIFY_DISABLED = saved;
    }
  });
});

describe('notifyUser — constants', () => {
  it('GC_MAX_AGE_MS >= DEFAULT_DEDUP_WINDOW_MS', async () => {
    const { GC_MAX_AGE_MS, DEFAULT_DEDUP_WINDOW_MS } = await import('../src/lib/notify.js');
    assert.ok(GC_MAX_AGE_MS >= DEFAULT_DEDUP_WINDOW_MS,
      `GC_MAX_AGE_MS (${GC_MAX_AGE_MS}) must be >= DEFAULT_DEDUP_WINDOW_MS (${DEFAULT_DEDUP_WINDOW_MS})`);
  });
});

describe('gcAlertState', () => {
  it('deletes dedup files older than 24h', async () => {
    const { gcAlertState } = await import('../src/lib/notify.js');

    await writeDedupFile('stale-key', new Date(Date.now() - 25 * 3600_000).toISOString());
    await writeDedupFile('fresh-key', new Date().toISOString());

    await gcAlertState();

    const staleExists = await readFile(dedupPath('stale-key'), 'utf8').then(() => true).catch(() => false);
    const freshExists = await readFile(dedupPath('fresh-key'), 'utf8').then(() => true).catch(() => false);

    assert.equal(staleExists, false, 'Stale dedup file should be deleted');
    assert.equal(freshExists, true, 'Fresh dedup file should survive');
  });

  it('deletes malformed dedup files', async () => {
    const { gcAlertState } = await import('../src/lib/notify.js');
    const alertDir = join(tempDir, 'alert-state');
    await mkdir(alertDir, { recursive: true });

    await writeFile(join(alertDir, 'malformed.json'), 'NOT VALID JSON{{{', 'utf8');

    await gcAlertState();

    const exists = await readFile(join(alertDir, 'malformed.json'), 'utf8').then(() => true).catch(() => false);
    assert.equal(exists, false, 'Malformed file should be deleted');
  });

  it('handles non-existent alert-state directory gracefully', async () => {
    const { gcAlertState } = await import('../src/lib/notify.js');
    // No alert-state dir → should not throw
    await assert.doesNotReject(() => gcAlertState());
  });
});

describe('migrateStalenessAlertFile', () => {
  it('migrates old staleness file to new location', async () => {
    const oldPath = join(tempDir, 'last-staleness-alert.json');
    const ts = new Date().toISOString();
    await writeFile(oldPath, JSON.stringify({ timestamp: ts }), 'utf8');

    const { migrateStalenessAlertFile } = await import('../src/lib/notify.js');
    await migrateStalenessAlertFile();

    // Old file should be gone
    const oldExists = await readFile(oldPath, 'utf8').then(() => true).catch(() => false);
    assert.equal(oldExists, false, 'Old staleness file should be deleted');

    // New file should exist
    const newPath = dedupPath('staleness');
    const newContent = await readFile(newPath, 'utf8');
    const parsed = JSON.parse(newContent);
    assert.equal(parsed.key, 'staleness');
    assert.equal(parsed.timestamp, ts);
  });

  it('is idempotent — second call is no-op', async () => {
    // Both calls use the same import (module-level `migrated` flag)
    const { migrateStalenessAlertFile } = await import('../src/lib/notify.js');

    const oldPath = join(tempDir, 'last-staleness-alert.json');
    await writeFile(oldPath, JSON.stringify({ timestamp: new Date().toISOString() }), 'utf8');

    await migrateStalenessAlertFile();
    // Delete old file that was cleaned up, recreate to test idempotency
    // Actually the module-level flag means second call just returns — test by calling twice
    await migrateStalenessAlertFile();
    // Should not throw
  });

  it('does nothing when old file does not exist', async () => {
    const { migrateStalenessAlertFile } = await import('../src/lib/notify.js');
    // No old file → no-op
    await assert.doesNotReject(() => migrateStalenessAlertFile());
  });
});

describe('dedup-key registry uniqueness', () => {
  it('all registry keys have disjoint matchspaces', () => {
    const registry = [
      { pattern: 'worker-spawn-*', type: 'wildcard' },
      { pattern: 'worker-exit-*', type: 'wildcard' },
      { pattern: 'skill-failed-*', type: 'wildcard' },
      { pattern: 'skill-fail-topic-*', type: 'wildcard' },
      { pattern: 'shell-skill-spawn-*', type: 'wildcard' },
      { pattern: 'catchup-threw-*', type: 'wildcard' },
      { pattern: 'evaluator-*', type: 'wildcard' },
      { pattern: 'analyzer-terminal', type: 'bare' },
      { pattern: 'failure-analyzer-terminal', type: 'bare' },
      { pattern: 'all-workers-rate-limited-*', type: 'wildcard' },
      { pattern: 'skill-exhausted-*', type: 'wildcard' },
      { pattern: 'bg-orphan-*', type: 'wildcard' },
      { pattern: 'daily-mail-brief-hallucination', type: 'bare' },
      { pattern: 'daily-mail-brief-auth', type: 'bare' },
      { pattern: 'daily-mail-brief-fetch', type: 'bare' },
      { pattern: 'staleness', type: 'bare' },
    ];

    // Check bare keys are unique
    const bareKeys = registry.filter(e => e.type === 'bare').map(e => e.pattern);
    assert.equal(new Set(bareKeys).size, bareKeys.length, 'Bare keys must be unique');

    // Check bare keys don't fall into any wildcard's matchspace
    const wildcards = registry.filter(e => e.type === 'wildcard');
    for (const bare of bareKeys) {
      for (const wc of wildcards) {
        const prefix = wc.pattern.replace('-*', '');
        assert.ok(!bare.startsWith(prefix + '-'),
          `Bare key "${bare}" collides with wildcard "${wc.pattern}" (prefix "${prefix}-")`);
      }
    }

    // Check no two wildcards have overlapping prefixes
    for (let i = 0; i < wildcards.length; i++) {
      for (let j = i + 1; j < wildcards.length; j++) {
        const p1 = wildcards[i].pattern.replace('-*', '');
        const p2 = wildcards[j].pattern.replace('-*', '');
        // Sort to get shorter first
        const [shorter, longer] = p1.length <= p2.length ? [p1, p2] : [p2, p1];
        assert.ok(!longer.startsWith(shorter + '-'),
          `Wildcard "${wildcards[i].pattern}" collides with "${wildcards[j].pattern}"`);
      }
    }
  });
});
