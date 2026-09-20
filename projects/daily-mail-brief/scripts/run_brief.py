"""
Orchestrator for daily mail brief.

Runs all fetch/send/pdf/obsidian steps as Python code.
Calls an LLM CLI (agy) only for LLM analysis (text-in, text-out, no tool use).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone, timedelta

from runtime_state import read_failure_marker, write_failure_marker, write_last_window_end

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

# Import the decisions helper (WP-B) for deterministic decision recording (AI-164)
# The worktree root is three levels up from SCRIPT_DIR: scripts/ -> daily-mail-brief/ -> projects/ -> worktree root
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "pa", "scripts"))
import decisions as decisions_lib  # import-safe (WP-B); PA_HOME resolves inside it

# Antigravity CLI (agy) — the successor to the sunset gemini CLI. This script was
# the ONLY production caller still shelling the legacy binary after AI-131 retired
# it for the worker fleet on 2026-08-08; its Code-Assist licence died on
# 2026-08-19 and the brief did not deliver for four days
# (the 2026-08-23 alerts-week review, internal, §2.2).
AGY_CMD = os.environ.get("AGY_CMD", "D:/gemini-shim/agy.cmd")
AGY_MODEL = os.environ.get("DAILY_MAIL_BRIEF_MODEL", "gemini-3.7-flash-high")
AGY_PRINT_TIMEOUT = os.environ.get("DAILY_MAIL_BRIEF_PRINT_TIMEOUT", "15m")

# Fallback inner-LLM CLI, used when agy exhausts its quota: the next healthy
# worker of the failover chain in ~/.pa/config.yaml (agy → codex → zclaude →
# claude — each worker draws from its own quota pool, so a quota-dead agy does
# not imply a quota-dead fallback). codex was cooling until 2026-09-07
# (operator fleet note, 2026-08-21) and zclaude is operator-ordered ahead of
# claude, so zclaude is the default; override per this script's AGY_CMD
# convention. No --model pin: the fallback keeps its own CLI default (operator
# directive 2026-08-15, mirrored in the zclaude worker block).
FALLBACK_LLM_CMD = os.environ.get(
    "DAILY_MAIL_BRIEF_FALLBACK_CMD", "zclaude"
)


def _duration_to_seconds(text: str, default: float) -> float:
    """'45s'/'10m'/'1h'/'90' → seconds; unparseable/empty → default."""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*([smh]?)\s*$", str(text or "").lower())
    if not m:
        return default
    return float(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600}[m.group(2)]


# Python-level bound for the agy subprocess. --print-timeout is only advisory
# to the CLI: a call that hangs at auth/network before the print wait, or a CLI
# overrunning its own bound, would otherwise block this run forever — no
# failure marker, no alert, no retry (the run simply goes dark). Sized one
# boot/shutdown margin LOOSER than the CLI's own bound so agy's internal
# timeout normally fires first and its diagnostic stderr (auth text, quota
# text) reaches the retry loop instead of being cut off mid-flight.
LLM_SUBPROCESS_TIMEOUT_S = _duration_to_seconds(AGY_PRINT_TIMEOUT, 900.0) + 120.0


def _dedup_key_for_status(status: str) -> str:
    """Dedup key for `pa notify`. Kept lockstep with fetch_headers.py's key
    convention so an 'auth' failure detected here at preflight collapses with
    fetch_headers' own 'auth' alert (one auth notice, not two)."""
    return f"daily-mail-brief-{status}"


def _notify_failure(status: str, body: str) -> None:
    """Send a brief-failure alert via `pa notify` (deduped, routed to pa-alerts)
    instead of send_telegram.py into the user-facing daily-briefings topic.

    A failed brief is retried by catchup every ~15 min; the old direct-send path
    posted an identical failure notice to the briefings topic on EVERY retry, so
    one overnight Gemini-auth blip produced 26 copies (2026-07-12) that read to
    the user as a flood of 'portfolio reports'. pa notify's shared 1-hour dedup
    window collapses the storm and keeps failure noise in the ops channel.
    Mirrors fetch_headers.py's _fetch_failed. Fail-soft — notify.send never
    raises."""
    sys.path.insert(0, SCRIPT_DIR)
    from notify import send as notify_send
    notify_send(
        subject=f"daily-mail-brief: {status} failure",
        body=body,
        dedup_key=_dedup_key_for_status(status),
    )


def run_py(script, *args, check=True):
    """Run a sibling Python script, return CompletedProcess."""
    result = subprocess.run(
        [sys.executable, os.path.join(SCRIPT_DIR, script)] + list(args),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=PROJECT_ROOT,
    )
    if check and result.returncode != 0:
        print(f"[ERROR] {script} failed:\n{result.stderr[:500]}", file=sys.stderr)
        sys.exit(1)
    return result


def build_agy_command(prompt_path: str) -> list:
    """agy argv for a one-shot text completion.

    The prompt is passed as an @-file reference, never inline: ~/.pa/config.yaml's
    agy worker block pins `-p '{prompt}'` and worker-exec.ts substitutes
    '@<tempfile>' (worker-exec.ts:231) precisely because a briefing prompt with
    email headers blows past the ~32 KB Windows command-line cap. agy resolves
    the @-reference client-side, verified from %TEMP% on 2026-07-21.

    --output-format text probe-confirmed 2026-08-23 (WP-F step 2c): a bounded
    "reply with the single word OK" call through this exact flag pair printed
    plain text containing OK, so the pair is kept.
    """
    return ["cmd", "/c", AGY_CMD,
            "--dangerously-skip-permissions",
            "--model", AGY_MODEL,
            "--print-timeout", AGY_PRINT_TIMEOUT,
            "--output-format", "text",
            "-p", f"@{prompt_path}"]


def build_fallback_llm_command() -> list:
    """Fallback CLI argv for a one-shot text completion.

    The prompt travels on stdin (never argv) — the same ~32 KB Windows
    command-line cap protection that build_agy_command's @-file reference
    provides, using the fallback CLI's native `cat prompt | cli -p` shape.
    """
    return ["cmd", "/c", FALLBACK_LLM_CMD,
            "--dangerously-skip-permissions",
            "--output-format", "text",
            "-p"]


# Claude Code CLI wrappers (zclaude included) proxy to a non-Anthropic
# backend by setting their OWN ANTHROPIC_* auth/model env vars before
# invoking the real `claude` binary. Defensive scrub: an ANTHROPIC_* inherited
# from this process must never be able to override the wrapper's routing.
# This was NOT the cause of the recorded 2026-09-14..15 fallback failures —
# the wrapper exports ANTHROPIC_AUTH_TOKEN itself, so the "connectors are
# disabled" warning and the unrecognized-model diagnostic print on every
# launch even with none of these inherited (live-probed 2026-09-19); the real
# cause was z.ai's weekly limit (see _CLI_STARTUP_NOISE_PREFIXES). Mirrors
# LABELER_ENV_DROP (pa/src/lib/typesafe-judge-eval.ts), the same scrub for the
# opposite leak direction.
FALLBACK_LLM_ENV_DROP = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
)


def _fallback_llm_env() -> dict:
    """Parent env minus ANTHROPIC_* auth/model overrides (FALLBACK_LLM_ENV_DROP)."""
    return {k: v for k, v in os.environ.items() if k not in FALLBACK_LLM_ENV_DROP}


def _strip_cli_noise(output: str) -> str:
    """Strip session-hook noise a CLI may append after the real response, and
    surrounding whitespace (harmless and cheap to keep checking on every path)."""
    noise_marker = "Created execution plan for SessionEnd:"
    if noise_marker in output:
        output = output[:output.index(noise_marker)]
    return output.strip()


# Lines a Claude Code CLI writes to stderr on EVERY launch, failing or not.
# On the recorded 2026-09-14..15 outage (6 failed runs) they were the CLI's
# entire stderr, so the first 300 chars — all the raised error carried — named
# a "connectors"/"model" problem while the real cause, z.ai's `429 [1310]
# Weekly/Monthly Limit Exhausted`, sat unreported on stdout.
_CLI_STARTUP_NOISE_PREFIXES = (
    "⚠ claude.ai connectors are disabled",
    "[claude-code:",
)


def _cli_failure_detail(stdout: str, stderr: str, limit: int = 300) -> str:
    """Actionable failure text for a fallback CLI that exited non-zero.

    In `-p --output-format text` mode a Claude Code CLI prints its fatal error
    as the LAST line of stdout (after any wrapper banner); zclaude.bat's own
    failures are stdout `echo`s too. That line comes first, then whatever
    stderr remains once startup noise is dropped. When neither stream has
    anything else, the raw stderr is kept so the reason is never blank.
    """
    out_lines = [ln.strip() for ln in (stdout or "").splitlines() if ln.strip()]
    err_lines = [
        ln for ln in (stderr or "").splitlines()
        if ln.strip() and not ln.lstrip().startswith(_CLI_STARTUP_NOISE_PREFIXES)
    ]
    parts = []
    if out_lines:
        parts.append(out_lines[-1][:limit])
    if err_lines:
        parts.append("\n".join(err_lines)[:limit])
    return " | ".join(parts) if parts else (stderr or "")[:limit]


def call_fallback_llm(prompt: str) -> str:
    """Run the fallback CLI with the prompt on stdin; return cleaned text.

    Any failure raises RuntimeError that stays transient-classified (never an
    auth signature), so main()'s retry loop and catchup keep retrying instead
    of taking the fatal llm-auth path.
    """
    try:
        result = subprocess.run(
            build_fallback_llm_command(),
            input=prompt,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=PROJECT_ROOT,
            timeout=LLM_SUBPROCESS_TIMEOUT_S,
            env=_fallback_llm_env(),
        )
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(
            f"fallback LLM timed out after {LLM_SUBPROCESS_TIMEOUT_S:g}s"
        ) from e
    if result.returncode != 0:
        raise RuntimeError(
            f"fallback LLM exited {result.returncode}: "
            f"{_cli_failure_detail(result.stdout, result.stderr)}"
        )
    return _strip_cli_noise(result.stdout)


def call_llm(prompt: str) -> str:
    """Call the configured LLM CLI and return cleaned response text.

    Default path shells agy via a temp-file @-reference (see build_agy_command),
    since the prompt can carry email headers well past the ~32 KB Windows
    command-line cap. A QUOTA failure on agy fails over to the fallback CLI
    (call_fallback_llm): quota exhaustion is capacity, not credentials, and the
    fallback worker draws from its own quota pool, so the brief can still
    deliver instead of aborting until Google's quota resets.
    """

    prompt_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8", newline="\n"
        ) as f:
            f.write(prompt)
            prompt_path = f.name
        try:
            result = subprocess.run(
                build_agy_command(prompt_path),
                capture_output=True, text=True, encoding="utf-8", errors="replace",
                cwd=PROJECT_ROOT,
                timeout=LLM_SUBPROCESS_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as e:
            # Transient, not auth: main()'s retry loop retries once, then fails
            # with status 'llm' — a hung CLI must fail the run visibly instead
            # of blocking it forever.
            raise RuntimeError(
                f"agy timed out after {LLM_SUBPROCESS_TIMEOUT_S:g}s "
                f"(print-timeout {AGY_PRINT_TIMEOUT})"
            ) from e
    finally:
        if prompt_path:
            try:
                os.unlink(prompt_path)
            except OSError:
                pass

    if result.returncode != 0:
        error_text = f"agy exited {result.returncode}: {result.stderr[:300]}"
        if is_llm_quota_failure(error_text):
            # Quota exhaustion is capacity, not credentials: agy's quota resets
            # on Google's own schedule (16-26h in the recorded 2026-09-02
            # failures), but the fallback CLI draws from a different worker's
            # pool — deliver the brief now instead of aborting until the reset.
            print(
                f"[WARN] agy quota exhausted — failing over to fallback LLM: {error_text}",
                file=sys.stderr,
            )
            return call_fallback_llm(prompt)
        # Credential/license failures are dead — non-transient. Surface the
        # agy failure directly rather than masking it with a fallback.
        raise RuntimeError(error_text)

    return _strip_cli_noise(result.stdout)


# Signatures of non-transient LLM CLI (agy) credential failures. A 10s retry
# cannot fix these: the 2026-08-19..21 license invalidation burned both
# attempts on every scheduled run because the retry loop treated a dead
# license as a transient blip. Matched case-insensitively against the raised
# error text. Quota exhaustion is deliberately NOT here (2026-09-02 revision):
# it is capacity, not credentials — see LLM_QUOTA_FAILURE_SIGNATURES below.
LLM_AUTH_FAILURE_SIGNATURES = (
    "error authenticating",  # "Error authenticating: _GaxiosError: You do not have a valid license..."
    "valid license",
    "invalid_grant",         # OAuth refresh token rejected
    "unauthenticated",       # API-level credential rejection
)


def is_llm_auth_failure(error_text: str) -> bool:
    """True when an LLM CLI (agy) error indicates a credential/license failure
    (non-transient), so callers fail fast instead of retrying."""
    lowered = (error_text or "").lower()
    return any(signature in lowered for signature in LLM_AUTH_FAILURE_SIGNATURES)


# Signatures of LLM CLI (agy) quota exhaustion — capacity, not credentials.
# The recorded 2026-09-02 failures ("Individual quota reached ... Resets in
# 26h16m20s" / "16h19m8s") reset on Google's own schedule, so neither a 10s
# retry nor a re-auth can fix them — but the fallback CLI (a different worker
# with its own quota pool) can still deliver the brief. RESOURCE_EXHAUSTED is
# Google's API-level marker for the same pool (~/.pa/config.yaml pairs it with
# the quota string in the agy worker's rate_limit_patterns).
LLM_QUOTA_FAILURE_SIGNATURES = (
    "individual quota reached",
    "resource_exhausted",
)


def is_llm_quota_failure(error_text: str) -> bool:
    """True when an LLM CLI (agy) error indicates quota exhaustion (capacity,
    not credentials), so call_llm fails over to the fallback CLI instead of
    aborting the brief."""
    lowered = (error_text or "").lower()
    return any(signature in lowered for signature in LLM_QUOTA_FAILURE_SIGNATURES)


PORTFOLIO_JSON_DIR = os.path.normpath(
    os.path.join(PROJECT_ROOT, "..", "portfolio-reports", "data", "prompt_processed", "json")
)


def _env_list(name: str) -> list:
    """Comma-separated env var → stripped, non-empty items ([] when unset)."""
    return [p.strip() for p in os.environ.get(name, "").split(",") if p.strip()]


# Providers excluded from grounding context: ones that already have their own
# full dedicated pipeline (no grounding needed here), plus ones whose processing
# is an intentional, documented deferral (portfolio-reports/README.md) —
# surfacing stale/absent context for either would be misleading.
PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS = set(_env_list("PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS"))
# Deliberately NOT aliased to PA_USER_NAME (used elsewhere for the brief's greeting,
# with a different "the user" fallback) — this must match the literal `owner` field
# portfolio-reports writes into its JSON snapshot filenames/report_metadata, which is
# a data convention, not a display preference. Keeping them separate means changing
# the greeting name can never silently break this filter.
# No personal-name default: the real owner comes from secrets.env (AI-094 —
# this file is tracked by the public mirror). Empty → grounding disabled.
PORTFOLIO_CONTEXT_OWNER = os.environ.get("PORTFOLIO_CONTEXT_OWNER", "")

# Statement-classifier identifiers — env-driven for the same reason. The provider
# set itself is personal data (which wealth manager sends the monthly statement,
# which brokers and banks must not be mistaken for it), so no real name may appear
# here. Deployments supply their own via ~/.pa/secrets.env; the placeholder
# defaults keep a fresh clone runnable, just less precise.
STATEMENT_PROVIDER = os.environ.get("BRIEF_STATEMENT_PROVIDER", "your wealth manager")
STATEMENT_SENDER_NAMES = os.environ.get("BRIEF_STATEMENT_SENDER_NAMES", "your relationship manager")
STATEMENT_EXAMPLE_SUBJECT = os.environ.get("BRIEF_STATEMENT_EXAMPLE_SUBJECT", "MONTHLY REPORT- <CLIENT FULL NAME>")
STATEMENT_EXAMPLE_SENDER = os.environ.get("BRIEF_STATEMENT_EXAMPLE_SENDER", "<relationship manager name>")
# Other brokers/platforms whose statements must NOT trigger portfolio-reports.
OTHER_PROVIDERS = _env_list("BRIEF_OTHER_PROVIDERS")
# Banks whose routine transactional alerts must NOT trigger it either.
BANK_ALERT_SENDERS = _env_list("BRIEF_BANK_ALERT_SENDERS")

_SNAPSHOT_FILENAME_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})_([A-Za-z]+)_([A-Za-z]+)"
)


def load_portfolio_context() -> str:
    """Build a compact grounding block: most recent known total value per
    portfolio provider for the given user, skipping the excluded providers.

    Fails soft on any error (missing directory, malformed JSON, unexpected
    schema) — returns "" rather than raising, since a grounding-context
    failure must never take down the whole daily brief.
    """
    try:
        if not PORTFOLIO_CONTEXT_OWNER:
            print("[WARN] PORTFOLIO_CONTEXT_OWNER not set — portfolio grounding disabled", file=sys.stderr)
            return ""
        if not os.path.isdir(PORTFOLIO_JSON_DIR):
            return ""

        excluded = {p.lower() for p in PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS}
        latest_by_provider = {}  # provider -> (report_date_str, filename)
        for filename in os.listdir(PORTFOLIO_JSON_DIR):
            if not filename.endswith(".json"):
                continue
            m = _SNAPSHOT_FILENAME_RE.match(filename)
            if not m:
                continue
            date_str, owner, provider = m.group(1), m.group(2), m.group(3)
            if owner != PORTFOLIO_CONTEXT_OWNER:
                continue
            if provider.lower() in excluded:
                continue
            existing = latest_by_provider.get(provider)
            if existing is None or date_str > existing[0]:
                latest_by_provider[provider] = (date_str, filename)

        if not latest_by_provider:
            return ""

        lines = []
        for provider, (date_str, filename) in sorted(latest_by_provider.items()):
            path = os.path.join(PORTFOLIO_JSON_DIR, filename)
            try:
                with open(path, encoding="utf-8") as f:
                    snapshot = json.load(f)

                report_metadata = snapshot.get("report_metadata") or {}
                report_date = report_metadata.get("report_date") or date_str
                summary = snapshot.get("summary") or []
                total_value = sum(
                    (item.get("current_value") or 0) for item in summary if isinstance(item, dict)
                )
                if total_value:
                    lines.append(
                        f"- {provider}: last known total value ~₹{total_value:,.0f} "
                        f"as of {report_date} (source: {filename})"
                    )
                else:
                    lines.append(f"- {provider}: last known snapshot dated {report_date}, no total value recorded")
            except (OSError, json.JSONDecodeError, TypeError, AttributeError):
                # One malformed/unexpected-schema snapshot must not wipe out grounding
                # for every other provider already processed in this loop — skip it.
                continue

        if not lines:
            return ""

        scope_note = ""
        if PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS:
            scope_note = (
                " (excludes " + ", ".join(sorted(PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS))
                + " — those are covered by a separate report or intentionally not tracked)"
            )
        return (
            f"Portfolio snapshots on file for {PORTFOLIO_CONTEXT_OWNER}{scope_note}:\n"
            + "\n".join(lines)
        )
    except Exception as e:
        print(f"[WARN] load_portfolio_context failed: {e}", file=sys.stderr)
        return ""


def detect_portfolio_statement_emails(emails: list) -> list:
    """Ask the LLM to identify emails that are personal account/portfolio statements.

    Returns a list of email IDs that the LLM classifies as personal statements.
    Falls back to [] on any error (conservative: don't trigger if uncertain).
    """
    if not emails:
        return []

    try:
        lines = []
        for e in emails:
            subject = (e.get("subject", "") or "")[:120]
            snippet = (e.get("snippet", "") or "")[:150]
            lines.append(
                f'id={e["id"]} from="{e.get("from", "")}" '
                f'subject="{subject}" '
                f'snippet="{snippet}"'
            )
        email_text = "\n".join(lines)

        bank_alert_hint = (
            f" (e.g. from {', '.join(BANK_ALERT_SENDERS)} alerts)" if BANK_ALERT_SENDERS else ""
        )
        other_provider_hint = (
            f"{', '.join(OTHER_PROVIDERS)}, or any provider" if OTHER_PROVIDERS else "any provider"
        )

        prompt = (
            "You are reviewing emails for a personal finance assistant.\n\n"
            "From the following emails, identify any that are the monthly portfolio statement "
            f"from {STATEMENT_PROVIDER.upper()}, sent directly to the user by "
            f"{STATEMENT_SENDER_NAMES} (or another {STATEMENT_PROVIDER} relationship manager). "
            "Example of a qualifying email: subject "
            f"\"{STATEMENT_EXAMPLE_SUBJECT}\", sender \"{STATEMENT_EXAMPLE_SENDER}\".\n\n"
            "Do NOT flag any of the following, even though they may look account/portfolio-related:\n"
            "- Routine bank transactional alerts: OTPs, balance updates, bill/EMI payment "
            f"confirmations, e-mandate notices{bank_alert_hint}\n"
            f"- Statements or contract notes from OTHER brokers/platforms — {other_provider_hint} "
            f"that is not {STATEMENT_PROVIDER}\n"
            "- General market news, newsletters, promotional offers, Sensex/Nifty/stock price "
            "alerts, company earnings results, dividend announcements\n"
            f"- Any email not specifically the {STATEMENT_PROVIDER} monthly statement\n\n"
            "Return ONLY a JSON array of the email IDs that qualify. Return [] if none qualify.\n"
            "Example valid response: [\"18f3a2b1c4d\"]\n\n"
            f"Emails:\n{email_text}"
        )

        response = call_llm(prompt)
        # Try parsing the full response as JSON first.
        # A top-level dict (e.g. {"ids": [...]}) is treated as unrecognised — return [].
        # A top-level list is the expected response format.
        # JSONDecodeError means it's prose with an embedded array; fall through to regex.
        stripped = response.strip()
        try:
            top = json.loads(stripped)
            if isinstance(top, list):
                return [str(i) for i in top]
            else:
                return []
        except (json.JSONDecodeError, ValueError):
            pass
        # Regex fallback: scan all [...] spans in prose, return first valid list
        for m in re.finditer(r'\[.*?\]', response, re.DOTALL):
            try:
                ids = json.loads(m.group(0))
                if isinstance(ids, list):
                    return [str(i) for i in ids]
            except (json.JSONDecodeError, ValueError):
                continue
    except Exception as e:
        print(f"[WARN] Portfolio statement detection failed: {e}", file=sys.stderr)

    return []


def detect_triggers(emails: list) -> list:
    """Return list of skill names to trigger based on LLM email content analysis."""
    triggered = set()

    statement_ids = detect_portfolio_statement_emails(emails)
    if statement_ids:
        by_id = {e.get("id"): e for e in emails}
        for sid in statement_ids:
            matched = by_id.get(sid)
            if matched:
                subj = (matched.get("subject", "") or "")[:120]
                sender = matched.get("from", "")
                print(f"[triggers] portfolio-reports: matched '{subj}' from '{sender}'", file=sys.stderr)
            else:
                print(f"[triggers] portfolio-reports: matched id={sid} (email not found in batch)", file=sys.stderr)
        triggered.add("portfolio-reports")

    return sorted(triggered)


def format_emails_for_prompt(emails: list) -> str:
    """Compact JSON-like format for prompt injection, truncating long snippets."""
    lines = []
    for i, e in enumerate(emails, 1):
        snippet = (e.get("snippet", "") or "")[:200]
        lines.append(
            f'{i}. id={e["id"]} from="{e.get("from","")}" '
            f'subject="{e.get("subject","(no subject)")}" '
            f'category={e.get("gmail_category","unknown")} '
            f'in_inbox={e.get("in_inbox",True)} is_unread={e.get("is_unread",True)}\n'
            f'   snippet: {snippet}'
        )
    return "\n".join(lines)


def build_grounding_rule() -> str:
    """The triage rule forcing portfolio-statement summaries to be grounded in the
    Recent Portfolio Context. Provider names are env-driven (see module top)."""
    subject = (
        f"a {', '.join(OTHER_PROVIDERS)}, or other portfolio/holdings/demat"
        if OTHER_PROVIDERS
        else "a portfolio/holdings/demat"
    )
    caveats = [f"NOT {STATEMENT_PROVIDER} — that has its own separate pipeline"]
    if BANK_ALERT_SENDERS:
        caveats.append(
            f"and NOT a routine {', '.join(BANK_ALERT_SENDERS)} transactional alert like an OTP, "
            "balance update, or credit card payment confirmation — those are just bank alerts, "
            "not investment holdings"
        )
    return (
        f"- If an email is {subject}\n"
        f"  statement or investment announcement ({', '.join(caveats)})\n"
        "  and you classify it NOTEWORTHY or ACTION_REQUIRED, ground\n"
        "  your summary in the Recent Portfolio Context above: state what changed vs. the\n"
        "  last known figure for that provider. If no context is available for that\n"
        "  provider, say so explicitly rather than inventing a comparison."
    )


def build_prompt(window: str, total_count: int, emails_text: str, portfolio_context: str = "") -> str:
    user_name = os.environ.get("PA_USER_NAME", "the user")
    portfolio_context_section = ""
    if portfolio_context:
        portfolio_context_section = f"\n## Recent Portfolio Context (for grounding takes on portfolio-adjacent emails only)\n{portfolio_context}\n"
    return f"""Produce a daily email briefing for {user_name}.

WINDOW: {window}
TOTAL EMAILS: {total_count}

EMAIL DATA:
{emails_text}
{portfolio_context_section}
## Triage Rules
Classify each email as ACTION_REQUIRED, NOTEWORTHY, or SKIP:
- ACTION_REQUIRED: Personal messages, follow-ups, bills/payments, meeting invites, anything needing response/action
- NOTEWORTHY: Important notifications, shipping/delivery, account activity, genuinely interesting newsletters
- SKIP: Clear marketing/promos, mass newsletters, automated system-only notifications
- Bank/UPI alerts: declined → ACTION_REQUIRED; ≥₹5000 → NOTEWORTHY; <₹5000 → SKIP
- gmail_category is a weak hint only — never auto-skip based on category alone
{build_grounding_rule()}

## Output Format
Output exactly two sections separated by these markers (include the markers verbatim):

===BRIEFING_START===
[pa assert] emails.json listed={total_count}

*Mail Brief — {window}*

☀️ *Needs Attention ([N])*
• *Subject* — Sender Name
  One sentence on what needs to be done and any deadline.

📌 *Worth Knowing ([N])*
• *Subject* — Sender Name
  One-line summary.

⏩ *Skipped:* [N] emails ([breakdown: e.g. 12 promos, 5 newsletters, 3 job alerts])
===BRIEFING_END===

===ANALYSIS_START===
*Mail Brief — {window}*

☀️ *Needs Attention ([N])*
• *Subject* — Sender Name
  Comprehensive analysis: what exactly needs to be done, full context, any deadlines, recommended action.

📌 *Worth Knowing ([N])*
• *Subject* — Sender Name
  High-depth analysis: what happened, why it matters strategically, background context, potential impact.
===ANALYSIS_END===

## Decision traces (AI-164)
After the briefing sections, output one more optional section between these markers
(include the markers verbatim, only when there were non-obvious choices):

===DECISIONS_START===
{{"request_excerpt":"<sender + subject, <=200 chars>","decision":"included|excluded|highlighted","rationale":"<one sentence: why this call was non-obvious>","alternatives":["<the disposition you rejected and why>"]}}
===DECISIONS_END===

One JSON object per line, max 10 lines. Record ONLY judgment calls: borderline
inclusions, borderline skips, promotions to the top of the brief. Never record
mechanical or obvious classifications. No code fences around the JSON.

Rules:
- Do NOT fabricate or infer content beyond what the email data shows
- Summarize non-English subjects in English
- Omit the Needs Attention section if count is 0; omit Worth Knowing if count is 0
- Use Telegram Markdown: *bold* for section headers and email subjects
- The [pa assert] line must be the very first line inside ===BRIEFING_START==="""


def build_marker_retry_prompt(prompt: str) -> str:
    return (
        f"{prompt}\n\n"
        "IMPORTANT RETRY INSTRUCTION:\n"
        "Your previous response was invalid because it omitted the required markers.\n"
        "Retry now and output only the two marked sections.\n"
        "You must include these marker pairs verbatim: ===BRIEFING_START=== ... ===BRIEFING_END=== "
        "and ===ANALYSIS_START=== ... ===ANALYSIS_END===.\n"
        "These markers are mandatory even if one or both sections are empty.\n"
        "If a section has no content, leave it blank between its markers instead of omitting the markers.\n"
        "Do not add any text before ===BRIEFING_START=== or after ===ANALYSIS_END===."
    )


def local_tz() -> timezone:
    """PA_TZ_OFFSET_MINUTES (minutes east of UTC) or UTC when unset — a loud
    stderr warning replaces the old silent IST default (WB-54)."""
    raw = os.environ.get("PA_TZ_OFFSET_MINUTES")
    if raw is None or raw == "":
        print("[daily-mail-brief] PA_TZ_OFFSET_MINUTES not set — defaulting to UTC (was IST before 2026-09-17)", file=sys.stderr)
        return timezone.utc
    try:
        return timezone(timedelta(minutes=int(raw)))
    except ValueError:
        print(f"[daily-mail-brief] PA_TZ_OFFSET_MINUTES={raw!r} is not an integer — defaulting to UTC", file=sys.stderr)
        return timezone.utc


def determine_slot(window_end_utc: datetime) -> tuple:
    """Return (date_str, slot_name) for Obsidian filename."""
    tz = local_tz()
    end_local = window_end_utc.astimezone(tz)
    slot = "morning" if end_local.hour <= 6 else "evening"
    return end_local.strftime("%Y-%m-%d"), slot


def parse_window_end(window_end_utc_str: str | None) -> datetime | None:
    if not window_end_utc_str:
        return None
    dt = datetime.fromisoformat(window_end_utc_str.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_decision_rows(response: str) -> list:
    """Extract decision rows from the DECISIONS marker block in LLM response.

    Returns a list of dicts with keys: request_excerpt, decision, rationale, alternatives.
    Malformed lines are skipped with a stderr note. Max 10 rows enforced.
    Missing markers → empty list (block is optional).
    """
    if "===DECISIONS_START===" not in response or "===DECISIONS_END===" not in response:
        return []

    d_start = response.index("===DECISIONS_START===") + len("===DECISIONS_START===")
    d_end = response.index("===DECISIONS_END===")
    block = response[d_start:d_end].strip()

    if not block:
        return []

    rows = []
    for i, line in enumerate(block.split("\n"), 1):
        line = line.strip()
        if not line:
            continue
        if len(rows) >= 10:
            print(f"[WARN] Decision block has >10 rows, capping at 10", file=sys.stderr)
            break
        try:
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
        except (json.JSONDecodeError, ValueError) as e:
            print(f"[WARN] Malformed decision line {i}: {e}", file=sys.stderr)

    return rows[:10]


def main():
    # Step 1: Preflight auth check
    r = run_py("preflight.py", check=False)
    if r.returncode != 0:
        fail = read_failure_marker() or {}
        status = fail.get("status", "auth")
        reason = fail.get("reason", r.stderr[:200] or "Unknown")
        write_failure_marker(status, reason)
        # The skill runner records only this script's stderr as the run's
        # error (pa/src/commands/run.ts: `error: error.trim() || undefined`),
        # and the failure analyzer degrades an empty error to 'unknown error'.
        # Six exit-2 runs printed nothing (2026-08-23..24) and became
        # unclassifiable rows. Print BEFORE _notify_failure so the real reason
        # also precedes any notify-timeout line in the recorded error.
        print(f"[ERROR] preflight failed ({status}): {reason}", file=sys.stderr)
        _notify_failure(
            status,
            f"Daily mail brief skipped — {status} failure.\n"
            f"Reason: {reason[:400]}\n"
            f"Re-auth: run `python ~/.pa/reauth_google.py`",
        )
        # A bare `return` here made preflight failures look like `status: success`
        # to the scheduler — latestSuccess kept advancing, so staleness/cadence
        # detectors stayed quiet and the self-improver's failure analyzer (which
        # reads only `.meta status:error`) could not see the 2026-08-19..21
        # four-day outage (review §2.2). Exit code 2, not 1, distinguishes
        # "blocked on a human-gated auth failure" from a generic step failure —
        # matching preflight.py's own sys.exit(2).
        sys.exit(2)

    # Step 2: Fetch email headers; state is advanced only after a successful primary delivery.
    r = run_py("fetch_headers.py", check=False)
    if r.returncode != 0:
        # fetch_headers already wrote the failure marker and notified
        print("[run_brief] fetch_headers failed, aborting.", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        print(f"[ERROR] fetch_headers output is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    status = data.get("status", "ok")
    if status == "already_processed":
        print(f"Window already processed: {data.get('window', 'Unknown window')}")
        return

    window = data.get("window", "Unknown window")
    window_end_utc_str = data.get("window_end_utc")
    emails = data.get("emails", [])
    total_count = len(emails)
    listed_count = data.get("listed_count", total_count)

    if total_count == 0:
        window_end_dt = parse_window_end(window_end_utc_str)
        if window_end_dt is not None:
            write_last_window_end(window_end_dt)
        print(f"No emails in window: {window}")
        return

    # Step 3: Call the LLM for triage + briefing composition (1 retry on failure)
    emails_text = format_emails_for_prompt(emails)
    portfolio_context = load_portfolio_context()
    prompt = build_prompt(window, total_count, emails_text, portfolio_context)

    def fail_llm(reason: str, auth_failure: bool = False) -> None:
        status = "llm-auth" if auth_failure else "llm"
        body = f"Mail brief failed — LLM error.\nWindow: {window}\nError: {reason[:300]}\n\n"
        # Same invariant as the preflight exit: every failure exit leaves a
        # stderr diagnostic, or the run degrades to an unclassifiable
        # 'unknown error' row (see the preflight branch). The
        # malformed-briefing branch reaches this funnel with no print of its
        # own. Printed BEFORE _notify_failure so an auth/licence reason is
        # never masked by a notify-timeout line in the recorded error.
        print(f"[ERROR] Mail brief failed ({status}): {reason[:300]}", file=sys.stderr)
        if auth_failure:
            body += (
                "This failure is not transient — catchup retries will keep failing until "
                "the LLM credential/license is fixed. Re-authenticate agy (AGY_CMD) or "
                "restore its license, then re-run `pa run daily-mail-brief`."
            )
        else:
            body += "State not advanced — next catchup will retry."
        write_failure_marker(status, reason)
        _notify_failure(status, body)
        sys.exit(1)

    print(f"[run_brief] Calling LLM for {total_count} emails in {window}...")
    response = None
    current_prompt = prompt
    for attempt in range(2):
        try:
            candidate = call_llm(current_prompt)
        except Exception as e:
            if is_llm_auth_failure(str(e)):
                # Credential/license failures are non-transient: the second
                # attempt re-fails identically (2026-08-19..21 license
                # incident), so fail fast with the actionable llm-auth alert.
                print(f"[ERROR] LLM auth/license failure — not retrying: {e}", file=sys.stderr)
                fail_llm(str(e), auth_failure=True)
            if attempt == 0:
                print(f"[WARN] LLM attempt 1 failed, retrying in 10s: {e}", file=sys.stderr)
                time.sleep(10)
                continue
            print(f"[ERROR] LLM call failed after 2 attempts: {e}", file=sys.stderr)
            fail_llm(str(e))

        if "===BRIEFING_START===" in candidate and "===BRIEFING_END===" in candidate:
            response = candidate
            break

        # No markers: the LLM didn't return a real briefing (e.g. it went agentic
        # and replied with meta-commentary like "saved to output.json" instead of
        # the requested text). Retry once rather than silently fabricating an
        # assert header that would bypass send_telegram.py's hallucination check.
        if attempt == 0:
            current_prompt = build_marker_retry_prompt(prompt)
            print("[WARN] LLM attempt 1 returned no BRIEFING markers, retrying in 10s", file=sys.stderr)
            time.sleep(10)
        else:
            print("[ERROR] LLM returned no BRIEFING markers after 2 attempts", file=sys.stderr)
            fail_llm(f"Response missing BRIEFING markers. Raw response: {candidate[:300]}")
    if response is None:
        print("[ERROR] LLM returned no response.", file=sys.stderr)
        sys.exit(1)

    window_end_dt = parse_window_end(window_end_utc_str)

    # Step 4: Parse LLM output (markers guaranteed present at this point)
    b_start = response.index("===BRIEFING_START===") + len("===BRIEFING_START===")
    b_end = response.index("===BRIEFING_END===")
    briefing_output = response[b_start:b_end].strip()
    analysis_input = ""
    if "===ANALYSIS_START===" in response and "===ANALYSIS_END===" in response:
        a_start = response.index("===ANALYSIS_START===") + len("===ANALYSIS_START===")
        a_end = response.index("===ANALYSIS_END===")
        analysis_input = response[a_start:a_end].strip()

    if not briefing_output or not briefing_output.startswith("[pa assert]"):
        # Extraction between markers was empty or malformed — don't fabricate an
        # assert header, that's exactly what let a hallucinated response through
        # send_telegram.py's count check last time.
        fail_llm(f"Malformed briefing content between markers: {briefing_output[:300] or '<empty>'}")

    # Step 4b: Parse and record decision traces (AI-164)
    decision_rows = parse_decision_rows(response)
    if decision_rows:
        # Enrich each row deterministically before recording (the LLM never supplies these)
        try:
            thread_id = None
            chat_id = None
            try:
                thread_id = int(os.environ.get("TELEGRAM_DAILY_BRIEFING_THREAD_ID", ""))
            except (ValueError, TypeError):
                pass
            try:
                chat_id = int(os.environ.get("TELEGRAM_BRIEFING_CHAT_ID", ""))
            except (ValueError, TypeError):
                pass

            for row in decision_rows:
                row["source"] = "skill"
                row["skill"] = "daily-mail-brief"
                if thread_id is not None:
                    row["thread_id"] = thread_id
                if chat_id is not None:
                    row["chat_id"] = chat_id
                result = decisions_lib.record_decision(row)
                if not result.get("ok"):
                    print(f"[WARN] decision trace write failed: {result.get('error', 'unknown')}", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] decision trace recording failed: {e}", file=sys.stderr)
            # Never fail the brief — recording is optional instrumentation

    # Step 5: Write output files
    briefing_path = os.path.join(PROJECT_ROOT, "briefing_output.md")
    with open(briefing_path, "w", encoding="utf-8") as f:
        f.write(briefing_output)

    if analysis_input:
        analysis_path = os.path.join(PROJECT_ROOT, "analysis_input.md")
        with open(analysis_path, "w", encoding="utf-8") as f:
            f.write(analysis_input)

    # Step 6: Send briefing to Telegram
    r = run_py("send_telegram.py", briefing_path, check=False)
    if r.returncode != 0:
        print(f"[WARN] Telegram send failed: {r.stderr[:200]}", file=sys.stderr)
        sys.exit(r.returncode)

    if window_end_dt is not None:
        write_last_window_end(window_end_dt)

    # Step 7: Generate and send analysis PDF
    if analysis_input:
        pdf_path = os.path.join(PROJECT_ROOT, "analysis_output.pdf")
        if os.path.exists(pdf_path):
            os.remove(pdf_path)
        r_pdf = run_py("generate_analysis_pdf.py", analysis_path, check=False)
        if r_pdf.returncode == 0 and os.path.exists(pdf_path):
            run_py("send_telegram.py", pdf_path, check=False)

    # Step 8: Copy to Obsidian (optional — only if OBSIDIAN_BRIEFS_DIR is set)
    obsidian_dir = os.environ.get("OBSIDIAN_BRIEFS_DIR")
    if obsidian_dir:
        if window_end_dt is None:
            print("[obsidian] skipping (window_end unavailable)", file=sys.stderr)
        else:
            date_str, slot = determine_slot(window_end_dt)
            obsidian_path = f"{obsidian_dir}/{date_str}-{slot}.md"
            run_py("write_obsidian.py", obsidian_path, briefing_path, check=False)
    else:
        print("[obsidian] skipping (OBSIDIAN_BRIEFS_DIR env var unset)")

    # Step 9: Skill triggers
    for skill in detect_triggers(emails):
        print(f"[pa run {skill}]")

    print(f"\n[OK] Brief complete — {window} ({total_count} emails)")


if __name__ == "__main__":
    main()
