---
name: self-improver
description: Nightly self-improvement loop — analyzes run logs, failures and the alert census, proposes and floor-gated-applies fixes, audited and rollback-able
cron: "20 22 * * *"
on_missed: latest
cwd: "${PA_FRAMEWORK_ROOT}/pa"
cmd: "node dist/src/self-improver.js"
timeout: 3600
critical: true
trigger_description: >-
  Scheduled nightly. Also trigger manually via pa run self-improver after
  changes to skill definitions or repeated failures you want analyzed.
---

## How it works

The self-improvement loop analyzes framework behavior and applies fixes automatically:

1. **Conversation-pattern analysis** — reads `~/.pa/conversation-history.jsonl` to extract patterns from past turns
2. **Failure analysis** — runs `analyzer.ts`/`failure-analyzer.ts`/``feedback-analyzer.ts` against logs to produce `DraftProposal` objects
3. **Alert-census routing** — the 7-day alert census feeds deterministic proposals (defect fixes, human-gated alerts, repeat-unchanged hygiene)
4. **Drafting** — `drafts.ts` consolidates findings into concrete change proposals with diff and validation detail
5. **Floor-gated application** — `validator.ts` checks each proposal against safety floors:
   - **Validation floor** — every applied change must pass its validation gate (fix/new-skill failing validation stays `pending`, never deploys broken)
   - **Protected-skills floor** — changes to git-workflow skills (commit, push, push-public, investigate-flagged) require explicit approval
   - **Critical-change flagging** — `isCriticalChange`/`hasRealSideEffects` proposals are recorded with risk flags rather than blocked
6. **Commit** — one pathspec commit per applied fix (rolled back via `git revert` if needed)
7. **Audit trail** — every terminal decision logged to `~/.pa/self-improver-audit.jsonl` (diff, validation, run-stats)
8. **Evaluation** — `pa improvements [--since N]` recomputes before/after state from the audit trail

The two safety floors (validation and protected-skills gates) are product features — they ensure autonomous changes are safe and reversible. Run `pa improvements` to see the audit trail and assess impact.

This example skill is for demonstration — it runs at 22:20 UTC, distinct from any private deployment's schedule.
