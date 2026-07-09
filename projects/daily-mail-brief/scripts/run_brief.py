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
# Providers excluded from grounding context: exampleprovider has its own full monthly
# pipeline already (no grounding needed here); examplebroker processing is an
# intentional, documented deferral (portfolio-reports/README.md) — surfacing
# stale/absent examplebroker context here would be misleading.
PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS = {"exampleprovider", "examplebroker"}
# Deliberately NOT aliased to PA_USER_NAME (used elsewhere for the brief's greeting,
# with a different "the user" fallback) — this must match the literal `owner` field
# portfolio-reports writes into its JSON snapshot filenames/report_metadata, which is
# a data convention, not a display preference. Keeping them separate means changing
# the greeting name can never silently break this filter.
# No personal-name default: the real owner comes from secrets.env (AI-094 —
# this file is tracked by the public mirror). Empty → grounding disabled.
PORTFOLIO_CONTEXT_OWNER = os.environ.get("PORTFOLIO_CONTEXT_OWNER", "")

# exampleprovider classifier prompt identifiers — env-driven for the same reason.
BRIEF_STATEMENT_SENDER_NAMES = os.environ.get("BRIEF_STATEMENT_SENDER_NAMES", "your relationship manager")
BRIEF_STATEMENT_EXAMPLE_SUBJECT = os.environ.get("BRIEF_STATEMENT_EXAMPLE_SUBJECT", "MONTHLY REPORT- <CLIENT FULL NAME>")
BRIEF_STATEMENT_EXAMPLE_SENDER = os.environ.get("BRIEF_STATEMENT_EXAMPLE_SENDER", "<relationship manager name>")

_SNAPSHOT_FILENAME_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2})_([A-Za-z]+)_([A-Za-z]+)"
)


def load_portfolio_context() -> str:
    """Build a compact grounding block: most recent known total value per
    non-exampleprovider, non-examplebroker portfolio provider, for the given user.

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
            if provider.lower() in PORTFOLIO_CONTEXT_EXCLUDED_PROVIDERS:
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

        return (
            f"Portfolio snapshots on file for {PORTFOLIO_CONTEXT_OWNER} "
            f"(examplebroker2/Example Securities/other non-exampleprovider providers only — "
            f"exampleprovider has its own separate monthly report, examplebroker is "
            f"intentionally not tracked):\n" + "\n".join(lines)
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

        prompt = (
            "You are reviewing emails for a personal finance assistant.\n\n"
            "From the following emails, identify any that are the monthly portfolio statement "
            f"from Example Wealth, sent directly to the user by {BRIEF_STATEMENT_SENDER_NAMES} (or another "
            "Example Wealth relationship manager). Example of a qualifying email: subject "
            f"\"{BRIEF_STATEMENT_EXAMPLE_SUBJECT}\", sender \"{BRIEF_STATEMENT_EXAMPLE_SENDER}\".\n\n"
            "Do NOT flag any of the following, even though they may look account/portfolio-related:\n"
            "- Routine bank transactional alerts: OTPs, balance updates, bill/EMI payment "
            "confirmations, e-mandate notices (e.g. from examplebank Bank alerts)\n"
            "- Statements or contract notes from OTHER brokers/platforms — examplebroker2, examplebank "
            "Securities, examplebroker, or any provider that is not Example Wealth\n"
            "- General market news, newsletters, promotional offers, Sensex/Nifty/stock price "
            "alerts, company earnings results, dividend announcements\n"
            "- Any email not specifically the Example Wealth monthly statement\n\n"
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
- If an email is a examplebroker2, Example Securities, or other portfolio/holdings/demat
  statement or investment announcement (NOT exampleprovider — that has its own separate
  pipeline, and NOT a routine examplebank Bank transactional alert like an OTP, balance
  update, or credit card payment confirmation — those are just bank alerts, not
  investment holdings) and you classify it NOTEWORTHY or ACTION_REQUIRED, ground
  your summary in the Recent Portfolio Context above: state what changed vs. the
  last known figure for that provider. If no context is available for that
  provider, say so explicitly rather than inventing a comparison.

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
        briefing = (
            f"⚠️ **Daily mail brief skipped — {status} failure**\n\n"
            f"Reason: {reason}\n\n"
            f"Re-auth: run `python ~/.pa/reauth_google.py`"
        )
        briefing_path = os.path.join(PROJECT_ROOT, "briefing_output.md")
        with open(briefing_path, "w", encoding="utf-8") as f:
            f.write(briefing)
        write_failure_marker(status, reason)
        run_py("send_telegram.py", briefing_path, check=False)
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
        fail_msg = (
            f"⚠️ **Mail brief failed — Gemini error**\n\n"
            f"Window: {window}\nError: {reason[:300]}\n\n"
            f"State not advanced — next catchup will retry."
        )
        briefing_path = os.path.join(PROJECT_ROOT, "briefing_output.md")
        with open(briefing_path, "w", encoding="utf-8") as f:
            f.write(fail_msg)
        write_failure_marker("gemini", reason)
        run_py("send_telegram.py", briefing_path, check=False)
        sys.exit(1)

    print(f"[run_brief] Calling gemini for {total_count} emails in {window}...")
    response = None
    for attempt in range(2):
        try:
            candidate = call_gemini(prompt)
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
