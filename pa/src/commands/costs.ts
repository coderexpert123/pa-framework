import { readFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../paths.js';
import type { UsageRecord } from '../lib/usage-ledger.js';

interface CostFilters {
  period: 'all' | 'week' | 'month';
  skill?: string;
}

interface RollupRow {
  worker: string;
  model?: string;
  skill?: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  tokensThinking: number;
  tokensCacheRead: number;
  totalTokens: number;
}

/**
 * Parse ~/.pa/logs/usage.jsonl and aggregate records by filters.
 */
async function readUsageLedger(): Promise<UsageRecord[]> {
  try {
    const usagePath = join(paHome(), 'logs', 'usage.jsonl');
    const content = await readFile(usagePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const records: UsageRecord[] = [];

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as UsageRecord;
        records.push(record);
      } catch {
        // Skip malformed lines
      }
    }

    return records;
  } catch {
    // File doesn't exist or isn't readable yet
    return [];
  }
}

/**
 * Filter usage records by time period and optional skill name.
 */
function filterRecords(records: UsageRecord[], filters: CostFilters): UsageRecord[] {
  const now = new Date();
  let cutoffDate: Date | undefined;

  if (filters.period === 'week') {
    cutoffDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (filters.period === 'month') {
    cutoffDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  return records.filter(record => {
    // Time filter
    if (cutoffDate) {
      const recordDate = new Date(record.ts);
      if (recordDate < cutoffDate) return false;
    }

    // Skill filter
    if (filters.skill && record.resource !== filters.skill) {
      return false;
    }

    return true;
  });
}

/**
 * Aggregate filtered records into rollup rows grouped by worker/model/skill.
 */
function aggregateRecords(records: UsageRecord[]): RollupRow[] {
  const grouped = new Map<string, RollupRow>();

  for (const record of records) {
    const key = `${record.worker}:${record.model || ''}:${record.resource}`;
    let row = grouped.get(key);

    if (!row) {
      row = {
        worker: record.worker,
        model: record.model,
        skill: record.resource,
        runs: 0,
        tokensIn: 0,
        tokensOut: 0,
        tokensThinking: 0,
        tokensCacheRead: 0,
        totalTokens: 0,
      };
      grouped.set(key, row);
    }

    row.runs++;
    row.tokensIn += record.tokensIn;
    row.tokensOut += record.tokensOut;
    row.tokensThinking += record.tokensThinking || 0;
    row.tokensCacheRead += record.tokensCacheRead || 0;
    row.totalTokens = row.tokensIn + row.tokensOut + row.tokensThinking + row.tokensCacheRead;
  }

  // Convert to array and sort by total tokens descending
  return Array.from(grouped.values()).sort((a, b) => b.totalTokens - a.totalTokens);
}

/**
 * Format a rollup row as a table row.
 */
function formatRow(row: RollupRow): string {
  const worker = row.worker.padEnd(12);
  const model = (row.model || '-').padEnd(20);
  const skill = (row.skill || '-').padEnd(25);
  const runs = String(row.runs).padStart(6);
  const inTokens = formatNumber(row.tokensIn).padStart(10);
  const outTokens = formatNumber(row.tokensOut).padStart(10);
  const thinkTokens = formatNumber(row.tokensThinking).padStart(10);
  const cacheTokens = formatNumber(row.tokensCacheRead).padStart(10);
  const total = formatNumber(row.totalTokens).padStart(12);

  return `${worker} ${model} ${skill} ${runs} ${inTokens} ${outTokens} ${thinkTokens} ${cacheTokens} ${total}`;
}

/**
 * Format a number with thousand separators.
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Print the costs report as a table.
 */
function printReport(rows: RollupRow[], filters: CostFilters): void {
  if (rows.length === 0) {
    console.log(`No usage records found for the specified period (${filters.period}${filters.skill ? ` skill: ${filters.skill}` : ''}).`);
    return;
  }

  const header = `${'Worker'.padEnd(12)} ${'Model'.padEnd(20)} ${'Skill/Resource'.padEnd(25)} ${'Runs'.padStart(6)} ${'In'.padStart(10)} ${'Out'.padStart(10)} ${'Thinking'.padStart(10)} ${'Cache'.padStart(10)} ${'Total'.padStart(12)}`;
  const separator = '-'.repeat(120);

  console.log(separator);
  console.log(header);
  console.log(separator);

  for (const row of rows) {
    console.log(formatRow(row));
  }

  console.log(separator);

  // Print totals
  const totalRuns = rows.reduce((sum, r) => sum + r.runs, 0);
  const totalIn = rows.reduce((sum, r) => sum + r.tokensIn, 0);
  const totalOut = rows.reduce((sum, r) => sum + r.tokensOut, 0);
  const totalThinking = rows.reduce((sum, r) => sum + r.tokensThinking, 0);
  const totalCache = rows.reduce((sum, r) => sum + r.tokensCacheRead, 0);
  const grandTotal = totalIn + totalOut + totalThinking + totalCache;

  console.log(`${'TOTAL'.padEnd(12)} ${''.padEnd(20)} ${''.padEnd(25)} ${String(totalRuns).padStart(6)} ${formatNumber(totalIn).padStart(10)} ${formatNumber(totalOut).padStart(10)} ${formatNumber(totalThinking).padStart(10)} ${formatNumber(totalCache).padStart(10)} ${formatNumber(grandTotal).padStart(12)}`);
  console.log(separator);
}

export async function costsCommand(args: string[]): Promise<void> {
  const filters: CostFilters = { period: 'all' };

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--week') {
      filters.period = 'week';
    } else if (arg === '--month') {
      filters.period = 'month';
    } else if (arg === '--skill' && i + 1 < args.length) {
      filters.skill = args[++i];
    }
  }

  const records = await readUsageLedger();
  const filtered = filterRecords(records, filters);
  const aggregated = aggregateRecords(filtered);
  printReport(aggregated, filters);
}
