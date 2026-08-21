"""
Weekly Operations Digest

Composes a weekly digest from three sources:
1. ~/.pa/self-improver-audit.jsonl — terminal decisions in the last 7 days grouped by action with counts
2. ~/.pa/maintenance-state.json — skip/shed entries in the last 7 days
3. Parked skills (from scheduler's latest.json consecutiveFailures > 0)

Outputs plain markdown to stdout; the pa runner relays it to pa-alerts via the
skill's telegram_output (token resolved runner-side). Direct telegram_notify
dispatch was removed 2026-08-19: cmd skills run without TELEGRAM_BOT_TOKEN in
their environment, so every direct send raised and exited 1, which also blocked
the runner's success-only stdout relay (4 recorded failures 2026-08-17).
Dedup key: weekly-digest-<iso-week>

Deterministic — NO LLM.
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta

# Add pa/src to path for telegram_notify import
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PA_SRC = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "src"))
sys.path.insert(0, PA_SRC)


def _pa_home() -> str:
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def get_iso_week(dt: datetime) -> str:
    """Get ISO week string in YYYY-Www format."""
    iso = dt.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def read_audit_trail(days: int = 7) -> list:
    """
    Read self-improver-audit.jsonl for the last N days.
    Returns list of JSON entries.
    """
    audit_path = os.path.join(_pa_home(), "self-improver-audit.jsonl")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")

    entries = []
    try:
        with open(audit_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    ts = entry.get("ts", "")
                    if ts >= cutoff:
                        entries.append(entry)
                except (json.JSONDecodeError, KeyError):
                    continue
    except FileNotFoundError:
        pass

    return entries


def group_by_action(entries: list) -> dict:
    """Group audit entries by action and count them."""
    actions = {}
    for entry in entries:
        action = entry.get("action", "unknown")
        if action not in actions:
            actions[action] = []
        actions[action].append(entry)
    return actions


def read_maintenance_state(days: int = 7) -> dict:
    """
    Read maintenance-state.json for skip/shed entries in the last N days.
    Returns processed summary.
    """
    ledger_path = os.path.join(_pa_home(), "maintenance-state.json")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")

    summary = {
        "skipped": [],
        "shed": []
    }

    try:
        with open(ledger_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        for job_name, job_data in data.get("jobs", {}).items():
            # Check for skips in the window
            last_skip = job_data.get("lastSkipAt", "")
            if last_skip and last_skip >= cutoff:
                skip_reason = job_data.get("lastSkipReason", "unknown")
                if skip_reason != "not-due":
                    summary["skipped"].append({
                        "job": job_name,
                        "reason": skip_reason,
                        "at": last_skip
                    })

            # Check for shed entries (skills parked due to consecutive failures)
            consecutive_failures = job_data.get("consecutiveFailures", 0)
            if consecutive_failures > 0:
                summary["shed"].append({
                    "job": job_name,
                    "consecutiveFailures": consecutive_failures
                })

    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, KeyError):
        pass

    return summary


def read_parked_skills() -> list:
    """
    Read scheduler's latest.json for parked skills (consecutiveFailures > 0).
    """
    latest_path = os.path.join(_pa_home(), "scheduler", "latest.json")

    parked = []
    try:
        with open(latest_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        for job_name, job_data in data.get("jobs", {}).items():
            consecutive_failures = job_data.get("consecutiveFailures", 0)
            if consecutive_failures > 0:
                parked.append({
                    "job": job_name,
                    "consecutiveFailures": consecutive_failures
                })

    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, KeyError):
        pass

    return parked


def read_pending_conflicts(days: int = 7) -> list:
    """
    Read review-digest-pending.jsonl for unresolved conflicts in the last N days.
    Returns list of conflict entries.
    """
    pending_path = os.path.join(_pa_home(), "review-digest-pending.jsonl")
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")

    conflicts = []
    try:
        with open(pending_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    # Filter: unresolved AND created within window
                    if not entry.get("resolved", False):
                        created_at = entry.get("created_at", "")
                        if created_at >= cutoff:
                            conflicts.append(entry)
                except (json.JSONDecodeError, KeyError):
                    continue
    except FileNotFoundError:
        pass

    return conflicts


def get_slo_summary() -> str:
    """
    Get SLO error budget status summary for current month.
    Calls 'pa slo report --month current' and parses output.
    Returns a one-line summary.
    """
    try:
        import subprocess
        now = datetime.now(timezone.utc)
        month_str = now.strftime("%Y-%m")
        result = subprocess.run(
            ["node", os.path.join(SCRIPT_DIR, "..", "dist", "bin", "pa.js"), "slo", "report", "--month", month_str],
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = result.stdout.strip()

        # Parse the table to extract status summary
        lines = output.split("\n")
        statuses = []
        for line in lines:
            if "bot-reply-delivery" in line:
                parts = line.split()
                if len(parts) >= 6:
                    status = parts[-1].upper()
                    statuses.append(f"bot:{status}")
            elif "daily-mail-brief" in line:
                parts = line.split()
                if len(parts) >= 6:
                    status = parts[-1].upper()
                    statuses.append(f"mail:{status}")
            elif "catchup-heartbeat" in line:
                parts = line.split()
                if len(parts) >= 6:
                    status = parts[-1].upper()
                    statuses.append(f"heartbeat:{status}")
            elif "ekadashi-alerts" in line:
                parts = line.split()
                if len(parts) >= 6:
                    status = parts[-1].upper()
                    statuses.append(f"ekadashi:{status}")

        if statuses:
            return " | ".join(statuses)
        else:
            return "No data"
    except Exception as e:
        return f"Error: {e}"


def compose_digest(audit_entries: list, maintenance_summary: dict, parked_skills: list, pending_conflicts: list) -> str:
    """Compose the weekly digest markdown."""
    lines = []

    # Header
    now = datetime.now(timezone.utc)
    lines.append(f"# Weekly Ops Digest — Week {get_iso_week(now)}")
    lines.append(f"Generated: {now.strftime('%Y-%m-%d %H:%M:%S')} UTC")
    lines.append("")

    # Section 0: SLO Status (NEW)
    lines.append("## SLO Error Budget Status (This Month)")
    slo_summary = get_slo_summary()
    lines.append(f"**Status**: {slo_summary}")
    lines.append("*Full report: `pa slo report`*")
    lines.append("")

    # Section 1: Self-Improver Activity
    lines.append("## Self-Improver Activity (Last 7 Days)")
    actions = group_by_action(audit_entries)

    if actions:
        for action, entries in sorted(actions.items(), key=lambda x: -len(x[1])):
            lines.append(f"### {action.replace('_', ' ').title()}: {len(entries)}")
            for entry in entries[:5]:  # Show first 5 examples
                draft = entry.get("draft", "unknown")
                target_skill = entry.get("target_skill", "")
                if target_skill:
                    lines.append(f"- {draft} (target: {target_skill})")
                else:
                    lines.append(f"- {draft}")
            if len(entries) > 5:
                lines.append(f"- ... and {len(entries) - 5} more")
            lines.append("")
    else:
        lines.append("*No self-improver activity in the last 7 days.*")
        lines.append("")

    # Section 2: Maintenance Job Skips
    lines.append("## Maintenance Job Skips (Last 7 Days)")
    skipped = maintenance_summary.get("skipped", [])

    if skipped:
        for item in skipped:
            job = item.get("job", "unknown")
            reason = item.get("reason", "unknown")
            at = item.get("at", "")
            lines.append(f"- **{job}**: {reason} (at {at})")
        lines.append("")
    else:
        lines.append("*No maintenance job skips in the last 7 days.*")
        lines.append("")

    # Section 3: Parked Skills
    lines.append("## Parked Skills")
    parked = parked_skills

    if parked:
        lines.append("The following skills are parked due to consecutive failures:")
        for item in parked:
            job = item.get("job", "unknown")
            failures = item.get("consecutiveFailures", 0)
            lines.append(f"- **{job}**: {failures} consecutive failures")
        lines.append("")
    else:
        lines.append("*No parked skills.*")
        lines.append("")

    # Section 4: Secrets Due for Rotation
    lines.append("## Secrets Due for Rotation")
    try:
        import subprocess
        result = subprocess.run(
            [sys.executable, os.path.join(SCRIPT_DIR, "rotate_secrets.py"), "--due"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        due_output = result.stdout.strip()
        if due_output and not due_output.startswith("No secrets"):
            lines.append("The following secrets are due for rotation:")
            lines.append("")
            for line in due_output.split("\n"):
                lines.append(f"  {line}")
            lines.append("")
        else:
            lines.append("*No secrets due for rotation.*")
            lines.append("")
    except Exception as e:
        lines.append(f"*Unable to check rotation status: {e}*")
        lines.append("")

    # Section 5: Memory Conflicts Pending Review
    lines.append("## Memory Conflicts Pending Review")
    conflicts = pending_conflicts

    if conflicts:
        lines.append("The following memory conflicts require manual resolution:")
        for item in conflicts:
            key = item.get("key", "unknown")
            new_text = item.get("new_text", "")
            existing_text = item.get("existing_text", "")
            category = item.get("category", "unknown")
            created_at = item.get("created_at", "")

            # Truncate text to 80 chars
            new_text_truncated = new_text[:77] + "..." if len(new_text) > 80 else new_text
            existing_text_truncated = existing_text[:77] + "..." if len(existing_text) > 80 else existing_text

            lines.append(f"- **{key}** ({category})")
            lines.append(f"  - New: {new_text_truncated}")
            lines.append(f"  - Existing: {existing_text_truncated}")
            lines.append(f"  - Created: {created_at}")
        lines.append("")
    else:
        lines.append("*No memory conflicts pending review.*")
        lines.append("")

    return "\n".join(lines)


def main():
    """Main entry point."""
    days = 7

    # Read data sources
    audit_entries = read_audit_trail(days)
    maintenance_summary = read_maintenance_state(days)
    parked_skills = read_parked_skills()
    pending_conflicts = read_pending_conflicts(days)

    # Compose digest
    digest = compose_digest(audit_entries, maintenance_summary, parked_skills, pending_conflicts)

    # Print to stdout — the pa runner relays this to pa-alerts via the skill's
    # telegram_output. Do NOT dispatch telegram_notify from here: cmd skills run
    # without TELEGRAM_BOT_TOKEN, so a direct send raises and exits 1, which
    # also blocks the runner's success-only stdout relay (2026-08-17 failures).
    iso_week = get_iso_week(datetime.now(timezone.utc))
    dedup_key = f"weekly-digest-{iso_week}"
    print(f"{digest}\n\n_Dedup: {dedup_key}_")


if __name__ == "__main__":
    main()
