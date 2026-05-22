"""
Orchestrator for daily mail brief.

Runs all fetch/send/pdf/obsidian steps as Python code.
Calls gemini CLI only for LLM analysis (text-in, text-out, no tool use).
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
# Env-driven gemini binary path. Default to plain "gemini" (in PATH).
# User with a wrapper/shim sets GEMINI_CMD in ~/.pa/secrets.env.
GEMINI_CMD = os.environ.get("GEMINI_CMD", "gemini")
FETCH_FAILED_FILE = os.path.join(PROJECT_ROOT, ".fetch-failed.json")

# Skill trigger keywords → skill names
TRIGGER_RULES = [
    (["examplebank statement", "credit card statement", "account statement", "dividend", "results declared",
      "portfolio", "mutual fund", "nse", "bse", "stock", "l&t", "m&m", "sensex", "nifty"], "portfolio-reports"),
]


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


def detect_triggers(emails: list) -> list:
    """Return list of skill names to trigger based on email subjects."""
    triggered = set()
    all_subjects = " ".join(e.get("subject", "").lower() for e in emails)
    for keywords, skill in TRIGGER_RULES:
        if any(kw in all_subjects for kw in keywords):
            triggered.add(skill)
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


def build_prompt(window: str, total_count: int, emails_text: str) -> str:
    user_name = os.environ.get("PA_USER_NAME", "the user")
    return f"""Produce a daily email briefing for {user_name}.

WINDOW: {window}
TOTAL EMAILS: {total_count}

EMAIL DATA:
{emails_text}

## Triage Rules
Classify each email as ACTION_REQUIRED, NOTEWORTHY, or SKIP:
- ACTION_REQUIRED: Personal messages, follow-ups, bills/payments, meeting invites, anything needing response/action
- NOTEWORTHY: Important notifications, shipping/delivery, account activity, genuinely interesting newsletters
- SKIP: Clear marketing/promos, mass newsletters, automated system-only notifications
- Bank/UPI alerts: declined → ACTION_REQUIRED; ≥₹5000 → NOTEWORTHY; <₹5000 → SKIP
- gmail_category is a weak hint only — never auto-skip based on category alone

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


def main():
    # Step 1: Preflight auth check
    r = run_py("preflight.py", check=False)
    if r.returncode != 0:
        if os.path.exists(FETCH_FAILED_FILE):
            with open(FETCH_FAILED_FILE, encoding="utf-8") as f:
                fail = json.load(f)
            status, reason = fail.get("status", "auth"), fail.get("reason", "Unknown")
        else:
            status, reason = "auth", r.stderr[:200]
        briefing = (
            f"⚠️ **Daily mail brief skipped — {status} failure**\n\n"
            f"Reason: {reason}\n\n"
            f"Re-auth: run `python ~/.pa/reauth_google.py`"
        )
        briefing_path = os.path.join(PROJECT_ROOT, "briefing_output.md")
        with open(briefing_path, "w", encoding="utf-8") as f:
            f.write(briefing)
        # Ensure .fetch-failed.json exists so send_telegram.py bypasses [pa assert] check
        if not os.path.exists(FETCH_FAILED_FILE):
            with open(FETCH_FAILED_FILE, "w", encoding="utf-8") as fh:
                json.dump({"status": status, "reason": reason[:500],
                           "timestamp": datetime.now(timezone.utc).isoformat()}, fh)
        run_py("send_telegram.py", briefing_path, check=False)
        return

    # Step 2: Fetch email headers (state.json is NOT advanced here; run_brief advances it after Gemini succeeds)
    r = run_py("fetch_headers.py", check=False)
    if r.returncode != 0:
        # fetch_headers already wrote .fetch-failed.json and notified
        print("[run_brief] fetch_headers failed, aborting.", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        print(f"[ERROR] fetch_headers output is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if data.get("window") == "not yet due":
        print("Slot not yet due — nothing to fetch.")
        return

    window = data.get("window", "Unknown window")
    window_end_utc_str = data.get("window_end_utc")
    emails = data.get("emails", [])
    total_count = len(emails)
    listed_count = data.get("listed_count", total_count)

    if listed_count == 0:
        print(f"No emails in window: {window}")
        return

    # Step 3: Call gemini for triage + briefing composition (1 retry on failure)
    emails_text = format_emails_for_prompt(emails)
    prompt = build_prompt(window, total_count, emails_text)

    print(f"[run_brief] Calling gemini for {total_count} emails in {window}...")
    response = None
    for attempt in range(2):
        try:
            response = call_gemini(prompt)
            break
        except Exception as e:
            if attempt == 0:
                print(f"[WARN] Gemini attempt 1 failed, retrying in 10s: {e}", file=sys.stderr)
                time.sleep(10)
            else:
                print(f"[ERROR] Gemini call failed after 2 attempts: {e}", file=sys.stderr)
                fail_msg = (
                    f"⚠️ **Mail brief failed — Gemini error**\n\n"
                    f"Window: {window}\nError: {str(e)[:300]}\n\n"
                    f"State not advanced — next catchup will retry."
                )
                briefing_path = os.path.join(PROJECT_ROOT, "briefing_output.md")
                with open(briefing_path, "w", encoding="utf-8") as f:
                    f.write(fail_msg)
                # Write .fetch-failed.json so send_telegram.py bypasses [pa assert] check
                with open(FETCH_FAILED_FILE, "w", encoding="utf-8") as fh:
                    json.dump({"status": "gemini", "reason": str(e)[:500],
                               "timestamp": datetime.now(timezone.utc).isoformat()}, fh)
                run_py("send_telegram.py", briefing_path, check=False)
                sys.exit(1)

    # Advance state now that Gemini succeeded — prevents permanent skip on earlier failure
    if window_end_utc_str:
        state_path = os.path.join(PROJECT_ROOT, "state.json")
        with open(state_path, "w") as f:
            json.dump({"last_window_end_utc": window_end_utc_str}, f, indent=2)
    window_end_dt = (
        datetime.fromisoformat(window_end_utc_str).replace(tzinfo=timezone.utc)
        if window_end_utc_str else None
    )

    # Step 4: Parse gemini output
    briefing_output = ""
    analysis_input = ""

    if "===BRIEFING_START===" in response and "===BRIEFING_END===" in response:
        b_start = response.index("===BRIEFING_START===") + len("===BRIEFING_START===")
        b_end = response.index("===BRIEFING_END===")
        briefing_output = response[b_start:b_end].strip()
    if "===ANALYSIS_START===" in response and "===ANALYSIS_END===" in response:
        a_start = response.index("===ANALYSIS_START===") + len("===ANALYSIS_START===")
        a_end = response.index("===ANALYSIS_END===")
        analysis_input = response[a_start:a_end].strip()

    if not briefing_output:
        # Fallback: use entire response with assert prepended
        briefing_output = f"[pa assert] emails.json listed={total_count}\n\n{response}"

    # Ensure assert header is first line
    if not briefing_output.startswith("[pa assert]"):
        briefing_output = f"[pa assert] emails.json listed={total_count}\n\n{briefing_output}"

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
    if r.returncode not in (0, 2):  # 2 = assertion failed (already notified)
        print(f"[WARN] Telegram send: {r.stderr[:200]}", file=sys.stderr)

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
            state_path = os.path.join(PROJECT_ROOT, "state.json")
            with open(state_path, encoding="utf-8") as f:
                state = json.load(f)
            window_end_dt = datetime.fromisoformat(state["last_window_end_utc"]).replace(tzinfo=timezone.utc)
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
