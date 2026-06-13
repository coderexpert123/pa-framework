import { setMyCommands } from './telegram.js';

export interface BotCommand {
  command: string;
  description: string;
}

export const BOT_COMMANDS: BotCommand[] = [
  // Local Commands (skipWorker = true)
  { command: 'model', description: 'Switch AI model (claude, gemini, zclaude, codex)' },
  { command: 'default', description: 'Show or set default worker for this topic' },
  { command: 'code', description: 'Set, show, or reset working directory' },
  { command: 'reset', description: 'Clear conversation and session for this topic' },
  { command: 'new', description: 'Clear context and start a fresh session (optionally seed from replied message)' },
  { command: 'status', description: 'Show bot health and worker status' },
  { command: 'skills', description: 'List scheduled skills and last run' },
  { command: 'auth', description: 'Complete OAuth flow using the bridge-page command' },
  { command: 'help', description: 'Show available commands' },
  { command: 'branch', description: 'Create a branch from this topic (manual topic creation required)' },
  { command: 'child_of', description: 'Link this topic as a child of a named parent topic' },
  { command: 'merge', description: 'Merge this branch context back into the parent topic' },
  { command: 'keepawake', description: 'Toggle machine keep-awake mode' },

  // Pass-through Commands (skipWorker = false)
  { command: 'deep_plan', description: 'Detailed implementation planning skill' },
  { command: 'deep_recheck', description: 'Deep verification of plans or implementation' },
  { command: 'update_brain', description: 'Update Agentic Brain from current session' },
  { command: 'claude_sync', description: 'Sync settings and memories to Google Drive' },
  { command: 'check_brain', description: 'Audit the project Agentic Brain architecture' },
  { command: 'simplify', description: 'Analyze code for potential simplifications' },
  { command: 'review', description: 'Perform a comprehensive code review' },
  { command: 'security_review', description: 'Audit code and config for exposed secrets' },
];

export const PASS_THROUGH_COMMANDS = new Set([
  'deep_plan',
  'deep_recheck',
  'update_brain',
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
