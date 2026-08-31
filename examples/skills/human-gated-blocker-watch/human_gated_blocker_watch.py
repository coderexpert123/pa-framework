#!/usr/bin/env python3
"""Escalating daily watchdog for human-gated worker blockers.

Prints either the single word NO_OUTPUT (nothing to escalate today) or a compact
report, and pages pa-alerts when — and only when — a worker has been stuck in a
terminal, HUMAN-GATED fault (`account-exhausted` or `auth-error`) for 3+ days.

Why this exists
---------------
A worker that hits a terminal, human-action-required fault gets ONE alert from
`pa/src/rate-limits.ts`'s `alertAccountExhausted()` and then goes quiet at a
fixed ~6h dedup cadence forever — it never gets louder, and nothing tracks HOW
LONG the outage has actually persisted. `~/.pa/rate-limit-state.json`'s
`last_event` / `cooldown_until` are REWRITTEN on every failed retry, so the
system's own state has no memory of "this has been broken for a week", only
"this failed again just now". Meanwhile a dead worker keeps sitting at its old
`priority:` in `~/.pa/config.yaml` with no signal recommending a human look.

Concretely, a worker at priority 1 can sit `account-exhausted` (a billing-class
fault rate-limits.ts documents as one that "never self-heals") for weeks,
and the only signal is a dedup-suppressed one-shot that never escalates.

This watchdog closes that gap. It keeps its OWN additive ledger of when each
human-gated blocker was first seen (because rate-limit-state.json's timestamps
can't be trusted for duration), computes an age in days, and escalates:

  * Days 0-2:  NO alert. The existing `alertAccountExhausted()` one-shot already
               covers this window on its own ~6h cadence — deliberately NOT
               duplicated here.
  * Days 3-6:  severity `warn`, once per calendar day, naming worker + day count.
  * Day 7+:    severity `error`, once per calendar day, ALSO naming the worker's
               current `priority:` from config.yaml so the mismatch (a dead
               worker still at priority 1) is visible without touching config.

Only `account-exhausted` and `auth-error` are treated as human-gated: the other
`RateLimitClassification` values (`quota-daily`, `quota-per-minute`,
`quota-exhausted`, `server-overload`, `usage-limit-session`) self-heal on a
timer and must NOT be escalated.

Two invariants that are deliberate, not oversights
--------------------------------------------------
1. THIS SCRIPT NEVER WRITES ~/.pa/config.yaml. config.yaml is hand-maintained
   human INTENT (priorities, `supersedes:` relationships, live-verified
   evidence in comments). This watchdog READS a worker's `priority:` only to
   name it in an escalated alert. It never reprioritises a dead worker — the
   alert RECOMMENDS recharging the account or manually reprioritising; a human
   decides. Auto-editing a hand-maintained config is how intent gets lost.
2. The ledger (~/.pa/human-gated-blockers.json) is ADDITIVE and separate. It is
   the only place age is tracked; it is never merged into config or state.

Honest limitation
------------------
Age tracking starts at this script's FIRST run, not retroactively. On first
deployment a blocker that has silently existed for days still shows as day 0 —
the script cannot know how long it was broken before it began watching.

A third family (WP-G, AI-147): Google reauth
----------------------------------------------
`scan_google_auth()` follows the same 3/7-day escalation as the worker-blocker
family above, modelled on the `scan_postmortems()` template rather than on
`evaluate()`: age lives in the marker file itself
(`~/.pa/google-auth-blocked.json`, written by
`pa/scripts/google_reauth_kick.py`), not in this script's ledger, and the
marker is deleted here once a `google-token.json` newer than the marker's
`first_seen` proves the block resolved. The daily-dedup stamp is the only
thing this family stores in `~/.pa/human-gated-blockers.json`, as a TOP-LEVEL
sibling of `"blockers"` (`"google_auth": {"last_alerted_on": ...}`) — never
inside `"blockers"` itself, because `evaluate()`'s vanished-key cleanup would
silently delete any key there that isn't a live worker `"<worker>:<classification>"`
pair. See `load_google_auth_stamp()` / `save_google_auth_stamp()`.

Usage:  python human_gated_blocker_watch.py
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

# Windows pipes default to cp1252; alert text carries em-dashes and the
# occasional emoji (same bug class as the 2026-07-08 PII-guard encoding fix).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# The only classifications a human must act on and that never self-heal. The
# rest (`quota-*`, `server-overload`, `usage-limit-session`) resolve on a timer
# and are covered by the normal cooldown machinery — escalating them would be
# crying wolf on a fault that fixes itself.
HUMAN_GATED = {"account-exhausted", "auth-error"}

WARN_AFTER_DAYS = 3   # days 3-6 -> warn
ERROR_AFTER_DAYS = 7  # day 7+   -> error
POSTMORTEM_ESCALATE_DAYS = 30  # postmortem action items escalate after 30 days
MAX_REPORT_CHARS = 3000

WARN = "warn"
ERROR = "error"


# ---------------------------------------------------------------------------
# secrets — Task Scheduler gives this process neither the bot's environment nor
# its cwd, so secrets are read straight from ~/.pa/secrets.env. Never hardcode a
# token or a chat id. (Reference: worker_capability_scan.py / update_coding_dirs.py)
# ---------------------------------------------------------------------------

_SECRETS_CACHE: dict | None = None


def pa_home() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa"))


def _load_secrets() -> dict:
    path = pa_home() / "secrets.env"
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                out[key.strip()] = val.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return out


def _secret(key: str, default=None):
    """os.environ wins, then ~/.pa/secrets.env, then the default."""
    global _SECRETS_CACHE
    if key in os.environ and os.environ[key]:
        return os.environ[key]
    if _SECRETS_CACHE is None:
        _SECRETS_CACHE = _load_secrets()
    return _SECRETS_CACHE.get(key, default)


def alert_chat_id() -> str | None:
    """pa-alerts if configured, else the supergroup.

    TELEGRAM_CHAT_ID is comma-separated and its order is NOT meaningful: parse
    by SIGN — a supergroup id is negative, a DM id is positive.
    """
    explicit = _secret("PA_ALERTS_CHAT_ID")
    if explicit:
        return explicit
    raw = _secret("TELEGRAM_CHAT_ID") or ""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    for p in parts:
        if p.startswith("-"):
            return p
    return parts[0] if parts else None


# ---------------------------------------------------------------------------
# I/O — all fail safe. A corrupt state or ledger file must never crash the run.
# ---------------------------------------------------------------------------

def load_state(path: Path) -> dict:
    """Read ~/.pa/rate-limit-state.json (Record<worker, WorkerCooldown>).

    Missing or corrupt => {} (nothing to escalate), never a crash.
    """
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def load_ledger(path: Path) -> dict:
    """The additive age ledger, or {} when there is no usable one.

    A corrupt ledger degrades to first-run semantics (re-baseline every
    currently-present blocker at `now`) rather than crashing the daily run.
    """
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}
    blockers = data.get("blockers")
    return blockers if isinstance(blockers, dict) else {}


def save_ledger(path: Path, blockers: dict, now: datetime) -> None:
    """Atomic (tmp + os.replace) so a crash mid-write cannot leave a half file
    the next run would read as corrupt."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "updatedAt": now.isoformat(),
        "note": ("Age ledger for human-gated worker blockers, written by "
                 "projects/pa-maintenance/scripts/human_gated_blocker_watch.py. "
                 "config.yaml and rate-limit-state.json are NEVER written by that "
                 "script; this file is the only place outage age is tracked."),
        "blockers": blockers,
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def load_google_auth_stamp(path: Path) -> str | None:
    """The google-auth family's daily-dedup stamp (`last_alerted_on`).

    Stored as a TOP-LEVEL sibling of "blockers" in the same ledger file
    (`~/.pa/human-gated-blockers.json`), deliberately OUTSIDE the "blockers"
    dict: evaluate()'s vanished-key cleanup pops any ledger key that is not a
    live "<worker>:<classification>" pair currently present in
    rate-limit-state.json, and "google-auth" (no worker in that state file)
    would be silently deleted every run if it lived inside "blockers" —
    defeating the dedup before this function ever saw it (WP-G, AI-147). The
    worker-blocker logic in evaluate()/save_ledger is intentionally untouched.
    """
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    ga = data.get("google_auth")
    return ga.get("last_alerted_on") if isinstance(ga, dict) else None


def save_google_auth_stamp(path: Path, last_alerted_on: str) -> None:
    """Read-modify-write just the "google_auth" top-level key, atomically.

    Must run AFTER save_ledger() in the same invocation — save_ledger()
    rewrites the whole file with only {updatedAt, note, blockers}, so this
    re-reads whatever save_ledger() just wrote and adds "google_auth" back as
    a sibling rather than racing it.
    """
    data: dict = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8", errors="replace"))
            if isinstance(loaded, dict):
                data = loaded
        except (json.JSONDecodeError, OSError):
            data = {}
    data["google_auth"] = {"last_alerted_on": last_alerted_on}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def load_priorities(path: Path) -> dict[str, object]:
    """worker-name -> its declared `priority:` from config.yaml. READ-ONLY —
    this script never writes config.yaml (see module docstring invariant #1)."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            data = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError):
        return {}
    workers = data.get("workers") if isinstance(data, dict) else None
    out: dict[str, object] = {}
    if isinstance(workers, list):
        for w in workers:
            if isinstance(w, dict) and w.get("name") is not None and "priority" in w:
                out[str(w["name"])] = w["priority"]
    return out


# ---------------------------------------------------------------------------
# pure evaluation (unit-tested without any filesystem or clock)
# ---------------------------------------------------------------------------

def human_gated_blockers(state: dict) -> dict[str, str]:
    """{"<worker>:<classification>": classification} for every currently-present
    human-gated cooldown. Anything self-healing is filtered out here."""
    out: dict[str, str] = {}
    for worker, cd in state.items():
        if not isinstance(cd, dict):
            continue
        classification = cd.get("classification")
        if classification in HUMAN_GATED:
            out[f"{worker}:{classification}"] = str(classification)
    return out


def age_days(first_detected_at: str, now: datetime) -> int:
    """Whole days since first_detected_at. Unparseable => 0 (never escalate on
    garbage — a corrupt timestamp must not manufacture an error-severity page)."""
    try:
        first = datetime.fromisoformat(first_detected_at)
    except (ValueError, TypeError):
        return 0
    if first.tzinfo is None:
        first = first.replace(tzinfo=timezone.utc)
    delta = now - first
    return max(delta.days, 0)


def evaluate(state: dict, ledger: dict, priorities: dict,
             now: datetime) -> tuple[list[dict], dict, list[str]]:
    """Pure end-to-end escalation pass.

    Returns (alerts, new_ledger, resolved_notes). No subprocess, no filesystem,
    no clock — `now` is injected so tests can simulate any outage age.

    Ledger discipline:
      * a currently-present blocker not yet tracked gets a fresh
        `first_detected_at = now` and NO alert (day 0);
      * one already tracked keeps its original `first_detected_at` and just
        bumps `last_confirmed_at`;
      * one no longer present in state is REMOVED, with a one-line resolved note
        only if it had ever escalated.

    Per-calendar-day dedup: an entry carries `last_alerted_on` (a date string).
    An alert fires only when age >= WARN_AFTER_DAYS AND we have not already
    alerted today, so the same day-bucket re-fires at most once per calendar day
    and never fights the unrelated per-dispatch alert's own dedup window.
    """
    present = human_gated_blockers(state)
    now_iso = now.isoformat()
    today = now.date().isoformat()
    new_ledger = dict(ledger)
    alerts: list[dict] = []
    resolved_notes: list[str] = []

    # Drop entries whose blocker is gone (worker recovered / classification
    # changed to a self-healing one). Iterate a snapshot — we mutate new_ledger.
    for key in list(new_ledger.keys()):
        if key not in present:
            entry = new_ledger.pop(key)
            if entry.get("ever_escalated"):
                worker = key.split(":", 1)[0]
                resolved_notes.append(
                    f"`{worker}` recovered — human-gated blocker `{key}` cleared "
                    f"after {age_days(entry.get('first_detected_at', now_iso), now)} day(s).")

    for key, classification in present.items():
        worker = key.split(":", 1)[0]
        entry = new_ledger.get(key)
        if entry is None:
            entry = {"first_detected_at": now_iso}
            new_ledger[key] = entry
        entry["last_confirmed_at"] = now_iso
        entry["classification"] = classification
        entry["worker"] = worker

        age = age_days(entry["first_detected_at"], now)
        if age < WARN_AFTER_DAYS:
            continue  # days 0-2: covered by the existing one-shot, no escalation
        if entry.get("last_alerted_on") == today:
            continue  # already escalated today — once per calendar day

        severity = ERROR if age >= ERROR_AFTER_DAYS else WARN
        priority = priorities.get(worker)
        alerts.append({
            "severity": severity,
            "worker": worker,
            "classification": classification,
            "age_days": age,
            "priority": priority,
        })
        entry["last_alerted_on"] = today
        entry["ever_escalated"] = True

    return alerts, new_ledger, resolved_notes


def render_report(alerts: list[dict], resolved_notes: list[str], postmortem_alerts: list[dict] | None = None,
                  google_auth_alerts: list[dict] | None = None) -> str:
    """Compact Markdown. sendToTelegram handles MarkdownV2 escaping — never
    hand-escape here (CLAUDE.md formatting rule)."""
    errors = [a for a in alerts if a["severity"] == ERROR]
    warns = [a for a in alerts if a["severity"] == WARN]
    postmortem_alerts = postmortem_alerts or []
    google_auth_alerts = google_auth_alerts or []
    lines: list[str] = []

    if errors:
        lines.append("🚨 *Human-gated worker blocker — ESCALATED (7+ days)*")
        lines.append("")
        for a in errors:
            prio = a["priority"]
            prio_txt = (f", still at *priority {prio}* in config.yaml"
                        if prio is not None else "")
            lines.append(
                f"*{a['worker']}* has been `{a['classification']}` for "
                f"*{a['age_days']} days*{prio_txt}. This fault does not self-heal — "
                f"recharge/reauth the account, or manually reprioritise the worker "
                f"in `~/.pa/config.yaml`.")
        lines.append("")
        lines.append("Nothing was changed automatically: this watchdog never edits "
                     "config.yaml. A human recharges or reprioritises.")

    if warns:
        if errors:
            lines.append("")
        lines.append("⚠️ *Human-gated worker blocker — warning (3-6 days)*")
        lines.append("")
        for a in warns:
            lines.append(
                f"*{a['worker']}* has been `{a['classification']}` for "
                f"*{a['age_days']} days*. This fault does not self-heal; it will "
                f"escalate to an error at 7 days if not resolved.")

    if resolved_notes:
        if lines:
            lines.append("")
        lines.append("*Resolved*")
        lines.append("")
        lines.extend(resolved_notes)

    if postmortem_alerts:
        if lines:
            lines.append("")
        lines.append("📋 *Postmortems — Unclosed Action Items*")
        lines.append("")
        for pm in postmortem_alerts:
            lines.append(
                f"*{pm['postmortem_file']}* — *{pm['age_days']} days* old, "
                f"*{pm['unclosed_count']}* unclosed action item(s)"
            )
            for item in pm['items']:
                lines.append(f"  - [ ] {item}")
            if pm['unclosed_count'] > 3:
                lines.append(f"  - ... and {pm['unclosed_count'] - 3} more")
        lines.append("")
        lines.append("_Postmortems live in plans/postmortems/ — close action items "
                     "by replacing `- [ ]` with `- [x]`._")

    if google_auth_alerts:
        if lines:
            lines.append("")
        lines.append("🔐 *Google auth — reauthorization required*")
        lines.append("")
        for ga in google_auth_alerts:
            skills = ga.get("skills") or []
            skills_txt = ", ".join(f"`{s}`" for s in skills) if skills else "unknown skill(s)"
            sev_txt = "ESCALATED" if ga["severity"] == ERROR else "warning"
            reason = ga.get("reason") or ""
            reason_txt = f" ({reason})" if reason else ""
            lines.append(
                f"Google authentication has been expired for *{ga['age_days']} days* "
                f"({sev_txt}), blocking {skills_txt}{reason_txt}.")
        lines.append("")
        lines.append("Send /reauth in Telegram, or run python ~/.pa/reauth_google.py on the laptop.")

    lines.append("")
    lines.append("_Ledger: ~/.pa/human-gated-blockers.json (age tracking; "
                 "config.yaml untouched)._")
    report = "\n".join(lines)
    if len(report) > MAX_REPORT_CHARS:
        report = report[: MAX_REPORT_CHARS - 3].rstrip() + "..."
    return report


def page_alerts(report: str) -> None:
    """Page pa-alerts via the repo's standard notifier — which mints the
    mandatory s-XXXXXXXXXXXX ref ID, appends it, and logs it to app.log.jsonl so
    `pa ref` can resolve it."""
    repo_root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(repo_root / "pa" / "src"))
    from telegram_notify import notify  # noqa: E402
    notify(report,
           chat_id=alert_chat_id(),
           thread_id=_secret("PA_ALERTS_THREAD_ID") or None)


def scan_postmortems(repo_root: Path, now: datetime) -> list[dict]:
    """Scan postmortem files for unclosed action items older than 30 days.

    Returns a list of alerts for action items that remain unchecked after
    POSTMORTEM_ESCALATE_DAYS. Each alert includes the postmortem file,
    the specific action item, and its age in days.

    Action items are markdown checkboxes: `- [ ]` for unclosed, `- [x]` for closed.
    """
    postmortems_dir = repo_root / "plans" / "postmortems"
    if not postmortems_dir.is_dir():
        return []

    alerts: list[dict] = []

    for pm_file in sorted(postmortems_dir.glob("*.md")):
        try:
            content = pm_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        # Extract the created date from the postmortem frontmatter
        created_at = None
        for line in content.splitlines()[:20]:  # Check first 20 lines only
            if line.strip().startswith("**Created:**"):
                try:
                    created_str = line.split("**Created:**")[1].strip()
                    created_at = datetime.fromisoformat(created_str)
                    if created_at.tzinfo is None:
                        created_at = created_at.replace(tzinfo=timezone.utc)
                    break
                except (ValueError, IndexError):
                    continue

        if not created_at:
            continue

        age_days = (now - created_at).days
        if age_days < POSTMORTEM_ESCALATE_DAYS:
            continue

        # Find unclosed action items (markdown checkboxes)
        unclosed_items: list[str] = []
        for line in content.splitlines():
            stripped = line.strip()
            # Match "- [ ]" (unclosed) but not "- [x]" (closed)
            if stripped.startswith("- [ ] ") and not stripped.startswith("- [x]"):
                item_text = stripped[6:]  # Remove "- [ ] " prefix
                unclosed_items.append(item_text)

        if unclosed_items:
            alerts.append({
                "severity": WARN,
                "postmortem_file": pm_file.name,
                "age_days": age_days,
                "unclosed_count": len(unclosed_items),
                "items": unclosed_items[:3],  # Limit to first 3 to keep report size manageable
            })

    return alerts


def scan_google_auth(marker_path: Path, token_path: Path, now: datetime) -> list[dict]:
    """Third human-gated-blocker family (WP-G, AI-147), modelled on
    scan_postmortems: reads the standing "blocked on Google reauth" marker
    written by pa/scripts/google_reauth_kick.py and turns it into an
    escalating alert.

    Unlike the worker-blocker ledger, "first_seen" lives IN the marker file
    itself (kick.py preserves it across repeated blocks), so this scan needs
    no ledger for AGE tracking — only the caller's daily-dedup stamp
    (load/save_google_auth_stamp) needs the ledger.

    Returns [] when there is no marker, or when the marker is RESOLVED: a
    google-token.json whose mtime is later than the marker's "first_seen"
    proves a successful reauth happened after the block began, so the marker
    is deleted here and [] is returned. Otherwise returns exactly one alert
    dict; severity is None for days 0-2 (track-but-silent, the same
    convention as evaluate()'s day-0-2 worker-blocker window).
    """
    if not marker_path.exists():
        return []
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(marker, dict) or not marker.get("first_seen"):
        return []

    if token_path.exists():
        try:
            token_mtime = datetime.fromtimestamp(token_path.stat().st_mtime, tz=timezone.utc)
            first_seen = datetime.fromisoformat(marker["first_seen"])
            if first_seen.tzinfo is None:
                first_seen = first_seen.replace(tzinfo=timezone.utc)
            if token_mtime > first_seen:
                marker_path.unlink(missing_ok=True)
                return []
        except (OSError, ValueError, TypeError):
            pass  # can't prove resolution from a malformed timestamp — keep tracking

    age = age_days(marker["first_seen"], now)
    severity = ERROR if age >= ERROR_AFTER_DAYS else WARN if age >= WARN_AFTER_DAYS else None
    return [{
        "kind": "google-auth",
        "age_days": age,
        "skills": marker.get("skills") or [],
        "reason": str(marker.get("reason") or "")[:200],
        "severity": severity,
    }]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Escalating daily watchdog for human-gated worker blockers.")
    parser.add_argument("--state", help="Override the rate-limit-state.json path (tests).")
    parser.add_argument("--ledger", help="Override the ledger path (tests).")
    parser.add_argument("--config", help="Override the config.yaml path (tests). READ-ONLY.")
    parser.add_argument("--now", help="ISO timestamp to use as the clock (tests).")
    parser.add_argument("--no-send", action="store_true",
                        help="Report without paging pa-alerts (tests / manual).")
    parser.add_argument("--no-write", action="store_true",
                        help="Do not update the ledger (tests / manual).")
    args = parser.parse_args(argv)

    home = pa_home()
    state_path = Path(args.state) if args.state else home / "rate-limit-state.json"
    ledger_path = Path(args.ledger) if args.ledger else home / "human-gated-blockers.json"
    config_path = Path(args.config) if args.config else home / "config.yaml"
    GOOGLE_AUTH_MARKER = home / "google-auth-blocked.json"
    GOOGLE_TOKEN = home / "google-token.json"
    if args.now:
        now = datetime.fromisoformat(args.now)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
    else:
        now = datetime.now(timezone.utc)

    state = load_state(state_path)
    ledger = load_ledger(ledger_path)
    priorities = load_priorities(config_path)
    # Read BEFORE save_ledger() below: save_ledger() unconditionally
    # overwrites the whole ledger file with only {updatedAt, note, blockers}
    # (no read-modify-write), which would otherwise clobber "google_auth"
    # before this run ever got to compare against it.
    previous_google_auth_stamp = load_google_auth_stamp(ledger_path)

    alerts, new_ledger, resolved_notes = evaluate(state, ledger, priorities, now)

    if not args.no_write:
        try:
            save_ledger(ledger_path, new_ledger, now)
        except OSError as e:
            # A ledger-write failure must never suppress the alerts themselves.
            print(f"human-gated-blocker-watch: ledger write failed: {e}", file=sys.stderr)

    # WPD6: Scan postmortems for unclosed action items
    repo_root = Path(__file__).resolve().parents[3]
    postmortem_alerts = scan_postmortems(repo_root, now)

    # WP-G (AI-147): third human-gated-blocker family — Google reauth. The
    # dedup WRITE must run AFTER save_ledger() above so save_google_auth_stamp()'s
    # read-modify-write sees the "blockers"/"updatedAt"/"note" keys
    # save_ledger() just wrote, not a stale copy — but the dedup READ (above)
    # must happen BEFORE save_ledger(), for the same reason in reverse.
    today = now.date().isoformat()
    google_auth_alerts: list[dict] = []
    for raw in scan_google_auth(GOOGLE_AUTH_MARKER, GOOGLE_TOKEN, now):
        if raw["severity"] is None:
            continue  # days 0-2: tracked in the marker file itself, no alert
        if previous_google_auth_stamp == today:
            continue  # already alerted today — once per calendar day
        google_auth_alerts.append(raw)
        if not args.no_write:
            try:
                save_google_auth_stamp(ledger_path, today)
            except OSError as e:
                print(f"human-gated-blocker-watch: google-auth stamp write failed: {e}", file=sys.stderr)

    if not alerts and not resolved_notes and not postmortem_alerts and not google_auth_alerts:
        # Empty stdout from a skill declaring telegram_output is a HARD FAILURE
        # (2026-07-21); without this sentinel the watchdog would fail every quiet
        # day and eventually be parked by the AI-098 failure-backoff ladder — i.e.
        # the blocker watchdog would silently stop watching. Day 0-2 tracking is a
        # quiet day: the ledger updated, but there is nothing to page yet.
        print("NO_OUTPUT")
        return 0

    report = render_report(alerts, resolved_notes, postmortem_alerts, google_auth_alerts)
    print(report)

    if (alerts or postmortem_alerts or google_auth_alerts) and not args.no_send:
        try:
            page_alerts(report)
        except Exception as e:  # noqa: BLE001 — stdout already carries the report
            print(f"(pa-alerts page could not be sent: {e})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
