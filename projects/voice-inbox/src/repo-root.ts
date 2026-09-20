import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository root, derived from a module URL that sits ONE level below the
 * package root (src/… during tests, dist/… in production — both are flat under
 * projects/voice-inbox). The repo root is TWO levels above the package:
 * …/<repo>/projects/voice-inbox. AI-236: server.ts previously resolved only ONE
 * level up (<repo>/projects), which doubled the `projects/` segment in every
 * dispatch-template script path handed to workers.
 */
export function repoRootFromModule(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl)); // src | dist
  const pkgRoot = resolve(moduleDir, '..'); // projects/voice-inbox
  return resolve(pkgRoot, '..', '..'); // <repo>
}
