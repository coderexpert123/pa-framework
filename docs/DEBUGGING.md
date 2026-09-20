# Debugging Conversation Traces

> Audience: any agent debugging a pa dispatcher run. Lookup-oriented, not tutorial.
> Scope: covers the CLI workers registered in `~/.pa/config.yaml` — `zclaude`, `claude`, `codex`, `agy`, `agyc`, `devin`, `kgclaude`, `opencode`.

## 1. Three levels of history — pick the right one

| Layer                   | File                                                  | When to read                                                                |
|-------------------------|-------------------------------------------------------|-----------------------------------------------------------------------------|
| PA archive              | `~/.pa/conversation-history.jsonl`                    | Full cross-topic bot I/O history (append-only).                             |
| Bot rolling window      | `~/.pa/telegram-bot-state.json`                       | Last ~20 turns the bot actually put into context.                           |
| Per-topic state         | `~/.pa/telegram-bot-topic-{chatId}_{threadId}.json`   | Per-topic archive + `session.worker` / `session.session_id` pointer.        |
| Turn trace (2026-08-24) | `~/.pa/turn-traces.jsonl`                             | Deterministic per-run tool/command/file/error record for every `executeWorker` call — one JSON line, joined by `run_id` (any run) or `(thread_id, update_id)` (a bot turn). `pa ref` prints it; see §3 below. |
| Decision rows (2026-08-27) | `~/.pa/decisions.sqlite`                           | Judgment calls with rationale/reaction (request excerpt, decision, alternatives, outcome). Query via `pa recall --source decisions` or direct `sqlite3`; writers: daily-mail-brief (inner-LLM), travel-butler (skill), reminders `rm:` buttons. |
| Feedback rules (2026-08-27) | `~/.pa/feedback-rules.yaml` (+ `-audit.jsonl`, `rules-violations.jsonl`) | Add-only rule store; nightly triage compiles from corrections + 👎 reactions; deterministic checks active immediately, semantic rules PENDING until `pa rules accept`. Inspect: `pa rules list`, `pa rules show <id>`. |
| SLO: daily-mail-brief misses (2026-08-27) | `~/.pa/daily-mail-brief/latest.json` | Missed 13:30/23:30 UTC windows detected by `fetch_headers.py` slot-gap logic; consumed by `pa slo report`. |
| Skill engagement census (2026-08-27) | `~/.pa/skill-engagement.json` | Monthly audit of skills with ≥90d zero engagement (no successful run, no decision rows); feeds weekly digest's Retire? section. Job: `skill-engagement-audit`. |
| Reauth kicks log (2026-08-27) | `~/.pa/reauth-kicks.jsonl` | Append-only log of every `kick_google_reauth` invocation (sent/rate-limited/failed); consumed by weekly digest's operator-intervention count. |
| **Per-CLI transcript**  | see §2 below                                          | Full model-side trace: system prompt, tool calls, raw stream-json events.   |

If you need to see *exactly* what the model saw and produced on a given turn — including tool calls, subagent spawns, and stream-json envelopes — go to the per-CLI transcript. Everything above it is pa-side bookkeeping.

## 2. Per-CLI state dirs

### 2.1 claude & zclaude  (identical storage)

- **Dir:** `~/.claude/projects/<derived-from-your-repo-cwd>/`
- **Encoding rule:** Claude Code derives the project subdir from cwd by replacing every `:`, `\`, `/`, and space with `-`. So `D:\My Repo` → `D--My-Repo`. If the bot's cwd is ever renamed, this folder name changes — the bot derives it the same way in `session.ts` (`cleanupExpiredSessions`, `claudeSessionPath`).
- **File:** `<session-uuid>.jsonl` (one JSON object per line).
- **Top-level per-line fields:** `parentUuid`, `type` (`user` | `assistant` | `system`), `message.{role,content}`, `uuid`, `timestamp`, `cwd`, `sessionId`, `gitBranch`, `version`.
- **Subagents:** `<session-uuid>/subagents/agent-*.jsonl` — one file per Task-tool spawn, same JSONL envelope, plus a sibling `agent-*.meta.json`. A top-level `*.jsonl` glob on the project dir will **miss** these; walk one level in.
- **Tool results folder:** `<session-uuid>/tool-results/` (referenced by the subagent transcripts; usually not needed directly).
- **Same-dir caveat:** zclaude, claude and kgclaude are indistinguishable from filename alone. Disambiguate by:
    1. `session.worker` in `~/.pa/telegram-bot-topic-*.json` for the topic.
    2. Model name in message payloads — `GLM-*` ⇒ zclaude or kgclaude (kgclaude pins bare `glm-5.3-flash`; zclaude uses `[1m]`-suffixed names), `claude-*` ⇒ claude.
    3. The matching spawn entry in `~/.pa/logs/` by timestamp.

### 2.2 codex

- **Dir:** `~/.codex/`
- **Storage:** `state_5.sqlite` — a SQLite DB, **not** flat files. The `threads` table is keyed by UUID (`id TEXT PRIMARY KEY`).
- **Archival semantics:** `cleanupExpiredSessions` sets `archived = 1` with `archived_at` rather than deleting, so old transcripts remain queryable even past the 24 h TTL that burns claude files.
- **Columns (verified from `.schema threads`):** `id`, `rollout_path`, `created_at`, `updated_at`, `source`, `model_provider`, `cwd`, `title`, `sandbox_policy`, `approval_mode`, `tokens_used`, `has_user_event`, `archived`, `archived_at`, plus later additions (`cli_version`, `first_user_message`, `agent_*`, `memory_mode`, `model`, `reasoning_effort`). `updated_at` is **Unix epoch seconds**, not milliseconds — when comparing to a JS `Date.now()` value, divide the JS value by 1000 first (see `cleanupCodexSessions` in `session.ts`).
- **Inspect:**
    ```bash
    sqlite3 "$HOME/.codex/state_5.sqlite" ".tables"
    sqlite3 "$HOME/.codex/state_5.sqlite" \
      "SELECT id, updated_at, archived FROM threads ORDER BY updated_at DESC LIMIT 20;"
    ```
  If `sqlite3` is not on PATH, install with `winget install sqlite.sqlite` (CLI only) or open the file in any SQLite browser.
- **Rollout transcript:** the full turn-by-turn transcript lives at `rollout_path` (a file path inside `~/.codex/`) — `threads` is the index, not the transcript.
- **Resume args:** pa uses the subcommand form `resume <uuid>` (not `--resume`) — see `buildResumeArgs` in `session.ts`.

### 2.3 opencode

- **Store:** `~/.local/share/opencode/opencode.db` — a SQLite DB, **not** flat files. Do **not** `cat` it; open with `sqlite3` (see §2.2's pattern).
- **Quick-inspect:** `opencode session list` lists sessions; `opencode export <sessionID>` prints the transcript.
- **Resume flags:** `-s`/`--session <sessionID>` to resume a session, `-c`/`--continue` for the most recent.
- **Disambiguation:** separate store from claude/zclaude/kgclaude (`~/.claude/projects/<cwd-slug>/*.jsonl`) — no same-dir caveat applies.

### 2.4 agy

- **Dir:** `~/.gemini/antigravity-cli/conversations/`
- **Format:** `<uuid>.db` files — SQLite, matching `~/.pa/config.yaml`'s `state_pattern: "*.db"` for the agy worker. (Corrected 2026-08-08: this section previously claimed `.pb` protobuf was primary and `.db` was a legacy fallback — the opposite of reality. Verified: `conversations/` holds 0 `.pb` files and 331 `.db` files.) Do **not** `cat` these; open with `sqlite3` (see §2.3's pattern) if you need to inspect turn history.
- **Discovery:** `discoverAgySessionId()` picks the `.pb`/`.db` file with the most recent mtime (the code still accepts `.pb`, `.db`-first, in case a future version reintroduces it). The session UUID lives in `session.session_id` of the topic state file; the filename is normally `<uuid>.db` but may differ if the CLI regenerated it.
- **Resume flag:** `--conversation <uuid>` — flag form distinct from other workers. See `buildResumeArgs` in `session.ts`.
- **TTL:** same 24 h mtime-based cleanup as claude (`cleanupExpiredSessions` deletes UUID-named `.pb`/`.db` files older than 24 h). Unlike codex, there is no archive — files are deleted.
- **Wrapper:** if you route agy through a wrapper script, every non-interactive invocation must go through it — it sets the GCP project env vars and refreshes the Antigravity token before/after execution (see docs/WORKERS_GUIDE.md).
- **Live liveness log:** `~/.gemini/antigravity-cli/log/cli-<timestamp>.log` — one file per invocation, also hardlinked as `cli.log` in the same directory while a run is in flight, so `tail -f ~/.gemini/antigravity-cli/log/cli.log` follows the current run under a stable name.
- **Structured content transcript (AI-115, fixed 2026-08-08):** `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl` (plus a `transcript_full.jsonl` twin, and `.system_generated/{messages,tasks}/` on runs that use them) — JSONL, one step per line, fields `step_index`/`source`/`type`/`status`/`created_at`/`content`. This was **silently 0 bytes on every shim-dispatched run since 2026-06-25**: the wrapper writes it to a Unix-style absolute path (`/Users/<you>/.gemini/...`), which on Windows is drive-relative and resolved against whichever drive the wrapper's `cd /d` to the repo root had made active — i.e. a path under the drive-relative location, which didn't exist. Fixed via a directory junction from the drive-relative location to the real one. One-line health check: `Select-String 'open /Users/' <latest cli-*.log>` should return zero matches; if it returns matches, the junction is missing or broken.

## 3. End-to-end trace recipe

Reconstructing one Telegram turn end-to-end:

1. Identify `chat_id` + `thread_id`. Open `~/.pa/telegram-bot-topic-{chatId}_{threadId}.json`. Read `session.worker` + `session.session_id`.
2. Start with `node pa/dist/bin/pa.js ref <refId>` (the `_Ref: s-XXXXXXXXXXXX_` line on the bot's reply, or any run's uuid) — it prints the archived turn text AND (2026-08-24) a `--- trace (turn-traces.jsonl) ---` block: outcome, worker, model, duration, exit code, tool-call counts by name, and the commands/files/errors that run touched. This is the fastest path to "what did the model actually do" without opening a raw transcript. For finer detail than the trace's capped/redacted summary — the exact prompt, every tool_use block, raw stream-json — open the per-CLI transcript (§2.x).
3. Cross-check `~/.pa/app.log.jsonl` for dispatcher events. As of 2026-04-19, `[workers]` entries include `{topic, update_id}` — use that to correlate a specific user message (update_id from `[poll] update:XXXXXX`) to its worker lifecycle.
4. If the turn is missing from the topic state (bot was down), `~/.pa/conversation-history.jsonl` is append-only and survives restarts — grep by `chat_id`/`thread_id` to find the last processed message before the gap. Or run `node pa/dist/bin/pa.js recall "<distinctive phrase>" --thread <id> --json` — full-text search across the conversation archive (live + rotated shards), worker traces, topic brains, the Ecosystem KB and pending review-digest conflicts, faster than grepping shards by hand.

## 3a. Debugging a worker failure

**`app.log.jsonl` shows exit code only — the actual error output is in the CLI transcript.**

Exit code reference:
- `exit:0` — success
- `exit:-1` — killed by signal (our sentinel for null exit code = process was killed, almost always a timeout)
- `exit:1` — explicit error from the CLI
- `exit:N` (other) — CLI-specific codes

**When `exit:-1` and duration ≈ worker timeout (default 180 s = 3 min):** the worker was killed by the idle/max timeout, not an API error. Look at the CLI transcript to see how far it got before the kill.

**Finding the CLI transcript for a failed run by timestamp:**

Match the `[workers] try: <worker>` timestamp from `app.log.jsonl` to the CLI's session/transcript file in its state dir.

**The bot stdout log (`~/.pa/logs/telegram-bot.log`) is unreliable for past failures** — it belongs to the current process and is truncated/rotated on restart. For any run that ended before the current bot instance started, the per-CLI transcript is the only record.

## 4. Quick-inspect commands

### Bash (Git-Bash on Windows; paths use `$HOME`)

```bash
# --- claude / zclaude ---
# List today's sessions (latest 10)
ls -lt "$HOME/.claude/projects/D--Personal-Assistant/"*.jsonl 2>/dev/null | head -10

# Pretty-print the most recent session
latest=$(ls -t "$HOME/.claude/projects/D--Personal-Assistant/"*.jsonl 2>/dev/null | head -1)
tail -n 20 "$latest" | jq .

# Resolve a specific session UUID
sid="<paste-uuid-from-session.session_id>"
cat "$HOME/.claude/projects/D--Personal-Assistant/${sid}.jsonl" | jq .

# Subagent transcripts for a session
ls "$HOME/.claude/projects/D--Personal-Assistant/${sid}/subagents/" 2>/dev/null

# Grep across all recent claude sessions
grep -l "some error fragment" "$HOME/.claude/projects/D--Personal-Assistant/"*.jsonl

# --- codex ---
# Recent (non-archived) threads
sqlite3 "$HOME/.codex/state_5.sqlite" \
  "SELECT id, datetime(updated_at,'unixepoch'), archived FROM threads
   ORDER BY updated_at DESC LIMIT 20;"

# Resolve a specific thread (may be archived after 24 h)
sqlite3 "$HOME/.codex/state_5.sqlite" \
  "SELECT id, rollout_path, archived, archived_at FROM threads WHERE id = '${sid}';"

# Open the transcript
rollout=$(sqlite3 "$HOME/.codex/state_5.sqlite" \
  "SELECT rollout_path FROM threads WHERE id = '${sid}';")
cat "$rollout"

# --- agy ---
# List recent sessions (most recent first) — live format is .db; .pb is legacy
ls -lt "$HOME/.gemini/antigravity-cli/conversations/"*.db "$HOME/.gemini/antigravity-cli/conversations/"*.pb 2>/dev/null | head -10

# Check if a known session_id has a matching conversation file
sid="<paste-uuid-from-session.session_id>"
ls "$HOME/.gemini/antigravity-cli/conversations/${sid}.pb" "$HOME/.gemini/antigravity-cli/conversations/${sid}.db" 2>/dev/null \
  || ls -t "$HOME/.gemini/antigravity-cli/conversations/"*.pb 2>/dev/null | head -3

# Note: .pb is protobuf binary (.db legacy SQLite) — do NOT jq or grep either
```

### PowerShell (equivalents for the two most common lookups)

```powershell
# Latest claude/zclaude session
Get-ChildItem "$HOME\.claude\projects\D--Personal-Assistant\*.jsonl" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 10

# Latest gemini session
Get-ChildItem "$HOME\.gemini\tmp\personal-assistant\chats\session-*.json" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 10
```

## 5. Caveats that routinely burn debuggers

- **24 h TTL.** At bot startup AND every 6 h in steady state (`SESSION_GC_INTERVAL_MS`, Phase 1 maintenance tick), `cleanupExpiredSessions` (`session.ts`) deletes claude JSONL and gemini JSON/JSONL files (both top-level `session-*` and UUID-dir layouts) older than 24 h by mtime. Codex rows are **archived** (`archived = 1`), not deleted — they remain queryable. If you're investigating an incident older than ~24-30 h on claude/gemini, the transcript is probably gone.
- **`findLatestStateFile` walks one level deep.** The idle-timer heuristic in `pa/src/state-monitor.ts` sees mtime changes from **any** project's claude runs under `~/.claude/projects/`, not only `D--Personal-Assistant`. If "idle timer reset on a quiet conversation" is confusing you, inspect the parent `~/.claude/projects/` globally.
- **Gemini filename ≠ full session ID.** The filename encodes only the first 8 hex chars. `--resume <8-char-prefix>` will fail; read the full UUID from inside the file first.
- **Subagent files are nested, not siblings.** A top-level `*.jsonl` scan misses `<uuid>/subagents/agent-*.jsonl`. Walk one level in.
- **zclaude ≡ claude on disk.** Same directory, same filename convention. Always disambiguate via `session.worker` in the topic state file (see §2.1).
- **Codex `updated_at` is seconds, not ms.** Dividing a JS `Date.now()` by 1000 before comparing is mandatory.
- **Codex DB version may bump.** `state_5.sqlite` appears in four places that must move together if codex upgrades to `state_6.sqlite`: `~/.pa/config.yaml` (`state_pattern`), `session.ts` (`cleanupExpiredSessions`, `codexSessionExists`), and §2.3 of this file.
- **agy sessions are `.db` (SQLite; the code still also accepts `.pb` protobuf, but none exist on disk today), not JSON.** Cannot be inspected with `jq` or `cat` — use `sqlite3`. Subject to the same 24 h mtime TTL as claude/gemini — deleted, not archived. `discoverAgySessionId()` uses latest mtime to identify the active session; the UUID inside the file is authoritative, not the filename.

## Windows-Specific Concurrency Caveats

**appendFile atomicity:** NTFS does not guarantee atomic `appendFile` across concurrent writers (unlike POSIX O_APPEND up to PIPE_BUF). Any file appended by multiple in-process or cross-process callers simultaneously should use a mutex or proper-lockfile. In this codebase, DLQ (`dlq.ts`) uses a per-process mutex; the conversation archive (`conversation.ts`) uses proper-lockfile.

**PID reuse:** Windows recycles PIDs faster than POSIX. The blackboard's `isProcessAlive` check (`blackboard.ts:31`) can return `true` for a new unrelated process that inherited a dead worker's PID. Mitigated by the 10-minute heartbeat stale threshold (`HEARTBEAT_STALE_MS`): even if the PID is alive, a missing/stale heartbeat purges the lock within 10 minutes.

Coordination state lives in two separate stores that are easy to confuse. `~/.pa/reservations.json` holds advisory path/logical reservations (`pa claims`, `@build`), TTL-expiring, written by `lib/reservations.ts`. `~/.pa/blackboard.json` holds PID+heartbeat locks (`skill-exclusive:git-workflow`, `skill-exclusive:git-public-workflow`, `catchup`, per-topic bot locks), written by `blackboard.ts`. A check against the wrong store is silently always-false: `clobber-sentinel` looked for the string `exclusive_resource:git-workflow` in the reservations store from the day it shipped until 2026-08-23, so its documented "skip while a commit is in flight" never once fired. Both stores are now written atomically (tmp + `renameWithRetry`) and both log at `error` with a ref-ID when a torn file is reset to empty — `pa ref <refId>` resolves it.

Reservation activity is queryable: every claim, denial, force, release, renewal and GC expiry is an `app.log.jsonl` line under module `reservations`, and `pa claims --stats [--days N] [--json]` rolls the last 7 days up.

## 6. Canonical references (code pointers)

Pointers cite `symbol — file (around line N)`. Symbol names survive refactors; line numbers drift. If the symbol has moved, grep for it rather than trusting the line.

| Symbol / constant                               | File (approx. line)                                              |
|-------------------------------------------------|------------------------------------------------------------------|
| `SESSION_TTL_MS` (24 h cutoff)                  | `projects/telegram-bot/src/session.ts` (~10)                     |
| `cleanupExpiredSessions` (claude TTL)           | `projects/telegram-bot/src/session.ts` (~19)                     |
| `cleanupCodexSessions` (UPDATE threads SET …)   | `projects/telegram-bot/src/session.ts` (~89)                     |
| `claudeSessionPath` (project dir encoding)      | `projects/telegram-bot/src/session.ts` (~112)                    |
| `codexSessionExists` (SELECT from threads)      | `projects/telegram-bot/src/session.ts` (~116)                    |
| `sessionFileExists` (dispatch by worker)        | `projects/telegram-bot/src/session.ts` (~147)                    |
| `discoverAgySessionId` (mtime fallback for agy) | `projects/telegram-bot/src/session.ts` (~274)                    |
| `buildResumeArgs` (`--resume` vs `resume` vs `--conversation`) | `projects/telegram-bot/src/session.ts` (~302)       |
| Session-ID capture from stream-json init event  | `pa/src/worker-exec.ts` (~297)                                   |
| `BOT_CWD` / `CLAUDE_FAMILY_WORKERS`            | `projects/telegram-bot/src/main.ts` (~54, 61)                     |
| `findLatestStateFile` (walks one level)         | `pa/src/state-monitor.ts` (~24)                                  |
| `analyzeAgentState` (stuck-agent heuristics)    | `pa/src/state-monitor.ts` (~102)                                 |
| Worker definitions (`state_dir`, `state_pattern`) | `~/.pa/config.yaml`                                            |
