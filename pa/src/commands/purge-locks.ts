import { blackboard } from '../blackboard.js';

export async function purgeLocksCommand(): Promise<void> {
  const purged = await blackboard.purgeStaleLocks();
  if (purged > 0) {
    console.log(`Successfully purged ${purged} stale locks from blackboard.`);
  } else {
    console.log('No stale locks found.');
  }
}
