/**
 * Worker tunables — the pure resolution layer behind the bot's /llm and /effort
 * commands.
 *
 * NOTHING IN THIS MODULE TOUCHES THE FILESYSTEM, THE PROCESS, OR THE CLOCK.
 * Every function is pure so the whole feature (which is almost entirely
 * resolution logic) is unit-testable without a temp PA_HOME. Keep it that way:
 * persistence belongs to the caller (bot state for session overrides,
 * config.yaml for topic/worker defaults), and the observed-values reader — the
 * one part that DOES read disk — lives in its own module, `tunables-observed.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE CASCADE (highest priority first)
 *   1. session — set by /llm or /effort, expires at midnight IST (the bot owns
 *      expiry, exactly as it already does for preferred_worker)
 *   2. topic   — persistent per-topic default (the /default command surface)
 *   3. worker  — TunableSpec.default in ~/.pa/config.yaml
 *   4. cli     — nothing is passed at all; the CLI applies its own default
 *
 * TUNABLES ARE WORKER-SCOPED, NOT TOPIC-SCOPED-FLAT. "effort=high" is
 * meaningless the moment the user runs /model gemini, because gemini declares
 * no effort flag. State is therefore keyed worker -> setting -> value
 * (TunableStore), and resolution only ever walks the settings the CURRENT
 * worker declares — so switching worker can never carry another worker's knobs
 * across, even if stale entries for it are still sitting in the store.
 *
 * STRICT ON THE KNOB, FREE ON THE VALUE. validateTunable() rejects an unknown
 * or unsupported setting NAME at command time. Nothing here ever rejects a
 * VALUE: `values:` in config is a display hint (and optionally a
 * canonical->native map), never an allowlist. isKnownValue() exists only so the
 * bot can add a "not a known value for <worker>, passing through" note.
 *
 * UNSET IS UNSET. undefined, "", and whitespace-only all mean "not set at this
 * tier" and fall through to the next one. A setting that resolves with no value
 * contributes NO ARGUMENTS AT ALL — never a bare flag, never an empty string.
 * Clearing a tier is therefore expressible by writing undefined (or "") at that
 * tier: see setWorkerTunable().
 *
 * KNOBS ARE INDEPENDENT UNLESS CONFIG SAYS OTHERWISE. A few CLIs reject certain
 * combinations outright, and a rejected command line fails EVERY dispatch in the
 * topic — the exact failure mode this module exists to prevent. A worker
 * declares such a conflict with `supersedes:` on the winning setting (see
 * TunableSpec); applySupersedes() below is the only place that honours it, and
 * no worker is ever named in this file. Suppression removes the loser's ARGS
 * only: it keeps its value, its tier and its place in the report, flagged with
 * `supersededBy` so the bot can explain the resolution instead of silently
 * dropping what the user asked for.
 */

import type { WorkerConfig, TunableSpec, TunableValues } from '../types.js';

/** Which tier of the cascade a resolved value came from. */
export type TunableTier = 'session' | 'topic' | 'worker' | 'cli';

/** Flat per-worker map: setting name -> value. `undefined`/empty = not set. */
export interface TunableOverrides {
  [setting: string]: string | undefined;
}

/** Worker-scoped store: worker name -> that worker's settings. */
export interface TunableStore {
  [workerName: string]: TunableOverrides | undefined;
}

export interface ResolvedTunable {
  setting: string;              // normalized setting name, e.g. "effort"
  value?: string;               // resolved CANONICAL value as set by the user; undefined => tier 'cli'
  native?: string;              // value actually placed on the command line (after canonical->native mapping)
  tier: TunableTier;            // where the value came from (drives the bare /effort reply)
  args: string[];               // EXPANDED args for this setting; [] when unset OR superseded — never a bare flag
  spec: TunableSpec;            // the worker's declaration, for help text
  supersededBy?: string;        // set + suppressed: the setting whose `supersedes:` dropped this one's args
  supersededByValue?: string;   // that winner's resolved value, so the bot can explain without re-resolving
  superseding?: string[];       // settings THIS one is actively suppressing (only ones that really had a value)
}

export interface TunableValidation {
  ok: boolean;
  setting: string;              // normalized name that was asked for
  supported: string[];          // settings this worker DOES declare (for a useful rejection)
  spec?: TunableSpec;           // present when ok
  error?: string;               // present when !ok — ready to show the user
}

/** What a worker declares for one setting — everything the bot/dashboard needs to render help. */
export interface TunableDescription {
  setting: string;
  description?: string;
  values: string[];             // declared CANONICAL values; [] when none are declared
  mapped: boolean;              // true when `values` is a canonical->native map
  default?: string;             // worker-level default, if any
  argsTemplate: string[];       // e.g. ["-c", "model_reasoning_effort={value}"]
  supersedes: string[];         // settings this one suppresses when set; [] when it conflicts with nothing
}

/**
 * Human phrasing for each tier — used by the bot's bare `/llm` / `/effort`
 * "where did this come from" reply. Presentation lives here so the two command
 * handlers cannot drift.
 */
export const TUNABLE_TIER_LABELS: Record<TunableTier, string> = {
  session: 'session override (expires at midnight IST)',
  topic: 'topic default',
  worker: 'worker default (config.yaml)',
  cli: "the CLI's own default (nothing passed)",
};

/** Setting names are matched case-insensitively and trimmed. */
export function normalizeTunableName(name: string): string {
  return String(name ?? '').trim().toLowerCase();
}

/** True when a tier actually holds a value (not undefined/null/blank). */
function isSet(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Settings this worker declares, in declaration order. Empty for a worker with no tunables block. */
export function listTunables(worker: WorkerConfig | undefined): string[] {
  if (!worker?.tunables) return [];
  return Object.keys(worker.tunables);
}

/** The declaration for one setting, or undefined if this worker does not support it. */
export function getTunableSpec(worker: WorkerConfig | undefined, setting: string): TunableSpec | undefined {
  if (!worker?.tunables) return undefined;
  return worker.tunables[normalizeTunableName(setting)];
}

/** Does this worker declare `setting`? */
export function supportsTunable(worker: WorkerConfig | undefined, setting: string): boolean {
  return getTunableSpec(worker, setting) !== undefined;
}

/**
 * Command-time validation — STRICT ON THE KNOB, FREE ON THE VALUE.
 *
 * Validation happens HERE, when the user types the command, never at dispatch
 * time: a flag the CLI does not accept fails EVERY dispatch in that topic and
 * reads as a worker outage rather than a settings mistake.
 *
 * Note this deliberately takes no value argument. Values are never validated.
 */
export function validateTunable(worker: WorkerConfig | undefined, setting: string): TunableValidation {
  const name = normalizeTunableName(setting);
  const supported = listTunables(worker);
  const workerName = worker?.name ?? 'unknown';

  if (!name) {
    return { ok: false, setting: name, supported, error: `No setting name given. ${describeSupported(workerName, supported)}` };
  }
  const spec = getTunableSpec(worker, name);
  if (!spec) {
    return {
      ok: false,
      setting: name,
      supported,
      error: `Worker '${workerName}' has no setting called '${name}'. ${describeSupported(workerName, supported)}`,
    };
  }
  return { ok: true, setting: name, supported, spec };
}

function describeSupported(workerName: string, supported: string[]): string {
  if (supported.length === 0) return `'${workerName}' declares no settable options.`;
  return `'${workerName}' supports: ${supported.join(', ')}.`;
}

/** Canonical values declared for a setting; [] when the config declares none. */
export function declaredValues(spec: TunableSpec | undefined): string[] {
  const values: TunableValues | undefined = spec?.values;
  if (!values) return [];
  return Array.isArray(values) ? [...values] : Object.keys(values);
}

/**
 * Is `value` one of the declared values?
 *
 * NOT A GATE — the caller passes the value through either way. Returns true
 * when nothing is declared (there is nothing to contradict), so a caller can
 * write `if (!isKnownValue(spec, v)) note(...)` without special-casing.
 */
export function isKnownValue(spec: TunableSpec | undefined, value: string): boolean {
  const declared = declaredValues(spec);
  if (declared.length === 0) return true;
  const v = String(value ?? '').trim().toLowerCase();
  return declared.some((d) => d.toLowerCase() === v);
}

/**
 * Map a canonical value to what this CLI actually wants.
 *
 * With a plain list (or nothing declared) the value passes through unchanged.
 * With a canonical->native map, a case-insensitive hit is translated (e.g.
 * high -> "3"); a miss passes through untouched, because values are free.
 */
export function toNativeValue(spec: TunableSpec | undefined, value: string): string {
  const raw = String(value ?? '').trim();
  const values = spec?.values;
  if (!values || Array.isArray(values)) return raw;
  const hit = Object.entries(values).find(([canon]) => canon.toLowerCase() === raw.toLowerCase());
  return hit ? hit[1] : raw;
}

/** Expand one setting's arg template with an already-native value. */
function expandTemplate(template: string[], native: string): string[] {
  return template.map((part) => part.split('{value}').join(native));
}

/** Everything a worker declares, for help text and the dashboard matrix. */
export function describeTunables(worker: WorkerConfig | undefined): TunableDescription[] {
  if (!worker?.tunables) return [];
  return Object.entries(worker.tunables).map(([setting, spec]) => ({
    setting,
    ...(spec.description ? { description: spec.description } : {}),
    values: declaredValues(spec),
    mapped: !!spec.values && !Array.isArray(spec.values),
    ...(spec.default !== undefined ? { default: spec.default } : {}),
    argsTemplate: [...spec.args],
    supersedes: [...(spec.supersedes ?? [])],
  }));
}

/** One setting's declaration, or undefined when this worker does not support it. */
export function describeTunable(worker: WorkerConfig | undefined, setting: string): TunableDescription | undefined {
  const name = normalizeTunableName(setting);
  return describeTunables(worker).find((d) => d.setting === name);
}

/**
 * Resolve every setting the worker declares through the 4-tier cascade.
 *
 * `sessionOverrides` / `topicDefaults` are the FLAT per-worker maps for THIS
 * worker (use selectWorkerTunables() to slice them out of a TunableStore).
 * Entries naming a setting the worker does not declare are ignored.
 *
 * Resolution is per-setting; the cross-setting `supersedes:` rule is applied
 * afterwards, over the whole resolved set (see applySupersedes).
 */
export function resolveTunables(
  worker: WorkerConfig | undefined,
  sessionOverrides?: TunableOverrides,
  topicDefaults?: TunableOverrides,
): ResolvedTunable[] {
  if (!worker?.tunables) return [];

  const resolved = Object.entries(worker.tunables).map(([setting, spec]) => {
    const session = sessionOverrides?.[setting];
    const topic = topicDefaults?.[setting];
    const pick = isSet(session)
      ? { value: session.trim(), tier: 'session' as const }
      : isSet(topic)
        ? { value: topic.trim(), tier: 'topic' as const }
        : isSet(spec.default)
          ? { value: spec.default.trim(), tier: 'worker' as const }
          : undefined;

    if (!pick) return { setting, tier: 'cli' as const, args: [], spec };

    const native = toNativeValue(spec, pick.value);
    return { setting, value: pick.value, native, tier: pick.tier, args: expandTemplate(spec.args, native), spec };
  });

  return applySupersedes(resolved);
}

/**
 * Honour every declared `supersedes:` across an already-resolved set.
 *
 * Only a setting that is itself LIVE (has a value) and not already suppressed
 * may suppress others, and only settings that actually hold a value are
 * recorded as suppressed — a rule that suppresses nothing is invisible, which
 * is what keeps the bot from reporting a conflict the user does not have.
 *
 * Declaration order breaks ties, so two settings that supersede each other
 * resolve to "the one declared first wins" instead of cancelling out and
 * emitting nothing. Cheap early-out: a worker with no rule at all (every worker
 * but agy today) returns the input array untouched.
 */
function applySupersedes(resolved: ResolvedTunable[]): ResolvedTunable[] {
  if (!resolved.some((r) => (r.spec.supersedes?.length ?? 0) > 0)) return resolved;

  const live = (r: ResolvedTunable | undefined): r is ResolvedTunable => !!r && isSet(r.value);
  const winnerOf = new Map<string, ResolvedTunable>();   // loser setting -> the setting that beat it

  for (const candidate of resolved) {
    if (!live(candidate) || winnerOf.has(candidate.setting)) continue;
    for (const target of candidate.spec.supersedes ?? []) {
      if (target === candidate.setting || winnerOf.has(target)) continue;
      const loser = resolved.find((r) => r.setting === target);
      if (!live(loser)) continue;
      winnerOf.set(target, candidate);
    }
  }

  if (winnerOf.size === 0) return resolved;

  const losersOf = new Map<string, string[]>();
  for (const [loser, winner] of winnerOf) {
    losersOf.set(winner.setting, [...(losersOf.get(winner.setting) ?? []), loser]);
  }

  return resolved.map((r) => {
    const winner = winnerOf.get(r.setting);
    const losers = losersOf.get(r.setting);
    if (!winner && !losers) return r;
    return {
      ...r,
      // Value and tier survive: the setting is still SET, it is merely not sent
      // this dispatch, and clearing the winner must bring it straight back.
      ...(winner ? { args: [], supersededBy: winner.setting, supersededByValue: winner.value } : {}),
      ...(losers ? { superseding: losers } : {}),
    };
  });
}

/**
 * Resolve a single setting. Returns undefined when the worker does not declare
 * it (the caller should have called validateTunable first and shown its error).
 */
export function resolveTunable(
  worker: WorkerConfig | undefined,
  setting: string,
  sessionOverrides?: TunableOverrides,
  topicDefaults?: TunableOverrides,
): ResolvedTunable | undefined {
  const name = normalizeTunableName(setting);
  return resolveTunables(worker, sessionOverrides, topicDefaults).find((r) => r.setting === name);
}

/**
 * Turn resolved settings into the args to APPEND to the worker command.
 *
 * A setting with no value contributes nothing — not a bare flag, not an empty
 * string. So does a setting another one supersedes, even though it DOES have a
 * value: that is the whole point of the rule, and emitting it would produce a
 * command line the CLI rejects. Output is the expanded templates concatenated
 * in declaration order.
 */
export function buildTunableArgs(resolved: ResolvedTunable[]): string[] {
  const args: string[] = [];
  for (const r of resolved) {
    if (!isSet(r.value)) continue;   // tier 'cli' (or a blank that slipped through): pass NOTHING
    if (r.supersededBy) continue;    // set, but config says it cannot ride along with the winner
    args.push(...r.args);
  }
  return args;
}

/** Convenience: resolve + build in one call. Returns [] for a worker with no tunables. */
export function resolveTunableArgs(
  worker: WorkerConfig | undefined,
  sessionOverrides?: TunableOverrides,
  topicDefaults?: TunableOverrides,
): string[] {
  return buildTunableArgs(resolveTunables(worker, sessionOverrides, topicDefaults));
}

/**
 * MERGE tunable args onto extraArgs a caller already built (e.g. the bot's
 * buildResumeArgs at the session-resume dispatch site). Tunables go LAST on
 * purpose: every CLI here is last-wins for a repeated flag (verified live for
 * --model on 2026-07-22), so appending is what makes an explicitly SET value
 * beat a value baked into the worker's static args. Never overwrite the
 * caller's args — dropping --resume/--session-id loses the conversation.
 */
export function mergeTunableArgs(existing: string[] | undefined, tunableArgs: string[]): string[] {
  return [...(existing ?? []), ...tunableArgs];
}

/**
 * Slice one worker's settings out of a worker-scoped store.
 *
 * Always returns a fresh object (never a live reference into the store), and
 * {} for an unknown worker — this is the function that structurally guarantees
 * a worker switch cannot inherit the previous worker's knobs.
 */
export function selectWorkerTunables(store: TunableStore | undefined, workerName: string | undefined): TunableOverrides {
  if (!store || !workerName) return {};
  const slice = store[workerName];
  if (!slice) return {};
  const out: TunableOverrides = {};
  for (const [k, v] of Object.entries(slice)) {
    if (isSet(v)) out[normalizeTunableName(k)] = v;
  }
  return out;
}

/**
 * Set (or CLEAR) one worker's setting in a store, purely.
 *
 * Returns a NEW store; the input is never mutated. Passing undefined or a blank
 * value DELETES the key — that is how "clear this setting" is expressed, and it
 * falls the setting through to the next tier rather than pinning it to nothing.
 * A worker whose last setting is cleared is dropped from the store entirely, so
 * persisted state does not accumulate empty husks.
 */
export function setWorkerTunable(
  store: TunableStore | undefined,
  workerName: string,
  setting: string,
  value: string | undefined,
): TunableStore {
  const next: TunableStore = {};
  for (const [w, slice] of Object.entries(store ?? {})) {
    if (slice) next[w] = { ...slice };
  }
  const name = normalizeTunableName(setting);
  const slice: TunableOverrides = { ...(next[workerName] ?? {}) };

  if (isSet(value)) {
    slice[name] = value.trim();
  } else {
    delete slice[name];
  }

  if (Object.keys(slice).length === 0) delete next[workerName];
  else next[workerName] = slice;

  return next;
}

/** Clear every setting for one worker (e.g. a /llm reset). Pure; returns a new store. */
export function clearWorkerTunables(store: TunableStore | undefined, workerName: string): TunableStore {
  const next: TunableStore = {};
  for (const [w, slice] of Object.entries(store ?? {})) {
    if (w !== workerName && slice && Object.keys(slice).length > 0) next[w] = { ...slice };
  }
  return next;
}

/**
 * Reverse of expandTemplate: pull the value out of an OBSERVED arg list.
 *
 * Pure, and exported because the observed-values reader
 * (`tunables-observed.ts`) is the only caller that needs it but must not own
 * template semantics — a template change here must not silently stop matching
 * history. Scans every window of the template's length and returns each
 * distinct value found, in first-seen order. Values are reverse-mapped through
 * a canonical->native map so the caller always sees CANONICAL words.
 */
export function extractTunableValues(spec: TunableSpec | undefined, observedArgs: string[] | undefined): string[] {
  if (!spec || !Array.isArray(observedArgs) || observedArgs.length === 0) return [];
  const template = spec.args;
  if (template.length === 0 || observedArgs.length < template.length) return [];

  const found: string[] = [];
  for (let i = 0; i + template.length <= observedArgs.length; i++) {
    let captured: string | undefined;
    let matched = true;

    for (let j = 0; j < template.length; j++) {
      const part = template[j];
      const actual = observedArgs[i + j];
      if (typeof actual !== 'string') { matched = false; break; }

      if (!part.includes('{value}')) {
        if (part !== actual) { matched = false; break; }
        continue;
      }
      const [prefix, ...restParts] = part.split('{value}');
      const suffix = restParts.join('{value}');   // only the FIRST placeholder captures
      if (!actual.startsWith(prefix) || !actual.endsWith(suffix)) { matched = false; break; }
      const value = actual.slice(prefix.length, actual.length - suffix.length);
      if (!value) { matched = false; break; }
      if (captured !== undefined && captured !== value) { matched = false; break; }
      captured = value;
    }

    if (matched && captured !== undefined) {
      const canonical = toCanonicalValue(spec, captured);
      if (!found.includes(canonical)) found.push(canonical);
    }
  }
  return found;
}

/** Inverse of toNativeValue: native -> canonical when a map is declared, else unchanged. */
export function toCanonicalValue(spec: TunableSpec | undefined, native: string): string {
  const raw = String(native ?? '').trim();
  const values = spec?.values;
  if (!values || Array.isArray(values)) return raw;
  const hit = Object.entries(values).find(([, nat]) => nat.toLowerCase() === raw.toLowerCase());
  return hit ? hit[0] : raw;
}
