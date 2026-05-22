import { syncSchedules, listSchedules } from '../scheduler.js';

export async function schedulesSyncCommand(): Promise<void> {
  await syncSchedules();
}

export async function schedulesListCommand(): Promise<void> {
  await listSchedules();
}
