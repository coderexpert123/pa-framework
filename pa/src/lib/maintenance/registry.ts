import type { MaintenanceHost, MaintenanceJob } from './types.js';
import { orphanWorkerReapJob } from './jobs/orphan-worker-reap.js';
import { blackboardPurgeJob } from './jobs/blackboard-purge.js';
import { stalenessCheckJob } from './jobs/staleness-check.js';
import { skillLogRotateJob } from './jobs/skill-log-rotate.js';
import { archivePruneJob } from './jobs/archive-prune.js';
import { alertStateGcJob } from './jobs/alert-state-gc.js';
import { weeklyLearnJob } from './jobs/weekly-learn.js';
import { sessionGcJob } from './jobs/session-gc.js';
import { voiceAttachmentGcJob } from './jobs/voice-attachment-gc.js';

/** THE single declared table. Every destructive path literal in this codebase
 *  lives under this directory — that is the point of the construct. */
export const MAINTENANCE_JOBS: readonly MaintenanceJob[] = [
  orphanWorkerReapJob, blackboardPurgeJob, stalenessCheckJob, skillLogRotateJob,
  archivePruneJob, alertStateGcJob, weeklyLearnJob, sessionGcJob, voiceAttachmentGcJob,
];

export function jobsForHost(host: MaintenanceHost): MaintenanceJob[] {
  return MAINTENANCE_JOBS.filter(j => j.host === host);
}

export function findJob(name: string): MaintenanceJob | undefined {
  return MAINTENANCE_JOBS.find(j => j.name === name);
}
