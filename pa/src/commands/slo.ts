/**
 * pa slo report command
 *
 * Generates SLO error budget reports from existing logs.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { generateMonthlyReport, formatReportTable, generateSkillOutcomes, formatSkillOutcomesTable } from '../lib/slo.js';
import { paHome } from '../paths.js';

/**
 * Default SLO config resolution: `~/.pa/slo.yaml` (honoring PA_HOME) when it
 * exists; otherwise undefined → loadServiceDefinitions falls back to the
 * built-in generic defaults. Explicit `--config` always wins.
 */
function defaultSloConfigPath(): string | undefined {
  const p = join(paHome(), 'slo.yaml');
  return existsSync(p) ? p : undefined;
}

interface SloReportOptions {
  month?: string;
  config?: string;
  json?: boolean;
}

function parseSloReportArgs(args: string[]): SloReportOptions {
  const options: SloReportOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--month' && i + 1 < args.length) {
      options.month = args[++i];
    } else if (args[i] === '--config' && i + 1 < args.length) {
      options.config = args[++i];
    } else if (args[i] === '--json') {
      options.json = true;
    }
  }

  return options;
}

export async function sloReportCommand(args: string[]): Promise<void> {
  const options = parseSloReportArgs(args);

  const month = options.month
    ? new Date(`${options.month}-01`)
    : new Date();

  const reports = generateMonthlyReport(month, options.config || defaultSloConfigPath());
  const skillOutcomes = generateSkillOutcomes();

  if (options.json) {
    const monthStr = month.toISOString().slice(0, 7); // YYYY-MM
    const payload = {
      month: monthStr,
      generatedAt: new Date().toISOString(),
      services: reports.map(r => ({
        service: r.service,
        target: r.target,
        targetHuman: r.targetHuman,
        periodStart: r.period.start.toISOString(),
        periodEnd: r.period.end.toISOString(),
        totalEvents: r.totalEvents,
        errorBudgetUsed: r.errorBudgetUsed,
        errorBudgetRemaining: r.errorBudgetRemaining,
        status: r.status,
        eventBreakdown: r.eventBreakdown,
        missingData: r.missingData,
      })),
      skillOutcomes: skillOutcomes,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const table = formatReportTable(reports);
    console.log(table);

    if (skillOutcomes) {
      console.log('\n' + formatSkillOutcomesTable(skillOutcomes));
    } else {
      console.log('\nPer-skill outcome SLOs: no decision data (decisions.sqlite absent or empty)');
    }
  }
}
