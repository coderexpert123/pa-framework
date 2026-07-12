import { loadSkill, listSkills } from '../skills.js';
import { loadSecrets } from '../secrets.js';
import { runWithFailover, executeWorker } from '../workers.js';
import { loadConfig } from '../config.js';
import { writeLog } from '../logger.js';
import { sendToTelegram } from '../telegram.js';
import { addWorkerPid, removeWorkerPid } from '../worker-pids.js';
import { killProcessTree } from '../process-tree.js';
import { log } from '../lib/log.js';
import { notifyUser } from '../lib/notify.js';
import type { RunMeta, CommandResult, TelegramOutput, RunOptions } from '../types.js';

/**
 * Returns true if the skill output should be suppressed (not sent to Telegram).
 * Checks whether the last non-empty line is exactly "NO_OUTPUT" — this handles workers
 * like Gemini that may emit reasoning/preamble text before the sentinel.
 */
export function isNoOutputSentinel(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;

  const lastLine = trimmed.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  if (lastLine === 'NO_OUTPUT') return true;

  const compactLeakPattern =
    /(?:^|[\s`"'()[\]{}<>.,!?;:-])NO_OUTPUT$/;
  if (!compactLeakPattern.test(trimmed)) return false;

  const sentinelIndex = trimmed.lastIndexOf('NO_OUTPUT');
  const prefix = trimmed.slice(0, sentinelIndex).trim();
  if (!prefix) return true;

  // Some workers collapse a short status preamble and the sentinel onto one line,
  // e.g. "Checking ... NO_OUTPUT". Suppress only when the prefix looks like
  // worker narration rather than real user-facing content.
  return /(?:^|[\s`"'()[\]{}<>])(?:checking|inspecting|parsing|reading|filtering|summarizing|reviewing|scanning|looking|searching|analyzing|analysing|verifying|loading|opening|processing|working|i(?:'m| am| will| ll)|let me|need to|going to)\b/i.test(prefix);
}

/**
 * For cmd: shell skills, only inject explicitly declared secrets into the child env.
 * Returns empty object if no secrets declared — least-privilege by default.
 */
export function filterSecretsForShell(
  allSecrets: Record<string, string>,
  declaredSecrets?: string[],
): Record<string, string> {
  if (!declaredSecrets) return {};
  const filtered: Record<string, string> = {};
  for (const key of declaredSecrets) {
    if (allSecrets[key] !== undefined) {
      filtered[key] = allSecrets[key];
    }
  }
  return filtered;
}

/**
 * Post-execution handler: log result, print output, detect and run trigger skills.
 * Extracted to avoid duplicating this logic across the preferred-worker and failover paths.
 */
async function handleSkillResult(
  result: CommandResult,
  worker: string,
  skillName: string,
  duration: number,
  extraArgs: string[],
  depth: number,
  preferredWorker?: string,
  telegramOutput?: TelegramOutput,
  secrets?: Record<string, string>,
): Promise<void> {
  const meta: RunMeta = {
    worker,
    status: result.success ? 'success' : 'error',
    exitCode: result.exitCode,
    duration,
    timestamp: new Date().toISOString(),
    error: result.error,
    extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
  };

  await writeLog(skillName, result.output, meta);

  // Print result
  console.log('');
  if (result.success) {
    console.log(`[OK] ${skillName} completed via ${worker} (${(duration / 1000).toFixed(1)}s)`);
  } else {
    console.log(`[FAIL] ${skillName} failed via ${worker} (${(duration / 1000).toFixed(1)}s)`);
    if (result.error) console.log(`Error: ${result.error.slice(0, 500)}`);

    // Alert pa-alerts on skill failure (unless already alerted by runWithFailover exhaustion)
    if (!result.alreadyAlertedPaSupport) {
      notifyUser(
        `Skill failed: ${skillName}`,
        `Skill: ${skillName}\nWorker: ${worker}\nDuration: ${(duration / 1000).toFixed(1)}s\nError: ${(result.error ?? '').slice(0, 500)}`,
        { dedupKey: `skill-failed-${skillName}`, severity: 'error' },
      ).catch(() => {});
    }

    // Always alert the skill's own topic when telegram_output is configured
    if (telegramOutput && secrets) {
      const token = secrets[telegramOutput.token_secret];
      if (token) {
        notifyUser(
          `Skill failed: ${skillName}`,
          `Worker: ${worker}\nError: ${(result.error ?? 'unknown error').slice(0, 300)}`,
          {
            dedupKey: `skill-fail-topic-${skillName}`,
            topic: { chat_id: telegramOutput.chat_id, thread_id: telegramOutput.thread_id },
            severity: 'error',
          },
        ).catch(() => {});
      }
    }
  }

  // Check for NO_OUTPUT sentinel: suppress Telegram delivery if the last non-empty line is
  // exactly "NO_OUTPUT". Checking last-line (not full-output) handles workers like Gemini that
  // may prefix reasoning/preamble text before emitting the sentinel.
  if (result.success && result.output && !isNoOutputSentinel(result.output) && telegramOutput && secrets) {
    const token = secrets[telegramOutput.token_secret];
    if (token) {
      await sendToTelegram(result.output, telegramOutput, token);
    } else {
      console.warn(`[run] telegram_output: secret '${telegramOutput.token_secret}' not found — skipping Telegram delivery`);
    }
  }

  if (result.output) {
    console.log('\n--- Output ---');
    console.log(result.output);

    // Detect triggers: [pa run <skill-name> <extra-args>]
    const triggerRegex = /\[pa run ([a-zA-Z0-9_-]+)(.*?)\]/g;
    let match;
    const triggers = new Map<string, string[]>();
    while ((match = triggerRegex.exec(result.output)) !== null) {
      const name = match[1];
      const rawArgs = match[2].trim();
      let triggeredArgs: string[] = [];
      if (rawArgs) {
        triggeredArgs = rawArgs.split(/\s+/);
      }
      triggers.set(name, triggeredArgs);
    }

    if (triggers.size > 0) {
      console.log(`\nDetected ${triggers.size} triggers: ${Array.from(triggers.keys()).join(', ')}`);
      for (const [t, tArgs] of triggers) {
        console.log(`\nExecuting triggered skill: ${t}${tArgs.length > 0 ? ` with args: ${tArgs.join(' ')}` : ''}`);
        try {
          await runCommand(t, tArgs, depth + 1, preferredWorker);
        } catch (err: any) {
          console.error(`Failed to execute triggered skill '${t}': ${err.message}`);
        }
      }
    }
  }
}

export async function runCommand(
  skillName: string,
  extraArgs: string[] = [],
  depth = 0,
  preferredWorker?: string,
): Promise<CommandResult> {
  if (!skillName) {
    throw new Error('Usage: pa run <skill-name>');
  }

  const MAX_RECURSION_DEPTH = 3;
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(`Error: Maximum trigger recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`);
  }

  const skill = await loadSkill(skillName);
  let finalPrompt = skill.prompt;

  // If inject_triggers is set, find all other skills with trigger_descriptions
  if (skill.frontmatter.inject_triggers) {
    const allSkills = await listSkills();
    const otherTriggers = allSkills
      .filter((s) => s.name !== skillName && s.frontmatter.trigger_description)
      .map((s) => `[${s.name}] ${s.frontmatter.trigger_description}`);

    if (otherTriggers.length > 0) {
      finalPrompt = `${finalPrompt}\n\n## Trigger System: Available Skills\n` +
        `If the briefing content matches any of these triggers, output EXACTLY \`[pa run <skill-name>]\` on its own line after the briefing.\n\n` +
        otherTriggers.join('\n');
    }
  }

  // Load all secrets. For cmd: shell skills, filter to only declared secrets (security hardening).
  // For LLM workers, pass all secrets (they need API keys injected via env).
  const allSecrets = await loadSecrets();
  let secrets: Record<string, string>;
  if (skill.frontmatter.cmd) {
    secrets = filterSecretsForShell(allSecrets, skill.frontmatter.secrets);
    // Warn on missing declared secrets (same UX as LLM path)
    for (const key of skill.frontmatter.secrets ?? []) {
      if (allSecrets[key] === undefined) {
        console.warn(`Warning: secret '${key}' not found in secrets.env`);
      }
    }
  } else {
    if (skill.frontmatter.secrets) {
      for (const key of skill.frontmatter.secrets) {
        if (allSecrets[key] === undefined) {
          console.warn(`Warning: secret '${key}' not found in secrets.env`);
        }
      }
    }
    secrets = allSecrets;
  }

  console.log(`Running skill: ${skillName}${extraArgs.length > 0 ? ` with extra args: ${extraArgs.join(' ')}` : ''}`);

  // 1. Direct command execution (bypasses LLM)
  if (skill.frontmatter.cmd) {
    const start = Date.now();
    const fullCmd = extraArgs.length > 0 ? `${skill.frontmatter.cmd} ${extraArgs.join(' ')}` : skill.frontmatter.cmd;
    const { spawn } = await import('child_process');
    const timeoutSec = skill.frontmatter.timeout;

    return new Promise<CommandResult>((resolve) => {
      const child = spawn(fullCmd, {
        shell: true,
        cwd: skill.frontmatter.cwd,
        env: { ...process.env, ...secrets },
        // POSIX only — see worker-exec.ts spawn for rationale (process-group
        // leader for killProcessTree; Windows keeps taskkill /T).
        detached: process.platform !== 'win32',
      });

      let output = '';
      let error = '';
      let killed = false;

      // PID tracking — reuses Phase 2C infrastructure for orphan cleanup on restart
      const pidTracked = child.pid
        ? addWorkerPid({
            pid: child.pid,
            spawnedBy: process.pid,
            worker: 'shell',
            skill: skillName,
            startedAt: new Date().toISOString(),
          }).catch(() => {})
        : undefined;

      // Timeout with process-tree kill → SIGKILL fallback
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timeoutTimer = timeoutSec
        ? setTimeout(() => {
            killed = true;
            log('warn', 'run', `Shell skill ${skillName} timed out after ${timeoutSec}s`, { skill: skillName });
            if (child.pid) {
              killProcessTree(child.pid);
              // Fallback SIGKILL after 5s if still alive
              killTimer = setTimeout(() => {
                try { process.kill(child.pid!, 'SIGKILL'); } catch {}
              }, 5000);
            }
          }, timeoutSec * 1000)
        : undefined;

      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { error += data.toString(); });

      child.on('close', async (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (child.pid) {
          await (pidTracked || Promise.resolve()).then(() => removeWorkerPid(child.pid!)).catch(() => {});
        }
        const result: CommandResult = {
          success: !killed && code === 0,
          output: killed ? `[Timed out after ${timeoutSec}s]\n${output.trim()}` : output.trim(),
          error: error.trim() || undefined,
          exitCode: code,
        };
        // Pass allSecrets for Telegram delivery (needs TELEGRAM_BOT_TOKEN)
        await handleSkillResult(result, 'shell', skillName, Date.now() - start, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, allSecrets);
        resolve(result);
      });

      child.on('error', async (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (child.pid) {
          (pidTracked || Promise.resolve()).then(() => removeWorkerPid(child.pid!)).catch(() => {});
        }
        // Notify before resolving — shell-skill spawn failure
        await notifyUser(
          `Shell skill spawn failed: ${skillName}`,
          `Skill: ${skillName}\nCommand: ${fullCmd.slice(0, 200)}\nError: ${err.message}`,
          { dedupKey: `shell-skill-spawn-${skillName}`, severity: 'error' },
        ).catch(() => {});
        const failResult: CommandResult = {
          success: false,
          alreadyAlertedPaSupport: true,
          error: err.message ?? String(err),
          exitCode: -1,
          output: output.trim(),
        };
        await handleSkillResult(failResult, 'shell', skillName, Date.now() - start, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, allSecrets);
        resolve(failResult);
      });
    });
  }

  // 2. LLM worker execution
  // Skill-declared worker_args (e.g. gemini --include-directories to widen its
  // file-tool workspace past the shim-forced repo cwd) prepend the run-time
  // extraArgs. cmd-based skills above don't use these — they're worker CLI flags.
  const workerExtraArgs = [...(skill.frontmatter.worker_args ?? []), ...extraArgs];
  // Resolve preferred worker: CLI --worker flag > skill frontmatter > global failover
  const workerPref = preferredWorker || skill.frontmatter.worker;
  const willFailover = !skill.frontmatter.no_fallback;
  if (workerPref) {
    const config = await loadConfig();
    const workerConfig = config.workers.find((w) => w.name === workerPref);
    if (workerConfig) {
      const start = Date.now();
      const prefResult = await executeWorker(workerConfig, finalPrompt, {
        cwd: skill.frontmatter.cwd,
        env: secrets,
        timeout: skill.frontmatter.timeout,
        idleTimeout: skill.frontmatter.idle_timeout,
        extraArgs: workerExtraArgs,
        resource: `skill-${skillName}`,
        agentName: workerPref,
        suppressExitAlert: willFailover,
      });
      if (prefResult.success) {
        await handleSkillResult(prefResult, workerPref, skillName, Date.now() - start, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, secrets);
        return prefResult;
      }
      // Pinned worker failed
      if (willFailover) {
        console.warn(`[run] preferred worker ${workerPref} failed for ${skillName}, falling back to failover`);
      } else {
        await handleSkillResult(prefResult, workerPref, skillName, Date.now() - start, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, secrets);
        return prefResult;
      }
    } else {
      console.warn(`[run] preferred worker '${workerPref}' not found in config, falling back to failover`);
    }
  }

  const start = Date.now();
  const failoverOpts: RunOptions = {
    cwd: skill.frontmatter.cwd,
    env: secrets,
    timeout: skill.frontmatter.timeout,
    idleTimeout: skill.frontmatter.idle_timeout,
    extraArgs: workerExtraArgs,
    resource: `skill-${skillName}`,
    noFallback: !!skill.frontmatter.no_fallback,
  };
  // When pinned worker failed and we're falling back, exclude it and record the prior attempt
  if (workerPref && willFailover) {
    failoverOpts.excludeWorkers = new Set([workerPref]);
    failoverOpts.priorAttempts = [workerPref];
  }
  const { result, worker } = await runWithFailover(finalPrompt, failoverOpts);

  await handleSkillResult(result, worker, skillName, Date.now() - start, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, secrets);
  return result;
}
