import { mkdir, writeFile, access } from 'fs/promises';
import { configPath, secretsPath, skillsDir, logsDir, draftsDir, paHome } from '../paths.js';

const DEFAULT_CONFIG = `
# Adjust command paths for your system (e.g. absolute paths or .cmd extensions on Windows)
workers:
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
    priority: 1
    state_dir: "~/.claude/projects"
    state_pattern: "*.jsonl"
    # tunables: user-settable knobs (the bot's /llm and /effort commands).
    # "args" is an ARG TEMPLATE — "{value}" is substituted and the whole
    # template is appended, but ONLY when the setting is actually set.
    # Only declare flags the CLI actually has — a bogus flag fails EVERY
    # dispatch to this worker and looks like an outage, not a settings error.
    # Omit "default:" to leave the CLI's own default in charge (nothing passed).
    # "values" is a display hint (or a canonical->native map), never an
    # allowlist: any value the user types is passed through.
    # "supersedes: [other]" declares that setting THIS knob must suppress
    # another one's args, for a CLI that rejects the two together (see agy).
    tunables:
      model:
        args: ["--model", "{value}"]
        description: "Model name passed to the CLI (e.g. opusplan, opus, sonnet)."
      effort:
        args: ["--effort", "{value}"]
        values: [low, medium, high, xhigh, max]
        description: "Effort level for the session (Claude Code 2.x --effort)."

  - name: gemini
    command: gemini
    args: ["--yolo", "--output-format", "stream-json"]
    input_mode: stdin-text
    output_format: stream-json
    check: gemini --version
    check_timeout: 10
    rate_limit_patterns:
      - "RESOURCE_EXHAUSTED"
      - "quota"
      - "rate limit"
      - "429"
      - "Resource exhausted"
    priority: 3
    state_dir: "~/.gemini/tmp/personal-assistant/chats"
    state_pattern: "*.jsonl"   # gemini-cli writes session-<ts>-<id>.jsonl here (verified 2026-07-22)
    # gemini-cli has -m/--model and NO reasoning-effort flag, so no effort knob
    # here — the bot uses that absence to explain why /effort is unavailable.
    tunables:
      model:
        args: ["--model", "{value}"]
        description: "Model name (e.g. gemini-2.5-pro)."

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
    priority: 4
    state_dir: "~/.codex"
    state_pattern: "state_5.sqlite"
    # codex has no --effort flag; reasoning effort is a -c config override —
    # which is exactly why "args" is a template array and not flag+value.
    tunables:
      model:
        args: ["--model", "{value}"]
        description: "Model the agent should use."
      effort:
        args: ["-c", "model_reasoning_effort={value}"]
        values: [minimal, low, medium, high]
        description: "Reasoning effort, via codex's -c config override."

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
    priority: 5
    state_dir: "~/.claude/projects"
    state_pattern: "*.jsonl"
    tunables:
      model:
        args: ["--model", "{value}"]
        description: "Model name passed to the CLI (e.g. opusplan, opus, sonnet)."
      effort:
        args: ["--effort", "{value}"]
        values: [low, medium, high, xhigh, max]
        description: "Effort level for the session (Claude Code 2.x --effort)."

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
    priority: 2
    state_dir: "~/.gemini/antigravity-cli/conversations"
    # agy stores each conversation as a SQLite database in WAL mode, hence the
    # sibling <id>.db-shm / <id>.db-wal files (the '*.db' glob deliberately
    # excludes those — findLatestStateFile matches on suffix). pa's state reader
    # is line-oriented JSON and cannot parse SQLite, so it degrades to "unknown"
    # rather than guessing; agy stuck-detection therefore relies on the
    # process-tree heartbeat, not transcript inspection.
    state_pattern: "*.db"
    # MODEL AND EFFORT ARE NOT INDEPENDENT ON agy (v1.1.5, verified live
    # 2026-07-22): '--model gemini-3.6-flash' alone is REJECTED (the CLI demands
    # an effort), '--model gemini-3.6-flash-high' is fine because the suffix IS
    # the effort, and '--model claude-sonnet-4-6 --effort high' is rejected with
    # "--effort is not supported". Every name 'agy models' prints is either
    # effort-suffixed or an effort-rejecting Claude/GPT model, so sending the
    # model ALONE is right for all of them - hence "supersedes: [effort]".
    # Effort on its own is still valid and is still passed.
    tunables:
      model:
        args: ["--model", "{value}"]
        supersedes: [effort]
        description: "Model for this CLI session; agy's reasoning effort is EMBEDDED in its gemini model names (-high/-medium/-low), and a base name with no suffix is rejected. Setting a model supersedes the effort knob. Run 'agy models' for the current list - from PowerShell/cmd, not Git Bash, where it hangs (verified 2026-07-22: 242s, rc=124, 0 bytes; NOT a TTY gate - it works with stdout redirected)."
      effort:
        args: ["--effort", "{value}"]
        values: [low, medium, high]
        description: "Reasoning effort when no model is set (agy's own default is low). Superseded once a model is set, because agy's model names carry the effort."

bg_tasks:
  alert_seconds: 300
  alert_repeat_seconds: 1800
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

import { join } from 'path';

export async function initCommand(): Promise<void> {
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
  console.log('  4. Verify: `pa health` should report all 10 checks as PASS or WARN.');
}
