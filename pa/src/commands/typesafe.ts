/**
 * `pa typesafe` (2026-09-17) — operator tools for the TypeSafe client.
 *   check [--samples N]  one trivial Choice per sample (default 5, max 20):
 *                        prints status, latency and token usage per sample,
 *                        then p50/max latency. Exit 0 ok, 1 not configured or
 *                        an API error, 2 usage.
 *   eval [--since YYYY-MM-DD] [--limit N] [--dry-run] [--out <path>]
 *                        replays LLM-routed voice-inbox tasks through typed
 *                        routing (lib/typesafe-routing-eval.ts). --dry-run
 *                        sends nothing and needs no key.
 *   eval --judge [--since D] [--until D] [--limit N] [--agy N] [--labels-only]
 *                [--dry-run] [--out <path>]
 *                        scores the code/general turn judge against Claude
 *                        CLI labels of past requests (lib/typesafe-judge-eval.ts).
 * Any unknown subcommand or flag (including --help) prints usage and exits 2
 * without sending anything.
 */
import { askSystemOne, isTypeSafeConfigured } from '../lib/typesafe-client.js';
import { REQUEST_CLASS_QUESTION } from '../lib/routing-policy.js';
import { runTypedRoutingEval, type EvalDeps, type EvalOptions } from '../lib/typesafe-routing-eval.js';
import {
  JUDGE_EVAL_DEFAULT_AGY,
  JUDGE_EVAL_DEFAULT_LIMIT,
  JUDGE_EVAL_MAX_AGY,
  JUDGE_EVAL_MAX_LIMIT,
  runJudgeEval,
  type JudgeEvalDeps,
  type JudgeEvalOptions,
} from '../lib/typesafe-judge-eval.js';
import { runTierEval, type TierEvalDeps, type TierEvalOptions } from '../lib/model-router/tier-eval.js';

export const TYPESAFE_USAGE =
  'Usage: pa typesafe check [--samples <1-20>]\n' +
  '       pa typesafe eval [--since YYYY-MM-DD] [--limit <n>] [--dry-run] [--out <path>]\n' +
  '       pa typesafe eval --judge [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--limit <1-400>] [--agy <0-30>] [--labels-only] [--dry-run] [--out <path>]\n' +
  '       pa typesafe eval --tier [--limit <n>] [--dry-run] [--out <path>]\n' +
  '                        scores the model-router needs classifier (tier + effort Score) over the\n' +
  '                        labelled turns (lib/model-router/tier-eval.ts)';

export const TYPESAFE_CHECK_STATE = { request: 'remind me to water the plants tomorrow at 7' };

export interface TypesafeCommandDeps {
  ask?: typeof askSystemOne;
  configured?: () => boolean;
  print?: (line: string) => void;
  runEval?: (opts: EvalOptions, deps: EvalDeps) => Promise<number>;
  runJudgeEval?: (opts: JudgeEvalOptions, deps: JudgeEvalDeps) => Promise<number>;
  runTierEval?: (opts: TierEvalOptions, deps: TierEvalDeps) => Promise<number>;
}

export async function typesafeCommand(args: string[], deps: TypesafeCommandDeps = {}): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  if (args[0] === 'check') return typesafeCheck(args.slice(1), deps, print);
  if (args[0] === 'eval') return typesafeEval(args.slice(1), deps, print);
  print(TYPESAFE_USAGE);
  return 2;
}

async function typesafeCheck(args: string[], deps: TypesafeCommandDeps, print: (line: string) => void): Promise<number> {
  let samples = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--samples') {
      const n = Number(args[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        print(TYPESAFE_USAGE);
        return 2;
      }
      samples = n;
      i += 1;
      continue;
    }
    print(TYPESAFE_USAGE);
    return 2;
  }
  const configured = deps.configured ?? (() => isTypeSafeConfigured());
  if (!configured()) {
    print('typesafe: not configured (TYPESAFE_API_KEY unset in the environment and secrets.env, or circuit breaker open); nothing was sent');
    return 1;
  }
  const ask = deps.ask ?? askSystemOne;
  const latencies: number[] = [];
  for (let s = 1; s <= samples; s++) {
    const r = await ask(
      { state: TYPESAFE_CHECK_STATE, questions: { request_class: REQUEST_CLASS_QUESTION } },
      { purpose: 'typesafe-check' }
    );
    if (!r.ok) {
      print(`sample ${s}: status=error error=${r.error}${r.status !== undefined ? ` http=${r.status}` : ''} latency_ms=${r.latencyMs}`);
      return 1;
    }
    const a = r.answers.request_class;
    const choice = a && a.type === 'choice' ? a.choice : '?';
    const confidence = a && a.type === 'choice' ? a.confidence.toFixed(3) : '?';
    latencies.push(r.latencyMs);
    print(`sample ${s}: status=ok http=${r.status} latency_ms=${r.latencyMs} input_tokens=${r.usage.inputTokens} choice=${choice} confidence=${confidence}`);
  }
  const sorted = [...latencies].sort((x, y) => x - y);
  print(`typesafe: ok samples=${samples} latency_ms p50=${sorted[Math.floor((sorted.length - 1) / 2)]} max=${sorted[sorted.length - 1]}`);
  return 0;
}

async function typesafeEval(args: string[], deps: TypesafeCommandDeps, print: (line: string) => void): Promise<number> {
  if (args.includes('--judge')) return typesafeJudgeEval(args.filter((a) => a !== '--judge'), deps, print);
  if (args.includes('--tier')) return typesafeTierEval(args.filter((a) => a !== '--tier'), deps, print);
  const opts: EvalOptions = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--dry-run') {
      opts.dryRun = true;
    } else if (flag === '--since' && value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      opts.sinceIso = `${value}T00:00:00.000Z`;
      i += 1;
    } else if (flag === '--limit' && value !== undefined && Number.isInteger(Number(value)) && Number(value) >= 1) {
      opts.limit = Number(value);
      i += 1;
    } else if (flag === '--out' && value !== undefined && value !== '' && !value.startsWith('--')) {
      opts.outPath = value;
      i += 1;
    } else {
      print(TYPESAFE_USAGE);
      return 2;
    }
  }
  const run = deps.runEval ?? runTypedRoutingEval;
  return run(opts, { print, askFn: deps.ask, configuredFn: deps.configured });
}

function isoDay(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const iso = `${value}T00:00:00.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
}

function intInRange(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= min && n <= max ? n : undefined;
}

async function typesafeJudgeEval(args: string[], deps: TypesafeCommandDeps, print: (line: string) => void): Promise<number> {
  const opts: JudgeEvalOptions = {
    limit: JUDGE_EVAL_DEFAULT_LIMIT,
    agy: JUDGE_EVAL_DEFAULT_AGY,
    dryRun: false,
    labelsOnly: false,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    const day = isoDay(value);
    const limit = intInRange(value, 1, JUDGE_EVAL_MAX_LIMIT);
    const agy = intInRange(value, 0, JUDGE_EVAL_MAX_AGY);
    if (flag === '--dry-run') {
      opts.dryRun = true;
    } else if (flag === '--labels-only') {
      opts.labelsOnly = true;
    } else if (flag === '--since' && day !== undefined) {
      opts.sinceIso = day;
      i += 1;
    } else if (flag === '--until' && day !== undefined) {
      opts.untilIso = day;
      i += 1;
    } else if (flag === '--limit' && limit !== undefined) {
      opts.limit = limit;
      i += 1;
    } else if (flag === '--agy' && agy !== undefined) {
      opts.agy = agy;
      i += 1;
    } else if (flag === '--out' && value !== undefined && value !== '' && !value.startsWith('--')) {
      opts.outPath = value;
      i += 1;
    } else {
      print(TYPESAFE_USAGE);
      return 2;
    }
  }
  const run = deps.runJudgeEval ?? runJudgeEval;
  return run(opts, { print, askFn: deps.ask, configuredFn: deps.configured });
}

async function typesafeTierEval(args: string[], deps: TypesafeCommandDeps, print: (line: string) => void): Promise<number> {
  const opts: TierEvalOptions = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--dry-run') {
      opts.dryRun = true;
    } else if (flag === '--limit' && value !== undefined && Number.isInteger(Number(value)) && Number(value) >= 1) {
      opts.limit = Number(value);
      i += 1;
    } else if (flag === '--labels-out' && value !== undefined && value !== '' && !value.startsWith('--')) {
      opts.labelsOutPath = value;
      i += 1;
    } else if (flag === '--out' && value !== undefined && value !== '' && !value.startsWith('--')) {
      opts.resultOutPath = value;
      i += 1;
    } else {
      print(TYPESAFE_USAGE);
      return 2;
    }
  }
  const run = deps.runTierEval ?? runTierEval;
  return run(opts, { print, askFn: deps.ask, configuredFn: deps.configured });
}
