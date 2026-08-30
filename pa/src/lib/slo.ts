/**
 * SLO-lite error budget tracking
 *
 * Defines service-level objectives with monthly error budgets and
 * deterministic computation from existing logs.
 *
 * Four services in v1:
 * - bot-reply-delivery: 99.5%/mo, events = DLQ TTL expiries + death notices
 * - daily-mail-brief: ≥95%, events = missed 19:00/05:00 IST windows
 * - catchup-heartbeat: gap <30min, events = heartbeat gaps >30min
 * - ekadashi-alerts: zero-miss, events = watchdog miss detections
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { decisionStatsBySkill } from './decisions.js';

export interface SLOServiceDefinition {
  name: string;
  target: number; // Percentage (99.5 = 99.5%)
  targetHuman: string; // Human-readable target
  period: 'month';
  eventSources: string[];
  description: string;
}

export interface SLOEvent {
  timestamp: Date;
  service: string;
  eventType: string;
  details?: string;
}

export interface SLOReport {
  service: string;
  target: number;
  targetHuman: string;
  period: { start: Date; end: Date };
  totalEvents: number;
  errorBudgetUsed: number; // Percentage
  errorBudgetRemaining: number; // Percentage
  status: 'ok' | 'warning' | 'exhausted' | 'unknown';
  eventBreakdown: Record<string, number>;
  missingData: string[];
}

export interface SkillOutcomeRow {
  skill: string;
  total: number;
  approved: number;
  rejected: number;
  replied: number;
  pending: number;
  other_reaction: number;
  actedOnRate: number | null; // null ⇔ total === 0
}

export interface SkillOutcomeReport {
  generatedAt: string;
  windowDays: 30;
  skills: SkillOutcomeRow[];
  inWindow: number;
}

const SERVICE_DEFINITIONS: SLOServiceDefinition[] = [
  {
    name: 'bot-reply-delivery',
    target: 99.5,
    targetHuman: '99.5%',
    period: 'month',
    eventSources: ['telegram-dlq'],
    description: 'Bot reply delivery success rate (DLQ TTL expiries + death notices)',
  },
  {
    name: 'daily-mail-brief',
    target: 95.0,
    targetHuman: '≥95%',
    period: 'month',
    eventSources: ['daily-mail-brief-windows'],
    description: 'Daily mail brief window delivery (missed 19:00/05:00 IST windows)',
  },
  {
    name: 'catchup-heartbeat',
    target: 100.0,
    targetHuman: 'gap <30min',
    period: 'month',
    eventSources: ['app-log'],
    description: 'Catchup heartbeat gaps (events = gaps >30min)',
  },
];

/**
 * Load service definitions from a YAML file
 */
export function loadServiceDefinitions(configPath: string): SLOServiceDefinition[] {
  if (!existsSync(configPath)) {
    return SERVICE_DEFINITIONS;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = parse(content);
    return config.services || SERVICE_DEFINITIONS;
  } catch (error) {
    return SERVICE_DEFINITIONS;
  }
}

/**
 * Parse events from DLQ file (telegram-dlq.jsonl)
 */
function parseDlqEvents(dlqPath: string, monthStart: Date, monthEnd: Date): SLOEvent[] {
  const events: SLOEvent[] = [];

  if (!existsSync(dlqPath)) {
    return events;
  }

  try {
    const content = readFileSync(dlqPath, 'utf-8');
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        const timestamp = new Date(entry.timestamp || entry.enqueuedAt || entry.sentAt);
        if (timestamp >= monthStart && timestamp <= monthEnd) {
          events.push({
            timestamp,
            service: 'bot-reply-delivery',
            eventType: 'dlq-expiry',
            details: entry.reason || 'unknown',
          });
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error
  }

  return events;
}

/**
 * Parse heartbeat gap events from app.log.jsonl
 */
function parseHeartbeatEvents(logPath: string, monthStart: Date, monthEnd: Date): SLOEvent[] {
  const events: SLOEvent[] = [];

  if (!existsSync(logPath)) {
    return events;
  }

  try {
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        const timestamp = new Date(entry.timestamp || entry.time);
        if (timestamp >= monthStart && timestamp <= monthEnd) {
          if (entry.message?.includes('heartbeat') || entry.event === 'heartbeat-gap') {
            const gapMinutes = entry.gapMinutes || entry.gap || 0;
            if (gapMinutes > 30) {
              events.push({
                timestamp,
                service: 'catchup-heartbeat',
                eventType: 'heartbeat-gap',
                details: `gap: ${gapMinutes}min`,
              });
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error
  }

  return events;
}

/**
 * Parse daily mail brief window misses
 */
function parseMailBriefEvents(reportPath: string, monthStart: Date, monthEnd: Date): SLOEvent[] {
  const events: SLOEvent[] = [];

  if (!existsSync(reportPath)) {
    return events;
  }

  try {
    const content = readFileSync(reportPath, 'utf-8');
    const data = JSON.parse(content);

    if (data.misses || data.missedWindows) {
      for (const miss of data.misses || data.missedWindows) {
        const timestamp = new Date(miss.timestamp || miss.date || miss.time);
        if (timestamp >= monthStart && timestamp <= monthEnd) {
          events.push({
            timestamp,
            service: 'daily-mail-brief',
            eventType: 'missed-window',
            details: miss.window || miss.time,
          });
        }
      }
    }
  } catch {
    // File parse error
  }

  return events;
}

/**
 * Parse ekadashi watchdog miss events
 */
function parseEkadashiEvents(receiptsPath: string, monthStart: Date, monthEnd: Date): SLOEvent[] {
  const events: SLOEvent[] = [];

  if (!existsSync(receiptsPath)) {
    return events;
  }

  try {
    const content = readFileSync(receiptsPath, 'utf-8');
    const lines = content.trim().split('\n');

    for (const line of lines) {
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        const timestamp = new Date(entry.timestamp || entry.date || entry.time);
        if (timestamp >= monthStart && timestamp <= monthEnd) {
          if (entry.missed || entry.status === 'missed' || entry.watchdogMiss) {
            events.push({
              timestamp,
              service: 'ekadashi-alerts',
              eventType: 'watchdog-miss',
              details: entry.ekadashi || entry.alertName,
            });
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error
  }

  return events;
}

/**
 * Compute error budget for a service
 */
export function computeErrorBudget(
  service: SLOServiceDefinition,
  events: SLOEvent[],
  monthStart: Date,
  monthEnd: Date
): Omit<SLOReport, 'service'> {
  const eventBreakdown: Record<string, number> = {};
  const missingData: string[] = [];

  // Count events by type
  for (const event of events) {
    eventBreakdown[event.eventType] = (eventBreakdown[event.eventType] || 0) + 1;
  }

  const totalEvents = events.length;

  // For zero-miss services, any event is a budget hit
  const errorBudgetUsed = service.target === 100
    ? totalEvents > 0 ? 100 : 0
    : Math.min(100, (totalEvents / Math.max(1, (100 - service.target) * 10)) * 100);

  const errorBudgetRemaining = Math.max(0, 100 - errorBudgetUsed);

  let status: 'ok' | 'warning' | 'exhausted' | 'unknown';
  if (totalEvents === 0 && missingData.length === 0) {
    status = 'ok';
  } else if (errorBudgetRemaining <= 0) {
    status = 'exhausted';
  } else if (errorBudgetRemaining < 20) {
    status = 'warning';
  } else {
    status = 'ok';
  }

  if (missingData.length > 0) {
    status = 'unknown';
  }

  return {
    target: service.target,
    targetHuman: service.targetHuman,
    period: { start: monthStart, end: monthEnd },
    totalEvents,
    errorBudgetUsed,
    errorBudgetRemaining,
    status,
    eventBreakdown,
    missingData,
  };
}

/**
 * Generate SLO report for a specific month
 */
export function generateMonthlyReport(
  month: Date,
  configPath?: string
): SLOReport[] {
  const reports: SLOReport[] = [];

  // Calculate month boundaries
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 0, 23, 59, 59, 999);

  const definitions = loadServiceDefinitions(configPath || '');

  for (const service of definitions) {
    const events: SLOEvent[] = [];
    const missingData: string[] = [];

    // Collect events from sources
    for (const source of service.eventSources) {
      let sourceEvents: SLOEvent[] = [];
      let sourcePath = '';

      if (source === 'telegram-dlq') {
        sourcePath = join(process.env.PA_HOME || join(process.env.HOME || '', '.pa'), 'telegram-dlq.jsonl');
        if (!existsSync(sourcePath)) {
          missingData.push(source);
        } else {
          sourceEvents = parseDlqEvents(sourcePath, monthStart, monthEnd);
        }
      } else if (source === 'app-log') {
        sourcePath = join(process.env.PA_HOME || join(process.env.HOME || '', '.pa'), 'app.log.jsonl');
        if (!existsSync(sourcePath)) {
          missingData.push(source);
        } else {
          sourceEvents = parseHeartbeatEvents(sourcePath, monthStart, monthEnd);
        }
      } else if (source === 'daily-mail-brief-windows') {
        sourcePath = join(process.env.PA_HOME || join(process.env.HOME || '', '.pa'), 'daily-mail-brief', 'latest.json');
        if (!existsSync(sourcePath)) {
          missingData.push(source);
        } else {
          sourceEvents = parseMailBriefEvents(sourcePath, monthStart, monthEnd);
        }
      } else if (source === 'ekadashi-watchdog') {
        sourcePath = join(process.env.PA_HOME || join(process.env.HOME || '', '.pa'), 'ekadashi-receipts.jsonl');
        if (!existsSync(sourcePath)) {
          missingData.push(source);
        } else {
          sourceEvents = parseEkadashiEvents(sourcePath, monthStart, monthEnd);
        }
      } else {
        missingData.push(source);
      }

      events.push(...sourceEvents);
    }

    const budget = computeErrorBudget(service, events, monthStart, monthEnd);
    budget.missingData = missingData;
    // C3 fix: services with missing data sources have status='unknown'
    // A service with all sources present and no events has status='ok'
    if (missingData.length > 0) {
      budget.status = 'unknown';
    }

    reports.push({
      service: service.name,
      ...budget,
    });
  }

  return reports;
}

/**
 * Format report as table
 */
export function formatReportTable(reports: SLOReport[]): string {
  const lines: string[] = [];

  lines.push('SLO Report - Error Budget Status');
  lines.push('='.repeat(120));
  lines.push('');
  lines.push(sprintf('%-30s %-12s %-12s %-12s %-12s %-12s', 'Service', 'Target', 'Events', 'Used', 'Remaining', 'Status'));
  lines.push('-'.repeat(120));

  for (const report of reports) {
    lines.push(sprintf(
      '%-30s %-12s %-12d %-12.1f%% %-12.1f%% %-12s',
      report.service,
      report.targetHuman,
      report.totalEvents,
      report.errorBudgetUsed,
      report.errorBudgetRemaining,
      report.status.toUpperCase()
    ));
  }

  lines.push('');
  lines.push('Event Breakdown:');
  lines.push('-'.repeat(120));

  for (const report of reports) {
    if (report.totalEvents > 0) {
      lines.push(`${report.service}:`);
      for (const [eventType, count] of Object.entries(report.eventBreakdown)) {
        lines.push(`  ${eventType}: ${count}`);
      }
    }
  }

  for (const report of reports) {
    if (report.missingData.length > 0) {
      lines.push('');
      lines.push(`WARNING: ${report.service} missing data sources: ${report.missingData.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate skill outcome report from decisions.sqlite.
 *
 * Returns null when the DB is absent or empty (no decisions ever recorded).
 * Universe = all-time distinct skills; a skill with no rows in the window
 * gets actedOnRate: null.
 */
export function generateSkillOutcomes(nowMs?: number): SkillOutcomeReport | null {
  const now = nowMs ?? Date.now();

  // Get all-time distinct skills (universe)
  const universeStats = decisionStatsBySkill('1970-01-01T00:00:00.000Z');
  if (!universeStats || universeStats.size === 0) {
    return null; // No decisions ever recorded
  }

  // Get trailing 30d window stats
  const windowStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(now).toISOString();
  const windowStats = decisionStatsBySkill(windowStart, windowEnd);

  const skills: SkillOutcomeRow[] = [];
  const universe = Array.from(universeStats.keys()).sort();
  let inWindow = 0;

  for (const skill of universe) {
    const stats = windowStats?.get(skill);
    if (stats && stats.total > 0) {
      inWindow++;
      const actedOnRate = (stats.approved + stats.replied) / stats.total;
      skills.push({
        skill,
        total: stats.total,
        approved: stats.approved,
        rejected: stats.rejected,
        replied: stats.replied,
        pending: stats.pending,
        other_reaction: stats.other_reaction,
        actedOnRate,
      });
    } else {
      // Skill exists in universe but has no rows in window
      skills.push({
        skill,
        total: 0,
        approved: 0,
        rejected: 0,
        replied: 0,
        pending: 0,
        other_reaction: 0,
        actedOnRate: null,
      });
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: 30,
    skills,
    inWindow,
  };
}

/**
 * Format skill outcomes table for text output.
 */
export function formatSkillOutcomesTable(report: SkillOutcomeReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('Per-skill outcome SLOs (acted_on = approved+replied, trailing 30d)');
  lines.push('-'.repeat(120));
  lines.push(sprintf('%-18s %6s %10s %6s %6s %6s %8s', 'skill', 'rows', 'acted_on', '👍', '👎', 'replied', 'pending'));
  lines.push('-'.repeat(120));

  for (const row of report.skills) {
    if (row.total === 0) {
      lines.push(sprintf('%-18s %6d %10s', row.skill, row.total, 'no decision data'));
    } else {
      const rate = row.actedOnRate !== null ? Math.round(row.actedOnRate * 100) + '%' : 'n/a';
      lines.push(sprintf(
        '%-18s %6d %10s %6d %6d %6d %8d',
        row.skill,
        row.total,
        rate,
        row.approved,
        row.rejected,
        row.replied,
        row.pending
      ));
    }
  }

  lines.push('-'.repeat(120));
  const totalSkills = report.skills.length;
  const withRows = report.inWindow;
  lines.push(`(${totalSkills} skills with decision rows all-time; ${withRows} with rows in window)`);

  return lines.join('\n');
}

// Simple sprintf implementation for table formatting
function sprintf(format: string, ...args: any[]): string {
  return format.replace(/%[-+0-9]*\.?[0-9]*[dfs]/g, (match) => {
    const specifier = match.slice(-1);
    const value = args.shift();

    if (specifier === 'd') {
      return String(Math.floor(value));
    } else if (specifier === 'f') {
      return String(Number(value).toFixed(match.includes('.1') ? 1 : 0));
    } else if (specifier === 's') {
      return String(value);
    }
    return String(value);
  });
}
