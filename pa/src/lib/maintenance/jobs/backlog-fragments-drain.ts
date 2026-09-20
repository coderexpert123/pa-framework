/**
 * backlog-fragments-drain — `backlog/open-*.md`'s SOLE writer, plus the
 * AUTO:BACKLOG-SECTIONS table region of the BACKLOG.md router ONLY
 * (2026-09-12, plans/2026-09-12-brain-file-lock-contention-SPEC.md D4;
 * per-section layout 2026-09-18, plans/2026-09-18-backlog-router-split-SPEC.md
 * §4). The router's preamble, normative Standard and archived-pointer regions
 * are human-maintained and never drain-touched.
 *
 * Threads no longer hand-edit the backlog (BACKLOG.md was claimed ~10x/day and
 * filing routinely stalled behind an unrelated reservation): they file a
 * PRIVATE, uniquely-named JSON fragment under gitignored `backlog/fragments/`
 * via `pa backlog add`. This job — every 3 minutes — discovers the layout
 * (`backlog/open-*.md` section files + the BACKLOG.md router), deterministically
 * merges pending fragments into the routed section file, assigns sequential
 * AI-nnn ids from a max-scan (so two filers can never race on an id), commits
 * via the same gitRunner pattern brain-sweep uses, and quarantines + alerts
 * anything it cannot parse (never silent-drop, never clobber, never block the
 * batch).
 *
 * Safety properties, in execution order:
 *  1. Idle pass = one readdir: no fragments ⇒ no lock, no git, no commit.
 *  2. The `git-workflow` exclusive lock (the same one the commit/push skill
 *     family serializes on) is acquired with waitMs 0 — busy ⇒ a NORMAL SKIP
 *     (never a throw: a throw would trip the runner's backoff ladder and page
 *     for a benign condition; retry is the next cadence). This single lock
 *     closes drain-vs-commit/push, drain-vs-update-brain-skill, and (with the
 *     caller-level pass locks) drain-vs-drain. The drain holds no other lock
 *     and waits for nothing ⇒ no deadlock is expressible.
 *  3. LAYOUT GATE (2026-09-18): discoverLayout + validateLayout BEFORE dirty
 *     classification — the layout DEFINES the write surface the dirty check
 *     covers. A `## ` in the router's open region ⇒ 'pre-router-backlog'
 *     (also the pre-migration guard — the window between code-land and
 *     migrate pauses inflow safely); any other invariant break ⇒
 *     'backlog-layout-invalid'. Both skip + warn and PRESERVE fragments —
 *     inflow is never quarantined for a layout problem it did not cause.
 *  4. A write-surface file dirtied within RECENT_MS (brain-sweep's 15-minute
 *     recently-edited window) DEFERS the pass — a legacy editor may be
 *     mid-flight; never clobber. BACKLOG.md's dirty check is DEFERRED to
 *     post-compute and evaluated only when a table regen is actually pending
 *     (a created section + its router row are one logical write — no
 *     half-applies). An OLDER dirty file is merged ON TOP of (never
 *     reverted) with a warn notify (dedupKey 'backlog-drain:stale-dirty')
 *     and a commit-message suffix naming the bundled pre-existing
 *     working-tree edits (attribution honesty; R-2).
 *  5. A mtime change on ANY write-set file (or the archive file) between
 *     baseline and write restarts the pass ONCE — the restart re-discovers
 *     the layout so a mid-pass human edit is merged, never clobbered; a
 *     second change ⇒ skip 'backlog-changed-mid-pass' + warn notify.
 *  6. Fragment markers (`<!-- frag:<stem> -->`, scoped to the ROUTED file)
 *     make a crash between commit and fragment deletion self-healing: the
 *     re-run skips the stem as alreadyMerged and just deletes the stale
 *     file — no duplicate entry, no empty-commit throw.
 *  7. `add` routes by section slug (`file.slug === fragment.section` — the
 *     fragment schema already constrains the field to `[a-z][a-z-]{0,30}`).
 *     A schema-valid section with no file AUTO-CREATES
 *     `backlog/open-<slug>.md` (heading `## <slug>` verbatim — round-trip
 *     identity) + a router row + a deduped warn: a typo becomes a visible
 *     stray, never silent. `status` routes by scanning every file's parsed
 *     ids: 0 hits ⇒ 'unknown target', >1 ⇒ 'ambiguous target' (pre-split
 *     semantics preserved).
 *  8. Auto-archive (2026-09-13; per-file 2026-09-18): after a successful
 *     merge compute, per-file archive plans fire when DONE-class items
 *     (status line `Type / Pri / DONE|BUILT|FIXED|COMPLETE`…, anchored —
 *     see lib/backlog-archive.ts) cross 10 in total or any merged section
 *     file's PRE-archive content reaches docs-lint's
 *     BACKLOG_SECTION_BUDGET; the same write+commit window moves the
 *     UNION of moved items into backlog/completed-<IST-date>.md under ONE
 *     archive section (append-only, verbatim blocks; a first-of-day
 *     archive commit creates that file, which the docs trim counter's
 *     split exemption reads as the outflow it is, not a trim). The manual
 *     `pa backlog archive` is the operator's threshold-free sweep.
 *  9. Router table regen: every writing pass splices renderSectionTable
 *     between the router's AUTO markers; a byte-compare means an identical
 *     table costs nothing, and absent/duplicated markers ⇒ a warn log +
 *     detail 'skipped-no-markers' — a cosmetic region never stalls a pass.
 *
 * CommonJS module — __filename, never the ESM meta-url form.
 */
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { exclusiveLockKey } from '../../../commands/run.js';
import { blackboard } from '../../../blackboard.js';
import { RECENT_MS } from '../../brain-sweep.js';
import { repoRootFromModule } from '../../git-root.js';
import { snapshotTree, type TreeSnapshot } from '../../worker-edit-audit.js';
import { defaultGitRunner, type GitRunner } from '../../tree-drift.js';
import { notifyUser } from '../../notify.js';
import { writeFileAtomic } from '../../atomic-write.js';
import {
  deleteFragment,
  fragmentsDir,
  listFragments,
  mergeFragments,
  parseBacklog,
  parseFragment,
  quarantineFragment,
  scanMaxId,
  type MergeFragmentInput,
} from '../../backlog-merge.js';
import {
  discoverLayout,
  fileForSection,
  fileForTargetId,
  renderSectionTable,
  sectionFileRel,
  sectionSkeleton,
  slugifySection,
  spliceSectionTable,
  validateLayout,
  type LayoutProblem,
  type SectionFile,
} from '../../backlog-layout.js';
import {
  appendArchiveSection,
  completedArchiveRelPath,
  istDateOf,
  planBacklogArchive,
  shouldAutoArchive,
  type ArchivePlan,
} from '../../backlog-archive.js';
import { log } from '../../log.js';
import type { MaintenanceJob, MaintenanceJobContext, MaintenanceJobResult } from '../types.js';

const MODULE = 'backlog-fragments-drain';
const JOB_EVERY_MS = 180_000; // 3 minutes
/** The lock agent recorded on the git-workflow lock row (D4 step 2). */
const LOCK_AGENT = 'backlog-drain';
const BACKLOG_PATH = 'BACKLOG.md';

/** The day's completed-archive file, read to append (absent ⇒ ''). */
async function readCompletedArchive(repoRoot: string, date: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, completedArchiveRelPath(date)), 'utf8');
  } catch {
    return '';
  }
}

// --- injectable dependencies (brain-sweep Deps pattern) ----------------------

export interface BacklogFragmentsDrainDeps {
  nowFn?: () => number;
  repoRootFn?: () => Promise<string>;
  snapshotFn?: (repoRoot: string) => Promise<TreeSnapshot>;
  gitRunner?: GitRunner;
  acquireLockFn?: (
    resource: string,
    agent: string,
    pid: number,
    timeoutMs: number,
    contextId?: string
  ) => Promise<boolean>;
  releaseLockFn?: (resource: string, agent: string, contextId?: string, opts?: { pid?: number }) => Promise<void>;
  notifyFn?: typeof notifyUser;
  /** Lost-update guard seam: returns a write-surface file's mtimeMs (0 when
   *  absent). Tests inject a shifting value to drive the restart /
   *  midpass-change paths without real filesystem races. */
  statFn?: (absPath: string) => Promise<number>;
}

async function defaultStatMtime(absPath: string): Promise<number> {
  try {
    return (await stat(absPath)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Read the pending fragments' raw JSON text, in stem order (filename order
 *  IS the merge order, D1). A fragment that vanished or cannot be read is
 *  collected as failed-with-'unreadable' rather than thrown — it quarantines
 *  (or is already gone) while the rest of the batch proceeds. */
async function readFragmentInputs(
  repoRoot: string,
  stems: string[]
): Promise<{ inputs: MergeFragmentInput[]; unreadable: { stem: string; error: string }[] }> {
  const dir = fragmentsDir(repoRoot);
  const inputs: MergeFragmentInput[] = [];
  const unreadable: { stem: string; error: string }[] = [];
  for (const stem of stems) {
    try {
      inputs.push({ stem, fragment: await readFile(join(dir, `${stem}.json`), 'utf8') });
    } catch (err) {
      unreadable.push({ stem, error: `unreadable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { inputs, unreadable };
}

/** Every top-level `backlog/*.md` file's content (archives, programs,
 *  not-valid, completed-index, and the open-*.md section files — max() over
 *  a superset is still the max) — scanMaxId's second input. The gitignored
 *  `fragments/` subdir contains no `.md` and is skipped by the filter. */
async function readBacklogDirTexts(repoRoot: string): Promise<string[]> {
  const dir = join(repoRoot, 'backlog');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const texts: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      texts.push(await readFile(join(dir, name), 'utf8'));
    } catch (err) {
      log('warn', MODULE, `failed to read ${`backlog/${name}`}; continuing max-id scan without it`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return texts;
}

/**
 * One drain pass. See the module docstring for the step order (§4 of the
 * 2026-09-18 spec, verbatim). Never throws for a held lock, a recent edit or
 * a broken layout — those are normal skips. Throws only on git failure
 * (runner records `failed`, fragments stay on disk, the next pass retries).
 */
export async function runBacklogFragmentsDrain(
  ctx: MaintenanceJobContext,
  deps: BacklogFragmentsDrainDeps = {}
): Promise<MaintenanceJobResult> {
  const now = (deps.nowFn ?? (() => ctx.now))();
  const repoRoot = await (deps.repoRootFn ?? (() => repoRootFromModule(__filename)))();
  const snapshotFn = deps.snapshotFn ?? snapshotTree;
  const git = deps.gitRunner ?? defaultGitRunner;
  const acquireLockFn =
    deps.acquireLockFn ??
    ((resource: string, agent: string, pid: number, timeoutMs: number, contextId?: string) =>
      blackboard.acquireLock(resource, agent, pid, timeoutMs, contextId));
  const releaseLockFn =
    deps.releaseLockFn ??
    ((resource: string, agent: string, contextId?: string, opts?: { pid?: number }) =>
      blackboard.releaseLock(resource, agent, contextId, opts));
  const notifyFn = deps.notifyFn ?? notifyUser;
  const statFn = deps.statFn ?? defaultStatMtime;

  // Step 1 — idle cost is one readdir. No lock, no git, no commit.
  const frags = await listFragments(repoRoot);
  if (frags.pending.length === 0 && frags.quarantined.length === 0) {
    return { touched: 0, detail: { merged: 0 } };
  }

  // Step 2 — git-workflow, waitMs 0. Busy is a NORMAL SKIP, never a throw.
  const lockKey = exclusiveLockKey('git-workflow');
  const contextId = randomUUID();
  const lockHeld = await acquireLockFn(lockKey, LOCK_AGENT, process.pid, 0, contextId);
  if (!lockHeld) {
    return { touched: 0, detail: { skipped: 'git-workflow-held' } };
  }

  const quarantined: { stem: string; error: string }[] = [];

  // Fire-and-collect the quarantine alert; a failed alert never aborts the
  // pass (brain-sweep's deferral-alert precedent).
  const alertQuarantined = async (): Promise<void> => {
    if (quarantined.length === 0) return;
    const lines = quarantined.map((q) => `${q.stem} — ${q.error}`);
    try {
      await notifyFn(
        `backlog-fragments-drain quarantined ${quarantined.length} fragment(s)`,
        ['Unparseable fragments were moved to backlog/fragments/quarantine/ (never silent-dropped):', '', ...lines].join('\n'),
        { dedupKey: 'backlog-drain:quarantine', severity: 'warn' },
      );
    } catch (err) {
      log('warn', MODULE, 'quarantine alert failed; pass result still returned', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Fire-and-collect a layout-gate alert — same non-fatal pattern as
  // alertQuarantined. The pass refuses rather than quarantine inflow or
  // merge into a broken layout; fragments stay pending.
  const alertLayoutInvalid = async (problem: LayoutProblem): Promise<void> => {
    try {
      await notifyFn(
        `backlog-fragments-drain skipped: ${problem.reason}`,
        `${problem.detail}\nFragments remain pending; the pass refuses rather ` +
          `than quarantine inflow or merge into a broken layout.`,
        { dedupKey: `backlog-drain:layout-${problem.reason}`, severity: 'warn' },
      );
    } catch (err) {
      log('warn', MODULE, 'layout-gate alert failed; skip result still returned', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    // Step 3 — LAYOUT + VALIDATE, BEFORE dirty classification: the layout
    // DEFINES the write surface the dirty check covers.
    let layout0 = await discoverLayout(repoRoot);
    const gate = validateLayout(layout0);
    if (!gate.ok) {
      await alertLayoutInvalid(gate.problem);
      return { touched: 0, detail: { skipped: gate.problem.reason, reason: gate.problem.detail } };
    }

    // Step 4 — dirty-state classification off one snapshot, per write-surface
    // file. BACKLOG.md is deliberately NOT here — it joins the write set only
    // when the table actually regenerates; its dirty check is deferred to
    // post-compute (below).
    let snap = await snapshotFn(repoRoot);
    const openPaths = layout0.files.map((f) => f.rel);
    let dirtyPaths = openPaths.filter((p) => snap.entries[p] !== undefined && snap.entries[p].xy !== '');
    if (dirtyPaths.some((p) => { const m = snap.entries[p].mtimeMs; return m !== 0 && now - m < RECENT_MS; })) {
      return { touched: 0, detail: { skipped: 'backlog-recently-edited' } };
    }
    let staleDirty = [...dirtyPaths]; // committed-on-top set (only when actually written)

    // Baselines for the lost-update guard: every potential write-set file.
    // A dirty file's baseline is the snapshot's mtime; otherwise the file's
    // mtime as of just before the merge compute.
    const archiveDate = istDateOf(now);
    const archiveRel = completedArchiveRelPath(archiveDate);
    let baselineFiles = [...openPaths, BACKLOG_PATH, archiveRel];
    const baselines = new Map<string, number>();
    for (const p of baselineFiles) {
      baselines.set(p, dirtyPaths.includes(p) ? snap.entries[p].mtimeMs : await statFn(join(repoRoot, p)));
    }

    const { inputs: initialInputs, unreadable } = await readFragmentInputs(repoRoot, frags.pending);
    quarantined.push(...unreadable);
    let inputs = initialInputs;

    // Attempt-loop results, carried out of the loop for the write/commit/
    // result phase (re-initialized at the top of every attempt — a restart
    // re-computes from the re-discovered layout).
    let applied: { stem: string; id: number | null; rel: string }[] = [];
    let alreadyMerged: string[] = [];
    let created: { slug: string; rel: string }[] = [];
    let archivePlan: Map<string, ArchivePlan> | null = null;
    let archived: ArchivePlan['moved'] = [];
    let routerWrite: string | null = null;
    let routerTableNote: 'skipped-no-markers' | null = null;
    let writeSet = new Map<string, string>();

    // Step 5 — MERGE COMPUTE. A mid-pass mtime change restarts from here
    // ONCE (re-discover, re-merge); the frag markers make it idempotent.
    for (let attempt = 0; ; attempt++) {
      // Fresh in-memory layout copy for this attempt.
      const files = layout0.files.map((f) => ({ ...f }));
      const contents = new Map(files.map((f) => [f.rel, f.content] as const));
      const models = new Map(files.map((f) => [f.rel, f.model] as const));
      created = [];
      const dirTexts = await readBacklogDirTexts(repoRoot); // backlog/*.md glob —
      // open-*.md included; max() is a superset anyway
      let maxId = scanMaxId([...contents.values()].join(''), dirTexts);
      applied = [];
      alreadyMerged = [];
      const failed: { stem: string; error: string }[] = [];

      for (const input of inputs) {
        // GLOBAL stem order (listFragments sorted)
        const parsed = parseFragment(input.fragment); // route before apply
        if (!parsed.ok) {
          failed.push({ stem: input.stem, error: parsed.error });
          continue;
        }
        const frag = parsed.fragment;

        // ROUTE → owning file (or auto-create for `add`)
        let target: SectionFile | null = null;
        if (frag.verb === 'add') {
          target = fileForSection(files, frag.section!);
          if (target === null) {
            // AUTO-CREATE (operator decision — no human step): fragment.section
            // is schema-valid ([a-z][a-z-]{0,30}), so the file slug IS the
            // section slug and the heading is the slug verbatim (round-trip
            // identity, spec'd form).
            const rel = sectionFileRel(frag.section!);
            const content = sectionSkeleton(frag.section!); // `# Open Items\n\n## <slug>\n`
            const sf: SectionFile = {
              rel,
              abs: join(repoRoot, rel),
              slug: frag.section!,
              sectionName: frag.section!,
              content,
              model: parseBacklog(content),
            };
            files.push(sf);
            files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
            contents.set(rel, content);
            models.set(rel, sf.model);
            created.push({ slug: frag.section!, rel });
            target = sf;
          }
        } else {
          const hit = fileForTargetId(files, parseInt(frag.target!.slice(3), 10));
          if (hit.kind === 'none') {
            failed.push({ stem: input.stem, error: 'unknown target' });
            continue;
          }
          if (hit.kind === 'ambiguous') {
            failed.push({ stem: input.stem, error: 'ambiguous target' });
            continue;
          }
          target = hit.file;
        }

        // alreadyMerged — the marker is scoped to the ROUTED file (plan §2.3)
        const cur = contents.get(target.rel)!;
        if (cur.includes(`<!-- frag:${input.stem} -->`)) {
          alreadyMerged.push(input.stem);
          continue;
        }

        const res = mergeFragments(cur, [input], maxId, models.get(target.rel)!); // 1-element batch
        if (res.alreadyMerged.length > 0) {
          alreadyMerged.push(...res.alreadyMerged);
          continue; // defensive
        }
        if (res.failed.length > 0) {
          failed.push(...res.failed);
          continue;
        }
        contents.set(target.rel, res.content);
        models.set(target.rel, parseBacklog(res.content));
        for (const a of res.applied) {
          applied.push({ stem: a.stem, id: a.id, rel: target.rel });
          if (a.id !== null) maxId = a.id; // sequential ids ACROSS files, stem order
        }
      }

      // Validation/application failures quarantine immediately — collected
      // for the post-commit (or post-skip) alert, never blocking the batch.
      for (const f of failed) {
        try {
          await quarantineFragment(repoRoot, f.stem);
        } catch (err) {
          log('warn', MODULE, `failed to move fragment ${f.stem} to quarantine (non-fatal)`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        quarantined.push(f);
      }
      inputs = inputs.filter((i) => !failed.some((f) => f.stem === i.stem));

      // AUTO-ARCHIVE — plan per file, trigger on Σ moved or any merged
      // section file's PRE-archive content ≥ BACKLOG_SECTION_BUDGET (the
      // drain decides from what it is about to write — the 2026-09-14
      // dead-arm lesson).
      const plans = new Map(
        [...contents.keys()].map((rel) => [rel, planBacklogArchive(contents.get(rel)!)] as const)
      );
      const totalMoved = [...plans.values()].reduce((n, p) => n + p.moved.length, 0);
      archivePlan = shouldAutoArchive(totalMoved, [...contents.values()]) ? plans : null;
      archived = archivePlan === null ? [] : [...archivePlan.values()].flatMap((p) => p.moved);

      // ROUTER TABLE REGEN (operator decision) — every pass that will write;
      // byte-compare so an identical table costs nothing. Splicing touches
      // ONLY the marker region — human edits outside the markers survive
      // (stale-dirty bundling, verbatim).
      routerWrite = null;
      routerTableNote = null;
      if (layout0.routerContent !== null) {
        if (layout0.routerHasMarkers) {
          const rows = files.map((f) => ({ sectionName: f.sectionName, rel: f.rel }));
          const next = spliceSectionTable(layout0.routerContent, rows);
          if (next !== layout0.routerContent) routerWrite = next;
        } else {
          log('warn', MODULE, 'router lacks AUTO:BACKLOG-SECTIONS markers — table not regenerated', {});
          routerTableNote = 'skipped-no-markers';
        }
      }

      // WRITE SET — every section file whose final (post-archive) content
      // differs from what was read, plus the router when the table regen
      // produced a change.
      writeSet = new Map<string, string>();
      for (const [rel, content] of contents) {
        const planned = archivePlan?.get(rel);
        const final = planned ? planned.content : content;
        if (final !== files.find((f) => f.rel === rel)!.content) writeSet.set(rel, final);
      }
      if (routerWrite !== null) writeSet.set(BACKLOG_PATH, routerWrite);

      if (applied.length === 0 && alreadyMerged.length === 0 && archivePlan === null
          && routerWrite === null && created.length === 0) {
        await alertQuarantined();
        return { touched: quarantined.length, detail: { merged: 0, quarantined: quarantined.length } };
      }

      // DEFERRED ROUTER DIRTY CHECK (the only BACKLOG.md deferral point): a
      // <15-min-dirty BACKLOG.md AND a pending regen ⇒ defer the WHOLE pass
      // (a created section + its table row are one logical write — no
      // half-applies). Older-dirty ⇒ bundle with the stale-dirty suffix.
      if (routerWrite !== null) {
        const e = snap.entries[BACKLOG_PATH];
        if (e !== undefined && e.xy !== '' && e.mtimeMs !== 0 && now - e.mtimeMs < RECENT_MS) {
          await alertQuarantined();
          return { touched: 0, detail: { skipped: 'backlog-recently-edited' } };
        }
        if (e !== undefined && e.xy !== '' && !staleDirty.includes(BACKLOG_PATH)) {
          staleDirty.push(BACKLOG_PATH); // stale ⇒ bundle
        }
      }

      // LOST-UPDATE GUARD over every write-set file + the archive file
      // (restart once, then skip 'backlog-changed-mid-pass' + warn).
      if (writeSet.size > 0 || archivePlan !== null) {
        const guard = new Set([...writeSet.keys(), ...(archivePlan !== null ? [archiveRel] : [])]);
        let changed = false;
        for (const rel of guard) {
          const cur = await statFn(join(repoRoot, rel));
          if (cur !== (baselines.get(rel) ?? 0)) {
            changed = true;
            break;
          }
        }
        if (changed) {
          if (attempt >= 1) {
            try {
              await notifyFn(
                'backlog-fragments-drain skipped: a write-surface file changed mid-pass',
                'A backlog write-surface file was modified while a merge pass was computing; the pass was abandoned ' +
                  'without writing (second change after one restart). Fragments remain pending for the next pass.',
                { dedupKey: 'backlog-drain:midpass-change', severity: 'warn' },
              );
            } catch (err) {
              log('warn', MODULE, 'midpass-change alert failed; skip result still returned', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
            await alertQuarantined();
            return { touched: 0, detail: { skipped: 'backlog-changed-mid-pass' } };
          }
          // Restart: re-read EVERYTHING — the layout is re-discovered (a
          // mid-pass human edit to a section file or the router is merged,
          // never clobbered) and every baseline is refreshed.
          layout0 = await discoverLayout(repoRoot);
          const regate = validateLayout(layout0);
          if (!regate.ok) {
            await alertLayoutInvalid(regate.problem);
            return { touched: 0, detail: { skipped: regate.problem.reason, reason: regate.problem.detail } };
          }
          baselineFiles = [...layout0.files.map((f) => f.rel), BACKLOG_PATH, archiveRel];
          for (const rel of baselineFiles) {
            baselines.set(rel, await statFn(join(repoRoot, rel)));
          }
          // Re-snapshot + reclassify dirty state off the NEW layout — a file
          // cleaned or dirtied by the mid-pass foreign action must not linger
          // in staleDirty (the suffix would name a file the commit doesn't
          // touch — the AI-334 lie in a narrower window), and a file whose
          // foreign edit is now <RECENT_MS old defers the whole pass again.
          snap = await snapshotFn(repoRoot);
          dirtyPaths = layout0.files.map((f) => f.rel).filter(
            (p) => snap.entries[p] !== undefined && snap.entries[p].xy !== '',
          );
          if (dirtyPaths.some((p) => { const m = snap.entries[p].mtimeMs; return m !== 0 && now - m < RECENT_MS; })) {
            return { touched: 0, detail: { skipped: 'backlog-recently-edited' } };
          }
          staleDirty = [...dirtyPaths];
          continue;
        }
      }
      break;
    }

    // Steps 7–8 — atomic writes, then pathspec add+commit, throwing on
    // non-zero exit exactly like brain-sweep.ts (a throw ⇒ runner records
    // `failed`, fragments stay on disk, the next pass retries). An applied
    // fragment, a created file or an archive plan always changes content, so
    // this commit can never be a "nothing to commit" no-op.
    if (writeSet.size > 0 || archivePlan !== null) {
      for (const [rel, content] of writeSet) {
        await writeFileAtomic(join(repoRoot, rel), content);
      }
      if (archivePlan !== null) {
        // ONE archive section for the UNION of moved items across files.
        await writeFileAtomic(
          join(repoRoot, archiveRel),
          appendArchiveSection(
            await readCompletedArchive(repoRoot, archiveDate),
            archiveDate,
            archived,
          ),
        );
      }
      // addPaths = the drain's own writes + the archive file + every
      // stale-dirty file. The commit message + notify claim "includes
      // pre-existing working-tree edits to X" — X must actually be in the
      // pathspec or the claim is a lie (AI-334: observed live, three commits
      // named open-bugs.md while their stats excluded it). A stale-dirty file
      // that is ALSO in the write set is harmless — Set dedups, and its
      // foreign content is already merged into the drain's own rewrite.
      // existsSync filter (verifier 2026-09-19): a stale-dirty file DELETED
      // between classification and add must drop out — committing a foreign
      // deletion under an "edits" suffix mischaracterizes it, and an
      // untracked file's pathspec would fail the whole `git add`. The suffix
      // and notify name exactly this filtered set, so the claim always
      // matches the pathspec.
      const staleDirtyCommitted = staleDirty.filter((p) => existsSync(join(repoRoot, p)));
      const addPaths = [
        ...new Set([...writeSet.keys(), ...(archivePlan !== null ? [archiveRel] : []), ...staleDirtyCommitted]),
      ];
      const add = await git(repoRoot, ['add', '--', ...addPaths]);
      if (add.code !== 0) {
        throw new Error(`git add failed (exit ${add.code}): ${add.stderr.toString('utf8').trim()}`);
      }
      const ids = applied.filter((a) => a.id !== null).map((a) => `AI-${a.id}`);
      let message: string;
      if (applied.length > 0) {
        message = `backlog-drain: merge ${applied.length} fragment(s) ${archiveDate} — ${ids.join(', ')}`;
        if (archivePlan !== null) {
          message += `, archived ${archived.length} DONE item(s) to ${archiveRel}`;
        }
      } else if (archivePlan !== null) {
        // The archive-only shape (same as the pre-split form).
        message = `backlog-drain: archive ${archived.length} DONE item(s) ${archiveDate} — ${archived
          .map((m) => `AI-${m.id}`)
          .join(', ')}`;
      } else {
        // Router-table-only write (no fragments applied, no archive).
        message = `backlog-drain: regenerate router table ${archiveDate}`;
      }
      for (const c of created) {
        message += `, new section ${c.rel}`;
      }
      if (routerWrite !== null && (applied.length > 0 || archivePlan !== null)) {
        message += ', regenerated router table';
      }
      if (staleDirtyCommitted.length > 0) {
        message += ` (includes pre-existing working-tree edits to ${staleDirtyCommitted.join(', ')})`;
      }
      const commit = await git(repoRoot, ['commit', '-m', message, '--', ...addPaths]);
      if (commit.code !== 0) {
        throw new Error(`git commit failed (exit ${commit.code}): ${commit.stderr.toString('utf8').trim()}`);
      }
      if (staleDirtyCommitted.length > 0) {
        // Operator visibility + attribution honesty: this commit landed
        // someone else's pre-existing working-tree edits too (R-2, accepted
        // by design). Never silent.
        try {
          await notifyFn(
            `backlog-fragments-drain committed over stale-dirty file(s): ${staleDirtyCommitted.join(', ')}`,
            `${staleDirtyCommitted.join(', ')} was already dirty (last edit >` +
              Math.round(RECENT_MS / 60000) +
              ' min ago) when this pass merged; the commit includes those pre-existing ' +
              'working-tree edits alongside the merged fragments (message suffix names it too).',
            { dedupKey: 'backlog-drain:stale-dirty', severity: 'warn' },
          );
        } catch (err) {
          log('warn', MODULE, 'stale-dirty alert failed; commit already landed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      for (const c of created) {
        // Operator decision: auto-created sections are never silent — a typo
        // slug becomes a visible stray file + router row, cheap to delete.
        try {
          await notifyFn(
            `backlog-fragments-drain created section file ${c.rel}`,
            `a \`--section ${c.slug}\` fragment named a schema-valid section with no file; ` +
              'the drain created the section + router row. If the slug was a typo the stray ' +
              'file is cheap to delete (plus its router row — regenerated next pass).',
            { dedupKey: `backlog-drain:section-created:${c.slug}`, severity: 'warn' },
          );
        } catch (err) {
          log('warn', MODULE, `section-created alert for ${c.rel} failed; commit already landed`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Step 9 — delete applied + already-merged fragments. Per-file unlink,
    // failures logged non-fatally: a stale file self-heals via its marker on
    // the next pass.
    for (const stem of [...applied.map((a) => a.stem), ...alreadyMerged]) {
      try {
        await deleteFragment(repoRoot, stem);
      } catch (err) {
        log('warn', MODULE, `failed to delete merged fragment ${stem} (non-fatal)`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await alertQuarantined();

    // Step 10 — result detail is exact-shape stable: new keys appear ONLY
    // when they occur.
    return {
      touched:
        applied.length + alreadyMerged.length + quarantined.length + archived.length + created.length,
      detail: {
        merged: applied.length,
        ids: applied.filter((a) => a.id !== null).map((a) => a.id),
        quarantined: quarantined.length,
        mode: staleDirty.length > 0 ? ('stale-dirty' as const) : ('clean' as const),
        // Present only when the auto-archive fired this pass.
        ...(archived.length > 0
          ? { archived: archived.length, archivedIds: archived.map((m) => m.id) }
          : {}),
        ...(created.length > 0 ? { created: created.map((c) => c.slug) } : {}),
        ...(routerWrite !== null
          ? { routerTable: 'regenerated' }
          : routerTableNote !== null
            ? { routerTable: routerTableNote }
            : {}),
      },
    };
  } finally {
    await releaseLockFn(lockKey, LOCK_AGENT, contextId, { pid: process.pid }).catch(() => {});
  }
}

export const backlogFragmentsDrainJob: MaintenanceJob = {
  name: 'backlog-fragments-drain',
  host: 'pa',
  everyMs: JOB_EVERY_MS,
  description:
    'Every 3 minutes merges pending backlog/fragments/*.json (gitignored per-thread fragments filed by ' +
    '`pa backlog add`) into backlog/open-<section>.md — the section files\' SOLE writer, plus the ' +
    'AUTO:BACKLOG-SECTIONS table region of the BACKLOG.md router ONLY. `add` fragments route by section ' +
    'slug — a schema-valid section with no file AUTO-CREATES backlog/open-<slug>.md (heading `## <slug>` ' +
    'verbatim) + a router row + a deduped warn (a typo becomes a visible stray, never silent); `status` ' +
    'fragments route by scanning every section file\'s parsed ids (0 hits ⇒ unknown-target, >1 ⇒ ' +
    'ambiguous-target quarantine). Sequential AI-nnn ids from a max-scan over all section files + ' +
    'backlog/*.md, committing via the brain-sweep gitRunner pattern while holding the git-workflow ' +
    'exclusive lock for the whole read-merge-commit window (busy ⇒ skip, never wait; a <15-min-dirty ' +
    'write-surface file defers — BACKLOG.md included, but only when a table regen is pending; an older ' +
    'dirty one merges on top with a warning suffix + notify naming the bundled paths). ' +
    'Since 2026-09-13 the pass also AUTO-ARCHIVES the DONE-item outflow: per-file archive plans fire ' +
    'when DONE-class items (anchored `Type / Pri / DONE|BUILT|FIXED|COMPLETE`… status lines) cross 10 ' +
    'in total or any merged section file\'s PRE-archive content reaches the 24,000-char section budget, ' +
    'moving them verbatim into backlog/completed-<IST-date>.md under ONE archive section (archived ids ' +
    'are re-scanned for the max-id check so they are never reused, and a status fragment targeting an ' +
    'archived id reads as unknown-target quarantine — an archived item never returns). ' +
    'The manual `pa backlog archive [--dry-run]` is the operator\'s threshold-free sweep. ' +
    'Layout violations skip the whole pass + warn with fragments preserved, never quarantined: ' +
    'pre-router-backlog (a `## ` in the router\'s open region — also the pre-migration guard) or ' +
    'backlog-layout-invalid (a section file breaking a file-level invariant, or a slug collision). ' +
    'Admission-rule proof: nearest existing job is orphan-edit-watch, which only DISPOSES of dirty files ' +
    '≥6h old and never merges content; no existing job merges pending writes into a tracked file, and ' +
    'brain-sweep is a skill-invoked command, not a cadence-declarable job.',
  destructive: false,
  shedWhenDegraded: false, // the drain IS the backlog's write path now — never shed (voice-inbox-fallback precedent)
  targets: [], // surface-only; own-state writes are not retention (orphan-edit-watch precedent comment)
  async run(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult> {
    return runBacklogFragmentsDrain(ctx);
  },
};
