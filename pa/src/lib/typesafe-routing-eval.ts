/**
 * Typed-routing calibration eval (2026-09-17) — replays past voice-inbox tasks
 * that an LLM routing turn placed through the typed router and reports, by
 * confidence band, how often TypeSafe agrees for the destination and the
 * continuation questions, plus the lowest band floor that meets the
 * precision target (destination 90%, continuation 95%; operator decision D3).
 * `pa typesafe eval` is its only caller. Read-only on the ledger; writes one
 * JSONL file of ids and answers (never request text). The labels are a proxy
 * (the LLM itself was sometimes wrong), today's topic descriptions stand in
 * for the ones that existed then, and the open-conversation offer is
 * reconstructed approximately (every conversation with a task in the 24 h
 * before the task, no status words), so the report bounds accuracy rather
 * than proving it.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { paHome } from '../paths.js';
import { voiceInboxLedgerPath } from './voice-inbox-ledger.js';
import { readTopicRegistry, type TopicRegistryEntry } from './topic-registry.js';
import { readVoiceInboxRoutingFileConfig, type VoiceInboxRoutingFileConfig } from './voice-inbox-routing-config.js';
import { askSystemOne, isTypeSafeConfigured } from './typesafe-client.js';
import {
  askTypedRouting,
  buildTypedRoutingRequest,
  candidateTopics,
  type TypedRoutingInput,
  type TypedRoutingTopic,
} from './voice-inbox-typed-routing.js';
import { openReadonly } from './voice-inbox-transcribe.js';

export const EVAL_EXCLUDED_REASON_PREFIXES: readonly string[] = [
  'Placed ',
  'Resumed by',
  'Sent back once',
  'formed ',
  'existing topic matched',
];
export const EVAL_OFFER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EVAL_SNIPPET_MAX_CHARS = 60;
export const EVAL_DEFAULT_LOOKBACK_DAYS = 14;
/** Band floors, highest first; a band runs from its floor up to the previous floor (1.00 for the first). */
export const EVAL_BAND_FLOORS: readonly number[] = [0.95, 0.9, 0.8, 0.7, 0.5, 0];
export const EVAL_MIN_SCORED_ROWS = 10;
export const DESTINATION_PRECISION_TARGET = 0.9;
export const CONTINUATION_PRECISION_TARGET = 0.95;

export interface EvalRow {
  taskId: string;
  createdAt: string;
  requestText: string;
  labelTopic: string;
  labelConversation: string | null;
  offer: Array<{ conversationId: string; snippet: string }>;
  askContinuation: boolean;
}

export interface EvalSkipCounts {
  notRouted: number;
  notLlmRouted: number;
  noText: number;
  labelNotCandidate: number;
}

interface EvalTaskRow {
  task_id: string;
  tenant_id: string;
  source: string;
  request_text: string | null;
  transcript: string | null;
  feedback_about: string | null;
  created_at: string;
}

function snippetOf(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, EVAL_SNIPPET_MAX_CHARS);
}

export function selectEvalRows(
  db: Database.Database,
  opts: { sinceIso: string; candidateKeys: ReadonlySet<string>; limit?: number }
): { rows: EvalRow[]; skipped: EvalSkipCounts } {
  const skipped: EvalSkipCounts = { notRouted: 0, notLlmRouted: 0, noText: 0, labelNotCandidate: 0 };
  const rows: EvalRow[] = [];
  const tasks = db
    .prepare(
      `SELECT task_id, tenant_id, source, request_text, transcript, feedback_about, created_at
       FROM tasks WHERE created_at >= ? ORDER BY created_at ASC, task_id ASC`
    )
    .all(opts.sinceIso) as EvalTaskRow[];
  const firstRouted = db.prepare(
    `SELECT payload_json FROM events WHERE task_id = ? AND kind = 'task.routed' ORDER BY ts ASC, rowid ASC LIMIT 1`
  );
  const offerWindow = db.prepare(
    `SELECT task_id, conversation_id, request_text FROM tasks
     WHERE tenant_id = ? AND created_at < ? AND created_at >= ? ORDER BY created_at ASC, task_id ASC`
  );
  for (const t of tasks) {
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
    const event = firstRouted.get(t.task_id) as { payload_json: string | null } | undefined;
    if (!event) {
      skipped.notRouted += 1;
      continue;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(event.payload_json ?? '{}') as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    if (EVAL_EXCLUDED_REASON_PREFIXES.some((p) => reason.startsWith(p)) || reason.includes('deterministic fallback')) {
      skipped.notLlmRouted += 1;
      continue;
    }
    const text =
      t.source === 'voice'
        ? (t.transcript ?? '').trim() || (t.request_text ?? '').trim()
        : (t.request_text ?? '').trim();
    if (text === '') {
      skipped.noText += 1;
      continue;
    }
    const labelTopic = typeof payload.routed_to === 'string' ? payload.routed_to : '';
    if (!opts.candidateKeys.has(labelTopic)) {
      skipped.labelNotCandidate += 1;
      continue;
    }
    const labelConversation =
      typeof payload.continues === 'string' && typeof payload.conversation_id === 'string' ? payload.conversation_id : null;
    const fromIso = new Date(Date.parse(t.created_at) - EVAL_OFFER_WINDOW_MS).toISOString();
    const groups = new Map<string, Array<{ task_id: string; request_text: string | null }>>();
    for (const w of offerWindow.all(t.tenant_id, t.created_at, fromIso) as Array<{
      task_id: string;
      conversation_id: string;
      request_text: string | null;
    }>) {
      if (w.conversation_id === t.task_id) continue;
      const group = groups.get(w.conversation_id) ?? [];
      group.push(w);
      groups.set(w.conversation_id, group);
    }
    const offer = [...groups.entries()].map(([conversationId, group]) => ({
      conversationId,
      snippet: snippetOf((group.find((g) => g.task_id === conversationId) ?? group[0]).request_text),
    }));
    rows.push({
      taskId: t.task_id,
      createdAt: t.created_at,
      requestText: text,
      labelTopic,
      labelConversation,
      offer,
      askContinuation: offer.length > 0 && !t.feedback_about,
    });
  }
  return { rows, skipped };
}

export interface EvalBand {
  floor: number;
  ceiling: number;
  n: number;
  agree: number;
}

export interface EvalQuestionSummary {
  bands: EvalBand[];
  scored: number;
  /** Lowest band floor whose cumulative precision (all rows at or above it) meets the target, with enough rows. */
  recommended: number | null;
}

export function summarizeQuestion(
  points: ReadonlyArray<{ confidence: number; correct: boolean }>,
  target: number
): EvalQuestionSummary {
  const bands: EvalBand[] = EVAL_BAND_FLOORS.map((floor, i) => ({
    floor,
    ceiling: i === 0 ? 1 : EVAL_BAND_FLOORS[i - 1],
    n: 0,
    agree: 0,
  }));
  for (const p of points) {
    const band = bands.find((b) => p.confidence >= b.floor) ?? bands[bands.length - 1];
    band.n += 1;
    if (p.correct) band.agree += 1;
  }
  let recommended: number | null = null;
  let n = 0;
  let agree = 0;
  for (const band of bands) {
    n += band.n;
    agree += band.agree;
    if (band.n === 0) continue; // corrected 2026-09-17: an empty band cannot earn a lower floor
    if (n >= EVAL_MIN_SCORED_ROWS && agree / n >= target) recommended = band.floor;
  }
  return { bands, scored: points.length, recommended };
}

export interface EvalOptions {
  sinceIso?: string;
  limit?: number;
  dryRun: boolean;
  outPath?: string;
}

export interface EvalDeps {
  print: (line: string) => void;
  nowFn?: () => number;
  ledgerPath?: string;
  readRegistryFn?: () => TopicRegistryEntry[];
  readConfigFn?: () => VoiceInboxRoutingFileConfig;
  configuredFn?: () => boolean;
  askFn?: typeof askSystemOne;
  openDbFn?: (path: string) => Database.Database;
}

export function printSummary(print: (line: string) => void, name: string, summary: EvalQuestionSummary, target: number): void {
  for (const b of summary.bands) {
    const pct = b.n === 0 ? 0 : Math.round((100 * b.agree) / b.n);
    print(`${name}: band ${b.floor.toFixed(2)}-${b.ceiling.toFixed(2)} n=${b.n} agree=${pct}%`);
  }
  const rec = summary.recommended === null ? 'none' : summary.recommended.toFixed(2);
  print(`${name}: scored=${summary.scored} recommended_threshold=${rec} target=${Math.round(target * 100)}%`);
}

/** Returns the process exit code: 0 done, 1 cannot run. */
export async function runTypedRoutingEval(opts: EvalOptions, deps: EvalDeps): Promise<number> {
  const print = deps.print;
  const now = (deps.nowFn ?? Date.now)();
  const ledgerPath = deps.ledgerPath ?? voiceInboxLedgerPath();
  if (!existsSync(ledgerPath)) {
    print(`typesafe eval: no voice-inbox ledger at ${ledgerPath}`);
    return 1;
  }
  const fileConfig = (deps.readConfigFn ?? (() => readVoiceInboxRoutingFileConfig()))();
  if (!fileConfig.inboxTopic) {
    print('typesafe eval: voice_inbox.inbox_topic is not configured');
    return 1;
  }
  const topics: TypedRoutingTopic[] = candidateTopics((deps.readRegistryFn ?? (() => readTopicRegistry()))(), fileConfig.inboxTopic);
  const sinceIso = opts.sinceIso ?? new Date(now - EVAL_DEFAULT_LOOKBACK_DAYS * 86_400_000).toISOString();
  const db = (deps.openDbFn ?? openReadonly)(ledgerPath);
  let selected: { rows: EvalRow[]; skipped: EvalSkipCounts };
  try {
    selected = selectEvalRows(db, { sinceIso, candidateKeys: new Set(topics.map((t) => t.key)), limit: opts.limit });
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  const { rows, skipped } = selected;
  print(
    `typesafe eval: rows=${rows.length} topics=${topics.length} since=${sinceIso} skipped not-routed=${skipped.notRouted} not-llm-routed=${skipped.notLlmRouted} no-text=${skipped.noText} label-not-candidate=${skipped.labelNotCandidate}`
  );
  const inputOf = (r: EvalRow): TypedRoutingInput => ({
    requestText: r.requestText,
    topics,
    openConversations: r.askContinuation ? r.offer.map((o) => ({ ...o, topicKey: null })) : [],
  });
  if (opts.dryRun) {
    const sizes = rows.map((r) => JSON.stringify(buildTypedRoutingRequest(inputOf(r))).length);
    const avg = sizes.length === 0 ? 0 : Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
    const max = sizes.length === 0 ? 0 : Math.max(...sizes);
    print(`typesafe eval: dry-run, no requests sent; request_chars avg=${avg} max=${max}`);
    return 0;
  }
  if (!(deps.configuredFn ?? (() => isTypeSafeConfigured()))()) {
    print('typesafe eval: not configured (TYPESAFE_API_KEY unset or circuit breaker open); nothing was sent');
    return 1;
  }
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const outPath = opts.outPath ?? join(paHome(), 'typesafe-eval', `routing-${stamp}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  const destination: Array<{ confidence: number; correct: boolean }> = [];
  const continuation: Array<{ confidence: number; correct: boolean }> = [];
  let unavailable = 0;
  let noneChosen = 0;
  for (const r of rows) {
    const decision = await askTypedRouting(inputOf(r), { ask: deps.askFn, purpose: 'typesafe-eval' });
    let continuationScored = false;
    if (decision.kind === 'unavailable') {
      unavailable += 1;
    } else {
      destination.push({ confidence: decision.destination.confidence, correct: decision.destination.topicKey === r.labelTopic });
      if (decision.destination.topicKey === null) noneChosen += 1;
      const labelOffered = r.labelConversation === null || r.offer.some((o) => o.conversationId === r.labelConversation);
      if (decision.continuation && r.askContinuation && labelOffered) {
        continuationScored = true;
        continuation.push({
          confidence: decision.continuation.confidence,
          correct: decision.continuation.conversationId === r.labelConversation,
        });
      }
    }
    appendFileSync(
      outPath,
      `${JSON.stringify({ taskId: r.taskId, createdAt: r.createdAt, labelTopic: r.labelTopic, labelConversation: r.labelConversation, continuationScored, decision })}\n`,
      'utf8'
    );
  }
  printSummary(print, 'destination', summarizeQuestion(destination, DESTINATION_PRECISION_TARGET), DESTINATION_PRECISION_TARGET);
  printSummary(print, 'continuation', summarizeQuestion(continuation, CONTINUATION_PRECISION_TARGET), CONTINUATION_PRECISION_TARGET);
  const nonePct = destination.length === 0 ? 0 : Math.round((100 * noneChosen) / destination.length);
  print(`destination: none_of_the_above=${nonePct}% unavailable=${unavailable}`);
  print(`typesafe eval: wrote ${outPath}`);
  return 0;
}
