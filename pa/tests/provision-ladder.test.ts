import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Pure unit tests for the capability ladder (Wave C WP-C3). Each case gets its
// OWN temp PA_HOME (coexistence registry + generated config live under it) so
// no test reads another's state — paHome() resolves process.env.PA_HOME
// dynamically at every call. The IO seam drives every branch
// deterministically; nothing here spawns a real CLI.
import {
  classifyDescription,
  DEGRADED_FLOOR_MESSAGE,
  discover,
  ESCAPE_HATCH_PROMPT,
  generateWorkerConfig,
  assertNoOperatorPaths,
  loadOperatorPatterns,
  runProvisionLadder,
  defaultConfigureCli,
  defaultMcpEntry,
  wingmanMcpEntry,
  type ProvisionIo,
} from '../src/lib/provision.js';
import { KeyCollisionError } from '../src/lib/coexistence.js';

interface TestIo extends ProvisionIo {
  lines: string[];
  script: string[]; // answers popped in order for each ask()
  asked: string[];
}

function makeIo(script: string[]): TestIo {
  const lines: string[] = [];
  // The preserve ask (step 4) is a single binary choice outside the connection
  // ask flow — every connection-flow ask carries the escape hatch (D12c).
  const hatchExempt = ['keep a copy of your assistant'];
  return {
    lines,
    script,
    asked: [],
    print: (line) => {
      lines.push(line);
    },
    ask: async (question) => {
      if (!hatchExempt.some((p) => question.includes(p))) {
        assert.ok(question.includes(ESCAPE_HATCH_PROMPT), `ask carries the escape hatch: ${question}`);
      }
      const answer = script.shift();
      assert.notEqual(answer, undefined, 'io script exhausted');
      return answer as string;
    },
  };
}

describe('provision ladder', () => {
  let paHomeDir: string;
  const savedPaHome = process.env.PA_HOME;

  afterEach(() => {
    if (paHomeDir) rmSync(paHomeDir, { recursive: true, force: true });
    process.env.PA_HOME = savedPaHome;
    paHomeDir = undefined as unknown as string;
  });

  function freshHome(): string {
    paHomeDir = mkdtempSync(join(tmpdir(), 'provision-ladder-'));
    process.env.PA_HOME = paHomeDir;
    return paHomeDir;
  }

  const noClis = { clis: [], keys: [] };

  // --- KNOWN-BAD FIRST: a pre-existing config with a colliding key must end
  // in the ask state with the config bytes unchanged — NEVER a silent
  // overwrite (spec §WP-C3 gates). This is the check-seen-to-fail fixture.
  it('KNOWN-BAD: colliding key routes to the ask flow; config bytes unchanged', async () => {
    const home = freshHome();
    const surface = join(home, 'claude-settings.json');
    const original = '{"mcpServers":{"existing":{"command":"user-owned"}}}\n';
    writeFileSync(surface, original, 'utf8');

    const io = makeIo(['yes', 'yes', 'no', 'no']); // accept connect; keep settings on collision; free tiers? no; preserve? no
    const r = await runProvisionLadder({
      io,
      discovery: { clis: [{ name: 'claude', onPath: true }], keys: [] },
      paHomeDir: home,
      configure: async () => {
        // Real coexistence-engine path against a pre-seeded surface.
        const { applyAdditive } = await import('../src/lib/coexistence.js');
        return applyAdditive('claude', surface, [
          { key: 'mcpServers.existing', value: { command: 'pa', args: ['mcp', 'serve'] } },
        ]).then(
          (res) => ({ ok: true, detail: `registered ${res.added.join(', ')}` }),
          (err) => {
            throw err;
          },
        );
      },
    });

    assert.equal(r.state, 'degraded-floor', 'collision → nothing provisioned → degraded floor');
    assert.deepEqual(
      r.collisions,
      [{ cli: 'claude', keys: ['mcpServers.existing'] }],
      'collision surfaced through the ask flow, never overwritten',
    );
    assert.ok(
      r.transcript.some((l) => l.includes('will not overwrite')),
      'transcript names the never-overwrite rule',
    );
    assert.equal(readFileSync(surface, 'utf8'), original, 'config bytes unchanged');
    assert.equal(r.gitWorkflow, false);
  });

  it('KNOWN-BAD companion: the collision fixture DOES throw KeyCollisionError before the ask routing', async () => {
    // Proves the routing test above rides a REAL throw, not a swallowed one.
    freshHome();
    const surface = join(paHomeDir, 's.json');
    writeFileSync(surface, '{"keep":1}', 'utf8');
    const { applyAdditive } = await import('../src/lib/coexistence.js');
    await assert.rejects(
      () => applyAdditive('claude', surface, [{ key: 'keep', value: 'pa' }]),
      KeyCollisionError,
    );
  });

  it('nothing found + declines free tiers → degraded floor with the verbatim message', async () => {
    const home = freshHome();
    const io = makeIo(['no', 'no']); // free tiers? no; preserve? no
    const r = await runProvisionLadder({ io, discovery: noClis, paHomeDir: home });
    assert.equal(r.state, 'degraded-floor');
    assert.deepEqual(r.provisioned, []);
    assert.ok(r.transcript.includes(DEGRADED_FLOOR_MESSAGE), 'degraded-floor message asserted verbatim');
    assert.ok(r.transcript.some((l) => l.includes('install a CLI such as opencode')), 'how to add a worker later');
    // Delivery floor: the outbox exists regardless of Telegram.
    assert.ok(existsSync(join(home, 'outbox')));
  });

  it('keys-only branch (D12b): keys present, zero CLIs → opencode harness offered and provisioned', async () => {
    const home = freshHome();
    const io = makeIo(['yes', 'yes']); // harness? yes; preserve? yes
    const provisionedReasons: string[] = [];
    const r = await runProvisionLadder({
      io,
      discovery: { clis: [], keys: ['OPENAI_API_KEY'] },
      paHomeDir: home,
      configure: async (cli, reason) => {
        provisionedReasons.push(`${cli}:${reason}`);
        return { ok: true, detail: 'registered' };
      },
    });
    assert.equal(r.state, 'configured');
    assert.deepEqual(r.provisioned, ['opencode']);
    assert.ok(provisionedReasons.includes('opencode:keys-only'), 'keys-only entry reason recorded');
    const cfg = readFileSync(join(home, 'config.yaml.provisioned'), 'utf8');
    assert.ok(cfg.includes('command: opencode'));
    assert.ok(!cfg.includes('sk-'), 'no key VALUE in generated config — env names only');
    assert.ok(r.gitWorkflow, 'preserve ask yes → git_workflow true');
    assert.ok(r.transcript.some((l) => l.includes('pull request')), 'D11 fork→PR destination stated');
  });

  it('escape hatch (D12c): a described setup maps to the nearest supported shape', async () => {
    const home = freshHome();
    const io = makeIo(['I have just an api key and a base url for my provider', 'yes', 'no']);
    const r = await runProvisionLadder({
      io,
      discovery: { clis: [{ name: 'claude', onPath: true }], keys: [] },
      paHomeDir: home,
      configure: async (cli, reason) => ({ ok: true, detail: `${cli}:${reason}` }),
    });
    // The described "api key + base url" setup outranks the offered default.
    assert.deepEqual(r.provisioned, ['opencode']);
    assert.ok(r.transcript.some((l) => l.includes('base URL and a key')), 'keys-only branch text');
  });

  it('escape hatch defaults come from discovery but the answer outranks them', () => {
    assert.deepEqual(classifyDescription('opencode please', false), { kind: 'free-tier', cli: 'opencode' });
    assert.deepEqual(classifyDescription('devin only', false), { kind: 'free-tier', cli: 'devin' });
    assert.deepEqual(classifyDescription('no idea, whatever', true), { kind: 'keys-only' });
    assert.deepEqual(classifyDescription('no idea, whatever', false), { kind: 'free-tier', cli: 'opencode' });
  });

  it('accepting a found CLI configures it via the coexistence engine shape (registered additive)', async () => {
    const home = freshHome();
    const io = makeIo(['yes', 'no']);
    let calledReason = '';
    const r = await runProvisionLadder({
      io,
      discovery: { clis: [{ name: 'claude', onPath: true }], keys: [] },
      paHomeDir: home,
      configure: async (cli, reason) => {
        calledReason = reason;
        return { ok: true, detail: `registered in ${cli} surface` };
      },
    });
    assert.equal(calledReason, 'accepted-existing');
    assert.equal(r.state, 'configured');
    assert.deepEqual(r.provisioned, ['claude']);
  });

  it('devin free-tier is best-effort: failure reports and never blocks (D7)', async () => {
    const home = freshHome();
    const io = makeIo(['yes', 'no']); // free tiers? yes → opencode ok, devin best-effort
    const r = await runProvisionLadder({
      io,
      discovery: noClis,
      paHomeDir: home,
      configure: async (cli) => ({ ok: cli !== 'devin', detail: cli === 'devin' ? 'not installed' : 'ok' }),
    });
    assert.equal(r.state, 'configured');
    assert.deepEqual(r.provisioned, ['opencode'], 'opencode first-class; devin best-effort never blocks');
    assert.ok(r.transcript.some((l) => l.includes('devin: not installed')));
  });

  it('discover probes by presence only: keys list carries NAMES, never values', async () => {
    const d = await discover(async (cmd) => cmd === 'claude', { OPENAI_API_KEY: 'sk-secret-value' });
    assert.deepEqual(d.clis.filter((c) => c.onPath).map((c) => c.name), ['claude']);
    assert.deepEqual(d.keys, ['OPENAI_API_KEY']);
    assert.ok(!JSON.stringify(d).includes('sk-secret-value'), 'key values never printed');
  });

  it('generateWorkerConfig uses PATH-resolved commands; operator-path assert fails on known-bad text first', () => {
    const cfg = generateWorkerConfig(['claude', 'opencode']);
    assert.ok(cfg.includes('command: claude') && cfg.includes('command: opencode'));
    assertNoOperatorPaths(cfg);
    // KNOWN-BAD: planted operator-path text must FAIL the checker before the
    // clean run counts (a check never seen to fail is unverified).
    assert.throws(() => assertNoOperatorPaths('workers:\n  - command: D:\\tools\\claude.cmd\n'), /operator-path-shaped/);
    assert.throws(() => assertNoOperatorPaths('chat 123456789012'), /operator-path-shaped/);
    assert.throws(() => assertNoOperatorPaths('path C:\\Users\\user'), /operator-path-shaped/);
  });

  it('G5 re-gate: generated config passes the REAL operator pattern set (file exists on this machine)', (t) => {
    const patterns = loadOperatorPatterns();
    // The real pattern file is operator-machine-only by design (it holds
    // operator identifiers and deliberately does NOT live under PA_HOME).
    // On a clean CI runner it is absent — skip rather than fail: the
    // placeholder-set gate in the previous test covers generated-config
    // hygiene everywhere (2026-09-20 public-mirror CI fail).
    if (patterns.length === 0) {
      t.skip('operator-identifiers.txt absent — real-set re-gate is an operator-machine check');
      return;
    }
    const cfg = generateWorkerConfig(['claude', 'codex', 'opencode', 'devin']);
    for (const re of patterns) {
      assert.ok(!re.test(cfg), `generated config must not match operator pattern ${re.source}`);
    }
    // And the known-bad fixture FAILS against the real set too.
    const bad = 'checkpoint: D:\\Personal Assistant\\scratch\\x';
    assert.ok(patterns.some((re) => re.test(bad)), 'real set flags the known-bad fixture');
  });

  describe('defaultConfigureCli — wingman entry (WP-P1)', () => {
    // defaultSurface('claude') resolves against process.env.HOME/USERPROFILE
    // (provision.ts's homeDir()), NOT PA_HOME — so these tests must override
    // HOME/USERPROFILE too, or defaultConfigureCli would write the REAL
    // ~/.claude/settings.json (§ 2 rule 8: builders never touch live config).
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    let fakeHomeDir: string;

    function freshFakeHome(): string {
      fakeHomeDir = freshHome(); // reuses the PA_HOME temp dir as the fake user home too
      process.env.HOME = fakeHomeDir;
      process.env.USERPROFILE = fakeHomeDir;
      mkdirSync(join(fakeHomeDir, '.claude'), { recursive: true });
      return join(fakeHomeDir, '.claude', 'settings.json');
    }

    afterEach(() => {
      process.env.HOME = savedHome;
      process.env.USERPROFILE = savedUserProfile;
    });

    it('wingman entry registered when jev-browser-wingman is on PATH', async () => {
      const surface = freshFakeHome();
      const { applyAdditive } = await import('../src/lib/coexistence.js');
      const outcome = await defaultConfigureCli('claude', 'accepted-existing', {
        probeWingman: async () => true,
        apply: async (cli, s, entries) => applyAdditive(cli, s, entries),
      });
      const written = JSON.parse(readFileSync(surface, 'utf8'));
      assert.ok(written.mcpServers['jev-browser-wingman'], 'wingman key present');
      assert.ok(written.mcpServers['pa-mcp'], 'pa-mcp key still present');
      assert.ok(outcome.ok);
    });

    it('no wingman entry when the probe fails', async () => {
      const surface = freshFakeHome();
      const { applyAdditive } = await import('../src/lib/coexistence.js');
      await defaultConfigureCli('claude', 'accepted-existing', {
        probeWingman: async () => false,
        apply: async (cli, s, entries) => applyAdditive(cli, s, entries),
      });
      const written = JSON.parse(readFileSync(surface, 'utf8'));
      assert.equal(written.mcpServers['jev-browser-wingman'], undefined);
      assert.ok(written.mcpServers['pa-mcp']);
    });

    it('an existing jev-browser-wingman key still registers pa-mcp', async () => {
      const surface = freshFakeHome();
      writeFileSync(surface, JSON.stringify({ mcpServers: { 'jev-browser-wingman': { command: 'user-owned' } } }), 'utf8');
      const { applyAdditive, coexistenceRegistryPath } = await import('../src/lib/coexistence.js');
      const outcome = await defaultConfigureCli('claude', 'accepted-existing', {
        probeWingman: async () => true,
        apply: async (cli, s, entries) => applyAdditive(cli, s, entries),
      });
      assert.ok(outcome.ok);
      assert.match(outcome.detail, /jev-browser-wingman already registered/);
      const written = JSON.parse(readFileSync(surface, 'utf8'));
      assert.deepEqual(written.mcpServers['jev-browser-wingman'], { command: 'user-owned' }, 'existing key untouched');
      assert.ok(written.mcpServers['pa-mcp'], 'pa-mcp still registered');
      const registry = JSON.parse(readFileSync(coexistenceRegistryPath(), 'utf8'));
      assert.equal(registry.entries.length, 1, 'one registry row, for the pa-mcp-only retry');
      assert.deepEqual(registry.entries[0].addedKeys, ['mcpServers.pa-mcp']);
    });
  });
});
