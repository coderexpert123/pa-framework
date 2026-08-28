#!/usr/bin/env python3
"""Deterministic post-run scope verifier for the `commit` skill (2026-08-28).

After a scoped `pa run commit --prompt-args "..."` run, the caller records HEAD
before the run and invokes this script with the same allowlist afterwards. It
lists every path touched by commits in `<base>..HEAD` that is NOT in the
allowlist — the mechanical detection of a multi-wave sweep that prompt-side
rules alone failed to prevent twice (2026-08-24 buttons program, 2026-08-27
seamless-restart-recovery).

Exit 0: scope held (or no commits in range). Exit 1: violations printed on
stdout, one per line, as `<path> (committed in <short-sha> <subject>)`.
Exit 2: usage / git error.

Usage:
  python verify_commit_scope.py --base <sha> [--allowlist-file <file>] [--] [path ...]

Allowlist matching is exact-path (no globs) — the caller names files, mirroring
the skill's own "name explicit files" rule. Run from the repo root.
"""
import argparse
import subprocess
import sys
from pathlib import Path


def git(args: list[str]) -> str:
    proc = subprocess.run(
        ["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if proc.returncode != 0:
        sys.stderr.write(f"git {' '.join(args)} failed: {proc.stderr.strip()}\n")
        sys.exit(2)
    return proc.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", required=True, help="HEAD recorded before the commit run")
    parser.add_argument(
        "--allowlist-file",
        help="file with one allowlisted path per line (# comments and blanks ignored)",
    )
    parser.add_argument("paths", nargs="*", help="allowlisted paths (exact, no globs)")
    args = parser.parse_args()

    allow: set[str] = set(p.replace("\\", "/") for p in args.paths if p.strip())
    if args.allowlist_file:
        for line in Path(args.allowlist_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                allow.add(line.replace("\\", "/"))
    if not allow:
        sys.stderr.write("verify_commit_scope: empty allowlist — nothing to verify against\n")
        return 2

    # Every commit the run produced (base..HEAD), oldest first, with subject.
    log = git(["log", "--format=%H%x00%s", f"{args.base}..HEAD"])
    commits = [
        (h, s) for h, s in (line.split("\x00", 1) for line in log.splitlines() if line)
    ]
    if not commits:
        print("verify_commit_scope: no commits in range — scope trivially held")
        return 0

    violations: list[str] = []
    for sha, subject in commits:
        out = git(["show", "--format=", "--name-only", sha])
        for path in (l.strip().replace("\\", "/") for l in out.splitlines() if l.strip()):
            if path not in allow:
                violations.append(f"{path} (committed in {sha[:9]} {subject})")

    if violations:
        print(f"verify_commit_scope: SCOPE VIOLATION — {len(violations)} unlisted path(s):")
        for v in violations:
            print(f"  {v}")
        return 1
    print(
        f"verify_commit_scope: scope held — {len(commits)} commit(s), "
        f"all paths within the {len(allow)}-path allowlist"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
