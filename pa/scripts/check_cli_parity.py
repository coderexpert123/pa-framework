"""
On-demand drift checker for CLI brain/skill parity — a thin combined-report
wrapper around sync_cli_parity.py's --check targets (gemini, agy, codex for
the brain files; skills, codex-skills for the mirrored skill catalogs). Not
wired into any schedule/skill trigger in this pass (per
the 2026-07-29 CLI/brain parity plan, Phase 4) — manual/
on-demand only. A natural fit for the update-brain nightly cadence later,
once proven stable unattended (brain-recheck's own cadence was folded into
update-brain's Step 9 on 2026-08-28 and no longer runs independently).

Usage:
  python check_cli_parity.py

Exit code: 0 if nothing has drift, 1 if anything does (any target's --check
found a difference, or raised an error trying to read its files).
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync_cli_parity as scp

# Order is the report order. Brain-file targets first, then the skill
# catalogs — a mirror target is dispatched by membership in
# sync_cli_parity.MIRROR_TARGETS, never by hard-coded name.
TARGETS = ["gemini", "agy", "skills", "codex", "codex-skills", "devin", "devin-skills"]


def check_target(name, out=sys.stdout):
    """Run --check for one target, capturing sync_cli_parity's own report
    output. Returns (name, exit_code, report_text, error). error is the
    exception if the target's files couldn't even be read (e.g. missing
    CLAUDE.md or target file) — reported as drift-equivalent (exit 1) rather
    than crashing the whole combined report."""
    buf = io.StringIO()
    try:
        if name in scp.MIRROR_TARGETS:
            # Same per-target exclusions main() applies — a registered mirror
            # target must never report drift for a skill it deliberately
            # does not mirror (e.g. `loop` on devin-skills).
            allowlist = [
                n for n in scp.SKILL_MIRROR_ALLOWLIST
                if n not in scp.TARGET_SKILL_EXCLUDES.get(name, set())
            ]
            code = scp.run_skill_mirror(
                apply=False, shared_skills_dir=scp.MIRROR_TARGETS[name],
                allowlist=allowlist, out=buf)
        else:
            code = scp.run(name, apply=False, out=buf)
        return (name, code, buf.getvalue(), None)
    except Exception as exc:  # noqa: BLE001 - surfaced in the report, not swallowed
        return (name, 1, buf.getvalue(), exc)


def run(targets=TARGETS, out=sys.stdout):
    """Returns exit code: 0 if no target has drift, 1 if any does."""
    results = [check_target(name, out=out) for name in targets]

    print("CLI brain/skill parity check", file=out)
    print("=" * 40, file=out)
    overall_code = 0
    for name, code, report, error in results:
        status = "DRIFT" if code != 0 else "clean"
        print(f"\n[{name}] {status}", file=out)
        if error is not None:
            print(f"  ERROR: {error}", file=out)
        elif report.strip():
            for line in report.rstrip("\n").splitlines():
                print(f"  {line}", file=out)
        if code != 0:
            overall_code = 1

    print("", file=out)
    if overall_code == 0:
        print("All targets clean — no drift detected.", file=out)
    else:
        drifted = [name for name, code, _, _ in results if code != 0]
        print(f"Drift detected in: {', '.join(drifted)}", file=out)
        print("Run: python sync_cli_parity.py --apply <target> to fix.", file=out)

    return overall_code


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    return run()


if __name__ == "__main__":
    sys.exit(main())
