"""
Shared Telegram sender for all PA skills and scripts.

Public API:
  send_text(text, chat_id=None, thread_id=None)      → ref_id
  send_document(file_path, chat_id=None, thread_id=None) → ref_id
  notify(message, chat_id=None, thread_id=None, *, reply_markup=None) → ref_id

All three:
  - Mint a unique s-XXXX ref ID
  - Append it to the outgoing message (text in body / document as caption)
  - Log to ~/.pa/app.log.jsonl with messageId for pa-ref deep links
  - Route DIRECT-FIRST, falling back to the SOCKS5 proxy pool on connect failure
  - Fall back to plain text on Markdown parse failures

When chat_id / thread_id are None, they are resolved from environment variables:
  TELEGRAM_BOT_TOKEN           (always required)
  TELEGRAM_BRIEFING_CHAT_ID    (preferred chat; may be comma-separated)
  TELEGRAM_CHAT_ID             (fallback chat; may be comma-separated)
  TELEGRAM_DAILY_BRIEFING_THREAD_ID  (optional thread for supergroups)
"""

import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timezone

import requests


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _pa_home() -> str:
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def _log_skill_message_sent(
    ref_id: str,
    chat_id: str,
    thread_id,
    chunk_index: int,
    text_preview: str,
    message_id=None,
) -> None:
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
    if message_id is not None:
        entry["messageId"] = message_id
    try:
        with open(os.path.join(_pa_home(), "app.log.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass  # log failures must never crash delivery


def _normalize_socks(u: str):
    u = (u or "").strip()
    if not u:
        return None
    if u.startswith("socks5h://"):
        return u
    if u.startswith("socks5://"):
        return "socks5h://" + u[len("socks5://"):]
    m = re.match(r"^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$", u)
    if m:
        return f"socks5h://{m.group(1)}:{m.group(2)}"
    return None


def _load_proxy_pool() -> list:
    proxies: list = []
    for part in os.environ.get("TELEGRAM_PROXY_URLS", "").split(","):
        n = _normalize_socks(part)
        if n and n not in proxies:
            proxies.append(n)
    try:
        with open(os.path.join(_pa_home(), "telegram-proxies.json"), encoding="utf-8") as f:
            for u in json.load(f).get("healthy", []):
                n = _normalize_socks(u)
                if n and n not in proxies:
                    proxies.append(n)
    except Exception:
        pass
    return proxies


def _redact(s) -> str:
    """requests/urllib3 exception text embeds the full request path, including
    /bot<TOKEN>/... — never print/log it raw (CLAUDE.md guardrail: secrets
    kept out of logs; worker stderr is persisted to app.log.jsonl)."""
    return re.sub(r"/bot[^/\s]+", "/bot<redacted>", str(s))


def _is_connect_stage(e) -> bool:
    """True only when the request provably never reached Telegram, so a
    re-send through another route cannot double-deliver. ProxyError and
    ConnectTimeout are always pre-transmission, and so are DNS-resolution
    failures (no TCP connection ever exists — and DNS poisoning was the
    documented mechanism of the India block, which socks5h proxy-side
    resolution exists to bypass; parity with telegram-proxy.ts's
    ENOTFOUND/EAI_AGAIN classification). requests.ConnectionError is
    OVERBROAD — it also wraps resets AFTER the body was transmitted
    ('Connection aborted', ProtocolError mid-response), exactly the ambiguous
    class the TS counterpart refuses to fail over on (effectively-once: err
    toward a lost message, never a duplicate) — so only the
    failed-to-establish / failed-to-resolve flavors count."""
    from requests.exceptions import ConnectTimeout, ProxyError
    from requests.exceptions import ConnectionError as ReqConnectionError

    if isinstance(e, (ProxyError, ConnectTimeout)):
        return True
    if isinstance(e, ReqConnectionError):
        # Prefer the typed check on the wrapped urllib3 reason:
        # NameResolutionError subclasses NewConnectionError, so one
        # isinstance covers both connect-refused and DNS flavors. Guarded so
        # a future urllib3 rename degrades to the string fallback instead of
        # crashing the alert path.
        try:
            from urllib3.exceptions import NewConnectionError
            reason = getattr(e.args[0], "reason", None) if e.args else None
            if isinstance(reason, NewConnectionError):
                return True
        except (ImportError, IndexError, AttributeError):
            pass
        text = str(e)
        return ("Failed to establish a new connection" in text
                or "NewConnectionError" in text
                or "NameResolutionError" in text
                or "Failed to resolve" in text)
    return False


def _post(url: str, payload: dict, timeout: int = 20):
    """JSON POST — DIRECT-FIRST, with SOCKS5 proxy-pool fallback.

    Mirrors the TypeScript telegram-proxy module's ordering (CLAUDE.md
    "Telegram API routing (DIRECT-FIRST)"): try the direct connection first;
    only on a connect-stage failure (see _is_connect_stage — the request
    never reached Telegram) iterate the proxy pool. Ambiguous failures
    (ReadTimeout, post-transmission resets) are never retried. The pool file
    can hold stale entries indefinitely (the TS auto-refresh only maintains
    it while direct is down), so proxy-first ordering would stall every
    skill send behind dead public proxies.
    """
    session = requests.Session()
    session.trust_env = False
    direct_err = None
    try:
        return session.post(url, json=payload, timeout=timeout)
    except Exception as e:
        if not _is_connect_stage(e):
            raise
        direct_err = e
        # Parity with telegram-proxy.ts:495 — the only forensic signal on a
        # fire-and-forget alert path that the direct block has returned.
        print(f"[Telegram] direct route blocked ({_redact(direct_err)}); falling back to proxy pool", file=sys.stderr)
    pool = _load_proxy_pool()
    for i, p in enumerate(pool):
        try:
            return session.post(url, json=payload, timeout=timeout,
                                proxies={"http": p, "https": p})
        except Exception as e:
            if not _is_connect_stage(e):
                raise
            if i == len(pool) - 1:
                # Pool exhausted — name BOTH failures, not just the last
                # random public proxy's (the except-bound name is cleared at
                # block exit, so direct_err carries the direct failure).
                print(f"[Telegram] all {len(pool)} proxies failed; direct also blocked ({_redact(direct_err)})", file=sys.stderr)
                raise
            continue
    # Empty pool: re-attempt direct so the caller gets a real exception/response.
    return session.post(url, json=payload, timeout=timeout)


def _post_multipart(url: str, data: dict, files: dict, timeout: int = 60):
    """Multipart POST (file uploads) — DIRECT-FIRST, proxy-pool fallback.

    Same ordering + connect-stage rationale as _post(). File handles in
    `files` are consumed when requests prepares the body, so retries must
    re-read the content: buffer each file's bytes up front and hand every
    attempt a fresh dict.
    """
    session = requests.Session()
    session.trust_env = False

    # Materialize file contents once so every attempt sends the full body
    # (a consumed handle on attempt 2+ would silently upload an empty file).
    # Preserve the upload FILENAME via (name, bytes) tuples: raw bytes would
    # make requests fall back to the field name (filename="document"),
    # renaming every uploaded file.
    buffered = {}
    for field, fh in files.items():
        if hasattr(fh, "read"):
            fname = os.path.basename(getattr(fh, "name", field) or field)
            buffered[field] = (fname, fh.read())
        elif isinstance(fh, tuple):
            buffered[field] = fh  # already (filename, content[, ...])
        else:
            buffered[field] = (field, fh)

    def fresh_files():
        return dict(buffered)

    direct_err = None
    try:
        return session.post(url, data=data, files=fresh_files(), timeout=timeout)
    except Exception as e:
        if not _is_connect_stage(e):
            raise
        direct_err = e
        print(f"[Telegram] direct route blocked ({_redact(direct_err)}); falling back to proxy pool", file=sys.stderr)
    pool = _load_proxy_pool()
    for i, p in enumerate(pool):
        try:
            return session.post(url, data=data, files=fresh_files(), timeout=timeout,
                                proxies={"http": p, "https": p})
        except Exception as e:
            if not _is_connect_stage(e):
                raise
            if i == len(pool) - 1:
                print(f"[Telegram] all {len(pool)} proxies failed; direct also blocked ({_redact(direct_err)})", file=sys.stderr)
                raise
            continue
    return session.post(url, data=data, files=fresh_files(), timeout=timeout)


def _resolve_routing(chat_id=None, thread_id=None):
    """Return (token, chat_ids_list, thread_id_str_or_None) from params or env.

    Privacy invariant: when chat_id is resolved from environment variables
    (i.e. the caller did NOT pass an explicit chat_id), DM chats (positive IDs)
    are silently excluded. Only group/supergroup chats (negative IDs) are
    reachable by default. To send a DM you must pass chat_id explicitly.
    """
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN must be set")

    if chat_id is None:
        raw = os.environ.get("TELEGRAM_BRIEFING_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID", "")
        all_ids = [c.strip() for c in raw.split(",") if c.strip()]
        # Strip DM chats — default routing never reaches personal inboxes.
        chat_ids = [c for c in all_ids if c.startswith("-")]
        if not chat_ids:
            raise RuntimeError(
                "No group/supergroup chat ID found for default routing "
                "(TELEGRAM_BRIEFING_CHAT_ID / TELEGRAM_CHAT_ID must contain a negative ID)"
            )
    else:
        raw = str(chat_id)
        chat_ids = [c.strip() for c in raw.split(",") if c.strip()]

    if thread_id is None:
        thread_id_str = os.environ.get("TELEGRAM_DAILY_BRIEFING_THREAD_ID") or None
    else:
        thread_id_str = str(thread_id) if thread_id else None

    return token, chat_ids, thread_id_str


def _gfm_to_telegram_markdown(text: str) -> str:
    """Convert the GitHub-flavored Markdown PA skills write (headers, **bold**,
    ~~strikethrough~~) into Telegram's legacy Markdown, which send_text's
    parse_mode="Markdown" actually speaks: only *bold*, _italic_, `code`,
    ```pre```, and [text](url) — no headers, no double-star bold, no
    strikethrough. Sending raw GFM through legacy parse_mode renders `#`/`##`
    as literal hashes and drops/garbles `**bold**` (2026-07-27 incident: the
    daily-briefing skill's GFM output went out unconverted).
    """
    # Headers "# H" / "## H" / "### H" -> bold (legacy has no header syntax).
    # Placeholder, not a literal "*", so the italic pass below doesn't re-touch it.
    text = re.sub(r"(?m)^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", "\x00\\1\x00", text)
    # Protect GFM **bold** behind the same placeholder before the italic pass
    # touches the single stars inside it.
    text = re.sub(r"\*\*(\S(?:.*?\S)?)\*\*", "\x00\\1\x00", text)
    # Remaining single-star spans are GFM italic -> legacy italic is _text_.
    text = re.sub(r"(?<!\*)\*(\S(?:.*?\S)?)\*(?!\*)", r"_\1_", text)
    # Restore protected bold as legacy's single-star bold.
    text = text.replace("\x00", "*")
    # No legacy equivalent for strikethrough — drop the markers, keep the text.
    text = re.sub(r"~~(.+?)~~", r"\1", text)
    return text


def _retry_after_seconds(resp) -> int | None:
    """Parse Telegram 429 retry_after from response, defensively.

    Returns None if any parse fails; caps the returned sleep at 60 seconds.
    AI-149: pii-audit 2026-08-09 showed 429s with retry_after 3..32 being
    treated as generic failures, causing whole skill runs to abort.
    """
    try:
        body = resp.json()
        if not isinstance(body, dict):
            return None
        parameters = body.get("parameters")
        if not isinstance(parameters, dict):
            return None
        retry_after = parameters.get("retry_after")
        if not isinstance(retry_after, (int, float)):
            return None
        # Cap at 60 seconds to avoid extreme waits from malformed responses
        return min(60, int(retry_after))
    except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
        return None


def _send_with_429_retry(send_fn, max_attempts: int = 4):
    """Shared helper for retrying a send function on 429 responses.

    The send_fn is a callable that returns a requests.Response.
    On 429, sleeps per retry_after (or 2s default) and retries up to max_attempts.
    Non-429 responses return immediately.

    AI-149: used by both send_text (_post) and send_document (_post_multipart)
    to honor Telegram rate limits without aborting skill runs.
    """
    for attempt in range(max_attempts):
        resp = send_fn()
        if resp.status_code == 200:
            return resp
        if resp.status_code == 429:
            retry_after = _retry_after_seconds(resp)
            if retry_after is not None:
                print(f"[Telegram] 429 rate limit, retry_after={retry_after}s, sleeping {retry_after + 1}s before attempt {attempt + 2}/{max_attempts}", file=sys.stderr)
                time.sleep(retry_after + 1)
            else:
                print(f"[Telegram] 429 without parseable retry_after, sleeping 2s before attempt {attempt + 2}/{max_attempts}", file=sys.stderr)
                time.sleep(2)
            # Retry the same operation
            continue
        # Non-429, non-200: no retry, let caller handle
        return resp
    return resp


def _send_payload(url: str, payload: dict, max_attempts: int = 4):
    """Send a JSON payload with up to 4 total attempts, honoring 429 retry_after.

    On a 429 response, if retry_after is parseable, sleep that many +1 seconds
    and retry the SAME payload (no plain-text fallback on rate limits — the
    fallback is for Markdown parse errors only, not server-side throttling).
    If retry_after is missing/invalid, sleep 2s before retrying.

    After all attempts are exhausted, returns the last response (falling
    through to the caller's error handling).

    AI-149: replaces bare _post call in send_text's inner loop to properly
    handle Telegram rate limits without aborting the entire skill run.
    """
    return _send_with_429_retry(lambda: _post(url, payload), max_attempts)


def _split_message(text: str, max_len: int = 4000) -> list:
    """Split text at paragraph boundaries to stay within Telegram's message limit."""
    if len(text) <= max_len:
        return [text]
    parts = []
    while len(text) > max_len:
        cut = text.rfind("\n\n", 0, max_len)
        if cut == -1:
            cut = text.rfind("\n", 0, max_len)
        if cut == -1:
            cut = max_len
        parts.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        parts.append(text)
    return parts


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def send_text(text: str, chat_id=None, thread_id=None, *, parse_mode: str | None = "Markdown",
              reply_markup: dict | None = None) -> str:
    """Send text to Telegram, splitting into multiple messages if needed.

    parse_mode: defaults to "Markdown" (unchanged behavior for every existing
    caller). Pass parse_mode=None for plain text with no markdown parsing at
    all — required for content like a Google OAuth consent URL, where
    underscores and parentheses are exactly what Telegram's legacy Markdown
    parser mangles (memory 2026-08-15). When None, the "parse_mode" key is
    omitted from the payload entirely and the ref trailer uses the same
    unescaped "Ref: <id>" form the Markdown-parse-error fallback below uses.

    reply_markup: optional Telegram InlineKeyboardMarkup dict (e.g.
    {"inline_keyboard": [[{"text": ..., "callback_data": ...}]]}). Telegram
    allows one keyboard per message, so it is attached to the LAST part's
    sendMessage payload only (the payload is posted via requests' json=
    kwarg, which serializes the nested dict, so no manual json.dumps is
    needed). Default None = byte-identical behavior for every existing
    caller.

    Returns the ref_id minted for this send. Exits on fatal failure.
    """
    token, chat_ids, thread_id_str = _resolve_routing(chat_id, thread_id)
    ref_id = f"s-{secrets.token_hex(6)}"
    base_url = f"https://api.telegram.org/bot{token}"
    parts = _split_message(_gfm_to_telegram_markdown(text))
    parts[-1] = f"{parts[-1]}\n\n_Ref: {ref_id}_"
    if parse_mode is None:
        parts[-1] = parts[-1].replace(f"\n\n_Ref: {ref_id}_", f"\n\nRef: {ref_id}")
    any_failed = False

    for cid in chat_ids:
        use_thread_id = int(thread_id_str) if thread_id_str and cid.startswith("-100") else None

        for i, part in enumerate(parts):
            payload = {"chat_id": cid, "text": part}
            if parse_mode is not None:
                payload["parse_mode"] = parse_mode
            if use_thread_id is not None:
                payload["message_thread_id"] = use_thread_id
            if reply_markup is not None and i == len(parts) - 1:
                payload["reply_markup"] = reply_markup

            try:
                resp = _send_payload(f"{base_url}/sendMessage", payload)
                if resp.status_code == 200:
                    msg_id = resp.json().get("result", {}).get("message_id")
                    print(f"[Telegram] {cid} Part {i + 1}/{len(parts)} sent OK (ref={ref_id})")
                    _log_skill_message_sent(ref_id, cid, use_thread_id, i, part, msg_id)
                elif resp.status_code == 429:
                    # 429 after exhausting retries: rate limit won't be solved by plain text
                    print(f"[Telegram] ERROR: {cid} Part {i + 1}/{len(parts)} failed after 4 attempts: rate limit (429)", file=sys.stderr)
                    any_failed = True
                else:
                    # Markdown parse error or other non-429 failure: try plain-text fallback once
                    plain = part.replace(f"\n\n_Ref: {ref_id}_", f"\n\nRef: {ref_id}")
                    fallback = {"chat_id": cid, "text": plain}
                    if use_thread_id is not None:
                        fallback["message_thread_id"] = use_thread_id
                    # The keyboard rides the fallback too — the TypeScript twin carries
                    # reply_markup into its plain-text fallback deliberately
                    # (pa/src/telegram.ts, 2026-08-24 buttons program P3): Markdown parse
                    # failures are common with LLM output, so dropping the keyboard here
                    # silently lost it exactly when it mattered (Wave-1 WP-C, 2026-09-02).
                    # Same last-part-only condition as the primary payload above.
                    if reply_markup is not None and i == len(parts) - 1:
                        fallback["reply_markup"] = reply_markup
                    resp2 = _post(f"{base_url}/sendMessage", fallback)
                    if resp2.status_code == 200:
                        msg_id = resp2.json().get("result", {}).get("message_id")
                        print(f"[Telegram] {cid} Part {i + 1}/{len(parts)} sent (plain fallback) OK (ref={ref_id})")
                        _log_skill_message_sent(ref_id, cid, use_thread_id, i, plain, msg_id)
                    else:
                        print(f"[Telegram] ERROR: {cid} Part {i + 1}/{len(parts)} failed: {resp2.status_code} {resp2.text}", file=sys.stderr)
                        any_failed = True
            except Exception as e:
                print(f"[Telegram] Error sending to {cid} part {i + 1}: {_redact(e)}", file=sys.stderr)
                any_failed = True

    if any_failed:
        sys.exit(1)
    return ref_id


def send_document(file_path: str, chat_id=None, thread_id=None) -> str:
    """Upload a file to Telegram with a ref ID caption.

    Returns the ref_id minted for this send. Exits on fatal failure.
    """
    token, chat_ids, thread_id_str = _resolve_routing(chat_id, thread_id)
    ref_id = f"s-{secrets.token_hex(6)}"
    url = f"https://api.telegram.org/bot{token}/sendDocument"
    fname = os.path.basename(file_path)
    any_failed = False

    for cid in chat_ids:
        use_thread_id = int(thread_id_str) if thread_id_str and cid.startswith("-100") else None

        try:
            with open(file_path, "rb") as f:
                data = {"chat_id": cid, "caption": f"_Ref: {ref_id}_", "parse_mode": "Markdown"}
                if use_thread_id is not None:
                    data["message_thread_id"] = str(use_thread_id)
                # Use 429-aware retry; _post_multipart already re-buffers file bytes for each attempt
                resp = _send_with_429_retry(lambda: _post_multipart(url, data, {"document": f}))

            if resp.status_code == 200:
                msg_id = resp.json().get("result", {}).get("message_id")
                print(f"[Telegram] {cid} Document '{fname}' sent OK (ref={ref_id})")
                _log_skill_message_sent(ref_id, cid, use_thread_id, 0, f"[document: {fname}]", msg_id)
            else:
                print(f"[Telegram] ERROR: {cid} Document failed: {resp.status_code} {resp.text}", file=sys.stderr)
                any_failed = True
        except Exception as e:
            print(f"[Telegram] Error sending document to {cid}: {_redact(e)}", file=sys.stderr)
            any_failed = True

    if any_failed:
        sys.exit(1)
    return ref_id


def notify(message: str, chat_id=None, thread_id=None, *, reply_markup: dict | None = None) -> str:
    """Send a notification message. Thin wrapper around send_text() for backward compatibility.

    reply_markup: optional Telegram InlineKeyboardMarkup dict, passed through to
    send_text verbatim (attached to the LAST part's payload, and carried into the
    plain-text fallback). Default None = byte-identical behavior for every existing
    caller (Wave-1 WP-C, 2026-09-02).
    """
    return send_text(message, chat_id=chat_id, thread_id=thread_id, reply_markup=reply_markup)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python telegram_notify.py <message>")
        sys.exit(1)
    notify(sys.argv[1])
