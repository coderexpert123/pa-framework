"""
One-time Google OAuth re-authentication.

Opens a browser window — run this on your local machine when the token
has been revoked or is otherwise unrecoverable.

Saves a fresh token to ~/.pa/google-token.json with all PA scopes.

Usage:
    python ~/.pa/reauth_google.py
"""

import os
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow

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

if not CREDENTIALS_FILE.exists():
    raise FileNotFoundError(
        f"Missing credentials file: {CREDENTIALS_FILE}\n"
        f"Download it from Google Cloud Console:\n"
        f"  → APIs & Services → Credentials\n"
        f"  → Create Credentials → OAuth Client ID → Desktop app\n"
        f"  → Download JSON\n"
        f"  → save as {CREDENTIALS_FILE}\n"
        f"See examples/oauth/README.md for the full walkthrough."
    )

print(f"Opening browser for Google authorization...")
print(f"Token will be saved to: {TOKEN_FILE}\n")

flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), ALL_SCOPES)
creds = flow.run_local_server(port=0)
TOKEN_FILE.write_text(creds.to_json())

print(f"\nSuccess! Token saved to {TOKEN_FILE}")
print(f"Expiry: {creds.expiry}")
