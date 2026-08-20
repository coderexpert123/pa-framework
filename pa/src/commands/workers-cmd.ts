import { getAvailableWorkers, getWorkerCooldown } from '../workers.js';
import { readFile, writeFile } from 'fs/promises';
import { configPath } from '../paths.js';

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export async function workersCommand(args: string[]): Promise<void> {
  // Handle 'pa worker pin <name>' subcommand
  if (args.length >= 2 && args[0] === 'pin') {
    const workerName = args[1];
    return workerPinCommand(workerName);
  }

  // Handle 'pa worker' (status)
  console.log('Checking workers...\n');
  const workers = await getAvailableWorkers();

  const nameWidth = Math.max(10, ...workers.map((w) => w.name.length));
  const cmdWidth = Math.max(10, ...workers.map((w) => w.command.length));

  console.log(
    'Name'.padEnd(nameWidth) + '  ' +
    'Command'.padEnd(cmdWidth) + '  ' +
    'Priority' + '  ' +
    'Status'
  );
  console.log('-'.repeat(nameWidth + cmdWidth + 24));

  for (const w of workers) {
    let status = w.available ? 'available' : 'not found';
    let icon = w.available ? '+' : '-';

    const cooldown = await getWorkerCooldown(w.name);
    if (cooldown) {
      const remainingMs = new Date(cooldown.cooldown_until).getTime() - Date.now();
      if (remainingMs > 0) {
        status = `cooling (${fmtDuration(remainingMs)} left: ${cooldown.reason})`;
        icon = '❄️';
      }
    }

    console.log(
      `${w.name.padEnd(nameWidth)}  ${w.command.padEnd(cmdWidth)}  ${String(w.priority).padEnd(8)}  [${icon}] ${status}`
    );
  }
}

/**
 * Set a worker as the preferred first choice via config.yaml.
 * Usage: pa worker pin <name>
 */
async function workerPinCommand(workerName: string): Promise<void> {
  const path = configPath();
  const raw = await readFile(path, 'utf8');

  // Remove existing worker_pin line if present
  const updated = raw
    .split('\n')
    .filter(line => !line.trim().startsWith('worker_pin:'))
    .join('\n');

  // Add new worker_pin line
  const pinLine = `worker_pin: "${workerName}"`;
  const withNewPin = updated.includes('\nworkers:')
    ? updated.replace(/(\nworkers:)/, `$1\n  ${pinLine}`)
    : updated + `\n${pinLine}`;

  await writeFile(path, withNewPin.trim() + '\n', 'utf8');
  console.log(`Worker pinned: ${workerName} will be tried first in all dispatches.`);
  console.log(`Edit ${path} to remove the 'worker_pin:' line and restore default ordering.`);
}
