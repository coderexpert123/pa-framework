import { loadSecrets } from '../secrets.js';
import { runBrainSweep } from '../lib/brain-sweep.js';

/**
 * `pa brain-sweep [--skill-held-lock]` — the deterministic update-brain
 * pre-update snapshot (AI-214). Prints ONE JSON object on stdout
 * `{committed:[{label,paths}],deferred:[{path,reason}],alertSent,refId}`;
 * exit 0 on success, 1 on git failure (the skill aborts with its ⚠️ message).
 */
export async function brainSweepCommand(args: string[] = []): Promise<void> {
  // CLI invocations don't auto-load secrets.env — load them so the deferral
  // alert's notifyUser can resolve the pa-alerts route.
  const secrets = await loadSecrets();
  for (const [k, v] of Object.entries(secrets)) {
    if (!(k in process.env)) process.env[k] = v;
  }

  const unknown = args.filter((a) => a !== '--skill-held-lock');
  if (unknown.length > 0) {
    console.error(`Usage: pa brain-sweep [--skill-held-lock] (unknown argument(s): ${unknown.join(' ')})`);
    process.exit(2);
  }

  try {
    const result = await runBrainSweep({ skillHeldLock: args.includes('--skill-held-lock') });
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(`pa brain-sweep: ${(err as Error).message}`);
    process.exit(1);
  }
}
