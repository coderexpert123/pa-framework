import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { secretsPath } from './paths.js';

export async function loadSecrets(keys?: string[]): Promise<Record<string, string>> {
  const path = secretsPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }

  const secrets = parseSecretsEnv(raw);

  if (!keys) return secrets;
  const filtered: Record<string, string> = {};
  for (const key of keys) {
    if (secrets[key] !== undefined) {
      filtered[key] = secrets[key];
    } else {
      console.warn(`Warning: secret '${key}' not found in ${path}`);
    }
  }
  return filtered;
}

/** KEY=VALUE lines of a secrets.env body: blank and # lines skipped,
 *  surrounding quotes stripped. The one parser behind loadSecrets and
 *  loadSecretsSync. */
export function parseSecretsEnv(raw: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    secrets[key] = value;
  }
  return secrets;
}

/** Synchronous, unfiltered loadSecrets() for sync callers (the TypeSafe
 *  client's key check). A missing or unreadable file yields {}. */
export function loadSecretsSync(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(secretsPath(), 'utf8');
  } catch {
    return {};
  }
  return parseSecretsEnv(raw);
}
