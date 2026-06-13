import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';

function paHome(): string {
  return process.env.PA_HOME || join(homedir(), '.pa');
}

function stateFile(): string { return join(paHome(), 'telegram-keepawake.json'); }
function stopSentinel(): string { return join(paHome(), 'telegram-keepawake.stop'); }
function psHelper(): string { return join(paHome(), 'telegram-keepawake.ps1'); }

export interface KeepAwakeStatus {
  active: boolean;
  pid?: number;
  since?: string; // ISO timestamp
}

/**
 * Returns the current machine-wide keep-awake status.
 * Verifies if the stored PID is actually alive.
 */
export function getKeepAwakeStatus(): KeepAwakeStatus {
  const file = stateFile();
  if (!existsSync(file)) {
    return { active: false };
  }

  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data.pid) return { active: false };

    // Check if process is alive
    try {
      process.kill(data.pid, 0);
      return { active: true, pid: data.pid, since: data.since };
    } catch {
      // Process is dead, clean up stale state
      cleanupStaleState();
      return { active: false };
    }
  } catch {
    return { active: false };
  }
}

/**
 * Toggles keep-awake mode.
 */
export async function toggleKeepAwake(): Promise<KeepAwakeStatus> {
  const status = getKeepAwakeStatus();
  if (status.active) {
    await stopKeepAwake(status.pid!);
    return { active: false };
  } else {
    return await startKeepAwake();
  }
}

async function startKeepAwake(): Promise<KeepAwakeStatus> {
  let child: ReturnType<typeof spawn>;

  if (platform() === 'win32') {
    ensurePowerShellHelper();
    const sentinel = stopSentinel();
    if (existsSync(sentinel)) unlinkSync(sentinel);
    // SetThreadExecutionState(0x80000001) -> ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psHelper()], {
      detached: true,
      stdio: 'ignore',
    });
  } else if (platform() === 'darwin') {
    // caffeinate -s: prevent system sleep; ships with macOS, no install needed
    child = spawn('caffeinate', ['-s'], { detached: true, stdio: 'ignore' });
  } else {
    // Linux: systemd-inhibit keeps an inhibitor lock for the lifetime of the child process
    child = spawn(
      'systemd-inhibit',
      ['--what=sleep:idle', '--who=pa-framework', '--why=keepawake', 'sleep', 'infinity'],
      { detached: true, stdio: 'ignore' }
    );
  }

  child.unref();

  if (!child.pid) {
    throw new Error('Failed to spawn keep-awake helper');
  }

  const status: KeepAwakeStatus = {
    active: true,
    pid: child.pid,
    since: new Date().toISOString(),
  };

  writeFileSync(stateFile(), JSON.stringify(status, null, 2));
  return status;
}

async function stopKeepAwake(pid: number): Promise<void> {
  if (platform() === 'win32') {
    // Graceful shutdown: write sentinel so the PS loop exits cleanly, then wait
    try {
      writeFileSync(stopSentinel(), '');
    } catch (err) {
      console.error('Failed to write stop sentinel:', err);
    }
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try {
        process.kill(pid, 0);
      } catch {
        cleanupStaleState();
        return;
      }
    }
  }

  // POSIX: caffeinate / systemd-inhibit exit cleanly on SIGTERM
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}

  cleanupStaleState();
}

function cleanupStaleState() {
  const file = stateFile();
  const sentinel = stopSentinel();
  if (existsSync(file)) try { unlinkSync(file); } catch {}
  if (existsSync(sentinel)) try { unlinkSync(sentinel); } catch {}
}

function ensurePowerShellHelper() {
  const sentinel = stopSentinel();
  const script = `
$signature = @"
[DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
"@

$type = Add-Type -MemberDefinition $signature -Name "WinAPI" -Namespace "KeepAwake" -PassThru

# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
$flags = 0x80000001

Write-Host "Starting keep-awake helper (PID $PID)..."

try {
    while (-not (Test-Path "${sentinel.replace(/\\/g, '\\\\')}")) {
        $type::SetThreadExecutionState($flags)
        Start-Sleep -Seconds 30
    }
    Write-Host "Stop sentinel detected. Exiting."
} finally {
    # Restore normal state: ES_CONTINUOUS (0x80000000)
    $type::SetThreadExecutionState(0x80000000)
}
`;
  writeFileSync(psHelper(), script, 'utf8');
}

