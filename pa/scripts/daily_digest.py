#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Daily digest — 24h activity rollup.

Sources (all deterministic, no LLM):
- ~/.pa/logs/*/*/*.meta files (RunMeta JSON from pa executions)
- pa costs --day --json (token & cost totals, rolling 24h)
- ~/.pa/app.log.jsonl (failover events)
- ~/.pa/telegram-dlq.jsonl (dead letter queue)
- ~/.pa/self-improver-audit.jsonl (autonomous changes)
- pa slo report --json (via weekly_digest.get_slo_summary)
- ~/.pa/review-digest-pending.jsonl (via weekly_digest.read_audit_trail)
- ~/.pa/alert-census.json (via weekly_digest.read_alert_census)

Stdout relay only — this script NEVER imports telegram_notify (2026-08-17 failure class).
Output is consumed by pa's stdout→telegram_output relay (redacts secrets at pa/src/telegram.ts:114).

Dedup key: daily-digest-<IST YYYY-MM-DD> (for Telegram duplicate suppression).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

# Import from same-directory weekly_digest (its module level is import-safe)
from weekly_digest import get_slo_summary, read_audit_trail, read_alert_census


def _pa_home() -> str:
    """Return ~/.pa path (PA_HOME env or default)."""
    pa_home = os.environ.get("PA_HOME")
    if pa_home:
        return pa_home
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if not home:
        raise RuntimeError("Cannot determine home directory")
    return os.path.join(home, ".pa")


def _repo_root() -> str:
    """Return repo root (3×dirname of __file__, forward slashes)."""
    # pa/scripts/daily_digest.py → repo root
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "../../"))


def _pa_js() -> str:
    """Return path to pa/dist/bin/pa.js."""
    return os.path.join(_repo_root(), "pa/dist/bin/pa.js")


def tz_offset_minutes() -> int:
    """Return IST offset in minutes (PA_TZ_OFFSET_MINUTES env or 330)."""
    try:
        return int(os.environ.get("PA_TZ_OFFSET_MINUTES", "330"))
    except ValueError:
        return 330


def ist_today() -> str:
    """Return today's date in IST as YYYY-MM-DD."""
    offset = timedelta(minutes=tz_offset_minutes())
    now = datetime.now(timezone.utc) + offset
    return now.strftime("%Y-%m-%d")


def _parse_meta_timestamp(filename: str) -> datetime | None:
    """Parse YYYYMMDD-HHMMSS from .meta filename; return None if invalid."""
    match = re.match(r"^(\d{8})-(\d{6})-[a-f0-9]+\.meta$", filename)
    if not match:
        return None
    date_str, time_str = match.groups()
    try:
        ts = datetime.strptime(f"{date_str}{time_str}", "%Y%m%d%H%M%S")
        return ts.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def collect_run_rollup(
    hours: int = 24,
    now: datetime | None = None,
    pa_home: str | None = None,
    max_meta: int = 20000,
) -> tuple[dict[str, Any], bool]:
    """
    Walk .meta files and aggregate run statistics per skill.

    R5 discipline: FILENAME timestamp filter BEFORE any read — out-of-window files
    are never opened, even if corrupt.

    Args:
        hours: Rolling window size in hours (default 24).
        now: Reference time (UTC); defaults to datetime.now(timezone.utc).
        pa_home: Path to ~/.pa; default from _pa_home().
        max_meta: Maximum .meta files to read (cap + truncated flag).

    Returns:
        (rollup_dict, truncated) where rollup_dict has keys:
        - runs: Total runs counted
        - success: Successful runs
        - error: Failed runs
        - rate_limited: Rate-limited runs
        - durationMs: Total duration in milliseconds
        - workers: Dict mapping worker name to count (global)
        - skills: Dict mapping skillDirName to {runs, success, error, rate_limited,
                   workers: {<worker>: count}}
        and truncated is True if the cap was hit.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if pa_home is None:
        pa_home = _pa_home()

    cutoff = now - timedelta(hours=hours)
    logs_dir = os.path.join(pa_home, "logs")

    rollup: dict[str, Any] = {
        "runs": 0,
        "success": 0,
        "error": 0,
        "rate_limited": 0,
        "durationMs": 0,
        "workers": {},
        "skills": {},
    }
    meta_count = 0
    truncated = False

    if not os.path.isdir(logs_dir):
        return rollup, False

    # Walk logs/<skill>/ directories
    for skill_dir in os.listdir(logs_dir):
        skill_path = os.path.join(logs_dir, skill_dir)
        if not os.path.isdir(skill_path):
            continue

        # Initialize per-skill aggregation
        skill_data: dict[str, Any] = {
            "runs": 0,
            "success": 0,
            "error": 0,
            "rate_limited": 0,
            "workers": {},
        }

        # Collect all .meta files, filter by filename timestamp first (R5)
        meta_files = []
        for entry in os.listdir(skill_path):
            if not entry.endswith(".meta"):
                continue
            ts = _parse_meta_timestamp(entry)
            if ts is None:
                continue
            if ts < cutoff:
                continue  # Out of window — never read this file
            meta_files.append((entry, ts))

        # Process newest-first (filename sort desc = newest first)
        meta_files.sort(key=lambda x: x[0], reverse=True)

        for entry, _ in meta_files:
            if meta_count >= max_meta:
                truncated = True
                break
            meta_path = os.path.join(skill_path, entry)

            try:
                with open(meta_path, encoding="utf-8") as f:
                    meta = json.loads(f.read())
            except (json.JSONDecodeError, IOError, OSError):
                # Skip corrupt/unreadable entries
                continue

            meta_count += 1
            rollup["runs"] += 1
            skill_data["runs"] += 1

            status = meta.get("status", "unknown")
            if status == "success":
                rollup["success"] += 1
                skill_data["success"] += 1
            elif status == "error":
                rollup["error"] += 1
                skill_data["error"] += 1
            elif status == "rate_limited":
                rollup["rate_limited"] += 1
                skill_data["rate_limited"] += 1

            duration = meta.get("durationMs", 0)
            rollup["durationMs"] += duration

            worker = meta.get("worker", "unknown")
            rollup["workers"][worker] = rollup["workers"].get(worker, 0) + 1
            skill_data["workers"][worker] = skill_data["workers"].get(worker, 0) + 1

        # Store skill data if we have any runs
        if skill_data["runs"] > 0:
            rollup["skills"][skill_dir] = skill_data

        if truncated:
            break

    return rollup, truncated


def read_cost_rollup(runner: Callable | None = None) -> dict[str, Any] | None:
    """
    Run `pa costs --day --json` and return parsed JSON.

    Args:
        runner: Injected subprocess runner (callable with .returncode, .stdout).
                Default: real subprocess.run with capture_output, timeout=30.

    Returns:
        Parsed JSON dict (D4 shape) or None on any failure.
    """
    if runner is None:
        def runner(cmd: list[str]) -> subprocess.CompletedProcess:
            return subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30,
            )

    cmd = ["node", _pa_js(), "costs", "--day", "--json"]
    try:
        result = runner(cmd)
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return None


def count_failover(
    hours: int = 24,
    now: datetime | None = None,
    pa_home: str | None = None,
) -> dict[str, int]:
    """
    Count failover events from app.log.jsonl.

    Returns:
        {"bot_switches": int, "exhausted": int}
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if pa_home is None:
        pa_home = _pa_home()

    cutoff = now - timedelta(hours=hours)
    log_path = os.path.join(pa_home, "app.log.jsonl")

    counts = {"bot_switches": 0, "exhausted": 0}

    if not os.path.isfile(log_path):
        return counts

    try:
        with open(log_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue  # Skip malformed lines

                ts_str = entry.get("timestamp")
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except ValueError:
                    continue

                if ts < cutoff:
                    continue

                kind = entry.get("kind")
                message = entry.get("message", "")

                if kind == "failover":
                    counts["bot_switches"] += 1
                elif message.startswith("Skill exhausted"):
                    counts["exhausted"] += 1
    except (IOError, OSError):
        pass

    return counts


def count_dlq(
    hours: int = 24,
    now: datetime | None = None,
    pa_home: str | None = None,
) -> dict[str, int]:
    """
    Count DLQ entries from telegram-dlq.jsonl.

    Returns:
        {"total": int, "quarantined": int}
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if pa_home is None:
        pa_home = _pa_home()

    cutoff = now - timedelta(hours=hours)
    dlq_path = os.path.join(pa_home, "telegram-dlq.jsonl")

    counts = {"total": 0, "quarantined": 0}

    if not os.path.isfile(dlq_path):
        return counts

    try:
        with open(dlq_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                ts_str = entry.get("timestamp")
                if not ts_str:
                    continue
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except ValueError:
                    continue

                if ts < cutoff:
                    continue

                counts["total"] += 1
                if entry.get("quarantined"):
                    counts["quarantined"] += 1
    except (IOError, OSError):
        pass

    return counts


def compose_daily_digest(
    rollup: dict[str, Any],
    truncated: bool,
    costs: dict[str, Any] | None,
    failover: dict[str, int],
    dlq: dict[str, int],
    audit_entries: list[dict[str, Any]],
    census: dict[str, Any] | None,
    slo_line: str,
) -> str:
    """
    Compose the daily digest markdown with exact section order.

    Every missing source renders its explicit unavailable line.
    """
    ist_date = ist_today()
    generated_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    lines: list[str] = []
    lines.append(f"# Daily Digest — {ist_date}")
    lines.append(f"Generated: {generated_utc} · Window: last 24h (UTC)")
    lines.append("")

    # ## Runs (24h)
    lines.append("## Runs (24h)")
    if rollup["runs"] == 0:
        lines.append("_No runs in the last 24h._")
    else:
        lines.append("| Skill | Runs | OK | Err | RL | Workers |")
        lines.append("|-------|------|----|-----|----|--------|")

        # Sort skills by runs desc, top 15
        skills_items = sorted(
            [(name, data) for name, data in rollup["skills"].items()],
            key=lambda x: x[1]["runs"],
            reverse=True,
        )
        shown = skills_items[:15]
        more_count = max(0, len(skills_items) - 15)

        for skill_name, skill_data in shown:
            runs = skill_data["runs"]
            ok = skill_data["success"]
            err = skill_data["error"]
            rl = skill_data["rate_limited"]

            # Build workers string: "agy×12, claude×1" style
            workers_parts = []
            for worker, count in sorted(skill_data["workers"].items()):
                workers_parts.append(f"{worker}×{count}")
            workers_str = ", ".join(workers_parts) if workers_parts else "-"

            lines.append(f"| {skill_name} | {runs} | {ok} | {err} | {rl} | {workers_str} |")

        if more_count > 0:
            lines.append(f"| _+ {more_count} more skills_ | | | | | |")

        if truncated:
            lines.append("")
            lines.append("_Meta cap reached — counts partial._")

    lines.append("")

    # ## Tokens & Est. Cost (24h)
    lines.append("## Tokens & Est. Cost (24h)")
    if costs is None:
        lines.append("_Token usage unavailable (`pa costs --day --json` failed)._")
    else:
        totals = costs.get("totals", {})
        total_tokens = totals.get("totalTokens", 0)
        est_cost = totals.get("estCostUsd", 0)
        unpriced = costs.get("unpricedKeys", [])

        lines.append(f"**Totals (24h):** {total_tokens:,} tokens")
        if est_cost > 0:
            lines.append(f"**Est. cost:** ${est_cost:.6f}")
        if unpriced:
            lines.append(f"_(Unpriced workers/models: {', '.join(sorted(unpriced))})_")

    lines.append("")

    # ## Failover (24h)
    lines.append("## Failover (24h)")
    bot_switches = failover.get("bot_switches", 0)
    exhausted = failover.get("exhausted", 0)
    if bot_switches == 0 and exhausted == 0:
        lines.append("No failover activity.")
    else:
        parts = []
        if bot_switches > 0:
            parts.append(f"{bot_switches} worker switches")
        if exhausted > 0:
            parts.append(f"{exhausted} skill-exhaustion cascades")
        lines.append(" · ".join(parts))

    lines.append("")

    # ## Alerts (census 7d)
    lines.append("## Alerts")
    if census is None:
        lines.append("_Alert census unavailable._")
    else:
        top_line = census.get("topLine", "")
        total_sent = census.get("totalSent", 0)
        total_suppressed = census.get("totalSuppressed", 0)
        sent_by_day = census.get("sentPerDay", {})

        lines.append(top_line)
        if total_sent > 0 or total_suppressed > 0:
            ratio = (total_suppressed / max(1, total_sent + total_suppressed)) * 100
            lines.append(f"**7d:** {total_sent} sent / {total_suppressed} suppressed ({ratio:.1f}% filtered)")

        # Show per-UTC-day counts for last 2 days
        now = datetime.now(timezone.utc)
        recent_days = []
        for i in range(1, 3):
            d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
            if d in sent_by_day:
                recent_days.append(f"{d}: {sent_by_day[d]}")

        if recent_days:
            lines.append(f"**Sent by UTC day:** {', '.join(recent_days)}")

    lines.append("")

    # ## DLQ (24h)
    lines.append("## DLQ (24h)")
    dlq_total = dlq.get("total", 0)
    dlq_quarantined = dlq.get("quarantined", 0)
    if dlq_total == 0:
        lines.append("DLQ empty.")
    else:
        lines.append(f"{dlq_total} entries ({dlq_quarantined} quarantined)")

    lines.append("")

    # ## Self-Improver (24h)
    lines.append("## Self-Improver (24h)")
    if not audit_entries:
        lines.append("No autonomous changes.")
    else:
        # Count by action
        actions: dict[str, int] = {}
        for entry in audit_entries:
            action = entry.get("action", "unknown")
            actions[action] = actions.get(action, 0) + 1

        for action, count in sorted(actions.items()):
            lines.append(f"{action}: {count}")

    lines.append("")

    # ## SLO (this month)
    lines.append("## SLO (this month)")
    lines.append(slo_line)

    lines.append("")
    return "\n".join(lines)


def main() -> None:
    """Gather data and print the daily digest to stdout."""
    pa_home = _pa_home()

    # Collect all data sources
    rollup, truncated = collect_run_rollup(hours=24, pa_home=pa_home)
    costs = read_cost_rollup()
    failover = count_failover(hours=24, pa_home=pa_home)
    dlq = count_dlq(hours=24, pa_home=pa_home)
    audit_entries = read_audit_trail(days=1)
    census = read_alert_census()
    slo_line = get_slo_summary(month=None, runner=None)

    digest = compose_daily_digest(
        rollup=rollup,
        truncated=truncated,
        costs=costs,
        failover=failover,
        dlq=dlq,
        audit_entries=audit_entries,
        census=census,
        slo_line=slo_line,
    )

    print(digest)
    print(f"\n\n_Dedup: daily-digest-{ist_today()}_")


if __name__ == "__main__":
    main()
