import { stat, readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { platform } from 'os';
import { paHome } from '../paths.js';
import { loadConfig } from '../config.js';
import { listSkills } from '../skills.js';
import { checkWorker, isWorkerCoolingDown } from '../workers.js';
import { loadSecrets } from '../secrets.js';

// ---- Types ----

type CheckStatus = 'OK' | 'WARN' | 'FAIL';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

// ---- Helpers ----

async function fileSize(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.size;
  } catch {
    return null;
  }
}

async function fileMtime(path: string): Promise<Date | null> {
  try {
    const s = await stat(path);
    return s.mtime;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

// ---- Individual checks ----

// Exported (2026-07-11) so code-fixer.ts's F3 verification gate can poll it directly after a
// `pa bot restart` triggered by a code fix that touched projects/telegram-bot — in-process
// function call, not a `pa health` subprocess spawn + text-output parse.
export async function checkBotProcess(): Promise<CheckResult> {
  const lockPath = join(paHome(), 'telegram-bot.lock');
  const content = await readFile(lockPath, 'utf8').catch(() => null);
  if (content === null) {
    const launcher = platform() === 'win32'
      ? '`pwsh projects/telegram-bot/run-bot.ps1`'
      : '`bash projects/telegram-bot/run-bot.sh`';
    return {
      name: 'bot-process',
      status: 'FAIL',
      detail: `no lock file at ~/.pa/telegram-bot.lock — bot not running. Fix: \`pa bot restart\` (your supervisor will bring it back) OR start manually: ${launcher}. See docs/BOT_GUIDE.md.`,
    };
  }

  const pid = parseInt(content.trim(), 10);
  if (isNaN(pid)) {
    const rmCmd = platform() === 'win32' ? 'Remove-Item ~/.pa/telegram-bot.lock' : 'rm ~/.pa/telegram-bot.lock';
    return {
      name: 'bot-process',
      status: 'FAIL',
      detail: `lock file unreadable. Fix: \`${rmCmd}\` then \`pa bot restart\`.`,
    };
  }

  if (!isProcessAlive(pid)) {
    return {
      name: 'bot-process',
      status: 'FAIL',
      detail: `lock file references PID ${pid} but the process is gone. Fix: \`pa bot restart\` (writes a fresh lock + spawns a new bot).`,
    };
  }

  // Lock file is written once at startup — mtime is not a freshness indicator
  return { name: 'bot-process', status: 'OK', detail: `PID ${pid} alive` };
}

async function checkBlackboard(): Promise<CheckResult> {
  const bbPath = join(paHome(), 'blackboard.json');
  try {
    const content = await readFile(bbPath, 'utf8');
    const data = JSON.parse(content) as { active_locks: any[] };
    const now = Date.now();
    const stale4h: string[] = [];
    const stale1h: string[] = [];

    if (!data.active_locks || !Array.isArray(data.active_locks)) {
      return { name: 'blackboard', status: 'OK', detail: 'no active locks' };
    }

    for (const lock of data.active_locks) {
      const heartbeatAt = new Date(lock.heartbeat).getTime();
      const ageMs = now - heartbeatAt;
      if (ageMs > 4 * 3_600_000) stale4h.push(lock.resource);
      else if (ageMs > 1 * 3_600_000) stale1h.push(lock.resource);
    }

    if (stale4h.length > 0) return { name: 'blackboard', status: 'FAIL', detail: `${stale4h.length} lock(s) stale >4h: ${stale4h.join(', ')}. Fix: \`pa purge-locks\`. If they reappear, check app.log.jsonl for repeated crashes.` };
    if (stale1h.length > 0) return { name: 'blackboard', status: 'WARN', detail: `${stale1h.length} lock(s) stale >1h: ${stale1h.join(', ')}. Consider \`pa purge-locks\` if these persist.` };
    return { name: 'blackboard', status: 'OK', detail: `${data.active_locks.length} lock(s)` };
  } catch {
    return { name: 'blackboard', status: 'OK', detail: 'no active locks' };
  }
}

async function checkConversationLog(): Promise<CheckResult> {
  const logPath = join(paHome(), 'conversation-history.jsonl');
  const size = await fileSize(logPath);
  if (size === null) {
    return { name: 'conversation-log', status: 'WARN', detail: 'missing — normal on a fresh install; the bot creates it on first message' };
  }
  const label = fmtSize(size);
  if (size > 5 * 1024 * 1024) return { name: 'conversation-log', status: 'FAIL', detail: `${label} (>5MB). Fix: move to ~/.pa/archive/ and recreate an empty file. See docs/TROUBLESHOOTING.md §"conversation-log FAIL".` };
  if (size > 1024 * 1024) return { name: 'conversation-log', status: 'WARN', detail: `${label} (1–5MB) — consider archiving soon` };
  return { name: 'conversation-log', status: 'OK', detail: label };
}

async function checkBotLog(): Promise<CheckResult> {
  const logPath = join(paHome(), 'logs', 'telegram-bot.log');
  const size = await fileSize(logPath);
  if (size === null) return { name: 'bot-log', status: 'WARN', detail: 'no log file yet — bot hasn\'t started or hasn\'t logged. Try: `pa bot restart`.' };
  const label = fmtSize(size);
  if (size > 5 * 1024 * 1024) return { name: 'bot-log', status: 'FAIL', detail: `${label} (>5MB — rotation failed?). Fix: \`pa bot rotate\` or manually move to ~/.pa/archive/.` };
  if (size > 2 * 1024 * 1024) return { name: 'bot-log', status: 'WARN', detail: `${label} (2–5MB) — rotate soon: \`pa bot rotate\`` };
  return { name: 'bot-log', status: 'OK', detail: label };
}

async function checkAppLog(): Promise<CheckResult> {
  const logPath = join(paHome(), 'app.log.jsonl');
  const size = await fileSize(logPath);
  if (size === null) return { name: 'app-log', status: 'WARN', detail: 'no structured log yet — normal on a fresh install' };
  const label = fmtSize(size);
  if (size > 5 * 1024 * 1024) return { name: 'app-log', status: 'FAIL', detail: `${label} (>5MB). Fix: move ~/.pa/app.log.jsonl to ~/.pa/archive/.` };
  if (size > 1024 * 1024) return { name: 'app-log', status: 'WARN', detail: `${label} (1–5MB)` };
  return { name: 'app-log', status: 'OK', detail: label };
}

async function checkWorkers(): Promise<CheckResult> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    return { name: 'workers', status: 'FAIL', detail: 'config unavailable' };
  }
  const results = await Promise.all(config.workers.map(async (w) => {
    const ok = await checkWorker(w);
    const cooling = await isWorkerCoolingDown(w.name);
    return { name: w.name, ok, cooling };
  }));

  const unavailable = results.filter((r) => !r.ok).map((r) => r.name);
  const cooling = results.filter((r) => r.cooling).map((r) => r.name);

  if (unavailable.length === results.length) {
    return {
      name: 'workers',
      status: 'FAIL',
      detail: `all unavailable: ${unavailable.join(', ')}. Fix: install at least one of Claude Code, gemini-cli, or openai-codex and update ~/.pa/config.yaml's \`command\` paths. See docs/WORKERS_GUIDE.md.`,
    };
  }

  const details: string[] = [];
  if (unavailable.length > 0) details.push(`unavailable: ${unavailable.join(', ')} (install/fix command path in config.yaml)`);
  if (cooling.length > 0) details.push(`cooling: ${cooling.join(', ')} (rate-limited; use \`--worker <other>\` or wait)`);

  if (details.length > 0) return { name: 'workers', status: 'WARN', detail: details.join('; ') };
  return { name: 'workers', status: 'OK', detail: `all ${results.length} available` };
}

async function checkSkills(): Promise<CheckResult> {
  try {
    const skills = await listSkills();
    return { name: 'skills', status: 'OK', detail: `${skills.length} skills parsed` };
  } catch (err: any) {
    return { name: 'skills', status: 'FAIL', detail: `parse error: ${err.message}. Fix: validate the YAML frontmatter in the named skill file. See docs/SKILLS_GUIDE.md for the schema.` };
  }
}

export async function checkSecrets(): Promise<CheckResult> {
  const secretsFile = join(paHome(), 'secrets.env');
  try {
    await readFile(secretsFile, 'utf8');
    // Reuse loadSecrets' real line-by-line parser (skips comments, strips
    // quotes) instead of a raw substring search — a substring search matches
    // the scaffolded template's own comment text (e.g. "# TELEGRAM_BOT_TOKEN=
    // <your bot token from @BotFather>"), reporting OK on a totally
    // unconfigured install. Falsy check also catches a present-but-empty
    // "KEY=" line, which loadSecrets treats as an assigned (empty) value.
    const secrets = await loadSecrets();
    const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter((key) => !secrets[key]);
    if (missing.length > 0) {
      return {
        name: 'secrets',
        status: 'FAIL',
        detail: `missing in ~/.pa/secrets.env: ${missing.join(', ')}. Fix: (1) create a bot via @BotFather → save token as TELEGRAM_BOT_TOKEN; (2) find your chat ID via @userinfobot → save as TELEGRAM_CHAT_ID. See docs/BOT_GUIDE.md.`,
      };
    }
    return { name: 'secrets', status: 'OK', detail: 'required keys present' };
  } catch {
    return {
      name: 'secrets',
      status: 'FAIL',
      detail: 'secrets.env not found at ~/.pa/secrets.env. Fix: run `node pa/dist/bin/pa.js init` (creates the scaffold) then add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.',
    };
  }
}

async function checkLastCatchup(): Promise<CheckResult> {
  const logsPath = join(paHome(), 'logs');
  try {
    const entries = await readdir(logsPath, { withFileTypes: true });
    let latestMtime: Date | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillLogsDir = join(logsPath, entry.name);
      try {
        const files = await readdir(skillLogsDir);
        for (const file of files) {
          if (!file.endsWith('.meta')) continue;
          const mt = await fileMtime(join(skillLogsDir, file));
          if (mt && (!latestMtime || mt > latestMtime)) latestMtime = mt;
        }
      } catch {}
    }
    if (!latestMtime) return { name: 'last-catchup', status: 'WARN', detail: 'no run logs found — no skill has executed yet. Try: `pa run <some-skill>`. To enable automatic runs: `pa schedules sync`.' };
    const ageMs = Date.now() - latestMtime.getTime();
    const label = fmtAge(ageMs);
    if (ageMs > 2 * 3_600_000) return { name: 'last-catchup', status: 'FAIL', detail: `last run ${label} (>2h). Catchup scheduler may have stopped — check with \`pa schedules list\`. Re-register: \`pa schedules sync\`.` };
    if (ageMs > 30 * 60_000) return { name: 'last-catchup', status: 'WARN', detail: `last run ${label} (>30m)` };
    return { name: 'last-catchup', status: 'OK', detail: `last run ${label}` };
  } catch {
    return { name: 'last-catchup', status: 'WARN', detail: 'logs dir not found — run `pa init` if this is a fresh install.' };
  }
}

async function checkDiskLogs(): Promise<CheckResult> {
  const logsPath = join(paHome(), 'logs');
  try {
    let totalBytes = 0;
    const dirs = await readdir(logsPath, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const files = await readdir(join(logsPath, dir.name)).catch(() => [] as string[]);
      for (const file of files) {
        const size = await fileSize(join(logsPath, dir.name, file));
        if (size) totalBytes += size;
      }
    }
    const label = fmtSize(totalBytes);
    if (totalBytes > 500 * 1024 * 1024) return { name: 'disk-logs', status: 'FAIL', detail: `${label} (>500MB). Fix: bulk-archive old skill logs older than 30d to ~/.pa/archive/.` };
    if (totalBytes > 100 * 1024 * 1024) return { name: 'disk-logs', status: 'WARN', detail: `${label} (100–500MB) — consider archiving old logs` };
    return { name: 'disk-logs', status: 'OK', detail: label };
  } catch {
    return { name: 'disk-logs', status: 'WARN', detail: 'logs dir not found' };
  }
}

async function checkRefIdLogging(): Promise<CheckResult> {
  const logPath = join(paHome(), 'app.log.jsonl');
  try {
    const content = await readFile(logPath, 'utf8');
    const lines = content.trim().split('\n').reverse().slice(0, 100);
    let messageSentCount = 0;
    let missingRefIdCount = 0;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.message && entry.message.includes('message sent')) {
          messageSentCount++;
          if (!entry.refId) missingRefIdCount++;
        }
      } catch {}
    }

    if (messageSentCount === 0) return { name: 'ref-id-logging', status: 'WARN', detail: 'no "message sent" logs found in last 100 entries' };
    if (missingRefIdCount > 0) return { name: 'ref-id-logging', status: 'FAIL', detail: `${missingRefIdCount}/${messageSentCount} recent messages missing refId. Standards regression!` };
    return { name: 'ref-id-logging', status: 'OK', detail: `last ${messageSentCount} messages verified` };
  } catch {
    return { name: 'ref-id-logging', status: 'WARN', detail: 'app.log.jsonl unreadable' };
  }
}

// ---- Rendering ----

function statusLabel(s: CheckStatus): string {
  if (s === 'OK')   return '\x1b[32m[OK]  \x1b[0m';
  if (s === 'WARN') return '\x1b[33m[WARN]\x1b[0m';
  return                   '\x1b[31m[FAIL]\x1b[0m';
}

export async function healthCommand(): Promise<void> {
  const checks = await Promise.all([
    checkBotProcess(),
    checkBlackboard(),
    checkConversationLog(),
    checkBotLog(),
    checkAppLog(),
    checkWorkers(),
    checkSkills(),
    checkSecrets(),
    checkLastCatchup(),
    checkDiskLogs(),
    checkRefIdLogging(),
  ]);

  const nameWidth = Math.max(...checks.map((c) => c.name.length));
  console.log('\nPA Health Check\n' + '─'.repeat(50));
  for (const check of checks) {
    const pad = ' '.repeat(nameWidth - check.name.length);
    console.log(`  ${statusLabel(check.status)} ${check.name}${pad}  ${check.detail}`);
  }
  console.log('─'.repeat(50));

  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'WARN').length;
  if (fails > 0) {
    console.log(`\x1b[31m  ${fails} check(s) failed, ${warns} warning(s)\x1b[0m\n`);
  } else if (warns > 0) {
    console.log(`\x1b[33m  ${warns} warning(s)\x1b[0m\n`);
  } else {
    console.log(`\x1b[32m  All checks passed\x1b[0m\n`);
  }
}
