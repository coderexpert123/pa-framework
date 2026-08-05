import type { MaintenanceJob } from '../types.js';
import {
  GC_RETENTION_MS,
  AGY_CONVERSATION_FILE_RE,
  agyConversationsDir,
  codexStateDbPath,
  cleanupExpiredSessions,
} from '../../session-gc.js';

const HOUR = 3_600_000;

export const sessionGcJob: MaintenanceJob = {
  name: 'session-gc',
  host: 'pa',
  everyMs: 6 * HOUR,
  description: 'Delete expired Antigravity (agy) conversation files and archive expired Codex threads. Never touches Claude Code or Gemini CLI transcripts (both self-manage their own retention).',
  destructive: true,
  shedWhenDegraded: true,
  targets: [
    {
      resolve: agyConversationsDir,
      match: AGY_CONVERSATION_FILE_RE,
      maxAgeMs: GC_RETENTION_MS,
      action: 'delete',
      ownership: 'external-no-retention',
      evidence: 'Antigravity CLI ships no retention policy of its own (audit 2026-08-02); PA prunes at 30d — plans/2026-08-02-session-gc-scope-to-pa-spawned.md. UUID-anchored filter so index/state .pb artifacts in the same directory are never touched.',
    },
    {
      resolve: codexStateDbPath,
      match: /^state_5\.sqlite$/,
      maxAgeMs: GC_RETENTION_MS,
      action: 'archive',
      ownership: 'external-no-retention',
      evidence: 'Codex CLI ships no retention policy of its own (audit 2026-08-02). Rows are marked archived=1, never deleted.',
      note: 'A SQLite file: rows are not enumerable by readdir, so the preview reports existence only.',
    },
  ],
  async run(ctx) {
    return { touched: await cleanupExpiredSessions(ctx.now) };
  },
};
