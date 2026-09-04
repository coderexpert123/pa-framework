import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';

export interface OAuthResumeAction {
  description?: string;
  [key: string]: unknown;
}

export interface OAuthExchangeResult {
  status?: string;
  error?: string;
  expiry?: string;
  resume_action?: OAuthResumeAction;
  retry_action?: string;
  chat_id?: string;
  thread_id?: number;
}

export type OAuthResumeStatus = 'not_needed' | 'started' | 'missing_hook' | 'failed'
  | 'topic_resumed' | 'topic_resume_failed';

export interface OAuthResumeInvoker {
  unref(): void;
}

export type OAuthResumeSpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    detached: boolean;
    stdio: 'ignore';
    shell: boolean;
    env: NodeJS.ProcessEnv;
  }
) => OAuthResumeInvoker;

export function normalizeResumeAction(result: OAuthExchangeResult): OAuthResumeAction | undefined {
  if (result.resume_action && typeof result.resume_action === 'object') {
    return result.resume_action;
  }

  if (result.retry_action) {
    return {
      type: 'legacy_pa_run_skill',
      skill: result.retry_action,
      description: `Retry skill: ${result.retry_action}`,
    };
  }

  return undefined;
}

export const TOPIC_RESUME_MAX_PROMPT_CHARS = 500;

export type TopicResumeValidation =
  | { ok: true; prompt: string }
  | { ok: false; error: string };

/** AI-181 (SPEC §2.1-2.2): the closed topic_resume vocabulary. ONE action
 * type, two keys, a single-line <=500-char prompt — no skill names, no args,
 * no nested objects — validated identically here (fire time, called from
 * main.ts's /auth branch) and at mint time in
 * pa/scripts/start_google_telegram_reauth.py (byte-identical error strings;
 * both pinned by tests). This is the same closed-vocabulary treatment
 * pa/src/lib/watch-jobs.ts gives watch checks, for the same reason: the
 * payload is armed by LLM output. A topic_resume action never reaches
 * oauth_resume_hook.py — the hook has no dispatch path into a topic. */
export function validateTopicResumeAction(action: OAuthResumeAction | undefined): TopicResumeValidation {
  if (!action || action.type !== 'topic_resume') {
    return { ok: false, error: 'not a topic_resume action' };
  }
  const keys = Object.keys(action).sort();
  if (keys.length !== 2 || keys[0] !== 'prompt' || keys[1] !== 'type') {
    return { ok: false, error: 'topic_resume must have exactly the keys "type" and "prompt"' };
  }
  const prompt = action.prompt;
  if (typeof prompt !== 'string') {
    return { ok: false, error: 'topic_resume.prompt must be a string' };
  }
  if (!prompt.trim()) {
    return { ok: false, error: 'topic_resume.prompt must not be empty' };
  }
  if (/[\r\n]/.test(prompt)) {
    return { ok: false, error: 'topic_resume.prompt must be a single line' };
  }
  if (prompt.length > TOPIC_RESUME_MAX_PROMPT_CHARS) {
    return { ok: false, error: 'topic_resume.prompt exceeds 500 characters' };
  }
  if (prompt.trim().startsWith('/')) {
    return { ok: false, error: 'topic_resume.prompt must not start with "/"' };
  }
  return { ok: true, prompt: prompt.trim() };
}

export function redactAuthCommand(): string {
  return '/auth [redacted]';
}

export function resolveOAuthResumeHookPath(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync
): string | undefined {
  const configured = env.PA_TELEGRAM_OAUTH_RESUME_HOOK?.trim();
  if (configured) return configured;

  const paHome = env.PA_HOME?.trim() || join(homedir(), '.pa');
  const fallback = join(paHome, 'oauth_resume_hook.py');
  return fileExists(fallback) ? fallback : undefined;
}

function describeResumeAction(action: OAuthResumeAction): string {
  const description = typeof action.description === 'string' ? action.description.trim() : '';
  if (description) return description;

  const actionType = typeof action.type === 'string' ? action.type.trim() : '';
  if (actionType) return actionType;

  return 'saved action';
}

function topicResumeExcerpt(result: OAuthExchangeResult): string {
  const raw = result.resume_action && typeof (result.resume_action as any).prompt === 'string'
    ? (result.resume_action as any).prompt as string : '';
  return raw.split(/\r?\n/)[0].trim().slice(0, 120);
}

function describeTopicResumeTarget(
  result: OAuthExchangeResult,
  source?: { chatId: number; threadId: number }
): string {
  const sameTopic = source
    && String(source.chatId) === String(result.chat_id)
    && (result.thread_id ?? 0) === source.threadId;
  return sameTopic
    ? 'to this topic'
    : `to chat ${result.chat_id} thread ${result.thread_id ?? 0}`;
}

export function launchOAuthResumeAction(
  action: OAuthResumeAction | undefined,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    spawner?: OAuthResumeSpawner;
    fileExists?: (path: string) => boolean;
  }
): OAuthResumeStatus {
  if (!action) return 'not_needed';

  const hookPath = resolveOAuthResumeHookPath(options.env, options.fileExists);
  if (!hookPath) return 'missing_hook';

  const encoded = Buffer.from(JSON.stringify(action), 'utf8').toString('base64');
  const command = resolvePythonCommand(options.env);
  const args = [hookPath, '--resume-action-base64', encoded];

  try {
    const spawner = options.spawner ?? spawn;
    const child = spawner(command, args, {
      cwd: options.cwd,
      detached: true,
      stdio: 'ignore',
      shell: true,
      env: options.env,
    });
    child.unref();
    return 'started';
  } catch {
    return 'failed';
  }
}

export function buildOAuthCompletionMessage(
  result: OAuthExchangeResult,
  resumeStatus: OAuthResumeStatus,
  source?: { chatId: number; threadId: number }
): string {
  if (result.status !== 'success') {
    return `❌ *Authentication failed*: ${result.error || 'Unknown error'}`;
  }

  const lines = ['✅ *Google authentication successful!*'];
  if (result.expiry) {
    lines.push('', `Token refreshed. Expiry: \`${result.expiry}\``);
  }

  const action = normalizeResumeAction(result);
  if (!action) {
    if (result.chat_id) {
      // AI-181 interim dead-end fix (plan §5): a successful /auth with a
      // pending session that recorded a chat but attached NO resume action
      // used to end in total silence — the operator never learned a task
      // might be waiting on the now-valid token.
      lines.push('', '_(No resume action was attached — if a task was waiting, tell it to continue.)_');
    }
    return lines.join('\n');
  }

  const description = describeResumeAction(action);
  if (resumeStatus === 'started') {
    lines.push('', `_(Resuming saved action: ${description})_`);
  } else if (resumeStatus === 'missing_hook') {
    lines.push('', `_(Saved action: ${description}. No OAuth resume hook is configured, so it was not restarted automatically.)_`);
  } else if (resumeStatus === 'failed') {
    lines.push('', `_(Saved action: ${description}. Automatic resume failed to start.)_`);
  } else if (resumeStatus === 'topic_resumed') {
    lines.push('', `_(Resuming saved task after Google auth — a new turn has been dispatched ${describeTopicResumeTarget(result, source)}: "${topicResumeExcerpt(result)}")_`);
  } else if (resumeStatus === 'topic_resume_failed') {
    lines.push('', '_(Saved task could not be resumed automatically — nothing was dispatched. If a task was waiting, tell it to continue.)_');
  } else {
    lines.push('', `_(Saved action: ${description})_`);
  }

  return lines.join('\n');
}
