import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../paths.js';
import { logger } from './log.js';

export interface UsageRecord {
  ts: string; // ISO timestamp
  worker: string;
  model?: string;
  resource: string; // skill or resource name
  tokensIn: number;
  tokensOut: number;
  tokensThinking?: number;
  tokensCacheRead?: number;
  estCostUsd?: number;
}

let parseFailures = 0;

/**
 * Append a usage record to the usage ledger (~/.pa/usage.jsonl).
 * Best-effort: logs a warning and continues on failure — never breaks a dispatch.
 */
export async function appendUsage(record: UsageRecord): Promise<void> {
  try {
    const usageDir = join(paHome(), 'logs');
    await mkdir(usageDir, { recursive: true });

    const usagePath = join(usageDir, 'usage.jsonl');
    const line = JSON.stringify(record) + '\n';
    await appendFile(usagePath, line, 'utf8');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn('usage-ledger', 'Failed to append usage record', { error: errMsg });
  }
}

/**
 * Get the count of JSON parse failures (for testing/monitoring).
 */
export function getUsageParseFailures(): number {
  return parseFailures;
}

/**
 * Reset parse failure count (for testing).
 */
export function resetUsageParseFailures(): void {
  parseFailures = 0;
}

/**
 * Extract usage information from a stream event object.
 * Returns undefined if no usage data is found in the event.
 *
 * Supports:
 * - agy (Antigravity CLI; Gemini-model usage events): event.usage or event.result?.usage
 * - claude/zclaude: event.usage or event.message?.usage
 * - codex: event.usage (if available)
 */
export function extractUsageFromEvent(
  event: any,
  workerName: string
): { tokensIn: number; tokensOut: number; tokensThinking?: number; tokensCacheRead?: number } | undefined {
  try {
    // Count null/undefined events as parse failures (defensive: malformed event)
    if (event === null || event === undefined) {
      parseFailures++;
      return undefined;
    }

    // Try various paths where usage might be embedded
    let usage = event?.usage;

    // agy: usage might be nested in result
    if (!usage && event?.result?.usage) {
      usage = event.result.usage;
    }

    // claude/zclaude: usage might be in message
    if (!usage && event?.message?.usage) {
      usage = event.message.usage;
    }

    if (!usage || typeof usage !== 'object') {
      return undefined;
    }

    // Extract token counts (normalize different field names)
    const tokensIn = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.in_tokens ?? 0) || 0;
    const tokensOut = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.out_tokens ?? 0) || 0;
    const tokensThinking = Number(usage.thinking_tokens ?? usage.thought_tokens) || undefined;
    const tokensCacheRead = Number(usage.cache_read_tokens ?? usage.cached_tokens) || undefined;

    if (tokensIn === 0 && tokensOut === 0) {
      return undefined;
    }

    return { tokensIn, tokensOut, tokensThinking, tokensCacheRead };
  } catch {
    parseFailures++;
    return undefined;
  }
}
