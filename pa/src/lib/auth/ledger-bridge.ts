/**
 * The D10 dynamic-import seam into the voice-inbox package's compiled
 * output (auth broker Phase A, 2026-09-10 build spec). Built exactly like
 * `defaultLoadVoiceInboxModules` in
 * `pa/src/lib/maintenance/jobs/voice-inbox-fallback.ts:431-439`: a
 * **dynamic** `import()` on a computed specifier via
 * `pathToFileURL(absPath).href`, cast to a local interface. A literal static
 * `import` of `projects/voice-inbox/dist/*.js` fails to compile — that
 * package ships no `.d.ts` and pa's tsconfig is `strict`.
 *
 * Every pa-side TEST injects this loader; no pa test ever touches the real
 * `projects/voice-inbox/dist`, so CI (which never builds that package) stays
 * green.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type VoiceInboxLedgerModules = {
  ledger: any;
  bridgeWriter: any;
  answerResume: any;
  config: any;
};

export async function loadVoiceInboxModules(repoRoot: string): Promise<VoiceInboxLedgerModules> {
  const distDir = join(repoRoot, 'projects', 'voice-inbox', 'dist');
  const ledgerPath = join(distDir, 'ledger.js');
  if (!existsSync(ledgerPath)) {
    throw new Error('voice-inbox package is not built — run: cd projects/voice-inbox && npm run build');
  }
  const ledger = await import(pathToFileURL(ledgerPath).href);
  const bridgeWriter = await import(pathToFileURL(join(distDir, 'bridge-writer.js')).href);
  const answerResume = await import(pathToFileURL(join(distDir, 'answer-resume.js')).href);
  const config = await import(pathToFileURL(join(distDir, 'config.js')).href);
  return { ledger, bridgeWriter, answerResume, config };
}
