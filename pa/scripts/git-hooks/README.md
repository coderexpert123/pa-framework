# pa-framework git hooks

## pre-push-pii-guard

Scans outgoing commits for personal data before they reach the public mirror.

**Three layers:**
1. Structural regex — Telegram bot tokens, Anthropic/OpenAI/Google API keys, hardcoded `BOT_TOKEN=` assignments. Always runs, no external calls.
2. Personal tripwire regex — patterns in `~/.pa/pii-tripwires.txt` (outside the repo, one regex per line). This is where you put names, emails, chat IDs.
3. Gemini semantic scan — sends the added lines to Gemini with a PII-detection prompt. Fail-open (a Gemini timeout or missing binary warns but does not block).

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

**Gemini binary:** resolved via `$GEMINI_CMD` env var, then `gemini` on PATH.
Must support `gemini --yolo` (non-interactive, reads prompt from stdin).
