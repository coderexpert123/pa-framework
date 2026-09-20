import { spawn } from 'child_process';
import { loadConfig } from './config.js';
import { loadSecrets } from './secrets.js';
import type { WorkerConfig, CommandResult, RunOptions, FailoverNotifyPayload } from './types.js';
import { notifyUser } from './lib/notify.js';
import { blackboard } from './blackboard.js';
import { logger } from './lib/log.js';
import { isWorkerCoolingDown, recordRateLimit, parseRateLimitDuration, classifyRateLimit, getCooldownStatus, getWorkerCooldown, clearRateLimitCache, autoDispatchEligibility } from './rate-limits.js';
import type { AutoDispatchEligibilityOpts, AutoDispatchIneligibility } from './rate-limits.js';

// Re-exports for backward compatibility — all existing imports from workers.js continue to work
export { executeWorker, collectBgAlerts, selectKillTargets, _setOrphanSweepDepsForTest } from './worker-exec.js';
export type { BgEntry, BgAlertEntry } from './worker-exec.js';
export { readStateTail } from './state-monitor.js';
export { isWorkerCoolingDown, recordRateLimit, parseRateLimitDuration, classifyRateLimit, getCooldownStatus, getWorkerCooldown, clearRateLimitCache, autoDispatchEligibility };
export type { AutoDispatchEligibilityOpts, AutoDispatchIneligibility };

// --- Worker availability ---

export async function checkWorker(worker: WorkerConfig, env?: Record<string, string>): Promise<boolean> {
  const timeoutMs = (worker.check_timeout || 30) * 1000;
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(worker.check, {
      shell: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => {
      logger.warn('workers', `check error: ${worker.name} — ${err.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      if (code !== 0 && stderr) {
        logger.warn('workers', `check failed: ${worker.name} (exit:${code}) — ${stderr.trim().slice(0, 200)}`);
      }
      resolve(code === 0);
    });
  });
}

/** Exact error string the zero-attempt cascade returns when every candidate worker is skipped (cooling/unavailable/excluded) — consumers match on this constant (never a re-typed literal) to classify "wall" outcomes. Exported single source. */
export const NO_WORKERS_AVAILABLE_ERROR = 'No workers available';

// --- Rate limit detection ---

export interface RateLimitCheck {
  hit: boolean;
  pattern?: string;
  snippet?: string;  // ~120 char window around the match in combined output
}

export function isRateLimited(worker: WorkerConfig, result: CommandResult): RateLimitCheck {
  // codex/agy/devin: API/quota errors come from stderr/NDJSON (result.error), a clean error channel
  //                  separate from agent text — never scan output for these.
  // claude/zclaude: rate-limit text can appear in the stream output, so scan both; but patterns
  //                 must be specific phrases seen in real errors, not broad heuristics.
  const combined = (worker.name === 'codex' || worker.name === 'agy' || worker.name === 'devin')
    ? (result.error || '')
    : `${result.output}\n${result.error || ''}`;
  const lower = combined.toLowerCase();
  for (const pattern of worker.rate_limit_patterns) {
    const idx = lower.indexOf(pattern.toLowerCase());
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(combined.length, idx + pattern.length + 80);
      return { hit: true, pattern, snippet: combined.slice(start, end).replace(/\n/g, ' ') };
    }
  }
  return { hit: false };
}

// --- Public API ---

export async function getAvailableWorkers(): Promise<Array<WorkerConfig & { available: boolean }>> {
  const secrets = await loadSecrets();
  const config = await loadConfig();
  const results = await Promise.all(
    config.workers.map(async (w) => ({
      ...w,
      available: await checkWorker(w, secrets),
    }))
  );
  return results;
}

/**
 * Filter secrets for a worker based on its secret_allowlist.
 *
 * If the worker has no secret_allowlist, return all secrets unchanged (backward compatible).
 * If the worker has a secret_allowlist, return only the named secrets that exist.
 * Warn about any names in the allowlist that don't exist in secrets.env.
 */
export function filterSecretsForWorker(
  allSecrets: Record<string, string>,
  worker: WorkerConfig
): Record<string, string> {
  // No allowlist = receive all secrets (current behavior, backward compatible)
  if (!worker.secret_allowlist || worker.secret_allowlist.length === 0) {
    return allSecrets;
  }

  const filtered: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of worker.secret_allowlist) {
    if (allSecrets[name] !== undefined) {
      filtered[name] = allSecrets[name];
    } else {
      missing.push(name);
    }
  }

  // Fail-soft on unknown names: warn but continue with the subset that exists
  if (missing.length > 0) {
    const missingStr = missing.join(', ');
    console.warn(`[workers] Worker '${worker.name}' secret_allowlist references missing secrets: ${missingStr}. These will be omitted.`);
    logger.warn('workers', 'secret_allowlist missing secrets', { worker: worker.name, missing });
  }

  return filtered;
}

export async function runWithFailover(
  prompt: string,
  options: RunOptions
): Promise<{ result: CommandResult; worker: string }> {
  const { executeWorker } = await import('./worker-exec.js');
  const config = await loadConfig();
  const allSecrets = options.env || await loadSecrets();

  // Use injected notifyUser if available (for testing), otherwise use default
  const notify = options._bgTaskHooks?.notifyUser || notifyUser;

  // Reorder workers based on config and health state
  let workers = config.workers;

  // Apply worker_pin override if set (always first regardless of health).
  // ignoreWorkerPin (2026-09-19 router-as-orchestrator decision 25) skips
  // this reorder on router-decided turns — the deprecated operator pin must
  // not outrank the router's chain.
  if (config.worker_pin && !options.ignoreWorkerPin) {
    const pinned = config.workers.find((w) => w.name === config.worker_pin);
    const others = config.workers.filter((w) => w.name !== config.worker_pin);
    workers = pinned ? [pinned, ...others] : config.workers;
  }

  // candidateOrder (2026-09-19 decision 20): routed turns — stable-reorder so
  // the named candidates come first in the router's probability order;
  // unnamed workers keep the static order after them. The chain itself is
  // never narrowed: every configured worker still trails as failover.
  if (options.candidateOrder && options.candidateOrder.length > 0) {
    const order = new Map(options.candidateOrder.map((name, i) => [name, i]));
    const named = workers.filter((w) => order.has(w.name)).sort((a, b) => order.get(a.name)! - order.get(b.name)!);
    const rest = workers.filter((w) => !order.has(w.name));
    workers = [...named, ...rest];
  }

  // Apply preferredWorker if set (higher priority than pin for this dispatch only)
  if (options.preferredWorker) {
    const preferred = workers.find((w) => w.name === options.preferredWorker);
    const others = workers.filter((w) => w.name !== options.preferredWorker);
    workers = preferred ? [preferred, ...others] : workers;
  }

  // Apply quota-aware failover ordering if enabled (opt-in, default OFF)
  if (config.quota_aware_failover) {
    const { getWorkerHealthSnapshot } = await import('./rate-limits.js');
    const healthMap = await getWorkerHealthSnapshot(workers.map((w) => w.name));

    // Split into healthy and demoted workers
    const healthy: typeof workers = [];
    const demoted: typeof workers = [];

    for (const w of workers) {
      const health = healthMap.get(w.name) || { isCoolingDown: false, consecutiveFailures: 0 };
      // Demote if cooling down OR 3+ consecutive failures
      if (health.isCoolingDown || health.consecutiveFailures >= 3) {
        demoted.push(w);
      } else {
        healthy.push(w);
      }
    }

    // Preserve priority order within each group, demoted workers go to tail
    workers = [...healthy, ...demoted];
  }

  const ctx: Record<string, unknown> = {};
  if (options.resource) ctx['topic'] = options.resource;
  if (options.updateId !== undefined) ctx['update_id'] = options.updateId;

  // Local state for exhaustion tracking
  const attemptedWorkers: string[] = options.priorAttempts ? [...options.priorAttempts] : [];
  const switchEvents: Array<{ from: string; to: string; reason: string }> = [];
  // If priorAttempts exist, synthesize an initial switch event
  if (options.priorAttempts && options.priorAttempts.length > 0) {
    let firstNonExcluded: WorkerConfig | undefined;
    for (const w of workers) {
      if (!options.excludeWorkers?.has(w.name) && !(await isWorkerCoolingDown(w.name))) {
        firstNonExcluded = w;
        break;
      }
    }
    if (firstNonExcluded) {
      switchEvents.push({
        from: options.priorAttempts[options.priorAttempts.length - 1],
        to: firstNonExcluded.name,
        reason: 'pinned-failure-fallback',
      });
    }
  }

  let finalResult: CommandResult = { success: false, output: '', error: NO_WORKERS_AVAILABLE_ERROR, exitCode: -1 };
  let finalWorkerName = 'none';
  let anyAttempted = false;

  // AI-092 gap, closed 2026-08-02. A Telegram /stop kills the worker that is
  // running RIGHT NOW, which surfaces here as an ordinary non-zero exit. The
  // callers' own stop checks all sit OUTSIDE this loop, so a kill landing
  // mid-cascade used to read as "that worker failed" and roll on to the next
  // one: the cancelled request got answered anyway (2026-08-02, thread 29 —
  // gemini killed at 21:59:22, claude answered at 22:02), plus a false
  // worker-exit page to pa-alerts and a "switching to" card for a request
  // nobody was waiting on. Cancellation is therefore polled per candidate,
  // and again immediately after a failed attempt — the kill almost always
  // lands mid-run, i.e. between those two points.
  // A caller-supplied predicate that throws must not take the dispatch down
  // with it: fail toward "not cancelled" (the behaviour callers get when they
  // pass nothing at all) rather than rejecting mid-cascade.
  const cancelled = () => {
    try {
      return options.isCancelled?.() === true;
    } catch (err) {
      logger.warn('workers', `isCancelled threw — treating as not cancelled: ${(err as Error).message}`, ctx);
      return false;
    }
  };

  // True when a LATER candidate could still be tried, so this hop's non-zero
  // exit is not the run's verdict. Deliberately cheap — it repeats the loop's
  // own manual_only/excluded/cooling filters but NOT checkWorker(), which
  // spawns a process per candidate. Over-optimism is safe: if every remaining
  // candidate turns out unavailable, the loop still ends at the
  // `Skill exhausted: <resource>` page below, so the failure is never silent.
  // Under noFallback there is no next hop by definition.
  // Why this exists: an intermediate failover hop paged
  // "Worker exited with code 1: <worker>" even when the next worker answered
  // (the 2026-08-23 alerts-week review §5.3).
  const hasEligibleCandidateAfter = async (index: number): Promise<boolean> => {
    if (options.noFallback) return false;
    for (let j = index + 1; j < workers.length; j++) {
      const w = workers[j];
      const eligibility = await autoDispatchEligibility(w, {
        preferredWorker: options.preferredWorker,
        workerPin: config.worker_pin,
        excludeWorkers: options.excludeWorkers,
      });
      if (!eligibility.eligible) continue;
      return true;
    }
    return false;
  };

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];

    // 0. Automatic-dispatch eligibility (manual_only / excluded / cooling) —
    // single predicate shared with the evaluator chain. Runs FIRST per
    // candidate, before the cancelled check (outcome table proven equivalent:
    // only skip-log vs abort interleaving changes when the first candidate is
    // ineligible AND cancelled — log-only, immaterial).
    const eligibility = await autoDispatchEligibility(worker, {
      preferredWorker: options.preferredWorker,
      workerPin: config.worker_pin,
      excludeWorkers: options.excludeWorkers,
    });
    if (!eligibility.eligible) {
      // manual_only workers never receive automatic failover traffic — they
      // run only when this dispatch EXPLICITLY names them (preferredWorker from
      // a bot /agent pick or a skill's `worker:` frontmatter, or a global
      // worker_pin). (2026-08-21, operator directive: agyc manual-only.)
      if (eligibility.reason === 'manual_only') {
        logger.info('workers', `skip: ${worker.name} — manual_only (not explicitly selected)`, ctx);
      } else if (eligibility.reason === 'excluded') {
        logger.info('workers', `skip: ${worker.name} — excluded (already failed)`, ctx);
      } else {
        logger.info('workers', `skip: ${worker.name} — cooling down`, ctx);
      }
      continue;
    }

    // 0a. Caller abandoned the request — stop, do NOT hand it to another worker.
    // Returns the last real result so the caller still sees a failed dispatch
    // (its own reply path swaps in the cancellation confirmation), and skips
    // the exhaustion/rate-limit-wall alerts below: nothing is wrong with the pool.
    if (cancelled()) {
      logger.info('workers', `abort: cancelled by caller before ${worker.name}`, ctx);
      return { result: finalResult, worker: finalWorkerName };
    }

    // 2. Check script availability
    const available = (await checkWorker(worker, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(worker) : true);
    if (!available) {
      logger.info('workers', `skip: ${worker.name} — not available`, ctx);
      if (options.onWorkerSwitch) {
        let nextWorker: WorkerConfig | undefined;
        for (let j = i + 1; j < workers.length; j++) {
          const w = workers[j];
          if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
            nextWorker = w;
            break;
          }
        }
        const payload: FailoverNotifyPayload = {
          from: worker.name,
          to: nextWorker?.name ?? null,
          kind: 'unavailable',
          reasonText: `${worker.name} check failed or script missing`,
        };
        await options.onWorkerSwitch(payload);
        switchEvents.push({ from: worker.name, to: nextWorker?.name ?? 'none', reason: payload.reasonText });
      }
      continue;
    }

    logger.info('workers', `try: ${worker.name}`, ctx);
    attemptedWorkers.push(worker.name);
    anyAttempted = true;

    // Filter secrets for this worker based on its secret_allowlist (defense-in-depth)
    const workerSecrets = filterSecretsForWorker(allSecrets, worker);

    const workerExtraArgs = options.getExtraArgs ? options.getExtraArgs(worker) : options.extraArgs;
    const nextHopExists = await hasEligibleCandidateAfter(i);
    const result = await executeWorker(worker, prompt, {
      ...options,
      extraArgs: workerExtraArgs,
      env: workerSecrets,
      agentName: worker.name,
      bgTasksConfig: options.bgTasksConfig ?? config.bg_tasks,
      suppressExitAlert: nextHopExists ? true : options.suppressExitAlert,
    });
    finalResult = result;
    finalWorkerName = worker.name;

    if (result.success) {
      // Silent no-op failover (2026-08-21): a dispatch that MUST deliver
      // (requireNonEmptyOutput — run.ts sets it for telegram_output skills)
      // treats exit-0-with-empty-output as a failure of THIS worker and moves
      // on, instead of returning a "success" that run.ts can only reclassify
      // after the cascade has already ended. The NO_OUTPUT sentinel is
      // non-empty and passes.
      if (options.requireNonEmptyOutput && (!result.output || !result.output.trim())) {
        logger.warn('workers', `silent no-op: ${worker.name} exited 0 with empty output — failing over`, ctx);
        if (options.onWorkerSwitch) {
          let nextWorker: WorkerConfig | undefined;
          for (let j = i + 1; j < workers.length; j++) {
            const w = workers[j];
            if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
              nextWorker = w;
              break;
            }
          }
          const payload: FailoverNotifyPayload = {
            from: worker.name,
            to: nextWorker?.name ?? null,
            kind: 'failure',
            reasonText: 'exit:0 — empty output (silent no-op)',
          };
          await options.onWorkerSwitch(payload);
          switchEvents.push({ from: worker.name, to: nextWorker?.name ?? 'none', reason: payload.reasonText });
        }
        continue;
      }
      return { result, worker: worker.name };
    }

    // Cancelled while this worker was running: the non-zero exit IS the kill.
    // Return before classification so a killed run can neither record a bogus
    // rate-limit cooldown nor emit a failover card.
    if (cancelled()) {
      logger.info('workers', `abort: ${worker.name} exited ${result.exitCode} after caller cancellation — not failing over`, ctx);
      return { result, worker: worker.name };
    }

    // claude/zclaude: bypass text-pattern gate entirely.
    // Session JSONL (exact 429 api_error events) is the only authoritative mechanism.
    // null → no rate-limit evidence → treat as regular failure.
    if (worker.name === 'claude' || worker.name === 'zclaude') {
      const cls = await classifyRateLimit(
        worker.name,
        result.output,
        result.error ?? '',
        result.sessionId,
        worker.state_dir,
        worker.state_pattern,
      );

      if (cls === null) {
        // No session evidence of a rate limit — this is a regular execution failure.
        logger.warn('workers', `failure: ${worker.name} (exit:${result.exitCode}) — no rate-limit evidence`, ctx);
        if (options.onWorkerSwitch) {
          let nextWorker: WorkerConfig | undefined;
          for (let j = i + 1; j < workers.length; j++) {
            const w = workers[j];
            if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
              nextWorker = w;
              break;
            }
          }
          const payload: FailoverNotifyPayload = {
            from: worker.name,
            to: nextWorker?.name ?? null,
            kind: 'failure',
            reasonText: `exit:${result.exitCode} — ${result.error ?? 'unknown'}`,
          };
          await options.onWorkerSwitch(payload);
          switchEvents.push({ from: worker.name, to: nextWorker?.name ?? 'none', reason: payload.reasonText });
        }
        if (options.noFallback) {
          return { result, worker: worker.name };
        }
        continue;
      }

      if (cls.minutes === 0) {
        logger.info('workers', `skip: ${worker.name} transient retry in progress`, ctx);
        const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
        await appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker: worker.name, raw: cls.raw ?? result.error ?? '', session_id: result.sessionId, classification: cls.classification, reason: 'minutes-zero' });
        continue;
      }

      logger.warn('workers', `rate limited: ${worker.name} — session confirms 429 (${cls.source})`, ctx);
      const reason = `[${cls.classification}] ${cls.source} — ${cls.raw ?? ''}`;
      await recordRateLimit(worker.name, cls.minutes, reason, cls.classification);

      if (options.onWorkerSwitch) {
        let nextWorker: WorkerConfig | undefined;
        for (let j = i + 1; j < workers.length; j++) {
          const w = workers[j];
          if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
            nextWorker = w;
            break;
          }
        }
        const payload: FailoverNotifyPayload = {
          from: worker.name,
          to: nextWorker?.name ?? null,
          kind: 'rate-limit',
          reasonText: cls.raw ?? cls.source,
          minutes: cls.minutes,
          classification: cls.classification,
          source: cls.source,
          resetsAtIST: cls.resetsAtIST,
          raw: cls.raw,
        };
        await options.onWorkerSwitch(payload);
        switchEvents.push({ from: worker.name, to: nextWorker?.name ?? 'none', reason: `rate-limit: ${cls.raw ?? cls.source}` });
      }
      continue;
    }

    // All other workers: use text-pattern gate (isRateLimited) first, then classify.
    const rl = isRateLimited(worker, result);
    if (rl.hit) {
      const cls = await classifyRateLimit(
        worker.name,
        result.output,
        result.error ?? '',
        result.sessionId,
        worker.state_dir,
        worker.state_pattern,
      );
      logger.warn('workers', `rate limited: ${worker.name} — pattern "${rl.pattern}" matched: ${rl.snippet}`, ctx);

      if (cls === null) {
        // Pattern fired but classifier found no rate-limit structure — treat as regular failure.
        logger.warn('workers', `failure: ${worker.name} — rate-limit pattern matched but classifier returned null`, ctx);
        if (options.onWorkerSwitch) {
          let nextWorker: WorkerConfig | undefined;
          for (let j = i + 1; j < workers.length; j++) {
            const w = workers[j];
            if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
              nextWorker = w;
              break;
            }
          }
          const payload: FailoverNotifyPayload = {
            from: worker.name,
            to: nextWorker?.name ?? null,
            kind: 'failure',
            reasonText: `exit:${result.exitCode} — pattern matched but not a rate limit`,
          };
          await options.onWorkerSwitch(payload);
          switchEvents.push({ from: worker.name, to: nextWorker?.name ?? 'none', reason: payload.reasonText });
        }
        if (options.noFallback) {
          return { result, worker: worker.name };
        }
        continue;
      }

      if (cls.minutes <= 0) {
        logger.info('workers', `skip: ${worker.name} transient retry in progress`, ctx);
        const { appendUnparseableRateLimit } = await import('./rate-limit-unparseable-log.js');
        await appendUnparseableRateLimit({ timestamp: new Date().toISOString(), worker: worker.name, raw: cls.raw ?? result.error ?? '', session_id: result.sessionId, classification: cls.classification, reason: 'minutes-zero' });
        continue;
      }

      const reason = `[${cls.classification}] ${cls.source} — ${cls.raw ?? rl.snippet ?? ''}`;
      await recordRateLimit(worker.name, cls.minutes, reason, cls.classification);

      if (options.onWorkerSwitch) {
        let nextWorker: WorkerConfig | undefined;
        for (let j = i + 1; j < workers.length; j++) {
          const w = workers[j];
          if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
            nextWorker = w;
            break;
          }
        }
        const payload: FailoverNotifyPayload = {
          from: worker.name,
          to: nextWorker?.name ?? null,
          kind: 'rate-limit',
          reasonText: cls.raw ?? rl.snippet ?? cls.source,
          minutes: cls.minutes,
          classification: cls.classification,
          source: cls.source,
          resetsAtIST: cls.resetsAtIST,
          raw: cls.raw,
        };
        await options.onWorkerSwitch(payload);
        switchEvents.push({ from: worker.name, to: nextWorker?.name ?? 'none', reason: `rate-limit: ${cls.raw ?? rl.snippet ?? cls.source}` });
      }
      continue;
    }

    // Plain execution failure (not rate-limit, not unavailable)
    logger.warn('workers', `failure: ${worker.name} (exit:${result.exitCode})`, ctx);
    if (options.onWorkerSwitch) {
      let nextWorker: WorkerConfig | undefined;
      for (let j = i + 1; j < workers.length; j++) {
        const w = workers[j];
        if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, allSecrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
          nextWorker = w;
          break;
        }
      }
      const payload: FailoverNotifyPayload = {
        from: worker.name,
        to: nextWorker?.name ?? null,
        kind: 'failure',
        reasonText: `exit:${result.exitCode} — ${result.error ?? 'unknown'}`,
      };
      await options.onWorkerSwitch(payload);
      switchEvents.push({ from: worker.name, to: nextWorker?.name ?? 'none', reason: payload.reasonText });
    }
    if (options.noFallback) {
      return { result, worker: worker.name };
    }
    // P2-1: Backoff before next attempt to avoid rapid-fire failures across workers
    // Skip if this is the last worker (no next attempt) to avoid pointless delay
    if (i < workers.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
    continue;
  }

  // Loop exhausted — all workers tried or skipped.
  // Branch on exhaustion vs rate-limit-wall vs empty-pool.
  const resourceKey = options.resource ?? 'unknown';

  // P2-2: All-cooling wall alert — send notification when every worker is cooling,
  // even when noFallback is set (user should see why no workers are available)
  const coolingState = await getCooldownStatus();
  const coolingEntries = Object.entries(coolingState)
    .filter(([name]) => !options.excludeWorkers?.has(name))
    .map(([name, entry]) => `${name} (until ${entry.cooldown_until})`);
  const allCooling = coolingEntries.length > 0 && workers.every(w =>
    options.excludeWorkers?.has(w.name) || coolingState[w.name] !== undefined
  );

  if (allCooling) {
    const body =
      `All candidate workers for ${resourceKey} are currently rate-limited.\n` +
      `Cooling: ${coolingEntries.join(', ')}`;
    notify(
      `All workers rate-limited: ${resourceKey}`,
      body.slice(0, 3500),
      { dedupKey: `all-workers-rate-limited-${resourceKey}`, severity: 'warn' },
    ).catch(() => {});
    finalResult.alreadyAlertedPaSupport = true;
  }

  if (!options.noFallback) {
    if (anyAttempted) {
      // Exhaustion: ≥1 worker attempted, none succeeded
      const body =
        `Skill/resource ${resourceKey} exhausted all fallback workers.\n` +
        `Attempted: ${attemptedWorkers.join(', ')}\n` +
        `Last error: ${finalResult.error ?? '<no message>'}\n` +
        `Last worker: ${finalWorkerName}\n` +
        `Failover log:\n` +
        switchEvents.map(e => `  ${e.from} → ${e.to}: ${e.reason}`).join('\n');
      notify(
        `Skill exhausted: ${resourceKey}`,
        body.slice(0, 3500),
        { dedupKey: `skill-exhausted-${resourceKey}`, severity: 'error' },
      ).catch(() => {});
      finalResult.alreadyAlertedPaSupport = true;
    } else if (!allCooling) {
      // Zero attempts, not all cooling — pool fully excluded or empty
      logger.warn('workers', `no candidates for ${resourceKey} — pool fully excluded or empty`, ctx);
    }
  }

  return { result: finalResult, worker: finalWorkerName };
}
