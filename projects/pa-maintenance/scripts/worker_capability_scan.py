#!/usr/bin/env python3
"""Daily drift watchdog for the worker-tunables surface in ~/.pa/config.yaml.

Prints either the single word NO_OUTPUT (nothing drifted) or a compact report,
and pages pa-alerts when — and only when — config declares a flag the CLI does
not actually have.

Why this exists
---------------
`config.yaml` declares, per worker, which knobs exist (`tunables.<name>.args`
is an ARG TEMPLATE) and the Telegram bot exposes /llm and /effort against those
declarations. The entire design rests on config accurately describing what each
CLI accepts, and when it does not the failure is nasty: a flag the CLI does not
have fails EVERY dispatch to that worker and presents as an outage, not as a
settings error. Four real drifts happened inside a few days:

  * the scaffolded `agy` worker declared `--yolo` and `--output-format`; agy has
    NEITHER, so a fresh `pa init` produced a worker that could not run at all.
    Nothing asserted it, so it went unnoticed.
  * agy's `state_pattern` was `*.pb` while the directory holds only `*.db`.
  * agy self-updated 1.0.13 -> 1.1.5 mid-session and its model moved from
    Gemini 3.5 Flash to 3.6 Flash.
  * a written brief asserted claude/zclaude had no `--effort` flag. They do.
    Only reading `--help` caught it.

So the PRIMARY job here is drift DETECTION; refreshing the value catalogue is
the by-product. Diffing flag lists is deterministic, so per CLAUDE.md this is a
committed script invoked by absolute path, never LLM reasoning — and unlike a
model, a script cannot hallucinate a flag into existence.

Two invariants that are deliberate, not oversights
--------------------------------------------------
1. THIS SCRIPT NEVER WRITES ~/.pa/config.yaml. config.yaml is hand-maintained
   human INTENT (its comments carry live-verified evidence, `supersedes:`
   relationships, and why-not rationale). The cache this script writes is
   OBSERVED REALITY, and the two are merged only at display time. A cron job
   that silently rewrites a hand-edited config is how intent gets lost.
2. A DECLARED FLAG IS NEVER AUTO-REMOVED, in config or anywhere else. Detecting
   that one vanished is a PAGE, not a fix: auto-removal would silently disable
   a setting the user depends on and turn a loud, diagnosable outage into a
   quiet behaviour change. The script only ever ADDS observed facts.

   This is why diff_worker() MERGES each run's observation with the previous
   cache entry instead of overwriting it: a single transient probe failure
   (a `--help` timeout, an empty `agy models` reply) must never wipe a
   worker's previously-known flags down to `[]` or a value list down to `{}`.
   See diff_worker()'s docstring for the mechanics. DO NOT let a future
   "simplification" flatten this back into `cache_workers[name] = observed`
   without the merge — that is exactly the bug this cache exists to prevent.

Classification
--------------
  BREAKING  a flag declared in the worker's own `args:` or in any tunable's
            `args:` template does not appear ANYWHERE in `--help`. This is the
            `--yolo` case. Pages pa-alerts.
  INFO      a CLI version changed, new flags appeared, or the CLI prints values
            config does not know about. Recorded and reported, never paged.

Usage:  python "C:/pa-checkout/projects/pa-maintenance/scripts/worker_capability_scan.py"
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

# Windows pipes default to cp1252 and CLI help text is full of box-drawing
# characters, em-dashes and the occasional emoji (same bug class as the
# 2026-07-08 PII-guard encoding fix and the 2026-07-12 collect_diff regression).
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_CLI_TIMEOUT = 90          # seconds per --version / --help invocation
DEFAULT_SUBCOMMAND_TIMEOUT = 150  # `agy models` was measured at 13-27s
MAX_REPORT_CHARS = 3000

# Flags that a CLI genuinely accepts but does not print in --help. Adding an
# entry here suppresses a BREAKING finding, so ONLY add a flag after running it
# live against the CLI and seeing it accepted. Left empty deliberately: an empty
# allowlist is the honest starting state, and every entry is a permanent
# exception to the one check that matters.
KNOWN_UNDOCUMENTED: dict[str, set[str]] = {}

# Workers whose value vocabulary lives behind a subcommand rather than --help.
#
# `agy models` HANGS FOREVER when launched from a Git Bash / MSYS shell (242s,
# rc=124, zero bytes on BOTH stdout and stderr — verified 2026-07-22) but
# answers in 13-27s from PowerShell. It is NOT a TTY gate: the working case had
# Console.IsOutputRedirected == True. Root cause unknown, so the fix is
# empirical — go through PowerShell — and a non-response is treated as a SOFT
# failure so one wedged CLI can never stall the daily run.
SUBCOMMAND_VALUE_SOURCES: dict[str, dict] = {
    "agy": {"setting": "model", "args": ["models"], "via": "powershell", "filter": "gemini"},
    "agyc": {"setting": "model", "args": ["models"], "via": "powershell", "filter": "non-gemini"},
}

STATIC_VALUE_DEFAULTS: dict[str, dict[str, list[str]]] = {
    "zclaude": {
        "model": [
            "glm-5.3",
            "glm-5.3[1m]",
            "glm-4.7",
            "glm-5-turbo",
            "fable",
            "opus",
            "sonnet",
            "haiku",
        ],
    },
    "claude": {
        "model": [
            "opusplan",
            "claude-opus-4-6-thinking",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
            "fable",
            "opus",
            "sonnet",
            "haiku",
        ],
    },
    "codex": {
        "model": [
            "gpt-5.4",
            "gpt-4o",
            "o3",
            "o3-mini",
            "o4-mini",
        ],
    },
}

BREAKING = "BREAKING"
INFO = "INFO"


# ---------------------------------------------------------------------------
# secrets — Task Scheduler gives this process neither the bot's environment nor
# its cwd, so secrets are read straight from ~/.pa/secrets.env. Never hardcode a
# token or a chat id. (Reference: projects/coding-dirs-updater/update_coding_dirs.py)
# ---------------------------------------------------------------------------

_SECRETS_CACHE: dict | None = None


def pa_home() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa"))


def _load_secrets() -> dict:
    path = pa_home() / "secrets.env"
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                out[key.strip()] = val.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return out


def _secret(key: str, default=None):
    """os.environ wins, then ~/.pa/secrets.env, then the default."""
    global _SECRETS_CACHE
    if key in os.environ and os.environ[key]:
        return os.environ[key]
    if _SECRETS_CACHE is None:
        _SECRETS_CACHE = _load_secrets()
    return _SECRETS_CACHE.get(key, default)


def alert_chat_id() -> str | None:
    """pa-alerts if configured, else the supergroup.

    TELEGRAM_CHAT_ID is comma-separated and its order is NOT meaningful: parse
    by SIGN — a supergroup id is negative, a DM id is positive.
    """
    explicit = _secret("PA_ALERTS_CHAT_ID")
    if explicit:
        return explicit
    raw = _secret("TELEGRAM_CHAT_ID") or ""
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    for p in parts:
        if p.startswith("-"):
            return p
    return parts[0] if parts else None


# ---------------------------------------------------------------------------
# subprocess — hard timeout with PROCESS-TREE kill
# ---------------------------------------------------------------------------

def kill_process_tree(proc: subprocess.Popen) -> None:
    """Kill proc AND every descendant.

    DO NOT REGRESS THIS INTO subprocess.run(timeout=...). On Windows the argv is
    typically `cmd /c shim.cmd ...`; a plain timeout kills only the cmd.exe
    wrapper and orphans the real grandchild, which then busy-spins at 100% CPU
    forever with a broken stdin pipe (observed 2026-07-20: six orphans burning
    six cores, one leaked per timed-out call). agy in particular is known to
    hang indefinitely on some invocations, so this path is load-bearing here.
    """
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True, timeout=30,
                encoding="utf-8", errors="replace",
            )
        except Exception:
            pass
    else:
        import signal
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        proc.kill()
    except Exception:
        pass


def run_capture(argv: list[str], timeout: float) -> dict:
    """Run argv, capture stdout+stderr, tree-kill on timeout. Never raises.

    Returns {ok, rc, out, err, timedOut}. `ok` means "the process answered",
    not "it exited 0" — several CLIs exit non-zero on --help.

    encoding="utf-8", errors="replace" is mandatory on EVERY subprocess call
    site in this repo: without it Windows decodes with cp1252 and one emoji or
    box-drawing byte raises mid-read. That exact omission silently emptied a
    whole scan on 2026-07-12 while the caller reported success.
    """
    kwargs: dict = dict(
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if os.name != "nt":
        kwargs["start_new_session"] = True  # so killpg has a group of our own
    try:
        proc = subprocess.Popen(argv, **kwargs)
    except (OSError, ValueError) as e:
        return {"ok": False, "rc": None, "out": "", "err": str(e), "timedOut": False}
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_process_tree(proc)
        try:  # reap so the pipes close and no zombie lingers
            proc.communicate(timeout=10)
        except Exception:
            pass
        return {"ok": False, "rc": None, "out": "", "err": f"timed out after {timeout}s",
                "timedOut": True}
    return {"ok": True, "rc": proc.returncode, "out": out or "", "err": err or "",
            "timedOut": False}


def resolve_argv(argv: list[str]) -> list[str]:
    """A .cmd/.bat shim cannot be exec'd with a list argv on Windows — it needs
    the cmd.exe interpreter. Missing this is what kept the PII guard's semantic
    layer silently disabled (AI-094)."""
    if not argv:
        return argv
    if os.name == "nt" and str(argv[0]).lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", *argv]
    return argv


def powershell_argv(command: str, sub_args: list[str]) -> list[str] | None:
    """Wrap `command sub_args...` for PowerShell. See SUBCOMMAND_VALUE_SOURCES."""
    shell = shutil.which("pwsh") or shutil.which("powershell")
    if not shell:
        return None
    def q(s: str) -> str:
        return "'" + str(s).replace("'", "''") + "'"
    line = "& " + q(command) + ("".join(" " + q(a) for a in sub_args))
    return [shell, "-NoProfile", "-NonInteractive", "-Command", line]


# ---------------------------------------------------------------------------
# pure parsing / diffing (everything below is unit-tested without a CLI)
# ---------------------------------------------------------------------------

LONG_FLAG_RE = re.compile(r"(?<![\w-])--[A-Za-z][A-Za-z0-9-]*")
SHORT_FLAG_RE = re.compile(r"(?<![\w-])-[A-Za-z](?![\w-])")
VERSION_RE = re.compile(r"\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?\b")

# Help text writes flag FAMILIES with a bracketed optional part rather than one
# line per member: Claude Code 2.1.217 documents `--append-system-prompt-file`
# only as `--append-system-prompt[-file]`, and `--no-` families commonly appear
# as `--[no-]colour`. Without expanding these the plain token scan sees the base
# name only and reports a live, daily-used flag as BREAKING — which is exactly
# the false page this script must not produce (caught on the first real run,
# 2026-07-22).
_OPT_SUFFIX_RE = re.compile(r"(?<![\w-])(--[A-Za-z][A-Za-z0-9-]*)\[(-?[A-Za-z0-9-]+)\]")
_OPT_PREFIX_RE = re.compile(r"(?<![\w-])--\[([A-Za-z0-9-]+)\]([A-Za-z0-9-]+)")


def expand_bracketed_flags(text: str) -> set[str]:
    """Members of a bracketed flag family, e.g. `--append-system-prompt[-file]`
    -> `--append-system-prompt-file`, `--[no-]cache` -> `--cache`, `--no-cache`.

    The joining hyphen is only inserted when the bracketed suffix does NOT
    already supply one: `--append-system-prompt[-file]` means the full flag is
    `--append-system-prompt-file` (the bracket already carries the `-`), while
    a CLI documenting `--cache[d]` means `--cached` (no hyphen in the member) —
    unconditionally inserting one there would wrongly produce `--cache-d`.
    """
    out: set[str] = set()
    for base, suffix in _OPT_SUFFIX_RE.findall(text or ""):
        out.add(base)
        # Concatenate directly — do NOT insert a joining hyphen. When the
        # captured suffix already starts with one (e.g. "-file"), simple
        # concatenation reproduces it exactly; when it doesn't (e.g. "d" for
        # `--cache[d]` -> `--cached`), inserting one would be wrong.
        out.add(f"{base}{suffix}")
    for prefix, rest in _OPT_PREFIX_RE.findall(text or ""):
        out.add(f"--{rest}")
        out.add(f"--{prefix.rstrip('-')}-{rest}")
    return out


def load_config(path: Path) -> dict:
    """Read config.yaml. READ-ONLY — this script never writes it (see module docstring)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        data = yaml.safe_load(f) or {}
    return data if isinstance(data, dict) else {}


def workers_of(config: dict) -> list[dict]:
    raw = config.get("workers")
    return [w for w in raw if isinstance(w, dict) and w.get("name")] if isinstance(raw, list) else []


def base_argv(worker: dict) -> list[str]:
    """The CLI invocation prefix: `command` plus any leading POSITIONAL args.

    Stops at the first flag or template placeholder, which keeps subcommand
    routing intact — codex's tunables target `codex exec`, so the help that
    matters is `node codex.js exec --help`, not `node codex.js --help`.
    """
    cmd = worker.get("command")
    if not cmd:
        return []
    argv = [str(cmd)]
    for a in worker.get("args") or []:
        s = str(a)
        if s.startswith("-") or "{" in s:
            break
        argv.append(s)
    return argv


def version_argv(worker: dict) -> list[str]:
    """Prefer the worker's own `check:` when it already asks for a version —
    it is the invocation the dispatcher itself trusts. Otherwise base + --version.
    `check: where gemini.cmd` is a presence probe, not a version probe, so it is
    ignored here."""
    check = worker.get("check")
    if isinstance(check, str) and "--version" in check:
        try:
            import shlex
            parts = shlex.split(check, posix=False)
        except ValueError:
            parts = check.split()
        parts = [p.strip('"') for p in parts if p.strip()]
        if parts:
            return parts
    base = base_argv(worker)
    return base + ["--version"] if base else []


def declared_flags(worker: dict) -> dict[str, list[str]]:
    """Every flag config claims the CLI accepts -> where it was declared.

    Both sources matter: a bogus flag in `args:` breaks every dispatch, and a
    bogus flag in a tunable template breaks every dispatch made once that knob
    is set (which is worse — it looks like the setting itself is broken).
    """
    out: dict[str, list[str]] = {}

    def add(tok: str, source: str) -> None:
        s = str(tok)
        if "{" in s:
            return
        if LONG_FLAG_RE.fullmatch(s) or SHORT_FLAG_RE.fullmatch(s):
            out.setdefault(s, [])
            if source not in out[s]:
                out[s].append(source)

    for a in worker.get("args") or []:
        add(a, "args")
    tunables = worker.get("tunables")
    if isinstance(tunables, dict):
        for name, spec in tunables.items():
            if not isinstance(spec, dict):
                continue
            for a in spec.get("args") or []:
                add(a, f"tunables.{name}.args")
    return out


def parse_help_flags(text: str) -> tuple[set[str], set[str]]:
    """(loose, strict).

    loose  = every flag-shaped token anywhere in the help text. Used for the
             BREAKING check, deliberately: it is a SUPERSET, so it errs toward
             not paging. A false page against a working CLI is worse than a
             missed one, because the whole point of the page is "this worker is
             down" and crying wolf daily trains the user to ignore it.
    strict = flags in an option-spec position (a line that starts with a dash,
             up to the description gap). Used for "new flag appeared" INFO,
             where prose mentions would be pure noise.
    """
    text = text or ""
    loose = (set(LONG_FLAG_RE.findall(text)) | set(SHORT_FLAG_RE.findall(text))
             | expand_bracketed_flags(text))
    strict: set[str] = set()
    for raw in text.splitlines():
        if not re.match(r"^\s{0,12}-", raw):
            continue
        spec = re.split(r"\s{2,}", raw.strip())[0]
        strict |= (set(LONG_FLAG_RE.findall(spec)) | set(SHORT_FLAG_RE.findall(spec))
                   | expand_bracketed_flags(spec))
    return loose, strict


def parse_version(text: str) -> str | None:
    """First semver-ish token; `2.1.217 (Claude Code)` -> `2.1.217`."""
    if not text:
        return None
    m = VERSION_RE.search(text)
    return m.group(0) if m else None


def _option_block(text: str, flag: str) -> str:
    """The help lines describing `flag`: its own line plus continuations, up to
    the next option-spec line."""
    lines = (text or "").splitlines()
    for i, line in enumerate(lines):
        if not re.search(rf"(?<![\w-]){re.escape(flag)}(?![\w-])", line):
            continue
        block = [line]
        for nxt in lines[i + 1:]:
            if not nxt.strip():
                break
            if re.match(r"^\s{0,12}-", nxt):
                break
            block.append(nxt)
        return "\n".join(block)
    return ""


_VALUE_GROUP_RE = re.compile(r"\(([^()]{2,120})\)|<([^<>]{2,120})>|\[([^\[\]]{2,120})\]")
_VALUE_TOKEN_RE = re.compile(r"^[a-z][a-z0-9._-]*$")


def parse_choice_values(help_text: str, flag: str) -> list[str]:
    """A CLOSED vocabulary printed inline for `flag`, e.g. `(low, medium, high,
    xhigh, max)` or `<low|medium|high>`. [] when the help prints no such list.

    Deliberately conservative — a group must yield at least two lowercase,
    space-free, colon-free tokens. `(default: medium)` yields one token with a
    colon and is correctly rejected; a free-text parenthetical is rejected the
    same way. Under-reporting a vocabulary costs a hint; over-reporting invents
    values that would be shown to the user as if the CLI offered them.
    """
    block = _option_block(help_text, flag)
    if not block:
        return []
    for m in _VALUE_GROUP_RE.finditer(block):
        inner = next((g for g in m.groups() if g), "")
        if "|" not in inner and "," not in inner:
            continue
        parts = [p.strip().strip("\"'`") for p in re.split(r"[|,]", inner)]
        vals = [p for p in parts if _VALUE_TOKEN_RE.match(p) and len(p) >= 2]
        if len(vals) >= 2 and len(vals) == len(parts):
            seen: list[str] = []
            for v in vals:
                if v not in seen:
                    seen.append(v)
            return seen
    return []


_MODEL_NAME_RE = re.compile(r"^[a-z][a-z0-9.]*(?:-[a-z0-9.]+)+$")


def parse_model_names(text: str, filter_kind: str | None = None) -> list[str]:
    """Model ids out of a `<cli> models` listing.

    Takes the first whitespace-delimited token of each line after stripping
    bullets/table glyphs, and keeps only hyphenated lowercase ids at least six
    characters long (gemini-3.6-flash-high, claude-sonnet-4-6, gpt-oss-120b-medium).
    Prose lines and headers do not survive that shape test.

    If filter_kind == "gemini", only keeps models starting with "gemini-".
    If filter_kind == "non-gemini", only keeps models NOT starting with "gemini-".
    """
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip().lstrip("-*•|>│├└─ \t")
        if not line:
            continue
        tok = line.split()[0].strip(",;|").strip()
        if len(tok) >= 6 and _MODEL_NAME_RE.match(tok):
            if filter_kind == "gemini" and not tok.startswith("gemini-"):
                continue
            if filter_kind == "non-gemini" and tok.startswith("gemini-"):
                continue
            if tok not in out:
                out.append(tok)
    return out


def declared_values(worker: dict, setting: str) -> list[str]:
    tunables = worker.get("tunables")
    if not isinstance(tunables, dict):
        return []
    spec = tunables.get(setting)
    if not isinstance(spec, dict):
        return []
    vals = spec.get("values")
    return [str(v) for v in vals] if isinstance(vals, list) else []


def finding(severity: str, worker: str, kind: str, message: str) -> dict:
    return {"severity": severity, "worker": worker, "kind": kind, "message": message}


# Spawn-failure markers that indicate the binary itself is gone, not a transient hang.
# Case-insensitive match against error text from --version/--help failures.
# AI-153: these are the exact phrases Windows uses when a junction target is gone
# or the binary path cannot be resolved.
SPAWN_FAILURE_MARKERS = [
    "cannot be resolved",
    "not found at",
    "no such file",
    "is not recognized as",
    "file cannot be found",
]


def classify_worker_down(probe: dict) -> bool:
    """Return True if the probe indicates the worker binary is missing/down.

    Path 1 — BOTH --version and --help failed AND the error text contains
    high-confidence spawn-failure markers (junction target gone, binary not
    found). A mere timeout without those markers stays a transient hang.

    Path 2 (added 2026-08-15 after a live miss): a shim's loud missing-binary
    GUARD prints its error banner to stdout and exits 1 — run_capture counts
    that as a successful capture, the banner becomes the "help" text,
    helpOk goes True, and the scan would otherwise derive bogus
    missing-flag BREAKING findings from garbage. Detect that shape directly:
    spawn-failure markers in the captured OUTPUT combined with no version
    parsed and no flags discoverable in the "help".

    Both paths err toward silence per the script's invariants: a watchdog
    that pages on every transient hang gets muted and ignored.
    """
    raw_outputs = f"{probe.get('help', '')}\n{probe.get('versionRaw', '')}".lower()
    if probe.get("helpOk"):
        # Path 2: guard banner masquerading as help. Require markers AND a
        # versionless, flagless capture — a real help text with a marker-like
        # phrase ("--model: file cannot be found in config" prose) that still
        # yields flags is NOT a down worker.
        if not any(m in raw_outputs for m in SPAWN_FAILURE_MARKERS):
            return False
        _, strict_flags = parse_help_flags(probe.get("help", ""))
        return probe.get("version") is None and not strict_flags

    errors = probe.get("errors") or []
    if not errors:
        return False  # No errors recorded, inconclusive

    # Check if BOTH --version and --help failed
    version_failed = any("--version:" in e for e in errors)
    help_failed = any("--help:" in e for e in errors)

    if not (version_failed and help_failed):
        return False  # Only one failed, not conclusive

    # Check for spawn-failure markers (case-insensitive)
    errors_text = " ".join(errors).lower()
    for marker in SPAWN_FAILURE_MARKERS:
        if marker.lower() in errors_text:
            return True

    return False


def compute_shim_hashes(shim_dir: Path) -> dict[str, str]:
    """Compute SHA-256 hashes of all shim files in the directory.

    Returns {filename: sha256_hex} for files that exist; missing files are
    omitted from the dict. Returns empty dict if shim_dir does not exist.
    """
    if not shim_dir.exists():
        return {}

    shim_files = ["agy.cmd", "agy.ps1", "gemini", "gemini.cmd", "gemini.ps1"]
    hashes: dict[str, str] = {}

    for filename in shim_files:
        filepath = shim_dir / filename
        if not filepath.exists():
            continue
        try:
            content = filepath.read_bytes()
            sha256 = hashlib.sha256(content).hexdigest()
            hashes[filename] = sha256
        except (OSError, IOError):
            # File unreadable — treat as missing/vanished
            continue

    return hashes


def load_shim_baseline(path: Path) -> dict[str, str] | None:
    """Load the shim baseline JSON; returns None if missing/invalid."""
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        if isinstance(data, dict) and isinstance(data.get("files"), dict):
            return data["files"]
    except (json.JSONDecodeError, OSError):
        pass
    return None


def save_shim_baseline(path: Path, hashes: dict[str, str]) -> None:
    """Write shim baseline atomically (tmp + os.replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps({"files": hashes}, indent=2, ensure_ascii=False),
                  encoding="utf-8")
    os.replace(tmp, path)


def check_shim_integrity(shim_dir: Path, baseline_path: Path,
                         update_baseline: bool = False) -> dict | None:
    r"""Check shim file hashes against baseline; return finding dict if drift.

    Args:
        shim_dir: Path to shim directory (default D:\gemini-shim)
        baseline_path: Path to baseline JSON (~/.pa/shim-baseline.json)
        update_baseline: If True, rewrite baseline from current files

    Returns:
        None if no drift or first run (baseline written), else a finding dict
        with severity BREAKING and kind "shim-drift".
    """
    current_hashes = compute_shim_hashes(shim_dir)

    # No shim dir → silently skip (not an error)
    if not shim_dir.exists():
        return None

    # No baseline → write it, no finding (first-run adoption)
    baseline = load_shim_baseline(baseline_path)
    if baseline is None:
        save_shim_baseline(baseline_path, current_hashes)
        return None

    # --update-shim-baseline flag: rewrite and return no finding
    if update_baseline:
        save_shim_baseline(baseline_path, current_hashes)
        return None

    # Check for drift: hash changed or file vanished
    drift_details: list[str] = []
    for filename, baseline_hash in baseline.items():
        current_hash = current_hashes.get(filename)
        if current_hash is None:
            drift_details.append(f"`{filename}` vanished")
        elif current_hash != baseline_hash:
            drift_details.append(f"`{filename}` content changed")

    if drift_details:
        return finding(
            BREAKING,
            "shim",
            "shim-drift",
            f"Live shim no longer matches the recorded baseline: {', '.join(drift_details)}. "
            f"If you changed it intentionally, re-run with `--update-shim-baseline`; "
            f"otherwise see `plans/2026-08-14-agy-restore.md` "
            f"(a shim was once silently rewritten to a different CLI, AI-154)."
        )

    return None


def diff_worker(name: str, worker: dict, probe: dict, prev: dict | None) -> tuple[list[dict], dict]:
    """Compare one worker's declarations against one probe result.

    Pure: no subprocess, no filesystem, no clock. `prev` is that worker's entry
    from the previous cache, or None on the very first run — and on a first run
    the cache-relative checks (version changed, new flag appeared) stay silent,
    so adopting this script records a baseline instead of dumping one.

    DO-NOT-REGRESS INVARIANT — this cache is ADDITIVE, never a wholesale
    overwrite. `scan()` assigns this function's returned `observed` dict
    straight into `cache_workers[name]`, so anything this function does not
    explicitly carry forward from `prev` is LOST from the cache on this run,
    even when the loss is only a transient probe hiccup. Concretely:
      * When `helpOk` is False (a `--help` timeout, or any other soft probe
        failure), `strict` is necessarily empty (there is no help text to
        parse), so `observed["flags"]` MUST fall back to `prev`'s flags rather
        than the freshly-computed empty list — otherwise one bad probe wipes a
        worker's entire known flag list down to `[]`, contradicting "a declared
        flag is never auto-removed" (see module docstring invariant #2).
      * For `values`, a setting this run did not (re)discover must fall back to
        `prev`'s value for that setting rather than being dropped — a value
        vocabulary discovered once should survive a run where, say, `agy
        models` came back empty.
    A future "simplification" that replaces this merge with a plain overwrite
    reintroduces the exact bug this comment documents.
    """
    findings: list[dict] = []
    loose, strict = parse_help_flags(probe.get("help", ""))
    prev = prev or {}
    observed: dict = {
        "version": probe.get("version"),
        "versionRaw": (probe.get("versionRaw") or "")[:200],
        "flags": sorted(strict),
        "helpOk": bool(probe.get("helpOk")),
        "values": {},
        "errors": list(probe.get("errors") or []),
    }

    # Worker-down check runs FIRST for both shapes (both-probes-failed AND
    # guard-banner-as-help, 2026-08-15): a down worker must never fall into
    # the missing-flag loop below, which would page four bogus BREAKINGs
    # derived from an error banner and cry wolf.
    if classify_worker_down(probe):
        findings.append(finding(
            BREAKING, name, "worker-down",
            f"Worker binary cannot be executed (`--version`/`--help` probes failed "
            f"or returned only an error banner). Known causes: (1) self-junction at "
            f"the install path — check with `fsutil reparsepoint query <path>`; "
            f"(2) binary uninstalled or emptied by a failed update; (3) shim guard "
            f"reporting the binary missing. See `plans/2026-08-14-agy-restore.md` "
            f"for recovery. Errors/output: {'; '.join(observed['errors'])[:150] or (probe.get('help') or '')[:150]}"
        ))
        # MERGE, do not overwrite (same invariant as the probe-failed branch):
        # there is no real help text to parse, so carry the previous flags.
        observed["flags"] = list(prev.get("flags") or [])
        observed["helpOk"] = False  # the captured "help" was an error banner
    elif not probe.get("helpOk"):
        # Transient hang or other soft failure — INFO only, do not page
        findings.append(finding(INFO, name, "probe-failed",
                                f"`--help` could not be read ({'; '.join(observed['errors'])[:120]}) — flags NOT verified this run."))

        # MERGE, do not overwrite: `strict` is empty here because there was no
        # help text to parse, not because the CLI actually lost every flag.
        # Falling through to the freshly-computed (empty) list would wipe this
        # worker's known flags on a single transient failure — carry the
        # previous cache entry's flags forward instead.
        observed["flags"] = list(prev.get("flags") or [])
    else:
        allowed = KNOWN_UNDOCUMENTED.get(name, set())
        for flag, sources in sorted(declared_flags(worker).items()):
            if flag in loose or flag in allowed:
                continue
            findings.append(finding(
                BREAKING, name, "missing-flag",
                f"config declares `{flag}` ({', '.join(sources)}) but it appears "
                f"nowhere in `--help`. Every dispatch using it fails."))
        if prev:
            new_flags = sorted(set(observed["flags"]) - set(prev.get("flags") or []))
            if new_flags and prev.get("flags"):
                findings.append(finding(INFO, name, "new-flags",
                                        "new flag(s) in `--help`: " + ", ".join(f"`{f}`" for f in new_flags)))

    if prev and probe.get("version") and prev.get("version") and probe["version"] != prev["version"]:
        findings.append(finding(INFO, name, "version-changed",
                                f"CLI version {prev['version']} -> {probe['version']}."))

    # Value catalogue: only compare where config has actually committed to a
    # `values:` hint. An absent list means "deliberately undeclared" (model names
    # move faster than this file), and reporting on it every day would be noise.
    for setting, discovered in (probe.get("values") or {}).items():
        if not discovered:
            continue
        observed["values"][setting] = list(discovered)
        declared = declared_values(worker, setting)
        if not declared:
            continue
        added = [v for v in discovered if v not in declared]
        gone = [v for v in declared if v not in discovered]
        if added:
            findings.append(finding(INFO, name, "new-values",
                                    f"`{setting}` accepts value(s) config does not list: "
                                    + ", ".join(f"`{v}`" for v in added)))
        if gone:
            findings.append(finding(INFO, name, "stale-values",
                                    f"`{setting}` value(s) config lists are no longer offered: "
                                    + ", ".join(f"`{v}`" for v in gone)
                                    + " (hint only — nothing is auto-removed)."))

    # MERGE, do not overwrite: a setting this run did not (re)discover — e.g.
    # `agy models` came back empty this one time — must fall back to the
    # PREVIOUS cache's value for that setting rather than being dropped.
    # Only settings this run actually discovered were written into
    # observed["values"] above; anything else in prev's values carries forward
    # untouched. This is the same additive-cache invariant as the flags
    # fallback above, applied to the values catalogue.
    for setting, prev_vals in (prev.get("values") or {}).items():
        if setting not in observed["values"] and prev_vals:
            observed["values"][setting] = list(prev_vals)

    return findings, observed


def scan(config: dict, probes: dict[str, dict], prev_cache: dict | None,
         now: datetime) -> tuple[list[dict], dict]:
    """Pure end-to-end diff. `probes` is worker-name -> probe result, injected so
    tests can replay fixtures instead of spawning CLIs."""
    prev_workers = (prev_cache or {}).get("workers") or {}
    findings: list[dict] = []
    cache_workers: dict = {}
    for worker in workers_of(config):
        name = str(worker["name"])
        probe = probes.get(name)
        if probe is None:
            continue
        f, observed = diff_worker(name, worker, probe, prev_workers.get(name))
        observed["checkedAt"] = now.isoformat()
        findings.extend(f)
        cache_workers[name] = observed
    # Workers no longer in config keep their last observation rather than being
    # dropped — the cache is additive, and a removed worker may come back.
    for name, old in prev_workers.items():
        cache_workers.setdefault(name, old)
    cache = {
        "updatedAt": now.isoformat(),
        "note": ("OBSERVED CLI capabilities, written by "
                 "projects/pa-maintenance/scripts/worker_capability_scan.py. "
                 "config.yaml is human intent and is NEVER written by that script; "
                 "this file is additive and is merged with config only for display."),
        "workers": cache_workers,
    }
    return findings, cache


def render_report(findings: list[dict]) -> str:
    """Compact Markdown. sendToTelegram handles MarkdownV2 escaping — never
    hand-escape here (CLAUDE.md formatting rule)."""
    breaking = [f for f in findings if f["severity"] == BREAKING]
    info = [f for f in findings if f["severity"] != BREAKING]
    lines: list[str] = []
    if breaking:
        lines.append("🚨 *Worker capability drift — BREAKING*")
        lines.append("")
        for f in breaking:
            lines.append(f"*{f['worker']}* — {f['message']}")
        lines.append("")
        lines.append(f"Fix `{pa_home() / 'config.yaml'}` by hand. Nothing was "
                     "auto-removed: a declared flag is never deleted automatically, "
                     "because that would silently disable a setting instead of "
                     "surfacing the break.")
    if info:
        if breaking:
            lines.append("")
        lines.append("*Worker capability drift — INFO*")
        lines.append("")
        for f in info:
            lines.append(f"*{f['worker']}* — {f['message']}")
    lines.append("")
    lines.append("_Cache: ~/.pa/worker-capabilities.json (observed reality; "
                 "config.yaml untouched)._")
    report = "\n".join(lines)
    if len(report) > MAX_REPORT_CHARS:
        report = report[: MAX_REPORT_CHARS - 3].rstrip() + "..."
    return report


# ---------------------------------------------------------------------------
# probing (the only impure part)
# ---------------------------------------------------------------------------

def probe_worker(name: str, worker: dict, cli_timeout: float,
                 sub_timeout: float) -> dict:
    """Run --version, --help and any subcommand value source for one worker.

    Every failure is soft. One hung CLI must not stall the daily run, so each
    call is individually bounded and tree-killed.
    """
    errors: list[str] = []
    probe: dict = {"version": None, "versionRaw": "", "help": "", "helpOk": False,
                   "values": {}, "errors": errors}

    vargv = resolve_argv(version_argv(worker))
    if vargv:
        r = run_capture(vargv, cli_timeout)
        if r["ok"]:
            raw = (r["out"] or r["err"] or "").strip()
            probe["versionRaw"] = raw
            probe["version"] = parse_version(raw)
        else:
            errors.append(f"--version: {r['err'][:120]}")

    base = base_argv(worker)
    if base:
        r = run_capture(resolve_argv(base + ["--help"]), cli_timeout)
        # Some CLIs print help on stderr and/or exit non-zero; take whatever came back.
        text = ((r["out"] or "") + "\n" + (r["err"] or "")).strip() if r["ok"] else ""
        if text:
            probe["help"] = text
            probe["helpOk"] = True
        elif r["ok"]:
            errors.append("--help: empty output")
        else:
            errors.append(f"--help: {r['err'][:120]}")
    else:
        errors.append("no `command:` in config — nothing to probe")

    source = SUBCOMMAND_VALUE_SOURCES.get(name)
    if source:
        cmd = worker.get("command")
        argv = powershell_argv(str(cmd), source["args"]) if cmd and source.get("via") == "powershell" \
            else resolve_argv([str(cmd), *source["args"]]) if cmd else None
        if not argv:
            errors.append(f"{' '.join(source['args'])}: no shell available")
        else:
            r = run_capture(argv, sub_timeout)
            if r["ok"] and (r["out"] or "").strip():
                filter_kind = source.get("filter")
                names = parse_model_names(r["out"], filter_kind=filter_kind)
                if names:
                    probe["values"][source["setting"]] = names
                else:
                    errors.append(f"{' '.join(source['args'])}: no model names parsed")
            else:
                errors.append(f"{' '.join(source['args'])}: {(r['err'] or 'no output')[:120]}")

    static_defaults = STATIC_VALUE_DEFAULTS.get(name)
    if static_defaults:
        for setting, defaults in static_defaults.items():
            if setting not in probe["values"]:
                probe["values"][setting] = list(defaults)

    # Effort-style vocabularies come straight out of --help, per tunable.
    if probe["helpOk"]:
        tunables = worker.get("tunables")
        if isinstance(tunables, dict):
            for setting, spec in tunables.items():
                if setting in probe["values"] or not isinstance(spec, dict):
                    continue
                flag = next((str(a) for a in (spec.get("args") or [])
                             if str(a).startswith("-") and "{" not in str(a)), None)
                if not flag:
                    continue
                vals = parse_choice_values(probe["help"], flag)
                if vals:
                    probe["values"][setting] = vals
    return probe


def load_cache(path: Path) -> dict | None:
    """The previous observation, or None when there is no USABLE one.

    Fails safe toward first-run semantics (record a baseline, report nothing
    cache-relative). A corrupt cache must never crash the daily run.
    """
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("workers"), dict):
        return None
    return data


def save_cache(path: Path, cache: dict) -> None:
    """Atomic (tmp + os.replace) so a crash mid-write cannot leave a half file
    that the next run would read as a corrupt cache."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(cache, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def page_alerts(report: str) -> None:
    """Page pa-alerts for BREAKING findings only, via the repo's standard
    notifier — which mints the mandatory s-XXXXXXXXXXXX ref ID, appends it, and
    logs it to app.log.jsonl so `pa ref` can resolve it."""
    repo_root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(repo_root / "pa" / "src"))
    from telegram_notify import notify  # noqa: E402
    notify(report,
           chat_id=alert_chat_id(),
           thread_id=_secret("PA_ALERTS_THREAD_ID") or None)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Daily worker CLI capability drift watchdog.")
    parser.add_argument("--config", help="Override the config.yaml path (tests).")
    parser.add_argument("--cache", help="Override the cache path (tests).")
    parser.add_argument("--worker", action="append",
                        help="Probe only this worker (repeatable; manual use).")
    parser.add_argument("--timeout", type=float, default=DEFAULT_CLI_TIMEOUT,
                        help="Hard per-CLI timeout in seconds for --version/--help.")
    parser.add_argument("--subcommand-timeout", type=float, default=DEFAULT_SUBCOMMAND_TIMEOUT)
    parser.add_argument(
        "--shim-dir",
        help=r"Path to shim directory (default: $PA_SHIM_DIR, else D:\gemini-shim).")
    parser.add_argument("--update-shim-baseline", action="store_true",
                        help="Rewrite ~/.pa/shim-baseline.json from current shim files.")
    parser.add_argument("--no-send", action="store_true",
                        help="Report without paging pa-alerts (tests / manual).")
    parser.add_argument("--no-write", action="store_true",
                        help="Do not update the cache (tests / manual).")
    parser.add_argument("--json", action="store_true",
                        help="Print the raw findings+cache as JSON instead of the report.")
    args = parser.parse_args(argv)

    home = pa_home()
    config_path = Path(args.config) if args.config else home / "config.yaml"
    cache_path = Path(args.cache) if args.cache else home / "worker-capabilities.json"
    shim_dir = Path(args.shim_dir or os.environ.get("PA_SHIM_DIR") or "D:/gemini-shim")
    shim_baseline_path = home / "shim-baseline.json"
    now = datetime.now(timezone.utc)

    try:
        config = load_config(config_path)
    except OSError as e:
        print(f"worker-capability-watch: cannot read {config_path}: {e}", file=sys.stderr)
        return 1

    wanted = set(args.worker or [])
    probes = {
        str(w["name"]): probe_worker(str(w["name"]), w, args.timeout, args.subcommand_timeout)
        for w in workers_of(config)
        if not wanted or str(w["name"]) in wanted
    }

    findings, cache = scan(config, probes, load_cache(cache_path), now)

    # AI-154: check shim integrity before report render
    shim_finding = check_shim_integrity(shim_dir, shim_baseline_path, args.update_shim_baseline)
    if shim_finding:
        findings.append(shim_finding)

    if not args.no_write:
        try:
            save_cache(cache_path, cache)
        except OSError as e:
            # A cache-write failure must never suppress the findings themselves.
            print(f"worker-capability-watch: cache write failed: {e}", file=sys.stderr)

    if args.json:
        print(json.dumps({"findings": findings, "cache": cache}, indent=2, ensure_ascii=False))
        return 0

    if not findings:
        # Skills declaring telegram_output treat empty stdout as a HARD FAILURE
        # (changed 2026-07-21). Without this sentinel the watchdog would fail
        # every quiet day and eventually be parked by the AI-098 failure-backoff
        # ladder — i.e. the drift watchdog would silently stop watching.
        print("NO_OUTPUT")
        return 0

    report = render_report(findings)
    print(report)

    if any(f["severity"] == BREAKING for f in findings) and not args.no_send:
        try:
            page_alerts(report)
        except Exception as e:  # noqa: BLE001 — stdout already carries the report
            print(f"(pa-alerts page could not be sent: {e})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
