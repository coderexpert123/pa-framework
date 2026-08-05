import { rm } from 'fs/promises';

/**
 * rm() that tolerates ENOTEMPTY/EBUSY/EPERM. maintenance-runner.test.ts's
 * concurrent updateJobState() calls take a proper-lockfile lock on the ledger
 * file; on Windows the lock artifact's removal can lag the promise resolving
 * by a tick, so an immediately-following recursive rm() of the temp dir can
 * observe a briefly non-empty directory. Retry until it settles so cleanup
 * never fails an otherwise-passing test. Mirrors
 * projects/telegram-bot/src/tests/rm-retry.ts (same root cause, AI-093).
 */
export async function rmRetry(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if ((err?.code === 'ENOTEMPTY' || err?.code === 'EBUSY' || err?.code === 'EPERM') && attempt < 9) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw err;
    }
  }
}
