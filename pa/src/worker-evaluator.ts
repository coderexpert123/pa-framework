import { loadConfig } from './config.js';
import { readStateTail } from './state-monitor.js';
import { log } from './lib/log.js';
import { notifyUser } from './lib/notify.js';
import type { WorkerConfig, CommandResult, RunOptions, EvaluatorConfig } from './types.js';

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

    // Don't evaluate yourself — would cause recursion
    if (evalCfg.worker === stuckWorkerName) return null;

    const evalWorker = config.workers.find((w) => w.name === evalCfg.worker);
    if (!evalWorker) return null;

    const stateContent = await readStateTail(stateDir, statePattern);
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

    const result = await executor(evalWorker, prompt, {
      timeout: evalCfg.timeout,
      idleTimeout: 30,
      isEvaluator: true,
      resource: `evaluator-${stuckWorkerName}`,
      agentName: evalCfg.worker,
      env,  // pass through secrets so evaluator has API keys
    });

    if (!result.success || !result.output.trim()) return null;

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
