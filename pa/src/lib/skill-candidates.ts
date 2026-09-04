/**
 * Analyzer watermark + candidate ledger (spec: the 2026-08-24 recall-traces
 * spec §3.5/E1). Two durable files under PA_HOME:
 *
 *  - analyzer-state.json   — the incremental watermark (`covers_through`) that
 *    `analyzeConversationPatterns` (analyzer.ts) advances after a fully-successful
 *    keying pass, so the nightly self-improver run never re-reads turns it has
 *    already keyed.
 *  - skill-candidates.json — the accumulating ledger of {key -> SkillCandidate},
 *    fed by Pass 1 (keying) and consumed by Pass 2 (proposal) once a key has
 *    been seen on SKILL_CANDIDATE_MIN_DAYS distinct days.
 *
 * Both files are small, single-process-owned JSON ledgers — same shape of
 * problem as pa/src/lib/maintenance/state.ts's readLedger/writeLedgerAtomic,
 * whose "missing/corrupt -> fresh default, never throw" pattern this mirrors.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../paths.js';
import { writeJsonAtomic } from './atomic-write.js';
import { log } from './log.js';

export const ANALYZER_STATE_VERSION = 1;
export const SKILL_CANDIDATES_VERSION = 1;
/** >= this many DISTINCT days before a key is proposed (D3.4). A constant, not an
 *  env knob — one fewer documented surface, and the value is a design decision. */
export const SKILL_CANDIDATE_MIN_DAYS = 3;
/** Do not re-propose the same key within this window (D3.4). */
export const SKILL_CANDIDATE_REPROPOSE_MS = 14 * 24 * 60 * 60_000;
/** Per-turn text cap handed to the LLM, replacing the 300-char cut (D3.1/D3.5). */
export const ANALYZER_TURN_CHARS = 4000;

/** Newest-kept cap on SkillCandidate.turn_refs (E1). */
const MAX_TURN_REFS = 20;

export interface AnalyzerState {
  version: number;
  covers_through: string | null;
  last_run_at: string | null;
  backfilled: boolean;
}

export interface CandidateTurnRef {
  thread_id?: number;
  message_id?: number;
  ts: string;
  run_id?: string;
}

export interface SkillCandidate {
  key: string;
  intent: string;
  count: number;
  days: string[]; // unique YYYY-MM-DD, ascending
  turn_refs: CandidateTurnRef[]; // capped at 20, newest kept
  first_seen: string;
  last_seen: string;
  origin: 'analyzer' | 'worker'; // D3.7 seam; v1 only ever writes 'analyzer'
  proposed_at: string | null;
  draft_id: string | null;
}

export interface SkillCandidateLedger {
  version: number;
  candidates: Record<string, SkillCandidate>;
}

export function analyzerStatePath(): string {
  return join(paHome(), 'analyzer-state.json');
}

export function skillCandidatesPath(): string {
  return join(paHome(), 'skill-candidates.json');
}

function defaultAnalyzerState(): AnalyzerState {
  return { version: ANALYZER_STATE_VERSION, covers_through: null, last_run_at: null, backfilled: false };
}

function defaultCandidateLedger(): SkillCandidateLedger {
  return { version: SKILL_CANDIDATES_VERSION, candidates: {} };
}

/** Missing/torn -> a fresh default, logged at warn with a refId-free message. Never throws. */
export async function loadAnalyzerState(): Promise<AnalyzerState> {
  const path = analyzerStatePath();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.version === ANALYZER_STATE_VERSION) {
      return parsed as AnalyzerState;
    }
    log('warn', 'skill-candidates', 'analyzer-state.json has an unexpected shape — resetting to a fresh default', { path });
    return defaultAnalyzerState();
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      log('warn', 'skill-candidates', 'analyzer-state.json unreadable — resetting to a fresh default', { path, error: String(err) });
    }
    return defaultAnalyzerState();
  }
}

export async function saveAnalyzerState(s: AnalyzerState): Promise<void> {
  await writeJsonAtomic(analyzerStatePath(), s);
}

/** Missing/torn -> a fresh default, logged at warn with a refId-free message. Never throws. */
export async function loadCandidates(): Promise<SkillCandidateLedger> {
  const path = skillCandidatesPath();
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' &&
      parsed.version === SKILL_CANDIDATES_VERSION &&
      parsed.candidates && typeof parsed.candidates === 'object'
    ) {
      return parsed as SkillCandidateLedger;
    }
    log('warn', 'skill-candidates', 'skill-candidates.json has an unexpected shape — resetting to a fresh default', { path });
    return defaultCandidateLedger();
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      log('warn', 'skill-candidates', 'skill-candidates.json unreadable — resetting to a fresh default', { path, error: String(err) });
    }
    return defaultCandidateLedger();
  }
}

export async function saveCandidates(l: SkillCandidateLedger): Promise<void> {
  await writeJsonAtomic(skillCandidatesPath(), l);
}

/** Pure. Folds one keying result into the ledger; returns a NEW ledger. */
export function upsertCandidate(
  ledger: SkillCandidateLedger,
  input: { key: string; intent: string; ref: CandidateTurnRef },
): SkillCandidateLedger {
  const existing = ledger.candidates[input.key];
  const day = input.ref.ts.slice(0, 10);

  if (!existing) {
    const candidate: SkillCandidate = {
      key: input.key,
      intent: input.intent,
      count: 1,
      days: [day],
      turn_refs: [input.ref],
      first_seen: input.ref.ts,
      last_seen: input.ref.ts,
      origin: 'analyzer',
      proposed_at: null,
      draft_id: null,
    };
    return { ...ledger, candidates: { ...ledger.candidates, [input.key]: candidate } };
  }

  const days = existing.days.includes(day) ? existing.days : [...existing.days, day].sort();
  const turnRefs = [...existing.turn_refs, input.ref].slice(-MAX_TURN_REFS);
  const candidate: SkillCandidate = {
    ...existing,
    // Latest occurrence's intent wins (the LLM has seen one more example by
    // now); an empty/missing new intent falls back to what we already had.
    intent: input.intent || existing.intent,
    count: existing.count + 1,
    days,
    turn_refs: turnRefs,
    last_seen: input.ref.ts > existing.last_seen ? input.ref.ts : existing.last_seen,
  };
  return { ...ledger, candidates: { ...ledger.candidates, [input.key]: candidate } };
}

/** Pure. Keys eligible for a Pass-2 proposal, most-recent-first. */
export function eligibleCandidates(
  ledger: SkillCandidateLedger,
  opts: { nowMs: number; existingSkillNames: string[]; existingDraftNames: string[] },
): SkillCandidate[] {
  const existingLower = new Set(
    [...opts.existingSkillNames, ...opts.existingDraftNames].map((n) => n.toLowerCase()),
  );

  const result: SkillCandidate[] = [];
  for (const candidate of Object.values(ledger.candidates)) {
    if (candidate.days.length < SKILL_CANDIDATE_MIN_DAYS) continue;
    if (candidate.draft_id !== null) continue;
    if (candidate.proposed_at !== null) {
      const age = opts.nowMs - Date.parse(candidate.proposed_at);
      if (age < SKILL_CANDIDATE_REPROPOSE_MS) continue;
    }
    if (existingLower.has(candidate.key.toLowerCase())) continue;
    result.push(candidate);
  }

  result.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  return result;
}
