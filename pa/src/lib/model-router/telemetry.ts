/**
 * Model-router per-turn telemetry (WP-G, plans/2026-09-18-model-router-SPEC.md §8).
 *
 * One JSONL line per SUCCESSFUL stream-json worker dispatch that runs while a
 * `model_router` block exists in config.yaml: token usage + latency, so shadow
 * disagreement data can be joined with what the dispatch actually cost. The
 * mechanism is PUBLIC (framework), the data is PRIVATE (file lives under PA_HOME,
 * never the tree — placement verdict plans/2026-09-18-model-router-SPEC.md §11).
 *
 * Contract (spec §8.2, decision 16):
 * - Line schema: `{at, worker, model?, durationMs, inputTokens?, outputTokens?}`.
 * - Best-effort try/catch: NEVER throws, never alters the worker exit path,
 *   never blocks the dispatch.
 * - NO TURN TEXT in any field (the no-turn-text probe, spec §14.4).
 */
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../paths.js';

export interface WorkerTelemetryRecord {
  at: string;              // ISO timestamp
  worker: string;
  model?: string;          // from the stream events; absent when the worker never emitted a model line
  durationMs: number;
  inputTokens?: number;    // absent when the stream carried no usage event
  outputTokens?: number;
}

/** Default path: `paHome()/model-router-telemetry.jsonl` (spec §8.2). */
export function telemetryPath(): string {
  return join(paHome(), 'model-router-telemetry.jsonl');
}

/**
 * Append ONE line, fire-and-forget from the worker exit path. Best-effort:
 * every failure mode (mkdir, open, write, serialization) is swallowed — the
 * caller's exit path is load-bearing and this never is.
 */
export async function appendTelemetryRecord(rec: WorkerTelemetryRecord): Promise<void> {
  try {
    await mkdir(paHome(), { recursive: true });
    await appendFile(telemetryPath(), `${JSON.stringify(rec)}\n`, 'utf8');
  } catch {
    // best-effort — telemetry must never surface a failure to the dispatch path
  }
}
