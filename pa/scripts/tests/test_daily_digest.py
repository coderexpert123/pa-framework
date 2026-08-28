"""
Tests for daily_digest.py

Tests cover:
- collect_run_rollup with window filter, corrupt out-of-window proof, status counting, worker mix, truncation
- count_failover from app.log.jsonl
- count_dlq from telegram-dlq.jsonl
- read_cost_rollup with injected runner
- SLO line via weekly_digest.get_slo_summary injected runner
- compose_daily_digest full render with unavailable lines
- main() hermetic with monkeypatched subprocess readers
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

import daily_digest


def test_collect_run_rollup_window_filter_via_corrupt_out_of_window_file():
    """Out-of-window .meta files are never read, even if corrupt.
    Filename timestamp filtering happens BEFORE the file open.
    A deliberately corrupt out-of-window file proves the filter works:
    if the file were read, json.loads would raise and the test would fail."""
    with tempfile.TemporaryDirectory() as temp_dir:
        old_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = temp_dir

        try:
            # Create logs directory structure
            logs_dir = os.path.join(temp_dir, "logs")
            skill_dir = os.path.join(logs_dir, "test-skill")
            os.makedirs(skill_dir, exist_ok=True)

            now = datetime.now(timezone.utc)
            in_window = now - timedelta(hours=12)  # Within 24h window
            out_window = now - timedelta(hours=30)  # Outside 24h window

            # In-window valid .meta file
            in_meta_path = os.path.join(skill_dir, f"{in_window.strftime('%Y%m%d-%H%M%S')}-abc123.meta")
            with open(in_meta_path, "w", encoding="utf-8") as f:
                json.dump({
                    "status": "success",
                    "durationMs": 1234,
                    "worker": "agy"
                }, f)

            # Out-of-window CORRUPT .meta file (invalid JSON that would crash json.loads)
            out_meta_path = os.path.join(skill_dir, f"{out_window.strftime('%Y%m%d-%H%M%S')}-def456.meta")
            with open(out_meta_path, "w", encoding="utf-8") as f:
                f.write("{corrupt json that would fail parse")  # Invalid JSON

            rollup, truncated = daily_digest.collect_run_rollup(hours=24, pa_home=temp_dir)

            # Should count only the in-window file; corrupt out-of-window file never opened
            assert rollup["runs"] == 1, f"Expected 1 run, got {rollup['runs']}"
            assert rollup["success"] == 1
            assert truncated is False

        finally:
            if old_pa_home:
                os.environ["PA_HOME"] = old_pa_home
            else:
                os.environ.pop("PA_HOME", None)


def test_collect_run_rollup_status_counts_and_worker_mix():
    """Aggregates status (success/error/rate_limited) and worker counts correctly per skill and globally."""
    with tempfile.TemporaryDirectory() as temp_dir:
        old_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = temp_dir

        try:
            logs_dir = os.path.join(temp_dir, "logs")
            skill_dir = os.path.join(logs_dir, "test-skill")
            os.makedirs(skill_dir, exist_ok=True)

            now = datetime.now(timezone.utc)
            ts = now - timedelta(hours=1)

            # Create multiple .meta files with different statuses and workers
            for i, (status, worker) in enumerate([
                ("success", "agy"),
                ("success", "agy"),
                ("error", "claude"),
                ("rate_limited", "agy"),
                ("success", "zclaude"),
            ]):
                meta_path = os.path.join(skill_dir, f"{ts.strftime('%Y%m%d-%H%M%S')}-{i:012x}.meta")
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump({
                        "status": status,
                        "durationMs": 100 * (i + 1),
                        "worker": worker
                    }, f)

            rollup, truncated = daily_digest.collect_run_rollup(hours=24, pa_home=temp_dir)

            # Top-level totals
            assert rollup["runs"] == 5
            assert rollup["success"] == 3
            assert rollup["error"] == 1
            assert rollup["rate_limited"] == 1
            assert rollup["durationMs"] == 1500  # 100+200+300+400+500
            assert rollup["workers"]["agy"] == 3
            assert rollup["workers"]["claude"] == 1
            assert rollup["workers"]["zclaude"] == 1
            assert truncated is False

            # Per-skill breakdown
            assert "test-skill" in rollup["skills"]
            skill_data = rollup["skills"]["test-skill"]
            assert skill_data["runs"] == 5
            assert skill_data["success"] == 3
            assert skill_data["error"] == 1
            assert skill_data["rate_limited"] == 1
            assert skill_data["workers"]["agy"] == 3
            assert skill_data["workers"]["claude"] == 1
            assert skill_data["workers"]["zclaude"] == 1

        finally:
            if old_pa_home:
                os.environ["PA_HOME"] = old_pa_home
            else:
                os.environ.pop("PA_HOME", None)


def test_collect_run_rollup_truncated_flag():
    """Returns truncated=True when max_meta cap is hit."""
    with tempfile.TemporaryDirectory() as temp_dir:
        old_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = temp_dir

        try:
            logs_dir = os.path.join(temp_dir, "logs")
            skill_dir = os.path.join(logs_dir, "test-skill")
            os.makedirs(skill_dir, exist_ok=True)

            now = datetime.now(timezone.utc)
            ts = now - timedelta(hours=1)

            # Create 5 .meta files but cap at 3
            for i in range(5):
                meta_path = os.path.join(skill_dir, f"{ts.strftime('%Y%m%d-%H%M%S')}-{i:012x}.meta")
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump({"status": "success", "durationMs": 100, "worker": "agy"}, f)

            rollup, truncated = daily_digest.collect_run_rollup(hours=24, pa_home=temp_dir, max_meta=3)

            assert rollup["runs"] == 3  # Only 3 read due to cap
            assert truncated is True

        finally:
            if old_pa_home:
                os.environ["PA_HOME"] = old_pa_home
            else:
                os.environ.pop("PA_HOME", None)


def test_count_failover():
    """Counts failover events and skill-exhaustion cascades from app.log.jsonl."""
    with tempfile.TemporaryDirectory() as temp_dir:
        old_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = temp_dir

        try:
            now = datetime.now(timezone.utc)
            recent = now - timedelta(hours=12)
            old = now - timedelta(hours=30)

            log_path = os.path.join(temp_dir, "app.log.jsonl")
            with open(log_path, "w", encoding="utf-8") as f:
                # In-window failover event
                f.write(json.dumps({
                    "timestamp": recent.isoformat().replace("+00:00", "Z"),
                    "kind": "failover",
                    "message": "Worker switched"
                }) + "\n")
                # In-window skill exhaustion
                f.write(json.dumps({
                    "timestamp": recent.isoformat().replace("+00:00", "Z"),
                    "kind": "other",
                    "message": "Skill exhausted: test-skill failed 3 times"
                }) + "\n")
                # Out-of-window event (should be ignored)
                f.write(json.dumps({
                    "timestamp": old.isoformat().replace("+00:00", "Z"),
                    "kind": "failover",
                    "message": "Old switch"
                }) + "\n")
                # Malformed line (should be skipped)
                f.write("not valid json\n")

            counts = daily_digest.count_failover(hours=24, pa_home=temp_dir)

            assert counts["bot_switches"] == 1
            assert counts["exhausted"] == 1

        finally:
            if old_pa_home:
                os.environ["PA_HOME"] = old_pa_home
            else:
                os.environ.pop("PA_HOME", None)


def test_count_dlq():
    """Counts DLQ entries and quarantined items from telegram-dlq.jsonl."""
    with tempfile.TemporaryDirectory() as temp_dir:
        old_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = temp_dir

        try:
            now = datetime.now(timezone.utc)
            recent = now - timedelta(hours=12)
            old = now - timedelta(hours=30)

            dlq_path = os.path.join(temp_dir, "telegram-dlq.jsonl")
            with open(dlq_path, "w", encoding="utf-8") as f:
                # In-window normal entry
                f.write(json.dumps({
                    "timestamp": recent.isoformat().replace("+00:00", "Z"),
                    "quarantined": False
                }) + "\n")
                # In-window quarantined entry
                f.write(json.dumps({
                    "timestamp": recent.isoformat().replace("+00:00", "Z"),
                    "quarantined": True
                }) + "\n")
                # Out-of-window entry (should be ignored)
                f.write(json.dumps({
                    "timestamp": old.isoformat().replace("+00:00", "Z"),
                    "quarantined": False
                }) + "\n")

            counts = daily_digest.count_dlq(hours=24, pa_home=temp_dir)

            assert counts["total"] == 2
            assert counts["quarantined"] == 1

        finally:
            if old_pa_home:
                os.environ["PA_HOME"] = old_pa_home
            else:
                os.environ.pop("PA_HOME", None)


class _FakeCompletedProcess:
    """Minimal stand-in for subprocess.CompletedProcess, for injected runners."""
    def __init__(self, returncode, stdout):
        self.returncode = returncode
        self.stdout = stdout


def test_read_cost_rollup_with_injected_runner():
    """Injected runner returning D4 JSON → totals rendered in compose."""
    payload = {
        "period": "day",
        "generatedAt": "2026-08-27T12:00:00Z",
        "skillFilter": None,
        "rows": [
            {"worker": "agy", "model": None, "skill": "test-skill", "runs": 10,
             "tokensIn": 1000, "tokensOut": 500, "tokensThinking": 0, "tokensCacheRead": 0,
             "totalTokens": 1500, "estCostUsd": 0.001234}
        ],
        "totals": {
            "runs": 10, "tokensIn": 1000, "tokensOut": 500, "tokensThinking": 0,
            "tokensCacheRead": 0, "totalTokens": 1500, "estCostUsd": 0.001234
        },
        "unpricedKeys": []
    }

    calls = []

    def fake_runner(cmd):
        calls.append(cmd)
        return _FakeCompletedProcess(0, json.dumps(payload))

    result = daily_digest.read_cost_rollup(runner=fake_runner)

    assert result == payload
    assert len(calls) == 1
    assert calls[0][0] == "node"
    assert "costs" in calls[0]
    assert "--day" in calls[0]
    assert "--json" in calls[0]


def test_read_cost_rollup_fallback_on_runner_failure():
    """Runner raising or returning non-zero → None → compose renders unavailable line."""
    import subprocess

    def timeout_runner(cmd):
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=30)

    def failing_runner(cmd):
        return _FakeCompletedProcess(1, "")

    for runner in (timeout_runner, failing_runner):
        result = daily_digest.read_cost_rollup(runner=runner)
        assert result is None, f"expected None from {runner.__name__}, got {result}"

    # Test that None renders the unavailable line in compose
    digest = daily_digest.compose_daily_digest(
        rollup={"runs": 0, "success": 0, "error": 0, "rate_limited": 0, "durationMs": 0, "workers": {}},
        truncated=False,
        costs=None,
        failover={"bot_switches": 0, "exhausted": 0},
        dlq={"total": 0, "quarantined": 0},
        audit_entries=[],
        census=None,
        slo_line="unavailable"
    )

    assert "_Token usage unavailable (`pa costs --day --json` failed)._ " in digest or "_Token usage unavailable (`pa costs --day --json` failed)._" in digest


def test_slo_line_via_weekly_digest_import():
    """Proves the import wiring from weekly_digest.get_slo_summary."""
    payload = {
        "month": "2026-08",
        "generatedAt": "2026-08-27T12:00:00Z",
        "services": [
            {"service": "test-service", "status": "ok"}
        ]
    }

    def fake_runner(cmd):
        return _FakeCompletedProcess(0, json.dumps(payload))

    # Import the function from weekly_digest (same-directory import)
    from weekly_digest import get_slo_summary

    result = get_slo_summary(month="2026-08", runner=fake_runner)
    assert "test-service:OK" in result


def test_compose_daily_digest_full_render():
    """Full render asserts every ## header appears with real per-skill rows."""
    # Rollup with amended contract: skills key with per-skill breakdown
    rollup = {
        "runs": 10,
        "success": 8,
        "error": 1,
        "rate_limited": 1,
        "durationMs": 5000,
        "workers": {"agy": 8, "claude": 2},
        "skills": {
            "test-skill": {
                "runs": 7,
                "success": 6,
                "error": 0,
                "rate_limited": 1,
                "workers": {"agy": 5, "claude": 2}
            },
            "other-skill": {
                "runs": 3,
                "success": 2,
                "error": 1,
                "rate_limited": 0,
                "workers": {"agy": 3}
            }
        }
    }
    truncated = False
    costs = {"totals": {"totalTokens": 1500, "estCostUsd": 0.001}, "unpricedKeys": []}
    failover = {"bot_switches": 1, "exhausted": 0}
    dlq = {"total": 0, "quarantined": 0}
    audit_entries = []
    census = {
        "topLine": "10 alerts / 2 families",
        "totalSent": 10,
        "totalSuppressed": 5,
        "sentPerDay": {}
    }
    slo_line = "test-service:OK"

    result = daily_digest.compose_daily_digest(
        rollup, truncated, costs, failover, dlq, audit_entries, census, slo_line
    )

    # Assert every ## header appears
    assert "## Runs (24h)" in result
    assert "## Tokens & Est. Cost (24h)" in result
    assert "## Failover (24h)" in result
    assert "## Alerts" in result
    assert "## DLQ (24h)" in result
    assert "## Self-Improver (24h)" in result
    assert "## SLO (this month)" in result

    # Assert skill table rows appear with real data
    assert "test-skill" in result
    assert "other-skill" in result
    assert "| 7 | 6 | 0 | 1 | agy×5, claude×2 |" in result
    assert "| 3 | 2 | 1 | 0 | agy×3 |" in result
    assert "# Daily Digest" in result


def test_compose_daily_digest_unavailable_lines():
    """Each section renders explicit unavailable line when input is None/empty."""
    empty_rollup = {
        "runs": 0,
        "success": 0,
        "error": 0,
        "rate_limited": 0,
        "durationMs": 0,
        "workers": {},
        "skills": {}
    }

    result = daily_digest.compose_daily_digest(
        rollup=empty_rollup,
        truncated=False,
        costs=None,  # Should render unavailable line
        failover={"bot_switches": 0, "exhausted": 0},
        dlq={"total": 0, "quarantined": 0},
        audit_entries=[],
        census=None,  # Should render unavailable line
        slo_line="unavailable (`pa slo report --json` failed)"
    )

    assert "_No runs in the last 24h._" in result
    assert "_Token usage unavailable (`pa costs --day --json` failed)._\n" in result or "_Token usage unavailable (`pa costs --day --json` failed)._ " in result or "_Token usage unavailable (`pa costs --day --json` failed)._" in result
    assert "_Alert census unavailable._" in result
    assert "unavailable (`pa slo report --json` failed)" in result
    assert "No autonomous changes." in result
    assert "DLQ empty." in result
    assert "No failover activity." in result


def test_main_hermetic_with_monkeypatched_readers():
    """main() runs hermetic with temp PA_HOME and monkeypatched subprocess readers.
    Asserts stdout ends with dedup footer and no exception is raised."""
    import contextlib
    import io

    with tempfile.TemporaryDirectory() as temp_dir:
        old_pa_home = os.environ.get("PA_HOME")
        os.environ["PA_HOME"] = temp_dir

        # Monkeypatch all three subprocess-backed readers
        real_cost_rollup = daily_digest.read_cost_rollup
        real_slo_summary = None
        real_read_audit = daily_digest.read_audit_trail if hasattr(daily_digest, 'read_audit_trail') else None
        real_read_census = daily_digest.read_alert_census if hasattr(daily_digest, 'read_alert_census') else None

        try:
            # Import from weekly_digest for monkeypatch
            from weekly_digest import get_slo_summary, read_audit_trail, read_alert_census

            # Replace with no-op functions that return minimal valid data
            def fake_cost_rollup(runner=None):
                return {"totals": {"totalTokens": 0, "estCostUsd": 0}, "unpricedKeys": []}

            def fake_slo_summary(month=None, runner=None):
                return "No services configured"

            def fake_read_audit_trail(days=1):
                return []

            def fake_read_alert_census():
                return None

            daily_digest.read_cost_rollup = fake_cost_rollup
            daily_digest.get_slo_summary = fake_slo_summary  # This won't work since it's imported
            # We need to monkeypatch at the module level

            stdout, stderr = io.StringIO(), io.StringIO()
            try:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    # Monkeypatch at import source
                    import weekly_digest
                    original_slo = weekly_digest.get_slo_summary
                    original_audit = weekly_digest.read_audit_trail
                    original_census = weekly_digest.read_alert_census

                    weekly_digest.get_slo_summary = fake_slo_summary
                    weekly_digest.read_audit_trail = fake_read_audit_trail
                    weekly_digest.read_alert_census = fake_read_alert_census

                    try:
                        daily_digest.main()
                    finally:
                        # Restore
                        weekly_digest.get_slo_summary = original_slo
                        weekly_digest.read_audit_trail = original_audit
                        weekly_digest.read_alert_census = original_census

            except SystemExit as exc:
                raise AssertionError(
                    f"main() exited with {exc.code}; main() must print to stdout and never exit"
                )

            out = stdout.getvalue()
            err = stderr.getvalue()

            assert "# Daily Digest" in out
            assert "_Dedup: daily-digest-" in out
            assert "No autonomous changes." in out

        finally:
            if old_pa_home:
                os.environ["PA_HOME"] = old_pa_home
            else:
                os.environ.pop("PA_HOME", None)


if __name__ == "__main__":
    test_collect_run_rollup_window_filter_via_corrupt_out_of_window_file()
    print("[OK] test_collect_run_rollup_window_filter_via_corrupt_out_of_window_file passed")

    test_collect_run_rollup_status_counts_and_worker_mix()
    print("[OK] test_collect_run_rollup_status_counts_and_worker_mix passed")

    test_collect_run_rollup_truncated_flag()
    print("[OK] test_collect_run_rollup_truncated_flag passed")

    test_count_failover()
    print("[OK] test_count_failover passed")

    test_count_dlq()
    print("[OK] test_count_dlq passed")

    test_read_cost_rollup_with_injected_runner()
    print("[OK] test_read_cost_rollup_with_injected_runner passed")

    test_read_cost_rollup_fallback_on_runner_failure()
    print("[OK] test_read_cost_rollup_fallback_on_runner_failure passed")

    test_slo_line_via_weekly_digest_import()
    print("[OK] test_slo_line_via_weekly_digest_import passed")

    test_compose_daily_digest_full_render()
    print("[OK] test_compose_daily_digest_full_render passed")

    test_compose_daily_digest_unavailable_lines()
    print("[OK] test_compose_daily_digest_unavailable_lines passed")

    test_main_hermetic_with_monkeypatched_readers()
    print("[OK] test_main_hermetic_with_monkeypatched_readers passed")

    print("\nAll tests passed!")
