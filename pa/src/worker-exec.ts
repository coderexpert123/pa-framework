import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes, randomUUID } from 'crypto';
import { DEFAULT_TIMEOUT, DEFAULT_IDLE_TIMEOUT } from './types.js';
import type { WorkerConfig, CommandResult, RunOptions } from './types.js';
import { blackboard } from './blackboard.js';
import { resolveStateDir, getLatestStateMtime, analyzeAgentState } from './state-monitor.js';
import { hasChildProcesses, killProcessTree, getDescendantPids, getCommandLines, areProcessesAlive } from './process-tree.js';
import { evaluateWorkerState } from './worker-evaluator.js';
import { addWorkerPid, removeWorkerPid, updateWorkerPidDescendants } from './worker-pids.js';
import { logger } from './lib/log.js';
import { notifyUser } from './lib/notify.js';
import { getSkillTranslationPatterns } from './lib/skill-translations.js';

function sanitizeCmdline(cmdline: string): string {
  return cmdline.replace(/([?&](api_key|token|password|secret)=)[^\s&]*/gi, '$1<redacted>').slice(0, 200);
}

// With shell:true, Node joins command + args into a shell string on all platforms.
// Quote args containing spaces or metacharacters to prevent word-splitting.
function quoteArg(a: string): string {
  if (process.platform === 'win32') {
    // cmd.exe: wrap in double quotes, escape embedded double quotes
    return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
  }
  // POSIX sh: wrap in single quotes, escape embedded single quotes via '\''
  return /[\s'"\\$`!|&;()<>]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
}

async function writeTempPrompt(prompt: string): Promise<string> {
  const id = randomBytes(8).toString('hex');
  const tmpPath = join(tmpdir(), `pa-prompt-${id}.txt`);
  await writeFile(tmpPath, prompt, 'utf8');
  return tmpPath;
}

export async function executeWorker(
  worker: WorkerConfig,
  prompt: string,
  options: RunOptions
): Promise<CommandResult> {
  const resource = options.resource || worker.name;
  const agentName = options.agentName || worker.name;
  const contextId = options.contextId;
  const maxTimeoutMs = (options.timeout || DEFAULT_TIMEOUT) * 1000;

  // Codex Translation Layer: Translate /skill -> $skill for pass-through commands.
  // Skill list is loaded from ~/.pa/codex-skill-translations.json (scaffolded by `pa init`)
  // with an embedded fallback if the file is missing or malformed.
  let effectivePrompt = prompt;
  if (worker.name === 'codex') {
    const skills = getSkillTranslationPatterns();
    const pattern = new RegExp(`^\\/(${skills.join('|')})\\b`, 'gm');
    effectivePrompt = prompt.replace(pattern, '$$$1');
  }

  // 1. Acquire lock on resource
  const acquired = await blackboard.acquireLock(resource, agentName, process.pid, maxTimeoutMs, contextId);
  if (!acquired) {
    return {
      success: false,
      output: '',
      error: `Failed to acquire lock for resource: ${resource} after ${maxTimeoutMs / 1000}s`,
      exitCode: -1,
    };
  }

  // 1b. Admission control (AI-096 item 3): heavyweight CLI workers all hit the
  // same disk — unbounded concurrency is what collapsed the machine on
  // 2026-07-04. Acquire one of PA_MAX_CONCURRENT_WORKERS blackboard slots
  // (cross-process: bot + catchup share the pool) or queue until one frees.
  // Slot AFTER resource: slot holders never wait on resources → no deadlock.
  // Evaluators are exempt: they run WHILE a slot-holding worker awaits their
  // verdict — making them queue for a slot would be a circular wait.
  const slotHandle = options.isEvaluator
    ? ('disabled' as const)
    : await acquireWorkerSlot(agentName, maxTimeoutMs, blackboard, undefined, async () => {
        // Keep the already-held resource lock fresh while queued — a slot wait
        // can exceed HEARTBEAT_STALE_MS, and a purged topic lock would let a
        // concurrent same-topic dispatch through.
        await blackboard.updateHeartbeat(resource, agentName, contextId).catch(() => {});
      });
  if (slotHandle === null) {
    await blackboard.releaseLock(resource, agentName, contextId);
    return {
      success: false,
      output: '',
      error: `All worker slots busy after ${maxTimeoutMs / 1000}s (PA_MAX_CONCURRENT_WORKERS=${workerSlotCount()}) — dispatch queued too long`,
      exitCode: -1,
    };
  }

  try {
    const idleTimeoutMs = Math.min((options.idleTimeout || DEFAULT_IDLE_TIMEOUT) * 1000, maxTimeoutMs);

    const useStdinJson = worker.input_mode === 'stdin-json';
    const useStdinText = worker.input_mode === 'stdin-text';
    const useStdin = useStdinJson || useStdinText;
    let promptFile: string | null = null;

    // Build args:
    // - stdin modes (json, text): no {prompt} substitution, prompt sent via stdin
    // - arg mode: write prompt to temp file and substitute {prompt}/{prompt_file}
    let args: string[];
    const extraArgs = options.extraArgs || [];
    if (useStdin) {
      // Codex resume uses subcommand syntax ('resume', no dashes).
      // Insert before the trailing stdin marker '-' instead of appending after it.
      if (extraArgs.length > 0 && extraArgs[0] === 'resume'
          && worker.args[worker.args.length - 1] === '-') {
        args = [...worker.args.slice(0, -1), ...extraArgs, '-'];
      } else {
        args = [...worker.args, ...extraArgs];
      }
    } else {
      promptFile = await writeTempPrompt(prompt);
      const substitutedArgs = worker.args.map((a) => {
        if (a === '{prompt}') return `@${promptFile}`;
        if (a === '{prompt_file}') return promptFile!;
        return a.replace('{prompt}', `@${promptFile}`).replace('{prompt_file}', promptFile!);
      });
      args = [...substitutedArgs, ...extraArgs]; // APPEND extra args
    }

    // shell:true runs on all platforms — quote args that contain spaces or
    // shell metacharacters so they aren't word-split by cmd.exe / sh.
    args = args.map(quoteArg);

    const mergedEnv = { ...process.env, ...(options.env || {}), PA_BOT_PID: String(process.pid) } as NodeJS.ProcessEnv;

    // Snapshot state dir mtime before spawning so we can detect new activity
    const stateDir = worker.state_dir ? resolveStateDir(worker.state_dir) : null;
    const statePattern = worker.state_pattern || '*.jsonl';
    let lastKnownMtime = stateDir ? await getLatestStateMtime(stateDir, statePattern) : null;

    const result = await new Promise<CommandResult>((resolve) => {
      let resolved = false;
      let pidTracked: Promise<void> | undefined;
      const done = (r: CommandResult) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        clearInterval(heartbeatInterval);
        if (child.pid) {
          (pidTracked || Promise.resolve()).then(() => removeWorkerPid(child.pid!)).catch(() => {});
        }
        resolve(r);
      };

      let stdout = '';
      let stderr = '';
      let capturedSessionId: string | undefined;
      let lastCodexTelemetry: { usedPercent: number; windowMinutes: number; resetsAt: number } | undefined;
      let codexStreamError = ''; // captures {"type":"error",...} events from codex NDJSON stream
      const isStreamJson = worker.output_format === 'stream-json';

      const command = (worker.name === 'gemini' && (worker.command === 'gemini' || worker.command.endsWith('gemini.cmd')))
        ? 'D:/gemini-shim/gemini.cmd'
        : ((worker.name === 'agy' && (worker.command === 'agy' || worker.command.endsWith('agy.cmd')))
          ? 'D:/gemini-shim/agy.cmd'
          : worker.command);

      const child = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        shell: true,
        env: mergedEnv,
        stdio: useStdin ? ['pipe', 'pipe', 'pipe'] : undefined,
      });

      pidTracked = child.pid
        ? addWorkerPid({
            pid: child.pid,
            spawnedBy: process.pid,
            worker: worker.name,
            skill: options.resource || 'unknown',
            startedAt: new Date().toISOString(),
          }).catch(() => {})
        : undefined;

      // Handle prompt injection via stdin
      if (useStdin && child.stdin) {
        // A shell-exec failure (e.g. command not found) can close the pipe before or during
        // this write, throwing an uncaught EPIPE that crashes the process. child.on('error')/
        // ('close') below already produce the correct failure CommandResult — this just stops
        // the stream-level error from escaping as an unhandled exception.
        child.stdin.on('error', () => {});
        if (useStdinJson) {
          // Claude Code stream-json expects: {"type":"user","message":{"role":"user","content":"..."}}
          const message = JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: prompt,
            },
          });
          child.stdin.write(message + '\n');
        } else {
          // Plain text injection (useStdinText)
          child.stdin.write(prompt);
        }
        child.stdin.end();
      }

      const mergeKillError = (reason: string) =>
        codexStreamError ? `${reason}\n${codexStreamError}` : reason;

      const killWithMessage = (reason: string) => {
        if (child.pid) killProcessTree(child.pid);
        else child.kill();
        done({
          success: false,
          output: stdout,
          error: mergeKillError(reason),
          exitCode: -1,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      };

      const killWithSummary = (reason: string, summary: string) => {
        if (child.pid) killProcessTree(child.pid);
        else child.kill();
        done({
          success: false,
          output: stdout,
          error: mergeKillError(reason),
          exitCode: -1,
          evaluatorSummary: summary,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      };

      const killWithSuccess = (summary: string) => {
        if (child.pid) killProcessTree(child.pid);
        else child.kill();
        done({
          success: true,
          output: stdout || summary,
          exitCode: 0,
          evaluatorSummary: summary,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      };

      // --- Idle timeout with "check before kill" ---
      // When idle timer fires, don't kill immediately. First analyze the conversation
      // state to see if the agent is actually working (pending tool call, active thinking)
      // or genuinely stuck (asking a question, retry loop).
      // If heuristics are inconclusive, escalate to a separate LLM evaluator.

      // Guard against concurrent evaluator invocations (heartbeat can reschedule the
      // idle timer while an evaluator call is already in flight).
      let evaluating = false;
      let maxExtensions = 0;

      const checkAndMaybeKill = async () => {
        if (resolved || evaluating) return;
        evaluating = true;

        try {
          // Check 1: analyze conversation state file (high-signal heuristics)
          if (stateDir) {
            const state = await analyzeAgentState(stateDir, statePattern);

            if (state.verdict === 'stuck') {
              // Obvious stuck case — no need to call the LLM evaluator
              killWithMessage(`Killed: ${state.status}`);
              return;
            }

            // Heuristic says "alive" or "unknown" — escalate to LLM evaluation
            // unless this worker IS the evaluator (prevents recursion)
            if (!options.isEvaluator) {
              process.stdout.write(`\r  [check] ${worker.name}: ${state.status} — consulting evaluator...    `);
              const verdict = await evaluateWorkerState(stateDir, statePattern, worker.name, options.env, executeWorker);
              if (verdict) {
                if (verdict.verdict === 'done') {
                  killWithSuccess(verdict.summary);
                  return;
                }
                if (verdict.verdict === 'kill') {
                  killWithSummary(
                    `Killed: LLM evaluator decided to stop (${verdict.reason})`,
                    verdict.summary,
                  );
                  return;
                }
                // verdict === 'extend'
                process.stdout.write(`\r  [check] ${worker.name}: evaluator extending — ${verdict.summary}    `);
                resetIdleTimer();
                return;
              }
              // Evaluator unavailable/failed — fall through to heuristic result
              if (state.verdict === 'alive') {
                process.stdout.write(`\r  [check] ${worker.name}: ${state.status} — extending (no evaluator)...    `);
                resetIdleTimer();
                return;
              }
            } else if (state.verdict === 'alive') {
              // This IS the evaluator — use heuristic only, no recursion
              process.stdout.write(`\r  [check] ${worker.name}: ${state.status} — extending...    `);
              resetIdleTimer();
              return;
            }
          }

          // Check 2: process tree — if children exist, definitely alive
          // (For shell:true, we look for grandchildren, as the direct child is the worker itself)
          if (child.pid && await hasChildProcesses(child.pid, true)) {
            process.stdout.write(`\r  [check] ${worker.name}: subprocess still running, extending...    `);
            resetIdleTimer();
            return;
          }
        } catch {
          // Check failed — fall through to kill
        } finally {
          evaluating = false;
        }

        // No signal either way — kill
        killWithMessage(`Killed: no activity for ${idleTimeoutMs / 1000}s (idle timeout)`);
      };

      let idleTimer = setTimeout(checkAndMaybeKill, idleTimeoutMs);

      const resetIdleTimer = (source?: string) => {
        clearTimeout(idleTimer);
        if (resolved) return;
        if (source) {
          process.stdout.write(`\r  [heartbeat] ${worker.name}: ${source}    `);
        }
        idleTimer = setTimeout(checkAndMaybeKill, idleTimeoutMs);
      };

      // BG-task tracking state
      const bgCfg = options.bgTasksConfig ?? { alert_seconds: 300, alert_repeat_seconds: 1800 };
      const bgAlertMs = bgCfg.alert_seconds * 1000;
      const bgRepeatMs = bgCfg.alert_repeat_seconds * 1000;
      const bgHooks = options._bgTaskHooks ?? {};
      const bgGetDescendants = bgHooks.getDescendantPids ?? getDescendantPids;
      const bgGetCmdlines = bgHooks.getCommandLines ?? getCommandLines;
      const bgAreAlive = bgHooks.areProcessesAlive ?? areProcessesAlive;
      const bgNotify = bgHooks.notifyUser ?? notifyUser;
      const heartbeatMs = bgHooks.heartbeatIntervalMs ?? 30_000;
      const startedAt = Date.now();

      interface BgEntry { firstSeen: number; cmdline?: string; lastRepeatBucket: number; }
      const bgTaskMap = new Map<number, BgEntry>();

      // Periodic heartbeat: checks process tree AND state file mtime
      const heartbeatInterval = setInterval(() => {
        if (resolved || !child.pid) return;

        (async () => {
          if (resolved) return; // guard: done() may have fired while we were awaiting
          try {
            // Update blackboard heartbeat
            if (resolved) return;
            await blackboard.updateHeartbeat(resource, agentName, contextId);
            if (slotHandle !== 'disabled') {
              await blackboard.updateHeartbeat(slotHandle.slot, agentName, slotHandle.ctx).catch(() => {});
            }

            // BG-task tracking: one OS query → BFS in memory
            const descendants = await bgGetDescendants(child.pid!);
            if (resolved) return; // guard: worker may have exited while querying OS
            // Persist the live worker tree so the orphan reaper can check liveness
            // even after the shell wrapper (child.pid) dies with a crashed spawner.
            updateWorkerPidDescendants(child.pid!, descendants.map(d => d.pid)).catch(() => {});
            const now = Date.now();
            const currentPids = new Set(descendants.map(d => d.pid));

            // Add new entries
            for (const { pid } of descendants) {
              if (!bgTaskMap.has(pid)) bgTaskMap.set(pid, { firstSeen: now, lastRepeatBucket: -1 });
            }
            // Drop gone PIDs
            for (const pid of bgTaskMap.keys()) {
              if (!currentPids.has(pid)) bgTaskMap.delete(pid);
            }
            // Batch-fetch cmdlines for new entries
            const needCmdline = [...bgTaskMap.entries()].filter(([, e]) => !e.cmdline).map(([pid]) => pid);
            if (needCmdline.length > 0) {
              const cmdlines = await bgGetCmdlines(needCmdline);
              for (const [pid, cmdline] of cmdlines) {
                const entry = bgTaskMap.get(pid);
                if (entry) entry.cmdline = sanitizeCmdline(cmdline);
              }
            }
            // Collect entries whose age bucket advanced — batched into one alert per heartbeat
            const alerting: Array<{ pid: number; ageSec: number; cmdline: string }> = [];
            for (const [pid, entry] of bgTaskMap) {
              const ageMs = now - entry.firstSeen;
              if (ageMs > bgAlertMs) {
                const bucket = Math.floor(ageMs / bgRepeatMs);
                if (bucket > entry.lastRepeatBucket) {
                  entry.lastRepeatBucket = bucket;
                  alerting.push({ pid, ageSec: Math.round(ageMs / 1000), cmdline: entry.cmdline ?? '(unknown)' });
                }
              }
            }
            if (alerting.length > 0) {
              const lines = alerting.map(a => `  PID ${a.pid} (age ${a.ageSec}s): ${a.cmdline}`);
              const body = `Worker: ${worker.name} (pid ${child.pid})\nResource: ${resource}\n${lines.join('\n')}`;
              // No dedupKey — per-PID lastRepeatBucket gate is the dedup mechanism
              bgNotify(
                `bg-leak: ${alerting.length} long-running descendant(s) of ${worker.name} (pid ${child.pid})`,
                body.slice(0, 3500),
              ).catch(() => {});
            }

            // Check 1: process tree (idle-timer reset)
            const hasChildren = await hasChildProcesses(child.pid!, true);
            if (hasChildren) {
              resetIdleTimer('subprocess running');
              return;
            }

            // Check 2: state file mtime changed since last check
            if (stateDir) {
              const currentMtime = await getLatestStateMtime(stateDir, statePattern);
              if (currentMtime && (!lastKnownMtime || currentMtime > lastKnownMtime)) {
                lastKnownMtime = currentMtime;
                const state = await analyzeAgentState(stateDir, statePattern);
                resetIdleTimer(state.status);
                return;
              }
            }
          } catch {
            // Heartbeat check failed — don't crash, just let idle timer continue
          }
        })();
      }, heartbeatMs);

      // Hard max timeout: absolute safety net with "check before kill" escalation
      const onMaxTimeout = async () => {
        if (resolved || evaluating) {
          // If evaluator is already running (via idle timer), wait for it
          maxTimer = setTimeout(onMaxTimeout, 30_000);
          return;
        }

        if (maxExtensions >= 2) {
          killWithMessage(`Killed: absolute timeout exceeded after ${maxExtensions} extensions`);
          return;
        }

        evaluating = true;
        try {
          // Escalate to LLM evaluation (skip heuristic check for hard timeout)
          if (!options.isEvaluator && stateDir) {
            process.stdout.write(`\r  [timeout] ${worker.name}: absolute timeout reached — consulting evaluator...    `);
            const verdict = await evaluateWorkerState(stateDir, statePattern, worker.name, options.env, executeWorker);
            if (verdict && verdict.verdict === 'extend') {
              maxExtensions++;
              process.stdout.write(`\r  [timeout] ${worker.name}: evaluator extending (extension ${maxExtensions}/2) — ${verdict.summary}    `);
              maxTimer = setTimeout(onMaxTimeout, maxTimeoutMs);
              return;
            }
          }
        } catch {
          // Check failed — fall through to kill
        } finally {
          evaluating = false;
        }

        killWithMessage(`Killed: exceeded max timeout of ${maxTimeoutMs / 1000}s`);
      };

      let maxTimer = setTimeout(onMaxTimeout, maxTimeoutMs);

      // Buffer for incomplete NDJSON lines across chunks
      let ndjsonBuffer = '';
      // For Gemini: track the stdout position after the last tool_result event.
      // On exit, we trim stdout to only keep content accumulated after this point,
      // discarding all intermediate planning narration from multi-step tool use.
      let lastToolBoundary = 0;

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (isStreamJson) {
          // Buffer chunks and process complete lines only
          ndjsonBuffer += chunk;
          const lines = ndjsonBuffer.split('\n');
          // Keep the last element (may be incomplete) in the buffer
          ndjsonBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);

              // Session ID detection
              if (event.sessionId) capturedSessionId = event.sessionId;
              if (event.session_id) capturedSessionId = event.session_id;
              if (event.type === 'init' && event.session_id) capturedSessionId = event.session_id;
              // Codex: { type: 'thread.started', thread_id: '...' }
              if (event.type === 'thread.started' && event.thread_id) capturedSessionId = event.thread_id;

              // Codex error events: {"type":"error","message":"..."} — capture for rate-limit detection
              if (event.type === 'error' && typeof event.message === 'string' && worker.name === 'codex') {
                codexStreamError += (codexStreamError ? '\n' : '') + event.message;
              }

              // Codex proactive rate-limit telemetry from token_count events.
              if (event.type === 'event_msg'
                  && event.payload?.type === 'token_count'
                  && event.payload?.rate_limits?.primary) {
                const p = event.payload.rate_limits.primary;
                if (typeof p.used_percent === 'number'
                    && typeof p.window_minutes === 'number'
                    && typeof p.resets_at === 'number') {
                  lastCodexTelemetry = {
                    usedPercent: p.used_percent,
                    windowMinutes: p.window_minutes,
                    resetsAt: p.resets_at,
                  };
                }
              }

              // Tool boundary tracking (Gemini): record stdout position after each tool_result
              // so we can discard intermediate planning narration on exit.
              if (event.type === 'tool_result' && (worker.name === 'gemini' || worker.name === 'agy')) {
                lastToolBoundary = stdout.length;
              }

              // Codex: { type: 'item.completed', item: { type: 'agent_message', text: '...' } }
              if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
                stdout += event.item.text;
              }

              // Result (final output)
              if (event.type === 'result' && event.result) {
                stdout = event.result; // result replaces accumulated assistant text
              } else if (event.type === 'assistant' || (event.type === 'message' && event.role === 'assistant')) {
                // Accumulate streaming content
                // Claude: { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
                // Gemini: { type: 'message', role: 'assistant', content: '...' }
                const content = event.message?.content || event.content;
                if (typeof content === 'string') {
                  stdout += content;
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'text' && block.text) {
                      stdout += block.text;
                    }
                  }
                }
              }
            } catch {
              // Malformed JSON line — skip
            }
          }
        } else {
          stdout += chunk;
        }
        resetIdleTimer();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        resetIdleTimer();
      });

      child.on('error', (err: Error) => {
        logger.warn('worker-exec', 'spawn-failed', { worker: worker.name, exitCode: -1, stderr_excerpt: err.message });
        notifyUser(
          `Worker spawn failed: ${worker.name}`,
          `Failed to start ${worker.name}: ${err.message}\nResource: ${resource}`,
          { dedupKey: `worker-spawn-${worker.name}`, severity: 'error' },
        ).catch(() => {});
        done({
          success: false,
          output: stdout,
          error: `Failed to start ${worker.name}: ${err.message}`,
          exitCode: -1,
          rateLimitTelemetry: lastCodexTelemetry,
        });
      });

      child.on('close', (code: number | null) => {
        // Flush any remaining NDJSON buffer content
        if (isStreamJson && ndjsonBuffer.trim()) {
          try {
            const event = JSON.parse(ndjsonBuffer);
            if (event.type === 'thread.started' && event.thread_id) capturedSessionId = event.thread_id;
            // Codex error events in trailing buffer (no terminating newline)
            if (event.type === 'error' && typeof event.message === 'string' && worker.name === 'codex') {
              codexStreamError += (codexStreamError ? '\n' : '') + event.message;
            }
            // Codex telemetry in trailing buffer
            if (event.type === 'event_msg'
                && event.payload?.type === 'token_count'
                && event.payload?.rate_limits?.primary) {
              const p = event.payload.rate_limits.primary;
              if (typeof p.used_percent === 'number'
                  && typeof p.window_minutes === 'number'
                  && typeof p.resets_at === 'number') {
                lastCodexTelemetry = {
                  usedPercent: p.used_percent,
                  windowMinutes: p.window_minutes,
                  resetsAt: p.resets_at,
                };
              }
            }
            if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item?.text) {
              stdout += event.item.text;
            } else if (event.type === 'tool_result' && (worker.name === 'gemini' || worker.name === 'agy')) {
              lastToolBoundary = stdout.length;
            } else if (event.type === 'result' && event.result) {
              stdout = event.result;
            } else if (event.type === 'assistant' || (event.type === 'message' && event.role === 'assistant')) {
              const content = event.message?.content || event.content;
              if (typeof content === 'string') {
                stdout += content;
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) {
                    stdout += block.text;
                  }
                }
              }
            }
          } catch {
            // Final buffer wasn't valid JSON — ignore
          }
        }

        // Gemini tool-boundary trim: discard all content accumulated before the last
        // tool_result. This strips intermediate planning narration from multi-step
        // tool-use conversations, keeping only the final response segment.
        if ((worker.name === 'gemini' || worker.name === 'agy') && lastToolBoundary > 0) {
          stdout = stdout.slice(lastToolBoundary);
        }

        // Clear the heartbeat line
        if (stateDir) process.stdout.write('\r' + ' '.repeat(60) + '\r');
        // Merge codex stream errors into the error field so rate-limit detection can see them
        const combinedError = [codexStreamError, stderr, code !== 0 && !codexStreamError && !stderr ? `Exited with code ${code}` : '']
          .filter(Boolean).join('\n') || undefined;
        if (code !== 0) {
          logger.warn('worker-exec', 'spawn-failed', { worker: worker.name, exitCode: code, stderr_excerpt: (combinedError ?? '').slice(0, 1000) });
          // Alert on non-zero exit (suppressed during mid-failover when suppressExitAlert is set)
          if (!options.suppressExitAlert) {
            const resourceKey = options.resource ?? 'unknown';
            notifyUser(
              `Worker exited with code ${code}: ${worker.name}`,
              `Worker: ${worker.name}\nResource: ${resourceKey}\nExit code: ${code}\nError: ${(combinedError ?? '').slice(0, 500)}`,
              { dedupKey: `worker-exit-${worker.name}-${resourceKey}`, severity: 'error' },
            ).catch(() => {});
          }
        }
        done({
          success: code === 0,
          output: stdout,
          error: combinedError,
          exitCode: code,
          sessionId: capturedSessionId,
          rateLimitTelemetry: lastCodexTelemetry,
        });

        // Post-exit orphan sweep: fire-and-forget, does not block the result
        if (bgTaskMap.size > 0 && child.pid) {
          const workerPid = child.pid;
          const tracked = Array.from(bgTaskMap.keys());
          bgAreAlive(tracked).then(alive => {
            const orphans = tracked.filter(pid => alive.get(pid));
            if (orphans.length > 0) {
              const lines = orphans.map(pid => {
                const entry = bgTaskMap.get(pid);
                return `  PID ${pid}: ${entry?.cmdline ?? '(unknown)'}`;
              });
              const body = `Worker: ${worker.name} (pid ${workerPid}) exited with ${orphans.length} descendant(s) still running:\n${lines.join('\n')}`;
              bgNotify(
                `bg-orphan: ${orphans.length} orphaned descendant(s) of ${worker.name}`,
                body.slice(0, 3500),
                { dedupKey: `bg-orphan-${startedAt}-${workerPid}` },
              ).catch(() => {});
            }
          }).catch(() => {});
        }
      });
    });

    if (promptFile) {
      try { await unlink(promptFile); } catch {}
    }

    return result;
  } finally {
    await blackboard.releaseLock(resource, agentName, contextId);
    if (slotHandle !== 'disabled') {
      await blackboard.releaseLock(slotHandle.slot, agentName, slotHandle.ctx).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Worker admission control (AI-096 item 3)
// ---------------------------------------------------------------------------

const SLOT_RETRY_MS = 5_000;

export function workerSlotCount(): number {
  const n = parseInt(process.env.PA_MAX_CONCURRENT_WORKERS ?? '3', 10);
  return Number.isFinite(n) ? n : 3;
}

export interface WorkerSlotHandle { slot: string; ctx: string }

/**
 * Acquire one of N machine-wide worker slots via the blackboard (cross-process).
 * Returns 'disabled' when PA_MAX_CONCURRENT_WORKERS <= 0 (no limiting), a
 * handle when a slot was acquired, or null when maxWaitMs elapsed with every
 * slot busy. Each acquisition uses a fresh contextId so same-PID concurrent
 * spawns (the bot) still exclude each other.
 */
export async function acquireWorkerSlot(
  agent: string,
  maxWaitMs: number,
  bb: Pick<typeof blackboard, 'acquireLock'> = blackboard,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  onRetry?: () => Promise<void>,
): Promise<WorkerSlotHandle | 'disabled' | null> {
  const n = workerSlotCount();
  if (n <= 0) return 'disabled';
  const ctx = randomUUID();
  const start = Date.now();
  do {
    for (let i = 0; i < n; i++) {
      const slot = `worker-slot-${i}`;
      // timeoutMs=50 → effectively a single acquisition attempt per slot (the
      // acquire loop's internal retry sleeps 1s, past the budget), while giving
      // enough headroom that a stray 1ms clock tick can't zero out the attempt.
      if (await bb.acquireLock(slot, agent, process.pid, 50, ctx)) return { slot, ctx };
    }
    if (onRetry) await onRetry();
    await sleepFn(SLOT_RETRY_MS);
  } while (Date.now() - start < maxWaitMs);
  return null;
}
