# Multi-Session Coordination Protocol

Several Claude Code sessions, plus the Telegram bot's worker dispatches, run against this ONE working tree concurrently — this tree is the live installation (`pa` runs from `pa/dist` built here, the bot from its own `dist` here, skills and Task Scheduler entries point here). Sessions share a tree, not worktrees, because a worktree is invisible to the running system until merged back. Ask any long-running session for the rules not covered here.

Enforcement audit and the findings behind the 2026-08-23 changes: `plans/2026-08-23-coordination-audit.md`. This file is THE surface for this protocol — if a coordination rule lives only in a global config file or an agent definition, it belongs here too.

## Rule 1: Look Before You Leap

**Before starting work that will touch more than one file or run longer than ~10 minutes, run `pa claims`.**

It prints two things:
- Explicit reservations other sessions have declared
- Every path modified in the last 15 minutes (independent of anyone's cooperation)

If your intended paths appear in either list, say so to the operator and pick different work, or coordinate. The mtime list is the one that catches the bot and any non-participating editor; never treat an empty reservation list as proof the tree is idle.

## Rule 2: Claim What You'll Edit

```
pa claim pa/src/code-fixer.ts pa/tests/code-fixer.test.ts --session <label> --note "<what you're doing>"
```

- Paths are repo-relative with forward slashes
- A directory claims everything beneath it
- Pick a short stable `--session` label describing the work (`voice-refactor`, not `session-3`) and reuse it
- **Claude Code's Bash tool does not persist environment variables between calls, so `export PA_SESSION=…` silently does nothing; you must pass `--session` every time.**
- Reservations expire on their own (45 min default, `--ttl <minutes>`, max 240)
- Renew with `pa claim --renew <id>` if the work outlives it
- Release with `pa release <id>` the moment you are done; do not hold one across idle time
- A Claude Code `PreToolUse` hook warns (never blocks) when you edit a path under any active reservation, once per reservation per session: `pa/scripts/hooks/reservation-guard.py`, registered PROJECT-scoped in this repo's own tracked `.claude/settings.json` — so it applies to sessions in this project and its worktrees, and never fires while you work in another repo. It adds to your personal `~/.claude/settings.json` hooks rather than replacing them. It names the holder; if the reservation is yours, continue. It binds interactive sessions and subagents in the Claude Code family only — the bot's own workers get the same information injected into their prompt instead (Rule 2 has no reach into agy/codex, which is why C1b exists).

## Rule 3: Reservations Are Advisory

Mandatory locking's dominant real-world failure is the abandoned lock, not the contended one (full rationale: `plans/2026-08-05-concurrent-session-safety.md`).

- A conflicting `pa claim` exits 1 and names the holder and their note
- `--force` proceeds anyway and is logged with a ref-ID
- Use `--force` only after actually reconciling with the other session's intent, never to silence the warning

## Rule 4: Builds and Tests Serialize on @build — Automatically
> **Build-before-test is ENFORCED (AI-180):** runners fail closed on stale dist (stamp sha + src mtimes); `PA_ALLOW_STALE_DIST=1` is the bisect escape.

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
- A `waiting for @build (held by "…")` line is the lock working. The run continues by itself once the holder releases; do not cancel it
- **A DEAD holder is taken over, not run around (AI-174).** Past the 15-min wait, the holder's PID (from its label) is checked once — alive iff it started before the reservation's `claimedAt` (PID-reuse guard). Dead ⇒ its stale row is force-released and re-claimed, and your run holds the lock normally — proceeding unlocked instead would leave the dead row standing for the NEXT waiter too, running two builds concurrently. Only an unparseable label or an uncertain liveness check still proceeds *without* the lock. **Alive** ⇒ waits to a 45-min hard cap, then fails **CLOSED** (throws, names the holder)
- **No-op** when `PA_BUILD_LOCK=0` (also the closed-fail bypass — no new env knob), a parent already holds it (`PA_BUILD_LOCK_HELD`), `~/.pa` is missing, or `pa/dist` isn't built yet — so CI/fresh-clone/first-build never claim anything
- Set `PA_BUILD_LOCK=0` for **scoped** runs in an orchestrated wave so builders don't serialize behind each other. Never for a full-suite or pre-push gate
- Implementation: `pa/src/lib/build-lock.ts` (both packages' build/test scripts, code-fixer's gate) — the only implementation, never add a second
- In PowerShell, a hand-typed `pa claim '@build' …` still needs the quotes: an unquoted leading `@` is parsed as a splat of a nonexistent variable

## Rule 5: Never Run Raw Git Commands

Never run raw `git commit` / `git push` / `git-public …` yourself (concurrency; the other reason is repo topology — root CLAUDE.md).

The `commit`/`push`/`push-public`/`investigate-flagged`/`update-brain` family serializes through the `git-workflow` blackboard lock. A raw git invocation sits entirely outside that lock and can collide on `.git/index.lock` — a failure mode with documented silent work-loss behaviour in concurrent-agent setups.

**Rule 5 is convention** — nothing blocks a raw `git commit` (the pre-push PII guard is content scanning, unrelated); a reservation-refusing pre-commit hook is C1 in the audit, not built.

### Rule 5a: The wave exception

A builder, verifier or deep-planner subagent inside an orchestrated wave commits its OWN scoped work with a pathspec commit — `git add <paths>` then `git commit -m "..." -- <paths>` — and that is the sanctioned, deliberate exception. It is safe only because the orchestrator holds the tree-level discipline for the wave: disjoint file ownership per package, one branch per package, and a single integrator running the full gates. Two constraints make it safe and both are load-bearing:

- **`git commit -- <pathspec>` does not stage untracked files.** `git add` the new paths first, then commit with the same pathspec.
- **A pathspec does not protect WITHIN a file.** If your target file already carries uncommitted changes at dispatch, `git add <path>` stages that whole diff and your commit bundles a stranger's unlanded work — a later revert of your commit then destroys theirs. Run `git diff HEAD -- <file>` before your FIRST edit to any file; non-empty means stop and surface it.

The `commit` skill (AI-195) FLAGS `src/`-touching commits lacking the waterfall's `exception:` line (wave commits exempt; flag in its Telegram report). Outside a wave, Rule 5 applies unchanged.

## Rule 6: Check For Clobbers

**If files change under you, stop and check for a clobber, do not just re-edit.**

Run `pa reconcile --check`. It reports any tracked file whose working-tree content is byte-identical to an ANCESTOR of `HEAD` — a pure reversion, which normal editing essentially never produces, and therefore a near-certain sign that something overwrote your work.

- `pa reconcile --restore <path>` restores one such file from `HEAD`
- For a file that has BOTH your new content and someone else's, `pa reconcile --merge <path>` writes a 3-way merge into `scratch/` and reports the conflict count without touching the working tree — read it, resolve by hand, and copy it back yourself
- Nothing auto-merges: a merge engine running over ordinary daily edits would be more dangerous than the problem it solves
- The `commit` skill runs this check itself before staging anything (its Step 1) — a file it flags is excluded from that run's commit, not silently swept in

## Rule 7: Worktrees Are the Escape Hatch

For a large, self-contained, multi-file refactor that will not need to exercise the live system mid-flight, `claude --worktree <name>` is fine. Merge back through the normal `commit`/`push` skills from the main tree.

- Never delete a worktree without `git status --porcelain` confirming it is clean (a documented Claude Code failure mode loses uncommitted work on cleanup)
- Never share `node_modules` into one via a junction — Windows worktree removal has deleted junction targets

## Rule 8: Long-Running Skills Hold the Tree

- `update-brain` fires nightly at 21:30 IST and commits pending `CLAUDE.md` / `inventory/` changes — it DEFERS the sweep for any managed path under an active foreign reservation or edited in the last 15 minutes, naming them in its Telegram report. Reserve `CLAUDE.md` (`pa claim CLAUDE.md …`) if mid-edit across 21:30 IST.
- `self-improver`'s code-fixer can hold `git-workflow` 30+ minutes. Long holders (`pa run` skills, `pa catchup`, code-fixer) renew via `startLockRenewal()`; a genuinely purged row FAILS the run loudly (`Skill failed (lock lost)` / `Catchup aborted (lock lost)`, code-fixer hard-reverts) rather than continuing as a silent second writer. **Purge checks holder liveness, not staleness alone:** dead PID ⇒ purge immediately; alive-but-stale (>10 min, `PA_HEARTBEAT_STALE_MS`) ⇒ a grace window (3 min, `PA_HEARTBEAT_GRACE_MS`) before eviction — `blackboard.ts`'s `classifyLock()` is the single decision point for `acquireLock`'s purge, `getActiveLocks()`, and `purgeStaleLocks()` (fixed after staleness-alone let a race steal an alive holder's row — three skill deaths 2026-08-31). `updateHeartbeat()` also retries internally (3x) before conceding.
- Neither is a bug. A held lock or reservation is honoured; an unheld, recently-untouched file is fair game for the nightly sweep.

## Rule 9: Never Destroy What You Do Not Own

No session, skill, worker or subagent may run `git stash`, `git checkout -- <path>`, `git reset`, `git clean`, or `git worktree remove` against a file it does not own. These rewrite other sessions' uncommitted work irreversibly and outside every lock in this system.

On 2026-08-23 a skill's LLM worker ran `git stash push -m temp-stash-backlog BACKLOG.md` to make a size gate pass, popping it four minutes later — three sessions' edits were briefly invisible on disk, and nothing in the skill's text forbade it.

If a gate needs a clean tree, run the gate against a fresh checkout of the committed head — `git worktree add --detach C:/wt/gate-<name> HEAD`, where `C:/wt` is the deployment's gate-checkout root (`C:/wt/gate-push` for the push gate) — never by mutating the shared tree. The `push` gate does this by construction (Wave C): the whole gate runs in `C:/wt/gate-push`, a detached checkout of HEAD. A gate that fails because of another session's WIP is reported as such, never stashed away.

## Rule 10: Test Runs Are Isolated, Serialized, and Off D:

These rules lived in global machine notes until 2026-08-23; they are repo-operational, not machine trivia.

- **One test process on this machine at a time.** Gates run in the FOREGROUND, serialized. Never launch a suite in the background and move on — on 2026-08-15 a background 35-file run alongside two other agents' runs starved the machine to a hard hang.
- **Agent test runs belong on C:, never on D:.** `git worktree add --detach <gate-root>/<name> <sha>` — `<gate-root>` is the gate-checkout root (Rule 9) — gives a same-repo, zero-contention checkout in seconds (git objects stay in the D: `.git`). `git worktree remove` when done — but if you junctioned `node_modules` into the worktree, delete the junctions FIRST (`cmd /c rmdir <gate-root>\<name>\pa\node_modules`, same for the bot): `git worktree remove --force` follows a junction and empties the LIVE `node_modules` on D: (2026-08-23: both packages' modules were wiped for ~90 s and one `pa catchup` tick died; restored with `npm ci`). Prefer `npm ci` in the worktree (~35 s) over junctions; a `git worktree add` interrupted mid-checkout leaves a `locked: initializing` entry that only `git worktree remove -f -f <path>` clears.
- **Verify the worktree's base before trusting any gate.** A harness-created worktree can be cut from a stale ref: `git merge-base main <branch>` must equal current `main`, or the gate is measuring a different tree than you think.
- **Point TEMP at a fast-drive scratch dir for every test run:** `TMP=<scratch> TEMP=<scratch> npm test -- <file>`. The user TEMP directory lives on D:, so temp sqlite files fsync against the saturated HDD; a trivial test "hung" for 30+ minutes on 2026-08-15 and passed in 22 seconds with TEMP on C:. Both run-tests.mjs wrappers do this via `PA_TEST_TMP_DIR` (falling back to the deployment's conventional scratch dir if present).
- **Run a scoped test through the package's own `npm test`:** `npm test -- <file.test.js>` (added 2026-08-23; matches on basename, still preloads the safety file, still excludes quarantined files, exits 1 if nothing matched). **Never hand-construct a `node --test` invocation** — it skips the `--import test-env-setup.js` preload, so `PA_HOME` resolves to the real `~/.pa` from the file's first line. That leak sent 3 real Telegram alerts to production on 2026-08-17.
- A slow run under contention is reported as "unverified, I/O-starved" — never as evidence either way.
- `npm test` now takes `@build` itself (Rule 4), so a scoped run inside an orchestrated wave should set `PA_BUILD_LOCK=0` to avoid six builders serializing behind each other; the integrator's full-suite runs must NOT set it.

## Rule 11: Talk Before You Force

`pa claim --force` is the last step, not the first. When a reservation blocks work that genuinely cannot wait, message the holding session directly and agree on who yields. That ad-hoc session-to-session channel is a real, used part of this protocol — on 2026-08-23 it was how two sessions resolved a live conflict correctly — and it was undocumented until now.

Every claim, denial, force, release and expiry is now logged to `app.log.jsonl` under module `reservations`; `pa claims --stats` summarizes the last 7 days and the weekly ops digest carries a one-line rollup.

## Rule 12: Unreserved Worker Edits Are Detected

A bot dispatch snapshots `git status` before and after the worker runs. Any tracked path that appears, changes, or vanishes inside that window without a covering reservation — active at either end, or claimed and released inside it — produces ONE `Unreserved worker edits` alert naming the paths, the topic and the worker. A worker that claims its paths produces no alert; that is the whole incentive. If the bot restarts mid-dispatch, the `worker-edit-audit-sweep` maintenance job closes the window instead. Detection only — nothing is blocked or reverted. Disable with `PA_WORKER_EDIT_AUDIT=0`. Design: `plans/2026-09-01-ai175-worker-edit-enforcement-SPEC.md`.

## See also

- `plans/2026-08-23-coordination-audit.md` — the enforcement audit behind Rules 4, 5a, 9, 10 and 11, with the per-surface enforced/advisory/prose matrix.
- `plans/2026-08-05-concurrent-session-safety.md` — the original design and the rationale for advisory-over-mandatory locking.
- `docs/repo-topology.md` — public/private repo boundaries, the PII guard, and the `exclusive_resource` lock's place in them.
- Global machine notes (`~/.claude/CLAUDE.md`) still carry machine-specific hardware detail (D: I/O diagnosis, PowerShell quoting, Windows path escaping). Everything in them that governs *this repo's* coordination is now restated above; if you find a coordination rule that exists only there, move it here.
