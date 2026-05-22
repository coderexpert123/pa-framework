import { readFile } from 'fs/promises';
import { parse as parseYaml } from 'yaml';
import { configPath } from './paths.js';
import type { PaConfig, WorkerConfig, EvaluatorConfig, BgTasksConfig } from './types.js';

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

  return { workers, evaluator, topic_defaults: parsed.topic_defaults, bg_tasks };
}
