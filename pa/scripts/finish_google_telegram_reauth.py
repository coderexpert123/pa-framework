import argparse
import json
import os
import sys
import time
from pathlib import Path

# AI-046: the start script authorizes with include_granted_scopes=true, so
# Google returns the UNION of requested + previously-granted scopes (e.g.
# drive.file, drive.readonly). oauthlib's default strict check treats that
# mismatch as fatal — every 2026-06-15 exchange died with "Scope has changed".
# Relaxing accepts the superset; coverage of the REQUESTED scopes is verified
# explicitly after the exchange instead.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")

from google_auth_oauthlib.flow import Flow

DEFAULT_SCOPES = [
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/photoslibrary.readonly",
]


def pick_pending(all_pending, state, now):
    """Select the pending auth session for this /auth code.

    Expired sessions are ignored; an explicit state must match exactly; with
    no state, the most recently created valid session wins. Returns None when
    nothing usable exists. Extracted for testability.
    """
    valid = [p for p in all_pending if p.get("expires_at", 0) > now]
    if not valid:
        return None
    if state:
        return next((p for p in valid if p.get("state") == state), None)
    return sorted(valid, key=lambda x: x.get("created_at", 0))[-1]


def missing_scopes(requested, granted):
    """Requested scopes absent from the granted set (superset grants are fine)."""
    return sorted(set(requested or []) - set(granted or []))

def main():
    parser = argparse.ArgumentParser(description="Finish Google OAuth flow for Telegram")
    parser.add_argument("--code", required=True, help="Authorization code from Google")
    parser.add_argument("--state", help="OAuth state for CSRF protection")
    parser.add_argument("--secrets-file", help="Path to Google client secrets JSON file")
    parser.add_argument("--state-file", help="Path to store pending authentication state")
    parser.add_argument("--token-file", help="Path to save the resulting Google token JSON")
    args = parser.parse_args()

    # Resolution logic for paths
    pa_home = Path(os.environ.get("PA_HOME", Path.home() / ".pa"))
    secrets_file = Path(args.secrets_file) if args.secrets_file else pa_home / "google-credentials-telegram.json"
    state_file = Path(args.state_file) if args.state_file else pa_home / "google-telegram-auth.json"
    token_file = Path(args.token_file) if args.token_file else pa_home / "google-token.json"

    if not state_file.exists():
        print(json.dumps({"error": f"No pending authentication found (state file missing: {state_file})."}))
        sys.exit(1)

    try:
        all_pending = json.loads(state_file.read_text())
    except Exception as e:
        print(json.dumps({"error": f"Failed to read state file: {e}"}))
        sys.exit(1)

    now = time.time()
    match = pick_pending(all_pending, args.state, now)
    if not match:
        print(json.dumps({"error": "Authentication request expired or not found."}))
        sys.exit(1)

    if not secrets_file.exists():
        print(json.dumps({"error": f"Missing secrets file: {secrets_file}"}))
        sys.exit(1)

    try:
        flow = Flow.from_client_secrets_file(
            str(secrets_file),
            scopes=match.get('scopes', DEFAULT_SCOPES),
            redirect_uri=match['redirect_uri']
        )
        flow.code_verifier = match['code_verifier']

        flow.fetch_token(code=args.code)
        creds = flow.credentials

        # Save token — NEVER overwrite a refreshable credential with a non-refreshable
        # one (2026-08-25 incident: a re-auth without prompt='consent' returned an
        # access token only, this line wrote it unconditionally, and the refresh token
        # was destroyed; Gmail/Drive/Docs then failed until a human noticed).
        new_payload = json.loads(creds.to_json())
        if not new_payload.get('refresh_token'):
            existing_refresh = None
            if token_file.exists():
                try:
                    existing_refresh = json.loads(token_file.read_text()).get('refresh_token')
                except Exception:
                    existing_refresh = None
            if existing_refresh:
                new_payload['refresh_token'] = existing_refresh
            else:
                print(json.dumps({
                    "error": "Google returned no refresh token and none is stored, so the "
                             "saved credential would be unrefreshable. NOT overwriting the "
                             "token file. Revoke this app at "
                             "https://myaccount.google.com/permissions and run /reauth again."
                }))
                return 1

        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(json.dumps(new_payload))

        # Remove used state
        remaining = [p for p in all_pending if p['auth_id'] != match['auth_id']]
        state_file.write_text(json.dumps(remaining, indent=2))

        # A successful exchange resolves any standing "blocked on Google auth"
        # marker (WP-G, AI-147) — the human-gated-blocker-watch scan would
        # otherwise keep alerting on a condition that already self-healed.
        try:
            (pa_home / "google-auth-blocked.json").unlink(missing_ok=True)
        except Exception:
            pass

        # Superset grants are fine (relaxed above); missing REQUESTED scopes are
        # not — surface them so the user knows a permission was declined.
        lost = missing_scopes(match.get("scopes", DEFAULT_SCOPES), creds.scopes)

        print(json.dumps({
            "status": "success",
            "expiry": str(creds.expiry),
            "missing_scopes": lost or None,
            "resume_action": match.get("resume_action"),
            "retry_action": match.get("retry_action"),
            "chat_id": match.get("chat_id"),
            "thread_id": match.get("thread_id")
        }))
    except Exception as e:
        print(json.dumps({"error": f"Token exchange failed: {e}"}))
        sys.exit(1)

if __name__ == "__main__":
    main()
