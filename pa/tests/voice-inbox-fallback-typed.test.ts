import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import { resetTypeSafeClientState } from '../src/lib/typesafe-client.js';
import { voiceInboxLedgerPath } from '../src/lib/voice-inbox-ledger.js';
import {
  handleReceived,
  readFallbackAppConfig,
  resolveTargetDetailed,
  runVoiceInboxFallback,
  type StuckTaskRow,
} from '../src/lib/maintenance/jobs/voice-inbox-fallback.js';
import type { RunScriptFn } from '../src/lib/voice-inbox-transcribe.js';
import type { TypedRouteOutcome } from '../src/lib/voice-inbox-typed-route-action.js';
import { buildVoiceRouteRetryMessage } from '../src/lib/voice-inbox-route-retry.js';

let tempDir: string;

// TYPED is CFG plus an enabled voice_inbox_routing block (D8: act on the top
// destination at any confidence — the fallback's own last-resort policy).
const CFG = { inboxTopic: '-100123_900', keywordTopics: { invoice: '-100123_5' } };
const TYPED = {
  ...CFG,
  typedRouting: {
    actConfidence: 0.9,
    continueConfidence: 0.9,
    noMatch: 'create-topic' as const,
    escalation: 'llm-turn' as const,
  },
};

beforeEach(async () => {
  tempDir = await createTempPaHome();
  delete process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC;
});

afterEach(async () => {
  await cleanup(tempDir);
});

/** A StuckTaskRow fixture: 'pay the invoice please' (matches the keyword
 *  table's 'invoice' entry), created/updated 7 minutes before `now`. */
function baseTask(now: number, overrides: Partial<Pick<StuckTaskRow, 'request_text'>> = {}): StuckTaskRow {
  const createdAt = new Date(now - 7 * 60_000).toISOString();
  return {
    task_id: 'vi-0000000000d1',
    tenant_id: 't-1',
    state: 'received',
    request_text: overrides.request_text ?? 'pay the invoice please',
    transcript: null,
    routed_to: null,
    conversation_id: 'vi-0000000000d1',
    created_at: createdAt,
    updated_at: createdAt,
  };
}

/** Records every call and returns a fixed exit code — the "runScript
 *  recorder returns code 0" convention this package's own tests use. */
function makeRunScriptRecorder(code = 0): { fn: RunScriptFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  const fn: RunScriptFn = async (script, args) => {
    calls.push({ script, args });
    return { stdout: '', stderr: '', code };
  };
  return { fn, calls };
}

/** The minimal ledger schema this file's legacy-path tests need: the union
 *  of the columns selectStuckTasks, isStillReceived, findContinuationCandidate
 *  and readTypedRouteTask read (verified against voice-inbox-fallback.ts and
 *  the typed action). Fixture only — never the real app schema. */
function buildMinimalLedger(path: string, row: {
  task_id: string;
  tenant_id: string;
  state: string;
  source: string;
  request_text: string;
  transcript: string | null;
  routed_to: string | null;
  conversation_id: string;
  feedback_about: string | null;
  worker_resource: string | null;
  created_at: string;
  updated_at: string;
}): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(
      'CREATE TABLE tasks (task_id TEXT PRIMARY KEY, tenant_id TEXT, state TEXT, source TEXT, request_text TEXT, transcript TEXT, routed_to TEXT, conversation_id TEXT, feedback_about TEXT, worker_resource TEXT, created_at TEXT, updated_at TEXT)'
    );
    db.prepare(
      `INSERT INTO tasks (task_id, tenant_id, state, source, request_text, transcript, routed_to, conversation_id, feedback_about, worker_resource, created_at, updated_at)
       VALUES (@task_id, @tenant_id, @state, @source, @request_text, @transcript, @routed_to, @conversation_id, @feedback_about, @worker_resource, @created_at, @updated_at)`
    ).run(row);
  } finally {
    db.close();
  }
}

function ledgerRowOf(task: StuckTaskRow, source: 'voice' | 'text') {
  return {
    task_id: task.task_id,
    tenant_id: task.tenant_id,
    state: task.state,
    source,
    request_text: task.request_text,
    transcript: task.transcript,
    routed_to: task.routed_to,
    conversation_id: task.conversation_id,
    feedback_about: null,
    worker_resource: null,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

const LEGACY_REASON = 'Placed by the deterministic fallback after 7 minutes without a worker routing it';

describe('voice-inbox-fallback: typed routing (received arm, 2026-09-17)', () => {
  it('typed routing placed: the legacy keyword route never runs', async () => {
    const now = Date.now();
    const task = baseTask(now);
    const { fn: runScript, calls } = makeRunScriptRecorder();
    const typedRouteFn = async (): Promise<TypedRouteOutcome> => ({
      kind: 'placed',
      action: { kind: 'route', topicKey: '-100123_5', reason: 'r', basis: 'typesafe' },
      scriptExit: 0,
    });
    const acted = await handleReceived(task, now, 'R', 'L', TYPED, { runScript, typedRouteFn });
    assert.equal(acted, true);
    assert.equal(calls.length, 0);
  });

  it('typed routing escalated: falls through to the keyword table exactly as today', async () => {
    const now = Date.now();
    const task = baseTask(now);
    const ledgerPath = join(tempDir, 'ledger.sqlite');
    buildMinimalLedger(ledgerPath, ledgerRowOf(task, 'text'));
    const { fn: runScript, calls } = makeRunScriptRecorder();
    const typedRouteFn = async (): Promise<TypedRouteOutcome> => ({
      kind: 'escalated',
      why: 'typesafe-unavailable:not-configured',
    });
    const acted = await handleReceived(task, now, 'R', ledgerPath, TYPED, { runScript, typedRouteFn });
    assert.equal(acted, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['--task', task.task_id, '--topic', '-100123_5', '--reason', LEGACY_REASON]);
  });

  it('typed routing disabled: typedRouteFn is never called', async () => {
    const now = Date.now();
    const task = baseTask(now);
    const ledgerPath = join(tempDir, 'ledger.sqlite');
    buildMinimalLedger(ledgerPath, ledgerRowOf(task, 'text'));
    const { fn: runScript, calls } = makeRunScriptRecorder();
    const typedRouteFn = async (): Promise<TypedRouteOutcome> => {
      throw new Error('typedRouteFn must not be called when typed routing is disabled');
    };
    const acted = await handleReceived(task, now, 'R', ledgerPath, CFG, { runScript, typedRouteFn });
    assert.equal(acted, true);
    assert.deepEqual(calls[0].args, ['--task', task.task_id, '--topic', '-100123_5', '--reason', LEGACY_REASON]);
  });

  it('typed routing claim-busy or raced leaves the task for the next pass', async () => {
    const now = Date.now();
    const task = baseTask(now);
    for (const outcome of [{ kind: 'claim-busy' as const }, { kind: 'raced' as const }]) {
      const { fn: runScript, calls } = makeRunScriptRecorder();
      const typedRouteFn = async (): Promise<TypedRouteOutcome> => outcome;
      const acted = await handleReceived(task, now, 'R', 'L', TYPED, { runScript, typedRouteFn });
      assert.equal(acted, false);
      assert.equal(calls.length, 0);
    }
  });

  it('typed routing script-failed falls through to the keyword table', async () => {
    const now = Date.now();
    const task = baseTask(now);
    const ledgerPath = join(tempDir, 'ledger.sqlite');
    buildMinimalLedger(ledgerPath, ledgerRowOf(task, 'text'));
    const { fn: runScript, calls } = makeRunScriptRecorder();
    const typedRouteFn = async (): Promise<TypedRouteOutcome> => ({
      kind: 'script-failed',
      action: { kind: 'route', topicKey: '-100123_5', reason: 'r', basis: 'typesafe' },
      scriptExit: 1,
    });
    const acted = await handleReceived(task, now, 'R', ledgerPath, TYPED, { runScript, typedRouteFn });
    assert.equal(acted, true);
    assert.equal(calls.length, 1);
  });

  it('without TYPESAFE_API_KEY the default typed route never calls fetch and routes by the keyword table', async () => {
    const now = Date.now();
    const task = baseTask(now, { request_text: 'book a doctor visit' });
    const ledgerPath = voiceInboxLedgerPath();
    buildMinimalLedger(ledgerPath, ledgerRowOf(task, 'text'));
    writeFileSync(
      join(tempDir, 'telegram-topic-names.json'),
      JSON.stringify({
        '-100123': {
          '0': { name: 'general-knowledge', description: 'default topic' },
          '5': { name: 'invoices' },
          '900': { name: 'inbox' },
        },
      }),
      'utf8'
    );
    const { fn: runScript, calls } = makeRunScriptRecorder();
    delete process.env.TYPESAFE_API_KEY;
    resetTypeSafeClientState();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('', { status: 500 });
    }) as typeof fetch;
    try {
      await runVoiceInboxFallback(
        { now, everyMs: 300_000 },
        {
          nowFn: () => now,
          runScript,
          readConfigFn: () => ({ ...TYPED, keywordTopics: { invoice: '-100123_5' } }),
          ledgerPathFn: () => ledgerPath,
          repoRootFn: async () => 'R',
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
      resetTypeSafeClientState();
    }
    assert.equal(fetchCalls, 0);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('-100123_0'), `expected -100123_0 in ${JSON.stringify(calls[0].args)}`);
    assert.ok(calls[0].args.includes('--create-topic'), `expected --create-topic in ${JSON.stringify(calls[0].args)}`);
  });

  it('readFallbackAppConfig reads voice_inbox.default_topic and an enabled voice_inbox_routing block', () => {
    writeFileSync(
      join(tempDir, 'config.yaml'),
      'voice_inbox:\n  inbox_topic: "-100123_900"\n  default_topic: "-100123_5"\nvoice_inbox_routing:\n  enabled: true\n',
      'utf8'
    );
    const cfg = readFallbackAppConfig();
    assert.deepEqual(cfg, {
      keywordTopics: {},
      inboxTopic: '-100123_900',
      defaultTopic: '-100123_5',
      typedRouting: { actConfidence: 0.9, continueConfidence: 0.9, noMatch: 'create-topic', escalation: 'llm-turn' },
    });
  });

  it('resolveTargetDetailed treats voice_inbox.default_topic as an override and the env wins over it', () => {
    const cfg = { inboxTopic: '-100123_900', keywordTopics: {}, defaultTopic: '-100123_5' };
    assert.deepEqual(resolveTargetDetailed('x', cfg), { topic: '-100123_5', basis: 'override' });
    process.env.PA_VOICE_INBOX_FALLBACK_DEFAULT_TOPIC = '-100123_7';
    assert.deepEqual(resolveTargetDetailed('x', cfg), { topic: '-100123_7', basis: 'override' });
  });

  it('buildVoiceRouteRetryMessage names the given default topic', () => {
    const base = { taskId: 'vi-x', topicKey: '-100123_900', requestText: 'x', repoRoot: 'R', topicNamesPath: 'T' };
    assert.ok(buildVoiceRouteRetryMessage({ ...base, defaultTopic: '-100123_5' }).includes('default topic -100123_5'));
    assert.ok(buildVoiceRouteRetryMessage(base).includes('default topic -100123_0'));
  });
});
