#!/usr/bin/env node
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');
const repoRoot = join(__dirname, '../..');

// Loader for the compiled @build lock helper. Duplicated verbatim across the
// four .mjs entry points (two run-tests.mjs, two build.mjs) — they are
// separate entry points in two packages with no shared module. Only this
// six-line resolver is duplicated; the acquire/release POLICY lives in
// exactly one place: pa/src/lib/build-lock.ts, compiled to
// pa/dist/src/lib/build-lock.js. createRequire is required (not import()) —
// that module is CommonJS (pa/ has no "type":"module").
const requireCjs = createRequire(import.meta.url);
function loadBuildLock(repoRoot) {
  const p = join(repoRoot, 'pa/dist/src/lib/build-lock.js');
  if (!existsSync(p)) return null;
  try { return requireCjs(p); } catch { return null; }
}
async function withBuildLockOrRun(repoRoot, pkg, fn) {
  const bl = loadBuildLock(repoRoot);
  if (!bl) return await fn();
  return await bl.withBuildLock(bl.buildLockLabel(pkg), fn);
}

// Written INSIDE the @build lock, only on a successful compile (see run()
// below). The mtime is the load-bearing signal (bot self-restart maintenance
// job compares it to the running process's start time); the JSON body is
// diagnostics only. dist/ is gitignored, so the stamp is never committed.
function writeBuildStamp() {
  try {
    let sha = 'unknown';
    try {
      const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'],
        { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && r.stdout.trim()) sha = r.stdout.trim();
    } catch { /* not a git checkout — 'unknown' is fine */ }
    const dist = join(pkgRoot, 'dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, '.build-stamp'),
      JSON.stringify({ builtAt: new Date().toISOString(), sha, pkg: 'pa' }) + '\n', 'utf8');
  } catch (e) {
    console.error('build: could not write .build-stamp:', e?.message ?? e);  // never fail the build
  }
}

async function main() {
  const tsc = join(pkgRoot, 'node_modules/typescript/bin/tsc');
  if (!existsSync(tsc)) {
    console.error('build: typescript not installed — run npm ci');
    process.exit(1);
  }
  const spawnTsc = () =>
    new Promise((res) => {
      const c = spawn(process.execPath, [tsc], {
        stdio: 'inherit',
        cwd: pkgRoot,
        env: process.env,
        windowsHide: true,
      });
      c.on('exit', (code) => res(code ?? 1));
      c.on('error', () => res(1));
    });
  const run = async () => {
    const code = await spawnTsc();
    if (code === 0) writeBuildStamp();
    return code;
  };
  process.exit(await withBuildLockOrRun(repoRoot, 'pa', run));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
