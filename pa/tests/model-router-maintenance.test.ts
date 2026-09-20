import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { clearRateLimitCache } from '../src/rate-limits.js';
import { modelRouterCooldownNormalizeJob } from '../src/lib/maintenance/jobs/model-router-cooldown-normalize.js';
import { MAINTENANCE_JOBS } from '../src/lib/maintenance/registry.js';

let dir: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function ctx(): { now: number; everyMs: number } {
  return { now: NOW, everyMs: DAY_MS };
}

function hoursAgo(h: number): string {
  return new Date(NOW - h * 3_600_000).toISOString();
}

async function seedCooldown(worker: string, entry: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rate-limit-state.json'), JSON.stringify({ [worker]: entry }), 'utf8');
}

beforeEach(async () => {
  dir = await createTempPaHome();
  clearRateLimitCache();
});

afterEach(async () => {
  clearRateLimitCache();
  await cleanup(dir);
});

describe('model-router-cooldown-normalize', () => {
  it('declares per AI-100: pa host, 24h cadence, destructive+shedding, fail-closed 90d shadow + telemetry targets', () => {
    const job = MAINTENANCE_JOBS.find((j) => j.name === 'model-router-cooldown-normalize');
    assert.ok(job, 'job must be registered');
    assert.equal(job.host, 'pa');
    assert.equal(job.everyMs, DAY_MS);
    assert.equal(job.destructive, true);
    assert.equal(job.shedWhenDegraded, true);
    assert.equal(job.targets.length, 2);
    const t = job.targets[0];
    assert.equal(t.resolve(), join(dir, 'model-router-shadow.jsonl'), 'resolve() reads PA_HOME at run time');
    assert.equal(t.match.test('model-router-shadow.jsonl'), true);
    assert.equal(t.match.test('model-router-shadow.jsonl.tmp'), false, 'fail-closed: tmp siblings never match');
    assert.equal(t.maxAgeMs, 90 * DAY_MS);
    assert.equal(t.action, 'delete');
    assert.equal(t.ownership, 'pa-owned');
    assert.match(t.evidence, /2026-09-18/);
    const telem = job.targets[1];
    assert.equal(telem.resolve(), join(dir, 'model-router-telemetry.jsonl'), 'telemetry target resolves the telemetry JSONL at run time');
    assert.equal(telem.match.test('model-router-telemetry.jsonl'), true);
    assert.equal(telem.match.test('model-router-telemetry.jsonl.tmp'), false, 'fail-closed: tmp siblings never match');
    assert.equal(telem.maxAgeMs, 90 * DAY_MS);
    assert.equal(telem.action, 'delete');
    assert.equal(telem.ownership, 'pa-owned');
    assert.match(telem.evidence, /2026-09-18/);
  });

  it('clears ONLY the stale self-healing cooldown', async () => {
    await seedCooldown('agy', {
      cooldown_until: hoursAgo(30),
      last_event: hoursAgo(54),
      reason: 'gemini terminal-fault stderr',
      classification: 'gemini-stderr' as never,
    });
    const res = await modelRouterCooldownNormalizeJob.run(ctx());
    assert.equal(res.touched, 1);
    const state = JSON.parse(await readFile(join(dir, 'rate-limit-state.json'), 'utf8'));
    assert.equal(state['agy'], undefined, 'stale self-healing entry removed');
    assert.ok(
      (res.detail as { cooldowns: { cleared: string[] } }).cooldowns.cleared.includes('agy'),
      'the expiry is recorded in detail, never silently zeroed',
    );
  });

  it('touches a terminal (account-exhausted) entry even when 24h+ expired', async () => {
    await seedCooldown('zclaude', {
      cooldown_until: hoursAgo(50),
      last_event: hoursAgo(74),
      reason: 'terminal billing fault',
      classification: 'account-exhausted' as never,
    });
    const res = await modelRouterCooldownNormalizeJob.run(ctx());
    assert.equal(res.touched, 0);
    const state = JSON.parse(await readFile(join(dir, 'rate-limit-state.json'), 'utf8'));
    assert.equal(state['zclaude'].classification, 'account-exhausted', 'terminal entry untouched');
  });

  it('records an unknown-class entry as unknown and never rewrites it (decision 5)', async () => {
    await seedCooldown('codex', {
      cooldown_until: hoursAgo(30),
      last_event: hoursAgo(55),
      reason: 'unparsed failure',
      classification: 'unknown' as never,
    });
    const res = await modelRouterCooldownNormalizeJob.run(ctx());
    assert.equal(res.touched, 0);
    const state = JSON.parse(await readFile(join(dir, 'rate-limit-state.json'), 'utf8'));
    assert.equal(state['codex'].classification, 'unknown', 'unknown stays unknown');
    assert.equal(state['codex'].cooldown_until, hoursAgo(30));
    assert.ok(
      (res.detail as { cooldowns: { kept_unknown: string[] } }).cooldowns.kept_unknown.includes('codex'),
      'the unknown entry is recorded in detail, never zeroed',
    );
  });

  it('leaves a FRESH self-healing cooldown alone (not yet 24h past expiry)', async () => {
    await seedCooldown('devin', {
      cooldown_until: hoursAgo(2),
      last_event: hoursAgo(26),
      reason: '429',
    });
    const res = await modelRouterCooldownNormalizeJob.run(ctx());
    assert.equal(res.touched, 0);
    const state = JSON.parse(await readFile(join(dir, 'rate-limit-state.json'), 'utf8'));
    assert.ok(state['devin'], 'fresh entry kept');
  });

  it('prunes shadow JSONL lines older than 90d, keeps fresh, no .tmp left, atomic', async () => {
    const shadow = join(dir, 'model-router-shadow.jsonl');
    await mkdir(dir, { recursive: true });
    const old901 = JSON.stringify({ at: hoursAgo(91 * 24), chosen: 'agy', baseline: 'zclaude' });
    const old902 = JSON.stringify({ at: hoursAgo(90 * 24 + 48), chosen: 'codex', baseline: 'zclaude' });
    const fresh = JSON.stringify({ at: hoursAgo(10), chosen: 'claude', baseline: 'agy' });
    const unparseable = 'this is not json';
    const freshBoundary = JSON.stringify({ at: hoursAgo(90 * 24 - 1) });
    await writeFile(shadow, [old901, old902, fresh, unparseable, freshBoundary].join('\n') + '\n', 'utf8');
    const res = await modelRouterCooldownNormalizeJob.run(ctx());
    assert.equal(res.touched, 2, 'two >90d lines dropped');
    const after = await readFile(shadow, 'utf8');
    assert.ok(after.includes(fresh), 'fresh line kept');
    assert.ok(after.includes(unparseable), 'unparseable line kept (fail closed)');
    assert.ok(after.includes(freshBoundary), 'boundary line just under 90d kept');
    assert.equal(after.includes(old901), false, 'old line 1 gone');
    assert.equal(after.includes(old902), false, 'old line 2 gone');
    const names = await readdir(dir);
    assert.equal(
      names.some((n) => n.endsWith('.tmp')),
      false,
      'no .tmp left behind (atomic rename)',
    );
  });

  it('prunes telemetry JSONL lines older than 90d too (same per-line atomic rewrite)', async () => {
    const telem = join(dir, 'model-router-telemetry.jsonl');
    await mkdir(dir, { recursive: true });
    const oldLine = JSON.stringify({ at: hoursAgo(91 * 24), worker: 'agy', durationMs: 100 });
    const freshLine = JSON.stringify({ at: hoursAgo(10), worker: 'claude', durationMs: 200 });
    const boundary = JSON.stringify({ at: hoursAgo(90 * 24 - 1), worker: 'codex', durationMs: 300 });
    await writeFile(telem, [oldLine, freshLine, boundary].join('\n') + '\n', 'utf8');
    const res = await modelRouterCooldownNormalizeJob.run(ctx());
    const after = await readFile(telem, 'utf8');
    assert.ok(after.includes(freshLine), 'fresh telemetry line kept');
    assert.ok(after.includes(boundary), 'boundary telemetry line kept');
    assert.equal(after.includes(oldLine), false, 'old telemetry line dropped');
    assert.equal(
      (res.detail as { telemetry: { dropped: number } }).telemetry.dropped,
      1,
      'the drop is recorded in the run detail',
    );
    const names = await readdir(dir);
    assert.equal(names.some((n) => n.endsWith('.tmp')), false, 'no .tmp left behind');
  });

  it('run() composes both duties and is a no-op on an empty PA_HOME', async () => {
    const res = await modelRouterCooldownNormalizeJob.run(ctx());
    assert.equal(res.touched, 0);
  });
});
