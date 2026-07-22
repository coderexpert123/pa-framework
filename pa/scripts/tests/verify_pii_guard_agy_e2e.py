"""
Group B — REAL end-to-end verification of pre-push-pii-guard's main(), invoked
as an actual subprocess exactly the way git invokes a pre-push hook.

This is DELIBERATELY NOT a unittest / pytest module. Everything the orchestrator
already verified (agy_check() in-process against a real agy binary, _run_agy's
tree-kill against a simulated stuck process) proved the PIECES work. This
script closes the remaining gap: the FULL script, run as `python
pre-push-pii-guard`, fed the real pre-push stdin protocol
("<local ref> <local sha1> <remote ref> <remote sha1>\n"), against a REAL
temporary git repository, with a REAL (uninstrumented, non-mocked) agy binary
where the scenario calls for one. No mocks anywhere in this file.

Two of the six scenarios below make a real agy call (~11-101s observed by the
orchestrator on 2026-07-22, occasionally a bit more with a retry) — this
script genuinely takes a few minutes to run. That is expected. Do not "fix"
it by mocking agy_check; the entire point of this file is that it does not.

Run directly:
    python pa/scripts/tests/verify_pii_guard_agy_e2e.py

Exit code: 0 if every scenario's assertions held, 1 otherwise (with a summary
printed either way — this script reports reality, it does not silently pass).

Hard constraint honored: this file does not import pre-push-pii-guard's code
and does not touch its logic. It only shells out to it, the same way git
itself does.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import traceback
from dataclasses import dataclass, field

# Same fix the guard itself carries (AI-097 class): the guard's own stderr
# uses non-ASCII markers (e.g. U+2139 in its "info" lines), and this script's
# console may be cp1252. Without this, printing a captured stderr tail can
# crash the harness itself — which is exactly the failure class this file
# exists to catch, just one frame further out. Caught it live on the first
# real run (2026-07-22): scenario 1 actually completed, but the summary print
# raised UnicodeEncodeError on 'ℹ' before the result could be recorded.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
GUARD_PATH = os.path.join(REPO_ROOT, "pa", "scripts", "git-hooks", "pre-push-pii-guard")
PA_HOME_REAL = os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")
SECRETS_PATH = os.path.join(PA_HOME_REAL, "secrets.env")

ZERO_SHA = "0" * 40
# Generous ceiling for a real agy call: AGY_TIMEOUT(150s) * MAX_ATTEMPTS(2) in
# the guard itself, plus slack for process startup/teardown on this machine.
REAL_AGY_SUBPROCESS_TIMEOUT = 340
FAST_TIMEOUT = 30  # for scenarios where agy is deliberately unreachable


def _load_real_agy_cmd() -> str | None:
    """Read AGY_CMD out of ~/.pa/secrets.env the same way the guard's own
    _load_secrets() does, without importing the guard module."""
    try:
        with open(SECRETS_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == "AGY_CMD":
                    return val.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return None


def _rmtree(path: str) -> None:
    """shutil.rmtree(ignore_errors=True) alone silently LEAKS temp dirs on
    Windows: git marks some objects read-only, and rmtree's default handler
    can't delete a read-only file — ignore_errors=True then swallows that
    PermissionError and moves on, leaving the directory behind (observed:
    27 stray pa-pii-guard-e2e-* dirs in %TEMP% after a handful of runs during
    this harness's own development). Clear the read-only bit first so the
    real removal actually happens; still never raise — a cleanup failure
    must not fail the scenario whose result already got recorded."""
    def _on_error(func, target, exc_info):
        try:
            os.chmod(target, 0o666)
            func(target)
        except Exception:
            pass
    shutil.rmtree(path, onerror=_on_error)


def _git(repo_dir: str, *args: str) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-C", repo_dir, *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {repo_dir}: {result.stderr}")
    return result


def _init_repo() -> str:
    repo_dir = tempfile.mkdtemp(prefix="pa-pii-guard-e2e-")
    _git(repo_dir, "init", "-q")
    _git(repo_dir, "config", "user.email", "e2e-fixture@example.invalid")
    _git(repo_dir, "config", "user.name", "PII Guard E2E Fixture")
    return repo_dir


def _commit(repo_dir: str, filename: str, content: str, message: str) -> str:
    with open(os.path.join(repo_dir, filename), "w", encoding="utf-8") as f:
        f.write(content)
    _git(repo_dir, "add", filename)
    _git(repo_dir, "commit", "-q", "-m", message)
    return _git(repo_dir, "rev-parse", "HEAD").stdout.strip()


GENERIC_CONTENT = textwrap.dedent(
    """\
    # Utility helpers for the e2e fixture repo — nothing sensitive here.
    def add(a, b):
        return a + b

    def multiply(a, b):
        return a * b
    """
)

# Clearly synthetic (fabricated, not a real person — per the task's own
# instruction) but DELIBERATELY not watermarked as fake: no "test",
# "fixture", "example", "demo", or "placeholder" wording anywhere in it,
# because agy_check's own prompt explicitly tells it NOT to block "generic
# placeholder data (example@example.com, 12345, TODO, etc.)". An earlier
# draft of this fixture used "...testfixture@fakemail-example.net" and
# "internal draft" / "demo schedule" — agy read those signals exactly as
# designed and correctly did NOT flag it (real run, 2026-07-22: exit 0,
# "PII guard: clean"). That was this harness's bug, not the guard's: real PII
# does not announce itself as a placeholder. This version is shaped exactly
# like a real client record — full name, personal email, phone, card number
# — none of which match the structural CREDENTIAL_PATTERNS (no token shapes)
# or this user's real ~/.pa/pii-tripwires.txt entries (keyed to real
# identifiers, not this invented one) — so a block here is the agy semantic
# layer catching it, not layers 0-2.
PII_CONTENT = textwrap.dedent(
    """\
    Client details for the escrow transfer:
    Priya Fernandes
    Email: priya.fernandes82@gmail.com
    Phone: +91-98765-43210
    Card on file: 4539 1488 0343 6467
    """
)


def _run_guard(
    repo_dir: str,
    new_sha: str,
    old_sha: str,
    env_overrides: dict[str, str],
    timeout: float,
) -> subprocess.CompletedProcess:
    """Invoke `python pre-push-pii-guard` as a REAL subprocess through its
    actual __main__ entry point, feeding the real pre-push stdin protocol."""
    stdin_text = f"refs/heads/main {new_sha} refs/heads/main {old_sha}\n"
    env = dict(os.environ)
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, GUARD_PATH],
        input=stdin_text,
        cwd=repo_dir,
        env=env,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout,
    )


@dataclass
class ScenarioResult:
    name: str
    passed: bool
    detail: str
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""


RESULTS: list[ScenarioResult] = []


def _record(name: str, passed: bool, detail: str, proc: subprocess.CompletedProcess | None = None) -> None:
    RESULTS.append(ScenarioResult(
        name=name, passed=passed, detail=detail,
        exit_code=proc.returncode if proc is not None else None,
        stdout=proc.stdout if proc is not None else "",
        stderr=proc.stderr if proc is not None else "",
    ))
    status = "PASS" if passed else "FAIL"
    rc = proc.returncode if proc is not None else "n/a"
    print(f"[{status}] {name} (exit={rc}) — {detail}")


def scenario_pii_blocks_real_agy(real_agy_cmd: str) -> None:
    name = "1: unambiguous fake PII -> real agy -> exit 1"
    repo_dir = _init_repo()
    try:
        old_sha = _commit(repo_dir, "utils.py", GENERIC_CONTENT, "initial: generic utils")
        new_sha = _commit(repo_dir, "notes.txt", PII_CONTENT, "add meeting notes")
        proc = _run_guard(
            repo_dir, new_sha, old_sha,
            env_overrides={"AGY_CMD": real_agy_cmd},
            timeout=REAL_AGY_SUBPROCESS_TIMEOUT,
        )
        ok = proc.returncode == 1 and (
            "violation" in proc.stderr.lower() or "aborted" in proc.stderr.lower()
        )
        _record(name, ok,
                 "expected exit 1 with a violation mentioned in stderr" if ok
                 else f"UNEXPECTED — stderr tail: {proc.stderr[-800:]!r}",
                 proc)
    finally:
        _rmtree(repo_dir)


def scenario_generic_content_passes_real_agy(real_agy_cmd: str) -> None:
    name = "2: generic content -> real agy -> exit 0"
    repo_dir = _init_repo()
    try:
        old_sha = _commit(repo_dir, "README.md", "# fixture repo\n", "initial: readme")
        new_sha = _commit(repo_dir, "utils.py", GENERIC_CONTENT, "add generic helpers")
        proc = _run_guard(
            repo_dir, new_sha, old_sha,
            env_overrides={"AGY_CMD": real_agy_cmd},
            timeout=REAL_AGY_SUBPROCESS_TIMEOUT,
        )
        ok = proc.returncode == 0
        _record(name, ok,
                 "expected exit 0 (clean)" if ok
                 else f"UNEXPECTED — stderr tail: {proc.stderr[-800:]!r}",
                 proc)
    finally:
        _rmtree(repo_dir)


def scenario_broken_agy_fails_closed() -> None:
    name = "3: agy unreachable -> FAIL-CLOSED -> exit 1 (the policy-change proof)"
    repo_dir = _init_repo()
    try:
        old_sha = _commit(repo_dir, "README.md", "# fixture repo\n", "initial: readme")
        # Same generic, layers-0-2-clean content as scenario 2 — the ONLY
        # variable that changes is whether agy can be reached. If this exits
        # 1, it is proof the fail-closed branch (added 2026-07-22) is really
        # wired into main(), not just present in the source.
        new_sha = _commit(repo_dir, "utils.py", GENERIC_CONTENT, "add generic helpers")
        broken_agy_cmd = os.path.join(repo_dir, "does-not-exist-agy-binary-xyz")
        proc = _run_guard(
            repo_dir, new_sha, old_sha,
            env_overrides={"AGY_CMD": broken_agy_cmd},
            timeout=FAST_TIMEOUT,
        )
        ok = proc.returncode == 1 and "fail-closed" in proc.stderr.lower()
        _record(name, ok,
                 "expected exit 1, stderr naming fail-closed policy" if ok
                 else f"UNEXPECTED — exit {proc.returncode}, stderr tail: {proc.stderr[-800:]!r}",
                 proc)
    finally:
        _rmtree(repo_dir)


def scenario_bypass_still_works() -> None:
    name = "6: PA_SKIP_PII_GUARD=1 still bypasses even with agy broken -> exit 0 + jsonl record"
    repo_dir = _init_repo()
    pa_home_tmp = tempfile.mkdtemp(prefix="pa-pii-guard-e2e-pahome-")
    try:
        old_sha = _commit(repo_dir, "README.md", "# fixture repo\n", "initial: readme")
        new_sha = _commit(repo_dir, "utils.py", GENERIC_CONTENT, "add generic helpers")
        broken_agy_cmd = os.path.join(repo_dir, "does-not-exist-agy-binary-xyz")
        proc = _run_guard(
            repo_dir, new_sha, old_sha,
            env_overrides={
                "AGY_CMD": broken_agy_cmd,
                "PA_SKIP_PII_GUARD": "1",
                "PA_HOME": pa_home_tmp,
            },
            timeout=FAST_TIMEOUT,
        )
        bypass_log = os.path.join(pa_home_tmp, "pii-guard-bypass.jsonl")
        log_exists = os.path.exists(bypass_log)
        log_content = ""
        if log_exists:
            with open(bypass_log, encoding="utf-8") as f:
                log_content = f.read()
        ok = proc.returncode == 0 and log_exists and "pii-guard-bypass" in log_content
        detail = (
            "expected exit 0 + a bypass record written to the temp PA_HOME's jsonl"
            if ok else
            f"UNEXPECTED — exit {proc.returncode}, log_exists={log_exists}, "
            f"log_content={log_content[:300]!r}, stderr tail={proc.stderr[-500:]!r}"
        )
        _record(name, ok, detail, proc)
    finally:
        _rmtree(repo_dir)
        _rmtree(pa_home_tmp)


def scenario_empty_tree_base_first_push() -> None:
    """Bonus coverage (cheap, no real agy call needed): a brand-new branch's
    first-ever push has remote_sha == all zeros, which collect_diff() must
    resolve to EMPTY_TREE as the diff base — not skip / crash. Uses the
    broken-agy fail-closed path so it stays fast; the assertion here is about
    collect_diff's EMPTY_TREE branch actually being reached and producing a
    real violation-worthy diff (all of utils.py's lines are 'added' against
    the empty tree), not specifically about agy."""
    name = "bonus: empty-tree base (first-ever push, remote_sha=0x40) is handled"
    repo_dir = _init_repo()
    try:
        # A single commit — this whole file is "new" against remote_sha=0000...
        new_sha = _commit(repo_dir, "utils.py", GENERIC_CONTENT, "first commit ever")
        broken_agy_cmd = os.path.join(repo_dir, "does-not-exist-agy-binary-xyz")
        proc = _run_guard(
            repo_dir, new_sha, ZERO_SHA,
            env_overrides={"AGY_CMD": broken_agy_cmd},
            timeout=FAST_TIMEOUT,
        )
        # Generic content, layers 0-2 clean, agy unreachable -> fail-closed -> 1.
        # The key proof is that this didn't crash/hang on the zero-sha base and
        # that the guard's own scope banner shows non-zero ADDED lines were seen
        # (i.e. EMPTY_TREE diffing actually produced content, not an empty scan).
        ok = proc.returncode == 1 and "added line" in proc.stderr.lower()
        _record(name, ok,
                 "expected exit 1 (fail-closed) with added lines actually scanned" if ok
                 else f"UNEXPECTED — exit {proc.returncode}, stderr tail: {proc.stderr[-800:]!r}",
                 proc)
    finally:
        _rmtree(repo_dir)


def main() -> int:
    print(f"Guard under test: {GUARD_PATH}")
    if not os.path.exists(GUARD_PATH):
        print(f"FATAL: guard script not found at {GUARD_PATH}")
        return 1

    real_agy_cmd = os.environ.get("AGY_CMD") or _load_real_agy_cmd()
    if not real_agy_cmd or not os.path.exists(real_agy_cmd):
        print(
            f"FATAL: could not resolve a real agy binary (got {real_agy_cmd!r}) — "
            f"scenarios 1 and 2 require a REAL agy call and cannot be faked. "
            f"Checked $AGY_CMD env and {SECRETS_PATH}."
        )
        return 1
    print(f"Real agy binary resolved to: {real_agy_cmd}")
    print(
        "Scenarios 1 and 2 make REAL agy calls (~11-101s each observed "
        "2026-07-22, occasionally more with a retry) — this will take a few "
        "minutes. That is expected; nothing here is mocked.\n"
    )

    # Fast, deterministic scenarios first so a failure there is known before
    # burning minutes on real agy calls.
    try:
        scenario_broken_agy_fails_closed()
    except Exception:
        _record("3: agy unreachable -> FAIL-CLOSED", False, f"raised: {traceback.format_exc()}")

    try:
        scenario_bypass_still_works()
    except Exception:
        _record("6: PA_SKIP_PII_GUARD bypass", False, f"raised: {traceback.format_exc()}")

    try:
        scenario_empty_tree_base_first_push()
    except Exception:
        _record("bonus: empty-tree base", False, f"raised: {traceback.format_exc()}")

    # Slow, real-agy scenarios last.
    try:
        scenario_pii_blocks_real_agy(real_agy_cmd)
    except subprocess.TimeoutExpired:
        _record("1: unambiguous fake PII -> real agy -> exit 1", False,
                 f"subprocess exceeded {REAL_AGY_SUBPROCESS_TIMEOUT}s — real agy call never returned")
    except Exception:
        _record("1: unambiguous fake PII -> real agy -> exit 1", False, f"raised: {traceback.format_exc()}")

    try:
        scenario_generic_content_passes_real_agy(real_agy_cmd)
    except subprocess.TimeoutExpired:
        _record("2: generic content -> real agy -> exit 0", False,
                 f"subprocess exceeded {REAL_AGY_SUBPROCESS_TIMEOUT}s — real agy call never returned")
    except Exception:
        _record("2: generic content -> real agy -> exit 0", False, f"raised: {traceback.format_exc()}")

    print("\n===== SUMMARY =====")
    n_pass = sum(1 for r in RESULTS if r.passed)
    for r in RESULTS:
        print(f"  [{'PASS' if r.passed else 'FAIL'}] {r.name}")
    print(f"{n_pass}/{len(RESULTS)} scenarios passed.")

    if "--verbose" in sys.argv:
        print("\n===== FULL OUTPUT PER SCENARIO (--verbose) =====")
        for r in RESULTS:
            print(f"\n--- {r.name} (exit={r.exit_code}) ---")
            print("  stdout:")
            print(textwrap.indent(r.stdout.strip() or "(empty)", "    "))
            print("  stderr:")
            print(textwrap.indent(r.stderr.strip() or "(empty)", "    "))

    return 0 if n_pass == len(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
