# pa-framework git hooks

## pre-push-pii-guard

Scans outgoing commits for personal data before they reach the public mirror.

### What gets scanned (read this before trusting a clean verdict)

Coverage is deliberately **asymmetric**: the free regex layers are broad, the
metered LLM layer is narrow. Confusing the two is how three separate leaks
survived every push for months.

| Layer | Scans | Blocks? |
|---|---|---|
| 0. Path tripwires | every path the push ships (post-rename **NEW** path) | yes |
| 0. Commit-message tripwires + credentials | every commit message the push publishes | yes |
| 1. Structural credential regex | full content of every touched file, + added lines, + commit messages | yes |
| 2. Personal tripwire regex | full content of every touched file, + touched paths, + added lines, + commit messages | yes |
| 3. Gemini semantic scan | **added lines only** | yes on VIOLATION, fail-open on infra failure |

Three things that are easy to get wrong, and were:

- **Paths are data.** `projects/daily-mail-brief/scripts/download_<bank>_statement.py`
  shipped publicly for months. The file's *contents* were entirely generic; the
  user's bank was named by the *filename*, and every layer (plus the manual
  audit scans) read contents only. Layer 0 exists because of that.
- **Commit messages are data.** The very commit that renamed that file away put
  the offending filename in its own subject line — so `git log` on the public
  mirror published the term the rename was removing. Tree clean, diff clean,
  path clean, `git log` not clean.
- **The diff is not the file.** `git diff` shows only ADDED lines, so PII that
  was already committed is invisible to a diff scan forever. Layers 1-2 now
  read the **full resulting content** of every file the push touches (via
  `git show <tip>:<path>`, 8 threads, capped at 500 files / 1 MB each). The
  added-lines scan is kept as well — it is cheap, it labels findings as
  `(added lines)`, and it is the only coverage for files whose blob could not
  be read (binary, oversized, unreadable; those paths are listed in the output).

**Word boundaries and filenames.** `_` is a `\w` character, so a well-anchored
`\bACME\b` tripwire has **no boundary** in `download_acme_statement.py` and does
not match. Rather than ask you to maintain a second, looser (false-positive
prone) copy of every pattern, the guard matches each tripwire against three
views of the text: raw, separators (`_ - . / \`) replaced by spaces, and
camelCase humps split. Splitting only *adds* word boundaries, so it can never
invent a match — and both extra views preserve line numbers.

**Install / reinstall (required after every change to this file):**
```sh
cp pa/scripts/git-hooks/pre-push-pii-guard .git-public/hooks/pre-push
chmod +x .git-public/hooks/pre-push
```
The hook is a **copy**, not a link. Editing the tracked source does nothing
until you re-copy it. Check for drift with:
```sh
diff .git-public/hooks/pre-push pa/scripts/git-hooks/pre-push-pii-guard
```

**Configure personal patterns** (`~/.pa/pii-tripwires.txt`, create if absent):
```
# One Python regex per line, matched case-insensitively. Lines starting with
# '#' and blank lines are ignored.
YourName\s+\w+
you@example\.com
-100\d{10}
\bAcmeBank\b
```
Prefer **precise** patterns. A tripwire that fires on ordinary English gets
switched off by the human, which is strictly worse than not having it — so
match a company by its distinctive name or its domain (`acme\.com`), not by a
word that also means something else. Anchoring with `\b` is safe here: the path
and content layers normalise separators before matching (see above), so an
anchored pattern still catches `acme_report.py` and `AcmeBank` in `snake_case`.

**Fail-open warnings.** Layer 3 never blocks a push on its own failure — a
Gemini timeout, an unresolvable binary, an unparseable verdict, an exhausted
budget or a tripped breaker all let the push through by design. Each of those
now prints a `!!!!` banner naming **which** layer did not run and **why**.
Silence used to be indistinguishable from "ran and found nothing"; it isn't any
more. `gemini_check()` returns `(is_clean, reason, ok)` — `ok=False` means
fail-open, **not** a real CLEAN — and the human-readable cause is in
`LLM_SKIP_REASON`.

**Override for deliberate pushes (recorded):**
```sh
PA_SKIP_PII_GUARD=1 git-public push origin main
```
Still works — it is the documented escape hatch for pushing a force-rewrite you
have verified clean by hand. It now prints a bypass banner **and appends a JSON
line to `~/.pa/pii-guard-bypass.jsonl`** (timestamp, the refs being pushed, cwd,
remote name + URL). The record lives outside the repo on purpose, so the audit
trail never becomes something that itself has to be reviewed before a push.
A failure to write the record warns but never blocks the push.

Read that file before concluding the mirror has always been guarded:
```sh
cat ~/.pa/pii-guard-bypass.jsonl
```

**Full-tree audit mode** (the per-push scan is bounded by what a push touches;
a file nobody has touched in a year is only ever re-checked here):
```sh
python pa/scripts/git-hooks/pre-push-pii-guard --full           # all layers
python pa/scripts/git-hooks/pre-push-pii-guard --full --no-llm  # regex layers only (fast, ~4s)
```
Reads the repo via `$GIT_DIR` (default `.git-public` relative to cwd) and scans
every tracked **path** (binaries included — a `.pdf` whose *name* names a bank
is a leak whose content nobody would ever open), the content of every readable
tracked file, and every commit message in the history. Reports all violations
as `file:line`, `path [PATH]`, or `[COMMIT MSG] <sha>:line` — the marker tells
you whether the fix is a file edit, a rename, or a history rewrite.

Exit 0 = scan completed (clean or not — **read the output**); non-zero = the
scan itself failed. (The scheduled skill only delivers stdout on success, so
findings are output, not an error exit.) Schedule it — this deployment runs it
weekly via the `pii-audit` skill.

**Gemini binary:** resolved via `$GEMINI_CMD` env var, then `gemini` on PATH,
then `GEMINI_CMD` in `~/.pa/secrets.env` — a git hook runs with a minimal
inherited environment, so the secrets.env fallback is what makes the layer
actually run in practice rather than silently reporting "no Gemini binary."
Must support `gemini --yolo` (non-interactive, reads prompt from stdin).
Windows: a `.cmd`/`.bat` shim is invoked through `cmd /c` automatically —
plain `subprocess` cannot exec batch files, which is how the semantic layer
ended up silently disabled for weeks.

**Reliability invariants (do not regress):**

- **Encoding.** Every subprocess call in this script that decodes output
  (`text=True`) passes explicit `encoding="utf-8", errors="replace"`. Without
  it, Windows decodes with the system codepage (cp1252): em-dashes mojibake and
  the variation selector in `⚠️` (byte `0x8f`, undefined in cp1252) raises —
  which a blanket `except` then swallows, emptying the scan input so the guard
  silently vets **nothing** while the push proceeds (observed 2026-07-08 on the
  Gemini call, again 2026-07-12 on `git diff`/`ls-files`). Calls without
  `text=True` return bytes and are exempt. Enforced at source level by
  `TestSubprocessEncodingInvariant` so future call sites inherit the rule.
- **Tree-kill on timeout.** All Gemini invocations go through `_run_gemini()`,
  whose timeout kills the whole process **tree** (`taskkill /F /T` on Windows,
  `killpg` on POSIX). Plain `subprocess.run(timeout=)` kills only the `cmd /c`
  wrapper and orphans the node grandchild, which then busy-spins at 100% CPU
  forever (2026-07-20: six orphans, six cores).
- **Bounded LLM phase.** `--full`'s semantic phase self-bounds via a
  3-consecutive-failure breaker plus `PA_PII_AUDIT_LLM_BUDGET` (default 2400s),
  so the weekly skill always finishes inside its 3600s timeout. A timed-out run
  records no success, and catchup then retries a still-overdue skill forever
  (the 34-hour hourly retry storm of 2026-07-19/20).
- **One retry on a transient Gemini failure** (timeout, subprocess error,
  unparseable response) before the layer gives up — a one-off blip must not
  silently disable the semantic scan for a whole push. A real parsed
  `VIOLATION` is a verdict, not a failure, and is never retried.

**Tests:** `pa/scripts/tests/test_pii_guard.py` (pure unit tests, no repo
mutation). Run with `PYTHONIOENCODING=utf-8` on Windows.
```sh
PYTHONIOENCODING=utf-8 python -m unittest discover -s pa/scripts/tests -p "test_pii_guard.py"
```
