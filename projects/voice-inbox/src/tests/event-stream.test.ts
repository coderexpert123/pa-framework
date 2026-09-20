/**
 * event-stream tests (vi-6b1014ea197b): the hub's fan-out/unsubscribe
 * bookkeeping, and the change watcher's core claim — a write through ANY
 * connection (this process's own `db`, or a separate connection standing in
 * for an out-of-process Python worker script) is detected, because the
 * watcher never shares a connection with a writer. See event-stream.ts's
 * module doc for why that separation is load-bearing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openLedger } from '../ledger.js';
import {
  createEventHub,
  createShellNudge,
  createShellVersionReader,
  startChangeWatcher,
  startShellWatcher,
} from '../event-stream.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate()` is true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await delay(stepMs);
  }
}

describe('createEventHub', () => {
  it('broadcasts a bare changed event to every connected client', () => {
    const hub = createEventHub();
    const a: string[] = [];
    const b: string[] = [];
    hub.addClient((chunk) => a.push(chunk));
    hub.addClient((chunk) => b.push(chunk));
    assert.equal(hub.size(), 2);
    hub.broadcast();
    assert.equal(a.length, 1);
    assert.match(a[0], /^event: changed\n/);
    assert.equal(b.length, 1);
    assert.deepEqual(a, b);
  });

  it('unsubscribe stops future broadcasts to that client only', () => {
    const hub = createEventHub();
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = hub.addClient((chunk) => a.push(chunk));
    hub.addClient((chunk) => b.push(chunk));
    unsubA();
    assert.equal(hub.size(), 1);
    hub.broadcast();
    assert.equal(a.length, 0);
    assert.equal(b.length, 1);
  });

  it('a throwing client does not stop the broadcast to others', () => {
    const hub = createEventHub();
    const b: string[] = [];
    hub.addClient(() => {
      throw new Error('dead socket');
    });
    hub.addClient((chunk) => b.push(chunk));
    assert.doesNotThrow(() => hub.broadcast());
    assert.equal(b.length, 1);
  });

  it('broadcasts a caller-named event (e.g. reload) instead of the changed default', () => {
    const hub = createEventHub();
    const a: string[] = [];
    hub.addClient((chunk) => a.push(chunk));
    hub.broadcast('reload');
    assert.equal(a.length, 1);
    assert.match(a[0], /^event: reload\n/);
  });
});

describe('startChangeWatcher', () => {
  it('detects a write made through the SAME logical writer as a normal API call, via its own connection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-eventstream-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const db = openLedger(dbPath);
    let changes = 0;
    const watcher = startChangeWatcher(dbPath, () => {
      changes += 1;
    }, 20);
    try {
      db.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-1', 1, 1, 'Test', '2026-01-01T00:00:00.000Z')`
      ).run();
      await waitFor(() => changes >= 1);
      assert.ok(changes >= 1);
    } finally {
      watcher.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects a write from a SEPARATE connection, standing in for an out-of-process Python worker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-eventstream-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const db = openLedger(dbPath);
    let changes = 0;
    const watcher = startChangeWatcher(dbPath, () => {
      changes += 1;
    }, 20);
    const worker = new Database(dbPath);
    try {
      worker.prepare(
        `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
         VALUES ('t-2', 2, 2, 'Worker', '2026-01-01T00:00:00.000Z')`
      ).run();
      await waitFor(() => changes >= 1);
      assert.ok(changes >= 1);
    } finally {
      watcher.stop();
      worker.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() ends polling — no further onChange calls, connection released for cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-eventstream-'));
    const dbPath = join(dir, 'ledger.sqlite');
    const db = openLedger(dbPath);
    let changes = 0;
    const watcher = startChangeWatcher(dbPath, () => {
      changes += 1;
    }, 20);
    watcher.stop();
    db.prepare(
      `INSERT INTO tenants (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)
       VALUES ('t-3', 3, 3, 'Late', '2026-01-01T00:00:00.000Z')`
    ).run();
    await delay(100);
    assert.equal(changes, 0);
    db.close();
    // A held handle on the watcher's own connection would EBUSY this on Windows.
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('startShellWatcher', () => {
  it('detects a shell file mtime change and reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-shellwatch-'));
    const file = join(dir, 'sw.js');
    writeFileSync(file, "const SHELL_CACHE = 'voice-inbox-shell-v1';");
    let changes = 0;
    const watcher = startShellWatcher(file, () => {
      changes += 1;
    }, 20);
    try {
      writeFileSync(file, "const SHELL_CACHE = 'voice-inbox-shell-v2';");
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      await waitFor(() => changes >= 1);
      assert.ok(changes >= 1);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() ends polling — no further onChange calls after a later edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-shellwatch-'));
    const file = join(dir, 'sw.js');
    writeFileSync(file, "const SHELL_CACHE = 'voice-inbox-shell-v1';");
    let changes = 0;
    const watcher = startShellWatcher(file, () => {
      changes += 1;
    }, 20);
    watcher.stop();
    writeFileSync(file, "const SHELL_CACHE = 'voice-inbox-shell-v2';");
    await delay(100);
    assert.equal(changes, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Write a fake sw.js carrying the given SHELL_CACHE version, with a
 *  guaranteed-distinct mtime so the version reader's mtime cache re-reads. */
let shellWriteTick = 0;
function writeShell(dir: string, version: string): string {
  const file = join(dir, 'sw.js');
  writeFileSync(file, `const SHELL_CACHE = 'voice-inbox-shell-${version}';`);
  shellWriteTick += 1;
  utimesSync(file, new Date(), new Date(Date.now() + shellWriteTick * 5000));
  return file;
}

describe('createShellVersionReader', () => {
  it("returns the SHELL_CACHE version, null for no-version or missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-shellver-'));
    try {
      const file = writeShell(dir, 'v55');
      const reader = createShellVersionReader(file);
      assert.equal(reader.current(), 'v55');

      // A file without a parseable SHELL_CACHE is "do not nudge", never a version.
      writeFileSync(file, 'const OTHER = true;');
      shellWriteTick += 1;
      utimesSync(file, new Date(), new Date(Date.now() + shellWriteTick * 5000));
      assert.equal(reader.current(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Missing file — same "do not nudge" contract, not a crash.
    const missing = createShellVersionReader(join(tmpdir(), 'no-such-shell-sw.js'));
    assert.equal(missing.current(), null);
  });

  it('picks up a version bump on mtime change (the cache is mtime-keyed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-shellver-'));
    try {
      const file = writeShell(dir, 'v1');
      const reader = createShellVersionReader(file);
      assert.equal(reader.current(), 'v1');
      writeShell(dir, 'v2'); // same path, new content + forced new mtime
      assert.equal(reader.current(), 'v2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createShellNudge', () => {
  it('nudges a stale or unversioned client exactly once per on-disk version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-shellnudge-'));
    try {
      const nudge = createShellNudge(createShellVersionReader(writeShell(dir, 'v55')));
      assert.equal(nudge.shouldNudge('session-1', 'v54'), true, 'stale client must be nudged');
      assert.equal(nudge.shouldNudge('session-1', 'v54'), false, 'same version must not nudge twice');
      assert.equal(nudge.shouldNudge('session-1', null), false, 'unversioned reconnect at the same version stays consumed');
      assert.equal(nudge.shouldNudge('session-1', 'v55'), false, 'a client that did update is current');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never nudges a current client, and never nudges on an unreadable shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-shellnudge-'));
    try {
      const nudge = createShellNudge(createShellVersionReader(writeShell(dir, 'v55')));
      assert.equal(nudge.shouldNudge('session-1', 'v55'), false, 'current client: nothing to replay');
      assert.equal(nudge.shouldNudge('session-1', null), true, 'a shell older than the handshake declares nothing and gets its one nudge');
      assert.equal(nudge.shouldNudge('session-1', null), false, '...and only that one');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const broken = createShellNudge(createShellVersionReader(join(tmpdir(), 'no-such-shell-sw.js')));
    assert.equal(broken.shouldNudge('session-1', 'v54'), false, 'unreadable shell must never nudge anyone');
    assert.equal(broken.shouldNudge('session-2', null), false);
  });

  it('a version bump re-arms the session; sessions are independent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-shellnudge-'));
    try {
      const nudge = createShellNudge(createShellVersionReader(writeShell(dir, 'v55')));
      assert.equal(nudge.shouldNudge('session-1', 'v54'), true);
      assert.equal(nudge.shouldNudge('session-2', 'v54'), true, 'separate devices nudge independently');
      writeShell(dir, 'v56');
      assert.equal(nudge.shouldNudge('session-1', 'v55'), true, 'a new on-disk version re-arms the session once');
      assert.equal(nudge.shouldNudge('session-1', 'v55'), false);
      assert.equal(nudge.shouldNudge('session-1', 'v56'), false, 'client caught up to v56');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
