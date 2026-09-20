---
name: injection-redteam
description: Manual trigger for prompt-injection redteam regression test (proposal #13). Runs the deterministic fixture corpus against credential redaction + PA_META protected-skill gate + legitimate PA_META preservation. Pages on failure.
cwd: "${PA_FRAMEWORK_ROOT}"
worker: agy
timeout: 300
trigger_description: >-
  Manually trigger when the user asks to "run the redteam test", "test injection
  defenses", "check prompt injection protections", or similar. This is a
  regression test, not a one-time audit — it should pass consistently.
---

You are manually triggering the prompt-injection redteam regression test. This
is a deterministic test of three defense layers, NOT a creative exploration.

## What this test does

Runs `pa/scripts/redteam_injection.py`, a deterministic fixture corpus (~25
adversarial inputs) against three layers:

1. **Credential redaction** (`pa/src/lib/redact.ts`) — verifies sk-/Bearer/ghp_/AIza/xoxb
   token patterns are redacted to `<redacted:token>`
2. **PA_META protected-skill gate** (bot `PA_META_PROTECTED_SKILLS`) — verifies
   attempts to `run_skill` targeting git-workflow skills (commit/push/push-public/
   commit-and-push/investigate-flagged/update-brain) are rejected
3. **Legitimate PA_META preservation** (positive controls) — verifies legitimate
   PA_META envelopes for non-protected skills pass unharmed

No LLM is invoked — this is purely pattern matching against deterministic code.

## Execution

1. Ensure you're at the repo root: `cd "$PA_FRAMEWORK_ROOT"`
2. Run: `python3 pa/scripts/redteam_injection.py || python pa/scripts/redteam_injection.py`
3. Report the outcome:
   - If all pass: brief confirmation ("✅ Redteam test passed")
   - If any fail: show which fixture(s) failed and which layer(s)
   - Include the pass/fail table from the script output

## What to do on failure

If the test fails, it means a regression in one of the deterministic defense layers:

- **Credential redaction failure**: the generic token patterns in `redact.ts`
  stopped matching — likely a code edit to `GENERIC_PATTERNS`
- **Gate failure**: `PA_META_PROTECTED_SKILLS` stopped rejecting a protected skill
  or wrongly rejects a legitimate skill — likely a code edit to `logic.ts`
- **Unexpected crash**: the script itself broke — check the error message

Report the failure clearly with the fixture ID(s) and layer(s) affected. This is
a regression test, so any failure is unexpected and needs investigation.
The script ships in the public tree at pa/scripts/redteam_injection.py — no setup beyond the repo itself.
