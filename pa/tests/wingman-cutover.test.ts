import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// dist/tests -> dist -> pa -> repo. Never a literal path: the repository's
// directory name is an operator-identifier pattern (RO-4).
const REPO_DIR = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_DIR, 'pa', 'scripts', 'wingman_cutover.mjs');

// The same skip-when-unbuilt rule as wingman-eligibility.test.ts, keyed on
// <dist>/src/cli/registrations.js. Locally gate I-6 requires # skip 0.
const distDir = process.env.WINGMAN_DIST_DIR;
const distReady = !!distDir && existsSync(join(distDir, 'src', 'cli', 'registrations.js'));

const COOKIE_FIXTURE = [
  { domain: 'a.example', name: 'sid', value: 'cookie-value-a' },
  { domain: 'b.example', name: 'sess', value: 'cookie-value-b' },
];
const COOKIE_FIXTURE_TEN = Array.from({ length: 10 }, (_, i) => ({
  domain: `d${i}.example`,
  name: `n${i}`,
  value: `v${i}`,
}));

interface CutoverModule {
  preflight: (client: string, deps?: object) => Promise<any>;
  snapshot: (client: string, deps?: object) => Promise<any>;
  printApply: (client: string, id: string, deps?: object) => Promise<any>;
  apply: (client: string, id: string, approved?: string, deps?: object) => Promise<any>;
  verify: (client: string, id: string, expect?: string, opts?: object, deps?: object) => Promise<any>;
  rollback: (client: string, id: string, approved?: string, deps?: object) => Promise<any>;
  runCli: (argv: string[]) => Promise<number>;
}

if (!distReady) {
  it.skip('jev-browser-wingman dist not built', () => {});
} else {
  describe('wingman cutover', () => {
    let cutover: CutoverModule;
    let baseDir: string;
    let tmpHome: string; // HOME / USERPROFILE — holds the fixture client configs
    let wingmanHome: string; // WINGMAN_HOME — holds config.json and cutover/
    let profile: string;
    let savedEnv: Record<string, string | undefined>;

    before(async () => {
      cutover = (await import(pathToFileURL(SCRIPT).href)) as CutoverModule;
    });

    beforeEach(() => {
      savedEnv = {};
      for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'WINGMAN_HOME', 'WINGMAN_DIST_DIR', 'WINGMAN_PKG_DIR']) {
        savedEnv[k] = process.env[k];
      }
      baseDir = mkdtempSync(join(tmpdir(), 'jevw-cutover-'));
      tmpHome = join(baseDir, 'home');
      wingmanHome = join(baseDir, 'wingman-home');
      profile = join(baseDir, 'profile');
      mkdirSync(tmpHome, { recursive: true });
      mkdirSync(wingmanHome, { recursive: true });
      mkdirSync(profile, { recursive: true });
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      process.env.APPDATA = join(tmpHome, 'AppData', 'Roaming');
      process.env.WINGMAN_HOME = wingmanHome;
      writeFileSync(
        join(wingmanHome, 'config.json'),
        `${JSON.stringify({ profile_dir: profile, port: 9333 }, null, 2)}\n`,
      );
    });

    afterEach(() => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(baseDir, { recursive: true, force: true });
    });

    // -- fixtures -----------------------------------------------------------

    const PW_ARGS = (prof: string) => ['-y', '@playwright/mcp@0.0.80', '--user-data-dir', prof, '--browser', 'chrome'];

    function writeConfig(client: string, content: string): string {
      const paths: Record<string, string> = {
        claude: join(tmpHome, '.claude.json'),
        codex: join(tmpHome, '.codex', 'config.toml'),
        opencode: join(tmpHome, '.config', 'opencode', 'opencode.jsonc'),
        agy: join(tmpHome, '.gemini', 'config', 'mcp_config.json'),
        devin: join(tmpHome, 'AppData', 'Roaming', 'devin', 'mcp_config.json'),
      };
      const p = paths[client];
      mkdirSync(resolve(p, '..'), { recursive: true });
      writeFileSync(p, content);
      return p;
    }

    function claudeConfig(): string {
      return `${JSON.stringify(
        { mcpServers: { playwright: { type: 'stdio', command: 'npx', args: PW_ARGS(profile), env: {} } } },
        null,
        2,
      )}\n`;
    }

    function codexConfig(): string {
      const prof = profile.replace(/\\/g, '/');
      return [
        'model = "gpt-5"',
        '',
        '[mcp_servers.playwright]',
        'command = "npx"',
        `args = ["-y", "@playwright/mcp@0.0.80", "--user-data-dir", "${prof}", "--browser", "chrome"]`,
        '',
        '[mcp_servers.other]',
        'command = "foo"',
        'args = ["bar"]',
        '',
      ].join('\n');
    }

    function jsoncConfig(): string {
      return `${JSON.stringify(
        {
          mcp: { playwright: { type: 'local', command: ['npx', ...PW_ARGS(profile)], enabled: true } },
        },
        null,
        2,
      )}\n`;
    }

    function agyConfig(): string {
      return `${JSON.stringify(
        { mcpServers: { playwright: { command: 'npx', args: PW_ARGS(profile), disabled: false } } },
        null,
        2,
      )}\n`;
    }

    function devinConfig(): string {
      return `${JSON.stringify(
        { mcpServers: { playwright: { command: 'npx', args: PW_ARGS(profile), transport: 'stdio' } } },
        null,
        2,
      )}\n`;
    }

    // -- injected deps ------------------------------------------------------

    interface ExecCall {
      cmd: string;
      args: string[];
    }

    function makeDeps(opts: { cookies?: any[]; chromeProcs?: Array<{ pid: number; cmdline: string }>; execImpl?: any } = {}) {
      const execCalls: ExecCall[] = [];
      const deps = {
        exec: async (cmd: string, args: string[]) => {
          execCalls.push({ cmd, args });
          if (opts.execImpl) return opts.execImpl(cmd, args);
          return { code: 0, stdout: '', stderr: '', enoent: false };
        },
        listChrome: async () => opts.chromeProcs ?? [],
        connect: async () => ({
          send: async () => ({ cookies: opts.cookies ?? COOKIE_FIXTURE }),
          close: async () => {},
        }),
        runDoctor: async () => ({ verdict: 'PASS' }),
        ensureChrome: async () => ({ ok: true, endpoint: 'http://127.0.0.1:9333', port: 9333, pid: null, startedByUs: false }),
        now: () => '2026-09-20T10:00:00.000Z',
      };
      return { deps, execCalls };
    }

    function gate(gates: any[], id: string): any {
      return gates.find((g) => g.id === id);
    }

    // -- tests --------------------------------------------------------------

    it('preflight passes on a clean fixture', async () => {
      writeConfig('claude', claudeConfig());
      const { deps } = makeDeps();
      const r = await cutover.preflight('claude', deps);
      assert.equal(r.verdict, 'PASS');
      const ids = r.gates.map((g: any) => g.id);
      assert.deepEqual(ids, ['G1 entry-present', 'G2 profile-same', 'G3 profile-not-default', 'G4 no-foreign-holder', 'G5 endpoint-profile']);
      for (const g of r.gates) assert.equal(g.status, 'PASS', `${g.id}: ${g.detail}`);
    });

    it('G2 fails when the playwright entry uses another profile dir', async () => {
      writeConfig('claude', claudeConfig());
      const other = join(baseDir, 'other-profile');
      writeFileSync(
        join(wingmanHome, 'config.json'),
        `${JSON.stringify({ profile_dir: other, port: 9333 }, null, 2)}\n`,
      );
      const { deps } = makeDeps();
      const r = await cutover.preflight('claude', deps);
      assert.equal(r.verdict, 'FAIL');
      assert.equal(gate(r.gates, 'G2 profile-same').status, 'FAIL');
    });

    it('G4 fails on a holder without a debug port and kills nothing', async () => {
      writeConfig('claude', claudeConfig());
      const { deps, execCalls } = makeDeps({
        chromeProcs: [{ pid: 4242, cmdline: `chrome.exe --user-data-dir=${profile} --no-sandbox` }],
      });
      const r = await cutover.preflight('claude', deps);
      assert.equal(r.verdict, 'FAIL');
      const g4 = gate(r.gates, 'G4 no-foreign-holder');
      assert.equal(g4.status, 'FAIL');
      assert.ok(g4.detail.includes('4242'), g4.detail);
      assert.ok(g4.detail.includes('close that browser; this tool never kills it'), g4.detail);
      // kills nothing: no external command ran at all (killTree is never reachable here)
      assert.equal(execCalls.length, 0);
    });

    it('an already wrapped entry is refused', async () => {
      writeConfig(
        'claude',
        `${JSON.stringify(
          {
            mcpServers: {
              playwright: {
                type: 'stdio',
                command: 'jev-browser-wingman',
                args: ['with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome'],
                env: {},
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const { deps } = makeDeps();
      const r = await cutover.preflight('claude', deps);
      assert.equal(r.refused, 'already-wrapped');
      const code = await cutover.runCli(['preflight', '--client', 'claude']);
      assert.equal(code, 3);
    });

    it('snapshot stores the entry, the file bytes and a cookie count but no cookie values or domains', async () => {
      const file = writeConfig('claude', claudeConfig());
      const { deps } = makeDeps();
      const r = await cutover.snapshot('claude', deps);
      assert.equal(r.snapshot, 'claude-20260920T100000Z');
      assert.equal(r.cookies, 2);
      const dir = join(wingmanHome, 'cutover', r.snapshot);
      const entry = JSON.parse(readFileSync(join(dir, 'entry.json'), 'utf8'));
      assert.equal(entry.command, 'npx');
      assert.equal(JSON.parse(readFileSync(join(dir, 'wingman-entry.json'), 'utf8')), null);
      assert.equal(readFileSync(join(dir, 'file.bytes'), 'utf8'), readFileSync(file, 'utf8'));
      assert.equal(
        readFileSync(join(dir, 'file.sha256'), 'utf8').trim(),
        createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex'),
      );
      const baseline = JSON.parse(readFileSync(join(dir, 'cookies-baseline.json'), 'utf8'));
      assert.equal(baseline.count, 2);
      assert.equal(baseline.pairs_sha256, createHash('sha256').update('a.example|sid\nb.example|sess').digest('hex'));
      // no cookie values, no domains anywhere in the snapshot dir
      for (const f of readdirSync(dir)) {
        const text = readFileSync(join(dir, f), 'utf8');
        for (const needle of ['cookie-value-a', 'cookie-value-b', 'a.example', 'b.example']) {
          assert.ok(!text.includes(needle), `${f} leaks ${needle}`);
        }
      }
    });

    it('print-apply shows the wrapped entry and the wingman entry', async () => {
      writeConfig('claude', claudeConfig());
      const { deps } = makeDeps();
      const snap = await cutover.snapshot('claude', deps);
      const r = await cutover.printApply('claude', snap.snapshot, deps);
      assert.equal(r.before.command, 'npx');
      assert.equal(r.after.command, 'jev-browser-wingman');
      assert.deepEqual(r.after.args, ['with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']);
      assert.equal(r.wingman_before, null);
      assert.deepEqual(r.wingman_after, { type: 'stdio', command: 'jev-browser-wingman', args: ['mcp'], env: {} });
    });

    it('apply refuses without an approval note', async () => {
      writeConfig('claude', claudeConfig());
      const { deps } = makeDeps();
      const snap = await cutover.snapshot('claude', deps);
      const r = await cutover.apply('claude', snap.snapshot, undefined, deps);
      assert.equal(r.refused, 'CUTOVER-REFUSED: operator approval note required');
      const rb = await cutover.rollback('claude', snap.snapshot, undefined, deps);
      assert.ok(String(rb.refused).includes('operator approval note required'));
    });

    it('apply refuses when the entry changed since the snapshot', async () => {
      writeConfig('claude', claudeConfig());
      const { deps } = makeDeps();
      const snap = await cutover.snapshot('claude', deps);
      // mutate the live entry after the snapshot (an args change is a V1-sense change)
      writeConfig(
        'claude',
        `${JSON.stringify(
          {
            mcpServers: {
              playwright: { type: 'stdio', command: 'npx', args: [...PW_ARGS(profile), '--headless'], env: {} },
            },
          },
          null,
          2,
        )}\n`,
      );
      const r = await cutover.apply('claude', snap.snapshot, 'go', deps);
      assert.equal(r.refused, 'CUTOVER-REFUSED: entry changed since snapshot');
    });

    it('apply on claude runs remove then add-json with the pinned JSON', async () => {
      const file = writeConfig('claude', claudeConfig());
      // exec stub with `claude mcp` semantics so the follow-up verify sees the write
      const execImpl = async (cmd: string, args: string[]) => {
        if (cmd === 'claude' && args[0] === 'mcp') {
          const obj = JSON.parse(readFileSync(file, 'utf8'));
          obj.mcpServers = obj.mcpServers ?? {};
          if (args[1] === 'remove') delete obj.mcpServers[args[2]];
          else if (args[1] === 'add-json') obj.mcpServers[args[2]] = JSON.parse(args[3]);
          writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
        }
        return { code: 0, stdout: '', stderr: '', enoent: false };
      };
      const { deps, execCalls } = makeDeps({ execImpl });
      const snap = await cutover.snapshot('claude', deps);
      const r = await cutover.apply('claude', snap.snapshot, 'operator go', deps);
      assert.equal(r.applied, true);
      assert.equal(r.verify.verdict, 'PASS');
      const pw = execCalls.filter((c) => c.args[2] === 'playwright' || c.args[2] === 'jev-browser-wingman');
      assert.deepEqual(pw.map((c) => [c.cmd, c.args[1], c.args[2]]), [
        ['claude', 'remove', 'playwright'],
        ['claude', 'add-json', 'playwright'],
        ['claude', 'add-json', 'jev-browser-wingman'],
      ]);
      assert.equal(
        pw[1].args[3],
        '{"type":"stdio","command":"jev-browser-wingman","args":["with-chrome","--","npx","-y","@playwright/mcp@0.0.80","--browser","chrome"],"env":{}}',
      );
      assert.equal(pw[2].args[3], '{"type":"stdio","command":"jev-browser-wingman","args":["mcp"],"env":{}}');
    });

    it('apply on codex rewrites only the playwright table and appends the wingman table', async () => {
      const file = writeConfig('codex', codexConfig());
      const { deps } = makeDeps();
      const snap = await cutover.snapshot('codex', deps);
      const r = await cutover.apply('codex', snap.snapshot, 'operator go', deps);
      assert.equal(r.applied, true, JSON.stringify(r));
      assert.equal(r.verify.verdict, 'PASS');
      const text = readFileSync(file, 'utf8');
      assert.ok(text.includes('model = "gpt-5"'));
      assert.ok(/\[mcp_servers\.playwright\]\r?\ncommand = "jev-browser-wingman"\r?\nargs = \["with-chrome", "--", "npx", "-y", "@playwright\/mcp@0\.0\.80", "--browser", "chrome"\]\r?\nstartup_timeout_sec = 60/.test(text), text);
      assert.ok(!text.includes('user-data-dir'), 'the user-data-dir pair must be stripped');
      // the other table is byte-identical
      assert.ok(text.includes('[mcp_servers.other]\ncommand = "foo"\nargs = ["bar"]'), text);
      assert.ok(text.includes('[mcp_servers.jev-browser-wingman]\ncommand = "jev-browser-wingman"\nargs = ["mcp"]\ntool_timeout_sec = 90'), text);
    });

    it('apply on opencode, agy and devin writes both entries', async () => {
      const cases: Array<[string, string, () => string]> = [
        ['opencode', '.config/opencode/opencode.jsonc', jsoncConfig],
        ['agy', '.gemini/config/mcp_config.json', agyConfig],
        ['devin', 'AppData/Roaming/devin/mcp_config.json', devinConfig],
      ];
      for (const [client, relPath, make] of cases) {
        const file = writeConfig(client, make());
        const { deps } = makeDeps();
        const snap = await cutover.snapshot(client, deps);
        const r = await cutover.apply(client, snap.snapshot, 'operator go', deps);
        assert.equal(r.applied, true, `${client}: ${JSON.stringify(r)}`);
        assert.equal(r.verify.verdict, 'PASS', `${client}: ${JSON.stringify(r.verify)}`);
        const text = readFileSync(file, 'utf8');
        const obj = JSON.parse(text);
        const servers = client === 'opencode' ? obj.mcp : obj.mcpServers;
        if (client === 'opencode') {
          assert.deepEqual(servers.playwright.command, [
            'jev-browser-wingman',
            'with-chrome',
            '--',
            'npx',
            '-y',
            '@playwright/mcp@0.0.80',
            '--browser',
            'chrome',
          ]);
          assert.equal(servers.playwright.enabled, true);
          assert.deepEqual(servers['jev-browser-wingman'].command, ['jev-browser-wingman', 'mcp']);
        } else {
          assert.equal(servers.playwright.command, 'jev-browser-wingman');
          assert.deepEqual(servers.playwright.args, ['with-chrome', '--', 'npx', '-y', '@playwright/mcp@0.0.80', '--browser', 'chrome']);
          assert.deepEqual(servers['jev-browser-wingman'].args, ['mcp']);
        }
        assert.ok(text.endsWith('\n'), `${client}: trailing newline`);
        assert.ok(text.startsWith('{\n  "'), `${client}: 2-space indent`);
        assert.equal(existsSync(`${file}.tmp-`), false);
      }
    });

    it('apply refuses an opencode config with comments', async () => {
      writeConfig(
        'opencode',
        `// operator note: keep the schema line\n${jsoncConfig()}`,
      );
      const { deps } = makeDeps();
      const snap = await cutover.snapshot('opencode', deps);
      const r = await cutover.apply('opencode', snap.snapshot, 'operator go', deps);
      assert.ok(String(r.refused).includes('has comments; edit by hand'), JSON.stringify(r));
    });

    it('verify original after rollback passes', async () => {
      const file = writeConfig('claude', claudeConfig());
      const execImpl = async (cmd: string, args: string[]) => {
        if (cmd === 'claude' && args[0] === 'mcp') {
          const obj = JSON.parse(readFileSync(file, 'utf8'));
          obj.mcpServers = obj.mcpServers ?? {};
          if (args[1] === 'remove') delete obj.mcpServers[args[2]];
          else if (args[1] === 'add-json') obj.mcpServers[args[2]] = JSON.parse(args[3]);
          writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`);
        }
        return { code: 0, stdout: '', stderr: '', enoent: false };
      };
      const { deps } = makeDeps({ execImpl });
      const snap = await cutover.snapshot('claude', deps);
      const applied = await cutover.apply('claude', snap.snapshot, 'operator go', deps);
      assert.equal(applied.applied, true);
      const rb = await cutover.rollback('claude', snap.snapshot, 'operator go', deps);
      assert.equal(rb.rolledBack, true, JSON.stringify(rb));
      assert.equal(rb.verify.verdict, 'PASS');
      const obj = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(obj.mcpServers.playwright.command, 'npx');
      assert.deepEqual(obj.mcpServers.playwright.args, PW_ARGS(profile));
      assert.equal(obj.mcpServers['jev-browser-wingman'], undefined);
      assert.ok(readFileSync(file, 'utf8').includes('"--user-data-dir"'), 'original entry restored');
    });

    it('V3 fails when the MCP report is not the default context', async () => {
      writeConfig('codex', codexConfig());
      const { deps } = makeDeps();
      const snap = await cutover.snapshot('codex', deps);
      const applied = await cutover.apply('codex', snap.snapshot, 'operator go', deps);
      assert.equal(applied.applied, true);
      const report = join(baseDir, 'mcp-report.json');
      writeFileSync(report, `${JSON.stringify({ isDefault: false, cookies: 2 }, null, 2)}\n`);
      const r = await cutover.verify('codex', snap.snapshot, 'wrapped', { mcpReport: report }, deps);
      assert.equal(r.verdict, 'FAIL');
      assert.equal(gate(r.gates, 'V3 state-survives').status, 'FAIL');
      assert.ok(gate(r.gates, 'V3 state-survives').detail.toLowerCase().includes('default context'));
    });

    it('V3 fails when cookies drop below 90 percent of the baseline', async () => {
      writeConfig('codex', codexConfig());
      const { deps } = makeDeps({ cookies: COOKIE_FIXTURE_TEN });
      const snap = await cutover.snapshot('codex', deps);
      assert.equal(snap.cookies, 10);
      const applied = await cutover.apply('codex', snap.snapshot, 'operator go', deps);
      assert.equal(applied.applied, true);
      const report = join(baseDir, 'mcp-report.json');
      writeFileSync(report, `${JSON.stringify({ isDefault: true, cookies: 5 }, null, 2)}\n`);
      const r = await cutover.verify('codex', snap.snapshot, 'wrapped', { mcpReport: report }, deps);
      assert.equal(r.verdict, 'FAIL');
      const v3 = gate(r.gates, 'V3 state-survives');
      assert.equal(v3.status, 'FAIL');
      assert.ok(v3.detail.includes('90 percent'), v3.detail);
      // discrimination: at baseline the same gate passes
      writeFileSync(report, `${JSON.stringify({ isDefault: true, cookies: 10 }, null, 2)}\n`);
      const ok = await cutover.verify('codex', snap.snapshot, 'wrapped', { mcpReport: report }, deps);
      assert.equal(gate(ok.gates, 'V3 state-survives').status, 'PASS');
    });
  });
}
