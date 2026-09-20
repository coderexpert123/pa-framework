#!/usr/bin/env python3
"""Placement registry -> public-path projection -> public-sync gate (placement Phase 3, P1).

One script, three subcommands:

  gen --registry <path> --out <path> [--gitignore <path> [--scan-repo <dir>]]
      Parse the registry's census tables (12-cell rows under `##` headings) and derive
      the public-path projection: ALLOW globs (R1 every PUBLIC row, R2 every
      public-tracked-boundary row even when SPLIT, R3 every uncovered SPLIT surface as
      `assumed: true` with a loud SPLIT-ASSUMED-PUBLIC warning on stderr), DENY globs
      (every PRIVATE row's surface, which must be exact-file — a directory or glob
      PRIVATE surface can never produce a DENY and is refused at parse time with a
      PlacementGateError naming the row; author it as an exact-file surface per path,
      or record the row under a different verdict). Written atomically (tmp +
      os.replace). Success line:
      PLACEMENT-PROJECTION OK rows=%d allow=%d deny=%d assumed=%d -> <out>
      With --gitignore: the registry's N3 feature cells (`L<lineno>:<exact gitignore
      line>`) are projected verbatim, in registry file order, under a fixed
      2-comment-line header, and the result is refused (exit 4, nothing written) when
      any SPLIT surface is assumed-public, when the emitted set lacks the
      `!/.gitignore-public` self re-include, or when real `git check-ignore` run in a
      throwaway repo disagrees with the projection over the tracked universe in a hard
      direction: DENY-PUBLIC (a path the projection denies would ship), or ALLOW-DENIED
      with an exact-file allowing row (a declared-public file locked out). An
      ALLOW-DENIED whose every allowing row is directory-grained (glob or dir surface)
      is a legitimate carve-out: one PLACEMENT-BOUNDARY-CARVE-OUT line per example
      (first 15) plus a PLACEMENT-BOUNDARY-WARNING count, then success. Second line:
      PLACEMENT-BOUNDARY OK lines=%d -> <gitignore>

  check --registry <path> --projection <path> --public-repo <dir> [--flags-file <path>]
      Freshness-check the projection against the current registry sha256 (exit 3 on
      mismatch), then classify every mirror-new file (`git ls-files --others
      --exclude-standard`): a DENY match or no ALLOW match refuses the file, prints
      PLACEMENT-UNKNOWN: <path> and appends one flag record unless an UNRESOLVED flag
      for the same file already exists (then PLACEMENT-FLAG-EXISTS: <file>).
      PLACEMENT-GATE OK new=<n> (exit 0) or PLACEMENT-GATE REFUSED files=<n> (exit 2).

  compare --registry <path> --generated <path> [--live <path>] [--scan-repo <dir>]
          [--public-repo <dir>]
      Steady state (no --live): regenerate the boundary in memory and byte-compare it
      against --generated — PLACEMENT-BOUNDARY VERIFIED generated=<path> matches
      registry derivation (exit 0), or PLACEMENT-BOUNDARY DRIFT generated=<path> does
      not match the registry derivation — regenerate and commit (exit 3; the
      staleness gate the public-sync skill runs). Migration (--live <path>): the
      pre-migration boundary is not generated, so the byte stage is skipped; the
      tracked universe (tracked files of both repos, star-free exact-file projection
      globs, and synthetic `.pa-boundary-probe` files under every directory prefix) is
      evaluated under BOTH files with real git. EXPOSED (live denies, generated
      allows) and LOCKED-OUT (live allows, generated denies) must both be empty
      (exit 0); otherwise up to 15 per bucket are listed, then
      PLACEMENT-BOUNDARY MISMATCH exposed=%d locked-out=%d (exit 2).

Exit codes: 0 ok | 2 refusal/mismatch | 3 stale/drift | 4 usage/parse. Nothing else.
(argparse's own error exit is overridden to 4 so it cannot collide with refusal's 2.)

Flag-schema join contract: each appended flag is one JSON line with keys in exactly
this order — timestamp (UTC, %Y-%m-%dT%H:%M:%SZ, second precision, literal Z),
file, reason, category ("placement-unknown"), run ("push-public"). The
investigate-flagged skill joins resolutions on the byte-exact `<timestamp>::<file>`
key, so neither field may ever change format.

Coupling note: the registry's 12-cell table grammar is shared with
scratch/placement-audit/check_completeness.py — a schema change must move both
parsers; the projection's registry_sha256 freshness check turns drift into exit 3,
never silent mismatch; and check_completeness.py's A4 compares the N3 line-texts
with the generated boundary's meaningful lines (content identity, no physical line
numbers) — a schema or emission change must move both.

Content coupling (found 2026-09-10, resolving the PRIVATE dir/glob refusal below):
check_completeness.py's A9 also reads the surfaces cell of every PUBLIC/PRIVATE row
directly against real `git ls-files` output, independent of this module. Rewriting a
PRIVATE row's surface as prose (or its verdict to SPLIT) to satisfy derive()'s new
exact-file-only rule removes that row from A9's leak check entirely — A9 skips SPLIT
outright and silently no-ops on prose text, since neither matches a real path. This
is an accepted, understood tradeoff for genuinely non-enumerable directory/glob
catch-alls (the true enforcement for those is the boundary line itself, not a DENY
glob), not a regression to chase — but a future schema/content change touching many
PRIVATE rows at once should re-run check_completeness.py and expect its A9 coverage
for those specific rows to have moved, not to still fire.

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
import shutil
import subprocess
import sys
import tempfile
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
            if row.verdict == "PRIVATE" and not is_exact_file(s):
                raise PlacementGateError(
                    "row %r (census %s, line %d): PRIVATE surface %r is directory- or "
                    "glob-grained and can never produce a DENY — use an exact-file "
                    "surface per path, or a different verdict" % (row.feature, row.census,
                                                                   row.lineno, s))
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
                # A dir/glob PRIVATE surface can never reach here — the parse loop
                # above already refused it, since it could never produce a DENY.
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


def write_projection(out_path, proj, registry_path, reg_bytes):
    """Atomic projection write (tmp + os.replace) — readers never see a torn file."""
    payload = proj.to_dict(registry=registry_path, registry_sha256=sha256_hex(reg_bytes),
                           generated_at=utc_z())
    out_dir = os.path.dirname(os.path.abspath(out_path))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    tmp_path = out_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp_path, out_path)


def cmd_gen(args):
    reg_bytes = read_bytes(args.registry)
    rows = parse_registry_rows(reg_bytes.decode("utf-8").splitlines())
    proj = derive(rows)
    for warning in proj.warnings:
        print(warning, file=sys.stderr)
    if args.gitignore:
        return cmd_gen_boundary(args, rows, proj, reg_bytes)
    write_projection(args.out, proj, args.registry, reg_bytes)
    print("PLACEMENT-PROJECTION OK rows=%d allow=%d deny=%d assumed=%d -> %s"
          % (proj.rows, len(proj.allow), len(proj.deny), proj.assumed, args.out))
    return EXIT_OK


# ---------------------------------------------------------------------------
# boundary generation: the public boundary is GENERATED output of the registry's
# Boundary lines (N3) census — a verbatim projection, never a synthesis
# ---------------------------------------------------------------------------

HEADER_LINES = [
    "# pa-framework public boundary - GENERATED file; do not edit by hand.",
    "# Source of truth: the placement registry's Boundary lines (N3) section; "
    "regenerate with pa/scripts/placement_gate.py gen --gitignore.",
    "",
]

SELF_REINCLUDE_LINE = "!/.gitignore-public"


def render_boundary(lines):
    """The exact generated file bytes: fixed 3-line header, then the pattern lines,
    LF, trailing newline. No timestamps, no digest — the byte-compare stage IS the
    staleness check."""
    return "\n".join(list(HEADER_LINES) + list(lines)) + "\n"


def emit_boundary_lines(rows):
    """Project every N3 row's `L<lineno>:<line-text>` feature cell verbatim, in
    registry file order. No re-anchoring, no glob rewriting, no dedupe (a duplicate
    line is a registry defect the completeness checker's set-parity surfaces). The
    line texts ARE gitignore lines, so git itself is the only negation engine —
    applied at validation/compare time in a throwaway repo."""
    lines = []
    for row in rows:
        if row.census != "N3":
            continue
        m = re.match(r"^(L\d+):(.+)$", row.feature)
        if not m:
            raise PlacementGateError(
                "N3 row %r (registry line %d) is not keyed L<lineno>:<line-text>"
                % (row.feature, row.lineno))
        lines.append(m.group(2).strip())
    return lines


class TempRepoPool(object):
    """Fresh throwaway git-repo dirs for check_ignore_set (one per batch, from
    repo_factory); removed on close() — the caller owns the cleanup."""

    def __init__(self):
        self.dirs = []

    def new_repo(self):
        d = tempfile.mkdtemp(prefix="pa-boundary-git-")
        self.dirs.append(d)
        return d

    def close(self):
        for d in self.dirs:
            shutil.rmtree(d, True)
        self.dirs = []


def _run_git(cmd, input_text=None):
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = CREATE_NO_WINDOW
    try:
        return subprocess.run(cmd, input=input_text, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=120, **kwargs)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PlacementGateError("%s failed (%s: %s)"
                                 % (" ".join(cmd[:3]), type(exc).__name__, exc))


def git_ls_files(repo):
    """Tracked files of a checkout: root-relative, forward-slash paths. -z keeps the
    output unquoted, so non-ASCII paths stay literal."""
    proc = _run_git(["git", "-C", repo, "ls-files", "-z"])
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()[-1:] or ["rc=%d" % proc.returncode]
        raise PlacementGateError("git ls-files failed in %s (%s)" % (repo, tail[0]))
    return [s for s in proc.stdout.split("\0") if s.strip()]


_ABSOLUTE_PATH_RE = re.compile(r"^[A-Za-z]:[/\\]|^[/\\]")


def _repo_relative(path):
    """True when real git can evaluate the path inside a throwaway repo: gitignore
    patterns and check-ignore queries are repo-relative, so drive-letter and other
    absolute surfaces are inert in a boundary and cannot be validated there (they
    stay in the emitted file untouched — emission is a projection, never a filter)."""
    return not _ABSOLUTE_PATH_RE.match(path)


def resolve_scan_repo(explicit):
    """--scan-repo, defaulting to the repo that owns the cwd; unusable cwd => exit 4."""
    if explicit:
        return explicit
    proc = _run_git(["git", "rev-parse", "--show-toplevel"])
    if proc.returncode != 0 or not (proc.stdout or "").strip():
        raise PlacementGateError("cannot resolve the scan repo from cwd; pass --scan-repo")
    return proc.stdout.strip()


def boundary_universe(proj, scan_repo, public_repo=None, n3_lines=()):
    """Every path the boundary's semantics must be proven over, sorted and deduped:
    tracked files of the scan repo, tracked files of the public mirror when given,
    literal probe paths for every exact-file projection glob, and a synthetic
    `<dir>/.pa-boundary-probe` under every directory prefix of any of those paths or
    of any N3 line text. Probes are what catch the untracked+unprojected residual
    (the default-open class): a removed carve-out with nothing tracked beneath it
    still flips a probe."""
    universe = set(git_ls_files(scan_repo))
    if public_repo:
        universe.update(git_ls_files(public_repo))
    for entry in proj.allow + proj.deny:
        if is_exact_file(entry["glob"]) and _repo_relative(entry["glob"]):
            universe.add(entry["glob"])
    seeds = set(universe)
    for line in n3_lines:
        cleaned = line.lstrip("!").lstrip("/").rstrip("/")
        if cleaned and _repo_relative(cleaned):
            seeds.add(cleaned)
    for path in seeds:
        parts = path.split("/")
        for i in range(1, len(parts)):
            universe.add("/".join(parts[:i]) + "/.pa-boundary-probe")
    return sorted(universe)


def check_ignore_set(text, universe, repo_factory):
    """The REAL negation engine: write the boundary text into a fresh throwaway repo
    (repo_factory hands out the dir; the pool cleans it up), `git init -q`, then ONE
    `check-ignore --stdin -z` batch over all universe paths, NUL-separated. exit 0 =>
    the ignored set; exit 1 => nothing ignored; anything else => error. A
    fnmatch-vs-gitignore divergence surfaces here mechanically as a validation
    mismatch, never silently."""
    if not universe:
        return set()
    repo_dir = repo_factory()
    with open(os.path.join(repo_dir, ".gitignore"), "w", encoding="utf-8",
              newline="\n") as fh:
        fh.write(text)
    init = _run_git(["git", "-C", repo_dir, "init", "-q"])
    if init.returncode != 0:
        tail = (init.stderr or "").strip().splitlines()[-1:] or ["rc=%d" % init.returncode]
        raise PlacementGateError("git init failed in %s (%s)" % (repo_dir, tail[0]))
    proc = _run_git(["git", "-C", repo_dir, "check-ignore", "--stdin", "-z"],
                    input_text="".join(p + "\0" for p in universe))
    if proc.returncode == 0:
        return set(s for s in proc.stdout.split("\0") if s)
    if proc.returncode == 1:
        return set()
    tail = (proc.stderr or "").strip().splitlines()[-1:] or ["rc=%d" % proc.returncode]
    raise PlacementGateError("git check-ignore failed in %s (%s)" % (repo_dir, tail[0]))


def validate_boundary(lines, proj, scan_repo):
    """Asymmetric rule per universe path u (adjudicated 2026-09-05): expected_public
    = (an allow entry matches u) and (no deny entry matches u); expected_private =
    not expected_public. The boundary must ignore expected-private and NOT ignore
    expected-public, as decided by real git. The two mismatch directions are NOT
    symmetric:
      - DENY-PUBLIC (expected-private but boundary-public) is always hard: the
        silent-exposure direction.
      - ALLOW-DENIED (expected-public but boundary-ignored) splits by the grain of
        the ALLOWING rows: any exact-file allowing row means a declared-public file
        is locked out — hard; every allowing row directory-grained (glob or dir
        surface) means a legitimate carve-out (a PUBLIC tree with private children)
        — one PLACEMENT-BOUNDARY-CARVE-OUT example line each (first 15) plus a
        PLACEMENT-BOUNDARY-WARNING count line, then success.
    Any hard mismatch prints its lines to stderr and raises (exit 4) with NOTHING
    written."""
    if SELF_REINCLUDE_LINE not in lines:
        line = ("PLACEMENT-BOUNDARY-MISMATCH: SELF-REINCLUDE generated boundary does "
                "not re-include .gitignore-public — extraction could never update the "
                "mirror copy")
        print(line, file=sys.stderr)
        raise PlacementGateError(line)
    text = render_boundary(lines)
    universe = boundary_universe(proj, scan_repo, n3_lines=lines)
    pool = TempRepoPool()
    try:
        ignored = check_ignore_set(text, universe, pool.new_repo)
    finally:
        pool.close()
    allow_denied = []   # exact-file grain: a declared-public file locked out
    carve_outs = []     # directory-grained only: legitimate carve-out
    deny_public = []
    for u in universe:
        allowing = [e for e in proj.allow if glob_match(e["glob"], u)]
        denied = any(glob_match(e["glob"], u) for e in proj.deny)
        expected_public = bool(allowing) and not denied
        if expected_public and u in ignored:
            if any(is_exact_file(e["glob"]) for e in allowing):
                allow_denied.append(u)
            else:
                carve_outs.append(u)
        elif not expected_public and u not in ignored:
            deny_public.append(u)
    for u in carve_outs[:15]:
        print("PLACEMENT-BOUNDARY-CARVE-OUT: %s" % u, file=sys.stderr)
    if carve_outs:
        print("PLACEMENT-BOUNDARY-WARNING: %d allowed-path denial(s) are "
              "directory-grained carve-outs (every allowing row is a glob or dir "
              "surface) — warning only, generation continues" % len(carve_outs),
              file=sys.stderr)
    if allow_denied or deny_public:
        for u in allow_denied:
            print("PLACEMENT-BOUNDARY-MISMATCH: ALLOW-DENIED %s" % u, file=sys.stderr)
        for u in deny_public:
            print("PLACEMENT-BOUNDARY-MISMATCH: DENY-PUBLIC %s" % u, file=sys.stderr)
        raise PlacementGateError(
            "boundary validation failed: %d exact-file allowed-path denial(s), %d "
            "public-path leak(s)" % (len(allow_denied), len(deny_public)))


def cmd_gen_boundary(args, rows, proj, reg_bytes):
    """The --gitignore branch, exact order: (a) refuse any assumed surface, (b)
    project the N3 cells, (c) validate with real git over the tracked universe, (d)
    atomic-write the boundary, and only then (e) the projection write plus both
    success lines. Every refusal leaves the filesystem untouched."""
    if proj.assumed > 0:
        for entry in proj.allow:
            if entry.get("assumed"):
                print("PLACEMENT-BOUNDARY-ASSUMED: %s %s"
                      % (entry["feature"], entry["glob"]), file=sys.stderr)
        print("PLACEMENT-BOUNDARY REFUSED assumed=%d — every boundary line must have "
              "an owning registry row" % proj.assumed, file=sys.stderr)
        return EXIT_USAGE
    scan_repo = resolve_scan_repo(args.scan_repo)
    lines = emit_boundary_lines(rows)
    validate_boundary(lines, proj, scan_repo)
    text = render_boundary(lines)
    out_dir = os.path.dirname(os.path.abspath(args.gitignore))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    tmp_path = args.gitignore + ".tmp"
    with open(tmp_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp_path, args.gitignore)
    write_projection(args.out, proj, args.registry, reg_bytes)
    print("PLACEMENT-PROJECTION OK rows=%d allow=%d deny=%d assumed=%d -> %s"
          % (proj.rows, len(proj.allow), len(proj.deny), proj.assumed, args.out))
    print("PLACEMENT-BOUNDARY OK lines=%d -> %s" % (len(lines), args.gitignore))
    return EXIT_OK


def read_text(path):
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def cmd_compare(args):
    reg_bytes = read_bytes(args.registry)
    rows = parse_registry_rows(reg_bytes.decode("utf-8").splitlines())
    proj = derive(rows)
    for warning in proj.warnings:
        print(warning, file=sys.stderr)
    if proj.assumed > 0:
        # A registry in this state has no valid generated file at all.
        for entry in proj.allow:
            if entry.get("assumed"):
                print("PLACEMENT-BOUNDARY-ASSUMED: %s %s"
                      % (entry["feature"], entry["glob"]), file=sys.stderr)
        return EXIT_USAGE
    if not args.live:
        lines = emit_boundary_lines(rows)
        with open(args.generated, "rb") as fh:
            actual = fh.read()
        if actual == render_boundary(lines).encode("utf-8"):
            print("PLACEMENT-BOUNDARY VERIFIED generated=%s matches registry derivation"
                  % args.generated)
            return EXIT_OK
        print("PLACEMENT-BOUNDARY DRIFT generated=%s does not match the registry "
              "derivation — regenerate and commit" % args.generated)
        return EXIT_STALE
    generated_text = read_text(args.generated)
    live_text = read_text(args.live)
    scan_repo = resolve_scan_repo(args.scan_repo)
    universe = boundary_universe(proj, scan_repo, public_repo=args.public_repo,
                                 n3_lines=emit_boundary_lines(rows))
    pool = TempRepoPool()
    try:
        ignored_generated = check_ignore_set(generated_text, universe, pool.new_repo)
        ignored_live = check_ignore_set(live_text, universe, pool.new_repo)
    finally:
        pool.close()
    exposed = sorted(u for u in universe
                     if u in ignored_live and u not in ignored_generated)
    locked_out = sorted(u for u in universe
                        if u in ignored_generated and u not in ignored_live)
    if not exposed and not locked_out:
        print("PLACEMENT-BOUNDARY VERIFIED universe=%d agreed=%d exposed=0 locked-out=0"
              % (len(universe), len(universe)))
        return EXIT_OK
    for u in exposed[:15]:
        print("PLACEMENT-BOUNDARY EXPOSED: %s" % u)
    for u in locked_out[:15]:
        print("PLACEMENT-BOUNDARY LOCKED-OUT: %s" % u)
    print("PLACEMENT-BOUNDARY MISMATCH exposed=%d locked-out=%d"
          % (len(exposed), len(locked_out)))
    return EXIT_REFUSED


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
    gen.add_argument("--gitignore", default=None,
                     help="also emit the generated public boundary file from the "
                          "registry's N3 line cells")
    gen.add_argument("--scan-repo", default=None,
                     help="repo whose tracked universe validates the emitted boundary "
                          "(default: the repo owning cwd)")
    gen.set_defaults(func=cmd_gen)

    compare = sub.add_parser(
        "compare", help="verify a boundary file against the registry derivation")
    compare.add_argument("--registry", required=True,
                         help="path to the placement registry md")
    compare.add_argument("--generated", required=True,
                         help="generated boundary file to verify")
    compare.add_argument("--live", default=None,
                         help="pre-migration boundary to prove semantic equivalence "
                              "against (skips the byte stage)")
    compare.add_argument("--scan-repo", default=None,
                         help="repo whose tracked universe joins the migration "
                              "comparison (default: the repo owning cwd)")
    compare.add_argument("--public-repo", default=None,
                         help="public mirror checkout whose tracked files join the "
                              "migration comparison")
    compare.set_defaults(func=cmd_compare)

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
