"""
Fetch full text content for specific message IDs.
Usage: python fetch_bodies.py id1 id2 id3 ...
"""
import base64
import json
import os
import re
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout = open(sys.stdout.fileno(), mode='w', encoding='utf-8', buffering=1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BODY_TRUNCATE = 10000


def extract_text(payload: dict) -> str:
    """Recursively extract plain text from MIME payload."""
    mime_type = payload.get("mimeType", "")
    body = payload.get("body", {})
    data = body.get("data", "")

    if mime_type == "text/plain" and data:
        return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")

    if mime_type == "text/html" and data:
        html = base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
        # Strip tags, collapse whitespace
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    # Walk parts — prefer text/plain parts first
    parts = payload.get("parts", [])
    plain = next((extract_text(p) for p in parts if p.get("mimeType") == "text/plain"), None)
    if plain:
        return plain
    html = next((extract_text(p) for p in parts if p.get("mimeType") == "text/html"), None)
    if html:
        return html
    # Recurse into multipart
    for part in parts:
        result = extract_text(part)
        if result:
            return result
    return ""


def fetch_bodies():
    msg_ids = sys.argv[1:]
    if not msg_ids:
        print("Usage: python fetch_bodies.py id1 id2 ...", file=sys.stderr)
        sys.exit(1)

    sys.path.insert(0, SCRIPT_DIR)
    from auth import get_gmail_service

    service = get_gmail_service()
    results = []

    def make_callback(msg_id):
        def callback(request_id, response, exception):
            if exception:
                print(f"[WARN] Failed to fetch {msg_id}: {exception}", file=sys.stderr)
                return
            headers = {h["name"]: h["value"] for h in response.get("payload", {}).get("headers", [])}
            text = extract_text(response.get("payload", {}))
            truncated = text[:BODY_TRUNCATE] + ("..." if len(text) > BODY_TRUNCATE else "")
            results.append({
                "id": response["id"],
                "subject": headers.get("Subject", "(no subject)"),
                "from": headers.get("From", ""),
                "body_text": truncated,
            })
        return callback

    BATCH_SIZE = 100
    for i in range(0, len(msg_ids), BATCH_SIZE):
        batch = service.new_batch_http_request()
        for msg_id in msg_ids[i:i + BATCH_SIZE]:
            batch.add(
                service.users().messages().get(userId="me", id=msg_id, format="full"),
                callback=make_callback(msg_id)
            )
        batch.execute()

    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    fetch_bodies()
