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
import re
import sys
from datetime import datetime, timezone, timedelta

# Add pa/src to path for telegram_notify import
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PA_SRC = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "src"))
sys.path.insert(0, PA_SRC)

# Budget start constant (operator-editable - the first month with no new features)
BUDGET_START = "2026-09-01"


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


def read_alert_census(max_age_days: int = 8) -> dict | None:
    """
    Read ~/.pa/alert-census.json (written daily by the alert-census maintenance
    job — plans/2026-08-23-alerts-wave-SPEC.md). Returns None when the file is
    absent, unparseable, or its generatedAt is older than max_age_days; the
    digest never omits the Alerts section silently, it renders an
    "unavailable" line instead (compose_digest handles that).
    """
    census_path = os.path.join(_pa_home(), "alert-census.json")
    try:
        with open(census_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

    generated_at = data.get("generatedAt")
    if not generated_at:
        return None

    try:
        generated_dt = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError:
        return None

    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    if generated_dt < cutoff:
        return None

    return data


def read_coordination_stats(days: int = 7, runner=None) -> dict | None:
    """
    Shell out to `pa claims --stats --days N --json` (the pa CLI at
    <repo root>/pa/dist/bin/pa.js) and parse the JSON result. One
    implementation of the computation lives in the CLI
    (pa/src/commands/claim.ts: coordinationStats); this function and
    compose_digest only render it — mirrors get_slo_summary()'s existing
    subprocess pattern.

    `runner` is an injectable callable (cmd: list[str]) -> a result object
    with `.returncode` and `.stdout`, for tests; defaults to a real
    `subprocess.run(cmd, capture_output=True, text=True, timeout=20)`. Any
    failure — the runner raising (e.g. subprocess.TimeoutExpired), a non-zero
    exit code, or unparseable JSON — returns None and NEVER raises;
    compose_digest renders the fallback line in that case.
    """
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    pa_js = os.path.join(repo_root, "pa", "dist", "bin", "pa.js")
    cmd = ["node", pa_js, "claims", "--stats", "--days", str(days), "--json"]

    def _default_runner(cmd):
        import subprocess
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20)

    run = runner or _default_runner

    try:
        result = run(cmd)
    except Exception:
        return None

    if result.returncode != 0:
        return None

    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return None


def get_rules_summary(runner=None) -> dict | None:
    """
    Get standing rules summary from `pa rules weekly --json`.

    Calls `pa rules weekly --json` and returns the parsed dict or None on any
    failure (the pa CLI at <repo root>/pa/dist/bin/pa.js). Mirrors
    get_slo_summary()'s subprocess pattern with injectable runner for tests.

    `runner` is an injectable callable (cmd: list[str]) -> a result object with
    `.returncode` and `.stdout`, for tests; defaults to a real
    `subprocess.run(cmd, capture_output=True, text=True, timeout=30)`. Any
    failure — the runner raising, a non-zero exit code, or unparseable JSON —
    returns None and NEVER raises; compose_digest renders the
    fallback line in that case.
    """
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    pa_js = os.path.join(repo_root, "pa", "dist", "bin", "pa.js")
    cmd = ["node", pa_js, "rules", "weekly", "--json"]

    def _default_runner(cmd):
        import subprocess
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    run = runner or _default_runner

    try:
        result = run(cmd)
    except Exception:
        return None

    if result.returncode != 0:
        return None

    try:
        return json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return None


# WP-D2 B.2 (2026-09-02): the ru: grammar's rule-id charset (pa/src/lib/callback-grammar.ts
# RU_RE — the single source; mirrored here ONLY as an emission pre-filter, so a rule id
# outside the grammar never produces a button the runner's validateKeyboardRequest would
# refuse — that would drop the WHOLE keyboard, not just the bad button).
RU_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
# validateKeyboardRequest caps a keyboard at 6 buttons; Accept+Reject pairs mean the
# first 3 charset-valid rules get buttons and the rest stay report-line only.
MAX_KEYBOARD_BUTTONS = 6


def build_rules_keyboard_payload(pending_rules: list | None) -> dict | None:
    """
    Build the [PA_KEYBOARD] envelope payload for the digest's pending rules, or
    None when nothing qualifies (no pending rules, or every id fails the ru:
    charset — those stay report-line only).
    """
    buttons = []
    for r in pending_rules or []:
        r_id = r.get("id", "")
        if not isinstance(r_id, str) or not RU_ID_RE.match(r_id):
            continue
        if len(buttons) + 2 > MAX_KEYBOARD_BUTTONS:
            break
        buttons.append({"text": "✅ Accept", "callback_data": f"ru:{r_id}:a"})
        buttons.append({"text": "✖ Reject", "callback_data": f"ru:{r_id}:x"})
    if not buttons:
        return None
    return {"buttons": buttons}


def render_rules_section(data: dict | None) -> list[str]:
    """
    Render the Standing Rules section from rules summary data.

    data is the parsed JSON from `pa rules weekly --json` or None on failure.
    Renders violation counts, pending rules, and escalation hints.
    """
    lines = []
    lines.append("## Standing Rules")

    if data is None or not data.get("ok", False):
        lines.append("*Rules status unavailable (`pa rules weekly --json` failed).*")
        lines.append("")
        return lines

    # New violations this week
    new_violations = data.get("new_violations", 0)
    violations_7d = data.get("violations_7d", [])
    pending_rules = data.get("pending_rules", [])

    if new_violations > 0:
        lines.append(f"**{new_violations} new rule violation(s) this week**")

    # Escalated violations (≥2/7d)
    escalated = [v for v in violations_7d if v.get("count", 0) >= 2]
    if escalated:
        lines.append("Escalated violations (≥2/7d, consider superseding):")
        for v in escalated:
            key = v.get("key", "unknown")
            count = v.get("count", 0)
            rule_id = v.get("rule_id", "unknown")
            lines.append(f"- **{key}** ({count}×) — `pa rules supersede {rule_id} --reason \"repeated violation\"`")
        lines.append("")

    # Single-count violations
    singles = [v for v in violations_7d if v.get("count", 0) == 1]
    if singles and not escalated:
        lines.append("Single-count violations (7d):")
        for v in singles:
            key = v.get("key", "unknown")
            lines.append(f"- {key}")
        lines.append("")

    # Pending rules awaiting operator accept
    if pending_rules:
        lines.append("**Pending rules awaiting operator accept:**")
        for r in pending_rules:
            r_id = r.get("id", "unknown")
            r_key = r.get("key", "unknown")
            r_text = r.get("text", "").replace("\n", " ")[:80]  # Truncate long text
            lines.append(f"- `{r_key}` (ID: {r_id}) — `pa rules accept {r_id}`")
            lines.append(f"  Text: \"{r_text}\"")
        lines.append("")

    if new_violations == 0 and not escalated and not singles and not pending_rules:
        lines.append("*No rule violations; no rules pending accept.*")
        lines.append("")

    return lines


def render_coordination_line(stats: dict | None) -> str:
    """Renders the exact one-line coordination rollup for the weekly digest."""
    if stats is None:
        return "**Coordination (7d):** unavailable (`pa claims --stats` failed)."
    return (
        f"**Coordination (7d):** {stats.get('claims', 0)} claims "
        f"({stats.get('forced', 0)} forced), {stats.get('denied', 0)} denied, "
        f"{stats.get('released', 0)} released, {stats.get('gcExpired', 0)} GC-expired; "
        f"{stats.get('autoSessionIds', 0)} of {stats.get('distinctSessions', 0)} session labels auto-generated."
    )


def _days_since(iso_str: str) -> int:
    """Whole days between an ISO timestamp and now. 0 on any parse failure."""
    try:
        dt = datetime.fromisoformat((iso_str or "").replace("Z", "+00:00"))
    except ValueError:
        return 0
    return max(0, (datetime.now(timezone.utc) - dt).days)


def get_slo_summary(month: str | None = None, runner=None) -> str:
    """
    Get SLO error budget status summary for the given month (default: current UTC month).
    Calls `pa slo report --month <month> --json` and renders the generic D2 format:
    "<service>:<STATUS>" joined by " | ", where STATUS is uppercased.

    `runner` is an injectable callable (cmd: list[str]) -> a result object with
    `.returncode` and `.stdout`, for tests; defaults to a real
    `subprocess.run(cmd, capture_output=True, text=True, timeout=30)`. Any
    failure — the runner raising, a non-zero exit code, or unparseable JSON —
    returns a deterministic unavailable line and NEVER raises.
    """
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    pa_js = os.path.join(repo_root, "pa", "dist", "bin", "pa.js")

    # Default month: current UTC YYYY-MM
    if month is None:
        month = datetime.now(timezone.utc).strftime("%Y-%m")

    cmd = ["node", pa_js, "slo", "report", "--month", month, "--json"]

    def _default_runner(cmd):
        import subprocess
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    run = runner or _default_runner

    try:
        result = run(cmd)
    except Exception:
        return "unavailable (`pa slo report --json` failed)"

    if result.returncode != 0:
        return "unavailable (`pa slo report --json` failed)"

    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return "unavailable (`pa slo report --json` failed)"

    services = data.get("services", [])
    if not services:
        return "No services configured"

    # Render per D2: "<service>:<STATUS>" joined by " | "
    statuses = [f"{s['service']}:{s['status'].upper()}" for s in services]
    return " | ".join(statuses)


def read_skill_engagement(max_age_days: int = 35) -> dict | None:
    """
    Read ~/.pa/skill-engagement.json (written monthly by the
    skill-engagement-audit maintenance job). Returns None when the file is
    absent, unparseable, or its generatedAt is older than max_age_days.
    """
    engagement_path = os.path.join(_pa_home(), "skill-engagement.json")
    try:
        with open(engagement_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None

    generated_at = data.get("generatedAt")
    if not generated_at:
        return None

    try:
        generated_dt = datetime.fromisoformat(generated_at.replace("Z", "+00:00"))
    except ValueError:
        return None

    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    if generated_dt < cutoff:
        return None

    return data


def read_intervention_counts(days: int = 7) -> dict:
    """
    Read intervention counts for the last N days:
    - blockers: ~/.pa/human-gated-blockers.json entries with first_detected_at >= cutoff
    - reauthKicks: ~/.pa/reauth-kicks.jsonl lines with ts >= cutoff
    Returns {"blockers": int, "reauthKicks": int}; absent files count as 0.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")
    blockers = 0
    reauth_kicks = 0

    # Read human-gated-blockers.json
    blockers_path = os.path.join(_pa_home(), "human-gated-blockers.json")
    try:
        with open(blockers_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for key, entry in data.get("blockers", {}).items():
            first_detected = entry.get("first_detected_at", "")
            if first_detected >= cutoff:
                blockers += 1
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        pass

    # Read reauth-kicks.jsonl
    kicks_path = os.path.join(_pa_home(), "reauth-kicks.jsonl")
    try:
        with open(kicks_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    ts = entry.get("ts", "")
                    if ts >= cutoff:
                        reauth_kicks += 1
                except (json.JSONDecodeError, KeyError):
                    continue
    except FileNotFoundError:
        pass

    return {"blockers": blockers, "reauthKicks": reauth_kicks}


def read_new_feature_count(since_iso: str) -> int:
    """
    Parse <repo_root>/plans/INDEX.md and count feature rows since the given date.
    A feature row matches: | YYYY-MM-DD | <title> | ... | where:
    - date >= since_iso
    - title does NOT match (case-insensitive): assessment, study, audit, scoping, postmortem, review
    Returns the count; 0 if the file is absent or unparseable.
    """
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    index_path = os.path.join(repo_root, "plans", "INDEX.md")

    try:
        with open(index_path, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return 0

    # Regex for table rows: | YYYY-MM-DD | <title> | ...
    row_pattern = r"^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^|]+)"
    exclusion_keywords = {"assessment", "study", "audit", "scoping", "postmortem", "review"}

    count = 0
    for match in re.finditer(row_pattern, content, re.MULTILINE):
        date_str = match.group(1)
        title = match.group(2).strip()

        if date_str >= since_iso:
            # Check if title contains any exclusion keyword
            title_lower = title.lower()
            if not any(keyword in title_lower for keyword in exclusion_keywords):
                count += 1

    return count


def render_retire_section(data: dict | None) -> list[str]:
    """Render the 'Retire?' section from skill-engagement data."""
    lines = []
    lines.append("## Skills — Retire? (90d zero engagement)")

    if data is None:
        lines.append("_*Skill engagement audit unavailable (job has not run in the last 35 days)._")
    else:
        stale = data.get("stale", [])
        if not stale:
            lines.append("*No zero-engagement skills.*")
        else:
            for skill in stale:
                name = skill.get("skill", "unknown")
                scheduled = skill.get("scheduled", False)
                label = "scheduled" if scheduled else "manual"
                last_success = skill.get("lastSuccessAt")
                rows = skill.get("decisionRows90d", 0)
                alerts = skill.get("alertSent7d", 0)

                if last_success:
                    days_ago = _days_since(last_success)
                    time_str = f"{days_ago}d ago"
                else:
                    time_str = "never"

                alert_str = f", {alerts} alerts/7d" if alerts > 0 else ""
                lines.append(f"- **{name}** ({label}): last success {time_str}, {rows} decision rows{alert_str}")

            lines.append("Nothing is auto-deleted — retiring is an operator decision.")

    lines.append("")
    return lines


def render_scorecard_section(
    alert_census: dict | None,
    audit_entries: list,
    intervention_counts: dict,
    feature_count: int
) -> list[str]:
    """Render the complexity budget scorecard section."""
    lines = []
    lines.append(f"## Complexity budget (since {BUDGET_START})")

    # Alerts line
    if alert_census is None:
        lines.append("- alerts: unavailable (census stale)")
    else:
        total = alert_census.get("totalSent", 0)
        lines.append(f"- alerts: {total} sent / 7d (census)")

    # Operator interventions
    blockers = intervention_counts.get("blockers", 0)
    reauth = intervention_counts.get("reauthKicks", 0)
    lines.append(f"- operator interventions: {blockers} new human-gated blockers, {reauth} reauth kicks / 7d")

    # Self-improver counts
    applied_set = {"applied-fix", "approved-new-skill", "applied-code-fix"}
    rolled_back_set = {"rolled-back", "reverted-protected-path", "reverted-test-weakening", "reverted-verification-failed"}

    applied = sum(1 for e in audit_entries if e.get("action") in applied_set)
    rolled_back = sum(1 for e in audit_entries if e.get("action") in rolled_back_set)

    lines.append(f"- self-improver: {applied} applied, {rolled_back} rolled back / 7d")

    # New plan/spec rows
    lines.append(f"- new plan/spec rows since start: {feature_count} (target: 0)")

    lines.append("")
    return lines


def compose_digest(audit_entries: list, maintenance_summary: dict, parked_skills: list, alert_census: dict | None = None, coordination_stats: dict | None = None, rules_summary: dict | None = None) -> str:
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

    # Section 3.5: Alerts (7d) (NEW, 2026-08-23 — plans/2026-08-23-alerts-wave-SPEC.md).
    # Never omitted silently: an absent/stale census still renders the header
    # plus an explicit "unavailable" line, so "0 proposals — nothing to report"
    # can never again mean "the census job hasn't run" (review §4).
    lines.append("## Alerts (7d)")
    if alert_census is None:
        lines.append("_No alert census available (job has not run in the last 8 days)._")
        lines.append("")
        lines.append(render_coordination_line(coordination_stats))
        lines.append("")
    else:
        lines.append(alert_census.get("topLine", ""))
        lines.append("")
        lines.append(render_coordination_line(coordination_stats))
        lines.append("")

        families = alert_census.get("families", [])
        if families:
            lines.append("| Family | Sent | Owner | Owner Status | Classification |")
            lines.append("|---|---|---|---|---|")
            for fam in families[:5]:
                name = fam.get("family", "unknown")
                sent = fam.get("sent", 0)
                owner_kind = fam.get("ownerKind", "unknown")
                owner = fam.get("owner")
                owner_label = f"{owner_kind}:{owner}" if owner else owner_kind
                owner_status = fam.get("ownerStatus") or {}
                status_label = owner_status.get("status", "unknown")
                classification = fam.get("classification", "unknown")
                lines.append(f"| {name} | {sent} | {owner_label} | {status_label} | {classification} |")
            lines.append("")

        masked = alert_census.get("maskedFailures", [])
        if masked:
            lines.append("**Masked failures:**")
            for m in masked:
                skill = m.get("skill", "unknown")
                last_run = m.get("lastRunAt", "")
                marker = m.get("marker", "")
                lines.append(f"- **{skill}** (last run {last_run}): {marker}")
            lines.append("")

        human_gated = [f for f in families if f.get("classification") == "human-gated"]
        if human_gated:
            lines.append("**Operator action needed:**")
            for fam in human_gated:
                name = fam.get("family", "unknown")
                owner_kind = fam.get("ownerKind", "unknown")
                owner = fam.get("owner")
                owner_label = f"{owner_kind}:{owner}" if owner else owner_kind
                age_days = _days_since(fam.get("firstSeen", ""))
                owner_status = fam.get("ownerStatus") or {}
                last_error = (owner_status.get("lastError") or "")[:200]
                lines.append(f"- **{name}** ({owner_label}), {age_days}d old: {last_error}")
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

    # Section 5: Standing Rules (AI-165). WP-D2 B.3 (2026-09-02) DELETED the former
    # Section 5 ("Memory Conflicts Pending Review") — it only ever rendered the
    # review-digest-pending.jsonl backlog as prose; conflicts surface through the
    # nightly consolidation report flow instead.
    rules_data = rules_summary if rules_summary is not None else get_rules_summary()
    rules_lines = render_rules_section(rules_data)
    lines.extend(rules_lines)

    # Section 6: Skills — Retire? (90d zero engagement) (NEW, AI-168)
    engagement_data = read_skill_engagement()
    retire_lines = render_retire_section(engagement_data)
    lines.extend(retire_lines)

    # Section 7: Complexity budget scorecard (NEW, AI-168)
    intervention_counts = read_intervention_counts(days=7)
    feature_count = read_new_feature_count(BUDGET_START)
    scorecard_lines = render_scorecard_section(alert_census, audit_entries, intervention_counts, feature_count)
    lines.extend(scorecard_lines)

    return "\n".join(lines)


def main():
    """Main entry point."""
    days = 7

    # Read data sources
    audit_entries = read_audit_trail(days)
    maintenance_summary = read_maintenance_state(days)
    parked_skills = read_parked_skills()
    alert_census = read_alert_census()
    coordination_stats = read_coordination_stats(days)
    # Fetched ONCE here (not also inside compose_digest) so the prose and the
    # B.2 keyboard come from the same snapshot.
    rules_summary = get_rules_summary()

    # Compose digest
    digest = compose_digest(audit_entries, maintenance_summary, parked_skills, alert_census, coordination_stats, rules_summary)

    # Print to stdout — the pa runner relays this to pa-alerts via the skill's
    # telegram_output. Do NOT dispatch telegram_notify from here: cmd skills run
    # without TELEGRAM_BOT_TOKEN, so a direct send raises and exits 1, which
    # also blocks the runner's success-only stdout relay (2026-08-17 failures).
    iso_week = get_iso_week(datetime.now(timezone.utc))
    dedup_key = f"weekly-digest-{iso_week}"
    print(f"{digest}\n\n_Dedup: {dedup_key}_")

    # WP-D2 B.2 (2026-09-02): the rules accept/reject keyboard rides the
    # [PA_KEYBOARD] envelope (Wave-1 WP-C, run.ts extractKeyboardEnvelope) as the
    # LAST stdout line, so it attaches to the delivery's last chunk and the marker
    # line is stripped from the delivered text. No pending rules (or none whose id
    # passes the ru: charset) prints nothing.
    keyboard_payload = build_rules_keyboard_payload(rules_summary.get("pending_rules") if rules_summary else None)
    if keyboard_payload:
        print(f"[PA_KEYBOARD]: {json.dumps(keyboard_payload)}")


if __name__ == "__main__":
    main()
