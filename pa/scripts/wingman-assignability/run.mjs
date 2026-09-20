#!/usr/bin/env node
// Run from pa/: node scripts/wingman-assignability/run.mjs [--bad]
// Maps the jev-browser-wingman/contract bare specifier to the sibling
// checkout's actual contract file at gate time only (§ 3.16, C22) — nothing
// committed or synced ever names the package's location.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wingmanPackageDir } from '../wingman_pkg.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bad = process.argv.includes('--bad');

const pkgDir = wingmanPackageDir();
const srcContract = join(pkgDir, 'src', 'contract', 'types.ts');
const distContract = join(pkgDir, 'dist', 'src', 'contract', 'types.d.ts');
let contractFile;
if (existsSync(srcContract)) contractFile = srcContract;
else if (existsSync(distContract)) contractFile = distContract;
else {
  console.log('ASSIGNABILITY: jev-browser-wingman not found; npm link it or set WINGMAN_PKG_DIR');
  process.exit(3);
}

const baseTsconfig = bad ? 'tsconfig.bad.json' : 'tsconfig.json';
const tmpDir = mkdtempSync(join(tmpdir(), 'wingman-assign-'));
const tmpTsconfig = join(tmpDir, 'tsconfig.json');
writeFileSync(
  tmpTsconfig,
  JSON.stringify({
    extends: join(__dirname, baseTsconfig),
    compilerOptions: { paths: { 'jev-browser-wingman/contract': [resolve(contractFile)] } },
  }),
);

const paRoot = resolve(__dirname, '..', '..');
const tscBin = join(paRoot, 'node_modules', 'typescript', 'bin', 'tsc');

let code = 0;
try {
  execFileSync(process.execPath, [tscBin, '-p', tmpTsconfig], { stdio: 'inherit', windowsHide: true });
} catch (err) {
  code = typeof err.status === 'number' ? err.status : 1;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(code);
