import { analyzeConversationPatterns } from '../analyzer.js';
import { analyzeFailurePatterns } from '../failure-analyzer.js';
import { saveDraft } from '../drafts.js';

export async function learnCommand(
  days: number = 14,
  options: { conversationsOnly?: boolean; failuresOnly?: boolean } = {}
): Promise<void> {
  let totalProposed = 0;

  if (!options.failuresOnly) {
    console.log(`Analyzing last ${days} days of conversation history...`);
    try {
      const proposals = await analyzeConversationPatterns(days);
      for (const proposal of proposals) {
        await saveDraft(proposal, 'conversation');
        console.log(`  + Proposed: ${proposal.name} (${proposal.reason.slice(0, 60)}...)`);
        totalProposed++;
      }
      if (proposals.length === 0) {
        console.log('  No conversation patterns found.');
      }
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
