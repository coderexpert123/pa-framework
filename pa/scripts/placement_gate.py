#!/usr/bin/env python3
"""Placement registry -> public-path projection -> public-sync gate (placement Phase 3, P1).

One script, two subcommands:

  gen --registry <path> --out <path>
      Parse the registry's census tables (12-cell rows under `##` headings) and derive
      the public-path projection: ALLOW globs (R1 every PUBLIC row, R2 every
      public-tracked-boundary row even when SPLIT, R3 every uncovered SPLIT surface as
      `assumed: true` with a loud SPLIT-ASSUMED-PUBLIC warning on stderr), DENY globs
      (exact-file PRIVATE surfaces only; dir/glob PRIVATE surfaces never deny). Written
      atomically (tmp + os.replace). Success line:
      PLACEMENT-PROJECTION OK rows=%d allow=%d deny=%d assumed=%d -> <out>

  check --registry <path> --projection <path> --public-repo <dir> [--flags-file <path>]
      Freshness-check the projection against the current registry sha256 (exit 3 on
      mismatch), then classify every mirror-new file (`git ls-files --others
      --exclude-standard`): a DENY match or no ALLOW match refuses the file, prints
      PLACEMENT-UNKNOWN: <path> and appends one flag record unless an UNRESOLVED flag
      for the same file already exists (then PLACEMENT-FLAG-EXISTS: <file>).
      PLACEMENT-GATE OK new=<n> (exit 0) or PLACEMENT-GATE REFUSED files=<n> (exit 2).

Exit codes: 0 ok | 2 refusal | 3 stale projection | 4 usage/parse. Nothing else.
(argparse's own error exit is overridden to 4 so it cannot collide with refusal's 2.)

Flag-schema join contract: each appended flag is one JSON line with keys in exactly
this order — timestamp (UTC, %Y-%m-%dT%H:%M:%SZ, second precision, literal Z),
file, reason, category ("placement-unknown"), run ("push-public"). The
investigate-flagged skill joins resolutions on the byte-exact `<timestamp>::<file>`
key, so neither field may ever change format.

Coupling note: the registry's 12-cell table grammar is shared with
scratch/placement-audit/check_completeness.py — a schema change must move both
parsers; the projection's registry_sha256 freshness check turns drift into exit 3,
never silent mismatch.

Engineering rules: stdlib only; git spawns carry creationflags=CREATE_NO_WINDOW on
win32; the registry path arrives only via --registry (this file is public-tracked and
must stay free of private-path literals); matching is case-sensitive over git's
forward-slash output (fnmatchcase); `~/`-prefixed surfaces are runtime-only and never
projected.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import namedtuple
from datetime import datetime, timezone

EXIT_OK = 0
EXIT_REFUSED = 2
EXIT_STALE = 3
EXIT_USAGE = 4

CREATE_NO_WINDOW = 0x08000000

DEFAULT_FLAGS_FILE = os.environ.get('PA_HOME', os.path.expanduser('~/.pa')) + '/public-mirror-flags.jsonl'

# Shared census-table grammar (see the coupling note above).
HEADER_CELLS = ["feature", "surfaces", "boundary", "verdict", "split-line", "tier",
                "rationale", "evidence", "gen-owed", "confidence", "provenance", "status"]
ASK_ROW = ["feature", "census", "question for operator"]
CENSUS_TOKEN_RE = re.compile(r"N(2B|2C|3B|3C|4|5|6|1|2|3)", re.IGNORECASE)
CENSUS_IDS = ["N1", "N2", "N2b", "N2c", "N3", "N3b", "N3c", "N4", "N5", "N6"]

FLAG_REASON = "new-to-mirror file matches no public-eligible placement-registry row"

Row = namedtuple("Row", ["feature", "census", "boundary", "verdict", "split_line",
                         "surfaces_raw", "lineno"])


class RegistryParseError(Exception):
    """Registry text violates the shared 12-cell census-table grammar."""


class PlacementGateError(Exception):
    """Projection derivation or gate input hit a hard error (exit 4)."""


class Projection(object):
    """Derived public-path projection; to_dict fixes the on-disk JSON key order."""

    def __init__(self):
        self.rows = 0
        self.allow = []     # {feature, census, verdict, glob, assumed}
        self.deny = []      # {feature, census, glob}
        self.warnings = []  # SPLIT-ASSUMED-PUBLIC lines, printed to stderr by gen

    @property
    def assumed(self):
        return sum(1 for e in self.allow if e.get("assumed"))

    def to_dict(self, registry, registry_sha256, generated_at):
        return {
            "version": 1,
            "generated_at": generated_at,
            "registry": registry,
            "registry_sha256": registry_sha256,
            "counts": {"rows": self.rows, "allow": len(self.allow),
                       "deny": len(self.deny), "assumed": self.assumed},
            "allow": self.allow,
            "deny": self.deny,
        }


# ---------------------------------------------------------------------------
# Registry parsing (shared grammar with the completeness checker)
# ---------------------------------------------------------------------------

def census_of_heading(text):
    m = CENSUS_TOKEN_RE.search(text)
    if not m:
        return None
    token = "N" + m.group(1).upper()
    for cid in CENSUS_IDS:
        if token == cid.upper():
            return cid
    return None


def split_cells(line):
    """A table row starts and ends with '|' and splits on the inner pipes. Cells never
    carry pipes themselves: a stray (unescaped) '|' inside a cell simply produces extra
    cells, so it surfaces as the !=12-cells error at the caller."""
    s = line.strip()
    if not s.startswith("|") or not s.endswith("|"):
        raise RegistryParseError("row does not start and end with '|': %r" % s[:80])
    return [c.strip() for c in s[1:-1].split("|")]


def is_separator(cells):
    return len(cells) > 0 and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


def parse_registry_rows(lines):
    """Census-table rows only. Header-anchored, because the registry legitimately
    carries other table schemas (the 3-cell ask table) and a Phase-2 gaps VIEW whose
    12-cell rows mirror the main censuses — emitting either would break gen on the
    real registry. Rows outside a census section are skipped; rows inside one with
    !=12 cells (including the unescaped-'|' shape) are a RegistryParseError."""
    rows = []
    cur_census = None
    cur_schema = None
    for lineno, raw in enumerate(lines, start=1):
        s = raw.strip()
        if not s:
            continue
        if s.startswith("#"):
            cur_census = census_of_heading(s.lstrip("#").strip())
            cur_schema = None
            continue
        if not s.startswith("|"):
            continue  # narrative prose between tables is not rows
        cells = split_cells(s)
        if is_separator(cells):
            continue
        if cells == HEADER_CELLS:
            cur_schema = "census"
            continue
        if cells == ASK_ROW:
            cur_schema = "ask"
            continue
        if cur_census is None or cur_schema != "census":
            continue  # ask / gaps-view / brain-proposal tables: not census rows
        if len(cells) != 12:
            raise RegistryParseError(
                "line %d: census row has %d cells (need 12; an unescaped '|' inside a "
                "cell also yields this)" % (lineno, len(cells)))
        rows.append(Row(feature=cells[0], census=cur_census, boundary=cells[2],
                        verdict=cells[3], split_line=cells[4], surfaces_raw=cells[1],
                        lineno=lineno))
    return rows


# ---------------------------------------------------------------------------
# Surface classification and matching semantics
# ---------------------------------------------------------------------------

def classify_surface(s):
    """'runtime' (~/-prefixed, dropped everywhere), 'prose' (wordy, no path shape),
    else 'path'."""
    if s.startswith("~/"):
        return "runtime"
    if " " in s and "/" not in s and "." not in s:
        return "prose"
    return "path"


def norm_surface(s):
    return s.strip().lstrip("/")


def is_dir_surface(s):
    """Shared matching semantics: a trailing '/' or the lack of a dot-extension means
    directory prefix, not a file."""
    n = norm_surface(s)
    return n.endswith("/") or "." not in n


def is_exact_file(s):
    n = norm_surface(s)
    return "*" not in n and not is_dir_surface(n)


def glob_match(glob_form, path):
    """Case-sensitive over git's forward-slash output. `*` -> fnmatch; a dir surface
    prefix-matches everything under it; else exact equality."""
    g = norm_surface(glob_form)
    p = path.replace("\\", "/").lstrip("/")
    if "*" in g:
        return fnmatch.fnmatchcase(p, g)
    if is_dir_surface(g):
        base = g.rstrip("/")
        return p == base or p.startswith(base + "/")
    return p == g


# ---------------------------------------------------------------------------
# Projection derivation (R1-R3 + DENY)
# ---------------------------------------------------------------------------

def _covered(row, norm, pool):
    """Covered = equal to, glob-matched by, or under another row's dir-prefix surface."""
    for other_id, other in pool:
        if other_id == id(row):
            continue
        if norm == other:
            return True
        if "*" in other and fnmatch.fnmatchcase(norm, other):
            return True
        base = other.rstrip("/")
        if base and is_dir_surface(other) and norm.startswith(base + "/"):
            return True
    return False


def derive(rows):
    proj = Projection()
    proj.rows = len(rows)
    parsed = []
    for row in rows:
        entries = []
        for s in (p.strip() for p in row.surfaces_raw.split(";")):
            if not s:
                continue
            kind = classify_surface(s)
            if kind == "runtime":
                continue  # ~/ runtime-only surfaces never project
            if kind == "prose":
                if row.verdict in ("PUBLIC", "SPLIT"):
                    raise PlacementGateError(
                        "row %r (census %s, line %d): prose surface %r is not a repo "
                        "path" % (row.feature, row.census, row.lineno, s))
                continue  # PRIVATE-row prose describes runtime state, not a path
            entries.append((s, norm_surface(s)))
        parsed.append(entries)

    # Coverage pool for R3: every path surface of every row, tagged with row identity
    # so a row never covers itself.
    pool = [(id(row), norm)
            for row, entries in zip(rows, parsed)
            for _raw, norm in entries]

    for row, entries in zip(rows, parsed):
        for _raw, norm in entries:
            if row.verdict == "PUBLIC":  # R1
                proj.allow.append({"feature": row.feature, "census": row.census,
                                   "verdict": row.verdict, "glob": norm,
                                   "assumed": False})
            elif row.verdict == "SPLIT":
                if row.boundary == "public-tracked":  # R2: content-level split, whole file public
                    proj.allow.append({"feature": row.feature, "census": row.census,
                                       "verdict": row.verdict, "glob": norm,
                                       "assumed": False})
                elif _covered(row, norm, pool):  # R3 suppression
                    continue
                else:  # R3: uncovered split half assumed public, loudly
                    proj.allow.append({"feature": row.feature, "census": row.census,
                                       "verdict": row.verdict, "glob": norm,
                                       "assumed": True})
                    proj.warnings.append("SPLIT-ASSUMED-PUBLIC: %s %s"
                                         % (row.feature, norm))
            elif row.verdict == "PRIVATE":
                # DENY is belt-and-suspenders under the boundary: exact files only.
                # Dir/glob PRIVATE surfaces coexist with re-includes and never deny.
                if is_exact_file(_raw):
                    proj.deny.append({"feature": row.feature, "census": row.census,
                                      "glob": norm})
    return proj


# ---------------------------------------------------------------------------
# gen
# ---------------------------------------------------------------------------

def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def sha256_hex(data):
    return hashlib.sha256(data).hexdigest()


def utc_z(now=None):
    """UTC %Y-%m-%dT%H:%M:%SZ — the investigate-flagged join-key format."""
    dt = now if now is not None else datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cmd_gen(args):
    reg_bytes = read_bytes(args.registry)
    rows = parse_registry_rows(reg_bytes.decode("utf-8").splitlines())
    proj = derive(rows)
    for warning in proj.warnings:
        print(warning, file=sys.stderr)
    payload = proj.to_dict(registry=args.registry, registry_sha256=sha256_hex(reg_bytes),
                           generated_at=utc_z())
    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    tmp_path = args.out + ".tmp"
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp_path, args.out)  # atomic write: readers never see a torn projection
    print("PLACEMENT-PROJECTION OK rows=%d allow=%d deny=%d assumed=%d -> %s"
          % (proj.rows, len(proj.allow), len(proj.deny), proj.assumed, args.out))
    return EXIT_OK


# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------

def git_new_candidates(public_repo):
    """Mirror-new files = untracked, exclude-respecting (the boundary stays authority
    #1; the tracked/untracked set side-steps the check-ignore negation exit-code
    landmine)."""
    cmd = ["git", "-C", public_repo, "ls-files", "--others", "--exclude-standard"]
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120, **kwargs)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PlacementGateError("git ls-files failed in %s (%s: %s)"
                                 % (public_repo, type(exc).__name__, exc))
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-1:] or ["rc=%d" % proc.returncode]
        raise PlacementGateError("git ls-files failed in %s (%s)"
                                 % (public_repo, tail[0]))
    return [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]


def load_flag_state(flags_path, file_rel):
    """True when an UNRESOLVED placement-unknown flag for file_rel already exists.
    Resolution records carry a `resolves` key holding the byte-exact
    `<timestamp>::<file>` key of the flag they resolved. Missing file tolerated; blank
    lines skipped; malformed lines skipped with a stderr note."""
    if not os.path.isfile(flags_path):
        return False
    resolved = set()
    unresolved = False
    with open(flags_path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                print("placement-flags: skipping malformed line %d in %s"
                      % (lineno, flags_path), file=sys.stderr)
                continue
            if not isinstance(obj, dict):
                print("placement-flags: skipping malformed line %d in %s"
                      % (lineno, flags_path), file=sys.stderr)
                continue
            if "resolves" in obj:
                resolved.add(obj.get("resolves"))
            elif (obj.get("file") == file_rel
                  and obj.get("category") == "placement-unknown"):
                key = "%s::%s" % (obj.get("timestamp"), obj.get("file"))
                if key not in resolved:
                    unresolved = True
    return unresolved


def append_flag(flags_path, file_rel):
    """One JSON line, keys in the exact join-contract order, append mode, created if
    absent."""
    record = {
        "timestamp": utc_z(),
        "file": file_rel,
        "reason": FLAG_REASON,
        "category": "placement-unknown",
        "run": "push-public",
    }
    with open(flags_path, "a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def cmd_check(args):
    try:
        proj = json.loads(read_bytes(args.projection).decode("utf-8"))
    except (OSError, ValueError) as exc:
        raise PlacementGateError("cannot read projection %s (%s: %s)"
                                 % (args.projection, type(exc).__name__, exc))
    if not isinstance(proj, dict):
        raise PlacementGateError("projection %s is not a JSON object" % args.projection)

    # (1) freshness — a stale projection is never silently trusted.
    reg_bytes = read_bytes(args.registry)
    if proj.get("registry_sha256") != sha256_hex(reg_bytes):
        print("PLACEMENT-GATE STALE projection=%s registry sha mismatch — regenerate"
              % args.projection)
        return EXIT_STALE

    allow = proj.get("allow") or []
    deny = proj.get("deny") or []

    # (2) candidates, (3) classify: DENY match or no ALLOW match => refused.
    candidates = git_new_candidates(args.public_repo)
    refused = []
    for f in candidates:
        deny_hit = next((e["glob"] for e in deny if glob_match(e["glob"], f)), None)
        if deny_hit is not None:
            print("PLACEMENT-DENY: %s matched deny glob %s" % (f, deny_hit),
                  file=sys.stderr)
            refused.append(f)
        elif not any(glob_match(e["glob"], f) for e in allow):
            refused.append(f)

    # (4) one UNKNOWN line + one flag per refused file, deduped against unresolved flags.
    for f in refused:
        print("PLACEMENT-UNKNOWN: %s" % f)
        if load_flag_state(args.flags_file, f):
            print("PLACEMENT-FLAG-EXISTS: %s" % f)
        else:
            append_flag(args.flags_file, f)

    # (5) verdict.
    if refused:
        print("PLACEMENT-GATE REFUSED files=%d" % len(refused))
        return EXIT_REFUSED
    print("PLACEMENT-GATE OK new=%d" % len(candidates))
    return EXIT_OK


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------

class GateParser(argparse.ArgumentParser):
    """argparse exits 2 on usage errors, which would collide with refusal's exit 2 —
    usage/parse is exit 4 here, always."""

    def error(self, message):
        self.print_usage(sys.stderr)
        print("%s: error: %s" % (self.prog, message), file=sys.stderr)
        sys.exit(EXIT_USAGE)


def build_parser():
    parser = GateParser(prog="placement_gate.py",
                        description="Placement registry -> public-path projection -> "
                                    "public-sync gate.")
    sub = parser.add_subparsers(dest="command", required=True, parser_class=GateParser)

    gen = sub.add_parser("gen", help="derive the public-path projection from the registry")
    gen.add_argument("--registry", required=True, help="path to the placement registry md")
    gen.add_argument("--out", required=True, help="projection JSON output path")
    gen.set_defaults(func=cmd_gen)

    check = sub.add_parser("check", help="gate mirror-new files against the projection")
    check.add_argument("--registry", required=True, help="path to the placement registry md")
    check.add_argument("--projection", required=True, help="projection JSON from gen")
    check.add_argument("--public-repo", required=True, help="public mirror checkout dir")
    check.add_argument("--flags-file", default=DEFAULT_FLAGS_FILE,
                       help="flags JSONL (default: <PA_HOME or ~/.pa>/public-mirror-flags.jsonl)")
    check.set_defaults(func=cmd_check)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (RegistryParseError, PlacementGateError, OSError, ValueError,
            subprocess.SubprocessError) as exc:
        print("PLACEMENT-GATE ERROR: %s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
