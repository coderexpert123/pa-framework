import { randomUUID, randomBytes } from 'crypto';
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
import { blackboard, startLockRenewal } from '../blackboard.js';
import { validateKeyboardRequest } from '../lib/callback-grammar.js';
import { PROTECTED_SKILLS } from '../validator.js';
import type { RunMeta, CommandResult, TelegramOutput, RunOptions } from '../types.js';

/**
 * Lock key for a skill's `exclusive_resource`. Shared by acquire/heartbeat/release
 * so the three call sites can't drift into using different key shapes.
 */
export function exclusiveLockKey(resource: string): string {
  return `skill-exclusive:${resource}`;
}

/**
 * How long to wait for an `exclusive_resource` lock before giving up: half of the
 * skill's own timeout budget. This scales automatically — the wait can never eat
 * the whole budget, so the remaining half is always available for the actual work
 * regardless of how long the wait took, without hardcoding a number per skill.
 */
export function lockWaitBudgetMs(skillTimeoutSec: number | undefined): number {
  const skillTimeoutMs = (skillTimeoutSec ?? 300) * 1000;
  // Floor is a defensive minimum only — every real git-workflow skill's own
  // timeout is >=600s (see their skill.md files), so 50% of that is already
  // >=300_000ms and this floor never actually engages in production.
  return Math.max(2_000, Math.floor(skillTimeoutMs * 0.5));
}

/**
 * Maps a CommandResult to the process exit code `pa run` should exit with
 * (AI-179 WP-2, 2026-09-03): success → 0; a failure whose exitCode lands in
 * 1..255 keeps that code; anything else → 1 (null exit code, the -1 lock-busy
 * skip at handleSkillResult, and a lock-lost downgrade that kept the worker's
 * 0). Consumers: bin/pa.ts's `case 'run'` sets process.exitCode from this, so
 * chains.ts's spawnPa (`success: code === 0`) now sees real skill failures and
 * on_failure actually fires. Deliberately NOT consumed by the bot's
 * fire-and-forget spawns — a lock-lost abort must not re-dispatch (the skill's
 * own Telegram report + pa's lock-lost alerts carry that signal).
 */
export function exitCodeForCommandResult(result: CommandResult): number {
  if (result.success) return 0;
  if (typeof result.exitCode === 'number' && result.exitCode >= 1 && result.exitCode <= 255) {
    return result.exitCode;
  }
  return 1;
}

/** Builds the per-run operator-arguments block appended to the skill prompt.
 *  AI-148 D-c introduced this for `--prompt-args`; since AI-187 (2026-09-03)
 *  runCommand ALSO builds it for LLM-worker skills invoked with `-- <extraArgs>`,
 *  because the args themselves are inert on every current worker CLI and the
 *  skills' binding-allowlist rules key on this block, not on CLI args. */
export function buildOperatorArgsBlock(promptArgs: string): string {
  return `\n\n## Operator arguments (this run)\n${promptArgs}\nTreat these as if the operator typed them alongside the skill trigger; they scope and constrain this run only.`;
}

/**
 * Returns true if the skill output should be suppressed (not sent to Telegram).
 * Checks whether the last non-empty line is exactly "NO_OUTPUT" — this handles workers
 * like agy that may emit reasoning/preamble text before the sentinel.
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
 * The `[PA_KEYBOARD]:` envelope (Wave-1 WP-C, 2026-09-02, SPEC §3.4): a
 * telegram_output skill's SCRIPT may end its output with one line
 *
 *   [PA_KEYBOARD]: {"buttons":[{"text":"Run again","callback_data":"sk:run:<skill>"}]}
 *
 * whose inline keyboard is validated against the ONE callback grammar
 * (callback-grammar.ts's validateKeyboardRequest — LLM-improvised callback_data is
 * grammar-checked, capped at 6 buttons / 40-char labels) and attached to the
 * delivery's last chunk. The envelope is emitted by the skill's deterministic
 * script, never trusted free-form from the worker.
 *
 * Parsing mirrors parseMetadata's last-marker logic exactly: the LAST
 * `\n[PA_KEYBOARD]:` occurrence (or a whole-output marker line), the JSON payload
 * must start with `{`, and the marker line is stripped from the delivered text.
 *
 * Every failure mode degrades to "deliver the text without a keyboard" — the
 * envelope must NEVER fail the run: a non-JSON payload strips silently
 * (parseMetadata parity); an unparseable or grammar-invalid payload warns and
 * drops; a skill in PROTECTED_SKILLS is refused outright (git-workflow skills
 * never get improvised buttons — the one-set-no-third-mirror rule).
 */
export function extractKeyboardEnvelope(
  output: string,
  skillName: string,
): { text: string; keyboard?: Record<string, unknown> } {
  const MARKER = '[PA_KEYBOARD]:';
  const nlMarker = '\n' + MARKER;
  const nlPos = output.lastIndexOf(nlMarker);

  let cleanedEnd: number;
  let markerLineStart: number;
  if (nlPos >= 0) {
    cleanedEnd = nlPos;
    markerLineStart = nlPos + 1;
  } else if (output.startsWith(MARKER)) {
    cleanedEnd = 0;
    markerLineStart = 0;
  } else {
    return { text: output };
  }

  // The envelope is ONE line (`[PA_KEYBOARD]: {json}`), so the payload is bounded
  // at the line end — NOT at end-of-output. Everything AFTER the line stays in
  // the delivered text, which is what makes the §3.4 ordering real: for
  // `report\n[PA_KEYBOARD]: {...}\nNO_OUTPUT` the remainder keeps the sentinel
  // line and the send is suppressed (a payload sliced to end-of-output would
  // swallow the sentinel into the JSON parse and the "contradictory request"
  // would go out as a bare send).
  const afterMarkerRaw = output.slice(markerLineStart + MARKER.length);
  const lineNl = afterMarkerRaw.indexOf('\n');
  const cleaned = (output.slice(0, cleanedEnd) + (lineNl >= 0 ? afterMarkerRaw.slice(lineNl) : '')).trim();
  const payloadLine = (lineNl >= 0 ? afterMarkerRaw.slice(0, lineNl) : afterMarkerRaw).trim();
  if (!payloadLine.startsWith('{')) {
    // parseMetadata parity: a marker line whose payload isn't JSON-shaped strips
    // silently and delivers the text with no keyboard.
    return { text: cleaned };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadLine);
  } catch {
    console.warn('[run] PA_KEYBOARD rejected — payload is not valid JSON — keyboard dropped');
    return { text: cleaned };
  }

  // Protected-skill refusal BEFORE grammar validation: the refusal reason is the
  // security one and must not be shadowed by a payload-shape complaint.
  if (PROTECTED_SKILLS.has(skillName)) {
    console.warn(`[run] PA_KEYBOARD refused — skill '${skillName}' is in PROTECTED_SKILLS — keyboard dropped`);
    return { text: cleaned };
  }

  const validated = validateKeyboardRequest(parsed);
  if (!validated.ok) {
    console.warn(`[run] PA_KEYBOARD rejected — ${validated.error} — keyboard dropped`);
    return { text: cleaned };
  }
  return { text: cleaned, keyboard: validated.keyboard };
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
 * AI-193: Python on Windows writes stdout/stderr in the machine's legacy ANSI
 * codepage (cp1252 here) while this runner collects with UTF-8 `toString()`, so
 * em-dashes and middots in Python skill output arrive as U+FFFD; text mode also
 * translates LF to CRLF. PYTHONUTF8=1 forces UTF-8 stdio for the child.
 * Scoped to python-family commands (first token) — a no-op for everyone else.
 */
export function shellSkillExtraEnv(cmd: string): Record<string, string> {
  return /^["']?\s*python(?:\d+(?:\.\d+)*)?(?:\.exe)?\s/i.test(cmd)
    ? { PYTHONUTF8: '1' }
    : {};
}

/**
 * AI-193: normalize child output collected on Windows — Python text mode emits
 * CRLF, and every downstream consumer (Telegram, logs, sentinels) expects LF.
 * Applied once to the fully-collected string, NOT per chunk: a `\r` ending one
 * chunk with `\n` starting the next must still collapse.
 */
export function normalizeCollectedText(text: string): string {
  return text.replace(/\r\n/g, '\n');
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
 * Subject/severity/dedupKey for a skill-failure alert, discriminating on
 * `worker === 'lock'` — the sentinel runCommand passes when the
 * exclusive_resource wait timed out (run.ts:399, see runSkillBody). Lock
 * contention is expected multi-session behaviour, not a page: it read to the
 * operator as "Skill failed: commit" three times in one week
 * (plans/2026-08-23-alerts-week-review.md §5.5). Extracted as a pure,
 * directly-testable function (2026-08-23).
 */
export function lockSkipAlertFields(
  worker: string,
  skillName: string,
): { subject: string; severity: 'info' | 'warn' | 'error'; dedupKey: string; topicDedupKey: string } {
  const isLockSkip = worker === 'lock';
  return {
    subject: isLockSkip ? `Skill skipped (lock busy): ${skillName}` : `Skill failed: ${skillName}`,
    severity: isLockSkip ? 'info' : 'error',
    dedupKey: isLockSkip ? `skill-lock-busy-${skillName}` : `skill-failed-${skillName}`,
    topicDedupKey: isLockSkip ? `skill-lock-busy-topic-${skillName}` : `skill-fail-topic-${skillName}`,
  };
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
  // like agy that prefix reasoning/preamble before the sentinel.
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
  if (result.success && result.output && telegramOutput && secrets) {
    // [PA_KEYBOARD] envelope ordering (SPEC §3.4): the envelope is stripped FIRST;
    // the NO_OUTPUT sentinel check then applies to the REMAINDER — a keyboard on a
    // suppressed send is a contradictory request and is dropped with it.
    const { text: deliveryText, keyboard } = extractKeyboardEnvelope(result.output, skillName);
    if (!isNoOutputSentinel(deliveryText)) {
      const token = secrets[telegramOutput.token_secret];
      if (token) {
        const send = await sendToTelegram(deliveryText, telegramOutput, token, 'MarkdownV2', keyboard);
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

    // The pa-alerts page is already suppressed for a lock skip via
    // alreadyAlertedPaSupport, but the telegram_output page below is not — see
    // lockSkipAlertFields for why this distinction exists.
    const { subject: failSubject, severity: failSeverity, dedupKey: paDedupKey, topicDedupKey } =
      lockSkipAlertFields(worker, skillName);

    // Alert pa-alerts on skill failure (unless already alerted by runWithFailover exhaustion)
    if (!result.alreadyAlertedPaSupport) {
      notifyUser(
        failSubject,
        `Skill: ${skillName}\nWorker: ${worker}\nDuration: ${(duration / 1000).toFixed(1)}s\nError: ${(result.error ?? '').slice(0, 500)}`,
        { dedupKey: paDedupKey, severity: failSeverity },
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
          failSubject,
          `Worker: ${worker}\nError: ${(result.error ?? 'unknown error').slice(0, 300)}`,
          {
            dedupKey: topicDedupKey,
            topic: { chat_id: telegramOutput.chat_id, thread_id: telegramOutput.thread_id },
            severity: failSeverity,
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
  promptArgs?: string,
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

  // AI-148 D-c: inject per-run operator arguments into the prompt
  if (promptArgs !== undefined && promptArgs.trim() !== '') {
    if (skill.frontmatter.cmd) {
      throw new Error('--prompt-args applies to LLM-worker skills only; cmd skills take their arguments after --');
    }
    finalPrompt = finalPrompt + buildOperatorArgsBlock(promptArgs);
    log('info', 'run', `Skill ${skillName}: prompt-args attached as the operator-arguments block`, {
      skill: skillName,
      promptArgs: promptArgs.slice(0, 300),
    });
  }

  // AI-187 (2026-09-03): bridge `--` extraArgs into the prompt for LLM-worker
  // skills. Before this, `pa run <llm-skill> -- <args>` handed the args ONLY to
  // the worker CLI (workerExtraArgs below), where they are inert on every
  // current worker (zclaude/codex splice them before the trailing `-` stdin
  // marker; agy gets them after the prompt-file arg). The commit skill's
  // binding-allowlist rule keys on the "## Operator arguments (this run)"
  // PROMPT block, so `pa run commit -- <9 paths>` produced NO block, the
  // worker's survey-everything fallback fired, and 13 dirty paths committed
  // against a 9-path allowlist (AI-185 wave, 2026-09-02; run
  // 20260902-043752-21b847). The bridge gives the block in BOTH invocation
  // forms — a safety rule must not depend on the caller knowing an
  // undocumented flag distinction. Worker-CLI passthrough is UNCHANGED (the
  // args still ride workerExtraArgs) — nothing that consumed them loses them.
  // cmd skills are exempt: their `--` args are real shell-command arguments.
  if (!skill.frontmatter.cmd && extraArgs.join('').trim() !== '') {
    finalPrompt = finalPrompt + buildOperatorArgsBlock(extraArgs.join('\n'));
    log('info', 'run', `Skill ${skillName}: ${extraArgs.length} extra arg(s) after -- bridged into the prompt as the operator-arguments block (AI-187)`, {
      skill: skillName,
      bridgedArgs: extraArgs,
    });
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

  // Cross-skill mutual exclusion. Different skill names (e.g. commit/push/
  // push-public/investigate-flagged, all declaring exclusive_resource:
  // git-workflow) run as separate `pa run` processes with no shared in-process
  // state, so nothing but a real lock stops two of them mutating the same
  // working tree at once. NOT set on commit-and-push itself — it spawns those
  // as child `pa run` processes and would deadlock waiting on its own child.
  const exclusiveResource = skill.frontmatter.exclusive_resource;
  const lockKey = exclusiveResource ? exclusiveLockKey(exclusiveResource) : undefined;
  let lockHeld = false;
  let lockContextId: string | undefined;
  let lockRenewal: { stop: () => void } | undefined;
  // Set by startLockRenewal's onLost: the run's result is downgraded to a failure once
  // runSkillBody() resolves, rather than trusting a "success" that raced an unknown
  // concurrent mutation. With the AI-179 tri-state renewal (2026-09-03), 'purged' means
  // the row was VERIFIED absent (renewHeartbeat returned row-absent, or its write
  // ladder failed and peekLockRow found no row) and 'expired' means the maxMs cap hit —
  // a transient heartbeat-write failure alone never fires onLost, so phantoms no longer
  // reach this downgrade.
  let lockLost: 'expired' | 'purged' | undefined;

  if (lockKey && exclusiveResource) {
    const waitStart = Date.now();
    const lockWaitMs = lockWaitBudgetMs(skill.frontmatter.timeout);
    lockContextId = randomUUID();
    lockHeld = await blackboard.acquireLock(lockKey, skillName, process.pid, lockWaitMs, lockContextId);
    if (!lockHeld) {
      const waitedS = Math.round((Date.now() - waitStart) / 1000);
      const lockResult: CommandResult = {
        success: false,
        alreadyAlertedPaSupport: true, // contention is expected, not a pa-alerts-worthy failure
        error: `Skipped: another skill holding exclusive_resource "${exclusiveResource}" was still running after waiting ${waitedS}s. Try again once it finishes.`,
        exitCode: -1,
        output: '',
      };
      await handleSkillResult(lockResult, 'lock', skillName, Date.now() - waitStart, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, allSecrets);
      return lockResult;
    }
    // Heartbeat while the run is in flight: acquireLock evicts a lock whose
    // heartbeat is older than HEARTBEAT_STALE_MS (10 min) PLUS a bounded grace
    // window when the holder's PID is still alive (see blackboard.ts's
    // classifyLock — 2026-09-01 followup-defects Defect 1; before that fix, an
    // alive holder was purged on staleness alone, which killed three real
    // push/push-public runs mid-gate on 2026-08-31), and dead-PID rows are
    // still purged immediately. push/push-public/investigate-flagged can all
    // legitimately run well past the stale threshold. Without this heartbeat,
    // a second run would eventually steal the lock mid-work once even the
    // grace window elapsed. Mirrors catchup.ts's own heartbeat.
    // startLockRenewal (2026-08-23) additionally detects a PURGED row via
    // onLost — the old hand-rolled setInterval renewed blindly and never
    // noticed a purge, so a concurrent commit could land undetected.
    lockRenewal = startLockRenewal(lockKey, skillName, lockContextId, {
      onLost: (reason) => {
        lockLost = reason;
        const refId = `s-${randomBytes(6).toString('hex')}`;
        log('error', 'run', `Lock lost mid-run for skill ${skillName}`, { skill: skillName, lockKey, reason, refId });
        void notifyUser(
          'Skill failed (lock lost)',
          `Skill: ${skillName}\nLock: ${lockKey}\nReason: ${reason}\n\n_Ref: ${refId}_`,
          { dedupKey: `skill-lock-lost:${skillName}`, severity: 'error' },
        ).catch(() => {});
      },
    });
  }

  try {
    const result = await runSkillBody();
    if (lockLost && lockKey) {
      // The run is deliberately NOT killed mid-gate: killing on a phantom and mid-push
      // on a real loss are both worse than continue-and-downgrade. Phantoms no longer
      // reach here — onLost fires on verified row-absence or the maxMs cap only
      // (AI-179, 2026-09-03).
      const downgraded: CommandResult = {
        ...result,
        success: false,
        alreadyAlertedPaSupport: true,
        error: `Lock lost (${lockLost}) mid-run — ${lockKey} was purged while this run held it; another process may have committed concurrently. Treat this run's tree mutations as unverified.`,
      };
      // Corrective note (AI-179 §3.5): the worker's report may claim a commit/push that
      // raced an unknown concurrent mutation. Whether the worker actually pushed is
      // unknown from the runner side, so this deliberately does NOT say "NOT pushed" —
      // ls-remote verification (push skill) is the decider.
      const refId = `s-${randomBytes(6).toString('hex')}`;
      log('error', 'run', `Lock-lost downgrade for skill ${skillName}`, { skill: skillName, lockKey, reason: lockLost, refId });
      void notifyUser(
        'Skill report unreliable (lock lost)',
        `⚠️ ${skillName}: this run LOST its "${exclusiveResource}" lock mid-run (${lockLost}). Its report above may be unreliable — before trusting any commit/push it claims, verify the remote with git ls-remote.\n\n_Ref: ${refId}_`,
        { dedupKey: `skill-lock-lost-followup:${skillName}`, severity: 'error' },
      ).catch(() => {});
      return downgraded;
    }
    return result;
  } finally {
    if (lockRenewal) lockRenewal.stop();
    if (lockHeld && lockKey) {
      await blackboard.releaseLock(lockKey, skillName, lockContextId, { pid: process.pid }).catch(() => {});
    }
  }

  async function runSkillBody(): Promise<CommandResult> {
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
        env: { ...process.env, ...secrets, ...shellSkillExtraEnv(fullCmd) },
        // POSIX only — see worker-exec.ts spawn for rationale (process-group
        // leader for killProcessTree; Windows keeps taskkill /T).
        detached: process.platform !== 'win32',
        // shell:true spawns a real cmd.exe console on Windows; without this
        // every cmd-based skill run flashes a visible window.
        windowsHide: true,
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
        const collectedOutput = normalizeCollectedText(output);
        const collectedError = normalizeCollectedText(error);
        const result: CommandResult = {
          success: !killed && code === 0,
          output: killed ? `[Timed out after ${timeoutSec}s]\n${collectedOutput.trim()}` : collectedOutput.trim(),
          error: collectedError.trim() || undefined,
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
          output: normalizeCollectedText(output).trim(),
        };
        await handleSkillResult(failResult, 'shell', skillName, Date.now() - start, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, allSecrets);
        resolve(failResult);
      });
    });
  }

  // 2. LLM worker execution
  // Skill-declared worker_args (e.g. agy --include-directories to widen its
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
        // Silent no-op (telegram_output skill, exit 0, empty output) is a
        // failure of the pinned worker too — fall into failover rather than
        // returning a "success" that handleSkillResult can only reclassify
        // after the chance to try another worker has passed (2026-08-21).
        // NO_OUTPUT sentinel is non-empty output and passes.
        if (skill.frontmatter.telegram_output && (!prefResult.output || !prefResult.output.trim()) && willFailover) {
          console.warn(`[run] preferred worker ${workerPref} exited 0 with empty output for ${skillName} (silent no-op), falling back to failover`);
        } else {
          await handleSkillResult(prefResult, workerPref, skillName, Date.now() - start, extraArgs, depth, preferredWorker, skill.frontmatter.telegram_output, secrets);
          return prefResult;
        }
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
    // A telegram_output skill exists to DELIVER — a worker that exits 0 with
    // empty output fails over instead of ending the cascade as a fake
    // success (workers.ts applies the check inside the loop).
    requireNonEmptyOutput: !!skill.frontmatter.telegram_output,
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
}
