#!/usr/bin/env python3
"""Deterministic Agentic-Brain integrity scan. Emits JSON findings on stdout.

Backs the `brain-recheck` skill. Every number and every existence check in that
skill's report is produced here; the worker's only remaining job is to format
this JSON into the Telegram block.

Why this exists
---------------
`brain-recheck` used to ask a gemini worker to count the internal plan-index rows and
stat files by hand. Two verified failures in the 2026-07-16..21 audit window:

  * It mis-counted INDEX.md in all four gemini runs (reported 43 completed vs
    62 actual on 2026-07-17). Counting is arithmetic, and CLAUDE.md is explicit
    that deterministic decisions belong in a committed script invoked by
    absolute path — the same rule that exists because LLM date math silently
    killed four Ekadashi alerts.
  * Two of its six check families were silently dropped in ALL four runs with
    "Path not in workspace": the gemini shim forces cwd to the repo root and
    `--yolo` sandboxes file tools to that tree, so `~/.claude` and `~/.pa` were
    unreachable. A plain Python process has no such sandbox.

Exit code is always 0 — findings are data, not a failure signal.

Usage:  python "C:/pa-checkout/projects/pa-maintenance/scripts/brain_recheck_scan.py"
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPTS_DIR.parents[2]  # scripts -> pa-maintenance -> projects -> repo root

def local_tz():
    """PA_TZ_OFFSET_MINUTES (minutes east of UTC) or UTC when unset — a loud
    stderr warning replaces the old silent IST default (WB-54)."""
    raw = os.environ.get("PA_TZ_OFFSET_MINUTES")
    if raw is None or raw == "":
        print("[brain-recheck] PA_TZ_OFFSET_MINUTES not set — defaulting to UTC (was IST before 2026-09-17)", file=sys.stderr)
        return timezone.utc
    try:
        return timezone(timedelta(minutes=int(raw)))
    except ValueError:
        print(f"[brain-recheck] PA_TZ_OFFSET_MINUTES={raw!r} is not an integer — defaulting to UTC", file=sys.stderr)
        return timezone.utc


# Back-compat alias; evaluated per call, never a cached import-time offset.
IST = local_tz

STALE_MEMORY_DAYS = 60
OVERDUE_PLAN_DAYS = 21
AGED_BACKLOG_DAYS = 30

# Status classification is by LEADING clause only: "Approved, pending impl" is
# pending even though it also says "impl", and "Completed, deployed — ..." is
# completed even though the tail can mention pending follow-ups.
COMPLETED_LEADS = ("completed", "complete", "implemented", "resolved", "done",
                   "deployed", "closed", "shipped", "fixed", "restored",
                   "remediated", "bom", "built", "verified", "audit", "assessment",
                   "research", "report", "operator-confirmed", "operator-approved",
                   "both", "all", "waves", "phases", "phase")
PENDING_LEADS = ("approved", "proposed", "pending", "planned", "draft",
                 "blocked", "in", "spec", "plan", "stage-1", "intent", "todo",
                 "awaiting", "scoping", "proposal")
LIVING_LEADS = ("living",)
SUPERSEDED_LEADS = ("replaced", "superseded", "obsolete", "abandoned", "not", "deprecated")

# Only these top-level directories are treated as repo-relative path references.
# Deliberately tight: CLAUDE.md is full of backticked identifiers that merely
# look path-ish (`logger.ts`, `${PA_HOME}`, `~/.pa/config.yaml`, `C:\...`).
# NOTE: no bare "scripts/" — the repo has no top-level scripts/, and CLAUDE.md
# uses project-relative "scripts/x.py" mentions that are not repo-relative paths.
REPO_PATH_PREFIXES = ("pa/", "projects/", "plans/", "docs/", "examples/", ".github/")

BACKTICK_RE = re.compile(r"`([^`\n]+)`")
# `-   pa/src/analyzer.ts: Conversation pattern analysis…` — the bare list-item
# form inventory/*.md uses for every entry (and CLAUDE.md for its project and
# auth inventories). Anchored to the list marker so prose mid-sentence is not
# picked up here.
LIST_ENTRY_RE = re.compile(r"^\s*-\s+([^\s:]+):\s", re.M)
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)\)")
SKILL_COUNT_RE = re.compile(r"\*\*(\d+)\s+skills?\s+total\*\*|(\d+)\s+skills?\s+total", re.I)
SKILL_BREAKDOWN_RE = re.compile(r"\((\d+)\s+scheduled,\s*(\d+)\s+manual", re.I)
BACKLOG_ITEM_RE = re.compile(r"^####\s*\[([A-Za-z]+-\d+)\]\s*(.+?)\s*$", re.M)
BACKLOG_STATUS_RE = re.compile(r"\*\*Status:\*\*\s*([A-Z][A-Z ]*[A-Z]|[A-Z]+)")
BACKLOG_LOGGED_RE = re.compile(r"\*Logged:\s*(\d{4}-\d{2}-\d{2})")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
AI_ID_RE = re.compile(r"\b([A-Z]{2,}-\d+)\b")
RUNBOOK_RE = re.compile(r"runbook:\s*([^\s/]+(?:/[^\s/]+)*)")


# --------------------------------------------------------------------------
# plan index (internal plans register)
# --------------------------------------------------------------------------

def classify_status(status: str) -> str:
    """'completed' | 'pending' | 'living' | 'superseded' | 'unknown'."""
    raw = (status or "").strip().strip("*_`")
    lead = re.split(r"[,—–(]| - ", raw)[0].strip().lower()
    first = lead.split()[0] if lead.split() else ""
    first = first.strip("*_`")
    if first in LIVING_LEADS:
        return "living"
    if first in SUPERSEDED_LEADS:
        return "superseded"
    if first in COMPLETED_LEADS:
        return "completed"
    if first in PENDING_LEADS:
        tail_words = set(re.findall(r"\b[a-z]+\b", raw.lower()))
        if tail_words & {"completed", "complete", "implemented", "deployed", "built", "verified", "done", "shipped"}:
            return "completed"
        return "pending"
    return "unknown"


def parse_index_rows(text: str) -> list[dict]:
    """Data rows of the plans index table: {date, title, status, link, klass}."""
    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        # Split only on pipes NOT preceded by backslash (escape-aware)
        cells = [c.strip() for c in re.split(r'(?<!\\)\|', line)]
        # Drop empty first/last parts from structural border pipes
        if len(cells) >= 2 and cells[0] == "":
            cells = cells[1:]
        if len(cells) >= 2 and cells[-1] == "":
            cells = cells[:-1]
        if len(cells) < 4:
            continue
        # Unescape: replace \| with | in each cell
        cells = [c.replace("\\|", "|") for c in cells]
        if cells[0].lower() == "date":
            continue
        if set(cells[0]) <= set("-: ") and cells[0]:
            continue
        rows.append({
            "date": cells[0],
            "title": cells[1],
            "status": cells[2],
            "link": cells[3],
            "klass": classify_status(cells[2]),
        })
    return rows


def index_counts(rows: list[dict]) -> dict:
    counts = {"total": len(rows), "completed": 0, "pending": 0,
              "living": 0, "superseded": 0, "unknown": 0}
    for r in rows:
        counts[r["klass"]] += 1
    return counts


def local_plan_links(rows: list[dict]) -> list[str]:
    """Relative .md targets from the Link cell (`[Local](./x.md)`)."""
    targets = []
    for r in rows:
        for _label, target in MD_LINK_RE.findall(r["link"]):
            if target.endswith(".md") and not target.startswith(("http://", "https://")):
                targets.append(target)
    return targets


# --------------------------------------------------------------------------
# path references
# --------------------------------------------------------------------------

def _keep_repo_path(candidate: str, seen: dict) -> None:
    if not candidate or not candidate.startswith(REPO_PATH_PREFIXES):
        return
    if re.search(r"[\s*?<>|\"$~`]|\.\.", candidate):
        return
    seen.setdefault(candidate, None)


def extract_repo_paths(text: str) -> list[str]:
    """Repo-relative paths referenced by a brain file, de-duplicated, in order.

    Two forms, because ONE of them alone is a near no-op: backticked mentions,
    and the bare `-   pa/src/x.ts: description` list-item form. inventory/*.md
    (FILE_INVENTORY.md's post-2026-08-07 split; the format is unchanged, only
    the file it lives in) writes the great majority of its entries in the
    second form and backticks only a handful incidentally, so a backtick-only
    extractor validated 5 of them and silently vetted nothing else
    (2026-07-21). Both forms are collected here.
    """
    seen: dict[str, None] = {}
    for token in BACKTICK_RE.findall(text):
        candidate = token.strip().split("::", 1)[0]  # pytest node ids: file.py::TestX
        candidate = candidate.strip().strip(".,;:")
        candidate = re.sub(r":\d+(-\d+)?$", "", candidate)  # file.ts:124 / :10-20
        _keep_repo_path(candidate.rstrip("/"), seen)
    for token in LIST_ENTRY_RE.findall(text):
        _keep_repo_path(token.strip().rstrip("/"), seen)
    return list(seen)


def memory_links(text: str) -> list[str]:
    """Memory-file targets from MEMORY.md's index links."""
    out: dict[str, None] = {}
    for _label, target in MD_LINK_RE.findall(text):
        if target.endswith(".md") and "/" not in target and not target.startswith("http"):
            out.setdefault(target, None)
    return list(out)


# --------------------------------------------------------------------------
# skills
# --------------------------------------------------------------------------

def parse_skill_claim(text: str) -> dict | None:
    """CLAUDE.md's own claim about skill counts, or None if it makes none."""
    m = SKILL_COUNT_RE.search(text)
    if not m:
        return None
    claim = {"total": int(m.group(1) or m.group(2))}
    b = SKILL_BREAKDOWN_RE.search(text[m.end():m.end() + 120])
    if b:
        claim["scheduled"] = int(b.group(1))
        claim["manual"] = int(b.group(2))
    return claim


def count_skills(skills_dir: Path) -> dict:
    total = scheduled = 0
    if not skills_dir.is_dir():
        return {"total": 0, "scheduled": 0, "manual": 0}
    for child in sorted(skills_dir.iterdir()):
        skill_file = child / "skill.md"
        if not (child.is_dir() and skill_file.is_file()):
            continue
        total += 1
        head = skill_file.read_text(encoding="utf-8", errors="replace")[:2000]
        if re.search(r"^cron:", head, re.M):
            scheduled += 1
    return {"total": total, "scheduled": scheduled, "manual": total - scheduled}


# --------------------------------------------------------------------------
# BACKLOG.md
# --------------------------------------------------------------------------

def parse_backlog_items(text: str) -> list[dict]:
    """{id, title, status, logged} per `#### [AI-nnn]` block."""
    items = []
    matches = list(BACKLOG_ITEM_RE.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[m.end():end]
        status = BACKLOG_STATUS_RE.search(block)
        logged = BACKLOG_LOGGED_RE.search(block)
        items.append({
            "id": m.group(1),
            "title": m.group(2),
            "status": (status.group(1).strip() if status else "UNKNOWN"),
            "logged": (logged.group(1) if logged else None),
        })
    return items


def days_since(iso: str, today: date) -> int | None:
    if not iso or not ISO_DATE_RE.match(iso):
        return None
    try:
        return (today - date.fromisoformat(iso)).days
    except ValueError:
        return None


# --------------------------------------------------------------------------
# scan
# --------------------------------------------------------------------------

def default_memory_dir(repo_root: Path) -> Path:
    """Claude Code encodes the project path by replacing [:/\\ .] with '-'."""
    slug = re.sub(r"[:/\\ .]", "-", str(repo_root))
    return Path.home() / ".claude" / "projects" / slug / "memory"


def default_skills_dir() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa")) / "skills"


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def scan(repo_root: Path, memory_dir: Path, skills_dir: Path, today: date) -> dict:
    issues: list[dict] = []

    def issue(severity: str, kind: str, detail: str) -> None:
        issues.append({"severity": severity, "kind": kind, "detail": detail})

    claude_md = _read(repo_root / "CLAUDE.md")
    inventory_router_md = _read(repo_root / "FILE_INVENTORY.md")
    # FILE_INVENTORY.md was split into inventory/*.md on 2026-08-07 (see
    # docs/CONVENTIONS.md § "Brain-file organization"). The router file that
    # remains at repo root only holds a path-prefix table + a handful of
    # orphan entries -- the real ~150-entry corpus this scan checks links
    # against now lives in inventory/*.md. Each (label, text) pair keeps its
    # own source label so a BROKEN LINK issue names the actual file to fix,
    # not a generic "FILE_INVENTORY.md" that hasn't held that content since
    # this date.
    inventory_sources = [("FILE_INVENTORY.md", inventory_router_md)] + [
        (f"inventory/{p.name}", _read(p))
        for p in sorted((repo_root / "inventory").glob("*.md"))
    ]
    index_md = _read(repo_root / "plans" / "INDEX.md")
    backlog_root_md = _read(repo_root / "BACKLOG.md")
    # BACKLOG.md was dedupe-fixed and split on 2026-08-07: completed items now
    # live in backlog/*.md, keyed the same #### [AI-nnn] way as the root file.
    backlog_archive_paths = sorted((repo_root / "backlog").glob("*.md"))
    backlog_md = backlog_root_md + "".join(
        "\n" + _read(p) for p in backlog_archive_paths
    )
    memory_md = _read(memory_dir / "MEMORY.md")

    missing_sources = [name for name, txt in (
        ("CLAUDE.md", claude_md), ("plan index (internal)", index_md),
        ("BACKLOG.md", backlog_root_md), ("MEMORY.md", memory_md)) if not txt]
    for name in missing_sources:
        issue("critical", "MISSING BRAIN FILE", name)
    # inventory/ went from "doesn't exist yet" (pre-split) to "the entire file
    # inventory lives here" (post-split) -- if the directory is empty or
    # absent, every BROKEN LINK check below silently iterates zero entries
    # and reports nothing, which reads as "all clean" rather than "couldn't
    # check". Treat that the same as any other missing brain file.
    if len(inventory_sources) <= 1 or not any(txt for _, txt in inventory_sources[1:]):
        issue("critical", "MISSING BRAIN FILE", "inventory/")

    # --- broken repo-path references -------------------------------------
    for source, text in [("CLAUDE.md", claude_md)] + inventory_sources:
        for rel in extract_repo_paths(text):
            if not (repo_root / rel).exists():
                issue("critical", "BROKEN LINK", f"{source} references missing `{rel}`")

    # --- broken plan links ------------------------------------------------
    rows = parse_index_rows(index_md)
    plans_dir = repo_root / "plans"
    for target in local_plan_links(rows):
        if not (plans_dir / target).resolve().exists():
            issue("critical", "BROKEN LINK", f"plan index (internal) links missing `{target}`")

    # --- broken memory links ---------------------------------------------
    for target in memory_links(memory_md):
        if not (memory_dir / target).exists():
            issue("critical", "BROKEN LINK", f"MEMORY.md links missing `{target}`")

    # --- skill count mismatch --------------------------------------------
    claim = parse_skill_claim(claude_md)
    actual = count_skills(skills_dir)
    if claim:
        if claim["total"] != actual["total"]:
            issue("warning", "COUNT MISMATCH",
                  f"CLAUDE.md says {claim['total']} skills, {actual['total']} on disk")
        if "scheduled" in claim and claim["scheduled"] != actual["scheduled"]:
            issue("warning", "COUNT MISMATCH",
                  f"CLAUDE.md says {claim['scheduled']} scheduled, "
                  f"{actual['scheduled']} on disk")
    else:
        issue("warning", "COUNT MISMATCH", "CLAUDE.md states no skill total to check")

    # --- overdue pending plans -------------------------------------------
    for r in rows:
        if r["klass"] != "pending":
            continue
        age = days_since(r["date"], today)
        if age is not None and age > OVERDUE_PLAN_DAYS:
            issue("warning", "OVERDUE PLAN", f"{r['title'][:90]} — pending {age} days")

    # --- stale pending (INDEX says pending, BACKLOG says DONE) ------------
    backlog_items = parse_backlog_items(backlog_md)
    done_ids = {i["id"] for i in backlog_items if i["status"].startswith("DONE")}
    for r in rows:
        if r["klass"] != "pending":
            continue
        for ref in AI_ID_RE.findall(r["title"]):
            if ref in done_ids:
                issue("warning", "STALE PENDING",
                      f"{ref} is DONE in BACKLOG.md but INDEX.md row "
                      f"({r['date']}) still reads '{r['status'][:40]}'")

    # --- aged backlog items ----------------------------------------------
    for item in backlog_items:
        if item["status"] != "PENDING":
            continue
        age = days_since(item["logged"], today)
        if age is not None and age > AGED_BACKLOG_DAYS:
            issue("info", "AGED BACKLOG ITEM",
                  f"{item['id']} logged {age} days ago — {item['title'][:70]}")

    # --- stale memory files ----------------------------------------------
    if memory_dir.is_dir():
        for f in sorted(memory_dir.glob("*.md")):
            mtime = datetime.fromtimestamp(f.stat().st_mtime, local_tz()).date()
            age = (today - mtime).days
            if age > STALE_MEMORY_DAYS:
                issue("info", "STALE MEMORY", f"{f.name} last updated {age} days ago")

    counts = index_counts(rows)
    if counts["unknown"]:
        issue("info", "UNCLASSIFIED PLAN STATUS",
              f"{counts['unknown']} INDEX.md row(s) have a status this scan "
              f"cannot classify — extend classify_status()")

    # --- broken runbook references -------------------------------------------
    # WPD6: Check for references to runbooks in postmortem files that don't exist
    runbooks_dir = repo_root / "plans" / "runbooks"
    postmortems_dir = repo_root / "plans" / "postmortems"
    if postmortems_dir.is_dir():
        for pm_file in sorted(postmortems_dir.glob("*.md")):
            try:
                content = pm_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            # Look for runbook references like "Runbook: <slug>" or markdown links
            for match in MD_LINK_RE.finditer(content):
                label, target = match.groups()
                # Only check relative links that look like runbook references
                if target.startswith("../runbooks/") or "runbook" in label.lower():
                    runbook_path = (pm_file.parent / target).resolve()
                    if not runbook_path.exists():
                        issue("warning", "BROKEN RUNBOOK REF",
                              f"{pm_file.name} references missing runbook `{target}`")

    severities = [i["severity"] for i in issues]
    return {
        "generatedAt": datetime.now(local_tz()).isoformat(),
        "today": today.isoformat(),
        "repoRoot": str(repo_root),
        "index": counts,
        "skills": {"claimed": claim, "actual": actual},
        "backlog": {"total": len(backlog_items),
                    "pending": sum(1 for i in backlog_items if i["status"] == "PENDING"),
                    "done": len(done_ids)},
        "summary": {
            "issues": len(issues),
            "critical": severities.count("critical"),
            "warnings": severities.count("warning"),
            "info": severities.count("info"),
        },
        "issues": issues,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(REPO_ROOT))
    parser.add_argument("--memory-dir")
    parser.add_argument("--skills-dir")
    parser.add_argument("--today", help="Override today's date (YYYY-MM-DD) — tests only.")
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    memory_dir = Path(args.memory_dir) if args.memory_dir else default_memory_dir(repo_root)
    skills_dir = Path(args.skills_dir) if args.skills_dir else default_skills_dir()
    today = date.fromisoformat(args.today) if args.today else datetime.now(local_tz()).date()

    print(json.dumps(scan(repo_root, memory_dir, skills_dir, today),
                     indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
