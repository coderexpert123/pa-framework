/**
 * Alert census (2026-08-23, the alerts-wave spec).
 *
 * Deterministic, LLM-free census of what the notify substrate actually SENT (and suppressed)
 * over the last N days, joined with the current health of whatever each alert family points
 * at (skill latest.json / maintenance ledger). Two consumers:
 *   - the `alert-census` maintenance job (daily): writes ~/.pa/alert-census.json, feeds the
 *     weekly-ops-digest, posts a one-line census to pa-alerts only when volume is high;
 *   - the self-improver (nightly): census → deterministic code-fix proposals for
 *     'deterministic-defect' families, "operator action needed" + "alert hygiene" report
 *     sections, and the always-printed census headline.
 *
 * Why it exists: in the week 2026-08-16..23 the loop reported "0 proposals — nothing to
 * report" while ~110 alerts/day fired, because its only failure input was skill .meta
 * status:error — maintenance-job failures, staleness/bg-leak/worker-exit alerts, notify
 * volume and exit-0-masked failures were all invisible (the 2026-08-23 alerts-week review §4).
 *
 * Contract file: the TYPES below are the cross-package contract (self-improver + weekly digest
 * read them).
 */

import { existsSync, createReadStream } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { join } from 'path';
import { paHome as defaultPaHome } from '../paths.js';
import { readFixLedger, latestFixByFamily, type FixRecord } from './fix-ledger.js';

export type CensusOwnerKind = 'skill' | 'maintenance-job' | 'worker' | 'system' | 'unknown';

export type CensusClassification =
  | 'deterministic-defect'   // body/lastError carries a traceback / ENOENT / can't open file / TypeError … → code-fix candidate
  | 'human-gated'            // invalid_grant / expired or revoked / valid license / re-authenticate / usage limit → operator action, never a code draft
  | 'repeat-unchanged'       // ≥10 sends with ≤2 distinct body hashes → alert-hygiene candidate (escalate/merge/mute)
  | 'transient'              // ≤2 sends and the owner is healthy now
  | 'informational';         // everything else (reports, one-offs)

export interface CensusOwnerStatus {
  status?: string;               // skill: latest.json latest.status; job: ledger lastOutcome
  consecutiveFailures?: number;
  lastSuccessAt?: string;        // skill: latestSuccess.timestamp; job: ledger lastRunAt
  lastError?: string;            // ≤ 400 chars
}

export interface CensusFamily {
  /** Normalized family key: dedupKey (else subject) with PIDs / topic ids / counts collapsed. */
  family: string;
  subjectSample: string;
  sent: number;
  suppressed: number;
  /** Attempts that were neither sent nor dedup-suppressed (disabled, missing-token, timeout, send-failed …). */
  other: number;
  firstSeen: string;             // ISO
  lastSeen: string;              // ISO
  severity?: 'info' | 'warn' | 'error' | string;
  ownerKind: CensusOwnerKind;
  owner?: string;                // skill / job / worker name
  ownerStatus?: CensusOwnerStatus;
  /** From the telegram module's textPreview of a matching send; ≤ 600 chars, MarkdownV2 escapes removed. */
  bodySample?: string;
  distinctBodies: number;
  classification: CensusClassification;
  // --- Suppression overlay (2026-08-29, the alert-suppression spec).
  // Additive and optional: absent on every pre-overlay census JSON. classification
  // above stays UNTOUCHED — history counts remain honest for consumers that do not
  // read these fields. Field is suppressedBy, NOT suppressed (that name is already
  // the dedup-suppressed attempt count, line 50).
  /** Set when a known-fix / green-signal rule suppressed this family from
   *  operator-facing surfaces ('fix-record' = ledger, 'green-signal' = quiet + owner green). */
  suppressedBy?: 'fix-record' | 'green-signal';
  /** ISO — the latest fix record's fixedAt; present on fix-record suppression AND on regressions. */
  fixedAt?: string;
  /** The latest fix record's note; fix-record suppression only. */
  fixNote?: string;
  /** true when lastSeen > fixedAt — the family RESURFACES marked, never suppressed. */
  regressedAfterFix?: boolean;
}

export interface CensusMaskedFailure {
  skill: string;
  lastRunAt: string;             // the "success" run whose own log carries a warn/error notify attempt
  marker: string;                // the matching log line, ≤ 200 chars
}

export interface AlertCensus {
  generatedAt: string;
  windowDays: number;
  since: string;
  until: string;
  totalSent: number;
  totalSuppressed: number;
  sentPerDay: Record<string, number>;   // YYYY-MM-DD → count
  families: CensusFamily[];             // sorted by sent desc
  maskedFailures: CensusMaskedFailure[];
  /** One line, e.g. "548 alerts / 22 families in 7d — top: restore-drill 180, staleness 111, bg-leak 88". */
  topLine: string;
}

export interface CensusOptions {
  days?: number;                 // default 7
  now?: Date;                    // default new Date()
  paHome?: string;               // default paHome()
}

export const ALERT_CENSUS_FILE = 'alert-census.json';

/** A family with no fix record is green-signal suppressed only after this many
 *  consecutive quiet days (lastSeen <= untilMs − N days) AND a verifiably green
 *  owner (PLAN §3c/§3d). */
export const GREEN_SIGNAL_QUIET_DAYS = 3;

// ---------------------------------------------------------------------------
// Family key normalisation (spec §WP-J1 step 1b)
// ---------------------------------------------------------------------------

/** Normalizes a raw dedupKey/subject pair into a stable family key: collapses
 *  per-run noise (PIDs, descendant counts, topic ids, trailing numeric ids on
 *  a couple of known-shaped subjects, and any bg-leak variant) so repeats of
 *  the same underlying condition count as one family instead of N. */
export function censusFamilyKey(dedupKey: string | undefined, subject: string): string {
  let key = dedupKey ?? subject;
  key = key.replace(/\(pid \d+\)/g, '(pid N)');
  key = key.replace(/\d+ long-running descendant\(s\)/g, 'N long-running descendant(s)');
  key = key.replace(/topic-?-?\d+_\d+/g, 'topic-*');
  key = key.replace(/^((?:skill-fail-topic|worker-exit)-.+)-\d+$/, '$1-*');
  if (key.startsWith('bg-leak')) key = 'bg-leak';
  return key;
}

// ---------------------------------------------------------------------------
// Owner attribution (spec §WP-J1 step 1e)
// ---------------------------------------------------------------------------

/** First-match-wins owner attribution from an alert subject line. */
export function censusOwnerOf(subject: string): { ownerKind: CensusOwnerKind; owner?: string } {
  let m = /^Skill (?:failed|parked after repeated failures|exhausted): (.+)$/.exec(subject);
  if (m) return { ownerKind: 'skill', owner: m[1] };

  m = /^Maintenance job (?:failed|suppressed): (.+)$/.exec(subject);
  if (m) return { ownerKind: 'maintenance-job', owner: m[1] };

  m = /^Worker exited with code \d+: (.+)$/.exec(subject);
  if (m) return { ownerKind: 'worker', owner: m[1] };

  m = /^(.+?): (?:auth|llm) failure$/.exec(subject);
  if (m) return { ownerKind: 'skill', owner: m[1] };

  if (/Stale Skills|Cadence Audit|bg-leak|bg-orphan|public-sync|All workers rate-limited|Alert census/.test(subject)) {
    return { ownerKind: 'system' };
  }

  return { ownerKind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Classification (spec §WP-J1 step 1g) — order is the contract: a
// human-gated family that also happens to repeat must never route to the
// code-fixer, so human-gated is checked first.
// ---------------------------------------------------------------------------

const HUMAN_GATED_RE = /invalid_grant|expired or revoked|valid license|re-?authenticat|usage limit|quota reached|rate.?limit/i;
const DETERMINISTIC_DEFECT_RE = /Traceback|ModuleNotFoundError|can't open file|ENOENT|No such file|TypeError|SyntaxError|AttributeError|KeyError|is not defined/i;

export function classifyFamily(f: Omit<CensusFamily, 'classification'>): CensusClassification {
  const lastError = f.ownerStatus?.lastError;
  const bodySample = f.bodySample;

  if ((lastError !== undefined && HUMAN_GATED_RE.test(lastError)) || (bodySample !== undefined && HUMAN_GATED_RE.test(bodySample))) {
    return 'human-gated';
  }
  if ((lastError !== undefined && DETERMINISTIC_DEFECT_RE.test(lastError)) || (bodySample !== undefined && DETERMINISTIC_DEFECT_RE.test(bodySample))) {
    return 'deterministic-defect';
  }
  if (f.sent >= 10 && f.distinctBodies <= 2) {
    return 'repeat-unchanged';
  }
  if (f.sent <= 2 && (f.ownerStatus?.consecutiveFailures ?? 0) === 0) {
    return 'transient';
  }
  return 'informational';
}

// ---------------------------------------------------------------------------
// Suppression overlay helpers (2026-08-29, the alert-suppression spec)
// ---------------------------------------------------------------------------

/** Owner is green ONLY on verifiable health (PLAN §3d): a skill needs
 *  latest.json status 'success' AND zero consecutive failures; a maintenance
 *  job needs ledger lastOutcome 'ran' AND zero consecutive failures.
 *  worker / system / unknown owners have no verifiable signal — never green;
 *  they age out naturally. */
function ownerIsGreen(f: CensusFamily): boolean {
  if (f.ownerKind === 'skill') {
    return f.ownerStatus?.status === 'success' && (f.ownerStatus?.consecutiveFailures ?? 0) === 0;
  }
  if (f.ownerKind === 'maintenance-job') {
    return f.ownerStatus?.status === 'ran' && (f.ownerStatus?.consecutiveFailures ?? 0) === 0;
  }
  return false;
}

/** PLAN §3 rules a–c, evaluated in order; all comparisons in epoch ms, anchored
 *  at the census's own untilMs. Mutates ONLY the four overlay fields — never
 *  counts, never classification. Rule (e): maskedFailures is computed elsewhere
 *  and is untouched by design.
 *    a. latest fix exists AND lastSeen >  fixedAt  ⇒ regressedAfterFix (resurfaces marked)
 *    b. latest fix exists AND lastSeen <= fixedAt  ⇒ suppressedBy 'fix-record'
 *    c. no usable fix AND lastSeen <= untilMs − GREEN_SIGNAL_QUIET_DAYS days
 *       AND owner green                              ⇒ suppressedBy 'green-signal' */
function applySuppressionOverlay(family: CensusFamily, ctx: { untilMs: number; fixLatest: Map<string, FixRecord> }): void {
  const rec = ctx.fixLatest.get(family.family);
  const fixedAtMs = rec !== undefined ? Date.parse(rec.fixedAt) : NaN;

  if (rec !== undefined && Number.isFinite(fixedAtMs)) {
    const lastSeenMs = Date.parse(family.lastSeen);
    if (lastSeenMs > fixedAtMs) {
      // rule a — a regression is never suppressed, never green-signaled away
      family.regressedAfterFix = true;
      family.fixedAt = rec.fixedAt;
    } else {
      // rule b — inclusive: lastSeen == fixedAt is fixed-and-quiet
      family.suppressedBy = 'fix-record';
      family.fixedAt = rec.fixedAt;
      family.fixNote = rec.note;
    }
    return;
  }

  // rule c — inclusive boundary (decision 3f)
  if (Date.parse(family.lastSeen) <= ctx.untilMs - GREEN_SIGNAL_QUIET_DAYS * DAY_MS && ownerIsGreen(family)) {
    family.suppressedBy = 'green-signal';
  }
}

// ---------------------------------------------------------------------------
// buildAlertCensus internals
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

interface FamilyAcc {
  family: string;
  sent: number;
  suppressed: number;
  other: number;
  firstSeenMs: number;
  lastSeenMs: number;
  severity?: string;
  subjectFromAttempting?: string;
  subjectFromResult?: string;
  bodyHashes: Set<string>;
  bodySample?: string;
}

function newAcc(family: string): FamilyAcc {
  return { family, sent: 0, suppressed: 0, other: 0, firstSeenMs: Infinity, lastSeenMs: -Infinity, bodyHashes: new Set() };
}

function touch(acc: FamilyAcc, tsMs: number): void {
  if (tsMs < acc.firstSeenMs) acc.firstSeenMs = tsMs;
  if (tsMs > acc.lastSeenMs) acc.lastSeenMs = tsMs;
}

/** Stream a file line by line. Never rejects — a missing/unreadable file
 *  (or a mid-read error) just yields whatever lines were seen so far, per the
 *  "never throw" tolerance this module promises for every input. */
async function forEachLine(filePath: string, onLine: (line: string) => void): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    let stream;
    try {
      stream = createReadStream(filePath, { encoding: 'utf8' });
    } catch {
      finish();
      return;
    }
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try { onLine(line); } catch { /* one bad line never aborts the scan */ }
    });
    rl.on('close', finish);
    rl.on('error', finish);
    stream.on('error', finish);
  });
}

function formatDateOnlyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** app.log.jsonl plus every archive/*-app.log.jsonl shard whose filename date
 *  prefix is >= since-1day. Never readFile's a whole shard — callers stream. */
async function selectShards(ph: string, sinceMs: number): Promise<string[]> {
  const shards: string[] = [];
  const liveLog = join(ph, 'app.log.jsonl');
  if (existsSync(liveLog)) shards.push(liveLog);

  const archiveDirPath = join(ph, 'archive');
  let entries: string[] = [];
  try {
    entries = await readdir(archiveDirPath);
  } catch {
    entries = [];
  }

  const cutoff = formatDateOnlyUTC(new Date(sinceMs - DAY_MS));
  for (const entry of entries) {
    if (!entry.endsWith('-app.log.jsonl')) continue;
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(entry);
    if (!m) continue;
    if (m[1] >= cutoff) shards.push(join(archiveDirPath, entry));
  }
  return shards;
}

interface StreamState {
  families: Map<string, FamilyAcc>;
  telegramPreviews: string[];
  totalSent: number;
  totalSuppressed: number;
  sentPerDay: Record<string, number>;
}

function processLine(line: string, sinceMs: number, untilMs: number, state: StreamState): void {
  if (!line) return;
  let row: any;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  if (!row || typeof row !== 'object') return;

  const tsMs = Date.parse(row.timestamp);
  if (!Number.isFinite(tsMs) || tsMs < sinceMs || tsMs > untilMs) return;

  if (row.module === 'notify' && row.message === 'attempting') {
    const family = censusFamilyKey(row.dedupKey, row.subject);
    const acc = state.families.get(family) ?? newAcc(family);
    touch(acc, tsMs);
    if (typeof row.severity === 'string') acc.severity = row.severity;
    if (typeof row.subject === 'string') acc.subjectFromAttempting = row.subject;
    state.families.set(family, acc);
    return;
  }

  if (row.module === 'notify' && row.message === 'result') {
    const family = censusFamilyKey(row.dedupKey, row.subject);
    const acc = state.families.get(family) ?? newAcc(family);
    touch(acc, tsMs);
    if (typeof row.subject === 'string' && acc.subjectFromResult === undefined) acc.subjectFromResult = row.subject;
    if (row.sent === true) {
      acc.sent++;
      state.totalSent++;
      const day = new Date(tsMs).toISOString().slice(0, 10);
      state.sentPerDay[day] = (state.sentPerDay[day] ?? 0) + 1;
    } else if (row.suppressed === true) {
      acc.suppressed++;
      state.totalSuppressed++;
    } else {
      acc.other++;
    }
    state.families.set(family, acc);
    return;
  }

  if (row.module === 'telegram' && row.message === 'skill message sent') {
    if (typeof row.textPreview === 'string') {
      const unescaped = row.textPreview.replace(/\\(.)/g, '$1');
      state.telegramPreviews.push(unescaped.slice(0, 600));
    }
  }
}

/** Attaches each cached telegram body preview to the family whose
 *  subjectSample the (unescaped) preview text starts with — a notifyUser
 *  body conventionally opens with a rendering of its own subject. */
function attachBodies(state: StreamState): void {
  const familyList = Array.from(state.families.values());
  for (const preview of state.telegramPreviews) {
    for (const acc of familyList) {
      const subjectSample = acc.subjectFromAttempting ?? acc.subjectFromResult ?? acc.family;
      if (subjectSample && preview.startsWith(subjectSample)) {
        const hash = createHash('sha1').update(preview).digest('hex').slice(0, 16);
        acc.bodyHashes.add(hash);
        if (acc.bodySample === undefined) acc.bodySample = preview;
        break;
      }
    }
  }
}

async function lookupOwnerStatus(ownerKind: CensusOwnerKind, owner: string | undefined, ph: string): Promise<CensusOwnerStatus | undefined> {
  if (!owner) return undefined;

  if (ownerKind === 'skill') {
    try {
      const raw = await readFile(join(ph, 'logs', owner, 'latest.json'), 'utf8');
      const pointer = JSON.parse(raw);
      const latest = pointer?.latest;
      if (!latest || typeof latest !== 'object') return undefined;
      return {
        status: typeof latest.status === 'string' ? latest.status : undefined,
        consecutiveFailures: typeof pointer.consecutiveFailures === 'number' ? pointer.consecutiveFailures : undefined,
        lastSuccessAt: pointer.latestSuccess?.timestamp,
        lastError: typeof latest.error === 'string' ? latest.error.slice(0, 400) : undefined,
      };
    } catch {
      return undefined;
    }
  }

  if (ownerKind === 'maintenance-job') {
    try {
      const raw = await readFile(join(ph, 'maintenance-state.json'), 'utf8');
      const parsed = JSON.parse(raw);
      const jobState = parsed?.jobs?.[owner];
      if (!jobState || typeof jobState !== 'object') return undefined;
      return {
        status: typeof jobState.lastOutcome === 'string' ? jobState.lastOutcome : undefined,
        consecutiveFailures: typeof jobState.consecutiveFailures === 'number' ? jobState.consecutiveFailures : undefined,
        lastSuccessAt: jobState.lastRunAt,
        lastError: typeof jobState.lastError === 'string' ? jobState.lastError.slice(0, 400) : undefined,
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Mirrors logger.ts's private formatTimestamp exactly (UTC YYYYMMDD-HHMMSS)
 *  — logger.ts does not export it, so this is a deliberate, documented copy
 *  used only to locate the sibling .log file for a given latest.json run. */
function formatLoggerTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

// INVARIANT this detector leans on (wave verifier, 2026-08-23): a warn/error notify
// attempt inside a skill's own run log means a FAILURE path — notifyUser's severity
// defaults to 'warn', so a skill that called `pa notify` on a SUCCESS path without an
// explicit `severity: 'info'` would be misreported here as a masked failure. Every
// current Python caller (fetch_headers._fetch_failed, run_brief._notify_failure/
// fail_llm, send_telegram's hallucination branch) is failure-path-only; keep it so,
// or pass severity 'info' for a success-path notice.
async function findMaskedMarker(logPath: string): Promise<string | undefined> {
  let marker: string | undefined;
  await forEachLine(logPath, (line) => {
    if (marker) return;
    const hasWarnOrError = line.includes('"severity":"warn"') || line.includes('"severity":"error"');
    if (line.includes('Alert suppressed') || (line.includes('[notify] attempting') && hasWarnOrError)) {
      marker = line.slice(0, 200);
    }
  });
  return marker;
}

/** The daily-mail-brief class of failure: exit 0 (latest.status === 'success')
 *  after the run's own log shows it tried to raise a warn/error alert, or
 *  logged "Alert suppressed" — an outage hidden behind a green status. */
async function computeMaskedFailures(ph: string): Promise<CensusMaskedFailure[]> {
  const logsDirPath = join(ph, 'logs');
  let skillDirs: string[] = [];
  try {
    const entries = await readdir(logsDirPath, { withFileTypes: true });
    skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const results: CensusMaskedFailure[] = [];
  for (const skill of skillDirs) {
    try {
      const raw = await readFile(join(logsDirPath, skill, 'latest.json'), 'utf8');
      const pointer = JSON.parse(raw);
      const latest = pointer?.latest;
      if (!latest || latest.status !== 'success' || typeof latest.timestamp !== 'string') continue;

      const tsMs = Date.parse(latest.timestamp);
      if (!Number.isFinite(tsMs)) continue;
      const prefix = formatLoggerTimestamp(new Date(tsMs));

      const skillDirEntries = await readdir(join(logsDirPath, skill));
      const logFile = skillDirEntries.find((f) => f.startsWith(prefix) && f.endsWith('.log'));
      if (!logFile) continue; // missing log file → skip

      const marker = await findMaskedMarker(join(logsDirPath, skill, logFile));
      if (marker) {
        results.push({ skill, lastRunAt: latest.timestamp, marker });
      }
    } catch {
      continue;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// buildAlertCensus
// ---------------------------------------------------------------------------

export async function buildAlertCensus(opts: CensusOptions = {}): Promise<AlertCensus> {
  const days = opts.days ?? 7;
  const now = opts.now ?? new Date();
  const ph = opts.paHome ?? defaultPaHome();

  const untilMs = now.getTime();
  const sinceMs = untilMs - days * DAY_MS;

  const shardPaths = await selectShards(ph, sinceMs);

  const state: StreamState = {
    families: new Map(),
    telegramPreviews: [],
    totalSent: 0,
    totalSuppressed: 0,
    sentPerDay: {},
  };

  for (const shardPath of shardPaths) {
    await forEachLine(shardPath, (line) => processLine(line, sinceMs, untilMs, state));
  }

  attachBodies(state);

  // Overlay inputs (2026-08-29): one ledger read per census. readFixLedger never
  // throws (missing/corrupt ⇒ []), preserving this module's no-throw contract.
  const fixLatest = latestFixByFamily(await readFixLedger(ph));

  const families: CensusFamily[] = [];
  for (const acc of state.families.values()) {
    const subjectSample = acc.subjectFromAttempting ?? acc.subjectFromResult ?? acc.family;
    const { ownerKind, owner } = censusOwnerOf(subjectSample);
    const ownerStatus = await lookupOwnerStatus(ownerKind, owner, ph);

    const partial: Omit<CensusFamily, 'classification'> = {
      family: acc.family,
      subjectSample,
      sent: acc.sent,
      suppressed: acc.suppressed,
      other: acc.other,
      firstSeen: new Date(acc.firstSeenMs === Infinity ? untilMs : acc.firstSeenMs).toISOString(),
      lastSeen: new Date(acc.lastSeenMs === -Infinity ? untilMs : acc.lastSeenMs).toISOString(),
      severity: acc.severity,
      ownerKind,
      owner,
      ownerStatus,
      bodySample: acc.bodySample,
      distinctBodies: acc.bodyHashes.size,
    };
    const family: CensusFamily = { ...partial, classification: classifyFamily(partial) };
    applySuppressionOverlay(family, { untilMs, fixLatest });
    families.push(family);
  }

  families.sort((a, b) => b.sent - a.sent);

  const maskedFailures = await computeMaskedFailures(ph);

  const totalSent = state.totalSent;
  const topEntries = families.slice(0, 3).map((f) => `${f.family} ${f.sent}`).join(', ');
  const topLine = families.length > 0
    ? `${totalSent} alerts / ${families.length} families in ${days}d — top: ${topEntries}`
    : `${totalSent} alerts / ${families.length} families in ${days}d`;

  return {
    generatedAt: new Date().toISOString(),
    windowDays: days,
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    totalSent,
    totalSuppressed: state.totalSuppressed,
    sentPerDay: state.sentPerDay,
    families,
    maskedFailures,
    topLine,
  };
}
