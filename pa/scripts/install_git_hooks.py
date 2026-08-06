#!/usr/bin/env python3
"""Idempotent installer for the public-mirror git hooks.

Why this exists
---------------
`<public mirror>/.git/hooks/pre-push` is the PII guard that stands between
this working tree and the public mirror. It is installed as a COPY of the
tracked source `pa/scripts/git-hooks/pre-push-pii-guard`:

    cp pa/scripts/git-hooks/pre-push-pii-guard <public mirror>/.git/hooks/pre-push

Copy-only since 2026-08-06 (was symlink-preferred with hardlink/copy
fallbacks — see git history if you need the old tiered version). The public
mirror used to live at `.git-public/` sharing THIS repo's working tree, so a
relative symlink from the tracked source to the hook target was a
same-working-tree convenience. It now lives at its own directory — nested at
`<repo root>/pa-public` by default (own `.git/`, gitignored by the private
repo), override via the `PA_PUBLIC_DIR` env var or the `--public-dir` flag —
as a genuinely SEPARATE git repository with its own independent clone/pull
lifecycle — a symlink or hard link crossing that boundary would silently
desync the moment either repo is re-cloned, which is now a normal, supported
recovery path (see plans/2026-08-05-concurrent-session-safety.md). Re-running
this installer after every edit to the source is the documented, expected
workflow; the drift-check verdict below is what catches "forgot to re-run" —
the same failure mode a stale symlink would have masked differently, not
eliminated.

Idempotent: content already matching the source is left untouched (no
rewrite, no mtime bump) so re-running this on every deploy is cheap and
side-effect-free when nothing changed.

Always ends with a content diff of installed-vs-source and an explicit
pass/fail verdict.

    python pa/scripts/install_git_hooks.py
    python pa/scripts/install_git_hooks.py --public-dir D:/other-location
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
HOOK_TARGET_REL = Path(".git/hooks/pre-push")
# Nested but independent: <repo root>/pa-public, own .git/, gitignored here.
DEFAULT_PUBLIC_DIR_NAME = "pa-public"


def _resolve_public_dir(root: Path, public_dir: Path | None) -> Path:
    """Explicit argument wins; else PA_PUBLIC_DIR env var; else <root>/pa-public."""
    if public_dir is not None:
        return Path(public_dir).resolve()
    env = os.environ.get("PA_PUBLIC_DIR")
    return Path(env).resolve() if env else (root / DEFAULT_PUBLIC_DIR_NAME).resolve()


def _make_executable(target: Path) -> None:
    """chmod +x — required on POSIX, a harmless no-op on Windows."""
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


def install(repo_root: Path | None = None, public_dir: Path | None = None) -> dict:
    """Copy the hook into the public mirror's hooks dir, returning:

        {method, changed, verified, target, source, warnings}

    method   always "copy" (kept in the result shape for compatibility with
             callers/scripts written against the old tiered installer).
    changed  False when an already-matching install was left untouched.
    verified True when installed content matches source content.
    """
    root = (repo_root or REPO_ROOT).resolve()
    source = (root / SOURCE_REL).resolve()
    target = _resolve_public_dir(root, public_dir) / HOOK_TARGET_REL
    warnings: list[str] = []

    if not source.exists():
        raise FileNotFoundError(f"hook source not found: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.is_symlink():
        # Never trust a symlink as-is, even one that happens to resolve to
        # matching content: a stale relative symlink from the pre-2026-08-06
        # shared-working-tree topology can coincidentally still resolve (e.g.
        # to the public repo's own tracked copy of this same script at the
        # same relative offset), and shutil.copyfile writes THROUGH a live
        # symlink into whatever it points at — silently mutating tracked
        # content instead of installing a real, independent copy.
        target.unlink()
    elif target.exists() and _content_matches(target, source):
        _make_executable(target)
        return _result(False, target, source, warnings)

    shutil.copyfile(source, target)
    _make_executable(target)
    return _result(True, target, source, warnings)


def _result(changed: bool, target: Path, source: Path, warnings: list[str]) -> dict:
    return {
        "method": "copy",
        "changed": changed,
        "verified": _content_matches(target, source),
        "target": target,
        "source": source,
        "warnings": warnings,
    }


def _display_rel(path: Path, start: Path) -> str:
    """`path` relative to `start` for display, tolerant of Windows cross-drive
    paths (relpath raises ValueError when they are on different mounts — which
    is now the COMMON case, since the public mirror is a different directory
    tree, possibly a different drive). Falls back to the absolute path."""
    try:
        return os.path.relpath(path, start)
    except ValueError:
        return str(path)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Install the public-mirror pre-push PII guard hook (copy).")
    parser.add_argument("--repo-root", help="Override the private repo root (tests).")
    parser.add_argument("--public-dir", help="Override the public mirror directory "
                                              "(default: $PA_PUBLIC_DIR or <repo root>/pa-public).")
    args = parser.parse_args(argv)

    root = Path(args.repo_root) if args.repo_root else REPO_ROOT
    public_dir = Path(args.public_dir) if args.public_dir else None
    try:
        res = install(root, public_dir)
    except FileNotFoundError as e:
        print(f"install_git_hooks: {e}", file=sys.stderr)
        return 1

    rel_target = _display_rel(res["target"], root)
    rel_source = _display_rel(res["source"], root)

    verb = "already installed" if not res["changed"] else "installed"
    print(f"{rel_target} {verb} as {res['method']} -> {rel_source}")

    for w in res["warnings"]:
        print(f"!! {w}", file=sys.stderr)

    if res["verified"]:
        print(f"drift check: CLEAN (installed content matches {rel_source})")
        return 0
    print(f"drift check: FAILED — installed hook content differs from {rel_source}",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
