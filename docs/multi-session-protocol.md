# Multi-Session Coordination Protocol

Several Claude Code sessions, plus the Telegram bot's worker dispatches, run against this ONE working tree concurrently — this tree is the live installation (`pa` runs from `pa/dist` built here, the bot from its own `dist` here, skills and Task Scheduler entries point here). Sessions share a tree, not worktrees, because a worktree is invisible to the running system until merged back. (Added 2026-08-05 after a concurrent-edit collision on `pa/src/code-fixer.ts` — full incident and design: `plans/2026-08-05-concurrent-session-safety.md`.)

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

## Rule 3: Reservations Are Advisory

Mandatory locking's dominant real-world failure is the abandoned lock, not the contended one (full rationale: `plans/2026-08-05-concurrent-session-safety.md`).

- A conflicting `pa claim` exits 1 and names the holder and their note
- `--force` proceeds anyway and is logged with a ref-ID
- Use `--force` only after actually reconciling with the other session's intent, never to silence the warning

## Rule 4: Build Under @build Lock

```
npm run build
npm test
```

Both run under `pa claim @build --wait 900 --ttl 30`, released immediately afterwards.

- Concurrent builds tear each other's `pa/dist` output (the bot loads it live)
- D:'s 5400rpm HDD starves other D: I/O under one concurrent build
- `@build` is a logical resource, not a path (the `@` prefix can never collide with a filename)
- Enforced in the `push` skill's Step 2; `commit` runs no build, so it doesn't need it

## Rule 5: Never Run Raw Git Commands

Never run raw `git commit` / `git push` / `git-public …` yourself (concurrency is one reason; see Public/private repo topology in root CLAUDE.md for the other).

The `commit`/`push`/`push-public`/`investigate-flagged`/`update-brain` family serializes through the `git-workflow` blackboard lock. A raw git invocation sits entirely outside that lock and can collide on `.git/index.lock` — a failure mode with documented silent work-loss behaviour in concurrent-agent setups.

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

- `update-brain` fires nightly at 21:30 IST and git-commits any pending working-tree changes
- `self-improver`'s code-fixer can hold the `git-workflow` lock 30+ minutes
- Neither is a bug. Don't leave work uncommitted across 21:30 IST expecting it to stay uncommitted.
