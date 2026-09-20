/**
 * Orphan attribution (AI-214 v2 §1.8, 2026-09-08) — who owns a dirty path and
 * are they still working?
 *
 * C1: there is no path→session registry in pa. The pinned liveness source is
 * the owner's Claude Code TRANSCRIPT file mtime within LIVE_ACTIVITY_MS — a
 * live session appends to its transcript on every turn, so file mtime is a
 * claim-independent activity signal. Reservations are NOT a liveness source;
 * an ACTIVE reservation is its own 'reserved' verdict (a live claim is a live
 * claim).
 *
 * The PURE core (`attributePath`) decides over pre-fetched data; the I/O
 * wrapper (`scanTranscriptsForPaths`) scans Claude transcripts under
 * `~/.claude/projects/<derived>` (PA_CLAUDE_PROJECTS_DIR env override for
 * portability/tests), time-boxed — a shortfall reads as unattributed, the
 * fail-safe direction: no false auto-dispatch. CommonJS module —
 * __filename, never the ESM meta-url form.
 */
import { createReadStream } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import { pathsOverlap } from './reservations.js';
import { log } from './log.js';

/** transcript-mtime liveness window (C1). */
export const LIVE_ACTIVITY_MS = 15 * 60 * 1000;
/** Only transcripts with mtime within this window are scanned at all. */
export const TRANSCRIPT_SCAN_DAYS = 7;
/** Whole-scan time box (D: is a 5400rpm HDD — machine notes § Disk). */
export const TRANSCRIPT_SCAN_BUDGET_MS = 5000;

export interface TranscriptHit {
  file: string;
  fileMtimeMs: number;
  newestMatchTs: number;
}

export interface AttributionInput {
  path: string;
  pathMtimeMs: number;
  now: number;
  activeReservations: Array<{ paths: string[]; session: string }>;
  /** Pre-scanned by the wrapper — attributePath itself does no I/O. */
  transcriptHits: TranscriptHit[];
}

export type Attribution =
  | { status: 'reserved'; session: string }
  | { status: 'owned'; ownerFile: string; alive: boolean; lastActivityMs: number }
  | { status: 'unattributed' };

/**
 * Pure. Priority (the operator's directive): reservation overlap →
 * 'reserved'; else the newest transcript hit (max newestMatchTs) → 'owned'
 * with alive = now - fileMtimeMs <= LIVE_ACTIVITY_MS; else 'unattributed'.
 */
export function attributePath(input: AttributionInput): Attribution {
  const covering = input.activeReservations.find((r) =>
    r.paths.some((rp) => pathsOverlap(input.path, rp)),
  );
  if (covering) {
    return { status: 'reserved', session: covering.session };
  }

  let newest: TranscriptHit | null = null;
  for (const hit of input.transcriptHits) {
    if (!newest || hit.newestMatchTs > newest.newestMatchTs) newest = hit;
  }
  if (newest) {
    return {
      status: 'owned',
      ownerFile: newest.file,
      alive: input.now - newest.fileMtimeMs <= LIVE_ACTIVITY_MS,
      lastActivityMs: newest.newestMatchTs,
    };
  }
  return { status: 'unattributed' };
}

// ---- I/O wrapper ----

export interface ScanTranscriptsResult {
  /** Per scanned path: the matching transcript hits found. */
  hitsByPath: Map<string, TranscriptHit[]>;
  /** True when the time box ran out before every candidate file was read —
   *  the shortfall belongs to paths with no hits (unattributed). */
  budgetExhausted: boolean;
  scannedFiles: number;
}

export interface ScanTranscriptsDeps {
  now?: number;
  /** Overrides the whole projects root (tests); default honors
   *  PA_CLAUDE_PROJECTS_DIR, else ~/.claude/projects. */
  projectsDirFn?: () => string;
  /** Lines of one transcript file, in order. Default streams via readline —
   *  transcripts are MBs, never read whole into memory. */
  lineReaderFn?: (file: string) => AsyncIterable<string>;
  budgetMs?: number;
}

function defaultProjectsDir(): string {
  const override = process.env.PA_CLAUDE_PROJECTS_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), '.claude', 'projects');
}

/** `D:\Personal Assistant` → `D--Personal-Assistant` — every non-alphanumeric
 *  char replaced by `-` (Claude Code's own project-dir derivation, verified
 *  live against this machine's real transcript dirs). */
export function deriveTranscriptDirName(repoRoot: string): string {
  return repoRoot.replace(/[^A-Za-z0-9]/g, '-');
}

function defaultLineReader(file: string): AsyncIterable<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  return rl;
}

/** The needle set one dirty path can appear as inside a transcript line:
 *  repo-relative and absolute, both slash directions, PLUS the JSON-escaped
 *  backslash forms (transcript lines are JSON — real Windows paths appear
 *  with doubled backslashes there). */
function needlesFor(repoRoot: string, p: string): string[] {
  const fwd = p.replace(/\\/g, '/');
  const back = p.replace(/\//g, '\\');
  const rootFwd = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const rootBack = repoRoot.replace(/\//g, '\\').replace(/\\$/, '');
  const raw = [
    fwd,
    back,
    `${rootFwd}/${fwd}`,
    `${rootBack}${rootBack.endsWith('\\') ? '' : '\\'}${back}`,
  ];
  return [...raw, ...raw.map((n) => n.replace(/\\/g, '\\\\'))];
}

/**
 * Scan the repo's transcript directory for recent files naming any of
 * `paths`. Serialized reads, line-streamed; a matching line is the only line
 * that gets JSON-parsed (its `timestamp` feeds newestMatchTs; missing/invalid
 * ts falls back to the file mtime). Time-boxed: on exhaustion, return what
 * was found — callers must treat the shortfall as unattributed.
 */
export async function scanTranscriptsForPaths(
  repoRoot: string,
  paths: string[],
  deps: ScanTranscriptsDeps = {},
): Promise<ScanTranscriptsResult> {
  const now = deps.now ?? Date.now();
  const projectsDir = deps.projectsDirFn ? deps.projectsDirFn() : defaultProjectsDir();
  const lineReader = deps.lineReaderFn ?? defaultLineReader;
  const budgetMs = deps.budgetMs ?? TRANSCRIPT_SCAN_BUDGET_MS;
  const dir = join(projectsDir, deriveTranscriptDirName(repoRoot));
  const result: ScanTranscriptsResult = { hitsByPath: new Map(), budgetExhausted: false, scannedFiles: 0 };
  if (paths.length === 0) return result;

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return result; // no transcript dir for this repo — nothing is attributed from transcripts
  }

  // Scan-window filter needs mtimes — stat first, serialized (D: HDD rule).
  const recent: Array<{ file: string; mtimeMs: number }> = [];
  for (const f of files) {
    const full = join(dir, f);
    try {
      const s = await stat(full);
      if (now - s.mtimeMs <= TRANSCRIPT_SCAN_DAYS * 24 * 60 * 60 * 1000) {
        recent.push({ file: full, mtimeMs: s.mtimeMs });
      }
    } catch {
      // vanished mid-scan — skip
    }
  }

  const started = Date.now();
  const needleLists = paths.map((p) => ({ path: p, needles: needlesFor(repoRoot, p) }));

  for (const { file, mtimeMs } of recent) {
    if (Date.now() - started >= budgetMs) {
      result.budgetExhausted = true;
      break;
    }
    result.scannedFiles++;
    try {
      for await (const line of lineReader(file)) {
        if (!line) continue;
        for (const { path, needles } of needleLists) {
          if (!needles.some((n) => n.length > 0 && line.includes(n))) continue;
          let ts = mtimeMs;
          try {
            const parsed = JSON.parse(line) as { timestamp?: unknown };
            const t = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
            if (Number.isFinite(t)) ts = t;
          } catch {
            // non-JSON matching line — file-mtime fallback stands
          }
          const hits = result.hitsByPath.get(path) ?? [];
          const existing = hits.find((h) => h.file === file);
          if (existing) {
            existing.newestMatchTs = Math.max(existing.newestMatchTs, ts);
          } else {
            hits.push({ file, fileMtimeMs: mtimeMs, newestMatchTs: ts });
          }
          result.hitsByPath.set(path, hits);
        }
      }
    } catch (err) {
      log('warn', 'orphan-attribution', 'transcript read failed mid-scan; continuing', {
        file,
        error: String(err),
      });
    }
  }
  return result;
}
