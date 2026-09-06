import { analyzeConversationWindow } from '../analyzer.js';
import { analyzeFailurePatterns } from '../failure-analyzer.js';
import { runWithFailover } from '../workers.js';
import { saveDraft } from '../drafts.js';
import { skillCandidatesPath } from '../lib/skill-candidates.js';
import { readTaskLaneActivity, enrichTaskLaneActivity, formatTaskLanePromptSection } from '../lib/task-lane-activity.js';
import { lookupTraceByTaskRef } from '../lib/ref-lookup.js';

export async function learnCommand(
  days: number = 14,
  options: { conversationsOnly?: boolean; failuresOnly?: boolean } = {}
): Promise<void> {
  let totalProposed = 0;

  if (!options.failuresOnly) {
    console.log(`Analyzing last ${days} days of conversation history...`);
    try {
      // AI-197: same best-effort task-lane read+enrich as the nightly self-improver
      // path — a failure here degrades to no prompt section, never a failed command.
      const taskLane = await readTaskLaneActivity({ days }).then((a) => enrichTaskLaneActivity(a, lookupTraceByTaskRef)).catch(() => undefined);
      const proposals = await analyzeConversationWindow(days, runWithFailover, formatTaskLanePromptSection(taskLane));
      for (const proposal of proposals) {
        await saveDraft(proposal, 'conversation');
        console.log(`  + Proposed: ${proposal.name} (${proposal.reason.slice(0, 60)}...)`);
        totalProposed++;
      }
      if (proposals.length === 0) {
        console.log('  No conversation patterns found.');
      }
      console.log(`  Candidate ledger: ${skillCandidatesPath()}`);
    } catch (err: any) {
      console.error(`  Conversation analysis failed: ${err.message}`);
    }
  }

  if (!options.conversationsOnly) {
    console.log(`\nAnalyzing skill execution failures...`);
    try {
      const proposals = await analyzeFailurePatterns(days);
      for (const proposal of proposals) {
        await saveDraft(proposal, 'failure');
        console.log(`  + Proposed: ${proposal.name} (${proposal.reason.slice(0, 60)}...)`);
        totalProposed++;
      }
      if (proposals.length === 0) {
        console.log('  No failure patterns found.');
      }
    } catch (err: any) {
      console.error(`  Failure analysis failed: ${err.message}`);
    }
  }

  console.log(`\nDone. ${totalProposed} draft(s) proposed. Run 'pa drafts' to review.`);
}
