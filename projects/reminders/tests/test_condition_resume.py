"""
Unit tests for projects/reminders/condition_resume.py — the "wait for a
condition, then run an action" wrapper around add_reminder.py's
--resume-action-json / topic_resume mechanism.
"""
import json
import os
import sys
import tempfile

import pytest

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

import add_reminder
import condition_resume


@pytest.fixture
def temp_pa_home(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        monkeypatch.setenv("PA_HOME", tmpdir)
        monkeypatch.setattr(add_reminder, "pa_home", tmpdir)
        monkeypatch.setattr(add_reminder, "REMINDERS_FILE", os.path.join(tmpdir, "reminders.json"))
        monkeypatch.setattr(condition_resume, "pa_home", tmpdir)
        monkeypatch.setattr(condition_resume, "STATE_DIR", os.path.join(tmpdir, "condition-resume"))
        yield tmpdir


def _arm_args(**overrides):
    parser = condition_resume.build_parser()
    defaults = [
        "arm",
        "--chat-id", "-1001234567890",
        "--thread-id", "310",
        "--label", "voice-inbox-scroll-fix",
        "--condition", "pa claims shows app.js as free",
        "--action", "add scroll restoration to app.js",
    ]
    argv = defaults[:1]
    kv = {
        "--chat-id": overrides.pop("chat_id", "-1001234567890"),
        "--thread-id": overrides.pop("thread_id", "310"),
        "--label": overrides.pop("label", "voice-inbox-scroll-fix"),
        "--condition": overrides.pop("condition", "pa claims shows app.js as free"),
        "--action": overrides.pop("action", "add scroll restoration to app.js"),
    }
    for flag, val in kv.items():
        argv += [flag, str(val)]
    for flag, val in overrides.items():
        argv += [f"--{flag.replace('_', '-')}", str(val)]
    return parser.parse_args(argv)


def _reminders(tmpdir):
    with open(os.path.join(tmpdir, "reminders.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def _state(tmpdir, cr_id):
    with open(os.path.join(tmpdir, "condition-resume", f"{cr_id}.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def test_arm_creates_state_and_mints_reminder(temp_pa_home, capsys):
    args = _arm_args()
    condition_resume.cmd_arm(args)

    out = capsys.readouterr().out
    assert "SUCCESS: armed cr-" in out
    cr_id = out.split("armed ")[1].split(" ")[0]

    state = _state(temp_pa_home, cr_id)
    assert state["label"] == "voice-inbox-scroll-fix"
    assert state["condition"] == "pa claims shows app.js as free"
    assert state["action"] == "add scroll restoration to app.js"
    assert state["attempt"] == 1
    assert state["max_attempts"] == 6
    assert state["status"] == "active"

    reminders = _reminders(temp_pa_home)
    assert len(reminders) == 1
    r = reminders[0]
    assert r["chat_id"] == "-1001234567890"
    assert r["thread_id"] == 310
    assert r["resume_action"]["type"] == "topic_resume"
    assert cr_id in r["resume_action"]["prompt"]
    assert r["message"] != r["resume_action"]["prompt"]


def test_resume_prompt_is_short_regardless_of_condition_length(temp_pa_home, capsys):
    # The prompt embedded in the reminder must always satisfy
    # add_reminder's topic_resume validator (<=500 chars, single line, no
    # leading "/") — it never grows with caller-supplied text since it only
    # references the state-file id, not the condition/action text itself.
    args = _arm_args(condition="x" * 2000, action="y" * 2000, label="z" * 200)
    condition_resume.cmd_arm(args)  # would sys.exit(1) via add_reminder if the prompt were rejected

    reminders = _reminders(temp_pa_home)
    prompt = reminders[0]["resume_action"]["prompt"]
    assert len(prompt) <= 500
    assert "\n" not in prompt and "\r" not in prompt
    assert not prompt.lstrip().startswith("/")


def test_check_prints_condition_and_action_and_does_not_mutate_attempt(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args())
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]

    condition_resume.cmd_check(condition_resume.build_parser().parse_args(["check", "--id", cr_id]))
    out = capsys.readouterr().out

    assert "pa claims shows app.js as free" in out
    assert "add scroll restoration to app.js" in out
    assert "attempt=1/6" in out
    assert f"rearm --id {cr_id}" in out
    assert "resolve --id" in out

    state = _state(temp_pa_home, cr_id)
    assert state["attempt"] == 1  # check is read-only w.r.t. attempt count
    assert any(h["event"] == "checked" for h in state["history"])


def test_check_last_attempt_only_offers_resolve_not_rearm(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args(max_attempts=1))
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]

    condition_resume.cmd_check(condition_resume.build_parser().parse_args(["check", "--id", cr_id]))
    out = capsys.readouterr().out
    assert "rearm --id" not in out
    assert "resolve --id" in out
    assert "exhausted" in out


def test_check_on_resolved_entry_is_a_noop(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args())
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]
    condition_resume.cmd_resolve(condition_resume.build_parser().parse_args(
        ["resolve", "--id", cr_id, "--outcome", "met", "--note", "done"]))
    capsys.readouterr()

    condition_resume.cmd_check(condition_resume.build_parser().parse_args(["check", "--id", cr_id]))
    out = capsys.readouterr().out
    assert "already resolved" in out
    assert "status='met'" in out


def test_rearm_increments_attempt_and_mints_a_new_reminder(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args())
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]

    condition_resume.cmd_rearm(condition_resume.build_parser().parse_args(["rearm", "--id", cr_id]))
    out = capsys.readouterr().out
    assert f"rearmed {cr_id}" in out
    assert "attempt 2/6" in out

    state = _state(temp_pa_home, cr_id)
    assert state["attempt"] == 2
    assert any(h["event"] == "rearmed" and h["attempt"] == 2 for h in state["history"])

    reminders = _reminders(temp_pa_home)
    assert len(reminders) == 2  # the original arm mint + the rearm mint
    assert cr_id in reminders[1]["resume_action"]["prompt"]


def test_rearm_refuses_once_max_attempts_reached(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args(max_attempts=1))
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]

    with pytest.raises(SystemExit) as exc:
        condition_resume.cmd_rearm(condition_resume.build_parser().parse_args(["rearm", "--id", cr_id]))
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "used all 1 attempts" in err
    assert "resolve --outcome exhausted" in err

    # No second reminder was minted by the refused rearm.
    assert len(_reminders(temp_pa_home)) == 1


def test_rearm_refuses_on_already_resolved_entry(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args())
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]
    condition_resume.cmd_resolve(condition_resume.build_parser().parse_args(
        ["resolve", "--id", cr_id, "--outcome", "cancelled", "--note", ""]))
    capsys.readouterr()

    with pytest.raises(SystemExit) as exc:
        condition_resume.cmd_rearm(condition_resume.build_parser().parse_args(["rearm", "--id", cr_id]))
    assert exc.value.code == 1
    assert "already resolved" in capsys.readouterr().err


def test_resolve_sets_status_and_note(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args())
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]

    condition_resume.cmd_resolve(condition_resume.build_parser().parse_args(
        ["resolve", "--id", cr_id, "--outcome", "met", "--note", "app.js was free, fix applied"]))
    out = capsys.readouterr().out
    assert f"{cr_id} resolved as 'met'" in out

    state = _state(temp_pa_home, cr_id)
    assert state["status"] == "met"
    assert state["resolution_note"] == "app.js was free, fix applied"
    assert state["resolved_at"]


def test_list_reports_no_entries_before_anything_armed(temp_pa_home, capsys):
    condition_resume.cmd_list(condition_resume.build_parser().parse_args(["list"]))
    out = capsys.readouterr().out
    assert "No condition-resume" in out


def test_list_shows_armed_entries(temp_pa_home, capsys):
    condition_resume.cmd_arm(_arm_args(label="fix-a"))
    cr_id_a = capsys.readouterr().out.split("armed ")[1].split(" ")[0]
    condition_resume.cmd_arm(_arm_args(label="fix-b"))
    capsys.readouterr()

    condition_resume.cmd_list(condition_resume.build_parser().parse_args(["list"]))
    out = capsys.readouterr().out
    assert "fix-a" in out
    assert "fix-b" in out
    assert cr_id_a in out


def test_check_on_unknown_id_exits_1(temp_pa_home, capsys):
    with pytest.raises(SystemExit) as exc:
        condition_resume.cmd_check(condition_resume.build_parser().parse_args(["check", "--id", "cr-doesnotexist"]))
    assert exc.value.code == 1
    assert "no condition-resume state" in capsys.readouterr().err


def test_arm_rejects_zero_max_attempts(temp_pa_home, capsys):
    with pytest.raises(SystemExit) as exc:
        condition_resume.cmd_arm(_arm_args(max_attempts=0))
    assert exc.value.code == 1
    assert "--max-attempts must be >= 1" in capsys.readouterr().err


def test_arm_leaves_no_state_when_the_mint_raises_reminder_store_busy(temp_pa_home, monkeypatch):
    # E-A2 (catchup-lane-wedge amendment, 2026-09-16): cmd_arm must mint the
    # reminder BEFORE saving state, so a busy store never leaves an "armed"
    # state file with no reminder behind it. The REAL add_reminder.add_reminder
    # turns ReminderStoreBusy into `print(...); sys.exit(1)` (E-A4, 2026-09-16)
    # rather than letting the exception propagate, so the mint failure this
    # test forces must match that: SystemExit(1), not ReminderStoreBusy.
    def _busy(*args, **kwargs):
        raise SystemExit(1)

    monkeypatch.setattr(add_reminder, "add_reminder", _busy)

    with pytest.raises(SystemExit) as exc:
        condition_resume.cmd_arm(_arm_args())
    assert exc.value.code == 1

    state_dir = os.path.join(temp_pa_home, "condition-resume")
    assert not os.path.isdir(state_dir) or os.listdir(state_dir) == []


def test_rearm_leaves_state_unchanged_when_the_mint_raises_reminder_store_busy(temp_pa_home, capsys, monkeypatch):
    # E-A2: same ordering requirement for cmd_rearm — a busy store on rearm
    # must not persist the incremented attempt count. See the arm test above
    # for why SystemExit(1) rather than ReminderStoreBusy is forced here.
    condition_resume.cmd_arm(_arm_args())
    cr_id = capsys.readouterr().out.split("armed ")[1].split(" ")[0]
    state_before = _state(temp_pa_home, cr_id)

    def _busy(*args, **kwargs):
        raise SystemExit(1)

    monkeypatch.setattr(add_reminder, "add_reminder", _busy)

    with pytest.raises(SystemExit) as exc:
        condition_resume.cmd_rearm(condition_resume.build_parser().parse_args(["rearm", "--id", cr_id]))
    assert exc.value.code == 1

    state_after = _state(temp_pa_home, cr_id)
    assert state_after == state_before
    assert state_after["attempt"] == 1
