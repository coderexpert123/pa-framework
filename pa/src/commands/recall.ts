/**
 * `pa recall` — full-text search over archived conversation turns, worker run
 * traces, per-topic brains, the Ecosystem KB and pending review-digest
 * conflicts. Calls `../lib/recall-store.js` IN-PROCESS (no spawn, no Python).
 *
 * Spec: the 2026-08-24 recall-traces spec §3.4 (WP-D).
 */

import { join, dirname } from 'path';
import { paHome } from '../paths.js';
import { loadSecrets } from '../secrets.js';
import { logger } from '../lib/log.js';
import { redactSecrets } from '../lib/redact.js';
import { formatIST } from '../ist.js';
import {
  indexRecall,
  rebuildRecall,
  queryRecall,
  RECALL_REFRESH_MS,
  type RecallSources,
  type RecallQuery,
  type RecallHit,
} from '../lib/recall-store.js';

export interface RecallOptions {
  query: string;
  thread?: number;
  source?: string;
  role?: 'user' | 'assistant';
  since?: string;
  until?: string;
  limit?: number;
  json?: boolean;
  reindex?: boolean;
  rebuild?: boolean;
}

const RECALL_USAGE =
  'Usage: pa recall "<query>" [--thread <id>] [--source <s>] [--role <user|assistant>] ' +
  '[--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--limit <n>] [--json] [--reindex] [--rebuild]';

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function parseStrictInt(value: string | undefined, flag: string): number {
  if (value === undefined || value.trim() === '' || !/^-?\d+$/.test(value.trim())) {
    throw new Error(`${flag} requires a numeric value, got ${JSON.stringify(value ?? '')}`);
  }
  return parseInt(value.trim(), 10);
}

/**
 * Pure argv parser. Throws on a malformed numeric flag, an unrecognized
 * `--flag`, or an invalid `--role` value — `recallCommand` turns any throw
 * from this function into "usage to stderr, exit 2" (the `pa claim`
 * precedent). All non-flag tokens are joined with a single space to form the
 * query, so both `pa recall "a b"` and an unquoted `pa recall a b` work.
 */
export function parseRecallArgs(argv: string[]): RecallOptions {
  const queryParts: string[] = [];
  const opts: RecallOptions = { query: '' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--thread':
        opts.thread = parseStrictInt(argv[++i], '--thread');
        break;
      case '--source':
        opts.source = requireValue(argv[++i], '--source');
        break;
      case '--role': {
        const v = requireValue(argv[++i], '--role');
        if (v !== 'user' && v !== 'assistant') {
          throw new Error(`--role must be "user" or "assistant", got ${JSON.stringify(v)}`);
        }
        opts.role = v;
        break;
      }
      case '--since':
        opts.since = requireValue(argv[++i], '--since');
        break;
      case '--until':
        opts.until = requireValue(argv[++i], '--until');
        break;
      case '--limit':
        opts.limit = parseStrictInt(argv[++i], '--limit');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--reindex':
        opts.reindex = true;
        break;
      case '--rebuild':
        opts.rebuild = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unrecognized option: ${arg}`);
        }
        queryParts.push(arg);
    }
  }

  opts.query = queryParts.join(' ');
  return opts;
}

function toStoreQuery(opts: RecallOptions): RecallQuery {
  return {
    q: opts.query,
    limit: opts.limit,
    thread: opts.thread,
    source: opts.source,
    role: opts.role,
    since: opts.since,
    until: opts.until,
  };
}

/**
 * Derives the store's source config from the live PA_HOME layout plus the
 * Ecosystem KB knob (C10: `PA_KB_SOURCES_PATH` is a FILE, not a directory —
 * the KB source is that file's directory; unset means the KB source is
 * skipped, same "unset means off" convention as `kb-notes.ts`).
 */
export async function buildSourcesConfig(kbSourcesPath?: string): Promise<RecallSources> {
  const home = paHome();
  const p = kbSourcesPath ?? process.env.PA_KB_SOURCES_PATH ?? (await loadSecrets(['PA_KB_SOURCES_PATH'])).PA_KB_SOURCES_PATH;

  return {
    conversation: { live: join(home, 'conversation-history.jsonl'), archiveDir: join(home, 'archive') },
    traces: { live: join(home, 'turn-traces.jsonl'), archiveDir: join(home, 'archive') },
    topicBrains: { dir: join(home, 'topic-brains') },
    kb: p ? { dir: dirname(p) } : null,
    reviewDigest: { path: join(home, 'review-digest-pending.jsonl') },
    decisions: { dbPath: join(home, 'decisions.sqlite') },
  };
}

/**
 * Calls the recall-store engine IN-PROCESS — no spawn, no
 * `resolvePythonCommand`, no `execFile` (C5/D2.1 amendment). Never throws:
 * the store's exceptions are caught here and returned as `{ok:false, error}`.
 * Exported for the maintenance job and for tests.
 */
export async function runRecallEngine(
  op: 'query' | 'index' | 'rebuild',
  query?: RecallOptions,
): Promise<Record<string, unknown>> {
  try {
    const db = join(paHome(), 'recall.sqlite');
    const sources = await buildSourcesConfig();
    switch (op) {
      case 'index':
        return indexRecall(db, sources) as unknown as Record<string, unknown>;
      case 'rebuild':
        return rebuildRecall(db, sources) as unknown as Record<string, unknown>;
      case 'query':
        return queryRecall(db, sources, toStoreQuery(query!), RECALL_REFRESH_MS) as unknown as Record<string, unknown>;
      default:
        return { ok: false, error: `unknown op: ${op as string}` };
    }
  } catch (err) {
    logger.warn('recall', 'engine failed', { op, error: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
}

function renderHit(n: number, hit: RecallHit): string {
  const tsLabel = hit.ts ? formatIST(new Date(hit.ts)) : 'no date';
  const threadLabel = hit.thread_id !== null ? `thread ${hit.thread_id}` : null;
  const rescueLabel = hit.rescue ? '[or-rescue]' : null;
  const meta = [hit.source, hit.title, tsLabel, threadLabel, rescueLabel].filter(Boolean).join(' · ');
  return `${n}. ${meta}\n   ${hit.snippet}`;
}

function renderQueryResult(query: string, result: Record<string, unknown>): string {
  const hits = (result.hits ?? []) as RecallHit[];
  const total = Number(result.total ?? 0);
  const note = result.note as string | null | undefined;

  const lines: string[] = [];
  lines.push(`${hits.length} hit(s) for ${JSON.stringify(query)} (${total} total)`);
  if (note) lines.push(note);
  lines.push('');
  hits.forEach((hit, i) => lines.push(renderHit(i + 1, hit)));
  return lines.join('\n');
}

function renderIndexSummary(label: string, result: Record<string, unknown>): string {
  if (result.ok !== true) {
    return `${label} failed: ${String(result.error ?? 'unknown error')}`;
  }
  const indexed = (result.indexed ?? {}) as { added?: number; updated?: number; deleted?: number; ms?: number };
  const sources = (result.sources ?? {}) as Record<string, unknown>;
  const sourceCount = Object.keys(sources).length;
  return (
    `${label}: ${indexed.added ?? 0} added, ${indexed.updated ?? 0} updated, ${indexed.deleted ?? 0} deleted ` +
    `across ${sourceCount} source(s) (${indexed.ms ?? 0} ms)`
  );
}

/**
 * `pa recall "<query>" [--thread N] [--source s] [--role user|assistant]
 *   [--since d] [--until d] [--limit n] [--json] [--reindex] [--rebuild]`
 *
 * `--rebuild` takes priority over `--reindex`, which takes priority over a
 * plain query — `--reindex`/`--rebuild` with no query run the index op and
 * print a one-line summary. Unknown flags -> usage to stderr, exit 2.
 */
export async function recallCommand(argv: string[]): Promise<number> {
  let opts: RecallOptions;
  try {
    opts = parseRecallArgs(argv);
  } catch (err) {
    console.error(RECALL_USAGE);
    console.error((err as Error).message);
    return 2;
  }

  if (!opts.query && !opts.reindex && !opts.rebuild) {
    console.error(RECALL_USAGE);
    return 2;
  }

  if (opts.rebuild) {
    const result = await runRecallEngine('rebuild');
    if (opts.json) {
      console.log(JSON.stringify(redactSecrets(result)));
    } else {
      console.log(redactSecrets(renderIndexSummary('rebuild', result)) as string);
    }
    return result.ok === true ? 0 : 1;
  }

  if (opts.reindex) {
    const result = await runRecallEngine('index');
    if (opts.json) {
      console.log(JSON.stringify(redactSecrets(result)));
    } else {
      console.log(redactSecrets(renderIndexSummary('reindex', result)) as string);
    }
    return result.ok === true ? 0 : 1;
  }

  const result = await runRecallEngine('query', opts);
  if (result.ok !== true) {
    console.error(redactSecrets(`recall failed: ${String(result.error ?? 'unknown error')}`) as string);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify(redactSecrets(result)));
  } else {
    console.log(redactSecrets(renderQueryResult(opts.query, result)) as string);
  }
  return 0;
}
