import { readFile, writeFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { configPath } from './paths.js';
import type { PaConfig, WorkerConfig, EvaluatorConfig, BgTasksConfig, TunableSpec, TunableValues } from './types.js';

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

  const workers: WorkerConfig[] = parsed.workers.map((w: any, i: number) => {
    if (!w.name || !w.command || !w.args || !w.check) {
      throw new Error(`Worker #${i + 1} missing required fields (name, command, args, check)`);
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

    return {
      workers,
      evaluator,
      topic_defaults: parsed.topic_defaults,
      bg_tasks,
      concurrency_limit: Number.isInteger(parsed.concurrency_limit) ? parsed.concurrency_limit : 2,
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
