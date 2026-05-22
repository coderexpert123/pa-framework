/**
 * `pa bot setup-topics` — auto-create Telegram forum topics from a template.
 *
 * Usage:
 *   pa bot setup-topics [--chat-id <id>] [--template <path>] [--dry-run]
 *
 * Prerequisites:
 *   - Bot must be admin in the target supergroup with forum topics enabled
 *   - TELEGRAM_BOT_TOKEN set in ~/.pa/secrets.env
 *   - chat-id: pass via --chat-id or default to TELEGRAM_CHAT_ID's first entry
 *
 * Behavior:
 *   - Reads topic template (default: <pa-framework>/examples/topics-template.json)
 *   - For each topic:
 *       - If a topic with the same name already exists in
 *         ~/.pa/telegram-topic-names.json → skip
 *       - Else: call createForumTopic via Telegram API → record thread_id
 *   - Updates ~/.pa/telegram-topic-names.json with all new entries
 *   - Prints recommended secrets.env + config.yaml additions at the end
 *
 * Idempotent: re-running won't recreate existing topics.
 *
 * This command duplicates a small amount of bot-side code (createForumTopic
 * fetch + topic-names JSON I/O) to avoid making pa depend on telegram-bot's
 * compiled dist. The bot's full topic-names module remains the runtime
 * source of truth at ~/.pa/telegram-topic-names.json.
 */
import { readFile, writeFile, rename } from 'fs/promises';
import { join, resolve } from 'path';
import { loadSecrets } from '../secrets.js';
import { paHome } from '../paths.js';

type SpecialRole = 'alerts' | 'briefings' | 'dashboard' | 'general' | 'none';

interface TopicTemplate {
  name: string;
  description?: string;
  special_role?: SpecialRole;
  default_worker?: string | null;
}

interface TemplateFile {
  topics: TopicTemplate[];
}

interface TopicEntry {
  name: string;
  description?: string;
}

type TopicRegistry = Record<string, Record<string, TopicEntry>>;

function parseArgs(args: string[]): { chatId?: number; templatePath?: string; dryRun: boolean } {
  const out: { chatId?: number; templatePath?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--chat-id' && i + 1 < args.length) {
      const n = Number(args[++i]);
      if (!Number.isFinite(n)) {
        console.error(`Error: --chat-id must be a number, got '${args[i]}'`);
        process.exit(2);
      }
      out.chatId = n;
    } else if (a === '--template' && i + 1 < args.length) {
      out.templatePath = args[++i];
    } else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: pa bot setup-topics [--chat-id <id>] [--template <path>] [--dry-run]
Defaults:
  --chat-id   first entry in TELEGRAM_CHAT_ID env var
  --template  <pa-framework>/examples/topics-template.json
  --dry-run   show what would be created without making API calls`);
      process.exit(0);
    }
  }
  return out;
}

function defaultTemplatePath(): string {
  // Compiled to pa/dist/src/commands/setup-topics.js — __dirname is that file's
  // location in CommonJS. Walk up four levels to reach repo root, then examples/.
  return resolve(__dirname, '../../../../examples/topics-template.json');
}

async function readTemplate(path: string): Promise<TemplateFile> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.topics)) {
    throw new Error(`Invalid template: missing "topics" array. Path: ${path}`);
  }
  return parsed as TemplateFile;
}

function topicNamesPath(): string {
  return join(paHome(), 'telegram-topic-names.json');
}

async function loadRegistry(): Promise<TopicRegistry> {
  try {
    const raw = await readFile(topicNamesPath(), 'utf8');
    return JSON.parse(raw) as TopicRegistry;
  } catch {
    return {};
  }
}

async function saveRegistry(reg: TopicRegistry): Promise<void> {
  const path = topicNamesPath();
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(reg, null, 2), 'utf8');
  await rename(tmp, path);
}

function existingThreadIdForName(reg: TopicRegistry, chatIdStr: string, name: string): number | null {
  const chat = reg[chatIdStr];
  if (!chat) return null;
  for (const [threadId, entry] of Object.entries(chat)) {
    // The registry may also contain legacy string-valued entries; handle both.
    const entryName = typeof entry === 'string' ? entry : (entry?.name ?? null);
    if (entryName === name) {
      const n = Number(threadId);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

async function createForumTopic(token: string, chatId: number, name: string): Promise<number> {
  const res = await fetch(`https://api.telegram.org/bot${token}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, name }),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`createForumTopic ${res.status}: ${errorText}`);
  }
  const data = await res.json() as { ok: boolean; result?: { message_thread_id: number }; description?: string };
  if (!data.ok || !data.result) {
    throw new Error(`createForumTopic returned not ok: ${data.description ?? JSON.stringify(data)}`);
  }
  return data.result.message_thread_id;
}

export async function setupTopicsCommand(args: string[] = process.argv.slice(3)): Promise<void> {
  const opts = parseArgs(args);

  // CLI invocations don't auto-load secrets.env (only the bot does at startup).
  const secrets = await loadSecrets();
  for (const [k, v] of Object.entries(secrets)) {
    if (!(k in process.env)) process.env[k] = v;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('Error: TELEGRAM_BOT_TOKEN not set in ~/.pa/secrets.env. See docs/BOT_GUIDE.md.');
    process.exit(2);
  }

  const chatId = opts.chatId
    ?? Number(process.env.TELEGRAM_CHAT_ID?.split(',')[0] ?? '');
  if (!Number.isFinite(chatId) || chatId === 0) {
    console.error('Error: chat ID required. Pass --chat-id <id> or set TELEGRAM_CHAT_ID in secrets.env.');
    process.exit(2);
  }

  const templatePath = opts.templatePath ?? defaultTemplatePath();
  let template: TemplateFile;
  try {
    template = await readTemplate(templatePath);
  } catch (err: any) {
    console.error(`Error reading template at ${templatePath}: ${err.message}`);
    console.error('Use --template <path> to specify a custom template. See examples/topics-template.json.');
    process.exit(2);
  }

  const chatIdStr = String(chatId);
  const registry = await loadRegistry();

  console.log(`Setting up topics in chat ${chatId}…`);
  console.log(`Template: ${templatePath}`);
  if (opts.dryRun) console.log('DRY RUN — no API calls will be made.\n');

  type Result = TopicTemplate & { threadId: number; created: boolean };
  const results: Result[] = [];

  for (const topic of template.topics) {
    const existingId = existingThreadIdForName(registry, chatIdStr, topic.name);
    if (existingId !== null) {
      console.log(`  [skip] ${topic.name} already exists at thread ${existingId}`);
      results.push({ ...topic, threadId: existingId, created: false });
      continue;
    }

    if (opts.dryRun) {
      console.log(`  [dry-run] would create: ${topic.name}`);
      continue;
    }

    try {
      const threadId = await createForumTopic(token, chatId, topic.name);
      console.log(`  [+] Created ${topic.name} → thread ${threadId}`);
      // Update registry in-memory
      if (!registry[chatIdStr]) registry[chatIdStr] = {};
      registry[chatIdStr][String(threadId)] = {
        name: topic.name,
        description: topic.description,
      };
      results.push({ ...topic, threadId, created: true });
    } catch (err: any) {
      console.error(`  [!] Failed to create ${topic.name}: ${err.message}`);
      console.error(`      (bot may not be admin in the chat, or forum topics may not be enabled)`);
    }
  }

  // Persist registry after the loop so the file isn't repeatedly rewritten
  if (!opts.dryRun && results.some(r => r.created)) {
    await saveRegistry(registry);
    console.log(`\nUpdated ${topicNamesPath()}`);
  }

  if (opts.dryRun) {
    console.log('\nDry run complete. Re-run without --dry-run to actually create topics.');
    return;
  }

  // Print recommendations
  const alerts = results.find(r => r.special_role === 'alerts');
  const briefings = results.find(r => r.special_role === 'briefings');
  const hasSpecials = alerts || briefings;
  const withWorkers = results.filter(r => r.default_worker);

  if (hasSpecials) {
    console.log('\n========================================');
    console.log('Recommended additions to ~/.pa/secrets.env:');
    console.log('========================================');
    if (alerts) {
      console.log(`PA_ALERTS_CHAT_ID=${chatId}`);
      console.log(`PA_ALERTS_THREAD_ID=${alerts.threadId}`);
    }
    if (briefings) {
      console.log(`TELEGRAM_BRIEFING_CHAT_ID=${chatId}`);
      console.log(`TELEGRAM_DAILY_BRIEFING_THREAD_ID=${briefings.threadId}`);
    }
  }

  if (withWorkers.length > 0) {
    console.log('\n========================================');
    console.log('Recommended additions to ~/.pa/config.yaml under topic_defaults:');
    console.log('========================================');
    console.log('topic_defaults:');
    for (const r of withWorkers) {
      const pad = ' '.repeat(Math.max(1, 24 - String(r.threadId).length - String(chatId).length));
      console.log(`  "${chatId}_${r.threadId}":${pad}${r.default_worker}   # ${r.name}`);
    }
  }

  if (hasSpecials || withWorkers.length > 0) {
    console.log('\nAfter updating secrets.env / config.yaml, run: pa bot restart');
  }
}
