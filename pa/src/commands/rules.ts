/**
 * `pa rules` — feedback-rules store CLI (AI-165).
 *
 * Spec: plans/2026-08-27-ai165-feedback-as-rules-SPEC.md §3.3 (WP-C).
 *
 * Subcommands:
 * - list [--active]    List rules
 * - show <id>          Show full rule as JSON
 * - supersede <id> --reason "<text>"    Supersede a rule
 * - accept <id> [--reason "<text>"]    Accept pending rule
 * - weekly [--json]    Weekly semantic grader
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { paHome } from '../paths.js';
import { loadRules, supersedeRule, acceptRule, activeRulesFor, violationsFilePath, type FeedbackRule } from '../lib/feedback-rules.js';
import { runWithFailover } from '../workers.js';
import { readRecentConversations } from '../analyzer.js';
import { redactSecrets } from '../lib/redact.js';
import { appendFileSync } from 'fs';

interface RulesOptions {
  subcommand: string;
  id?: string;
  active?: boolean;
  reason?: string;
  json?: boolean;
}

const RULES_USAGE =
  'Usage: pa rules list [--active] | show <id> | supersede <id> --reason "…" | accept <id> [--reason "…"] | weekly [--json]';

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

/**
 * Pure argv parser. Throws on unknown flags or usage errors.
 */
export function parseRulesArgs(argv: string[]): RulesOptions {
  if (argv.length === 0) {
    throw new Error('no subcommand provided');
  }

  const subcommand = argv[0];
  const opts: RulesOptions = { subcommand };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--active':
        opts.active = true;
        break;
      case '--reason':
        opts.reason = requireValue(argv[++i], '--reason');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--':
        // End of flags
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`unrecognized option: ${arg}`);
        }
        // Positional argument (id)
        if (!opts.id) {
          opts.id = arg;
        } else {
          throw new Error(`too many arguments: ${arg}`);
        }
    }
  }

  return opts;
}

/**
 * Render a rule in list format: `- <id>  <status|SUPERSEDED>  <scope>  <key>  (<created_at date>)`
 */
function renderRuleListLine(rule: FeedbackRule): string {
  const status = rule.superseded_by !== null ? 'SUPERSEDED' : rule.status.toUpperCase();
  const createdDate = new Date(rule.created_at).toISOString().split('T')[0];
  return `- ${rule.id}  ${status}  ${rule.scope}  ${rule.key}  (${createdDate})`;
}

/**
 * List command.
 */
function listCommand(opts: RulesOptions): number {
  const rules = loadRules();

  if (rules.length === 0) {
    console.log('No rules defined.');
    return 0;
  }

  const filtered = opts.active ? rules.filter(r => r.status === 'active' && r.superseded_by === null) : rules;
  filtered.forEach(r => console.log(renderRuleListLine(r)));
  return 0;
}

/**
 * Show command — display full rule as pretty JSON.
 */
function showCommand(opts: RulesOptions): number {
  if (!opts.id) {
    console.error('Error: show requires <id>');
    return 2;
  }

  const rules = loadRules();
  const rule = rules.find(r => r.id === opts.id);

  if (!rule) {
    console.error('Error: rule not found');
    return 1;
  }

  console.log(JSON.stringify(rule, null, 2));
  return 0;
}

/**
 * Supersede command.
 */
async function supersedeCommand(opts: RulesOptions): Promise<number> {
  if (!opts.id) {
    console.error('Error: supersede requires <id>');
    return 2;
  }

  if (!opts.reason) {
    console.error(RULES_USAGE);
    console.error('Error: --reason is required for supersede');
    return 2;
  }

  const result = await supersedeRule(opts.id, 'operator', opts.reason);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    return 1;
  }

  console.log(`Superseded ${opts.id}.`);
  return 0;
}

/**
 * Accept command.
 */
async function acceptCommand(opts: RulesOptions): Promise<number> {
  if (!opts.id) {
    console.error('Error: accept requires <id>');
    return 2;
  }

  const result = await acceptRule(opts.id, opts.reason);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    return 1;
  }

  console.log(`Accepted ${opts.id} (now active).`);
  return 0;
}

/**
 * Weekly semantic grader — LLM pass over recent replies, checking semantic rules.
 * Spec: §2.10
 */
async function weeklyCommand(opts: RulesOptions): Promise<number> {
  // Load active semantic rules (check === null)
  const rules = activeRulesFor({}).filter(r => r.check === null);

  if (rules.length === 0) {
    // No semantic rules — zero-shape, no LLM call
    const zeroResult = {
      ok: true,
      semantic_rules: 0,
      replies_scanned: 0,
      new_violations: 0,
      violations_7d: [],
      pending_rules: loadRules().filter(r => r.status === 'pending' && r.superseded_by === null).map(r => ({
        id: r.id,
        key: r.key,
        text: r.text
      }))
    };
    if (opts.json) {
      console.log(JSON.stringify(zeroResult));
    } else {
      console.log(`Semantic rules graded: 0`);
      console.log(`New violations: 0`);
      console.log(`Pending rules: ${zeroResult.pending_rules.length}`);
    }
    return 0;
  }

  // Read recent conversations (7 days, assistant replies only)
  const turns = await readRecentConversations(7);
  const replies = turns
    .filter(t => t.role === 'assistant')
    .slice(-30) // newest 30 replies
    .map(t => ({ ...t, text: (redactSecrets(t.text) as string).slice(0, 500) }));

  if (replies.length === 0) {
    const zeroReplyResult = {
      ok: true,
      semantic_rules: rules.length,
      replies_scanned: 0,
      new_violations: 0,
      violations_7d: [],
      pending_rules: loadRules().filter(r => r.status === 'pending' && r.superseded_by === null).map(r => ({
        id: r.id,
        key: r.key,
        text: r.text
      }))
    };
    if (opts.json) {
      console.log(JSON.stringify(zeroReplyResult));
    } else {
      console.log(`Semantic rules graded: ${rules.length}`);
      console.log(`New violations: 0`);
      console.log(`Pending rules: ${zeroReplyResult.pending_rules.length}`);
    }
    return 0;
  }

  // Build LLM prompt
  const rulesText = rules.map(r => `- ${r.id}: ${r.text}`).join('\n');
  const repliesText = replies.map((r, i) => `Reply ${i + 1} (thread ${r.thread_id || 'unknown'}): ${r.text}`).join('\n\n');

  const prompt = `You are grading recent Telegram bot replies against standing semantic rules (rules without automated checks).

Active semantic rules:
${rulesText}

Recent replies (last 7 days, newest 30):
${repliesText}

For each rule, determine whether ANY reply violated it. A semantic rule is violated when the reply's content contradicts the rule's intent.

Respond ONLY with a JSON array (no fences, no markdown):
[
  {"rule_id":"r-...","violated":true|false,"evidence":"≤200 chars explaining the match"},
  ...
]

Skip any rule_id not in the active list. Keep each evidence under 200 chars.`;

  // Call LLM
  const runner = _weeklyRunnerOverride || runWithFailover;
  const { result } = await runner(prompt, {
    resource: 'feedback-rules-weekly',
    timeout: 300,
    idleTimeout: 120,
  });

  if (!result.success || !result.output) {
    const errorResult = {
      ok: false,
      error: result.error || 'LLM call failed'
    };
    if (opts.json) {
      console.log(JSON.stringify(errorResult));
    } else {
      console.error(`Error: ${errorResult.error}`);
    }
    return 1;
  }

  // Parse response
  let grading: Array<{ rule_id: string; violated: boolean; evidence?: string }> = [];
  try {
    const raw = result.output.trim();
    const stripped = raw.replace(/^```json\n?|\n?```$/g, '').trim();
    grading = JSON.parse(stripped);
    if (!Array.isArray(grading)) {
      throw new Error('response is not an array');
    }
  } catch (err: any) {
    const errorResult = {
      ok: false,
      error: `failed to parse LLM response: ${err.message}`
    };
    if (opts.json) {
      console.log(JSON.stringify(errorResult));
    } else {
      console.error(`Error: ${errorResult.error}`);
    }
    return 1;
  }

  // Write violation records for violated rules
  let newViolations = 0;
  const activeRuleIds = new Set(rules.map(r => r.id));
  const violationsPath = violationsFilePath();

  for (const entry of grading) {
    if (!activeRuleIds.has(entry.rule_id)) continue; // Skip unknown rule_ids
    if (entry.violated !== true) continue;

    newViolations++;
    // Find a matching reply to cite (naive: first reply)
    const sampleReply = replies[0];
    const record = {
      ts: new Date().toISOString(),
      rule_id: entry.rule_id,
      rule_key: rules.find(r => r.id === entry.rule_id)!.key,
      check_kind: 'semantic' as const,
      chat_id: null, // Not available from conversation-history
      thread_id: sampleReply.thread_id || null,
      reply_ref_id: null,
      excerpt: (entry.evidence || 'No evidence').slice(0, 200)
    };

    try {
      appendFileSync(violationsPath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      // Fail silently — log but don't fail the command
    }
  }

  // Build 7-day violation summary from violations jsonl
  const violations7d = new Map<string, number>();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    if (existsSync(violationsPath)) {
      const content = readFileSync(violationsPath, 'utf8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          const recTs = new Date(rec.ts);
          if (recTs >= sevenDaysAgo) {
            const key = rec.rule_id;
            violations7d.set(key, (violations7d.get(key) || 0) + 1);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    // If we can't read violations, just continue with empty summary
  }

  const violations7dArray = Array.from(violations7d.entries()).map(([rule_id, count]) => {
    const rule = rules.find(r => r.id === rule_id);
    return { rule_id, key: rule?.key || '', count };
  });

  const pendingRules = loadRules().filter(r => r.status === 'pending' && r.superseded_by === null).map(r => ({
    id: r.id,
    key: r.key,
    text: r.text
  }));

  const finalResult = {
    ok: true,
    semantic_rules: rules.length,
    replies_scanned: replies.length,
    new_violations: newViolations,
    violations_7d: violations7dArray,
    pending_rules: pendingRules
  };

  if (opts.json) {
    console.log(JSON.stringify(finalResult));
  } else {
    console.log(`Semantic rules graded: ${rules.length}`);
    console.log(`New violations: ${newViolations}`);
    console.log(`Pending rules: ${pendingRules.length}`);
  }

  return 0;
}

// Test injection point for weekly runner
let _weeklyRunnerOverride: typeof runWithFailover | null = null;
export function _setWeeklyRunnerForTest(runner: typeof runWithFailover): void {
  _weeklyRunnerOverride = runner;
}

/**
 * Main command dispatcher.
 */
export async function rulesCommand(argv: string[]): Promise<number> {
  let opts: RulesOptions;
  try {
    opts = parseRulesArgs(argv);
  } catch (err) {
    console.error(RULES_USAGE);
    console.error((err as Error).message);
    return 2;
  }

  switch (opts.subcommand) {
    case 'list':
      return listCommand(opts);

    case 'show':
      return showCommand(opts);

    case 'supersede':
      return await supersedeCommand(opts);

    case 'accept':
      return await acceptCommand(opts);

    case 'weekly':
      return await weeklyCommand(opts);

    default:
      console.error(RULES_USAGE);
      console.error(`Error: unknown subcommand: ${opts.subcommand}`);
      return 2;
  }
}
