import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { parseTunables } from '../src/config.js';
import type { TunableSpec, WorkerConfig } from '../src/types.js';
import {
  TUNABLE_TIER_LABELS,
  buildTunableArgs,
  clearWorkerTunables,
  declaredValues,
  describeTunable,
  describeTunables,
  extractTunableValues,
  getTunableSpec,
  isKnownValue,
  listTunables,
  mergeTunableArgs,
  normalizeTunableName,
  resolveTunable,
  resolveTunableArgs,
  resolveTunables,
  selectWorkerTunables,
  setWorkerTunable,
  supportsTunable,
  toCanonicalValue,
  toNativeValue,
  validateTunable,
} from '../src/lib/tunables.js';
import {
  readObservedTunableValues,
  readObservedTunableValuesForWorker,
  readRecentExtraArgs,
} from '../src/lib/tunables-observed.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function worker(name: string, tunables?: Record<string, TunableSpec>): WorkerConfig {
  return {
    name,
    command: 'echo',
    args: ['hi'],
    check: 'echo ok',
    rate_limit_patterns: [],
    priority: 1,
    ...(tunables ? { tunables } : {}),
  };
}

/**
 * agy-shaped: plain --flag value templates, closed effort vocabulary, and the
 * `supersedes` rule the real agy needs.
 *
 * Verified live against agy v1.1.5 on 2026-07-22: `--model gemini-3.6-flash`
 * alone is REJECTED (the CLI demands an effort), `--model gemini-3.6-flash-high`
 * is fine (the suffix IS the effort), and `--model claude-sonnet-4-6 --effort
 * high` is rejected with "--effort is not supported". Model and effort are
 * therefore NOT independent knobs on this worker, and the fixture says so.
 */
const agy = worker('agy', {
  model: { args: ['--model', '{value}'], description: 'Model for the session', supersedes: ['effort'] },
  effort: { args: ['--effort', '{value}'], values: ['low', 'medium', 'high'], description: 'Reasoning effort' },
});

/**
 * codex-shaped: effort is a -c key=value override, not a flag — and the two
 * knobs ARE independent, so no supersedes. Doubles as the regression guard that
 * the rule changes nothing for a worker that does not declare it.
 */
const codex = worker('codex', {
  model: { args: ['--model', '{value}'] },
  effort: { args: ['-c', 'model_reasoning_effort={value}'], values: ['minimal', 'low', 'medium', 'high'] },
});

/** gemini-shaped: model only. The bot uses this to explain why /effort is unavailable. */
const gemini = worker('gemini', { model: { args: ['--model', '{value}'] } });

/** no tunables block at all — must behave exactly as before the feature existed. */
const plain = worker('plain');

/** canonical -> native map: one bot word, a CLI vocabulary that differs. */
const mapped = worker('mapped', {
  effort: { args: ['--thinking', '{value}'], values: { low: '1', medium: '2', high: '3' } },
});

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  return { warnings, restore: () => { console.warn = original; } };
}

// ---------------------------------------------------------------------------
// parseTunables (config shape)
// ---------------------------------------------------------------------------

describe('parseTunables', () => {
  it('returns undefined when a worker declares no tunables', () => {
    assert.equal(parseTunables(undefined, 'w'), undefined);
    assert.equal(parseTunables(null, 'w'), undefined);
  });

  it('parses an args template with default, description and a values list', () => {
    const out = parseTunables({
      effort: {
        args: ['--effort', '{value}'],
        default: ' high ',
        description: '  Reasoning effort  ',
        values: ['low', 'medium', 'high'],
      },
    }, 'agy');
    assert.deepEqual(out, {
      effort: {
        args: ['--effort', '{value}'],
        default: 'high',
        description: 'Reasoning effort',
        values: ['low', 'medium', 'high'],
      },
    });
  });

  it('supports a key=value arg template (codex has no --effort flag)', () => {
    const out = parseTunables({
      effort: { args: ['-c', 'model_reasoning_effort={value}'] },
    }, 'codex');
    assert.deepEqual(out!.effort.args, ['-c', 'model_reasoning_effort={value}']);
  });

  it('parses a canonical->native values map', () => {
    const out = parseTunables({ effort: { args: ['-t', '{value}'], values: { high: 3, low: '1' } } }, 'w');
    assert.deepEqual(out!.effort.values, { high: '3', low: '1' });
  });

  it('lowercases and trims setting names', () => {
    const out = parseTunables({ '  MODEL ': { args: ['--model', '{value}'] } }, 'w');
    assert.deepEqual(Object.keys(out!), ['model']);
  });

  it('coerces a single-string args template to an array', () => {
    const out = parseTunables({ model: { args: '--model={value}' } }, 'w');
    assert.deepEqual(out!.model.args, ['--model={value}']);
  });

  it('SKIPS a tunable with no args template rather than throwing', () => {
    const cap = captureWarnings();
    try {
      const out = parseTunables({ model: { description: 'oops' }, effort: { args: ['--effort', '{value}'] } }, 'w');
      assert.deepEqual(Object.keys(out!), ['effort']);
      assert.ok(cap.warnings.some((w) => /missing required 'args'/.test(w)));
    } finally { cap.restore(); }
  });

  it('SKIPS a template with no {value} placeholder (it would silently drop the value)', () => {
    const cap = captureWarnings();
    try {
      const out = parseTunables({ model: { args: ['--model', 'opus'] } }, 'w');
      assert.equal(out, undefined);
      assert.ok(cap.warnings.some((w) => /no \{value\} placeholder/.test(w)));
    } finally { cap.restore(); }
  });

  it('treats a malformed or empty values declaration as undeclared, keeping the tunable', () => {
    const cap = captureWarnings();
    try {
      const out = parseTunables({
        model: { args: ['--model', '{value}'], values: 'low,high' },
        effort: { args: ['--effort', '{value}'], values: [] },
      }, 'w');
      assert.equal(out!.model.values, undefined);
      assert.equal(out!.effort.values, undefined);
      assert.equal(Object.keys(out!).length, 2);
    } finally { cap.restore(); }
  });

  it('ignores a non-object tunables block', () => {
    const cap = captureWarnings();
    try {
      assert.equal(parseTunables(['model'], 'w'), undefined);
      assert.equal(parseTunables('model', 'w'), undefined);
    } finally { cap.restore(); }
  });

  it('drops an empty default so it falls through to the CLI default', () => {
    const out = parseTunables({ model: { args: ['--model', '{value}'], default: '   ' } }, 'w');
    assert.equal(out!.model.default, undefined);
  });

  it('parses supersedes as a list or a single name, normalized like setting names', () => {
    const list = parseTunables({
      model: { args: ['--model', '{value}'], supersedes: [' Effort ', 'effort', 'thinking'] },
      effort: { args: ['--effort', '{value}'] },
      thinking: { args: ['--thinking', '{value}'] },
    }, 'agy');
    assert.deepEqual(list!.model.supersedes, ['effort', 'thinking']);   // trimmed, lowercased, deduped

    const single = parseTunables({
      model: { args: ['--model', '{value}'], supersedes: 'effort' },
      effort: { args: ['--effort', '{value}'] },
    }, 'agy');
    assert.deepEqual(single!.model.supersedes, ['effort']);
  });

  it('omits supersedes entirely when it is absent or unusable', () => {
    const cap = captureWarnings();
    try {
      assert.equal(parseTunables({ model: { args: ['--model', '{value}'] } }, 'w')!.model.supersedes, undefined);
      assert.equal(parseTunables({ model: { args: ['--model', '{value}'], supersedes: [] } }, 'w')!.model.supersedes, undefined);
      assert.equal(parseTunables({ model: { args: ['--model', '{value}'], supersedes: ['  '] } }, 'w')!.model.supersedes, undefined);
      assert.ok(cap.warnings.some((w) => /no usable setting names/.test(w)));
    } finally { cap.restore(); }
  });

  it('drops a self-reference (a setting that suppressed itself could never be emitted)', () => {
    const cap = captureWarnings();
    try {
      const out = parseTunables({ model: { args: ['--model', '{value}'], supersedes: ['model', 'effort'] }, effort: { args: ['--effort', '{value}'] } }, 'w');
      assert.deepEqual(out!.model.supersedes, ['effort']);
      assert.ok(cap.warnings.some((w) => /lists itself/.test(w)));
    } finally { cap.restore(); }
  });

  it('WARNS BUT KEEPS a supersedes target this worker does not declare', () => {
    // Keeping it costs nothing (it can suppress nothing) and stays correct if
    // the target is added later; the warning is what stops a typo from silently
    // looking like a handled conflict.
    const cap = captureWarnings();
    try {
      const out = parseTunables({ model: { args: ['--model', '{value}'], supersedes: ['efort'] } }, 'agy');
      assert.deepEqual(out!.model.supersedes, ['efort']);
      assert.ok(cap.warnings.some((w) => /supersedes unknown setting 'efort'/.test(w)));
    } finally { cap.restore(); }
  });
});

// ---------------------------------------------------------------------------
// supports / describe
// ---------------------------------------------------------------------------

describe('supports + describe', () => {
  it('lists declared settings in declaration order', () => {
    assert.deepEqual(listTunables(agy), ['model', 'effort']);
    assert.deepEqual(listTunables(gemini), ['model']);
    assert.deepEqual(listTunables(plain), []);
    assert.deepEqual(listTunables(undefined), []);
  });

  it('answers supports(W, S) case-insensitively', () => {
    assert.equal(supportsTunable(agy, 'effort'), true);
    assert.equal(supportsTunable(agy, ' EFFORT '), true);
    assert.equal(supportsTunable(gemini, 'effort'), false);
    assert.equal(supportsTunable(plain, 'model'), false);
    assert.equal(supportsTunable(undefined, 'model'), false);
  });

  it('describes what a worker supports, with declared values for the matrix', () => {
    const d = describeTunables(agy);
    assert.deepEqual(d.map((x) => x.setting), ['model', 'effort']);
    assert.deepEqual(d[1].values, ['low', 'medium', 'high']);
    assert.equal(d[1].mapped, false);
    assert.deepEqual(d[0].values, []);            // model: no declared values, anything goes
    assert.deepEqual(d[0].argsTemplate, ['--model', '{value}']);
  });

  it('marks a canonical->native map and exposes its canonical keys', () => {
    const d = describeTunable(mapped, 'effort')!;
    assert.equal(d.mapped, true);
    assert.deepEqual(d.values, ['low', 'medium', 'high']);
  });

  it('describeTunable returns undefined for an unsupported setting', () => {
    assert.equal(describeTunable(gemini, 'effort'), undefined);
    assert.equal(describeTunable(plain, 'model'), undefined);
  });

  it('getTunableSpec normalizes the name', () => {
    assert.deepEqual(getTunableSpec(codex, 'EFFORT')!.args, ['-c', 'model_reasoning_effort={value}']);
    assert.equal(normalizeTunableName('  Model '), 'model');
  });
});

// ---------------------------------------------------------------------------
// validation: strict on the knob, free on the value
// ---------------------------------------------------------------------------

describe('validateTunable', () => {
  it('accepts a declared setting', () => {
    const v = validateTunable(agy, 'effort');
    assert.equal(v.ok, true);
    assert.deepEqual(v.supported, ['model', 'effort']);
    assert.deepEqual(v.spec!.args, ['--effort', '{value}']);
  });

  it('rejects a setting the worker does not declare and says what it DOES support', () => {
    const v = validateTunable(gemini, 'effort');
    assert.equal(v.ok, false);
    assert.match(v.error!, /no setting called 'effort'/);
    assert.match(v.error!, /supports: model/);
  });

  it('rejects on a worker with no tunables at all', () => {
    const v = validateTunable(plain, 'model');
    assert.equal(v.ok, false);
    assert.match(v.error!, /declares no settable options/);
  });

  it('rejects an empty setting name', () => {
    assert.equal(validateTunable(agy, '   ').ok, false);
  });

  it('NEVER validates a value — unknown values are known-unknown, not rejected', () => {
    // isKnownValue is a display hint only; there is no value-rejecting API at all.
    assert.equal(isKnownValue(agy.tunables!.effort, 'high'), true);
    assert.equal(isKnownValue(agy.tunables!.effort, 'HIGH'), true);
    assert.equal(isKnownValue(agy.tunables!.effort, 'xhigh'), false);
    // nothing declared => nothing to contradict
    assert.equal(isKnownValue(agy.tunables!.model, 'Gemini 3.9 Flash'), true);
    assert.deepEqual(declaredValues(agy.tunables!.model), []);
  });
});

// ---------------------------------------------------------------------------
// the cascade
// ---------------------------------------------------------------------------

describe('resolveTunables cascade', () => {
  const specWithDefault = worker('w', {
    effort: { args: ['--effort', '{value}'], default: 'medium', values: ['low', 'medium', 'high'] },
  });

  it('session beats topic beats worker-default beats cli', () => {
    const all = resolveTunable(specWithDefault, 'effort', { effort: 'high' }, { effort: 'low' })!;
    assert.equal(all.value, 'high');
    assert.equal(all.tier, 'session');

    const topic = resolveTunable(specWithDefault, 'effort', {}, { effort: 'low' })!;
    assert.equal(topic.value, 'low');
    assert.equal(topic.tier, 'topic');

    const wdef = resolveTunable(specWithDefault, 'effort')!;
    assert.equal(wdef.value, 'medium');
    assert.equal(wdef.tier, 'worker');

    const cli = resolveTunable(agy, 'effort')!;
    assert.equal(cli.value, undefined);
    assert.equal(cli.tier, 'cli');
  });

  it('treats blank/whitespace at a tier as UNSET and falls through', () => {
    const r = resolveTunable(specWithDefault, 'effort', { effort: '   ' }, { effort: '' })!;
    assert.equal(r.value, 'medium');
    assert.equal(r.tier, 'worker');
  });

  it('trims a set value', () => {
    const r = resolveTunable(agy, 'model', { model: '  Gemini 3.6 Flash  ' })!;
    assert.equal(r.value, 'Gemini 3.6 Flash');
  });

  it('ignores overrides naming a setting this worker does not declare', () => {
    const r = resolveTunables(gemini, { effort: 'high', model: 'gemini-2.5-pro' });
    assert.deepEqual(r.map((x) => x.setting), ['model']);
    assert.deepEqual(buildTunableArgs(r), ['--model', 'gemini-2.5-pro']);
  });

  it('returns [] for a worker with no tunables (backward compatible)', () => {
    assert.deepEqual(resolveTunables(plain, { model: 'x' }), []);
    assert.deepEqual(resolveTunables(undefined), []);
    assert.deepEqual(resolveTunableArgs(plain, { model: 'x' }), []);
  });

  it('exposes a tier label for every tier', () => {
    for (const tier of ['session', 'topic', 'worker', 'cli'] as const) {
      assert.equal(typeof TUNABLE_TIER_LABELS[tier], 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// toArgs
// ---------------------------------------------------------------------------

describe('buildTunableArgs / resolveTunableArgs', () => {
  it('AN UNSET SETTING CONTRIBUTES ZERO ARGS — not a bare flag, not an empty string', () => {
    const resolved = resolveTunables(agy);                   // nothing set anywhere
    assert.deepEqual(resolved.map((r) => r.tier), ['cli', 'cli']);
    assert.deepEqual(resolved.flatMap((r) => r.args), []);
    const args: string[] = buildTunableArgs(resolved);
    // `[] as string[]` is load-bearing: a bare `[]` infers as never[], which
    // narrows `args` to never[] via assert's assertion signature and makes the
    // .includes() guards below fail to compile.
    assert.deepEqual(args, [] as string[]);
    assert.equal(args.length, 0);
    // Explicit: a bare flag or an empty-string value would both be silent
    // corruption — the CLI would see "--model" with no value, or "" as a value.
    assert.equal(args.includes(''), false);
    assert.equal(args.includes('--model'), false);
    assert.equal(args.includes('--effort'), false);
  });

  it('emits only the settings that ARE set, in declaration order', () => {
    assert.deepEqual(
      resolveTunableArgs(agy, { effort: 'high' }),
      ['--effort', 'high'],
    );
    // CORRECTED 2026-07-22: this previously asserted BOTH knobs were emitted for
    // agy, encoding the assumption that model and effort are independent. They
    // are not — `--model claude-sonnet-4-6 --effort high` is rejected by agy's
    // own CLI, so the old expectation was a command line that fails every
    // dispatch. The independent-knob behaviour is still asserted, on codex,
    // which really does have independent knobs (see the test below).
    assert.deepEqual(
      resolveTunableArgs(agy, { model: 'gemini-3.6-flash-high', effort: 'medium' }),
      ['--model', 'gemini-3.6-flash-high'],
    );
  });

  it('REGRESSION: a worker with no supersedes rule still emits BOTH knobs', () => {
    assert.deepEqual(
      resolveTunableArgs(codex, { model: 'gpt-5.4', effort: 'high' }),
      ['--model', 'gpt-5.4', '-c', 'model_reasoning_effort=high'],
    );
  });

  it('expands a key=value template into exactly two args', () => {
    assert.deepEqual(
      resolveTunableArgs(codex, { effort: 'high' }),
      ['-c', 'model_reasoning_effort=high'],
    );
  });

  it('applies a canonical->native map when building args', () => {
    const r = resolveTunable(mapped, 'effort', { effort: 'high' })!;
    assert.equal(r.value, 'high');     // canonical, for display
    assert.equal(r.native, '3');       // native, for the CLI
    assert.deepEqual(r.args, ['--thinking', '3']);
  });

  it('passes an undeclared value straight through, mapped or not', () => {
    assert.deepEqual(resolveTunableArgs(mapped, { effort: 'ludicrous' }), ['--thinking', 'ludicrous']);
    assert.deepEqual(resolveTunableArgs(agy, { model: 'some-model-that-ships-tomorrow' }),
      ['--model', 'some-model-that-ships-tomorrow']);
  });

  it('MERGES onto caller-built extraArgs instead of overwriting them', () => {
    const resume = ['--resume', 'sess-123'];
    const merged = mergeTunableArgs(resume, resolveTunableArgs(agy, { effort: 'high' }));
    assert.deepEqual(merged, ['--resume', 'sess-123', '--effort', 'high']);
    assert.deepEqual(resume, ['--resume', 'sess-123']);   // caller's array untouched
    assert.deepEqual(mergeTunableArgs(undefined, ['--effort', 'low']), ['--effort', 'low']);
    assert.deepEqual(mergeTunableArgs(resume, []), resume);
  });

  it('toNativeValue/toCanonicalValue round-trip through a map and pass through a list', () => {
    const m = mapped.tunables!.effort;
    assert.equal(toNativeValue(m, 'HIGH'), '3');
    assert.equal(toCanonicalValue(m, '3'), 'high');
    assert.equal(toNativeValue(m, 'unknown'), 'unknown');
    assert.equal(toCanonicalValue(m, 'unknown'), 'unknown');
    assert.equal(toNativeValue(agy.tunables!.effort, 'high'), 'high');
    assert.equal(toCanonicalValue(agy.tunables!.effort, 'high'), 'high');
  });
});

// ---------------------------------------------------------------------------
// supersedes: the config-expressible mutual-exclusion rule
//
// Why it exists: on agy the reasoning effort is EMBEDDED in the model name
// (gemini-3.6-flash-high), and its Claude-family models reject --effort
// outright — so a user who set both would produce a command line agy refuses,
// failing EVERY dispatch in that topic and reading as a worker outage rather
// than a settings mistake. The rule is declared in config (no worker is named
// anywhere in the TypeScript) and honoured by the arg builder.
// ---------------------------------------------------------------------------

describe('supersedes', () => {
  /** Two settings that each claim the other: declaration order must break the tie. */
  const mutual = worker('mutual', {
    a: { args: ['--a', '{value}'], supersedes: ['b'] },
    b: { args: ['--b', '{value}'], supersedes: ['a'] },
  });

  /** A rule pointing at a setting this worker does not declare — a harmless no-op. */
  const dangling = worker('dangling', {
    model: { args: ['--model', '{value}'], supersedes: ['effort'] },
  });

  it('emits ONLY the superseding setting when both are set', () => {
    assert.deepEqual(
      resolveTunableArgs(agy, { model: 'claude-sonnet-4-6', effort: 'high' }),
      ['--model', 'claude-sonnet-4-6'],
    );
  });

  it('is tier-independent — the rule is about the command line, not recency', () => {
    // effort set at the highest tier, model only at the lowest: model still wins,
    // because "both flags together" is what agy rejects regardless of who set what.
    const workerDefaulted = worker('wd', {
      model: { args: ['--model', '{value}'], default: 'gemini-3.1-pro-low', supersedes: ['effort'] },
      effort: { args: ['--effort', '{value}'] },
    });
    assert.deepEqual(
      resolveTunableArgs(workerDefaulted, { effort: 'high' }),
      ['--model', 'gemini-3.1-pro-low'],
    );
  });

  it('effort ALONE is still emitted — the rule only fires when the winner has a value', () => {
    assert.deepEqual(resolveTunableArgs(agy, { effort: 'high' }), ['--effort', 'high']);
    const r = resolveTunable(agy, 'effort', { effort: 'high' })!;
    assert.equal(r.supersededBy, undefined);
    assert.equal(resolveTunable(agy, 'model', { effort: 'high' })!.superseding, undefined);
  });

  it('model ALONE is still emitted', () => {
    assert.deepEqual(resolveTunableArgs(agy, { model: 'gemini-3.6-flash-high' }), ['--model', 'gemini-3.6-flash-high']);
  });

  it('AN UNSET KNOB STILL CONTRIBUTES ZERO ARGS under the rule', () => {
    const args = resolveTunableArgs(agy, {});
    assert.deepEqual(args, [] as string[]);
    assert.equal(args.includes('--model'), false);
    assert.equal(args.includes('--effort'), false);
    assert.equal(args.includes(''), false);
  });

  it('KEEPS the superseded value and tier, and flags BOTH sides for the user', () => {
    const resolved = resolveTunables(agy, { effort: 'high' }, { model: 'claude-sonnet-4-6' });
    const model = resolved.find((r) => r.setting === 'model')!;
    const effort = resolved.find((r) => r.setting === 'effort')!;

    // The loser is suppressed, not forgotten: clearing the model brings it back.
    assert.equal(effort.value, 'high');
    assert.equal(effort.tier, 'session');
    assert.deepEqual(effort.args, []);
    assert.equal(effort.supersededBy, 'model');
    assert.equal(effort.supersededByValue, 'claude-sonnet-4-6');

    // The winner knows what it displaced, so the bare /llm reply can say so.
    assert.deepEqual(model.superseding, ['effort']);
    assert.equal(model.supersededBy, undefined);
    assert.deepEqual(model.args, ['--model', 'claude-sonnet-4-6']);

    // Clearing the winner restores the loser with no further intervention.
    assert.deepEqual(resolveTunableArgs(agy, { effort: 'high' }, {}), ['--effort', 'high']);
  });

  it('AN UNDECLARED VALUE STILL PASSES THROUGH — values are never a gate', () => {
    // A model that ships tomorrow must work tomorrow, rule or no rule.
    const withValues = worker('wv', {
      model: { args: ['--model', '{value}'], values: ['gemini-3.6-flash-high'], supersedes: ['effort'] },
      effort: { args: ['--effort', '{value}'], values: ['low', 'high'] },
    });
    assert.equal(isKnownValue(withValues.tunables!.model, 'gemini-4.0-flash-high'), false);
    assert.deepEqual(
      resolveTunableArgs(withValues, { model: 'gemini-4.0-flash-high', effort: 'high' }),
      ['--model', 'gemini-4.0-flash-high'],
    );
  });

  it('a rule naming an undeclared setting is a harmless no-op', () => {
    assert.deepEqual(resolveTunableArgs(dangling, { model: 'm', effort: 'high' }), ['--model', 'm']);
    assert.equal(resolveTunable(dangling, 'model', { model: 'm' })!.superseding, undefined);
  });

  it('breaks a mutual-supersedes cycle by declaration order instead of emitting nothing', () => {
    const args = resolveTunableArgs(mutual, { a: '1', b: '2' });
    assert.deepEqual(args, ['--a', '1']);
    const b = resolveTunable(mutual, 'b', { a: '1', b: '2' })!;
    assert.equal(b.supersededBy, 'a');
  });

  it('describeTunables exposes the rule (dashboard/help), [] when there is none', () => {
    assert.deepEqual(describeTunable(agy, 'model')!.supersedes, ['effort']);
    assert.deepEqual(describeTunable(agy, 'effort')!.supersedes, []);
    assert.deepEqual(describeTunable(codex, 'model')!.supersedes, []);
  });

  it('a superseded setting is not resurrected by buildTunableArgs', () => {
    // Defence in depth: even if a caller hand-builds a ResolvedTunable with
    // stale args, the supersededBy flag alone must keep them off the command line.
    const forged = [{
      setting: 'effort', value: 'high', native: 'high', tier: 'session' as const,
      args: ['--effort', 'high'], spec: agy.tunables!.effort, supersededBy: 'model',
    }];
    assert.deepEqual(buildTunableArgs(forged), [] as string[]);
  });
});

// ---------------------------------------------------------------------------
// worker-scoped store
// ---------------------------------------------------------------------------

describe('worker-scoped tunable store', () => {
  it('never leaks one worker settings into another', () => {
    let store = setWorkerTunable(undefined, 'agy', 'effort', 'high');
    store = setWorkerTunable(store, 'codex', 'model', 'gpt-5.4');

    assert.deepEqual(selectWorkerTunables(store, 'agy'), { effort: 'high' });
    assert.deepEqual(selectWorkerTunables(store, 'gemini'), {});
    // after /model gemini, gemini resolves nothing even though agy's entry survives
    assert.deepEqual(resolveTunableArgs(gemini, selectWorkerTunables(store, 'gemini')), []);
    assert.deepEqual(resolveTunableArgs(agy, selectWorkerTunables(store, 'agy')), ['--effort', 'high']);
  });

  it('is pure — the input store is never mutated', () => {
    const before = { agy: { effort: 'high' } };
    const after = setWorkerTunable(before, 'agy', 'model', 'x');
    assert.deepEqual(before, { agy: { effort: 'high' } });
    assert.deepEqual(after, { agy: { effort: 'high', model: 'x' } });
    assert.notEqual(before.agy, after.agy);
  });

  it('clearing a setting deletes the key (falls through), and empties are pruned', () => {
    const store = setWorkerTunable({ agy: { effort: 'high' } }, 'agy', 'effort', undefined);
    assert.deepEqual(store, {});
    const blank = setWorkerTunable({ agy: { effort: 'high', model: 'm' } }, 'agy', 'effort', '  ');
    assert.deepEqual(blank, { agy: { model: 'm' } });
  });

  it('clearWorkerTunables drops only that worker', () => {
    const store = { agy: { effort: 'high' }, codex: { model: 'gpt-5.4' } };
    assert.deepEqual(clearWorkerTunables(store, 'agy'), { codex: { model: 'gpt-5.4' } });
    assert.deepEqual(store, { agy: { effort: 'high' }, codex: { model: 'gpt-5.4' } });
  });

  it('normalizes setting names on the way in and out', () => {
    const store = setWorkerTunable(undefined, 'agy', ' EFFORT ', 'high');
    assert.deepEqual(selectWorkerTunables(store, 'agy'), { effort: 'high' });
    assert.deepEqual(selectWorkerTunables(undefined, 'agy'), {});
    assert.deepEqual(selectWorkerTunables({ agy: { effort: '  ' } }, 'agy'), {});
  });
});

// ---------------------------------------------------------------------------
// extraction from observed args (pure)
// ---------------------------------------------------------------------------

describe('extractTunableValues', () => {
  it('pulls the value out of a flag+value template', () => {
    assert.deepEqual(
      extractTunableValues(agy.tunables!.model, ['--print-timeout', '65m', '--model', 'Gemini 3.6 Flash']),
      ['Gemini 3.6 Flash'],
    );
  });

  it('pulls the value out of a key=value template', () => {
    assert.deepEqual(
      extractTunableValues(codex.tunables!.effort, ['-c', 'model_reasoning_effort=high']),
      ['high'],
    );
  });

  it('does not confuse a different -c override for the effort knob', () => {
    assert.deepEqual(extractTunableValues(codex.tunables!.effort, ['-c', 'model="o3"']), []);
  });

  it('returns distinct values in first-seen order', () => {
    assert.deepEqual(
      extractTunableValues(agy.tunables!.model, ['--model', 'a', '--model', 'b', '--model', 'a']),
      ['a', 'b'],
    );
  });

  it('reverse-maps native values to canonical', () => {
    assert.deepEqual(extractTunableValues(mapped.tunables!.effort, ['--thinking', '3']), ['high']);
  });

  it('is empty for junk input', () => {
    assert.deepEqual(extractTunableValues(undefined, ['--model', 'x']), []);
    assert.deepEqual(extractTunableValues(agy.tunables!.model, undefined), []);
    assert.deepEqual(extractTunableValues(agy.tunables!.model, []), []);
    assert.deepEqual(extractTunableValues(agy.tunables!.model, ['--model']), []);      // flag with no value
    assert.deepEqual(extractTunableValues(agy.tunables!.model, ['--effort', 'high']), []);
  });
});

// ---------------------------------------------------------------------------
// observed values (filesystem, must fail soft)
// ---------------------------------------------------------------------------

describe('observed tunable values', () => {
  let tempDir: string;
  let logs: string;
  const NOW = Date.UTC(2026, 6, 22, 12, 0, 0);   // 2026-07-22

  async function writeMeta(skill: string, name: string, meta: unknown): Promise<void> {
    await mkdir(join(logs, skill), { recursive: true });
    await writeFile(join(logs, skill, name), typeof meta === 'string' ? meta : JSON.stringify(meta), 'utf8');
  }

  beforeEach(async () => {
    tempDir = await createTempPaHome();
    logs = join(tempDir, 'logs');
  });

  afterEach(async () => {
    await cleanup(tempDir);
  });

  it('returns [] when the logs directory does not exist (fails soft, never throws)', async () => {
    assert.deepEqual(await readObservedTunableValues(agy, 'model', { dir: join(tempDir, 'nope'), now: NOW }), []);
    assert.deepEqual(await readRecentExtraArgs('agy', { dir: join(tempDir, 'nope'), now: NOW }), []);
    assert.deepEqual(
      await readObservedTunableValuesForWorker(agy, { dir: join(tempDir, 'nope'), now: NOW }),
      { model: [], effort: [] },
    );
  });

  it('returns [] on an empty logs directory and for an unsupported setting', async () => {
    assert.deepEqual(await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW }), []);
    await writeMeta('s1', '20260722-101010-aaaaaa.meta', { worker: 'agy', status: 'success', exitCode: 0, duration: 1, timestamp: '', extraArgs: ['--effort', 'high'] });
    assert.deepEqual(await readObservedTunableValues(gemini, 'effort', { dir: logs, now: NOW }), []);
  });

  it('extracts distinct values across skills, newest run first', async () => {
    await writeMeta('s1', '20260720-101010-aaaaaa.meta', { worker: 'agy', extraArgs: ['--model', 'Gemini 3.5 Flash'] });
    await writeMeta('s2', '20260722-101010-bbbbbb.meta', { worker: 'agy', extraArgs: ['--model', 'Gemini 3.6 Flash', '--effort', 'high'] });
    const models = await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW });
    assert.deepEqual(models, ['Gemini 3.6 Flash', 'Gemini 3.5 Flash']);
    const all = await readObservedTunableValuesForWorker(agy, { dir: logs, now: NOW });
    assert.deepEqual(all.effort, ['high']);
  });

  it('ignores runs from other workers', async () => {
    await writeMeta('s1', '20260722-101010-aaaaaa.meta', { worker: 'codex', extraArgs: ['--model', 'gpt-5.4'] });
    assert.deepEqual(await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW }), []);
    assert.deepEqual(await readObservedTunableValues(codex, 'model', { dir: logs, now: NOW }), ['gpt-5.4']);
  });

  it('skips malformed, truncated and non-meta files without throwing', async () => {
    await writeMeta('s1', '20260722-101010-aaaaaa.meta', '{not json');
    await writeMeta('s1', '20260722-101011-bbbbbb.meta', { worker: 'agy' });                       // no extraArgs
    await writeMeta('s1', '20260722-101012-cccccc.meta', { worker: 'agy', extraArgs: 'nope' });    // wrong type
    await writeMeta('s1', '20260722-101013-dddddd.log', 'plain log, not metadata');
    await writeMeta('s1', '20260722-101014-eeeeee.meta', { worker: 'agy', extraArgs: ['--model', 'ok'] });
    assert.deepEqual(await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW }), ['ok']);
  });

  it('honours maxAgeDays via the filename date prefix', async () => {
    await writeMeta('s1', '20260101-101010-aaaaaa.meta', { worker: 'agy', extraArgs: ['--model', 'ancient'] });
    await writeMeta('s1', '20260721-101010-bbbbbb.meta', { worker: 'agy', extraArgs: ['--model', 'recent'] });
    assert.deepEqual(
      await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW, maxAgeDays: 7 }),
      ['recent'],
    );
    assert.deepEqual(
      (await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW, maxAgeDays: 365 })).sort(),
      ['ancient', 'recent'],
    );
  });

  // maxFiles caps files SCANNED (newest first, across every skill and worker),
  // not matches — a burst of other workers' runs can push older matches out.
  it('honours maxFiles, newest first', async () => {
    await writeMeta('s1', '20260720-101010-aaaaaa.meta', { worker: 'agy', extraArgs: ['--model', 'old'] });
    await writeMeta('s1', '20260722-101010-bbbbbb.meta', { worker: 'agy', extraArgs: ['--model', 'new'] });
    assert.deepEqual(await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW, maxFiles: 1 }), ['new']);
    assert.deepEqual(await readObservedTunableValues(agy, 'model', { dir: logs, now: NOW, maxFiles: 0 }), []);
  });

  it('returns an empty map for a worker with no tunables', async () => {
    assert.deepEqual(await readObservedTunableValuesForWorker(plain, { dir: logs, now: NOW }), {});
    assert.deepEqual(await readObservedTunableValuesForWorker(undefined, { dir: logs, now: NOW }), {});
  });
});
