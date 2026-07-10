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
    priority: 2
    state_dir: "~/.gemini/tmp/personal-assistant/chats"
    state_pattern: "*.json"

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
    priority: 3
    state_dir: "~/.codex"
    state_pattern: "state_5.sqlite"

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
    priority: 4
    state_dir: "~/.claude/projects"
    state_pattern: "*.jsonl"

  - name: agy
    command: agy
    args: ["--yolo", "--output-format", "stream-json"]
    input_mode: stdin-text
    output_format: stream-json
    check: agy --version
    check_timeout: 10
    rate_limit_patterns:
      - "quota"
      - "rate limit"
      - "429"
      - "Resource exhausted"
    priority: 5
    state_dir: "~/.gemini/antigravity-cli/conversations"
    state_pattern: "*.pb"  # protobuf conversation files (.db = pre-2026 legacy SQLite)

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
