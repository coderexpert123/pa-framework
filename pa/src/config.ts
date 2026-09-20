import { readFile, writeFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { configPath } from './paths.js';
import type { PaConfig, WorkerConfig, EvaluatorConfig, BgTasksConfig, TunableSpec, TunableValues, MaintenanceConfig, TranscriptionConfig, TranscriptionEnginePreference, TranscriptionWorkerMode, UsageConfig, GitWorkflowConfig, BrowserConfig, VoiceInboxConfig } from './types.js';

/**
 * Parse a tunable's optional `values:` — a DISPLAY HINT, never a gate.
 * Accepts a list (values pass through unchanged) or a mapping
 * (canonical -> native, for a CLI whose vocabulary differs). Anything else, or
 * an empty result, yields undefined: "no declared values" simply means the bot
 * shows no suggestions and never second-guesses what the user typed.
 */
function parseTunableValues(raw: any, where: string): TunableValues | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (Array.isArray(raw)) {
    const list: string[] = [];
    for (const v of raw) {
      if (v === undefined || v === null) continue;
      const s = String(v).trim();
      if (s && !list.includes(s)) list.push(s);
    }
    if (list.length === 0) {
      console.warn(`${where}: 'values' list is empty; treating as undeclared`);
      return undefined;
    }
    return list;
  }

  if (typeof raw === 'object') {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, any>)) {
      const canon = String(k).trim();
      if (!canon) continue;
      if (v === undefined || v === null || String(v).trim() === '') {
        console.warn(`${where}: value '${canon}' maps to nothing; ignoring that entry`);
        continue;
      }
      map[canon] = String(v).trim();
    }
    if (Object.keys(map).length === 0) {
      console.warn(`${where}: 'values' mapping is empty; treating as undeclared`);
      return undefined;
    }
    return map;
  }

  console.warn(`${where}: 'values' must be a list or a canonical->native mapping; treating as undeclared`);
  return undefined;
}

/**
 * Parse a tunable's optional `supersedes:` — the names of settings this one
 * suppresses when it is set (see TunableSpec.supersedes in types.ts).
 *
 * Accepts a single name or a list. Names are normalized exactly like setting
 * names (trim + lowercase) so `supersedes: [Effort]` matches the `effort` key.
 * A self-reference is dropped: a setting that suppressed itself could never be
 * emitted, which no one can have meant.
 */
function parseTunableSupersedes(raw: any, where: string, selfName: string): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];

  const out: string[] = [];
  for (const entry of list) {
    if (entry === undefined || entry === null) continue;
    if (typeof entry === 'object') {
      console.warn(`${where}: 'supersedes' entries must be setting names; ignoring ${JSON.stringify(entry)}`);
      continue;
    }
    const name = String(entry).trim().toLowerCase();
    if (!name) continue;
    if (name === selfName) {
      console.warn(`${where}: 'supersedes' lists itself; ignoring that entry`);
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) {
    console.warn(`${where}: 'supersedes' declares no usable setting names; treating as absent`);
    return undefined;
  }
  return out;
}

/**
 * Parse a worker's optional `tunables:` block (see TunableSpec in types.ts).
 *
 * Warn-and-skip rather than throw: a malformed knob must not take the whole
 * config (and with it the scheduler, the bot, and every skill) down. A skipped
 * knob is still VISIBLE — the bot rejects `/effort` on that worker with the
 * list of settings it does support, which is a settings error the user can act
 * on, unlike a bad flag that would fail every dispatch as a fake worker outage.
 *
 * Shape (all optional except `args`):
 *   tunables:
 *     effort:
 *       args: ["-c", "model_reasoning_effort={value}"]
 *       values: [minimal, low, medium, high]      # or a canonical->native map
 *       default: medium                           # omit => CLI decides
 *       description: "..."
 *     model:
 *       args: ["--model", "{value}"]
 *       supersedes: [effort]                      # emit --model alone when both are set
 */
export function parseTunables(raw: any, workerName: string): Record<string, TunableSpec> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[config] worker '${workerName}': 'tunables' must be a mapping of setting name -> { flag, ... }; ignoring`);
    return undefined;
  }

  const out: Record<string, TunableSpec> = {};
  for (const [rawName, rawSpec] of Object.entries(raw as Record<string, any>)) {
    const name = String(rawName).trim().toLowerCase();
    const where = `[config] worker '${workerName}' tunable '${rawName}'`;
    if (!name) {
      console.warn(`${where}: empty setting name; ignoring`);
      continue;
    }
    if (!rawSpec || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      console.warn(`${where}: must be a mapping with at least an 'args' template; ignoring`);
      continue;
    }
    const rawArgs = rawSpec.args;
    const argList: string[] = Array.isArray(rawArgs)
      ? rawArgs.filter((a: any) => a !== undefined && a !== null).map((a: any) => String(a))
      : typeof rawArgs === 'string' || typeof rawArgs === 'number'
        ? [String(rawArgs)]
        : [];
    if (argList.length === 0) {
      console.warn(`${where}: missing required 'args' template (e.g. ["--model", "{value}"]); ignoring`);
      continue;
    }
    if (!argList.some((a) => a.includes('{value}'))) {
      // A template with no {value} placeholder would silently DROP the user's
      // value and pass a constant instead — invisible at command time, wrong
      // at every dispatch. Refuse the whole knob rather than half-honour it.
      console.warn(`${where}: args template ${JSON.stringify(argList)} has no {value} placeholder; ignoring this tunable`);
      continue;
    }
    const totalPlaceholders = argList.reduce((n, a) => n + a.split('{value}').length - 1, 0);
    if (totalPlaceholders > 1) {
      // expandTemplate substitutes EVERY occurrence (correct dispatch), but
      // extractTunableValues — the reverse parser observed-values mines
      // history through — only recovers the FIRST occurrence's value; for a
      // template with a second placeholder it can never match a real
      // expanded arg again and silently returns no observed values forever.
      // Refuse rather than ship a knob whose history-mining is permanently
      // and invisibly broken (found 2026-07-22; no live worker declares one
      // today, but nothing stopped a future one from doing so).
      console.warn(`${where}: args template ${JSON.stringify(argList)} has more than one {value} placeholder, which observed-value extraction cannot round-trip; ignoring this tunable`);
      continue;
    }
    const values = parseTunableValues(rawSpec.values, where);
    const rawDefault = rawSpec.default;
    const def = rawDefault === undefined || rawDefault === null || String(rawDefault).trim() === ''
      ? undefined
      : String(rawDefault).trim();
    const desc = typeof rawSpec.description === 'string' && rawSpec.description.trim()
      ? rawSpec.description.trim()
      : undefined;

    const supersedes = parseTunableSupersedes(rawSpec.supersedes, where, name);

    if (out[name]) console.warn(`${where}: duplicate setting name; later declaration wins`);
    out[name] = {
      args: argList,
      ...(def !== undefined ? { default: def } : {}),
      ...(desc ? { description: desc } : {}),
      ...(values !== undefined ? { values } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    };
  }

  // Cross-check `supersedes` targets only once every setting is known. A name
  // that matches nothing is a no-op, so it is KEPT (the target may be added to
  // this worker later) but warned about — silently swallowing a typo here would
  // leave the user believing a conflict is being handled when it is not.
  for (const [name, spec] of Object.entries(out)) {
    for (const target of spec.supersedes ?? []) {
      if (!out[target]) {
        console.warn(
          `[config] worker '${workerName}' tunable '${name}': supersedes unknown setting '${target}'; it has no effect`,
        );
      }
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse a duration like `30s` / `5m` / `6h` / `7d` into ms. Returns null for
 *  anything else — INCLUDING a bare integer, which is ambiguous (ms? seconds?)
 *  and would silently pick the wrong one. */
export function parseDurationMs(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/i.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const v = n * mult[m[2].toLowerCase()];
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Parse the optional top-level `maintenance:` block. WARN-AND-SKIP, never
 *  throw — same house style as parseTunables. A malformed knob must not take
 *  the config, and with it the scheduler, the bot and every skill, down. */
export function parseMaintenance(raw: any): Record<string, MaintenanceConfig> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn("[config] 'maintenance' must be a mapping of job name -> { enabled, every }; ignoring");
    return undefined;
  }
  const out: Record<string, MaintenanceConfig> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k) continue;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      console.warn(`[config] maintenance '${k}': must be a mapping with 'enabled' and/or 'every'; ignoring`);
      continue;
    }
    const entry: MaintenanceConfig = {};
    const vv = v as any;
    if ('enabled' in vv) {
      if (typeof vv.enabled === 'boolean') entry.enabled = vv.enabled;
      else console.warn(`[config] maintenance '${k}': 'enabled' must be true/false; ignoring that field`);
    }
    if ('every' in vv) {
      const ms = parseDurationMs(vv.every);
      if (ms !== null) entry.everyMs = ms;
      else console.warn(`[config] maintenance '${k}': 'every' must be a duration like 30s/5m/6h/7d (got ${JSON.stringify(vv.every)}); ignoring that field`);
    }
    if (Object.keys(entry).length > 0) out[k] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const VALID_ENGINE_PREFERENCES: readonly TranscriptionEnginePreference[] = ['auto', 'cloud', 'local'];
const VALID_WORKER_MODES: readonly TranscriptionWorkerMode[] = ['spawn', 'persistent'];
const VALID_CLOUD_PROVIDERS = ['groq', 'openai', 'deepgram'] as const;
// ISO 639-1: exactly two letters, optionally a hyphen and a two-letter region
// (e.g. "en", "en-US"). Case-insensitive on input; not re-cased on output —
// the value is passed straight through to each cloud provider's own API.
const LANGUAGE_PATTERN = /^[a-z]{2}(-[A-Za-z]{2})?$/i;
const ENGLISH_LANGUAGE_PATTERN = /^en(-|$)/i;

export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  engine_preference: 'auto',
  worker_mode: 'spawn',
  cloud_order: ['groq', 'openai', 'deepgram'],
  language: null,
};

/** Merge a (possibly undefined/partial) transcription config field-by-field
 *  over DEFAULT_TRANSCRIPTION_CONFIG. The only defaulting logic for this
 *  feature — parseTranscription below delegates to it rather than
 *  re-implementing it, and so must every other consumer (e.g. `main.ts`
 *  falls back to `{ workers: [] }` when loadConfig() throws, so
 *  `config.transcription` really can be undefined at the call site). */
export function resolveTranscriptionConfig(raw?: Partial<TranscriptionConfig>): TranscriptionConfig {
  return {
    engine_preference: raw?.engine_preference ?? DEFAULT_TRANSCRIPTION_CONFIG.engine_preference,
    worker_mode: raw?.worker_mode ?? DEFAULT_TRANSCRIPTION_CONFIG.worker_mode,
    cloud_order: raw?.cloud_order ?? DEFAULT_TRANSCRIPTION_CONFIG.cloud_order,
    language: raw?.language !== undefined ? raw.language : DEFAULT_TRANSCRIPTION_CONFIG.language,
  };
}

/** Parse the optional top-level `transcription:` block. WARN-AND-SKIP, same
 *  house style as parseTunables/parseMaintenance — a malformed knob must not
 *  take the config, and with it the scheduler, the bot and every skill,
 *  down. Every warning names the config file, since for a first-time user
 *  it may only ever be read out of a bot log. */
export function parseTranscription(raw: any): TranscriptionConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'transcription' must be a mapping with 'engine_preference', 'worker_mode', 'cloud_order'; ignoring");
    return undefined;
  }

  const partial: Partial<TranscriptionConfig> = {};

  if (raw.engine_preference !== undefined && raw.engine_preference !== null) {
    const v = String(raw.engine_preference).trim().toLowerCase();
    if ((VALID_ENGINE_PREFERENCES as readonly string[]).includes(v)) {
      partial.engine_preference = v as TranscriptionEnginePreference;
    } else {
      console.warn(
        `[config] ~/.pa/config.yaml: transcription.engine_preference must be one of ${VALID_ENGINE_PREFERENCES.join('|')} (got ${JSON.stringify(raw.engine_preference)}); using default '${DEFAULT_TRANSCRIPTION_CONFIG.engine_preference}'`,
      );
    }
  }

  if (raw.worker_mode !== undefined && raw.worker_mode !== null) {
    const v = String(raw.worker_mode).trim().toLowerCase();
    if ((VALID_WORKER_MODES as readonly string[]).includes(v)) {
      partial.worker_mode = v as TranscriptionWorkerMode;
    } else {
      console.warn(
        `[config] ~/.pa/config.yaml: transcription.worker_mode must be one of ${VALID_WORKER_MODES.join('|')} (got ${JSON.stringify(raw.worker_mode)}); using default '${DEFAULT_TRANSCRIPTION_CONFIG.worker_mode}'`,
      );
    }
  }

  if (raw.cloud_order !== undefined && raw.cloud_order !== null) {
    const rawList = Array.isArray(raw.cloud_order) ? raw.cloud_order : [raw.cloud_order];
    const list: string[] = [];
    for (const entry of rawList) {
      if (entry === undefined || entry === null) continue;
      const name = String(entry).trim().toLowerCase();
      if (!name) continue;
      if (!(VALID_CLOUD_PROVIDERS as readonly string[]).includes(name)) {
        console.warn(
          `[config] ~/.pa/config.yaml: transcription.cloud_order entry ${JSON.stringify(entry)} is not one of ${VALID_CLOUD_PROVIDERS.join('|')}; dropping it`,
        );
        continue;
      }
      if (!list.includes(name)) list.push(name);
    }
    if (list.length > 0) {
      partial.cloud_order = list;
    } else {
      console.warn(
        `[config] ~/.pa/config.yaml: transcription.cloud_order has no usable entries; using default ${JSON.stringify(DEFAULT_TRANSCRIPTION_CONFIG.cloud_order)}`,
      );
    }
  }

  if (raw.language !== undefined && raw.language !== null) {
    const v = String(raw.language).trim();
    if (v === '') {
      // Explicit blank is the same as unset: fall through to the null default,
      // no warning — nothing was actually asked for.
    } else if (LANGUAGE_PATTERN.test(v)) {
      partial.language = v;
    } else {
      console.warn(
        `[config] ~/.pa/config.yaml: transcription.language must be an ISO 639-1 code, optionally region-qualified (e.g. 'en' or 'en-US') (got ${JSON.stringify(raw.language)}); falling back to auto-detect`,
      );
    }
  }

  // The small.en local model is English-only: a non-English language paired
  // with the local engine is accepted (still passed through as a hint — the
  // local transcriber may honour it, may not) but warned about, since it will
  // otherwise silently mistranscribe or transliterate rather than fail loudly.
  const effectiveEnginePreference = partial.engine_preference ?? DEFAULT_TRANSCRIPTION_CONFIG.engine_preference;
  if (partial.language && effectiveEnginePreference === 'local' && !ENGLISH_LANGUAGE_PATTERN.test(partial.language)) {
    console.warn(
      `[config] ~/.pa/config.yaml: transcription.language is '${partial.language}' but engine_preference is 'local' — the local model (small.en) is English-only and will likely mistranscribe or transliterate rather than error; use a cloud engine for other languages`,
    );
  }

  return resolveTranscriptionConfig(partial);
}

/** Parse the optional top-level `git_workflow:` block. WARN-AND-SKIP, same
 *  house style as parseMaintenance/parseUsage. A skipped or absent block
 *  resolves to undefined, which consumers read as ENABLED: pre-knob configs
 *  keep their existing git behavior, and only an explicit `enabled: false`
 *  opts a deployment out (pa init scaffolds exactly that for new installs). */
export function parseGitWorkflow(raw: any): GitWorkflowConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'git_workflow' must be a mapping with 'enabled'; ignoring (git stays allowed)");
    return undefined;
  }
  if (raw.enabled === undefined || raw.enabled === null) return undefined;
  if (typeof raw.enabled !== 'boolean') {
    console.warn(`[config] ~/.pa/config.yaml: git_workflow.enabled must be true/false (got ${JSON.stringify(raw.enabled)}); ignoring (git stays allowed)`);
    return undefined;
  }
  return { enabled: raw.enabled };
}

/** Parse the optional top-level `usage:` block. WARN-AND-SKIP, same
 *  house style as parseTunables/parseMaintenance/parseTranscription. */
export function parseUsage(raw: any): UsageConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'usage' must be a mapping with 'budget_monthly_usd'; ignoring");
    return undefined;
  }

  const out: UsageConfig = {};

  if (raw.budget_monthly_usd !== undefined && raw.budget_monthly_usd !== null) {
    const v = Number(raw.budget_monthly_usd);
    if (Number.isFinite(v) && v > 0) {
      out.budget_monthly_usd = v;
    } else {
      console.warn(
        `[config] ~/.pa/config.yaml: usage.budget_monthly_usd must be a positive number (got ${JSON.stringify(raw.budget_monthly_usd)}); ignoring`,
      );
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse the optional top-level `cost_tier:` block. WARN-AND-SKIP. */
export function parseCostTier(raw: any): import('./types.js').CostTierConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'cost_tier' must be a mapping with 'peak_window_utc'; ignoring");
    return undefined;
  }

  const out: import('./types.js').CostTierConfig = {};

  if (raw.peak_window_utc !== undefined && raw.peak_window_utc !== null) {
    const pw = raw.peak_window_utc;
    if (typeof pw !== 'object' || Array.isArray(pw)) {
      console.warn("[config] cost_tier.peak_window_utc must be a mapping; ignoring");
      return undefined;
    }

    // Validate days array (if present)
    if (pw.days !== undefined) {
      if (!Array.isArray(pw.days) || pw.days.some((d: any) => typeof d !== 'number' || d < 0 || d > 6)) {
        console.warn("[config] cost_tier.peak_window_utc.days must be an array of integers 0-6 (Sunday-Saturday); using default");
        return undefined;
      }
    }

    // Validate start_hour (if present)
    if (pw.start_hour !== undefined) {
      const sh = Number(pw.start_hour);
      if (!Number.isInteger(sh) || sh < 0 || sh > 23) {
        console.warn("[config] cost_tier.peak_window_utc.start_hour must be an integer 0-23; using default");
        return undefined;
      }
    }

    // Validate end_hour (if present)
    if (pw.end_hour !== undefined) {
      const eh = Number(pw.end_hour);
      if (!Number.isInteger(eh) || eh < 0 || eh > 23) {
        console.warn("[config] cost_tier.peak_window_utc.end_hour must be an integer 0-23; using default");
        return undefined;
      }
    }

    // Validate non-wrapping (start_hour < end_hour for v1)
    const start = pw.start_hour !== undefined ? Number(pw.start_hour) : 6;
    const end = pw.end_hour !== undefined ? Number(pw.end_hour) : 10;
    if (start >= end) {
      console.warn("[config] cost_tier.peak_window_utc requires start_hour < end_hour (non-wrapping windows); using default");
      return undefined;
    }

    out.peak_window_utc = {
      days: pw.days !== undefined ? pw.days : [1, 2, 3, 4, 5],
      start_hour: start,
      end_hour: end,
    };
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

const DEFAULT_BROWSER_CDP_PORT = 9222;

/** Parse the optional top-level `browser:` block (AI-246 WP-D). WARN-AND-SKIP,
 *  same house style — a bad cdp_port falls back to the default rather than
 *  taking the config down. Always returns a concrete BrowserConfig. */
export function parseBrowser(raw: any): BrowserConfig {
  const out: BrowserConfig = { cdp_port: DEFAULT_BROWSER_CDP_PORT };
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'browser' must be a mapping with 'cdp_port'; using defaults");
    return out;
  }
  if (raw.cdp_port !== undefined && raw.cdp_port !== null) {
    const p = Number(raw.cdp_port);
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) {
      out.cdp_port = p;
    } else {
      console.warn(`[config] ~/.pa/config.yaml: browser.cdp_port must be an integer 1024-65535 (got ${JSON.stringify(raw.cdp_port)}); using default ${DEFAULT_BROWSER_CDP_PORT}`);
    }
  }
  return out;
}

/** Parse the optional top-level `voice_inbox:` block — PA's typed view of the
 *  keys it consumes (the app itself reads the same keys via its own loader).
 *  WARN-AND-SKIP per field; absent block => undefined. */
export function parseVoiceInbox(raw: any): VoiceInboxConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'voice_inbox' must be a mapping; ignoring");
    return undefined;
  }
  const out: VoiceInboxConfig = {};
  if (raw.port !== undefined && raw.port !== null) {
    const p = Number(raw.port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      out.port = p;
    } else {
      console.warn(`[config] ~/.pa/config.yaml: voice_inbox.port must be an integer 1-65535 (got ${JSON.stringify(raw.port)}); ignoring that field`);
    }
  }
  if (raw.screencast_ingest_token !== undefined && raw.screencast_ingest_token !== null) {
    if (typeof raw.screencast_ingest_token === 'string' && raw.screencast_ingest_token.trim()) {
      out.screencast_ingest_token = raw.screencast_ingest_token.trim();
    } else {
      console.warn("[config] ~/.pa/config.yaml: voice_inbox.screencast_ingest_token must be a non-empty string; ignoring that field");
    }
  }
  return out;
}

/**
 * Parse the optional top-level `routing_policy:` block. WARN-AND-SKIP per
 * field; `enabled !== true` ⇒ undefined (policy absent = disabled = today's
 * behavior). Worker-name existence is NOT checked here — loadConfig
 * cross-checks below and resolveRoutingWorker fails open regardless.
 */
export function parseRoutingPolicy(raw: any): import('./types.js').RoutingPolicyConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'routing_policy' must be a mapping; ignoring");
    return undefined;
  }
  if (raw.enabled !== true) return undefined;

  const out: import('./types.js').RoutingPolicyConfig = {
    enabled: true,
    judge: 'agy',
    judge_model: 'gemini-3.6-flash-low',
    judge_timeout_ms: 20000,
  };

  if (raw.judge !== undefined && raw.judge !== null) {
    if (raw.judge === 'typesafe' || raw.judge === 'agy' || raw.judge === 'deterministic') {
      out.judge = raw.judge;
    } else {
      console.warn(`[config] routing_policy.judge must be 'typesafe' | 'agy' | 'deterministic'; defaulting to 'agy'`);
      out.judge = 'agy';
    }
  }

  if (raw.judge_model !== undefined && raw.judge_model !== null) {
    if (typeof raw.judge_model === 'string' && raw.judge_model.trim()) {
      out.judge_model = raw.judge_model.trim();
    } else {
      console.warn(`[config] routing_policy.judge_model must be a non-empty string; defaulting to 'gemini-3.6-flash-low'`);
      out.judge_model = 'gemini-3.6-flash-low';
    }
  }

  if (raw.judge_timeout_ms !== undefined && raw.judge_timeout_ms !== null) {
    const t = Number(raw.judge_timeout_ms);
    if (Number.isFinite(t) && t > 0) {
      out.judge_timeout_ms = t;
    } else {
      console.warn(`[config] routing_policy.judge_timeout_ms must be a positive number; defaulting to 20000`);
      out.judge_timeout_ms = 20000;
    }
  }

  if (raw.judge_command !== undefined && raw.judge_command !== null) {
    if (typeof raw.judge_command === 'string' && raw.judge_command.trim()) {
      out.judge_command = raw.judge_command.trim();
    } else {
      console.warn(`[config] routing_policy.judge_command must be a non-empty string; dropping the field`);
    }
  }

  for (const field of ['general_worker', 'code_worker', 'peak_code_worker'] as const) {
    if (raw[field] !== undefined && raw[field] !== null) {
      if (typeof raw[field] !== 'string' || !raw[field].trim()) {
        console.warn(`[config] routing_policy.${field} must be a non-empty worker name; dropping the field`);
        continue;
      }
      out[field] = raw[field].trim();
    }
  }

  if (raw.code_patterns !== undefined && raw.code_patterns !== null) {
    if (!Array.isArray(raw.code_patterns)) {
      console.warn("[config] routing_policy.code_patterns must be an array of regex strings; dropping it");
    } else {
      const patterns = raw.code_patterns
        .map((p: any) => String(p))
        .filter((p: string) => {
          try {
            new RegExp(p, 'i');
            return true;
          } catch {
            console.warn(`[config] routing_policy.code_patterns entry is not a valid regex; dropping it: ${p}`);
            return false;
          }
        });
      if (patterns.length > 0) out.code_patterns = patterns;
    }
  }

  if (raw.topic_classes !== undefined && raw.topic_classes !== null) {
    if (typeof raw.topic_classes !== 'object' || Array.isArray(raw.topic_classes)) {
      console.warn("[config] routing_policy.topic_classes must be a mapping of topicKey -> code|general|off; dropping it");
    } else {
      const classes: Record<string, 'code' | 'general' | 'off'> = {};
      for (const [key, val] of Object.entries(raw.topic_classes)) {
        if (val === 'code' || val === 'general' || val === 'off') {
          classes[key] = val;
        } else {
          console.warn(`[config] routing_policy.topic_classes['${key}'] must be code|general|off; dropping the entry`);
        }
      }
      if (Object.keys(classes).length > 0) out.topic_classes = classes;
    }
  }

  return out;
}

/**
 * Parse the optional top-level `model_router:` block (2026-09-18,
 * plans/2026-09-18-model-router-SPEC.md WP-A). WARN-AND-SKIP per field like
 * parseRoutingPolicy — but the block itself is kept even when `enabled` is
 * false: shadow staging runs iff the block EXISTS; `enabled: true` only
 * additionally lets the router DECIDE. Each bad field warns and drops THAT
 * field, never the whole block (a non-mapping drops the block). Worker names
 * in table/effort_projection are NOT validated against `workers:` here — the
 * router's availability layer re-checks fleet membership at resolve time and
 * fails open (same split as routing_policy's separate load-time warn above).
 */
export function parseModelRouter(raw: any): import('./types.js').ModelRouterConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn("[config] ~/.pa/config.yaml: 'model_router' must be a mapping; ignoring");
    return undefined;
  }

  const TIERS = ['quick_lookup', 'standard', 'deep_reasoning', 'rich_toolchain'] as const;

  const out: import('./types.js').ModelRouterConfig = {
    enabled: false,
    state_max_chars: 4000,
    context_max_chars: 2000,
    topic_max_chars: 300,
    zai_workers: ['zclaude'],
  };

  if (raw.enabled !== undefined && raw.enabled !== null) {
    if (typeof raw.enabled === 'boolean') {
      out.enabled = raw.enabled;
    } else {
      console.warn("[config] model_router.enabled must be a boolean; defaulting to false");
    }
  }

  if (raw.judge !== undefined && raw.judge !== null) {
    if (raw.judge === 'typesafe') {
      out.judge = raw.judge;
    } else {
      console.warn("[config] model_router.judge must be 'typesafe'; dropping the field");
    }
  }

  // sticky: absent = ON when the block exists (default per operator); only an
  // explicit `sticky: false` opts out. Non-boolean warns and drops (stays ON).
  if (raw.sticky !== undefined && raw.sticky !== null) {
    if (typeof raw.sticky === 'boolean') {
      out.sticky = raw.sticky;
    } else {
      console.warn('[config] model_router.sticky must be a boolean; dropping the field (default ON)');
    }
  }

  // deprecate_pins (decision 25): absent = true when the block exists; only an
  // explicit `false` restores today's pin behavior on router-decided turns.
  // Non-boolean warns and drops (stays ON).
  if (raw.deprecate_pins !== undefined && raw.deprecate_pins !== null) {
    if (typeof raw.deprecate_pins === 'boolean') {
      out.deprecate_pins = raw.deprecate_pins;
    } else {
      console.warn('[config] model_router.deprecate_pins must be a boolean; dropping the field (default ON)');
    }
  }

  // availability_ttl_ms (decision 27): a non-negative number of ms; `0`
  // disables the cache (always fresh). Non-number warns and drops.
  if (raw.availability_ttl_ms !== undefined && raw.availability_ttl_ms !== null) {
    const n = Number(raw.availability_ttl_ms);
    if (Number.isFinite(n) && n >= 0) {
      out.availability_ttl_ms = n;
    } else {
      console.warn('[config] model_router.availability_ttl_ms must be a non-negative number (ms; 0 disables); dropping the field (default 5000)');
    }
  }

  // placement caps (decision 21): positive numbers; each bad field warns and
  // drops THAT field (default applies at use time).
  if (raw.placement !== undefined && raw.placement !== null) {
    if (typeof raw.placement === 'object' && !Array.isArray(raw.placement)) {
      const placement: import('./types.js').ModelRouterConfig['placement'] = {};
      for (const [field, dflt] of [
        ['candidate_cap', 25],
        ['goal_chars', 80],
        ['section_chars', 2400],
      ] as const) {
        const v = raw.placement[field];
        if (v === undefined || v === null) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          (placement as Record<string, number>)[field] = n;
        } else {
          console.warn(`[config] model_router.placement.${field} must be a positive number; dropping the field (default ${dflt})`);
        }
      }
      if (Object.keys(placement).length > 0) out.placement = placement;
    } else {
      console.warn('[config] model_router.placement must be a mapping of caps; dropping it');
    }
  }

  // surfaces staging keys (decision 28): each must be 'shadow' | 'live';
  // absent = 'shadow' (dark) at use time. Bad values warn and drop THAT field.
  if (raw.surfaces !== undefined && raw.surfaces !== null) {
    if (typeof raw.surfaces === 'object' && !Array.isArray(raw.surfaces)) {
      const surfaces: NonNullable<import('./types.js').ModelRouterConfig['surfaces']> = {};
      for (const name of ['fallback', 'steer', 'placement'] as const) {
        const v = raw.surfaces[name];
        if (v === undefined || v === null) continue;
        if (v === 'shadow' || v === 'live') {
          surfaces[name] = v;
        } else {
          console.warn(`[config] model_router.surfaces.${name} must be 'shadow' | 'live'; dropping the field (default 'shadow')`);
        }
      }
      if (Object.keys(surfaces).length > 0) out.surfaces = surfaces;
    } else {
      console.warn('[config] model_router.surfaces must be a mapping of surface -> staging mode; dropping it');
    }
  }

  for (const [field, dflt] of [
    ['state_max_chars', 4000],
    ['context_max_chars', 2000],
    ['topic_max_chars', 300],
  ] as const) {
    if (raw[field] !== undefined && raw[field] !== null) {
      const n = Number(raw[field]);
      if (Number.isFinite(n) && n > 0) {
        out[field] = n;
      } else {
        console.warn(`[config] model_router.${field} must be a positive number; dropping the field (default ${dflt})`);
      }
    }
  }

  if (raw.zai_workers !== undefined && raw.zai_workers !== null) {
    if (Array.isArray(raw.zai_workers)) {
      const names = raw.zai_workers
        .filter((w: any) => typeof w === 'string' && w.trim())
        .map((w: string) => w.trim());
      if (names.length > 0) out.zai_workers = names;
      if (names.length !== raw.zai_workers.length) {
        console.warn('[config] model_router.zai_workers entries must be non-empty strings; dropping the bad entries');
      }
    } else {
      console.warn('[config] model_router.zai_workers must be an array of worker names; dropping it (default [zclaude])');
    }
  }

  if (raw.table !== undefined && raw.table !== null) {
    if (Array.isArray(raw.table)) {
      const rows: import('./types.js').ModelRouterPolicyRow[] = [];
      for (const row of raw.table) {
        const worker = typeof row?.worker === 'string' ? row.worker.trim() : '';
        const model = row?.model;
        const tier = row?.max_tier;
        const score = Number(row?.max_score);
        if (!worker) {
          console.warn(`[config] model_router.table row must carry a non-empty 'worker'; dropping the row`);
          continue;
        }
        if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
          console.warn(`[config] model_router.table row '${worker}' has a non-empty-string 'model' expected; dropping the row`);
          continue;
        }
        if (!TIERS.includes(tier)) {
          console.warn(`[config] model_router.table row '${worker}' has max_tier '${tier}' — must be one of ${TIERS.join(' | ')}; dropping the row`);
          continue;
        }
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          console.warn(`[config] model_router.table row '${worker}' has max_score ${row?.max_score} — must be an integer 1-5; dropping the row`);
          continue;
        }
        const typed: import('./types.js').ModelRouterPolicyRow = {
          worker,
          max_tier: tier,
          max_score: score as import('./types.js').EffortScore,
        };
        if (model !== undefined) typed.model = model.trim();
        rows.push(typed);
      }
      if (rows.length > 0) out.table = rows;
    } else {
      console.warn('[config] model_router.table must be an array of rows; dropping it');
    }
  }

  if (raw.effort_projection !== undefined && raw.effort_projection !== null) {
    if (typeof raw.effort_projection === 'object' && !Array.isArray(raw.effort_projection)) {
      const proj: Record<string, import('./types.js').ModelRouterEffortProjection> = {};
      for (const [worker, entry] of Object.entries<any>(raw.effort_projection)) {
        const tunable = entry?.tunable;
        if (tunable !== 'effort' && tunable !== 'none') {
          console.warn(`[config] model_router.effort_projection['${worker}'].tunable must be 'effort' | 'none'; dropping the entry`);
          continue;
        }
        const typed: import('./types.js').ModelRouterEffortProjection = { tunable };
        if (tunable === 'effort' && entry.map !== undefined) {
          if (typeof entry.map === 'object' && !Array.isArray(entry.map)) {
            const map: Partial<Record<import('./types.js').EffortScore, string>> = {};
            for (const [k, v] of Object.entries<any>(entry.map)) {
              const key = Number(k);
              if (!Number.isInteger(key) || key < 1 || key > 5 || typeof v !== 'string' || !v.trim()) {
                console.warn(`[config] model_router.effort_projection['${worker}'].map entry '${k}' must be an integer key 1-5 with a non-empty string value; dropping that pair`);
                continue;
              }
              map[key as import('./types.js').EffortScore] = v;
            }
            typed.map = map;
          } else {
            console.warn(`[config] model_router.effort_projection['${worker}'].map must be a mapping score -> effort string; dropping the entry`);
            continue;
          }
        }
        proj[worker] = typed;
      }
      if (Object.keys(proj).length > 0) out.effort_projection = proj;
    } else {
      console.warn('[config] model_router.effort_projection must be a mapping of worker -> projection; dropping it');
    }
  }

  if (raw.shadow_path !== undefined && raw.shadow_path !== null) {
    if (typeof raw.shadow_path === 'string' && raw.shadow_path.trim()) {
      out.shadow_path = raw.shadow_path.trim();
    } else {
      console.warn('[config] model_router.shadow_path must be a non-empty string; dropping the field');
    }
  }

  return out;
}

export async function loadConfig(): Promise<PaConfig> {
  const path = configPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Config not found at ${path}. Run 'pa init' or create it manually.`);
  }

  const parsed = parseYaml(raw);
  if (!parsed?.workers || !Array.isArray(parsed.workers)) {
    throw new Error(`Invalid config: 'workers' must be an array in ${path}`);
  }

  // Validation regex for secret names: uppercase alphanumeric + underscore only
  const SECRET_NAME_PATTERN = /^[A-Z0-9_]+$/;

  const workers: WorkerConfig[] = parsed.workers.map((w: any, i: number) => {
    if (!w.name || !w.command || !w.args || !w.check) {
      throw new Error(`Worker #${i + 1} missing required fields (name, command, args, check)`);
    }

    // Validate secret_allowlist if present
    if (w.secret_allowlist !== undefined && w.secret_allowlist !== null) {
      if (!Array.isArray(w.secret_allowlist)) {
        console.warn(`[config] worker '${w.name}': 'secret_allowlist' must be an array of secret name strings; ignoring`);
        w.secret_allowlist = undefined;
      } else {
        const validNames: string[] = [];
        for (const entry of w.secret_allowlist) {
          if (entry === undefined || entry === null) continue;
          const name = String(entry).trim();
          if (!name) continue;
          if (!SECRET_NAME_PATTERN.test(name)) {
            console.warn(`[config] worker '${w.name}': secret_allowlist entry '${name}' does not match pattern [A-Z0-9_]+; ignoring`);
            continue;
          }
          if (!validNames.includes(name)) validNames.push(name);
        }
        if (validNames.length === 0) {
          console.warn(`[config] worker '${w.name}': 'secret_allowlist' has no valid entries; treating as absent`);
          w.secret_allowlist = undefined;
        } else {
          w.secret_allowlist = validNames;
        }
      }
    }

    return {
      name: w.name,
      command: w.command,
      args: Array.isArray(w.args) ? w.args : [w.args],
      check: w.check,
      rate_limit_patterns: Array.isArray(w.rate_limit_patterns) ? w.rate_limit_patterns : [],
      priority: w.priority ?? i + 1,
      state_dir: w.state_dir,
      state_pattern: w.state_pattern,
      input_mode: w.input_mode || 'arg',
      output_format: w.output_format,
      check_timeout: w.check_timeout || 30,
      tunables: parseTunables(w.tunables, w.name),
      secret_allowlist: w.secret_allowlist,
      manual_only: w.manual_only === true ? true : undefined,
    };
  });

  workers.sort((a, b) => a.priority - b.priority);

  const evaluator: EvaluatorConfig | undefined = parsed.evaluator
    ? { worker: parsed.evaluator.worker ?? 'claude', timeout: parsed.evaluator.timeout ?? 60 }
    : undefined;

  const DEFAULT_BG: BgTasksConfig = { alert_seconds: 300, alert_repeat_seconds: 1800 };
  const rawBg = parsed.bg_tasks;
  let bg_tasks: BgTasksConfig = { ...DEFAULT_BG };
  if (rawBg) {
    const as = Number(rawBg.alert_seconds);
    const ars = Number(rawBg.alert_repeat_seconds);
    if (!Number.isInteger(as) || as < 60) {
      console.warn(`[config] bg_tasks.alert_seconds must be an integer >= 60; using default ${DEFAULT_BG.alert_seconds}`);
    } else {
      bg_tasks.alert_seconds = as;
    }
    if (!Number.isInteger(ars) || ars < bg_tasks.alert_seconds) {
      console.warn(`[config] bg_tasks.alert_repeat_seconds must be an integer >= alert_seconds; using default ${DEFAULT_BG.alert_repeat_seconds}`);
    } else {
      bg_tasks.alert_repeat_seconds = ars;
    }
  }

    const routing_policy = parseRoutingPolicy(parsed.routing_policy);
    if (routing_policy) {
      // Load-time cross-check: a typo'd worker name would silently fail open
      // at resolve time (code turns keep the topic default). Say so once here.
      const names = new Set(workers.map((w) => w.name));
      for (const field of ['general_worker', 'code_worker', 'peak_code_worker'] as const) {
        const target = routing_policy[field];
        if (target && !names.has(target)) {
          console.warn(`[config] routing_policy.${field} names unknown worker '${target}' (configured: ${[...names].join(', ')}); turns for it keep the topic default`);
        }
      }
    }

    return {
      workers,
      evaluator,
      topic_defaults: parsed.topic_defaults,
      bg_tasks,
      concurrency_limit: Number.isInteger(parsed.concurrency_limit) ? parsed.concurrency_limit : undefined,
      maintenance: parseMaintenance(parsed.maintenance),
      transcription: parseTranscription(parsed.transcription),
      usage: parseUsage(parsed.usage),
      cost_tier: parseCostTier(parsed.cost_tier),
      routing_policy,
      model_router: parseModelRouter(parsed.model_router),
      git_workflow: parseGitWorkflow(parsed.git_workflow),
      quota_aware_failover: typeof parsed.quota_aware_failover === 'boolean' ? parsed.quota_aware_failover : false,
      worker_pin: typeof parsed.worker_pin === 'string' ? parsed.worker_pin.trim() : undefined,
      browser: parseBrowser(parsed.browser),
      voice_inbox: parseVoiceInbox(parsed.voice_inbox),
    };
}

export async function saveTopicDefault(topicKey: string, worker: string | undefined): Promise<void> {
  const path = configPath();
  let raw = await readFile(path, 'utf8');

  const escapedKey = topicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingLineRegex = new RegExp(`^([ \\t]+${escapedKey}:[ \\t+])\\S+`, 'm');

  if (worker === undefined) {
    raw = raw.replace(new RegExp(`^[ \\t]+${escapedKey}:[ \\t]+\\S+\\r?\\n`, 'm'), '');
  } else if (existingLineRegex.test(raw)) {
    raw = raw.replace(existingLineRegex, `$1${worker}`);
  } else if (/^topic_defaults:/m.test(raw)) {
    raw = raw.replace(/^(topic_defaults:[ \t]*\r?\n)/m, `$1  ${topicKey}: ${worker}\n`);
  } else {
    raw += `\ntopic_defaults:\n  ${topicKey}: ${worker}\n`;
  }

  await writeFile(path, raw, 'utf8');
}
