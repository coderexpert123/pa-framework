/**
 * docs-lint — the budgeted-doc gate's single implementation (AI-242,
 * 2026-09-14).
 *
 * Two regrow-trim cycles in 24h on the bot+vi CLAUDE.mds (2026-09-13/14)
 * proved the check's placement wrong, not the check: budgets lived only in
 * pa/tests/docs-crossref.test.ts, reachable solely at push-gate time, so
 * feature waves landed over-budget brain rows and a separate trim wave
 * followed. This module is the same gate made reachable at commit time:
 * `pa docs-lint [--] [path ...]` runs it before a landing, and the test
 * suite imports it verbatim — the numbers, the CRLF-normalized measure, and
 * the same-file-trim counter exist here exactly ONCE. A second budget table
 * or a parallel checker is a defect; extend this file.
 *
 * Budgets measure content, not encoding: public Windows CI checks out CRLF
 * (PR #34 run 33436146842 measured bot CLAUDE.md at 12,073 vs 11,923 LF), so
 * every count below normalizes CRLF to a single LF. This is the same measure
 * as backlog-archive.ts's `backlogBudgetChars` — keep them identical.
 *
 * The escape hatch is a RAISE, recorded: every non-default entry below is a
 * {budget, since, justification} record — the dated, evidence-cited reason
 * the ceiling moved (the recorded-justification rule; a test in
 * pa/tests/docs-lint.test.ts rejects a bare bump). Precedent class:
 * voice-inbox 12k→13k→15k and telegram-bot 15k→17k (2026-09-14),
 * content-verified — raise-or-split per the trim doctrine, completeness-
 * audited, never a trim that would cut a rule.
 *
 * Numbers here MUST match docs/CONVENTIONS.md § "Brain-file organization" —
 * if you're changing one, change both, or this check silently drifts from
 * the rule it's supposed to enforce.
 *
 * CommonJS module — no ESM meta-url forms.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// ---------------------------------------------------------------------------
// Arm 1: size budgets
// ---------------------------------------------------------------------------

/** The docs-gate measure: chars with CRLF normalized to LF, so a CRLF file
 *  is never double-counted toward the budget. */
export function budgetChars(content: string): number {
  return content.replace(/\r\n/g, '\n').length;
}

export interface DocBudgetFailure {
  /** Repo-relative forward-slash path of the over-budget doc. */
  file: string;
  chars: number;
  budget: number;
  /** The full failure line, matching the test-suite messages verbatim. */
  message: string;
}

/** A non-default (raised) budget: the ceiling plus its recorded
 *  justification. `since` is the raise date (YYYY-MM-DD); `justification`
 *  names the raise-class and the evidence. Required by AI-242's escape
 *  hatch — a budget bump is legitimate only WITH this record attached. */
export interface RaisedBudget {
  budget: number;
  since: string;
  justification: string;
}

export const ROOT_CLAUDE_BUDGET = 48_000; // soft 40k / hard 48k per CONVENTIONS
export const FILE_INVENTORY_BUDGET = 4_000; // router budget
// BACKLOG.md became a ROUTER over backlog/open-*.md on 2026-09-18 (AI-316): open
// items moved to per-section files and the root file keeps only the preamble,
// the normative Standard, and the drain-maintained section table. The router gets
// the established router/index class ceiling — the whole 12k→17k raise history is
// moot because the file is a different class now. Replaced, not appended to.
export const BACKLOG_ROUTER_BUDGET = 4_000;
// backlog/open-*.md — ONE glob-class budget covering every present AND FUTURE
// section file (a per-file table leaves a new section unbudgeted — the
// DOCS_FILE_BUDGETS coverage hole). The drain's auto-archive is the real
// outflow control, this number is a tripwire.
// Raised 24,000 -> 30,000 (2026-09-18): the 24k figure was sized off a stale
// 19,621-char Bugs measurement taken at spec time; by wave-landing the live
// file measured 24,699 over 47 items with ZERO DONE-class archivable rows, so
// the remediation message's remedy (archive DONE items) was unavailable and
// the gate sat red on audited growth — same-day backlog-blitz merges plus
// standing filings account for the delta. 30,000 restores ~18% headroom.
export const BACKLOG_SECTION_BUDGET = 30_000;
// backlog/completed-index.md raised across 16,000 -> 20,000 (2026-08-23, Wave
// C W-C13) -> 21,000 -> 24,000 (2026-09-04, placement Phase-3: 16 DONE items
// pruned from BACKLOG.md landed as index rows) -> 25,000 (2026-09-06,
// backlog-blitz: three verified bug closures AI-202/206/208) -> 27,000
// (2026-09-08, AI-216's filing): three 1k-ish raises in about two weeks show
// 1k steps are too small for a file documented to grow monotonically -- a 2k
// step buys real room without weakening a gate whose bloat-control purpose
// this file class is explicitly exempt from. Do not trim this file to fit
// under budget -- raise instead; a prior trim pass already left several rows
// mid-word (e.g. "...kill every live tracked de |"), which trimming damages
// and a raise never does.
export const COMPLETED_INDEX_BUDGET = 27_000;

/** The pa CLI subsystem brain (directory-scoped, auto-loads under pa/).
 *  Budget = the class default per docs/CONVENTIONS.md. Extracted 2026-09-15
 *  from 50,155 chars to seven docs/pa-*.md topic files; linter-checked from
 *  the same day so it cannot silently regrow unbudgeted. */
export const PA_CLAUDE_BUDGET = 12_000;

export const PROJECT_CLAUDE_DEFAULT_BUDGET = 12_000;

/** Named raise-class exceptions to the default 12k for
 *  projects/<x>/CLAUDE.md. telegram-bot raised to 15,000 (2026-09-06): the
 *  backlog-blitz night added five real subsystem sections in one wave set
 *  (command router, topic sources, voice-inbox bridge + pin self-heal,
 *  orchestrator threads) — growth matched by capability, not prose drift,
 *  the same raise-class as the job/knob catalogs. An initial 14,000 estimate
 *  predated the orchestrator rows. */
export const PROJECT_CLAUDE_BUDGETS: Record<string, RaisedBudget> = {
  // voice-inbox raised to 13,200 (2026-09-14): content grew legitimately
  // (answer-register rule, raw-html lane invariants, form-widget rules —
  // 2026-09-13/14 waves); two trim cycles proved steady-state >12k and the
  // file re-proved it at 13,168 within hours of the 13,000 ruling — the
  // budget tracks verified rule content, not an arbitrary cap.
  // Raised 13,200 -> 15,000 (2026-09-14): 2 further feature waves' audited
  // brain rows the same day (committed 14,105) — the 2-trims-in-24h counter
  // mandates raise-or-split; completeness-audited (all rules, no fat);
  // per-wave-allowance follow-up is this module (AI-242).
  // Raised 15,000 -> 16,000 (2026-09-14, wave verifier): AI-244's worker-side
  // attach-path rule paragraph (7655b38, +6 lines) landed post-gate at
  // 15,378 measured — rule content under the file's own "RULES ONLY"
  // contract, so the doctrine's response is a raise, not a trim or a
  // relocation to FEATURE-NOTES (mechanics/stories live there, not rules).
  // Raised 16,000 -> 19,000 (2026-09-15): the AI-246 live-screencast wave's
  // rule rows (live-pane file layout, shell-version sync pin, input gating,
  // takeover coordination) landed the file at 18,757 measured — audited rule
  // growth, same doctrine response as the 09-14 raises.
  // Raised 19,000 -> 22,000 (2026-09-15): intervening waves' rule rows pushed
  // HEAD to 20,157 before the archive-search + header-free-list + footer-fix
  // wave landed (+1,092: header-free groups/archive pill/?q= search rules +
  // the two-control footer-cap invariant), 21,249 measured — audited rule
  // growth, raise per doctrine; never a trim that would cut a rule.
  // Raised 22,000 -> 24,000 (2026-09-15): the answer-presentation P4 wave's
  // form-set contract rules (8cc2f35 +19 lines: derived-path back-navigation,
  // per-task draft store, three submit modes, malformed-steps fallback —
  // renderer contract content under RULES ONLY) landed the file at 22,850
  // measured — audited rule growth, third same-day raise under the doctrine.
  // Raised 24,000 -> 25,000 (2026-09-16): the answer-presentation P6 wave's
  // device-awareness rule (the v13 `surface` column, the one-directional
  // media-query override, and the NULL-renders-as-before invariant that keeps
  // every pre-v13 answer stable) landed the file at 24,321 measured against
  // 261 chars of headroom — audited rule growth under RULES ONLY, raise per
  // doctrine; a trim to fit would have cut a live renderer invariant.
  // Raised 25,000 -> 27,000 (2026-09-16): the voice-transcription-latency wave's
  // brain rows (bot-process transcription drain, route-entry hold, one
  // shared transcription implementation, the fallback as a backstop, the
  // cleaned-request rule) landed the file at 25,954 against the 25,000
  // ceiling — audited rule growth, raise per doctrine, never a trim that
  // would cut a live rule.
  // Raised 27,000 -> 28,000 (2026-09-20): the router-metadata wave's rows —
  // decision-33 display contract on the provenance chip, the v16 router_*
  // column notes, and the stale-v14→v16 domino pass — audited rule growth,
  // same raise-class.
  'voice-inbox': {
    budget: 28_000,
    since: '2026-09-20',
    justification:
      'router-metadata wave: decision-33 display contract on the provenance chip + v16 router_* rows landed the file past the 27,000 ceiling — audited rule growth, raise per doctrine',
  },
  // telegram-bot raised to 15,000 (2026-09-06: five subsystem sections, see
  // the block comment above). Raised 15,000 -> 17,000 (2026-09-14): 43
  // feature landings' audited brain rows since that raise (committed
  // 16,473) — raise-or-split per the trim doctrine; completeness-audited
  // (all rules, no fat); per-wave-allowance follow-up is this module
  // (AI-242).
  // Raised 17,000 -> 18,000 (2026-09-14, AI-215 WP-B3): the orchestrator-
  // threads arming-pointer bullet was rewritten to state default-on +
  // explicit-false opt-out (the gate inverted to
  // `orchestrator_enabled !== false`) plus the resolved 2026-09-08
  // cancellation concern — correctness-critical invariant content the spec
  // (§4) requires to live in the brain file, not mechanics relocatable to
  // the companion doc; file landed at 17,332. Same raise-class.
  // Raised 18,000 -> 19,000 (2026-09-15, AI-246 WP-E): two new rule rows —
  // the silent-unknown-action-type hazard (the `{"type":"T"}` template
  // placeholder copied verbatim, spawns vanishing with no parse error) and
  // the late-sweep receipt-refusal retry (`THREAD_VOICE_REFUSED_RESULT_NOTE`
  // on the `\bexited 2\b` signature) + the routing-thread early-close quirk —
  // landed at 18,651 measured; audited rule content, same raise-class.
  // Raised 19,500 -> 21,000 (2026-09-16): the voice-transcription-latency wave's
  // brain rows (bot-process transcription drain, route-entry hold, one
  // shared transcription implementation, the fallback as a backstop, the
  // cleaned-request rule) landed the file at 19,848 against the 19,500
  // ceiling — audited rule growth, raise per doctrine, never a trim that
  // would cut a live rule.
  // Raised 21,000 -> 22,000 (2026-09-20, router-metadata wave WS3): the
  // PA_ROUTING_* provenance sentence on the WS3 bullet (the wave spec's
  // REQUIRED 4th raise — the file measured 20,994/21,000 at spec time, 6
  // chars of headroom, so the overrun was certain) — audited rule growth,
  // same raise-class.
  'telegram-bot': {
    budget: 22_000,
    since: '2026-09-20',
    justification:
      'router-metadata wave: WS3 bullet gains the PA_ROUTING_* / cascade-getEnv / ThreadRecord.routing sentence; file measured 20,994/21,000 at spec time — audited rule growth, raise per doctrine',
  },
};

export const DOCS_DEFAULT_BUDGET = 16_000; // operational-detail files
export const DOCS_EVERGREEN_BUDGET = 24_000; // ALL-CAPS-before-the-dot guides

/** Named raises inside docs/*.md on top of DOCS_DEFAULT_BUDGET. */
export const DOCS_FILE_BUDGETS: Record<string, RaisedBudget> = {
  // multi-session-protocol.md raised 16,000 -> 17,500 (2026-09-15): two
  // budget trims in ~48h (d5161f2 09-13, ea103ad 09-14) already hit the
  // raise-or-split counter, and the growth since is audited rule content —
  // Rules 14-19 (update-brain pass, backlog drain, landing discipline, stall
  // disposition, testlock), the AI-243 git-guard claim-gate paragraph, and the
  // waterfall-v2 tier wording — never a trim that would cut a live rule.
  // Splitting rules out of the protocol doc would orphan them from the
  // enforcement section (same call as CONVENTIONS.md's 2026-09-14 raise).
  // Raised 17,500 -> 18,000 (2026-09-17): post-split growth is again audited
  // rule content — spawned-context supersession clause + dir-first git-guard
  // invocation detail; three further trim passes reached ~17,740 before
  // shaving live-rule phrasing.
  // Raised 18,000 -> 19,000 (2026-09-19): Rule 21 bus-topology + the
  // commit-skill push-gated doctrine lines (2026-09-18 wave) pushed the file
  // to ~18.5k; same audited-rule-accrual class as both prior raises, and a
  // fourth trim pass would shave live rules.
  // Raised 19,000 -> 20,500 (2026-09-20): Rule 22, the AI-264/AI-318 shared-tree
  // stash doctrine — stash is a named, owned hold, never a tree-cleaner; born
  // from the 2026-09-20 stash incidents. Same audited-rule-accrual class as
  // every prior raise; a trim would cut a live coordination rule.
  'multi-session-protocol.md': {
    budget: 20_500,
    since: '2026-09-20',
    justification:
      'Rule 22 shared-tree stash doctrine (AI-264/AI-318, 2026-09-20 incidents) — same audited-rule-accrual class as the 2026-09-15/17/19 raises, trims already bottomed out',
  },
  // model-router.md NEW named entry (2026-09-20): the file previously rode the
  // 16,000 DOCS_DEFAULT_BUDGET. The routing-metadata provenance section (the
  // seven PA_ROUTING_* env keys, the three stamping lanes, the router_* ledger
  // columns + task_telemetry recording, the fail-open rule, the PWA display
  // pointer, the no-turn-text/share-view invariants) landed it at ~17.5k —
  // contract content under the recorded-justification rule, never a trim that
  // would cut a live contract line.
  'model-router.md': {
    budget: 17_500,
    since: '2026-09-20',
    justification:
      'routing-metadata provenance section (2026-09-20 wave: PA_ROUTING_* env contract, stamping lanes, router_* ledger columns, share-view invariant) pushed the file past the 16,000 docs default — contract content, raise per doctrine',
  },
  // The job catalog grows monotonically with every declared job — a
  // documented raise-class (budget doctrine): 18k since AI-198's 32nd job;
  // raised 26,000 -> 28,000 (2026-09-10, sanctioned by
  // plans/2026-09-10-launch-cadence-SPEC.md's WP-DOC): the
  // nonpaged-pool-watch job's paragraph (the 36th job) pushed the file past
  // its old ceiling — the same raise-class as before, one paragraph per
  // declared job the code still ships, never a trim inside the reference
  // catalog. Raised 28,000 -> 29,000 (2026-09-11): the
  // voice-inbox-fallback conversation-claim guard's paragraph (a landed
  // behavioral fix to a declared job, not a new job) pushed the file past
  // its old ceiling — same raise-class, same never-trim rule.
  // Raised 29,000 -> 31,000 (2026-09-14, wave verifier): the AI-239 bounded
  // transcription-retry landing (9645b82) extended the voice-inbox-fallback
  // job's own entry — a landed behavior fix to a declared job, the same
  // raise-class — leaving the file at 30,275 normalized.
  // Raised 31,000 -> 32,000 (2026-09-15, update-brain): the agent-bus wave's
  // busDrainJob paragraph (the 38th job) pushed the file to 31,241 — the same
  // raise-class as the 09-10/09-11/09-14 raises, one paragraph per declared
  // job the code still ships, never a trim inside the reference catalog.
  // Raised 32,000 -> 33,000 (2026-09-16): the voice-transcription-latency wave's
  // brain rows (bot-process transcription drain, route-entry hold, one
  // shared transcription implementation, the fallback as a backstop, the
  // cleaned-request rule) landed the file at 32,340 against the 32,000
  // ceiling — audited rule growth, raise per doctrine, never a trim that
  // would cut a live rule.
  // Raised 33,000 -> 34,000 (2026-09-17): maintenance job catalog grows one
  // entry per declared job; bus-prune (e8f45c4) pushed it to 33,320 over
  // 33,000; catchup-lane-wedge WP-G trims it to 33,210 — still over, so
  // raise per the raise-or-split doctrine, never a trim that cuts a live rule.
  'maintenance-jobs.md': {
    budget: 36_000,
    since: '2026-09-18',
    justification:
      'two waves grew real content past 34,000 the same day (slow-rca pool-watch paragraph + AI-316 per-section drain rewrite → 35,150): raise per the raise-or-split doctrine, never a trim that cuts a live rule',
  },
  // CONFIGURATION.md is the knobs catalog — one row per knob, the same
  // documented raise-class as the job catalog. Raised 28,000 -> 30,000
  // (2026-09-10, sanctioned by plans/2026-09-10-launch-cadence-SPEC.md's
  // WP-DOC): the PA_AGY_NO_PROGRESS_TIMEOUT_MS knob row pushed the file
  // past its old ceiling — the same raise-class as before, one row per
  // knob the code still ships, never a trim inside the reference table.
  // Raised 30,000 -> 35,000 (2026-09-11, the dynamic-worker-slots wave's
  // WP-2): the file sat 6 chars under the old ceiling; the four
  // dynamic-slot knob rows (PA_DYNAMIC_SLOTS, PA_SLOTS_MIN,
  // PA_SLOTS_PER_WORKER_MB, PA_SLOTS_SYSTEM_RESERVE_MB, +1,073 chars) and
  // the same-day routing_policy config section (+3,164 chars, another
  // wave's landed content) pushed it past. Same raise-class, same
  // never-trim rule; the step buys ~1.2k of headroom.
  // Raised 35,000 -> 37,000 (2026-09-11) by the slots-governor wave: two
  // dead knob rows removed and five added (three brake inputs plus the
  // worker-fault and recovery-wait knobs) with two rows rewritten; the
  // knobs catalog is a never-trim one-row-per-knob reference table, and the
  // measured landing point left only ~250 chars of slack with three other
  // sessions editing this file the same evening.
  // Raised 37,000 -> 37,500 (2026-09-14): six feature landings' audited
  // knob rows since the 2026-09-11 raise (committed 36,998, 2 chars of
  // slack) plus the held rollback-failed audit restoration landing in the
  // same commit — raise-or-split per the trim doctrine;
  // completeness-audited (all rules, no fat); per-wave-allowance follow-up
  // is this module (AI-242).
  // Raised 37,500 -> 39,000 (2026-09-17): the TypeSafe typed-routing wave
  // (WP-G) and Wave C's coexistence rows (1d56dfa) brought the file to 38,273,
  // and the judge-eval usage paragraph that ships with `pa typesafe eval --judge`
  // adds 512 — same never-trim raise-class, one combined move.
  'CONFIGURATION.md': {
    budget: 39_000,
    since: '2026-09-17',
    justification:
      'knobs catalog — one row per shipped knob, never-trim reference; the TypeSafe typed-routing knobs filled 37,500 and the judge-eval usage paragraph ships with its command',
  },
  // ARCHITECTURE.md keeps its own 28,000 ceiling, split out from
  // CONFIGURATION.md's branch (2026-09-10) now that the two diverge.
  // Raised to 28,000 (2026-09-04, AI-179 WP-4): the blackboard section
  // documents the landed tri-state lock renewal — one sentence for a
  // landed P1 fix, the same raise-class doctrine as the knobs catalog
  // (trimming would cut live reference content).
  'ARCHITECTURE.md': {
    budget: 28_000,
    since: '2026-09-04',
    justification:
      'AI-179 WP-4 — landed tri-state lock renewal section; same never-trim raise-class as the knobs catalog',
  },
  // CONVENTIONS.md raised 24,000 -> 27,000 (2026-09-14, AI-242): the file sat
  // at 24,399 — already over the evergreen ceiling — when this wave opened,
  // from the multi-session-protocol rule splits and doctrine paragraphs
  // landing through the day; AI-242's own allowance+gate paragraph added
  // ~1.3k more. Convention accrual is monotone growth of the same class as
  // the catalogs — a split of the budget doctrine out of its own doc would
  // orphan the contract from its enforcement section.
  'CONVENTIONS.md': {
    budget: 28_000,
    since: '2026-09-17',
    justification:
      'jargon-gate paragraph (WP-C5) landed on a file already pushed to ~27.2k by same-day waves; raise-or-split doctrine, never a trim of a live rule',
  },
};

export const INVENTORY_DEFAULT_BUDGET = 16_000; // manual inventory files
// The auto-managed glob-derived class ceiling: a file the update-brain
// skill rewrites wholesale from one glob() pattern gets the higher ceiling
// -- its AUTO:FILE-INVENTORY-* marker pair is what makes it that class.
// Raised 18,000 -> 20,000 (2026-08-30): pa-lib.md crossed 18k on legitimate
// growth -- one new entry per new lib module, and the lib only grows.
// Trimming inside the AUTO markers is futile (update-brain owns it). The
// durable fix is the split pa-lib.md's own header names (maintenance/ out);
// 20k is headroom toward that, not permission to grow unbounded.
// Raised 20,000 -> 23,000 (2026-09-03): the handover waves' new lib modules
// (topic-tasks/-events/-executor, orphan-ledger, daily-recon, grammars)
// pushed pa-lib and telegram-bot past 20k on legitimate per-module growth.
// Raised 23,000 -> 26,000 (2026-09-06): the backlog-blitz night added five
// bot modules in one wave set (command-router, orchestrator,
// thread-executor, session-capture, topic-threads) — same per-module class.
// Raised 29,000 -> 33,000 (2026-09-11) by the slots-governor wave:
// pa-lib.md was ALREADY 1,647 chars over the old ceiling when this wave
// opened, from another wave's peak-window.ts and routing-policy.ts rows.
// That wave added one lib module's row and rewrote another; trimming inside
// the AUTO markers is futile because update-brain owns that span. The step
// is 4,000 rather than the ~2,000 that would just clear it because the
// nightly sweep appends its own stub for each new lib module.
export const INVENTORY_AUTO_BUDGET = 33_000;

/** Named raises inside inventory/*.md on top of the class defaults. */
export const INVENTORY_FILE_BUDGETS: Record<string, RaisedBudget> = {
  // pa-lib.md raised to 35,000 (2026-09-15, update-brain): the deterministic
  // inventory sweep seeded five waves' landed files (bus-queue, bus-acp,
  // backlog-archive, browser-launcher, docs-lint) taking the auto-managed file
  // to 33,657 — raise-class per the doctrine (stepwise 18k->33k; the row in
  // docs/CONVENTIONS.md documents the code), never a trim of a glob-derived
  // inventory.
  // Raised 35,000 -> 36,000 (2026-09-17): the spawned-context supersession
  // sweep landing (6dbc25c) extended reservations.ts's entry to 35,689 —
  // same raise-class, trim inside AUTO markers is futile.
  // Raised 36,000 -> 37,000 (2026-09-17, same day): the registry-reap +
  // claim-latency entries (reapBusRegistry, test-env-scrub session markers)
  // pushed it to 36,409 — same class, same day, documented.
  // Raised 37,000 -> 43,000 (2026-09-20, router-as-orchestrator wave WP-6):
  // the wave landed 7 legitimate rows (availability.ts NEW, classifier/
  // policy-table/router/context-reader/ledger/typesafe-client extensions)
  // taking it to 42,210 — same raise-class, trim inside AUTO markers is
  // futile; the durable fix stays the split pa-lib.md's header names.
  'pa-lib.md': {
    budget: 43_000,
    since: '2026-09-20',
    justification:
      'auto-managed glob-derived inventory — router-as-orchestrator wave landed 7 legitimate rows (42,210); raise-class per doctrine, never a trim',
  },
  // Budget raised to 110,000 for placement-registry.md only (2026-09-03,
  // placement wave-1): it is an every-item-exactly-once census index — 263
  // 12-column machine-checkable rows validated by the placement
  // completeness checker (A1-A9), the raise-class per this file's own trim
  // doctrine. Splitting it would break the checker's single-file contract;
  // growth is bounded by census re-gates (~4 bytes/char per row), not prose
  // drift. Raised 110,000 -> 130,000 (2026-09-10): measured file was
  // 109,961 chars, 39 chars under budget with no split shipped yet — the
  // next registry row from any session would have gone red with no
  // warning. The raise buys headroom only; the split (tracked in
  // BACKLOG.md) is still the durable fix.
  'placement-registry.md': {
    budget: 130_000,
    since: '2026-09-10',
    justification:
      'every-item-exactly-once census index validated by the placement checker; splitting breaks its single-file contract; raise buys headroom toward the tracked split',
  },
};

/** All budgeted docs as repo-relative forward-slash paths — the exact set
 *  both arms cover. Scoped invocations (`pa docs-lint -- <paths>`) filter
 *  this list; a named path outside it simply carries no budget. */
export function budgetedDocFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const push = (abs: string) => {
    if (existsSync(abs)) files.push(relative(repoRoot, abs).split('\\').join('/'));
  };
  const docsDir = join(repoRoot, 'docs');
  push(join(repoRoot, 'CLAUDE.md'));
  push(join(repoRoot, 'pa', 'CLAUDE.md'));
  push(join(repoRoot, 'FILE_INVENTORY.md'));
  push(join(repoRoot, 'BACKLOG.md'));
  push(join(repoRoot, 'backlog', 'completed-index.md'));
  const backlogDir2 = join(repoRoot, 'backlog');
  if (existsSync(backlogDir2)) {
    for (const f of readdirSync(backlogDir2).filter((f) => /^open-.+\.md$/.test(f)).sort()) push(join(backlogDir2, f));
  }
  const projectsDir = join(repoRoot, 'projects');
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) push(join(projectsDir, entry.name, 'CLAUDE.md'));
    }
  }
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir).filter((f) => f.endsWith('.md'))) push(join(docsDir, f));
  }
  const inventoryDir = join(repoRoot, 'inventory');
  if (existsSync(inventoryDir)) {
    for (const f of readdirSync(inventoryDir).filter((f) => f.endsWith('.md'))) push(join(inventoryDir, f));
  }
  return files;
}

/** Normalize a caller-supplied path to this module's repo-relative
 *  forward-slash spelling (absolute paths under repoRoot are re-relativized;
 *  a leading ./ is dropped). */
export function normalizeDocPath(repoRoot: string, p: string): string {
  let s = p.split('\\').join('/');
  if (s.startsWith('./')) s = s.slice(2);
  const rootFwd = repoRoot.split('\\').join('/').replace(/\/+$/, '');
  if (s.startsWith(rootFwd + '/')) s = s.slice(rootFwd.length + 1);
  return s;
}

/**
 * The size-budget arm: every budgeted doc at/over its gate yields one
 * failure whose message matches the test suite's historical wording.
 * `only` (repo-relative paths) restricts the check to a landing's own file
 * set — the commit-skill/wave-landing call shape; omitted = the full
 * budgeted set, the post-wave/orchestrator shape.
 */
export function docBudgetFailures(repoRoot: string, only?: string[]): DocBudgetFailure[] {
  const wanted = only ? new Set(only.map((p) => normalizeDocPath(repoRoot, p))) : null;
  const failures: DocBudgetFailure[] = [];
  const check = (rel: string, content: string | null, budget: number, message: (len: number) => string) => {
    if (wanted && !wanted.has(rel)) return;
    if (content === null) return; // absent in the public mirror
    const len = budgetChars(content);
    if (len > budget) failures.push({ file: rel, chars: len, budget, message: message(len) });
  };
  const read = (rel: string) =>
    existsSync(join(repoRoot, rel)) ? readFileSync(join(repoRoot, rel), 'utf8') : null;

  check('CLAUDE.md', read('CLAUDE.md'), ROOT_CLAUDE_BUDGET, (len) =>
    `CLAUDE.md is ${len} chars, over the ${ROOT_CLAUDE_BUDGET.toLocaleString()}-char hard budget -- run /shorten-brain`);

  check('pa/CLAUDE.md', read('pa/CLAUDE.md'), PA_CLAUDE_BUDGET, (len) =>
    `pa/CLAUDE.md is ${len} chars, over its ${PA_CLAUDE_BUDGET.toLocaleString()}-char budget -- read docs/pa-*.md pointers or extract a new topic file`);

  check('FILE_INVENTORY.md', read('FILE_INVENTORY.md'), FILE_INVENTORY_BUDGET, (len) =>
    `FILE_INVENTORY.md is ${len} chars, over the ${FILE_INVENTORY_BUDGET.toLocaleString()}-char router budget -- it has stopped being a router, re-split`);

  check('BACKLOG.md', read('BACKLOG.md'), BACKLOG_ROUTER_BUDGET, (len) =>
    `BACKLOG.md is ${len} chars, over the ${BACKLOG_ROUTER_BUDGET.toLocaleString()}-char router budget -- it has stopped being a router; open items belong in backlog/open-*.md`);

  check('backlog/completed-index.md', read('backlog/completed-index.md'), COMPLETED_INDEX_BUDGET, (len) =>
    `backlog/completed-index.md is ${len} chars, over the ${COMPLETED_INDEX_BUDGET.toLocaleString()}-char budget -- it's a lookup table, not an archive, and should stay scannable`);

  // backlog/open-*.md — the section files. Glob-class (E1): every file present
  // gets the same section budget; absent files (public mirror, pre-migration)
  // simply aren't listed.
  const backlogDir = join(repoRoot, 'backlog');
  if (existsSync(backlogDir)) {
    for (const f of readdirSync(backlogDir).filter((f) => /^open-.+\.md$/.test(f)).sort()) {
      check(`backlog/${f}`, read(`backlog/${f}`), BACKLOG_SECTION_BUDGET, (len) =>
        `backlog/${f} is ${len} chars, over its ${BACKLOG_SECTION_BUDGET.toLocaleString()}-char section budget -- archive DONE items to backlog/completed-<date>.md`);
    }
  }

  const projectsDir = join(repoRoot, 'projects');
  if (existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `projects/${entry.name}/CLAUDE.md`;
      const abs = join(projectsDir, entry.name, 'CLAUDE.md');
      const budget = PROJECT_CLAUDE_BUDGETS[entry.name]?.budget ?? PROJECT_CLAUDE_DEFAULT_BUDGET;
      check(rel, existsSync(abs) ? readFileSync(abs, 'utf8') : null, budget, (len) =>
        `${abs} is ${len} chars, over the ${budget}-char budget`);
    }
  }

  const docsDir = join(repoRoot, 'docs');
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir).filter((f) => f.endsWith('.md'))) {
      // Evergreen guides are ALL-CAPS-before-the-dot (BOT_GUIDE.md,
      // CONFIGURATION.md); extracted operational-detail files are
      // lowercase-hyphen (repo-topology.md). Named raises live in
      // DOCS_FILE_BUDGETS with their recorded justifications.
      const isEvergreenGuide = /^[A-Z][A-Z0-9_]*\.md$/.test(f);
      const budget =
        DOCS_FILE_BUDGETS[f]?.budget ?? (isEvergreenGuide ? DOCS_EVERGREEN_BUDGET : DOCS_DEFAULT_BUDGET);
      check(`docs/${f}`, readFileSync(join(docsDir, f), 'utf8'), budget, (len) =>
        `docs/${f} is ${len} chars, over its ${budget.toLocaleString()}-char budget`);
    }
  }

  const inventoryDir = join(repoRoot, 'inventory');
  if (existsSync(inventoryDir)) {
    for (const f of readdirSync(inventoryDir).filter((f) => f.endsWith('.md'))) {
      const content = readFileSync(join(inventoryDir, f), 'utf8');
      // AUTO:FILE-INVENTORY-* marker pair = the auto-managed glob-derived
      // class; named per-file raises live in INVENTORY_FILE_BUDGETS.
      const isAutoManaged = content.includes('<!-- AUTO:FILE-INVENTORY-');
      const budget =
        INVENTORY_FILE_BUDGETS[f]?.budget ??
        (isAutoManaged ? INVENTORY_AUTO_BUDGET : INVENTORY_DEFAULT_BUDGET);
      check(`inventory/${f}`, content, budget, (len) =>
        `inventory/${f} is ${len} chars, over its ${budget.toLocaleString()}-char budget`);
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Arm 2: budget-pressure doctrine — same-file-trim counter (operator
// directive 2026-09-03, docs/CONVENTIONS.md § "Brain-file organization").
// The doctrine clause: "never trim the same file twice in a day — the
// second trim triggers a contract-look, and the contract picks the
// response"; its last line names this checker as the mechanical
// enforcement ("docs-lint's same-file-trim counter"). Coverage is exactly
// the files the size-budget arm covers.
//
// Discriminator: one `git log --numstat --reverse` invocation per budgeted
// file; a commit is a TRIM iff its summed deletions exceed its summed
// additions (net-negative line delta = the file got smaller). Raises
// (net-positive) and balanced mechanical moves never qualify, whatever the
// churn volume. Each trim candidate additionally gets one memoized
// `git show --name-status` probe (commitMdStatus), read by TWO split arms: a
// candidate that CREATES a .md file, or one that carries an A/M row on the
// trimmed file's documented COMPANION_DOCS (the relocation landed in a doc
// that already existed, so there is no `A` status to see — the 2026-09-14
// bot-CLAUDE shape). Either is a split and resets the counter instead of
// counting.
//
// Window: the doctrine's own landing commit is the rule's effective date —
// the rule cannot forbid the six-trim night that motivated it, and without
// this anchor the counter's very first suite run would fail on exactly that
// pre-doctrine history. In steady state (doctrine older than 24h ago) the
// anchor is older than now-24h and the window is the plain last 24h. No file
// is exempt; this is when the rule came into force, not a carve-out. When
// the marker is absent from this checkout's history (public mirror before
// its next sync, shallow checkout) the plain 24h window applies.
// ---------------------------------------------------------------------------

export const TRIM_DOCTRINE_REF =
  'docs/CONVENTIONS.md § "Brain-file organization" — Budget-pressure doctrine (operator directive 2026-09-03)';
export const TRIM_DOCTRINE_CLAUSE =
  'never trim the same file twice in a day — the second trim triggers a contract-look, and the contract picks the response';
export const TRIM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TRIM_COMMIT_LIMIT = 2; // fail at >= 2 trim commits inside the window
const DOCTRINE_MARKER = 'Budget-pressure doctrine';

// The doctrine's split remedy relocates content "at the natural fault line"
// into a companion doc. When that doc ALREADY exists the commit carries no
// `A` status, so recognition needs the destination named. Exact paths, per
// budgeted file (repo-relative, forward-slash keys — budgetedDocFiles()'s
// spelling). Extend this map with a documented precedent, never widen the
// match: an unrelated .md edit riding the same commit must not earn the
// reset, and a split to a NEW companion needs no row here (the A-status arm
// already sees it).
export const COMPANION_DOCS: Record<string, string[]> = {
  'projects/telegram-bot/CLAUDE.md': [
    // 2026-09-14 regrowth trim: the 8th test rule -> bot-test-rules.md, the
    // mutation-pass detail -> bot-incident-records.md (both M rows, same commit).
    'docs/bot-test-rules.md',
    'docs/bot-incident-records.md',
    'projects/telegram-bot/VOICE-INBOX-BRIDGE.md',
  ],
  'projects/voice-inbox/CLAUDE.md': [
    // 2026-09-07 CONTRACTS split; 2026-09-14 regrowth trim -> FEATURE-NOTES.md.
    'projects/voice-inbox/CONTRACTS.md',
    'projects/voice-inbox/FEATURE-NOTES.md',
  ],
};

// Prefix companions: documented relocation targets whose paths carry a date —
// an exact-path row would rot daily. Kept separate from COMPANION_DOCS so that
// map's exact-path rule stays literal; each prefix here is still a documented
// precedent, never a wildcard.
export const COMPANION_PREFIXES: Record<string, string[]> = {
  'BACKLOG.md': [
    // The backlog-drain convention IS this file's documented split: DONE items
    // relocate verbatim to backlog/completed-<IST-date>.md (the drain job's own
    // header names this exemption; BACKLOG.md's footer and the size checker's
    // "move more DONE items to backlog/" remedy document it). A first-of-day
    // drain shows an A row; same-day follow-up drains carry M rows on the
    // existing dated file (live shape: f4c808a + 38733fa, 2026-09-14).
    'backlog/completed-',
    // 'backlog/open-' (2026-09-18, AI-316): a router trim that relocates into a
    // section file reads as a split (counter reset), not a trim.
    'backlog/open-',
  ],
};

// ---------------------------------------------------------------------------
// Arm 3: user-facing jargon blocklist (Wave C WP-C5, AI-264, 2026-09-17).
// The spec's code block binds: the lexicon is exactly the tokens listed in
// plans/2026-09-17-public-install-package-WAVE-C-SPEC.md §WP-C5, scope is
// only sections the author marked user-facing via
// `<!-- user-facing -->` ... `<!-- /user-facing -->` HTML-comment fences
// (agent-facing sections are exempt), and every hit is a finding with rule
// tag `J1`. Invocation/exit contract lives in commands/docs-lint.ts:
// `pa docs-lint --jargon <file>` — exit 1 on ANY J1 finding, exit 0 clean,
// exit 2 usage. A second jargon checker anywhere is a defect; extend this
// file (the header's one-implementation mandate covers every arm).
// ---------------------------------------------------------------------------

/** The blocklist lexicon — exactly the spec §WP-C5 mechanism-block tokens.
 *  Matched case-insensitively on word boundaries (`\bconfig\b` does not
 *  match "configuration", by design: agent-facing prose may name the
 *  category without being user-facing text). Extend only by spec amendment,
 *  never ad hoc. */
export const JARGON_LEXICON: string[] = [
  'claude', 'codex', 'npm', 'git', 'config', 'env', 'path', 'repo', 'clone',
  'build', 'deploy', 'API key', 'token', 'MCP', 'hook', 'YAML', 'scheduler',
];

const USER_FACING_OPEN = '<!-- user-facing -->';
const USER_FACING_CLOSE = '<!-- /user-facing -->';

export interface JargonFinding {
  /** Repo-relative or caller-supplied path the content came from. */
  file: string;
  /** 1-based line number of the hit. */
  line: number;
  /** The lexicon token that matched. */
  term: string;
  /** The full finding line, matching the test-suite messages verbatim. */
  message: string;
}

/** The J1 message shape the CLI prints and the tests assert verbatim. */
export function jargonFindingMessage(f: Omit<JargonFinding, 'message'>): string {
  return `J1: ${f.file}:${f.line}: user-facing jargon "${f.term}" — rewrite in plain language (docs/CONVENTIONS.md § "Jargon gate")`;
}

/**
 * The jargon arm: extract the `<!-- user-facing -->` fenced regions of
 * `content` and return one J1 finding per lexicon hit inside them. A file
 * with no fences yields no findings (agent-facing files are exempt by
 * construction); an unclosed fence runs to end-of-file (the gate must not
 * go silent because an author forgot the closer).
 */
export function jargonFindings(file: string, content: string): JargonFinding[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const findings: JargonFinding[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(USER_FACING_CLOSE)) {
      inFence = false;
      continue;
    }
    if (line.includes(USER_FACING_OPEN)) {
      inFence = true;
      // A hit on the marker line itself cannot exist (the marker is the
      // only thing this line may carry — the fence is HTML-comment text);
      // keep scanning from the next line.
      continue;
    }
    if (!inFence) continue;
    for (const term of JARGON_LEXICON) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'i');
      if (re.test(line)) {
        findings.push({ file, line: i + 1, term, message: jargonFindingMessage({ file, line: i + 1, term }) });
      }
      // Multiword entries and word-boundary overlap: "API key" can share a
      // line with a bare "token"; no dedup needed — one finding per
      // (line, term) pair is the contract.
    }
  }
  return findings;
}

const execFileP = promisify(execFile);

export async function gitLog(repoRoot: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd: repoRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return String(stdout);
}

const doctrineAnchorCache = new Map<string, string | null>();

/**
 * The doctrine's landing commit time (ISO), or null when this checkout's
 * history doesn't carry it. ONE git invocation, memoized per process AND
 * per repoRoot — the fixture-repo tests run several roots through this in
 * one process, so a single global memo would leak the real repo's anchor
 * into fixture scans.
 */
export function doctrineAnchorIso(repoRoot: string): Promise<string | null> {
  const cached = doctrineAnchorCache.get(repoRoot);
  if (cached !== undefined) return Promise.resolve(cached);
  return gitLog(repoRoot, [
    'log',
    `-S${DOCTRINE_MARKER}`,
    '--format=%cI',
    '-1',
    '--',
    'docs/CONVENTIONS.md',
  ])
    .then((out) => {
      const iso = out.trim().split(/\r?\n/)[0]?.trim() ?? '';
      const anchor = iso ? new Date(iso).toISOString() : null;
      doctrineAnchorCache.set(repoRoot, anchor);
      return anchor;
    })
    .catch(() => {
      // Not a repo / git missing / marker absent: the plain window applies,
      // and the per-file lookups below fail closed with a clear message.
      doctrineAnchorCache.set(repoRoot, null);
      return null;
    });
}

export interface TrimScan {
  file: string;
  trimCount: number;
  trimShas: string[];
}

/**
 * Memoized per repoRoot+sha: the commit's raw `git show --name-status` rows
 * over `*.md`. ONE probe serves both split arms — creation (statusAddsDoc)
 * and relocation into an existing companion (statusTouchesPath).
 */
const mdStatusCache = new Map<string, string>();

async function commitMdStatus(repoRoot: string, sha: string): Promise<string> {
  // `git log --numstat` cannot see file creation: a created file shows a plain
  // `added<TAB>0<TAB>path` row, byte-identical to a modify that only adds lines
  // (the `-`-marker form is --stat's, and binary files'.) The truth is one
  // name-status probe per trim candidate.
  const key = `${repoRoot}\n${sha}`;
  const cached = mdStatusCache.get(key);
  if (cached !== undefined) return cached;
  const out = await gitLog(repoRoot, ['show', '--name-status', '--format=', sha, '--', '*.md']);
  mdStatusCache.set(key, out);
  return out;
}

/** A created `.md` file: a name-status `A` row (the create-a-new-doc split arm). */
function statusAddsDoc(status: string): boolean {
  return status.split(/\r?\n/).some((line) => /^A\t.*\.md/.test(line));
}

/**
 * An `A`/`M` row whose final path field is exactly `path` — content was
 * created at or modified in that doc by this commit (the relocate-into-an-
 * existing-companion split arm). Renames (`R100<TAB>old<TAB>new`) only match
 * on their destination field; a `D` deliberately does not count — a companion
 * deleted alongside a trim is not a relocation INTO it.
 */
function statusTouchesPath(status: string, path: string): boolean {
  return status
    .split(/\r?\n/)
    .some((line) => {
      const fields = line.split('\t');
      return (fields[0] === 'A' || fields[0] === 'M') && fields[fields.length - 1] === path;
    });
}

/**
 * Same row shape as statusTouchesPath but matched on a path PREFIX — for
 * companions whose names carry a date (`backlog/completed-<date>.md`). All
 * rows are already `*.md`-filtered by the commitMdStatus probe.
 */
function statusTouchesPrefix(status: string, prefix: string): boolean {
  return status
    .split(/\r?\n/)
    .some((line) => {
      const fields = line.split('\t');
      return (fields[0] === 'A' || fields[0] === 'M') && fields[fields.length - 1].startsWith(prefix);
    });
}

/**
 * ONE `git log --numstat --reverse` per file: `%H` lines delimit commits;
 * numstat lines (`added<TAB>deleted<TAB>path`, `-` for binary) accumulate per
 * commit, streamed OLDEST-FIRST (--reverse) so a split's reset clears exactly
 * the trims that accumulated before it — in git log's default newest-first
 * order the reset would fire before anything accumulated and wipe the wrong
 * end (the live window's split, 48929c4, is its newest trim). A commit counts
 * as a trim iff deleted > added — except a split (both arms in the loop
 * below), which resets the counter instead of counting.
 */
export async function findTrimCommits(repoRoot: string, file: string, sinceIso: string): Promise<TrimScan> {
  const out = await gitLog(repoRoot, [
    'log',
    `--since=${sinceIso}`,
    '--reverse',
    '--numstat',
    '--format=%H',
    '--',
    file,
  ]);
  const commits: Array<{ sha: string; added: number; deleted: number }> = [];
  let currentSha: string | null = null;
  let added = 0;
  let deleted = 0;
  const flush = () => {
    if (currentSha !== null) commits.push({ sha: currentSha, added, deleted });
    currentSha = null;
  };
  for (const line of out.split(/\r?\n/)) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      flush();
      currentSha = line;
      added = 0;
      deleted = 0;
      continue;
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (m && currentSha !== null) {
      added += m[1] === '-' ? 0 : Number(m[1]);
      deleted += m[2] === '-' ? 0 : Number(m[2]);
    }
  }
  flush();

  let trimCount = 0;
  const trimShas: string[] = [];
  const companions = COMPANION_DOCS[file];
  const companionPrefixes = COMPANION_PREFIXES[file];
  for (const { sha, added: a, deleted: d } of commits) {
    if (d <= a) continue;
    // Split recognition (doctrine amendment 2026-09-03; companion arm added
    // 2026-09-14): a net-negative commit executing the doctrine's own
    // split-or-raise remedy is not a trim — its deletions moved to a
    // companion doc and the file's contract changed. Reset the counter:
    // pre-split trims don't count against the post-split file. Two
    // mechanical shapes qualify, both read off one memoized name-status
    // probe: the commit CREATES a new .md (destination didn't exist), or it
    // carries an A/M row on one of the file's documented COMPANION_DOCS
    // (destination already existed — live shape: the 2026-09-14 bot/vi
    // regrowth trim whose -6/-14 net traveled with M rows on
    // bot-test-rules.md, bot-incident-records.md and FEATURE-NOTES.md).
    const status = await commitMdStatus(repoRoot, sha);
    const isSplit =
      statusAddsDoc(status) ||
      (companions ?? []).some((c) => statusTouchesPath(status, c)) ||
      (companionPrefixes ?? []).some((p) => statusTouchesPrefix(status, p));
    if (isSplit) {
      trimCount = 0;
      trimShas.length = 0;
      continue;
    }
    trimCount += 1;
    trimShas.push(sha);
  }
  return { file, trimCount, trimShas };
}

function trimFailureMessage(scan: TrimScan, windowStartIso: string): string {
  return [
    `${scan.file} was trimmed in ${scan.trimCount} commits within its 24h trim window (window started ${windowStartIso}; commits: ${scan.trimShas.join(', ')}).`,
    `${TRIM_DOCTRINE_REF}: "${TRIM_DOCTRINE_CLAUSE}".`,
    'Respond per this file\'s contract, not with a third trim: an auto-managed glob-derived inventory or an every-item-exactly-once index gets its documented ceiling RAISED; genuine prose/scope growth gets a SPLIT at the natural fault line.',
  ].join('\n');
}

/** All failing files (>= TRIM_COMMIT_LIMIT trims inside the window), message per file. */
export async function sameFileTrimFailures(repoRoot: string, files: string[], nowMs: number): Promise<string[]> {
  const anchor = await doctrineAnchorIso(repoRoot);
  const windowStartMs = Math.max(nowMs - TRIM_WINDOW_MS, anchor ? Date.parse(anchor) : Number.NEGATIVE_INFINITY);
  const sinceIso = new Date(windowStartMs).toISOString();
  const failures: string[] = [];
  for (const file of files) {
    let scan: TrimScan;
    try {
      scan = await findTrimCommits(repoRoot, file, sinceIso);
    } catch (err) {
      failures.push(
        `${file}: same-file-trim counter could not read git history (${String(err)}) — fix the environment; this check fails closed`
      );
      continue;
    }
    if (scan.trimCount >= TRIM_COMMIT_LIMIT) {
      failures.push(trimFailureMessage(scan, sinceIso));
    }
  }
  return failures;
}
