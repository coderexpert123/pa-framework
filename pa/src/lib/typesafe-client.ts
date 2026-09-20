/**
 * TypeSafe client (2026-09-17) — the ONE module that knows the TypeSafe System
 * One endpoint, its Bearer header, the model name, the error codes, retry and
 * the circuit breaker. Callers ask typed questions and get typed answers or a
 * typed failure: askSystemOne never throws. Inert without TYPESAFE_API_KEY
 * (the environment first, else ~/.pa/secrets.env): every ask returns
 * {ok:false, error:'no-key'} with no network call and no log line.
 *
 * The budget (TYPESAFE_TIMEOUT_MS, default 4000 ms) bounds the whole call,
 * retry included: a 429 is retried once after its retry-after-ms / Retry-After
 * header, a 5xx (529 included) once after 250 ms, only while the budget
 * allows; 401 and 422 never retry; a timeout or network error never retries.
 * Three consecutive counted failures (timeout, network, any HTTP error except
 * 422) open the breaker for two minutes. Direct fetch — never the Telegram
 * proxy pool. One log line per call (none for no-key): purpose, question ids,
 * chosen option ids, confidence, top-3 probabilities, latency, input tokens,
 * status, retries. The request state and the key are never logged.
 * TYPESAFE_BASE_URL is a test-only seam for a local stub server; it and the
 * key are scrubbed from test-suite spawns (test-env-scrub.ts).
 */
import { loadSecretsSync } from '../secrets.js';
import { log } from './log.js';

const MODULE = 'typesafe';

export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const TYPESAFE_ENDPOINT_PATH = '/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';
export const DEFAULT_TYPESAFE_TIMEOUT_MS = 4_000;
export const TYPESAFE_MAX_ATTEMPTS = 2;
export const TYPESAFE_RETRY_DELAY_MS = 250;
export const TYPESAFE_BREAKER_THRESHOLD = 3;
export const TYPESAFE_BREAKER_OPEN_MS = 120_000;
export const TYPESAFE_KEY_CACHE_MS = 60_000;

/**
 * A structured Choice criterion, for an option easily confused with a
 * neighbor (TypeSafe docs, primitives/choice.md: "Use an object when a
 * description needs several kinds of guidance"). Field names ride to the
 * model as-is; `what`/`not_for`/`examples` is the documented convention, not
 * an API requirement.
 */
export interface TypeSafeCriterionDetail {
  what: string;
  not_for?: string;
  examples?: string[];
}

export interface TypeSafeChoiceQuestion {
  type: 'choice';
  instructions: string;
  /**
   * Widened 2026-09-18 (typesafe judge wording tuning, JE-4) from
   * `string | null`: the API has always accepted a structured object here
   * (confirmed against the live docs and a live measurement run, no
   * rejections) — pa's own type was the only reason routing-policy.ts used
   * to flatten `what`/`not_for`/`examples` guidance into a single string.
   * Additive: every existing `string | null` construction still type-checks
   * unchanged. A consumer that renders a criterion as text (rather than just
   * sending it) must use `renderTypeSafeCriterion`, never `String(value)` —
   * that silently prints "[object Object]" for the structured case.
   */
  criteria: Record<string, string | null | TypeSafeCriterionDetail>;
}

/**
 * Render one Choice criterion as plain text, for a consumer that needs a
 * human-readable description rather than the wire shape (e.g. a rubric
 * prompt built for an LLM labeler). `String(value)` silently stringifies a
 * structured criterion to "[object Object]" — go through this instead.
 */
export function renderTypeSafeCriterion(value: string | null | TypeSafeCriterionDetail): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  const parts = [value.what];
  if (value.not_for) parts.push(`Not for: ${value.not_for}`);
  if (value.examples?.length) parts.push(`Examples: ${value.examples.map((e) => `"${e}"`).join(', ')}`);
  return parts.join(' ');
}

export interface TypeSafeNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type TypeSafeQuestion = TypeSafeChoiceQuestion | TypeSafeNoulQuestion;

export interface TypeSafeRequest {
  state: unknown;
  questions: Record<string, TypeSafeQuestion>;
}

export interface TypeSafeChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface TypeSafeNoulAnswer {
  type: 'noul';
  noul: number;
}

export type TypeSafeAnswer = TypeSafeChoiceAnswer | TypeSafeNoulAnswer;

export type TypeSafeErrorKind = 'no-key' | 'circuit-open' | 'timeout' | 'http' | 'network' | 'invalid-response';

export type TypeSafeResult =
  | {
      ok: true;
      answers: Record<string, TypeSafeAnswer>;
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
      status: number;
      retries: number;
    }
  | {
      ok: false;
      error: TypeSafeErrorKind;
      status?: number;
      retryAfterMs?: number;
      latencyMs: number;
      retries: number;
    };

export interface AskOptions {
  /** Short label for the log line, e.g. 'routing-judge'. */
  purpose: string;
  /** Whole-call budget in ms; default TYPESAFE_TIMEOUT_MS, else 4000. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Explicit key (tests). Default resolveTypeSafeApiKey(). */
  apiKey?: string;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  logFn?: typeof log;
  /** Lenient per-question parse (2026-09-19 router-as-orchestrator M1): a
   *  missing/out-of-options answer for ONE question no longer voids the
   *  whole response — whatever parsed is returned, the rest are absent.
   *  The model-router one-ask classifier sets this so a garbage placement/
   *  chain/steer_wait answer degrades per question instead of failing the
   *  classification. DEFAULT (unset) keeps the strict all-or-nothing
   *  contract byte-identical for the judge and the evals. */
  lenient?: boolean;
}

interface ClientState {
  consecutiveFailures: number;
  breakerOpenUntilMs: number;
  warned401: boolean;
  keyCache?: { value: string | undefined; readAtMs: number };
}

const state: ClientState = { consecutiveFailures: 0, breakerOpenUntilMs: 0, warned401: false };

/** Test-only: forget the breaker, the 401 warning and the cached key. */
export function resetTypeSafeClientState(): void {
  state.consecutiveFailures = 0;
  state.breakerOpenUntilMs = 0;
  state.warned401 = false;
  state.keyCache = undefined;
}

/** TYPESAFE_API_KEY from the environment, else from secrets.env (re-read at most once a minute). */
export function resolveTypeSafeApiKey(nowMs: number = Date.now()): string | undefined {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (state.keyCache !== undefined && nowMs - state.keyCache.readAtMs < TYPESAFE_KEY_CACHE_MS) {
    return state.keyCache.value;
  }
  let value: string | undefined;
  try {
    value = loadSecretsSync().TYPESAFE_API_KEY?.trim() || undefined;
  } catch {
    value = undefined;
  }
  state.keyCache = { value, readAtMs: nowMs };
  return value;
}

export function typeSafeTimeoutMs(): number {
  const raw = Number(process.env.TYPESAFE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TYPESAFE_TIMEOUT_MS;
}

function typeSafeBaseUrl(): string {
  const raw = process.env.TYPESAFE_BASE_URL?.trim();
  return (raw || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/** True when a key resolves and the circuit breaker is closed. */
export function isTypeSafeConfigured(nowMs: number = Date.now()): boolean {
  return resolveTypeSafeApiKey(nowMs) !== undefined && nowMs >= state.breakerOpenUntilMs;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** A probability in [0, 1], tolerating float noise up to 1.000001. */
function probability(x: unknown): number | undefined {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1.000001) return undefined;
  return Math.min(1, x);
}

/** Validate a response body against the request's questions. undefined = invalid. */
export function parseTypeSafeAnswers(
  request: TypeSafeRequest,
  body: unknown
): Record<string, TypeSafeAnswer> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const answers = (body as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return undefined;
  const out: Record<string, TypeSafeAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const raw = (answers as Record<string, unknown>)[id];
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    if (question.type === 'choice') {
      if (typeof r.choice !== 'string' || !hasOwn(question.criteria, r.choice)) return undefined;
      const confidence = probability(r.confidence);
      if (confidence === undefined) return undefined;
      if (!r.probabilities || typeof r.probabilities !== 'object') return undefined;
      const probabilities: Record<string, number> = {};
      for (const [option, p] of Object.entries(r.probabilities as Record<string, unknown>)) {
        const value = probability(p);
        if (!hasOwn(question.criteria, option) || value === undefined) return undefined;
        probabilities[option] = value;
      }
      out[id] = { type: 'choice', choice: r.choice, probabilities, confidence };
    } else {
      const noul = probability(r.noul);
      if (noul === undefined) return undefined;
      out[id] = { type: 'noul', noul };
    }
  }
  return out;
}

/**
 * Lenient per-question variant (2026-09-19 router-as-orchestrator M1): a
 * missing/out-of-options answer for ONE question is skipped, not fatal —
 * whatever parsed is returned, the rest are absent from the map. Used by the
 * model-router one-ask classifier so a garbage placement/chain/steer_wait
 * answer degrades per question instead of failing the classification. The
 * envelope itself (non-object body, missing `answers` mapping) is still
 * invalid. The DEFAULT `parseTypeSafeAnswers` above stays all-or-nothing for
 * the judge and the evals — byte-identical strict contract.
 */
export function parseTypeSafeAnswersLenient(
  request: TypeSafeRequest,
  body: unknown
): Record<string, TypeSafeAnswer> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const answers = (body as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return undefined;
  const out: Record<string, TypeSafeAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const raw = (answers as Record<string, unknown>)[id];
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (question.type === 'choice') {
      if (typeof r.choice !== 'string' || !hasOwn(question.criteria, r.choice)) continue;
      const confidence = probability(r.confidence);
      if (confidence === undefined) continue;
      if (!r.probabilities || typeof r.probabilities !== 'object') continue;
      const probabilities: Record<string, number> = {};
      let probsValid = true;
      for (const [option, p] of Object.entries(r.probabilities as Record<string, unknown>)) {
        const value = probability(p);
        if (!hasOwn(question.criteria, option) || value === undefined) {
          probsValid = false;
          break;
        }
        probabilities[option] = value;
      }
      if (!probsValid) continue;
      out[id] = { type: 'choice', choice: r.choice, probabilities, confidence };
    } else {
      const noul = probability(r.noul);
      if (noul === undefined) continue;
      out[id] = { type: 'noul', noul };
    }
  }
  return out;
}

function retryAfterMsFrom(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function recordOutcome(result: TypeSafeResult, nowMs: number, logFn: typeof log): TypeSafeResult {
  if (result.ok) {
    state.consecutiveFailures = 0;
    return result;
  }
  if (result.error === 'http' && result.status === 401 && !state.warned401) {
    state.warned401 = true;
    logFn('warn', MODULE, 'TypeSafe rejected the API key (HTTP 401); check TYPESAFE_API_KEY', {});
  }
  const counted =
    result.error === 'timeout' || result.error === 'network' || (result.error === 'http' && result.status !== 422);
  if (!counted) return result;
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= TYPESAFE_BREAKER_THRESHOLD) {
    state.consecutiveFailures = 0;
    state.breakerOpenUntilMs = nowMs + TYPESAFE_BREAKER_OPEN_MS;
    logFn('warn', MODULE, 'TypeSafe circuit breaker opened after consecutive failures', {
      openMs: TYPESAFE_BREAKER_OPEN_MS,
    });
  }
  return result;
}

function roundProbability(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function logCall(logFn: typeof log, purpose: string, questionIds: string[], result: TypeSafeResult): void {
  if (!result.ok && result.error === 'no-key') return;
  if (result.ok) {
    const answers: Record<string, unknown> = {};
    for (const [id, a] of Object.entries(result.answers)) {
      answers[id] =
        a.type === 'choice'
          ? {
              choice: a.choice,
              confidence: roundProbability(a.confidence),
              top: Object.entries(a.probabilities)
                .sort((x, y) => y[1] - x[1])
                .slice(0, 3)
                .map(([option, p]) => [option, roundProbability(p)]),
            }
          : { noul: roundProbability(a.noul) };
    }
    logFn('info', MODULE, `typesafe call ok (${purpose})`, {
      purpose,
      questionIds,
      answers,
      latencyMs: result.latencyMs,
      inputTokens: result.usage.inputTokens,
      status: result.status,
      retries: result.retries,
    });
    return;
  }
  logFn('warn', MODULE, `typesafe call failed (${purpose}): ${result.error}`, {
    purpose,
    questionIds,
    error: result.error,
    ...(result.status !== undefined ? { status: result.status } : {}),
    latencyMs: result.latencyMs,
    retries: result.retries,
  });
}

/** Ask one System One request. Never throws. */
export async function askSystemOne(request: TypeSafeRequest, opts: AskOptions): Promise<TypeSafeResult> {
  const nowFn = opts.nowFn ?? Date.now;
  const logFn = opts.logFn ?? log;
  const questionIds = Object.keys(request.questions);
  const started = nowFn();
  let retries = 0;
  const finish = (result: TypeSafeResult): TypeSafeResult => {
    logCall(logFn, opts.purpose, questionIds, result);
    return result;
  };
  try {
    const apiKey = opts.apiKey ?? resolveTypeSafeApiKey(started);
    if (!apiKey) return finish({ ok: false, error: 'no-key', latencyMs: 0, retries });
    if (started < state.breakerOpenUntilMs) return finish({ ok: false, error: 'circuit-open', latencyMs: 0, retries });
    const fetchFn = opts.fetchFn ?? fetch;
    const sleepFn = opts.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const budgetMs = opts.timeoutMs ?? typeSafeTimeoutMs();
    const url = `${typeSafeBaseUrl()}${TYPESAFE_ENDPOINT_PATH}`;
    const body = JSON.stringify({ model: TYPESAFE_MODEL, state: request.state, questions: request.questions });
    let last: TypeSafeResult = { ok: false, error: 'timeout', latencyMs: 0, retries };
    for (let attempt = 1; attempt <= TYPESAFE_MAX_ATTEMPTS; attempt++) {
      const remainingMs = budgetMs - (nowFn() - started);
      if (remainingMs <= 0) {
        last = { ok: false, error: 'timeout', latencyMs: nowFn() - started, retries };
        break;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      let status = 0;
      let headers = new Headers();
      let text = '';
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: controller.signal,
        });
        status = res.status;
        headers = res.headers;
        text = await res.text();
      } catch {
        clearTimeout(timer);
        last = { ok: false, error: controller.signal.aborted ? 'timeout' : 'network', latencyMs: nowFn() - started, retries };
        break;
      }
      clearTimeout(timer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (status >= 200 && status < 300) {
        const answers = opts.lenient
          ? parseTypeSafeAnswersLenient(request, parsed)
          : parseTypeSafeAnswers(request, parsed);
        if (!answers) {
          last = { ok: false, error: 'invalid-response', status, latencyMs: nowFn() - started, retries };
          break;
        }
        const usage = (parsed as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
        last = {
          ok: true,
          answers,
          usage: {
            inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
            outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
          },
          latencyMs: nowFn() - started,
          status,
          retries,
        };
        break;
      }
      const retryAfterMs = status === 429 ? retryAfterMsFrom(headers) : undefined;
      last = {
        ok: false,
        error: 'http',
        status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        latencyMs: nowFn() - started,
        retries,
      };
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt === TYPESAFE_MAX_ATTEMPTS) break;
      const delayMs = status === 429 ? (retryAfterMs ?? TYPESAFE_RETRY_DELAY_MS) : TYPESAFE_RETRY_DELAY_MS;
      if (delayMs >= budgetMs - (nowFn() - started)) break;
      await sleepFn(delayMs);
      retries += 1;
    }
    return finish(recordOutcome(last, nowFn(), logFn));
  } catch {
    return finish(recordOutcome({ ok: false, error: 'network', latencyMs: nowFn() - started, retries }, nowFn(), logFn));
  }
}
