/**
 * Worker tunables at the BOT level: /llm, /effort, the /default <setting>
 * extension, the 4-tier cascade's lifecycle, and the injection of resolved args
 * into every executeWorker dispatch site.
 *
 * The pure resolution layer itself (pa/src/lib/tunables.ts) is tested in pa's
 * own suite. What is tested here is everything the bot owns: parsing, the
 * session tier's IST-day expiry, worker-scoped isolation across a /model switch,
 * strict-on-knob / free-on-value command behavior, and — end to end, by actually
 * spawning a worker — that the resolved args reach the child process's argv.
 *
 * Isolation: each dispatch case writes its own config.yaml into a fresh PA_HOME,
 * mirroring dispatch-error-paths.test.ts.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';

import {
  parseTunableCommand,
  setSessionTunable,
  setTopicTunable,
  expireTunableOverrides,
  clearSessionTunables,
  clearTopicContext,
  handleResetCommand,
  handleNewCommand,
  renderTunableReport,
  renderTunableSetResult,
  renderTunableClearResult,
  tunableStampKey,
} from '../logic.js';
import {
  resolveTunable,
  selectWorkerTunables,
  validateTunable,
} from '../../../../pa/dist/src/lib/tunables.js';

const testRunId = `test-${process.pid}-${Date.now()}`;

let sharedTempDir: string;

before(async () => {
  sharedTempDir = await mkdtemp(join(tmpdir(), 'tunables-cmd-test-'));
  process.env.PA_HOME = sharedTempDir;
  await writeFile(join(sharedTempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
  await writeFile(join(sharedTempDir, 'rate-limit-state.json'), '{}', 'utf8');
});

after(async () => {
  delete process.env.PA_HOME;
  await rmRetry(sharedTempDir);
});

const { handleTunableCommand, buildDispatchExtraArgs, dispatchMessage } = await import('../main.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeState(extra: Partial<ConversationState> = {}): ConversationState {
  return { chat_id: 1, last_update_id: 0, thread_id: 0, turns: [], ...extra };
}

/**
 * Mirrors the real shapes in ~/.pa/config.yaml (agy/claude style vs codex style).
 *
 * agy declares `supersedes` because its two knobs are NOT independent: the
 * reasoning effort is embedded in its gemini model names (gemini-3.6-flash-high)
 * and its Claude-family models reject --effort outright, so sending both fails
 * the dispatch (verified live against agy v1.1.5, 2026-07-22).
 */
const AGY: any = {
  name: 'agy',
  command: 'agy',
  args: [],
  tunables: {
    model: { args: ['--model', '{value}'], description: 'Model id.', supersedes: ['effort'] },
    effort: { args: ['--effort', '{value}'], values: ['low', 'medium', 'high'] },
  },
};

/** gemini declares NO effort knob — the case that makes the store worker-scoped. */
const GEMINI: any = {
  name: 'gemini',
  command: 'gemini',
  args: [],
  tunables: {
    model: { args: ['--model', '{value}'] },
  },
};

/** codex expresses effort as `-c key=value`, which a flag+value schema cannot represent. */
const CODEX: any = {
  name: 'codex',
  command: 'codex',
  args: ['-'],
  tunables: {
    model: { args: ['--model', '{value}'] },
    effort: { args: ['-c', 'model_reasoning_effort={value}'], values: ['minimal', 'low', 'medium', 'high'] },
  },
};

/** A worker whose config pins a default, for the third cascade tier. */
const WITH_DEFAULT: any = {
  name: 'defaulty',
  command: 'defaulty',
  args: [],
  tunables: {
    effort: { args: ['--effort', '{value}'], values: ['low', 'high'], default: 'low' },
  },
};

/** A worker with a canonical->native value map. */
const MAPPED: any = {
  name: 'mapped',
  command: 'mapped',
  args: [],
  tunables: {
    effort: { args: ['--level', '{value}'], values: { low: '1', medium: '2', high: '3' } },
  },
};

const CONFIG = { workers: [AGY, GEMINI, CODEX, WITH_DEFAULT, MAPPED] };

function yesterdayIso(): string {
  return new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// parseTunableCommand
// ---------------------------------------------------------------------------

describe('parseTunableCommand', () => {
  it('bare /llm is a show on the model setting, session scope', () => {
    const cmd = parseTunableCommand('/llm');
    assert.deepEqual(cmd, { scope: 'session', label: 'llm', setting: 'model', action: 'show' });
  });

  it('bare /effort is a show on the effort setting', () => {
    const cmd = parseTunableCommand('/effort');
    assert.equal(cmd?.action, 'show');
    assert.equal(cmd?.setting, 'effort');
  });

  it('/llm <name> sets the session override', () => {
    const cmd = parseTunableCommand('/llm gemini-3.6-flash-high');
    assert.equal(cmd?.action, 'set');
    assert.equal(cmd?.scope, 'session');
    assert.equal(cmd?.setting, 'model');
    assert.equal(cmd?.value, 'gemini-3.6-flash-high');
  });

  it('tolerates the @botname suffix and surrounding whitespace', () => {
    const cmd = parseTunableCommand('  /effort@my_bot   high  ');
    assert.equal(cmd?.action, 'set');
    assert.equal(cmd?.value, 'high');
  });

  it('clear / reset / unset / - all mean clear', () => {
    for (const token of ['clear', 'reset', 'unset', '-', 'CLEAR']) {
      assert.equal(parseTunableCommand(`/llm ${token}`)?.action, 'clear', token);
    }
  });

  it('/default <setting> <value> is the topic tier', () => {
    const cmd = parseTunableCommand('/default effort high');
    assert.deepEqual(cmd, { scope: 'topic', label: 'effort', setting: 'effort', action: 'set', value: 'high' });
  });

  it('/default llm <name> maps the llm alias to the model setting', () => {
    const cmd = parseTunableCommand('/default llm sonnet');
    assert.equal(cmd?.scope, 'topic');
    assert.equal(cmd?.setting, 'model');
    assert.equal(cmd?.value, 'sonnet');
  });

  it('/default <setting> with no value shows the topic tier', () => {
    assert.equal(parseTunableCommand('/default effort')?.action, 'show');
  });

  it('never hijacks /default <worker> — order-independent, not just by call site', () => {
    for (const worker of ['claude', 'gemini', 'zclaude', 'codex', 'agy', 'AGY']) {
      assert.equal(parseTunableCommand(`/default ${worker}`), undefined, worker);
    }
  });

  it('ignores bare /default and non-commands', () => {
    assert.equal(parseTunableCommand('/default'), undefined);
    assert.equal(parseTunableCommand('what model are you'), undefined);
    assert.equal(parseTunableCommand('/model agy'), undefined);
  });
});

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

describe('tunable cascade', () => {
  it('resolves to the CLI default (no args) when nothing is set', () => {
    const state = makeState();
    const r = resolveTunable(AGY, 'effort',
      selectWorkerTunables(state.tunable_overrides, 'agy'),
      selectWorkerTunables(state.tunable_defaults, 'agy'));
    assert.equal(r?.tier, 'cli');
    assert.equal(r?.value, undefined);
    assert.deepEqual(r?.args, []);
    assert.equal(buildDispatchExtraArgs(state, AGY), undefined, 'unset contributes ZERO args');
  });

  it('resolves the worker default from config when no user tier is set', () => {
    const state = makeState();
    const r = resolveTunable(WITH_DEFAULT, 'effort', {}, {});
    assert.equal(r?.tier, 'worker');
    assert.equal(r?.value, 'low');
    assert.deepEqual(buildDispatchExtraArgs(state, WITH_DEFAULT), ['--effort', 'low']);
  });

  it('topic default beats the worker default', () => {
    const state = makeState();
    setTopicTunable(state, 'defaulty', 'effort', 'high');
    const r = resolveTunable(WITH_DEFAULT, 'effort',
      selectWorkerTunables(state.tunable_overrides, 'defaulty'),
      selectWorkerTunables(state.tunable_defaults, 'defaulty'));
    assert.equal(r?.tier, 'topic');
    assert.equal(r?.value, 'high');
  });

  it('session override beats the topic default', () => {
    const state = makeState();
    setTopicTunable(state, 'agy', 'effort', 'low');
    setSessionTunable(state, 'agy', 'effort', 'high');
    const r = resolveTunable(AGY, 'effort',
      selectWorkerTunables(state.tunable_overrides, 'agy'),
      selectWorkerTunables(state.tunable_defaults, 'agy'));
    assert.equal(r?.tier, 'session');
    assert.equal(r?.value, 'high');
    assert.deepEqual(buildDispatchExtraArgs(state, AGY), ['--effort', 'high']);
  });

  it('maps a canonical value to its native form on the command line', () => {
    const state = makeState();
    setSessionTunable(state, 'mapped', 'effort', 'high');
    assert.deepEqual(buildDispatchExtraArgs(state, MAPPED), ['--level', '3']);
  });
});

// ---------------------------------------------------------------------------
// Session-tier expiry (IST day boundary), per entry
// ---------------------------------------------------------------------------

describe('expireTunableOverrides', () => {
  it('keeps an override set today', () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high');
    assert.deepEqual(expireTunableOverrides(state), []);
    assert.equal(state.tunable_overrides?.['agy']?.['effort'], 'high');
  });

  it('clears an override set on a previous IST day but keeps the topic default', () => {
    const state = makeState();
    setTopicTunable(state, 'agy', 'effort', 'low');
    setSessionTunable(state, 'agy', 'effort', 'high', yesterdayIso());

    const cleared = expireTunableOverrides(state);

    assert.deepEqual(cleared, [tunableStampKey('agy', 'effort')]);
    assert.equal(state.tunable_overrides, undefined);
    assert.equal(state.tunable_defaults?.['agy']?.['effort'], 'low', 'topic default survives midnight');
    const r = resolveTunable(AGY, 'effort',
      selectWorkerTunables(state.tunable_overrides, 'agy'),
      selectWorkerTunables(state.tunable_defaults, 'agy'));
    assert.equal(r?.tier, 'topic');
    assert.equal(r?.value, 'low');
  });

  it('expires PER ENTRY — a knob set today does not keep yesterday\'s alive', () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high', yesterdayIso());
    setSessionTunable(state, 'agy', 'model', 'gemini-3.6-flash-high');

    const cleared = expireTunableOverrides(state);

    assert.deepEqual(cleared, [tunableStampKey('agy', 'effort')]);
    assert.equal(state.tunable_overrides?.['agy']?.['model'], 'gemini-3.6-flash-high');
    assert.equal(state.tunable_overrides?.['agy']?.['effort'], undefined);
  });

  it('expires an entry whose stamp is missing or unparseable (provenance unknown)', () => {
    const state = makeState({ tunable_overrides: { agy: { effort: 'high', model: 'x' } } });
    state.tunable_overrides_set_at = { [tunableStampKey('agy', 'model')]: 'not-a-date' };

    const cleared = expireTunableOverrides(state);

    assert.equal(cleared.length, 2);
    assert.equal(state.tunable_overrides, undefined);
  });

  it('drops orphaned stamps when no overrides remain', () => {
    const state = makeState();
    state.tunable_overrides_set_at = { 'agy:effort': new Date().toISOString() };
    assert.deepEqual(expireTunableOverrides(state), []);
    assert.equal(state.tunable_overrides_set_at, undefined);
  });
});

// ---------------------------------------------------------------------------
// Worker scoping
// ---------------------------------------------------------------------------

describe('worker-scoped isolation', () => {
  it('switching worker does not leak the previous worker\'s knobs', () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high');
    setSessionTunable(state, 'agy', 'model', 'gemini-3.6-flash-high');

    // /model gemini — gemini declares model only, and nothing was set for it.
    assert.equal(buildDispatchExtraArgs(state, GEMINI), undefined);
    // agy's settings are untouched and still apply when it comes back. Only the
    // model reaches the command line (CORRECTED 2026-07-22: this asserted both
    // flags, which agy's CLI rejects) — but BOTH values are still stored, so
    // clearing the model brings the effort back.
    assert.deepEqual(buildDispatchExtraArgs(state, AGY), ['--model', 'gemini-3.6-flash-high']);
    assert.equal(state.tunable_overrides?.['agy']?.['effort'], 'high', 'superseded, not deleted');
    setSessionTunable(state, 'agy', 'model', undefined);
    assert.deepEqual(buildDispatchExtraArgs(state, AGY), ['--effort', 'high']);
  });

  it('REGRESSION: a worker without the rule still sends both knobs', () => {
    const state = makeState();
    setSessionTunable(state, 'codex', 'model', 'gpt-5.4');
    setSessionTunable(state, 'codex', 'effort', 'high');
    assert.deepEqual(
      buildDispatchExtraArgs(state, CODEX),
      ['--model', 'gpt-5.4', '-c', 'model_reasoning_effort=high'],
    );
  });

  it('a value stored under a setting the worker does not declare is ignored', () => {
    const state = makeState({ tunable_overrides: { gemini: { effort: 'high' } } });
    assert.equal(buildDispatchExtraArgs(state, GEMINI), undefined);
  });
});

// ---------------------------------------------------------------------------
// /reset and /new
// ---------------------------------------------------------------------------

describe('/reset and /new vs the two tiers', () => {
  it('clearTopicContext drops session overrides and keeps topic defaults', () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high');
    setTopicTunable(state, 'agy', 'effort', 'low');

    clearTopicContext(state);

    assert.equal(state.tunable_overrides, undefined);
    assert.equal(state.tunable_overrides_set_at, undefined);
    assert.equal(state.tunable_defaults?.['agy']?.['effort'], 'low');
  });

  it('/reset clears session overrides, topic defaults survive', () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'model', 'x');
    setTopicTunable(state, 'agy', 'model', 'y');
    handleResetCommand(state);
    assert.equal(state.tunable_overrides, undefined);
    assert.equal(state.tunable_defaults?.['agy']?.['model'], 'y');
  });

  it('/new clears session overrides, topic defaults survive', () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'model', 'x');
    setTopicTunable(state, 'agy', 'model', 'y');
    handleNewCommand(state, '/new');
    assert.equal(state.tunable_overrides, undefined);
    assert.equal(state.tunable_defaults?.['agy']?.['model'], 'y');
  });

  it('clearSessionTunables reports whether anything was cleared', () => {
    const state = makeState();
    assert.equal(clearSessionTunables(state), false);
    setSessionTunable(state, 'agy', 'model', 'x');
    assert.equal(clearSessionTunables(state), true);
  });
});

// ---------------------------------------------------------------------------
// handleTunableCommand — strict on the knob, free on the value
// ---------------------------------------------------------------------------

const noObserved = async () => [] as string[];

describe('handleTunableCommand', () => {
  it('rejects a setting the current worker does not declare, listing what it DOES support', async () => {
    const state = makeState({ preferred_worker: 'gemini' });
    const reply = await handleTunableCommand(
      parseTunableCommand('/effort high')!, state, CONFIG, 'agy', noObserved);

    assert.match(reply, /no setting called 'effort'/);
    assert.match(reply, /supports: model/);
    assert.equal(state.tunable_overrides, undefined, 'nothing is stored for a rejected knob');
  });

  it('rejects an unknown setting name outright', async () => {
    const state = makeState();
    const reply = await handleTunableCommand(
      parseTunableCommand('/default temperature 0.7')!, state, CONFIG, 'agy', noObserved);
    assert.match(reply, /no setting called 'temperature'/);
    assert.equal(state.tunable_defaults, undefined);
  });

  it('accepts a known value with no warning and reports the exact args', async () => {
    const state = makeState();
    const reply = await handleTunableCommand(
      parseTunableCommand('/effort high')!, state, CONFIG, 'agy', noObserved);

    assert.doesNotMatch(reply, /Not a known value/);
    assert.match(reply, /--effort high/);
    assert.equal(state.tunable_overrides?.['agy']?.['effort'], 'high');
  });

  it('NEVER rejects an unrecognised value — it passes it through with a note', async () => {
    const state = makeState();
    const reply = await handleTunableCommand(
      parseTunableCommand('/effort ludicrous')!, state, CONFIG, 'agy', noObserved);

    assert.match(reply, /Not a known value/);
    assert.match(reply, /passing through/i);
    assert.equal(state.tunable_overrides?.['agy']?.['effort'], 'ludicrous', 'stored anyway');
    assert.deepEqual(buildDispatchExtraArgs(state, AGY), ['--effort', 'ludicrous']);
  });

  it('accepts any model name — an allowlist would already be stale', async () => {
    const state = makeState();
    const reply = await handleTunableCommand(
      parseTunableCommand('/llm gemini-9.9-flash-nonexistent')!, state, CONFIG, 'agy', noObserved);
    assert.doesNotMatch(reply, /Not a known value/, 'no declared values for model => nothing to warn about');
    assert.equal(state.tunable_overrides?.['agy']?.['model'], 'gemini-9.9-flash-nonexistent');
  });

  it('/default <setting> <value> writes the TOPIC tier, not the session tier', async () => {
    const state = makeState();
    await handleTunableCommand(
      parseTunableCommand('/default effort low')!, state, CONFIG, 'agy', noObserved);
    assert.equal(state.tunable_defaults?.['agy']?.['effort'], 'low');
    assert.equal(state.tunable_overrides, undefined);
  });

  it('clearing a session override falls back to the topic default and says so', async () => {
    const state = makeState();
    setTopicTunable(state, 'agy', 'effort', 'low');
    setSessionTunable(state, 'agy', 'effort', 'high');

    const reply = await handleTunableCommand(
      parseTunableCommand('/effort clear')!, state, CONFIG, 'agy', noObserved);

    assert.match(reply, /Cleared session override/);
    assert.match(reply, /Now: low/);
    assert.match(reply, /topic default/);
    assert.equal(state.tunable_overrides, undefined);
    assert.deepEqual(buildDispatchExtraArgs(state, AGY), ['--effort', 'low']);
  });

  it('clearing the topic default too leaves the CLI to decide', async () => {
    const state = makeState();
    setTopicTunable(state, 'agy', 'effort', 'low');
    const reply = await handleTunableCommand(
      parseTunableCommand('/default effort clear')!, state, CONFIG, 'agy', noObserved);
    assert.match(reply, /Cleared topic default/);
    assert.equal(state.tunable_defaults, undefined);
    assert.equal(buildDispatchExtraArgs(state, AGY), undefined);
  });

  it('bare command reports the value, the TIER that set it, and what the worker accepts', async () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high');

    const reply = await handleTunableCommand(
      parseTunableCommand('/effort')!, state, CONFIG, 'agy',
      async () => ['xhigh']);

    assert.match(reply, /Current: high/);
    assert.match(reply, /session override/);
    assert.match(reply, /Known values: low, medium, high/);
    assert.match(reply, /Seen in past runs: xhigh/, 'observed values are shown separately from declared ones');
    assert.match(reply, /\/effort <value>/, 'tells the user how to set it');
  });

  it('bare command on an unset knob says the CLI decides', async () => {
    const state = makeState();
    const reply = await handleTunableCommand(
      parseTunableCommand('/llm')!, state, CONFIG, 'agy', noObserved);
    assert.match(reply, /Current: \(none/);
    assert.match(reply, /CLI's own default/);
  });

  it('bare command surfaces a value pinned in the worker\'s static args', async () => {
    // claude/zclaude ship `--model opusplan` in config.yaml. Reporting "nothing
    // is passed" there would be flatly wrong.
    const pinnedWorker: any = {
      name: 'zclaude',
      command: 'zclaude',
      args: ['-p', '--model', 'opusplan', '--verbose'],
      tunables: { model: { args: ['--model', '{value}'] } },
    };
    const reply = await handleTunableCommand(
      parseTunableCommand('/llm')!, makeState(), { workers: [pinnedWorker] }, 'zclaude', noObserved);

    assert.match(reply, /Current: opusplan/);
    assert.match(reply, /fixed args in config\.yaml/);
  });

  it('a set value takes precedence over the pinned one in the report', async () => {
    const pinnedWorker: any = {
      name: 'zclaude',
      command: 'zclaude',
      args: ['--model', 'opusplan'],
      tunables: { model: { args: ['--model', '{value}'] } },
    };
    const state = makeState();
    setSessionTunable(state, 'zclaude', 'model', 'sonnet');
    const reply = await handleTunableCommand(
      parseTunableCommand('/llm')!, state, { workers: [pinnedWorker] }, 'zclaude', noObserved);

    assert.match(reply, /Current: sonnet/);
    assert.match(reply, /session override/);
  });

  it('bare command for an unsupported knob explains what the worker DOES support', async () => {
    const state = makeState({ preferred_worker: 'gemini' });
    const reply = await handleTunableCommand(
      parseTunableCommand('/effort')!, state, CONFIG, 'agy', noObserved);
    assert.match(reply, /supports: model/);
  });

  it('survives a failing observed-values read (help must never crash)', async () => {
    const state = makeState();
    const reply = await handleTunableCommand(
      parseTunableCommand('/llm')!, state, CONFIG, 'agy',
      async () => { throw new Error('disk on fire'); });
    assert.match(reply, /Current:/);
  });

  it('targets the topic\'s preferred worker over the topic default worker', async () => {
    const state = makeState({ preferred_worker: 'codex' });
    await handleTunableCommand(
      parseTunableCommand('/effort medium')!, state, CONFIG, 'agy', noObserved);
    assert.equal(state.tunable_overrides?.['codex']?.['effort'], 'medium');
    assert.equal(state.tunable_overrides?.['agy'], undefined);
  });

  // -------------------------------------------------------------------------
  // supersedes: the resolution must be EXPLAINED, never silent. A stored value
  // that is not reaching the CLI is the same invisible-behaviour class of bug
  // the whole tunables feature exists to avoid.
  // -------------------------------------------------------------------------

  it('bare /effort says it is superseded, by what, and how to get it back', async () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high');
    setSessionTunable(state, 'agy', 'model', 'claude-sonnet-4-6');

    const reply = await handleTunableCommand(
      parseTunableCommand('/effort')!, state, CONFIG, 'agy', noObserved);

    assert.match(reply, /Current: high/, 'the stored value is still reported');
    assert.match(reply, /NOT passed/);
    assert.match(reply, /model.*claude-sonnet-4-6/);
    assert.match(reply, /Clear the model/);
  });

  it('bare /llm says which knob it is superseding', async () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high');
    setSessionTunable(state, 'agy', 'model', 'gemini-3.6-flash-high');

    const reply = await handleTunableCommand(
      parseTunableCommand('/llm')!, state, CONFIG, 'agy', noObserved);

    assert.match(reply, /Current: gemini-3\.6-flash-high/);
    assert.match(reply, /effort.*NOT passed/);
  });

  it('setting the losing knob accepts it but says it will not be sent', async () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'model', 'claude-sonnet-4-6');

    const reply = await handleTunableCommand(
      parseTunableCommand('/effort high')!, state, CONFIG, 'agy', noObserved);

    assert.equal(state.tunable_overrides?.['agy']?.['effort'], 'high', 'the command is never rejected');
    assert.match(reply, /NOT passed/);
    assert.doesNotMatch(reply, /Args:/, 'there are no args to show — it contributes none');
  });

  it('NO supersede note when only one of the two is set', async () => {
    const state = makeState();
    const reply = await handleTunableCommand(
      parseTunableCommand('/effort high')!, state, CONFIG, 'agy', noObserved);
    assert.doesNotMatch(reply, /NOT passed/);
    assert.match(reply, /--effort high/);
  });

  it('NO supersede note on a worker that declares no rule', async () => {
    const state = makeState({ preferred_worker: 'codex' });
    setSessionTunable(state, 'codex', 'model', 'gpt-5.4');
    const reply = await handleTunableCommand(
      parseTunableCommand('/effort high')!, state, CONFIG, 'codex', noObserved);
    assert.doesNotMatch(reply, /NOT passed/);
    assert.match(reply, /model_reasoning_effort=high/);
  });
});

// ---------------------------------------------------------------------------
// Renderers (pure)
// ---------------------------------------------------------------------------

describe('tunable renderers', () => {
  it('renderTunableReport returns the validation error verbatim when unsupported', () => {
    const validation = validateTunable(GEMINI, 'effort');
    const out = renderTunableReport({ worker: 'gemini', label: 'effort', setting: 'effort', validation });
    assert.equal(out, validation.error);
  });

  it('renderTunableSetResult warns only for an unrecognised value', () => {
    const base = { worker: 'agy', setting: 'effort', scope: 'session' as const, args: ['--effort', 'x'] };
    assert.doesNotMatch(renderTunableSetResult({ ...base, value: 'high', known: true }), /⚠️/);
    assert.match(renderTunableSetResult({ ...base, value: 'x', known: false }), /⚠️/);
  });

  it('renderTunableSetResult flags a value that was stored but is superseded', () => {
    const resolved = resolveTunable(AGY, 'effort', { effort: 'high', model: 'claude-sonnet-4-6' }, {});
    const out = renderTunableSetResult({
      worker: 'agy', setting: 'effort', scope: 'session', value: 'high', known: true,
      args: resolved?.args ?? [], resolved,
    });
    assert.match(out, /effort → \*high\*/, 'the set still succeeded');
    assert.match(out, /NOT passed/);
    assert.match(out, /claude-sonnet-4-6/);
  });

  it('renderTunableSetResult stays unchanged when nothing is superseded', () => {
    const resolved = resolveTunable(AGY, 'effort', { effort: 'high' }, {});
    const out = renderTunableSetResult({
      worker: 'agy', setting: 'effort', scope: 'session', value: 'high', known: true,
      args: resolved?.args ?? [], resolved,
    });
    assert.doesNotMatch(out, /NOT passed/);
    assert.match(out, /Args: `--effort high`/);
  });

  it('renderTunableClearResult names the tier now in effect', () => {
    const resolved = resolveTunable(AGY, 'effort', {}, { effort: 'low' });
    const out = renderTunableClearResult({ worker: 'agy', setting: 'effort', scope: 'session', resolved });
    assert.match(out, /Now: low/);
    assert.match(out, /topic default/);
  });

  it('renderTunableClearResult falls back to the pinned static arg, not "nothing"', () => {
    const resolved = resolveTunable(AGY, 'model', {}, {});
    const out = renderTunableClearResult({
      worker: 'zclaude', setting: 'model', scope: 'session', resolved, pinned: ['opusplan'],
    });
    assert.match(out, /Now: opusplan/);
    assert.match(out, /fixed args/);
  });
});

// ---------------------------------------------------------------------------
// buildDispatchExtraArgs — merge semantics at the resume site
// ---------------------------------------------------------------------------

describe('buildDispatchExtraArgs merge', () => {
  it('returns undefined (not []) when nothing is set and there are no base args', () => {
    assert.equal(buildDispatchExtraArgs(makeState(), AGY), undefined);
  });

  it('passes base resume args through untouched when no tunables are set', () => {
    assert.deepEqual(buildDispatchExtraArgs(makeState(), AGY, ['--conversation', 'abc']), ['--conversation', 'abc']);
  });

  it('APPENDS tunables after the resume args — the resume args must survive', () => {
    const state = makeState();
    setSessionTunable(state, 'agy', 'effort', 'high');
    assert.deepEqual(
      buildDispatchExtraArgs(state, AGY, ['--conversation', 'abc']),
      ['--conversation', 'abc', '--effort', 'high'],
    );
  });

  it('keeps extraArgs[0] === "resume" so worker-exec\'s codex splice still fires', () => {
    const state = makeState();
    setSessionTunable(state, 'codex', 'effort', 'high');
    const args = buildDispatchExtraArgs(state, CODEX, ['resume', 'session-id']);
    assert.equal(args?.[0], 'resume');
    assert.deepEqual(args, ['resume', 'session-id', '-c', 'model_reasoning_effort=high']);
  });

  it('handles an unknown worker config without throwing', () => {
    assert.equal(buildDispatchExtraArgs(makeState(), undefined), undefined);
    assert.deepEqual(buildDispatchExtraArgs(makeState(), undefined, ['--resume', 'x']), ['--resume', 'x']);
  });
});

// ---------------------------------------------------------------------------
// End to end: the resolved args actually reach the spawned process's argv
// ---------------------------------------------------------------------------

describe('dispatchMessage injects tunable args into the worker command line', () => {
  let testDir: string;
  let argvOut: string;
  let echoScript: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'tunables-dispatch-'));
    process.env.PA_HOME = testDir;
    argvOut = join(testDir, 'argv.json');
    echoScript = join(testDir, 'echo-args.cjs');
    await writeFile(join(testDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(testDir, 'rate-limit-state.json'), '{}', 'utf8');
    await writeFile(
      echoScript,
      'require("fs").writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n'
      + 'process.stdout.write("ok");\n',
      'utf8',
    );
  });

  afterEach(async () => {
    process.env.PA_HOME = sharedTempDir;
    await rmRetry(testDir);
  });

  async function writeConfigWithTunables(workerNames: string[]) {
    const config = {
      workers: workerNames.map((name, i) => ({
        name,
        command: 'node',
        args: [echoScript],
        input_mode: 'stdin-text',
        output_format: 'text',
        check: 'echo ok',
        rate_limit_patterns: [],
        priority: i + 1,
        state_dir: '/nonexistent/path',
        state_pattern: '*.jsonl',
        tunables: {
          model: { args: ['--model', '{value}'] },
          effort: { args: ['--effort', '{value}'], values: ['low', 'medium', 'high'] },
        },
      })),
    };
    await writeFile(join(testDir, 'config.yaml'), JSON.stringify(config), 'utf8');
  }

  async function readArgv(): Promise<string[]> {
    return JSON.parse(await readFile(argvOut, 'utf8'));
  }

  it('preferred-worker site receives the resolved args', async () => {
    await writeConfigWithTunables(['zclaude', 'claude']);
    const state = makeState({ preferred_worker: 'zclaude' });
    setSessionTunable(state, 'zclaude', 'effort', 'high');
    setTopicTunable(state, 'zclaude', 'model', 'opus');

    const result = await dispatchMessage(
      'hello', undefined, undefined, state, { ARGV_OUT: argvOut }, `topic-999_${testRunId}-pref`, 'claude');

    assert.equal(result.dispatchedWorker, 'zclaude');
    assert.deepEqual(await readArgv(), ['--model', 'opus', '--effort', 'high']);
  });

  it('default-worker site receives the resolved args', async () => {
    await writeConfigWithTunables(['zclaude', 'claude']);
    const state = makeState();
    setSessionTunable(state, 'zclaude', 'model', 'sonnet');

    const result = await dispatchMessage(
      'hello', undefined, undefined, state, { ARGV_OUT: argvOut }, `topic-999_${testRunId}-def`, 'zclaude');

    assert.equal(result.dispatchedWorker, 'zclaude');
    assert.deepEqual(await readArgv(), ['--model', 'sonnet']);
  });

  it('passes NOTHING when no tunable is set (byte-identical to pre-feature dispatch)', async () => {
    await writeConfigWithTunables(['zclaude', 'claude']);
    const result = await dispatchMessage(
      'hello', undefined, undefined, makeState(), { ARGV_OUT: argvOut }, `topic-999_${testRunId}-none`, 'zclaude');

    assert.equal(result.dispatchedWorker, 'zclaude');
    assert.deepEqual(await readArgv(), []);
  });

  it('does not leak another worker\'s tunables to the worker actually dispatched', async () => {
    await writeConfigWithTunables(['zclaude', 'claude']);
    const state = makeState();
    setSessionTunable(state, 'claude', 'effort', 'high');   // set for a DIFFERENT worker

    await dispatchMessage(
      'hello', undefined, undefined, state, { ARGV_OUT: argvOut }, `topic-999_${testRunId}-leak`, 'zclaude');

    assert.deepEqual(await readArgv(), []);
  });
});
