import { loadSkill, listSkills } from '../skills.js';
import { loadSecrets } from '../secrets.js';
import { runWithFailover, executeWorker } from '../workers.js';
import { loadConfig } from '../config.js';
import { writeLog } from '../logger.js';
import { sendToTelegram, type SendResult } from '../telegram.js';
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
 * A skill that declares `telegram_output` exists to DELIVER something. If it exits 0
 * with empty/whitespace-only stdout, nothing is sent AND the run is recorded 'success'
 * — a completely silent no-op that no alert, log, or backoff ever notices. Reference
 * case from the 2026-07-16..21 audit: ~/.pa/logs/oracle/20260717-081242-b56c4e.log is
 * 0 BYTES after 436s of runtime, recorded status 'success', delivered nothing.
 * Treat that shape as a failure so it reaches consecutiveFailures / the AI-098 backoff.
 *
 * DO NOT WIDEN THIS SCOPE. The `telegramOutput` guard is load-bearing, not cosmetic:
 * `reminders` runs on `* * * * *` (1440 runs/day) and legitimately produces no output
 * on the overwhelming majority of them — it declares no telegram_output, and applying
 * this rule to it would manufacture a 1440-failures-per-day outage.
 *
 * The designed escape hatch for a telegram_output skill that legitimately has nothing
 * to say is the NO_OUTPUT sentinel (isNoOutputSentinel above) — an explicit "I ran, I
 * decided there is nothing to send". EMPTY output is not the sentinel; it is silence,
 * and silence is indistinguishable from a crashed pipeline.
 */
export function isSilentNoOp(
  success: boolean,
  output: string | undefined,
  telegramOutput?: TelegramOutput,
): boolean {
  if (!success) return false; // already recorded as a failure — nothing to reclassify
  if (!telegramOutput) return false; // SCOPE GUARD — see the 'reminders' note above
  return !output || output.trim() === '';
}

/**
 * One-line, log-safe description of a REJECTED `sendToTelegram` result. Used in
 * both the run's `error` (which lands in the .meta) and the app.log.jsonl row,
 * so "why didn't this arrive" is answerable from either.
 */
export function describeSendFailure(send: Extract<SendResult, { ok: false }>): string {
  const parts: string[] = [send.reason];
  if (send.status !== undefined) parts.push(`status ${send.status}`);
  if (send.detail) parts.push(send.detail.slice(0, 200));
  return parts.join(': ');
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
 * Turn an undelivered telegram_output run into a recorded failure. Mutating
 * `result` in place is deliberate for the same reason the silent-no-op rule
 * above does it: `result` IS the object runCommand returns, so the caller,
 * `writeLog`, and catchup all see one consistent verdict.
 */
function recordDeliveryFailure(
  result: CommandResult,
  skillName: string,
  worker: string,
  duration: number,
  detail: string,
  extra: Record<string, unknown> = {},
): void {
  log('error', 'run', `Skill ${skillName} Telegram delivery failed — ${detail}`, {
    skill: skillName,
    worker,
    duration,
    deliveryFailed: true,
    ...extra,
  });
  const line = `Telegram delivery failed (${detail}). The skill produced output but it was never delivered.`;
  result.success = false;
  result.error = result.error ? `${result.error}\n${line}` : line;
}

/**
 * Post-execution handler: deliver output, log result, print output, detect and run
 * trigger skills. Extracted to avoid duplicating this logic across the
 * preferred-worker and failover paths.
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
  // Silent no-op detection (see isSilentNoOp for the scope guard and why it matters).
  // Mutating `result` in place is deliberate: it IS the object runCommand returns, so
  // catchup sees the same verdict writeLog records. Done before `meta` so the run is
  // logged status 'error' and counts toward consecutiveFailures / AI-098 backoff.
  if (isSilentNoOp(result.success, result.output, telegramOutput)) {
    const detail = 'declares telegram_output but produced no output (silent no-op)';
    log('error', 'run', `Skill ${skillName} ${detail}`, {
      skill: skillName,
      worker,
      exitCode: result.exitCode, // kept as-is: exit 0 with no output IS the finding
      duration,
      silentNoOp: true,
    });
    result.success = false;
    result.error = result.error
      ? `${result.error}\nSkill ${detail}.`
      : `Skill ${detail}. Emit NO_OUTPUT as the last line if this run legitimately had nothing to send.`;
  }

  // --- Telegram delivery, BEFORE the run is recorded -------------------------
  // Suppression check: the NO_OUTPUT sentinel (last non-empty line) means "I ran
  // and decided there is nothing to send" — a success that delivers nothing on
  // purpose. Checking the last line rather than the whole output handles workers
  // like Gemini that prefix reasoning/preamble before the sentinel.
  //
  // Everything else that declares telegram_output exists to DELIVER. Until
  // 2026-07-21 this call DISCARDED sendToTelegram's return value, so a send
  // Telegram REJECTED (400 chat not found, network error, empty chat_id) was
  // still recorded status 'success' — the same "recorded success, delivered
  // nothing" class the silent-no-op rule above closes, one branch away from it.
  //
  // Two deliberate choices here; do NOT regress either:
  //  1. Delivery runs BEFORE `meta`/writeLog. Recording first and sending after
  //     is exactly what made the failure invisible: the .meta, the latest.json
  //     pointer and consecutiveFailures were all already written 'success' by
  //     the time the send was rejected. writeLog is not idempotent (a second
  //     call appends another run and double-counts the pointer), so the only
  //     honest order is deliver → record.
  //  2. A rejected delivery marks the RUN failed. The skill's own work did
  //     happen, but for a telegram_output skill the delivery IS the deliverable
  //     — a briefing nobody received is not a success anyone can act on. Failing
  //     it is also the only thing that buys a retry (transient network) and,
  //     once AI-098 backoff exhausts the retries, a pa-alerts page (permanent
  //     misconfig). A 'success' record buys neither.
  if (result.success && result.output && !isNoOutputSentinel(result.output) && telegramOutput && secrets) {
    const token = secrets[telegramOutput.token_secret];
    if (token) {
      const send = await sendToTelegram(result.output, telegramOutput, token);
      if (!send.ok) {
        recordDeliveryFailure(result, skillName, worker, duration, describeSendFailure(send), {
          failure: send.reason,
          status: send.status,
          detail: send.detail,
          chatId: telegramOutput.chat_id,
          threadId: telegramOutput.thread_id,
        });
      }
    } else {
      // Declared telegram_output but the token secret is absent: nothing can be
      // delivered, now or ever. Same class as a rejected send — a console.warn
      // on an unattended scheduled run is indistinguishable from silence.
      console.warn(`[run] telegram_output: secret '${telegramOutput.token_secret}' not found — skipping Telegram delivery`);
      recordDeliveryFailure(
        result,
        skillName,
        worker,
        duration,
        `missing-token: secret '${telegramOutput.token_secret}' not found in secrets.env`,
        { failure: 'missing-token', chatId: telegramOutput.chat_id, threadId: telegramOutput.thread_id },
      );
    }
  }

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

    // Always alert the skill's own topic when telegram_output is configured.
    // Deliberately still attempted when the failure IS a rejected delivery to
    // this same topic: rejections are frequently content-specific (message
    // shape, size, parse mode), so the short alert often lands where the full
    // output did not — and when it doesn't, notifyUser records the miss rather
    // than claiming a send. The pa-alerts page above is the route that does not
    // depend on this topic working at all.
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
