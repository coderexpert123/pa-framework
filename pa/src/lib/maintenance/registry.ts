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
import { workerTeeGcJob } from './jobs/worker-tee-gc.js';
import { reservationGcJob } from './jobs/reservation-gc.js';
import { restoreDrillJob } from './jobs/restore-drill.js';
import { alertCensusJob } from './jobs/alert-census.js';
import { clobberSentinelJob } from './jobs/clobber-sentinel.js';
import { redteamRecurringJob } from './jobs/redteam-recurring.js';
import { botLogRotationCheckJob } from './jobs/bot-log-rotation-check.js';
import { modelOverrideSweepJob } from './jobs/model-override-sweep.js';
import { deliveredStoreCompactJob } from './jobs/delivered-store-compact.js';
import { proxyPoolRefreshJob } from './jobs/proxy-pool-refresh.js';
import { dlqFlushJob } from './jobs/dlq-flush.js';
import { groundingCheckJob } from './jobs/grounding-check.js';
import { registryContentWatchJob } from './jobs/registry-content-watch.js';
import { dashboardRefreshJob } from './jobs/dashboard-refresh.js';
import { reviewConflictButtonsJob } from './jobs/review-conflict-buttons.js';
import { recallIndexJob } from './jobs/recall-index.js';
import { skillEngagementAuditJob } from './jobs/skill-engagement-audit.js';
import { sharedTmpSweepJob } from './jobs/shared-tmp-sweep.js';
import { botSelfRestartJob } from './jobs/bot-self-restart.js';

/** THE single declared table. Every declared maintenance job across pa and bot hosts
 *  lives under this array — that is the point of the construct. */
export const MAINTENANCE_JOBS: readonly MaintenanceJob[] = [
  // pa-host jobs
  orphanWorkerReapJob,
  blackboardPurgeJob,
  stalenessCheckJob,
  skillLogRotateJob,
  archivePruneJob,
  alertStateGcJob,
  weeklyLearnJob,
  sessionGcJob,
  voiceAttachmentGcJob,
  workerTeeGcJob,
  reservationGcJob,
  restoreDrillJob,
  alertCensusJob,
  clobberSentinelJob,
  redteamRecurringJob,
  reviewConflictButtonsJob,
  recallIndexJob,
  skillEngagementAuditJob,
  sharedTmpSweepJob,
  // bot-host jobs
  botLogRotationCheckJob,
  modelOverrideSweepJob,
  deliveredStoreCompactJob,
  proxyPoolRefreshJob,
  groundingCheckJob,
  registryContentWatchJob,
  dashboardRefreshJob,
  botSelfRestartJob,
  dlqFlushJob,
];

export function jobsForHost(host: MaintenanceHost): MaintenanceJob[] {
  return MAINTENANCE_JOBS.filter((j) => j.host === host);
}

export function findJob(name: string): MaintenanceJob | undefined {
  return MAINTENANCE_JOBS.find((j) => j.name === name);
}
