/**
 * Secret redaction for logs and outputs.
 *
 * - Loads literal secret VALUES from secrets.env once per process (lazily, cached)
 * - Only values >= 8 chars are considered, sorted longest-first to prevent substring overlaps
 * - Replaces literal occurrences with <redacted:NAME>
 * - Generic shape patterns for common token forms NOT in secrets.env
 * - Zero false positives on ordinary prose is the bar — when unsure, do not match
 */

import { existsSync } from 'fs';
import { paHome } from '../paths.js';
import { readFileSync } from 'fs';

interface SecretPattern {
  name: string;
  value: string;
  pattern: RegExp;
}

let cachedSecrets: SecretPattern[] | null = null;

/**
 * Generic shape patterns for common token forms NOT in secrets.env.
 * These are conservative patterns that match typical token structures.
 */
const GENERIC_PATTERNS: Array<{name: string, regex: RegExp}> = [
  {
    name: 'token',
    // Stripe-like tokens: sk- followed by 16+ alphanumeric/underscore/hyphen
    regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g
  },
  {
    name: 'token',
    // Slack tokens: xoxb, xoxa, xoxp, xoxs, xoxr followed by token chars
    regex: /\bxox[baprs]-[A-Za-z0-9_-]{10,}\b/g
  },
  {
    name: 'token',
    // Google tokens: AIza followed by 20+ alphanumeric/underscore/hyphen
    regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g
  },
  {
    name: 'token',
    // GitHub tokens: ghp, gho, ghu, ghs, ghr followed by 20+ alphanumeric
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g
  },
  {
    name: 'token',
    // Bearer tokens: "Bearer " followed by 20+ alphanumeric/dot/underscore/hyphen
    regex: /\bBearer [A-Za-z0-9._-]{20,}\b/g
  }
];

/**
 * Load secret patterns from secrets.env once per process.
 * Only values >= 8 chars are considered, sorted longest-first.
 */
function loadSecretPatterns(): SecretPattern[] {
  if (cachedSecrets !== null) {
    return cachedSecrets;
  }

  const secretsPath = `${paHome()}/secrets.env`;
  const patterns: SecretPattern[] = [];

  if (!existsSync(secretsPath)) {
    cachedSecrets = patterns;
    return patterns;
  }

  try {
    const content = readFileSync(secretsPath, 'utf8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines, comments, and lines without '='
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
        continue;
      }

      const eqIndex = trimmed.indexOf('=');
      const name = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      // Only consider values >= 8 chars
      if (value.length >= 8) {
        // Escape special regex characters in the value for safe pattern matching
        const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        patterns.push({
          name,
          value,
          pattern: new RegExp(escapedValue, 'g')
        });
      }
    }

    // Sort by value length descending to prevent substring overlaps
    // (longer values get replaced first)
    patterns.sort((a, b) => b.value.length - a.value.length);

    cachedSecrets = patterns;
    return patterns;
  } catch (err) {
    // If we fail to read secrets.env, log a warning but continue
    console.warn('[redact] Failed to load secrets.env, redaction will be incomplete:', err);
    cachedSecrets = patterns;
    return patterns;
  }
}

/**
 * Redact secrets from a string.
 * Replaces literal secret values with <redacted:NAME>.
 * Also applies generic shape patterns for common token forms.
 * Generic patterns do not overwrite literal secret redactions.
 */
function redactString(text: string): string {
  let result = text;

  // First, redact known literal secrets from secrets.env
  const secrets = loadSecretPatterns();
  for (const secret of secrets) {
    result = result.replace(secret.pattern, `<redacted:${secret.name}>`);
  }

  // Then, apply generic shape patterns, but skip matches that overlap
  // with existing <redacted:...> tags
  for (const generic of GENERIC_PATTERNS) {
    result = result.replace(generic.regex, (match, offset) => {
      // Look backward to see if we're inside a <redacted:...> tag
      const before = result.substring(0, offset);

      // Count open <redacted: tags before this match
      const openTags = (before.match(/<redacted:/g) || []).length;
      // Count closing > tags before this match
      const closeTags = (before.match(/>/g) || []).length;

      // If there are more open tags than close tags, we're inside a redaction
      if (openTags > closeTags) {
        return match; // Skip, already inside a redaction tag
      }

      return `<redacted:${generic.name}>`;
    });
  }

  return result;
}

/**
 * Reset the secret pattern cache.
 * Exported for tests to clear cached secrets between runs.
 */
export function resetRedactCache(): void {
  cachedSecrets = null;
}

/**
 * Recursively redact secrets from an object.
 * Only processes string values in nested objects.
 */
function redactObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return redactString(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactObject(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactObject(value);
    }
    return result;
  }

  // Numbers, booleans, etc. are returned as-is
  return obj;
}

/**
 * Redact secrets from text or objects.
 *
 * - For strings: returns redacted string with <redacted:NAME> placeholders
 * - For objects: recursively redacts string values in nested structures
 * - Other types are returned as-is
 *
 * This function loads literal secret values from secrets.env once per process
 * (lazy-loaded and cached). Only values >= 8 characters are considered, sorted
 * longest-first to prevent substring overlaps.
 *
 * Generic shape patterns are also applied for common token forms that may not
 * be in secrets.env (Stripe, Slack, Google, GitHub, Bearer tokens).
 *
 * @param textOrObject - String or object to redact
 * @returns Redacted string or object (same type as input)
 */
export function redactSecrets(textOrObject: string | Record<string, unknown>): string | Record<string, unknown> {
  if (typeof textOrObject === 'string') {
    return redactString(textOrObject);
  }

  // For objects, recursively process all string values
  return redactObject(textOrObject) as Record<string, unknown>;
}
