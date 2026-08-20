/**
 * pa slo report command
 *
 * Generates SLO error budget reports from existing logs.
 */

import { generateMonthlyReport, formatReportTable } from '../lib/slo.js';

interface SloReportOptions {
  month?: string;
  config?: string;
}

function parseSloReportArgs(args: string[]): SloReportOptions {
  const options: SloReportOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--month' && i + 1 < args.length) {
      options.month = args[++i];
    } else if (args[i] === '--config' && i + 1 < args.length) {
      options.config = args[++i];
    }
  }

  return options;
}

export async function sloReportCommand(args: string[]): Promise<void> {
  const options = parseSloReportArgs(args);

  const month = options.month
    ? new Date(`${options.month}-01`)
    : new Date();

  const reports = generateMonthlyReport(month, options.config);
  const table = formatReportTable(reports);

  console.log(table);
}
