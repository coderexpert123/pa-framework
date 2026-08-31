/**
 * Turn-trace sidecar (AI-161, plans/2026-08-24-recall-traces-wave-SPEC.md §3.1).
 *
 * One append-only line per `executeWorker` run in `~/.pa/turn-traces.jsonl`,
 * capturing what the worker actually did (tool calls, commands, files,
 * errors) beyond the 300-char text preview the analyzer sees today. Feeds
 * `pa ref` (a trace block under a bot turn) and, later, the recall index and
 * the analyzer's trace-fed drafter (WP-D/WP-E, same wave).
 *
 * Two dialects are understood:
 *  - agy/agyc `step_update` stream events (C3 in the spec, measured from the
 *    live tee corpus).
 *  - claude-family `tool_use`/`tool_result` blocks (C4).
 * Codex (`item.completed`, `event_msg`, `thread.started`) matches neither
 * branch by design — `parsed` stays `false` for it (C4); when codex comes
 * off cooldown a third branch can be added with no schema change (§7.2).
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { paHome } from '../paths.js';
import { redactSecrets } from './redact.js';
import { rotateFileIfNeeded } from './archive-files.js';
import { logger } from './log.js';

export const TURN_TRACE_VERSION = 1;

export const TRACE_CAPS = {
  arg: 200,          // per tool_call.arg, per commands[] entry, per files[] entry
  toolCalls: 200,
  commands: 50,
  files: 50,
  errors: 5,
  errorChars: 300,
} as const;

export type TraceOrigin = 'bot' | 'skill' | 'self-improver' | 'other';
export type TraceOutcome = 'ok' | 'error' | 'timeout' | 'killed' | 'failover';

export interface TurnTraceToolCall {
  n: number;        // 1-based ordinal, assignment order
  name: string;
  arg: string;      // <= TRACE_CAPS.arg chars
  ok: boolean;
  ms?: number;      // integer milliseconds, when the dialect reports a duration
}

export interface TurnTraceV1 {
  v: 1;
  run_id: string;              // uuid, from CommandResult.runId
  ts_start: string;            // ISO
  ts_end: string;              // ISO
  duration_ms: number;
  origin: TraceOrigin;
  chat_id?: number;
  thread_id?: number;
  update_id?: number;
  skill?: string;              // skill name for origin 'skill'
  worker: string;              // worker.name
  model?: string;
  session_id?: string;
  exit_code: number | null;
  outcome: TraceOutcome;
  parsed: boolean;
  tool_calls: TurnTraceToolCall[];
  commands: string[];
  files: string[];
  errors: string[];
  retries: number;             // always 0 in v1 (executeWorker has no retry loop); the seam is the field
  tokens?: { in: number; out: number };
  bytes_out: number;           // stdout byte length at completion
  truncated: boolean;          // true iff ANY cap above was hit
}

/**
 * 'topic-'          -> 'bot'      (main.ts:1275 `topic-${chatId}_${threadId}`)
 * 'skill-'          -> 'skill'    (commands/run.ts:595,631 `skill-${skillName}`)
 * 'self-improver'   -> 'self-improver' (prefix match; code-fixer.ts:872
 *                      `self-improver-code-fix-${proposal.name}`)
 * anything else / undefined -> 'other'
 */
export function classifyOrigin(resource: string | undefined): TraceOrigin {
  if (resource === undefined) return 'other';
  if (resource.startsWith('topic-')) return 'bot';
  if (resource.startsWith('skill-')) return 'skill';
  if (resource.startsWith('self-improver')) return 'self-improver';
  return 'other';
}

const BOT_RESOURCE_RE = /^topic-(-?\d+)_(\d+)$/;

/** /^topic-(-?\d+)_(\d+)$/ ; undefined when it does not match. */
export function parseBotResource(resource: string | undefined): { chatId: number; threadId: number } | undefined {
  if (resource === undefined) return undefined;
  const m = BOT_RESOURCE_RE.exec(resource);
  if (!m) return undefined;
  return { chatId: Number(m[1]), threadId: Number(m[2]) };
}

const SKILL_RESOURCE_RE = /^skill-(.+)$/;

/** /^skill-(.+)$/ -> group 1. */
export function skillFromResource(resource: string | undefined): string | undefined {
  if (resource === undefined) return undefined;
  const m = SKILL_RESOURCE_RE.exec(resource);
  return m ? m[1] : undefined;
}

const TIMEOUT_ERROR_RE = /idle timeout|max timeout|absolute timeout/i;

/**
 * Order is exact and must not be reordered:
 *   exitCode === 0                                   -> 'ok'
 *   cancelled                                        -> 'killed'
 *   /idle timeout|max timeout|absolute timeout/i.test(error ?? '') -> 'timeout'
 *   suppressExitAlert                                -> 'failover'   // workers.ts:321 sets it
 *                                                       //  only for a non-terminal hop
 *   otherwise                                        -> 'error'
 */
export function classifyOutcome(a: {
  exitCode: number | null;
  cancelled: boolean;          // options.isCancelled?.() === true, evaluated defensively
  suppressExitAlert: boolean;  // options.suppressExitAlert === true
  error?: string;
}): TraceOutcome {
  if (a.exitCode === 0) return 'ok';
  if (a.cancelled) return 'killed';
  if (TIMEOUT_ERROR_RE.test(a.error ?? '')) return 'timeout';
  if (a.suppressExitAlert) return 'failover';
  return 'error';
}

// Parameter keys read off su.tool_info.parameters, in priority order, to
// build a tool call's `arg` display string (C3).
const AGY_ARG_KEYS = [
  'CommandLine', 'AbsolutePath', 'TargetFile', 'Query', 'Pattern',
  'DirectoryPath', 'SearchPath', 'SearchDirectory', 'Prompt', 'Action', 'query',
];

const CLAUDE_ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url'];

const CLAUDE_FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);

export class TraceCollector {
  private readonly isAgyDialect: boolean;
  private _parsed = false;
  private _model: string | undefined;
  private _tokens: { in: number; out: number } | undefined;
  private _truncated = false;

  // agy: keyed by step_index. claude: keyed by tool_use id (String()'d in both cases).
  private readonly toolCallsByKey = new Map<string, TurnTraceToolCall>();
  private readonly toolCallOrder: TurnTraceToolCall[] = [];
  private readonly commandStepSeen = new Set<string>();
  private readonly commands: string[] = [];
  private readonly filesSeen = new Set<string>();
  private readonly files: string[] = [];
  private readonly errors: string[] = [];
  private nextOrdinal = 1;

  constructor(opts: { isAgyDialect: boolean }) {
    this.isAgyDialect = opts.isAgyDialect;
  }

  get parsed(): boolean { return this._parsed; }
  get model(): string | undefined { return this._model; }
  get tokens(): { in: number; out: number } | undefined { return this._tokens; }

  /** Feed one already-JSON.parse'd stream event. Never throws. */
  observe(event: unknown): void {
    try {
      if (this.isAgyDialect) this.observeAgy(event);
      else this.observeClaude(event);
    } catch {
      // never throws — a malformed/unexpected event shape must not break the dispatch
    }
  }

  /** Applies every cap and returns the collected slices + truncated flag. */
  harvest(): {
    tool_calls: TurnTraceToolCall[]; commands: string[]; files: string[];
    errors: string[]; truncated: boolean;
  } {
    let tool_calls = this.toolCallOrder;
    if (tool_calls.length > TRACE_CAPS.toolCalls) {
      this._truncated = true;
      tool_calls = tool_calls.slice(0, TRACE_CAPS.toolCalls);
    }

    let commands = this.commands;
    if (commands.length > TRACE_CAPS.commands) {
      this._truncated = true;
      commands = commands.slice(0, TRACE_CAPS.commands);
    }
    commands = commands.map((c) => this.cap(c, TRACE_CAPS.arg));

    let files = this.files;
    if (files.length > TRACE_CAPS.files) {
      this._truncated = true;
      files = files.slice(0, TRACE_CAPS.files);
    }
    files = files.map((f) => this.cap(f, TRACE_CAPS.arg));

    let errors = this.errors;
    if (errors.length > TRACE_CAPS.errors) {
      this._truncated = true;
      errors = errors.slice(0, TRACE_CAPS.errors);
    }
    errors = errors.map((e) => this.cap(e, TRACE_CAPS.errorChars));

    return { tool_calls, commands, files, errors, truncated: this._truncated };
  }

  private cap(s: string, max: number): string {
    if (s.length > max) {
      this._truncated = true;
      return s.slice(0, max);
    }
    return s;
  }

  private pushCommand(value: unknown): void {
    if (value === undefined || value === null) return;
    this.commands.push(String(value));
  }

  private pushFile(value: unknown): void {
    if (value === undefined || value === null) return;
    const s = String(value);
    if (!this.filesSeen.has(s)) {
      this.filesSeen.add(s);
      this.files.push(s);
    }
  }

  private agyArg(su: any): string {
    const parameters = su?.tool_info?.parameters;
    let value: unknown;
    if (parameters && typeof parameters === 'object') {
      for (const key of AGY_ARG_KEYS) {
        if (parameters[key] !== undefined) { value = parameters[key]; break; }
      }
    }
    const str = value !== undefined ? String(value) : JSON.stringify(parameters ?? {});
    return this.cap(str, TRACE_CAPS.arg);
  }

  private observeAgy(event: any): void {
    if (!event || typeof event !== 'object') return;

    if (event.event === 'init') {
      this._parsed = true;
      if (typeof event.init?.model === 'string') this._model = event.init.model;
      return;
    }

    if (event.event === 'step_update') {
      const su = event.step_update;
      if (su && su.step_type === 'tool') {
        this._parsed = true;
        const key = String(su.step_index);
        let call = this.toolCallsByKey.get(key);
        if (!call) {
          call = { n: this.nextOrdinal++, name: String(su.tool_name ?? 'unknown'), arg: this.agyArg(su), ok: true };
          this.toolCallsByKey.set(key, call);
          this.toolCallOrder.push(call);
        }

        if (su.state === 'DONE') {
          call.ms = Math.round((su.duration_seconds ?? 0) * 1000);
          call.ok = !su.tool_info?.error;
        } else if (su.state === 'ERROR') {
          call.ok = false;
          if (su.duration_seconds !== undefined) call.ms = Math.round(su.duration_seconds * 1000);
          this.errors.push(String(su.tool_info?.error?.message ?? su.tool_info?.error ?? 'tool error'));
        }

        if (su.tool_name === 'run_command' && !this.commandStepSeen.has(key)) {
          this.commandStepSeen.add(key);
          this.pushCommand(su.tool_info?.parameters?.CommandLine);
        }

        if (su.tool_name === 'view_file') {
          this.pushFile(su.tool_info?.parameters?.AbsolutePath);
        } else if (su.tool_name === 'write_to_file' || su.tool_name === 'replace_file_content') {
          this.pushFile(su.tool_info?.parameters?.TargetFile);
        }
      }
      return;
    }

    if (event.event === 'result') {
      this._parsed = true;
      const usage = event.result?.usage;
      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
        this._tokens = { in: usage.input_tokens, out: usage.output_tokens };
      }
      if (event.result?.status !== undefined && event.result.status !== 'SUCCESS') {
        this.errors.push(String(event.result.error ?? event.result.status));
      }
    }
  }

  private claudeArg(input: any): string {
    let value: unknown;
    if (input && typeof input === 'object') {
      for (const key of CLAUDE_ARG_KEYS) {
        if (input[key] !== undefined) { value = input[key]; break; }
      }
    }
    const str = value !== undefined ? String(value) : JSON.stringify(input ?? {});
    return this.cap(str, TRACE_CAPS.arg);
  }

  private observeClaude(event: any): void {
    if (!event || typeof event !== 'object') return;

    if (this._model === undefined) {
      const m = event.message?.model ?? event.model;
      if (typeof m === 'string') this._model = m;
    }
    const usage = event.message?.usage ?? event.usage;
    if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
      this._tokens = { in: usage.input_tokens, out: usage.output_tokens };
    }

    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use') {
          this._parsed = true;
          const key = String(block.id);
          const call: TurnTraceToolCall = {
            n: this.nextOrdinal++,
            name: String(block.name ?? 'unknown'),
            arg: this.claudeArg(block.input),
            ok: true,
          };
          this.toolCallsByKey.set(key, call);
          this.toolCallOrder.push(call);

          if (block.name === 'Bash') {
            this.pushCommand(block.input?.command);
          } else if (CLAUDE_FILE_TOOLS.has(block.name)) {
            this.pushFile(block.input?.file_path);
          }
        }
      }
    } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_result') {
          const call = this.toolCallsByKey.get(String(block.tool_use_id));
          if (call) {
            call.ok = block.is_error !== true;
            if (block.is_error === true) {
              this.errors.push(this.cap(String(block.content), TRACE_CAPS.errorChars));
            }
          }
        }
      }
    }
  }
}

export function turnTracesPath(): string {
  return join(paHome(), 'turn-traces.jsonl');
}

let warned = false;

/**
 * Append one line to ~/.pa/turn-traces.jsonl. Rotates first, redacts every
 * string, and NEVER throws or rejects — a failure logs `warn` once per
 * process and resolves.
 */
export async function appendTurnTrace(trace: TurnTraceV1): Promise<void> {
  try {
    const line = JSON.stringify(redactSecrets(trace as unknown as Record<string, unknown>)) + '\n';
    const path = turnTracesPath();
    await rotateFileIfNeeded(path, Buffer.byteLength(line));
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, 'utf8');
  } catch (error) {
    if (!warned) {
      warned = true;
      logger.warn('turn-trace', 'sidecar write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
