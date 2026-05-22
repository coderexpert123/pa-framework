import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
  // Ensure PS helper exists
  ensurePowerShellHelper();

  const sentinel = stopSentinel();
  // Remove any stale stop sentinel
  if (existsSync(sentinel)) unlinkSync(sentinel);

  // Spawn the PowerShell script
  // SetThreadExecutionState(0x80000001) -> ES_CONTINUOUS | ES_SYSTEM_REQUIRED
  // We use a loop that calls it every 30 seconds to be safe, though ES_CONTINUOUS should be enough.
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psHelper()], {
    detached: true,
    stdio: 'ignore',
  });

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
  // 1. Try graceful shutdown via sentinel
  try {
    writeFileSync(stopSentinel(), '');
  } catch (err) {
    console.error('Failed to write stop sentinel:', err);
  }
  
  // Wait up to 2 seconds for it to exit
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0);
    } catch {
      // It's gone
      cleanupStaleState();
      return;
    }
  }

  // 2. Force kill if still alive
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

