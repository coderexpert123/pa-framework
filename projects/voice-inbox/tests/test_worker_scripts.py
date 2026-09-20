#!/usr/bin/env python3
"""Voice-inbox worker-script suite (route / telemetry / input / complete / transcribe).

Two layers:

1. Sync tests — the python worker scripts are pinned to the committed TS
   ledger. The test reads ``src/ledger.ts`` and ``src/contracts.ts`` at
   runtime, extracts the schema SQL, the vocabularies and the transition
   table, and asserts byte/list equality against this file's pinned copy of
   the schema and against the scripts' own constants. Editing one side
   without the other fails a gate (the python test owns the sync).
2. Functional tests — each script runs as a real subprocess against a ledger
   created by executing the EXTRACTED TS SQL (the real producer output, not a
   hand-built fixture), plus the real ``pa/scripts/decisions.py`` for the
   decision-trace path.

Conventions: every test isolates runtime state under a per-test ``PA_HOME``
(the repo convention); no test talks to the network or to the live ``~/.pa``.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
REPO = PROJECT.parents[1]
SCRIPTS = PROJECT / "scripts"
LEDGER_TS = PROJECT / "src" / "ledger.ts"
CONTRACTS_TS = PROJECT / "src" / "contracts.ts"
SCRIPT_NAMES = ["route_task.py", "task_telemetry.py", "task_input.py", "task_complete.py",
                "task_transcribe.py"]

sys.path.insert(0, str(SCRIPTS))
import route_task  # noqa: E402
import task_complete  # noqa: E402
import task_input  # noqa: E402
import task_telemetry  # noqa: E402
import task_transcribe  # noqa: E402

TENANT_ID = "t-42"
CHAT_ID = -1001234567890
THREAD_ID = 1040
TOPIC_KEY = f"{CHAT_ID}_{THREAD_ID}"
TASK_ID = "vi-" + "ab" * 6
REQUEST_TEXT = "Summarize the Q3 report"
LEDGER_MISSING_MSG = "ledger missing: start the server first"

# ---------------------------------------------------------------------------
# Pinned copies of the shared contract text (transcribed from the 2026-09-05
# build spec; the runtime extractions from the TS sources must equal these).
# ---------------------------------------------------------------------------

SCHEMA_SQL = """CREATE TABLE IF NOT EXISTS tenants (
  tenant_id        TEXT PRIMARY KEY,           -- 't-<telegram_user_id>'
  telegram_user_id INTEGER NOT NULL UNIQUE,
  telegram_chat_id INTEGER NOT NULL,
  display_name     TEXT,
  created_at       TEXT NOT NULL               -- ISO-8601 Z
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,             -- 'vi-<12 hex>'
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  source         TEXT NOT NULL CHECK (source IN ('voice','text')),
  transcript     TEXT,                         -- voice only; text tasks NULL
  request_text   TEXT NOT NULL,                -- what the operator asked (text or transcript)
  state          TEXT NOT NULL CHECK (state IN
                   ('received','transcribing','routed','running','awaiting_input','transcribe_failed','done','failed','cancelled')),
  routed_to      TEXT,                         -- '<chatId>_<threadId>' topic key
  routing_reason TEXT,
  result_summary TEXT,                         -- filled by task_complete.py
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '', -- v3: the conversation's root task_id; createTask always sets it
  worker_resource TEXT,                     -- v3: PA_WORKER_RESOURCE of the worker executing this task
  worker_dispatch_id TEXT,                  -- v4: PA_WORKER_DISPATCH_ID — identifies the DISPATCH, not the lane
  steer_mode      TEXT,                     -- v4: 'queue' | 'interrupt' when this task was recorded as a steer
  feedback_about  TEXT,                     -- v7: 'vi-<12 hex>' conversation or task this feedback is about; set only via POST /tasks, NULL otherwise
  result_short    TEXT,                     -- v8: worker-written standalone short summary (the card's IN SHORT lead); NEVER capped or trimmed
  suggested_items TEXT,                     -- v10: AI-234 worker-written quick-reply chip labels (JSON array); plain product language only
  tg_message_id   INTEGER,                  -- v11: AI-218 Telegram message_id of the FYI reply the bot posted to the topic; the deep-link anchor (NULL until the bot captures it post-send)
  result_structured TEXT,                    -- v12: worker-written structured answer data (JSON); NULL when absent, falls back to markdown
  surface        TEXT,                       -- v13: 'phone' | 'desktop' — the viewport class the question was asked FROM, captured once at creation; NULL on every pre-v13 row and on any client that omits it. A layout preference only, never a content gate
  retried_by     TEXT,                       -- v14: the retry task created from this failed task (Retry in the app); NULL while unresolved. Set only by createTask in the same transaction that creates the retry
  worker_cli      TEXT,                      -- v15: the worker CLI that ran this task (e.g. 'zclaude'); NULL on pre-v15 rows and runs that never stamped progress
  worker_model    TEXT,                      -- v15: the resolved model string for that run; NULL until the worker stamps identity
  worker_effort   TEXT,                      -- v15: the resolved effort tier for that run; NULL when unset or uninstrumented
  router_decision TEXT,                      -- v16: PA_ROUTING_DECISION ('router' | 'ladder' | 'command') — who picked the serving turn's worker; NULL when uninstrumented
  router_placement TEXT,                     -- v16: PA_ROUTING_PLACEMENT ('continued-here' | 'diverted' | 'new-conversation' | 'split'); NULL = no placement fact for the serving turn
  router_target   TEXT,                      -- v16: PA_ROUTING_TARGET — the ORIGIN conversation id ('vi-<12 hex>') on a placed turn's destination leg; ids only, never turn text
  router_steer    TEXT,                      -- v16: PA_ROUTING_STEER ('steer' | 'wait'); NULL when the turn did not interact with a running task
  router_steer_by TEXT,                      -- v16: PA_ROUTING_STEER_BY ('router' | 'operator') — who made the steer/wait call; stamped only alongside router_steer
  router_effort_proj TEXT,                   -- v16: PA_ROUTING_EFFORT_PROJ ('applied' | 'nearest' | 'recategorize'); NULL when no effort projection applied
  router_failovers INTEGER                    -- v16: PA_ROUTING_FAILOVERS — dispatches that failed before the serving hop; NULL when absent (uninstrumented, or first attempt served)
);
CREATE INDEX IF NOT EXISTS tasks_tenant_created ON tasks(tenant_id, created_at DESC);
CREATE TABLE IF NOT EXISTS input_requests (
  request_id     TEXT PRIMARY KEY,             -- 'ir-<12 hex>'
  task_id        TEXT NOT NULL REFERENCES tasks(task_id),
  tenant_id      TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('secret','text','choice','oauth','file','confirm','form')),
  prompt         TEXT NOT NULL,                -- model-written copy, 1..500 chars
  params_json    TEXT NOT NULL DEFAULT '{}',   -- per-kind params (§4); NEVER an answer value
  status         TEXT NOT NULL CHECK (status IN
                   ('pending','answered','expired','cancelled')),
  answer_pointer TEXT,                         -- path under ~/.pa/voice-inbox/ ; never the value
  created_at     TEXT NOT NULL,
  answered_at    TEXT
);
CREATE INDEX IF NOT EXISTS inputs_task_status ON input_requests(task_id, status);
CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,                  -- 's-<12 hex>', minted by the writer
  kind         TEXT NOT NULL CHECK (kind IN
                 ('task.received','task.routed','task.progress','task.input_needed',
                  'task.input_received','task.result_ready','task.completed',
                  'task.failed','task.cancelled','task.rerouted','task.transcribed')),
  summary      TEXT,                           -- model-phrased plain language, ≤200 chars
  payload_json TEXT NOT NULL DEFAULT '{}',     -- structured facts, redacted, never secrets
  ts           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task_ts ON events(task_id, event_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,               -- sha256 hex of the bearer token
  tenant_id    TEXT NOT NULL REFERENCES tenants(tenant_id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash        TEXT PRIMARY KEY,           -- sha256 hex of the 8-char code
  telegram_user_id INTEGER NOT NULL,
  telegram_chat_id INTEGER NOT NULL,
  first_name       TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,              -- +10 min
  consumed_at      TEXT
);
CREATE TABLE IF NOT EXISTS conversation_meta (
  conversation_id TEXT PRIMARY KEY,           -- v5: the conversation's root task_id ('vi-<12 hex>')
  tenant_id       TEXT NOT NULL,
  title           TEXT,                       -- v5: worker-set noun phrase, <=60 chars; NULL means the client derives one
  recap           TEXT,                       -- v5: worker-set state sentences, <=400 chars; NULL means the client derives one
  next_action     TEXT,                       -- v5: worker-set action line, <=200 chars; NULL means none
  updated_at      TEXT NOT NULL,
  viewed_at       TEXT                        -- v14: ISO Z time the operator first viewed the current answer; NULL = never viewed. Written only by POST /conversations/:id/viewed and the v14 migration
);
CREATE INDEX IF NOT EXISTS conversation_meta_tenant ON conversation_meta(tenant_id);
CREATE TABLE IF NOT EXISTS conversation_shares (
  token           TEXT PRIMARY KEY,           -- base64url(randomBytes(32)); stored raw by deliberate design (read-only passive grant, not account auth)
  tenant_id       TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS conversation_shares_lookup
  ON conversation_shares(tenant_id, conversation_id, revoked_at);"""

# The target-topic injection text of the route-queue contract, transcribed
# independently from the spec (route_task.py must render exactly this).
EXPECTED_TARGET_TEXT = (
    "[Voice task {task_id} routed from inbox — reason: {reason}] {briefing}{framing}{request_text}. {attachments}"
    "This task arrives from the voice-inbox app (our own PWA, fully ours — long-press menus, custom sheets and inline widgets all possible); design UI answers for that surface, not Telegram's Bot-API constraints. "
    "Run first: python \"{repo}/projects/voice-inbox/scripts/task_telemetry.py\" start --task {task_id}. "
    "For operator input (secret, choice, confirm/yes-no, file, Google consent), use "
    "python \"{repo}/projects/voice-inbox/scripts/task_input.py\" create --help — "
    "a typed widget, never chat text, never HTML. "
    "If a tool needs authorization (a URL, code, key, password, or a yes/no you cannot answer): pa auth request with the shape, pa auth wait, then re-run non-interactively — never stall or ask in chat. "
    "Choose autonomously — never ask which topic (no choice widget, no chat question); "
    "if torn, route to the closest match and state the reason. "
    "Emit progress via task_telemetry.py (plan:/build:/verify: prefix optional; else plain Running); "
    "finish with python \"{repo}/projects/voice-inbox/scripts/task_complete.py\" --task {task_id} "
    "--summary \"<the complete answer>\". "
    "The summary is what the operator reads — every substantive detail of the answer, "
    "no length trimming; strip only technical narration "
    "(tool names, paths, commands, steps). "
    "Also pass --short \"<the verdict, not the reasoning>\" — one or two plain sentences an average non-technical user understands, in the product's own terms. Never a truncated start; never capped. "
    "Never narrate internal housekeeping (brain upkeep, claims, gates, telemetry, coordination) — do it silently, or page via pa ping only if the operator must act. "
    "Format richly for the answer card (it renders markdown): blank line between points, "
    "### headings, **bold**, - or 1) lists, pipe tables with a |---| row, code fences, "
    "[text](url) or bare links. "
    "Never hard-code colours in HTML. "
    "Keep the conversation's three summary lines current: pass --title (a short noun phrase "
    "for the conversation, at most 60 characters, never a transcription of "
    "the request), --recap (one or two plain sentences on what is happening and "
    "where it stands) and --next (one line for the operator's next step, omitted "
    "when there is nothing) to task_complete.py, and the same three flags to task_input.py "
    "create whenever you ask a question. "
    "Phrase --prompt and choice labels in plain language — no ids, tool names, paths, or technical terms. "
    "Pass --suggest \"<plain follow-up>\" repeatable (0..4), ≤40 chars each, "
    "plain words only; non-plain entries dropped. Omit when nothing natural follows. "
    "For comparison/listing/guide/form-set/summary answers, pass --structured <json> (task_complete.py --help). "
)

# GOLDEN_BRIEFING_TEMPLATE — the byte-identical twin of
# `src/tests/conversation-briefing.test.ts`'s GOLDEN_A (fixture A), parameterised
# on the ledger path since the lookup line always names it (t-3, 2026-09-18: the
# per-turn dump was replaced with a single runnable ledger-lookup line, so the
# constant is no longer ledger-path-independent). The pair IS the cross-language
# pin (§7.2 G4 of the AI-conversation-context spec, 2026-09-10): editing one
# without moving the other breaks it.
GOLDEN_BRIEFING_TEMPLATE = (
    "Conversation so far (vi-aaaaaaaaaaaa): 2 earlier turn(s), oldest first.\n"
    "Title: Strava caption for today's workout\n"
    "Where it stands: Three caption drafts are on the table; the operator wants a shorter one.\n"
    "Next: Pick one of the three captions.\n"
    "Full turn-by-turn record: sqlite3 \"{ledger_path}\" \"SELECT created_at, request_text, "
    "result_summary FROM tasks WHERE conversation_id = 'vi-aaaaaaaaaaaa' ORDER BY created_at ASC\".\n"
    "End of the conversation record.\n"
)

# The fixed-ledger-path instance used by tests that call build_conversation_briefing
# directly with an explicit ledger_path argument (matches the TS test's LEDGER_PATH).
GOLDEN_BRIEFING = GOLDEN_BRIEFING_TEMPLATE.format(ledger_path="C:/tmp/pa/voice-inbox/ledger.sqlite")

# ---------------------------------------------------------------------------
# Extraction helpers (the TS sources are the single source of truth)
# ---------------------------------------------------------------------------


def extract_schema_sql() -> str:
    text = LEDGER_TS.read_text(encoding="utf-8")
    match = re.search(r"LEDGER_SCHEMA_SQL = `(.*?)`;", text, re.S)
    assert match, "LEDGER_SCHEMA_SQL template literal not found in ledger.ts"
    return match.group(1)


def extract_ledger_schema_version() -> int:
    match = re.search(r"export const LEDGER_SCHEMA_VERSION = (\d+);",
                      LEDGER_TS.read_text(encoding="utf-8"))
    assert match, "LEDGER_SCHEMA_VERSION not found in ledger.ts"
    return int(match.group(1))


def extract_quoted_list(text: str, pattern: str) -> list[str]:
    match = re.search(pattern, text, re.S)
    assert match, f"pattern not found: {pattern}"
    return re.findall(r"'([^']+)'", match.group(1))


def extract_ledger_states() -> list[str]:
    return extract_quoted_list(LEDGER_TS.read_text(encoding="utf-8"),
                               r"export const TASK_STATES = \[(.*?)\] as const")


def extract_ledger_transitions() -> dict[str, list[str]]:
    text = LEDGER_TS.read_text(encoding="utf-8")
    match = re.search(r"export const TASK_TRANSITIONS[^=]*= \{(.*?)\n\};", text, re.S)
    assert match, "TASK_TRANSITIONS record not found in ledger.ts"
    entries = dict(re.findall(r"(\w+): \[([^\]]*)\]", match.group(1)))
    return {state: re.findall(r"'([^']+)'", targets) for state, targets in entries.items()}


def extract_contracts_kinds(pattern: str) -> list[str]:
    return extract_quoted_list(CONTRACTS_TS.read_text(encoding="utf-8"), pattern)


def sql_tables(schema_sql: str) -> dict[str, str]:
    tables = re.findall(r"CREATE TABLE IF NOT EXISTS (\w+) \((.*?)\);\n", schema_sql, re.S)
    return dict(tables)


def sql_check_list(table_body: str, column: str) -> list[str]:
    match = re.search(rf"CHECK \({column} IN\s*\((.*?)\)\)", table_body, re.S)
    assert match, f"CHECK IN list for {column} not found"
    return re.findall(r"'([^']+)'", match.group(1))


def shared_block(script_name: str) -> str:
    text = (SCRIPTS / script_name).read_text(encoding="utf-8")
    match = re.search(r"^# BEGIN SHARED LEDGER HELPER\n(.*?)^# END SHARED LEDGER HELPER",
                      text, re.S | re.M)
    assert match, f"shared helper block not found in {script_name}"
    return match.group(1)


# ---------------------------------------------------------------------------
# Test-environment helpers
# ---------------------------------------------------------------------------


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_ledger(tmp_path: Path) -> Path:
    """Create the ledger by executing the SQL extracted from the committed TS."""
    vi_dir = tmp_path / "voice-inbox"
    vi_dir.mkdir(parents=True)
    db_path = vi_dir / "ledger.sqlite"
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(extract_schema_sql())
    conn.execute(f"PRAGMA user_version = {extract_ledger_schema_version()}")
    conn.commit()
    conn.close()
    return db_path


def seed_task(db_path: Path, task_id: str = TASK_ID, state: str = "received",
              request_text: str = REQUEST_TEXT, source: str = "text",
              conversation_id: str | None = None,
              steer_mode: str | None = None,
              worker_dispatch_id: str | None = None,
              created_at: str | None = None,
              result_summary: str | None = None,
              feedback_about: str | None = None,
              routed_to: str | None = None) -> None:
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO tenants"
            " (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)"
            " VALUES (?, 42, ?, 'Operator', ?)",
            (TENANT_ID, CHAT_ID, iso_now()),
        )
        conn.execute(
            "INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text,"
            " state, result_summary, created_at, updated_at, conversation_id, steer_mode,"
            " worker_dispatch_id, feedback_about, routed_to)"
            " VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (task_id, TENANT_ID, source, request_text, state, result_summary,
             created_at if created_at is not None else iso_now(), iso_now(),
             conversation_id if conversation_id is not None else task_id,
             steer_mode, worker_dispatch_id, feedback_about, routed_to),
        )
    conn.close()


def seed_conversation_meta(db_path: Path, conversation_id: str, tenant_id: str = TENANT_ID,
                            title: str | None = None, recap: str | None = None,
                            next_action: str | None = None) -> None:
    """Direct conversation_meta row insert for briefing fixtures (mirrors the
    TS suite's setConversationMeta seeding — this test file never calls the
    scripts' own set_conversation_meta for fixture setup, only to exercise it)."""
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "INSERT INTO conversation_meta"
            " (conversation_id, tenant_id, title, recap, next_action, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (conversation_id, tenant_id, title, recap, next_action, iso_now()),
        )
    conn.close()


def seed_topics(pa_home: Path) -> None:
    (pa_home / "telegram-topic-names.json").write_text(json.dumps({
        str(CHAT_ID): {str(THREAD_ID): {"name": "Reports", "description": "report tasks"}},
    }), encoding="utf-8")


def make_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, task_state: str = "received",
              topics: bool = True) -> Path:
    """Fresh isolated PA_HOME with a seeded ledger (+ task) and topic names."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, state=task_state)
    if topics:
        seed_topics(tmp_path)
    return db_path


def make_voice_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Like make_case, but the task is a voice recording sitting in the
    transcribing stage (the state the server leaves a fresh voice task in)."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, source="voice", state="transcribing")
    seed_topics(tmp_path)
    return db_path


def run_script(name: str, *argv: str, pa_home: Path,
                extra_env: dict[str, str | None] | None = None) -> subprocess.CompletedProcess:
    """`extra_env` overlays on top of the real environment; a `None` value
    deletes the key (used to prove behavior when a var is truly absent,
    regardless of whatever the host environment happens to carry)."""
    # PA_NOTIFY_DISABLED defaults to 1 here (the bot/pa suites' same gate):
    # task_complete/task_input fire a best-effort `pa ping` attention page on
    # success, and a test run must never page the operator for real.
    env = {**os.environ, "PA_HOME": str(pa_home), "PA_NOTIFY_DISABLED": "1"}
    for key, value in (extra_env or {}).items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return subprocess.run(
        [sys.executable, str(SCRIPTS / name), *argv],
        capture_output=True, encoding="utf-8", errors="replace", env=env, timeout=60,
    )


def out_json(proc: subprocess.CompletedProcess) -> dict:
    lines = [line for line in proc.stdout.strip().splitlines() if line.strip()]
    assert lines, f"no stdout: rc={proc.returncode} stderr={proc.stderr}"
    return json.loads(lines[-1])


def expect_fail(proc: subprocess.CompletedProcess, fragment: str) -> dict:
    assert proc.returncode == 1, \
        f"expected exit 1, got {proc.returncode}: stdout={proc.stdout!r} stderr={proc.stderr!r}"
    payload = out_json(proc)
    assert payload.get("ok") is False
    assert fragment in str(payload.get("error")), payload
    return payload


def fetch_one(db_path: Path, sql: str, params: tuple = ()) -> dict:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(sql, params).fetchone()
        return dict(row) if row is not None else {}
    finally:
        conn.close()


def fetch_all(db_path: Path, sql: str, params: tuple = ()) -> list[dict]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def read_queue(pa_home: Path) -> list[dict]:
    queue = pa_home / "voice-inbox" / "route-queue.jsonl"
    assert queue.exists(), "route-queue.jsonl was not written"
    lines = [line for line in queue.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [json.loads(line) for line in lines]


TRANSITION_EVENT_FOR = {
    "received": "task.transcribed", "transcribing": "task.transcribed", "routed": "task.routed",
    "running": "task.progress", "awaiting_input": "task.input_needed",
    "transcribe_failed": "task.failed", "done": "task.completed", "failed": "task.failed",
    "cancelled": "task.cancelled",
}


def call_transition(module, task_id: str, to_state: str, event_kind: str | None, **kwargs):
    """Run module.transition_task in its own `with conn:` block, the way the
    scripts do. Returns ("ok", ref_id) or ("refused", exit_code)."""
    conn = module.open_ledger()
    try:
        with conn:
            ref_id, _ts = module.transition_task(conn, task_id, to_state, event_kind, **kwargs)
        return ("ok", ref_id)
    except SystemExit as exc:
        return ("refused", exc.code)
    finally:
        conn.close()


def seed_pending_ask(db_path: Path, request_id: str, task_id: str) -> None:
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "INSERT INTO input_requests"
            " (request_id, task_id, tenant_id, kind, prompt, params_json, status, created_at)"
            " VALUES (?, ?, ?, 'text', 'a question', '{}', 'pending', ?)",
            (request_id, task_id, TENANT_ID, iso_now()),
        )
    conn.close()


# ---------------------------------------------------------------------------
# Sync tests — python scripts pinned to the committed TS ledger
# ---------------------------------------------------------------------------


def test_schema_sql_byte_sync_with_ledger_ts():
    assert extract_schema_sql() == SCHEMA_SQL


def test_event_vocabulary_sync():
    events_body = sql_tables(SCHEMA_SQL)["events"]
    from_sql = sql_check_list(events_body, "kind")
    from_contracts = extract_contracts_kinds(r"export const TASK_EVENT_KINDS = \[(.*?)\] as const")
    assert from_sql == from_contracts
    for name in SCRIPT_NAMES:
        module = {"route_task.py": route_task, "task_telemetry.py": task_telemetry,
                  "task_input.py": task_input, "task_complete.py": task_complete,
                  "task_transcribe.py": task_transcribe}[name]
        assert module.TASK_EVENT_KINDS == from_sql, name


def test_input_kinds_sync():
    inputs_body = sql_tables(SCHEMA_SQL)["input_requests"]
    from_sql = sql_check_list(inputs_body, "kind")
    from_contracts = extract_contracts_kinds(r"export const INPUT_KINDS = \[(.*?)\] as const")
    assert from_sql == from_contracts
    for module in (route_task, task_telemetry, task_input, task_complete, task_transcribe):
        assert module.INPUT_KINDS == from_sql


def test_oauth_providers_sync():
    from_contracts = extract_contracts_kinds(r"export const OAUTH_PROVIDERS = \[(.*?)\] as const")
    assert task_input.OAUTH_PROVIDERS == from_contracts


def test_set_conversation_meta_sync():
    """AI-222 hand-copies `set_conversation_meta` into all FIVE worker scripts
    (route_task.py, task_complete.py, task_input.py, task_telemetry.py,
    task_transcribe.py — each a standalone script with no shared import), the
    same pattern as the target-injection-text triple-copy and
    TASK_STATES/transition-table five-copy already pinned above. Nothing
    pinned this fifth copy before this test (deep-recheck 2026-09-10): the
    five bodies happen to be byte-identical today, but a future edit to only
    one of them would sail through every existing gate silently."""
    import inspect

    reference = inspect.getsource(route_task.set_conversation_meta)
    for module in (task_complete, task_input, task_telemetry, task_transcribe):
        assert inspect.getsource(module.set_conversation_meta) == reference, (
            f"{module.__name__}.set_conversation_meta has drifted from route_task.py's copy"
        )


def test_task_states_sync():
    tasks_body = sql_tables(SCHEMA_SQL)["tasks"]
    from_sql = sql_check_list(tasks_body, "state")
    assert from_sql == extract_ledger_states()
    for module in (route_task, task_telemetry, task_input, task_complete, task_transcribe):
        assert module.TASK_STATES == from_sql


def test_transition_table_sync():
    from_ts = extract_ledger_transitions()
    for module in (route_task, task_telemetry, task_input, task_complete, task_transcribe):
        assert module.TASK_TRANSITIONS == from_ts


def test_shared_helper_blocks_byte_identical():
    blocks = {name: shared_block(name) for name in SCRIPT_NAMES}
    unique = set(blocks.values())
    assert len(unique) == 1, f"shared helper drifted across: {[n for n, b in blocks.items() if b != next(iter(unique))]}"
    block = next(iter(unique))
    # The helper must never create schema and must carry the pinned refusal.
    assert "CREATE TABLE" not in block and "CREATE INDEX" not in block
    assert "executescript" not in block
    assert LEDGER_MISSING_MSG in block


def test_transition_helper_matrix_accepts_only_table_edges(tmp_path, monkeypatch, capsys):
    """Thread lifecycle (2026-09-17): the helper's UPDATE predicate is the only
    gate — every (from, to) pair lands iff the pinned table allows it, and a
    refused pair writes neither state nor event."""
    for from_state in task_complete.TASK_STATES:
        for to_state in task_complete.TASK_STATES:
            home = tmp_path / f"{from_state}-{to_state}"
            db_path = make_case(home, monkeypatch, task_state=from_state)
            outcome, _ = call_transition(task_complete, TASK_ID, to_state,
                                         TRANSITION_EVENT_FOR[to_state])
            legal = to_state in task_complete.TASK_TRANSITIONS[from_state]
            state = fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                              (TASK_ID,))["state"]
            kinds = [e["kind"] for e in fetch_all(db_path, "SELECT kind FROM events")]
            if legal:
                assert outcome == "ok", (from_state, to_state)
                assert state == to_state, (from_state, to_state)
                assert kinds == [TRANSITION_EVENT_FOR[to_state]], (from_state, to_state)
            else:
                assert outcome == "refused", (from_state, to_state)
                assert state == from_state, (from_state, to_state)
                assert kinds == [], (from_state, to_state)
    capsys.readouterr()


def test_transition_helper_race_two_writers_one_wins_no_second_event(tmp_path, monkeypatch, capsys):
    """Two writers race the same completion: exactly one lands, the loser is
    refused, and exactly one task.completed event exists."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    barrier = threading.Barrier(2)
    outcomes: list[str] = []
    lock = threading.Lock()

    def writer() -> None:
        conn = task_complete.open_ledger()
        try:
            barrier.wait()
            try:
                with conn:
                    task_complete.transition_task(conn, TASK_ID, "done", "task.completed",
                                                  {"result_chars": 1})
                result = "ok"
            except SystemExit:
                result = "refused"
        finally:
            conn.close()
        with lock:
            outcomes.append(result)

    threads = [threading.Thread(target=writer) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    assert sorted(outcomes) == ["ok", "refused"]
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?", (TASK_ID,))["state"] == "done"
    assert len(fetch_all(db_path, "SELECT * FROM events WHERE kind = 'task.completed'")) == 1
    capsys.readouterr()


def test_transition_helper_expires_only_the_tasks_own_asks_when_leaving_awaiting_input(tmp_path, monkeypatch, capsys):
    db_path = make_case(tmp_path, monkeypatch, task_state="awaiting_input")
    other_id = "vi-" + "cd" * 6
    seed_task(db_path, task_id=other_id, state="awaiting_input", conversation_id=TASK_ID)
    own_ask, other_ask = "ir-" + "aa" * 6, "ir-" + "bb" * 6
    seed_pending_ask(db_path, own_ask, TASK_ID)
    seed_pending_ask(db_path, other_ask, other_id)
    status = lambda rid: fetch_one(db_path, "SELECT status FROM input_requests WHERE request_id = ?",
                                   (rid,))["status"]
    assert call_transition(task_telemetry, TASK_ID, "failed", "task.failed",
                           payload={"reason": "r"})[0] == "ok"
    assert status(own_ask) == "expired"
    assert status(other_ask) == "pending"
    assert call_transition(task_telemetry, other_id, "cancelled", "task.cancelled",
                           payload={"by": "operator"})[0] == "ok"
    assert status(other_ask) == "cancelled"
    third_id, third_ask = "vi-" + "ef" * 6, "ir-" + "cc" * 6
    seed_task(db_path, task_id=third_id, state="awaiting_input", conversation_id=TASK_ID)
    seed_pending_ask(db_path, third_ask, third_id)
    assert call_transition(task_telemetry, third_id, "running", "task.input_received")[0] == "ok"
    assert status(third_ask) == "pending", "the answer path (-> running) leaves asks alone"
    capsys.readouterr()


# ---------------------------------------------------------------------------
# AI-234: sanitizeSuggestedItems regex sync — the Python twin in
# task_complete.py must match the TS canonical in
# projects/telegram-bot/src/logic.ts byte-for-byte. Builder A owns the TS
# version; this test is the shared seam. When Builder A's logic.ts has not
# landed yet, the cross-language assertion skips (the Python pin still runs).
# ---------------------------------------------------------------------------

# The exact regex pattern string transcribed from the AI-234 spec definition:
# backticks, braces, brackets, angle, =, |, //, \\, file extensions at word
# edge, http, 0x/hex runs.
EXPECTED_SUGGESTED_ITEM_NONPLAIN_PATTERN = (
    r"[`{}[\]<>|=]"
    r"|\/\/"
    r"|\\"
    r"|\.\w{1,4}\b"
    r"|http"
    r"|0x[0-9a-fA-F]+"
)

LOGIC_TS = REPO / "projects" / "telegram-bot" / "src" / "logic.ts"


def _extract_suggested_item_nonplain_pattern_py() -> str:
    """Extract the raw regex pattern string from task_complete.py's
    SUGGESTED_ITEM_NONPLAIN_RE compiled regex."""
    return task_complete.SUGGESTED_ITEM_NONPLAIN_RE.pattern


def _extract_suggested_item_nonplain_pattern_ts() -> str | None:
    """Extract the raw regex pattern string from logic.ts's
    sanitizeSuggestedItems. Returns None when Builder A has not landed it."""
    if not LOGIC_TS.exists():
        return None
    text = LOGIC_TS.read_text(encoding="utf-8")
    # The TS canonical defines the regex as a RegExp literal or via new RegExp.
    # Match a RegExp literal: /pattern/flags  — capture the pattern source.
    match = re.search(r"SUGGESTED_ITEM_NONPLAIN_RE\s*=\s*/((?:[^/\\]|\\.)*)/", text)
    if match:
        return match.group(1)
    # Fallback: new RegExp("pattern", "flags")
    match = re.search(r'SUGGESTED_ITEM_NONPLAIN_RE\s*=\s*new RegExp\(\s*"((?:[^"\\]|\\.)*)"', text)
    if match:
        return match.group(1).replace(r"\\" , "\\")
    return None


def test_suggested_items_regex_pinned_to_spec():
    """The Python regex pattern equals the spec's definition exactly."""
    py_pattern = _extract_suggested_item_nonplain_pattern_py()
    assert py_pattern == EXPECTED_SUGGESTED_ITEM_NONPLAIN_PATTERN, (
        f"Python SUGGESTED_ITEM_NONPLAIN_RE pattern drifted from the spec:\n"
        f"  expected: {EXPECTED_SUGGESTED_ITEM_NONPLAIN_PATTERN!r}\n"
        f"  got:      {py_pattern!r}"
    )


def test_suggested_items_regex_syncs_with_ts_logic():
    """The Python regex pattern is byte-equal to the TS canonical in logic.ts.
    Skips when Builder A's sanitizeSuggestedItems has not landed yet."""
    ts_pattern = _extract_suggested_item_nonplain_pattern_ts()
    if ts_pattern is None:
        pytest.skip("Builder A's SUGGESTED_ITEM_NONPLAIN_RE not yet landed in "
                    "projects/telegram-bot/src/logic.ts — cross-language sync "
                    "test will activate when it lands")
    py_pattern = _extract_suggested_item_nonplain_pattern_py()
    assert py_pattern == ts_pattern, (
        f"sanitizeSuggestedItems regex drifted between Python and TS:\n"
        f"  python: {py_pattern!r}\n"
        f"  ts:     {ts_pattern!r}"
    )


def test_suggested_items_caps_sync():
    """The 4/40 caps match between Python and the spec."""
    assert task_complete.SUGGESTED_ITEM_MAX == 4
    assert task_complete.SUGGESTED_ITEM_LABEL_MAX == 40


def test_sanitize_suggested_items_drops_non_plain():
    """The Python twin drops code symbols, paths, URLs; keeps plain prose."""
    sanitize = task_complete.sanitize_suggested_items
    # Plain prose survives
    assert sanitize(["Tell me more", "Show the details"]) == ["Tell me more", "Show the details"]
    # Backticks, braces, brackets, angle, =, |, //, \\, file ext, http, 0x all drop
    assert sanitize(["`code`"]) == []
    assert sanitize(["{json}"]) == []
    assert sanitize(["[array]"]) == []
    assert sanitize(["<tag>"]) == []
    assert sanitize(["key=value"]) == []
    assert sanitize(["a|b"]) == []
    assert sanitize(["a//b"]) == []
    assert sanitize(["a\\b"]) == []
    assert sanitize(["file.pdf"]) == []
    assert sanitize(["http://example.com"]) == []
    assert sanitize(["0xDEADBEEF"]) == []
    # Mixed: plain survives, non-plain drops
    assert sanitize(["Tell me more", "`code`", "Show the details"]) == ["Tell me more", "Show the details"]
    # Empty / whitespace / too long drop
    assert sanitize(["", "   ", "x" * 41]) == []
    # Caps at 4
    assert sanitize(["a", "b", "c", "d", "e"]) == ["a", "b", "c", "d"]
    # Dedup
    assert sanitize(["Tell me more", "Tell me more"]) == ["Tell me more"]
    # None / empty input
    assert sanitize(None) == []
    assert sanitize([]) == []


def test_missing_ledger_refuses_and_creates_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "done",
                      pa_home=tmp_path)
    payload = expect_fail(proc, LEDGER_MISSING_MSG)
    assert payload == {"ok": False, "error": LEDGER_MISSING_MSG}
    assert not (tmp_path / "voice-inbox" / "ledger.sqlite").exists()


def test_schemaless_ledger_refuses(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    (tmp_path / "voice-inbox").mkdir(parents=True)
    (tmp_path / "voice-inbox" / "ledger.sqlite").write_bytes(b"")
    shot = tmp_path / "shot.png"  # task_blocker_ask copies this before its child refuses
    shot.write_bytes(b"x")
    cases = [
        ("route_task.py", ["--task", TASK_ID, "--topic", TOPIC_KEY, "--reason", "r"]),
        ("task_telemetry.py", ["start", "--task", TASK_ID]),
        ("task_input.py", ["create", "--task", TASK_ID, "--kind", "text", "--prompt", "ok"]),
        ("task_complete.py", ["--task", TASK_ID, "--summary", "done"]),
        ("task_transcribe.py", ["--task", TASK_ID, "--transcript", "hello"]),
        ("task_blocker_ask.py", ["--task", TASK_ID, "--screenshot", str(shot), "--prompt", "p"]),
    ]
    for name, argv in cases:
        expect_fail(run_script(name, *argv, pa_home=tmp_path), LEDGER_MISSING_MSG)


# ---------------------------------------------------------------------------
# route_task.py
# ---------------------------------------------------------------------------


def test_route_happy_path_from_received(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["task_id"] == TASK_ID
    assert payload["state"] == "routed"
    assert payload["routed_to"] == TOPIC_KEY
    assert payload["steer_outcome"] == "not-requested"

    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "routed"
    assert task["routed_to"] == TOPIC_KEY
    assert task["routing_reason"] == "reports fit here"

    event = fetch_one(
        db_path,
        "SELECT * FROM events WHERE task_id = ? AND kind = 'task.routed'", (TASK_ID,))
    assert event["ref_id"] == payload["ref_id"]
    assert re.fullmatch(r"s-[0-9a-f]{12}", event["ref_id"])
    # No steer_mode on this task: the payload deep-equals exactly {routed_to,
    # reason} — no steer keys.
    assert json.loads(event["payload_json"]) == {"routed_to": TOPIC_KEY, "reason": "reports fit here"}
    assert event["tenant_id"] == TENANT_ID
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", event["ts"])

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    entry = entries[0]
    assert list(entry.keys()) == ["q_id", "ts", "task_id", "tenant_id", "chat_id",
                                  "thread_id", "text", "ref_id"]
    assert re.fullmatch(r"rq-[0-9a-f]{12}", entry["q_id"])
    assert entry["task_id"] == TASK_ID
    assert entry["tenant_id"] == TENANT_ID
    assert entry["chat_id"] == CHAT_ID and isinstance(entry["chat_id"], int)
    assert entry["thread_id"] == THREAD_ID and isinstance(entry["thread_id"], int)
    assert entry["ref_id"] == payload["ref_id"]


def test_route_queue_text_matches_contract(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    repo = REPO.resolve().as_posix()
    expected = EXPECTED_TARGET_TEXT.format(
        task_id=TASK_ID, reason="reports fit here", request_text=REQUEST_TEXT, repo=repo,
        briefing="", framing="", attachments="")


def test_route_records_decision_trace(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    decisions_path = tmp_path / "decisions.sqlite"
    assert decisions_path.exists(), "decisions.sqlite was not created by the trace"
    rows = fetch_all(decisions_path, "SELECT * FROM decisions")
    assert len(rows) == 1
    row = rows[0]
    assert row["source"] == "skill"
    assert row["skill"] == "voice-inbox"
    assert row["request_excerpt"] == REQUEST_TEXT
    assert row["decision"] == f"routed to {TOPIC_KEY}"
    assert row["rationale"] == "reports fit here"
    assert re.fullmatch(r"d-\d{12}-[0-9a-f]{12}", row["decision_id"])


def test_route_rejects_unknown_or_malformed_topic(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch)
    for bad_topic in ("-1009999999999_9999", "not-a-topic-key", "-1001234567890_"):
        proc = run_script("route_task.py", "--task", TASK_ID, "--topic", bad_topic,
                          "--reason", "r", pa_home=tmp_path)
        expect_fail(proc, "topic")
    task = fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "received"
    # No queue entry may exist for a rejected route.
    assert not (tmp_path / "voice-inbox" / "route-queue.jsonl").exists()


def test_route_rejects_wrong_state_and_missing_task(tmp_path, monkeypatch):
    # 2026-09-17: a running task is routable only while no route ever placed it
    # (routed_to NULL, OD-1) — this one was routed, so routing refuses.
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, state="running", routed_to=TOPIC_KEY)
    seed_topics(tmp_path)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", pa_home=tmp_path)
    expect_fail(proc, "running")
    proc = run_script("route_task.py", "--task", "vi-" + "ff" * 6, "--topic", TOPIC_KEY,
                      "--reason", "r", pa_home=tmp_path)
    expect_fail(proc, "not found")
    assert fetch_all(db_path, "SELECT * FROM events") == []
    assert not (tmp_path / "voice-inbox" / "route-queue.jsonl").exists()


def test_route_accepts_a_running_task_never_routed_and_clears_worker_identity(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET worker_resource = ?, worker_dispatch_id = ? WHERE task_id = ?",
                     ("topic--1001234567890_1040-th3", "a1b2c3d4e5f6", TASK_ID))
    conn.close()
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "early progress post", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "routed"
    assert task["routed_to"] == TOPIC_KEY
    assert task["worker_resource"] is None
    assert task["worker_dispatch_id"] is None
    assert [e["kind"] for e in fetch_all(db_path, "SELECT kind FROM events")] == ["task.routed"]
    assert len(read_queue(tmp_path)) == 1


def test_route_refuses_a_running_task_already_routed(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, state="running", routed_to=TOPIC_KEY)
    seed_topics(tmp_path)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "late re-route", pa_home=tmp_path)
    expect_fail(proc, f"task {TASK_ID} is running; routing is valid from received or routed, "
                      "or from running before any route")
    task = fetch_one(db_path, "SELECT state, routed_to FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task == {"state": "running", "routed_to": TOPIC_KEY}
    assert fetch_all(db_path, "SELECT * FROM events") == []
    assert not (tmp_path / "voice-inbox" / "route-queue.jsonl").exists()


def test_route_reroute_from_routed_is_allowed(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "better fit", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "routed"
    assert len(fetch_all(db_path, "SELECT * FROM events WHERE kind = 'task.routed'")) == 1
    assert len(read_queue(tmp_path)) == 1


def test_route_continues_merges_conversation_and_extends_payload(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch)  # TASK_ID: conversation_id defaults to itself
    parent_id = "vi-" + "11" * 6
    # A terminal-but-not-cancelled parent is allowed on the automatic path too
    # (D2: only a cancelled newest task refuses the automatic merge).
    seed_task(db_path, task_id=parent_id, state="done", request_text="parent request")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", "--continues", parent_id,
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["conversation_id"] == parent_id

    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["conversation_id"] == parent_id

    event = fetch_one(
        db_path, "SELECT * FROM events WHERE task_id = ? AND kind = 'task.routed'", (TASK_ID,))
    event_payload = json.loads(event["payload_json"])
    assert event_payload["routed_to"] == TOPIC_KEY
    assert event_payload["reason"] == "reports fit here"
    assert event_payload["continues"] == parent_id
    assert event_payload["conversation_id"] == parent_id


def test_route_continues_unknown_target_fails(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch)
    unknown_id = "vi-" + "22" * 6
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--continues", unknown_id, pa_home=tmp_path)
    expect_fail(proc, f"continues target not found: {unknown_id}")
    task = fetch_one(db_path, "SELECT state, conversation_id FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "received"
    assert task["conversation_id"] == TASK_ID
    assert fetch_all(db_path, "SELECT * FROM events") == []


def test_route_continues_cross_tenant_fails(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch)
    other_tenant = "t-999"
    other_task = "vi-" + "33" * 6
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO tenants"
            " (tenant_id, telegram_user_id, telegram_chat_id, display_name, created_at)"
            " VALUES (?, 999, ?, 'Other', ?)",
            (other_tenant, CHAT_ID, iso_now()),
        )
        conn.execute(
            "INSERT INTO tasks (task_id, tenant_id, source, transcript, request_text,"
            " state, created_at, updated_at, conversation_id)"
            " VALUES (?, ?, 'text', NULL, ?, 'received', ?, ?, ?)",
            (other_task, other_tenant, "other tenant's request", iso_now(), iso_now(), other_task),
        )
    conn.close()
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--continues", other_task, pa_home=tmp_path)
    expect_fail(proc, "continues target belongs to another tenant")
    task = fetch_one(db_path, "SELECT state, conversation_id FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "received"
    assert task["conversation_id"] == TASK_ID
    assert fetch_all(db_path, "SELECT * FROM events") == []


def test_route_continues_cancelled_conversation_fails(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch)
    parent_id = "vi-" + "44" * 6
    seed_task(db_path, task_id=parent_id, state="cancelled", request_text="cancelled parent")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--continues", parent_id, pa_home=tmp_path)
    expect_fail(proc, f"conversation of task {parent_id} was cancelled; not merging")
    task = fetch_one(db_path, "SELECT state, conversation_id FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "received"
    assert task["conversation_id"] == TASK_ID
    assert fetch_all(db_path, "SELECT * FROM events") == []


def queue_lock_dir(tmp_path: Path) -> Path:
    return tmp_path / "voice-inbox" / "route-queue.jsonl.lock"


def test_route_append_rejects_while_lock_held(tmp_path, monkeypatch):
    """A live holder of the shared mutex blocks the append: the script must
    fail loudly and write NOTHING — an unguarded fallback append is exactly
    the silent loss the spec §7 mutex exists to prevent."""
    make_case(tmp_path, monkeypatch)
    queue_dir = tmp_path / "voice-inbox"
    (queue_dir / "route-queue.jsonl").touch()
    lock_dir = queue_lock_dir(tmp_path)
    lock_dir.mkdir()
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", pa_home=tmp_path)
    expect_fail(proc, "lock")
    assert lock_dir.exists(), "a live holder's lock directory must never be removed"
    assert read_queue(tmp_path) == []


def test_route_append_steals_a_stale_lock(tmp_path, monkeypatch):
    """A lock directory older than the stale window is a dead holder's
    leftover: the append steals it, writes the line, and releases the lock
    (proper-lockfile's mtime staleness semantics, which the bot drain and
    bridge-writer both run with stale=5000)."""
    make_case(tmp_path, monkeypatch)
    queue_dir = tmp_path / "voice-inbox"
    (queue_dir / "route-queue.jsonl").touch()
    lock_dir = queue_lock_dir(tmp_path)
    lock_dir.mkdir()
    aged = time.time() - (route_task.ROUTE_QUEUE_LOCK_STALE_MS / 1000) - 5
    os.utime(lock_dir, (aged, aged))
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert not lock_dir.exists()
    assert len(read_queue(tmp_path)) == 1


def test_route_append_releases_the_lock(tmp_path, monkeypatch):
    """The happy path leaves the shared mutex unheld (os.mkdir lock, rmdir
    release — the same on-disk shape proper-lockfile leaves behind)."""
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert not queue_lock_dir(tmp_path).exists()
    assert len(read_queue(tmp_path)) == 1


# --- WP-5: steer entries (D5/D9/K6/§3.5/§4) ----------------------------------


def test_route_steer_from_received_writes_a_steer_entry(tmp_path, monkeypatch):
    """A `received` task with steer_mode set writes a `kind:"steer"` queue
    line whose text is byte-identical to the plain target injection text
    (K6) — this script only writes the verb entry, it never frames it."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, steer_mode="interrupt")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["steer_outcome"] == "queued"

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    entry = entries[0]
    assert list(entry.keys()) == [
        "q_id", "ts", "task_id", "tenant_id", "chat_id", "thread_id", "text", "ref_id",
        "kind", "steer_mode", "steer_conversation",
    ]
    assert entry["kind"] == "steer"
    assert entry["steer_mode"] == "interrupt"
    assert entry["steer_conversation"] == TASK_ID  # self-rooted conversation
    # chat_id/thread_id still come from --topic (§3.6), same as a plain route.
    assert entry["chat_id"] == CHAT_ID and isinstance(entry["chat_id"], int)
    assert entry["thread_id"] == THREAD_ID and isinstance(entry["thread_id"], int)
    repo = REPO.resolve().as_posix()
    expected_text = EXPECTED_TARGET_TEXT.format(
        task_id=TASK_ID, reason="reports fit here", request_text=REQUEST_TEXT, repo=repo,
        briefing="", framing="", attachments="")
    assert entry["text"] == expected_text

    event = fetch_one(
        db_path, "SELECT * FROM events WHERE task_id = ? AND kind = 'task.routed'", (TASK_ID,))
    event_payload = json.loads(event["payload_json"])
    assert event_payload["steer"] == "interrupt"
    assert event_payload["steer_conversation"] == TASK_ID
    assert event_payload["steer_outcome"] == "queued"
    assert "steer_reason" not in event_payload


def test_route_steer_reroute_does_not_refire(tmp_path, monkeypatch):
    """D5: a steer fires on first routing only. A `routed → routed` re-route
    of a task that carries steer_mode writes a PLAIN route entry (never a
    second steer) and records steer_outcome:"none" with the fixed reason."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, state="routed", steer_mode="queue")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "better fit", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["steer_outcome"] == "none"

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    assert list(entries[0].keys()) == [
        "q_id", "ts", "task_id", "tenant_id", "chat_id", "thread_id", "text", "ref_id",
    ]

    event = fetch_one(
        db_path, "SELECT * FROM events WHERE task_id = ? AND kind = 'task.routed'", (TASK_ID,))
    event_payload = json.loads(event["payload_json"])
    assert event_payload["steer"] == "queue"
    assert event_payload["steer_outcome"] == "none"
    assert event_payload["steer_reason"] == "re-route: steering fires only on first routing"


# --- AI-222: conversation summary lines --------------------------------------


def test_route_title_is_initial_only(tmp_path, monkeypatch):
    """D4/C6: route_task.py --title writes only when no title is stored yet —
    the mechanism behind "a worker-set title never regresses to ASR text"."""
    db_path = make_case(tmp_path, monkeypatch)  # TASK_ID starts at 'received'
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", "--title", "A", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    meta = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert meta["title"] == "A"

    # A worker then sets a real title (simulated directly — task_complete.py's
    # own write is exercised in test_conversation_meta_written_by_complete).
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE conversation_meta SET title = 'C' WHERE conversation_id = ?", (TASK_ID,))
    conn.close()

    # The T4 failing case: a re-route with --title B must leave the
    # worker-chosen title C untouched.
    proc2 = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                       "--reason", "better fit", "--title", "B", pa_home=tmp_path)
    assert proc2.returncode == 0, proc2.stderr
    meta2 = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert meta2["title"] == "C"

    # The discriminating control: the same re-route DOES store B when nothing
    # is stored yet — a check that could not fail would prove nothing.
    other_id = "vi-" + "88" * 6
    seed_task(db_path, task_id=other_id, state="routed")
    proc3 = run_script("route_task.py", "--task", other_id, "--topic", TOPIC_KEY,
                       "--reason", "better fit", "--title", "B", pa_home=tmp_path)
    assert proc3.returncode == 0, proc3.stderr
    meta3 = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (other_id,))
    assert meta3["title"] == "B"


def test_route_title_rejects_blank(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--title", "   ", pa_home=tmp_path)
    assert proc.returncode == 2
    assert "--title must not be empty" in proc.stderr


# ---------------------------------------------------------------------------
# route_task.py — route-stage topic formation (operator feature, 2026-09-14)
# ---------------------------------------------------------------------------

FORMED_NAME = "Research Solar Inverter Prices"
FORMED_REQUEST = "research solar inverter prices"


class _StubTelegramHandler(http.server.BaseHTTPRequestHandler):
    """Records the createForumTopic POST and answers with the server's
    configurable `response` payload — never talks to the real API."""

    def do_POST(self):  # noqa: N802 — http.server API
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        self.server.payloads.append((self.path, body))
        data = json.dumps(self.server.response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # keep pytest output clean
        pass


@pytest.fixture()
def stub_telegram(monkeypatch):
    """Local Telegram-API stub: VOICE_INBOX_TELEGRAM_API_BASE is the script's
    only API-base seam (production never sets it), and the fixture never lets
    a test reach api.telegram.org."""

    class _StubServer(http.server.ThreadingHTTPServer):
        def __init__(self, response):
            super().__init__(("127.0.0.1", 0), _StubTelegramHandler)
            self.payloads: list = []
            self.response = response

    server = _StubServer({"ok": True, "result": {"message_thread_id": 777}})
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "12345:testtoken")
    monkeypatch.setenv("VOICE_INBOX_TELEGRAM_API_BASE",
                       f"http://127.0.0.1:{server.server_address[1]}")
    yield server
    server.shutdown()
    server.server_close()


def write_topics_registry(pa_home: Path, names: dict[int, str]) -> None:
    (pa_home / "telegram-topic-names.json").write_text(json.dumps({
        str(CHAT_ID): {str(thread_id): {"name": name, "description": "d"}
                       for thread_id, name in names.items()},
    }), encoding="utf-8")


def test_derive_topic_name_edges():
    today = "2026-09-14"
    assert route_task.derive_topic_name(FORMED_REQUEST, today) == FORMED_NAME
    # Stopwords/fillers drop out; acronyms keep their case; digits survive.
    assert route_task.derive_topic_name(
        "please help me find my invoice from march", today) == "Find Invoice March"
    assert route_task.derive_topic_name(
        "fix the API rate limit bug", today) == "Fix API Rate Limit Bug"
    assert route_task.derive_topic_name("buy 42 adapters", today) == "Buy 42 Adapters"
    # Capped at 40 chars on a word boundary.
    long_name = route_task.derive_topic_name(
        "international shipping delays affecting q3 quarterly revenue forecasts", today)
    assert long_name == "International Shipping Delays Affecting"
    assert len(long_name) <= route_task.TOPIC_NAME_MAX
    # Empty or garbage transcript -> the dated fallback name.
    for garbage in ("", "   ", "...", "!!! ???", "um uh okay"):
        assert route_task.derive_topic_name(garbage, today) == f"New work {today}", garbage


def test_route_create_topic_forms_and_routes(tmp_path, monkeypatch, stub_telegram):
    db_path = make_case(tmp_path, monkeypatch)
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET request_text = ? WHERE task_id = ?",
                     (FORMED_REQUEST, TASK_ID))
    conn.close()
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "Placed by the deterministic fallback",
                      "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["routed_to"] == f"{CHAT_ID}_777"

    # Exactly one createForumTopic call, naming the derived topic.
    assert len(stub_telegram.payloads) == 1
    path, body = stub_telegram.payloads[0]
    assert path.startswith("/bot12345:testtoken/createForumTopic")
    assert body == {"chat_id": CHAT_ID, "name": FORMED_NAME}

    # Task routed to the formed topic with the reason explaining the no-fit.
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "routed"
    assert task["routed_to"] == f"{CHAT_ID}_777"
    assert task["routing_reason"] == f"formed {FORMED_NAME}: no existing topic matched by name"

    # Registry gained the formed topic with a description; the seeded entry is untouched.
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert registry[str(CHAT_ID)]["777"] == {"name": FORMED_NAME, "description": FORMED_REQUEST}
    assert registry[str(CHAT_ID)][str(THREAD_ID)]["name"] == "Reports"

    # No daily cap state file is written.
    assert not (tmp_path / "voice-inbox" / "topics-created.json").exists()

    # The route queue entry carries the formed topic's ids.
    queued = [line for line in read_queue(tmp_path) if line["task_id"] == TASK_ID]
    assert len(queued) == 1
    assert queued[0]["chat_id"] == CHAT_ID
    assert queued[0]["thread_id"] == 777

    # The name seeded the conversation title.
    meta = fetch_one(db_path, "SELECT title FROM conversation_meta WHERE conversation_id = ?",
                     (TASK_ID,))
    assert meta["title"] == FORMED_NAME


def test_route_create_topic_prefers_transcript_over_request_text(tmp_path, monkeypatch, stub_telegram):
    db_path = make_case(tmp_path, monkeypatch)
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET source = 'voice', transcript = ? WHERE task_id = ?",
                     ("organize the garage shelves this weekend", TASK_ID))
    conn.close()
    stub_telegram.response = {"ok": True, "result": {"message_thread_id": 888}}

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT routed_to, routing_reason FROM tasks WHERE task_id = ?",
                     (TASK_ID,))
    assert task["routed_to"] == f"{CHAT_ID}_888"
    assert task["routing_reason"] == "formed Organize Garage Shelves Weekend: no existing topic matched by name"


def test_route_without_create_flag_never_creates(tmp_path, monkeypatch, stub_telegram):
    """Fit-existing (no --create-topic) never touches the API or the registry's
    new-topic path."""
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert stub_telegram.payloads == []
    assert not (tmp_path / "voice-inbox" / "topics-created.json").exists()
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert set(registry[str(CHAT_ID)]) == {str(THREAD_ID)}


def test_route_create_topic_reuses_existing_name(tmp_path, monkeypatch, stub_telegram):
    """A topic with the derived name already exists: the task joins it — no
    mint. If the matched entry has no description, one is backfilled from the
    arriving work."""
    db_path = make_case(tmp_path, monkeypatch)
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET request_text = ? WHERE task_id = ?",
                     (FORMED_REQUEST, TASK_ID))
    conn.close()
    # Seed an existing entry WITHOUT a description (string form).
    (tmp_path / "telegram-topic-names.json").write_text(json.dumps({
        str(CHAT_ID): {
            str(THREAD_ID): {"name": "Reports", "description": "report tasks"},
            "3001": FORMED_NAME,
        },
    }), encoding="utf-8")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path := tmp_path / "voice-inbox" / "ledger.sqlite",
                     "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["routed_to"] == f"{CHAT_ID}_3001"
    assert task["routing_reason"] == f"existing topic matched: {FORMED_NAME}"
    assert stub_telegram.payloads == []
    assert not (tmp_path / "voice-inbox" / "topics-created.json").exists()
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert registry[str(CHAT_ID)]["3001"] == {"name": FORMED_NAME, "description": FORMED_REQUEST}


def test_route_create_topic_preserves_existing_description(tmp_path, monkeypatch, stub_telegram):
    """A matched existing topic that already has a description keeps it."""
    db_path = make_case(tmp_path, monkeypatch)
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET request_text = ? WHERE task_id = ?",
                     (FORMED_REQUEST, TASK_ID))
    conn.close()
    (tmp_path / "telegram-topic-names.json").write_text(json.dumps({
        str(CHAT_ID): {
            str(THREAD_ID): {"name": "Reports", "description": "report tasks"},
            "3001": {"name": FORMED_NAME, "description": "keep me"},
        },
    }), encoding="utf-8")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path := tmp_path / "voice-inbox" / "ledger.sqlite",
                     "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["routed_to"] == f"{CHAT_ID}_3001"
    assert task["routing_reason"] == f"existing topic matched: {FORMED_NAME}"
    assert stub_telegram.payloads == []
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert registry[str(CHAT_ID)]["3001"] == {"name": FORMED_NAME, "description": "keep me"}


def test_route_create_topic_api_failure_falls_back_to_bucket(tmp_path, monkeypatch, stub_telegram):
    """A failed createForumTopic must never lose the placement: bucket with a
    redacted reason note (the token never reaches the ledger)."""
    make_case(tmp_path, monkeypatch)
    stub_telegram.response = {"ok": False, "description": "CHAT_FORUM_SUPERGROUP"}
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "Placed by the deterministic fallback",
                      "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(tmp_path / "voice-inbox" / "ledger.sqlite",
                     "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["routed_to"] == TOPIC_KEY
    assert task["routing_reason"].startswith(
        "Placed by the deterministic fallback (topic creation failed: createForumTopic")
    assert "testtoken" not in task["routing_reason"]
    assert "testtoken" not in (proc.stdout + proc.stderr)
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert set(registry[str(CHAT_ID)]) == {str(THREAD_ID)}
    assert not (tmp_path / "voice-inbox" / "topics-created.json").exists()


def test_route_create_topic_rejects_continues(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--continues", TASK_ID,
                      "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 2
    assert "cannot be combined" in proc.stderr


def test_route_create_topic_no_token_falls_back_to_bucket(tmp_path, monkeypatch):
    """No TELEGRAM_BOT_TOKEN anywhere (env deleted, and the tmp PA_HOME has no
    secrets.env for the fallback read) → the caller's bucket with a reason
    note; nothing is minted, registered, or counted."""
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "Placed by the deterministic fallback",
                      "--create-topic", pa_home=tmp_path,
                      extra_env={"TELEGRAM_BOT_TOKEN": None,
                                 "VOICE_INBOX_TELEGRAM_API_BASE": None})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(tmp_path / "voice-inbox" / "ledger.sqlite",
                     "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["routed_to"] == TOPIC_KEY
    assert task["routing_reason"] == (
        "Placed by the deterministic fallback "
        "(no TELEGRAM_BOT_TOKEN available for topic creation)")
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert set(registry[str(CHAT_ID)]) == {str(THREAD_ID)}
    assert not (tmp_path / "voice-inbox" / "topics-created.json").exists()


def test_route_create_topic_dict_entry_without_description_backfilled(
        tmp_path, monkeypatch, stub_telegram):
    """A same-named DICT entry missing the description key is backfilled too —
    the string-form backfill has its own test; this is the dict branch."""
    db_path = make_case(tmp_path, monkeypatch)
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET request_text = ? WHERE task_id = ?",
                     (FORMED_REQUEST, TASK_ID))
    conn.close()
    (tmp_path / "telegram-topic-names.json").write_text(json.dumps({
        str(CHAT_ID): {
            str(THREAD_ID): {"name": "Reports", "description": "report tasks"},
            "3001": {"name": FORMED_NAME},
        },
    }), encoding="utf-8")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["routed_to"] == f"{CHAT_ID}_3001"
    assert task["routing_reason"] == f"existing topic matched: {FORMED_NAME}"
    assert stub_telegram.payloads == []
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert registry[str(CHAT_ID)]["3001"] == {"name": FORMED_NAME, "description": FORMED_REQUEST}


def test_route_create_topic_empty_source_uses_dated_name(tmp_path, monkeypatch, stub_telegram):
    """Empty transcript AND request_text → the dated 'New work <UTC date>'
    name still forms (placement never depends on name quality) and the
    description is the empty string."""
    db_path = make_case(tmp_path, monkeypatch)
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET request_text = '' WHERE task_id = ?", (TASK_ID,))
    conn.close()
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--create-topic", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    # Read the minted name from the stub call itself — deterministic relative
    # to the subprocess's own clock (a test-side _utc_today() could straddle
    # a midnight boundary the subprocess did not).
    assert len(stub_telegram.payloads) == 1
    _path, body = stub_telegram.payloads[0]
    name = body["name"]
    assert name.startswith("New work ")
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["routed_to"] == f"{CHAT_ID}_777"
    assert task["routing_reason"] == f"formed {name}: no existing topic matched by name"
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert registry[str(CHAT_ID)]["777"] == {"name": name, "description": ""}


def test_route_create_topic_never_mints_for_terminal_task(tmp_path, monkeypatch, stub_telegram):
    """--create-topic on a task the state gate refuses (done) must not mint a
    topic first — formation is a real createForumTopic side effect running
    before the transaction, so it pre-checks the same routable states."""
    make_case(tmp_path, monkeypatch, task_state="done")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", "--create-topic", pa_home=tmp_path)
    expect_fail(proc, "routing is valid from received or routed")
    assert stub_telegram.payloads == [], "no topic minted for a refused task"
    registry = json.loads((tmp_path / "telegram-topic-names.json").read_text(encoding="utf-8"))
    assert set(registry[str(CHAT_ID)]) == {str(THREAD_ID)}


def test_resolve_topic_accepts_legacy_string_entry(tmp_path, monkeypatch):
    """A legacy bare-string registry entry ("<tid>": "<name>") is a valid
    --topic target — every other registry reader accepts both shapes."""
    db_path = make_case(tmp_path, monkeypatch)
    (tmp_path / "telegram-topic-names.json").write_text(json.dumps({
        str(CHAT_ID): {str(THREAD_ID): "Reports"},
    }), encoding="utf-8")
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "r", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT routed_to FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["routed_to"] == TOPIC_KEY


# ---------------------------------------------------------------------------
# task_telemetry.py
# ---------------------------------------------------------------------------


def test_telemetry_start_moves_routed_to_running(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["kind"] == "task.progress"
    assert payload["task_state"] == "running"
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "running"
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.progress"
    assert json.loads(event["payload_json"]) == {"step": "started"}
    assert re.fullmatch(r"s-[0-9a-f]{12}", event["ref_id"])


def test_telemetry_start_honors_custom_step(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID,
                      "--step", "pulling the data", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert json.loads(event["payload_json"]) == {"step": "pulling the data"}


def test_telemetry_start_captures_worker_resource(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path,
                      extra_env={"PA_WORKER_RESOURCE": "topic--100_5-th2"})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT worker_resource FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["worker_resource"] == "topic--100_5-th2"


def test_telemetry_start_leaves_worker_resource_null_when_unset_or_empty(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path,
                      extra_env={"PA_WORKER_RESOURCE": None})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT worker_resource FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["worker_resource"] is None

    home2 = tmp_path / "empty-resource"
    db_path2 = make_case(home2, monkeypatch, task_state="routed")
    proc2 = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=home2,
                       extra_env={"PA_WORKER_RESOURCE": "   "})
    assert proc2.returncode == 0, proc2.stderr
    task2 = fetch_one(db_path2, "SELECT worker_resource FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task2["worker_resource"] is None


def test_telemetry_start_captures_worker_dispatch_id_alongside_resource(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path,
                      extra_env={"PA_WORKER_RESOURCE": "topic--100_29",
                                 "PA_WORKER_DISPATCH_ID": "a1b2c3d4e5f6"})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT worker_resource, worker_dispatch_id FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["worker_resource"] == "topic--100_29"
    assert task["worker_dispatch_id"] == "a1b2c3d4e5f6"


def test_telemetry_start_leaves_dispatch_id_null_never_empty_when_unset(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path,
                      extra_env={"PA_WORKER_RESOURCE": "topic--100_29", "PA_WORKER_DISPATCH_ID": None})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT worker_resource, worker_dispatch_id FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["worker_resource"] == "topic--100_29"
    assert task["worker_dispatch_id"] is None


def test_telemetry_start_captures_routing_metadata(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path,
                      extra_env={"PA_WORKER_RESOURCE": "topic--100_29",
                                 "PA_ROUTING_DECISION": "router",
                                 "PA_ROUTING_PLACEMENT": "diverted",
                                 "PA_ROUTING_TARGET": "vi-0123456789ab",
                                 "PA_ROUTING_STEER": "wait",
                                 "PA_ROUTING_STEER_BY": "operator",
                                 "PA_ROUTING_EFFORT_PROJ": "nearest",
                                 "PA_ROUTING_FAILOVERS": "2"})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT router_decision, router_placement, router_target,"
                              " router_steer, router_steer_by, router_effort_proj, router_failovers"
                              " FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["router_decision"] == "router"
    assert task["router_placement"] == "diverted"
    assert task["router_target"] == "vi-0123456789ab"
    assert task["router_steer"] == "wait"
    assert task["router_steer_by"] == "operator"
    assert task["router_effort_proj"] == "nearest"
    assert task["router_failovers"] == 2


def test_telemetry_start_records_router_steer_by_and_leaves_it_null_when_absent(tmp_path, monkeypatch):
    """steer_by value branch: 'router' records as-is; STEER set without
    STEER_BY -> NULL (absent env is fail-open, never invented)."""
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path,
                      extra_env={"PA_WORKER_RESOURCE": "topic--100_29",
                                 "PA_ROUTING_STEER": "steer",
                                 "PA_ROUTING_STEER_BY": "router"})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT router_steer, router_steer_by FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["router_steer"] == "steer"
    assert task["router_steer_by"] == "router"

    home2 = tmp_path / "no-steer-by"
    db_path2 = make_case(home2, monkeypatch, task_state="routed")
    proc2 = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=home2,
                       extra_env={"PA_WORKER_RESOURCE": "topic--100_29",
                                  "PA_ROUTING_STEER": "steer",
                                  "PA_ROUTING_STEER_BY": None})
    assert proc2.returncode == 0, proc2.stderr
    task2 = fetch_one(db_path2, "SELECT router_steer, router_steer_by FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task2["router_steer"] == "steer"
    assert task2["router_steer_by"] is None


def test_telemetry_start_leaves_routing_metadata_null_when_env_absent(tmp_path, monkeypatch):
    """Fail-open branch: no PA_ROUTING_* env -> all seven columns stay NULL
    and the run is still recorded."""
    db_path = make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", TASK_ID, pa_home=tmp_path,
                      extra_env={"PA_WORKER_RESOURCE": "topic--100_29",
                                 "PA_ROUTING_DECISION": None,
                                 "PA_ROUTING_PLACEMENT": None,
                                 "PA_ROUTING_TARGET": None,
                                 "PA_ROUTING_STEER": None,
                                 "PA_ROUTING_STEER_BY": None,
                                 "PA_ROUTING_EFFORT_PROJ": None,
                                 "PA_ROUTING_FAILOVERS": None})
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT router_decision, router_placement, router_target,"
                              " router_steer, router_steer_by, router_effort_proj, router_failovers"
                              " FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["router_decision"] is None
    assert task["router_placement"] is None
    assert task["router_target"] is None
    assert task["router_steer"] is None
    assert task["router_steer_by"] is None
    assert task["router_effort_proj"] is None
    assert task["router_failovers"] is None


def test_telemetry_progress_appends_while_running(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_telemetry.py", "progress", "--task", TASK_ID,
                      "--step", "fetching statements", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["task_state"] == "running"
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "running"
    events = fetch_all(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert len(events) == 1
    assert json.loads(events[0]["payload_json"]) == {"step": "fetching statements"}
    proc = run_script("task_telemetry.py", "progress", "--task", TASK_ID,
                      "--step", "parsing", "--summary", "halfway there", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    events = fetch_all(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert len(events) == 2
    assert events[1]["summary"] == "halfway there"


def test_telemetry_progress_accepted_from_received(tmp_path, monkeypatch):
    # D5: a task.progress event now moves a `received` task straight to
    # `running` — the transcribed-while-worker-already-progressing shortcut.
    db_path = make_case(tmp_path, monkeypatch, task_state="received")
    for argv in (["start", "--task", TASK_ID],
                 ["progress", "--task", TASK_ID, "--step", "x"]):
        proc = run_script("task_telemetry.py", *argv, pa_home=tmp_path)
        assert proc.returncode == 0, proc.stderr
        assert out_json(proc)["task_state"] == "running"
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"
    assert len(fetch_all(db_path, "SELECT * FROM events")) == 2


def test_telemetry_progress_from_received_sets_running(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="received")
    proc = run_script("task_telemetry.py", "progress", "--task", TASK_ID,
                      "--step", "starting up", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["task_state"] == "running"
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "running"


def test_telemetry_failed_moves_to_failed(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="awaiting_input")
    proc = run_script("task_telemetry.py", "--event", "task.failed", "--task", TASK_ID,
                      "--reason", "the source site is unreachable", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["task_state"] == "failed"
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "failed"
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.failed"
    assert json.loads(event["payload_json"]) == {"reason": "the source site is unreachable"}


def test_telemetry_failed_rejected_from_terminal(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="done")
    proc = run_script("task_telemetry.py", "--event", "task.failed", "--task", TASK_ID,
                      "--reason", "r", pa_home=tmp_path)
    expect_fail(proc, "cannot fail")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "done"


def test_telemetry_failed_requires_reason(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_telemetry.py", "--event", "task.failed", "--task", TASK_ID,
                      pa_home=tmp_path)
    assert proc.returncode == 2
    assert "--reason is required" in proc.stderr


def test_telemetry_rejects_unknown_event_kind(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch)
    proc = run_script("task_telemetry.py", "--event", "task.completed", "--task", TASK_ID,
                      pa_home=tmp_path)
    assert proc.returncode == 2  # argparse choices: completion belongs to task_complete.py
    proc = run_script("task_telemetry.py", "--event", "task.rerouted", "--task", TASK_ID,
                      pa_home=tmp_path)
    assert proc.returncode == 2  # routing belongs to route_task.py


def test_telemetry_result_ready_appends_without_state_change(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    preview = "p" * 300
    proc = run_script("task_telemetry.py", "--event", "task.result_ready", "--task", TASK_ID,
                      "--preview", preview, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["task_state"] == "running"
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "running"
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    payload = json.loads(event["payload_json"])
    assert payload["preview"] == "p" * 200  # capped at the vocabulary limit
    assert event["kind"] == "task.result_ready"


def test_telemetry_result_ready_rejected_from_terminal(tmp_path, monkeypatch):
    # 2026-09-17: failed/transcribe_failed gained the operator-only `cancelled`
    # edge, so "no outgoing edge" no longer names every state that takes no
    # further worker events — the list is explicit.
    for state in ("transcribe_failed", "done", "failed", "cancelled"):
        home = tmp_path / state
        db_path = make_case(home, monkeypatch, task_state=state)
        proc = run_script("task_telemetry.py", "--event", "task.result_ready", "--task",
                          TASK_ID, pa_home=home)
        expect_fail(proc, "no further events are accepted")
        assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                         (TASK_ID,))["state"] == state
        assert fetch_all(db_path, "SELECT * FROM events") == []


def test_telemetry_missing_task(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="routed")
    proc = run_script("task_telemetry.py", "start", "--task", "vi-" + "ee" * 6,
                      pa_home=tmp_path)
    expect_fail(proc, "not found")


# ---------------------------------------------------------------------------
# task_input.py
# ---------------------------------------------------------------------------


# --- AI-235 WP-2: plain-language default for --prompt / --param ---------------
#
# The `--prompt` help (and the `--param` choice-option-label note) must carry a
# plain-language content rule, mirroring task_blocker_ask.py:194. The
# route-injection text that teaches workers how to call `task_input.py create`
# (bridge-writer.ts buildTargetInjectionText / route_task.py
# TARGET_INJECTION_TEMPLATE) must teach the same rule, and the two twins must
# stay byte-equal (the sync-twins.test.ts pin covers the whole template; this
# is a focused python-side pin on the plain-language sentence alone).

PLAIN_LANGUAGE_TEACHING_RE = re.compile(
    r"Phrase --prompt and choice labels in plain language"
    r".*?technical terms\.", re.S)


def test_input_create_help_prompts_plain_language(tmp_path, monkeypatch):
    """`task_input.py create --help` must name the plain-language rule for the
    --prompt question and the --param choice-option labels (AI-235 GAP 2)."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    proc = run_script("task_input.py", "create", "--help", pa_home=tmp_path)
    # argparse renders --help to stdout and exits 0 (before any ledger access).
    assert proc.returncode == 0, proc.stderr
    # argparse wraps long help lines, so collapse whitespace before substring
    # checks (a wrapped "plain\n  product language" must still match).
    flat = re.sub(r"\s+", " ", proc.stdout)
    assert "plain-language question" in flat, \
        "--prompt help lost its plain-language rule"
    assert "plain product language" in flat, \
        "--param help lost its choice-option-label plain-language note"


def test_target_injection_plain_language_teaching_twin_sync():
    """The plain-language --prompt teaching sentence in bridge-writer.ts and
    route_task.py must match byte-for-byte (AI-235 WP-2). A one-twin edit that
    drops or rewords only one side fails here."""
    ts_source = (PROJECT / "src" / "bridge-writer.ts").read_text(encoding="utf-8")
    py_source = (SCRIPTS / "route_task.py").read_text(encoding="utf-8")
    ts_match = PLAIN_LANGUAGE_TEACHING_RE.search(ts_source)
    py_match = PLAIN_LANGUAGE_TEACHING_RE.search(py_source)
    assert ts_match, "plain-language teaching sentence not found in bridge-writer.ts"
    assert py_match, "plain-language teaching sentence not found in route_task.py"
    assert ts_match.group(0) == py_match.group(0), (
        "bridge-writer.ts and route_task.py plain-language teaching sentences diverged:\n"
        f"TS:  {ts_match.group(0)!r}\nPY:  {py_match.group(0)!r}"
    )


def test_input_create_choice_happy_path(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "choice",
                      "--prompt", "Which plan should I file?",
                      "--param", 'options=["Plan A","Plan B"]',
                      "--summary", "asking which plan", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    request_id = payload["request_id"]
    assert re.fullmatch(r"ir-[0-9a-f]{12}", request_id)
    assert payload["kind"] == "choice"
    assert payload["task_state"] == "awaiting_input"

    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "awaiting_input"
    request = fetch_one(db_path, "SELECT * FROM input_requests WHERE request_id = ?",
                        (request_id,))
    assert request["task_id"] == TASK_ID
    assert request["tenant_id"] == TENANT_ID
    assert request["kind"] == "choice"
    assert request["prompt"] == "Which plan should I file?"
    assert json.loads(request["params_json"]) == {"options": ["Plan A", "Plan B"]}
    assert request["status"] == "pending"
    assert request["answer_pointer"] is None
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.input_needed"
    assert json.loads(event["payload_json"]) == {"request_id": request_id, "kind": "choice"}
    assert event["summary"] == "asking which plan"


def test_input_create_from_received_rejected(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="received")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "ok", pa_home=tmp_path)
    expect_fail(proc, "input requests are created from running")
    assert fetch_all(db_path, "SELECT * FROM input_requests") == []
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "received"


def test_input_create_from_awaiting_input_rejected(tmp_path, monkeypatch):
    # Regression pin (2026-09-11 action-block wave): create is legal only from
    # running — a task already awaiting_input must reject a second ask until
    # its standing ask is answered or withdrawn.
    db_path = make_case(tmp_path, monkeypatch, task_state="awaiting_input")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "ok", pa_home=tmp_path)
    expect_fail(proc, "input requests are created from running")
    assert fetch_all(db_path, "SELECT * FROM input_requests") == []
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "awaiting_input"


def test_input_create_rejects_unknown_kind(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "widget",
                      "--prompt", "ok", pa_home=tmp_path)
    expect_fail(proc, "kind must be one of")


def test_input_create_rejects_unknown_param_keys(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    # A model-supplied auth_url is structurally impossible: not a key of any
    # kind's param set.
    for kind, param in (("secret", "auth_url=https://x"),
                        ("oauth", "auth_url=https://x"),
                        ("text", "options=[\"a\"]")):
        proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", kind,
                          "--prompt", "ok", "--param", param, pa_home=tmp_path)
        expect_fail(proc, "unknown field")


def test_input_create_oauth_provider_must_be_google(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "oauth",
                      "--prompt", "ok", "--param", "provider=facebook", pa_home=tmp_path)
    expect_fail(proc, "must be one of google")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "oauth",
                      "--prompt", "ok", pa_home=tmp_path)
    expect_fail(proc, "must be one of google")


def test_input_create_rejects_oversize_prompt(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "x" * 501, pa_home=tmp_path)
    expect_fail(proc, "prompt must be 1..500 chars")


def test_input_create_choice_options_validation(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "choice",
                      "--prompt", "ok", "--param", 'options=["1","2","3","4","5","6","7"]',
                      pa_home=tmp_path)
    expect_fail(proc, "array of 1..6 options")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "choice",
                      "--prompt", "ok", "--param", "options=[3]", pa_home=tmp_path)
    expect_fail(proc, "options[0]")


def test_input_create_file_params_validation(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "file",
                      "--prompt", "ok", "--param", 'accept=["pdf"]', pa_home=tmp_path)
    expect_fail(proc, "dot-extension")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "file",
                      "--prompt", "ok", "--param", "max_bytes=99999999999",
                      pa_home=tmp_path)
    expect_fail(proc, "max_bytes must be an integer of 1..26214400")


def test_input_create_text_multiline(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "Describe it", "--param", "multiline=true",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    request_id = out_json(proc)["request_id"]
    request = fetch_one(db_path, "SELECT * FROM input_requests WHERE request_id = ?",
                        (request_id,))
    assert json.loads(request["params_json"]) == {"multiline": True}
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "Describe it", "--param", "multiline=yes",
                      pa_home=tmp_path)
    expect_fail(proc, "multiline must be a boolean")


def test_input_create_param_needs_key_value(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "ok", "--param", "novalue", pa_home=tmp_path)
    assert proc.returncode == 2
    assert "key=value" in proc.stderr


def test_input_check_pending_line(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "choice",
                      "--prompt", "Which?", "--param", 'options=["a","b"]', pa_home=tmp_path)
    request_id = out_json(proc)["request_id"]
    proc = run_script("task_input.py", "check", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 0
    assert f"Request {request_id} is still pending (kind=choice)." in proc.stdout
    assert "Answer for" not in proc.stdout
    proc = run_script("task_input.py", "check", "--task", TASK_ID,
                      "--request", request_id, pa_home=tmp_path)
    assert proc.returncode == 0
    assert request_id in proc.stdout


def test_input_check_answered_pointer_line(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "secret",
                      "--prompt", "API key?", pa_home=tmp_path)
    request_id = out_json(proc)["request_id"]
    answers_dir = tmp_path / "voice-inbox" / "answers" / TASK_ID
    answers_dir.mkdir(parents=True)
    pointer = str(answers_dir / f"{request_id}.txt")
    Path(pointer).write_text("sk-secret-value", encoding="utf-8")
    conn = sqlite3.connect(db_path)
    with conn:  # simulate the API's answer submission (WP-B owns the real path)
        conn.execute(
            "UPDATE input_requests SET status = 'answered', answer_pointer = ?, answered_at = ?"
            " WHERE request_id = ?", (pointer, iso_now(), request_id))
        conn.execute("UPDATE tasks SET state = 'running', updated_at = ? WHERE task_id = ?",
                     (iso_now(), TASK_ID))
    conn.close()
    proc = run_script("task_input.py", "check", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 0
    expected = (f"Answer for {request_id} is at {pointer}"
                " — read it; never repeat its value in chat.")
    assert expected in proc.stdout


def test_input_check_erased_pointer_line(tmp_path, monkeypatch):
    """C10: once the answer file is gone (delivered-once reaping), `check`
    must report the erased sentence, not the pointer line — and must never
    raise on the now-missing path."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "secret",
                      "--prompt", "API key?", pa_home=tmp_path)
    request_id = out_json(proc)["request_id"]
    # Never created on disk: simulates a pointer whose file has already been
    # erased (or one that was never materialized).
    pointer = str(tmp_path / "voice-inbox" / "answers" / TASK_ID / f"{request_id}.txt")
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "UPDATE input_requests SET status = 'answered', answer_pointer = ?, answered_at = ?"
            " WHERE request_id = ?", (pointer, iso_now(), request_id))
        conn.execute("UPDATE tasks SET state = 'running', updated_at = ? WHERE task_id = ?",
                     (iso_now(), TASK_ID))
    conn.close()
    proc = run_script("task_input.py", "check", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 0
    expected = (f"Answer for {request_id} was delivered and has been erased "
                "(answers to secret requests are kept only briefly). Ask again with "
                "task_input.py create if you still need it.")
    assert expected in proc.stdout
    assert "is at" not in proc.stdout


def test_input_create_keeps_next_action(tmp_path, monkeypatch):
    """A question leaves a standing action item alone unless --next names a
    new one (the "__keep__" sentinel path in set_conversation_meta)."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "What's the deadline?", "--next", "Reply with the deadline",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    meta = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert meta["next_action"] == "Reply with the deadline"

    # Simulate the answer landing (the API's own path is exercised elsewhere)
    # so a second create is legal from running, then omit --next: untouched.
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET state = 'running' WHERE task_id = ?", (TASK_ID,))
    conn.close()
    proc2 = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "confirm",
                       "--prompt", "Proceed?", pa_home=tmp_path)
    assert proc2.returncode == 0, proc2.stderr
    meta2 = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert meta2["next_action"] == "Reply with the deadline"

    # With --next, it replaces the standing action item.
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET state = 'running' WHERE task_id = ?", (TASK_ID,))
    conn.close()
    proc3 = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "confirm",
                       "--prompt", "Sure?", "--next", "Approve the budget", pa_home=tmp_path)
    assert proc3.returncode == 0, proc3.stderr
    meta3 = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert meta3["next_action"] == "Approve the budget"


# ---------------------------------------------------------------------------
# task_input.py cancel — withdraw the task's still-pending asks (the bot's
# reverse-clear; 2026-09-11 action-block SPEC 2b/2g).
# ---------------------------------------------------------------------------


def test_input_cancel_cancels_pending_only(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "choice",
                      "--prompt", "Which?", "--param", 'options=["a","b"]', pa_home=tmp_path)
    pending_id = out_json(proc)["request_id"]
    # A second, already-answered ask (the API's answer path, simulated).
    answered_id = "ir-" + "ee" * 6
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "INSERT INTO input_requests"
            " (request_id, task_id, tenant_id, kind, prompt, params_json, status,"
            "  answer_pointer, created_at, answered_at)"
            " VALUES (?, ?, ?, 'text', 'earlier ask', '{}', 'answered', 'p/ath', ?, ?)",
            (answered_id, TASK_ID, TENANT_ID, iso_now(), iso_now()),
        )
    conn.close()
    proc = run_script("task_input.py", "cancel", "--task", TASK_ID,
                      "--reason", "answered on Telegram", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload == {"ok": True, "task_id": TASK_ID, "cancelled": 1,
                       "task_state": "running"}
    assert fetch_one(db_path, "SELECT status FROM input_requests WHERE request_id = ?",
                     (pending_id,))["status"] == "cancelled"
    assert fetch_one(db_path, "SELECT status FROM input_requests WHERE request_id = ?",
                     (answered_id,))["status"] == "answered"
    # No event row is written for a cancel: the create's task.input_needed is
    # the only event this task carries (stdout JSON + caller log are the audit).
    assert [event["kind"] for event in
            fetch_all(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
            ] == ["task.input_needed"]


def test_input_cancel_flips_awaiting_input_to_running(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "confirm",
                      "--prompt", "Proceed?", pa_home=tmp_path)
    assert out_json(proc)["task_state"] == "awaiting_input"
    proc = run_script("task_input.py", "cancel", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["cancelled"] == 1
    assert payload["task_state"] == "running"
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"


def test_input_cancel_noop_when_nothing_pending(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    other_id = "vi-" + "cd" * 6
    seed_task(db_path, task_id=other_id, state="awaiting_input")
    proc = run_script("task_input.py", "cancel", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["cancelled"] == 0
    assert payload["task_state"] == "running"
    assert fetch_all(db_path, "SELECT * FROM input_requests") == []
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"
    # Zero pending flips nothing: the awaiting_input task is left as it was.
    proc = run_script("task_input.py", "cancel", "--task", other_id, pa_home=tmp_path)
    payload = out_json(proc)
    assert payload["cancelled"] == 0
    assert payload["task_state"] == "awaiting_input"
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (other_id,))["state"] == "awaiting_input"


def test_input_cancel_rejects_oversize_reason(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "cancel", "--task", TASK_ID,
                      "--reason", "x" * 201, pa_home=tmp_path)
    expect_fail(proc, "--reason must be at most 200 chars")


# --- form kind (WP-PY, 2026-09-14): --steps-file + the validator mirror -----

# The seven-step questionnaire from the form-widget SPEC § Fixture, embedded
# (tests never read the scratch file); asserted to pass both validators.
FORM_SHEET_PROMPT = ("Skill outputs in the inbox — the proposal's remaining choices. One Submit "
                     "sends every answer at once; each question carries its context inline. "
                     "Question 3 is already decided and locked.")
FORM_SEVEN_STEPS = [
    {
        "id": "q1-telegram-copies",
        "title": "Telegram copies — mail brief & oracle",
        "decide": "Whether thread 29 stops receiving the mail brief and oracle copies after the ~2-week dual-run, making the inbox their primary surface.",
        "options": [
            {"label": "Retire both after the dual-run",
             "note": "The inbox card reads better; the fixed transition window keeps a fallback while trust builds."},
            {"label": "Retire oracle only, keep mail copy",
             "note": "Thread 29 keeps the mail brief text + PDF."},
            {"label": "Keep both permanently",
             "note": "Inbox becomes the reading/archive surface only."},
        ],
        "preselected": "Retire both after the dual-run",
    },
    {
        "id": "q2-paging",
        "title": "Which deliveries page you",
        "decide": "Which skill deliveries fire a web-push page and which land quietly in the Ready section for review at leisure.",
        "options": [
            {"label": "As proposed",
             "note": "Page: morning brief, Dashami guide, invoice, portfolio, every failure. Quiet: evening brief, oracle, ekadashi pings."},
            {"label": "Page every briefing",
             "note": "Oracle and the evening brief page too."},
            {"label": "Page only failures + invoice",
             "note": "Everything else lands quietly."},
        ],
        "preselected": "As proposed",
    },
    {
        "id": "q3-one-conversation",
        "title": "One conversation per run",
        "decide": "Whether each skill run creates its own conversation, or runs merge into one conversation per day.",
        "locked": True,
        "answer": "One conversation per run — decided 2026-09-13 via the tap-through widget (task vi-5f499f8cd330).",
    },
    {
        "id": "q4-portfolio-dm",
        "title": "Portfolio DM duplicate",
        "decide": "Whether the portfolio report's direct Telegram DM stops once inbox web push is trusted.",
        "options": [
            {"label": "Retire the DM once push is trusted",
             "note": "One paging surface; inbox plus thread 29 cover reading and record."},
            {"label": "Keep the DM, retire thread-29 copy",
             "note": "The DM stays the paging surface instead."},
            {"label": "Keep all three",
             "note": "DM + thread 29 + inbox all receive it."},
        ],
        "preselected": "Retire the DM once push is trusted",
    },
    {
        "id": "q5-invoice-widget",
        "title": "Invoice approval as inbox choices (v2)",
        "decide": "Whether Hemir invoice approval becomes approve/reject/edit choices on the invoice card, replacing the Telegram 'Send now' queue.",
        "options": [
            {"label": "Build it in v2",
             "note": "A one-tap widget action; removes a surface switch mid-approval."},
            {"label": "Keep Telegram approval",
             "note": "Approval stays a typed 'Send now' in the PA topic."},
            {"label": "Decide later",
             "note": "After inbox-primary proves out."},
        ],
        "preselected": "Build it in v2",
    },
    {
        "id": "q6-watchdog",
        "title": "Expected-deliverable-missing watchdog (v2)",
        "decide": "Whether a daily check notices a cron skill that declared inbox output but delivered nothing — the silent-death case.",
        "options": [
            {"label": "Build in v2, all contract skills",
             "note": "A ledger scan against declared skills is cheap and closes the silent gap."},
            {"label": "Rely on per-skill watchdogs",
             "note": "Coverage only where built (ekadashi today)."},
            {"label": "Cover only the daily skills",
             "note": "Mail brief and oracle only."},
        ],
        "preselected": "Build in v2, all contract skills",
    },
    {
        "id": "q7-oracle-defect",
        "title": "Oracle double-delivery defect",
        "decide": "Whether the observed oracle double-run of 2026-09-13 gets its own defect task now, separate from this design.",
        "options": [
            {"label": "File its own task now",
             "note": "An observed same-day defect with a clean reproduction window."},
            {"label": "Fold into the retirement wave",
             "note": "Fixed when the thread-29 copies retire."},
            {"label": "Wait for a recurrence",
             "note": "The 24h duplicate guard covers the inbox door meanwhile."},
        ],
        "preselected": "File its own task now",
    },
]


def test_input_form_validator_mirror():
    """The python form validator is the exact-key BEHAVIOR twin of contracts.ts's
    checkFormSteps: the seven-step fixture passes and every contract rejection
    rejects (message TEXT is not pinned across languages; behavior is)."""
    assert task_input.validate_request("form", "p", {"steps": FORM_SEVEN_STEPS}) is None
    plain = FORM_SEVEN_STEPS[0]
    option = plain["options"][0]
    locked = FORM_SEVEN_STEPS[2]

    def bad(step: object) -> dict:
        return {"steps": [step]}

    # The 20-step hostile array trips the 1..8 count check first — with
    # FORM_STEPS_MAX=8 and every field capped, a valid form serializes to
    # ≈17k chars, under FORM_STEPS_JSON_MAX; the 20 000-char bound is
    # defense-in-depth and its error string is unreachable behind the earlier
    # checks (same spec-gap note as contracts.test.ts's oversize test).
    huge = [{**plain, "id": f"s{i}", "title": "x" * 1000} for i in range(20)]
    cases = [
        ("unknown step field", bad({**plain, "url": "https://evil.example"})),
        ("unknown option field", bad({**plain, "options": [{**option, "href": "https://evil.example"}]})),
        ("9 steps", {"steps": FORM_SEVEN_STEPS + [dict(plain), dict(plain)]}),
        ("61-char title", bad({**plain, "title": "x" * 61})),
        ("201-char decide", bad({**plain, "decide": "x" * 201})),
        ("7 options", bad({**plain, "options": [dict(option) for _ in range(7)]})),
        ("61-char label", bad({**plain, "options": [{"label": "x" * 61, "note": "n"}]})),
        ("201-char note", bad({**plain, "options": [{"label": "l", "note": "x" * 201}]})),
        ("oversize hostile array", {"steps": huge}),
        ("preselected not an option label", bad({**plain, "preselected": plain["preselected"] + " "})),
        ("duplicate ids", {"steps": [dict(plain), dict(plain)]}),
        ("id uppercase", bad({**plain, "id": "Q1"})),
        ("id leading dash", bad({**plain, "id": "-lead"})),
        ("id empty", bad({**plain, "id": ""})),
        ("id non-string", bad({**plain, "id": 42})),
        ("id 41 chars", bad({**plain, "id": "a" * 41})),
        ("locked with options", bad({**locked, "options": [dict(option)]})),
        ("locked empty answer", bad({**locked, "answer": ""})),
        ("locked missing answer", bad({k: v for k, v in locked.items() if k != "answer"})),
        ("locked false", bad({**plain, "locked": False})),
        ("non-locked with answer", bad({**plain, "answer": "decided"})),
        ("empty options", bad({**plain, "options": []})),
        ("steps not an array", {"steps": "x"}),
        ("steps empty", {"steps": []}),
        ("step not an object", bad(None)),
        ("step array", bad([42])),
        ("step with non-string id", bad({"id": {}})),
    ]
    for name, params in cases:
        error = task_input.validate_request("form", "p", params)
        assert error is not None, f"case {name!r} was accepted"
    # Hostile input never throws — every shape yields an error string.
    for hostile in ({"steps": None}, {}, {"steps": [None]}, {"steps": [42]},
                    {"steps": ["x" * 30000]}):
        assert isinstance(task_input.validate_request("form", "p", hostile), str)
    # The bound stays backstop-only: a maximal valid form (8 steps × 6
    # max-size options) stays under FORM_STEPS_JSON_MAX and is accepted.
    max_form = []
    for i in range(8):
        max_form.append({"id": f"s{i}", "title": "t" * 60, "decide": "d" * 200,
                         "options": [{"label": "L" * 60, "note": "n" * 200} for _ in range(6)],
                         "preselected": "L" * 60})
    serialized = json.dumps(max_form, ensure_ascii=False, separators=(",", ":"))
    assert len(serialized) <= task_input.INPUT_LIMITS["FORM_STEPS_JSON_MAX"]
    assert task_input.validate_request("form", "p", {"steps": max_form}) is None


def test_task_input_form_steps_file_creates_row(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    steps_path = tmp_path / "steps.json"
    steps_path.write_text(json.dumps({"sheet_prompt": FORM_SHEET_PROMPT,
                                      "steps": FORM_SEVEN_STEPS}), encoding="utf-8")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "form",
                      "--prompt", FORM_SHEET_PROMPT, "--steps-file", str(steps_path),
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["kind"] == "form"
    assert payload["task_state"] == "awaiting_input"
    request_id = payload["request_id"]
    request = fetch_one(db_path, "SELECT kind, params_json FROM input_requests")
    assert request["kind"] == "form"
    assert json.loads(request["params_json"])["steps"] == FORM_SEVEN_STEPS
    task = fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "awaiting_input"
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.input_needed"
    assert json.loads(event["payload_json"]) == {"request_id": request_id, "kind": "form"}


def test_task_input_form_steps_file_errors(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")

    def form_proc(*argv: str) -> subprocess.CompletedProcess:
        return run_script("task_input.py", "create", "--task", TASK_ID,
                          "--prompt", "p", *argv, pa_home=tmp_path)

    # Every rejection below fails BEFORE the ledger opens — side-effect-free.
    expect_fail(form_proc("--kind", "form", "--steps-file", str(tmp_path / "nope.json")),
                "cannot be read")
    bad_json = tmp_path / "bad.json"
    bad_json.write_text("{not json", encoding="utf-8")
    expect_fail(form_proc("--kind", "form", "--steps-file", str(bad_json)), "not valid JSON")
    expect_fail(form_proc("--kind", "choice", "--steps-file", "x"), "only valid with --kind form")
    expect_fail(form_proc("--kind", "form", "--param", "steps=1", "--steps-file", "x"),
                "--steps-file")
    dup = tmp_path / "dup.json"
    dup.write_text(json.dumps([dict(FORM_SEVEN_STEPS[0]), dict(FORM_SEVEN_STEPS[0])]),
                   encoding="utf-8")
    expect_fail(form_proc("--kind", "form", "--steps-file", str(dup)), "invalid input request")
    # The state gate is intact: forms are created from running, like every kind.
    other = "vi-" + "cd" * 6
    seed_task(db_path, task_id=other, state="received")
    valid = tmp_path / "valid.json"
    valid.write_text(json.dumps(FORM_SEVEN_STEPS), encoding="utf-8")
    expect_fail(run_script("task_input.py", "create", "--task", other, "--prompt", "p",
                           "--kind", "form", "--steps-file", str(valid), pa_home=tmp_path),
                "input requests are created from running")
    # The wrapper is optional: a bare-array steps file is accepted.
    proc = form_proc("--kind", "form", "--steps-file", str(valid))
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["task_state"] == "awaiting_input"
    request = fetch_one(db_path, "SELECT kind FROM input_requests WHERE request_id = ?",
                        (payload["request_id"],))
    assert request["kind"] == "form"


# ---------------------------------------------------------------------------
# task_complete.py
# ---------------------------------------------------------------------------


def test_complete_happy_path_from_running(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Filed the Q3 summary; two anomalies flagged",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["state"] == "done"
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "done"
    assert task["result_summary"] == "Filed the Q3 summary; two anomalies flagged"
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.completed"
    assert json.loads(event["payload_json"]) == {
        "result_chars": len("Filed the Q3 summary; two anomalies flagged")}
    assert re.fullmatch(r"s-[0-9a-f]{12}", event["ref_id"])


def test_complete_refused_from_awaiting_input_and_from_received(tmp_path, monkeypatch):
    # 2026-09-17: awaiting_input -> done is gone (closing dropped the question);
    # received -> done was never legal (a task must be routed first).
    db_path = make_case(tmp_path, monkeypatch, task_state="awaiting_input")
    seed_task(db_path, task_id="vi-" + "cd" * 6, state="received")
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "resolved",
                      pa_home=tmp_path)
    expect_fail(proc, "withdraw the question first")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "awaiting_input"
    proc = run_script("task_complete.py", "--task", "vi-" + "cd" * 6, "--summary", "resolved",
                      pa_home=tmp_path)
    expect_fail(proc, "illegal task state transition: received -> done")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     ("vi-" + "cd" * 6,))["state"] == "received"
    assert fetch_all(db_path, "SELECT * FROM events") == []


def test_complete_rejected_from_terminal(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="cancelled")
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "again",
                      pa_home=tmp_path)
    expect_fail(proc, "illegal task state transition: cancelled -> done")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "cancelled"


def test_complete_requires_summary(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 2
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "   ",
                      pa_home=tmp_path)
    assert proc.returncode == 2


def test_conversation_meta_written_by_complete(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "done",
                      "--title", "Q3 report", "--recap", "Filed and reviewed.",
                      "--next", "Await sign-off", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    meta = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert meta["title"] == "Q3 report"
    assert meta["recap"] == "Filed and reviewed."
    assert meta["next_action"] == "Await sign-off"

    # A sibling task in the SAME conversation, completed with --summary only:
    # title/recap stay intact, and next_action is cleared (D3's exception —
    # a completed conversation has no pending action item).
    sibling_id = "vi-" + "77" * 6
    seed_task(db_path, task_id=sibling_id, state="running", conversation_id=TASK_ID,
              request_text="follow-up in the same conversation")
    proc2 = run_script("task_complete.py", "--task", sibling_id, "--summary", "resolved",
                       pa_home=tmp_path)
    assert proc2.returncode == 0, proc2.stderr
    meta2 = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert meta2["title"] == "Q3 report"
    assert meta2["recap"] == "Filed and reviewed."
    assert meta2["next_action"] is None


def test_conversation_meta_clamps(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "done",
                      "--title", "x" * 61, "--recap", "y" * 401, "--next", "z" * 201,
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    meta = fetch_one(db_path, "SELECT * FROM conversation_meta WHERE conversation_id = ?", (TASK_ID,))
    assert len(meta["title"]) == 60
    assert len(meta["recap"]) == 400
    assert len(meta["next_action"]) == 200


def test_complete_title_recap_reject_blank(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "done",
                      "--title", "   ", pa_home=tmp_path)
    assert proc.returncode == 2
    assert "--title must not be empty" in proc.stderr
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "done",
                      "--recap", "   ", pa_home=tmp_path)
    assert proc.returncode == 2
    assert "--recap must not be empty" in proc.stderr


def test_complete_with_short_stores_it_uncapped(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id=TASK_ID, state="running",
              created_at="2026-09-01T00:00:00.000Z")
    long_summary = "Full answer. " * 30
    short = "s" * 500  # deliberately far past any historical cap
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", long_summary, "--short", short,
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    row = sqlite3.connect(db_path).execute(
        "SELECT state, result_summary, result_short FROM tasks WHERE task_id = ?",
        (TASK_ID,)).fetchone()
    assert row == ("done", long_summary, short)  # byte-exact, NOT clamped


def test_complete_without_short_leaves_null(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id=TASK_ID, state="running",
              created_at="2026-09-01T00:00:00.000Z")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Plain outcome.", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    row = sqlite3.connect(db_path).execute(
        "SELECT result_short FROM tasks WHERE task_id = ?", (TASK_ID,)).fetchone()
    assert row == (None,)


def test_complete_rejects_blank_short(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id=TASK_ID, state="running",
              created_at="2026-09-01T00:00:00.000Z")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Plain outcome.", "--short", "   ",
                      pa_home=tmp_path)
    # argparse validation (neighboring idiom — parser.error exits 2 with the
    # message on stderr, unlike the JSON-on-stdout ledger refusals)
    assert proc.returncode == 2
    assert "--short must not be empty" in proc.stderr
    # refused completions write nothing
    state = sqlite3.connect(db_path).execute(
        "SELECT state FROM tasks WHERE task_id = ?", (TASK_ID,)).fetchone()
    assert state == ("running",)


def test_complete_refuses_receipt_summaries(tmp_path, monkeypatch):
    """Summary-shape guard (2026-09-14): routing receipts are process, not the
    operator-facing outcome. Receipt verb + command-output markers (the
    observed junk shapes) and the markers alone all refuse with the standard
    named; a refusal writes nothing. argparse idiom: parser.error exits 2 with
    the message on stderr (same family as the blank-summary refusal)."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    receipts = [
        'Routed and verified. **Command output** (exit 0): ```json\n{"ok": true}\n```',
        'Done. Task routed to the reports topic. Command output: 0',
        'Transcribed and routed. ```json {"ok": true} ```',
        'The route command completed. {"ok": true, "topic": "reports"}',
        'Routed and verified. exit 0.',
    ]
    for text in receipts:
        proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", text,
                          pa_home=tmp_path)
        assert proc.returncode == 2, (text, proc.stdout, proc.stderr)
        assert "outcome for the operator" in proc.stderr, text
        # refused completions write nothing
        assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                         (TASK_ID,))["state"] == "running", text


def test_complete_accepts_fenced_real_outcome(tmp_path, monkeypatch):
    """False-refusal control: a fenced block wrapping real answer content is
    legitimate answer-card formatting (the route injection teaches it; the
    card renders it) and must close normally."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    good = ("You asked for this week's due reports.\n\n```text\n3 reports\n```\n\n"
            "Three are due Friday: the ops digest, the alert census and the "
            "backlog review.")
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", good,
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["state"] == "done"
    row = fetch_one(db_path, "SELECT result_summary FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert "```" in row["result_summary"]


def test_complete_refuses_transcript_repaste(tmp_path, monkeypatch):
    """Structural clause: a transcript re-paste (2+ verbatim request sentences)
    is process, not the answer. Ledger-refusal idiom: fail() exits 1 with the
    JSON error on stdout."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    request = ("Please look into why the nightly digest arrived late yesterday and "
               "tell me whether the mail queue backed up again. Also check the "
               "retry counters. If the queue backed up, restart the relay for me.")
    seed_task(db_path, task_id=TASK_ID, state="running", request_text=request,
              created_at="2026-09-01T00:00:00.000Z")
    repaste = "Done. Here is your request back verbatim: " + request
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", repaste,
                      pa_home=tmp_path)
    expect_fail(proc, "re-pastes the request transcript")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"


def test_complete_accepts_single_sentence_quote(tmp_path, monkeypatch):
    """False-refusal control: quoting ONE sentence of the request (a normal
    'you asked X' answer) never fires — only 2+ verbatim sentences refuse."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    request = ("Please look into why the nightly digest arrived late yesterday and "
               "tell me whether the mail queue backed up again. Also check the "
               "retry counters. If the queue backed up, restart the relay for me.")
    seed_task(db_path, task_id=TASK_ID, state="running", request_text=request,
              created_at="2026-09-01T00:00:00.000Z")
    answer = ("You asked whether the mail queue backed up again. It did not — the "
              "lateness was the relay restart, and the retry counters stayed at zero.")
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", answer,
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr


def test_complete_refuses_an_asking_task_and_keeps_its_question(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "choice",
                      "--prompt", "Which?", "--param", 'options=["a","b"]', pa_home=tmp_path)
    request_id = out_json(proc)["request_id"]
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "resolved without waiting for an answer",
                      pa_home=tmp_path)
    expect_fail(proc, f"task {TASK_ID} is awaiting_input; it is waiting on the operator's answer")
    assert fetch_one(db_path, "SELECT status FROM input_requests WHERE request_id = ?",
                     (request_id,))["status"] == "pending"
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "awaiting_input"
    assert fetch_all(db_path, "SELECT * FROM events WHERE kind = 'task.completed'") == []


def test_complete_sweeps_only_its_own_stray_pending_ask(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    own_ask = "ir-" + "aa" * 6
    seed_pending_ask(db_path, own_ask, TASK_ID)
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "Filed it.",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["cancelled_pending_inputs"] == 1
    assert fetch_one(db_path, "SELECT status FROM input_requests WHERE request_id = ?",
                     (own_ask,))["status"] == "cancelled"


def test_complete_never_cancels_another_tasks_question(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_topics(tmp_path)
    asking_id = "vi-" + "cd" * 6
    seed_task(db_path, task_id=asking_id, state="awaiting_input",
              created_at="2026-09-17T08:00:00.000Z")
    seed_task(db_path, task_id=TASK_ID, state="running", conversation_id=asking_id,
              created_at="2026-09-17T09:00:00.000Z")
    other_ask = "ir-" + "bb" * 6
    seed_pending_ask(db_path, other_ask, asking_id)
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "Answered the newer request.",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["cancelled_pending_inputs"] == 0
    assert fetch_one(db_path, "SELECT status FROM input_requests WHERE request_id = ?",
                     (other_ask,))["status"] == "pending"
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (asking_id,))["state"] == "awaiting_input"


def test_complete_by_an_older_task_keeps_the_newer_tasks_next_action(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_topics(tmp_path)
    older, newer = TASK_ID, "vi-" + "cd" * 6
    seed_task(db_path, task_id=older, state="running", created_at="2026-09-17T08:00:00.000Z")
    seed_task(db_path, task_id=newer, state="awaiting_input", conversation_id=older,
              created_at="2026-09-17T09:00:00.000Z")
    seed_conversation_meta(db_path, older, next_action="Reply with the deadline")
    proc = run_script("task_complete.py", "--task", older, "--summary", "Filed the older request.",
                      "--next", "Something else", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    meta = fetch_one(db_path, "SELECT next_action FROM conversation_meta WHERE conversation_id = ?", (older,))
    assert meta["next_action"] == "Reply with the deadline"
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute("UPDATE tasks SET state = 'running' WHERE task_id = ?", (newer,))
    conn.close()
    proc = run_script("task_complete.py", "--task", newer, "--summary", "Answered the newer request.",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    meta = fetch_one(db_path, "SELECT next_action FROM conversation_meta WHERE conversation_id = ?", (older,))
    assert meta["next_action"] is None, "the newest task's completion clears it"


def test_complete_sweep_leaves_answered_row_alone(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_input.py", "create", "--task", TASK_ID, "--kind", "text",
                      "--prompt", "Describe it", pa_home=tmp_path)
    request_id = out_json(proc)["request_id"]
    conn = sqlite3.connect(db_path)
    with conn:  # simulate the API's answer submission
        conn.execute(
            "UPDATE input_requests SET status = 'answered', answer_pointer = ?, answered_at = ?"
            " WHERE request_id = ?", ("p/ath", iso_now(), request_id))
        conn.execute("UPDATE tasks SET state = 'running', updated_at = ? WHERE task_id = ?",
                     (iso_now(), TASK_ID))
    conn.close()
    proc = run_script("task_complete.py", "--task", TASK_ID, "--summary", "done",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["cancelled_pending_inputs"] == 0
    assert fetch_one(db_path, "SELECT status FROM input_requests WHERE request_id = ?",
                     (request_id,))["status"] == "answered"


# --- duplicate-close guard (2026-09-12, the vi-499aac51e800 incident) --------
# Verbatim incident texts replayed from the ledger: the operator's 14:51 IST
# request (dropped), the logo-consistency request sent 22 seconds later (the
# WRONG cover a worker could point at), and the close-out summary that ended
# the task with no covering work. A summary claiming coverage elsewhere must
# name --covered-by a task the LEDGER shows carries the same request. Every
# refusal below is a shape of the real incident; the succeed case and the
# regex/overlap pins are the discriminating controls that prove the gate can
# both fail (it must) and open (for genuine duplicates).

INCIDENT_REQUEST = (" I think the mic button in the main page should be exactly in the "
                    "middle and tap to record  should be a small subtext at the bottom "
                    "or just record in the center or just not have  that just put the "
                    "icon of the mic there I think that should be enough no text is "
                    "required.")
INCIDENT_WRONG_COVER_REQUEST = ("and actually make the mic button logo consistent "
                                "across all the places, yeah even inside the thread as "
                                "well, keep the button the same")
INCIDENT_SUMMARY = ("Feedback: the mic button on the voice-inbox main page should be "
                    "centered, with no tap-to-record subtext — just the mic icon by "
                    "itself is enough. This was already transcribed and routed to the "
                    "voice-inbox topic as UI feedback; this dispatch closes out a "
                    "duplicate/stale ledger entry for the same task.")
COVER_ID = "vi-" + "5a" * 6


def make_incident_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                       cover_state: str | None = None,
                       cover_request: str | None = None) -> Path:
    """Fresh case: TASK_ID running with the incident request, optionally a
    covering task in `cover_state` carrying `cover_request`."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, state="running", request_text=INCIDENT_REQUEST)
    seed_topics(tmp_path)
    if cover_state is not None:
        seed_task(db_path, task_id=COVER_ID, state=cover_state,
                  request_text=cover_request if cover_request is not None
                  else INCIDENT_REQUEST)
    return db_path


def test_complete_incident_replay_duplicate_close_refused(tmp_path, monkeypatch):
    """The known-bad case, verbatim: the exact summary that closed the
    operator's request on 2026-09-12 with no covering task. The gate must
    refuse it and leave the task untouched — had this gate existed, the
    request could not have silently vanished."""
    db_path = make_incident_case(tmp_path, monkeypatch)
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", INCIDENT_SUMMARY, pa_home=tmp_path)
    expect_fail(proc, "duplicate-close guard")
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "running"
    assert task["result_summary"] is None
    assert fetch_all(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,)) == []


def test_complete_covered_by_unknown_task_refused(tmp_path, monkeypatch):
    db_path = make_incident_case(tmp_path, monkeypatch)
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Duplicate of an earlier task; already handled there.",
                      "--covered-by", "vi-" + "ee" * 6, pa_home=tmp_path)
    expect_fail(proc, "covering task not found")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"


def test_complete_covered_by_self_refused(tmp_path, monkeypatch):
    """The degenerate cover: naming the task ITSELF. It exists, shares the
    tenant, is 'running' (passes the progression floor) and overlaps 100% —
    every other check would pass, so the self-reference needs its own gate."""
    db_path = make_incident_case(tmp_path, monkeypatch)
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Duplicate of an earlier task; already handled there.",
                      "--covered-by", TASK_ID, pa_home=tmp_path)
    expect_fail(proc, "cannot cover itself")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"


def test_complete_covered_by_wrong_request_refused(tmp_path, monkeypatch):
    """The historically-adjacent variant: naming the logo-consistency task
    (done, real, 22 seconds later) as the cover — the exact wrong cover the
    incident's worker treated as covering. Different request => refused."""
    db_path = make_incident_case(tmp_path, monkeypatch, cover_state="done",
                                 cover_request=INCIDENT_WRONG_COVER_REQUEST)
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "closes out a duplicate of the earlier mic task",
                      "--covered-by", COVER_ID, pa_home=tmp_path)
    expect_fail(proc, "requests different work")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"


def test_complete_covered_by_unprogressed_task_refused(tmp_path, monkeypatch):
    """A same-request cover that is still `received` has not actually done
    anything — closing against it reproduces the incident with one indirection
    (both tasks then sit unworked). Refused until it progresses."""
    db_path = make_incident_case(tmp_path, monkeypatch, cover_state="received")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Duplicate of the earlier task; already routed there.",
                      "--covered-by", COVER_ID, pa_home=tmp_path)
    expect_fail(proc, "still 'received'")
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"


def test_complete_covered_by_same_request_succeeds(tmp_path, monkeypatch):
    """The discriminating control: a genuine duplicate (a PARAPHRASE, not a
    byte-copy, so the overlap floor's pass side is exercised) named with
    --covered-by completes normally. A gate that only ever refused would
    prove nothing — this is it opening."""
    db_path = make_incident_case(tmp_path, monkeypatch, cover_state="done",
                                 cover_request="remove the tap to record caption under "
                                               "the big mic button")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Duplicate of the earlier task; the same request "
                                   "is already handled there.",
                      "--covered-by", COVER_ID, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["state"] == "done"
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "done"
    assert task["result_summary"].startswith("Duplicate of the earlier task")


def test_guard_regex_fires_only_on_closeout_phrasing():
    """Tuned against all 259 real completion summaries in the ledger: the
    close-out anchors fire; ordinary prose that merely mentions duplicates,
    'the same task system', or things 'already sent' must not (bare-word
    matching would have falsely refused 17% of real completions)."""
    fires = [
        INCIDENT_SUMMARY,
        "This exact build is already under way. The same request went through "
        "the normal path in the feature-recommendations topic.",
        "This route was a stale duplicate: the original voice request sat "
        "unrouted for about 33 hours.",
    ]
    silent = [
        "I traced the duplicate Swiggy OTP prompts to two voice notes sent 14 "
        "seconds apart.",
        "Completion of both is tracked through the same task and backlog system.",
        "The cancellation email was already sent, so no further action is needed.",
        "Filed the Q3 summary; two anomalies flagged",
        "That closes out the full subscriptions audit: the ZEE5 refund was sent.",
    ]
    for text in fires:
        assert task_complete.DUPLICATE_CLAIM_RE.search(text), text
    for text in silent:
        assert not task_complete.DUPLICATE_CLAIM_RE.search(text), text


def test_covered_by_overlap_calibration_pins_the_incident_gap():
    """The floor (0.15) must stay inside the measured gap: the incident's
    wrong cover scores ~0.07, a paraphrased true duplicate ~0.24. If a future
    edit to the stopwords or tokenizer moves either side across the floor,
    this pin forces a conscious re-calibration instead of silent drift."""
    wrong = task_complete.request_overlap(INCIDENT_REQUEST, INCIDENT_WRONG_COVER_REQUEST)
    right = task_complete.request_overlap(
        INCIDENT_REQUEST, "remove the tap to record caption under the big mic button")
    assert wrong < task_complete.COVERED_BY_MIN_OVERLAP < right, (wrong, right)


# task_complete.py --attach (AI-244): result artifacts stage into
# files/<task_id>/ under the SAME copy semantics as task_blocker_ask.py's
# screenshot — sanitized basename, `result-` prefix (never audio.*/tmp-*),
# -N de-conflict, tmp-* staging then rename. The dir listing IS the
# registration; the task.completed event carries the stored names.


def complete_attach_artifact(tmp_path: Path, name: str = "report.pdf") -> Path:
    artifact = tmp_path / name
    artifact.write_bytes(b"%PDF-result-artifact")
    return artifact


def test_complete_attach_copies_result_file(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    artifact = complete_attach_artifact(tmp_path)
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Built the Q3 report PDF",
                      "--attach", str(artifact), pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["state"] == "done"
    assert payload["attachments"] == ["result-report.pdf"]
    stored_path = Path(payload["attachment_paths"][0])
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    assert stored_path.parent == task_dir
    assert stored_path.read_bytes() == artifact.read_bytes()
    # No tmp-* residue; the copy is the registration — nothing else to call.
    assert [e.name for e in task_dir.iterdir()] == ["result-report.pdf"]
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.completed"
    assert json.loads(event["payload_json"]) == {
        "result_chars": len("Built the Q3 report PDF"),
        "attachments": ["result-report.pdf"]}


def test_complete_attach_repeatable_and_deconflicts(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    task_dir.mkdir(parents=True)
    (task_dir / "result-report.pdf").write_bytes(b"earlier")  # forces -2
    first = complete_attach_artifact(tmp_path, "report.pdf")
    second = complete_attach_artifact(tmp_path, "chart.png")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Report and chart generated",
                      "--attach", str(first), "--attach", str(second),
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["attachments"] == ["result-report-2.pdf", "result-chart.png"]
    assert (task_dir / "result-report.pdf").read_bytes() == b"earlier"
    assert (task_dir / "result-report-2.pdf").read_bytes() == first.read_bytes()
    assert (task_dir / "result-chart.png").read_bytes() == second.read_bytes()


def test_complete_attach_sanitizes_reserved_and_weird_names(tmp_path, monkeypatch):
    """The result- prefix is the registration guarantee: a source named
    `audio.mp3` or `tmp-x.txt` can never land under an invisible/excluded
    name, and non-[A-Za-z0-9._-] chars collapse to _ (sanitizeUploadName)."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    audio = tmp_path / "audio.mp3"
    audio.write_bytes(b"mp3-bytes")
    tmp = tmp_path / "tmp-x.txt"
    tmp.write_bytes(b"tmp-bytes")
    weird = tmp_path / "my chart (final).png"
    weird.write_bytes(b"png-bytes")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Three artifacts produced",
                      "--attach", str(audio), "--attach", str(tmp),
                      "--attach", str(weird), pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["attachments"] == [
        "result-audio.mp3", "result-tmp-x.txt", "result-my_chart__final_.png"]
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    # The listing's exclusions are ^audio\. and ^tmp- — every stored name
    # survives them, so all three would render on the card.
    assert all(not re.match(r"^(audio\.|tmp-)", n, re.IGNORECASE)
               for n in payload["attachments"])
    assert (task_dir / "result-my_chart__final_.png").read_bytes() == b"png-bytes"
    event = fetch_one(db_path, "SELECT payload_json FROM events WHERE task_id = ?",
                      (TASK_ID,))
    assert json.loads(event["payload_json"])["attachments"] == payload["attachments"]


def test_complete_attach_dash_prefixed_path_value(tmp_path, monkeypatch):
    """A --attach value starting with a single dash is joined into
    --flag=value form by normalize_argv (the shared VALUE_FLAGS pin)."""
    make_case(tmp_path, monkeypatch, task_state="running")
    # A bare `-draft.png` value would be eaten by argparse as an option string
    # (exit 2) without the normalize_argv join; with it, the flag parses and the
    # isfile check fails cleanly (no such file in the subprocess's CWD).
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Attached a dash-named file",
                      "--attach", "-draft.png", pa_home=tmp_path)
    assert proc.returncode == 1
    assert "attachment not found: -draft.png" in out_json(proc)["error"]


def test_complete_attach_missing_file_fails_clean(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    ok_file = complete_attach_artifact(tmp_path, "chart.png")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--attach", str(ok_file),
                      "--attach", str(tmp_path / "nope.png"), pa_home=tmp_path)
    expect_fail(proc, "attachment not found")
    # All paths checked before the first copy: nothing staged, task untouched.
    assert not (tmp_path / "voice-inbox" / "files").exists()
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "running"
    assert fetch_all(db_path, "SELECT * FROM events") == []


def test_complete_attach_refusal_keeps_evidence(tmp_path, monkeypatch):
    """A ledger-stage refusal (here: received -> done is illegal) keeps the
    copied artifacts — they are the produced results, and a corrected re-run
    de-conflicts the names (task_blocker_ask.py's create-refusal semantics)."""
    db_path = make_case(tmp_path, monkeypatch, task_state="received")
    artifact = complete_attach_artifact(tmp_path)
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--attach", str(artifact),
                      pa_home=tmp_path)
    expect_fail(proc, "illegal task state transition: received -> done")
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    assert [e.name for e in task_dir.iterdir()] == ["result-report.pdf"]
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "received"
    assert fetch_all(db_path, "SELECT * FROM events") == []


# ---------------------------------------------------------------------------
# AI-234: --suggest quick-reply chips (task_complete.py)
# ---------------------------------------------------------------------------

def test_complete_with_suggest_stores_items(tmp_path, monkeypatch):
    """--suggest writes a JSON array to tasks.suggested_items."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "The answer is ready.",
                      "--suggest", "Tell me more",
                      "--suggest", "Show the details",
                      pa_home=tmp_path)
    out = out_json(proc)
    assert out["state"] == "done"
    assert out["suggested_items"] == ["Tell me more", "Show the details"]
    row = fetch_one(db_path, "SELECT suggested_items FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert row["suggested_items"] is not None
    assert json.loads(row["suggested_items"]) == ["Tell me more", "Show the details"]


def test_complete_with_suggest_in_event_payload(tmp_path, monkeypatch):
    """The task.completed event payload carries suggested_items (audit parity
    with attachments)."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    run_script("task_complete.py", "--task", TASK_ID,
               "--summary", "The answer is ready.",
               "--suggest", "Tell me more",
               pa_home=tmp_path)
    events = fetch_all(db_path,
                       "SELECT payload_json FROM events WHERE kind = 'task.completed'")
    assert len(events) == 1
    payload = json.loads(events[0]["payload_json"])
    assert payload["suggested_items"] == ["Tell me more"]


def test_complete_suggest_drops_non_plain_keeps_survivors(tmp_path, monkeypatch):
    """The plain-language guard drops code/symbols but keeps plain entries;
    the answer still writes."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "The answer is ready.",
                      "--suggest", "Tell me more",
                      "--suggest", "`code snippet`",
                      "--suggest", "Show the details",
                      "--suggest", "http://evil.com",
                      pa_home=tmp_path)
    out = out_json(proc)
    assert out["state"] == "done"
    assert out["suggested_items"] == ["Tell me more", "Show the details"]
    row = fetch_one(db_path, "SELECT suggested_items FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert json.loads(row["suggested_items"]) == ["Tell me more", "Show the details"]


def test_complete_suggest_all_dropped_exits_nonzero_but_writes_summary(tmp_path, monkeypatch):
    """When every --suggest entry is non-plain, the script exits non-zero so
    the worker sees it — but the completion still lands (state=done, summary
    written, event emitted). Chips never block the answer."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "The answer is ready.",
                      "--suggest", "`code`",
                      "--suggest", "{json}",
                      pa_home=tmp_path)
    assert proc.returncode != 0
    # The completion still landed.
    row = fetch_one(db_path, "SELECT state, result_summary, suggested_items FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert row["state"] == "done"
    assert row["result_summary"] == "The answer is ready."
    assert row["suggested_items"] is None
    events = fetch_all(db_path,
                       "SELECT payload_json FROM events WHERE kind = 'task.completed'")
    assert len(events) == 1
    payload = json.loads(events[0]["payload_json"])
    assert "suggested_items" not in payload


def test_complete_without_suggest_leaves_null(tmp_path, monkeypatch):
    """No --suggest means the column stays NULL and the payload omits the key."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "The answer is ready.",
                      pa_home=tmp_path)
    out = out_json(proc)
    assert out["state"] == "done"
    assert "suggested_items" not in out
    row = fetch_one(db_path, "SELECT suggested_items FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert row["suggested_items"] is None


def test_complete_suggest_caps_at_four(tmp_path, monkeypatch):
    """More than 4 plain suggestions are capped at 4."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "The answer is ready.",
                      "--suggest", "one", "--suggest", "two",
                      "--suggest", "three", "--suggest", "four",
                      "--suggest", "five",
                      pa_home=tmp_path)
    out = out_json(proc)
    assert out["suggested_items"] == ["one", "two", "three", "four"]
    row = fetch_one(db_path, "SELECT suggested_items FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert json.loads(row["suggested_items"]) == ["one", "two", "three", "four"]


# ---------------------------------------------------------------------------
# P1: --structured validation (task_complete.py)
# ---------------------------------------------------------------------------

def test_complete_with_structured_stores_json(tmp_path, monkeypatch):
    """A valid comparison JSON passes validation and stores in result_structured."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "comparison.json"
    struct_path.write_text(json.dumps({
        "type": "comparison",
        "title": "Used 7-seater shortlist",
        "recommendation": "Ertiga for mileage",
        "items": [
            {"name": "Maruti Ertiga", "attributes": {"Price": "12 lakh", "Mileage": "18 km/l"},
             "actions": [{"label": "Call seller", "kind": "call", "value": "+91..."}]}
        ]
    }), encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Here is the comparison",
                      "--structured", str(struct_path), pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT result_structured FROM tasks WHERE task_id = ?", (TASK_ID,))
    stored = json.loads(task["result_structured"])
    assert stored["type"] == "comparison"
    assert stored["items"][0]["name"] == "Maruti Ertiga"


def test_complete_structured_malformed_json_rejected(tmp_path, monkeypatch):
    """Malformed JSON in the --structured file exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "bad.json"
    struct_path.write_text("{not valid json", encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "invalid JSON")


def test_complete_structured_unknown_type_rejected(tmp_path, monkeypatch):
    """An unknown type value exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "bad.json"
    struct_path.write_text(json.dumps({"type": "unknown", "items": []}), encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "must be one of")


def test_complete_structured_item_missing_name_rejected(tmp_path, monkeypatch):
    """An item without a name exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "bad.json"
    struct_path.write_text(json.dumps({
        "type": "listing", "items": [{"attributes": {}}]
    }), encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "name must be a non-empty string")


def test_complete_structured_oversized_rejected(tmp_path, monkeypatch):
    """JSON over 64KB exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "big.json"
    # >64KB while staying under the 20-item cap (item-count validation runs
    # before the size cap, so a huge item count would fail on "max 20" first —
    # a big attribute value is what actually exercises the byte ceiling).
    struct_path.write_text(json.dumps({
        "type": "listing",
        "items": [{"name": "item", "attributes": {"blob": "x" * 70000}}]
    }), encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "exceeds")


def test_complete_structured_too_many_items_rejected(tmp_path, monkeypatch):
    """Over 20 items exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "many.json"
    items = [{"name": f"item-{i}"} for i in range(21)]
    struct_path.write_text(json.dumps({"type": "listing", "items": items}),
                           encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "max 20")


def test_complete_without_structured_leaves_null(tmp_path, monkeypatch):
    """Absent --structured leaves result_structured NULL."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT result_structured FROM tasks WHERE task_id = ?",
                     (TASK_ID,))
    assert task["result_structured"] is None


def test_complete_structured_form_set_uses_steps(tmp_path, monkeypatch):
    """form-set type requires steps, not items."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "form.json"
    struct_path.write_text(json.dumps({
        "type": "form-set",
        "steps": [{"id": "s1", "prompt": "What?", "type": "text"}]
    }), encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "Fill this form",
                      "--structured", str(struct_path), pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    task = fetch_one(db_path, "SELECT result_structured FROM tasks WHERE task_id = ?", (TASK_ID,))
    stored = json.loads(task["result_structured"])
    assert stored["type"] == "form-set"


def test_complete_structured_unknown_action_kind_rejected(tmp_path, monkeypatch):
    """An action with unknown kind exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "bad.json"
    struct_path.write_text(json.dumps({
        "type": "comparison", "items": [
            {"name": "X", "actions": [{"label": "Do", "kind": "unknown"}]}
        ]
    }), encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "kind must be one of")


def test_complete_structured_nonfinite_number_rejected(tmp_path, monkeypatch):
    """A NaN/Infinity value exits non-zero — Python's json.loads reads them,
    but the stored JSON would be unparseable by the PWA's JSON.parse and would
    silently fall back to markdown."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "nan.json"
    struct_path.write_text(
        '{"type": "listing", "items": [{"name": "X", '
        '"attributes": {"score": NaN}}]}', encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "non-finite")


def test_complete_structured_nonobject_rejected(tmp_path, monkeypatch):
    """A JSON array (not object) in --structured exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    struct_path = tmp_path / "arr.json"
    struct_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done", "--structured", str(struct_path),
                      pa_home=tmp_path)
    expect_fail(proc, "JSON object")


def test_complete_structured_missing_file_rejected(tmp_path, monkeypatch):
    """A --structured path that does not exist exits non-zero."""
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_complete.py", "--task", TASK_ID,
                      "--summary", "done",
                      "--structured", str(tmp_path / "nope.json"),
                      pa_home=tmp_path)
    expect_fail(proc, "cannot read")


def test_complete_structured_help_names_per_kind_action_fields(tmp_path, monkeypatch):
    """`task_complete.py --help` is THE shape reference the injection guidance
    names ("--structured <json> (task_complete.py --help)"), so it must name
    the per-kind target fields the PWA's renderActionButton requires — the
    server validator checks label+kind only, and an action missing its target
    field renders NO control. A documented shape of just {label, kind} lets a
    worker emit a call/link that validates yet paints nothing (P3 recheck)."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    proc = run_script("task_complete.py", "--help", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    flat = re.sub(r"\s+", " ", proc.stdout)
    for fragment in ('"value"', '"url"', '"prompt"'):
        assert fragment in flat, \
            f"--structured help lost the per-kind action field {fragment}"
    assert "call" in flat and "link" in flat and "task" in flat, \
        "--structured help lost an action kind"


# ---------------------------------------------------------------------------
# P4: --structured form-set validation (task_complete.py)
# ---------------------------------------------------------------------------

def _structured_error(payload):
    """Run validate_structured, return 'ok' or the fail() message."""
    import io, contextlib
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            task_complete.validate_structured(payload, "case.json")
    except SystemExit:
        pass
    out = buf.getvalue().strip()
    if not out:
        return "ok"
    row = json.loads(out.splitlines()[-1])
    return row.get("error", "ok") if row.get("ok") is False else "ok"


def _fs(**kw):
    base = {"type": "form-set",
            "steps": [{"id": "a", "prompt": "A?", "options": ["x", "y"]}]}
    base.update(kw)
    return base


def test_structured_formset_accepts_the_full_shape():
    ok = [
        _fs(),                                                        # minimal
        _fs(steps=[{"id": "s", "title": "Pick", "options": ["A", "B"]}]),
        _fs(steps=[{"id": "ok", "prompt": "Proceed?", "type": "confirm"}]),
        _fs(steps=[{"id": "t", "prompt": "T?", "type": "text", "preselected": "d"}]),
        _fs(steps=[{"id": "l", "prompt": "K", "locked": True, "answer": "v"},
                   {"id": "q", "prompt": "Q?", "options": ["a"]}]),
        _fs(steps=[{"id": "a", "prompt": "A?", "options": ["y", "n"],
                    "branch": {"y": "c"}},
                   {"id": "b", "prompt": "B?", "options": ["x"]},
                   {"id": "c", "prompt": "C?", "options": ["x"]}]),
        _fs(submit="update-conversation", submit_early=True),
        _fs(submit="save-only"),
        _fs(steps=[{"id": f"s{i}", "prompt": f"Q{i}?", "options": ["x"]}
                   for i in range(20)]),
        {"type": "comparison", "items": [{"name": "a"}]},               # unaffected
    ]
    for payload in ok:
        assert _structured_error(payload) == "ok", payload


def test_structured_formset_rejects_step_shape_errors():
    cases = [
        (_fs(steps="nope"), "'steps' must be an array"),
        (_fs(steps=[]), "'steps' has 0 entries"),
        (_fs(steps=[{"id": f"s{i}", "prompt": "p", "options": ["x"]}
                    for i in range(21)]), "max 20"),
        (_fs(steps=[42]), "must be an object"),
        (_fs(steps=[{"prompt": "p", "options": ["x"]}]), "id must match"),
        (_fs(steps=[{"id": "BAD!", "prompt": "p", "options": ["x"]}]), "id must match"),
        (_fs(steps=[{"id": "a", "prompt": "p", "options": ["x"]},
                    {"id": "a", "prompt": "p2", "options": ["y"]}]), "not unique"),
        (_fs(steps=[{"id": "a", "options": ["x"]}]), "non-empty 'prompt' or 'title'"),
        (_fs(steps=[{"id": "a", "prompt": "p", "locked": True}]),
         "answer must be a non-empty"),
        (_fs(steps=[{"id": "a", "prompt": "p", "type": "weird", "options": ["x"]}]),
         "type must be one of"),
        (_fs(steps=[{"id": "a", "prompt": "p"}]), "options must be a non-empty array"),
        (_fs(steps=[{"id": "a", "prompt": "p", "options": [{"note": "n"}]}]),
         "non-empty label"),
        (_fs(steps=[{"id": "a", "prompt": "p", "options": ["x", "x"]}]),
         "labels must be unique"),
        (_fs(steps=[{"id": "a", "prompt": "p", "options": ["x"],
                     "preselected": "ghost"}]), "preselected must equal one option label"),
        (_fs(steps=[{"id": "f", "prompt": "p", "type": "file", "preselected": "x.pdf"}]),
         "preselected needs an answerable"),
    ]
    for payload, fragment in cases:
        assert fragment in str(_structured_error(payload)), payload


def test_structured_formset_rejects_submit_errors():
    assert "'submit' must be one of" in str(_structured_error(_fs(submit="teleport")))
    assert "submit_early' must be a boolean" in str(_structured_error(_fs(submit_early="yes")))
    assert "save-only" in str(_structured_error(
        _fs(submit="save-only",
            steps=[{"id": "a", "prompt": "p", "options": ["x"]},
                   {"id": "f", "prompt": "Attach", "type": "file"}])))


def test_structured_formset_rejects_branch_errors():
    bad = [
        (_fs(steps=[{"id": "a", "prompt": "p", "options": ["x"], "branch": "b"}]),
         "branch must be an object"),
        (_fs(steps=[{"id": "t", "prompt": "p", "type": "text", "branch": {"x": "b"}},
                    {"id": "b", "prompt": "B?", "options": ["x"]}]),
         "option/answer-keyed"),
        (_fs(steps=[{"id": "a", "prompt": "p", "options": ["x"],
                     "branch": {"x": "ghost"}}]), "declared step id"),
        (_fs(steps=[{"id": "a", "prompt": "p", "options": ["x"],
                     "branch": {"x": "a"}}]), "must not point at its own step"),
        (_fs(steps=[{"id": "a", "prompt": "p", "options": ["x"],
                     "branch": {"ghost": "b"}},
                    {"id": "b", "prompt": "B?", "options": ["y"]}]),
         "must match an option label"),
        (_fs(steps=[{"id": "l", "prompt": "p", "locked": True, "answer": "hit",
                     "branch": {"miss": "b"}},
                    {"id": "b", "prompt": "B?", "options": ["x"]}]),
         "locked step's answer"),
    ]
    for payload, fragment in bad:
        assert fragment in str(_structured_error(payload)), payload


def test_structured_formset_branch_good_cases_accept():
    good = [
        _fs(steps=[{"id": "a", "prompt": "A?", "type": "confirm", "branch": {"No": "e"}},
                   {"id": "e", "prompt": "E?", "options": ["x"]}]),
        _fs(steps=[{"id": "l", "prompt": "K", "locked": True, "answer": "hit",
                    "branch": {"hit": "b"}},
                   {"id": "b", "prompt": "B?", "options": ["x"]}]),
        # A confirm without options answers Yes/No on the client — a key on
        # either implicit label is real (P4 recheck: labels used to stay
        # empty, so every key was unchecked).
        _fs(steps=[{"id": "a", "prompt": "A?", "type": "confirm",
                    "branch": {"Yes": "b"}},
                   {"id": "b", "prompt": "B?", "options": ["x"]}]),
        _fs(steps=[{"id": "a", "prompt": "A?", "type": "confirm",
                    "preselected": "Yes"}]),
    ]
    for payload in good:
        assert _structured_error(payload) == "ok", payload


def test_structured_formset_confirm_implicit_labels_reject_ghosts():
    # The same implicit Yes/No set rejects what can never be an answer.
    bad = [
        (_fs(steps=[{"id": "a", "prompt": "A?", "type": "confirm",
                     "branch": {"Maybe": "b"}},
                    {"id": "b", "prompt": "B?", "options": ["x"]}]),
         "must match an option label"),
        (_fs(steps=[{"id": "a", "prompt": "A?", "type": "confirm",
                     "preselected": "Maybe"}]),
         "preselected must equal one option label"),
    ]
    for payload, fragment in bad:
        assert fragment in str(_structured_error(payload)), payload


def test_route_lock_retries_until_acquire_on_vanish(tmp_path, monkeypatch):
    """Regression (deep-recheck pass-4): the original bounded for-loop could
    exhaust and yield UNLOCKED when the holder released during the final
    retry (stat FileNotFoundError / stale-steal 'continue' paths skipped the
    budget check) — the exact silent-loss window the mutex exists to close.
    The lock must keep retrying until mkdir actually succeeds, and release
    must still remove the directory."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    (tmp_path / "voice-inbox").mkdir(parents=True)
    lock = tmp_path / "voice-inbox" / "route-queue.jsonl.lock"
    real_mkdir = os.mkdir
    real_stat = os.stat
    state = {"mkdirs": 0}
    flaky_max = route_task.ROUTE_QUEUE_LOCK_RETRIES + 3

    def flaky_mkdir(path, *args, **kwargs):
        if os.fspath(path) == str(lock) and state["mkdirs"] < flaky_max:
            state["mkdirs"] += 1
            raise FileExistsError(11, "held")
        return real_mkdir(path, *args, **kwargs)

    def gone_stat(path, *args, **kwargs):
        raise FileNotFoundError(2, "vanished", os.fspath(path))

    monkeypatch.setattr(route_task.os, "mkdir", flaky_mkdir)
    monkeypatch.setattr(route_task.os, "stat", gone_stat)
    monkeypatch.setattr(route_task.time, "sleep", lambda s: None)

    def held_via_real_stat() -> bool:
        # pathlib's is_dir()/exists() route through the PATCHED os.stat, whose
        # FileNotFoundError they swallow into a False — assert via the real one.
        try:
            real_stat(lock)
            return True
        except FileNotFoundError:
            return False

    with route_task.route_queue_lock():
        assert held_via_real_stat(), "must hold the mkdir lock inside the context"
    assert not held_via_real_stat(), "release must remove the lock directory"


# ---------------------------------------------------------------------------
# task_transcribe.py
# ---------------------------------------------------------------------------


def test_transcribe_success_moves_transcribing_to_received(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    transcript = "Please summarize the Q3 report"
    proc = run_script("task_transcribe.py", "--task", TASK_ID,
                      "--transcript", transcript, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["task_id"] == TASK_ID
    assert payload["state"] == "received"
    assert re.fullmatch(r"s-[0-9a-f]{12}", payload["ref_id"])

    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "received"
    assert task["transcript"] == transcript
    assert task["request_text"] == transcript  # request text becomes the transcript

    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.transcribed"
    assert event["ref_id"] == payload["ref_id"]
    assert re.fullmatch(r"s-[0-9a-f]{12}", event["ref_id"])
    assert event["summary"] is None
    assert event["tenant_id"] == TENANT_ID
    assert json.loads(event["payload_json"]) == {"chars": len(transcript)}
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", event["ts"])


def test_transcribe_records_engine_in_payload(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_transcribe.py", "--task", TASK_ID,
                      "--transcript", "hello there", "--engine", "groq", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["state"] == "received"
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert json.loads(event["payload_json"]) == {"chars": len("hello there"), "engine": "groq"}
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "received"


def test_transcribe_fail_moves_to_transcribe_failed(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_transcribe.py", "--task", TASK_ID, "--fail",
                      "--reason", "no transcription key configured", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["task_id"] == TASK_ID
    assert payload["state"] == "transcribe_failed"
    assert re.fullmatch(r"s-[0-9a-f]{12}", payload["ref_id"])

    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "transcribe_failed"
    assert task["transcript"] is None
    assert task["request_text"] == REQUEST_TEXT  # the failure path never invents a request

    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.failed"
    assert json.loads(event["payload_json"]) == {"reason": "no transcription key configured"}
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", event["ts"])


def test_transcribe_rejects_non_transcribing_states(tmp_path, monkeypatch):
    for state in ("received", "routed", "running", "done"):
        home = tmp_path / state
        db_path = make_case(home, monkeypatch, task_state=state)
        proc = run_script("task_transcribe.py", "--task", TASK_ID,
                          "--transcript", "hello", pa_home=home)
        expect_fail(proc, "valid only from transcribing")
        assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                         (TASK_ID,))["state"] == state
        assert fetch_all(db_path, "SELECT * FROM events") == []


def test_transcribe_missing_task(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_transcribe.py", "--task", "vi-" + "ee" * 6,
                      "--transcript", "hello", pa_home=tmp_path)
    expect_fail(proc, "not found")
    assert fetch_all(db_path, "SELECT * FROM events") == []


def test_transcribe_rejects_empty_transcript(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    for transcript in ("", "   "):
        proc = run_script("task_transcribe.py", "--task", TASK_ID,
                          "--transcript", transcript, pa_home=tmp_path)
        expect_fail(proc, "transcript must be a non-empty string")
    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "transcribing"  # nothing written
    assert task["transcript"] is None
    assert fetch_all(db_path, "SELECT * FROM events") == []


def test_transcribe_fail_requires_reason(tmp_path, monkeypatch):
    make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_transcribe.py", "--task", TASK_ID, "--fail", pa_home=tmp_path)
    assert proc.returncode == 2
    assert "--reason is required with --fail" in proc.stderr


def test_transcribe_fail_with_code_appends_code_last(tmp_path, monkeypatch):
    """AI-223: --code is additive, reason text unchanged, key order is
    reason-then-code (existing keys first)."""
    db_path = make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_transcribe.py", "--task", TASK_ID, "--fail",
                      "--reason", "audio file is 100 bytes, under the 8192-byte floor",
                      "--code", "too_short", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out_json(proc)["state"] == "transcribe_failed"

    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.failed"
    payload = json.loads(event["payload_json"])
    assert payload == {"reason": "audio file is 100 bytes, under the 8192-byte floor",
                        "code": "too_short"}
    assert list(payload.keys()) == ["reason", "code"]  # existing keys first, code last


def test_transcribe_fail_without_code_omits_it(tmp_path, monkeypatch):
    """A genuine transcription/infra error (no --code passed) must NOT gain a
    code key — only the classified too_short shapes do."""
    db_path = make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_transcribe.py", "--task", TASK_ID, "--fail",
                      "--reason", "transcription failed (network_error): timeout",
                      pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    payload = json.loads(event["payload_json"])
    assert payload == {"reason": "transcription failed (network_error): timeout"}
    assert "code" not in payload


def test_transcribe_code_requires_fail(tmp_path, monkeypatch):
    make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_transcribe.py", "--task", TASK_ID,
                      "--transcript", "hello", "--code", "too_short", pa_home=tmp_path)
    assert proc.returncode == 2
    assert "--code is only valid with --fail" in proc.stderr


def test_voice_lifecycle_transcribe_then_route(tmp_path, monkeypatch):
    """End-to-end voice flow: transcribing -> received (write-back) -> routed,
    and the queue entry's target text carries the transcript as request_text."""
    db_path = make_voice_case(tmp_path, monkeypatch)
    transcript = "Voice: file the expense report"
    proc = run_script("task_transcribe.py", "--task", TASK_ID,
                      "--transcript", transcript, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "expenses fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    assert entries[0]["text"] == EXPECTED_TARGET_TEXT.format(
        task_id=TASK_ID, reason="expenses fit here", request_text=transcript,
        repo=REPO.resolve().as_posix(), briefing="", framing="", attachments="")

    task = fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert task["state"] == "routed"
    assert task["routed_to"] == TOPIC_KEY
    assert task["request_text"] == transcript


# --- AI-conversation-context WP-2: the conversation briefing --------------------


def test_conversation_briefing_golden(tmp_path):
    """The python twin renders WP-1 fixture A byte-identically to the TS
    golden implementation (`src/tests/conversation-briefing.test.ts`'s
    GOLDEN_A) — the cross-language pin, §7.2 G4."""
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              request_text="Write a Strava caption for today's workout",
              result_summary="Here are three caption options for the tempo run.",
              state="done", created_at="2026-09-09T10:00:00.000Z")
    seed_task(db_path, task_id="vi-bbbbbbbbbbbb", conversation_id="vi-aaaaaaaaaaaa",
              request_text="Make it shorter", state="running",
              created_at="2026-09-09T11:00:00.000Z")
    seed_task(db_path, task_id="vi-cccccccccccc", conversation_id="vi-aaaaaaaaaaaa",
              request_text="Not Rava. Strava.", state="routed",
              created_at="2026-09-10T09:00:00.000Z")
    seed_conversation_meta(
        db_path, "vi-aaaaaaaaaaaa",
        title="Strava caption for today's workout",
        recap="Three caption drafts are on the table; the operator wants a shorter one.",
        next_action="Pick one of the three captions.",
    )
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        result = route_task.build_conversation_briefing(
            conn, TENANT_ID, "vi-aaaaaaaaaaaa", "vi-cccccccccccc",
            "C:/tmp/pa/voice-inbox/ledger.sqlite", 1200)
    finally:
        conn.close()
    assert result == GOLDEN_BRIEFING


def test_conversation_briefing_never_exceeds_max_chars(tmp_path):
    """Fixture C/D: across a wide maxChars sweep the briefing never exceeds
    the requested budget — the never-overflows guarantee, §7.2 G5."""
    db_path = make_ledger(tmp_path)
    turn_ids = [
        "vi-aaaaaaaaaaaa",
        "vi-d00000000002",
        "vi-d00000000003",
        "vi-d00000000004",
        "vi-d00000000005",
        "vi-d00000000006",
        "vi-d00000000007",
        "vi-d00000000008",
    ]
    for i, task_id in enumerate(turn_ids):
        seed_task(db_path, task_id=task_id, conversation_id="vi-aaaaaaaaaaaa",
                  request_text=f"turn {i + 1}", state="done",
                  created_at=f"2026-09-01T{i:02d}:00:00.000Z")
    seed_task(db_path, task_id="vi-cccccccccccc", conversation_id="vi-aaaaaaaaaaaa",
              request_text="the current follow-up", state="routed",
              created_at="2026-09-01T08:00:00.000Z")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        for max_chars in [0, 50, 100, 199, 200, 320, 600, 1200]:
            result = route_task.build_conversation_briefing(
                conn, TENANT_ID, "vi-aaaaaaaaaaaa", "vi-cccccccccccc",
                "C:/tmp/pa/voice-inbox/ledger.sqlite", max_chars)
            assert len(result) <= max_chars, (
                f"maxChars={max_chars} produced length {len(result)}: {result}")
    finally:
        conn.close()


def test_route_injects_the_conversation_briefing(tmp_path, monkeypatch):
    """A real route_task.py invocation against fixture A's conversation
    injects the exact GOLDEN_BRIEFING between the routing header and the
    request text — the python-side sibling of G9, and G4 exercised through
    the real CLI rather than a direct function call."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              request_text="Write a Strava caption for today's workout",
              result_summary="Here are three caption options for the tempo run.",
              state="done", created_at="2026-09-09T10:00:00.000Z")
    seed_task(db_path, task_id="vi-bbbbbbbbbbbb", conversation_id="vi-aaaaaaaaaaaa",
              request_text="Make it shorter", state="running",
              created_at="2026-09-09T11:00:00.000Z")
    seed_task(db_path, task_id="vi-cccccccccccc", conversation_id="vi-aaaaaaaaaaaa",
              request_text="Not Rava. Strava.", state="routed",
              created_at="2026-09-10T09:00:00.000Z")
    seed_conversation_meta(
        db_path, "vi-aaaaaaaaaaaa",
        title="Strava caption for today's workout",
        recap="Three caption drafts are on the table; the operator wants a shorter one.",
        next_action="Pick one of the three captions.",
    )
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", "vi-cccccccccccc", "--topic", TOPIC_KEY,
                      "--reason", "reroute for briefing", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    repo = REPO.resolve().as_posix()
    golden_briefing = GOLDEN_BRIEFING_TEMPLATE.format(ledger_path=db_path.as_posix())
    expected = EXPECTED_TARGET_TEXT.format(
        task_id="vi-cccccccccccc", reason="reroute for briefing",
        request_text="Not Rava. Strava.", repo=repo, briefing=golden_briefing,
        framing="", attachments="")
    assert entries[0]["text"] == expected


def test_steer_message_limit_matches_the_bot():
    """Cross-package pin (§7.2 G7): route_task.py's hand-copy of the bot's
    STEER_MESSAGE_MAX must move together with it."""
    source = (REPO / "projects" / "telegram-bot" / "src" / "voice-inbox-steer.ts").read_text(
        encoding="utf-8")
    match = re.search(r"export const STEER_MESSAGE_MAX = (\d+);", source)
    assert match, "STEER_MESSAGE_MAX not found in projects/telegram-bot/src/voice-inbox-steer.ts"
    assert int(match.group(1)) == route_task.STEER_MESSAGE_LIMIT, (
        "the bot's STEER_MESSAGE_MAX moved; update STEER_MESSAGE_LIMIT and ROUTE_TEXT_MAX "
        "in conversation-briefing.ts and route_task.py"
    )


def test_route_text_stays_under_the_steer_limit(tmp_path, monkeypatch):
    """G6: a real steer render stays under the bot's 4000-character
    thread-lane limit even with long prior turns (now irrelevant to briefing
    size, since the briefing is a fixed-ish-size lookup reference rather than
    an inlined dump) and a long current request — the gate a fixed-size
    fixture cannot see (§1.6)."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    conversation_id = "vi-eeeeeeeeeeee"
    for i in range(5):
        seed_task(db_path, task_id=f"vi-e0000000000{i}", conversation_id=conversation_id,
                  request_text=f"prior request {i}", result_summary="x" * 2000,
                  state="done", created_at=f"2026-09-01T0{i}:00:00.000Z")
    long_request = "y" * 1200
    seed_task(db_path, task_id="vi-eeeeeeeeeeed", conversation_id=conversation_id,
              request_text=long_request, state="received",
              created_at="2026-09-01T09:00:00.000Z")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", "vi-eeeeeeeeeeed", "--topic", TOPIC_KEY,
                      "--reason", "long content stress test", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    assert len(entries[0]["text"]) <= route_task.ROUTE_TEXT_MAX


# --- Feedback framing (schema v7, 2026-09-13) ------------------------------------


def test_route_feedback_conversation_framing(tmp_path, monkeypatch):
    """A feedback task whose feedback_about names the conversation ROOT
    renders conversation-level framing (title from conversation_meta)."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              state="done", created_at="2026-09-01T00:00:00.000Z")
    seed_task(db_path, task_id=TASK_ID, state="received",
              feedback_about="vi-aaaaaaaaaaaa")
    seed_conversation_meta(db_path, "vi-aaaaaaaaaaaa", title="Strava caption")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    framing = route_task.build_feedback_framing(
        "vi-aaaaaaaaaaaa", "Strava caption", "conversation") + " "
    # Feedback now carries the referenced conversation's briefing (a lookup
    # reference, not inlined turns) so the worker has context about what the
    # feedback is about.
    briefing = (
        "Conversation so far (vi-aaaaaaaaaaaa): 1 earlier turn(s), oldest first.\n"
        "Title: Strava caption\n"
        f"Full turn-by-turn record: sqlite3 \"{db_path.as_posix()}\" \"SELECT created_at, "
        "request_text, result_summary FROM tasks WHERE conversation_id = 'vi-aaaaaaaaaaaa' "
        "ORDER BY created_at ASC\".\n"
        "End of the conversation record.\n"
    )
    expected = EXPECTED_TARGET_TEXT.format(
        task_id=TASK_ID, reason="reports fit here", request_text=REQUEST_TEXT,
        repo=REPO.resolve().as_posix(), briefing=briefing, framing=framing, attachments="")
    assert entries[0]["text"] == expected
    assert ('(operator feedback about voice-inbox conversation vi-aaaaaaaaaaaa,'
            ' "Strava caption")') in entries[0]["text"]


def test_route_feedback_task_framing(tmp_path, monkeypatch):
    """A feedback task whose feedback_about names a MID-CONVERSATION turn
    renders task-level framing (§3 level-resolution rule)."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              state="done", created_at="2026-09-01T00:00:00.000Z")
    seed_task(db_path, task_id="vi-bbbbbbbbbbbb", conversation_id="vi-aaaaaaaaaaaa",
              state="done", created_at="2026-09-01T01:00:00.000Z")
    seed_task(db_path, task_id=TASK_ID, state="received",
              feedback_about="vi-bbbbbbbbbbbb")
    seed_conversation_meta(db_path, "vi-aaaaaaaaaaaa", title="Say \"hi\" <again>")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    framing = route_task.build_feedback_framing(
        "vi-bbbbbbbbbbbb", "Say \"hi\" <again>", "task") + " "
    # Feedback now carries the referenced conversation's briefing (a lookup
    # reference, not inlined turns) so the worker has context about what the
    # feedback is about.
    briefing = (
        "Conversation so far (vi-aaaaaaaaaaaa): 2 earlier turn(s), oldest first.\n"
        "Title: Say \"hi\" <again>\n"
        f"Full turn-by-turn record: sqlite3 \"{db_path.as_posix()}\" \"SELECT created_at, "
        "request_text, result_summary FROM tasks WHERE conversation_id = 'vi-aaaaaaaaaaaa' "
        "ORDER BY created_at ASC\".\n"
        "End of the conversation record.\n"
    )
    expected = EXPECTED_TARGET_TEXT.format(
        task_id=TASK_ID, reason="reports fit here", request_text=REQUEST_TEXT,
        repo=REPO.resolve().as_posix(), briefing=briefing, framing=framing, attachments="")
    assert entries[0]["text"] == expected
    assert ('(operator feedback about voice-inbox task vi-bbbbbbbbbbbb,'
            ' "Say \'hi\' <again>")') in entries[0]["text"]


def test_attachments_segment_twin_golden():
    assert route_task.build_attachments_segment([]) == ""
    assert route_task.build_attachments_segment(
        ["D:/pa/voice-inbox/files/vi-aaaaaaaaaaaa/shot.png",
         "D:/pa/voice-inbox/files/vi-aaaaaaaaaaaa/note.mp4"]
    ) == (
        "Attachments (2): "
        "D:/pa/voice-inbox/files/vi-aaaaaaaaaaaa/shot.png; "
        "D:/pa/voice-inbox/files/vi-aaaaaaaaaaaa/note.mp4."
        " Open them from disk when the task needs them; audio or video attachments "
        "can be transcribed with transcribe_voice.py. "
    )


def test_attachments_dir_listing_excludes_audio_and_tmp(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    task_dir = tmp_path / "voice-inbox" / "files" / "vi-aaaaaaaaaaaa"
    task_dir.mkdir(parents=True)
    (task_dir / "b.mp4").write_bytes(b"x")
    (task_dir / "a.png").write_bytes(b"x")
    (task_dir / "audio.webm").write_bytes(b"x")
    (task_dir / "tmp-partial.attach").write_bytes(b"x")
    (task_dir / "subdir").mkdir()
    paths = route_task.task_attachment_paths(str(task_dir))
    assert [p.replace("\\", "/").rsplit("/", 1)[1] for p in paths] == ["a.png", "b.mp4"]
    assert all(p.startswith(str(task_dir).replace("\\", "/")) for p in paths)


def test_attachments_dir_overflow_caps_at_ten_paths(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    task_dir = tmp_path / "voice-inbox" / "files" / "vi-aaaaaaaaaaaa"
    task_dir.mkdir(parents=True)
    for i in range(12):
        (task_dir / f"f{i:02d}.png").write_bytes(b"x")
    display = route_task.attachments_display_paths(str(task_dir))
    assert len(display) == 11
    assert display[-1] == f"… and 2 more in {str(task_dir).replace(chr(92), '/')}"
    segment = route_task.build_attachments_segment(display)
    assert segment.startswith("Attachments (11): ")
    assert segment.startswith("Attachments (11): " + "; ".join(display[:10]))
    assert segment.count("; ") == 11  # 10 join separators + "; audio" in the pinned suffix


def test_route_task_with_attachments_on_disk(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id=TASK_ID, state="received")
    seed_topics(tmp_path)
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    task_dir.mkdir(parents=True)
    (task_dir / "shot.png").write_bytes(b"x")
    (task_dir / "note.mp4").write_bytes(b"x")
    (task_dir / "audio.webm").write_bytes(b"x")
    (task_dir / "tmp-partial.attach").write_bytes(b"x")

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    seg_paths = [
        str(task_dir / "note.mp4").replace("\\", "/"),
        str(task_dir / "shot.png").replace("\\", "/"),
    ]
    expected = EXPECTED_TARGET_TEXT.format(
        task_id=TASK_ID, reason="reports fit here", request_text=REQUEST_TEXT,
        repo=REPO.resolve().as_posix(), briefing="", framing="",
        attachments=route_task.build_attachments_segment(seg_paths))
    assert entries[0]["text"] == expected
    assert "Attachments (2): " in entries[0]["text"]


def test_route_feedback_no_title(tmp_path, monkeypatch):
    """No conversation_meta row → the framing renders in the no-title form."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              state="done", created_at="2026-09-01T00:00:00.000Z")
    seed_task(db_path, task_id=TASK_ID, state="received",
              feedback_about="vi-aaaaaaaaaaaa")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    assert ("(operator feedback about voice-inbox conversation vi-aaaaaaaaaaaa) "
            "Summarize the Q3 report.") in entries[0]["text"]


def test_route_nonfeedback_has_no_framing(tmp_path, monkeypatch):
    """A normal (non-feedback) task's routed text carries NO framing at all —
    the framing slot renders '' when feedback_about is NULL."""
    make_case(tmp_path, monkeypatch)
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    entry = read_queue(tmp_path)[0]
    assert "operator feedback" not in entry["text"]


def test_feedback_bracket_regex_discriminates(tmp_path, monkeypatch):
    """Known-bad persistence (§4.8): the real framing render is never in a
    `[Voice …]` bracketed form — and the negative regex is proven to
    discriminate by feeding it the bracketed twin, which MUST match."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              state="done", created_at="2026-09-01T00:00:00.000Z")
    seed_task(db_path, task_id=TASK_ID, state="received",
              feedback_about="vi-aaaaaaaaaaaa")
    seed_conversation_meta(db_path, "vi-aaaaaaaaaaaa", title="T")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "reports fit here", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    text = read_queue(tmp_path)[0]["text"]
    paren = route_task.build_feedback_framing("vi-aaaaaaaaaaaa", "T", "conversation")
    assert paren in text
    assert re.search(r"\[Voice[^\]\n]*vi-[0-9a-f]{12}[^\]\n]*operator feedback",
                     text) is None
    bracketed = text.replace(paren, "[Voice task vi-aaaaaaaaaaaa operator feedback]")
    assert re.search(r"\[Voice[^\]\n]*vi-[0-9a-f]{12}[^\]\n]*operator feedback",
                     bracketed) is not None


def test_route_feedback_carries_referenced_conversation_briefing(tmp_path, monkeypatch):
    """Feedback about a routed conversation must carry THAT conversation's
    briefing (context) so the worker knows what the feedback is about. The
    routing topic is NOT changed — feedback can be processed in any topic
    the caller chooses. Regression pin for the 2026-09-15 stuck thread:
    'Table wasn't user friendly' feedback had no context, looping 33
    reroutes."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    # The car conversation, already routed to its own topic.
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              state="done", created_at="2026-09-01T00:00:00.000Z",
              routed_to=f"{CHAT_ID}_9999",
              result_summary="The shortlist with the table.")
    # The feedback task references it.
    seed_task(db_path, task_id=TASK_ID, state="received",
              feedback_about="vi-aaaaaaaaaaaa")
    seed_conversation_meta(db_path, "vi-aaaaaaaaaaaa", title="Used 7-seater shortlist")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "no existing topic matched by name", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    # The routing topic is the CALLER's --topic, NOT the referenced
    # conversation's topic — feedback can be processed in any topic.
    assert entries[0]["thread_id"] == THREAD_ID
    # The framing line is present (the link to the original conversation).
    assert "(operator feedback about voice-inbox conversation vi-aaaaaaaaaaaa" in entries[0]["text"]
    # The briefing is built from the REFERENCED conversation (vi-aaaaaaaaaaaa,
    # the target_conv re-pointing in route_task.py), not the feedback task's
    # own conversation_id — the regression this test protects. It now carries
    # a lookup reference rather than inlined turns; the lookup line's
    # conversation_id clause must name the referenced conversation.
    assert "Used 7-seater shortlist" in entries[0]["text"]
    assert "Conversation so far (vi-aaaaaaaaaaaa)" in entries[0]["text"]
    assert "conversation_id = 'vi-aaaaaaaaaaaa' ORDER BY created_at ASC" in entries[0]["text"]
    assert f"conversation_id = '{TASK_ID}'" not in entries[0]["text"]


def test_route_feedback_unrouted_reference_uses_caller_topic(tmp_path, monkeypatch):
    """When the referenced conversation was never routed (no routed_to), the
    feedback falls back to the caller's --topic — same behavior as today."""
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    db_path = make_ledger(tmp_path)
    seed_task(db_path, task_id="vi-aaaaaaaaaaaa", conversation_id="vi-aaaaaaaaaaaa",
              state="done", created_at="2026-09-01T00:00:00.000Z",
              routed_to=None)
    seed_task(db_path, task_id=TASK_ID, state="received",
              feedback_about="vi-aaaaaaaaaaaa")
    seed_conversation_meta(db_path, "vi-aaaaaaaaaaaa", title="Unrouted conv")
    seed_topics(tmp_path)

    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                      "--reason", "no existing topic matched by name", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr

    entries = read_queue(tmp_path)
    assert len(entries) == 1
    assert entries[0]["thread_id"] == THREAD_ID


# ---------------------------------------------------------------------------
# task_blocker_ask.py — blocker escalation (screenshot attach + question card,
# 2026-09-14). The script never opens the ledger: the copy into the task's
# files dir IS the registration (the app lists attachments from that
# directory), and the request goes through the real `task_input.py create`
# as a subprocess — the ONLY creator, its refusals relayed verbatim.
# ---------------------------------------------------------------------------


def blocker_screenshot(tmp_path: Path) -> Path:
    shot = tmp_path / "page.png"
    shot.write_bytes(b"\x89PNG-blocker-evidence")
    return shot


def test_blocker_ask_attaches_and_creates_choice(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    shot = blocker_screenshot(tmp_path)
    proc = run_script(
        "task_blocker_ask.py", "--task", TASK_ID, "--screenshot", str(shot),
        "--prompt", "The sign-in page wants a password — which account?",
        "--options", "Personal|Work", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["kind"] == "choice"
    assert payload["task_state"] == "awaiting_input"

    # The copy is the registration: stored under files/<task_id>/, blocker-
    # prefixed (never a reserved audio.*/tmp-* name), byte-identical to the
    # source screenshot.
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    stored_path = Path(payload["attachment_path"])
    assert stored_path.parent == task_dir
    assert payload["attachment"].startswith("blocker-")
    assert stored_path.read_bytes() == shot.read_bytes()

    # The request is real: the ledger row, the state move and the event were
    # all written by the child task_input.py create.
    request = fetch_one(db_path, "SELECT * FROM input_requests WHERE request_id = ?",
                        (payload["request_id"],))
    assert request["task_id"] == TASK_ID
    assert request["kind"] == "choice"
    assert json.loads(request["params_json"]) == {"options": ["Personal", "Work"]}
    assert fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?",
                     (TASK_ID,))["state"] == "awaiting_input"
    event = fetch_one(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,))
    assert event["kind"] == "task.input_needed"
    assert json.loads(event["payload_json"]) == {"request_id": payload["request_id"],
                                                 "kind": "choice"}


def test_blocker_ask_defaults_to_text_and_deconflicts(tmp_path, monkeypatch):
    """No --options -> a free-text answer field; a second ask with the same
    screenshot name de-conflicts to -2 (storedAttachmentName's loop)."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    shot = blocker_screenshot(tmp_path)
    proc = run_script("task_blocker_ask.py", "--task", TASK_ID, "--screenshot", str(shot),
                      "--prompt", "The consent dialog is up — proceed?", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    first = out_json(proc)
    assert first["kind"] == "text"
    assert first["attachment"] == "blocker-page.png"

    # The answer lands (the API's answer path, simulated) so a second ask is
    # legal from running, then the same-named screenshot is escalated again.
    conn = sqlite3.connect(db_path)
    with conn:
        conn.execute(
            "UPDATE input_requests SET status = 'answered', answer_pointer = ?, answered_at = ?"
            " WHERE request_id = ?", ("p/ath", iso_now(), first["request_id"]))
        conn.execute("UPDATE tasks SET state = 'running', updated_at = ? WHERE task_id = ?",
                     (iso_now(), TASK_ID))
    conn.close()
    proc = run_script("task_blocker_ask.py", "--task", TASK_ID, "--screenshot", str(shot),
                      "--prompt", "It is asking again — proceed?", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    second = out_json(proc)
    assert second["attachment"] == "blocker-page-2.png"
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    assert (task_dir / "blocker-page.png").exists()
    assert (task_dir / "blocker-page-2.png").exists()
    request = fetch_one(db_path, "SELECT kind, params_json FROM input_requests"
                        " WHERE request_id = ?", (second["request_id"],))
    assert request["kind"] == "text"
    assert json.loads(request["params_json"]) == {}


def test_blocker_ask_missing_screenshot_fails_clean(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_blocker_ask.py", "--task", TASK_ID,
                      "--screenshot", str(tmp_path / "nope.png"),
                      "--prompt", "p", pa_home=tmp_path)
    expect_fail(proc, "screenshot not found")
    assert not (tmp_path / "voice-inbox" / "files" / TASK_ID).exists()
    assert fetch_all(db_path, "SELECT * FROM input_requests") == []
    assert fetch_all(db_path, "SELECT * FROM events") == []


def test_blocker_ask_rejects_bad_options_before_any_side_effect(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="running")
    proc = run_script("task_blocker_ask.py", "--task", TASK_ID,
                      "--screenshot", str(tmp_path / "nope.png"),
                      "--prompt", "p", "--options", "a|b|c|d|e|f|g", pa_home=tmp_path)
    expect_fail(proc, "1..6")
    assert not (tmp_path / "voice-inbox" / "files" / TASK_ID).exists()


def test_blocker_ask_create_refusal_keeps_evidence_and_relays(tmp_path, monkeypatch):
    """A create refusal (here: wrong state) is relayed verbatim and the
    screenshot copy deliberately stays — the evidence of the blocked page."""
    db_path = make_case(tmp_path, monkeypatch, task_state="received")
    shot = blocker_screenshot(tmp_path)
    proc = run_script("task_blocker_ask.py", "--task", TASK_ID, "--screenshot", str(shot),
                      "--prompt", "p", pa_home=tmp_path)
    expect_fail(proc, "created from running")
    task_dir = tmp_path / "voice-inbox" / "files" / TASK_ID
    assert [entry.name for entry in task_dir.iterdir()] == ["blocker-page.png"]
    assert fetch_all(db_path, "SELECT * FROM input_requests") == []
    assert fetch_all(db_path, "SELECT * FROM events") == []


# ---------------------------------------------------------------------------
# task_set_message_id.py (AI-218) — records the Telegram message_id of a
# voice task's FYI reply into tasks.tg_message_id (schema v11). A plain column
# update: no state transition, no event. Best-effort: a missing task or a
# non-integer id exits non-zero with a JSON {"ok": false} line.
# ---------------------------------------------------------------------------
def test_set_message_id_writes_column_and_emits_ok(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="done")
    proc = run_script("task_set_message_id.py", "--task", TASK_ID,
                      "--message-id", "4242", pa_home=tmp_path)
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    payload = out_json(proc)
    assert payload["ok"] is True
    assert payload["task_id"] == TASK_ID
    assert payload["tg_message_id"] == 4242
    row = fetch_one(db_path, "SELECT tg_message_id, state FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert row["tg_message_id"] == 4242
    assert row["state"] == "done", "no state transition — the column update only"


def test_set_message_id_unknown_task_fails(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="done")
    proc = run_script("task_set_message_id.py", "--task", "vi-deadbeefdead",
                      "--message-id", "1", pa_home=tmp_path)
    expect_fail(proc, "task not found")


def test_set_message_id_writes_no_event(tmp_path, monkeypatch):
    """The message_id is display plumbing, not task lifecycle — no event row."""
    db_path = make_case(tmp_path, monkeypatch, task_state="running")
    before = fetch_all(db_path, "SELECT * FROM events")
    proc = run_script("task_set_message_id.py", "--task", TASK_ID,
                      "--message-id", "99", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    after = fetch_all(db_path, "SELECT * FROM events")
    assert len(after) == len(before), "no event written for a message_id update"


def test_set_message_id_is_idempotent_on_rerun(tmp_path, monkeypatch):
    db_path = make_case(tmp_path, monkeypatch, task_state="done")
    run_script("task_set_message_id.py", "--task", TASK_ID,
               "--message-id", "10", pa_home=tmp_path)
    proc = run_script("task_set_message_id.py", "--task", TASK_ID,
                      "--message-id", "20", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    row = fetch_one(db_path, "SELECT tg_message_id FROM tasks WHERE task_id = ?",
                    (TASK_ID,))
    assert row["tg_message_id"] == 20, "a re-run overwrites with the new id"


def test_set_message_id_missing_ledger_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    proc = run_script("task_set_message_id.py", "--task", TASK_ID,
                      "--message-id", "1", pa_home=tmp_path)
    expect_fail(proc, "ledger missing")


# ---------------------------------------------------------------------------
# P5: --structured per-type item fields (task_complete.py)
# ---------------------------------------------------------------------------

def test_structured_item_fields_accept():
    """The P5 conventions validate when present — permissive fields, never
    required (unknown fields still pass)."""
    ok = [
        {"type": "listing", "items": [{"name": "a", "summary": "s"}]},
        {"type": "listing", "items": [{"name": "a", "description": "d"}]},
        {"type": "guide", "items": [{"name": "s1", "done": True},
                                    {"name": "s2", "done": False}]},
        {"type": "guide", "items": [{"name": "s", "points": ["a", "b"]}]},
        {"type": "summary", "items": [{"name": "sec", "points": ["p"],
                                       "attributes": {"k": "v"}}]},
        {"type": "guide", "items": [{"name": "a", "points": []}]},
        {"type": "guide", "items": [{"name": "a", "bogus": 5}]},
    ]
    for payload in ok:
        assert _structured_error(payload) == "ok", payload


def test_structured_item_fields_reject():
    bad = [
        ({"type": "listing", "items": [{"name": "a", "summary": 5}]},
         "summary must be a string"),
        ({"type": "listing", "items": [{"name": "a", "description": ["x"]}]},
         "description must be a string"),
        ({"type": "guide", "items": [{"name": "a", "points": "nope"}]},
         "points must be an array"),
        ({"type": "guide", "items": [{"name": "a", "points": ["ok", 3]}]},
         "points[1] must be a non-empty string"),
        ({"type": "guide", "items": [{"name": "a", "points": [" "]}]},
         "points[0] must be a non-empty string"),
        ({"type": "guide", "items": [{"name": "a", "done": "yes"}]},
         "done must be a boolean"),
    ]
    for payload, fragment in bad:
        err = _structured_error(payload)
        assert fragment in str(err), (payload, err)


# ---------------------------------------------------------------------------
# task_request.py (2026-09-16)
# ---------------------------------------------------------------------------

RAW = "umm so book the uh dentist for friday"


def _transcribe_first(tmp_path: Path) -> None:
    proc = run_script("task_transcribe.py", "--task", TASK_ID, "--transcript", RAW,
                       pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr


def test_task_request_show_prints_state_transcript_and_request_text(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    _transcribe_first(tmp_path)
    proc = run_script("task_request.py", "show", "--task", TASK_ID, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload == {"ok": True, "task_id": TASK_ID, "state": "received", "source": "voice",
                        "transcript": RAW, "request_text": RAW}


def test_task_request_show_missing_task_fails(tmp_path, monkeypatch):
    make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_request.py", "show", "--task", "vi-" + "ee" * 6, pa_home=tmp_path)
    expect_fail(proc, "task not found")


def test_task_request_clean_rewrites_request_text_and_keeps_transcript_immutable(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    _transcribe_first(tmp_path)
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", "Book the dentist for Friday", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["changed"] is True
    row = fetch_one(db_path, "SELECT request_text, transcript FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert row["request_text"] == "Book the dentist for Friday"
    assert row["transcript"] == RAW


def test_task_request_clean_bumps_updated_at_and_writes_no_event(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    _transcribe_first(tmp_path)
    before = fetch_one(db_path, "SELECT updated_at FROM tasks WHERE task_id = ?", (TASK_ID,))
    before_events = len(fetch_all(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,)))
    time.sleep(0.01)
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", "Book the dentist for Friday", pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    after_events = len(fetch_all(db_path, "SELECT * FROM events WHERE task_id = ?", (TASK_ID,)))
    after = fetch_one(db_path, "SELECT updated_at FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert after_events == before_events
    assert after["updated_at"] != before["updated_at"]


def test_task_request_clean_refuses_non_received_states(tmp_path, monkeypatch):
    # (a) not yet transcribed: still sitting in transcribing
    db_path = make_voice_case(tmp_path, monkeypatch)
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", "Book the dentist for Friday", pa_home=tmp_path)
    expect_fail(proc, "valid only from received")
    row = fetch_one(db_path, "SELECT request_text FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert row["request_text"] == REQUEST_TEXT

    # (b) fresh home: transcribed then routed, so clean is refused post-routing
    fresh_home = tmp_path / "fresh"
    fresh_home.mkdir()
    monkeypatch.setenv("PA_HOME", str(fresh_home))
    fresh_db_path = make_ledger(fresh_home)
    seed_task(fresh_db_path, source="voice", state="transcribing")
    seed_topics(fresh_home)
    proc = run_script("task_transcribe.py", "--task", TASK_ID, "--transcript", RAW,
                       pa_home=fresh_home)
    assert proc.returncode == 0, proc.stderr
    proc = run_script("route_task.py", "--task", TASK_ID, "--topic", TOPIC_KEY,
                       "--reason", "fits", pa_home=fresh_home)
    assert proc.returncode == 0, proc.stderr
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", "Book the dentist for Friday", pa_home=fresh_home)
    expect_fail(proc, "valid only from received")
    row = fetch_one(fresh_db_path, "SELECT request_text FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert row["request_text"] == RAW


def test_task_request_clean_refuses_text_tasks(tmp_path, monkeypatch):
    make_case(tmp_path, monkeypatch, task_state="received")
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", "cleaned", pa_home=tmp_path)
    expect_fail(proc, "valid only for voice tasks")


def test_task_request_clean_refuses_blank_text(tmp_path, monkeypatch):
    make_voice_case(tmp_path, monkeypatch)
    _transcribe_first(tmp_path)
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", "   ", pa_home=tmp_path)
    assert proc.returncode == 2, proc.stderr
    assert "must be a non-empty string" in proc.stderr


def test_task_request_clean_refuses_growth_past_the_cap(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    _transcribe_first(tmp_path)
    text = "x" * (2 * len(RAW) + 201)
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", text, pa_home=tmp_path)
    expect_fail(proc, "cleanup must not add content")
    row = fetch_one(db_path, "SELECT request_text FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert row["request_text"] == RAW


def test_task_request_clean_unchanged_text_writes_nothing(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    _transcribe_first(tmp_path)
    before = fetch_one(db_path, "SELECT updated_at FROM tasks WHERE task_id = ?", (TASK_ID,))
    time.sleep(0.01)
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", RAW, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["changed"] is False
    after = fetch_one(db_path, "SELECT updated_at FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert after["updated_at"] == before["updated_at"]


def test_task_request_clean_accepts_a_value_starting_with_a_dash(tmp_path, monkeypatch):
    db_path = make_voice_case(tmp_path, monkeypatch)
    _transcribe_first(tmp_path)
    text = "-5 degrees is the Friday forecast"
    proc = run_script("task_request.py", "clean", "--task", TASK_ID,
                       "--text", text, pa_home=tmp_path)
    assert proc.returncode == 0, proc.stderr
    payload = out_json(proc)
    assert payload["changed"] is True
    row = fetch_one(db_path, "SELECT request_text FROM tasks WHERE task_id = ?", (TASK_ID,))
    assert row["request_text"] == text


def test_task_request_ledger_missing_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("PA_HOME", str(tmp_path))
    proc = run_script("task_request.py", "show", "--task", TASK_ID, pa_home=tmp_path)
    expect_fail(proc, "ledger missing: start the server first")
