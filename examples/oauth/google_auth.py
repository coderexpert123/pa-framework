"""
Shared Google OAuth module for all PA projects.

Token:       ~/.pa/google-token.json
Credentials: ~/.pa/google-credentials.json

To re-authenticate (e.g. after revocation):
    python ~/.pa/reauth_google.py

The token covers all scopes used across PA projects:
  drive, gmail.send, gmail.readonly, documents
"""

import os
import time
from pathlib import Path
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

PA_HOME = Path(os.environ.get("PA_HOME", Path.home() / ".pa"))
TOKEN_FILE = PA_HOME / "google-token.json"
CREDENTIALS_FILE = PA_HOME / "google-credentials.json"

ALL_SCOPES = [
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/documents",
]


def get_credentials():
    """Return valid Google credentials, auto-refreshing and saving if needed."""
    creds = None

    if TOKEN_FILE.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), ALL_SCOPES)
        except Exception as e:
            print(f"[google_auth] Failed to load token: {e}", flush=True)

    if creds and creds.expired and creds.refresh_token:
        _TRANSIENT_KEYWORDS = ('ssl', 'eof', 'connection', 'timeout', 'network', 'reset', 'broken pipe')
        for attempt in range(3):
            try:
                creds.refresh(Request())
                _save(creds)
                print(f"[google_auth] Token refreshed. New expiry: {creds.expiry}", flush=True)
                break
            except Exception as e:
                err_str = str(e).lower()
                is_transient = any(kw in err_str for kw in _TRANSIENT_KEYWORDS)
                if is_transient and attempt < 2:
                    wait = 2 ** attempt
                    print(f"[google_auth] Refresh failed (attempt {attempt + 1}/3, retrying in {wait}s): {e}", flush=True)
                    time.sleep(wait)
                else:
                    print(f"[google_auth] Refresh failed: {e}", flush=True)
                    creds = None
                    break

    if not creds or not creds.valid:
        raise RuntimeError(
            f"Google token is missing or invalid.\n"
            f"Run to re-authenticate: python \"{PA_HOME / 'reauth_google.py'}\""
        )

    return creds


def _save(creds):
    TOKEN_FILE.write_text(creds.to_json())


def get_gmail_service():
    return build("gmail", "v1", credentials=get_credentials())


def get_drive_service():
    return build("drive", "v3", credentials=get_credentials())


def get_docs_service():
    return build("docs", "v1", credentials=get_credentials())
