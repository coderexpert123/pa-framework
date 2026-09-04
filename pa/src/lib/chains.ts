/**
 * Sequential workflow chains for PA.
 *
 * Chains are defined as YAML files in ~/.pa/chains/ and execute a series of
 * skills sequentially, with retry logic and failure handling.
 *
 * Schema (strict, validated on load):
 *   steps:
 *     - skill: <name>
 *       args?: <string array>
 *       retry?:
 *         max: <number>  # default 1
 *         backoff_s: <number>  # default 0
 *       on_failure: stop|notify|continue  # default stop
 *   report: telegram|stdout  # default stdout
 *
 * Sequential only: no parallel execution.
 * Each step spawns `pa run <skill>` in a subprocess, inheriting git-workflow
 * lock discipline automatically (children take their own locks).
 *
 * End-of-chain report is sent to pa-alerts (deduped by chain-name+date) when
 * report=telegram, or printed to stdout when report=stdout (default).
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { paHome } from '../paths.js';
import { parse as parseYaml } from 'yaml';
import { spawn } from 'child_process';
import { parseCallbackData } from './callback-grammar.js';
import { log } from './log.js';
import { notifyUser } from './notify.js';

/**
 * Chain schema types.
 */

export interface ChainRetry {
  max: number;
  backoff_s: number;
}

export type ChainOnFailure = 'stop' | 'notify' | 'continue';

export interface ChainStep {
  skill: string;
  args?: string[];
  retry?: ChainRetry;
  on_failure?: ChainOnFailure;
}

export type ChainReport = 'telegram' | 'stdout';

export interface ChainDefinition {
  steps: ChainStep[];
  report?: ChainReport;
}

/**
 * Validation error with context.
 */
export class ChainValidationError extends Error {
  public readonly path: string;
  public readonly field?: string;

  constructor(message: string, path: string, field?: string) {
    super(message);
    this.name = 'ChainValidationError';
    this.path = path;
    this.field = field;
  }
}

/**
 * Allowed fields in chain schema (strict validation).
 */
const ALLOWED_TOP_LEVEL_FIELDS = new Set(['steps', 'report']);
const ALLOWED_STEP_FIELDS = new Set(['skill', 'args', 'retry', 'on_failure']);
const ALLOWED_RETRY_FIELDS = new Set(['max', 'backoff_s']);
const ALLOWED_ON_FAILURE_VALUES = new Set<ChainOnFailure>(['stop', 'notify', 'continue']);

/**
 * Validate a chain definition against the strict schema.
 * Throws ChainValidationError on any violation.
 */
function validateChain(def: any, path: string): ChainDefinition {
  if (!def || typeof def !== 'object') {
    throw new ChainValidationError('Chain definition must be an object', path);
  }

  // Check for unknown top-level fields
  const unknownTopFields = Object.keys(def).filter(k => !ALLOWED_TOP_LEVEL_FIELDS.has(k));
  if (unknownTopFields.length > 0) {
    throw new ChainValidationError(
      `Unknown top-level fields: ${unknownTopFields.join(', ')}`,
      path,
      'top-level'
    );
  }

  // Validate steps array
  if (!Array.isArray(def.steps)) {
    throw new ChainValidationError('Field "steps" must be an array', path, 'steps');
  }

  if (def.steps.length === 0) {
    throw new ChainValidationError('Field "steps" must contain at least one step', path, 'steps');
  }

  // Validate each step
  def.steps.forEach((step: any, idx: number) => {
    const stepPrefix = `steps[${idx}]`;

    if (!step || typeof step !== 'object') {
      throw new ChainValidationError(`Step ${idx} must be an object`, path, stepPrefix);
    }

    // Check for unknown step fields
    const unknownStepFields = Object.keys(step).filter(k => !ALLOWED_STEP_FIELDS.has(k));
    if (unknownStepFields.length > 0) {
      throw new ChainValidationError(
        `Step ${idx} has unknown fields: ${unknownStepFields.join(', ')}`,
        path,
        stepPrefix
      );
    }

    // Validate required skill field
    if (typeof step.skill !== 'string' || !step.skill.trim()) {
      throw new ChainValidationError(`Step ${idx} must have a non-empty "skill" string`, path, `${stepPrefix}.skill`);
    }

    // Validate args (optional)
    if (step.args !== undefined && !Array.isArray(step.args)) {
      throw new ChainValidationError(`Step ${idx} field "args" must be an array`, path, `${stepPrefix}.args`);
    }

    if (step.args !== undefined) {
      for (let i = 0; i < step.args.length; i++) {
        if (typeof step.args[i] !== 'string') {
          throw new ChainValidationError(
            `Step ${idx} args[${i}] must be a string`,
            path,
            `${stepPrefix}.args[${i}]`
          );
        }
      }
    }

    // Validate retry (optional)
    if (step.retry !== undefined) {
      if (typeof step.retry !== 'object' || Array.isArray(step.retry)) {
        throw new ChainValidationError(`Step ${idx} field "retry" must be an object`, path, `${stepPrefix}.retry`);
      }

      // Check for unknown retry fields
      const unknownRetryFields = Object.keys(step.retry).filter(k => !ALLOWED_RETRY_FIELDS.has(k));
      if (unknownRetryFields.length > 0) {
        throw new ChainValidationError(
          `Step ${idx} retry has unknown fields: ${unknownRetryFields.join(', ')}`,
          path,
          `${stepPrefix}.retry`
        );
      }

      // max defaults to 1
      const max = step.retry.max ?? 1;
      if (typeof max !== 'number' || max < 1 || !Number.isInteger(max)) {
        throw new ChainValidationError(
          `Step ${idx} retry.max must be an integer >= 1`,
          path,
          `${stepPrefix}.retry.max`
        );
      }

      // backoff_s defaults to 0
      const backoff = step.retry.backoff_s ?? 0;
      if (typeof backoff !== 'number' || backoff < 0) {
        throw new ChainValidationError(
          `Step ${idx} retry.backoff_s must be a number >= 0`,
          path,
          `${stepPrefix}.retry.backoff_s`
        );
      }
    }

    // Validate on_failure (optional, defaults to 'stop')
    if (step.on_failure !== undefined) {
      if (!ALLOWED_ON_FAILURE_VALUES.has(step.on_failure)) {
        throw new ChainValidationError(
          `Step ${idx} on_failure must be one of: stop, notify, continue`,
          path,
          `${stepPrefix}.on_failure`
        );
      }
    }
  });

  // Validate report (optional, defaults to 'stdout')
  if (def.report !== undefined && def.report !== 'telegram' && def.report !== 'stdout') {
    throw new ChainValidationError('Field "report" must be "telegram" or "stdout"', path, 'report');
  }

  // Apply defaults
  const steps: ChainStep[] = def.steps.map((s: any) => ({
    skill: s.skill,
    args: s.args ?? [],
    retry: s.retry ?? { max: 1, backoff_s: 0 },
    on_failure: s.on_failure ?? 'stop',
  }));

  return {
    steps,
    report: def.report ?? 'stdout',
  };
}

/**
 * Load a chain definition from a YAML file.
 * Throws ChainValidationError on validation errors.
 */
export async function loadChain(name: string): Promise<{ def: ChainDefinition; path: string }> {
  const chainsDir = join(paHome(), 'chains');
  const chainPath = join(chainsDir, `${name}.yaml`);

  if (!existsSync(chainPath)) {
    throw new ChainValidationError(`Chain "${name}" not found at ${chainPath}`, chainPath);
  }

  const content = await readFile(chainPath, 'utf8');
  const raw = parseYaml(content);
  const def = validateChain(raw, chainPath);

  return { def, path: chainPath };
}

/**
 * Execute a single step with retry logic.
 */
async function executeStep(
  step: ChainStep,
  chainName: string,
  stepIndex: number,
  spawnFn?: (args: string[]) => Promise<{ success: boolean; output: string }>
): Promise<{ success: boolean; output: string }> {
  const spawnDep = spawnFn ?? spawnPa;
  const maxAttempts = step.retry?.max ?? 1;
  const backoffSec = step.retry?.backoff_s ?? 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log('info', 'chains', `executing step`, {
      chain: chainName,
      step: stepIndex,
      skill: step.skill,
      attempt,
      maxAttempts,
    });

    const args = ['run', step.skill, ...(step.args ?? [])];
    const result = await spawnDep(args);

    if (result.success) {
      return result;
    }

    // If not the last attempt, wait before retry
    if (attempt < maxAttempts && backoffSec > 0) {
      log('info', 'chains', `step failed, retrying after backoff`, {
        chain: chainName,
        step: stepIndex,
        skill: step.skill,
        attempt,
        nextAttempt: attempt + 1,
        backoffSec,
      });
      await new Promise(resolve => setTimeout(resolve, backoffSec * 1000));
    } else if (attempt === maxAttempts) {
      log('warn', 'chains', `step failed after all retries`, {
        chain: chainName,
        step: stepIndex,
        skill: step.skill,
        attempts: maxAttempts,
      });
      return result;
    }
  }

  // Should never reach here, but TypeScript needs it
  return { success: false, output: 'Unknown error' };
}

/**
 * Spawn `pa` as a subprocess and capture output.
 */
function spawnPa(args: string[]): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', ['pa/dist/bin/pa.js', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout || stderr,
      });
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        output: `Spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Execute a chain sequentially.
 * Returns overall success status and a report message.
 */
export async function executeChain(
  name: string,
  opts: { spawnFn?: (args: string[]) => Promise<{ success: boolean; output: string }> } = {}
): Promise<{ success: boolean; report: string }> {
  // spawnFn is a test seam (the DI pattern — ESM exports are read-only, so
  // callers inject rather than mock). Production leaves it unset.
  const { def, path: chainPath } = await loadChain(name);
  const chainName = name; // For logging

  log('info', 'chains', `starting chain execution`, {
    chain: chainName,
    steps: def.steps.length,
    report: def.report,
  });

  const results: Array<{ step: number; skill: string; success: boolean; output: string }> = [];

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    const result = await executeStep(step, chainName, i, opts.spawnFn);

    results.push({
      step: i,
      skill: step.skill,
      success: result.success,
      output: result.output,
    });

    if (!result.success) {
      const onFailure = step.on_failure ?? 'stop';

      if (onFailure === 'stop') {
        log('warn', 'chains', `chain stopped on failure`, {
          chain: chainName,
          step: i,
          skill: step.skill,
        });

        const report = generateReport(chainName, results, def.report, 'stopped_on_failure');
        await sendReport(report, def.report, chainName);

        return { success: false, report: report.message };
      }

      if (onFailure === 'notify') {
        await notifyUser(
          `Chain step failed: ${chainName}`,
          `Step ${i} (${step.skill}) failed. Continuing to next step.\n\nOutput:\n${result.output.slice(0, 500)}`,
          { dedupKey: `chain-${chainName}-${new Date().toISOString().slice(0, 10)}` }
        );
      }

      // on_failure === 'continue' - just log and continue
      log('info', 'chains', `step failed, continuing`, {
        chain: chainName,
        step: i,
        skill: step.skill,
        on_failure: onFailure,
      });
    }
  }

  log('info', 'chains', `chain execution completed`, {
    chain: chainName,
    totalSteps: def.steps.length,
    successfulSteps: results.filter(r => r.success).length,
  });

  const report = generateReport(chainName, results, def.report, 'completed');
  await sendReport(report, def.report, chainName);

  const overallSuccess = results.every(r => r.success);
  return { success: overallSuccess, report: report.message };
}

/**
 * Generate a human-readable report of chain execution.
 */
interface ChainReportData {
  message: string;
  details: string;
}

function generateReport(
  name: string,
  results: Array<{ step: number; skill: string; success: boolean; output: string }>,
  reportType: ChainReport | undefined,
  status: 'completed' | 'stopped_on_failure'
): ChainReportData {
  const successful = results.filter(r => r.success).length;
  const failed = results.length - successful;

  let message = `Chain "${name}" ${status}: ${successful}/${results.length} steps succeeded`;

  if (failed > 0) {
    message += ` (${failed} failed)`;
  }

  const lines: string[] = [message, '', 'Steps:'];

  for (const r of results) {
    const status = r.success ? '✓' : '✗';
    lines.push(`  ${status} Step ${r.step}: ${r.skill}`);
    if (!r.success && reportType === 'telegram') {
      // Include truncated output for failed steps in telegram reports
      const preview = r.output.slice(0, 200).trim();
      if (preview) {
        lines.push(`    ${preview}${r.output.length > 200 ? '...' : ''}`);
      }
    }
  }

  const details = lines.join('\n');
  return { message, details };
}

/**
 * Send the chain report to the appropriate destination.
 */
async function sendReport(report: ChainReportData, reportType: ChainReport | undefined, chainName: string): Promise<void> {
  if (reportType === 'telegram') {
    // Dedup by chain-name+date to avoid spamming on repeated failures
    const today = new Date().toISOString().slice(0, 10);
    const failed = report.details.includes('failed');
    await notifyUser(`Chain report: ${chainName}`, report.details, {
      dedupKey: `chain-${chainName}-${today}`,
      severity: failed ? 'warn' : 'info',
      // WP-D2 B.6 (2026-09-02): a failure report carries the one-tap re-run button.
      // The bot two-tap-confirms it (first tap rewrites to ch:r:<name>:c) before
      // spawning `pa chain run <name>`, so the unconfirmed data here is safe. Grammar-
      // checked: a chain name outside the ch: charset would make a DEAD button — no
      // button beats a dead one.
      replyMarkup: failed && parseCallbackData(`ch:r:${chainName}`)
        ? { inline_keyboard: [[{ text: '🔁 Re-run chain', callback_data: `ch:r:${chainName}` }]] }
        : undefined,
    });
  } else {
    // stdout
    console.log(report.details);
  }
}
