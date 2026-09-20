#!/usr/bin/env node
// WP-P3 — eligibility estimate for jev-browser-wingman (spec § WP-P3, 2026-09-19).
// ESM, never compiled. Estimates how much of this machine's browser activity the
// wingman would withhold as sensitive. Reads the Chrome History DB only from the
// profile given via --profile; running it against the real profile is OG-7 and is
// operator-gated. Prints ONE aggregate JSON object; no URL, host or path is ever
// printed. Package code loads through wingmanDistDir() (§ 3.16), never a literal.

import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wingmanDistDir } from './wingman_pkg.mjs';

const NOTE =
  'Host and path only; page signals such as password fields are not visible here, so sensitive shares are a lower bound.';

// Chrome timestamps: microseconds since 1601-01-01. Offset to the unix epoch in µs.
const CHROME_EPOCH_OFFSET_US = 11644473600000n * 1000n;
const DEFAULT_PROFILE = join(homedir(), '.pa', 'browser-profile');
const DEFAULT_TRACES = join(homedir(), '.pa', 'turn-traces.jsonl');
const DEFAULT_SINCE_DAYS = 30;

function parseArgs(argv) {
  const opts = { profile: DEFAULT_PROFILE, traces: DEFAULT_TRACES, sinceDays: DEFAULT_SINCE_DAYS };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--profile') opts.profile = value;
    else if (flag === '--traces') opts.traces = value;
    else if (flag === '--since-days') opts.sinceDaysRaw = value;
    else {
      process.stderr.write(`ELIGIBILITY: unknown argument ${flag}\n`);
      process.exit(2);
    }
  }
  if (opts.sinceDaysRaw !== undefined) {
    const n = Number(opts.sinceDaysRaw);
    if (!Number.isInteger(n) || n < 0) {
      process.stderr.write('ELIGIBILITY: --since-days must be a non-negative integer\n');
      process.exit(2);
    }
    opts.sinceDays = n;
  }
  return opts;
}

// The repository root, derived from this script's own location — never a literal
// path, because the directory name is an operator-identifier pattern (RO-4).
const REPO_DIR = fileURLToPath(new URL('../..', import.meta.url));

async function loadPolicy() {
  const dist = wingmanDistDir();
  const policyJs = join(dist, 'src', 'core', 'policy.js');
  if (!existsSync(policyJs)) {
    console.log('ELIGIBILITY: jev-browser-wingman not found; npm link it or set WINGMAN_DIST_DIR');
    process.exit(3);
  }
  return await import(pathToFileURL(policyJs).href);
}

function readHistoryUrls(profile, sinceDays) {
  const historyPath = join(profile, 'Default', 'History');
  const tmpCopy = join(tmpdir(), `jevw-elig-history-${process.pid}-${Date.now()}.sqlite`);
  try {
    try {
      copyFileSync(historyPath, tmpCopy);
    } catch {
      console.log(`ELIGIBILITY: History is locked; close the Chrome on ${profile} and run again`);
      process.exit(3);
    }
    const require = createRequire(join(REPO_DIR, 'pa', 'package.json'));
    const Database = require('better-sqlite3');
    const db = new Database(tmpCopy, { readonly: true });
    try {
      const cutoffUs = BigInt(Date.now()) * 1000n + CHROME_EPOCH_OFFSET_US - BigInt(sinceDays) * 86_400n * 1_000_000n;
      const rows = db.prepare('SELECT url FROM urls WHERE last_visit_time > ?').all(cutoffUs);
      return rows.map((r) => String(r.url));
    } finally {
      db.close();
    }
  } finally {
    try {
      rmSync(tmpCopy, { force: true });
    } catch {
      // best-effort cleanup of the temp copy
    }
  }
}

// Trace lines are turn-trace tool calls (C17); args are capped at 200 chars, so a
// longer URL classifies on its truncated host and path.
function readTraceNavigations(tracesPath) {
  let text;
  try {
    text = readFileSync(tracesPath, 'utf8');
  } catch {
    return [];
  }
  const urls = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!rec || !Array.isArray(rec.tool_calls)) continue;
    for (const call of rec.tool_calls) {
      if (!call || typeof call.name !== 'string' || !call.name.includes('browser_navigate')) continue;
      const match = String(call.arg ?? '').match(/https?:\/\/\S+/);
      if (match) urls.push(match[0]);
    }
  }
  return urls;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { classifyUrl } = await loadPolicy();

  const historyUrls = readHistoryUrls(opts.profile, opts.sinceDays);
  const traceUrls = readTraceNavigations(opts.traces);

  const counts = new Map();
  for (const url of [...historyUrls, ...traceUrls]) {
    const verdict = classifyUrl(url);
    const key = verdict.sensitive ? verdict.reason : 'not-sensitive';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = historyUrls.length + traceUrls.length;

  const byReason = {};
  const shares = {};
  for (const [key, n] of counts) {
    byReason[key] = n;
    shares[key] = Math.round((n / total) * 1000) / 1000;
  }

  console.log(
    JSON.stringify({
      sources: { history: { urls: historyUrls.length, days: opts.sinceDays }, traces: { navigations: traceUrls.length } },
      total,
      by_reason: byReason,
      shares,
      note: NOTE,
    }),
  );
}

main();
