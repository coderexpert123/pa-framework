import { spawn } from 'child_process';
import { loadConfig } from './config.js';
import { loadSecrets } from './secrets.js';
import type { WorkerConfig, CommandResult, RunOptions, FailoverNotifyPayload } from './types.js';
import { notifyUser } from './lib/notify.js';
import { blackboard } from './blackboard.js';
import { logger } from './lib/log.js';
import { isWorkerCoolingDown, recordRateLimit, parseRateLimitDuration, classifyRateLimit, getCooldownStatus, getWorkerCooldown, clearRateLimitCache } from './rate-limits.js';

// Re-exports for backward compatibility — all existing imports from workers.js continue to work
export { executeWorker, collectBgAlerts } from './worker-exec.js';
export type { BgEntry, BgAlertEntry } from './worker-exec.js';
export { readStateTail } from './state-monitor.js';
export { isWorkerCoolingDown, recordRateLimit, parseRateLimitDuration, classifyRateLimit, getCooldownStatus, getWorkerCooldown, clearRateLimitCache };

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

// --- Rate limit detection ---

export interface RateLimitCheck {
  hit: boolean;
  pattern?: string;
  snippet?: string;  // ~120 char window around the match in combined output
}

export function isRateLimited(worker: WorkerConfig, result: CommandResult): RateLimitCheck {
  // codex: errors come from the NDJSON stream, captured into result.error by worker-exec.
  // gemini: API errors come from stderr (result.error). Both workers have a clean error channel
  //         separate from agent text — never scan output for these.
  // claude/zclaude: rate-limit text can appear in the stream output, so scan both; but patterns
  //                 must be specific phrases seen in real errors, not broad heuristics.
  const combined = (worker.name === 'codex' || worker.name === 'gemini' || worker.name === 'agy')
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

export async function runWithFailover(
  prompt: string,
  options: RunOptions
): Promise<{ result: CommandResult; worker: string }> {
  const { executeWorker } = await import('./worker-exec.js');
  const config = await loadConfig();
  const secrets = options.env || await loadSecrets();

  // Reorder workers: preferred first, then rest in priority order
  const workers = options.preferredWorker
    ? (() => {
        const preferred = config.workers.find((w) => w.name === options.preferredWorker);
        const others = config.workers.filter((w) => w.name !== options.preferredWorker);
        return preferred ? [preferred, ...others] : config.workers;
      })()
    : config.workers;

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

  let finalResult: CommandResult = { success: false, output: '', error: 'No workers available', exitCode: -1 };
  let finalWorkerName = 'none';
  let anyAttempted = false;

  for (let i = 0; i < workers.length; i++) {
    const worker = workers[i];

    // 0. Skip workers excluded by caller (already failed in earlier dispatch phases)
    if (options.excludeWorkers?.has(worker.name)) {
      logger.info('workers', `skip: ${worker.name} — excluded (already failed)`, ctx);
      continue;
    }

    // 1. Check shared cooldown state (shared between bot and CLI)
    if (await isWorkerCoolingDown(worker.name)) {
      logger.info('workers', `skip: ${worker.name} — cooling down`, ctx);
      continue;
    }

    // 2. Check script availability
    const available = (await checkWorker(worker, secrets)) && (options.checkAvailable ? await options.checkAvailable(worker) : true);
    if (!available) {
      logger.info('workers', `skip: ${worker.name} — not available`, ctx);
      if (options.onWorkerSwitch) {
        let nextWorker: WorkerConfig | undefined;
        for (let j = i + 1; j < workers.length; j++) {
          const w = workers[j];
          if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, secrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
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

    const result = await executeWorker(worker, prompt, {
      ...options,
      agentName: worker.name,
      bgTasksConfig: options.bgTasksConfig ?? config.bg_tasks,
    });
    finalResult = result;
    finalWorkerName = worker.name;

    if (result.success) {
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
            if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, secrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
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
          if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, secrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
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
            if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, secrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
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
          if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, secrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
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
        if (!(await isWorkerCoolingDown(w.name)) && (await checkWorker(w, secrets)) && (options.checkAvailable ? await options.checkAvailable(w) : true)) {
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

  // Loop exhausted — all workers tried or skipped.
  // Branch on exhaustion vs rate-limit-wall vs empty-pool.
  const resourceKey = options.resource ?? 'unknown';

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
      notifyUser(
        `Skill exhausted: ${resourceKey}`,
        body.slice(0, 3500),
        { dedupKey: `skill-exhausted-${resourceKey}`, severity: 'error' },
      ).catch(() => {});
      finalResult.alreadyAlertedPaSupport = true;
    } else {
      // Zero attempts — check if all candidates were cooling (rate-limit wall) or excluded
      const coolingState = await getCooldownStatus();
      const coolingEntries = Object.entries(coolingState)
        .filter(([name]) => !options.excludeWorkers?.has(name))
        .map(([name, entry]) => `${name} (until ${entry.cooldown_until})`);
      if (coolingEntries.length > 0) {
        const coolingNames = coolingEntries;
        const body =
          `All candidate workers for ${resourceKey} are currently rate-limited.\n` +
          `Cooling: ${coolingNames.join(', ')}`;
        notifyUser(
          `All workers rate-limited: ${resourceKey}`,
          body.slice(0, 3500),
          { dedupKey: `all-workers-rate-limited-${resourceKey}`, severity: 'warn' },
        ).catch(() => {});
        finalResult.alreadyAlertedPaSupport = true;
      } else {
        logger.warn('workers', `no candidates for ${resourceKey} — pool fully excluded or empty`, ctx);
      }
    }
  }

  return { result: finalResult, worker: finalWorkerName };
}
