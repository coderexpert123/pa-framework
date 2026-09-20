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
import type { ConversationState, SessionInfo } from '../types.js';

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

  it('T-C2: off persists orchestrator_enabled = false (explicit opt-out, not a deleted key), returns the frozen text, clearSession true (AI-215)', () => {
    // AI-215: under default-on, `off` must store an explicit `false` so the
    // inverted predicate (`!== false`) reads the opt-out. A deleted key would
    // read as default-on (true) — the opt-out would silently fail.
    const state = makeState({ orchestrator_enabled: true });
    const r = handleOrchestratorCommand('/orchestrator off', state, []);
    assert.equal(state.orchestrator_enabled, false, 'off must persist explicit false, not delete the key');
    assert.equal(r.clearSession, true);
    assert.equal(
      r.response,
      '🧭 Orchestrator mode OFF. Back to normal execution in this topic. Conversation context reset.'
    );
  });

  it('T-C3: bare status renders ON for a keyless topic (default-on), clearSession false, flag untouched (AI-215)', () => {
    // AI-215: a keyless topic is default-on, so /orchestrator status must
    // render ON — not OFF. The flag key stays absent (status never mutates).
    const state = makeState();
    const r = handleOrchestratorCommand('/orchestrator', state, []);
    assert.ok(!('orchestrator_enabled' in state), 'status must not mutate the flag');
    assert.equal(r.clearSession, false);
    assert.equal(r.response, '🧭 Orchestrator mode: ON.\nNo threads.');
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

  it('T-C5b: a queued record renders the generic status interpolation, no +k suffix when input is empty (increment 4)', () => {
    const state = makeState({ orchestrator_enabled: true });
    const now = new Date().toISOString();
    const threads = [
      { id: 't-1', n: 1, title: 'Sweep logs', goal: 'g', status: 'queued', createdAt: now, updatedAt: now, workdir: 'C:/w', runSeq: 0, attempts: 0, pendingInput: [] },
    ] as const;
    const r = handleOrchestratorCommand('/orchestrator status', state, threads as any);
    assert.ok(r.response.includes('- t-1 — Sweep logs (queued) · updated 0m'), `got: ${r.response}`);
    assert.ok(!r.response.includes('+0 queued'));
  });

  // --- AI-215 default-on + opt-out semantics (§6.1 #2) ---

  it('T-COPT1: /orchestrator off on a default-on (keyless) topic persists explicit false and clears the session (AI-215)', () => {
    // A topic that has never had /orchestrator on is default-on. Typing off
    // must store an explicit false (the opt-out) — not delete the key, which
    // would leave it default-on under the inverted predicate.
    const sentinel: SessionInfo = { session_id: 's-1', worker: 'fake', started_at: new Date().toISOString() };
    const state = makeState({ session: sentinel });
    assert.ok(!('orchestrator_enabled' in state), 'fixture starts keyless (default-on)');
    const r = handleOrchestratorCommand('/orchestrator off', state, []);
    assert.equal(state.orchestrator_enabled, false, 'off must persist explicit false on a keyless topic');
    assert.equal(r.clearSession, true, 'off must clear the session (role boundary)');
  });

  it('T-COPT2: /orchestrator on on an opted-out topic sets it back to true (AI-215)', () => {
    // An opted-out topic (orchestrator_enabled = false) can re-arm with on.
    const state = makeState({ orchestrator_enabled: false });
    const r = handleOrchestratorCommand('/orchestrator on', state, []);
    assert.equal(state.orchestrator_enabled, true, 'on must flip an explicit-false opt-out back to true');
    assert.equal(r.clearSession, true);
  });

  it('T-COPT3: /orchestrator status renders OFF for an explicit-false topic (AI-215)', () => {
    // The only way status reads OFF under default-on is an explicit false.
    const state = makeState({ orchestrator_enabled: false });
    const r = handleOrchestratorCommand('/orchestrator status', state, []);
    assert.equal(r.clearSession, false);
    assert.ok(r.response.includes('🧭 Orchestrator mode: OFF.'), `expected OFF for explicit-false; got: ${r.response}`);
  });

  it('T-COPT4: /orchestrator status renders ON for a keyless topic with live threads (AI-215)', () => {
    // A keyless topic with running threads must show ON + the thread list —
    // the default-on invariant is visible in the status card.
    const state = makeState();
    const now = new Date().toISOString();
    const threads = [
      { id: 't-1', n: 1, title: 'Sweep logs', goal: 'g', status: 'running', createdAt: now, updatedAt: now, workdir: 'C:/w', runSeq: 0, attempts: 0, pendingInput: [] },
    ] as const;
    const r = handleOrchestratorCommand('/orchestrator status', state, threads as any);
    assert.ok(r.response.includes('🧭 Orchestrator mode: ON.'), `expected ON for keyless; got: ${r.response}`);
    assert.ok(r.response.includes('- t-1 — Sweep logs (running)'));
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

// ---------------------------------------------------------------------------
// WP-5 (router-as-orchestrator 2026-09-19): the persona-branch skip and the
// /orchestrator deprecation notice — main.ts appends the notice at its call
// site (the handler in logic.ts stays untouched so the state writes and the
// flag-off reversal are exact); these pins hold the frozen surfaces.
// ---------------------------------------------------------------------------
const { personaBranchSkipped, ORCHESTRATOR_ROUTER_NOTICE } = await import('../orchestrator.js');

describe('WP-5 persona-branch skip + /orchestrator deprecation notice', () => {
  it('personaBranchSkipped: live surface AND routed turn only', () => {
    assert.equal(personaBranchSkipped(true, true), true, 'live placement surface + routed turn = persona skipped');
    assert.equal(personaBranchSkipped(false, true), false, 'dark surface keeps today’s persona branch (byte-identity)');
    assert.equal(personaBranchSkipped(true, false), false, 'fail-open/pinned/command turns keep the persona branch');
    assert.equal(personaBranchSkipped(false, false), false);
  });

  it('the deprecation notice is a frozen, apostrophe-free standing line', () => {
    assert.equal(
      ORCHESTRATOR_ROUTER_NOTICE,
      '\n\n_(routing owns placement on routed turns now — this persona stays armed for flag-off)_',
    );
  });
});
