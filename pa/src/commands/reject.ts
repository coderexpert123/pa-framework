import { rejectDraft } from '../drafts.js';

export async function rejectCommand(name: string): Promise<void> {
  if (!name) {
    throw new Error('Usage: pa reject <name>');
  }

  await rejectDraft(name);
  console.log(`Draft '${name}' rejected. It will be excluded from future proposals.`);
}
