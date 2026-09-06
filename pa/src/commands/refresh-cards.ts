import { spawn } from 'child_process';
import { join } from 'path';
import { repoRootFromModule } from '../lib/git-root.js';

export async function refreshCardsCommand(args: string[]): Promise<number> {
  const repoRoot = await repoRootFromModule(__filename);
  const scriptPath = join(repoRoot, 'projects', 'telegram-bot', 'scripts', 'refresh-all-topics-status.ts');

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath, ...args], {
      stdio: 'inherit',
      cwd: repoRoot,
      env: process.env,
      windowsHide: true,
    });

    child.on('close', (code) => {
      resolve(code ?? 0);
    });

    child.on('error', (err) => {
      console.error(`Failed to spawn refresh-all-topics-status: ${err.message}`);
      resolve(1);
    });
  });
}
