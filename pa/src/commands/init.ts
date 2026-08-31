import { mkdir, writeFile, access } from 'fs/promises';
import { configPath, secretsPath, skillsDir, logsDir, draftsDir, paHome } from '../paths.js';
import { loadSecrets } from '../secrets.js';
import { notifyUser } from '../lib/notify.js';

const DEFAULT_CONFIG = `
# Adjust command paths for your system (e.g. absolute paths or .cmd extensions on Windows)
workers:
  - name: claude
    command: claude
    args: ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]
    input_mode: stdin-json
    output_format: stream-json
    check: claude --version
    rate_limit_patterns:
      - "rate limit"
      - "token limit"
      - "quota exceeded"
      - "Usage limit"
      - "over your limit"
      - "hit your limit"
    priority: 1
    state_dir: "~/.claude/projects"
    state_pattern: "*.jsonl"
    # secret_allowlist: []  # Uncomment and list secrets this worker may access
    tunables:
      model:
        args: ["--model", "{value}"]
        description: "Model name passed to the CLI (e.g. opusplan, opus, sonnet)."
      effort:
        args: ["--effort", "{value}"]
        values: [low, medium, high, xhigh, max]
        description: "Effort level for the session (Claude Code 2.x --effort)."

  - name: codex
    command: codex
    args: ["exec", "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "--json", "-"]
    input_mode: stdin-text
    output_format: stream-json
    check: codex --version
    check_timeout: 15
    rate_limit_patterns:
      - "hit your usage limit"
      - "rate limit"
      - "quota exceeded"
      - "429"
    priority: 2
    state_dir: "~/.codex"
    state_pattern: "state_5.sqlite"
    # codex has no --effort flag; reasoning effort is a -c config override —
    # which is exactly why "args" is a template array and not flag+value.
    # secret_allowlist: []  # Uncomment and list secrets this worker may access
    tunables:
      model:
        args: ["--model", "{value}"]
        description: "Model the agent should use."
      effort:
        args: ["-c", "model_reasoning_effort={value}"]
        values: [minimal, low, medium, high]
        description: "Reasoning effort, via codex's -c config override."

  # Antigravity CLI (agy) — setup-required; the dispatcher skips it if not installed.
  - name: agy
    command: agy
    # --print-timeout is required: agy's print mode self-kills at 5m0s by default.
    # 65m sits just above pa's DEFAULT_TIMEOUT (3600s) so pa's own max-timeout is
    # always the layer that fires (attributable error + failure backoff).
    # {prompt} is substituted with '@<tempfile>' by worker-exec.ts (arg mode), not
    # inlined — so there is no command-line length cap on the prompt.
    args: ["--dangerously-skip-permissions", "--print-timeout", "65m", "-p", "{prompt}"]
    input_mode: arg
    output_format: plain-text
    check: agy --version
    check_timeout: 10
    rate_limit_patterns:
      - "RESOURCE_EXHAUSTED"
      - "429"
    priority: 3
    state_dir: "~/.gemini/antigravity-cli/conversations"
    # agy stores each conversation as a SQLite database in WAL mode, hence the
    # sibling <id>.db-shm / <id>.db-wal files (the '*.db' glob deliberately
    # excludes those — findLatestStateFile matches on suffix). pa's state reader
    # is line-oriented JSON and cannot parse SQLite, so it degrades to "unknown"
    # rather than guessing; agy stuck-detection therefore relies on the
    # process-tree heartbeat, not transcript inspection.
    state_pattern: "*.db"
    # agy v1.1.13 (live-verified 2026-08-15, AI-155): a bare '--effort high'
    # with no model is REJECTED instantly ("invalid model selection --
    # --effort is not supported for the current model"), which killed every
    # effort-bearing dispatch until 1.1.13 was probed. The effort tunable is
    # therefore deliberately ABSENT for agy: the model name's -high/-medium/-low
    # suffix IS the effort and is the only valid surface. claude-*/gpt-* names
    # reject --effort outright, so "model alone" is correct for every entry
    # 'agy models' prints. (On v1.1.5, 2026-07-22, effort-alone was still
    # accepted — the removal is a 1.1.13 behavior change, not a cleanup.)
    # secret_allowlist: []  # Uncomment and list secrets this worker may access
    tunables:
      model:
        args: ["--model", "{value}"]
        values:
          - gemini-3.7-flash-high
          - gemini-3.7-flash-medium
          - gemini-3.7-flash-low
          - gemini-3.6-flash-high
          - gemini-3.6-flash-medium
          - gemini-3.6-flash-low
          - gemini-3.5-flash-high
          - gemini-3.5-flash-medium
          - gemini-3.5-flash-low
          - gemini-3.1-pro-high
          - gemini-3.1-pro-low
          - claude-sonnet-4-6
          - claude-opus-4-6-thinking
          - gpt-oss-120b-medium
        description: "Model for this CLI session; agy's reasoning effort is EMBEDDED in its gemini model names (-high/-medium/-low), and a base name with no suffix is rejected. There is deliberately NO effort knob (v1.1.13 rejects a bare --effort, AI-155). Run 'agy models' for the current list - from PowerShell/cmd, not Git Bash, where it hangs (verified 2026-07-22: 242s, rc=124, 0 bytes; NOT a TTY gate - it works with stdout redirected)."

  # zclaude — example Claude-compatible wrapper CLI; setup-required.
  - name: zclaude
    command: zclaude
    args: ["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"]
    input_mode: stdin-json
    output_format: stream-json
    check: zclaude --version
    rate_limit_patterns:
      - "rate limit"
      - "token limit"
      - "quota exceeded"
      - "Usage limit"
      - "over your limit"
      - "hit your limit"
      - "429"
    priority: 4
    state_dir: "~/.claude/projects"
    state_pattern: "*.jsonl"
    # Optional defense-in-depth: limit which secrets this worker receives.
    # If absent, the worker gets ALL secrets from secrets.env (current behavior).
    # If present, ONLY the named secrets are injected into the worker's environment.
    # Secret names must match pattern [A-Z0-9_]+ (uppercase alphanumeric + underscore).
    # LLM workers (agy, claude, codex, zclaude): this field controls which secrets
    #   from secrets.env are injected. Shell skills (cmd:) are unaffected.
    # Example: secret_allowlist: [TELEGRAM_BOT_TOKEN, OPENAI_API_KEY]
    # secret_allowlist:

bg_tasks:
  alert_seconds: 300
  alert_repeat_seconds: 1800

# === maintenance (optional) ===
# Overrides for declared maintenance jobs. Run \`pa maintenance list\` for the
# full table with resolved target paths. A knob may only DISABLE a job or
# CHANGE its cadence — it can never add or widen a target.
# maintenance:
#   session-gc:    { enabled: true, every: 6h }
#   archive-prune: { every: 1h }

# === usage (optional) ===
# Track token usage and set budget alerts. The \`pa costs\` command reports
# usage rollups by worker, model, and skill. The budget_monthly_usd field is
# parsed but budget alerting is not implemented yet — reserved for future budget alerts.
# Cost estimation requires a price table to be configured — without prices,
# tokens are tracked but costs remain null.
# usage:
#   budget_monthly_usd: 100   # optional monthly USD budget; alerting not implemented yet

# === model_pricing (optional) ===
# Per-million-token USD pricing for cost estimation. Built-in defaults cover
# common models; override here to adjust or add entries. Keys are model names;
# a key matching a worker name prices records that carry no model field.
# model_pricing:
#   gemini-3.7-flash: { input: 0.75, output: 3.75, cache_read: 0.075 }
#   agy: { input: 0.75, output: 3.75, cache_read: 0.075 }

# === quota-aware failover (optional) ===
# Opt-in flag for health-score-based worker ordering. When ON, cooldown
# workers and those with 3+ consecutive failures are demoted to the tail.
# When OFF (default): workers tried in fixed priority order.
# quota_aware_failover: false

# === worker pin (optional) ===
# Persisted override for 'pa worker pin <name>' — set via CLI command.
# worker_pin: "claude"

# === git workflow (persona switch) ===
# pa ships run-only by default: no skill commits, pushes, or reverts on your
# behalf. update-brain then runs file-only and the self-improver example skips
# its code-fix lane. Flip to true (inside a git work tree) to enable snapshot
# commits and autonomous code fixes. Skills probe with: pa git-guard
git_workflow:
  enabled: false

# === transcription (optional) ===
# Controls how Telegram VOICE NOTES become text. If you never send voice notes,
# ignore this whole block — everything else works exactly as before.
#
# You need ONE engine. Two ways to get one:
#
#   Cloud — recommended, about a minute to set up, transcribes in seconds:
#     put GROQ_API_KEY=<free key from https://console.groq.com/keys> in
#     ~/.pa/secrets.env and restart the bot. Nothing to install locally.
#     OPENAI_API_KEY and DEEPGRAM_API_KEY work the same way.
#
#   Local — fully offline, audio never leaves your machine, but SLOW and heavy:
#     install the \`transcription\` Python package plus ffmpeg, then set
#     engine_preference: local below. Expect ~1 GB of dependencies and one to
#     several MINUTES per voice note on CPU.
#
# Full walkthrough: docs/BOT_GUIDE.md "Voice messages (speech to text)"
# Something broken?  docs/TROUBLESHOOTING.md "Voice-message transcription"
#
# transcription:
#   # auto  = use a cloud engine when an API key is set, otherwise fall back to local
#   # cloud = cloud only; fail rather than fall back to local if every provider fails
#   # local = local only; audio NEVER leaves this machine, even if API keys are set
#   engine_preference: auto
#
#   # How the LOCAL engine runs. Ignored entirely when a cloud engine handles the note.
#   #   spawn      = one fresh Python process per voice note. Simple, nothing resident,
#   #                but it reloads the speech model every time — that is where the
#   #                minutes go.
#   #   persistent = start a background process on the first voice note that needs it,
#   #                keep the model in RAM (~230 MB and up) so later notes are much
#   #                faster, and shut it down after 10 idle minutes.
#   # A deliberate, static choice: pa never switches modes on its own.
#   worker_mode: spawn
#
#   # Cloud providers to try, in order. Only providers whose API key is actually set
#   # are attempted, so listing all three is safe.
#   cloud_order: [groq, openai, deepgram]
#
#   # Pin the spoken language instead of auto-detecting (ISO 639-1, optionally
#   # region-qualified — e.g. "en" or "en-US"). The local model (small.en) is
#   # English-only: a non-English language here paired with engine_preference: local
#   # is accepted but logs a config-load warning, since it will likely mistranscribe
#   # or transliterate rather than fail outright. Leave unset (null) to auto-detect.
#   language: null
`.trim();

const DEFAULT_SECRETS = `
# KEY=VALUE pairs injected into worker environment.
# See examples/secrets.env.example for the full annotated list of env vars
# the framework + sample skills consume.
#
# Minimum required keys:
#   TELEGRAM_BOT_TOKEN=<your bot token from @BotFather>
#   TELEGRAM_CHAT_ID=<destination chat id; see docs/BOT_GUIDE.md>
#
# On Windows, Claude Code also needs:
#   CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe
`.trim();

const DEFAULT_CODEX_SKILL_TRANSLATIONS = `{
  "patterns": [
    "deep[-_]plan",
    "deep[-_]recheck",
    "update[-_]brain",
    "claude[-_]sync",
    "check[-_]brain",
    "simplify",
    "review",
    "security[-_]review"
  ]
}
`;

const DEFAULT_BRAIN_FILES = `{
  "root": "\${PA_FRAMEWORK_ROOT}",
  "files": []
}
`;

const DEFAULT_EXEMPT_JSON = `{}`;


import { join } from 'path';

export async function initCommand(opts?: { notify?: typeof notifyUser }): Promise<void> {
  const home = paHome();
  console.log(`Initializing PA at ${home}...`);

  await mkdir(home, { recursive: true });
  await mkdir(skillsDir(), { recursive: true });
  await mkdir(logsDir(), { recursive: true });
  await mkdir(draftsDir(), { recursive: true });

  const cp = configPath();
  try {
    await access(cp);
    console.log(`[skip] config.yaml already exists.`);
  } catch {
    await writeFile(cp, DEFAULT_CONFIG, 'utf8');
    console.log(`[+] Created config.yaml`);
  }

  const sp = secretsPath();
  try {
    await access(sp);
    console.log(`[skip] secrets.env already exists.`);
  } catch {
    await writeFile(sp, DEFAULT_SECRETS, 'utf8');
    console.log(`[+] Created secrets.env`);
  }

  const codexTranslationsPath = join(home, 'codex-skill-translations.json');
  try {
    await access(codexTranslationsPath);
    console.log(`[skip] codex-skill-translations.json already exists.`);
  } catch {
    await writeFile(codexTranslationsPath, DEFAULT_CODEX_SKILL_TRANSLATIONS, 'utf8');
    console.log(`[+] Created codex-skill-translations.json (8 default skill patterns)`);
  }

  const brainFilesPath = join(home, 'brain-files.json');
  try {
    await access(brainFilesPath);
    console.log(`[skip] brain-files.json already exists.`);
  } catch {
    await writeFile(brainFilesPath, DEFAULT_BRAIN_FILES, 'utf8');
    console.log(`[+] Created brain-files.json (empty; opt-in for the update-brain sample skill)`);
  }

  const topicBrainsDir = join(home, 'topic-brains');
  try {
    await access(topicBrainsDir);
    console.log(`[skip] topic-brains directory already exists.`);
  } catch {
    await mkdir(topicBrainsDir, { recursive: true });
    console.log(`[+] Created topic-brains directory`);
  }

  const exemptJsonPath = join(topicBrainsDir, 'EXEMPT.json');
  try {
    await access(exemptJsonPath);
    console.log(`[skip] topic-brains/EXEMPT.json already exists.`);
  } catch {
    await writeFile(exemptJsonPath, DEFAULT_EXEMPT_JSON, 'utf8');
    console.log(`[+] Created topic-brains/EXEMPT.json (empty exemption registry)`);
  }

  console.log('\n========================================');
  console.log('Initialization complete.');
  console.log('========================================');
  console.log('');
  console.log('Next steps:');
  console.log('');
  console.log('  Important — read first: docs/CONVENTIONS.md covers file-placement rules.');
  console.log('  Personal docs go OUTSIDE the repo (~/Documents/personal-imports/),');
  console.log('  not at the repo root. For deployment patterns, see docs/DEPLOYMENT.md.');
  console.log('');
  console.log('  0. After filling secrets.env, re-run `pa init` to send a');
  console.log('     verification message and confirm Telegram delivery works.');
  console.log('');
  console.log('  1. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in', sp);
  console.log('     See docs/BOT_GUIDE.md for Telegram setup.');
  console.log('');
  console.log('  2. Adjust worker `command` paths in', cp);
  console.log("     if your LLM CLIs aren't in PATH. See docs/WORKERS_GUIDE.md.");
  console.log('');
  console.log('  3. Copy a sample skill:');
  console.log('       PowerShell: Copy-Item -Recurse examples/skills/reminders ~/.pa/skills/');
  console.log('       Bash:       cp -r examples/skills/reminders ~/.pa/skills/');
  console.log('     See docs/SKILLS_GUIDE.md.');
  console.log('');
  console.log('  4. Verify: `pa health` should report every check as PASS or WARN.');

  // Alive message per D8
  const notify = opts?.notify ?? notifyUser;
  try {
    const secrets = await loadSecrets();
    const token = secrets.TELEGRAM_BOT_TOKEN;
    const chatIdRaw = secrets.TELEGRAM_CHAT_ID;

    if (!token || !chatIdRaw) {
      console.log('[skip] Alive message not sent — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in secrets.env, then re-run pa init.');
      return;
    }

    const chatId = chatIdRaw.split(',')[0].trim();
    await notify('Your assistant is alive', `pa initialized at ${home} and Telegram delivery is working.\n\nNext: run \`pa health\`, then try \`pa run reminders\`.`, {
      dedupKey: 'init-alive',
      escalate: false,
      severity: 'info',
      topic: { chat_id: chatId, thread_id: 0 }
    });
    console.log(`[i] Sent alive message to chat ${chatId}`);
  } catch (err) {
    console.log('[skip] Alive message failed:', err instanceof Error ? err.message : String(err));
  }
}
