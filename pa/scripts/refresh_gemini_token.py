"""
Headless Gemini OAuth token refresh.

Usage:
  python refresh_gemini_token.py                   — refresh if expired (pre-run)
  python refresh_gemini_token.py --restore-refresh-token — re-add refresh_token if
      stripped by the CLI's internal cacheCredentials (post-run guard)

Gemini CLI v0.47.0 bug: when it internally refreshes an expired token, it writes
the refresh response back to oauth_creds.json WITHOUT the refresh_token (Google's
refresh endpoint doesn't return it). This strips the refresh_token, making the
next expiry unrecoverable headlessly. Both modes guard against this.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CREDS_PATH = os.path.expanduser("~/.gemini/oauth_creds.json")
TOKEN_URL = "https://oauth2.googleapis.com/token"
BUFFER_SECS = 120  # refresh if expiring within 2 min
STASH_PATH = CREDS_PATH + ".refresh_token_stash"


# Task-Scheduler-invoked scripts don't inherit the bot's environment — must be
# self-contained (see projects/coding-dirs-updater/update_coding_dirs.py, the
# reference implementation for this pattern).
def _pa_home():
    return os.environ.get("PA_HOME") or os.path.expanduser("~/.pa")


_SECRETS_CACHE = None


def _load_secrets():
    path = os.path.join(_pa_home(), "secrets.env")
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                out[key.strip()] = val.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return out


def _secret(key):
    global _SECRETS_CACHE
    if key in os.environ:
        return os.environ[key]
    if _SECRETS_CACHE is None:
        _SECRETS_CACHE = _load_secrets()
    if key in _SECRETS_CACHE:
        return _SECRETS_CACHE[key]
    raise RuntimeError(f"{key} not set in environment or ~/.pa/secrets.env")


def _client_id():
    return _secret("GEMINI_OAUTH_CLIENT_ID")


def _client_secret():
    return _secret("GEMINI_OAUTH_CLIENT_SECRET")


def load_creds():
    with open(CREDS_PATH) as f:
        return json.load(f)


def save_creds(creds):
    with open(CREDS_PATH, "w") as f:
        json.dump(creds, f, indent=2)


def pre_run():
    """Refresh token if expired. Also stash refresh_token so post_run can restore it."""
    if not os.path.exists(CREDS_PATH):
        return

    creds = load_creds()
    refresh_token = creds.get("refresh_token")

    # Stash refresh_token for post-run restore, even if we don't refresh now
    if refresh_token:
        with open(STASH_PATH, "w") as f:
            f.write(refresh_token)

    expiry_ms = creds.get("expiry_date", 0)
    now_ms = int(time.time() * 1000)
    if expiry_ms - now_ms > BUFFER_SECS * 1000:
        return  # token still fresh

    if not refresh_token:
        print("[gemini-refresh] No refresh_token in creds, skipping", file=sys.stderr)
        sys.exit(1)

    _do_refresh(creds, refresh_token)


def post_run():
    """Restore refresh_token if the CLI stripped it (v0.47.0 bug).

    The stash file is intentionally persistent (never deleted). Pre_run always
    updates it with the current refresh_token before each gemini invocation, so
    it stays current. Not deleting it eliminates a race condition where two
    concurrent gemini processes could have the first post_run delete the stash
    before the second can use it.
    """
    if not os.path.exists(STASH_PATH) or not os.path.exists(CREDS_PATH):
        return

    with open(STASH_PATH) as f:
        stashed = f.read().strip()

    if not stashed:
        return

    try:
        creds = load_creds()
    except Exception as e:
        print(f"[gemini-refresh] Could not read creds for restore: {e}", file=sys.stderr)
        return

    if not creds.get("refresh_token"):
        creds["refresh_token"] = stashed
        save_creds(creds)
        print("[gemini-refresh] Restored stripped refresh_token", file=sys.stderr)


def _do_refresh(creds, refresh_token):
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": _client_id(),
        "client_secret": _client_secret(),
    }).encode()

    req = urllib.request.Request(TOKEN_URL, data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"[gemini-refresh] HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"[gemini-refresh] Request failed: {e}", file=sys.stderr)
        sys.exit(1)

    creds["access_token"] = data["access_token"]
    creds["expiry_date"] = int(time.time() * 1000) + data.get("expires_in", 3600) * 1000
    if "id_token" in data:
        creds["id_token"] = data["id_token"]
    # Keep refresh_token — not returned by refresh endpoint

    save_creds(creds)
    print(f"[gemini-refresh] Refreshed, expires in {data.get('expires_in', 3600)}s", file=sys.stderr)


if __name__ == "__main__":
    if "--restore-refresh-token" in sys.argv:
        post_run()
    else:
        pre_run()
