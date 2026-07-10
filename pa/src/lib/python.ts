import { spawnSync } from 'child_process';

/**
 * Resolves the python command to invoke, in priority order:
 *   1. $PYTHON (trimmed, non-empty) — used verbatim, never probed, never cached.
 *   2. Windows — 'python' (the standard launcher on Windows installs).
 *   3. POSIX — probe 'python3' first; falls back to 'python' if the probe
 *      fails. The probe result is memoized module-level (one spawnSync per
 *      process lifetime) since it doesn't change at runtime.
 *
 * `probe` and `platform` are injectable for testing; production call sites
 * omit them and get the real host platform + a real `--version` spawnSync.
 */

export type PythonProbe = (cmd: string) => boolean;

const defaultProbe: PythonProbe = (cmd) => {
  const result = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
};

let cachedPosixCommand: string | null = null;

export function resolvePythonCommand(
  env: NodeJS.ProcessEnv = process.env,
  probe: PythonProbe = defaultProbe,
  platform: NodeJS.Platform = process.platform
): string {
  const envPython = env.PYTHON?.trim();
  if (envPython) return envPython;

  if (platform === 'win32') return 'python';

  if (cachedPosixCommand === null) {
    cachedPosixCommand = probe('python3') ? 'python3' : 'python';
  }
  return cachedPosixCommand;
}

/** Test-only: clears the memoized POSIX probe result. */
export function _resetPythonCacheForTest(): void {
  cachedPosixCommand = null;
}
