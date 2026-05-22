import { readFile } from 'fs/promises';
import { readLogs } from '../logger.js';

export async function logsCommand(skillName: string, count: number = 10, showFull: boolean = false): Promise<void> {
  if (!skillName) {
    throw new Error('Usage: pa logs <skill-name> [--last N] [--full]');
  }

  const logs = await readLogs(skillName, count);

  if (logs.length === 0) {
    console.log(`No logs found for skill '${skillName}'`);
    return;
  }

  console.log(`Last ${logs.length} run(s) for '${skillName}':\n`);

  const tsWidth = 20;
  console.log(
    'Timestamp'.padEnd(tsWidth) + '  ' +
    'Worker'.padEnd(10) + '  ' +
    'Status'.padEnd(8) + '  ' +
    'Duration'
  );
  console.log('-'.repeat(tsWidth + 36));

  for (const { meta, logPath } of logs) {
    const ts = new Date(meta.timestamp).toLocaleString();
    const dur = `${(meta.duration / 1000).toFixed(1)}s`;
    console.log(
      `${ts.padEnd(tsWidth)}  ${meta.worker.padEnd(10)}  ${meta.status.padEnd(8)}  ${dur}`
    );

    if (showFull) {
      if (meta.extraArgs && meta.extraArgs.length > 0) {
        console.log(`  Extra Args: ${meta.extraArgs.join(' ')}`);
      }
      try {
        const content = await readFile(logPath, 'utf8');
        console.log(`\n--- Output ---\n${content}\n`);
      } catch {
        console.log('  (log file not found)');
      }
    }
  }
}
