import { createReadStream } from 'fs';
import { access, unlink } from 'fs/promises';
import { createInterface } from 'readline';
import { join } from 'path';
import { paHome } from './paths.js';
import { listSkills } from './skills.js';
import { listDrafts, isDuplicate, computeFingerprint } from './drafts.js';
import { runWithFailover } from './workers.js';
import { notifyUser } from './lib/notify.js';
import {
  ANALYZER_STATE_VERSION,
  ANALYZER_TURN_CHARS,
  analyzerStatePath,
  loadAnalyzerState,
  saveAnalyzerState,
  loadCandidates,
  saveCandidates,
  upsertCandidate,
  eligibleCandidates,
} from './lib/skill-candidates.js';
import type { CandidateTurnRef, SkillCandidate } from './lib/skill-candidates.js';
import type { DraftProposal } from './types.js';

export interface ConversationTurn {
  role: string;
  text: string;
  timestamp: string;
  message_id?: string;
  thread_id?: number;
}

/** Turn shape with the archive join fields (WP-B/C23-C24) a turn MAY carry. */
export interface EvidenceTurn extends ConversationTurn {
  message_id?: string;
  thread_id?: number;
  run_id?: string;
  update_id?: number;
  session_id?: string;
  refId?: string;
}

export async function readRecentConversations(days: number): Promise<ConversationTurn[]> {
  const filePath = join(paHome(), 'conversation-history.jsonl');

  try {
    await access(filePath);
  } catch {
    return [];
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const turns: ConversationTurn[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const turn = JSON.parse(trimmed) as ConversationTurn;
      if (new Date(turn.timestamp) >= cutoff) turns.push(turn);
    } catch {
      // skip malformed
    }
  }

  return turns;
}

/**
 * USER turns strictly after `coversThrough` (all turns when null), oldest first.
 * Assistant turns never enter Pass 1 (D3.1) — filtered out here, not left to the
 * caller, so every consumer of this function gets the same guarantee.
 */
export async function readTurnsSince(coversThrough: string | null, maxDays: number): Promise<EvidenceTurn[]> {
  const filePath = join(paHome(), 'conversation-history.jsonl');

  try {
    await access(filePath);
  } catch {
    return [];
  }

  const cutoff = coversThrough === null ? new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000) : null;
  const turns: EvidenceTurn[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const turn = JSON.parse(trimmed) as EvidenceTurn;
      if (turn.role !== 'user') continue;
      if (coversThrough !== null) {
        // Strict `>` — a turn AT the watermark was already processed by the run
        // that set it.
        if (!(turn.timestamp > coversThrough)) continue;
      } else if (cutoff && new Date(turn.timestamp) < cutoff) {
        continue;
      }
      turns.push(turn);
    } catch {
      // skip malformed
    }
  }

  // The archive is append-ordered already; sort defensively so callers can
  // rely on "oldest first" even if that ever stops being true upstream.
  turns.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return turns;
}

/** Shared fence-stripping for both response parsers below. */
function stripMarkdownFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    const lastFence = cleaned.lastIndexOf('```');
    if (firstNewline !== -1 && lastFence > firstNewline) {
      cleaned = cleaned.slice(firstNewline + 1, lastFence).trim();
    }
  }
  return cleaned;
}

export function parseProposalResponse(raw: string): DraftProposal[] {
  const cleaned = stripMarkdownFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const proposals: DraftProposal[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, reason, source_message_ids, frontmatter, prompt, target_skill, code_target } = item as Record<string, unknown>;

    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof reason !== 'string' || !reason.trim()) continue;
    if (typeof prompt !== 'string' || !prompt.trim()) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue; // injection guard
    // target_skill (when present and non-null) names an *existing* skill — same charset as
    // skill names, and must pass loadSkill()'s own traversal guard later. `null`/omitted both
    // mean "no target" (e.g. a brand-new skill, or failure-analyzer's diagnostic-skill option)
    // — only a non-null value that fails the shape check is treated as malformed.
    if (target_skill !== undefined && target_skill !== null
      && (typeof target_skill !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(target_skill))) continue;
    // code_target (2026-07-11, autonomous code-fix capability) — an LLM-proposed repo-relative
    // FILE path, not a skill name, so it needs its own charset + traversal guard rather than
    // reusing target_skill's. `null`/omitted both mean "no hint" (the common case — most
    // failure proposals won't name a specific file). A malformed value drops the WHOLE
    // proposal, same severity as a malformed target_skill — code-fixer.ts treats this as a
    // hint it will pass straight to a coding worker's brief, so it must never carry a
    // traversal/absolute-path payload through unvalidated.
    if (code_target !== undefined && code_target !== null
      && (typeof code_target !== 'string'
        || !/^[a-zA-Z0-9_][a-zA-Z0-9_.\-/]*$/.test(code_target)
        || code_target.includes('..')
        || code_target.startsWith('/')
        || /^[a-zA-Z]:/.test(code_target))) continue;

    proposals.push({
      name: name.trim(),
      reason: reason.trim(),
      source_message_ids: Array.isArray(source_message_ids)
        ? source_message_ids.filter((id) => typeof id === 'string')
        : [],
      frontmatter: typeof frontmatter === 'object' && frontmatter !== null
        ? frontmatter as Partial<DraftProposal['frontmatter']>
        : {},
      prompt: prompt.trim(),
      ...(typeof target_skill === 'string' && target_skill.trim() ? { target_skill: target_skill.trim() } : {}),
      ...(typeof code_target === 'string' && code_target.trim() ? { code_target: code_target.trim() } : {}),
    });
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Pass 1 — keying
// ---------------------------------------------------------------------------

export interface KeyingResult {
  message_id: string;
  key: string | null;
  intent: string;
}

/**
 * Pass-1 keying prompt. Renders full turn text (capped at ANALYZER_TURN_CHARS,
 * not the old 300-char cut) and asks the LLM to assign each turn a reusable
 * "key" (or null for non-actionable turns), defaulting to reuse of an
 * existing key over minting a new one.
 */
export function buildKeyingPrompt(
  turns: EvidenceTurn[],
  existingKeys: Array<{ key: string; intent: string }>,
  existingSkills: Array<{ name: string; description: string }>,
): string {
  // Defensive: only user turns are ever rendered, even if the caller hands
  // this a mixed-role list (readTurnsSince already filters, but this function
  // must not depend on that to stay correct in isolation).
  const userTurns = turns.filter((t) => t.role === 'user');

  const byDay = new Map<string, EvidenceTurn[]>();
  for (const turn of userTurns) {
    const day = turn.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(turn);
  }

  const conversationBlock = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayTurns]) => {
      const lines = dayTurns
        .map((t) => `[${t.message_id ?? ''}] ${(t.text ?? '').slice(0, ANALYZER_TURN_CHARS)}`)
        .join('\n');
      return `## ${day}\n${lines}`;
    })
    .join('\n\n');

  const keyList = existingKeys.length
    ? existingKeys.map((k) => `- ${k.key}: ${k.intent}`).join('\n')
    : 'none';
  const skillList = existingSkills.length
    ? existingSkills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    : 'none';

  return `You are keying a personal assistant's user turns by recurring intent, to detect patterns worth automating as a "skill" (a reusable prompt template).

## User Turns (last ${[...byDay.keys()].length} days)

${conversationBlock || '(no user turns in this period)'}

## Existing Candidate Keys
${keyList}

## Existing Skills
${skillList}

## Task

For EACH user turn above, assign a short kebab-case "key" summarizing the request's intent, plus a one-sentence "intent" description. Reusing an existing key is the default. Only mint a new key when no existing key describes the same intent. Set "key" to null for a turn that is not an actionable, repeatable request (a one-off question, small talk, a reply to the assistant, etc).

Respond with ONLY a JSON array (no markdown fences, no explanation). Each element must have these exact fields, one per turn, referencing the turn by its bracketed id:

[
  {
    "message_id": "the bracketed id of the turn",
    "key": "kebab-case-intent-key",
    "intent": "one-sentence description of the request"
  }
]

Set "key" to null (not the string "null") for a non-actionable turn. If no turns are present, respond with an empty array: []`;
}

export function parseKeyingResponse(raw: string): KeyingResult[] {
  const cleaned = stripMarkdownFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: KeyingResult[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { message_id, key, intent } = item as Record<string, unknown>;
    if (typeof message_id !== 'string' || !message_id.trim()) continue; // drop: non-string message_id
    const normalizedKey = typeof key === 'string' && key.trim() ? key.trim() : null; // missing/empty -> null
    results.push({
      message_id: message_id.trim(),
      key: normalizedKey,
      intent: typeof intent === 'string' ? intent.trim() : '',
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Pass 2 — proposal
// ---------------------------------------------------------------------------

/**
 * Renders the `tools=` segment from WP-A's real TurnTraceToolCall[] shape
 * (`{ n, name, arg, ok, ms? }[]`, spec §3.1/A5, corrected 2026-08-24 —
 * the field is `tool_calls`, not `tools`): aggregate by `name` into
 * `name×count`, ordered count desc then name asc (same ordering `pa ref`
 * uses). Anything not shaped like `{ name: string }` is skipped rather than
 * thrown on — the trace object is untrusted, opaque input to this function.
 */
function formatToolCalls(trace: Record<string, unknown>): string {
  const toolCalls = Array.isArray((trace as any).tool_calls) ? ((trace as any).tool_calls as unknown[]) : [];
  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    const name = typeof (call as any)?.name === 'string' ? (call as any).name : undefined;
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return 'none';
  return [...counts.entries()]
    .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
}

function formatTraceSummary(fallbackRunId: string | undefined, trace: Record<string, unknown>): string {
  const runId = typeof trace.run_id === 'string' ? trace.run_id : (fallbackRunId ?? 'unknown');
  const toolsStr = formatToolCalls(trace);
  const commands = Array.isArray((trace as any).commands) ? ((trace as any).commands as unknown[]).slice(0, 5) : [];
  const files = Array.isArray((trace as any).files) ? ((trace as any).files as unknown[]).slice(0, 5) : [];
  const outcome = typeof (trace as any).outcome === 'string' ? (trace as any).outcome : 'unknown';
  return `Trace for this run (run_id ${runId}): tools=${toolsStr}; commands=${commands.join(', ') || 'none'}; files=${files.join(', ') || 'none'}; outcome=${outcome}`;
}

/**
 * Pass-2 proposal prompt for one eligible candidate. Up to 5 occurrences,
 * newest first; each carries the user turn's full text, a trace summary (or
 * the literal "no trace recorded" when none is available — D3.4), and an
 * optional assistant reply rendered as context only, never as evidence.
 */
export function buildProposalPrompt(
  candidate: SkillCandidate,
  occurrences: Array<{ turn: EvidenceTurn; assistantReply?: string; trace?: Record<string, unknown> }>,
  existingSkills: string[],
  existingDrafts: string[],
): string {
  const top = occurrences.slice(0, 5);

  const occurrenceBlocks = top
    .map((occ, i) => {
      const userText = (occ.turn.text ?? '').slice(0, ANALYZER_TURN_CHARS);
      const traceLine = occ.trace ? formatTraceSummary(occ.turn.run_id, occ.trace) : 'no trace recorded';
      const lines = [
        `### Occurrence ${i + 1} (${occ.turn.timestamp})`,
        `User: ${userText}`,
        traceLine,
      ];
      if (occ.assistantReply) {
        lines.push(`Assistant reply (context only, NOT evidence): ${occ.assistantReply.slice(0, ANALYZER_TURN_CHARS)}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  const exclusionList = [...existingSkills, ...existingDrafts].join(', ') || 'none';

  return `You are proposing a personal assistant "skill" (a reusable prompt template) for a recurring user request.

## Candidate
Key: ${candidate.key}
Intent: ${candidate.intent}
Seen on ${candidate.days.length} different days.

## Occurrences (newest first, up to 5)

${occurrenceBlocks || '(no occurrences)'}

## Existing Skills and Drafts (do NOT re-propose these)
${exclusionList}

## Task

Propose ONE skill definition for this recurring pattern, grounded in the occurrences above. Treat a trace line as evidence of what actually happened; treat an assistant reply as context only, NOT evidence.

Only propose a skill for a clear, actionable, repeatable task. If this pattern does not warrant a skill, say so by responding with an empty array.

Respond with ONLY a JSON array (no markdown fences, no explanation). Each element must have these exact fields:

[
  {
    "name": "kebab-case-skill-name",
    "reason": "Why this pattern warrants a skill (1-2 sentences)",
    "source_message_ids": ["id1", "id2"],
    "frontmatter": {
      "cron": null,
      "trigger_description": "When to fire this skill automatically",
      "timeout": 300,
      "idle_timeout": 120
    },
    "prompt": "The full skill prompt in markdown"
  }
]

If no patterns qualify, respond with an empty array: []`;
}

// ---------------------------------------------------------------------------
// Trace lookup seam (WP-A/A5 contract, reached lazily so a worktree without
// WP-A still compiles and behaves as "no trace available" — spec §3.5/E2, §4).
// ---------------------------------------------------------------------------

export type TraceLookup = (threadId: number, updateId: number) => Promise<Record<string, unknown> | null>;

let traceLookupOverride: TraceLookup | null = null;

/** Test seam. Production leaves it at the default (lookupTraceByUpdate). Tests set a
 *  stub so no test ever touches ~/.pa/turn-traces.jsonl. Reset in afterEach. */
export function _setTraceLookupForTest(fn: TraceLookup | null): void {
  traceLookupOverride = fn;
}

async function defaultTraceLookup(threadId: number, updateId: number): Promise<Record<string, unknown> | null> {
  try {
    // Dynamic + loosely-typed on purpose: pa/src/lib/ref-lookup.ts may not yet
    // export lookupTraceByUpdate in every worktree (WP-A/A5 had not landed in
    // this one at build time — confirmed by grep before this file was
    // written). A static import would fail to compile until WP-A merges; this
    // resolves at runtime instead, and when the export is absent it safely
    // returns null — the same behaviour spec §4 asks for as the fallback
    // ("default the seam to async () => null"), but self-healing once WP-A's
    // dist lands, so no follow-up edit is required.
    const mod = (await import('./lib/ref-lookup.js')) as unknown as {
      lookupTraceByUpdate?: TraceLookup;
    };
    if (typeof mod.lookupTraceByUpdate === 'function') {
      return await mod.lookupTraceByUpdate(threadId, updateId);
    }
  } catch {
    // WP-A not present (or its lookup threw) — no trace available.
  }
  return null;
}

function getTraceLookup(): TraceLookup {
  return traceLookupOverride ?? defaultTraceLookup;
}

/** Test seam: clears analyzer-state.json under the current PA_HOME so a shared-home
 *  test file can call analyzeConversationPatterns more than once (C26). */
export async function _resetAnalyzerStateForTest(): Promise<void> {
  await unlink(analyzerStatePath()).catch(() => {});
}

// ---------------------------------------------------------------------------
// Shared two-pass driver
// ---------------------------------------------------------------------------

async function resolveTrace(turn: EvidenceTurn, lookup: TraceLookup): Promise<Record<string, unknown> | null> {
  if (turn.thread_id === undefined || turn.update_id === undefined) return null;
  try {
    return await lookup(turn.thread_id, turn.update_id);
  } catch {
    return null;
  }
}

async function runAnalysisPasses(opts: {
  since: string | null;
  days: number;
  runner: typeof runWithFailover;
  advanceWatermark: boolean;
  traceLookup: TraceLookup;
}): Promise<DraftProposal[]> {
  const turns = await readTurnsSince(opts.since, opts.days);

  // Short-circuit: no conversations to analyze — no LLM call, watermark untouched.
  if (turns.length === 0) return [];

  const [skills, drafts, initialLedger] = await Promise.all([listSkills(), listDrafts(), loadCandidates()]);
  const existingSkillNames = skills.map((s) => s.name);
  const existingDraftNames = drafts.map((d) => d.skill.name);
  const existingSkillDescs = skills.map((s) => ({ name: s.name, description: s.frontmatter.trigger_description ?? '' }));

  // Group turns by UTC day, ascending — one Pass-1 runner call per day.
  const byDay = new Map<string, EvidenceTurn[]>();
  const turnsByMessageId = new Map<string, EvidenceTurn>();
  let maxTimestamp: string | null = null;
  for (const turn of turns) {
    const day = turn.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(turn);
    if (turn.message_id !== undefined) turnsByMessageId.set(String(turn.message_id), turn);
    if (maxTimestamp === null || turn.timestamp > maxTimestamp) maxTimestamp = turn.timestamp;
  }
  const days = [...byDay.keys()].sort();

  let ledger = initialLedger;
  let allBatchesParsedNonEmpty = true;

  for (const day of days) {
    const dayTurns = byDay.get(day)!;
    const existingKeysForPrompt = Object.values(ledger.candidates).map((c) => ({ key: c.key, intent: c.intent }));
    const prompt = buildKeyingPrompt(dayTurns, existingKeysForPrompt, existingSkillDescs);

    const { result } = await opts.runner(prompt, {
      resource: 'skill-learner-keying',
      timeout: 300,
      idleTimeout: 120,
    });

    if (!result.success) {
      await notifyUser(
        'Analyzer terminal failure',
        `The conversation pattern analyzer LLM run failed.\nError: ${(result.error ?? 'unknown').slice(0, 300)}`,
        { dedupKey: 'analyzer-terminal', severity: 'error' },
      ).catch(() => {});
      allBatchesParsedNonEmpty = false;
      continue;
    }

    const keyingResults = parseKeyingResponse(result.output);
    if (keyingResults.length === 0) {
      // Parse failure (or a genuinely empty response) — D3.3: leave the
      // watermark unmoved for this run rather than silently lose the day.
      allBatchesParsedNonEmpty = false;
      continue;
    }

    for (const kr of keyingResults) {
      if (kr.key === null) continue;
      const turn = turnsByMessageId.get(kr.message_id);
      if (!turn) continue;
      const ref: CandidateTurnRef = {
        thread_id: turn.thread_id,
        message_id: turn.message_id !== undefined ? Number(turn.message_id) : undefined,
        ts: turn.timestamp,
        run_id: turn.run_id,
      };
      ledger = upsertCandidate(ledger, { key: kr.key, intent: kr.intent, ref });
    }
  }

  await saveCandidates(ledger);

  const eligible = eligibleCandidates(ledger, {
    nowMs: Date.now(),
    existingSkillNames,
    existingDraftNames,
  });

  const proposals: DraftProposal[] = [];
  const seenNames = new Set<string>();
  const seenFingerprints = new Set<string>();
  let ledgerChangedAfterSave = false;

  for (const candidate of eligible) {
    const refsNewestFirst = [...candidate.turn_refs].reverse().slice(0, 5);
    const occurrences: Array<{ turn: EvidenceTurn; assistantReply?: string; trace?: Record<string, unknown> }> = [];

    for (const ref of refsNewestFirst) {
      const freshTurn = ref.message_id !== undefined ? turnsByMessageId.get(String(ref.message_id)) : undefined;
      const turn: EvidenceTurn = freshTurn ?? {
        role: 'user',
        // CandidateTurnRef (E1) does not store turn text — only turns fetched
        // in THIS run (freshTurn above) have real text available. An
        // occurrence carried over from an earlier run's ledger entry has no
        // text to show; said explicitly rather than rendered as blank.
        text: '(original text not retained in the candidate ledger — this occurrence is from an earlier analyzer run)',
        timestamp: ref.ts,
        message_id: ref.message_id !== undefined ? String(ref.message_id) : undefined,
        thread_id: ref.thread_id,
        run_id: ref.run_id,
      };
      const trace = await resolveTrace(turn, opts.traceLookup);
      occurrences.push({ turn, trace: trace ?? undefined });
    }

    const prompt = buildProposalPrompt(candidate, occurrences, existingSkillNames, existingDraftNames);
    const { result } = await opts.runner(prompt, {
      resource: 'skill-learner-proposal',
      timeout: 300,
      idleTimeout: 120,
    });

    if (!result.success) {
      await notifyUser(
        'Analyzer terminal failure (proposal pass)',
        `The conversation pattern analyzer LLM run failed.\nError: ${(result.error ?? 'unknown').slice(0, 300)}`,
        { dedupKey: 'analyzer-terminal', severity: 'error' },
      ).catch(() => {});
      continue;
    }

    const candidateProposals = parseProposalResponse(result.output);
    let producedAny = false;
    for (const proposal of candidateProposals) {
      const fingerprint = computeFingerprint(proposal.name, proposal.prompt);
      if (seenNames.has(proposal.name)) continue;
      if (seenFingerprints.has(fingerprint)) continue;
      if (await isDuplicate(proposal)) continue;
      seenNames.add(proposal.name);
      seenFingerprints.add(fingerprint);
      proposals.push(proposal);
      producedAny = true;
    }

    if (producedAny) {
      const existingCandidate = ledger.candidates[candidate.key];
      if (existingCandidate) {
        ledger = {
          ...ledger,
          candidates: {
            ...ledger.candidates,
            [candidate.key]: { ...existingCandidate, proposed_at: new Date().toISOString() },
          },
        };
        ledgerChangedAfterSave = true;
      }
    }
  }

  if (ledgerChangedAfterSave) {
    await saveCandidates(ledger);
  }

  if (opts.advanceWatermark && allBatchesParsedNonEmpty && maxTimestamp !== null) {
    const priorState = await loadAnalyzerState();
    await saveAnalyzerState({
      version: ANALYZER_STATE_VERSION,
      covers_through: maxTimestamp,
      last_run_at: new Date().toISOString(),
      backfilled: opts.since === null ? true : priorState.backfilled,
    });
  }

  return proposals;
}

/**
 * The incremental, watermark-advancing entry point. `days` is used only when
 * no watermark exists yet (first-run backfill, D3.1) — once analyzer-state.json
 * has a `covers_through`, `days` is ignored and every turn since the watermark
 * is processed. Signature is byte-identical to the pre-wave export (C22):
 * self-improver.ts:530's existing call needs no edit.
 */
export async function analyzeConversationPatterns(
  days: number = 14,
  runner: typeof runWithFailover = runWithFailover
): Promise<DraftProposal[]> {
  const state = await loadAnalyzerState();
  return runAnalysisPasses({
    since: state.covers_through,
    days,
    runner,
    advanceWatermark: true,
    traceLookup: getTraceLookup(),
  });
}

/**
 * The non-advancing sibling for `pa learn` (D3.6). Same two passes over an
 * EXPLICIT `days` window, writing the candidate ledger but NEVER reading or
 * writing analyzer-state.json — an on-demand run can never move the nightly
 * watermark.
 */
export async function analyzeConversationWindow(
  days: number = 14,
  runner: typeof runWithFailover = runWithFailover
): Promise<DraftProposal[]> {
  return runAnalysisPasses({
    since: null,
    days,
    runner,
    advanceWatermark: false,
    traceLookup: getTraceLookup(),
  });
}
