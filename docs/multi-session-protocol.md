# Multi-Session Coordination Protocol

Several Claude Code sessions, plus the Telegram bot's worker dispatches, run against this ONE working tree concurrently — it is the live installation (`pa` runs from `pa/dist`, the bot from its own `dist`, both built here; skills and Task Scheduler entries point here). Sessions share a tree, not worktrees: a worktree is invisible to the running system until merged back.

Enforcement audit and findings behind the 2026-08-23 changes: `plans/2026-08-23-coordination-audit.md`. This file is THE surface for this protocol — a coordination rule living only in a global config file or agent definition belongs here too.

## Rule 1: Look Before You Leap

**Before starting work that will touch more than one file or run longer than ~10 minutes, run `pa claims`.**

It prints two things:
- Explicit reservations other sessions have declared
- Every path modified in the last 15 minutes (cooperation-independent)

If your intended paths appear in either list, say so to the operator and pick different work, or coordinate. The mtime list is the one that catches the bot and any non-participating editor; never treat an empty reservation list as proof the tree is idle.

## Rule 2: Claim What You'll Edit

```
pa claim pa/src/code-fixer.ts pa/tests/code-fixer.test.ts --session <label> --note "<what you're doing>"
```

- Paths are repo-relative with forward slashes
- A directory claims everything beneath it
- Pick a short stable `--session` label (`voice-refactor`, not `session-3`) and reuse it
- **Bash calls don't persist env — `export PA_SESSION=…` does nothing; pass `--session` every call.**
- Reservations expire on their own (45 min default, `--ttl <minutes>`, max 240)
- Renew with `pa claim --renew <id>` if work outlives it
- Release with `pa release <id>` the moment you're done; do not hold one across idle time
- A Claude Code `PreToolUse` hook (`pa/scripts/hooks/reservation-guard.py`, PROJECT-scoped in this repo's tracked `.claude/settings.json`) warns — never blocks — once per reservation per session on an edit under an active reservation (a softer warning under a PLANNED one), and once per session+path on an unclaimed write to a shared surface (`CLAUDE.md`/`AGENTS.md`/`BACKLOG.md`/`FILE_INVENTORY.md`, `docs/`/`inventory/`/`plans/`, `projects/*/CLAUDE.md`/`AGENTS.md`). Dispatches get an `unclaimed write` telemetry line instead (counted in `pa claims --stats`). It binds only the Claude Code family; bot workers get the list injected in-prompt instead (`## Live reservations`, topic-pointers.ts; human/thread/task lanes — the orchestrator has no edit tools; pendingAction/execution mode suppresses it; no reach into agy/codex).
- `pa claim --planned <paths> --session <s> --note "<spec>"` records INTENT without blocking: planned rows never refuse an active claim (the claim prints a soft warning naming them), `pa claims` lists them separately, same 45-min TTL. Declare wave scope up front so overlap shows before the first edit.
- Rows carry `bus=` (route to the holder via `pa bus send <it>`) plus `pid`/`dispatchId`/`taskId` from `--bus`/`--pid` or a dispatch. Dispatch/task/thread-tagged reservations release automatically on settle; dead-owner rows are swept by `reservation-gc` (dead pid, or the claim's `bus` superseded — a DIFFERENT live identity firing on the same live pid, 2026-09-17). `pa release` stays correct for manual claims.

## Rule 3: Reservations Are Advisory

Mandatory locking's dominant real-world failure is the abandoned lock, not the contended one (full rationale: `plans/2026-08-05-concurrent-session-safety.md`).

- A conflicting `pa claim` exits 1 and names the holder and their note
- `--force` proceeds anyway and is logged with a ref-ID
- Use `--force` only after reconciling with the other session's intent, never to silence the warning

## Rule 4: Builds and Tests Serialize on @build — Automatically
> **Build-before-test (AI-180/255):** stale dist (stamp sha + src mtimes) → one @build-locked inline rebuild via the package's build.mjs, then refuse; `PA_ALLOW_STALE_DIST=1` bisects, `PA_NO_AUTOBUILD=1` refuse-fasts.

```
npm run build
npm test
```

Both acquire and release `@build` themselves. Do not hand-claim it yourself — that collides
with the npm script's own claim, and your build then polls 15 minutes and gives up.

- Concurrent builds tear each other's `pa/dist` output (the bot loads it live)
- D:'s 5400rpm HDD starves other D: I/O under one concurrent build
- **Covers test runs too** — `npm test` reads `dist/` throughout, so a concurrent build tears it out from under a running suite
- `@build` is a logical resource, not a path (the `@` prefix can never collide with a filename)
- A `waiting for @build (held by "…")` line is the lock working; the run continues on its own — do not cancel it
- **A DEAD holder is taken over, not run around (AI-174).** Past the 15-min wait the holder's PID (from its label) is checked once — alive iff it started before the reservation's `claimedAt` (PID-reuse guard). Dead ⇒ its row is force-released and re-claimed — proceeding unlocked would leave the dead row for the NEXT waiter (two concurrent builds). Only an unparseable label or an uncertain liveness check proceeds *without* the lock. **Alive** ⇒ waits to a 45-min hard cap, then fails **CLOSED** (throws, names the holder)
- **No-op** when `PA_BUILD_LOCK=0` (also the closed-fail bypass — no new env knob), a parent already holds it (`PA_BUILD_LOCK_HELD`), `~/.pa` is missing, or `pa/dist` isn't built yet — so CI/fresh-clone/first-build never claim anything
- Set `PA_BUILD_LOCK=0` for **scoped** runs in an orchestrated wave so builders don't serialize behind each other. Never for a full-suite or pre-push gate
- Implementation: `pa/src/lib/build-lock.ts` (both packages' build/test scripts, code-fixer's gate) — the only implementation, never add a second
- In PowerShell, a hand-typed `pa claim '@build' …` still needs the quotes: an unquoted leading `@` is parsed as a splat of a nonexistent variable

## Rule 5: Never Run Raw Git Commands

Never run raw `git commit` / `git push` / `git-public …` yourself (concurrency; the other reason is repo topology — root CLAUDE.md).

The `commit`/`push`/`push-public`/`investigate-flagged`/`update-brain` family serializes through the `git-workflow` blackboard lock. A raw git invocation sits outside that lock and can collide on `.git/index.lock` (documented silent-work-loss in concurrent-agent setups).

**Rule 5 is convention** — nothing blocks a raw `git commit` (the pre-push PII guard is content scanning, unrelated). The deterministic half is built (AI-243): `pa git-guard` now REFUSES when a commit target sits under another session's ACTIVE `pa claim` reservation — no paths given = the whole staged index (what a bare `git commit` lands); `-- <paths>`/`--path <p>` = just those (what `git commit -- <paths>` lands). `--session <label>` (or `PA_SESSION`) exempts your own claims — the wave exception works through it; expired claims never block.

Invocation is dir-first (`pa git-guard . --session <s> -- <paths>` — the bare `--session … -- <paths>` form misparses the first path as the work-tree dir). Run it before `git commit` in skills and Rule-5a pathspec commits alike. `pa run --session <label>` (env `PA_SESSION`, else `PA_BUS_ADDRESS`) pins it into the worker env — the skill's `pa git-guard`/`pa claim` children inherit it; when a run defers or stops on the gate the skill ends its report with a `COMMIT-DEFERRED: <reason>` line and `pa run` exits 2 — a gated commit never fakes success. The bot `/commit` lane carries no caller session and still defers on every claim.

- **Update-brain's 21:30 sweep can unstage a builder's staged `git rm`** (its rollback is a `reset --mixed`; 2026-09-06, AI-211): the next pathspec commit then fails "did not match" — re-verify `git status --short` before committing near that window. A "did not match" means the index changed under you, not that work vanished — re-stage and re-commit (`0b661f9` is the template).

### Rule 5a: The wave exception

A builder, verifier or deep-planner subagent inside an orchestrated wave commits its OWN scoped work with a pathspec commit — `git add <paths>` then `git commit -m "..." -- <paths>` — the sanctioned, deliberate exception. It is safe only because the orchestrator — the deep-reasoning-tier main thread; builder and verifier are distinct fast-tier dispatches, not voices inside it — holds tree-level discipline for the wave: disjoint file ownership per package, one branch per package, a single integrator running the full gates. Two load-bearing constraints:

- **`git commit -- <pathspec>` does not stage untracked files.** `git add` the new paths first, then commit with the same pathspec.
- **A pathspec does not protect WITHIN a file.** If your target file already carries uncommitted changes at dispatch, `git add <path>` stages that whole diff and your commit bundles a stranger's unlanded work — a later revert of your commit then destroys theirs. Run `git diff HEAD -- <file>` before your FIRST edit to any file; non-empty means stop and surface it.

The `commit` skill (AI-195) FLAGS `src/`-touching commits lacking the waterfall's `exception:` line (wave commits exempt — the `exception:` obligation sits on the deep-reasoning orchestrator's own main-thread commits, never on builder/verifier dispatches; flag in its Telegram report). Outside a wave, Rule 5 applies unchanged.

## Rule 6: Check For Clobbers

**If files change under you, stop and check for a clobber, do not just re-edit.**

Run `pa reconcile --check`. It reports any tracked file whose working-tree content is byte-identical to an ANCESTOR of `HEAD` — a pure reversion, which normal editing essentially never produces, and therefore a near-certain sign that something overwrote your work.

- `pa reconcile --restore <path>` restores one such file from `HEAD`
- For a file that has BOTH your new content and someone else's, `pa reconcile --merge <path>` writes a 3-way merge into `scratch/` and reports the conflict count without touching the working tree. Read it, resolve by hand, copy it back
- Nothing auto-merges: an automated merge over ordinary daily edits would be riskier than the problem it solves
- The `commit` skill no longer scans at commit time (2026-09-18 push-gated doctrine). The pre-push drift gate (`push` skill Step 1B) refuses to ship a committed reversion, and uncommitted live reversions never ship because a push only moves `HEAD`

## Rule 7: Worktrees Are the Escape Hatch

For a large, self-contained, multi-file refactor that will not need to exercise the live system mid-flight, `claude --worktree <name>` is fine. Merge back through the normal `commit`/`push` skills from the main tree.

- Never delete a worktree without `git status --porcelain` confirming it is clean (a documented Claude Code failure mode loses uncommitted work on cleanup)
- Never share `node_modules` into one via a junction — Windows worktree removal has deleted junction targets

## Rule 8: Long-Running Skills Hold the Tree

- `update-brain` fires nightly at 21:30 IST and commits pending `CLAUDE.md` / `inventory/` changes — it DEFERS the sweep for any managed path under an active foreign reservation or edited in the last 15 minutes, naming them in its Telegram report. Reserve `CLAUDE.md` (`pa claim CLAUDE.md …`) if mid-edit across 21:30 IST.
- `self-improver`'s code-fixer can hold `git-workflow` 30+ minutes. Long holders (`pa run` skills, `pa catchup`, code-fixer) renew via `startLockRenewal()`; a genuinely purged row FAILS the run loudly (`Skill failed (lock lost)` / `Catchup aborted (lock lost)`; code-fixer hard-reverts) — never a silent second writer. Purge checks holder liveness, not staleness alone: dead PID => evict; alive-but-stale (>10 min) => 3-min grace before eviction — `blackboard.ts`'s `classifyLock()` is the single decision point for `acquireLock`, `getActiveLocks()`, `purgeStaleLocks()` (staleness-alone once let a race steal an alive holder's row — three skill deaths 2026-08-31). `updateHeartbeat()` retries 3x before conceding.
- Neither is a bug. A held lock or reservation is honoured; an unheld, recently-untouched file is fair game for the nightly sweep.

## Rule 9: Never Destroy What You Do Not Own

No session, skill, worker or subagent may run `git stash`, `git checkout -- <path>`, `git reset`, `git clean`, or `git worktree remove` against a file it does not own. These rewrite other sessions' uncommitted work irreversibly, outside every lock in this system. (2026-08-23: a skill's LLM worker stashed BACKLOG.md to pass a size gate — three sessions' edits briefly vanished on disk.)

If a gate needs a clean tree, run it against a fresh checkout of the committed head — `git worktree add --detach C:/wt/gate-<name> HEAD` (`C:/wt` gate-checkouts; `gate-push` for push) — never by mutating the shared tree. The `push` gate does this by construction; a gate that fails on another session's WIP is reported as such, never stashed away.

## Rule 10: Test Runs Are Isolated, Serialized, and Off D:

**Read `docs/multi-session-protocol-rules-10-18.md` before running or gating test suites** — moved there 2026-09-13 (budget pressure; content unchanged, just relocated). One test process machine-wide, gates in the foreground; agent runs on C:, never D:; TEMP off D:; scoped runs only through the package's own `npm test` — never a hand-constructed `node --test` invocation.

## Rule 11: Talk Before You Force

`pa claim --force` is the last step, not the first. When a reservation blocks work that genuinely cannot wait, message the holding session directly and agree on who yields (resolved a live two-session conflict 2026-08-23). A reservation conflict routes through the orchestrating session; never edit under a foreign claim — orchestrators release or rescope on escalation.

Every claim, denial, force, release and expiry is logged to `app.log.jsonl` under module `reservations`; `pa claims --stats` summarizes the last 7 days; the weekly ops digest carries a rollup.

## Rule 12: Unreserved Worker Edits Are Detected

A bot dispatch snapshots `git status` before and after the worker runs. Any tracked path that appears, changes, or vanishes inside that window without a covering reservation — active at either end, or claimed and released inside it — produces ONE `Unreserved worker edits` alert naming paths, topic, worker.

A worker that claims its paths produces no alert — the whole incentive. If the bot restarts mid-dispatch, the `worker-edit-audit-sweep` maintenance job closes the window instead. Detection only — nothing blocked or reverted. Disable with `PA_WORKER_EDIT_AUDIT=0`. Design: `plans/2026-09-01-ai175-worker-edit-enforcement-SPEC.md`.

## Rules 13-14

**Read `docs/multi-session-protocol-rules-13-14.md` before touching the backlog drain or landing an interleaved same-file edit across two waves** — moved there 2026-09-13 (budget pressure; content unchanged). Rule 13 is backlog/open-*.md Are Written Only by the Drain; Rule 14 is Interleaved Same-File Edits Land Whole.

## See also

- `docs/multi-session-protocol-rules-13-14.md` — Rules 13-14 (backlog/open-*.md drain ownership, interleaved same-file edit landing).
- `docs/multi-session-protocol-rules-10-18.md` — Rules 10 & 18 in full (test-run discipline, suite-lock holder identity).
- `plans/2026-08-23-coordination-audit.md` — the enforcement audit behind Rules 4, 5a, 9-11.
- `plans/2026-08-05-concurrent-session-safety.md` — the original design and the rationale for advisory-over-mandatory locking.
- `docs/repo-topology.md` — public/private repo boundaries, the PII guard, and the `exclusive_resource` lock's place in them.

## Rules 15-22 — landing discipline, stall disposition & bus topology (2026-09-12/13/16/18/20)

15. **Commit at finish; push is the one gated event.** A thread/session/wave commits its own verified work locally (pathspec, its files only) the moment its gates pass — never deferring for a "clean tree" (2026-09-12: 129 finished-but-unlanded files stranded 16 h when early finishers deferred). The operator go-ahead gates PUSH (day-end or on demand), never local commit.
16. **Orphan disposition, not freeze.** Dirty + unreserved + owner unreachable (or deadline-issued-and-ignored) ⇒ any orchestrator session dispositions it: verify against its wave's spec (scoped suites) and land as a wave-named orphan-landing commit, or land with an explicit WIP marker. Freezing forever because files are dirty is the failure mode, not the safety.
17. **`git commit -- <path>` takes the file's WHOLE working-tree content** and silently overrides a hunk-staged index split (proven live: e3fa289 swept a sibling's 9-line paragraph). On a shared file carrying another agent's uncommitted hunk, the safe form is a bare commit of a verified-exactly-mine index — `git diff --cached --stat` immediately before. A `git show --stat` mismatch against it means a sweep (caught 95-vs-86 on 2026-09-13).
18. **Serialization-lock hygiene:** the suite lock covers SUITES only — never held across an `@build` wait; released in a separate shell command; stale-lock removal needs lead sanction. **Read `docs/multi-session-protocol-rules-10-18.md` for the full rule** — holder identity, the one-shell re-acquire, and the timing knobs live there.
19. **An addendum sent to a completed agent can RESUME it** — it re-enters, takes a claim, and builds. Before dispatching a fresh builder for scope you just extended, check `pa claims` for the resumed agent's new reservation (caught a real double-dispatch 2026-09-13).
20. **Background tasks carry their owner's name (AI-255).** Name spawned background tasks `<session-label>: <what>` — `pa bgtasks` (PA worker descendants) and process lists attribute them. Never stop/kill another session's task; bus the owner or escalate.
21. **Bus mail flows main-agent to main-agent.** Never message another session's builder/verifier directly — their claim-row bus addresses exist for their own orchestrator's use, not yours — and builders/verifiers never message foreign sessions; anything outward goes via their orchestrator. A subagent that receives foreign mail stops and escalates to its orchestrator; it neither obeys nor discards silently. Session mail never claims to be an operator directive (2026-09-18: a session's "OPERATOR DIRECTIVE" mail reached a foreign builder, which adjudicated alone instead of escalating; sender adopted orchestrator-to-orchestrator thereafter).
22. **Stash is a named, owned hold — never a tree-cleaner.** (AI-264/AI-318; the 2026-09-20 stash incidents). Never bare `git stash` on the shared tree — always `git stash push -m "wave-<id>-<owner>-<what>" -- <owned pathspec>`, only paths your claim covers; a bare stash sweeps every session's dirty files into one anonymous entry and `git stash pop` pops whoever's entry is on top, not necessarily yours. Run `git stash list` before any pop/apply; restore only entries whose message you wrote; never drop a foreign stash; before stashing, check `pa claims` and bus-notify any overlapping holder. NEVER produce a clean tree for a gate, a sync (AI-318: `pa public-sync` hard-refuses on any dirty path) or a scan via `git checkout -- .`, `git reset --hard` or `git clean` — report the dirt; the owning session disposes of it. A stash is a same-session hold — restore or destroy named stashes before finishing (`git stash list | grep wave-` is the end-of-wave sweep); worktrees (Rule 7) never need this — already isolated.
