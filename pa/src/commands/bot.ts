import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { formatIST } from '../ist.js';
import { rotateFileIfNeeded } from '../lib/archive-files.js';
import { paHome as getPAHome } from '../paths.js';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function botStopCommand(): Promise<boolean> {
  const lockPath = join(getPAHome(), 'telegram-bot.lock');
  const sentinelPath = join(getPAHome(), 'telegram-bot.stop');

  // Read PID from lock file
  let pid: number | null = null;
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed)) pid = parsed;
  } catch {
    console.log('[bot] No lock file found — bot is not running.');
    return true;
  }

  // Self-stop guard: if invoked from within a worker spawned by the same bot
  // we're trying to stop, write the sentinel and return false. The bot will
  // exit on its next poll after the worker returns; Task Scheduler restarts it.
  // Returning false makes botRestartCommand skip pollForRestart (would deadlock).
  const selfPid = process.env.PA_BOT_PID ? parseInt(process.env.PA_BOT_PID, 10) : NaN;
  if (pid !== null && !isNaN(selfPid) && selfPid === pid) {
    await writeFile(sentinelPath, String(Date.now()), 'utf8');
    console.log(`[bot] Self-stop detected (PA_BOT_PID=${selfPid}) — sentinel written. Bot will exit on next poll; returning without waiting.`);
    return false;
  }

  if (!pid || !isProcessAlive(pid)) {
    console.log(`[bot] Bot (PID ${pid}) is not running.`);
    return true;
  }

  // Write sentinel file — the bot checks for this file on each poll iteration
  await writeFile(sentinelPath, String(Date.now()), 'utf8');
  console.log(`[bot] Stop signal sent to PID ${pid} — waiting for graceful exit...`);
  console.log('[bot] (The bot will finish any in-flight work before stopping)');

  // Poll until the process dies (up to 120s)
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    if (!isProcessAlive(pid)) {
      console.log('[bot] Stopped.');
      return true;
    }
  }

  console.log('[bot] Timed out after 120s. The bot may still be finishing a long worker task.');
  console.log(`[bot] Force-kill if needed: Stop-Process -Force -Id ${pid}`);
  return false;
}

export async function pollForRestart(
  paHome: string,
  oldPid: number,
  pollIntervalMs: number,
  deadlineMs: number
): Promise<{ pid: number; started: Date } | null> {
  const lockPath = join(paHome, 'telegram-bot.lock');
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    try {
      const raw = await readFile(lockPath, 'utf8');
      const pid = parseInt(raw.trim(), 10);
      if (!isNaN(pid) && pid !== oldPid && isProcessAlive(pid)) {
        return { pid, started: new Date() };
      }
    } catch {
      // ENOENT — lock file absent during the gap between stop and start; continue polling
    }
  }

  return null;
}

export async function botRotateCommand(): Promise<void> {
  const paHome = getPAHome();
  const botLogPath = join(paHome, 'logs', 'telegram-bot.log');
  const rotated = await rotateFileIfNeeded(botLogPath);
  if (rotated) {
    console.log('[bot] Log file rotated.');
  } else {
    console.log('[bot] Log file size within limit; no rotation needed.');
  }
}

export async function botRestartCommand(): Promise<void> {
  const paHome = getPAHome();
  const lockPath = join(paHome, 'telegram-bot.lock');

  // Capture oldPid BEFORE stopping so we can detect the new process afterwards
  let oldPid = 0;
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed)) oldPid = parsed;
  } catch {
    // Bot not running — oldPid stays 0; any new PID ≠ 0 will be accepted
  }

  const stopped = await botStopCommand();
  if (!stopped) {
    const selfPid = process.env.PA_BOT_PID ? parseInt(process.env.PA_BOT_PID, 10) : NaN;
    if (!isNaN(selfPid) && selfPid === oldPid) {
      console.log('[bot] Restart initiated from inside the bot — Task Scheduler will handle the restart. Not polling for new PID.');
    }
    return;
  }

  // Rotate bot log while stopped (not locked)
  const botLogPath = join(paHome, 'logs', 'telegram-bot.log');
  await rotateFileIfNeeded(botLogPath).catch(() => {});

  // Clear the stop sentinel so the next bot startup (via Task Scheduler /
  // run-bot.ps1 / etc.) doesn't see it and immediately exit. botStopCommand
  // wrote the sentinel to signal the OLD bot to stop; without removing it,
  // every subsequent spawn just reads "should stop" and quits.
  const sentinelPath = join(paHome, 'telegram-bot.stop');
  await unlink(sentinelPath).catch(() => {}); // ENOENT is fine

  console.log('[bot] Windows Task Scheduler will restart the bot within 1 minute.');
  const result = await pollForRestart(paHome, oldPid, 2000, 90_000);

  if (result) {
    console.log(`[bot] Restarted. PID ${result.pid}, started at ${formatIST(result.started)}.`);
  } else {
    console.log('[bot] Timed out — Task Scheduler may still be starting it. Check: cat ~/.pa/telegram-bot.lock');
  }
}
