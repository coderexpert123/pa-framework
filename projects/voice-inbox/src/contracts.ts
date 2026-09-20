/**
 * Voice-inbox contracts (AI-201): the typed input-request (widget) contract,
 * the telemetry event vocabulary, and the answer/API payload types.
 *
 * This file is the single TS source for three spec sections:
 *   - the seven-kind input-request table (§4): `validateInputRequest` enforces
 *     it, the worker scripts (python) mirror it, and the PWA renders only what
 *     it allows. This is the prompt-injection boundary: the model writes only
 *     `prompt` copy (and choice option labels) — every other field is fixed,
 *     unknown fields reject, and hostile input never throws.
 *   - the telemetry event vocabulary (§5): the same 11 kinds the ledger's
 *     SQL CHECK constraint pins. The python worker scripts byte-sync their
 *     copies against the SQL block + this list (the python test owns that
 *     sync); editing one side without the other fails a gate.
 *   - the per-kind answer shapes (§4 answer column) + the fixed submission ack.
 *
 * Validator style copied from pa's `validateKeyboardRequest`: a discriminated
 * result, never a throw.
 */

// ---------------------------------------------------------------------------
// Widget kinds + per-kind params (§4 table)
// ---------------------------------------------------------------------------

export const INPUT_KINDS = ['secret', 'text', 'choice', 'oauth', 'file', 'confirm', 'form'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** Providers the generalized `oauth` widget accepts (the auth broker's frozen
 * list, Phase A). A model-supplied provider outside this list rejects. */
export const OAUTH_PROVIDERS = ['google'] as const;
export type OauthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Hard limits from the §4 table. The python `task_input.py` validator mirrors
 * these numbers — change both together. */
export const INPUT_LIMITS = {
  /** `prompt` (model-written copy) — 1..500 chars, all kinds. */
  PROMPT_MAX: 500,
  /** `placeholder` (secret/text) — 0..100 chars. */
  PLACEHOLDER_MAX: 100,
  /** secret answer value — 1..1000 chars. */
  SECRET_VALUE_MAX: 1000,
  /** text answer value — 1..4000 chars. */
  TEXT_VALUE_MAX: 4000,
  /** choice: 1..6 options, each 1..60 chars. */
  CHOICE_OPTIONS_MAX: 6,
  CHOICE_OPTION_MAX: 60,
  /** file: ≤5 dot-extension allowlist entries. */
  FILE_ACCEPT_MAX: 5,
  /** file: max_bytes cap — 25 MB. */
  FILE_MAX_BYTES_MAX: 26_214_400,
  /** form: 1..8 steps. */
  FORM_STEPS_MAX: 8,
  /** form step: title 1..60 chars (the CHOICE_OPTION_MAX family). */
  FORM_STEP_TITLE_MAX: 60,
  /** form step: the one-line "what this decides" context, 1..200 chars; a
   * locked step's recorded answer uses the same cap. */
  FORM_STEP_DECIDE_MAX: 200,
  /** form option note: 1..200 chars. */
  FORM_OPTION_NOTE_MAX: 200,
  /** form: the serialized steps array caps at this many chars. */
  FORM_STEPS_JSON_MAX: 20_000,
  /** form answer: per-step free-text/label entry, 1..500 chars (answer side). */
  FORM_ANSWER_MAX: 500,
} as const;

export interface SecretParams {
  placeholder?: string;
}

export interface TextParams {
  placeholder?: string;
  multiline?: boolean;
}

export interface ChoiceParams {
  options: string[];
}

/** confirm has no params — prompt copy only. */
export interface ConfirmParams {
  never?: never;
}

export interface OauthParams {
  provider: string;
  user_code?: string;
  confirmable?: boolean;
}

export interface FileParams {
  /** Dot-extensions, e.g. ['.pdf', '.png']. */
  accept?: string[];
  max_bytes?: number;
}

/** One form step. Non-locked steps carry options (exact keys
 * {id,title,decide,options} + optional preselected); a locked step carries
 * exactly {id,title,decide,locked:true,answer} and NO options — the server
 * composes its recorded answer itself, so a client can never alter it. */
export interface FormStepOption {
  label: string;
  note: string;
}

export interface FormStep {
  id: string;
  title: string;
  decide: string;
  options?: FormStepOption[];
  preselected?: string;
  locked?: true;
  answer?: string;
}

export interface FormParams {
  steps: FormStep[];
}

export type InputRequestParams =
  | SecretParams
  | TextParams
  | ChoiceParams
  | ConfirmParams
  | OauthParams
  | FileParams
  | FormParams;

export type InputRequest =
  | { kind: 'secret'; prompt: string; params: SecretParams }
  | { kind: 'text'; prompt: string; params: TextParams }
  | { kind: 'choice'; prompt: string; params: ChoiceParams }
  | { kind: 'oauth'; prompt: string; params: OauthParams }
  | { kind: 'file'; prompt: string; params: FileParams }
  | { kind: 'confirm'; prompt: string; params: ConfirmParams }
  | { kind: 'form'; prompt: string; params: FormParams };

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Exact allowed param keys per kind (§4). Anything outside the kind's set
 * rejects — this is what makes a model-supplied `auth_url` impossible: it is
 * not a key of the oauth param set, so it cannot pass validation.
 */
const PARAM_KEYS: Record<InputKind, readonly string[]> = {
  secret: ['placeholder'],
  text: ['placeholder', 'multiline'],
  choice: ['options'],
  confirm: [],
  oauth: ['provider', 'user_code', 'confirmable'],
  file: ['accept', 'max_bytes'],
  form: ['steps'],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shared field validators. Each returns an error string or null. */
function checkPrompt(value: unknown): string | null {
  if (typeof value !== 'string') return 'prompt must be a string';
  if (value.length < 1 || value.length > INPUT_LIMITS.PROMPT_MAX) {
    return `prompt must be 1..${INPUT_LIMITS.PROMPT_MAX} chars`;
  }
  return null;
}

function checkPlaceholder(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > INPUT_LIMITS.PLACEHOLDER_MAX) {
    return `placeholder must be a string of at most ${INPUT_LIMITS.PLACEHOLDER_MAX} chars`;
  }
  return null;
}

/** `^[a-z0-9][a-z0-9-]{0,39}$` — the form step-id family (request-id shaped). */
const FORM_STEP_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The `form` steps validator (§ "The form contract"). Exact-key checks at every
 * level — request params, step, option — with an error string for every
 * rejection; hostile input never throws.
 */
function checkFormSteps(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > INPUT_LIMITS.FORM_STEPS_MAX) {
    return `params.steps must be an array of 1..${INPUT_LIMITS.FORM_STEPS_MAX} steps`;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const step = value[i];
    const where = `params.steps[${i}]`;
    if (!isPlainObject(step)) return `${where} must be an object`;
    const stepKeys = Object.keys(step);
    const isLocked = step['locked'] !== undefined;
    if (isLocked) {
      if (step['locked'] !== true) return `${where}.locked must be true`;
      const allowed = ['id', 'title', 'decide', 'locked', 'answer'];
      for (const key of stepKeys) {
        if (!allowed.includes(key)) return `${where}: unknown field "${key}" for a locked step`;
      }
    } else {
      const allowed = ['id', 'title', 'decide', 'options', 'preselected'];
      for (const key of stepKeys) {
        if (!allowed.includes(key)) return `${where}: unknown field "${key}"`;
      }
    }
    const id = step['id'];
    if (typeof id !== 'string' || !FORM_STEP_ID_PATTERN.test(id)) {
      return `${where}.id must match ^[a-z0-9][a-z0-9-]{0,39}$`;
    }
    if (seenIds.has(id)) return `${where}.id "${id}" is not unique`;
    seenIds.add(id);
    for (const [key, max] of [['title', INPUT_LIMITS.FORM_STEP_TITLE_MAX], ['decide', INPUT_LIMITS.FORM_STEP_DECIDE_MAX]] as const) {
      const v = step[key];
      if (typeof v !== 'string' || v.length < 1 || v.length > max) {
        return `${where}.${key} must be a string of 1..${max} chars`;
      }
    }
    if (isLocked) {
      const answer = step['answer'];
      if (typeof answer !== 'string' || answer.length < 1 || answer.length > INPUT_LIMITS.FORM_STEP_DECIDE_MAX) {
        return `${where}.answer must be a string of 1..${INPUT_LIMITS.FORM_STEP_DECIDE_MAX} chars`;
      }
      if (step['options'] !== undefined || step['preselected'] !== undefined) {
        return `${where}: a locked step carries no options`;
      }
      continue;
    }
    const options = step['options'];
    if (!Array.isArray(options) || options.length < 1 || options.length > INPUT_LIMITS.CHOICE_OPTIONS_MAX) {
      return `${where}.options must be an array of 1..${INPUT_LIMITS.CHOICE_OPTIONS_MAX} options`;
    }
    const labels: string[] = [];
    for (let j = 0; j < options.length; j++) {
      const opt = options[j];
      if (!isPlainObject(opt)) return `${where}.options[${j}] must be an object`;
      for (const key of Object.keys(opt)) {
        if (key !== 'label' && key !== 'note') return `${where}.options[${j}]: unknown field "${key}"`;
      }
      const label = opt['label'];
      const note = opt['note'];
      if (typeof label !== 'string' || label.length < 1 || label.length > INPUT_LIMITS.CHOICE_OPTION_MAX) {
        return `${where}.options[${j}].label must be a string of 1..${INPUT_LIMITS.CHOICE_OPTION_MAX} chars`;
      }
      if (typeof note !== 'string' || note.length < 1 || note.length > INPUT_LIMITS.FORM_OPTION_NOTE_MAX) {
        return `${where}.options[${j}].note must be a string of 1..${INPUT_LIMITS.FORM_OPTION_NOTE_MAX} chars`;
      }
      labels.push(label);
    }
    const preselected = step['preselected'];
    if (preselected !== undefined && !labels.includes(preselected as string)) {
      return `${where}.preselected must equal exactly one option label`;
    }
  }
  if (JSON.stringify(value).length > INPUT_LIMITS.FORM_STEPS_JSON_MAX) {
    return `params.steps must serialize to at most ${INPUT_LIMITS.FORM_STEPS_JSON_MAX} chars`;
  }
  return null;
}

function checkParamsForKind(kind: InputKind, params: Record<string, unknown>): string | null {
  const allowed = PARAM_KEYS[kind];
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) return `params: unknown field "${key}" for kind "${kind}"`;
  }
  switch (kind) {
    case 'secret': {
      if (params['placeholder'] !== undefined) {
        const err = checkPlaceholder(params['placeholder']);
        if (err) return err;
      }
      return null;
    }
    case 'text': {
      if (params['placeholder'] !== undefined) {
        const err = checkPlaceholder(params['placeholder']);
        if (err) return err;
      }
      if (params['multiline'] !== undefined && typeof params['multiline'] !== 'boolean') {
        return 'params.multiline must be a boolean';
      }
      return null;
    }
    case 'choice': {
      const options = params['options'];
      if (!Array.isArray(options) || options.length < 1 || options.length > INPUT_LIMITS.CHOICE_OPTIONS_MAX) {
        return `params.options must be an array of 1..${INPUT_LIMITS.CHOICE_OPTIONS_MAX} options`;
      }
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        if (typeof opt !== 'string' || opt.length < 1 || opt.length > INPUT_LIMITS.CHOICE_OPTION_MAX) {
          return `params.options[${i}] must be a string of 1..${INPUT_LIMITS.CHOICE_OPTION_MAX} chars`;
        }
      }
      return null;
    }
    case 'confirm':
      return null;
    case 'oauth': {
      const provider = params['provider'];
      if (typeof provider !== 'string' || !(OAUTH_PROVIDERS as readonly string[]).includes(provider)) {
        return `params.provider must be one of ${OAUTH_PROVIDERS.join(', ')}`;
      }
      const userCode = params['user_code'];
      if (userCode !== undefined) {
        if (typeof userCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{3,15}$/.test(userCode)) {
          return 'params.user_code must be 4..16 chars of A-Z, a-z, 0-9 and -';
        }
      }
      if (params['confirmable'] !== undefined && typeof params['confirmable'] !== 'boolean') {
        return 'params.confirmable must be a boolean';
      }
      return null;
    }
    case 'file': {
      const accept = params['accept'];
      if (accept !== undefined) {
        if (!Array.isArray(accept) || accept.length < 1 || accept.length > INPUT_LIMITS.FILE_ACCEPT_MAX) {
          return `params.accept must be an array of 1..${INPUT_LIMITS.FILE_ACCEPT_MAX} dot-extensions`;
        }
        for (let i = 0; i < accept.length; i++) {
          const ext = accept[i];
          if (typeof ext !== 'string' || !ext.startsWith('.') || ext.length < 2) {
            return `params.accept[${i}] must be a dot-extension like ".pdf"`;
          }
        }
      }
      const maxBytes = params['max_bytes'];
      if (maxBytes !== undefined) {
        if (!Number.isInteger(maxBytes) || (maxBytes as number) < 1 ||
          (maxBytes as number) > INPUT_LIMITS.FILE_MAX_BYTES_MAX) {
          return `params.max_bytes must be an integer of 1..${INPUT_LIMITS.FILE_MAX_BYTES_MAX}`;
        }
      }
      return null;
    }
    case 'form': {
      return checkFormSteps(params['steps']);
    }
  }
}

/**
 * Validate a widget input request (§4). Hand-rolled exact-key checks in the
 * `validateKeyboardRequest` style: unknown kinds, unknown fields, oversize
 * copy and wrong types all reject with an error string; nothing throws, no
 * matter how hostile the input.
 */
export function validateInputRequest(input: unknown): ValidationResult<InputRequest> {
  if (!isPlainObject(input)) return { ok: false, error: 'input request must be an object' };
  const allowedTop = ['kind', 'prompt', 'params'];
  for (const key of Object.keys(input)) {
    if (!allowedTop.includes(key)) return { ok: false, error: `unknown field "${key}"` };
  }
  const kind = input['kind'];
  if (typeof kind !== 'string' || !(INPUT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `kind must be one of ${INPUT_KINDS.join(', ')}` };
  }
  const promptError = checkPrompt(input['prompt']);
  if (promptError) return { ok: false, error: promptError };
  if (!isPlainObject(input['params'])) return { ok: false, error: 'params must be an object' };
  const paramsError = checkParamsForKind(kind as InputKind, input['params']);
  if (paramsError) return { ok: false, error: paramsError };
  return {
    ok: true,
    value: {
      kind,
      prompt: input['prompt'] as string,
      params: input['params'],
    } as InputRequest,
  };
}

// ---------------------------------------------------------------------------
// Per-kind answer shapes (§4 answer column) + the fixed submission ack
// ---------------------------------------------------------------------------

export type SecretAnswer = { value: string };
export type TextAnswer = { value: string };
export type ChoiceAnswer = { value: string };
export type ConfirmAnswer = { confirmed: boolean };
/** oauth has no VALUE answer — a `confirmable` request closes with a fixed
 * `{confirmed: true}` (the Done button); a non-confirmable one auto-answers
 * when the minted session resolves and never accepts a user answer at all. */
export type OauthAnswer = { confirmed: true };

/** form's wire answer: the client sends ONLY non-locked steps; the server
 * composes locked steps' recorded answers itself at validation time. */
export type FormAnswer = { answers: Record<string, string> };

export type InputAnswer =
  | (SecretAnswer & { kind: 'secret' })
  | (TextAnswer & { kind: 'text' })
  | (ChoiceAnswer & { kind: 'choice' })
  | (ConfirmAnswer & { kind: 'confirm' })
  | (OauthAnswer & { kind: 'oauth' })
  | (FormAnswer & { kind: 'form', value: string });

/** The API's fixed answer-ack — it never echoes a submitted value. */
export type AnswerAck = { ok: true; status: 'answered' };

/**
 * Validate an operator's answer against its request (§4 answer column).
 * Exact-key checks again; the choice value must equal one option exactly.
 */
export function validateInputAnswer(
  request: InputRequest,
  input: unknown
): ValidationResult<InputAnswer> {
  if (request.kind === 'oauth' && request.params.confirmable !== true) {
    return { ok: false, error: 'oauth requests have no user answer' };
  }
  if (request.kind === 'file') {
    // §4: a file answer is a multipart upload part, not a JSON answer body.
    return { ok: false, error: 'file answers are multipart uploads, not JSON answers' };
  }
  if (request.kind === 'form') {
    if (!isPlainObject(input)) return { ok: false, error: 'answer must be an object' };
    for (const key of Object.keys(input)) {
      if (key !== 'kind' && key !== 'answers') return { ok: false, error: `unknown field "${key}" in answer` };
    }
    if (input['kind'] !== 'form') {
      return { ok: false, error: `answer kind "${String(input['kind'])}" does not match request kind "form"` };
    }
    const answers = input['answers'];
    if (!isPlainObject(answers)) return { ok: false, error: 'answers must be an object' };
    const steps = request.params.steps;
    const stepIds = new Set(steps.map((s) => s.id));
    for (const key of Object.keys(answers)) {
      if (!stepIds.has(key)) return { ok: false, error: `unknown step "${key}" in form answers` };
      if (typeof answers[key] !== 'string' || (answers[key] as string).length < 1 ||
        (answers[key] as string).length > INPUT_LIMITS.FORM_ANSWER_MAX) {
        return { ok: false, error: `form answer for step "${key}" must be a string of 1..${INPUT_LIMITS.FORM_ANSWER_MAX} chars` };
      }
    }
    // Canonical value: EVERY step id, locked answers composed server-side —
    // a client entry for a locked id is ignored, never stored.
    const canonical: Record<string, string> = {};
    for (const step of steps) {
      if (step.locked === true) {
        canonical[step.id] = step.answer as string;
        continue;
      }
      const entry = answers[step.id];
      if (typeof entry !== 'string' || entry.length < 1) {
        return { ok: false, error: `form answer for step "${step.id}" is missing` };
      }
      canonical[step.id] = entry;
    }
    return { ok: true, value: { kind: 'form', answers: answers as Record<string, string>, value: JSON.stringify(canonical) } };
  }
  if (!isPlainObject(input)) return { ok: false, error: 'answer must be an object' };
  const expectedKeys =
    request.kind === 'confirm' || request.kind === 'oauth' ? ['kind', 'confirmed'] : ['kind', 'value'];
  for (const key of Object.keys(input)) {
    if (!expectedKeys.includes(key)) return { ok: false, error: `unknown field "${key}" in answer` };
  }
  if (input['kind'] !== request.kind) {
    return { ok: false, error: `answer kind "${String(input['kind'])}" does not match request kind "${request.kind}"` };
  }
  if (request.kind === 'confirm') {
    if (typeof input['confirmed'] !== 'boolean') {
      return { ok: false, error: 'confirmed must be a boolean' };
    }
    return { ok: true, value: { kind: 'confirm', confirmed: input['confirmed'] } };
  }
  if (request.kind === 'oauth') {
    if (input['confirmed'] !== true) {
      return {
        ok: false,
        error: 'confirmed must be true — an oauth request is only closed by completing it',
      };
    }
    return { ok: true, value: { kind: 'oauth', confirmed: true } };
  }
  const value = input['value'];
  if (typeof value !== 'string' || value.length < 1) {
    return { ok: false, error: 'value must be a non-empty string' };
  }
  if (request.kind === 'secret' && value.length > INPUT_LIMITS.SECRET_VALUE_MAX) {
    return { ok: false, error: `secret value must be at most ${INPUT_LIMITS.SECRET_VALUE_MAX} chars` };
  }
  if (request.kind === 'text' && value.length > INPUT_LIMITS.TEXT_VALUE_MAX) {
    return { ok: false, error: `text value must be at most ${INPUT_LIMITS.TEXT_VALUE_MAX} chars` };
  }
  if (request.kind === 'choice' && !request.params.options.includes(value)) {
    return { ok: false, error: 'value must exactly equal one of the offered options' };
  }
  return { ok: true, value: { kind: request.kind, value } };
}

// ---------------------------------------------------------------------------
// Telemetry event vocabulary (§5) — the 11 kinds the ledger SQL CHECK pins
// ---------------------------------------------------------------------------

export const TASK_EVENT_KINDS = [
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
] as const;

export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

export function isTaskEventKind(value: unknown): value is TaskEventKind {
  return typeof value === 'string' && (TASK_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Fixed per-kind timeline fallback strings (§5 rendering rule): the PWA
 * renders `summary` when the model phrased one, else this kind's fixed
 * string. Owned here so renderer and ledger cannot disagree.
 */
export const EVENT_FALLBACK: Record<TaskEventKind, string> = {
  'task.received': 'Task received',
  'task.routed': 'Task routed to a topic',
  'task.progress': 'Progress update',
  'task.input_needed': 'Waiting for your input',
  'task.input_received': 'Your input was received',
  'task.result_ready': 'Result ready',
  'task.completed': 'Task completed',
  'task.failed': 'Task failed',
  'task.cancelled': 'Task cancelled',
  'task.rerouted': 'Task rerouted to another topic',
  'task.transcribed': 'Voice transcribed',
};

/** `summary` cap (§3 events table) — writers truncate to this. */
export const EVENT_SUMMARY_MAX = 200;

/** OS notification body preview cap (vi-77c9ccd3865e, 2026-09-14): a
 *  notification carries only a short preview — word-boundary cut to this
 *  length plus an ellipsis; the full text stays in the app. Mirrored as a
 *  literal in public/app.js (showNotif) and public/sw.js (push handler);
 *  pa's dispatcher keeps its own copy in pa/src/lib/web-push.ts. */
export const NOTIF_BODY_MAX = 140;

// ---------------------------------------------------------------------------
// Per-event payload shapes (§5 payload-keys table)
// ---------------------------------------------------------------------------

export interface TaskReceivedPayload {
  source?: 'voice' | 'text';
  chars?: number;
  /** v14: the failed task this task retries (thread Retry). */
  retry_of?: string;
}

export interface TaskRoutedPayload {
  routed_to: string;
  reason?: string;
}

export interface TaskProgressPayload {
  /** Short worker-chosen label, ≤60 chars. */
  step?: string;
}

export interface TaskInputNeededPayload {
  request_id: string;
  kind: InputKind;
}

export interface TaskInputReceivedPayload {
  request_id: string;
  kind: InputKind;
}

export interface TaskResultReadyPayload {
  /** ≤200 chars. */
  preview?: string;
}

export interface TaskCompletedPayload {
  result_chars?: number;
  /** Non-empty only when the worker attached result artifacts via `--attach` (AI-244). */
  attachments?: string[];
  /** AI-234: quick-reply chip labels the worker emitted in the same call as
   *  the answer. Mirrors the `tasks.suggested_items` column; audit-only on the
   *  event (the PWA renders off the task row, not events). Plain product
   *  language only (sanitizeSuggestedItems drops non-plain entries). */
  suggested_items?: string[];
  /** P1 (2026-09-15): true when the same call stored structured answer JSON in
   *  `tasks.result_structured` (schema v12). A flag, not the payload — the
   *  event says the column landed; the PWA reads the task row. */
  result_structured?: boolean;
}

export interface TaskFailedPayload {
  /** Required, ≤300 chars. */
  reason: string;
}

export interface TaskCancelledPayload {
  by?: 'operator';
}

export interface TaskReroutedPayload {
  from: string;
  to: string;
  reason?: string;
}

export interface TaskTranscribedPayload {
  chars?: number;
  engine?: string;
}

/** Payload caps from the §5 table (workers' writers enforce; TS mirrors). */
export const EVENT_PAYLOAD_LIMITS = {
  STEP_MAX: 60,
  PREVIEW_MAX: 200,
  FAILED_REASON_MAX: 300,
} as const;

export interface TaskEventPayloadByKind {
  'task.received': TaskReceivedPayload;
  'task.routed': TaskRoutedPayload;
  'task.progress': TaskProgressPayload;
  'task.input_needed': TaskInputNeededPayload;
  'task.input_received': TaskInputReceivedPayload;
  'task.result_ready': TaskResultReadyPayload;
  'task.completed': TaskCompletedPayload;
  'task.failed': TaskFailedPayload;
  'task.cancelled': TaskCancelledPayload;
  'task.rerouted': TaskReroutedPayload;
  'task.transcribed': TaskTranscribedPayload;
}

/** A telemetry event row as the API serves it (§5: ref_id + ts on every row). */
export interface TaskEventRow {
  event_id: number;
  tenant_id: string;
  task_id: string;
  ref_id: string;
  kind: TaskEventKind;
  summary: string | null;
  payload: Record<string, unknown>;
  ts: string;
}
