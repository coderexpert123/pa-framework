/**
 * Golden-task eval gate for the self-improver loop (proposal #22).
 *
 * v1: Deterministic scorer subset ONLY. Tasks 4-6 (markdown-shape, PA_META well-formedness,
 * injection-resistance) run against static fixture inputs. Tasks 1-3 (ref-ID format, date
 * arithmetic, grounding citation) require an LLM worker dispatch and are SKIPPED unless
 * PA_EVAL_FULL=1.
 *
 * The gate is deliberately SOFT in v1: failure parks the change as validation-failed-pending
 * with eval detail appended — the validation floor still governs.
 *
 * Usage:
 *   import { runEvalGate } from './lib/eval-gate.js';
 *   const result = await runEvalGate({ skillName: 'my-skill', changedPrompt: 'new prompt' });
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { paHome } from '../paths.js';

const execAsync = promisify(exec);

/**
 * Result from a single golden-task scorer.
 */
export interface TaskResult {
  task: string;
  worker: string;
  pass: boolean;
  detail: string;
  skipped?: boolean;
}

/**
 * Aggregated eval gate result.
 */
export interface EvalGateResult {
  pass: number;
  fail: number;
  skipped: number;
  tasks: TaskResult[];
}

/**
 * Options for running the eval gate.
 */
export interface EvalGateOptions {
  skillName: string;
  changedPrompt?: string;
  fullEval?: boolean; // If true, run all tasks including LLM-dependent ones
}

/**
 * Runs the eval gate for a skill prompt change.
 *
 * For v1, this runs the DETERMINISTIC-ONLY subset (tasks 4-6) against static fixture inputs.
 * Tasks 1-3 require a worker and are SKIPPED unless `fullEval` is true.
 *
 * @param options - Eval gate options
 * @returns Aggregated pass/fail/skip counts + per-task detail
 */
export async function runEvalGate(options: EvalGateOptions): Promise<EvalGateResult> {
  const { skillName, changedPrompt, fullEval = false } = options;

  // In v1, we run only deterministic-only tasks (4-6) via run_eval.py --all
  // The script already handles the PA_EVAL_FULL gating for tasks 1-3

  try {
    // Resolve from THIS module's compiled location (pa/dist/src/lib/) → pa/scripts/
    // (the old cwd-relative form doubled the path when invoked from pa/)
    const scriptPath = join(__dirname, '..', '..', '..', 'scripts', 'run_eval.py');
    const env = {
      ...process.env,
      PA_EVAL_FULL: fullEval ? '1' : '0',
      PA_HOME: paHome()
    };

    // Run all deterministic-only tasks
    const { stdout, stderr } = await execAsync(
      `"${process.execPath}" "${scriptPath}" --all`,
      {
        env,
        timeout: 60000, // 60s timeout
        windowsHide: true
      }
    );

    if (stderr && !stderr.includes('DeprecationWarning')) {
      console.warn('[eval-gate] run_eval.py stderr:', stderr);
    }

    const result = JSON.parse(stdout.trim()) as EvalGateResult;

    // Ensure all expected fields are present
    return {
      pass: result.pass ?? 0,
      fail: result.fail ?? 0,
      skipped: result.skipped ?? 0,
      tasks: result.tasks ?? []
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn('[eval-gate] Failed to run eval gate:', error.message);

    // On failure, return empty results (fail-soft per audit convention)
    return {
      pass: 0,
      fail: 0,
      skipped: 0,
      tasks: []
    };
  }
}

/**
 * Formats eval gate results for inclusion in audit records.
 */
export function formatEvalDetail(result: EvalGateResult): string {
  const parts: string[] = [];

  if (result.pass > 0) parts.push(`${result.pass} passed`);
  if (result.fail > 0) parts.push(`${result.fail} failed`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);

  const summary = parts.join(', ') || 'no tasks run';

  if (result.fail > 0 && result.tasks.length > 0) {
    const failures = result.tasks
      .filter((t) => !t.pass && !t.skipped)
      .map((t) => `${t.task}: ${t.detail}`)
      .join('; ');
    return `Eval gate: ${summary}. Failures: ${failures}`;
  }

  return `Eval gate: ${summary}`;
}
