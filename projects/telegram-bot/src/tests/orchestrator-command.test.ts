/**
 * AI-203 WP-2 — /orchestrator command semantics (logic.ts) plus the
 * isKnownCommand / guardUnknownCommand pinning the spec's gate names.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmRetry } from './rm-retry.js';
import type { ConversationState } from '../types.js';

let sharedTempDir = '';

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'orch-cmd-test-'));
  process.env.PA_HOME = sharedTempDir;
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

// Dynamic imports after PA_HOME is set (dispatch-error-paths.test.ts pattern).
const { handleOrchestratorCommand, isKnownCommand, guardUnknownCommand, ORCHESTRATOR_PATTERN } =
  await import('../logic.js');

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;

function makeState(extra: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: CHAT_ID, last_update_id: 0, thread_id: THREAD_ID, turns: [], ...extra };
}

describe('ORCHESTRATOR_PATTERN', () => {
  it('matches bare/status/on/off and @botname forms; rejects lookalikes', () => {
    assert.ok(ORCHESTRATOR_PATTERN.test('/orchestrator'));
    assert.ok(ORCHESTRATOR_PATTERN.test('/orchestrator status'));
    assert.ok(ORCHESTRATOR_PATTERN.test('/orchestrator on'));
    assert.ok(ORCHESTRATOR_PATTERN.test('/orchestrator off'));
    assert.ok(ORCHESTRATOR_PATTERN.test('/orchestrator@mybot on'));
    assert.ok(ORCHESTRATOR_PATTERN.test('/ORCHESTRATOR ON')); // i flag + lowercase arg handling
    assert.ok(!ORCHESTRATOR_PATTERN.test('/orchestrators'));
    assert.ok(!ORCHESTRATOR_PATTERN.test('/orchestrator bogus'));
  });
});

describe('handleOrchestratorCommand', () => {
  it('T-C1: on arms the flag, returns the frozen text, clearSession true', () => {
    const state = makeState();
    const r = handleOrchestratorCommand('/orchestrator on', state, []);
    assert.equal(state.orchestrator_enabled, true);
    assert.equal(r.clearSession, true);
    assert.equal(
      r.response,
      '🧭 Orchestrator mode ON. This conversation now routes work instead of executing it; execution happens in spawned threads. Conversation context reset.'
    );
  });

  it('T-C2: off disarms the flag, returns the frozen text, clearSession true', () => {
    const state = makeState({ orchestrator_enabled: true });
    const r = handleOrchestratorCommand('/orchestrator off', state, []);
    assert.ok(!('orchestrator_enabled' in state));
    assert.equal(r.clearSession, true);
    assert.equal(
      r.response,
      '🧭 Orchestrator mode OFF. Back to normal execution in this topic. Conversation context reset.'
    );
  });

  it('T-C3: bare status renders OFF + No threads, clearSession false, flag untouched', () => {
    const state = makeState();
    const r = handleOrchestratorCommand('/orchestrator', state, []);
    assert.ok(!('orchestrator_enabled' in state));
    assert.equal(r.clearSession, false);
    assert.equal(r.response, '🧭 Orchestrator mode: OFF.\nNo threads.');
  });

  it('T-C4: status renders one line per thread', () => {
    const state = makeState({ orchestrator_enabled: true });
    const now = new Date().toISOString();
    const threads = [
      { id: 't-1', n: 1, title: 'Sweep logs', goal: 'g', status: 'running', createdAt: now, updatedAt: now, workdir: 'C:/w', runSeq: 0, attempts: 0, pendingInput: [] },
      { id: 't-2', n: 2, title: 'Research', goal: 'g', status: 'done', createdAt: now, updatedAt: now, workdir: 'C:/w', runSeq: 0, attempts: 0, pendingInput: [] },
    ] as const;
    const r = handleOrchestratorCommand('/orchestrator status', state, threads as any);
    assert.equal(r.clearSession, false);
    assert.ok(r.response.includes('🧭 Orchestrator mode: ON.'));
    assert.ok(r.response.includes('- t-1 — Sweep logs (running) · updated 0m'));
    assert.ok(r.response.includes('- t-2 — Research (done) · updated 0m'));
    assert.ok(!r.response.includes('queued'));
  });

  it('T-C4b: a thread with queued steer input carries the +<k> queued suffix', () => {
    const state = makeState({ orchestrator_enabled: true });
    const now = new Date().toISOString();
    const threads = [
      { id: 't-1', n: 1, title: 'Sweep logs', goal: 'g', status: 'running', createdAt: now, updatedAt: now, workdir: 'C:/w', runSeq: 0, attempts: 0, pendingInput: ['x'] },
      { id: 't-2', n: 2, title: 'Research', goal: 'g', status: 'done', createdAt: now, updatedAt: now, workdir: 'C:/w', runSeq: 0, attempts: 0, pendingInput: [] },
    ] as const;
    const r = handleOrchestratorCommand('/orchestrator status', state, threads as any);
    assert.ok(r.response.includes('- t-1 — Sweep logs (running) · updated 0m · +1 queued'));
    assert.ok(r.response.includes('- t-2 — Research (done) · updated 0m'));
    assert.ok(!r.response.includes('Research (done) · updated 0m · +'));
  });
});

describe('unknown-command guard integration', () => {
  it('T-C5: /orchestrator is a known command', () => {
    assert.equal(isKnownCommand('/orchestrator'), true);
    assert.equal(isKnownCommand('orchestrator'), true);
  });

  it('T-C6: guardUnknownCommand passes /orchestrator through', () => {
    assert.equal(guardUnknownCommand('/orchestrator'), undefined);
    assert.equal(guardUnknownCommand('/orchestrator on'), undefined);
  });

  it('T-C7: guardUnknownCommand still eats an unknown slash command', () => {
    const r = guardUnknownCommand('/foo');
    assert.ok(r);
    assert.ok(r.response.includes('Unknown command: /foo'));
    assert.equal(r.skipWorker, true);
  });
});
