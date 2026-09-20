#!/usr/bin/env node
// § 3.16 — locates the jev-browser-wingman package before npm publish.
// ESM, never compiled. Imports only Node builtins and writes nothing.
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export function defaultNpmRoot() {
  return execSync('npm root -g', { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
}

export function wingmanPackageDir(env = process.env, npmRoot = defaultNpmRoot) {
  if (env.WINGMAN_PKG_DIR) return env.WINGMAN_PKG_DIR;
  return join(npmRoot(), 'jev-browser-wingman');
}

export function wingmanDistDir(env = process.env, npmRoot = defaultNpmRoot) {
  if (env.WINGMAN_DIST_DIR) return env.WINGMAN_DIST_DIR;
  return join(wingmanPackageDir(env, npmRoot), 'dist');
}
