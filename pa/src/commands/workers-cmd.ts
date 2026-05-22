import { getAvailableWorkers, getWorkerCooldown } from '../workers.js';

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export async function workersCommand(): Promise<void> {
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
