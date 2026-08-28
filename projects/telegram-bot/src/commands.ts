import { setMyCommands } from './telegram.js';

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  // Local Commands (skipWorker = true)
  // NOTE: /agent picks the agent/CLI harness (agy, agyc, zclaude, codex, claude).
  // /model picks the foundation model (gemini-3.7-flash-high, opusplan, etc.).
  { command: 'agent', description: 'Switch or view active agent for this topic (agy, agyc, zclaude, codex, claude)' },
  { command: 'model', description: 'Show or set the model for the current agent (/model <name>, /model clear)' },
  { command: 'effort', description: 'Show or set reasoning effort for the current agent (/effort <value>, /effort clear)' },
  { command: 'default', description: 'Topic defaults: /default <agent>, /default model <name>, /default effort <value>' },
  { command: 'code', description: 'Set, show, or reset working directory' },
  { command: 'reset', description: 'Clear conversation and session for this topic' },
  { command: 'new', description: 'Clear context and start a fresh session (optionally seed from replied message)' },
  { command: 'status', description: 'Show this topic\'s agent/model status card' },
  { command: 'skills', description: 'List scheduled skills and last run' },
  { command: 'auth', description: 'Complete OAuth flow using the bridge-page command' },
  { command: 'reauth', description: 'Request a fresh Google OAuth link in this topic (/reauth [skill])' },
  { command: 'help', description: 'Show available commands' },
  { command: 'health', description: 'Show pa system health check (read-only)' },
  { command: 'ref', description: 'Look up a ref-ID: /ref <id> (read-only)' },
  { command: 'claims', description: 'Show active file reservations and recent changes (read-only)' },
  { command: 'branch', description: 'Create a branch from this topic: /branch <name> [prompt]' },
  { command: 'child_of', description: 'Link this topic as a child of a named parent topic' },
  { command: 'merge', description: 'Merge this branch context back into the parent topic' },
  { command: 'keepawake', description: 'Toggle machine keep-awake mode' },
  { command: 'stop', description: 'Kill the worker currently running in this topic' },
  { command: 'steer', description: 'Kill the running worker and resume with folded context (/steer [prompt])' },
  { command: 'retranscribe', description: 'Re-transcribe the voice/audio/video note you replied to (optional engine override)' },
  { command: 'commit', description: 'Commit pending work locally — fast, no push, no test gate, no CI wait' },
  { command: 'push', description: 'Push already-committed local work to origin/main after a full local test gate, wait for CI' },
  { command: 'push_public', description: 'Sync currently-eligible framework changes to the public mirror via a guarded auto-merge PR' },
  { command: 'investigate_flagged', description: 'Investigate anomalies push-public flagged and act on safe, reversible corrections only' },

  // Pass-through Commands (skipWorker = false)
  { command: 'deep_plan', description: 'Detailed implementation planning skill' },
  { command: 'deep_recheck', description: 'Deep verification of plans or implementation' },
  { command: 'update_brain', description: 'Capture this topic\'s learnings for its topic brain (folded nightly)' },
  { command: 'claude_sync', description: 'Sync settings and memories to Google Drive' },
  { command: 'check_brain', description: 'Audit the project Agentic Brain architecture' },
  { command: 'simplify', description: 'Analyze code for potential simplifications' },
  { command: 'review', description: 'Perform a comprehensive code review' },
  { command: 'security_review', description: 'Audit code and config for exposed secrets' },
];

export const PASS_THROUGH_COMMANDS = new Set([
  'deep_plan',
  'deep_recheck',
  'claude_sync',
  'check_brain',
  'simplify',
  'review',
  'security_review',
]);

export async function registerBotCommands(token: string): Promise<boolean> {
  console.log(`[commands] Registering ${BOT_COMMANDS.length} commands with Telegram...`);
  const success = await setMyCommands(token, BOT_COMMANDS);
  if (success) {
    console.log('[commands] Successfully registered commands.');
  } else {
    console.error('[commands] Failed to register commands.');
  }
  return success;
}
