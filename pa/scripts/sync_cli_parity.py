"""
Sync the portable "CLI-PARITY" regions of the global Claude Code brain file
(~/.claude/CLAUDE.md) into Gemini CLI's and Antigravity's own global rule
files, without touching either file's live-appended memory section.

Why not a symlink: Gemini CLI's save_memory tool appends facts to exactly
these files under a "## Gemini Added Memories" heading, loaded as context in
every subsequent session
(https://google-gemini.github.io/gemini-cli/docs/tools/memory.html). A
symlink would destroy memories already captured there and redirect all
future ones into Claude's own global brain file. Confirmed via inode check
(2026-07-29) that agy's GEMINI.md and AGY.md are two separate files kept
identical by convention, not a hardlink — both must be written.

Two regions are synced, matched by heading rather than a single contiguous
block, because "## Machine Notes" (Windows/this-machine-specific asides)
sits between them in CLAUDE.md and is deliberately NOT synced:
  - "principles": Working Principles + Brain Bootstrap + The Agentic Brain
  - "injection":   Prompt Injection Awareness

On first run (no CLI-PARITY markers yet in the target), each region is
spliced in by matching the target's OWN existing heading span (migrating an
already-hand-ported copy in place) and falls back to inserting right after
"## Gemini Added Memories" only if that heading doesn't exist in the target
at all. Once markers exist, subsequent syncs replace only the marked content.

Usage:
  python sync_cli_parity.py --check <target>   # print diff, exit 1 if drift
  python sync_cli_parity.py --apply <target>   # write target file(s)

<target> is one of:
  gemini   ~/.gemini/GEMINI.md (classic Gemini CLI)
  agy      ~/.gemini/antigravity-cli/GEMINI.md AND AGY.md (Antigravity)
"""
import argparse
import difflib
import os
import re
import sys

CLAUDE_MD_PATH = os.path.expanduser("~/.claude/CLAUDE.md")
GEMINI_MD_PATH = os.path.expanduser("~/.gemini/GEMINI.md")
AGY_DIR = os.path.expanduser("~/.gemini/antigravity-cli")
AGY_TARGET_PATHS = [os.path.join(AGY_DIR, "GEMINI.md"), os.path.join(AGY_DIR, "AGY.md")]

TARGETS = {
    "gemini": [GEMINI_MD_PATH],
    "agy": AGY_TARGET_PATHS,
}

CLAUDE_SKILLS_DIR = os.path.expanduser("~/.claude/skills")
# Antigravity's own docs: ~/.gemini/config/skills/ is a single shared global
# scope across Gemini CLI, Antigravity IDE, and Antigravity CLI — one mirror
# target covers both `gemini` and `agy`, unlike the brain files above.
SHARED_SKILLS_DIR = os.path.expanduser("~/.gemini/config/skills")

# Reviewed 2026-07-29 against ~/.claude/skills/ (22 skills total):
# - claude-sync EXCLUDED unconditionally — syncs Claude Code's own files by
#   definition; mirroring it into Antigravity would be actively wrong.
# - deep-plan, deep-recheck EXCLUDED — reference Claude-Code-only tool names
#   directly (EnterPlanMode, AskUserQuestion).
# - deep-recheck-loop, update-brain, shorten-brain EXCLUDED as a set — each
#   depends on /deep-recheck or /deep-recheck-loop as part of its own
#   process; mirroring any of them alone would leave a dangling
#   slash-command reference in Antigravity's catalog.
# Everything below scanned clean (no Claude-only tool names, no dependency
# on an excluded skill).
SKILL_MIRROR_ALLOWLIST = [
    "cloudflare", "cloudflare-email-service", "cloudflare-one",
    "cloudflare-one-migrations", "durable-objects", "sandbox-sdk",
    "agents-sdk", "workers-best-practices", "web-perf", "wrangler",
    "turnstile-spin", "transcription", "itr-tax-docs",
    "ultrathink", "check-brain",
]

# end_heading=None means "to the next top-level '## ' heading, or EOF".
REGIONS = [
    {"name": "principles", "start_heading": "## Working Principles", "end_heading": "## Machine Notes"},
    {"name": "injection", "start_heading": "## Prompt Injection Awareness", "end_heading": None},
]

BEGIN_MARKER = "<!-- CLI-PARITY:BEGIN:{name} -->"
END_MARKER = "<!-- CLI-PARITY:END:{name} -->"

MEMORIES_HEADING = "## Gemini Added Memories"

_NEXT_H2_RE = re.compile(r"^## ", re.MULTILINE)


def _find_heading_span(text, start_heading, end_heading):
    """Return (start, end) char offsets of the section starting at
    start_heading (inclusive) up to end_heading (exclusive). If end_heading
    is None, or given but not found in text, falls back to the next
    top-level '## ' heading after start_heading's own line, or end of file.
    Returns None if start_heading itself isn't found."""
    start = text.find(start_heading)
    if start == -1:
        return None
    if end_heading is not None:
        end = text.find(end_heading, start + len(start_heading))
        if end != -1:
            return (start, end)
    after_start_line = text.find("\n", start) + 1
    if after_start_line == 0:
        after_start_line = len(text)
    m = _NEXT_H2_RE.search(text, after_start_line)
    if m:
        return (start, m.start())
    return (start, len(text))


def _find_marked_span(text, name):
    """Return (outer_start, outer_end) spanning a full existing
    BEGIN..END marker pair for `name`, or None if absent/incomplete."""
    begin = BEGIN_MARKER.format(name=name)
    end = END_MARKER.format(name=name)
    b = text.find(begin)
    if b == -1:
        return None
    e = text.find(end, b)
    if e == -1:
        return None
    return (b, e + len(end))


def extract_region(claude_text, region):
    """Pull one region's content out of CLAUDE.md's text (source of truth).
    Prefers extracting strictly between existing CLI-PARITY markers (immune
    to whatever trailing content sits after the END marker, e.g. the
    do-not-hand-edit note) and falls back to heading-based extraction only
    when the source itself has no markers yet."""
    name = region["name"]
    begin = BEGIN_MARKER.format(name=name)
    end = END_MARKER.format(name=name)
    b = claude_text.find(begin)
    if b != -1:
        e = claude_text.find(end, b)
        if e != -1:
            return claude_text[b + len(begin):e].strip("\n")

    span = _find_heading_span(claude_text, region["start_heading"], region["end_heading"])
    if span is None:
        raise ValueError(f"Region {region['name']!r}: heading {region['start_heading']!r} not found in source")
    start, end_idx = span
    return claude_text[start:end_idx].rstrip("\n")


# Neither Gemini CLI nor Antigravity IS Claude Code (unlike zclaude, which
# literally is the Claude Code binary) — verbatim Claude-Code-flavored
# phrasing would regress the generalization the 2026-06-25 antigravity-cli
# hand-port already did by hand (e.g. "managed by the agent" instead of
# "managed by Claude Code"). Matches CLAUDE.md whether backtick-wrapped or
# bare; skips anything already expanded (idempotent re-apply).
# Two fixed-backtick alternatives rather than independently-optional
# backticks — an optional-on-both-ends pattern lets the regex engine
# backtrack past the negative lookahead by simply not consuming the closing
# backtick, silently defeating idempotency.
_CLAUDE_MD_RE = re.compile(r"`CLAUDE\.md`(?!/`AGY\.md`/`GEMINI\.md`)|(?<!`)CLAUDE\.md(?!`)(?!/AGY\.md/GEMINI\.md)")
_NEEDS_BRAIN_RE = re.compile(r"`\.claude-needs-brain`(?!\s*\(or)")
_MANAGED_BY_RE = re.compile(r"\bmanaged by Claude Code\b")


def _expand_claude_md(m):
    return "`CLAUDE.md`/`AGY.md`/`GEMINI.md`" if m.group(0).startswith("`") else "CLAUDE.md/AGY.md/GEMINI.md"


def generalize_for_non_claude(content):
    """Applied to extracted CLAUDE.md content before splicing into any
    non-Claude-Code target. Pure function — no I/O."""
    content = _CLAUDE_MD_RE.sub(_expand_claude_md, content)
    content = _NEEDS_BRAIN_RE.sub("`.claude-needs-brain` (or `.gemini-needs-brain`, `.agy-needs-brain`)", content)
    content = _MANAGED_BY_RE.sub("managed by the agent", content)
    return content


def splice_region_into_target(target_text, region, region_content):
    """Replace (steady state) or insert/migrate (first run) one named
    region in target_text. Pure function — no I/O."""
    name = region["name"]
    wrapped = f"{BEGIN_MARKER.format(name=name)}\n{region_content}\n{END_MARKER.format(name=name)}"

    marked = _find_marked_span(target_text, name)
    if marked is not None:
        start, end = marked
        return target_text[:start] + wrapped + target_text[end:]

    # First run: no markers yet. Try to migrate the target's own existing
    # (unmarked) copy of this section by heading match.
    span = _find_heading_span(target_text, region["start_heading"], region["end_heading"])
    if span is not None:
        start, end = span
        return target_text[:start] + wrapped + "\n\n" + target_text[end:]

    # Heading doesn't exist in target at all — insert right after the
    # CLI's own memory section so that stays the first thing it reads.
    mem_span = _find_heading_span(target_text, MEMORIES_HEADING, None)
    if mem_span is not None:
        insert_at = mem_span[1]
        return target_text[:insert_at] + "\n\n" + wrapped + "\n" + target_text[insert_at:]

    # No memories heading either — insert after any CLI-PARITY block(s)
    # already spliced in earlier in this same call (preserves region order
    # when multiple regions all hit this fallback), else at the very top.
    last_end = -1
    marker = "<!-- CLI-PARITY:END:"
    idx = target_text.find(marker)
    while idx != -1:
        close = target_text.find("-->", idx)
        if close != -1:
            last_end = close + len("-->")
        idx = target_text.find(marker, close if close != -1 else idx + 1)
    if last_end == -1:
        return wrapped + "\n\n" + target_text
    return target_text[:last_end] + "\n\n" + wrapped + target_text[last_end:]


def sync_all_regions(claude_text, target_text):
    """Apply all REGIONS in order. Pure function — no I/O."""
    for region in REGIONS:
        content = extract_region(claude_text, region)
        content = generalize_for_non_claude(content)
        target_text = splice_region_into_target(target_text, region, content)
    return target_text


def has_drift(claude_text, target_text):
    return sync_all_regions(claude_text, target_text) != target_text


def _dirs_equal(a, b):
    """Recursive, content-based (not mtime-based) directory comparison.

    filecmp.dircmp() has never accepted a `shallow` keyword argument — that
    belongs to filecmp.cmp()/filecmp.cmpfiles(), not dircmp's constructor.
    dircmp's own diff_files/same_files are always computed via a shallow
    (mtime+size) stat comparison with no way to force it deep through the
    class itself, so common_files must be content-compared explicitly.
    """
    import filecmp
    cmp = filecmp.dircmp(a, b)
    if cmp.left_only or cmp.right_only or cmp.funny_files:
        return False
    _match, mismatch, errors = filecmp.cmpfiles(a, b, cmp.common_files, shallow=False)
    if mismatch or errors:
        return False
    for sub in cmp.common_dirs:
        if not _dirs_equal(os.path.join(a, sub), os.path.join(b, sub)):
            return False
    return True


def mirror_skill_catalog(claude_skills_dir=CLAUDE_SKILLS_DIR, shared_skills_dir=SHARED_SKILLS_DIR,
                          allowlist=SKILL_MIRROR_ALLOWLIST, apply=False):
    """Copy (not symlink — must survive a machine without symlink privilege)
    each allowlisted skill's whole directory tree from claude_skills_dir into
    shared_skills_dir. Wholesale replace per skill on re-run (remove then
    copy), not a file-by-file merge, so a stale mirrored file left over from
    a shrunk source skill doesn't linger. Returns a list of
    (name, changed, note) tuples; note is None unless the source is missing."""
    import shutil

    results = []
    for name in allowlist:
        src = os.path.join(claude_skills_dir, name)
        dst = os.path.join(shared_skills_dir, name)
        if not os.path.isdir(src):
            results.append((name, False, "source missing"))
            continue
        changed = not (os.path.isdir(dst) and _dirs_equal(src, dst))
        if changed and apply:
            if os.path.isdir(dst):
                shutil.rmtree(dst)
            os.makedirs(shared_skills_dir, exist_ok=True)
            shutil.copytree(src, dst)
        results.append((name, changed, None))
    return results


def _read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def run(target_name, apply, claude_md_path=CLAUDE_MD_PATH, targets=TARGETS, out=sys.stdout):
    """Returns exit code: 0 if no drift (or successfully applied), 1 if
    --check found drift."""
    claude_text = _read(claude_md_path)
    exit_code = 0
    for path in targets[target_name]:
        target_text = _read(path)
        new_text = sync_all_regions(claude_text, target_text)
        if new_text == target_text:
            print(f"{path}: no drift", file=out)
            continue
        if apply:
            _write(path, new_text)
            print(f"{path}: applied", file=out)
        else:
            diff = difflib.unified_diff(
                target_text.splitlines(keepends=True),
                new_text.splitlines(keepends=True),
                fromfile=path,
                tofile=path + " (synced)",
            )
            out.writelines(diff)
            exit_code = 1
    return exit_code


def main(argv=None):
    # Windows console defaults stdout to cp1252, which can't encode the
    # em-dashes/arrows in CLAUDE.md's prose — crashes mid-diff otherwise.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("target", choices=sorted(TARGETS) + ["skills"])
    args = parser.parse_args(argv)
    if args.target == "skills":
        return run_skill_mirror(args.apply)
    return run(args.target, args.apply)


def run_skill_mirror(apply, claude_skills_dir=CLAUDE_SKILLS_DIR, shared_skills_dir=SHARED_SKILLS_DIR,
                      allowlist=SKILL_MIRROR_ALLOWLIST, out=sys.stdout):
    """Returns exit code: 0 if no drift (or successfully applied), 1 if
    --check found drift."""
    results = mirror_skill_catalog(
        claude_skills_dir=claude_skills_dir, shared_skills_dir=shared_skills_dir,
        allowlist=allowlist, apply=apply,
    )
    exit_code = 0
    for name, changed, note in results:
        if note:
            print(f"{name}: {note} — skipped", file=out)
            continue
        if not changed:
            print(f"{name}: no drift", file=out)
        elif apply:
            print(f"{name}: applied", file=out)
        else:
            print(f"{name}: drift", file=out)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
