/**
 * `pa chain run <name>` — execute a sequential workflow chain.
 *
 * Chains are defined as YAML files in ~/.pa/chains/ and execute a series of
 * skills sequentially, with retry logic and failure handling.
 *
 * Usage:
 *   pa chain run <name>     Execute the named chain
 *   pa chain list           List available chains
 */

import { readdirSync } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { paHome } from '../paths.js';
import { executeChain, loadChain, ChainValidationError } from '../lib/chains.js';

/**
 * `pa chain run <name>` — execute a chain.
 */
export async function chainRunCommand(args: string[]): Promise<number> {
  const name = args[0];

  if (!name) {
    console.error('Usage: pa chain run <name>');
    return 1;
  }

  try {
    const result = await executeChain(name);
    return result.success ? 0 : 1;
  } catch (err: any) {
    if (err instanceof ChainValidationError) {
      console.error(`Chain validation error: ${err.message}`);
      if (err.field) {
        console.error(`  Field: ${err.field}`);
      }
      console.error(`  File: ${err.path}`);
      return 1;
    }

    console.error(`Chain execution error: ${err?.message ?? String(err)}`);
    return 1;
  }
}

/**
 * `pa chain list` — list available chains.
 */
export async function chainListCommand(): Promise<number> {
  const chainsDir = join(paHome(), 'chains');

  if (!existsSync(chainsDir)) {
    console.log('No chains directory found at', chainsDir);
    return 0;
  }

  const entries = readdirSync(chainsDir);
  const chains = entries
    .filter(e => e.endsWith('.yaml'))
    .map(e => e.slice(0, -5)); // Remove .yaml extension

  if (chains.length === 0) {
    console.log('No chains found.');
    return 0;
  }

  console.log('Available chains:');
  for (const chain of chains.sort()) {
    console.log(`  ${chain}`);
  }

  return 0;
}
