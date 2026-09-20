// Model metadata (static, in-repo; spec plans/2026-09-18-model-router-SPEC.md
// §0.1.8, decision 15). Hand-curated from the live fleet config (~/.pa/config.yaml
// as of 2026-09-18); reviewed at every model change. Cost is a TIEBREAK/warning
// input, never a dollar optimizer — rank order (policy table) decides.

import type { CapabilityTier, EffortScore, ModelRouterPolicyRow } from '../../types.js';

export type CostBasis =
  | { kind: 'per-token'; inputPerM: number; outputPerM: number }
  | { kind: 'flat'; basis: 'subscription' | 'quota' };

export type Strength = 'deep-reasoning' | 'quick-lookup' | 'agentic-long-horizon';

export interface ModelMeta {
  model: string;
  worker: string;
  cost: CostBasis;
  strengths: Strength[];
  latency: 'fast' | 'medium' | 'slow';
  quotaBurn: 'light' | 'heavy';
}

function flat(model: string, worker: string, basis: 'subscription' | 'quota', strengths: Strength[], latency: 'fast' | 'medium' | 'slow', quotaBurn: 'light' | 'heavy'): ModelMeta {
  return { model, worker, cost: { kind: 'flat', basis }, strengths, latency, quotaBurn };
}

/**
 * COST PROVENANCE (2026-09-18): every worker this fleet runs bills a flat
 * subscription or a quota allowance, NOT metered per-token — z.ai quota
 * (zclaude/kgclaude, 2x credits inside the peak window), Antigravity quota
 * (agy/agyc), ChatGPT/Claude/ChatGPT-Codex plans (codex/claude), Devin
 * credits. Devin's docs (docs.devin.ai, checked 2026-09-18) price usage in
 * ACUs only; the CLI models page publishes NO per-token rates for
 * deepseek-v4-1-flash-max, so the spec's "per-token transcription" has no
 * published source — devin is represented flat/subscription with this
 * dated note instead of fabricated per-M numbers. Revisit if Devin ever
 * publishes token rates.
 */
export const MODEL_METADATA: Record<string, ModelMeta> = {
  // zclaude — z.ai quota (GLM)
  'zclaude:glm-5.3': flat('glm-5.3', 'zclaude', 'quota', ['deep-reasoning', 'agentic-long-horizon'], 'medium', 'heavy'),
  'zclaude:glm-5.3[1m]': flat('glm-5.3[1m]', 'zclaude', 'quota', ['deep-reasoning', 'agentic-long-horizon'], 'medium', 'heavy'),
  'zclaude:glm-4.7': flat('glm-4.7', 'zclaude', 'quota', ['agentic-long-horizon'], 'medium', 'light'),
  'zclaude:glm-5-turbo': flat('glm-5-turbo', 'zclaude', 'quota', ['quick-lookup'], 'fast', 'light'),
  // agy — Antigravity quota (Gemini; effort encoded in the model row)
  'agy:gemini-3.8-flash-high': flat('gemini-3.8-flash-high', 'agy', 'quota', ['deep-reasoning'], 'medium', 'heavy'),
  'agy:gemini-3.8-flash-medium': flat('gemini-3.8-flash-medium', 'agy', 'quota', ['agentic-long-horizon'], 'medium', 'light'),
  'agy:gemini-3.8-flash-low': flat('gemini-3.8-flash-low', 'agy', 'quota', ['quick-lookup'], 'fast', 'light'),
  'agy:gemini-3.7-flash-high': flat('gemini-3.7-flash-high', 'agy', 'quota', ['deep-reasoning'], 'medium', 'heavy'),
  'agy:gemini-3.7-flash-medium': flat('gemini-3.7-flash-medium', 'agy', 'quota', ['agentic-long-horizon'], 'medium', 'light'),
  'agy:gemini-3.7-flash-low': flat('gemini-3.7-flash-low', 'agy', 'quota', ['quick-lookup'], 'fast', 'light'),
  // agyc — Antigravity quota (manual-only)
  'agyc:claude-sonnet-4-6': flat('claude-sonnet-4-6', 'agyc', 'quota', ['agentic-long-horizon'], 'medium', 'light'),
  'agyc:claude-opus-4-6-thinking': flat('claude-opus-4-6-thinking', 'agyc', 'quota', ['deep-reasoning'], 'slow', 'heavy'),
  'agyc:gpt-oss-120b-medium': flat('gpt-oss-120b-medium', 'agyc', 'quota', ['quick-lookup'], 'fast', 'light'),
  // codex — ChatGPT plan; effort tunable (minimal/low/medium/high)
  'codex:gpt-5.4': flat('gpt-5.4', 'codex', 'subscription', ['deep-reasoning', 'agentic-long-horizon'], 'medium', 'heavy'),
  // claude — Claude plan
  'claude:opus': flat('opus', 'claude', 'subscription', ['deep-reasoning', 'agentic-long-horizon'], 'slow', 'heavy'),
  'claude:sonnet': flat('sonnet', 'claude', 'subscription', ['agentic-long-horizon'], 'medium', 'light'),
  'claude:fable': flat('fable', 'claude', 'subscription', ['deep-reasoning'], 'slow', 'heavy'),
  // devin — see COST PROVENANCE note above
  'devin:deepseek-v4-1-flash-max': flat('deepseek-v4-1-flash-max', 'devin', 'subscription', ['agentic-long-horizon'], 'medium', 'light'),
  // kgclaude — Kaggle TPU quota (manual-only)
  'kgclaude:glm-5.3-flash': flat('glm-5.3-flash', 'kgclaude', 'quota', ['quick-lookup', 'agentic-long-horizon'], 'fast', 'light'),
};

/**
 * Warn strings for a policy table against the metadata above. Never throws.
 * (a) row model absent from MODEL_METADATA; (b) max_tier >= deep_reasoning
 * but the model lacks the 'deep-reasoning' strength; (c) max_score >= 4 but
 * quotaBurn is heavy OR latency is slow.
 */
export function validateTable(rows: ModelRouterPolicyRow[]): string[] {
  const warns: string[] = [];
  for (const row of rows) {
    const label = `${row.worker}:${row.model ?? '<default>'}`;
    if (!row.model) {
      warns.push(`model-router: row ${label} omits 'model'; metadata checks skipped for it`);
      continue;
    }
    const meta = MODEL_METADATA[label];
    if (!meta) {
      warns.push(`model-router: row ${label} has no MODEL_METADATA entry`);
      continue;
    }
    if ((['deep_reasoning', 'rich_toolchain'] as CapabilityTier[]).includes(row.max_tier) && !meta.strengths.includes('deep-reasoning')) {
      warns.push(`model-router: row ${label} claims max_tier ${row.max_tier} but metadata lacks the 'deep-reasoning' strength`);
    }
    if (row.max_score >= 4 && (meta.quotaBurn === 'heavy' || meta.latency === 'slow')) {
      warns.push(`model-router: row ${label} claims max_score ${row.max_score} but quotaBurn=${meta.quotaBurn}/latency=${meta.latency}`);
    }
  }
  return warns;
}
