#!/usr/bin/env python3
"""
Server-side PII / secret scanner for the public pa-framework mirror.

WHY THIS EXISTS
---------------
`pa/scripts/git-hooks/pre-push-pii-guard` is a LOCAL pre-push hook. It is the
only thing standing between the working tree and the public repo, and it has
four structural blind spots that a 2026-07-21 audit turned into real leaks:

  * it scans only the lines ADDED by a push, so anything already committed is
    never re-examined;
  * it scans file CONTENTS only, never file PATHS (a filename that named the
    user's bank sailed through every layer);
  * it is a local hook — uninstalled, broken, or bypassed via
    PA_SKIP_PII_GUARD=1, coverage silently drops to zero;
  * nothing on the server ever double-checks it.

This scanner is the server-side half. It runs in GitHub Actions on the public
repo (.github/workflows/pii-scan.yml) over the ENTIRE tracked tree at HEAD —
contents AND paths — and optionally over every path that ever existed in
history. It is also runnable by a human locally against the public mirror:

    python pa/scripts/pii_ci_scan.py --git-dir .git-public
    python pa/scripts/pii_ci_scan.py --git-dir .git-public --history-paths

WHAT IT CAN AND CANNOT CATCH  (read this before trusting it)
------------------------------------------------------------
The real personal-tripwire list lives at ~/.pa/pii-tripwires.txt, OUTSIDE the
repo, and must never be committed: publishing the list of things you are hiding
is itself a disclosure. So this scanner is a HYBRID:

  * STRUCTURAL classes (committed, always on) — credential shapes, bot-token
    and bot-handle shapes, private absolute paths, real-looking email
    addresses, private-key blocks, secret-looking assignments, and a GENERIC
    dictionary of financial-institution names. None of these reveal anything
    about the maintainer: the institution dictionary is a long generic list, so
    a hit tells you a provider name leaked, not which provider is theirs.

  * PERSONAL-TERM layer (optional) — regexes supplied out-of-band via the
    PA_PII_TRIPWIRES environment variable (in CI: a repository secret), or from
    a local file. Findings are reported as `personal-term#N` — never the
    pattern, never the matched text.

This is NOT equivalent to the local guard. Without the personal-term layer it
catches classes of secret, not this person's identity, and it has no semantic
(LLM) layer at all. Treat it as the backstop that makes a bypassed or broken
local hook survivable, not as a replacement for it.

CI-LOG SAFETY
-------------
CI logs on a public repo are public. A scanner that printed the string it
caught would leak the very thing it caught. This reporter therefore emits
ONLY: file path, line number, and the pattern CLASS NAME. Never the match,
never surrounding context, never the personal patterns themselves.

SUPPRESSION
-----------
Pattern definitions have to contain the shapes they hunt for, so lines between
`pii-scan:ignore-start` and `pii-scan:ignore-end`, and any line carrying
`pii-scan:ignore-line`, are skipped for CONTENT matching (paths are never
suppressible). This is deliberately visible in review — it is a readability
tool, not a security boundary.

EXIT CODES
----------
  0  scan completed, no findings
  1  scan completed, findings reported (fail the build)
  2  the scan itself could not run (bad usage, no files found)
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys

# Windows consoles may be cp1252; never let the report itself crash the scan.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

IGNORE_START = "pii-scan:ignore-start"
IGNORE_END = "pii-scan:ignore-end"
IGNORE_LINE = "pii-scan:ignore-line"

SKIP_EXTENSIONS = (
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".pdf", ".db", ".sqlite",
    ".woff", ".woff2", ".ttf", ".eot", ".zip", ".gz", ".tar", ".exe", ".dll",
    ".so", ".dylib", ".class", ".jar", ".mp3", ".mp4", ".wav",
)
SKIP_DIR_NAMES = {
    ".git", ".git-public", "node_modules", "__pycache__", "dist", "build",
    "venv", ".venv", ".pytest_cache", ".mypy_cache", "coverage",
}
MAX_FILE_BYTES = 2_000_000

# --------------------------------------------------------------------------
# Structural pattern classes.
#
# Everything between the ignore sentinels below is exempt from CONTENT
# scanning — otherwise the scanner flags its own definitions on every run.
# pii-scan:ignore-start
# --------------------------------------------------------------------------

# Domains that are explicitly placeholder/CI-owned and never personal.
_PLACEHOLDER_EMAIL_DOMAINS = (
    "example.com", "example.org", "example.net", "example", "test", "invalid",
    "localhost", "domain.com", "yourdomain.com", "company.com", "email.com",
    "mydomain.com", "users.noreply.github.com", "noreply.github.com",
    "sample.com", "foo.com", "bar.com", "acme.com", "somewhere.com",
)
# Local-parts that are obviously generic even on a real-looking domain, plus
# role addresses (statements@, alerts@, …) — a role address identifies an
# organisation's mailbox, not a person, so it is not the PII class we block on.
_PLACEHOLDER_EMAIL_LOCALS = (
    "you", "user", "username", "someone", "example", "test", "tests", "demo",
    "sample", "your", "youremail", "me", "foo", "bar", "admin", "email",
    "noreply", "no-reply", "donotreply", "do-not-reply", "notifications",
    "notification", "alerts", "alert", "statements", "statement", "info",
    "support", "contact", "hello", "help", "team", "service", "mail", "news",
    "newsletter", "billing", "sales", "security", "abuse", "postmaster",
    # SSH remote URLs (git@github.com:owner/repo.git) are not email addresses.
    "git", "hg", "svn",
)
# Home-directory segments that are placeholders, CI users, or OS accounts.
_PLACEHOLDER_HOME_USERS = (
    "you", "user", "username", "youruser", "yourname", "runner", "root",
    "public", "default", "defaultuser", "administrator", "all users", "me",
    "ubuntu", "vagrant", "docker", "node", "ci", "actions", "test", "example",
    "<user>", "%username%", "$user", "${user}",
)
# Bot handles that are generic examples rather than a person's real bot.
# (Snake_case CODE symbols ending in _bot — restart_bot, is_bot — are excluded
# by the CONTEXT requirement on the handle pattern below, not by this list:
# an allowlist of every such identifier would be endless whack-a-mole.)
_GENERIC_BOT_HANDLES = (
    "telegram_bot", "example_bot", "sample_bot", "test_bot", "tests_bot",
    "my_bot", "your_bot", "the_bot", "a_bot", "some_bot", "demo_bot",
    "dummy_bot", "fake_bot", "mock_bot", "pa_bot", "assistant_bot",
    "echo_bot", "dev_bot", "local_bot", "stub_bot", "placeholder_bot",
)
# Values that look like a secret assignment but are obviously placeholders.
_PLACEHOLDER_SECRET_VALUES = re.compile(
    r"^(?:your|my|the|a|some|xxx+|change[_-]?me|replace[_-]?me|placeholder|"
    r"dummy|fake|sample|example|test|redacted|removed|none|null|undefined|"
    r"\.\.\.|<|\$\{|%|\*+$)",
    re.IGNORECASE,
)

# A generic dictionary of well-known banks / brokers / payment firms. This list
# is deliberately long and generic: it discloses nothing about which provider
# the maintainer actually uses, but it catches the "provider name hardcoded in
# a script, a test fixture, or a FILENAME" class that leaked in 2026-07.
# Ambiguous English words (axis, chase, discover, ally, mint, wise, target)
# are intentionally EXCLUDED — a false CI failure trains people to ignore it.
_FINANCIAL_INSTITUTIONS = (
    "hdfc", "icici", "kotak", "indusind", "idfc", "yesbank", "canara",
    "andhra bank", "bank of baroda", "punjab national", "federal bank",
    "au small finance", "bandhan bank", "rbl bank", "dbs bank", "citibank",
    "standard chartered", "hsbc", "barclays", "jpmorgan", "j\\.p\\. morgan",
    "morgan stanley", "goldman sachs", "wells fargo", "american express",
    "capital one", "santander", "natwest", "lloyds", "monzo", "revolut",
    "starling bank", "n26", "deutsche bank", "credit suisse", "ubs",
    "zerodha", "groww", "upstox", "angelone", "angel one", "5paisa",
    "indmoney", "smallcase", "kuvera", "coin by zerodha", "sharekhan",
    "motilal oswal", "iifl", "edelweiss", "geojit", "fyers", "dhan",
    "fidelity", "netbenefits", "vanguard", "schwab", "etrade", "e\\*trade",
    "robinhood", "interactive brokers", "tastytrade", "webull", "sofi",
    "betterment", "wealthfront", "coinbase", "binance", "kraken",
    "razorpay", "payu", "billdesk", "phonepe", "paytm", "bharatpe",
    "policybazaar", "bajaj finserv", "bajaj finance", "cred\\.club",
)

_CLASS_DEFS: list[tuple[str, str, str, int]] = [
    # (class name, regex, scope: content|path|both, extra re flags)
    ("telegram-bot-token",      r"[0-9]{8,10}:[A-Za-z0-9_\-]{35}",              "content", 0),
    # A CONTEXT prefix (@mention, t.me link, or a name/username assignment) is
    # required: a bare `\w+_bot` token matches ordinary snake_case identifiers
    # (restart_bot, is_bot) and would fail CI on clean code forever, which
    # trains people to ignore the check. The 2026-07-21 leak was a handle in a
    # bot fixture's username field, which this shape still catches.
    ("telegram-bot-handle",
     r"(?:@|t\.me/|(?:bot[_\-]?)?(?:user)?name\s*[:=]\s*[\"']?@?)"
     r"(?P<handle>[A-Za-z0-9][A-Za-z0-9_]{3,28}_bot)\b",                        "content", re.IGNORECASE),
    ("telegram-supergroup-id",  r"-100(?P<gid>[0-9]{10})\b",                    "both",    0),
    ("anthropic-api-key",       r"sk-ant-[A-Za-z0-9_\-]{20,}",                  "content", 0),
    ("openai-api-key",          r"sk-(?:proj|live|svcacct)-[A-Za-z0-9_\-]{20,}", "content", 0),
    ("google-api-key",          r"AIza[0-9A-Za-z_\-]{35}",                      "content", 0),
    ("google-oauth-client-id",  r"[0-9]{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com", "content", 0),
    ("aws-access-key-id",       r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b", "content", 0),
    ("github-token",            r"\bgh[pousr]_[A-Za-z0-9]{30,}\b",              "content", 0),
    ("slack-token",             r"\bxox[abprs]-[A-Za-z0-9\-]{10,}",             "content", 0),
    ("private-key-block",       r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----", "content", 0),
    ("hardcoded-bot-token",     r"BOT_TOKEN\s*[:=]\s*[\"'][0-9]{6,}",           "content", 0),
    ("hardcoded-chat-id",       r"CHAT_ID\s*[:=]\s*[\"']-?[0-9]{7,}",           "content", 0),
    ("india-pan-number",        r"\b[A-Z]{5}[0-9]{4}[A-Z]\b",                   "both",    0),
    ("india-ifsc-code",         r"\b[A-Z]{4}0[A-Z0-9]{6}\b",                    "both",    0),
    ("phone-number",            r"\+(?:91|1|44|61|65|971)[\-\s]?[0-9]{3}[\-\s]?[0-9]{3,4}[\-\s]?[0-9]{3,4}\b", "both", 0),
]

# Classes needing a callable allowlist rather than a pure regex.
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
# The user segment is bounded to a plausible username: `C:\\Users\n` in a test
# string would otherwise capture the escape char `n` as a "leaked" username.
_WIN_HOME_RE = re.compile(r"[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9._%$<>{}\-]{2,32})", re.IGNORECASE)
_NIX_HOME_RE = re.compile(r"/(?:home|Users)/([A-Za-z0-9._%$<>{}\-]{2,32})")
_SECRET_ASSIGN_RE = re.compile(
    r"(?i)\b(?:api[_\-]?key|secret|client[_\-]?secret|access[_\-]?token|"
    r"refresh[_\-]?token|auth[_\-]?token|password|passwd|private[_\-]?key|"
    r"credential)s?\s*[:=]\s*[\"']([A-Za-z0-9_\-./+=]{20,})[\"']"
)
_FINANCIAL_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:" + "|".join(_FINANCIAL_INSTITUTIONS) + r")(?![A-Za-z0-9])",
    re.IGNORECASE,
)
# --------------------------------------------------------------------------
# pii-scan:ignore-end
# --------------------------------------------------------------------------


class Finding:
    """A single hit. Deliberately holds NO matched text — there is no field
    that could leak the value into a public CI log even by accident."""

    __slots__ = ("where", "path", "line", "pattern_class")

    def __init__(self, where: str, path: str, line: int | None, pattern_class: str):
        self.where = where          # "content" | "path" | "history-path"
        self.path = path
        self.line = line
        self.pattern_class = pattern_class

    def format(self) -> str:
        loc = f"{self.path}:{self.line}" if self.line else self.path
        return f"  {self.where:<12} {loc}  [{self.pattern_class}]"

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Finding({self.where}, {self.path}, {self.line}, {self.pattern_class})"


def _compiled_classes() -> list[tuple[str, re.Pattern[str], str]]:
    out = []
    for name, pattern, scope, flags in _CLASS_DEFS:
        out.append((name, re.compile(pattern, flags), scope))
    return out


COMPILED_CLASSES = _compiled_classes()


def class_names() -> list[str]:
    """Every structural class this scanner knows about (for --list-classes)."""
    extra = ["email-address", "private-absolute-path", "secret-assignment",
             "financial-institution"]
    return [n for n, _p, _s in COMPILED_CLASSES] + extra


# --------------------------------------------------------------------------
# Personal-term layer (out-of-band patterns; never printed)
# --------------------------------------------------------------------------

def load_personal_terms(env_value: str | None, tripwire_file: str | None) -> tuple[list[re.Pattern[str]], str]:
    """
    Compile personal tripwire regexes from an out-of-band source.

    Returns (compiled patterns, source label). The source label is safe to
    print; the patterns themselves are NEVER printed — a finding cites
    `personal-term#N` only, because publishing the list of things you are
    hiding is itself a disclosure.
    """
    raw: list[str] = []
    source = "off"
    if env_value and env_value.strip():
        raw = [ln.strip() for ln in env_value.splitlines()]
        source = "env:PA_PII_TRIPWIRES"
    elif tripwire_file and os.path.isfile(tripwire_file):
        try:
            with open(tripwire_file, encoding="utf-8", errors="replace") as f:
                raw = [ln.strip() for ln in f]
            source = "file"
        except OSError:
            return [], "off"
    patterns: list[re.Pattern[str]] = []
    for line in raw:
        if not line or line.startswith("#"):
            continue
        try:
            patterns.append(re.compile(line, re.IGNORECASE))
        except re.error:
            continue  # a malformed personal pattern must never be echoed
    if not patterns:
        return [], "off" if source == "off" else f"{source} (0 usable patterns)"
    return patterns, source


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------

def _email_is_placeholder(match: str) -> bool:
    local, _, domain = match.partition("@")
    domain = domain.lower()
    local = local.lower()
    if any(domain.endswith("." + d) or domain == d for d in _PLACEHOLDER_EMAIL_DOMAINS):
        return True
    if domain.endswith((".example", ".test", ".invalid", ".local", ".localhost")):
        return True
    if "example" in domain or "placeholder" in domain or "dummy" in domain:
        return True
    if local in _PLACEHOLDER_EMAIL_LOCALS:
        return True
    # a@b.com / x@y.com — a one-or-two-character local part on a
    # one-or-two-character domain label is never a real personal address.
    if len(local) <= 2 and len(domain.split(".")[0]) <= 2:
        return True
    return False


def _home_user_is_placeholder(user: str) -> bool:
    user = user.strip().lower()
    if user in _PLACEHOLDER_HOME_USERS:
        return True
    # <user>, %USERNAME%, ${HOME}, $USER — templated, not a real account name.
    return bool(re.match(r"^[<%${]", user))


def _bot_handle_is_generic(handle: str) -> bool:
    handle = handle.lstrip("@").lower()
    if handle in _GENERIC_BOT_HANDLES:
        return True
    # Any handle whose FIRST segment is a placeholder word — Example_pa_bot,
    # test_x_bot — is a fixture, not a person's bot. (The sanitized fixtures
    # this repo now ships use exactly that shape.)
    first = handle.split("_", 1)[0]
    return first in ("example", "sample", "test", "tests", "demo", "dummy",
                     "fake", "mock", "stub", "placeholder", "your", "my",
                     "foo", "bar", "baz", "some", "any", "the")


def _group_id_is_placeholder(digits: str) -> bool:
    """-1001234567890 is THE canonical fake supergroup ID (77 uses in this
    repo's own fixtures and docs). Flagging obvious dummies would make the
    check permanently red, so sequential / repeated digit runs are exempt.
    A real chat ID is personal data and is best covered by the personal-term
    layer as well — this structural class is a coarse backstop."""
    if len(set(digits)) <= 2:
        return True
    ascending = "01234567890123456789"
    descending = "98765432109876543210"
    return digits in ascending or digits in descending


def _iter_class_hits(text: str, scope: str):
    """Yield (class_name, offset) for every structural class hit in `text`.

    `scope` is "content" or "path" — classes declare which they apply to.
    Never yields the matched substring; callers only ever see an offset.
    """
    for name, rx, class_scope in COMPILED_CLASSES:
        if class_scope not in (scope, "both"):
            continue
        for m in rx.finditer(text):
            groups = m.groupdict()
            if name == "telegram-bot-handle" and _bot_handle_is_generic(groups.get("handle") or ""):
                continue
            if name == "telegram-supergroup-id" and _group_id_is_placeholder(groups.get("gid") or ""):
                continue
            yield name, m.start()

    for m in _EMAIL_RE.finditer(text):
        if not _email_is_placeholder(m.group(0)):
            yield "email-address", m.start()

    for rx in (_WIN_HOME_RE, _NIX_HOME_RE):
        for m in rx.finditer(text):
            if not _home_user_is_placeholder(m.group(1)):
                yield "private-absolute-path", m.start()

    for m in _FINANCIAL_RE.finditer(text):
        yield "financial-institution", m.start()

    if scope == "content":
        for m in _SECRET_ASSIGN_RE.finditer(text):
            if not _PLACEHOLDER_SECRET_VALUES.match(m.group(1)):
                yield "secret-assignment", m.start()


def scan_path(path: str, personal: list[re.Pattern[str]]) -> list[Finding]:
    """Scan a repository PATH itself. Leak class 3 (2026-07-21) was a filename:
    the file's contents were entirely generic and every content layer passed."""
    findings: list[Finding] = []
    seen: set[str] = set()
    for name, _offset in _iter_class_hits(path, "path"):
        if name in seen:
            continue
        seen.add(name)
        findings.append(Finding("path", path, None, name))
    for i, rx in enumerate(personal, start=1):
        if rx.search(path):
            findings.append(Finding("path", path, None, f"personal-term#{i}"))
    return findings


def _suppressed_lines(lines: list[str]) -> set[int]:
    """0-based indices of lines exempted by the ignore sentinels."""
    suppressed: set[int] = set()
    in_block = False
    for i, line in enumerate(lines):
        if IGNORE_START in line:
            in_block = True
            suppressed.add(i)
            continue
        if IGNORE_END in line:
            in_block = False
            suppressed.add(i)
            continue
        if in_block or IGNORE_LINE in line:
            suppressed.add(i)
    return suppressed


def scan_content(path: str, text: str, personal: list[re.Pattern[str]]) -> list[Finding]:
    """Scan file CONTENTS line by line. Line-by-line (rather than whole-file
    with offset arithmetic) so suppression sentinels are cheap and exact."""
    findings: list[Finding] = []
    lines = text.splitlines()
    suppressed = _suppressed_lines(lines)
    for idx, line in enumerate(lines):
        if idx in suppressed:
            continue
        seen: set[str] = set()
        for name, _offset in _iter_class_hits(line, "content"):
            if name in seen:
                continue
            seen.add(name)
            findings.append(Finding("content", path, idx + 1, name))
        for i, rx in enumerate(personal, start=1):
            if rx.search(line):
                findings.append(Finding("content", path, idx + 1, f"personal-term#{i}"))
    return findings


# --------------------------------------------------------------------------
# File enumeration
# --------------------------------------------------------------------------

def _git(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    # encoding/errors are load-bearing on EVERY subprocess call site: without
    # them Windows decodes with cp1252 and a single emoji variation-selector
    # byte raises, which (in the pre-push guard, 2026-07-12) silently emptied
    # the scan input and vetted nothing. Same class of bug, same fix.
    return subprocess.run(
        args, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
    )


def git_tracked_paths(root: str, git_dir: str | None) -> list[str]:
    """Tracked paths via git. Returns [] when git can't answer."""
    args = ["git"]
    if git_dir:
        args += ["--git-dir", os.path.abspath(git_dir), "--work-tree", root]
    else:
        args += ["-C", root]
    args.append("ls-files")
    try:
        result = _git(args)
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    return [p.strip() for p in result.stdout.splitlines() if p.strip()]


def walk_paths(root: str) -> list[str]:
    """Filesystem fallback when git is unavailable (also used by tests)."""
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES]
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out.append(rel)
    return sorted(out)


def history_paths(root: str, git_dir: str | None) -> list[str]:
    """Every path that ever appeared in history on any ref.

    Cheap (paths only, no blob contents) and it closes the exact hole that let
    a bank-naming FILENAME survive: renaming the file fixes HEAD but leaves the
    name in history forever. Requires a full clone (fetch-depth: 0 in CI)."""
    args = ["git"]
    if git_dir:
        args += ["--git-dir", os.path.abspath(git_dir), "--work-tree", root]
    else:
        args += ["-C", root]
    args += ["log", "--all", "--pretty=format:", "--name-only"]
    try:
        result = _git(args, timeout=180)
    except (OSError, subprocess.SubprocessError):
        return []
    if result.returncode != 0:
        return []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if line:
            seen.add(line)
    return sorted(seen)


def read_text(root: str, rel_path: str) -> str | None:
    """File contents, or None when unreadable / binary / oversized."""
    if rel_path.lower().endswith(SKIP_EXTENSIONS):
        return None
    full = os.path.join(root, rel_path.replace("/", os.sep))
    try:
        if os.path.getsize(full) > MAX_FILE_BYTES:
            return None
        with open(full, encoding="utf-8", errors="strict") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

def scan_repo(root: str, paths: list[str], personal: list[re.Pattern[str]],
              hist_paths: list[str] | None = None) -> tuple[list[Finding], int]:
    """Scan `paths` (contents + path strings) plus optional history paths.
    Returns (findings, files_whose_contents_were_read)."""
    findings: list[Finding] = []
    content_scanned = 0
    for rel in paths:
        findings.extend(scan_path(rel, personal))
        text = read_text(root, rel)
        if text is None:
            continue
        content_scanned += 1
        findings.extend(scan_content(rel, text, personal))
    if hist_paths:
        live = set(paths)
        for rel in hist_paths:
            if rel in live:
                continue  # already covered by the HEAD pass
            for f in scan_path(rel, personal):
                findings.append(Finding("history-path", f.path, None, f.pattern_class))
    return findings, content_scanned


def render_report(findings: list[Finding], files: int, content_scanned: int,
                  personal_count: int, personal_source: str,
                  history_count: int) -> str:
    """Build the report. Contains file, line and pattern CLASS only — never a
    matched value, never a personal pattern. CI logs on a public repo are
    public; printing the hit would leak the very thing it caught."""
    lines: list[str] = []
    lines.append(
        f"PII CI scan: {files} tracked path(s), {content_scanned} file(s) read"
        + (f", {history_count} historical path(s)" if history_count else "")
    )
    lines.append(
        f"  layers: structural={len(class_names())} classes ON; "
        + (f"personal-terms={personal_count} pattern(s) via {personal_source}"
           if personal_count else
           "personal-terms OFF (no PA_PII_TRIPWIRES) — structural classes only, "
           "this run cannot catch person-specific identifiers")
    )
    if not findings:
        lines.append("OK: no findings.")
        return "\n".join(lines)

    by_class: dict[str, int] = {}
    for f in findings:
        by_class[f.pattern_class] = by_class.get(f.pattern_class, 0) + 1
    lines.append(f"FAIL: {len(findings)} finding(s) across {len(by_class)} class(es).")
    lines.append("  (locations and pattern classes only — the matched text is "
                 "deliberately not printed, CI logs are public)")
    for f in findings:
        lines.append(f.format())
    lines.append("  summary: " + ", ".join(
        f"{name}={count}" for name, count in sorted(by_class.items())))
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pii_ci_scan.py",
        description="Scan a repository's tracked file contents AND paths for "
                    "structural secrets and (optionally) personal tripwires. "
                    "Reports locations and pattern classes only.",
    )
    p.add_argument("--root", default=".", help="Working tree to scan (default: cwd)")
    p.add_argument("--git-dir", default=None,
                   help="Scan the repo at this git dir (e.g. .git-public). "
                        "Default: the git repo containing --root.")
    p.add_argument("--no-git", action="store_true",
                   help="Ignore git; walk the filesystem under --root instead.")
    p.add_argument("--history-paths", action="store_true",
                   help="Also scan every path that ever existed in history "
                        "(needs a full clone: fetch-depth 0).")
    p.add_argument("--tripwire-file", default=None,
                   help="Local file of personal regexes (one per line). Used "
                        "only when PA_PII_TRIPWIRES is unset. Its contents are "
                        "never printed.")
    p.add_argument("--list-classes", action="store_true",
                   help="Print the structural class names and exit.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.list_classes:
        for name in class_names():
            print(name)
        return 0

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print(f"PII CI scan: --root '{args.root}' is not a directory", file=sys.stderr)
        return 2

    if args.no_git:
        if args.history_paths:
            print("⚠  PII CI scan: --history-paths needs git; ignored under "
                  "--no-git (history was NOT scanned)", file=sys.stderr)
        paths = walk_paths(root)
        hist: list[str] = []
    else:
        paths = git_tracked_paths(root, args.git_dir)
        if not paths:
            print("PII CI scan: git listed no tracked files — falling back to "
                  "a filesystem walk", file=sys.stderr)
            paths = walk_paths(root)
        hist = history_paths(root, args.git_dir) if args.history_paths else []

    if not paths:
        print("PII CI scan: nothing to scan (no files found)", file=sys.stderr)
        return 2

    personal, source = load_personal_terms(
        os.environ.get("PA_PII_TRIPWIRES"), args.tripwire_file)
    if not personal and source == "off":
        print("⚠  PII CI scan: personal-term layer is OFF — this run checks "
              "structural classes only. It is NOT equivalent to the local "
              "pre-push guard.", file=sys.stderr)

    findings, content_scanned = scan_repo(root, paths, personal, hist)
    print(render_report(findings, len(paths), content_scanned,
                        len(personal), source, len(hist)))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
