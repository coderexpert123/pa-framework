/**
 * Registry Content Rules Loader
 *
 * Loads declarative topic-description content rules from ~/.pa/registry-content-rules.json.
 * Rules are evaluated by registry-content-watch to enforce invariants (e.g., required
 * phrases, forbidden hallucinations).
 *
 * Rule format:
 *   {
 *     topic_key: string,
 *     thread_id: number,
 *     require_contains?: string,   // description must contain this phrase
 *     forbid_contains?: string,    // description must NOT contain this phrase
 *     label: string                // human-readable invariant name
 *   }
 *
 * The file is $PA_HOME-aware and fails to empty if missing/corrupt (warns once).
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { warnOnce } from './lib/warn-once.js';

/**
 * Rule shape: declarative predicates over topic descriptions.
 */
export interface RegistryContentRule {
  topic_key: string;
  thread_id: number;
  require_contains?: string;
  forbid_contains?: string;
  label: string;
}

/**
 * Load registry content rules from ~/.pa/registry-content-rules.json.
 *
 * Respects $PA_HOME if set (falls back to ~/.pa). Returns empty array if
 * the file is missing or corrupt (warns once).
 */
export function loadRegistryContentRules(): RegistryContentRule[] {
  const paHome = process.env.PA_HOME || join(process.env.HOME || '', '.pa');
  const rulesPath = join(paHome, 'registry-content-rules.json');

  if (!existsSync(rulesPath)) {
    warnOnce('maintenance-jobs', `Registry content rules file not found: ${rulesPath} — using empty rules (no invariants enforced)`);
    return [];
  }

  try {
    const content = readFileSync(rulesPath, 'utf-8');
    const rules = JSON.parse(content) as RegistryContentRule[];

    // Basic shape validation
    for (const rule of rules) {
      if (typeof rule.topic_key !== 'string' || typeof rule.thread_id !== 'number' || typeof rule.label !== 'string') {
        warnOnce('maintenance-jobs', `Invalid rule shape in ${rulesPath} — skipping`);
        continue;
      }
      if (rule.require_contains === undefined && rule.forbid_contains === undefined) {
        warnOnce('maintenance-jobs', `Rule ${rule.topic_key}/${rule.thread_id} has no predicate — skipping`);
        continue;
      }
    }

    return rules;
  } catch (err) {
    warnOnce('maintenance-jobs', `Failed to parse ${rulesPath}: ${err} — using empty rules`);
    return [];
  }
}
