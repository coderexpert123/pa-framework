#!/usr/bin/env node
// WP-R — staged-registration (cutover) tooling. PREPARED, not executed: this
// script stages and verifies the per-CLI move of the Playwright registration
// onto the shared Chrome (spec 2026-09-19-jev-browser-wingman-SPEC, § WP-R,
// § 3.12, § 3.13, § 3.16). Every subcommand prints ONE JSON object on stdout.
//
// Usage:
//   node pa/scripts/wingman_cutover.mjs preflight|snapshot|print-apply|apply|verify|rollback
//        --client <claude|codex|opencode|agy|devin>
//   apply and rollback also require --snapshot <id> and --approved "<note>".
//   verify also accepts --expect wrapped|original (default wrapped) and
//   --mcp-report <file>.
//
// Exit codes: 0 PASS or done, 1 a gate FAILed, 2 usage, 3 refused.
//
// Package code is loaded with dynamic import() from wingmanDistDir() of
// ./wingman_pkg.mjs (§ 3.16), never a literal path. A missing package prints
// the § 3.16 JSON line and exits 3. All external commands are injectable via
// the exported functions' deps (exec, fs, listChrome, connect, runDoctor,
// now, ensureChrome) — the test suite injects every one of them.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wingmanDistDir } from './wingman_pkg.mjs';

const CUTOVER_CLIENTS = ['claude', 'codex', 'opencode', 'agy', 'devin'];
const DIST_FILES = [
  'src/cli/registrations.js',
  'src/browser/chrome.js',
  'src/browser/process-list.js',
  'src/adapters/cdp-connection.js',
  'src/core/config.js',
  'src/contract/home.js',
];

class CutoverRefusal extends Error {
  constructor(message) {
    super(message);
    this.refusal = true;
  }
}

// ---------------------------------------------------------------------------
// Package loading (§ 3.16)
// ---------------------------------------------------------------------------

let pkgCache = null;
async function loadPkg() {
  if (pkgCache) return pkgCache;
  const dist = wingmanDistDir();
  if (!existsSync(join(dist, DIST_FILES[0]))) {
    throw new CutoverRefusal('jev-browser-wingman not found; npm link it or set WINGMAN_DIST_DIR');
  }
  const mods = {};
  for (const rel of DIST_FILES) {
    if (!existsSync(join(dist, rel))) {
      throw new CutoverRefusal('jev-browser-wingman not found; npm link it or set WINGMAN_DIST_DIR');
    }
  }
  mods.registrations = await import(pathToFileURL(join(dist, 'src/cli/registrations.js')).href);
  mods.chrome = await import(pathToFileURL(join(dist, 'src/browser/chrome.js')).href);
  mods.processList = await import(pathToFileURL(join(dist, 'src/browser/process-list.js')).href);
  mods.cdp = await import(pathToFileURL(join(dist, 'src/adapters/cdp-connection.js')).href);
  mods.config = await import(pathToFileURL(join(dist, 'src/core/config.js')).href);
  mods.home = await import(pathToFileURL(join(dist, 'src/contract/home.js')).href);
  pkgCache = mods;
  return mods;
}

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

function defaultExec(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120_000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : err.code === 'ENOENT' ? 127 : 1;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), enoent: !!err && err.code === 'ENOENT' });
    });
  });
}

const defaultFs = {
  exists: (p) => existsSync(p),
  read: (p) => fsp.readFile(p, 'utf8'),
  readBytes: (p) => fsp.readFile(p),
  mkdir: (p) => fsp.mkdir(p, { recursive: true }),
  write: (p, data) => fsp.writeFile(p, data),
  writeAtomic: async (p, data) => {
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p);
  },
};

async function resolveDeps(deps = {}) {
  const pkg = await loadPkg();
  const d = {
    exec: deps.exec ?? defaultExec,
    fs: { ...defaultFs, ...(deps.fs ?? {}) },
    listChrome: deps.listChrome ?? pkg.processList.listChromeProcesses,
    connect:
      deps.connect ??
      ((endpoint) => pkg.cdp.CdpConnection.connect(endpoint)),
    ensureChrome: deps.ensureChrome ?? pkg.chrome.ensureChrome,
    runDoctor:
      deps.runDoctor ??
      (async (client) => {
        const r = await (deps.exec ?? defaultExec)('jev-browser-wingman', [
          'doctor',
          '--json',
          '--client',
          client,
        ]);
        if (r.enoent || r.code === 127) return { error: 'wingman-not-installed' };
        const lines = r.stdout.trim().split('\n').filter((l) => l.trim() !== '');
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            return JSON.parse(lines[i]);
          } catch {
            continue;
          }
        }
        return { error: `doctor output not JSON: ${(r.stderr || r.stdout).trim()}` };
      }),
    now: deps.now ?? (() => new Date().toISOString()),
  };
  return { pkg, deps: d };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function stampZ(iso) {
  return `${iso.slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function normProfile(p, platform = process.platform) {
  let out = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32' || platform === 'darwin') out = out.toLowerCase();
  return out;
}

function userDataDirOf(entry) {
  const args = entry?.args ?? [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-data-dir') return args[i + 1] ?? null;
    if (args[i].startsWith('--user-data-dir=')) return args[i].slice('--user-data-dir='.length) || null;
  }
  const envVal = entry?.env?.PLAYWRIGHT_MCP_USER_DATA_DIR;
  return envVal ? envVal : null;
}

function isWrapped(entry) {
  return entry?.command === 'jev-browser-wingman';
}

function eqStrArr(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A client may normalize other keys when it writes an entry, so `env`
 *  compares only when the expected env is non-empty (§ WP-R item 5, V1). */
function envMatches(liveEnv, wantEnv) {
  const wantKeys = Object.keys(wantEnv ?? {});
  if (wantKeys.length === 0) return true;
  return JSON.stringify(liveEnv ?? {}) === JSON.stringify(wantEnv);
}

/** V1 "matches" sense: command, args (for opencode, the command array),
 *  non-empty env; codex's startup_timeout_sec / tool_timeout_sec are checked
 *  against the file text by the caller, because the TOML reader drops them. */
function matchesEntry(live, wantRaw, client) {
  if (!live) return false;
  if (client === 'opencode') {
    const liveArr = Array.isArray(live.raw?.command) ? live.raw.command : [live.command, ...(live.args ?? [])];
    const wantArr = Array.isArray(wantRaw?.command) ? wantRaw.command : [wantRaw?.command, ...(wantRaw?.args ?? [])];
    return eqStrArr(liveArr, wantArr) && envMatches(live.env, wantRaw?.environment ?? wantRaw?.env);
  }
  if ((live.command ?? '') !== (wantRaw?.command ?? '')) return false;
  if (!eqStrArr(live.args ?? [], wantRaw?.args ?? [])) return false;
  return envMatches(live.env, wantRaw?.env);
}

/** The wrapped value for a client's raw entry value (§ 3.12). opencode's
 *  array form [C, ...A] becomes ["jev-browser-wingman", "with-chrome", "--", C, ...A']. */
function wrapRaw(pkg, client, raw) {
  if (client === 'opencode' && Array.isArray(raw?.command)) {
    return { ...raw, command: pkg.registrations.wrapPlaywrightEntry(raw.command, client) };
  }
  return pkg.registrations.wrapPlaywrightEntry(raw, client);
}

async function loadConfigOrThrow(pkg) {
  const r = await pkg.config.loadConfig(process.env);
  if (!r.ok) throw new CutoverRefusal(`config: ${r.error}`);
  return r.config;
}

async function readSnapshot(fs, home, snapshotId) {
  const dir = join(home, 'cutover', snapshotId);
  if (!fs.exists(dir)) throw new CutoverRefusal(`snapshot not found: ${snapshotId}`);
  const entry = JSON.parse(await fs.read(join(dir, 'entry.json')));
  const wingmanRaw = await fs.read(join(dir, 'wingman-entry.json'));
  const wingman = JSON.parse(wingmanRaw); // null when absent
  let baseline = { count: 0, pairs_sha256: null };
  const baselinePath = join(dir, 'cookies-baseline.json');
  if (fs.exists(baselinePath)) baseline = JSON.parse(await fs.read(baselinePath));
  return { dir, entry, wingman, baseline };
}

function playwrightEntryOf(reg) {
  if (reg.error || !reg.exists) return null;
  return reg.entries.find((e) => e.server === 'playwright') ?? null;
}

function wingmanEntryOf(reg) {
  if (reg.error || !reg.exists) return null;
  return reg.entries.find((e) => e.server === 'jev-browser-wingman') ?? null;
}

// ---------------------------------------------------------------------------
// JSONC comment detection (apply refuses commented files; a rewrite would
// drop the comments, § WP-R item 4).
// ---------------------------------------------------------------------------

export function hasJsonComments(text) {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') return true;
    if (ch === '/' && text[i + 1] === '*') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Codex TOML text edits (§ WP-R item 4: only the playwright table changes)
// ---------------------------------------------------------------------------

function tomlBasic(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlStringArray(arr) {
  return `args = [${arr.map(tomlBasic).join(', ')}]`;
}

function tableSpan(lines, header) {
  const exact = new RegExp(`^\\[${header.replace(/\./g, '\\.')}]\\s*$`);
  const start = lines.findIndex((l) => exact.test(l.trim()));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** Scalar keys of a TOML table, read straight from the text (the package's
 *  TOML reader drops keys it does not know, so V1 needs this for codex). */
export function tomlTableScalars(text, header) {
  const lines = text.split(/\r?\n/);
  const span = tableSpan(lines, header);
  if (!span) return null;
  const out = {};
  for (let i = span.start + 1; i < span.end; i++) {
    const kv = /^([^=]+?)\s*=\s*(.+)$/.exec(lines[i].trim());
    if (!kv) continue;
    const key = kv[1].trim().replace(/^"|"$/g, '');
    const v = kv[2].trim();
    if (/^-?\d+(\.\d+)?$/.test(v)) out[key] = Number(v);
    else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) out[key] = v.slice(1, -1);
    else if (v === 'true') out[key] = true;
    else if (v === 'false') out[key] = false;
  }
  return out;
}

function withEol(text, lines) {
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n');
}

const WINGMAN_TABLE = [
  '[mcp_servers.jev-browser-wingman]',
  'command = "jev-browser-wingman"',
  'args = ["mcp"]',
  'tool_timeout_sec = 90',
].join('\n');

async function applyCodex(fs, file, entry, wrappedArgs, addWingman) {
  const text = await fs.read(file);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const span = tableSpan(lines, 'mcp_servers.playwright');
  if (!span) return 'CUTOVER-REFUSED: no [mcp_servers.playwright] table; edit by hand';
  for (let i = span.start + 1; i < span.end; i++) {
    if (/^\s*args\s*=/.test(lines[i]) && !lines[i].includes(']')) {
      return 'CUTOVER-REFUSED: multi-line args; edit by hand';
    }
  }
  const commandLine = 'command = "jev-browser-wingman"';
  const argsLine = tomlStringArray(wrappedArgs);
  let sawArgs = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > span.start && i < span.end) {
      if (/^\s*command\s*=/.test(lines[i])) {
        out.push(commandLine);
        continue;
      }
      if (/^\s*args\s*=/.test(lines[i])) {
        out.push(argsLine);
        out.push('startup_timeout_sec = 60');
        sawArgs = true;
        continue;
      }
      if (/^\s*startup_timeout_sec\s*=/.test(lines[i])) continue; // replaced by the line after args
    }
    out.push(lines[i]);
  }
  if (!sawArgs) {
    // No args line existed: add args + startup_timeout_sec after command.
    const cmdIdx = out.findIndex((l, idx) => idx > span.start && /^\s*command\s*=/.test(l));
    if (cmdIdx === -1) return 'CUTOVER-REFUSED: no command line in [mcp_servers.playwright]; edit by hand';
    out.splice(cmdIdx + 1, 0, argsLine, 'startup_timeout_sec = 60');
  }
  let result = withEol(text, out);
  if (addWingman && !tableSpan(result.split(/\r?\n/), 'mcp_servers.jev-browser-wingman')) {
    result = result.replace(/\r?\n+$/, '') + eol + eol + WINGMAN_TABLE.split('\n').join(eol) + eol;
  }
  await fs.writeAtomic(file, result);
  return null;
}

async function rollbackCodex(fs, file, entry, removeWingman) {
  const text = await fs.read(file);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const span = tableSpan(lines, 'mcp_servers.playwright');
  if (!span) return 'CUTOVER-REFUSED: no [mcp_servers.playwright] table; edit by hand';
  const commandLine = `command = ${tomlBasic(entry.command)}`;
  const argsLine = `args = [${(entry.args ?? []).map(tomlBasic).join(', ')}]`;
  let sawArgs = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > span.start && i < span.end) {
      if (/^\s*command\s*=/.test(lines[i])) {
        out.push(commandLine);
        continue;
      }
      if (/^\s*args\s*=/.test(lines[i])) {
        out.push(argsLine);
        sawArgs = true;
        continue;
      }
      if (/^\s*startup_timeout_sec\s*=/.test(lines[i])) continue; // the snapshot state had none (V1-original expects it absent)
    }
    out.push(lines[i]);
  }
  if (!sawArgs) {
    const cmdIdx = out.findIndex((l, idx) => idx > span.start && /^\s*command\s*=/.test(l));
    if (cmdIdx !== -1) out.splice(cmdIdx + 1, 0, argsLine);
  }
  let result = withEol(text, out);
  if (removeWingman) {
    const rlines = result.split(/\r?\n/);
    const wspan = tableSpan(rlines, 'mcp_servers.jev-browser-wingman');
    if (wspan) rlines.splice(wspan.start, wspan.end - wspan.start);
    result = rlines.join(eol).replace(/\r?\n+$/, '') + eol;
  }
  await fs.writeAtomic(file, result);
  return null;
}

// ---------------------------------------------------------------------------
// JSON clients (claude / opencode / agy / devin): parse, set, write atomically
// ---------------------------------------------------------------------------

async function applyJson(fs, file, client, wrapped, wing) {
  const text = await fs.read(file);
  if (hasJsonComments(text)) return `CUTOVER-REFUSED: ${file} has comments; edit by hand`;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return `CUTOVER-REFUSED: cannot parse ${file}: ${e.message}`;
  }
  const key = client === 'opencode' ? 'mcp' : 'mcpServers';
  if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) obj[key] = {};
  obj[key].playwright = wrapped;
  if (wing !== undefined) obj[key]['jev-browser-wingman'] = wing;
  await fs.writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
  return null;
}

async function rollbackJson(fs, file, client, entryRaw, wing) {
  const text = await fs.read(file);
  if (hasJsonComments(text)) return `CUTOVER-REFUSED: ${file} has comments; edit by hand`;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return `CUTOVER-REFUSED: cannot parse ${file}: ${e.message}`;
  }
  const key = client === 'opencode' ? 'mcp' : 'mcpServers';
  if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) obj[key] = {};
  obj[key].playwright = entryRaw;
  if (wing === null) delete obj[key]['jev-browser-wingman'];
  else if (wing !== undefined) obj[key]['jev-browser-wingman'] = wing;
  await fs.writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
  return null;
}

// ---------------------------------------------------------------------------
// Exported stages
// ---------------------------------------------------------------------------

/** preflight --client <c> → { verdict, gates: [{id, status, detail}] } */
export async function preflight(client, deps = {}) {
  const { pkg, deps: d } = await resolveDeps(deps);
  const gates = [];
  let cfg = null;
  try {
    cfg = await loadConfigOrThrow(pkg);
  } catch (e) {
    gates.push({ id: 'G2 profile-same', status: 'FAIL', detail: e.message });
    return { verdict: 'FAIL', gates };
  }
  const profile = cfg.profile_dir;
  const reg = await pkg.registrations.readRegistrations(client);
  const entry = playwrightEntryOf(reg);

  if (entry && isWrapped(entry)) {
    return {
      refused: 'already-wrapped',
      verdict: 'FAIL',
      gates: [{ id: 'G1 entry-present', status: 'FAIL', detail: 'the playwright entry is already wrapped' }],
    };
  }
  gates.push({
    id: 'G1 entry-present',
    status: entry ? 'PASS' : 'FAIL',
    detail: entry ? `command ${entry.command}` : (reg.error ?? 'no playwright entry'),
  });

  // G2 profile-same
  if (!entry) {
    gates.push({ id: 'G2 profile-same', status: 'FAIL', detail: 'no playwright entry' });
  } else {
    const raw = userDataDirOf(entry);
    if (!raw) {
      gates.push({
        id: 'G2 profile-same',
        status: 'FAIL',
        detail: 'no --user-data-dir argument or PLAYWRIGHT_MCP_USER_DATA_DIR env in the playwright entry',
      });
    } else {
      const expanded = pkg.home.expandHome(raw);
      const same = normProfile(expanded) === normProfile(profile);
      gates.push({
        id: 'G2 profile-same',
        status: same ? 'PASS' : 'FAIL',
        detail: same ? profile : `entry profile ${expanded} != config profile_dir ${profile}`,
      });
    }
  }

  // G3 profile-not-default
  const defaultDir = pkg.chrome.isDefaultUserDataDir(profile);
  gates.push({
    id: 'G3 profile-not-default',
    status: defaultDir ? 'FAIL' : 'PASS',
    detail: defaultDir ? 'profile_dir is Chrome\'s default user-data dir; Chrome 136+ ignores the debug port there' : profile,
  });

  // G4 no-foreign-holder
  const holders = await pkg.chrome.profileHolders(profile, { listChromeProcesses: d.listChrome });
  gates.push({
    id: 'G4 no-foreign-holder',
    status: holders.withoutPort.length === 0 ? 'PASS' : 'FAIL',
    detail:
      holders.withoutPort.length === 0
        ? 'no Chrome holds the profile without a debug port'
        : `pids ${holders.withoutPort.join(', ')} hold the profile without a debug port; close that browser; this tool never kills it`,
  });

  // G5 endpoint-profile
  if (!gates.slice(0, 4).every((g) => g.status === 'PASS')) {
    gates.push({ id: 'G5 endpoint-profile', status: 'SKIP', detail: 'earlier gate FAILed' });
  } else {
    const procs = await d.listChrome();
    const owner = procs.find((p) => pkg.chrome.debugPortOf(p.cmdline) === cfg.port);
    if (!owner) {
      gates.push({ id: 'G5 endpoint-profile', status: 'PASS', detail: `port ${cfg.port} not answering` });
    } else if (pkg.chrome.profileMarkerMatches(owner.cmdline, profile)) {
      gates.push({ id: 'G5 endpoint-profile', status: 'PASS', detail: `pid ${owner.pid} on port ${cfg.port} carries the profile` });
    } else {
      gates.push({
        id: 'G5 endpoint-profile',
        status: 'FAIL',
        detail: `pid ${owner.pid} answers on port ${cfg.port} but its cmdline does not carry the profile`,
      });
    }
  }

  return { verdict: gates.every((g) => g.status === 'PASS') ? 'PASS' : 'FAIL', gates };
}

/** snapshot --client <c>: preflight, ensureChrome, cookie baseline, snapshot dir. */
export async function snapshot(client, deps = {}) {
  const { pkg, deps: d } = await resolveDeps(deps);
  const pre = await preflight(client, d);
  if (pre.refused) return pre;
  if (pre.verdict !== 'PASS') return { error: 'preflight FAILed', ...pre };
  const cfg = await loadConfigOrThrow(pkg);
  const home = pkg.home.wingmanHome(process.env);
  const ens = await d.ensureChrome({
    port: cfg.port,
    profileDir: cfg.profile_dir,
    chromePath: cfg.chrome_path,
    home,
    window: cfg.window,
  });
  if (!ens || !ens.ok) {
    return { error: `ensure failed: ${ens?.message ?? ens?.code ?? 'unknown'}` };
  }
  const endpoint = `http://127.0.0.1:${cfg.port}`;
  const conn = await d.connect(endpoint);
  let cookies;
  try {
    const res = await conn.send('Storage.getCookies', {});
    cookies = res?.cookies ?? [];
  } finally {
    if (typeof conn.close === 'function') await conn.close();
  }
  const names = cookies.map((c) => `${c.domain}|${c.name}`).sort();
  const pairs = sha256Hex(names.join('\n'));
  const dirName = `${client}-${stampZ(d.now())}`;
  const dir = join(home, 'cutover', dirName);
  await d.fs.mkdir(dir);
  const reg = await pkg.registrations.readRegistrations(client);
  const entry = playwrightEntryOf(reg);
  const wing = wingmanEntryOf(reg);
  await d.fs.write(join(dir, 'entry.json'), `${JSON.stringify(entry, null, 2)}\n`);
  await d.fs.write(join(dir, 'wingman-entry.json'), `${JSON.stringify(wing ?? null, null, 2)}\n`);
  const bytes = await d.fs.readBytes(reg.file);
  await d.fs.write(join(dir, 'file.bytes'), bytes);
  await d.fs.write(join(dir, 'file.sha256'), `${sha256Hex(bytes)}\n`);
  await d.fs.write(
    join(dir, 'cookies-baseline.json'),
    `${JSON.stringify({ count: cookies.length, pairs_sha256: pairs }, null, 2)}\n`,
  );
  return { snapshot: dirName, cookies: cookies.length };
}

/** print-apply / computeTargets: the diff the operator approves. */
export async function computeTargets(client, snapshotId, deps = {}) {
  const { pkg, deps: d } = await resolveDeps(deps);
  const home = pkg.home.wingmanHome(process.env);
  const snap = await readSnapshot(d.fs, home, snapshotId);
  return {
    before: snap.entry.raw,
    after: wrapRaw(pkg, client, snap.entry.raw),
    wingman_before: snap.wingman ?? null,
    wingman_after: pkg.registrations.wingmanServerEntry(client),
  };
}

export async function printApply(client, snapshotId, deps = {}) {
  return computeTargets(client, snapshotId, deps);
}

/** apply --client <c> --snapshot <id> --approved "<note>" */
export async function apply(client, snapshotId, approved, deps = {}) {
  const { pkg, deps: d } = await resolveDeps(deps);
  if (!approved) return { refused: 'CUTOVER-REFUSED: operator approval note required' };
  const home = pkg.home.wingmanHome(process.env);
  const snap = await readSnapshot(d.fs, home, snapshotId);
  const reg = await pkg.registrations.readRegistrations(client);
  const live = playwrightEntryOf(reg);
  if (!live || !matchesEntry(live, snap.entry.raw, client)) {
    return { refused: 'CUTOVER-REFUSED: entry changed since snapshot' };
  }
  const wrapped = wrapRaw(pkg, client, snap.entry.raw);
  const wingAbs = wingmanEntryOf(reg) === null;
  const wing = pkg.registrations.wingmanServerEntry(client);

  let refusal = null;
  if (client === 'claude') {
    await d.exec('claude', ['mcp', 'remove', 'playwright', '-s', 'user']);
    await d.exec('claude', ['mcp', 'add-json', 'playwright', JSON.stringify(wrapped), '-s', 'user']);
    if (wingAbs) await d.exec('claude', ['mcp', 'add-json', 'jev-browser-wingman', JSON.stringify(wing), '-s', 'user']);
  } else if (client === 'codex') {
    refusal = await applyCodex(d.fs, reg.file, snap.entry, wrapped.args, wingAbs);
  } else {
    refusal = await applyJson(d.fs, reg.file, client, wrapped, wingAbs ? wing : undefined);
  }
  if (refusal) return { refused: refusal };
  const v = await verify(client, snapshotId, 'wrapped', {}, d);
  return { applied: true, verify: v };
}

/** verify --client <c> --snapshot <id> --expect wrapped|original [--mcp-report <file>] */
export async function verify(client, snapshotId, expect = 'wrapped', opts = {}, deps = {}) {
  const { pkg, deps: d } = await resolveDeps(deps);
  if (expect !== 'wrapped' && expect !== 'original') {
    throw new CutoverRefusal(`--expect must be wrapped or original, got ${expect}`);
  }
  const home = pkg.home.wingmanHome(process.env);
  const snap = await readSnapshot(d.fs, home, snapshotId);
  const cfg = await loadConfigOrThrow(pkg);
  const reg = await pkg.registrations.readRegistrations(client);
  const livePw = playwrightEntryOf(reg);
  const liveWing = wingmanEntryOf(reg);
  const gates = [];

  // V1 entry
  let v1 = true;
  const details = [];
  if (expect === 'wrapped') {
    const wantWing = pkg.registrations.wingmanServerEntry(client);
    v1 = matchesEntry(livePw, wrapRaw(pkg, client, snap.entry.raw), client);
    v1 = v1 && matchesEntry(liveWing, wantWing, client);
    if (client === 'codex') {
      const text = await d.fs.read(reg.file);
      const pwScalars = tomlTableScalars(text, 'mcp_servers.playwright');
      const wingScalars = tomlTableScalars(text, 'mcp_servers.jev-browser-wingman');
      if (!pwScalars || Number(pwScalars.startup_timeout_sec) !== 60) {
        v1 = false;
        details.push('startup_timeout_sec != 60 in [mcp_servers.playwright]');
      }
      if (!wingScalars || Number(wingScalars.tool_timeout_sec) !== 90) {
        v1 = false;
        details.push('tool_timeout_sec != 90 in [mcp_servers.jev-browser-wingman]');
      }
    }
  } else {
    v1 = matchesEntry(livePw, snap.entry.raw, client);
    if (snap.wingman) {
      v1 = v1 && matchesEntry(liveWing, snap.wingman.raw, client);
    } else {
      v1 = v1 && liveWing === null;
      if (client === 'codex') {
        const text = await d.fs.read(reg.file);
        if (tomlTableScalars(text, 'mcp_servers.jev-browser-wingman') !== null) {
          v1 = false;
          details.push('[mcp_servers.jev-browser-wingman] still present');
        }
        const pwScalars = tomlTableScalars(text, 'mcp_servers.playwright');
        if (pwScalars && pwScalars.startup_timeout_sec !== undefined) {
          v1 = false;
          details.push('startup_timeout_sec still set in [mcp_servers.playwright]');
        }
      }
    }
  }
  gates.push({
    id: 'V1 entry',
    status: v1 ? 'PASS' : 'FAIL',
    detail: v1 ? `entries match the ${expect} snapshot state` : `entries do not match: ${details.join('; ') || 'command/args/env differ'}`,
  });

  // V2 doctor (wrapped only)
  if (expect === 'wrapped') {
    const report = await d.runDoctor(client);
    if (report?.error === 'wingman-not-installed') {
      gates.push({ id: 'V2 doctor', status: 'FAIL', detail: 'wingman-not-installed' });
    } else if (report?.verdict === 'PASS') {
      gates.push({ id: 'V2 doctor', status: 'PASS', detail: 'doctor verdict PASS' });
    } else {
      gates.push({ id: 'V2 doctor', status: 'FAIL', detail: `doctor verdict ${report?.verdict ?? report?.error ?? 'unknown'}` });
    }
  }

  // V3 state-survives (only with --mcp-report)
  if (opts.mcpReport) {
    let report = null;
    try {
      report = JSON.parse(await d.fs.read(opts.mcpReport));
    } catch (e) {
      report = { error: `cannot read MCP report: ${e.message}` };
    }
    if (report.error) {
      gates.push({ id: 'V3 state-survives', status: 'FAIL', detail: report.error });
    } else if (report.isDefault !== true) {
      gates.push({ id: 'V3 state-survives', status: 'FAIL', detail: 'the MCP report is not the default context (isDefault false)' });
    } else if (snap.baseline.count > 0 && Number(report.cookies) < 0.9 * snap.baseline.count) {
      gates.push({
        id: 'V3 state-survives',
        status: 'FAIL',
        detail: `cookies ${report.cookies} below 90 percent of the baseline ${snap.baseline.count}`,
      });
    } else {
      gates.push({ id: 'V3 state-survives', status: 'PASS', detail: `isDefault true, cookies ${report.cookies} of baseline ${snap.baseline.count}` });
    }
  }

  // V4 no-pipe-chrome
  const holders = await pkg.chrome.profileHolders(cfg.profile_dir, { listChromeProcesses: d.listChrome });
  gates.push({
    id: 'V4 no-pipe-chrome',
    status: holders.withoutPort.length === 0 ? 'PASS' : 'FAIL',
    detail:
      holders.withoutPort.length === 0
        ? 'no Chrome holds the profile without a debug port'
        : `pids ${holders.withoutPort.join(', ')} hold the profile without a debug port; close that browser; this tool never kills it`,
  });

  const relevant = expect === 'wrapped' ? gates : gates.filter((g) => g.id !== 'V2 doctor');
  return { verdict: relevant.every((g) => g.status === 'PASS') ? 'PASS' : 'FAIL', gates };
}

/** rollback --client <c> --snapshot <id> --approved "<note>" */
export async function rollback(client, snapshotId, approved, deps = {}) {
  const { pkg, deps: d } = await resolveDeps(deps);
  if (!approved) return { refused: 'CUTOVER-REFUSED: operator approval note required' };
  const home = pkg.home.wingmanHome(process.env);
  const snap = await readSnapshot(d.fs, home, snapshotId);
  const reg = await pkg.registrations.readRegistrations(client);
  const removeWing = snap.wingman === null;

  let refusal = null;
  if (client === 'claude') {
    await d.exec('claude', ['mcp', 'remove', 'playwright', '-s', 'user']);
    await d.exec('claude', ['mcp', 'add-json', 'playwright', JSON.stringify(snap.entry.raw), '-s', 'user']);
    if (removeWing) await d.exec('claude', ['mcp', 'remove', 'jev-browser-wingman', '-s', 'user']);
    else await d.exec('claude', ['mcp', 'add-json', 'jev-browser-wingman', JSON.stringify(snap.wingman.raw), '-s', 'user']);
  } else if (client === 'codex') {
    refusal = await rollbackCodex(d.fs, reg.file, snap.entry, removeWing);
  } else {
    refusal = await rollbackJson(d.fs, reg.file, client, snap.entry.raw, removeWing ? null : snap.wingman.raw);
  }
  if (refusal) return { refused: refusal };
  const v = await verify(client, snapshotId, 'original', {}, d);
  return { rolledBack: true, verify: v };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--client') flags.client = argv[++i];
    else if (a === '--snapshot') flags.snapshot = argv[++i];
    else if (a === '--approved') flags.approved = argv[++i];
    else if (a === '--expect') flags.expect = argv[++i];
    else if (a === '--mcp-report') flags.mcpReport = argv[++i];
    else return null;
  }
  return flags;
}

function usage() {
  return {
    error:
      'usage: node pa/scripts/wingman_cutover.mjs <preflight|snapshot|print-apply|apply|verify|rollback> --client <claude|codex|opencode|agy|devin> [--snapshot <id>] [--approved "<note>"] [--expect wrapped|original] [--mcp-report <file>]',
  };
}

export async function runCli(argv) {
  const [sub, ...rest] = argv;
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const flags = sub ? parseFlags(rest) : null;
  const known = ['preflight', 'snapshot', 'print-apply', 'apply', 'verify', 'rollback'];
  if (!sub || !known.includes(sub) || flags === null || !flags.client || !CUTOVER_CLIENTS.includes(flags.client)) {
    out(usage());
    return 2;
  }
  const needsSnapshot = sub === 'print-apply' || sub === 'apply' || sub === 'verify' || sub === 'rollback';
  if (needsSnapshot && !flags.snapshot) {
    out(usage());
    return 2;
  }
  const needsApproval = sub === 'apply' || sub === 'rollback';
  if (needsApproval && !flags.approved) {
    out(usage());
    return 2;
  }
  try {
    let result;
    if (sub === 'preflight') result = await preflight(flags.client);
    else if (sub === 'snapshot') result = await snapshot(flags.client);
    else if (sub === 'print-apply') result = await printApply(flags.client, flags.snapshot);
    else if (sub === 'apply') result = await apply(flags.client, flags.snapshot, flags.approved);
    else if (sub === 'verify') result = await verify(flags.client, flags.snapshot, flags.expect ?? 'wrapped', { mcpReport: flags.mcpReport });
    else if (sub === 'rollback') result = await rollback(flags.client, flags.snapshot, flags.approved);
    out(result);
    if (result?.refused) return 3;
    if (result?.error) return 1;
    if (result?.verify?.verdict) return result.verify.verdict === 'PASS' ? 0 : 1;
    if (result?.verdict) return result.verdict === 'PASS' ? 0 : 1;
    return 0;
  } catch (e) {
    if (e instanceof CutoverRefusal || e?.refusal) {
      out({ error: e.message });
      return 3;
    }
    out({ error: e.message });
    return 1;
  }
}

async function main() {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
