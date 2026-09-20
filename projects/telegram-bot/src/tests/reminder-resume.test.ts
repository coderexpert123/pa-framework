// AI-185 (plans/2026-09-02-ai185-executable-reminder-dispatch-SPEC.md §3.3-3.4):
// drain of PA_HOME/pending-reminder-resume.json + the injectSystemReminderUpdate
// wrapper. MUST stay first — sandboxes PA_HOME against real side effects.
import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { drainDueReminderResumes, injectSystemReminderUpdate, injectSystemResumeUpdate } from '../main.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { waitForDrain } from './test-teardown-guard.js';

// A stub standing in for projects/voice-inbox/scripts/create_conversation_task.py
// (never the real script, never a real ledger) — it echoes its own argv plus a
// caller-controlled JSON envelope, so these tests assert exactly what
// resumeVoiceInboxConversation passes and how it reacts, without touching sqlite
// or a real python-side ledger write. The real script's own INSERT shape is
// verified separately (manually, against the real schema) — this suite only
// owns the TS-side dispatch/validation/fail-open behaviour.
const STUB_SCRIPT = `
import sys, json, os
result = json.loads(os.environ.get("TEST_STUB_RESULT", '{"ok": true, "task_id": "vi-000000000000", "routed_to": null}'))
result["_argv"] = sys.argv[1:]
print(json.dumps(result))
sys.exit(0 if result.get("ok") else 1)
`;

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '2026-09-02T09:30:00+00:00-abcd1234',
    queued_at: '2026-09-02T04:00:00.000Z', // 09:30 IST
    chat_id: CHAT_ID,
    thread_id: THREAD_ID,
    resume_action: { type: 'topic_resume', prompt: 'Run Gate F verification and report PASS/FAIL' },
    ...overrides,
  };
}

function queuePath(paHome: string): string {
  return join(paHome, 'pending-reminder-resume.json');
}

async function writeQueue(paHome: string, records: unknown[]): Promise<void> {
  await writeFile(queuePath(paHome), JSON.stringify(records, null, 2), 'utf8');
}

async function readQueue(paHome: string): Promise<unknown[]> {
  const raw = await readFile(queuePath(paHome), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

describe('drainDueReminderResumes', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog(); // drain pending appends before switching PA_HOME
    tempDir = await mkdtemp(join(tmpdir(), 'reminder-resume-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await flushLog(); // drain fire-and-forget log writes to tempDir before removing it
    await waitForDrain();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readLogEntries(): Promise<any[]> {
    await flushLog(); // deterministic — await pending log writes instead of a racy fixed sleep
    const raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('absent queue file is a no-op (returns 0)', async () => {
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    assert.equal(injected, 0);
  });

  it('invalid JSON queue file is a no-op (returns 0)', async () => {
    await writeFile(queuePath(tempDir), '{not json', 'utf8');
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    assert.equal(injected, 0);
  });

  it('empty queue is a no-op (returns 0)', async () => {
    await writeQueue(tempDir, []);
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    assert.equal(injected, 0);
  });

  it('pops FIRST: remaining records are persisted BEFORE the injection fires', async () => {
    const { readFileSync } = await import('fs');
    await writeQueue(tempDir, [record({ id: 'rec-1' }), record({ id: 'rec-2', prompt: 'second payload' })]);
    const seenDuringInjection: string[][] = [];
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {
      // Sync read INSIDE injectFn: whatever the queue file holds at injection
      // time is exactly what was persisted before this injection fired.
      const entries = JSON.parse(readFileSync(queuePath(tempDir), 'utf8')) as any[];
      seenDuringInjection.push(entries.map((e) => e.id));
    });
    assert.equal(injected, 2);
    assert.deepEqual(seenDuringInjection, [
      ['rec-2'],
      [],
    ], 'each pop must be persisted before its injection (rec-1 already gone when injecting rec-1)');
    assert.deepEqual(await readQueue(tempDir), [], 'queue fully drained');
  });

  it('injects via injectSystemReminderUpdate with the record prompt and queued_at', async () => {
    await writeQueue(tempDir, [record()]);
    const updates: any[] = [];
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), (u) => updates.push(u));
    assert.equal(injected, 1);
    assert.equal(updates.length, 1);
    assert.match(updates[0].message.text,
      /^\[System: reminder-triggered \(queued \d{2}:\d{2} IST\)] Run Gate F verification and report PASS\/FAIL$/);
  });

  it('validation-reject drops the record with a WARN and never crashes the job', async () => {
    // extra key -> validateTopicResumeAction rejects ("exactly the keys type+prompt")
    await writeQueue(tempDir, [record({ resume_action: { type: 'topic_resume', prompt: 'x', skill: 'nope' } })]);
    const updates: any[] = [];
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), (u) => updates.push(u));
    assert.equal(injected, 0);
    assert.equal(updates.length, 0);
    assert.deepEqual(await readQueue(tempDir), [], 'rejected record is still popped, not left to redrain');
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'reminder-resume' && e.level === 'warn');
    assert.ok(warn, 'a reminder-resume WARN must be logged');
    assert.match(warn.message, /rejected at fire time/);
    assert.equal(warn.id, '2026-09-02T09:30:00+00:00-abcd1234');
  });

  it('non-allowed chat drops the record with a WARN', async () => {
    await writeQueue(tempDir, [record({ chat_id: -999 })]);
    const updates: any[] = [];
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), (u) => updates.push(u));
    assert.equal(injected, 0);
    assert.equal(updates.length, 0);
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'reminder-resume' && e.level === 'warn');
    assert.ok(warn, 'a reminder-resume WARN must be logged');
    assert.match(warn.message, /is not an allowed chat/);
    assert.equal(warn.id, '2026-09-02T09:30:00+00:00-abcd1234');
  });

  it('missing chat_id drops the record with a WARN', async () => {
    await writeQueue(tempDir, [record({ chat_id: undefined })]);
    const updates: any[] = [];
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), (u) => updates.push(u));
    assert.equal(injected, 0);
    assert.equal(updates.length, 0);
  });

  it('does not age-drop: a stale queued_at still drains', async () => {
    await writeQueue(tempDir, [record({ queued_at: '2026-08-01T04:00:00.000Z' })]);
    const updates: any[] = [];
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), (u) => updates.push(u));
    assert.equal(injected, 1);
    assert.equal(updates.length, 1);
  });

  it('logs the exact pop line per record', async () => {
    await writeQueue(tempDir, [record()]);
    await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    const entries = await readLogEntries();
    const pop = entries.find((e) => e.module === 'reminder-resume' && e.message === 'popped record for injection');
    assert.ok(pop, 'pop log line must exist');
    assert.equal(pop.id, '2026-09-02T09:30:00+00:00-abcd1234');
    assert.equal(String(pop.chatId), String(CHAT_ID));
    assert.equal(pop.threadId, THREAD_ID);
  });
});

// AI-conversation-context reminder fix (2026-09-12): drainDueReminderResumes'
// second branch, for a reminder whose pending decision originated in a
// voice-inbox UI conversation rather than a Telegram chat/topic.
describe('drainDueReminderResumes — voice_inbox_resume', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;
  let originalScriptEnv: string | undefined;
  let originalStubResult: string | undefined;
  const CONVERSATION_ID = 'vi-682a17c7e13c';

  function voiceInboxRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: '2026-09-12T02:30:00+00:00-efgh5678',
      queued_at: '2026-09-12T02:30:00.000Z',
      chat_id: CHAT_ID,
      thread_id: THREAD_ID,
      resume_action: { type: 'voice_inbox_resume', conversation_id: CONVERSATION_ID, prompt: 'Run the fresh-OTP Swiggy re-run' },
      ...overrides,
    };
  }

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'reminder-resume-vi-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
    const stubPath = join(tempDir, 'stub_create_conversation_task.py');
    await writeFile(stubPath, STUB_SCRIPT, 'utf8');
    originalScriptEnv = process.env.PA_VOICE_INBOX_RESUME_SCRIPT;
    process.env.PA_VOICE_INBOX_RESUME_SCRIPT = stubPath;
    originalStubResult = process.env.TEST_STUB_RESULT;
  });

  afterEach(async () => {
    await flushLog();
    await waitForDrain();
    if (originalPaHome === undefined) delete process.env.PA_HOME; else process.env.PA_HOME = originalPaHome;
    if (originalScriptEnv === undefined) delete process.env.PA_VOICE_INBOX_RESUME_SCRIPT; else process.env.PA_VOICE_INBOX_RESUME_SCRIPT = originalScriptEnv;
    if (originalStubResult === undefined) delete process.env.TEST_STUB_RESULT; else process.env.TEST_STUB_RESULT = originalStubResult;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readLogEntries(): Promise<any[]> {
    await flushLog();
    const raw = await readFile(join(tempDir, 'app.log.jsonl'), 'utf8');
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('resolves via create_conversation_task.py, passing conversation_id and prompt, never via injectFn', async () => {
    process.env.TEST_STUB_RESULT = JSON.stringify({ ok: true, task_id: 'vi-abc123abc123', routed_to: '-1001234567890_310' });
    await writeQueue(tempDir, [voiceInboxRecord()]);
    const updates: any[] = [];
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), (u) => updates.push(u));
    assert.equal(injected, 1);
    assert.equal(updates.length, 0, 'a voice_inbox_resume never goes through the Telegram injection path');

    const entries = await readLogEntries();
    const info = entries.find((e) => e.module === 'reminder-resume' && e.message === 'injected voice_inbox_resume turn');
    assert.ok(info, 'a success log line must exist');
    assert.equal(info.conversationId, CONVERSATION_ID);
    assert.equal(info.taskId, 'vi-abc123abc123');
    assert.deepEqual(await readQueue(tempDir), [], 'record consumed');
  });

  it('script reporting ok:false drops the record with a WARN (fail-open, never crashes)', async () => {
    process.env.TEST_STUB_RESULT = JSON.stringify({ ok: false, error: 'no task found for conversation_id' });
    await writeQueue(tempDir, [voiceInboxRecord()]);
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    assert.equal(injected, 0);
    assert.deepEqual(await readQueue(tempDir), [], 'record still popped, not left to redrain');
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'reminder-resume' && e.level === 'warn');
    assert.ok(warn, 'a reminder-resume WARN must be logged');
    assert.match(warn.message, /voice_inbox_resume script reported failure/);
  });

  it('a missing/unspawnable script drops the record with a WARN (fail-open)', async () => {
    process.env.PA_VOICE_INBOX_RESUME_SCRIPT = join(tempDir, 'does-not-exist.py');
    await writeQueue(tempDir, [voiceInboxRecord()]);
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    assert.equal(injected, 0);
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'reminder-resume' && e.level === 'warn');
    assert.ok(warn, 'a reminder-resume WARN must be logged');
    assert.match(warn.message, /voice_inbox_resume script failed/);
  });

  it('rejects a malformed voice_inbox_resume action before ever spawning the script', async () => {
    await writeQueue(tempDir, [voiceInboxRecord({
      resume_action: { type: 'voice_inbox_resume', conversation_id: 'not-a-real-id', prompt: 'do it' },
    })]);
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    assert.equal(injected, 0);
    const entries = await readLogEntries();
    const warn = entries.find((e) => e.module === 'reminder-resume' && e.level === 'warn');
    assert.ok(warn, 'a reminder-resume WARN must be logged');
    assert.match(warn.message, /conversation_id must match/);
  });

  it('is unaffected by allowedChatIds/chat_id — the target is the conversation, not a chat', async () => {
    process.env.TEST_STUB_RESULT = JSON.stringify({ ok: true, task_id: 'vi-abc123abc123', routed_to: null });
    await writeQueue(tempDir, [voiceInboxRecord({ chat_id: -999, thread_id: undefined })]);
    const injected = await drainDueReminderResumes(new Set([CHAT_ID]), () => {});
    assert.equal(injected, 1, 'voice_inbox_resume bypasses the chat_id/allowedChatIds gate entirely');
  });
});

describe('injectSystemReminderUpdate (AI-185)', () => {
  it('emits the exact system_reminder text, tag and message shape', () => {
    const updates: any[] = [];
    const updateId = injectSystemReminderUpdate(
      { chatId: CHAT_ID, threadId: THREAD_ID, prompt: 'Run Gate F verification', queuedAtIst: '09:30' },
      (u) => updates.push(u)
    );
    assert.equal(updates.length, 1);
    const update = updates[0];
    assert.strictEqual(update.message.text,
      '[System: reminder-triggered (queued 09:30 IST)] Run Gate F verification');
    assert.strictEqual(update.__synthetic, 'system_reminder');
    assert.strictEqual(update.message.message_id, 0);
    assert.deepStrictEqual(update.message.from, { id: 0, first_name: 'PA system' });
    assert.strictEqual(update.message.chat.id, CHAT_ID);
    assert.strictEqual(update.message.chat.type, 'supergroup');
    assert.strictEqual(update.message.message_thread_id, THREAD_ID);
    assert.strictEqual(typeof updateId, 'number');
    assert.ok(updateId > 0);
  });

  it('threadId 0 omits message_thread_id and marks the chat private (0-sentinel)', () => {
    const updates: any[] = [];
    injectSystemReminderUpdate(
      { chatId: 12345, threadId: 0, prompt: 'private-chat payload', queuedAtIst: '21:15' },
      (u) => updates.push(u)
    );
    assert.strictEqual(updates[0].message.message_thread_id, undefined);
    assert.strictEqual(updates[0].message.chat.type, 'private');
  });

  it('logs the exact injected line', async () => {
    await flushLog();
    const tempDir2 = await mkdtemp(join(tmpdir(), 'reminder-inject-'));
    const prev = process.env.PA_HOME;
    process.env.PA_HOME = tempDir2;
    try {
      injectSystemReminderUpdate(
        { chatId: CHAT_ID, threadId: THREAD_ID, prompt: 'Run Gate F verification', queuedAtIst: '09:30' },
        () => {}
      );
      await flushLog();
      const raw = await readFile(join(tempDir2, 'app.log.jsonl'), 'utf8');
      const entries = raw.trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
      const entry = entries.find((e: any) => e.module === 'system-reminder');
      assert.ok(entry, 'system-reminder log entry must exist');
      assert.equal(entry.message, 'injected reminder_resume turn');
      assert.equal(entry.chatId, CHAT_ID);
      assert.equal(entry.threadId, THREAD_ID);
      assert.equal(typeof entry.updateId, 'number');
    } finally {
      await flushLog();
      await waitForDrain();
      if (prev === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = prev;
      await rm(tempDir2, { recursive: true, force: true });
    }
  });
});

describe('oauth resume path regression (G3 — byte-identical)', () => {
  it('injectSystemResumeUpdate keeps the exact text prefix and system_resume tag', () => {
    const updates: any[] = [];
    injectSystemResumeUpdate(
      { chatId: CHAT_ID, threadId: THREAD_ID, prompt: 'continue the contact add' },
      (u) => updates.push(u)
    );
    assert.strictEqual(updates[0].message.text,
      '[System: auto-resumed after Google auth] continue the contact add');
    assert.strictEqual(updates[0].__synthetic, 'system_resume');
    assert.strictEqual(updates[0].message.message_id, 0);
    assert.deepStrictEqual(updates[0].message.from, { id: 0, first_name: 'PA system' });
  });

  it('keeps the exact oauth log line', async () => {
    const tempDir2 = await mkdtemp(join(tmpdir(), 'reminder-oauth-'));
    const prev = process.env.PA_HOME;
    process.env.PA_HOME = tempDir2;
    try {
      injectSystemResumeUpdate(
        { chatId: CHAT_ID, threadId: THREAD_ID, prompt: 'continue the contact add' },
        () => {}
      );
      await flushLog();
      const raw = await readFile(join(tempDir2, 'app.log.jsonl'), 'utf8');
      const entries = raw.trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
      const entry = entries.find((e: any) => e.module === 'system-resume');
      assert.ok(entry, 'system-resume log entry must exist');
      assert.equal(entry.message, 'injected topic_resume turn after Google auth');
    } finally {
      await flushLog();
      await waitForDrain();
      if (prev === undefined) delete process.env.PA_HOME;
      else process.env.PA_HOME = prev;
      await rm(tempDir2, { recursive: true, force: true });
    }
  });
});
