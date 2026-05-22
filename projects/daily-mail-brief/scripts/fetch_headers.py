"""
Fetch email headers for the next scheduled 12h window.

The two daily slots are 13:30 UTC (7:00 PM IST) and 23:30 UTC (5:00 AM IST next day).
Uses state.json to track the last processed window end, so each run covers
exactly its intended slot regardless of when it actually executes (catchup-safe).
"""
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta

# Force UTF-8 output on Windows
if sys.stdout.encoding != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
STATE_FILE = os.path.join(PROJECT_ROOT, "state.json")
FETCH_FAILED_FILE = os.path.join(PROJECT_ROOT, ".fetch-failed.json")


def _write_fetch_failed(status: str, reason: str):
    with open(FETCH_FAILED_FILE, "w", encoding="utf-8") as f:
        json.dump({
            "status": status,
            "reason": reason[:500],
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }, f, indent=2)


def _dedup_key_for_status(status: str) -> str:
    return "daily-mail-brief-auth" if status == "auth" else "daily-mail-brief-fetch"


def _fetch_failed(status: str, reason: str):
    """Write .fetch-failed.json, alert pa-support, and exit."""
    _write_fetch_failed(status, reason)
    sys.path.insert(0, SCRIPT_DIR)
    from notify import send as notify_send
    notify_send(
        subject=f"daily-mail-brief: {status} failure",
        body=reason[:500],
        dedup_key=_dedup_key_for_status(status),
    )
    print(f"[fetch] {status} failure: {reason[:300]}", file=sys.stderr)
    sys.exit(1)

# Slot boundaries in UTC (hour, minute) — evening first, then overnight-morning
DAILY_SLOTS_UTC = [(13, 30), (23, 30)]


def next_slot_after(dt: datetime) -> datetime:
    """Return the next scheduled slot boundary strictly after dt."""
    dt = dt.replace(second=0, microsecond=0)
    for h, m in DAILY_SLOTS_UTC:
        candidate = dt.replace(hour=h, minute=m)
        if candidate > dt:
            return candidate
    # Wrap to next day first slot
    next_day = dt + timedelta(days=1)
    h, m = DAILY_SLOTS_UTC[0]
    return next_day.replace(hour=h, minute=m)


def load_state() -> datetime:
    """Return last_window_end from state.json, or default to 12h ago."""
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                data = json.load(f)
            return datetime.fromisoformat(data["last_window_end_utc"]).replace(tzinfo=timezone.utc)
        except Exception:
            pass
    # First run: default to 12h ago (covers one slot back)
    return datetime.now(timezone.utc) - timedelta(hours=12)


def save_state(window_end: datetime):
    with open(STATE_FILE, 'w') as f:
        json.dump({"last_window_end_utc": window_end.isoformat()}, f, indent=2)


def map_category(label_ids: list) -> str:
    for label in label_ids:
        if label == "CATEGORY_PROMOTIONS":
            return "promotions"
        if label == "CATEGORY_PERSONAL":
            return "personal"
        if label == "CATEGORY_UPDATES":
            return "updates"
        if label == "CATEGORY_SOCIAL":
            return "social"
        if label == "CATEGORY_FORUMS":
            return "forums"
    return "unknown"


def fetch_headers():
    sys.path.insert(0, SCRIPT_DIR)
    from auth import get_gmail_service

    try:
        service = get_gmail_service()
    except RuntimeError as e:
        _fetch_failed("auth", str(e))
    except Exception as e:
        error_str = str(e).lower()
        tb = traceback.format_exc().lower()
        if any(k in tb for k in ("socket", "ssl", "urllib3", "requests", "connection", "timeout", "gaierror")):
            _fetch_failed("network", str(e))
        elif "auth" in error_str or "token" in error_str or "credential" in error_str:
            _fetch_failed("auth", str(e))
        else:
            _fetch_failed("unknown", str(e))

    window_start = load_state()
    now = datetime.now(timezone.utc)
    window_end = next_slot_after(window_start)

    if window_end > now:
        # Slot hasn't occurred yet — nothing to fetch, don't advance state
        result = {
            "window": "not yet due",
            "total_count": 0,
            "listed_count": 0,
            "emails": []
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    start_epoch = int(window_start.timestamp())
    end_epoch = int(window_end.timestamp())

    # Format IST times for display
    ist = timezone(timedelta(hours=5, minutes=30))
    start_ist = window_start.astimezone(ist)
    end_ist = window_end.astimezone(ist)
    window_label = f"{start_ist.strftime('%d %b %Y %H:%M')} – {end_ist.strftime('%d %b %Y %H:%M')} IST"

    # Fetch ALL emails in window — no inbox restriction, no category filter
    query = f"after:{start_epoch} before:{end_epoch}"
    all_messages = []
    page_token = None
    while True:
        kwargs = {"userId": "me", "q": query, "maxResults": 500}
        if page_token:
            kwargs["pageToken"] = page_token
        response = service.users().messages().list(**kwargs).execute()
        messages = response.get("messages", [])
        all_messages.extend(messages)
        page_token = response.get("nextPageToken")
        if not page_token:
            break

    if not all_messages:
        result = {
            "window": window_label,
            "total_count": 0,
            "listed_count": 0,
            "emails": []
        }
        save_state(window_end)
        # Clean up any stale failure marker on success
        if os.path.exists(FETCH_FAILED_FILE):
            try: os.remove(FETCH_FAILED_FILE)
            except OSError: pass
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return
    emails = []
    failed_ids = []

    def make_callback(msg_id):
        def callback(request_id, response, exception):
            if exception:
                print(f"[WARN] Batch failed for {msg_id}: {exception}", file=sys.stderr)
                failed_ids.append(msg_id)
                return
            headers = {h["name"]: h["value"] for h in response.get("payload", {}).get("headers", [])}
            label_ids = response.get("labelIds", [])
            emails.append({
                "id": response["id"],
                "from": headers.get("From", ""),
                "to": headers.get("To", ""),
                "subject": headers.get("Subject", "(no subject)"),
                "date": headers.get("Date", ""),
                "snippet": response.get("snippet", ""),
                "gmail_category": map_category(label_ids),
                "in_inbox": "INBOX" in label_ids,
                "is_unread": "UNREAD" in label_ids,
            })
        return callback

    BATCH_SIZE = 25
    for i in range(0, len(all_messages), BATCH_SIZE):
        if i > 0:
            time.sleep(2)
        batch = service.new_batch_http_request()
        for msg in all_messages[i:i + BATCH_SIZE]:
            msg_id = msg["id"]
            batch.add(
                service.users().messages().get(
                    userId="me",
                    id=msg_id,
                    format="metadata",
                    metadataHeaders=["From", "To", "Subject", "Date"]
                ),
                callback=make_callback(msg_id)
            )
        batch.execute()

    # Retry individually any IDs that failed in the batch (handles transient 429s)
    # Use exponential backoff with multiple retry attempts
    if failed_ids:
        print(f"[INFO] Retrying {len(failed_ids)} failed messages with exponential backoff...", file=sys.stderr)
        time.sleep(3)
        still_failed = []

        for msg_id in failed_ids:
            # Exponential backoff: try 3 times with increasing delays
            fetched = False
            for attempt in range(3):
                try:
                    delay = (2 ** attempt) * 1.0  # 0s, 2s, 4s (first retry immediate)
                    if attempt > 0:
                        print(f"[RETRY] {msg_id} attempt {attempt + 1}/3 (waiting {delay}s)...", file=sys.stderr)
                        time.sleep(delay)
                    response = service.users().messages().get(
                        userId="me", id=msg_id, format="metadata",
                        metadataHeaders=["From", "To", "Subject", "Date"]
                    ).execute()
                    headers = {h["name"]: h["value"] for h in response.get("payload", {}).get("headers", [])}
                    label_ids = response.get("labelIds", [])
                    emails.append({
                        "id": response["id"],
                        "from": headers.get("From", ""),
                        "to": headers.get("To", ""),
                        "subject": headers.get("Subject", "(no subject)"),
                        "date": headers.get("Date", ""),
                        "snippet": response.get("snippet", ""),
                        "gmail_category": map_category(label_ids),
                        "in_inbox": "INBOX" in label_ids,
                        "is_unread": "UNREAD" in label_ids,
                    })
                    # Small delay between successful individual requests
                    time.sleep(0.5)
                    fetched = True
                    break
                except Exception as e:
                    error_str = str(e).lower()
                    if "429" in error_str or "quota" in error_str or "rate limit" in error_str:
                        if attempt == 2:  # Last attempt
                            print(f"[ERROR] All retries exhausted for {msg_id}: {e}", file=sys.stderr)
                        # Otherwise continue to next attempt
                        continue
                    else:
                        # Non-429 error, don't retry
                        print(f"[ERROR] Non-retryable error for {msg_id}: {e}", file=sys.stderr)
                        break
            if not fetched:
                still_failed.append(msg_id)

        if still_failed:
            print(f"[ERROR] {len(still_failed)} messages permanently failed and will be missing from this brief.", file=sys.stderr)

    save_state(window_end)
    # Clean up any stale failure marker on success
    if os.path.exists(FETCH_FAILED_FILE):
        try: os.remove(FETCH_FAILED_FILE)
        except OSError: pass

    result = {
        "window": window_label,
        "listed_count": len(all_messages),
        "total_count": len(emails),
        "emails": emails,
    }
    
    # Save to emails.json in project root for downstream scripts (e.g. send_telegram.py assertion)
    emails_path = os.path.join(PROJECT_ROOT, "emails.json")
    try:
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[WARN] Failed to write emails.json: {e}", file=sys.stderr)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    fetch_headers()
