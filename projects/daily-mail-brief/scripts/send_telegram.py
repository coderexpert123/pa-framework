"""Send a markdown briefing file to Telegram."""
import json
import os
import sys

from runtime_state import fetch_failed_file

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)


def _find_pa_src():
    """Locate the pa/src directory containing telegram_notify.py."""
    root = os.environ.get("PA_FRAMEWORK_ROOT")
    if root:
        candidate = os.path.join(root, "pa", "src")
        if os.path.isdir(candidate):
            return candidate
    current = os.path.abspath(__file__)
    for _ in range(8):
        current = os.path.dirname(current)
        candidate = os.path.join(current, "pa", "src")
        if os.path.isfile(os.path.join(candidate, "telegram_notify.py")):
            return candidate
    return None


_pa_src = _find_pa_src()
if not _pa_src:
    print("[send_telegram] FATAL: could not locate pa/src/telegram_notify.py "
          "(set PA_FRAMEWORK_ROOT)", file=sys.stderr)
    sys.exit(1)
sys.path.insert(0, _pa_src)
from telegram_notify import send_document, send_text  # noqa: E402


def _build_hallucination_body(claimed: str, actual: int, first_line: str) -> str:
    worker = os.environ.get("PA_WORKER_NAME", "<unknown>")
    return (
        f"Expected: {actual} emails in emails.json\n"
        f"Claimed: {claimed}\n"
        f"First line: {first_line[:200]}\n"
        f"Worker: {worker}\n"
        f"Halucination detected — briefing NOT sent to user."
    )


def _check_assertion(text: str) -> tuple:
    """
    Verify [pa assert] emails.json listed={n} header.
    Returns (ok, claimed_count_str, actual_count).
    """
    first_line = text.split("\n", 1)[0].strip()
    if not first_line.startswith("[pa assert] emails.json listed="):
        return (False, "<missing>", -1)

    claimed = first_line.split("=", 1)[1].strip()
    # Load actual count from emails.json
    emails_path = os.path.join(PROJECT_ROOT, "emails.json")
    if not os.path.exists(emails_path):
        return (False, claimed, -1)

    try:
        with open(emails_path, encoding="utf-8") as f:
            data = json.load(f)
        actual = len(data.get("emails", []))
    except Exception:
        return (False, claimed, -1)

    try:
        claimed_int = int(claimed)
    except ValueError:
        return (False, claimed, actual)

    return (claimed_int == actual, claimed, actual)


def main():
    if len(sys.argv) < 2:
        print("Usage: python send_telegram.py <file_path>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"[Telegram] ERROR: File not found: {path}", file=sys.stderr)
        sys.exit(1)

    failure_marker = fetch_failed_file()

    # Failure mode: the PA-home failure marker exists → bypass assert, send as-is
    if os.path.exists(failure_marker):
        print("[send_telegram] failure-mode delivery", file=sys.stderr)

    if path.lower().endswith(".pdf"):
        send_document(path)
        return

    with open(path, encoding="utf-8") as f:
        text = f.read()

    # Normal mode: verify assertion header
    if not os.path.exists(failure_marker):
        ok, claimed, actual = _check_assertion(text)
        if not ok:
            first_line = text.split("\n", 1)[0].strip()
            body = _build_hallucination_body(claimed, actual, first_line)
            sys.path.insert(0, SCRIPT_DIR)
            from notify import send as notify_send
            notify_send(
                subject="daily-mail-brief: assertion failed",
                body=body,
                dedup_key="daily-mail-brief-hallucination",
            )
            print(f"[send_telegram] ASSERTION FAILED: claimed={claimed}, actual={actual}", file=sys.stderr)
            sys.exit(2)
        # Strip the assert header line before sending
        text = text.split("\n", 1)[1] if "\n" in text else ""

    send_text(text)


if __name__ == "__main__":
    main()
