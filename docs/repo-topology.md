# Public/private repo topology — operational detail

Extracted from CLAUDE.md during a 2026-08-07 `/shorten-brain` pass. CLAUDE.md keeps the
compact rules; this file keeps the full mechanics, incident history, and gotchas. Read
this before touching git-public, push-public, the PII guard, the `exclusive_resource`
lock, or any dual-repo assumption.

## Git-workflow skill family — bot wiring

Bot wiring for the `commit`/`push`/`push-public`/`investigate-flagged`/`commit-and-push`
Telegram commands: `COMMIT_PATTERN`/`COMMIT_AND_PUSH_PATTERN`/`PUSH_PATTERN`/
`PUSH_PUBLIC_PATTERN`/`INVESTIGATE_FLAGGED_PATTERN` in `logic.ts`, dispatched via the
shared `dispatchGitWorkflowSkill()` helper in `main.ts`, registered in `commands.ts`'s
`BOT_COMMANDS`.

## Cross-skill mutual exclusion (2026-08-05)

`commit`, `push`, `push-public`, `investigate-flagged`, AND `update-brain` each declare
`exclusive_resource: git-workflow` in their frontmatter — `update-brain` is included
because it also git-commits (its own documented "pre-update snapshot" / "commit pending
brain-file changes" behavior) and runs on its own nightly cron independent of the other
four, so leaving it out would have reopened exactly the race the lock exists to prevent.
This is a new `SkillFrontmatter` field (`pa/src/types.ts`) that `pa run`
(`pa/src/commands/run.ts`) enforces via a `blackboard.acquireLock`/`updateHeartbeat`/
`releaseLock` wrap around the skill's whole execution, keyed `skill-exclusive:<resource>`
and heartbeated every 60s (mirrors `catchup.ts`'s own lock pattern; allowlisted in
`pa/tests/timer-inventory.test.ts`) so a long `push`/`push-public` run doesn't get purged
as stale past blackboard's 10-minute heartbeat window. Prevents two different skill names
— each spawned as a separate OS process via `spawn('pa', ['run', ...])`, sharing no
in-process state — from mutating the same working tree concurrently (e.g. a scheduled
`push-public` colliding with a manual `/commit`).

Lock-wait budget is half the skill's own `timeout` (`lockWaitBudgetMs` in run.ts), so a
blocked run always keeps half its budget for the actual work no matter how long it
waited; on timeout it returns a failed `CommandResult` routed through the normal
`handleSkillResult` path (`alreadyAlertedPaSupport: true`, so it notifies the skill's own
Telegram topic, not a pa-alerts page).

**`commit-and-push` deliberately does NOT declare `exclusive_resource`** — it spawns
`update-brain`/`commit`/`push`/`push-public` as child `pa run` processes that each
acquire the lock themselves; if the orchestrator also held it, its own child would
deadlock waiting on its parent.

**`loadSkill` (`pa/src/skills.ts`) builds `SkillFrontmatter` as an explicit whitelist,
not a spread of the parsed YAML** — a new frontmatter field is silently dropped (parsed
by no one, no error) unless it's added to that literal by hand; caught this exact gap
for `exclusive_resource` itself during implementation (the lock never activated because
the field never reached the code that reads it). Any new skill.md field needs adding in
three places: `SkillFrontmatter` (types.ts), `loadSkill`'s object literal (skills.ts),
and the frontmatter table in `docs/ARCHITECTURE.md`.

**The self-improver's two autonomous git paths take the same lock directly, not via
frontmatter**: `code-fixer.ts`'s `attemptCodeFix` (commit/push, heartbeated — can hold
the lock ~30+ min across the coding worker + verification gate) and
`self-improver.ts`'s `rollback()` (git-revert/push, no heartbeat — its git sequence is
normally seconds, and git's own `.git/index.lock` is a second layer of defense against
the residual stale-purge risk). Deliberately not `exclusive_resource` on
`self-improver`'s own skill.md — that would hold the lock across the whole hour-long run
including `generateProposals()`'s LLM calls. The coding worker's brief is hardened to
never invoke a git-workflow skill of its own while code-fixer holds the lock (it would
stall against its own parent).

## Windows console-window flash (2026-08-05)

Every Node `child_process.spawn` using `shell: true`, or spawning a real console app
(`powershell.exe`), needs `windowsHide: true` or it pops a visible window on the desktop
— this was silently missing everywhere except the two spots `voice.ts`/
`voice-worker-client.ts` already got it right during the voice-transcription work. Fixed
in `worker-exec.ts` (the actual worker CLI spawn — every skill/chat dispatch),
`workers.ts` (health checks), `run.ts` (`cmd:`-based skill spawn), `keepawake.ts` (the
`powershell.exe` SetThreadExecutionState spawn), and `main.ts`'s three spawns
(`dispatchGitWorkflowSkill`, the chat-dispatch `pa run`, the OAuth code-exchange Python
call). Any NEW spawn call in this codebase needs `windowsHide: true` too unless it's
deliberately interactive/foreground (the one exception: `approve.ts`'s editor-open
spawn, `stdio: 'inherit'`, meant to be seen).

## HISTORICAL — shared-worktree git-public topology (retired 2026-08-06)

Before that date, `.git-public` was a second git-dir pointed with
`--git-dir`/`--work-tree` at THIS SAME physical directory — a branch checkout on either
repo could silently destroy or corrupt files the other repo needed, and this happened
twice (2026-07-21, 2026-08-05): `push-public` left `.git-public` on a stale feature
branch, and a manual `git-public.ps1 checkout main` fix — without first confirming the
private repo's working tree was clean — caused git to physically delete dozens of files
(recovered only because private `HEAD` still had them all). Root-caused and fixed
structurally, not just procedurally: the public mirror now lives at its own
nested-but-independent directory (`pa-public/`, own `.git/`), so a checkout there can
never touch anything here again — full design and migration record:
`plans/2026-08-05-concurrent-session-safety.md`. This entry stays as history so nobody
re-diagnoses the same incident class from scratch.

## 2026-07-21 public history rewrite — PII lives in PATHS, not just contents

The mirror's entire 46-commit history was rewritten with `git-filter-repo` and
force-pushed, so every pre-rewrite public SHA cited in older `plans/` docs now dangles
(marked legacy in place; private SHAs are unaffected). Three PII items had been public
since the 2026-05-22 initial release; one was a FILENAME — a script under
`projects/daily-mail-brief/scripts/` was named after the user's bank while its contents
were entirely generic (now `download_statement_attachment.py`). It passed every
pre-push guard layer and the 2026-06-24 full-tree audit because content scanners read
file CONTENTS and never look at PATHS. Any future scan must check the tracked-path list
as well — and must not quote the offending name, which is why this entry describes it
instead. Full record: `plans/2026-07-21-performance-audit-remediation.md`.

## Reference facts (short, kept for completeness)

-   **Private repo (`.git/`)**: tracks personal brain files, backlog, plans, private
    projects, and deployment-specific glue.
-   **Public mirror (`pa-public/`)**: a real, independent git repo (own `.git/`,
    gitignored by the private repo) tracking the reusable substrate defined by
    `.gitignore-public`. Fully DERIVED — `pa public-sync` may wipe and regenerate it at
    any moment; nothing is ever authored there directly. Default location is
    `<repo root>/pa-public`, overridable via the `PA_PUBLIC_DIR` env var.
-   **Wrapper scripts**: `git-public.ps1` / `git-public.cmd` are thin aliases resolving
    into `pa-public/`'s own directory (`git -C <pa-public>`) — use them for public-repo
    status/add/commit/push operations instead of hand-rolled invocations. They no longer
    use `--git-dir`/`--work-tree` (see historical note above).
-   **Whitelist boundary**: `.gitignore-public` is the source of truth for what ships to
    the public framework repo. **It does NOT filter `pa public-sync`'s extraction** —
    that step (`git archive HEAD | tar -x`) writes the private repo's ENTIRE committed
    tree into `pa-public/`'s working tree, unfiltered (verified 2026-08-08; the earlier
    claim here that extraction was filtered was wrong — see
    `pa/tests/public-sync.test.ts`'s own comment asserting the opposite). The boundary is
    enforced one step later, at STAGING: `.gitignore-public` is wired in as
    `pa-public/.git/config`'s `core.excludesfile`, so git itself treats every
    private-only file `public-sync` just wrote as ignored — invisible to `git status`/
    `git add` unless force-added. `push-public`'s Step 2 independently re-checks this via
    `git-public.ps1 check-ignore`/`ls-files` before staging.
-   **Public-mirror sync scope discipline — now structural, not procedural.**
    `pa public-sync` extracts ONLY from the private repo's committed `HEAD`
    (`git archive`), never the working tree, and refuses to run at all if the private
    repo has uncommitted changes. This closes the 2026-07-08/09 incident class (a
    `git-public add` batch sweep once staged two entire uncommitted private feature
    branches, ~15 files, before the private repo had them in history at all) as a
    mechanism — it cannot recur by construction, not because someone remembered to
    check.
-   **Public-only path caveat (retired 2026-08-06)**: the private repo's `.gitignore`
    used to intentionally ignore `/README.md`, `/LICENSE`, `/docs/`, and `/examples/` as
    "public-only" paths; as of 2026-08-06 the private repo tracks these too (strict
    superset of public), so this caveat no longer applies to new files under those
    paths.
-   **Pre-push PII guard**: `pa/scripts/git-hooks/pre-push-pii-guard`, installed at
    `pa-public/.git/hooks/pre-push` (a COPY, not a link — re-run
    `python pa/scripts/install_git_hooks.py` after any source edit; copy-only since
    2026-08-06, the public mirror is a genuinely separate repo with its own clone
    lifecycle now, so a symlink would silently desync on re-clone). Read
    `pa/scripts/git-hooks/README.md` in full before touching the hook, tripwires, or its
    test suite — it is the maintained source of truth for layer coverage, the agy
    invocation shape, the fail-closed(push)/fail-open(`--full`) policy split, the
    new-branch merge-base fix (2026-07-23), the CI server-side backstop, and every
    do-not-regress reliability invariant (encoding, tree-kill, word-boundary matching).
    Headline facts worth knowing unprompted: DO NOT TRUST THE GUARD ALONE (it's a local
    hook — uninstalled, stale, or bypassed leaves zero coverage, which is why the CI
    backstop exists independently); a layer-3 (agy) infra failure now blocks the push by
    design, not waves it through; the sanctioned bypass is
    `PA_SKIP_PII_GUARD=1 git-public push origin main`, logged to
    `~/.pa/pii-guard-bypass.jsonl`, never silent.
-   **OAuth boundary**: generic bridge-page assets, `/auth` handling, auth-session
    schema, and resume-framework plumbing belong in the public mirror;
    deployment-specific secrets, tokens, and the action-registry hook stay private under
    `~/.pa/`.
