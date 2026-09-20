/**
 * Contracts tests (AI-201 WP-A): the §4 widget validator hostile-input matrix
 * and the §5 event vocabulary. `validateInputRequest` is the prompt-injection
 * boundary — the matrix below feeds it exactly the shapes a hostile
 * "widget" JSON would use (unknown kinds/fields, oversize copy, wrong types,
 * prototype-pollution keys, a model-supplied auth_url) and asserts rejection
 * without throwing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_FALLBACK,
  INPUT_KINDS,
  INPUT_LIMITS,
  TASK_EVENT_KINDS,
  isTaskEventKind,
  validateInputAnswer,
  validateInputRequest,
  type InputRequest,
} from '../contracts.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

const VALID_SECRET = { kind: 'secret', prompt: 'Enter the API key', params: { placeholder: 'key' } };
const VALID_TEXT = { kind: 'text', prompt: 'Describe the issue', params: { multiline: true } };
const VALID_CHOICE = { kind: 'choice', prompt: 'Pick one', params: { options: ['alpha', 'beta'] } };
const VALID_CONFIRM = { kind: 'confirm', prompt: 'Proceed?', params: {} };
const VALID_OAUTH = { kind: 'oauth', prompt: 'Grant Google access', params: { provider: 'google' } };
const VALID_FILE = {
  kind: 'file',
  prompt: 'Upload the statement',
  params: { accept: ['.pdf'], max_bytes: 1024 },
};

// The real seven-step questionnaire (SPEC § Fixture, vi-6f1d767dd640) —
// embedded verbatim; tests never read the scratch file.
const FORM_SEVEN_STEPS = [
  {
    id: 'q1-telegram-copies',
    title: 'Telegram copies — mail brief & oracle',
    decide: 'Whether thread 29 stops receiving the mail brief and oracle copies after the ~2-week dual-run, making the inbox their primary surface.',
    options: [
      { label: 'Retire both after the dual-run', note: 'The inbox card reads better; the fixed transition window keeps a fallback while trust builds.' },
      { label: 'Retire oracle only, keep mail copy', note: 'Thread 29 keeps the mail brief text + PDF.' },
      { label: 'Keep both permanently', note: 'Inbox becomes the reading/archive surface only.' },
    ],
    preselected: 'Retire both after the dual-run',
  },
  {
    id: 'q2-paging',
    title: 'Which deliveries page you',
    decide: 'Which skill deliveries fire a web-push page and which land quietly in the Ready section for review at leisure.',
    options: [
      { label: 'As proposed', note: 'Page: morning brief, Dashami guide, invoice, portfolio, every failure. Quiet: evening brief, oracle, ekadashi pings.' },
      { label: 'Page every briefing', note: 'Oracle and the evening brief page too.' },
      { label: 'Page only failures + invoice', note: 'Everything else lands quietly.' },
    ],
    preselected: 'As proposed',
  },
  {
    id: 'q3-one-conversation',
    title: 'One conversation per run',
    decide: 'Whether each skill run creates its own conversation, or runs merge into one conversation per day.',
    locked: true,
    answer: 'One conversation per run — decided 2026-09-13 via the tap-through widget (task vi-5f499f8cd330).',
  },
  {
    id: 'q4-portfolio-dm',
    title: 'Portfolio DM duplicate',
    decide: "Whether the portfolio report's direct Telegram DM stops once inbox web push is trusted.",
    options: [
      { label: 'Retire the DM once push is trusted', note: 'One paging surface; inbox plus thread 29 cover reading and record.' },
      { label: 'Keep the DM, retire thread-29 copy', note: 'The DM stays the paging surface instead.' },
      { label: 'Keep all three', note: 'DM + thread 29 + inbox all receive it.' },
    ],
    preselected: 'Retire the DM once push is trusted',
  },
  {
    id: 'q5-invoice-widget',
    title: 'Invoice approval as inbox choices (v2)',
    decide: "Whether Hemir invoice approval becomes approve/reject/edit choices on the invoice card, replacing the Telegram 'Send now' queue.",
    options: [
      { label: 'Build it in v2', note: 'A one-tap widget action; removes a surface switch mid-approval.' },
      { label: 'Keep Telegram approval', note: "Approval stays a typed 'Send now' in the PA topic." },
      { label: 'Decide later', note: 'After inbox-primary proves out.' },
    ],
    preselected: 'Build it in v2',
  },
  {
    id: 'q6-watchdog',
    title: 'Expected-deliverable-missing watchdog (v2)',
    decide: 'Whether a daily check notices a cron skill that declared inbox output but delivered nothing — the silent-death case.',
    options: [
      { label: 'Build in v2, all contract skills', note: 'A ledger scan against declared skills is cheap and closes the silent gap.' },
      { label: 'Rely on per-skill watchdogs', note: 'Coverage only where built (ekadashi today).' },
      { label: 'Cover only the daily skills', note: 'Mail brief and oracle only.' },
    ],
    preselected: 'Build in v2, all contract skills',
  },
  {
    id: 'q7-oracle-defect',
    title: 'Oracle double-delivery defect',
    decide: 'Whether the observed oracle double-run of 2026-09-13 gets its own defect task now, separate from this design.',
    options: [
      { label: 'File its own task now', note: 'An observed same-day defect with a clean reproduction window.' },
      { label: 'Fold into the retirement wave', note: 'Fixed when the thread-29 copies retire.' },
      { label: 'Wait for a recurrence', note: 'The 24h duplicate guard covers the inbox door meanwhile.' },
    ],
    preselected: 'File its own task now',
  },
];

const VALID_FORM = {
  kind: 'form',
  prompt: "Skill outputs in the inbox — the proposal's remaining choices. One Submit sends every answer at once; each question carries its context inline. Question 3 is already decided and locked.",
  params: { steps: FORM_SEVEN_STEPS },
};

function rejects(input: unknown, expectedFragment?: string): void {
  const result = validateInputRequest(input);
  assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(input)}`);
  if (!result.ok && expectedFragment !== undefined) {
    assert.ok(
      result.error.includes(expectedFragment),
      `error "${result.error}" should mention "${expectedFragment}"`
    );
  }
}

function accepts(input: unknown): InputRequest {
  const result = validateInputRequest(input);
  assert.equal(result.ok, true, `expected acceptance for ${JSON.stringify(input)}`);
  return (result as { ok: true; value: InputRequest }).value;
}

describe('validateInputRequest — valid shapes (one per kind)', () => {
  it('accepts every kind at its valid minimal shape', () => {
    for (const valid of [VALID_SECRET, VALID_TEXT, VALID_CHOICE, VALID_CONFIRM, VALID_OAUTH, VALID_FILE]) {
      const request = accepts(valid);
      assert.equal(request.kind, (valid as { kind: string }).kind);
      assert.equal(request.prompt, (valid as { prompt: string }).prompt);
    }
  });

  it('accepts boundary sizes: 500-char prompt, 100-char placeholder, 6 options of 60 chars', () => {
    accepts({ kind: 'secret', prompt: 'x'.repeat(INPUT_LIMITS.PROMPT_MAX), params: {} });
    accepts({ kind: 'secret', prompt: 'p', params: { placeholder: 'x'.repeat(INPUT_LIMITS.PLACEHOLDER_MAX) } });
    accepts({
      kind: 'choice',
      prompt: 'p',
      params: { options: Array.from({ length: INPUT_LIMITS.CHOICE_OPTIONS_MAX }, () => 'x'.repeat(INPUT_LIMITS.CHOICE_OPTION_MAX)) },
    });
    accepts({
      kind: 'file',
      prompt: 'p',
      params: { accept: ['.a', '.b', '.c', '.d', '.e'], max_bytes: INPUT_LIMITS.FILE_MAX_BYTES_MAX },
    });
  });
});

describe('validateInputRequest — hostile input matrix', () => {
  it('rejects non-objects without throwing', () => {
    for (const hostile of [null, undefined, 42, 'secret', [], true]) {
      rejects(hostile);
    }
  });

  it('rejects missing and unknown top-level fields', () => {
    rejects({ prompt: 'p', params: {} });
    rejects({ kind: 'secret', params: {} });
    rejects({ kind: 'secret', prompt: 'p' });
    rejects({ ...VALID_SECRET, extra: 1 }, 'unknown field');
  });

  it('rejects unknown kinds', () => {
    rejects({ kind: 'widget', prompt: 'p', params: {} });
    rejects({ kind: 'SECRET', prompt: 'p', params: {} });
    rejects({ kind: '', prompt: 'p', params: {} });
    rejects({ kind: 42, prompt: 'p', params: {} });
  });

  it('rejects bad prompts (empty, oversize, wrong type)', () => {
    rejects({ kind: 'secret', prompt: '', params: {} });
    rejects({ kind: 'secret', prompt: 'x'.repeat(INPUT_LIMITS.PROMPT_MAX + 1) });
    rejects({ kind: 'secret', prompt: 42, params: {} });
    rejects({ kind: 'secret', prompt: null, params: {} });
  });

  it('rejects non-object params', () => {
    rejects({ kind: 'confirm', prompt: 'p', params: null });
    rejects({ kind: 'confirm', prompt: 'p', params: 'none' });
    rejects({ kind: 'confirm', prompt: 'p', params: [] });
  });

  it('rejects unknown per-kind param keys — exact-key check', () => {
    rejects({ kind: 'secret', prompt: 'p', params: { nope: 1 } });
    rejects({ kind: 'text', prompt: 'p', params: { foo: 1 } });
    rejects({ kind: 'choice', prompt: 'p', params: { options: ['a'], label: 'x' } });
    rejects({ kind: 'confirm', prompt: 'p', params: { confirmed: true } });
    rejects({ kind: 'file', prompt: 'p', params: { mime: 'application/pdf' } });
  });

  it('rejects a model-supplied auth_url on oauth params (injection boundary)', () => {
    // §4: oauth.auth_url is NEVER model-supplied — the backend mints it. It is
    // not a key of the oauth param set, so the exact-key check must refuse it.
    rejects(
      { kind: 'oauth', prompt: 'p', params: { provider: 'google', auth_url: 'https://evil.example/consent' } },
      'unknown field'
    );
    rejects({ kind: 'oauth', prompt: 'p', params: { auth_url: 'https://evil.example/consent' } });
  });

  it('rejects bad placeholder values', () => {
    rejects({ kind: 'secret', prompt: 'p', params: { placeholder: 'x'.repeat(INPUT_LIMITS.PLACEHOLDER_MAX + 1) } });
    rejects({ kind: 'text', prompt: 'p', params: { placeholder: 42 } });
  });

  it('rejects bad multiline values (strict boolean)', () => {
    rejects({ kind: 'text', prompt: 'p', params: { multiline: 'yes' } });
    rejects({ kind: 'text', prompt: 'p', params: { multiline: 1 } });
    rejects({ kind: 'text', prompt: 'p', params: { multiline: null } });
  });

  it('rejects bad choice option arrays', () => {
    rejects({ kind: 'choice', prompt: 'p', params: {} });
    rejects({ kind: 'choice', prompt: 'p', params: { options: [] } });
    rejects({ kind: 'choice', prompt: 'p', params: { options: Array.from({ length: INPUT_LIMITS.CHOICE_OPTIONS_MAX + 1 }, () => 'a') } });
    rejects({ kind: 'choice', prompt: 'p', params: { options: ['x'.repeat(INPUT_LIMITS.CHOICE_OPTION_MAX + 1)] } });
    rejects({ kind: 'choice', prompt: 'p', params: { options: [''] } });
    rejects({ kind: 'choice', prompt: 'p', params: { options: [42] } });
    rejects({ kind: 'choice', prompt: 'p', params: { options: 'alpha' } });
  });

  it('rejects bad oauth provider values', () => {
    rejects({ kind: 'oauth', prompt: 'p', params: {} });
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'microsoft' } });
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'Google' } });
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 42 } });
  });

  it('rejects bad file accept lists and max_bytes', () => {
    rejects({ kind: 'file', prompt: 'p', params: { accept: [] } });
    rejects({ kind: 'file', prompt: 'p', params: { accept: ['.a', '.b', '.c', '.d', '.e', '.f'] } });
    rejects({ kind: 'file', prompt: 'p', params: { accept: ['pdf'] } });
    rejects({ kind: 'file', prompt: 'p', params: { accept: ['.'] } });
    rejects({ kind: 'file', prompt: 'p', params: { accept: [42] } });
    rejects({ kind: 'file', prompt: 'p', params: { max_bytes: INPUT_LIMITS.FILE_MAX_BYTES_MAX + 1 } });
    rejects({ kind: 'file', prompt: 'p', params: { max_bytes: 1.5 } });
    rejects({ kind: 'file', prompt: 'p', params: { max_bytes: '25' } });
    rejects({ kind: 'file', prompt: 'p', params: { max_bytes: 0 } });
    rejects({ kind: 'file', prompt: 'p', params: { max_bytes: -5 } });
  });

  it('never throws on adversarial structures (prototype keys, deep nesting)', () => {
    const protoAttack = JSON.parse('{"kind":"secret","prompt":"p","params":{"__proto__":{}}}');
    rejects(protoAttack, 'unknown field');
    const nested = JSON.parse('{"kind":"choice","prompt":"p","params":{"options":[{"deep":{"deeper":[1,2,3]}}]}}');
    rejects(nested);
    const constructorAttack = JSON.parse('{"kind":"text","prompt":"p","params":{"constructor":{"x":1}}}');
    rejects(constructorAttack, 'unknown field');
  });
});

describe('validateInputAnswer — §4 answer column', () => {
  it('accepts a secret answer at the 1000-char boundary and rejects beyond', () => {
    const request = accepts(VALID_SECRET);
    assert.equal(validateInputAnswer(request, { kind: 'secret', value: 'x'.repeat(INPUT_LIMITS.SECRET_VALUE_MAX) }).ok, true);
    assert.equal(validateInputAnswer(request, { kind: 'secret', value: 'x'.repeat(INPUT_LIMITS.SECRET_VALUE_MAX + 1) }).ok, false);
    assert.equal(validateInputAnswer(request, { kind: 'secret', value: '' }).ok, false);
  });

  it('accepts a text answer at the 4000-char boundary and rejects beyond', () => {
    const request = accepts(VALID_TEXT);
    assert.equal(validateInputAnswer(request, { kind: 'text', value: 'x'.repeat(INPUT_LIMITS.TEXT_VALUE_MAX) }).ok, true);
    assert.equal(validateInputAnswer(request, { kind: 'text', value: 'x'.repeat(INPUT_LIMITS.TEXT_VALUE_MAX + 1) }).ok, false);
  });

  it('requires a choice answer to exactly equal one offered option', () => {
    const request = accepts(VALID_CHOICE);
    assert.equal(validateInputAnswer(request, { kind: 'choice', value: 'alpha' }).ok, true);
    assert.equal(validateInputAnswer(request, { kind: 'choice', value: 'Alpha' }).ok, false);
    assert.equal(validateInputAnswer(request, { kind: 'choice', value: 'alphabet' }).ok, false);
    assert.equal(validateInputAnswer(request, { kind: 'choice', value: '' }).ok, false);
  });

  it('requires a strictly boolean confirm answer', () => {
    const request = accepts(VALID_CONFIRM);
    assert.equal(validateInputAnswer(request, { kind: 'confirm', confirmed: true }).ok, true);
    assert.equal(validateInputAnswer(request, { kind: 'confirm', confirmed: false }).ok, true);
    assert.equal(validateInputAnswer(request, { kind: 'confirm', confirmed: 'true' }).ok, false);
    assert.equal(validateInputAnswer(request, { kind: 'confirm', confirmed: 1 }).ok, false);
  });

  it('refuses any user answer for oauth requests (auto-answer only)', () => {
    const request = accepts(VALID_OAUTH);
    const result = validateInputAnswer(request, { kind: 'oauth', value: 'x' });
    assert.equal(result.ok, false);
  });

  it('rejects unknown fields and kind mismatches', () => {
    const request = accepts(VALID_SECRET);
    assert.equal(validateInputAnswer(request, { kind: 'secret', value: 'v', extra: 1 }).ok, false);
    assert.equal(validateInputAnswer(request, { kind: 'text', value: 'v' }).ok, false);
    assert.equal(validateInputAnswer(request, null).ok, false);
    assert.equal(validateInputAnswer(request, 'value').ok, false);
  });
});

describe('event vocabulary (§5)', () => {
  it('exposes exactly the eleven spec kinds, in spec order', () => {
    assert.deepEqual([...TASK_EVENT_KINDS], [
      'task.received',
      'task.routed',
      'task.progress',
      'task.input_needed',
      'task.input_received',
      'task.result_ready',
      'task.completed',
      'task.failed',
      'task.cancelled',
      'task.rerouted',
      'task.transcribed',
    ]);
  });

  it('EVENT_FALLBACK covers every kind exactly once with a non-empty ≤200-char string', () => {
    assert.equal(Object.keys(EVENT_FALLBACK).length, TASK_EVENT_KINDS.length);
    for (const kind of TASK_EVENT_KINDS) {
      const fallback = EVENT_FALLBACK[kind];
      assert.equal(typeof fallback, 'string');
      assert.ok(fallback.length >= 1 && fallback.length <= 200, `fallback for ${kind} must be 1..200 chars`);
    }
  });

  it('isTaskEventKind gates the vocabulary', () => {
    for (const kind of TASK_EVENT_KINDS) assert.equal(isTaskEventKind(kind), true);
    for (const bad of ['task.unknown', '', 'TASK.RECEIVED', 42, null, undefined]) {
      assert.equal(isTaskEventKind(bad), false);
    }
  });

  it('widget kind list matches the §4 table exactly', () => {
    assert.deepEqual([...INPUT_KINDS], ['secret', 'text', 'choice', 'oauth', 'file', 'confirm', 'form']);
  });
});

describe('voice-inbox contracts — generalized oauth widget (auth broker)', () => {
  it('accepts every valid oauth param shape', () => {
    accepts({ kind: 'oauth', prompt: 'Grant Google access', params: { provider: 'google' } });
    accepts({
      kind: 'oauth',
      prompt: 'Grant Google access',
      params: { provider: 'google', user_code: 'ABCD-1234' },
    });
    accepts({
      kind: 'oauth',
      prompt: 'Grant Google access',
      params: { provider: 'google', confirmable: true },
    });
  });

  it('rejects a provider outside the frozen list, wrong case, and wrong type', () => {
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'microsoft' } });
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'Google' } });
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 42 } });
  });

  it('rejects a user_code outside 4..16 chars of A-Z, a-z, 0-9 and -', () => {
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'google', user_code: 'abc' } });
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'google', user_code: 'x'.repeat(17) } });
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'google', user_code: '-ABCD' } });
  });

  it('rejects a non-boolean confirmable', () => {
    rejects({ kind: 'oauth', prompt: 'p', params: { provider: 'google', confirmable: 'yes' } });
  });

  it('still rejects a model-supplied auth_url as an unknown field', () => {
    rejects(
      { kind: 'oauth', prompt: 'p', params: { provider: 'google', auth_url: 'https://evil.example/consent' } },
      'unknown field'
    );
  });

  it('accepts an oauth answer only when the request is confirmable', () => {
    const confirmable = accepts({
      kind: 'oauth',
      prompt: 'Grant Google access',
      params: { provider: 'google', confirmable: true },
    });
    assert.equal(validateInputAnswer(confirmable, { kind: 'oauth', confirmed: true }).ok, true);

    const result = validateInputAnswer(confirmable, { kind: 'oauth', confirmed: false });
    assert.equal(result.ok, false);
    assert.equal(
      !result.ok && result.error,
      'confirmed must be true — an oauth request is only closed by completing it'
    );
  });

  it('rejects any answer for a non-confirmable oauth request with the unchanged existing string', () => {
    const nonConfirmable = accepts({
      kind: 'oauth',
      prompt: 'Grant Google access',
      params: { provider: 'google' },
    });
    const result = validateInputAnswer(nonConfirmable, { kind: 'oauth', confirmed: true });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error, 'oauth requests have no user answer');
  });
});

describe('validateInputRequest — form kind', () => {
  const step = (over: Record<string, unknown>, base = FORM_SEVEN_STEPS[0]): Record<string, unknown> => ({
    ...base, ...over,
  });
  const formOf = (steps: unknown, extraParams: Record<string, unknown> = {}): unknown => ({
    kind: 'form', prompt: 'p', params: { steps, ...extraParams },
  });
  const option = (label: string, note = 'a note'): Record<string, unknown> => ({ label, note });
  const simpleStep = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, title: 't', decide: 'd',
    options: [option('a'), option('b')],
    ...over,
  });

  it('accepts the real seven-step questionnaire', () => {
    const request = accepts(VALID_FORM);
    assert.equal((request.params as { steps: unknown[] }).steps.length, 7);
    const steps = (request.params as { steps: Array<Record<string, unknown>> }).steps;
    assert.equal(steps[2].locked, true);
    assert.equal(steps[2].options, undefined);
    for (const i of [0, 1, 3, 4, 5, 6]) {
      const s = steps[i];
      const options = s.options as Array<{ label: string }>;
      assert.equal(options.length, 3, `step ${i} carries 3 options`);
      const labels = options.map((o) => o.label);
      assert.ok(labels.includes(s.preselected as string), `step ${i} preselected equals an option label`);
    }
    assert.ok(JSON.stringify(steps).length <= 20000);
  });

  it('rejects unknown fields at every level', () => {
    rejects(formOf([step({ url: 'https://evil.example' })]), 'unknown field "url"');
    rejects(formOf([{
      id: 'x', title: 't', decide: 'd',
      options: [{ label: 'a', note: 'n', href: 'https://evil.example' }],
    }]), 'unknown field "href"');
    rejects({ kind: 'form', prompt: 'p', params: { steps: [simpleStep('x')], template: 'evil' } }, 'unknown field "template"');
  });

  it('rejects oversize shapes', () => {
    rejects(formOf(Array.from({ length: INPUT_LIMITS.FORM_STEPS_MAX + 1 }, (_, i) => simpleStep(`s${i}`))));
    rejects(formOf([simpleStep('x', { title: 'x'.repeat(INPUT_LIMITS.FORM_STEP_TITLE_MAX + 1) })]));
    rejects(formOf([simpleStep('x', { decide: 'x'.repeat(INPUT_LIMITS.FORM_STEP_DECIDE_MAX + 1) })]));
    rejects(formOf([simpleStep('x', { options: Array.from({ length: INPUT_LIMITS.CHOICE_OPTIONS_MAX + 1 }, () => option('a')) })]));
    rejects(formOf([simpleStep('x', { options: [option('x'.repeat(INPUT_LIMITS.CHOICE_OPTION_MAX + 1))] })]));
    rejects(formOf([simpleStep('x', { options: [option('a', 'x'.repeat(INPUT_LIMITS.FORM_OPTION_NOTE_MAX + 1))] })]));
    const huge = Array.from({ length: 20 }, (_, i) => simpleStep(`s${i}`, { title: 'x'.repeat(1000) }));
    // NOTE: this hostile array trips the 1..8 count check first — with
    // FORM_STEPS_MAX=8 and every field capped, a steps array that passes the
    // per-field checks serializes to ≈17k chars, under FORM_STEPS_JSON_MAX;
    // the 20 000-char bound is defense-in-depth bounding params_json and its
    // error string is unreachable behind the earlier checks (spec gap,
    // recorded in the WP-TS report).
    rejects(formOf(huge));
  });

  it('rejects a preselected that is not an option label', () => {
    accepts(formOf([simpleStep('x', { preselected: 'a' })]));
    rejects(formOf([simpleStep('x', { preselected: 'a ' })]), 'preselected');
    rejects(formOf([simpleStep('x', { preselected: 'nope' })]), 'preselected');
  });

  it('rejects duplicate step ids', () => {
    rejects(formOf([simpleStep('dup'), simpleStep('dup')]), 'not unique');
  });

  it('rejects ids outside the family', () => {
    for (const bad of ['Q1', '-lead', '', 42, 'a'.repeat(41)]) {
      rejects(formOf([simpleStep(bad as string)]));
    }
  });

  it('rejects locked-step violations', () => {
    // The locked allowed-key check fires before the carries-no-options check —
    // `options` is simply not in a locked step's allowed set.
    rejects(formOf([{ id: 'l', title: 't', decide: 'd', locked: true, answer: 'a', options: [option('a')] }]), 'unknown field "options"');
    rejects(formOf([{ id: 'l', title: 't', decide: 'd', locked: true, answer: '' }]), 'answer');
    rejects(formOf([{ id: 'l', title: 't', decide: 'd', locked: true }]), 'answer');
    rejects(formOf([{ id: 'l', title: 't', decide: 'd', locked: false, options: [option('a')] }]), 'locked');
    rejects(formOf([simpleStep('x', { answer: 'recorded' })]), 'unknown field "answer"');
  });

  it('rejects empty options and non-array steps', () => {
    rejects(formOf([simpleStep('x', { options: [] })]));
    rejects({ kind: 'form', prompt: 'p', params: { steps: 'x' } });
    rejects({ kind: 'form', prompt: 'p', params: { steps: [] } });
    rejects(formOf([null]));
    rejects(formOf([42]));
  });

  it('never throws on hostile input', () => {
    const result = validateInputRequest({
      kind: 'form', prompt: 'p',
      params: { steps: [null, 42, [], {}, { id: {} }], extra: 1 },
    });
    assert.equal(result.ok, false);
  });
});

describe('validateInputAnswer — form', () => {
  const nonLockedAnswers = (): Record<string, string> => {
    const answers: Record<string, string> = {};
    for (const s of FORM_SEVEN_STEPS) {
      if (s.locked !== true) answers[s.id] = s.preselected as string;
    }
    return answers;
  };

  it('composes the canonical value incl. the locked step, ignoring a client override', () => {
    const request = accepts(VALID_FORM);
    const answers = { ...nonLockedAnswers(), 'q3-one-conversation': 'HACKED' };
    const result = validateInputAnswer(request, { kind: 'form', answers });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const composed = JSON.parse((result.value as { value: string }).value) as Record<string, string>;
    assert.equal(composed['q3-one-conversation'], FORM_SEVEN_STEPS[2].answer);
    assert.notEqual(composed['q3-one-conversation'], 'HACKED');
    assert.deepEqual(Object.keys(composed).sort(), FORM_SEVEN_STEPS.map((s) => s.id).sort());
  });

  it('accepts a free-text escape per step', () => {
    const request = accepts(VALID_FORM);
    const answers = { ...nonLockedAnswers(), 'q2-paging': 'page nothing at all, ever' };
    const result = validateInputAnswer(request, { kind: 'form', answers });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const composed = JSON.parse((result.value as { value: string }).value) as Record<string, string>;
    assert.equal(composed['q2-paging'], 'page nothing at all, ever');
  });

  it('rejects a missing step, naming it', () => {
    const request = accepts(VALID_FORM);
    const answers = nonLockedAnswers();
    delete answers['q2-paging'];
    const result = validateInputAnswer(request, { kind: 'form', answers });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('q2-paging'));
  });

  it('rejects an empty answer and an oversize answer', () => {
    const request = accepts(VALID_FORM);
    const empty = { ...nonLockedAnswers(), 'q2-paging': '' };
    assert.equal(validateInputAnswer(request, { kind: 'form', answers: empty }).ok, false);
    const oversize = { ...nonLockedAnswers(), 'q2-paging': 'x'.repeat(INPUT_LIMITS.FORM_ANSWER_MAX + 1) };
    const result = validateInputAnswer(request, { kind: 'form', answers: oversize });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes('500'));
  });

  it('rejects unknown keys', () => {
    const request = accepts(VALID_FORM);
    const unknownStep = { ...nonLockedAnswers(), nope: 'x' };
    const r1 = validateInputAnswer(request, { kind: 'form', answers: unknownStep });
    assert.equal(r1.ok, false);
    assert.ok(!r1.ok && r1.error.includes('unknown step'));
    const r2 = validateInputAnswer(request, { kind: 'form', answers: nonLockedAnswers(), value: 'x' });
    assert.equal(r2.ok, false);
    assert.ok(!r2.ok && r2.error.includes('unknown field "value" in answer'));
  });

  it('rejects non-object answers', () => {
    const request = accepts(VALID_FORM);
    assert.equal(validateInputAnswer(request, { kind: 'form', answers: 'x' }).ok, false);
    assert.equal(validateInputAnswer(request, { kind: 'form' }).ok, false);
  });
});

describe('TaskCompletedPayload — AI-234 suggested_items', () => {
  it('the interface declares suggested_items?: string[]', () => {
    // Source-level pin: TaskCompletedPayload is a type (erased at runtime),
    // so assert the field exists in the contracts.ts source — the same
    // structural idiom used by sync-twins.test.ts.
    const src = readFileSync(join(PKG_ROOT, 'src', 'contracts.ts'), 'utf8');
    const iface = /export interface TaskCompletedPayload \{([\s\S]*?)\}/.exec(src)?.[1];
    assert.ok(iface, 'TaskCompletedPayload interface not found in contracts.ts');
    assert.ok(
      /suggested_items\?\s*:\s*string\[\]/.test(iface),
      'TaskCompletedPayload must declare suggested_items?: string[]'
    );
  });
});
