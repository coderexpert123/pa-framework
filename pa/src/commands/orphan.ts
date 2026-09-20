import { loadSecrets } from '../secrets.js';
import { emptyOrphanStore, landOrphanGroup, readOrphanStore, type OrphanAction } from '../lib/orphan-watch.js';

/**
 * `pa orphan` CLI — the orphaned-edit disposition surface (AI-214).
 *
 *   pa orphan list                 Print the orphan-watch store
 *   pa orphan land <gid>           Land the group verbatim (operator-gated;
 *                                  refuses reserved/lock-held/clean)
 *   pa orphan keep <gid>           Snooze the group 24 h
 *   pa orphan diff <gid>           Post the truncated group diff to pa-alerts
 *
 * Refusals exit 1 with the stable reason token on stderr
 * ('unknown-gid' | 'reserved:<session>' | 'lock-held' | 'clean').
 * Outcome notifies (land/diff) are sent from landOrphanGroup itself.
 * Exit codes: 0 ok · 1 refusal/failure · 2 argument error.
 */
export async function orphanCommand(args: string[] = []): Promise<void> {
  // CLI invocations don't auto-load secrets.env (only the bot does at
  // startup) — load them so notifyUser's resolvers see the alert route.
  const secrets = await loadSecrets();
  for (const [k, v] of Object.entries(secrets)) {
    if (!(k in process.env)) process.env[k] = v;
  }

  const sub = args[0];
  if (sub === 'list') {
    const store = await readOrphanStore().catch(() => emptyOrphanStore());
    console.log(JSON.stringify(store));
    return;
  }

  if (sub === 'land' || sub === 'keep' || sub === 'diff') {
    const gid = args[1];
    if (!gid) {
      console.error(`Error: pa orphan ${sub} requires a <gid> argument`);
      process.exit(2);
    }
    try {
      const result = await landOrphanGroup(sub as OrphanAction, gid);
      if (sub === 'land') {
        console.log(`Landed at ${result.sha ?? '(unknown sha)'}.`);
      } else if (sub === 'keep') {
        console.log('Group snoozed for 24h.');
      } else {
        console.log('Diff sent.');
      }
    } catch (err) {
      console.error(`pa orphan ${sub} ${gid}: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  console.error('Usage: pa orphan <list|land|keep|diff> [gid]');
  process.exit(2);
}
