import { loadConfig } from './config.js';
import { readUsableStateTail } from './state-monitor.js';
import { log } from './lib/log.js';
import { notifyUser } from './lib/notify.js';
import type { WorkerConfig, CommandResult, RunOptions, EvaluatorConfig } from './types.js';
import { autoDispatchEligibility } from './rate-limits.js';
import { readPressureSampleCached, type PressureSample } from './lib/pressure-sample.js';
import { DEFAULT_PHYSICAL_BRAKE_MB, DEFAULT_CPU_BRAKE_PCT, DEFAULT_DISK_QUEUE_BRAKE } from './lib/dynamic-slots.js';

export interface EvaluatorVerdict {
  verdict: 'extend' | 'kill' | 'done';
  summary: string;
  reason: string;
}

/**
 * Send a Telegram alert to pa-support when the evaluator returns unparseable output.
 * Best-effort — never throws.
 */
async function notifyEvaluatorFailure(workerName: string, rawOutput: string, reason: string): Promise<void> {
  const truncated = rawOutput.length > 800
    ? rawOutput.slice(0, 800) + `\n\n[truncated — ${rawOutput.length} chars total]`
    : rawOutput;

  await notifyUser(
    `Evaluator parse failure: ${workerName}`,
    `Worker: ${workerName}\nReason: ${reason}\nVerdict: defaulted to extend\n\n${truncated}`,
    { dedupKey: `evaluator-${workerName}`, severity: 'warn' },
  ).catch(() => {});
}

/**
 * Zero-meaningful knob reader mirroring dynamic-slots.ts's envIntZeroOk: 0
 * is a VALUE (it disables that pressure input), so the accept test is
 * >= 0, not > 0. Local mirror — no new shared const, no new import.
 */
function evalEnvIntZeroOk(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Pressure-scaled evaluator timeout multiplier (1x–3x). Pure: the sample is
 * passed in, brake knobs are read live. Per-input null = no evidence = skip
 * that input (sampler doctrine). Floor (1x) = today's configured values;
 * PA_DYNAMIC_SLOTS=0 (existing kill switch) forces 1x.
 */
export function evaluatorTimeoutMultiplier(sample: PressureSample | null): 1 | 2 | 3 {
  if (sample === null) return 1;
  if (process.env.PA_DYNAMIC_SLOTS === '0') return 1;
  const brakeMb = evalEnvIntZeroOk('PA_SLOTS_PHYSICAL_BRAKE_MB', DEFAULT_PHYSICAL_BRAKE_MB);
  const cpuBrake = evalEnvIntZeroOk('PA_SLOTS_CPU_BRAKE_PCT', DEFAULT_CPU_BRAKE_PCT);
  const dqBrake = evalEnvIntZeroOk('PA_SLOTS_DISK_QUEUE_BRAKE', DEFAULT_DISK_QUEUE_BRAKE);
  const severe =
    (brakeMb > 0 && sample.physFreeMb !== null && sample.physFreeMb < brakeMb / 2) ||
    (cpuBrake > 0 && sample.cpuPct !== null && sample.cpuPct >= 97) ||
    (dqBrake > 0 && sample.diskQueue !== null && sample.diskQueue >= dqBrake * 2);
  if (severe) return 3;
  const pressured =
    (brakeMb > 0 && sample.physFreeMb !== null && sample.physFreeMb < brakeMb) ||
    (cpuBrake > 0 && sample.cpuPct !== null && sample.cpuPct >= cpuBrake) ||
    (dqBrake > 0 && sample.diskQueue !== null && sample.diskQueue >= dqBrake);
  if (pressured) return 2;
  return 1;
}

/**
 * Spawn a separate CLI instance to evaluate the stuck worker's conversation trace
 * and decide whether to extend its timeout or kill it.
 *
 * Returns null if the evaluator is unavailable or fails — caller falls through
 * to standard behavior.
 *
 * executor is injected to avoid a circular dependency between worker-evaluator
 * and worker-exec (which calls evaluateWorkerState).
 */
export async function evaluateWorkerState(
  stateDir: string,
  statePattern: string,
  stuckWorkerName: string,
  env?: Record<string, string>,
  executor?: (worker: WorkerConfig, prompt: string, opts: RunOptions) => Promise<CommandResult>,
): Promise<EvaluatorVerdict | null> {
  if (!executor) return null;

  try {
    const config = await loadConfig();
    const evalCfg: EvaluatorConfig = config.evaluator ?? { worker: 'claude', timeout: 60 };

    // Build the evaluator worker chain: the configured worker first (unless
    // it IS the stuck worker), then all remaining workers SORTED BY PRIORITY
    // as fallbacks. Sorting is load-bearing — config.workers is in YAML file
    // order (zclaude first), not priority order, so without the sort zclaude
    // would be tried before agyc despite being lower priority.
    const evalWorkers: WorkerConfig[] = [];
    const excluded = new Set([stuckWorkerName]);
    const primary = config.workers.find((w) => w.name === evalCfg.worker);
    if (primary && (await autoDispatchEligibility(primary, { excludeWorkers: excluded })).eligible) {
      evalWorkers.push(primary);
    }
    const sorted = [...config.workers].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    for (const w of sorted) {
      if (!evalWorkers.some(e => e.name === w.name)
        && (await autoDispatchEligibility(w, { excludeWorkers: excluded })).eligible) {
        evalWorkers.push(w);
      }
    }
    if (evalWorkers.length === 0) return null;

    // DO NOT REGRESS: readUsableStateTail, never readStateTail. Some workers
    // (agy) keep their conversation in a binary SQLite/protobuf store, and the
    // raw tail of that file must never be interpolated into the prompt below —
    // it is pure noise to the model and it smuggles fragments of whatever files
    // the stuck agent had read into a different vendor's CLI. No usable state
    // means no verdict, which the caller already treats as "fall through to
    // standard behavior".
    const tail = await readUsableStateTail(stateDir, statePattern, stuckWorkerName);
    if (tail.problem) return null;
    const stateContent = tail.content;
    if (!stateContent) return null;

    const prompt = `You are evaluating whether an AI agent subprocess should be allowed to continue running or should be terminated.

The agent has been idle (no stdout/stderr output) for its configured idle timeout period. Below is the tail of its conversation state file (last 32KB). This may be truncated JSON — that is fine, read it as-is.

Analyze and respond with ONLY a JSON object, no markdown, no explanation:
{"verdict": "extend" | "kill" | "done", "summary": "...", "reason": "..."}

Rules:
- "extend" if the agent is making meaningful, distinct progress — new tool calls with new arguments, genuinely different reasoning steps, active problem-solving
- "done" if the agent has produced a complete, final response and is simply waiting for more input (i.e. the task is finished correctly, the process just hasn't exited yet)
- "kill" if the agent is: repeating itself or looping (same thoughts/content reworded), producing no meaningful new output due to being stuck, or making a fundamental mistake it will not recover from
- "summary" must be a user-friendly 1-3 sentence description. For "kill"/"done": what was accomplished. For "extend": what it is actively working on.
- Use "done" (not "kill") when the agent finished correctly — this distinction matters for how the result is reported to the user.

Conversation state tail:
---
${stateContent}
---`;

    let result: CommandResult | null = null;
    let evalWorkerUsed: WorkerConfig | undefined;

    // Pressure-scaled timeouts: floor = today's configured values, ceiling
    // 3x. The sample read is sync, TTL-cached, spawn-free RAM/CPU — safe on
    // this path. PA_DYNAMIC_SLOTS=0 forces 1x (inside the multiplier).
    const pressureMult = evaluatorTimeoutMultiplier(readPressureSampleCached());

    for (const evalWorker of evalWorkers) {
      try {
        const attempt = await executor(evalWorker, prompt, {
          timeout: evalCfg.timeout * pressureMult,
          idleTimeout: 30 * pressureMult,
          isEvaluator: true,
          stripArgs: ['--append-system-prompt-file'],
          resource: `evaluator-${stuckWorkerName}`,
          agentName: evalWorker.name,
          env,
        });
        if (attempt.success && attempt.output.trim()) {
          result = attempt;
          evalWorkerUsed = evalWorker;
          break;
        }
        // Worker responded but output was empty or failed — try next in chain
        log('info', 'evaluator', `evaluator worker ${evalWorker.name} produced no usable result, trying next in fallback chain`, {
          stuckWorker: stuckWorkerName,
        });
      } catch {
        // Worker spawn failed entirely — try next in chain
        continue;
      }
    }

    if (!result || !evalWorkerUsed) return null;

    // Strip markdown code fences if the LLM wrapped its response
    const raw = result.output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

    let parsed: EvaluatorVerdict;
    try {
      parsed = JSON.parse(raw) as EvaluatorVerdict;
    } catch {
      // Non-JSON output — default to extend (safe action per ambiguous-error standard)
      log('warn', 'evaluator', 'Evaluator returned non-JSON output', {
        worker: stuckWorkerName, rawLength: raw.length, rawPreview: raw.slice(0, 200),
      });
      await notifyEvaluatorFailure(stuckWorkerName, raw, 'non-JSON output');
      return { verdict: 'extend', summary: 'Evaluator output not parseable — defaulting to extend', reason: raw.slice(0, 200) };
    }

    if (parsed.verdict !== 'extend' && parsed.verdict !== 'kill' && parsed.verdict !== 'done') {
      log('warn', 'evaluator', 'Evaluator returned invalid verdict', {
        worker: stuckWorkerName, verdict: (parsed as any).verdict, rawPreview: raw.slice(0, 200),
      });
      await notifyEvaluatorFailure(stuckWorkerName, raw, `invalid verdict: ${(parsed as any).verdict}`);
      return { verdict: 'extend', summary: 'Evaluator returned invalid verdict — defaulting to extend', reason: raw.slice(0, 200) };
    }

    return parsed;
  } catch {
    return null;
  }
}
