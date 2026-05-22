import { readFile } from 'fs/promises';
import { secretsPath } from './paths.js';

export async function loadSecrets(keys?: string[]): Promise<Record<string, string>> {
  const path = secretsPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return {};
  }

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
