"""
On-demand drift checker for CLI brain/skill parity — a thin combined-report
wrapper around sync_cli_parity.py's three --check targets (gemini, agy,
skills). Not wired into any schedule/skill trigger in this pass (per
plans/2026-07-29-cli-brain-skill-parity-agy-gemini.md Phase 4) — manual/
on-demand only. A natural fit for the brain-recheck cadence later, once
proven stable unattended.

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

TARGETS = ["gemini", "agy", "skills"]


def check_target(name, out=sys.stdout):
    """Run --check for one target, capturing sync_cli_parity's own report
    output. Returns (name, exit_code, report_text, error). error is the
    exception if the target's files couldn't even be read (e.g. missing
    CLAUDE.md or target file) — reported as drift-equivalent (exit 1) rather
    than crashing the whole combined report."""
    buf = io.StringIO()
    try:
        if name == "skills":
            code = scp.run_skill_mirror(apply=False, out=buf)
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
