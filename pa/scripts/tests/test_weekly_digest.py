"""
Tests for weekly_digest.py

Tests cover:
- Fixture audit jsonl + ledger → expected digest sections
- Parked skills listed
- Dedup key stable per week
"""

import json
import os
import sys
import tempfile
from datetime import datetime, timezone, timedelta

# Add pa/scripts to path for import
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PA_SCRIPTS = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, PA_SCRIPTS)

import weekly_digest


def test_read_audit_trail():
    """Test reading and filtering audit trail by date."""
    # Create a temporary audit file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        audit_path = f.name

        # Write some test entries
        now = datetime.now(timezone.utc)
        old = now - timedelta(days=10)
        recent = now - timedelta(days=2)

        entries = [
            {"ts": old.isoformat().replace("+00:00", "Z"), "action": "applied", "draft": "old-fix"},
            {"ts": recent.isoformat().replace("+00:00", "Z"), "action": "applied", "draft": "recent-fix"},
            {"ts": now.isoformat().replace("+00:00", "Z"), "action": "rejected", "draft": "rejected-proposal"},
        ]
        for entry in entries:
            f.write(json.dumps(entry) + "\n")

    try:
        # Temporarily override PA_HOME
        old_pa_home = os.environ.get("PA_HOME")
        temp_dir = os.path.dirname(audit_path)
        os.environ["PA_HOME"] = temp_dir

        # Move the audit file to the right location
        import shutil
        target_path = os.path.join(temp_dir, "self-improver-audit.jsonl")
        shutil.copy(audit_path, target_path)

        # Read last 7 days - should exclude the old entry
        result = weekly_digest.read_audit_trail(days=7)

        assert len(result) == 2, f"Expected 2 recent entries, got {len(result)}"
        actions = [e.get("action") for e in result]
        assert "applied" in actions
        assert "rejected" in actions

        # Restore env
        if old_pa_home:
            os.environ["PA_HOME"] = old_pa_home
        else:
            os.environ.pop("PA_HOME", None)

    finally:
        os.unlink(audit_path)
        if os.path.exists(target_path):
            os.unlink(target_path)


def test_group_by_action():
    """Test grouping audit entries by action."""
    entries = [
        {"action": "applied", "draft": "fix-1"},
        {"action": "rejected", "draft": "fix-2"},
        {"action": "applied", "draft": "fix-3"},
        {"action": "rolled_back", "draft": "fix-4"},
    ]

    result = weekly_digest.group_by_action(entries)

    assert "applied" in result
    assert len(result["applied"]) == 2
    assert "rejected" in result
    assert len(result["rejected"]) == 1
    assert "rolled_back" in result
    assert len(result["rolled_back"]) == 1


def test_read_maintenance_state():
    """Test reading maintenance state for skips/sheds."""
    # Create a temporary maintenance-state file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        state_path = f.name

        now = datetime.now(timezone.utc)
        recent_skip = now - timedelta(days=2)

        data = {
            "version": 1,
            "jobs": {
                "test-job-1": {
                    "lastSkipAt": recent_skip.isoformat().replace("+00:00", "Z"),
                    "lastSkipReason": "dependency-missing",
                    "consecutiveFailures": 0
                },
                "test-job-2": {
                    "lastSkipAt": "2026-01-01T00:00:00Z",
                    "lastSkipReason": "not-due",  # Should be ignored
                    "consecutiveFailures": 0
                },
                "parked-job": {
                    "consecutiveFailures": 5,  # Should appear in shed
                    "lastOutcome": "failed"
                }
            }
        }
        json.dump(data, f)

    try:
        # Temporarily override PA_HOME
        old_pa_home = os.environ.get("PA_HOME")
        temp_dir = os.path.dirname(state_path)
        os.environ["PA_HOME"] = temp_dir

        # Move the state file to the right location
        import shutil
        target_path = os.path.join(temp_dir, "maintenance-state.json")
        shutil.copy(state_path, target_path)

        result = weekly_digest.read_maintenance_state(days=7)

        assert len(result["skipped"]) == 1, f"Expected 1 skip, got {len(result['skipped'])}"
        assert result["skipped"][0]["job"] == "test-job-1"
        assert result["skipped"][0]["reason"] == "dependency-missing"

        assert len(result["shed"]) == 1, f"Expected 1 shed, got {len(result['shed'])}"
        assert result["shed"][0]["job"] == "parked-job"
        assert result["shed"][0]["consecutiveFailures"] == 5

        # Restore env
        if old_pa_home:
            os.environ["PA_HOME"] = old_pa_home
        else:
            os.environ.pop("PA_HOME", None)

    finally:
        os.unlink(state_path)
        if os.path.exists(target_path):
            os.unlink(target_path)


def test_read_parked_skills():
    """Test reading parked skills from scheduler latest.json."""
    # Create a temporary scheduler latest.json file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        latest_path = f.name

        data = {
            "version": 1,
            "jobs": {
                "healthy-skill": {
                    "consecutiveFailures": 0,
                    "lastOutcome": "ran"
                },
                "parked-skill-1": {
                    "consecutiveFailures": 3,
                    "lastOutcome": "failed"
                },
                "parked-skill-2": {
                    "consecutiveFailures": 7,
                    "lastOutcome": "failed"
                }
            }
        }
        json.dump(data, f)

    try:
        # Temporarily override PA_HOME
        old_pa_home = os.environ.get("PA_HOME")
        temp_dir = os.path.dirname(latest_path)
        os.environ["PA_HOME"] = temp_dir

        # Create scheduler directory and move the file
        scheduler_dir = os.path.join(temp_dir, "scheduler")
        os.makedirs(scheduler_dir, exist_ok=True)
        import shutil
        target_path = os.path.join(scheduler_dir, "latest.json")
        shutil.copy(latest_path, target_path)

        result = weekly_digest.read_parked_skills()

        assert len(result) == 2, f"Expected 2 parked skills, got {len(result)}"
        job_names = [item["job"] for item in result]
        assert "parked-skill-1" in job_names
        assert "parked-skill-2" in job_names
        assert "healthy-skill" not in job_names

        # Restore env
        if old_pa_home:
            os.environ["PA_HOME"] = old_pa_home
        else:
            os.environ.pop("PA_HOME", None)

    finally:
        os.unlink(latest_path)
        if os.path.exists(target_path):
            os.unlink(target_path)


def test_compose_digest():
    """Test composing the full digest."""
    audit_entries = [
        {"action": "applied", "draft": "fix-1", "target_skill": "daily-mail-brief"},
        {"action": "applied", "draft": "fix-2"},
        {"action": "rejected", "draft": "bad-proposal"},
    ]

    maintenance_summary = {
        "skipped": [
            {"job": "test-job", "reason": "missing-dep", "at": "2026-08-17T10:00:00Z"}
        ],
        "shed": []
    }

    parked_skills = [
        {"job": "broken-skill", "consecutiveFailures": 5}
    ]

    pending_conflicts = []

    result = weekly_digest.compose_digest(audit_entries, maintenance_summary, parked_skills, pending_conflicts)

    # Check that key sections are present
    assert "# Weekly Ops Digest" in result
    assert "## Self-Improver Activity" in result
    assert "## Maintenance Job Skips" in result
    assert "## Parked Skills" in result

    # Check content
    assert "Applied: 2" in result
    assert "Rejected: 1" in result
    assert "test-job" in result
    assert "missing-dep" in result
    assert "broken-skill" in result
    assert "5 consecutive failures" in result


def test_read_pending_conflicts_returns_unresolved():
    """Test reading pending conflicts filters out resolved ones."""
    # Create a temporary review-digest-pending.jsonl file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        pending_path = f.name

        # Write some test conflicts
        now = datetime.now(timezone.utc)
        recent = now - timedelta(days=2)

        conflicts = [
            {
                "id": "cf-001",
                "created_at": recent.isoformat().replace("+00:00", "Z"),
                "resolved": False,
                "resolved_at": None,
                "resolution": None,
                "key": "dietary-mushrooms",
                "new_text": "Eats mushrooms regularly now",
                "existing_text": "Avoid mushrooms completely",
                "existing_valid_from": "2026-06-15",
                "category": "preference",
                "source": "conversation",
                "source_ref": "turn-20260818-1234"
            },
            {
                "id": "cf-002",
                "created_at": recent.isoformat().replace("+00:00", "Z"),
                "resolved": False,
                "resolved_at": None,
                "resolution": None,
                "key": "fitness-running",
                "new_text": "Running paused due to injury",
                "existing_text": "Running active 3x per week",
                "existing_valid_from": "2026-07-01",
                "category": "fitness",
                "source": "conversation",
                "source_ref": "turn-20260818-5678"
            },
            {
                "id": "cf-003",
                "created_at": recent.isoformat().replace("+00:00", "Z"),
                "resolved": True,
                "resolved_at": now.isoformat().replace("+00:00", "Z"),
                "resolution": "accepted",
                "key": "resolved-conflict",
                "new_text": "Old resolved text",
                "existing_text": "Old existing text",
                "existing_valid_from": "2026-06-15",
                "category": "preference",
                "source": "conversation",
                "source_ref": "turn-20260818-9999"
            }
        ]
        for conflict in conflicts:
            f.write(json.dumps(conflict) + "\n")

    try:
        # Temporarily override PA_HOME
        old_pa_home = os.environ.get("PA_HOME")
        temp_dir = os.path.dirname(pending_path)
        os.environ["PA_HOME"] = temp_dir

        # Move the pending file to the right location
        import shutil
        target_path = os.path.join(temp_dir, "review-digest-pending.jsonl")
        shutil.copy(pending_path, target_path)

        # Read conflicts - should return only unresolved
        result = weekly_digest.read_pending_conflicts(days=7)

        assert len(result) == 2, f"Expected 2 unresolved conflicts, got {len(result)}"
        keys = [c.get("key") for c in result]
        assert "dietary-mushrooms" in keys
        assert "fitness-running" in keys
        assert "resolved-conflict" not in keys

        # Restore env
        if old_pa_home:
            os.environ["PA_HOME"] = old_pa_home
        else:
            os.environ.pop("PA_HOME", None)

    finally:
        os.unlink(pending_path)
        if os.path.exists(target_path):
            os.unlink(target_path)


def test_read_pending_conflicts_filters_by_date():
    """Test reading pending conflicts filters by date window."""
    # Create a temporary review-digest-pending.jsonl file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        pending_path = f.name

        # Write conflicts with different dates
        now = datetime.now(timezone.utc)
        recent = now - timedelta(days=2)
        old = now - timedelta(days=10)

        conflicts = [
            {
                "id": "cf-001",
                "created_at": recent.isoformat().replace("+00:00", "Z"),
                "resolved": False,
                "resolved_at": None,
                "resolution": None,
                "key": "recent-conflict",
                "new_text": "Recent conflict",
                "existing_text": "Existing text",
                "existing_valid_from": "2026-06-15",
                "category": "preference",
                "source": "conversation",
                "source_ref": "turn-recent"
            },
            {
                "id": "cf-002",
                "created_at": old.isoformat().replace("+00:00", "Z"),
                "resolved": False,
                "resolved_at": None,
                "resolution": None,
                "key": "old-conflict",
                "new_text": "Old conflict",
                "existing_text": "Existing text",
                "existing_valid_from": "2026-06-15",
                "category": "preference",
                "source": "conversation",
                "source_ref": "turn-old"
            }
        ]
        for conflict in conflicts:
            f.write(json.dumps(conflict) + "\n")

    try:
        # Temporarily override PA_HOME
        old_pa_home = os.environ.get("PA_HOME")
        temp_dir = os.path.dirname(pending_path)
        os.environ["PA_HOME"] = temp_dir

        # Move the pending file to the right location
        import shutil
        target_path = os.path.join(temp_dir, "review-digest-pending.jsonl")
        shutil.copy(pending_path, target_path)

        # Read last 7 days - should exclude the old conflict
        result = weekly_digest.read_pending_conflicts(days=7)

        assert len(result) == 1, f"Expected 1 recent conflict, got {len(result)}"
        assert result[0].get("key") == "recent-conflict"

        # Restore env
        if old_pa_home:
            os.environ["PA_HOME"] = old_pa_home
        else:
            os.environ.pop("PA_HOME", None)

    finally:
        os.unlink(pending_path)
        if os.path.exists(target_path):
            os.unlink(target_path)


def test_compose_digest_includes_conflicts_section():
    """Test that compose_digest includes conflicts section with details."""
    audit_entries = [
        {"action": "applied", "draft": "fix-1", "target_skill": "daily-mail-brief"},
    ]

    maintenance_summary = {
        "skipped": [],
        "shed": []
    }

    parked_skills = []

    pending_conflicts = [
        {
            "id": "cf-001",
            "created_at": "2026-08-17T10:00:00Z",
            "resolved": False,
            "key": "dietary-mushrooms",
            "new_text": "Eats mushrooms regularly now",
            "existing_text": "Avoid mushrooms completely",
            "category": "preference",
            "source": "conversation"
        }
    ]

    result = weekly_digest.compose_digest(audit_entries, maintenance_summary, parked_skills, pending_conflicts)

    # Check that conflicts section is present
    assert "## Memory Conflicts Pending Review" in result
    assert "dietary-mushrooms" in result
    assert "Eats mushrooms regularly now" in result
    assert "Avoid mushrooms completely" in result
    assert "preference" in result
    assert "2026-08-17T10:00:00Z" in result


def test_compose_digest_no_conflicts_shows_empty():
    """Test that compose_digest shows empty message when no conflicts."""
    audit_entries = [
        {"action": "applied", "draft": "fix-1", "target_skill": "daily-mail-brief"},
    ]

    maintenance_summary = {
        "skipped": [],
        "shed": []
    }

    parked_skills = []

    pending_conflicts = []

    result = weekly_digest.compose_digest(audit_entries, maintenance_summary, parked_skills, pending_conflicts)

    # Check that conflicts section is present with empty message
    assert "## Memory Conflicts Pending Review" in result
    assert "*No memory conflicts pending review.*" in result


def test_main_delivers_via_stdout_without_direct_telegram_dispatch():
    """Reproduces the 2026-08-17 recorded failures: main() dispatched Telegram
    directly via telegram_notify, but cmd skills run without TELEGRAM_BOT_TOKEN
    in their environment, so send_text raised 'TELEGRAM_BOT_TOKEN must be set',
    main() exited 1, and the runner's telegram_output stdout relay (which only
    fires on successful runs) never delivered anything. main() must print the
    digest to stdout and never dispatch Telegram itself."""
    import contextlib
    import io
    import telegram_notify

    with tempfile.TemporaryDirectory() as temp_dir:
        old_pa_home = os.environ.get("PA_HOME")
        old_token = os.environ.get("TELEGRAM_BOT_TOKEN")
        real_slo = weekly_digest.get_slo_summary
        real_send_text = telegram_notify.send_text
        direct_calls = []

        def tracking_send_text(*args, **kwargs):
            direct_calls.append((args, kwargs))
            return real_send_text(*args, **kwargs)

        os.environ["PA_HOME"] = temp_dir
        os.environ.pop("TELEGRAM_BOT_TOKEN", None)
        # Keep the test hermetic and fast: no real `pa slo report` subprocess.
        weekly_digest.get_slo_summary = lambda: "No data"
        telegram_notify.send_text = tracking_send_text

        stdout, stderr = io.StringIO(), io.StringIO()
        try:
            try:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    weekly_digest.main()
            except SystemExit as exc:
                raise AssertionError(
                    f"main() exited with {exc.code}; delivery must be stdout-only "
                    f"(the runner relays successful runs via telegram_output). "
                    f"stderr: {stderr.getvalue()!r}"
                )
        finally:
            weekly_digest.get_slo_summary = real_slo
            telegram_notify.send_text = real_send_text
            if old_pa_home is not None:
                os.environ["PA_HOME"] = old_pa_home
            else:
                os.environ.pop("PA_HOME", None)
            if old_token is not None:
                os.environ["TELEGRAM_BOT_TOKEN"] = old_token
            else:
                os.environ.pop("TELEGRAM_BOT_TOKEN", None)

        out = stdout.getvalue()
        err = stderr.getvalue()
        assert "# Weekly Ops Digest" in out
        assert "_Dedup: weekly-digest-" in out
        assert direct_calls == [], (
            "main() must not dispatch Telegram directly — the runner relays "
            "stdout via telegram_output"
        )
        assert "Failed to send Telegram notification" not in err


def test_get_iso_week():
    """Test ISO week format is stable."""
    # Test a known date
    dt = datetime(2026, 8, 17, 12, 0, 0, tzinfo=timezone.utc)  # 2026-08-17 is week 34
    result = weekly_digest.get_iso_week(dt)
    assert result == "2026-W34", f"Expected 2026-W34, got {result}"

    # Test that same week produces same result
    dt2 = datetime(2026, 8, 18, 15, 0, 0, tzinfo=timezone.utc)  # Still week 34
    result2 = weekly_digest.get_iso_week(dt2)
    assert result2 == result

    # Test different week produces different result
    dt3 = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)  # Week 35
    result3 = weekly_digest.get_iso_week(dt3)
    assert result3 == "2026-W35"
    assert result3 != result


if __name__ == "__main__":
    test_get_iso_week()
    print("✓ test_get_iso_week passed")

    test_group_by_action()
    print("✓ test_group_by_action passed")

    test_read_audit_trail()
    print("✓ test_read_audit_trail passed")

    test_read_maintenance_state()
    print("✓ test_read_maintenance_state passed")

    test_read_parked_skills()
    print("✓ test_read_parked_skills passed")

    test_read_pending_conflicts_returns_unresolved()
    print("✓ test_read_pending_conflicts_returns_unresolved passed")

    test_read_pending_conflicts_filters_by_date()
    print("✓ test_read_pending_conflicts_filters_by_date passed")

    test_compose_digest()
    print("✓ test_compose_digest passed")

    test_compose_digest_includes_conflicts_section()
    print("✓ test_compose_digest_includes_conflicts_section passed")

    test_compose_digest_no_conflicts_shows_empty()
    print("✓ test_compose_digest_no_conflicts_shows_empty passed")

    test_main_delivers_via_stdout_without_direct_telegram_dispatch()
    print("✓ test_main_delivers_via_stdout_without_direct_telegram_dispatch passed")

    print("\nAll tests passed!")
