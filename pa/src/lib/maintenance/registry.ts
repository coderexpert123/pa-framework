import type { MaintenanceHost, MaintenanceJob } from './types.js';
import { orphanWorkerReapJob } from './jobs/orphan-worker-reap.js';
import { blackboardPurgeJob } from './jobs/blackboard-purge.js';
import { stalenessCheckJob } from './jobs/staleness-check.js';
import { skillCadenceAuditJob } from './jobs/skill-cadence-audit.js';
import { skillLogRotateJob } from './jobs/skill-log-rotate.js';
import { archivePruneJob } from './jobs/archive-prune.js';
import { alertStateGcJob } from './jobs/alert-state-gc.js';
import { weeklyLearnJob } from './jobs/weekly-learn.js';
import { sessionGcJob } from './jobs/session-gc.js';
import { voiceAttachmentGcJob } from './jobs/voice-attachment-gc.js';
import { workerTeeGcJob } from './jobs/worker-tee-gc.js';
import { reservationGcJob } from './jobs/reservation-gc.js';
import { restoreDrillJob } from './jobs/restore-drill.js';
import { clobberSentinelJob } from './jobs/clobber-sentinel.js';
import { redteamRecurringJob } from './jobs/redteam-recurring.js';
import { botLogRotationCheckJob } from './jobs/bot-log-rotation-check.js';
import { modelOverrideSweepJob } from './jobs/model-override-sweep.js';
import { deliveredStoreCompactJob } from './jobs/delivered-store-compact.js';
import { proxyPoolRefreshJob } from './jobs/proxy-pool-refresh.js';
import { dlqFlushJob } from './jobs/dlq-flush.js';
import { groundingCheckJob } from './jobs/grounding-check.js';

/** THE single declared table. Every declared maintenance job across pa and bot hosts
 *  lives under this array — that is the point of the construct. */
export const MAINTENANCE_JOBS: readonly MaintenanceJob[] = [
  // pa-host jobs
  orphanWorkerReapJob,
  blackboardPurgeJob,
  stalenessCheckJob,
  skillCadenceAuditJob,
  skillLogRotateJob,
  archivePruneJob,
  alertStateGcJob,
  weeklyLearnJob,
  sessionGcJob,
  voiceAttachmentGcJob,
  workerTeeGcJob,
  reservationGcJob,
  restoreDrillJob,
  clobberSentinelJob,
  redteamRecurringJob,
  // bot-host jobs
  botLogRotationCheckJob,
  modelOverrideSweepJob,
  deliveredStoreCompactJob,
  proxyPoolRefreshJob,
  groundingCheckJob,
  dlqFlushJob,
];

export function jobsForHost(host: MaintenanceHost): MaintenanceJob[] {
  return MAINTENANCE_JOBS.filter((j) => j.host === host);
}

export function findJob(name: string): MaintenanceJob | undefined {
  return MAINTENANCE_JOBS.find((j) => j.name === name);
}
