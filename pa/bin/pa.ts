#!/usr/bin/env node

import { runCommand } from '../src/commands/run.js';
import { listCommand } from '../src/commands/list.js';
import { workersCommand } from '../src/commands/workers-cmd.js';
import { logsCommand } from '../src/commands/logs.js';
import { catchupCommand } from '../src/commands/catchup.js';
import { schedulesSyncCommand, schedulesListCommand } from '../src/commands/schedules.js';
import { initCommand } from '../src/commands/init.js';
import { purgeLocksCommand } from '../src/commands/purge-locks.js';
import { botStopCommand, botRestartCommand, botRotateCommand } from '../src/commands/bot.js';
import { setupTopicsCommand } from '../src/commands/setup-topics.js';
import { learnCommand } from '../src/commands/learn.js';
import { draftsCommand } from '../src/commands/drafts-cmd.js';
import { approveCommand } from '../src/commands/approve.js';
import { rejectCommand } from '../src/commands/reject.js';
import { healthCommand } from '../src/commands/health.js';
import { notifyCommand } from '../src/commands/notify-cmd.js';
import { bgtasksCommand } from '../src/commands/bgtasks.js';
import { refCommand } from '../src/commands/ref.js';

const USAGE = `
pa — Personal Assistant CLI Dispatcher

Usage:
  pa init                       Initialize ~/.pa/ directory and config
  pa run <skill> [-- <args>]    Run a skill with automatic worker failover
  pa list                       List all skills with schedules and last run
  pa workers                  Show available AI CLI workers
  pa logs <skill> [--last N]  View execution logs for a skill
  pa catchup [--topic t]      Run missed scheduled skills by topic partition
  pa purge-locks                Clear stale resource locks from blackboard
  pa schedules sync           Register schedules with OS task scheduler
  pa schedules list           Show registered scheduled tasks
  pa bot stop                 Gracefully stop the Telegram bot
  pa bot restart              Gracefully stop the bot (Task Scheduler restarts it)
  pa bot rotate               Rotate the bot log file if it exceeds the size limit
  pa bot setup-topics         Auto-create canonical Telegram forum topics from a template
  pa learn [--days N]         Analyze conversations & failures, propose skill drafts
  pa drafts [--pending|--rejected|--approved]  List skill drafts
  pa approve <name> [--edit]  Approve a draft and install as active skill
  pa reject <name>            Reject a skill draft
  pa health                   Show system health status
  pa notify --subject <s> (--body <b> | --body-file <path> | --body-stdin) [--dedup-key <k>] [--topic-thread <id>] [--severity info|warn|error]
  pa bgtasks [--json] [--kill <pid>]  List or kill background descendant processes
  pa ref <refId>              Look up what message produced a Ref ID (e.g. 'pa ref c-a59a')
  pa help                     Show this help message
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'init':
        await initCommand();
        break;

      case 'run': {
        const skillName = args[1];
        const dashIdx = args.indexOf('--');
        const workerIdx = args.indexOf('--worker');
        // Only accept --worker if it appears before -- (or there's no --)
        const preferredWorker = (workerIdx !== -1 && (dashIdx === -1 || workerIdx < dashIdx))
          ? args[workerIdx + 1] : undefined;
        const extraArgs = dashIdx !== -1 ? args.slice(dashIdx + 1) : [];
        await runCommand(skillName, extraArgs, 0, preferredWorker);
        break;
      }

      case 'list':
      case 'ls':
        await listCommand();
        break;

      case 'workers':
        await workersCommand();
        break;

      case 'logs': {
        const skillName = args[1];
        const lastIdx = args.indexOf('--last');
        const count = lastIdx !== -1 ? parseInt(args[lastIdx + 1], 10) || 10 : 10;
        const full = args.includes('--full');
        await logsCommand(skillName, count, full);
        break;
      }

      case 'catchup': {
        const topicIdx = args.indexOf('--topic') !== -1 ? args.indexOf('--topic') : args.indexOf('-t');
        const topic = topicIdx !== -1 ? args[topicIdx + 1] : undefined;
        await catchupCommand({ topic });
        break;
      }

      case 'purge-locks':
        await purgeLocksCommand();
        break;

      case 'schedules': {
        const sub = args[1];
        if (sub === 'sync') {
          await schedulesSyncCommand();
        } else if (sub === 'list') {
          await schedulesListCommand();
        } else {
          console.log('Usage: pa schedules <sync|list>');
        }
        break;
      }

      case 'bot': {
        const sub = args[1];
        if (sub === 'stop') {
          await botStopCommand();
        } else if (sub === 'restart') {
          await botRestartCommand();
        } else if (sub === 'rotate') {
          await botRotateCommand();
        } else if (sub === 'setup-topics') {
          await setupTopicsCommand(args.slice(2));
        } else {
          console.log('Usage: pa bot <stop|restart|rotate|setup-topics>');
        }
        break;
      }

      case 'learn': {
        const daysIdx = args.indexOf('--days');
        const days = daysIdx !== -1 ? parseInt(args[daysIdx + 1], 10) || 14 : 14;
        const conversationsOnly = args.includes('--conversations-only');
        const failuresOnly = args.includes('--failures-only');
        await learnCommand(days, { conversationsOnly, failuresOnly });
        break;
      }

      case 'drafts': {
        const filter = args.includes('--rejected') ? 'rejected'
          : args.includes('--approved') ? 'approved'
          : 'pending';
        await draftsCommand(filter);
        break;
      }

      case 'approve':
        await approveCommand(args[1], args.includes('--edit'));
        break;

      case 'reject':
        await rejectCommand(args[1]);
        break;

      case 'health':
        await healthCommand();
        break;

      case 'notify':
        await notifyCommand(args.slice(1));
        break;

      case 'bgtasks':
        await bgtasksCommand(args.slice(1));
        break;

      case 'ref':
        await refCommand(args[1]);
        break;

      case 'help':
      case '--help':
      case '-h':
      case undefined:
        console.log(USAGE);
        break;

      default:
        throw new Error(`Unknown command: ${command}\nRun 'pa help' for usage.`);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
