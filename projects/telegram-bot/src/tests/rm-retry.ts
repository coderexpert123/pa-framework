import { rm } from 'fs/promises';

/**
 * rm() that tolerates ENOTEMPTY/EBUSY/EPERM. Tests that spawn worker processes
 * (dispatchMessage / runPollLoop) fire async log/state writes that can land in
 * the temp dir AFTER the test asserts. Under suite load those writes race the
 * recursive remove and the dir is briefly non-empty (or a handle is still open)
 * mid-rm — retry until it settles so cleanup never fails an otherwise-passing
 * test. This was the root cause of the flaky "hookFailed: ENOTEMPTY" failures.
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
