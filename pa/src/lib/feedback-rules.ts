/**
 * Feedback-rules store and check evaluator (AI-165).
 *
 * - Add-only yaml store (~/.pa/feedback-rules.yaml) with supersede-by-key semantics
 * - Deterministic check evaluator (forbidden_phrase, must_include, max_length)
 * - Reaction compiler from decisions.sqlite 👎 rows
 * - Audit trail (feedback-rules-audit.jsonl) for every mutation
 * - Violation record path (rules-violations.jsonl) written by bot critic and weekly grader
 *
 * All writes serialized under proper-lockfile on the yaml path with tmp-file + renameSync
 * atomic replace. Never-throws surface: failures log and return {ok:false,error}.
 *
 * C1: Uses existing yaml dependency (^2.7.0) already in pa/package.json.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import lockfile from 'proper-lockfile';
import { parse, stringify } from 'yaml';
import { paHome } from '../paths.js';
import { redactSecrets } from './redact.js';
import { logger } from './log.js';
import Database from 'better-sqlite3';

/**
 * Rule check kinds (deterministic only — semantic rules have check:null).
 */
export type RuleCheck =
  | { kind: 'forbidden_phrase'; phrase: string }
  | { kind: 'must_include'; phrase: string }
  | { kind: 'max_length'; max: number };

/**
 * Feedback rule row (yaml + TS type).
 */
export interface FeedbackRule {
  id: string;
  key: string;
  text: string;
  scope: string;                      // 'global' | `topic:${number}` | `skill:${string}`
  status: 'active' | 'pending';
  check: RuleCheck | null;
  origin: {
    thread_id: number | null;
    message_id: string | null;
    refId: string | null;
    ts: string;
    decision_ids: string[];          // filled for reaction-compiled rules (C8); [] for turn-sourced
  };
  created_at: string;
  superseded_by: string | null;
}

/**
 * Loosen-pattern rejection list (C9 — matched as lowercase substrings).
 */
const LOOSEN_PATTERNS = [
  'ignore', "don't ask", 'skip', 'you may always', 'no need to'
];

/**
 * File paths.
 */
export function rulesFilePath(): string {
  return join(paHome(), 'feedback-rules.yaml');
}

export function auditFilePath(): string {
  return join(paHome(), 'feedback-rules-audit.jsonl');
}

export function violationsFilePath(): string {
  return join(paHome(), 'rules-violations.jsonl');
}

/**
 * Load all rules from yaml. Returns [] on missing/corrupt file (never throws).
 * Unknown version ⇒ warn + treat as empty, never migrate.
 */
export function loadRules(): FeedbackRule[] {
  const path = rulesFilePath();
  if (!existsSync(path)) {
    return [];
  }

  try {
    const content = readFileSync(path, 'utf8');
    const parsed = parse(content) as any;

    if (!parsed || typeof parsed !== 'object' || !('version' in parsed)) {
      logger.warn('feedback-rules', 'invalid yaml structure (no version field)', { path });
      return [];
    }

    if (parsed.version !== 1) {
      logger.warn('feedback-rules', 'unknown version — treating as empty', { version: parsed.version });
      return [];
    }

    if (!Array.isArray(parsed.rules)) {
      logger.warn('feedback-rules', 'invalid rules field (not an array)', { path });
      return [];
    }

    return parsed.rules as FeedbackRule[];
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to load rules file', { path, error: err.message });
    return [];
  }
}

/**
 * Get active rules for a scope. Filters by status==='active', superseded_by===null,
 * and (scope==='global' || scope===`topic:${threadId}`). Returns created_at DESC.
 */
export function activeRulesFor(scope: { threadId?: number }): FeedbackRule[] {
  const all = loadRules();
  const active = all.filter(r =>
    r.status === 'active' &&
    r.superseded_by === null &&
    (r.scope === 'global' || (scope.threadId !== undefined && r.scope === `topic:${scope.threadId}`))
  );
  // Sort created_at DESC (recency-first)
  return active.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Compute SHA256 hash of the rules array for audit trail.
 */
function hashRules(rules: FeedbackRule[]): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

/**
 * Internal locking helper — takes proper-lockfile, read-modify-writes yaml atomically,
 * then appends audit line.
 */
async function withLockedWrite<T>(
  fn: (rules: FeedbackRule[]) => { ok: boolean; error?: string; result?: T }
): Promise<{ ok: boolean; error?: string; result?: T }> {
  const path = rulesFilePath();

  // Ensure the file exists (empty) for proper-lockfile to lock on
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, '', { flag: 'wx' });
    }
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to ensure rules file exists', { path, error: err.message });
    return { ok: false, error: `failed to ensure file: ${err.message}` };
  }

  const release = await lockfile.lock(path, { retries: 3 }).catch((err: any) => {
    logger.warn('feedback-rules', 'failed to acquire lock', { path, error: err.message });
    return null;
  });

  if (!release) {
    return { ok: false, error: 'failed to acquire lock' };
  }

  try {
    const rules = loadRules();
    const beforeHash = hashRules(rules);
    const outcome = fn(rules);
    if (!outcome.ok) {
      return outcome;
    }

    // Write to temp file then atomic rename
    const tempPath = `${path}.tmp`;
    const yamlContent = stringify({ version: 1, rules });
    writeFileSync(tempPath, yamlContent, 'utf8');
    renameSync(tempPath, path);

    const afterHash = hashRules(rules);
    return outcome;
  } catch (err: any) {
    logger.warn('feedback-rules', 'write failed', { path, error: err.message });
    return { ok: false, error: `write failed: ${err.message}` };
  } finally {
    await release();
  }
}

/**
 * Append audit line (never throws — failures log only).
 */
function appendAudit(action: string, ruleId: string, key: string, beforeSha256: string, afterSha256: string, actor: 'analyzer' | 'operator', reason?: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    actor,
    action,
    rule_id: ruleId,
    key,
    reason: reason || undefined,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
  }) + '\n';

  try {
    // Ensure directory exists before appending
    const path = auditFilePath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, 'utf8');
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to append audit line', { error: err.message });
  }
}

/**
 * Validation rules (§2.2). Returns {ok:true} or {ok:false,error:string}.
 */
function validateRule(input: Omit<FeedbackRule, 'id' | 'created_at' | 'superseded_by' | 'status'> & { status?: 'active' | 'pending' }): { ok: boolean; error?: string } {
  // text: trimmed length 1..140
  const text = input.text.trim();
  if (text.length < 1 || text.length > 140) {
    return { ok: false, error: 'text must be 1-140 chars' };
  }

  // loosen-pattern rejection (C9)
  const lowerText = text.toLowerCase();
  for (const pattern of LOOSEN_PATTERNS) {
    if (lowerText.includes(pattern)) {
      return { ok: false, error: `text contains loosen-pattern "${pattern}"` };
    }
  }

  // key: /^[a-z0-9]+(-[a-z0-9]+)*$/, ≤ 60 chars
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.key) || input.key.length > 60) {
    return { ok: false, error: 'key must be kebab-case, ≤60 chars' };
  }

  // scope validation
  if (input.scope !== 'global') {
    const topicMatch = input.scope.match(/^topic:(\d+)$/);
    const skillMatch = input.scope.match(/^skill:([A-Za-z0-9_-]+)$/);
    if (!topicMatch && !skillMatch) {
      return { ok: false, error: 'scope must be global, topic:<digits>, or skill:<name>' };
    }
  }

  // check validation
  if (input.check !== null && input.check !== undefined) {
    const kind = input.check.kind;
    if (kind === 'forbidden_phrase' || kind === 'must_include') {
      if (typeof input.check.phrase !== 'string' || input.check.phrase.length < 3 || input.check.phrase.length > 100) {
        return { ok: false, error: `${input.check.kind} phrase must be 3-100 chars` };
      }
    } else if (kind === 'max_length') {
      if (typeof input.check.max !== 'number' || input.check.max < 50 || input.check.max > 4000) {
        return { ok: false, error: 'max_length max must be 50-4000' };
      }
    } else {
      return { ok: false, error: `unknown check kind: ${kind}` };
    }
  }

  // origin.decision_ids validation
  if (input.origin.decision_ids && input.origin.decision_ids.length > 0) {
    if (input.origin.decision_ids.length > 10) {
      return { ok: false, error: 'decision_ids must have ≤10 entries' };
    }
    for (const id of input.origin.decision_ids) {
      if (!/^d-\d{12}-[0-9a-f]{12}$/.test(id)) {
        return { ok: false, error: `invalid decision_id format: ${id}` };
      }
    }
  }

  return { ok: true };
}

/**
 * Add a rule. Validates, redacts, supersedes-by-key, appends audit.
 * Returns {ok:true,rule} or {ok:false,error}.
 */
export async function addRule(
  input: Omit<FeedbackRule, 'id' | 'created_at' | 'superseded_by' | 'status'> & { status?: 'active' | 'pending' }
): Promise<{ ok: boolean; rule?: FeedbackRule; error?: string }> {
  // Validate (outside lock - cheap, no I/O)
  const validation = validateRule(input);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  // Redact text and check.phrase (outside lock - pure function)
  const redactedText = redactSecrets(input.text) as string;
  const redactedCheck = input.check
    ? (input.check.kind === 'forbidden_phrase' || input.check.kind === 'must_include'
        ? { kind: input.check.kind, phrase: redactSecrets(input.check.phrase) as string }
        : input.check)
    : null;

  const path = rulesFilePath();

  // Ensure the file exists
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, '', { flag: 'wx' });
    }
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to ensure rules file exists', { path, error: err.message });
    return { ok: false, error: `failed to ensure file: ${err.message}` };
  }

  const release = await lockfile.lock(path, { retries: 3 }).catch((err: any) => {
    logger.warn('feedback-rules', 'failed to acquire lock', { path, error: err.message });
    return null;
  });

  if (!release) {
    return { ok: false, error: 'failed to acquire lock' };
  }

  try {
    // Load rules INSIDE the lock to get fresh data
    const rules = loadRules();
    const beforeHash = hashRules(rules);

    // Supersede-by-key: any existing non-superseded row with the same key
    const existing = rules.find((r: FeedbackRule) => r.key === input.key && r.superseded_by === null);
    if (existing) {
      existing.superseded_by = 'pending-new-id'; // Will be replaced with new id below
    }

    // Mint new id and created_at
    const id = `r-${require('crypto').randomBytes(6).toString('hex')}`;
    const created_at = new Date().toISOString();

    const newRule: FeedbackRule = {
      id,
      key: input.key,
      text: redactedText,
      scope: input.scope,
      status: input.status || 'pending',
      check: redactedCheck,
      origin: {
        ...input.origin,
        decision_ids: input.origin.decision_ids || [],
      },
      created_at,
      superseded_by: null,
    };

    // Update the superseded_by of the old rule to point to the new id
    if (existing) {
      existing.superseded_by = id;
    }

    rules.push(newRule);

    // Atomic write
    const afterHash = hashRules(rules);
    const tempPath = path + '.tmp';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, stringify({ version: 1, rules }), 'utf8');
    renameSync(tempPath, path);

    // Append audit
    appendAudit('add', id, input.key, beforeHash, afterHash, 'analyzer');

    return { ok: true, rule: newRule };
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to write new rule', { error: err.message });
    return { ok: false, error: `write failed: ${err.message}` };
  } finally {
    await release();
  }
}

/**
 * Supersede a rule by operator. Sets superseded_by:'operator'.
 */
export async function supersedeRule(id: string, actor: 'analyzer' | 'operator', reason: string): Promise<{ ok: boolean; error?: string }> {
  const path = rulesFilePath();

  // Ensure the file exists
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, '', { flag: 'wx' });
    }
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to ensure rules file exists', { path, error: err.message });
    return { ok: false, error: `failed to ensure file: ${err.message}` };
  }

  const release = await lockfile.lock(path, { retries: 3 }).catch((err: any) => {
    logger.warn('feedback-rules', 'failed to acquire lock', { path, error: err.message });
    return null;
  });

  if (!release) {
    return { ok: false, error: 'failed to acquire lock' };
  }

  try {
    const rules = loadRules();
    const beforeHash = hashRules(rules);

    const rule = rules.find((r: FeedbackRule) => r.id === id);
    if (!rule) {
      return { ok: false, error: 'rule not found' };
    }

    if (rule.superseded_by !== null) {
      return { ok: false, error: 'rule already superseded' };
    }

    rule.superseded_by = 'operator';

    const afterHash = hashRules(rules);
    const tempPath = path + '.tmp';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, stringify({ version: 1, rules }), 'utf8');
    renameSync(tempPath, path);

    appendAudit('supersede', id, rule.key, beforeHash, afterHash, actor, reason);

    return { ok: true };
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to supersede rule', { error: err.message });
    return { ok: false, error: `write failed: ${err.message}` };
  } finally {
    await release();
  }
}

/**
 * Accept a pending rule (pending → active).
 */
export async function acceptRule(id: string, reason?: string): Promise<{ ok: boolean; error?: string }> {
  const path = rulesFilePath();

  // Ensure the file exists
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, '', { flag: 'wx' });
    }
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to ensure rules file exists', { path, error: err.message });
    return { ok: false, error: `failed to ensure file: ${err.message}` };
  }

  const release = await lockfile.lock(path, { retries: 3 }).catch((err: any) => {
    logger.warn('feedback-rules', 'failed to acquire lock', { path, error: err.message });
    return null;
  });

  if (!release) {
    return { ok: false, error: 'failed to acquire lock' };
  }

  try {
    const rules = loadRules();
    const beforeHash = hashRules(rules);

    const rule = rules.find((r: FeedbackRule) => r.id === id);
    if (!rule) {
      return { ok: false, error: 'rule not found' };
    }

    if (rule.status !== 'pending') {
      return { ok: false, error: 'rule is not pending' };
    }

    if (rule.superseded_by !== null) {
      return { ok: false, error: 'rule already superseded' };
    }

    rule.status = 'active';

    const afterHash = hashRules(rules);
    const tempPath = path + '.tmp';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tempPath, stringify({ version: 1, rules }), 'utf8');
    renameSync(tempPath, path);

    appendAudit('accept', id, rule.key, beforeHash, afterHash, 'operator', reason);

    return { ok: true };
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to accept rule', { error: err.message });
    return { ok: false, error: `write failed: ${err.message}` };
  } finally {
    await release();
  }
}

/**
 * Deterministic check evaluator (O(regex), no allocation beyond lowercase copy).
 */
export function evaluateCheck(rule: FeedbackRule, text: string): { violated: boolean; detail?: string } {
  if (rule.check === null) {
    return { violated: false };
  }

  const lowerText = text.toLowerCase();

  switch (rule.check.kind) {
    case 'forbidden_phrase':
      const violatedFP = lowerText.includes(rule.check.phrase.toLowerCase());
      return violatedFP
        ? { violated: true, detail: `contains forbidden phrase: ${rule.check.phrase}` }
        : { violated: false };

    case 'must_include':
      const violatedMI = !lowerText.includes(rule.check.phrase.toLowerCase());
      return violatedMI
        ? { violated: true, detail: `missing required phrase: ${rule.check.phrase}` }
        : { violated: false };

    case 'max_length':
      const violatedML = text.length > rule.check.max;
      return violatedML
        ? { violated: true, detail: `exceeds max length ${rule.check.max}` }
        : { violated: false };

    default:
      // Unknown kind — treat as non-violating (defensive)
      return { violated: false };
  }
}

/**
 * Reaction compiler from decisions.sqlite 👎 rows.
 * Returns array of {rationale_key, rows} candidates (≥2 👎 per skill/source).
 * Absent/corrupt db ⇒ [] (never throws).
 */
export function compileReactionCandidates(dbPath: string, sinceIso: string): Array<{
  rationale_key: string;
  rows: Array<{
    decision_id: string;
    skill: string | null;
    source: string;
    decision: string;
    rationale: string;
    thread_id: number | null;
    ts: string;
  }>;
}> {
  if (!existsSync(dbPath)) {
    return [];
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');

    const stmt = db.prepare(`
      SELECT decision_id, skill, source, decision, rationale, thread_id, ts
      FROM decisions
      WHERE reaction = '👎' AND ts >= ?
      ORDER BY ts DESC
    `);

    const rows: Array<{
      decision_id: string;
      skill: string | null;
      source: string;
      decision: string;
      rationale: string;
      thread_id: number | null;
      ts: string;
    }> = stmt.all(sinceIso) as any[];

    // Group by `${skill ?? source}` rationale key
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.skill ?? row.source;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(row);
    }

    // Filter to groups with ≥2 rows, cap at 5 newest per candidate
    const candidates: Array<{ rationale_key: string; rows: typeof rows }> = [];
    for (const [key, groupRows] of groups.entries()) {
      if (groupRows.length >= 2) {
        candidates.push({
          rationale_key: key,
          rows: groupRows.slice(0, 5), // Cap at 5 newest
        });
      }
    }

    return candidates;
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to compile reaction candidates', { dbPath, error: err.message });
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Append a triage-skip audit line (for WP-B's CORRECTION/NIT rows).
 * Never throws — failures log only.
 */
export function auditTriageSkip(entry: {
  classification: string;
  note?: string;
  reason?: string;
  evidence_message_ids: string[];
}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    actor: 'analyzer' as const,
    action: 'triage-skip' as const,
    rule_id: '',
    key: '',
    reason: entry.note || entry.reason || entry.classification,
    before_sha256: '',
    after_sha256: '',
  }) + '\n';

  try {
    appendFileSync(auditFilePath(), line, 'utf8');
  } catch (err: any) {
    logger.warn('feedback-rules', 'failed to append triage-skip audit', { error: err.message });
  }
}
