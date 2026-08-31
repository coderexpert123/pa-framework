# Daily Mail Brief: LLM-Powered Inbox Triage

A sophisticated tool that performs high-signal triage of your Gmail inbox, producing concise morning and evening briefings and dynamically triggering downstream automation.

## 🏗 Architecture

1.  **Header Fetch**: `scripts/fetch_headers.py` retrieves all email headers for the 12-hour window.
2.  **LLM Triage**: An AI agent classifies emails into ACTION_REQUIRED, NOTEWORTHY, or SKIP.
3.  **Body Fetch (Selective)**: `scripts/fetch_bodies.py` retrieves full content for ambiguous emails.
4.  **Briefing Generation**: The agent writes a clean Markdown summary to Obsidian (path configured via the `OBSIDIAN_BRIEFS_DIR` env var; if unset, Obsidian archival is skipped).
5.  **Telegram Dispatch**: `scripts/send_telegram.py` sends the briefing to your phone.
6.  **Dynamic Triggers**: The agent checks the classified emails against available `trigger_description`s and outputs `[pa run <skill>]` to chain further automation.

## 📁 Repository Structure

-   📂 `scripts/`: Python utilities for Gmail API interaction and Telegram messaging.
-   📂 `venv/`: Local Python environment.
-   📄 `state.json`: Tracks the last processed email window.

## 🛠 Features

-   **Trigger System**: Seamlessly integrates with the `pa` dispatcher to launch skills like `portfolio-reports` when relevant emails (e.g., monthly statements) arrive.
-   **Obsidian Integration**: Automatically archives every briefing into your personal knowledge base when `OBSIDIAN_BRIEFS_DIR` is configured.
-   **Fail-Safe Timeouts**: Configured with a 5-minute idle timeout to handle large inboxes and deep thinking.
-   **Decision Traces (2026-08-27)**: The pipeline records ≤10 decision rows per run to `~/.pa/decisions.sqlite` from the inner LLM's optional `===DECISIONS_START/END===` marker block — capturing non-obvious judgment calls (borderline inclusions, borderline skips, promotions) with request excerpt, decision, rationale, and alternatives. Recording is deterministic (the LLM's JSON output is parsed and enriched with `source='skill'`, `skill='daily-mail-brief'`, and thread/chat IDs from env vars) and never fatal (malformed lines are skipped with a stderr warning; a recording failure never fails the brief). These rows are searchable via `pa recall --source decisions`.
-   **SLO Miss Detection (2026-08-27, AI-168)**: The fetch stage detects missed 13:30/23:30 UTC windows by slot-gap logic — every scheduled slot-end between `last_processed` and the current window start is a miss. Writes `~/.pa/daily-mail-brief/latest.json` (misses array, capped at 200 newest) consumed by `pa slo report`. Implemented in `fetch_headers.py` (detector) and `runtime_state.py` (writer).
