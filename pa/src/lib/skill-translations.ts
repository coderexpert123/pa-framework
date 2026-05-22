/**
 * Shared loader for the skill-name list used by:
 *   - Codex worker's `/skill` → `$skill` translation (pa/src/worker-exec.ts)
 *   - Telegram bot's PASS_THROUGH_PATTERN (projects/telegram-bot/src/logic.ts)
 *
 * Both must read from the same source of truth to stay in sync.
 *
 * Source: ~/.pa/codex-skill-translations.json with shape:
 *   { "patterns": ["deep[-_]plan", "deep[-_]recheck", ...] }
 *
 * If the file is missing or malformed, falls back to the embedded default list.
 * Read synchronously at module load with a cached result; restart required
 * after editing the file.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { paHome } from '../paths.js';

const EMBEDDED_DEFAULT = [
  'deep[-_]plan',
  'deep[-_]recheck',
  'update[-_]brain',
  'claude[-_]sync',
  'check[-_]brain',
  'simplify',
  'review',
  'security[-_]review',
];

let cached: string[] | null = null;

export function getSkillTranslationPatterns(): string[] {
  if (cached) return cached;
  try {
    const raw = readFileSync(join(paHome(), 'codex-skill-translations.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed?.patterns) &&
      parsed.patterns.every((p: unknown) => typeof p === 'string')
    ) {
      cached = parsed.patterns;
      return cached!;
    }
  } catch {
    /* fall through to embedded default */
  }
  cached = EMBEDDED_DEFAULT;
  return cached;
}
