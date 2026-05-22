import { spawn } from 'child_process';
import { approveDraft, loadDraft } from '../drafts.js';

export async function approveCommand(name: string, edit: boolean = false): Promise<void> {
  if (!name) {
    throw new Error('Usage: pa approve <name> [--edit]');
  }

  const { skill } = await loadDraft(name);

  if (edit) {
    const editor = process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [skill.path], { stdio: 'inherit', shell: true });
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Editor exited with code ${code}`))));
      child.on('error', reject);
    });
  }

  await approveDraft(name);
  console.log(`Skill '${name}' approved and installed at ~/.pa/skills/${name}/skill.md`);
  console.log(`Run 'pa list' to see it in your skill roster.`);
}
