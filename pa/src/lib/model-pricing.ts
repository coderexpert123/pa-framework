// List prices verified 2026-08-27 — platform.claude.com/docs (pricing),
// ai.google.dev/gemini-api/docs/pricing, docs.z.ai/guides/overview/pricing.
// gemini-3.8 verified 2026-09-04 — rates identical to 3.7 through 2026-12-31.
// ESTIMATES ONLY (subscription CLIs are rated at list API prices); override per
// deployment via config.yaml `model_pricing:` (merged key-by-key over these).

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
}

export type ModelPricingTable = Record<string, ModelPrice>;

export const DEFAULT_MODEL_PRICING: ModelPricingTable = {
  // worker-level fallbacks (usage records often carry no model — 100% of this
  // deployment's ledger as of 2026-08-27)
  'agy':                    { input: 0.75, output: 3.75, cacheRead: 0.075 },  // = gemini-3.8-flash pin
  'zclaude':                { input: 1.40, output: 4.40, cacheRead: 0.26 },   // = glm-5.3
  // model keys — Anthropic (thinking billed at output rate)
  'claude-opus-4-6':        { input: 5,    output: 25,   cacheRead: 0.50 },
  'claude-sonnet-4-6':      { input: 3,    output: 15,   cacheRead: 0.30 },
  'claude-sonnet-5':        { input: 2,    output: 10,   cacheRead: 0.20 },
  'claude-haiku-4-5':       { input: 1,    output: 5,    cacheRead: 0.10 },
  // model keys — Google Gemini
  'gemini-3.8-flash':       { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.7-flash':       { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.6-flash':       { input: 0.75, output: 3.75, cacheRead: 0.075 },
  'gemini-3.5-flash':       { input: 1.50, output: 9.00, cacheRead: 0.15 },
  'gemini-3.5-flash-lite':  { input: 0.30, output: 2.50, cacheRead: 0.03 },
  'gemini-2.5-flash':       { input: 0.30, output: 2.50, cacheRead: 0.03 },
  'gemini-2.5-flash-lite':  { input: 0.10, output: 0.40, cacheRead: 0.01 },
  // model keys — Zhipu GLM (z.ai)
  'glm-5.3':                { input: 1.40, output: 4.40, cacheRead: 0.26 },
  'glm-5.2':                { input: 1.40, output: 4.40, cacheRead: 0.26 },
  'glm-5.1':                { input: 1.40, output: 4.40, cacheRead: 0.26 },
  'glm-5':                  { input: 1.00, output: 3.20, cacheRead: 0.20 },
  'glm-4.7':                { input: 0.60, output: 2.20, cacheRead: 0.11 },
};

/**
 * Validate and parse model pricing from config.
 * Invalid entries are logged and skipped; empty result → {}.
 */
export function parseModelPricing(raw: unknown): ModelPricingTable {
  const result: ModelPricingTable = {};

  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return result;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') {
      console.warn(`[model-pricing] key ${key}: value is not an object; ignoring that entry`);
      continue;
    }

    const price = value as Record<string, unknown>;

    const input = price.input;
    const output = price.output;
    const cacheRead = (price as any).cache_read; // YAML uses snake_case

    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) {
      console.warn(`[model-pricing] key ${key}: input must be a finite number >= 0; ignoring that entry`);
      continue;
    }

    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      console.warn(`[model-pricing] key ${key}: output must be a finite number >= 0; ignoring that entry`);
      continue;
    }

    const entry: ModelPrice = { input, output };

    if (cacheRead !== undefined) {
      if (typeof cacheRead !== 'number' || !Number.isFinite(cacheRead) || cacheRead < 0) {
        console.warn(`[model-pricing] key ${key}: cache_read must be a finite number >= 0 or omitted; ignoring that entry`);
        continue;
      }
      entry.cacheRead = cacheRead;
    }

    result[key] = entry;
  }

  return result;
}

/**
 * Load model pricing from config.yaml, merging with built-in defaults.
 * Returns defaults on any read/parse failure.
 */
export async function loadModelPricing(): Promise<ModelPricingTable> {
  const { readFile } = await import('fs/promises');
  const { join } = await import('path');
  const { paHome } = await import('../paths.js');

  try {
    const configPath = join(paHome(), 'config.yaml');
    const content = await readFile(configPath, 'utf8');

    // Parse YAML - we need a simple parser for this since we don't want to add a dependency
    // Just parse the model_pricing section as a simple key-value structure
    const yaml = await import('yaml');
    const parsed = yaml.parse(content);

    if (parsed && typeof parsed === 'object' && parsed.model_pricing) {
      const override = parseModelPricing(parsed.model_pricing);
      return { ...DEFAULT_MODEL_PRICING, ...override };
    }

    return { ...DEFAULT_MODEL_PRICING };
  } catch {
    // Any error (file not found, parse error, etc.) → fall back to defaults
    return { ...DEFAULT_MODEL_PRICING };
  }
}

/**
 * Determine the pricing key for a record.
 * Uses trimmed model if present and non-empty, otherwise uses worker name.
 */
export function priceKeyFor(worker: string, model?: string): string {
  if (model && model.trim().length > 0) {
    return model.trim();
  }
  return worker;
}

/**
 * Estimate the cost in USD for a single usage record.
 * Returns null if the pricing key is not found in the table.
 *
 * Cost formula: (in*input + (out+thinking)*output + cacheRead*cache_read) / 1e6
 * (thinking tokens are billed at the output rate)
 */
export function estimateRecordCostUsd(
  record: {
    worker: string;
    model?: string;
    tokensIn: number;
    tokensOut: number;
    tokensThinking?: number;
    tokensCacheRead?: number;
  },
  table: ModelPricingTable
): number | null {
  const key = priceKeyFor(record.worker, record.model);
  const price = table[key];

  if (!price) {
    return null;
  }

  const cacheReadRate = price.cacheRead ?? 0;
  const thinkingTokens = record.tokensThinking ?? 0;
  const cacheTokens = record.tokensCacheRead ?? 0;

  const costUsd =
    (record.tokensIn * price.input +
      (record.tokensOut + thinkingTokens) * price.output +
      cacheTokens * cacheReadRate) / 1_000_000;

  // Round to 6 decimal places
  return Math.round(costUsd * 1_000_000) / 1_000_000;
}
