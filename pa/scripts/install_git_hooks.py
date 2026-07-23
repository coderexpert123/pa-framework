#!/usr/bin/env python3
"""Idempotent installer for the public-mirror git hooks.

Why this exists
---------------
`.git-public/hooks/pre-push` is the PII guard that stands between this working
tree and the public mirror. For months it was installed as a plain COPY of the
tracked source `pa/scripts/git-hooks/pre-push-pii-guard`:

    cp pa/scripts/git-hooks/pre-push-pii-guard .git-public/hooks/pre-push

A copy has to be RE-COPIED after every edit to the source, by hand, forever.
It was forgotten repeatedly — the installed hook drifted from its source the
same day it was last reinstalled (source 47,294 B, installed copy 46,715 B),
meaning the guard actually running against real pushes was NOT the guard in the
repo. This installer replaces that copy with a filesystem LINK so editing the
tracked source is the install — there is nothing left to remember.

The repo already proves the pattern works on this machine: `AGENTS.md` and
`GEMINI.md` at the root are real symlinks to `CLAUDE.md`.

The guard script has zero `__file__`/`os.path.dirname`/`realpath` self-location
logic (confirmed by grep) — it depends only on the process CWD for git
operations, and git always invokes a hook with cwd == the working-tree root.
So a symlinked or hard-linked invocation is fully equivalent to a copy; no
special handling is needed inside the guard itself.

Fallback ladder (each tier louder than the last, never silently does LESS than
the old copy behavior):
  1. Relative symlink (primary). Relative target so the link survives being
     cloned to a different path.
  2. Hard link, if symlink privilege is unavailable (no Developer Mode). Warns
     that a future `git checkout`/merge that rewrites the source as a NEW inode
     can desync the two names — recommend enabling symlink privilege.
  3. Plain copy, if hard-linking also fails (e.g. cross-volume). Warns loudly
     that manual reinstall discipline is required again — this is the exact
     state we are trying to escape, so it is the last resort and it says so.

Always ends with a content diff of installed-vs-source and an explicit
pass/fail verdict.

Safe to re-run: a correct symlink is left untouched (no-op).

    python pa/scripts/install_git_hooks.py
"""
from __future__ import annotations

import argparse
import os
import shutil
import stat
import sys
from pathlib import Path

# Windows pipes default to cp1252; keep unicode in warnings from crashing.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# Repo-root-relative locations. This file lives at pa/scripts/install_git_hooks.py,
# so the repo root is two parents up.
REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_REL = Path("pa/scripts/git-hooks/pre-push-pii-guard")
TARGET_REL = Path(".git-public/hooks/pre-push")


def _relative_link_target(target: Path, source: Path) -> str:
    """The symlink body: source expressed relative to the target's directory.

    For `.git-public/hooks/pre-push` -> `pa/scripts/git-hooks/pre-push-pii-guard`
    this is `../../pa/scripts/git-hooks/pre-push-pii-guard`, so the link keeps
    resolving no matter where the repo is cloned.
    """
    return os.path.relpath(source, target.parent)


def _is_correct_symlink(target: Path, want: str) -> bool:
    """True iff `target` is a symlink already pointing at `want` (normalized)."""
    if not target.is_symlink():
        return False
    try:
        current = os.readlink(target)
    except OSError:
        return False
    return os.path.normpath(current) == os.path.normpath(want)


def _same_hard_link(target: Path, source: Path) -> bool:
    """True iff `target` and `source` are the same inode (an existing hard link).

    On Windows `os.stat().st_ino` is populated for real files, so this is
    reliable enough to make the hard-link tier idempotent too.
    """
    if target.is_symlink() or not target.exists():
        return False
    try:
        ts, ss = target.stat(), source.stat()
    except OSError:
        return False
    return ts.st_ino == ss.st_ino and ts.st_dev == ss.st_dev and ts.st_ino != 0


def _remove(target: Path) -> None:
    """Remove whatever is at `target` (broken symlink, stale copy, wrong link)."""
    if target.is_symlink() or target.exists():
        target.unlink()


def _make_executable(target: Path) -> None:
    """chmod +x — required on POSIX, a harmless no-op on Windows.

    On a symlink this is skipped: the mode that matters is the source file's,
    and some platforms reject chmod on the link itself.
    """
    if target.is_symlink():
        return
    try:
        mode = target.stat().st_mode
        target.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass


def _content_matches(target: Path, source: Path) -> bool:
    try:
        return target.read_bytes() == source.read_bytes()
    except OSError:
        return False


def install(repo_root: Path | None = None) -> dict:
    """Install the hook, returning a result dict:

        {method, changed, verified, target, source, warnings}

    method   one of "symlink" | "hardlink" | "copy"
    changed  False when an already-correct install was left untouched
    verified True when installed content matches source content
    """
    root = (repo_root or REPO_ROOT).resolve()
    source = (root / SOURCE_REL).resolve()
    target = root / TARGET_REL
    warnings: list[str] = []

    if not source.exists():
        raise FileNotFoundError(f"hook source not found: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)

    link_body = _relative_link_target(target, source)

    # --- idempotent no-ops ---------------------------------------------------
    if _is_correct_symlink(target, link_body):
        _make_executable(source)
        return _result("symlink", False, target, source, warnings)
    if _same_hard_link(target, source):
        _make_executable(target)
        warnings.append(_HARDLINK_WARNING)
        return _result("hardlink", False, target, source, warnings)

    # --- tier 1: relative symlink -------------------------------------------
    _remove(target)
    try:
        os.symlink(link_body, target)
        _make_executable(source)
        return _result("symlink", True, target, source, warnings)
    except (OSError, NotImplementedError) as e:
        warnings.append(
            f"symlink creation failed ({e}); falling back to a hard link. "
            "Enable Windows Developer Mode (or run with symlink privilege) for "
            "the durable fix."
        )

    # --- tier 2: hard link ---------------------------------------------------
    _remove(target)
    try:
        os.link(source, target)
        _make_executable(target)
        warnings.append(_HARDLINK_WARNING)
        return _result("hardlink", True, target, source, warnings)
    except OSError as e:
        warnings.append(
            f"hard link failed ({e}); falling back to a PLAIN COPY. "
            + _COPY_WARNING
        )

    # --- tier 3: plain copy (last resort) -----------------------------------
    _remove(target)
    shutil.copyfile(source, target)
    _make_executable(target)
    return _result("copy", True, target, source, warnings)


_HARDLINK_WARNING = (
    "Installed as a HARD LINK, not a symlink. This shares content today, but a "
    "future `git checkout`/merge that rewrites the source with a NEW inode "
    "(rather than editing it in place) will silently DESYNC the two names. "
    "Re-run this installer after such an operation, and prefer enabling symlink "
    "privilege so the primary (symlink) tier is used instead."
)

_COPY_WARNING = (
    "Installed as a PLAIN COPY — the exact drift-prone state this installer "
    "exists to replace. The hook will NOT track edits to the source; you must "
    "re-run `python pa/scripts/install_git_hooks.py` after every change to "
    "pa/scripts/git-hooks/pre-push-pii-guard."
)


def _display_rel(path: Path, start: Path) -> str:
    """`path` relative to `start` for display, tolerant of Windows cross-drive
    paths (relpath raises ValueError when they are on different mounts — which
    happens whenever the repo and cwd sit on different drives, or when a Temp
    junction resolves onto another drive). Falls back to the absolute path."""
    try:
        return os.path.relpath(path, start)
    except ValueError:
        return str(path)


def _result(method: str, changed: bool, target: Path, source: Path,
            warnings: list[str]) -> dict:
    return {
        "method": method,
        "changed": changed,
        "verified": _content_matches(target, source),
        "target": target,
        "source": source,
        "warnings": warnings,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Install the public-mirror pre-push PII guard hook "
                    "(symlink, with hard-link/copy fallbacks).")
    parser.add_argument("--repo-root", help="Override the repo root (tests).")
    args = parser.parse_args(argv)

    root = Path(args.repo_root) if args.repo_root else REPO_ROOT
    try:
        res = install(root)
    except FileNotFoundError as e:
        print(f"install_git_hooks: {e}", file=sys.stderr)
        return 1

    rel_target = _display_rel(res["target"], root)
    rel_source = _display_rel(res["source"], root)

    verb = "already installed" if not res["changed"] else "installed"
    print(f"{rel_target} {verb} as {res['method']} -> {rel_source}")

    for w in res["warnings"]:
        print(f"!! {w}", file=sys.stderr)

    # Explicit drift verdict — the same content check documented in the README.
    if res["verified"]:
        print(f"drift check: CLEAN (installed content matches {rel_source})")
        return 0
    print(f"drift check: FAILED — installed hook content differs from {rel_source}",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
