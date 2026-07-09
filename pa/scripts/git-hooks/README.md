# pa-framework git hooks

## pre-push-pii-guard

Scans outgoing commits for personal data before they reach the public mirror.

**Three layers:**
1. Structural regex — Telegram bot tokens, Anthropic/OpenAI/Google API keys, hardcoded `BOT_TOKEN=` assignments. Always runs, no external calls.
2. Personal tripwire regex — patterns in `~/.pa/pii-tripwires.txt` (outside the repo, one regex per line). This is where you put names, emails, chat IDs.
3. Gemini semantic scan — sends the added lines to Gemini with a PII-detection prompt. Retries once on a transient failure (timeout, subprocess error, unparseable response) before giving up. Fail-open only after both attempts fail (a Gemini timeout or missing binary warns but does not block).

**Install (one-time, after cloning):**
```sh
cp pa/scripts/git-hooks/pre-push-pii-guard .git-public/hooks/pre-push
chmod +x .git-public/hooks/pre-push
```

**Configure personal patterns** (`~/.pa/pii-tripwires.txt`, create if absent):
```
# One Python regex per line, matched case-insensitively
YourName\s+\w+
you@example\.com
-100\d{10}
```

**Override for deliberate pushes:**
```sh
PA_SKIP_PII_GUARD=1 git-public push origin main
```

**Full-tree audit mode** (the per-push scan only checks ADDED lines — PII in
pre-existing/unchanged lines is never re-checked):
```sh
python pa/scripts/git-hooks/pre-push-pii-guard --full           # all 3 layers
python pa/scripts/git-hooks/pre-push-pii-guard --full --no-llm  # regex layers only (fast)
```
Reads the repo via `$GIT_DIR` (default `.git-public` relative to cwd), scans
every tracked text file, reports all `file:line` violations. Exit 0 = scan
completed (clean or not — read the output); non-zero = the scan itself failed.
(The scheduled skill only delivers stdout on success, so findings are output,
not an error exit.)
Schedule it — this deployment runs it weekly via the `pii-audit` skill.

**Gemini binary:** resolved via `$GEMINI_CMD` env var, then `gemini` on PATH,
then `GEMINI_CMD` in `~/.pa/secrets.env` — a git hook runs with a minimal
inherited environment, so the secrets.env fallback is what makes the layer
actually run in practice rather than silently reporting "no Gemini binary."
Must support `gemini --yolo` (non-interactive, reads prompt from stdin).
Windows: a `.cmd`/`.bat` shim is invoked through `cmd /c` automatically —
plain `subprocess` cannot exec batch files, which is how the semantic layer
ended up silently disabled for weeks.

**Reliability (AI-097):** the subprocess call to Gemini uses explicit
`encoding="utf-8", errors="replace"`. Without it, Windows decodes the
subprocess's output with the system codepage (cp1252) — Gemini's own UTF-8
output (emoji, smart quotes) then crashes a background reader thread with an
exception that bypasses this script's own error handling entirely (wrong
thread), producing a raw traceback instead of the intended fail-open
behavior. A single transient failure (timeout, subprocess error, unparseable
response) gets one retry before the layer gives up — so a one-off network
blip doesn't silently disable the semantic scan for a whole push.
