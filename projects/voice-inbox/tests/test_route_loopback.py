#!/usr/bin/env python3
"""Routed-ask loopback (2026-09-14): the route stage leaves the task open.

The operator bug this pins: the inbox route worker used to close the task it
had just routed with a routing receipt ("Routed and verified..."), so the
destination topic's later completion was refused (``done -> done``) and the
operator's conversation ended with routing meta instead of the answer.

The contract, end to end through the REAL scripts against the REAL extracted
TS schema:

  route_task.py leaves the task ``routed`` with NO result summary, and the
  destination stage's task_complete.py — the only sanctioned closer — closes
  that same row from ``routed`` with the actual answer.

Fixtures are reused from ``test_worker_scripts`` (same suite conventions:
isolated per-test PA_HOME, PA_NOTIFY_DISABLED=1, real producer output).
"""

from __future__ import annotations

import pytest

import test_worker_scripts as tws

ANSWER = "The Q3 report shows revenue up 12% over Q2, led by the services line."
SHORT = "Revenue grew 12% from last quarter, mostly from services."


def test_route_leaves_task_open_and_destination_completion_closes_it(tmp_path, monkeypatch):
    """route → routed (no summary); task_complete from routed → done (the answer)."""
    db_path = tws.make_case(tmp_path, monkeypatch)

    routed = tws.run_script(
        "route_task.py", "--task", tws.TASK_ID, "--topic", tws.TOPIC_KEY,
        "--reason", "reports fit here", pa_home=tmp_path,
    )
    assert routed.returncode == 0, routed.stderr
    payload = tws.out_json(routed)
    assert payload["state"] == "routed"

    task = tws.fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (tws.TASK_ID,))
    assert task["state"] == "routed", "the route stage left the task open"
    assert task["result_summary"] is None, "a route is never an answer — no summary yet"
    assert task["routed_to"] == tws.TOPIC_KEY

    done = tws.run_script(
        "task_complete.py", "--task", tws.TASK_ID,
        "--summary", ANSWER, "--short", SHORT, pa_home=tmp_path,
    )
    assert done.returncode == 0, done.stderr
    assert tws.out_json(done)["state"] == "done"

    task = tws.fetch_one(db_path, "SELECT * FROM tasks WHERE task_id = ?", (tws.TASK_ID,))
    assert task["state"] == "done"
    assert task["result_summary"] == ANSWER, "the destination's answer is what the operator reads"
    assert task["result_short"] == SHORT

    events = tws.fetch_all(
        db_path, "SELECT kind FROM events WHERE task_id = ? ORDER BY ts", (tws.TASK_ID,))
    assert [e["kind"] for e in events] == ["task.routed", "task.completed"]

    # The route queue carried exactly the destination injection; completion
    # writes nothing to it.
    assert len(tws.read_queue(tmp_path)) == 1


def test_early_close_by_the_route_stage_would_block_the_answer(tmp_path, monkeypatch):
    """The old bug, pinned as the refusal it now is: a route-stage receipt
    close moves the row to ``done``, so the destination's completion is
    refused and the receipt — not the answer — is what the card keeps."""
    db_path = tws.make_case(tmp_path, monkeypatch)

    assert tws.run_script(
        "route_task.py", "--task", tws.TASK_ID, "--topic", tws.TOPIC_KEY,
        "--reason", "reports fit here", pa_home=tmp_path,
    ).returncode == 0

    receipt = "Routed and verified."
    # The receipt shape task_complete.py refuses outright (2026-09-14 guard):
    # a route-stage close has to dress up as an outcome to land at all.
    dressed = (f"{receipt} The operator should watch the other topic for the answer.")
    closed = tws.run_script(
        "task_complete.py", "--task", tws.TASK_ID, "--summary", dressed, pa_home=tmp_path,
    )
    assert closed.returncode == 0, closed.stderr

    blocked = tws.run_script(
        "task_complete.py", "--task", tws.TASK_ID,
        "--summary", ANSWER, "--short", SHORT, pa_home=tmp_path,
    )
    tws.expect_fail(blocked, "illegal task state transition")
    task = tws.fetch_one(db_path, "SELECT state, result_summary FROM tasks WHERE task_id = ?",
                         (tws.TASK_ID,))
    assert task["state"] == "done"
    assert ANSWER not in (task["result_summary"] or "")
    assert task["result_summary"].startswith(receipt), (
        "the card is stuck with the receipt — exactly why the route stage must not close")


def test_pure_receipt_summary_from_routed_is_refused_outright(tmp_path, monkeypatch):
    """task_complete.py's receipt guard fires from the routed state too —
    the route stage cannot even close with the bare command receipt."""
    db_path = tws.make_case(tmp_path, monkeypatch)
    assert tws.run_script(
        "route_task.py", "--task", tws.TASK_ID, "--topic", tws.TOPIC_KEY,
        "--reason", "r", pa_home=tmp_path,
    ).returncode == 0
    receipt = ('Routed and verified. **Command output** (exit 0): ```json {"ok": true}```')
    refused = tws.run_script(
        "task_complete.py", "--task", tws.TASK_ID, "--summary", receipt, pa_home=tmp_path,
    )
    # parser.error exit shape (argparse refusals exit 2, not fail()'s 1).
    assert refused.returncode == 2, refused.stdout + refused.stderr
    assert "reads like a routing receipt" in (refused.stdout or "") + (refused.stderr or "")
    task = tws.fetch_one(db_path, "SELECT state FROM tasks WHERE task_id = ?", (tws.TASK_ID,))
    assert task["state"] == "routed", "the refusal leaves the task open for the destination"
