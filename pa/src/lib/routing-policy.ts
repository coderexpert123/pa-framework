// Model routing policy (2026-09-11, plans/2026-09-11-model-routing-policy.md).
//
// Classifies a turn as code/engineering or general and — for code turns —
// overrides the topic default with a time-window worker: code_worker outside
// the ZAI peak window, peak_code_worker inside it. The peak window is
// cost_tier.peak_window_utc (lib/peak-window.ts), never a second config.
//
// Deterministic by design (repo rule: deterministic decisions never in LLM
// arithmetic): classification is regex signals over the turn text. Every
// resolution path fails OPEN — an unknown worker name, an unparseable policy,
// or an 'off' topic returns no override and the dispatch keeps today's
// topic-default behavior.

import { execFile } from 'node:child_process';
import { isPeakWindow, resolvePeakWindowUtc } from './peak-window.js';
import type { CostTierConfig, RoutingPolicyConfig } from '../types.js';
import { logger } from './log.js';
import { askSystemOne, type TypeSafeChoiceQuestion } from './typesafe-client.js';

export type RequestClass = 'code' | 'general';

export interface RoutingDecision {
  requestClass: RequestClass;
  peak: boolean;
  /** Set = override the topic default with this worker for this turn.
   *  Undefined = keep the incoming default (general behavior). */
  worker?: string;
  reason: string;
}

export interface RoutingInput {
  topicKey: string;
  /** The turn's user text (prompt body, not command prefix). */
  text: string;
  now?: Date;
  /** Configured worker names — override candidates are validated against it. */
  workerNames: string[];
  /** RAW topic_defaults[topicKey] (undefined when the topic has none). */
  topicDefault?: string;
  /** config.cost_tier — the single peak-window source. */
  costTier?: CostTierConfig;
  judgeRunner?: (text: string, model: string, timeoutMs: number) => Promise<RequestClass | undefined>;
  /** Test seam for judge 'typesafe'. Production uses classifyWithTypeSafe. */
  typeSafeJudge?: (text: string) => Promise<RequestClass | undefined>;
}

/**
 * Built-in code/engineering signals. Conservative on purpose: a miss routes a
 * code ask to the general worker (harmless — the chain still fails over); a
 * false positive only picks a stronger worker for a chat turn. Case-
 * insensitive; tested against the whole turn text.
 */
export const DEFAULT_CODE_PATTERNS: RegExp[] = [
  // Explicit engineering verbs + artifacts
  /\b(refactor|debug|repro\b|stack ?trace|traceback|compile|hotfix|code ?review|unit ?tests?|integration ?tests?|test ?suite|merge conflict|pull request|\bpr\b diff)/i,
  // Languages / runtimes / tools
  /\b(typescript|javascript|node\.?js|npm|python|regex|sql\b|json schema|docker|kubernetes|css|html|react|git\b)/i,
  // Fix/build/implement … <code noun>
  /\b(fix|repair|patch|implement|write|add|build|update|create)\b[^.!?]{0,60}\b(bug|error|exception|crash|function|method|class|module|script|endpoint|\bapi\b|component|hook|command|parser|feature|test|tests|migration|query)\b/i,
  /\b(bug|error|exception|crash)\b[^.!?]{0,60}\b(fix|repair|patch)\b/i,
  // Version control shapes
  /\b(git|repo|repository|branch)\b[^.!?]{0,40}\b(commit|push|merge|rebase|checkout|stash|diff|conflict)\b/i,
  // Code file extensions mentioned anywhere in the text
  /\.(tsx?|jsx?|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|sh|bat|ps1|sql|ya?ml|toml|mjs|cjs)\b/i,
];

function compileCustomPatterns(sources: string[] | undefined): RegExp[] {
  if (!sources?.length) return [];
  const out: RegExp[] = [];
  for (const src of sources) {
    try {
      out.push(new RegExp(src, 'i'));
    } catch {
      // parseRoutingPolicy already drops invalid sources; defensive only.
    }
  }
  return out;
}

/** Deterministic code-vs-general classification of one turn's text. */
export function classifyRequestText(text: string, policy: RoutingPolicyConfig): RequestClass {
  const patterns = [...DEFAULT_CODE_PATTERNS, ...compileCustomPatterns(policy.code_patterns)];
  return patterns.some((p) => p.test(text)) ? 'code' : 'general';
}

function quoteArg(a: string): string {
  if (process.platform === 'win32') {
    const escaped = a.replace(/"/g, '\\"').split('%').join('"^%"');
    return `"${escaped}"`;
  }
  return a;
}

/**
 * Classify a turn's text using the Antigravity (agy) CLI as a fast LLM judge.
 * Fail-open: returns undefined on timeout, non-zero exit, or unrecognized output,
 * letting the caller fall back to deterministic regex heuristics.
 */
export function classifyWithAgy(
  text: string,
  options: { model: string; timeoutMs: number; command?: string },
): Promise<RequestClass | undefined> {
  return new Promise((resolve) => {
    try {
      const prompt = `You are a routing judge. Classify the user input as 'code' if it is about software engineering, programming, or coding tasks. Classify as 'general' otherwise. Reply ONLY with 'code' or 'general'.\n\nInput: ${text.slice(0, 1000)}`;
      const cmd = options.command || (process.platform === 'win32' ? 'D:\\gemini-shim\\agy.cmd' : 'agy');
      const rawArgs = ['--model', options.model, '-p', prompt];
      const args = process.platform === 'win32' ? rawArgs.map(quoteArg) : rawArgs;
      execFile(
        cmd,
        args,
        {
          timeout: options.timeoutMs,
          shell: process.platform === 'win32',
          windowsHide: true,
        },
        (err, stdout, _stderr) => {
          if (err) {
            logger.warn('routing-policy', `agy judge failed or timed out: ${err.message}`, { error: String(err) });
            resolve(undefined);
            return;
          }
          let trimmed = (stdout || '').trim().toLowerCase();
          if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('`') && trimmed.endsWith('`'))) {
            trimmed = trimmed.slice(1, -1).trim();
          }
          if (trimmed === 'code' || trimmed === 'general') {
            resolve(trimmed);
            return;
          }
          logger.warn('routing-policy', `agy judge returned unrecognized output: ${JSON.stringify(stdout)}`);
          resolve(undefined);
        },
      );
    } catch (err) {
      logger.warn('routing-policy', `agy judge invocation error: ${(err as Error).message}`);
      resolve(undefined);
    }
  });
}

/** State cap for the TypeSafe judge (the agy path sends 1,000 chars). */
export const TYPESAFE_JUDGE_STATE_MAX_CHARS = 4000;

/**
 * The code/general question (V2, judge wording tuning, 2026-09-18, JE-4):
 * structured `{what, not_for, examples}` criteria, measured at 86% agreement
 * against 104 Claude-labelled operator requests (the prior plain-string
 * wording below scored 75%; `pa typesafe eval --judge`,
 * plans/2026-09-17-typesafe-judge-eval-result.md). The dominant miss
 * under the old wording was under-detecting code: bug reports and "why did
 * X happen" questions about the assistant's OWN dev framework read as
 * everyday app use. `not_for` on each option carves out the mirror
 * confusion — organizing the assistant's own task/backlog items uses
 * software vocabulary without asking for any software change.
 *
 * Criteria are no longer string-only: `TypeSafeChoiceQuestion.criteria` was
 * widened the same day (typesafe-client.ts) once this measurement showed
 * the API always accepted the structured shape and pa's own type was the
 * only thing forcing it into flattened strings.
 */
export const REQUEST_CLASS_QUESTION: TypeSafeChoiceQuestion = {
  type: 'choice',
  instructions:
    "Classify the request in `request`: does it ask for software engineering work on this assistant's own dev project or any codebase, or for anything else? A request that continues, checks on, or is a short reply about EARLIER technical or engineering work (for example \"go ahead\", \"fix it\", \"do it\") counts as code.",
  criteria: {
    code: {
      what:
        "Software engineering work: writing, changing, debugging, testing, reviewing, building or deploying code, scripts, configuration or infrastructure; reading or investigating logs, errors, stack traces, crashes, or unexpected behavior; explaining how a program, developer tool, or THIS ASSISTANT'S OWN workers, jobs, UI, or automations behave. Includes bug reports about the assistant's own app or bot not working, and any request about the assistant's own code.",
      not_for:
        'Managing work items as items only — adding, merging, resuming, or reordering tasks, backlog entries, or conversation threads — without asking anything about the software’s behavior to be checked, fixed, or explained. Also not for asking only for a different reply format, tone, or presentation.',
      examples: [
        'fix the crash in the parser',
        'why does the build fail on Windows',
        'add a retry to the sync script',
        'who is creating these extra processes',
        'is claude rate limited, can you check',
        "the mic icon isn't showing in the app",
        'why is the dashboard button erroring',
      ],
    },
    general: {
      what:
        "Anything else: questions, research, planning, reminders, personal admin, writing, shopping, health, travel, and using apps or services as intended. Includes operating or organizing the assistant's own workflow itself — adding, merging, resuming, or reordering its tasks, backlog items, or threads — as long as it does not ask for the underlying software to be changed, fixed, checked, or explained.",
      not_for:
        "Reporting that the assistant's own software, UI, or a worker is broken, or asking how or why its code behaves — that is code even when it reads like an everyday complaint.",
      examples: [
        'remind me to call the bank at 4pm',
        'what did the doctor say about fasting',
        'compare these two cars',
        'resume all stuck threads',
        'add this to the backlog',
        'merge this task with that one',
      ],
    },
  },
};

/** One TypeSafe code/general answer with the confidence the eval bands on. */
export interface TypeSafeJudgment {
  requestClass: RequestClass;
  confidence: number;
}

/**
 * Ask the code/general Choice once and keep its confidence. Fail-open:
 * undefined on any client failure (no key, breaker open, timeout, HTTP error,
 * bad response). `purpose` labels the client log line; the live judge uses
 * 'routing-judge', `pa typesafe eval --judge` its own.
 */
export async function judgeWithTypeSafe(
  text: string,
  options: { ask?: typeof askSystemOne; purpose?: string } = {}
): Promise<TypeSafeJudgment | undefined> {
  const ask = options.ask ?? askSystemOne;
  const result = await ask(
    {
      state: { request: text.slice(0, TYPESAFE_JUDGE_STATE_MAX_CHARS) },
      questions: { request_class: REQUEST_CLASS_QUESTION },
    },
    { purpose: options.purpose ?? 'routing-judge' }
  );
  if (!result.ok) return undefined;
  const answer = result.answers.request_class;
  if (!answer || answer.type !== 'choice') return undefined;
  const requestClass: RequestClass | undefined =
    answer.choice === 'code' ? 'code' : answer.choice === 'general' ? 'general' : undefined;
  if (requestClass === undefined) return undefined;
  return { requestClass, confidence: answer.confidence };
}

/**
 * Classify a turn's text with one TypeSafe Choice. Fail-open: undefined on any
 * client failure, so the caller falls back to the deterministic regex — never
 * to agy.
 */
export async function classifyWithTypeSafe(
  text: string,
  options: { ask?: typeof askSystemOne } = {}
): Promise<RequestClass | undefined> {
  return (await judgeWithTypeSafe(text, { ask: options.ask }))?.requestClass;
}

/**
 * Resolve one turn's routing decision. Never throws and never returns a
 * worker outside `workerNames` — anything unresolved returns worker:
 * undefined and the caller keeps its incoming default.
 */
export async function resolveRoutingWorker(policy: RoutingPolicyConfig, input: RoutingInput): Promise<RoutingDecision> {
  const peak = isPeakWindow(input.now ?? new Date(), resolvePeakWindowUtc(input.costTier?.peak_window_utc));

  const classPin = policy.topic_classes?.[input.topicKey];
  if (classPin === 'off') {
    return { requestClass: 'general', peak, reason: `policy off for ${input.topicKey}` };
  }

  let requestClass: RequestClass;
  if (classPin) {
    requestClass = classPin;
  } else if (policy.judge === 'typesafe') {
    // TypeSafe ladder (operator decision D5, 2026-09-17): pin (above) →
    // one TypeSafe Choice → the deterministic regex. Never agy.
    let typedClass: RequestClass | undefined;
    try {
      typedClass = await (input.typeSafeJudge ?? classifyWithTypeSafe)(input.text);
    } catch (err) {
      logger.warn('routing-policy', `typesafe judge threw: ${(err as Error).message}`);
      typedClass = undefined;
    }
    requestClass = (typedClass === 'code' || typedClass === 'general')
      ? typedClass
      : classifyRequestText(input.text, policy);
  } else if (policy.judge === 'agy' || policy.judge === undefined) {
    const judgeModel = policy.judge_model ?? 'gemini-3.6-flash-low';
    const judgeTimeoutMs = policy.judge_timeout_ms ?? 20000;
    let agyClass: RequestClass | undefined;
    try {
      agyClass = input.judgeRunner
        ? await input.judgeRunner(input.text, judgeModel, judgeTimeoutMs)
        : await classifyWithAgy(input.text, { model: judgeModel, timeoutMs: judgeTimeoutMs, command: policy.judge_command });
    } catch (err) {
      logger.warn('routing-policy', `agy judge runner threw error: ${(err as Error).message}`);
      agyClass = undefined;
    }
    requestClass = (agyClass === 'code' || agyClass === 'general')
      ? agyClass
      : classifyRequestText(input.text, policy);
  } else {
    requestClass = classifyRequestText(input.text, policy);
  }

  if (requestClass === 'general') {
    // General turns keep today's behavior (topic default, else the first
    // priority worker). general_worker only fills topics with NO default,
    // where "prefer agy" would otherwise be implicit chain order.
    if (!input.topicDefault && policy.general_worker && input.workerNames.includes(policy.general_worker)) {
      return { requestClass, peak, worker: policy.general_worker, reason: 'general turn on a topic with no configured default' };
    }
    return { requestClass, peak, worker: undefined, reason: 'general turn keeps the topic default' };
  }

  const target = peak ? policy.peak_code_worker : policy.code_worker;
  if (!target) {
    return { requestClass, peak, worker: undefined, reason: `code turn but no ${peak ? 'peak_code_worker' : 'code_worker'} configured` };
  }
  if (!input.workerNames.includes(target)) {
    return { requestClass, peak, worker: undefined, reason: `code target '${target}' is not a configured worker` };
  }
  return {
    requestClass,
    peak,
    worker: target,
    reason: peak
      ? 'code turn inside the peak window'
      : 'code turn outside the peak window',
  };
}
