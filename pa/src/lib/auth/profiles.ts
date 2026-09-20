/**
 * `~/.pa/auth-profiles.yaml` — provider profiles learned via `pa auth learn`
 * (auth broker Phase A, 2026-09-10 build spec §3.3). Top-level map keyed by
 * provider name.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { paHome } from '../../paths.js';
import { log } from '../log.js';
import { atomicWriteSync } from './store.js';
import type { AuthShape } from './shapes.js';

export function authProfilesPath(): string {
  return join(paHome(), 'auth-profiles.yaml');
}

export interface AuthProfile {
  shape: AuthShape;
  command: string;
  env?: string;
  credential_path?: string;
  expires_days?: number;
  notes?: string;
  learned_at: string;
}

export type AuthProfilesStore = Record<string, AuthProfile>;

/** Fail-to-empty on a missing or unparseable file — one `warn`, never throws. */
export function loadProfiles(): AuthProfilesStore {
  const path = authProfilesPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AuthProfilesStore;
    }
    return {};
  } catch (err) {
    log('warn', 'auth-profiles', 'failed to parse auth-profiles.yaml, treating as empty', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** Supersede-by-key: an existing provider row is replaced WHOLE, never merged. */
export function upsertProfile(name: string, profile: AuthProfile): void {
  const store = loadProfiles();
  store[name] = profile;
  mkdirSync(paHome(), { recursive: true });
  atomicWriteSync(authProfilesPath(), stringify(store));
}
