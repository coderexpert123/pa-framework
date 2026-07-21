"""
Orchestrator for daily mail brief.

Runs all fetch/send/pdf/obsidian steps as Python code.
Calls gemini CLI only for LLM analysis (text-in, text-out, no tool use).
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta

from runtime_state import read_failure_marker, write_failure_marker, write_last_window_end

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

# Env-driven gemini binary path. Default to plain "gemini" (in PATH).
# User with a wrapper/shim sets GEMINI_CMD in ~/.pa/secrets.env.
GEMINI_CMD = os.environ.get("GEMINI_CMD", "gemini")


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


def call_gemini(prompt: str) -> str:
    """Call gemini CLI non-interactively via stdin pipe, return cleaned response text.

    Uses -p '' to trigger non-interactive mode; full prompt is sent via stdin
    (gemini appends stdin to the -p value), avoiding the Windows 32KB arg limit.
    Session hook noise is stripped from the output.
    """
    result = subprocess.run(
        ["cmd", "/c", GEMINI_CMD, "--yolo", "--output-format", "text", "-p", ""],
        input=prompt,
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=PROJECT_ROOT,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Gemini exited {result.returncode}: {result.stderr[:300]}"
            + (f"\nstdout: {result.stdout[:300]}" if result.stdout.strip() else "")
        )
    # Strip session hook noise that gemini appends after the real response
    output = result.stdout
    noise_marker = "Created execution plan for SessionEnd:"
    if noise_marker in output:
        output = output[:output.index(noise_marker)]
    return output.strip()


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
    """Ask Gemini to identify emails that are personal account/portfolio statements.

    Returns a list of email IDs that Gemini classifies as personal statements.
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

        response = call_gemini(prompt)
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


def determine_slot(window_end_utc: datetime) -> tuple:
    """Return (date_str, slot_name) for Obsidian filename."""
    ist = timezone(timedelta(hours=5, minutes=30))
    end_ist = window_end_utc.astimezone(ist)
    slot = "morning" if end_ist.hour <= 6 else "evening"
    return end_ist.strftime("%Y-%m-%d"), slot


def parse_window_end(window_end_utc_str: str | None) -> datetime | None:
    if not window_end_utc_str:
        return None
    dt = datetime.fromisoformat(window_end_utc_str.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def main():
    # Step 1: Preflight auth check
    r = run_py("preflight.py", check=False)
    if r.returncode != 0:
        fail = read_failure_marker() or {}
        status = fail.get("status", "auth")
        reason = fail.get("reason", r.stderr[:200] or "Unknown")
        write_failure_marker(status, reason)
        _notify_failure(
            status,
            f"Daily mail brief skipped — {status} failure.\n"
            f"Reason: {reason[:400]}\n"
            f"Re-auth: run `python ~/.pa/reauth_google.py`",
        )
        return

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

    # Step 3: Call gemini for triage + briefing composition (1 retry on failure)
    emails_text = format_emails_for_prompt(emails)
    portfolio_context = load_portfolio_context()
    prompt = build_prompt(window, total_count, emails_text, portfolio_context)

    def fail_gemini(reason: str) -> None:
        write_failure_marker("gemini", reason)
        _notify_failure(
            "gemini",
            f"Mail brief failed — Gemini error.\n"
            f"Window: {window}\nError: {reason[:300]}\n\n"
            f"State not advanced — next catchup will retry.",
        )
        sys.exit(1)

    print(f"[run_brief] Calling gemini for {total_count} emails in {window}...")
    response = None
    current_prompt = prompt
    for attempt in range(2):
        try:
            candidate = call_gemini(current_prompt)
        except Exception as e:
            if attempt == 0:
                print(f"[WARN] Gemini attempt 1 failed, retrying in 10s: {e}", file=sys.stderr)
                time.sleep(10)
                continue
            print(f"[ERROR] Gemini call failed after 2 attempts: {e}", file=sys.stderr)
            fail_gemini(str(e))

        if "===BRIEFING_START===" in candidate and "===BRIEFING_END===" in candidate:
            response = candidate
            break

        # No markers: Gemini didn't return a real briefing (e.g. it went agentic
        # and replied with meta-commentary like "saved to output.json" instead of
        # the requested text). Retry once rather than silently fabricating an
        # assert header that would bypass send_telegram.py's hallucination check.
        if attempt == 0:
            current_prompt = build_marker_retry_prompt(prompt)
            print("[WARN] Gemini attempt 1 returned no BRIEFING markers, retrying in 10s", file=sys.stderr)
            time.sleep(10)
        else:
            print("[ERROR] Gemini returned no BRIEFING markers after 2 attempts", file=sys.stderr)
            fail_gemini(f"Response missing BRIEFING markers. Raw response: {candidate[:300]}")
    if response is None:
        print("[ERROR] Gemini returned no response.", file=sys.stderr)
        sys.exit(1)

    window_end_dt = parse_window_end(window_end_utc_str)

    # Step 4: Parse gemini output (markers guaranteed present at this point)
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
        fail_gemini(f"Malformed briefing content between markers: {briefing_output[:300] or '<empty>'}")

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
