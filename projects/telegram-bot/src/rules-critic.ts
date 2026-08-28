import { appendFileSync } from 'fs';
import { activeRulesFor, evaluateCheck, violationsFilePath } from '../../../pa/dist/src/lib/feedback-rules.js';
import { redactSecrets } from '../../../pa/dist/src/lib/redact.js';
import { logger } from '../../../pa/dist/src/lib/log.js'; // the main.ts precedent — the bot has NO local logger module

/** AI-165 deterministic per-reply critic: O(regex), synchronous, NEVER throws, NEVER
 *  blocks or mutates the reply. A violation is logged (app.log + rules-violations.jsonl)
 *  and that is all — the weekly digest escalates repeats. SPEC §3.5 (integrator-completed
 *  2026-08-28 after the builder hit the account usage limit mid-WP; the module body is
 *  the SPEC's verbatim contract). */
export function runRulesCritic(args: { text: string; chatId: number; threadId: number; refId: string }): void {
  try {
    const rules = activeRulesFor({ threadId: args.threadId }).filter((r) => r.check !== null);
    for (const rule of rules) {
      const verdict = evaluateCheck(rule, args.text);
      if (!verdict.violated) continue;
      const record = {
        ts: new Date().toISOString(),
        rule_id: rule.id,
        rule_key: rule.key,
        check_kind: rule.check!.kind,
        chat_id: args.chatId,
        thread_id: args.threadId,
        reply_ref_id: args.refId,
        excerpt: redactSecrets(args.text.slice(0, 200)) as string,
      };
      appendFileSync(violationsFilePath(), JSON.stringify(record) + '\n', 'utf8');
      logger.warn('rules-critic', 'rule violation', { ruleId: rule.id, key: rule.key, kind: record.check_kind, refId: args.refId });
    }
  } catch {
    /* the critic must never break a send */
  }
}
