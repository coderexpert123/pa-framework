"""Fetch email headers for the single slot immediately preceding the current time."""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

from runtime_state import clear_failure_marker, load_last_window_end, write_failure_marker

# Force UTF-8 output on Windows
if sys.stdout.encoding != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)


def _dedup_key_for_status(status: str) -> str:
    return "daily-mail-brief-auth" if status == "auth" else "daily-mail-brief-fetch"


def _fetch_failed(status: str, reason: str):
    """Write the failure marker, alert pa-support, and exit."""
    write_failure_marker(status, reason)
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


def get_current_window_end(now: datetime) -> datetime:
    """Return the slot boundary immediately preceding now."""
    dt = now.replace(second=0, microsecond=0)
    # Check today's slots in reverse
    for h, m in reversed(DAILY_SLOTS_UTC):
        candidate = dt.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate <= dt:
            return candidate
    # Wrap to yesterday's last slot
    prev_day = dt - timedelta(days=1)
    h, m = DAILY_SLOTS_UTC[-1]
    return prev_day.replace(hour=h, minute=m)


def get_prev_slot_before(dt: datetime) -> datetime:
    """Return the slot boundary immediately preceding dt."""
    for h, m in reversed(DAILY_SLOTS_UTC):
        candidate = dt.replace(hour=h, minute=m, second=0, microsecond=0)
        if candidate < dt:
            return candidate
    prev_day = dt - timedelta(days=1)
    h, m = DAILY_SLOTS_UTC[-1]
    return prev_day.replace(hour=h, minute=m, second=0, microsecond=0)


def resolve_window(now: datetime, last_processed: datetime | None, force: bool = False):
    """Resolve the single slot this run is responsible for."""
    if last_processed is not None and last_processed > now:
        last_processed = None
    window_end = get_current_window_end(now)
    window_start = get_prev_slot_before(window_end)
    already_processed = bool(
        not force and last_processed is not None and last_processed >= window_end
    )
    return window_start, window_end, already_processed


def format_window_label(window_start: datetime, window_end: datetime) -> str:
    ist = timezone(timedelta(hours=5, minutes=30))
    start_ist = window_start.astimezone(ist)
    end_ist = window_end.astimezone(ist)
    return f"{start_ist.strftime('%d %b %Y %H:%M')} – {end_ist.strftime('%d %b %Y %H:%M')} IST"


def write_emails_json(payload: dict) -> None:
    emails_path = os.path.join(PROJECT_ROOT, "emails.json")
    try:
        with open(emails_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[WARN] Failed to write emails.json: {e}", file=sys.stderr)


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
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="Ignore state.json and run current window")
    parser.add_argument("--jump", action="store_true", help="Deprecated compatibility flag; ignored")
    args, _ = parser.parse_known_args()

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

    now = datetime.now(timezone.utc)
    last_processed = load_last_window_end()
    window_start, window_end, already_processed = resolve_window(now, last_processed, args.force)
    window_label = format_window_label(window_start, window_end)

    if already_processed:
        result = {
            "status": "already_processed",
            "window": window_label,
            "last_processed_utc": last_processed.isoformat() if last_processed else None,
            "window_start_utc": window_start.isoformat(),
            "window_end_utc": window_end.isoformat(),
            "total_count": 0,
            "listed_count": 0,
            "emails": [],
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    start_epoch = int(window_start.timestamp())
    end_epoch = int(window_end.timestamp())

    try:
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

        batch_size = 25
        for i in range(0, len(all_messages), batch_size):
            if i > 0:
                time.sleep(2)
            batch = service.new_batch_http_request()
            for msg in all_messages[i:i + batch_size]:
                msg_id = msg["id"]
                batch.add(
                    service.users().messages().get(
                        userId="me",
                        id=msg_id,
                        format="metadata",
                        metadataHeaders=["From", "To", "Subject", "Date"],
                    ),
                    callback=make_callback(msg_id),
                )
            batch.execute()

        if failed_ids:
            print(
                f"[INFO] Retrying {len(failed_ids)} failed messages with exponential backoff...",
                file=sys.stderr,
            )
            time.sleep(3)
            still_failed = []

            for msg_id in failed_ids:
                fetched = False
                for attempt in range(3):
                    try:
                        delay = (2 ** attempt) * 1.0
                        if attempt > 0:
                            print(
                                f"[RETRY] {msg_id} attempt {attempt + 1}/3 (waiting {delay}s)...",
                                file=sys.stderr,
                            )
                            time.sleep(delay)
                        response = service.users().messages().get(
                            userId="me",
                            id=msg_id,
                            format="metadata",
                            metadataHeaders=["From", "To", "Subject", "Date"],
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
                        time.sleep(0.5)
                        fetched = True
                        break
                    except Exception as e:
                        error_str = str(e).lower()
                        if "429" in error_str or "quota" in error_str or "rate limit" in error_str:
                            if attempt == 2:
                                print(f"[ERROR] All retries exhausted for {msg_id}: {e}", file=sys.stderr)
                            continue
                        print(f"[ERROR] Non-retryable error for {msg_id}: {e}", file=sys.stderr)
                        break
                if not fetched:
                    still_failed.append(msg_id)

            if still_failed:
                print(
                    f"[ERROR] {len(still_failed)} messages permanently failed and will be missing from this brief.",
                    file=sys.stderr,
                )
    except Exception as e:
        error_str = str(e).lower()
        tb = traceback.format_exc().lower()
        if any(k in tb for k in ("socket", "ssl", "urllib3", "requests", "connection", "timeout", "gaierror")):
            _fetch_failed("network", str(e))
        elif "auth" in error_str or "token" in error_str or "credential" in error_str:
            _fetch_failed("auth", str(e))
        else:
            _fetch_failed("api", str(e))

    result = {
        "status": "ok",
        "window": window_label,
        "window_start_utc": window_start.isoformat(),
        "window_end_utc": window_end.isoformat(),
        "last_processed_utc": last_processed.isoformat() if last_processed else None,
        "listed_count": len(all_messages),
        "total_count": len(emails),
        "emails": emails,
    }

    clear_failure_marker()
    write_emails_json(result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    fetch_headers()
