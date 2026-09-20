#!/usr/bin/env node

import { runCommand, exitCodeForCommandResult } from '../src/commands/run.js';
import { listCommand } from '../src/commands/list.js';
import { workersCommand } from '../src/commands/workers-cmd.js';
import { logsCommand } from '../src/commands/logs.js';
import { catchupCommand } from '../src/commands/catchup.js';
import { schedulesSyncCommand, schedulesListCommand } from '../src/commands/schedules.js';
import { initCommand } from '../src/commands/init.js';
import { purgeLocksCommand } from '../src/commands/purge-locks.js';
import { botStopCommand, botRestartCommand, botRotateCommand } from '../src/commands/bot.js';
import { setupTopicsCommand } from '../src/commands/setup-topics.js';
import { refreshCardsCommand } from '../src/commands/refresh-cards.js';
import { learnCommand } from '../src/commands/learn.js';
import { draftsCommand } from '../src/commands/drafts-cmd.js';
import { approveCommand } from '../src/commands/approve.js';
import { rejectCommand } from '../src/commands/reject.js';
import { healthCommand } from '../src/commands/health.js';
import { notifyCommand } from '../src/commands/notify-cmd.js';
import { pingCommand } from '../src/commands/ping-cmd.js';
import { bgtasksCommand } from '../src/commands/bgtasks.js';
import { refCommand } from '../src/commands/ref.js';
import { recallCommand } from '../src/commands/recall.js';
import { improvementsCommand, acceptRollbackCommand } from '../src/commands/improvements.js';
import { costsCommand } from '../src/commands/costs.js';
import { maintenanceCommand } from '../src/commands/maintenance.js';
import { publicSyncCommand } from '../src/commands/public-sync.js';
import { claimCommand, releaseCommand, claimsCommand } from '../src/commands/claim.js';
import { reconcileCommand } from '../src/commands/reconcile.js';
import { dlqCommand } from '../src/commands/dlq.js';
import { chainRunCommand, chainListCommand } from '../src/commands/chain.js';
import { sloReportCommand } from '../src/commands/slo.js';
import { rulesCommand } from '../src/commands/rules.js';
import { fixCommand } from '../src/commands/fix.js';
import { gitGuardCommand } from '../src/commands/git-guard.js';
import { statusCommand } from '../src/commands/status.js';
import { watchCommand } from '../src/commands/watch.js';
import { topicTaskCommand, topicNoteCommand, topicEventsCommand } from '../src/commands/topic.js';
import { orphanCommand } from '../src/commands/orphan.js';
import { brainSweepCommand } from '../src/commands/brain-sweep.js';
import { docsLintCommand } from '../src/commands/docs-lint.js';
import { backlogCommand } from '../src/commands/backlog.js';
import { authCommand } from '../src/commands/auth.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { coexistenceCommand } from '../src/commands/coexistence.js';
import { verifyInstallCommand } from '../src/commands/verify-install.js';
import { busCommand } from '../src/commands/bus.js';
import { browserEnsureCommand, browserStopCommand } from '../src/commands/browser.js';
import { typesafeCommand } from '../src/commands/typesafe.js';

async function mcpServeCommand(): Promise<void> {
  // @ts-ignore - .mjs module without declaration file
  await import('../mcp/server.mjs');
  // Server is now running on stdio
}

async function mcpManifestCommand(): Promise<void> {
  const { repoRootFromModule } = await import('../src/lib/git-root.js');
  const repoRoot = await repoRootFromModule(__filename);
  const mcpServerPath = repoRoot.replace(/\\/g, '/') + '/pa/mcp/server.mjs';

  const manifest = {
    name: 'pa-cli-mcp-server',
    version: '1.0.0',
    description: 'Personal Assistant CLI MCP server — read-only tools for pa lookup and coordination',
    tools: [
      {
        name: 'pa_ref_lookup',
        description: 'Look up a pa ref-ID (e.g. "c-a59a") to find what message produced it. Returns the full record with timestamp, worker, chat context, and text preview.',
      },
      {
        name: 'pa_claims',
        description: 'List active path reservations and recently modified files (last 15 minutes). Used for multi-session coordination.',
      },
      {
        name: 'pa_maintenance_status',
        description: 'Show the maintenance ledger — last run time, outcome, consecutive failures/skips for each declared maintenance job.',
      },
      {
        name: 'pa_costs',
        description: 'Show usage/cost rollup by worker, model, and skill. Supports time periods (week/month) and optional skill filtering.',
      },
      {
        name: 'pa_slo_report',
        description: 'Generate SLO error budget report. Shows service-level objectives, error budget consumed/remaining, and event breakdowns.',
      },
      {
        name: 'pa_recall',
        description: 'Full-text search across archived conversation turns, worker run traces, per-topic brains, the Ecosystem KB and judgment-call decision rows. Use before assuming something was never discussed.',
      },
    ],
    transport: 'stdio',
    command: 'pa mcp serve',
  };

  console.log('# pa MCP Server Manifest\n');
  console.log('Save this manifest to ~/.pa/mcp.json for manual registration:\n');
  console.log('```json');
  console.log(JSON.stringify(manifest, null, 2));
  console.log('```\n');
  console.log('## Registration Instructions\n');
  console.log('### Claude (claude mcp add)\n');
  console.log('```bash');
  console.log('claude mcp add pa-mcp -- pa mcp serve');
  console.log('```\n');
  console.log("`--` separates the server name from the launch command. Stdio is the default transport, so no transport flag is needed (use `--transport http` only for URL servers). The `-s` scope flag chooses where the entry lands: `local` (default) writes `~/.claude.json` under the current project's entry, `user` makes it available in every project, and `project` writes a `.mcp.json` at the project root.\n");
  console.log('### Codex (~/.codex/config.toml — TOML, one [mcp_servers.<name>] table per server)\n');
  console.log('```toml');
  console.log('[mcp_servers.pa-mcp]');
  console.log('command = "node"');
  console.log(`args = ["${mcpServerPath}"]`);
  console.log('```\n');
  console.log('Optional `[mcp_servers.<name>.env]` and `[mcp_servers.<name>.tools.<tool>]` (e.g. an `approval_mode` override) tables sit alongside. There is no `~/.codex/config.json` — Codex reads only the TOML file.\n');
  console.log('### agy (~/.gemini/settings.json — top-level mcpServers object)\n');
  console.log('```json');
  console.log('{');
  console.log('  "mcpServers": {');
  console.log('    "pa-mcp": {');
  console.log('      "command": "node",');
  console.log(`      "args": ["${mcpServerPath}"]`);
  console.log('    }');
  console.log('  }');
  console.log('}');
  console.log('```\n');
  console.log('Entries use the same `{command, args, env, cwd}` stdio shape as Claude (plus `timeout` and `trust`). There is no `~/.agy/config.yaml` — agy\'s MCP servers are configured in `~/.gemini/settings.json` (a per-project `.gemini/settings.json` works the same way).\n');
}

const USAGE = `
pa — Personal Assistant CLI Dispatcher

Usage:
  pa init                       Initialize ~/.pa/ directory and config
  pa run <skill> [--worker <name>] [--session <label>] [-- <args>]  Run a skill with automatic worker failover
  pa list                       List all skills with schedules and last run
  pa workers                  Show available AI CLI workers
  pa logs <skill> [--last N]  View execution logs for a skill
  pa catchup [--topic t]      Run missed scheduled skills once, by topic partition
  pa catchup --loop           Run the long-lived scheduler loop (skills + maintenance lanes)
  pa purge-locks                Clear stale resource locks from blackboard
  pa schedules sync           Register schedules with OS task scheduler
  pa schedules list           Show registered scheduled tasks
  pa bot stop                 Gracefully stop the Telegram bot
  pa bot restart              Gracefully stop the bot (Task Scheduler restarts it)
  pa bot rotate               Rotate the bot log file if it exceeds the size limit
  pa bot setup-topics         Auto-create canonical Telegram forum topics from a template
  pa bot refresh-cards        Refresh pinned status cards across topics
  pa learn [--days N]         Analyze conversations & failures, propose skill drafts
  pa drafts [--pending|--rejected|--approved]  List skill drafts
  pa approve <name> [--edit]  Approve a draft and install as active skill
  pa reject <name>            Reject a skill draft
  pa fix <family> [--note "..."]  Record a shipped fix in the fix ledger (stops the family re-alerting)
  pa fix --list                 List fix-ledger records (oldest first)
  pa watch add --desc "<text>" --type <file_exists|file_gone|file_newer_than|file_contains|process_gone> [--path <p>|--pattern <re>|--pid <n>|--since <iso>] [--deadline <dur>] [--interval <dur>] [--chat-id <id>] [--thread-id <n>]
  pa watch list [--json]      List registered async watches (active + last 10 terminal)
  pa watch rm <id>            Cancel a watch (no Telegram report is sent)
  pa watch re-register <id>   Re-arm a terminal watch (copy spec into a fresh active row)
  pa auth request --shape S1|S2|S3|S4|S5 --provider <name> [--prompt <text>] [--task <vi-id>] [--tenant <t-id>] [--expires <seconds>] [--confirmable] [--json]
  pa auth wait <request-id> [--timeout <seconds>] [--json]  Poll until answered, expired, or timed out
  pa auth answer --request <request-id> [--tenant <t-id>]  Deliver a value from stdin (bot/interactive shells only)
  pa auth learn --provider <name> --shape S1..S5 --command <text>  Record a provider profile in ~/.pa/auth-profiles.yaml
  pa topic-task add <chatId>_<threadId> --title "<t>" --prompt "<p>" [--worker <pin>]  Queue a task for the topic's bot drain (content-hash dedup)
  pa topic-task list <topicKey>  List a topic's queued + in-flight (running/parked) tasks
  pa topic-note add <topicKey> "<text>" [--key <k>] [--expires YYYY-MM-DD]  Add an OPEN note to the topic store (rendered into the prompt's Open items)
  pa topic-note list <topicKey>  List the topic's notes from the store
  pa topic-note close <topicKey> <key>  Close an OPEN note (DONE)
  pa topic-events <topicKey>  Show the topic's event log (newest last, last 20)
  pa git-guard [<dir>] [--session <label>] [--path <p> ... | -- <path>...]
                             Check whether skills may run git on your behalf; also refuses when a commit
                             target (staged index, or named paths) sits under a foreign ACTIVE claim (exit 0 = yes, 1 = no)
  pa health                   Show system health status
  pa doctor [--json|--text]   Detect machine profile: os/shell/cpu/mem/disk/scheduler/workers (read-only; JSON default, --text table)
  pa coexistence list|restore List/restore pa's registered, reversible edits to existing CLI configs (registry-and-restore)
  pa verify-install [--json] [--skill <name>] Run the install acceptance probes; JSON emits the pinned verdict schema
  pa status                   One-screen overview: health, git, skills/next-due, claims, DLQ, maintenance
  pa notify --subject <s> (--body <b> | --body-file <path> | --body-stdin) [--dedup-key <k>] [--topic-thread <id>] [--severity info|warn|error]
  pa ping --title <t> [--body <b>] | --payload-file <path.json> [--cleanup] [--no-toast] [--no-ping]
  pa bgtasks [--json] [--kill <pid>]  List or kill background descendant processes
  pa browser ensure [--headed|--headless] [--port N]   Launch/attach PA's CDP Chrome (prints the handle as JSON)
  pa browser stop               Kill the pidfile-recorded browser-session Chrome
  pa ref <refId>              Look up what message produced a Ref ID (e.g. 'pa ref c-a59a')
  pa recall "<q>" [--thread N] [--json]   Full-text search over turns, traces, brains, KB
  pa improvements [--since N] Eval self-improver's applied/rolled-back changes (default 30d)
  pa improvements accept <commit_hash> [--reason "..."]  Record a human decision to KEEP a commit whose rollback failed
  pa maintenance list         List declared maintenance jobs + resolved target paths
  pa brain-sweep [--skill-held-lock]  Deterministic update-brain snapshot: commit managed brain paths per owner, defer+alert the rest (never --allow-empty)
  pa docs-lint [--] [path ...]      Budgeted-doc gate (AI-242): size budgets + 24h same-file-trim counter; scoped to named paths or all budgeted docs (exit 0 clean, 1 = landing fails)
  pa backlog add --section <bugs|features|process> --title "<t>" (--body "<text>" | --body-file <path>) --session <label>
  pa backlog status --target <AI-nnn> --status-line "<full replacement paragraph>" --session <label>
  pa backlog pending [--json]    List unmerged fragments (dedup check before filing)
  pa backlog archive [--dry-run]    Move DONE-class items out of backlog/open-*.md into backlog/completed-<date>.md
  pa backlog migrate    One-time cutover: BACKLOG.md → router + backlog/open-*.md section files
  pa orphan <list|land|keep|diff> [gid]  Orphaned-edit store + operator-gated disposition (land re-checks reservations/lock at press time)
  pa maintenance status       Show the maintenance ledger (last run, outcome, skips)
  pa maintenance run <job> [--dry-run]  Run one job now; --dry-run touches nothing
  pa public-sync [--public-dir <path>] [--dry-run]  Sync the derived pa-public mirror (nested at <repo root>/pa-public) from private HEAD
  pa claim <path...> --session <label> --note "<text>" [--ttl <minutes>] [--force] [--wait <seconds>]
                               Reserve path(s)/@logical-resource for multi-session coordination
  pa claim --renew <id> [--ttl <minutes>]  Extend an existing reservation
  pa release <id> [--session <label>] [--force]  Release a reservation by id (ownership-checked when --session is given)
  pa claims [--stats [--days N] [--json]]  Show active reservations + recently modified paths, or a reservation-activity rollup
  pa reconcile [--check [--range <ref>] [--max-commits <n>]] [--restore <path>] [--merge <path>]  Detect/restore/diagnose reverted files (live tree or pushed range)
  pa dlq list                 List Dead Letter Queue entries (age, attempts, quarantined, preview)
  pa dlq replay <index|all>   Clear quarantined flag and reset attempts (retry on next flush)
  pa dlq discard <index|all>  Remove entries from DLQ
  pa costs [--day|--week|--month] [--skill <name>] [--json]  Show usage/cost rollup by worker, model, and skill
  pa slo report [--month <YYYY-MM>] [--json]  Generate SLO error budget report
  pa rules list [--active] | show <id> | supersede <id> --reason "…" | accept <id> | weekly [--json]  Feedback-rules store (AI-165)
  pa mcp serve                Start the MCP stdio server (for Claude/Codex/agy integration)
  pa mcp manifest             Print MCP manifest + registration instructions
  pa bus send <to> --from <addr> --body <text> [--reply-to <id>]  Send a bus message (content-hash dedup)
  pa bus inbox <address> [--peek]    Pop (or peek) the next message; touches cursor
  pa bus list <address>              List queued envelopes for an address (no consume)
  pa bus wait <address> [--timeout <s>]  Wait for a new envelope (default 60s)
  pa bus register <address> --capabilities <csv>  Register an address
  pa bus registry                    List registered addresses + capabilities
  pa bus whoami [--provider <name>] [--repo <name>]  Print the derived provider@repo address
  pa typesafe check [--samples N]  Send N trivial TypeSafe questions; print latency and token usage (needs TYPESAFE_API_KEY)
  pa typesafe eval [--since YYYY-MM-DD] [--limit N] [--dry-run] [--out <path>]  Replay LLM-routed voice tasks through typed routing; print agreement by confidence
  pa typesafe eval --judge [--since D] [--until D] [--limit N] [--agy N] [--labels-only] [--dry-run] [--out <path>]  Score the code/general turn judge against Claude-labelled past requests
  pa chain run <name>         Execute a sequential workflow chain
  pa chain list               List available chains
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
        const promptArgsIdx = args.indexOf('--prompt-args');
        const sessionIdx = args.indexOf('--session');
        // Only accept --worker if it appears before -- (or there's no --)
        const preferredWorker = (workerIdx !== -1 && (dashIdx === -1 || workerIdx < dashIdx))
          ? args[workerIdx + 1] : undefined;
        // Only accept --prompt-args if it appears before -- (or there's no --)
        const promptArgs = (promptArgsIdx !== -1 && (dashIdx === -1 || promptArgsIdx < dashIdx))
          ? args[promptArgsIdx + 1] : undefined;
        // Only accept --session if it appears before -- (or there's no --)
        const sessionLabel = (sessionIdx !== -1 && (dashIdx === -1 || sessionIdx < dashIdx))
          ? args[sessionIdx + 1] : undefined;
        if ((promptArgs === undefined && promptArgsIdx !== -1 && (dashIdx === -1 || promptArgsIdx < dashIdx))
          || (sessionLabel === undefined && sessionIdx !== -1 && (dashIdx === -1 || sessionIdx < dashIdx))) {
          console.error('Usage: pa run <skill> [--prompt-args "<text>"] [--worker <name>] [--session <label>] [-- <extra-args>]');
          process.exitCode = 2;
          break;
        }
        // AI-255 B1: PA_SESSION is the claims-gate identity `pa git-guard`
        // reads — the worker env spreads process.env, so pinning it here
        // reaches the skill's git-guard children AND trigger-child `pa run`s
        // for free. Fallback: a session that only ever registered a bus
        // address (the hooks' env) still gets an exemptable identity.
        if (sessionLabel) process.env.PA_SESSION = sessionLabel;
        if (!process.env.PA_SESSION && process.env.PA_BUS_ADDRESS) {
          process.env.PA_SESSION = process.env.PA_BUS_ADDRESS;
        }
        const extraArgs = dashIdx !== -1 ? args.slice(dashIdx + 1) : [];
        // AI-179 WP-2: this CommandResult used to be discarded, so every `pa run`
        // exited 0 and a failed push read as success. Map it to the exit code —
        // chains.ts's spawnPa keys success on this code, so chain `on_failure` now
        // fires on real skill failures. The bot's spawns stay fire-and-forget BY
        // DESIGN and must NOT start consuming it (no failover on a lock-lost abort).
        const result = await runCommand(skillName, extraArgs, 0, preferredWorker, promptArgs);
        process.exitCode = exitCodeForCommandResult(result);
        break;
      }

      case 'list':
      case 'ls':
        await listCommand();
        break;

      case 'workers': {
        // Extract subcommand args (e.g., 'pin <name>')
        const subArgs = args.slice(1);
        await workersCommand(subArgs);
        break;
      }

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
        const loop = args.includes('--loop');
        if (loop && topicIdx !== -1) {
          console.log('pa catchup --loop does not take --topic (the loop serves all its lanes).');
          process.exitCode = 2;
          break;
        }
        await catchupCommand({ topic, loop });
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
        } else if (sub === 'refresh-cards') {
          process.exitCode = await refreshCardsCommand(args.slice(2));
        } else {
          console.log('Usage: pa bot <stop|restart|rotate|setup-topics|refresh-cards>');
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

      case 'fix':
        await fixCommand(args.slice(1));
        break;

      case 'git-guard':
        process.exitCode = await gitGuardCommand(args.slice(1));
        break;

      case 'watch':
        process.exitCode = await watchCommand(args.slice(1));
        break;

      case 'auth':
        process.exitCode = await authCommand(args.slice(1));
        break;

      case 'topic-task':
        process.exitCode = await topicTaskCommand(args.slice(1));
        break;

      case 'topic-note':
        process.exitCode = await topicNoteCommand(args.slice(1));
        break;

      case 'topic-events':
        process.exitCode = await topicEventsCommand(args.slice(1));
        break;

      case 'doctor':
        await doctorCommand(args.slice(1));
        break;

      case 'coexistence':
        await coexistenceCommand(args.slice(1));
        break;

      case 'verify-install':
        await verifyInstallCommand(args.slice(1));
        break;

      case 'health':
        await healthCommand(args.slice(1));
        break;

      case 'status':
        await statusCommand();
        break;

      case 'notify':
        await notifyCommand(args.slice(1));
        break;

      case 'ping':
        await pingCommand(args.slice(1));
        break;

      case 'orphan':
        await orphanCommand(args.slice(1));
        break;

      case 'brain-sweep':
        await brainSweepCommand(args.slice(1));
        break;

      case 'docs-lint':
        process.exitCode = await docsLintCommand(args.slice(1));
        break;

      case 'backlog':
        await backlogCommand(args.slice(1));
        break;

      case 'bgtasks':
        await bgtasksCommand(args.slice(1));
        break;

      case 'browser': {
        const sub = args[1];
        if (sub === 'ensure') {
          await browserEnsureCommand(args.slice(2));
        } else if (sub === 'stop') {
          await browserStopCommand();
        } else {
          console.log('Usage: pa browser <ensure [--headed|--headless] [--port N]|stop>');
        }
        break;
      }

      case 'ref':
        await refCommand(args[1]);
        break;

      case 'improvements': {
        if (args[1] === 'accept') {
          const commitHash = args[2];
          const reasonIdx = args.indexOf('--reason');
          const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;
          await acceptRollbackCommand(commitHash, reason);
        } else {
          const sinceIdx = args.indexOf('--since');
          const sinceDays = sinceIdx !== -1 ? parseInt(args[sinceIdx + 1], 10) || 30 : 30;
          await improvementsCommand(sinceDays);
        }
        break;
      }

      case 'maintenance':
        await maintenanceCommand(args.slice(1));
        break;

      case 'public-sync':
        process.exitCode = await publicSyncCommand(args.slice(1));
        break;

      case 'claim':
        process.exitCode = await claimCommand(args.slice(1));
        break;

      case 'release':
        process.exitCode = await releaseCommand(args.slice(1));
        break;

      case 'claims':
        process.exitCode = await claimsCommand(args.slice(1));
        break;

      case 'recall':
        process.exitCode = await recallCommand(args.slice(1));
        break;

      case 'reconcile':
        await reconcileCommand(args.slice(1));
        break;

      case 'costs':
        await costsCommand(args.slice(1));
        break;

      case 'dlq':
        await dlqCommand(args.slice(1));
        break;

      case 'chain': {
        const sub = args[1];
        if (sub === 'run') {
          process.exitCode = await chainRunCommand(args.slice(2));
        } else if (sub === 'list') {
          process.exitCode = await chainListCommand();
        } else {
          console.log('Usage: pa chain <run|list>');
        }
        break;
      }

      case 'slo': {
        const sub = args[1];
        if (sub === 'report') {
          await sloReportCommand(args.slice(2));
        } else {
          console.log('Usage: pa slo report [--month <YYYY-MM>] [--json]');
        }
        break;
      }

      case 'rules':
        process.exitCode = await rulesCommand(args.slice(1));
        break;

      case 'mcp': {
        const sub = args[1];
        if (sub === 'serve') {
          await mcpServeCommand();
        } else if (sub === 'manifest') {
          await mcpManifestCommand();
        } else {
          console.log('Usage: pa mcp <serve|manifest>');
        }
        break;
      }

      case 'bus':
        process.exitCode = await busCommand(args.slice(1));
        break;

      case 'typesafe':
        process.exitCode = await typesafeCommand(args.slice(1));
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
