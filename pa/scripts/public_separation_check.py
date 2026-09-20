#!/usr/bin/env python3
"""Private/public separation checker (Wave A, AI-264) — audit engine.

PLACEMENT: PRIVATE for now. `pa/` is public-tracked (re-included by
.gitignore-public), so this file must stay genericized (no operator names,
paths, ids); it becomes public-eligible only when a later wave adds its
registry row. Not a gate — an audit tool: it NEVER suppresses a match and
NEVER prints the matched text (public-CI rule: report the CLASS/pattern,
never the offending string).

CLI:
  python pa/scripts/public_separation_check.py \\
    --repo <git-dir-or-worktree> \\
    --patterns <patterns-file> [--patterns <more> ...]  # unioned
    [--mode contents|paths|history|all]                 # default all
    [--paths <file|"-">]                                # newline-separated; "-" = stdin

Patterns file format = the pii-tripwires format: one Python regex per line,
case-insensitive, `#` comments. STRICT loader here (stricter than the guard's
loader): a non-comment empty line or a malformed regex is a hard error naming
the offending line number — never a silent partial scan.

Modes:
  contents — every file in `git ls-files`, content scanned line-by-line.
             Reports: VIOLATION CONTENT <file>:<line> <CLASS>
  paths    — every tracked path (plus every path ever touched in history)
             matched against the three normalization views the guard uses
             (raw, separators -> spaces, camelCase split). With --paths,
             restricted to EXACTLY that newline-separated set.
             Reports: VIOLATION PATH <path> <CLASS>
  history  — over `git log --all`: every touched path, every blob content,
             every commit message.
             Reports: VIOLATION HISTORY-CONTENT <sha> <file>:<line> <CLASS>
                      VIOLATION HISTORY-PATH   <sha> <path> <CLASS>
                      VIOLATION HISTORY-MSG    <sha> msg:<line> <CLASS>

Exit codes: 0 = scan completed clean; 2 = violations found (scan succeeded);
any other non-zero = scanner failure. Every completion prints exactly one
summary line:
  SCAN OK repo=<repo> mode=<m> files=<n> commits=<n> violations=<k>
"""
import argparse
import re
import subprocess
import sys
from typing import Callable

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

FULL_SCAN_MAX_BYTES = 1_000_000  # binary/oversized blobs are skipped, never a crash

EXIT_CLEAN = 0
EXIT_VIOLATIONS = 2
EXIT_FAILURE = 3


def fail(msg: str) -> int:
    print(f"ERROR {msg}", file=sys.stderr)
    return EXIT_FAILURE


def git(repo: str, args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", repo] + args,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout,
    )


# --- pattern loading (strict) -------------------------------------------------

def load_patterns(path: str) -> list[str]:
    """Strict loader: one regex per line, `#` comments. An empty non-comment
    line or an uncompilable regex is an error naming the line number."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as e:
        raise RuntimeError(f"cannot read patterns file {path}: {e}") from None
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # a single trailing newline is not an empty pattern line
    patterns: list[str] = []
    for i, raw in enumerate(lines, start=1):
        line = raw.rstrip("\r")
        if line.startswith("#"):
            continue
        if not line.strip():
            raise RuntimeError(f"patterns file {path}: line {i}: empty line")
        try:
            re.compile(line, re.IGNORECASE)
        except re.error as e:
            raise RuntimeError(
                f"patterns file {path}: line {i}: malformed regex ({e})"
            ) from None
        patterns.append(line)
    return patterns


# --- the guard's three-view normalization -------------------------------------

def token_variants(text: str) -> list[str]:
    """Raw, separators (_ - . / \\) -> spaces, camelCase humps split.
    Ported conceptually from the guard's _token_variants: length-preserving
    or insertion-only, so line numbers still count correctly."""
    variants = [text]
    spaced = re.sub(r"[_\-./\\]", " ", text)
    if spaced != text:
        variants.append(spaced)
    camel = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", spaced)
    if camel != spaced:
        variants.append(camel)
    return variants


class Scanner:
    def __init__(self, patterns: list[str]):
        self.patterns = patterns
        self.violations: list[str] = []
        self.files = 0
        self.commits = 0
        self._seen: set[str] = set()

    def report(self, line: str) -> None:
        if line not in self._seen:
            self._seen.add(line)
            self.violations.append(line)

    def match_content_line(self, where: str, line: str) -> None:
        for pattern in self.patterns:
            if any(re.search(pattern, v, re.IGNORECASE)
                   for v in token_variants(line)):
                self.report(f"VIOLATION CONTENT {where} {pattern}")

    def match_path(self, path: str, sha: str | None = None) -> None:
        variants = token_variants(path)
        for pattern in self.patterns:
            if any(re.search(pattern, v, re.IGNORECASE) for v in variants):
                loc = f"{sha} {path}" if sha else path
                self.report(f"VIOLATION {'HISTORY-PATH' if sha else 'PATH'} {loc} {pattern}")

    def match_message(self, sha: str, body: str) -> None:
        for i, line in enumerate(body.split("\n"), start=1):
            for pattern in self.patterns:
                if re.search(pattern, line, re.IGNORECASE):
                    self.report(f"VIOLATION HISTORY-MSG {sha} msg:{i} {pattern}")


def _skipped(where: str) -> None:
    print(f"SKIPPED {where}")


def _readable_blob(repo: str, spec: str) -> str | None:
    """Blob content as text via `git show`; None if binary/oversized/unreadable."""
    try:
        r = git(repo, ["show", spec])
    except Exception:
        return None
    if r.returncode != 0:
        return None
    out = r.stdout
    if len(out) > FULL_SCAN_MAX_BYTES:
        return None
    if "\x00" in out:  # binary-ish: git show's replace-decode keeps NULs
        return None
    return out


def mode_contents(repo: str, sc: Scanner) -> None:
    r = git(repo, ["-c", "core.quotepath=false", "ls-files"])
    if r.returncode != 0:
        raise RuntimeError(f"git ls-files failed: {r.stderr.strip()[:200]}")
    paths = [p for p in r.stdout.splitlines() if p.strip()]
    sc.files += len(paths)
    for path in paths:
        content = _readable_blob(repo, f"HEAD:{path}")
        if content is None:
            _skipped(f"CONTENT {path}")
            continue
        for i, line in enumerate(content.split("\n"), start=1):
            sc.match_content_line(f"{path}:{i}", line)


def mode_paths(repo: str, sc: Scanner, restrict: list[str] | None) -> None:
    if restrict is not None:
        paths = list(restrict)
    else:
        r = git(repo, ["-c", "core.quotepath=false", "ls-files"])
        if r.returncode != 0:
            raise RuntimeError(f"git ls-files failed: {r.stderr.strip()[:200]}")
        paths = [p for p in r.stdout.splitlines() if p.strip()]
        # plus every path ever touched in history
        for touched in history_touched_paths(repo):
            for p in touched:
                if p and p not in paths:
                    paths.append(p)
    sc.files += len(paths)
    for path in paths:
        sc.match_path(path)


def history_touched_paths(repo: str) -> list[list[str]]:
    """Per-commit touched paths over --all, in one bulk `git log` call.

    With --format=%x1e%H%x1e git emits `\x1e<sha>\x1e` then a blank line then
    the --name-only path lines, so the path lines land AFTER the separator in
    the following split record — parse statefully: a 40-hex line opens a
    commit, every other nonempty line is a touched path of the current one."""
    r = git(repo, ["log", "--all", "--format=%x1e%H%x1e", "--name-only"])
    if r.returncode != 0:
        raise RuntimeError(f"git log --all failed: {r.stderr.strip()[:200]}")
    out: list[list[str]] = []
    cur: list[str] | None = None
    for record in r.stdout.split("\x1e"):
        for ln in record.split("\n"):
            ln = ln.strip()
            if not ln:
                continue
            if re.fullmatch(r"[0-9a-f]{40}", ln):
                cur = [ln]
                out.append(cur)
            elif cur is not None:
                cur.append(ln)
    return [c for c in out if c]


def history_messages(repo: str) -> list[tuple[str, str]]:
    """(sha, full message body) for every commit over --all."""
    r = git(repo, ["log", "--all", "--format=%x1e%H%x1f%B%x1e"])
    if r.returncode != 0:
        raise RuntimeError(f"git log --all failed: {r.stderr.strip()[:200]}")
    msgs: list[tuple[str, str]] = []
    for record in r.stdout.split("\x1e"):
        if "\x1f" not in record:
            continue
        sha, _, body = record.strip("\n").partition("\x1f")
        sha = sha.strip()
        if sha:
            msgs.append((sha, body))
    return msgs


def mode_history(repo: str, sc: Scanner) -> None:
    # (a) touched paths + (b) blob contents per commit
    for record in history_touched_paths(repo):
        sha = record[0]
        touched = record[1:]
        sc.commits += 1
        for path in touched:
            sc.match_path(path, sha)
        for path in touched:
            content = _readable_blob(repo, f"{sha}:{path}")
            if content is None:
                _skipped(f"HISTORY {sha[:12]}:{path}")
                continue
            for i, line in enumerate(content.split("\n"), start=1):
                for pattern in sc.patterns:
                    if re.search(pattern, line, re.IGNORECASE):
                        sc.report(
                            f"VIOLATION HISTORY-CONTENT {sha} {path}:{i} {pattern}"
                        )
                        break
    # (c) commit messages
    for sha, body in history_messages(repo):
        sc.match_message(sha, body)


def read_paths_arg(value: str) -> list[str]:
    """Newline-separated path list from a file, or stdin for \"-\"."""
    try:
        if value == "-":
            text = sys.stdin.read()
        else:
            with open(value, encoding="utf-8", errors="replace") as f:
                text = f.read()
    except OSError as e:
        raise RuntimeError(f"cannot read --paths source {value}: {e}") from None
    return [ln.strip() for ln in text.split("\n") if ln.strip()]


def run(repo: str, patterns: list[str], mode: str, paths_arg: str | None) -> int:
    sc = Scanner(patterns)
    restrict: list[str] | None = None
    if paths_arg is not None:
        if mode not in ("paths", "all"):
            return fail(f"--paths restricts only --mode paths (got --mode {mode})")
        restrict = read_paths_arg(paths_arg)
        if mode == "all":
            mode = "paths"  # --paths restricts only the paths layer
    modes = ["contents", "paths", "history"] if mode == "all" else [mode]
    for m in modes:
        if m == "contents":
            mode_contents(repo, sc)
        elif m == "paths":
            mode_paths(repo, sc, restrict)
        elif m == "history":
            mode_history(repo, sc)
        else:
            return fail(f"unknown mode '{m}'")
    for v in sc.violations:
        print(v)
    print(f"SCAN OK repo={repo} mode={mode} files={sc.files} "
          f"commits={sc.commits} violations={len(sc.violations)}")
    return EXIT_VIOLATIONS if sc.violations else EXIT_CLEAN


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Private/public separation checker (audit; never suppresses)")
    ap.add_argument("--repo", required=True,
                    help="git dir or worktree to scan")
    ap.add_argument("--patterns", action="append", required=True,
                    help="patterns file (guard pii-tripwires format); repeatable, unioned")
    ap.add_argument("--mode", default="all",
                    choices=["contents", "paths", "history", "all"])
    ap.add_argument("--paths", default=None,
                    help="file with newline-separated paths ('-' = stdin); "
                         "restricts --mode paths to exactly that set")
    args = ap.parse_args()

    patterns: list[str] = []
    try:
        for p in args.patterns:
            patterns.extend(load_patterns(p))
    except RuntimeError as e:
        return fail(str(e))
    if not patterns:
        return fail("no patterns loaded — an audit with zero patterns scans nothing")

    try:
        return run(args.repo, patterns, args.mode, args.paths)
    except Exception as e:
        return fail(f"scan failed: {e}")


if __name__ == "__main__":
    sys.exit(main())
