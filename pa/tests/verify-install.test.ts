import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Acceptance-probe tests for `pa verify-install` (Wave C WP-C7, spec
// plans/2026-09-17-public-install-package-WAVE-C-SPEC.md §WP-C7). Each case
// gets its OWN temp PA_HOME (coexistence registry, outbox and example skills
// live under it) so no test reads another's state. The IO seam drives the
// health/worker branches deterministically; the skill and restore probes run
// the REAL loadSkill + coexistence engine over REAL fixture skill files —
// the test crosses the real producer/consumer seam, never mocks its own
// fixture shape for those two.
import {
  runVerifyInstall,
  unregisteredChanges,
  USER_FACING_REPORT,
  MIN_WORKER_REPLY_LEN,
  verifyInstallCommand,
  classifyHealthFails,
  type VerifyInstallIo,
} from '../src/commands/verify-install.js';
import {
  list,
  coexistenceRegistryPath,
} from '../src/lib/coexistence.js';
import { DEGRADED_FLOOR_MESSAGE } from '../src/lib/provision.js';

describe('verify-install', () => {
  let paHomeDir: string;
  const savedPaHome = process.env.PA_HOME;

  afterEach(() => {
    if (paHomeDir) rmSync(paHomeDir, { recursive: true, force: true });
    process.env.PA_HOME = savedPaHome;
    paHomeDir = undefined as unknown as string;
  });

  function freshHome(): string {
    paHomeDir = mkdtempSync(join(tmpdir(), 'verify-install-'));
    process.env.PA_HOME = paHomeDir;
    return paHomeDir;
  }

  // --- KNOWN-BAD FIRST (spec §WP-C7): a NON-REGISTERED config modification
  // must FAIL check 4 before any clean run counts — a check never seen to
  // fail is unverified.
  it('KNOWN-BAD: unregistered config modification FAILS check 4', async () => {
    const home = freshHome();
    const surface = join(home, 'claude-settings.json');
    const original = '{"mcpServers":{"existing":{"command":"user-owned"}}}\n';
    writeFileSync(surface, original, 'utf8');
    // Snapshot holds the pre-edit bytes, but the LIVE file drifted with a key
    // nobody registered — the exact violation class this check exists to see.
    writeFileSync(surface, '{"mcpServers":{"existing":{"command":"user-owned"}},"zz":9}\n', 'utf8');
    mkdirSync(join(home, 'coexistence-snapshots'), { recursive: true });
    writeFileSync(join(home, 'coexistence-snapshots', 'snap.json'), original, 'utf8');
    writeFileSync(coexistenceRegistryPath(), JSON.stringify({
      entries: [{
        id: 'claude-test-surface-keyhash',
        cli: 'claude',
        surface,
        mode: 'registry-restore',
        snapshot: join(home, 'coexistence-snapshots', 'snap.json'),
        addedKeys: ['mcpServers.pa-mcp'],
        timestamp: new Date().toISOString(),
      }],
    }), 'utf8');

    const result = await runVerifyInstall({ runHealth: async () => ({ failCount: 0, detail: 'clean' }) });
    const c4 = result.checks.find((c) => c.id === 'coexistence-untouched');
    assert.equal(c4?.status, 'FAIL', `expected check-4 FAIL, got ${JSON.stringify(c4)}`);
    assert.match(c4!.detail, /added:zz/);
    void home;
  });

  it('registered addedKeys do not count as violations; clean registry passes', async () => {
    freshHome();
    assert.deepEqual(
      unregisteredChanges('{"a":1}', '{"a":1,"mcp":{"pa":1,"child":{"x":2}}}', ['mcp']),
      [],
    );
    // Changed value on an unregistered key IS a violation.
    assert.deepEqual(unregisteredChanges('{"a":1}', '{"a":2}', []), ['changed:a']);
    assert.deepEqual(unregisteredChanges('{"a":1}', '{}', []), ['removed:a']);
    assert.deepEqual(unregisteredChanges('{}', '{"b":1}', []), ['added:b']);
    // Allowed prefix covers leaves beneath the registered key.
    assert.deepEqual(unregisteredChanges('{}', '{"mcp":{"x":{"y":1}}}', ['mcp.x']), []);
    const result = await runVerifyInstall({
      runHealth: async () => ({ failCount: 0, detail: 'clean' }),
      runSkill: async () => ({ output: 'hello' }),
      runWorker: async () => ({ reply: 'reachable, thanks for asking' }),
      outboxDir: () => join(paHomeDir!, 'outbox'),
    });
    const c4 = result.checks.find((c) => c.id === 'coexistence-untouched');
    assert.equal(c4?.status, 'PASS');
  });

  it('degraded floor: no workers → verbatim floor message, WARN, degradedFloor=true, verdict PASS', async () => {
    freshHome();
    const result = await runVerifyInstall({
      runHealth: async () => ({ failCount: 0, detail: 'clean' }),
      runSkill: async () => ({ output: 'hello' }),
      runWorker: async () => null,
      outboxDir: () => join(paHomeDir!, 'outbox'),
    });
    assert.equal(result.degradedFloor, true);
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.checks));
    const c3 = result.checks.find((c) => c.id === 'worker-reply');
    assert.equal(c3?.status, 'WARN');
    assert.equal(c3?.detail, DEGRADED_FLOOR_MESSAGE);
  });

  it('worker reply below the minimum length FAILS; long reply PASSES', async () => {
    freshHome();
    const short = await runVerifyInstall({
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runSkill: async () => ({ output: 'x' }),
      runWorker: async () => ({ reply: 'ok' }),
      outboxDir: () => join(paHomeDir!, 'outbox'),
    });
    assert.equal(short.checks.find((c) => c.id === 'worker-reply')?.status, 'FAIL');
    assert.equal(short.verdict, 'FAIL');

    const long = await runVerifyInstall({
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runSkill: async () => ({ output: 'x' }),
      runWorker: async () => ({ reply: 'a'.repeat(MIN_WORKER_REPLY_LEN) }),
      outboxDir: () => join(paHomeDir!, 'outbox'),
    });
    assert.equal(long.checks.find((c) => c.id === 'worker-reply')?.status, 'PASS');
  });

  it('health FAIL lines drive the health check FAIL', async () => {
    freshHome();
    const result = await runVerifyInstall({
      runHealth: async () => ({ failCount: 2, detail: '2 failed' }),
      runSkill: async () => ({ output: 'x' }),
      runWorker: async () => ({ reply: 'a'.repeat(MIN_WORKER_REPLY_LEN) }),
      outboxDir: () => join(paHomeDir!, 'outbox'),
    });
    assert.equal(result.checks.find((c) => c.id === 'health')?.status, 'FAIL');
    assert.equal(result.verdict, 'FAIL');
  });

  it('REAL skill end-to-end: fixture cmd skill fires through loadSkill and lands a fresh non-empty outbox file', async () => {
    const home = freshHome();
    mkdirSync(join(home, 'skills', 'probe-skill'), { recursive: true });
    writeFileSync(join(home, 'skills', 'probe-skill', 'skill.md'), [
      '---',
      'name: probe-skill',
      'cmd: "node -e \\"console.log(\'skill output for verify-install\')\\""',
      'timeout: 60',
      '---',
      '',
      'probe body',
      '',
    ].join('\n'), 'utf8');

    const result = await runVerifyInstall({
      skillName: 'probe-skill',
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runWorker: async () => null,
    });
    const c2 = result.checks.find((c) => c.id === 'skill-end-to-end');
    assert.equal(c2?.status, 'PASS', JSON.stringify(result.checks));
    assert.match(c2!.detail, /outbox file .* non-empty/);
    // The outbox file exists under the temp PA_HOME with the skill's output.
    const outDir = join(home, 'outbox');
    const files = (await import('fs')).readdirSync(outDir);
    assert.ok(files.length > 0, 'outbox dir has the probe file');
    const body = readFileSync(join(outDir, files[0]!), 'utf8');
    assert.match(body, /skill output for verify-install/);
    void home;
  });

  it('REAL restore round-trip: applyAdditive → restore is byte-identical (check 5)', async () => {
    freshHome();
    const result = await runVerifyInstall({
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runSkill: async () => ({ output: 'x' }),
      runWorker: async () => null,
      outboxDir: () => join(paHomeDir!, 'outbox'),
    });
    const c5 = result.checks.find((c) => c.id === 'restore-proven');
    assert.equal(c5?.status, 'PASS', c5?.detail);
    // The probe file cleaned up after itself; the registry row was spent.
    const rows = await list();
    assert.equal(rows.length, 0);
  });

  it('report lint: the user-facing report has zero J1 jargon findings (check 6)', async () => {
    freshHome();
    const result = await runVerifyInstall({
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runSkill: async () => ({ output: 'x' }),
      runWorker: async () => null,
      outboxDir: () => join(paHomeDir!, 'outbox'),
    });
    const c6 = result.checks.find((c) => c.id === 'report-lint');
    assert.equal(c6?.status, 'PASS', c6?.detail);
    assert.match(USER_FACING_REPORT, /<!-- user-facing -->/);
  });

  it('--json prints exactly the pinned schema once', async () => {
    freshHome();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => { lines.push(String(m)); };
    try {
      await verifyInstallCommand('--json --skill x'.split(' '));
    } finally {
      console.log = orig;
    }
    assert.equal(lines.length, 1, `expected one JSON line, got ${lines.length}`);
    const parsed = JSON.parse(lines[0]!);
    assert.deepEqual(Object.keys(parsed).sort(), ['checks', 'degradedFloor', 'verdict']);
    assert.ok(['PASS', 'DEGRADED', 'FAIL'].includes(parsed.verdict));
    assert.equal(typeof parsed.degradedFloor, 'boolean');
    assert.ok(Array.isArray(parsed.checks));
    for (const c of parsed.checks) {
      assert.deepEqual(Object.keys(c).sort(), ['detail', 'id', 'status']);
    }
    const ids = parsed.checks.map((c: any) => c.id);
    for (const id of ['health', 'skill-end-to-end', 'worker-reply', 'coexistence-untouched', 'restore-proven', 'report-lint', 'pii-guard-semantic-off']) {
      assert.ok(ids.includes(id), `missing check id ${id}`);
    }
  });

  // --- DEFECT 1 (install trial 2026-09-18): on a fresh install `pa health`
  // prints ONLY the two Telegram-absence FAIL rows (no bot yet, no token yet)
  // and the probe's nonzero-exit path then counted them as hard fails. The
  // D4 reclassification must hold on BOTH exit paths. The stdout fixture is
  // the real non-color row format from commands/health.ts on a fresh install
  // (statusLabel + name + detail); the secrets-not-found detail names
  // TELEGRAM_BOT_TOKEN in its fix text, so the TELEGRAM_ marker matches both
  // fresh secrets variants.
  it('defect 1: fresh-install health stdout with only Telegram-absence FAILs reclassifies to failCount 0', async () => {
    freshHome();
    const telegramOnly = [
      '',
      'PA Health Check',
      '─'.repeat(50),
      '  [FAIL] bot-process     no lock file at ~/.pa/telegram-bot.lock — bot not running.',
      '  [OK]   blackboard      no active locks',
      '  [WARN] conversation-log missing — normal on a fresh install; the bot creates it on first message',
      '  [WARN] bot-log         no log file yet',
      '  [OK]   app-log         no structured log yet',
      '  [OK]   workers         all 0 available',
      '  [OK]   skills          2 skills parsed',
      '  [FAIL] secrets         secrets.env not found at ~/.pa/secrets.env. Fix: run `node pa/dist/bin/pa.js init` (creates the scaffold) then add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.',
      '  [WARN] last-catchup    no run logs found',
      '  [OK]   disk-logs       0KB',
      '  [WARN] ref-id-logging  no "message sent" logs found in last 100 entries',
      '─'.repeat(50),
      '',
    ].join('\n');
    const r = classifyHealthFails(telegramOnly);
    assert.equal(r.failCount, 0, `expected 0 hard fails, got ${r.failCount}`);
    assert.equal(r.telegramWarns, 2);
    // A genuinely hard FAIL still counts — the reclassification is
    // Telegram-absence-only, never a blanket pardon. (All-unavailable workers
    // is WARN since 2026-09-20 — the degraded floor; all-cooling stays FAIL.)
    assert.equal(classifyHealthFails('  [FAIL] workers         all available workers cooling / rate-limited (agy). No active worker ready to take dispatches.\n').failCount, 1);
    assert.equal(classifyHealthFails('  [FAIL] secrets         missing in ~/.pa/secrets.env: OPENAI_KEY\n').failCount, 1);
  });

  // --- DEFECT 2 (install trial 2026-09-18): INSTALL.md runs the example
  // skill (S8) BEFORE checklist 7, which consumes the seeded due reminder and
  // leaves an EMPTY-but-existing store; the old seed predicate checked only
  // store-file-missing, so the probe ran against an empty store and the
  // example skill produced no output. The REAL example skill (copied verbatim
  // from examples/skills/reminders/) must fire over the appended probe entry.
  it('defect 2: empty-but-existing reminders store is seeded with a due probe entry', async () => {
    const home = freshHome();
    const skillDir = join(home, 'skills', 'reminders');
    mkdirSync(skillDir, { recursive: true });
    // REAL example producer + skill definition, verbatim from the repo.
    // Tests compile to dist/tests — __dirname-based, never cwd-relative.
    const exDir = join(__dirname, '..', '..', '..', 'examples', 'skills', 'reminders');
    writeFileSync(join(skillDir, 'skill.md'), readFileSync(join(exDir, 'skill.md'), 'utf8'));
    writeFileSync(join(skillDir, 'process_reminders.py'), readFileSync(join(exDir, 'process_reminders.py'), 'utf8'));
    // The S8-consumed state: store EXISTS but holds no due entries.
    writeFileSync(join(skillDir, 'reminders.json'), '[]', 'utf8');

    const result = await runVerifyInstall({
      skillName: 'reminders',
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runWorker: async () => null,
    });
    const c2 = result.checks.find((c) => c.id === 'skill-end-to-end');
    assert.equal(c2?.status, 'PASS', JSON.stringify(result.checks));
    const outDir = join(home, 'outbox');
    const files = (await import('fs')).readdirSync(outDir);
    const outboxBody = files.map((f) => readFileSync(join(outDir, f), 'utf8')).join('\n');
    assert.match(outboxBody, /verify-install probe/);

    // Cleanup restores the pre-existing store with NO probe residue: the
    // appended probe row is removed; the store survives as a list.
    const store = JSON.parse(readFileSync(join(skillDir, 'reminders.json'), 'utf8'));
    assert.ok(Array.isArray(store), 'store is still a JSON list');
    assert.ok(store.every((r: any) => !/verify-install probe/.test(r?.message ?? '')), 'no probe residue');
    void home;
  });

  // --- A fresh install has NO example skills copied yet: the real
  // defaultRunSkill → loadSkill throws "not found", and the FAIL detail must
  // name the remediation (examples/skills/<name> + INSTALL.md), not just the
  // cryptic loadSkill error.
  it('missing example skill: not-found FAIL detail names the skill-pack remediation', async () => {
    freshHome();
    const result = await runVerifyInstall({
      skillName: 'no-such-skill-xyz',
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runWorker: async () => null,
      // No runSkill injection: the REAL defaultRunSkill → loadSkill throws.
    });
    const c2 = result.checks.find((c) => c.id === 'skill-end-to-end');
    assert.equal(c2?.status, 'FAIL', JSON.stringify(result.checks));
    assert.match(c2!.detail, /not found/i);
    assert.match(c2!.detail, /examples\/skills\/no-such-skill-xyz/);
    assert.match(c2!.detail, /INSTALL\.md/);
  });

  // A skill that EXISTS but fails to run (e.g. `python: command not found` —
  // Mac leg-1 F2) must NOT get the skill-pack hint: the advice would be wrong.
  it('existing skill run failure: no skill-pack remediation hint', async () => {
    freshHome();
    const result = await runVerifyInstall({
      skillName: 'reminders',
      runHealth: async () => ({ failCount: 0, detail: '' }),
      runSkill: async () => { throw new Error("reminders failed via shell: /bin/sh: python: command not found"); },
      runWorker: async () => null,
    });
    const c2 = result.checks.find((c) => c.id === 'skill-end-to-end');
    assert.equal(c2?.status, 'FAIL', JSON.stringify(result.checks));
    assert.doesNotMatch(c2!.detail, /INSTALL\.md/, JSON.stringify(result.checks));
    assert.match(c2!.detail, /command not found/);
  });
});
