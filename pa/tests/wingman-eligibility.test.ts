import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// dist/tests -> dist -> pa -> repo. Never a literal path: the repository's
// directory name is an operator-identifier pattern (RO-4).
const REPO_DIR = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_DIR, 'pa', 'scripts', 'wingman_eligibility.mjs');

function chromeTimeUs(dateMs: number): bigint {
  // Chrome timestamps: microseconds since 1601-01-01; computed in BigInt because
  // the value exceeds Number.MAX_SAFE_INTEGER.
  return (BigInt(Math.round(dateMs)) + 11644473600000n) * 1000n;
}

const FIXTURE_URLS = ['https://www.chase.com/account', 'https://old.example.org/page', 'https://sub.example.org/signin'];
const FIXTURE_HOSTS = ['chase.com', 'example.org'];
const FIXTURE_PATHS = ['/account', '/page', '/signin'];

// The no-URL assertion helper. Throws if any fixture URL, host or path occurs in
// the text; the known-bad test proves it throws on planted output.
function assertNoFixtureLocations(text: string): void {
  for (const url of FIXTURE_URLS) {
    if (text.includes(url)) throw new Error(`fixture URL leaked into output: ${url}`);
  }
  for (const host of FIXTURE_HOSTS) {
    if (text.toLowerCase().includes(host)) throw new Error(`fixture host leaked into output: ${host}`);
  }
  for (const p of FIXTURE_PATHS) {
    if (text.includes(p)) throw new Error(`fixture path leaked into output: ${p}`);
  }
}

// The package is not built in PA's CI and does not exist in the public mirror, so
// there the file registers one visible SKIP. Locally gate I-6 requires # skip 0.
const distDir = process.env.WINGMAN_DIST_DIR;
const distReady = !!distDir && existsSync(join(distDir, 'src', 'core', 'policy.js'));

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'jevw-elig-'));
  cleanupDirs.push(dir);
  const profile = join(dir, 'profile');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  const db = new Database(join(profile, 'Default', 'History'));
  try {
    db.exec('CREATE TABLE urls (url TEXT, last_visit_time INTEGER)');
    const insert = db.prepare('INSERT INTO urls (url, last_visit_time) VALUES (?, ?)');
    const nowMs = Date.now();
    insert.run(FIXTURE_URLS[0], chromeTimeUs(nowMs - 1 * 86_400_000)); // 1 day ago
    insert.run(FIXTURE_URLS[1], chromeTimeUs(nowMs - 60 * 86_400_000)); // 60 days ago
  } finally {
    db.close();
  }
  const traces = join(dir, 'traces.jsonl');
  writeFileSync(
    traces,
    `${JSON.stringify({
      v: 1,
      tool_calls: [{ n: 1, name: 'mcp__wingman__browser_navigate', arg: `go to ${FIXTURE_URLS[2]} and read it`, ok: true }],
    })}\n`,
  );
  return { dir, profile, traces };
}

async function loadDistPolicy() {
  return await import(pathToFileURL(join(distDir!, 'src', 'core', 'policy.js')).href);
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WINGMAN_DIST_DIR: distDir! },
  });
}

// Expected buckets computed through the real compiled policy, so this test checks
// the aggregation seam, not policy classification itself (that is C2's own gate).
function expectedBuckets(urls: string[], policy: { classifyUrl: (u: string) => { sensitive: boolean; reason?: string } }) {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const verdict = policy.classifyUrl(url);
    const key = verdict.sensitive ? String(verdict.reason) : 'not-sensitive';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = urls.length;
  const byReason: Record<string, number> = {};
  const shares: Record<string, number> = {};
  for (const [key, n] of counts) {
    byReason[key] = n;
    shares[key] = Math.round((n / total) * 1000) / 1000;
  }
  return { byReason, shares };
}

describe('wingman-eligibility', () => {
  if (!distReady) {
    it.skip('jev-browser-wingman dist not built', () => {});
    return;
  }

  it('counts history and trace URLs by reason', async () => {
    const fx = makeFixtures();
    const run = runScript(['--profile', fx.profile, '--traces', fx.traces]);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    const policy = await loadDistPolicy();
    const expected = expectedBuckets([FIXTURE_URLS[0], FIXTURE_URLS[2]], policy);
    assert.deepEqual(out, {
      sources: { history: { urls: 1, days: 30 }, traces: { navigations: 1 } },
      total: 2,
      by_reason: expected.byReason,
      shares: expected.shares,
      note: 'Host and path only; page signals such as password fields are not visible here, so sensitive shares are a lower bound.',
    });
  });

  it('respects since-days', async () => {
    const fx = makeFixtures();
    const run = runScript(['--profile', fx.profile, '--traces', fx.traces, '--since-days', '100']);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    const policy = await loadDistPolicy();
    const expected = expectedBuckets(FIXTURE_URLS, policy);
    assert.equal(out.sources.history.urls, 2);
    assert.equal(out.sources.history.days, 100);
    assert.equal(out.total, 3);
    assert.deepEqual(out.by_reason, expected.byReason);
    assert.deepEqual(out.shares, expected.shares);
  });

  it('output contains no URL, host or path', async () => {
    const fx = makeFixtures();
    const run = runScript(['--profile', fx.profile, '--traces', fx.traces]);
    assert.equal(run.status, 0, run.stderr);
    assertNoFixtureLocations(run.stdout);
  });

  it('the no-URL assertion fails on planted output', () => {
    assert.throws(() => assertNoFixtureLocations(`visited ${FIXTURE_URLS[0]} recently`));
  });

  it('a missing History file exits 3 with the locked message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevw-elig-'));
    cleanupDirs.push(dir);
    const profile = join(dir, 'empty-profile');
    mkdirSync(join(profile, 'Default'), { recursive: true });
    const run = runScript(['--profile', profile, '--traces', join(dir, 'none.jsonl')]);
    assert.equal(run.status, 3);
    assert.equal(
      run.stdout.trim(),
      `ELIGIBILITY: History is locked; close the Chrome on ${profile} and run again`,
    );
  });
});
