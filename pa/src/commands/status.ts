import { checkBotProcess, checkBlackboard, checkConversationLog, checkBotLog, checkAppLog, checkWorkers, checkSkills, checkSecrets, checkLastCatchup, checkDiskLogs, checkRefIdLogging } from './health.js';
import { listSkills } from '../skills.js';
import { getLastRun } from '../logger.js';
import { getOverdueSkills } from '../scheduler.js';
import { readActive } from '../lib/reservations.js';
import { checkGitWorkflowAllowed } from '../lib/git-guard.js';
import { dlqEntryCount } from './dlq.js';
import { readLedger } from '../lib/maintenance/state.js';
import { parseExpression } from 'cron-parser';
import type { CheckResult } from './health.js';

export interface StatusDeps {
  /** Test-only: overrides the git-workflow probe. */
  gitGuardFn?: () => Promise<import('../lib/git-guard.js').GitGuardResult>;
}

export async function statusCommand(deps: StatusDeps = {}): Promise<void> {
  const header = `PA Status — ${new Date().toISOString()}`;
  console.log(`\n${header}`);
  console.log('─'.repeat(header.length));

  // ---- Section 1: Health ----
  try {
    const checks = await Promise.all([
      checkBotProcess(),
      checkBlackboard(),
      checkConversationLog(),
      checkBotLog(),
      checkAppLog(),
      checkWorkers(),
      checkSkills(),
      checkSecrets(),
      checkLastCatchup(),
      checkDiskLogs(),
      checkRefIdLogging(),
    ]);

    const ok = checks.filter((c: CheckResult) => c.status === 'OK').length;
    const warn = checks.filter((c: CheckResult) => c.status === 'WARN').length;
    const fail = checks.filter((c: CheckResult) => c.status === 'FAIL').length;
    const failingNames = checks.filter((c: CheckResult) => c.status === 'FAIL').map((c: CheckResult) => c.name);
    console.log(`  health:       <ok> ${ok}, <warn> ${warn}, <fail> ${fail}${fail > 0 ? ` (failing: ${failingNames.join(', ')})` : ''}`);
  } catch (err: any) {
    console.log(`  health:       unavailable (${err.message})`);
  }

  // ---- Section 2: Git ----
  try {
    const result = deps.gitGuardFn ? await deps.gitGuardFn() : await checkGitWorkflowAllowed();
    const status = result.allowed ? 'allowed' : 'not allowed';
    console.log(`  git:          ${status} — ${result.reason}`);
  } catch (err: any) {
    console.log(`  git:          unavailable (${err.message})`);
  }

  // ---- Section 3: Skills ----
  try {
    const skills = await listSkills();
    const scheduled = skills.filter((s) => s.frontmatter.cron !== undefined).length;
    const overdue = (await getOverdueSkills()).length;
    console.log(`  skills:       ${skills.length} total (${scheduled} scheduled), ${overdue} overdue`);
  } catch (err: any) {
    console.log(`  skills:       unavailable (${err.message})`);
  }

  // ---- Section 4: Next Due ----
  try {
    const skills = await listSkills();
    const now = Date.now();
    const nextRuns: Array<{ name: string; diff: string }> = [];

    for (const skill of skills) {
      const cron = skill.frontmatter.cron;
      if (!cron) continue;
      try {
        const interval = parseExpression(cron);
        const next = interval.next().getTime();
        const diffMs = next - now;
        let diff: string;
        if (diffMs <= 90 * 60_000) {
          diff = `${Math.round(diffMs / 60_000)}m`;
        } else if (diffMs <= 90 * 24 * 60_000) {
          diff = `${Math.round(diffMs / (24 * 60_000))}d`;
        } else {
          diff = `${Math.round(diffMs / (60_000))}h`;
        }
        nextRuns.push({ name: skill.name, diff });
      } catch {
        // Unparseable cron — skip silently
      }
    }

    nextRuns.sort((a, b) => a.diff.localeCompare(b.diff));
    const top3 = nextRuns.slice(0, 3);
    if (top3.length === 0) {
      console.log(`  next due:     none`);
    } else {
      const lines = top3.map((r) => `${r.name} in ${r.diff}`).join(', ');
      console.log(`  next due:     ${lines}`);
    }
  } catch (err: any) {
    console.log(`  next due:     unavailable (${err.message})`);
  }

  // ---- Section 5: Claims ----
  try {
    const claims = await readActive();
    console.log(`  claims:       ${claims.length} active`);
    const toShow = claims.slice(0, 5);
    for (const claim of toShow) {
      console.log(`    ${claim.id} (${claim.session})`);
    }
  } catch (err: any) {
    console.log(`  claims:       unavailable (${err.message})`);
  }

  // ---- Section 6: DLQ ----
  try {
    const { total, quarantined } = await dlqEntryCount();
    console.log(`  dlq:          ${total} entry(ies), ${quarantined} quarantined`);
  } catch (err: any) {
    console.log(`  dlq:          unavailable (${err.message})`);
  }

  // ---- Section 7: Maintenance ----
  try {
    const ledger = await readLedger();
    const jobs = Object.values(ledger.jobs);
    const failing = jobs.filter((j) => j.lastOutcome === 'failed').length;
    const skippedStale = jobs.filter((j) => j.consecutiveSkips > 0).length;
    console.log(`  maintenance:  ${failing} failing, ${skippedStale} skipped-stale`);
  } catch (err: any) {
    console.log(`  maintenance:  unavailable (${err.message})`);
  }

  console.log('─'.repeat(header.length));
}
