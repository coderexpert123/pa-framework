/**
 * AI-203 WP-1 — orchestrator prompt completeness (item 6: standing-rules +
 * open-items injection) and per-thread worker pin (item 4: validator + route
 * type). The orchestrator is the router; routing WITHOUT operator-confirmed
 * behavioral rules or the topic's queued task list is a correctness gap (it may
 * spawn duplicate work or route against a standing rule). This file pins:
 *
 * - buildOrchestratorPrompt injects `## Open items (short-term)` (from the
 *   shared renderOpenItems helper) and `## Standing rules` (from activeRulesFor,
 *   same 12-rule/1500-char cap as context.ts buildPrompt) between
 *   `## Execution threads` and `## Telegram Metadata`. Both are fail-to-absent
 *   (empty ⇒ no section) — a phantom section is a DEFECT, a missing one when
 *   data exists is a DEFECT.
 * - buildOrchestratorResumedPrompt is UNCHANGED (grounding v2: standing rules
 *   and open items are fresh-prompt-only, matching buildPrompt vs
 *   buildResumedPrompt).
 * - validateSpawnThreadAction accepts an optional `worker` pin (≤16 chars,
 *   /^[a-z0-9_-]+$/i); absent ⇒ no `worker` key (cascade default); invalid ⇒
 *   rejected with a reason.
 * - The PA_META types line teaches `spawn_thread{title,prompt,worker?,depends_on?,model?}`
 *   and a spawn_thread.worker bullet.
 *
 * Fixtures seed the REAL pa/dist stores (appendTask) and write a real
 * feedback-rules.yaml — the same producers the live drain and rules critic use
 * — so a rendering deviation on either side fails here (real producer, real
 * consumer). Synthetic ids only (-1001234567890, threads 5001/5002).
 */
import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'fs/promises';
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendTask } from '../../../../pa/dist/src/lib/topic-tasks.js';
import type { ConversationState } from '../types.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;

let tempDir = '';

before(async () => {
  // A baseline PA_HOME so the dynamic import's module-init (if any reads
  // paHome()) sees a valid home; beforeEach overrides it per test with a fresh
  // dir for store isolation.
  tempDir = await mkdtemp(join(tmpdir(), 'orch-rules-wp1-'));
  process.env.PA_HOME = tempDir;
  await mkdir(join(tempDir, 'topic-threads'), { recursive: true });
});

// Dynamic imports after PA_HOME is set (dispatch-error-paths.test.ts pattern).
const {
  validateSpawnThreadAction,
  buildOrchestratorPrompt,
  buildOrchestratorResumedPrompt,
} = await import('../orchestrator.js');

function makeState(overrides: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: CHAT_ID, last_update_id: 0, thread_id: THREAD_ID, turns: [], ...overrides };
}

/** Write a feedback-rules.yaml with the given active rules (global scope). */
function writeRules(rules: { id: string; key: string; text: string; createdAt: string }[]): void {
  const lines = ['version: 1', 'rules:'];
  for (const r of rules) {
    lines.push(
      `  - id: ${r.id}`,
      `    key: ${r.key}`,
      `    text: "${r.text}"`,
      `    scope: global`,
      `    status: active`,
      `    check: null`,
      `    origin:`,
      `      thread_id: null`,
      `      message_id: null`,
      `      refId: null`,
      `      ts: "${r.createdAt}"`,
      `      decision_ids: []`,
      `    created_at: "${r.createdAt}"`,
      `    superseded_by: null`
    );
  }
  writeFileSync(join(tempDir, 'feedback-rules.yaml'), lines.join('\n') + '\n', 'utf8');
}

beforeEach(async () => {
  // Fresh PA_HOME per test: rules + tasks + brains all live under PA_HOME, so a
  // leftover file from one test would silently satisfy another's "present"
  // assertion (or break a "fail-to-absent" pin). mkdtemp gives isolation.
  tempDir = await mkdtemp(join(tmpdir(), 'orch-rules-wp1-t-'));
  process.env.PA_HOME = tempDir;
  await mkdir(join(tempDir, 'topic-threads'), { recursive: true });
});

afterEach(() => {
  delete process.env.PA_HOME;
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Item 6: standing-rules + open-items injection into buildOrchestratorPrompt
// ---------------------------------------------------------------------------

describe('buildOrchestratorPrompt: standing rules injection (item 6)', () => {
  it('renders ## Standing rules + rule text when active rules exist', async () => {
    writeRules([
      { id: 'r-a1b2c3d4e5f6', key: 'no-latex', text: 'Never use LaTeX in Telegram replies', createdAt: '2026-09-14T09:00:00.000Z' },
    ]);
    const prompt = await buildOrchestratorPrompt('do the thing', makeState(), []);
    assert.ok(prompt.includes('## Standing rules'), 'a topic with active rules MUST carry ## Standing rules (a missing section when rules exist is a DEFECT)');
    assert.ok(prompt.includes('Never use LaTeX in Telegram replies'), 'the rule text must appear');
    assert.ok(prompt.includes('Operator-confirmed behavioral rules from past feedback. Obey them exactly.'), 'the frozen lead line must appear');
  });

  it('omits ## Standing rules when no rules exist (fail-to-absent)', async () => {
    // No feedback-rules.yaml written — activeRulesFor returns [].
    const prompt = await buildOrchestratorPrompt('do the thing', makeState(), []);
    assert.ok(!prompt.includes('## Standing rules'), 'a topic with no rules MUST NOT carry ## Standing rules (a phantom section is a DEFECT)');
  });

  it('places ## Standing rules AFTER ## Execution threads and BEFORE ## Telegram Metadata', async () => {
    writeRules([
      { id: 'r-b2c3d4e5f6a7', key: 'cite-sources', text: 'Always cite sources for factual claims', createdAt: '2026-09-14T10:00:00.000Z' },
    ]);
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    const threadsIdx = prompt.indexOf('## Execution threads');
    const rulesIdx = prompt.indexOf('## Standing rules');
    const metaIdx = prompt.indexOf('## Telegram Metadata');
    assert.ok(threadsIdx >= 0 && rulesIdx > threadsIdx && metaIdx > rulesIdx, '## Standing rules must sit between ## Execution threads and ## Telegram Metadata');
  });

  it('caps at 12 rules / 1500 chars with the frozen overflow line (same cap as buildPrompt)', async () => {
    // 15 short rules — the 12-rule cap binds before the 1500-char cap.
    const rules: { id: string; key: string; text: string; createdAt: string }[] = [];
    for (let i = 0; i < 15; i++) {
      rules.push({
        id: `r-${String(i).padStart(12, '0')}`,
        key: `rule-${i}`,
        text: `Rule number ${i}`,
        // Descending created_at so activeRulesFor's recency-first order is stable.
        createdAt: `2026-09-14T${String(14 - i).padStart(2, '0')}:00:00.000Z`,
      });
    }
    writeRules(rules);
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    const bullets = prompt.match(/^- Rule number \d+$/gm) || [];
    assert.equal(bullets.length, 12, 'exactly 12 rules render (the cap)');
    assert.ok(prompt.includes('(+3 older — pa rules list)'), 'the overflow line names the 3 omitted rules');
  });
});

describe('buildOrchestratorPrompt: open items injection (item 6)', () => {
  it('renders ## Open items (short-term) + the task line when a task is queued', async () => {
    await appendTask(CHAT_ID, THREAD_ID, { title: 'Sweep the logs', prompt: 'Report one line: drain works.', createdBy: 'test' });
    const prompt = await buildOrchestratorPrompt('do the thing', makeState(), []);
    assert.ok(prompt.includes('## Open items (short-term)'), 'a topic with a queued task MUST carry ## Open items (short-term)');
    assert.ok(/- tt-[0-9a-f]{12} — Sweep the logs \(queued \d{2}:\d{2} IST\)/.test(prompt), 'the task line renders id, title and the queued HH:MM IST label');
  });

  it('omits ## Open items when the task store is empty (fail-to-absent)', async () => {
    const prompt = await buildOrchestratorPrompt('do the thing', makeState(), []);
    assert.ok(!prompt.includes('## Open items'), 'a topic with no tasks/notes MUST NOT carry an Open items section');
  });

  it('places ## Open items AFTER ## Execution threads and BEFORE ## Standing rules (buildPrompt order)', async () => {
    await appendTask(CHAT_ID, THREAD_ID, { title: 'A queued task', prompt: 'p', createdBy: 'test' });
    writeRules([
      { id: 'r-c3d4e5f6a7b8', key: 'a-rule', text: 'A standing rule', createdAt: '2026-09-14T11:00:00.000Z' },
    ]);
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    const threadsIdx = prompt.indexOf('## Execution threads');
    const openIdx = prompt.indexOf('## Open items (short-term)');
    const rulesIdx = prompt.indexOf('## Standing rules');
    const metaIdx = prompt.indexOf('## Telegram Metadata');
    assert.ok(threadsIdx >= 0 && openIdx > threadsIdx && rulesIdx > openIdx && metaIdx > rulesIdx, 'order must be: Execution threads → Open items → Standing rules → Telegram Metadata');
  });
});

describe('buildOrchestratorResumedPrompt: grounding v2 (UNCHANGED)', () => {
  it('does NOT inject ## Standing rules or ## Open items (fresh-prompt-only)', async () => {
    await appendTask(CHAT_ID, THREAD_ID, { title: 'Resumed task', prompt: 'p', createdBy: 'test' });
    writeRules([
      { id: 'r-d4e5f6a7b8c9', key: 'resumed-rule', text: 'A standing rule that must NOT appear', createdAt: '2026-09-14T12:00:00.000Z' },
    ]);
    const prompt = await buildOrchestratorResumedPrompt('yes', undefined, 'the sweep plan', []);
    assert.ok(!prompt.includes('## Standing rules'), 'resumed prompt must never carry ## Standing rules (grounding v2)');
    assert.ok(!prompt.includes('## Open items'), 'resumed prompt must never carry ## Open items (grounding v2)');
    assert.ok(!prompt.includes('A standing rule that must NOT appear'), 'rule text must not leak into the resumed prompt');
  });
});

// ---------------------------------------------------------------------------
// Item 4: per-thread worker pin — validator + PA_META teaching
// ---------------------------------------------------------------------------

describe('validateSpawnThreadAction: optional worker pin (item 4)', () => {
  it('accepts a valid worker and returns it on the ok struct', () => {
    const v = validateSpawnThreadAction({ type: 'spawn_thread', title: 'Sweep logs', prompt: 'do the sweep', worker: 'zclaude' });
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.title, 'Sweep logs');
      assert.equal(v.prompt, 'do the sweep');
      assert.equal(v.worker, 'zclaude', 'a valid worker pin rides the ok struct');
    }
  });

  it('absent worker ⇒ ok with NO worker key (cascade default, unchanged)', () => {
    const v = validateSpawnThreadAction({ type: 'spawn_thread', title: 'Sweep logs', prompt: 'do the sweep' });
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal('worker' in v, false, 'absent worker must not produce a worker key (cascade default)');
    }
  });

  it('rejects an empty worker', () => {
    const v = validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'p', worker: '   ' });
    assert.ok(!v.ok);
    if (!v.ok) assert.ok(v.reason.includes('1..16 chars'), `reason names the bound: ${v.reason}`);
  });

  it('rejects a >16-char worker', () => {
    const v = validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'p', worker: 'a'.repeat(17) });
    assert.ok(!v.ok);
    if (!v.ok) assert.ok(v.reason.includes('1..16 chars'), `reason names the bound: ${v.reason}`);
  });

  it('rejects a worker with spaces / invalid characters', () => {
    const v = validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'p', worker: 'claude code' });
    assert.ok(!v.ok);
    if (!v.ok) assert.ok(v.reason.includes('^[a-z0-9_-]+$/i'), `reason names the pattern: ${v.reason}`);
  });

  it('accepts worker pins with underscores and hyphens (codex, agy, zclaude)', () => {
    for (const w of ['claude', 'zclaude', 'agy', 'codex', 'my_worker-1']) {
      const v = validateSpawnThreadAction({ type: 'spawn_thread', title: 't', prompt: 'p', worker: w });
      assert.ok(v.ok, `${w} should be accepted`);
      if (v.ok) assert.equal(v.worker, w);
    }
  });
});

describe('buildOrchestratorPrompt: PA_META worker teaching (item 4)', () => {
  it('the PA_META types line includes spawn_thread{title,prompt,worker?,depends_on?,model?}', async () => {
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    assert.ok(
      prompt.includes('spawn_thread{title,prompt,worker?,depends_on?,model?}'),
      'the PA_META types line must teach the optional worker field'
    );
  });

  it('carries the spawn_thread.worker teaching bullet', async () => {
    const prompt = await buildOrchestratorPrompt('hi', makeState(), []);
    assert.ok(prompt.includes('- spawn_thread.worker:'), 'the spawn_thread.worker bullet must be present');
    assert.ok(prompt.includes('pin this thread to'), 'the bullet names the pin intent');
    assert.ok(prompt.includes('A pinned thread\'s session resumes only on the same worker'), 'the bullet teaches the resume constraint');
  });
});
