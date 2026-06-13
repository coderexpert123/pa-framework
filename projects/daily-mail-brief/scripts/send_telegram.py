"""
Send a markdown briefing file to Telegram.
Usage: python send_telegram.py <path_to_briefing.md>
Reads TELEGRAM_BOT_TOKEN from environment.
Chat routing (in priority order):
  TELEGRAM_BRIEFING_CHAT_ID — if set, used instead of TELEGRAM_CHAT_ID (briefing-specific override)
  TELEGRAM_CHAT_ID          — fallback; may be comma-separated (e.g. "1000000001,-1001234567890")
TELEGRAM_DAILY_BRIEFING_THREAD_ID (optional): if set, messages sent to supergroup
chats (IDs starting with -100) will be posted into that forum topic.

Failure mode: when .fetch-failed.json exists in cwd, bypasses the [pa assert]
header check and sends briefing_output.md content as-is (user-facing failure
notice delivery).

Normal mode: verifies [pa assert] emails.json listed={n} header matches the
actual email count in emails.json. Mismatch or missing header → halucination
alert via pa notify, does NOT send the briefing to the user.
"""
import json
import os
import secrets
import sys
from datetime import datetime, timezone

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
FETCH_FAILED_FILE = os.path.join(PROJECT_ROOT, ".fetch-failed.json")

MAX_MSG_LEN = 4000  # Telegram limit is 4096, leave buffer


def _pa_home() -> str:
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def _log_skill_message_sent(ref_id: str, chat_id: str, thread_id, chunk_index: int, text_preview: str) -> None:
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "level": "info",
        "module": "telegram",
        "message": "skill message sent",
        "refId": ref_id,
        "chatId": int(chat_id),
        "threadId": int(thread_id) if thread_id is not None else None,
        "chunkIndex": chunk_index,
        "textPreview": text_preview[:500],
    }
    try:
        log_path = os.path.join(_pa_home(), "app.log.jsonl")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # log failures must never crash delivery


def split_message(text: str) -> list:
    """Split long text at paragraph boundaries."""
    if len(text) <= MAX_MSG_LEN:
        return [text]

    parts = []
    while len(text) > MAX_MSG_LEN:
        # Find last paragraph break before limit
        cut = text.rfind("\n\n", 0, MAX_MSG_LEN)
        if cut == -1:
            cut = text.rfind("\n", 0, MAX_MSG_LEN)
        if cut == -1:
            cut = MAX_MSG_LEN
        parts.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        parts.append(text)
    return parts


def send(text: str):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id_raw = os.environ.get("TELEGRAM_BRIEFING_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")
    thread_id_str = os.environ.get("TELEGRAM_DAILY_BRIEFING_THREAD_ID")

    if not token or not chat_id_raw:
        print("[Telegram] ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_BRIEFING_CHAT_ID (or TELEGRAM_CHAT_ID) must be set", file=sys.stderr)
        sys.exit(1)

    ref_id = f"s-{secrets.token_hex(2)}"
    chat_ids = [cid.strip() for cid in chat_id_raw.split(",") if cid.strip()]
    base_url = f"https://api.telegram.org/bot{token}"
    parts = split_message(text)
    # Append ref trailer to last chunk so it shows up in the message
    parts[-1] = f"{parts[-1]}\n\n_Ref: {ref_id}_"
    any_failed = False

    for chat_id in chat_ids:
        # Apply thread_id only to supergroup chats (IDs starting with -100)
        use_thread_id = None
        if thread_id_str and chat_id.startswith("-100"):
            use_thread_id = int(thread_id_str)

        for i, part in enumerate(parts, 1):
            chunk_index = i - 1
            payload = {
                "chat_id": chat_id,
                "text": part,
                "parse_mode": "Markdown",
            }
            if use_thread_id is not None:
                payload["message_thread_id"] = use_thread_id

            try:
                resp = requests.post(f"{base_url}/sendMessage", json=payload)
                if resp.status_code == 200:
                    print(f"[Telegram] {chat_id} Part {i}/{len(parts)} sent OK (ref={ref_id})")
                    _log_skill_message_sent(ref_id, chat_id, use_thread_id, chunk_index, part)
                else:
                    # Retry without Markdown in case of formatting errors
                    plain_text = part.replace(f"\n\n_Ref: {ref_id}_", f"\n\nRef: {ref_id}")
                    fallback = {"chat_id": chat_id, "text": plain_text}
                    if use_thread_id is not None:
                        fallback["message_thread_id"] = use_thread_id
                    resp2 = requests.post(f"{base_url}/sendMessage", json=fallback)
                    if resp2.status_code == 200:
                        print(f"[Telegram] {chat_id} Part {i}/{len(parts)} sent (plain fallback): OK (ref={ref_id})")
                        _log_skill_message_sent(ref_id, chat_id, use_thread_id, chunk_index, plain_text)
                    else:
                        print(f"[Telegram] ERROR: {chat_id} Part {i}/{len(parts)} failed even without Markdown: {resp2.status_code} {resp2.text}", file=sys.stderr)
                        any_failed = True
            except Exception as e:
                print(f"[Telegram] Error sending to {chat_id} part {i}: {e}", file=sys.stderr)
                any_failed = True

    if any_failed:
        sys.exit(1)


def send_document(file_path: str):
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id_raw = os.environ.get("TELEGRAM_BRIEFING_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")
    thread_id_str = os.environ.get("TELEGRAM_DAILY_BRIEFING_THREAD_ID")

    if not token or not chat_id_raw:
        print("[Telegram] ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_BRIEFING_CHAT_ID (or TELEGRAM_CHAT_ID) must be set", file=sys.stderr)
        sys.exit(1)

    chat_ids = [cid.strip() for cid in chat_id_raw.split(",") if cid.strip()]
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    any_failed = False

    for chat_id in chat_ids:
        use_thread_id = None
        if thread_id_str and chat_id.startswith("-100"):
            use_thread_id = int(thread_id_str)

        try:
            with open(file_path, 'rb') as f:
                files = {'document': f}
                payload = {'chat_id': chat_id}
                if use_thread_id is not None:
                    payload["message_thread_id"] = use_thread_id
                
                resp = requests.post(url, data=payload, files=files)
                if resp.status_code == 200:
                    print(f"[Telegram] {chat_id} Document sent OK")
                else:
                    print(f"[Telegram] ERROR: {chat_id} Document failed: {resp.status_code} {resp.text}", file=sys.stderr)
                    any_failed = True
        except Exception as e:
            print(f"[Telegram] Error sending document to {chat_id}: {e}", file=sys.stderr)
            any_failed = True

    if any_failed:
        sys.exit(1)


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

    # Failure mode: .fetch-failed.json present → bypass assert, send as-is
    if os.path.exists(FETCH_FAILED_FILE):
        print("[send_telegram] failure-mode delivery", file=sys.stderr)

    if path.lower().endswith(".pdf"):
        send_document(path)
        return

    with open(path, encoding="utf-8") as f:
        text = f.read()

    # Normal mode: verify assertion header
    if not os.path.exists(FETCH_FAILED_FILE):
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

    send(text)


if __name__ == "__main__":
    main()
