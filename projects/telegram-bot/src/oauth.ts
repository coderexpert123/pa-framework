import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

export type OAuthResumeStatus = 'not_needed' | 'started' | 'missing_hook' | 'failed';

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
  const command = options.env.PYTHON?.trim() || 'python';
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
  resumeStatus: OAuthResumeStatus
): string {
  if (result.status !== 'success') {
    return `❌ *Authentication failed*: ${result.error || 'Unknown error'}`;
  }

  const lines = ['✅ *Google authentication successful!*'];
  if (result.expiry) {
    lines.push('', `Token refreshed. Expiry: \`${result.expiry}\``);
  }

  const action = normalizeResumeAction(result);
  if (!action) return lines.join('\n');

  const description = describeResumeAction(action);
  if (resumeStatus === 'started') {
    lines.push('', `_(Resuming saved action: ${description})_`);
  } else if (resumeStatus === 'missing_hook') {
    lines.push('', `_(Saved action: ${description}. No OAuth resume hook is configured, so it was not restarted automatically.)_`);
  } else if (resumeStatus === 'failed') {
    lines.push('', `_(Saved action: ${description}. Automatic resume failed to start.)_`);
  } else {
    lines.push('', `_(Saved action: ${description})_`);
  }

  return lines.join('\n');
}
