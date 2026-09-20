import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { applyAdditive, KeyCollisionError } from './coexistence.js';
import { paHome } from '../paths.js';
import { writeFileAtomic } from './atomic-write.js';

/** CLI-config home for the ladder's default surfaces (deliberately the user
 *  home, not PA_HOME). */
function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/**
 * Capability ladder (Wave C / WP-C3, spec
 * plans/2026-09-17-public-install-package-WAVE-C-SPEC.md §WP-C3 + D11 + D12).
 *
 * `pa init --provision` runs this ladder after scaffolding:
 *   1. discover()  — probe PATH for claude/codex/opencode/devin; probe env for
 *      API keys BY PRESENCE ONLY (values are never read out, never printed).
 *   2. ask()       — one typed question set per found/existing CLI; collision
 *      answers route here from the coexistence engine's KeyCollisionError.
 *      2b. keys-only branch (D12b): only API keys + a provider link, no CLI on
 *          PATH → install a harness that accepts base-URL + key directly.
 *      2c. escape hatch (D12c): every ask ends with "something else? describe
 *          it" — a user-described setup maps to the nearest supported shape;
 *          the user's answer outranks the offered defaults.
 *   3. configure() — wire the chosen set via the WP-C2 coexistence engine
 *      (registered, reversible, additive; never overwrites a user key).
 *   4. preserve ask (C4/D11) — optional copy of the assistant's own changes
 *      via git_workflow.enabled; destination is the USER'S fork opened as a
 *      PR against the public repository, never a direct push.
 *   5. degraded floor — zero workers provisioned: install completes and says
 *      so plainly ("your assistant runs but can't think yet") + how to add a
 *      worker later.
 *
 * Delivery floor: the local-file outbox (~/.pa/outbox/) is created
 * regardless of Telegram; Telegram is configured only if the user opted in.
 *
 * Generated config carries ZERO operator paths: every generated blob passes
 * assertNoOperatorPaths against the A6 placeholder pattern set and — on a
 * machine where the Wave A pattern file exists — the real pattern set (G5
 * re-gate).
 */

/** The four public ladder rows (D2/D7). Operator-private CLIs (agy, zclaude,
 *  kgclaude) are deliberately absent — they are not public ladder rows. */
export const LADDER_CLIS = ['claude', 'codex', 'opencode', 'devin'] as const;
export type LadderCli = (typeof LADDER_CLIS)[number];

/** Free tier ordering per D7: opencode first-class, Devin best-effort. */
export const FREE_TIER_ORDER: LadderCli[] = ['opencode', 'devin'];

/** API-key env names probed by presence only — never values. */
export const KEY_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
] as const;

export const DEGRADED_FLOOR_MESSAGE = "Your assistant runs but can't think yet";
export const DEGRADED_FLOOR_HINT =
  'No worker CLI was connected, so your assistant can run skills but cannot think yet. ' +
  'To add thinking later: install a CLI such as opencode (free tier) and run `pa init --provision` again.';

export const ESCAPE_HATCH_PROMPT = 'something else? describe it';
export const FORK_PR_NOTE =
  'Preserved changes go to YOUR OWN fork and open a pull request against the public repository ' +
  '(the main branch is gated; contributions arrive as pull requests only).';
export const PRESERVE_VIA_NOTE = 'Changes are preserved through the git-workflow skills, never raw git.';
export const OUTBOX_FLOOR_NOTE =
  'Delivery floor: notifications also land as local files under ~/.pa/outbox/ — no Telegram account is required.';

export interface DiscoveredCli {
  name: LadderCli;
  onPath: boolean;
}

export interface Discovery {
  clis: DiscoveredCli[];
  /** API-key env names PRESENT in the environment — names only, never values. */
  keys: string[];
}

export interface ProvisionIo {
  print(line: string): void;
  ask(question: string): Promise<string>;
}

/** A6 placeholder pattern set (spec §1) — the pre-Wave-A stand-in. SHAPE
 *  classes only: this file is public-tracked, so it must never carry a real
 *  operator name — those live in the private operator-identifiers.txt that
 *  loadOperatorPatterns() reads (the G5 re-gate asserts them). */
export const PLACEHOLDER_PATH_PATTERNS: RegExp[] = [
  /D:\\/i,
  /C:\\Users\\/i,
  /\d{9,}/, // chat-id shape: 9 or more consecutive digits
];

/** Load the real Wave A operator pattern set (~/.pa/operator-identifiers.txt,
 *  one Python regex per line, '#' comments). Returns [] when the file is
 *  absent — the placeholder set covers the pre-Wave-A case. NOTE: this reads
 *  the OPERATOR-MACHINE pattern file under the real user home, deliberately
 *  NOT PA_HOME — it is a placement input, not runtime state, and tests run
 *  with PA_HOME pointed at temp dirs. Used by the G5 re-gate; the real set is
 *  a superset of the placeholders by design. */
export function loadOperatorPatterns(path?: string): RegExp[] {
  const file = path ?? join(homeDir(), '.pa', 'operator-identifiers.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      try {
        return new RegExp(line, 'i');
      } catch {
        return null;
      }
    })
    .filter((re): re is RegExp => re !== null);
}

/** Throws on ANY operator-path-shaped substring in generated config text.
 *  `extraPatterns` extends the placeholder set (the real A6 set on re-gate). */
export function assertNoOperatorPaths(text: string, extraPatterns: RegExp[] = []): void {
  for (const re of [...PLACEHOLDER_PATH_PATTERNS, ...extraPatterns]) {
    if (re.test(text)) {
      throw new Error(`generated config contains an operator-path-shaped value (matched ${re.source})`);
    }
  }
}

async function probeOnPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: 10_000, windowsHide: true }, (err) => {
      // Err absent = found on PATH and ran; ENOENT / non-zero exit / timeout
      // all count as absent — presence on PATH is the only ladder signal.
      resolve(!err);
    });
  });
}

/** Step 1 — discover. Probe PATH for the four ladder CLIs and the environment
 *  for API keys by presence only. Injectable for tests: `probe` and `env`. */
export async function discover(
  probe: (cmd: string) => Promise<boolean> = probeOnPath,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Discovery> {
  const clis = await Promise.all(
    LADDER_CLIS.map(async (name): Promise<DiscoveredCli> => ({ name, onPath: await probe(name) })),
  );
  const keys = KEY_ENV_NAMES.filter((k) => {
    const v = env[k];
    return typeof v === 'string' && v.length > 0;
  });
  return { clis, keys };
}

/** Per-CLI default config surfaces (absolute paths resolved at call time) and
 *  the additive MCP key each registers. The injection seam keeps tests offline
 *  and lets a platform pack override a surface path later. */
export function defaultSurface(cli: LadderCli): string {
  const home = homeDir();
  switch (cli) {
    case 'claude':
      return join(home, '.claude', 'settings.json');
    case 'opencode':
      return join(home, '.config', 'opencode', 'opencode.jsonc');
    case 'codex':
      return join(home, '.codex', 'mcp.json');
    case 'devin':
      return join(home, '.config', 'devin', 'mcp.json');
  }
}

export function defaultMcpEntry(cli: LadderCli): { key: string; value: unknown } {
  const server = { command: 'pa', args: ['mcp', 'serve'] };
  switch (cli) {
    case 'claude':
      return { key: 'mcpServers.pa-mcp', value: server };
    case 'opencode':
      return { key: 'mcp.pa-mcp', value: server };
    case 'codex':
      return { key: 'mcp_servers.pa-mcp', value: server };
    case 'devin':
      return { key: 'mcpServers.pa-mcp', value: server };
  }
}

export type ConfigureReason = 'accepted-existing' | 'free-tier' | 'keys-only';

export interface ConfigureOutcome {
  ok: boolean;
  detail: string;
}

/** WP-P1: the jev-browser-wingman MCP entry per CLI (§ 3.16, C7). Additive
 *  only — never registered unconditionally, because before npm publish the
 *  command may not exist on PATH (probed by probeWingmanOnPath). */
export function wingmanMcpEntry(cli: LadderCli): { key: string; value: unknown } {
  switch (cli) {
    case 'claude':
      return { key: 'mcpServers.jev-browser-wingman', value: { command: 'jev-browser-wingman', args: ['mcp'] } };
    case 'opencode':
      return { key: 'mcp.jev-browser-wingman', value: { command: 'jev-browser-wingman', args: ['mcp'] } };
    case 'devin':
      return { key: 'mcpServers.jev-browser-wingman', value: { command: 'jev-browser-wingman', args: ['mcp'] } };
    case 'codex':
      return {
        key: 'mcp_servers.jev-browser-wingman',
        value: { command: 'jev-browser-wingman', args: ['mcp'], tool_timeout_sec: 90 },
      };
  }
}

/** Presence-only probe for the wingman command, run through a shell on
 *  win32 because npm-link shims are `.cmd` files that execFile cannot start
 *  directly (C7, mirroring provision.ts:138-146's probeOnPath). */
export async function probeWingmanOnPath(run: typeof execFile = execFile): Promise<boolean> {
  return new Promise((resolve) => {
    run(
      'jev-browser-wingman',
      ['--version'],
      { shell: process.platform === 'win32', windowsHide: true, timeout: 10_000 },
      (err) => resolve(!err),
    );
  });
}

/** Default configure step: additive MCP registration through the WP-C2
 *  coexistence engine (snapshot → additive keys → registry row). A
 *  KeyCollisionError propagates to the caller, which routes it to the ask
 *  flow — never an overwrite. Devin free-tier is best-effort per D7: report,
 *  never block. The wingman entry is added only when probeWingman() finds
 *  the command on PATH; a collision on the wingman key alone retries with
 *  just the pa-mcp entry so an already-registered wingman never blocks
 *  pa-mcp's own registration (C7). */
export async function defaultConfigureCli(
  cli: LadderCli,
  reason: ConfigureReason,
  deps: { probeWingman: () => Promise<boolean>; apply: typeof applyAdditive } = {
    probeWingman: probeWingmanOnPath,
    apply: applyAdditive,
  },
): Promise<ConfigureOutcome> {
  if (reason === 'free-tier' && cli === 'devin') {
    return { ok: false, detail: 'devin CLI not set up — best-effort row skipped (never blocks)' };
  }
  const surface = defaultSurface(cli);
  const paEntry = defaultMcpEntry(cli);
  const wEntry = wingmanMcpEntry(cli);
  const entries = (await deps.probeWingman()) ? [paEntry, wEntry] : [paEntry];
  try {
    const result = await deps.apply(cli, surface, entries);
    return { ok: true, detail: `registered ${result.added.join(', ')} in ${surface}` };
  } catch (err) {
    if (err instanceof KeyCollisionError && err.keys.length === 1 && err.keys[0] === wEntry.key) {
      const result = await deps.apply(cli, surface, [paEntry]);
      return { ok: true, detail: `registered ${result.added.join(', ')} in ${surface}; jev-browser-wingman already registered` };
    }
    throw err;
  }
}

/** D12c: map a user-described setup onto the nearest supported shape. The
 *  description always wins over the offered defaults. */
export type LadderShape =
  | { kind: 'connect'; cli: LadderCli }
  | { kind: 'keys-only' }
  | { kind: 'free-tier'; cli: LadderCli }
  | { kind: 'degraded' };

export function classifyDescription(description: string, keysPresent: boolean): LadderShape {
  const d = description.toLowerCase();
  if (d.includes('opencode')) return { kind: 'free-tier', cli: 'opencode' };
  if (d.includes('devin')) return { kind: 'free-tier', cli: 'devin' };
  for (const cli of LADDER_CLIS) {
    if (d.includes(cli)) return { kind: 'connect', cli };
  }
  if (d.includes('key') || d.includes('api') || d.includes('base url') || d.includes('endpoint')) {
    return { kind: 'keys-only' };
  }
  return keysPresent ? { kind: 'keys-only' } : { kind: 'free-tier', cli: 'opencode' };
}

export interface ProvisionResult {
  state: 'configured' | 'degraded-floor';
  provisioned: LadderCli[];
  /** Collisions surfaced through the ask flow (never overwritten). */
  collisions: { cli: LadderCli; keys: string[] }[];
  gitWorkflow: boolean;
  /** Verbatim transcript of everything printed — test seam (G7 asserts the
   *  degraded-floor message verbatim against this). */
  transcript: string[];
}

export interface ProvisionOptions {
  io: ProvisionIo;
  discovery: Discovery;
  /** Test seam; defaults to the coexistence-engine-backed defaultConfigureCli. */
  configure?: (cli: LadderCli, reason: ConfigureReason) => Promise<ConfigureOutcome>;
  /** Directory the generated config lands in (defaults to PA_HOME). */
  paHomeDir?: string;
  /** Extra operator-path patterns for the generated-config gate (real A6 set
   *  on the Wave-A-complete re-gate). */
  extraPatterns?: RegExp[];
}

/** One typed question with the escape hatch (D12c) always available. Returns
 *  'yes'/'no' for a plain answer, or the LadderShape the user described. */
async function askWithEscape(
  io: ProvisionIo,
  question: string,
  keysPresent: boolean,
): Promise<'yes' | 'no' | LadderShape> {
  const answer = (await io.ask(`${question} (yes/no, or: ${ESCAPE_HATCH_PROMPT})`)).trim();
  const lowered = answer.toLowerCase();
  if (lowered.startsWith('y')) return 'yes';
  if (lowered.startsWith('n')) return 'no';
  // Anything else — treat the free text as the user's described setup.
  return classifyDescription(answer, keysPresent);
}

/** Run the ladder. Never throws for user-level outcomes — every branch ends in
 *  a state; only programmer/environment errors propagate. */
export async function runProvisionLadder(opts: ProvisionOptions): Promise<ProvisionResult> {
  const io = opts.io;
  const transcript: string[] = [];
  const print = (line: string) => {
    transcript.push(line);
    io.print(line);
  };
  const configure = opts.configure ?? defaultConfigureCli;
  const keysPresent = opts.discovery.keys.length > 0;
  const provisioned: LadderCli[] = [];
  const collisions: ProvisionResult['collisions'] = [];
  let acceptedAny = false;

  const found = opts.discovery.clis.filter((c) => c.onPath);

  /** Configure with the collision rule wired at the call site: a
   *  KeyCollisionError routes to the ask flow — never an overwrite. */
  async function tryConfigure(cli: LadderCli, reason: ConfigureReason): Promise<boolean> {
    try {
      const outcome = await configure(cli, reason);
      if (outcome.ok) {
        provisioned.push(cli);
        acceptedAny = true;
        print(`[+] connected ${cli} (${outcome.detail})`);
        return true;
      }
      print(`[!] ${cli}: ${outcome.detail}`);
      return false;
    } catch (err) {
      if (err instanceof KeyCollisionError) {
        collisions.push({ cli, keys: err.keys });
        print(`PA found existing settings for ${cli} it will not overwrite: ${err.keys.join(', ')}.`);
        const answer = await askWithEscape(
          io,
          'keep your existing settings and skip this connection?',
          keysPresent,
        );
        if (answer === 'yes') {
          print(`[i] kept your ${cli} settings; nothing was changed.`);
        } else if (answer === 'no') {
          print(`[i] skipping ${cli} for now; you can connect it later.`);
        } else {
          await applyShape(answer);
        }
        return false;
      }
      throw err;
    }
  }

  async function applyShape(shape: LadderShape): Promise<void> {
    if (shape.kind === 'connect') {
      await tryConfigure(shape.cli, 'accepted-existing');
    } else if (shape.kind === 'keys-only') {
      await keysOnlyBranch();
    } else if (shape.kind === 'free-tier') {
      await provisionFreeTier(shape.cli);
    } else {
      print('[i] keeping the default setup — run `pa init --provision` again any time.');
    }
  }

  // Step 2b — D12b keys-only branch: entry condition is key presence with
  // ZERO configured CLIs accepted.
  async function keysOnlyBranch(): Promise<void> {
    if (provisioned.length > 0) return;
    print('You have an API key but no assistant CLI on PATH. A harness that works directly with a base URL and a key can be set up.');
    const answer = await askWithEscape(io, 'set up opencode as your assistant harness?', keysPresent);
    if (answer === 'yes') {
      await provisionFreeTier('opencode');
    } else if (answer === 'no') {
      print('[i] skipped. Your key stays in your environment; nothing was written.');
    } else {
      await applyShape(answer);
    }
  }

  // Free-tier fallback: opencode first-class, Devin best-effort (D7).
  async function provisionFreeTier(cli: LadderCli): Promise<void> {
    await tryConfigure(cli, cli === 'devin' ? 'free-tier' : 'keys-only');
  }

  // Step 2 — ask about each discovered CLI.
  for (const cli of found) {
    const answer = await askWithEscape(io, `you already use ${cli.name} — may the assistant connect to it?`, keysPresent);
    if (answer === 'yes') {
      await tryConfigure(cli.name, 'accepted-existing');
    } else if (answer === 'no') {
      // declined — nothing to do
    } else {
      // User-described setup outranks the default question (D12c).
      await applyShape(answer);
      break;
    }
  }
  if (!found.length) {
    print('No assistant CLIs found on PATH.');
  }

  // Nothing accepted → keys-only branch (if keys exist), else the free-tier
  // fallback offer: opencode first-class, Devin best-effort.
  if (!acceptedAny && provisioned.length === 0) {
    if (keysPresent) {
      await keysOnlyBranch();
    } else {
      print('No assistant CLIs or API keys found. Free tiers are available:');
      print('  - opencode: free tier, first-class support.');
      print('  - devin:    free tier, best-effort (attempted, never blocks).');
      const answer = await askWithEscape(io, 'provision the free tiers now?', keysPresent);
      if (answer === 'yes') {
        for (const cli of FREE_TIER_ORDER) {
          await provisionFreeTier(cli);
        }
      } else if (answer === 'no') {
        print('[i] skipped free-tier setup.');
      } else {
        await applyShape(answer);
      }
    }
  }

  // Step 4 — preserve ask (C4, D11). Asked once.
  const preserveAnswer = (await io.ask("keep a copy of your assistant's own changes? (yes/no)")).trim().toLowerCase();
  const gitWorkflow = preserveAnswer.startsWith('y');
  if (gitWorkflow) {
    print(PRESERVE_VIA_NOTE);
    print(FORK_PR_NOTE);
  }

  // Delivery floor (D4): the local outbox exists regardless of Telegram.
  const home = opts.paHomeDir ?? paHome();
  mkdirSync(join(home, 'outbox'), { recursive: true });
  print(OUTBOX_FLOOR_NOTE);

  // Step 5 — degraded floor. Loud, plain language; install still completes.
  if (provisioned.length === 0) {
    print(DEGRADED_FLOOR_MESSAGE);
    print(DEGRADED_FLOOR_HINT);
    return { state: 'degraded-floor', provisioned: [], collisions, gitWorkflow, transcript };
  }

  // Generate the worker config for everything provisioned. The generated
  // config carries ZERO operator paths (placeholder set + any re-gate set).
  const config = generateWorkerConfig(provisioned);
  assertNoOperatorPaths(config, opts.extraPatterns ?? []);
  await writeFileAtomic(join(home, 'config.yaml.provisioned'), config);
  print(
    `[+] wrote ${join(home, 'config.yaml.provisioned')} — review it, then merge the workers: block into ~/.pa/config.yaml.`,
  );
  return { state: 'configured', provisioned, collisions, gitWorkflow, transcript };
}

/** Worker rows for the provisioned set. Command values are PATH names — the
 *  config-time resolution emits per-OS command values and never absolute
 *  operator paths. API keys are referenced by env NAME only, never a value. */
export function generateWorkerConfig(provisioned: LadderCli[]): string {
  const rows = provisioned
    .map((name, i) => {
      switch (name) {
        case 'claude':
          return `  - name: claude
    command: claude
    args: ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]
    input_mode: stdin-json
    output_format: stream-json
    check: claude --version
    priority: ${i + 1}`;
        case 'codex':
          return `  - name: codex
    command: codex
    args: ["exec", "--color", "never", "--json", "-"]
    input_mode: stdin-text
    output_format: stream-json
    check: codex --version
    priority: ${i + 1}`;
        case 'opencode':
          return `  # opencode free tier — reads your API key from the environment
  # (OPENAI_API_KEY / ANTHROPIC_API_KEY or a provider-specific env var).
  # PA never writes your key into this file.
  - name: opencode
    command: opencode
    args: ["run", "{prompt}"]
    input_mode: arg
    output_format: plain-text
    check: opencode --version
    priority: ${i + 1}`;
        case 'devin':
          return `  - name: devin
    command: devin
    args: ["--prompt-file", "{prompt_file}", "-p", "--respect-workspace-trust", "false", "--permission-mode", "dangerous"]
    input_mode: arg
    output_format: plain-text
    check: devin --version
    manual_only: true
    priority: ${i + 1}`;
      }
    })
    .join('\n');
  return `# Generated by 'pa init --provision'. Review before merging into ~/.pa/config.yaml.
# Worker commands resolve from PATH — adjust per platform if a CLI is not on it.
workers:
${rows}
`;
}
