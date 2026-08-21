"""
Secret Rotation Manager

OWASP-inspired secret rotation workflow for PA deployment secrets.
Manifest-driven with classification: provider-key, telegram-token, no-rotate.

Classes:
- provider-key: API keys that can be rotated (quarterly cadence)
- telegram-token: Telegram bot token (quarterly cadence)
- no-rotate: Secrets that should NEVER be auto-rotated (Google OAuth, backup passphrases, personal data)

Workflow (--rotate <name>):
1. CREATE: Generate or provision new secret value
2. SET: Swap into secrets.env (atomic write)
3. TEST: Verify the new value works (where testable)
4. FINISH: Mark rotation complete in manifest
5. On failure at any step: ROLLBACK to previous value

Usage:
    python rotate_secrets.py --init          # Initialize manifest from secrets.env
    python rotate_secrets.py --due            # Check which secrets are due for rotation
    python rotate_secrets.py --rotate <name>  # Rotate a specific secret (OWASP workflow)
    python rotate_secrets.py --manifest       # Show current manifest state

Deterministic — NO LLM.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional


# Classification rules
# Provider API keys (quarterly rotation)
PROVIDER_KEY_PATTERNS = [
    "GROQ_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "COHERE_API_KEY",
    "MISTRAL_API_KEY",
]

# Telegram token (quarterly, but manual BotFather create)
TELEGRAM_TOKEN_PATTERN = "TELEGRAM_BOT_TOKEN"

# Never auto-rotate these (manual process or security policy)
NO_ROTATE_PATTERNS = [
    "GEMINI_OAUTH_CLIENT_ID",           # Google OAuth: requires full reauth flow
    "GEMINI_OAUTH_CLIENT_SECRET",       # Google OAuth: requires full reauth flow
    "GOOGLE_AUTH_REDIRECT_URI",        # Google OAuth: deployment endpoint
    "PA_OAUTH_FINISH_SCRIPT",          # Google OAuth: deployment path
    "STRAVA_REFRESH_TOKEN",            # OAuth refresh token: requires re-grant
    "PA_BACKUP_PASSPHRASE",            # Backup encryption: manual rotation
    "CREDIT_CARD_PASSWORDS",           # Personal data: never auto-rotate
    "COROS_PASSWORD",                  # Personal credential: never auto-rotate
    "TELEGRAM_CHAT_ID",                # Configuration constant, not secret
    "TELEGRAM_DAILY_BRIEFING_THREAD_ID",  # Configuration constant
    "TELEGRAM_BRIEFING_CHAT_ID",       # Configuration constant
    "PA_ALERTS_CHAT_ID",               # Configuration constant
    "PA_ALERTS_THREAD_ID",             # Configuration constant
    "PA_SELF_IMPROVER_THREAD_ID",      # Configuration constant
    "PA_PLANS_DRIVE_FOLDER_ID",        # Configuration constant
    "TELEGRAM_PROXY_SOURCE_URL",       # Configuration, not credential
    "HEMIR_INVOICE_RECIPIENT_EMAIL",  # Configuration constant
    "DRIVE_KNEE_RECOVERY_URL",        # Configuration constant
]

DEFAULT_CADENCE_DAYS = {
    "provider-key": 90,    # Quarterly
    "telegram-token": 90,   # Quarterly (manual create)
}


def pa_home() -> str:
    """Get PA_HOME directory."""
    return os.environ.get("PA_HOME") or os.path.join(os.path.expanduser("~"), ".pa")


def secrets_env_path() -> str:
    """Path to secrets.env file."""
    return os.path.join(pa_home(), "secrets.env")


def manifest_path() -> str:
    """Path to secrets rotation manifest (runtime state)."""
    return os.path.join(pa_home(), "secrets-rotation-manifest.json")


def read_secrets_env() -> Dict[str, str]:
    """Read secrets.env file and return name->value mapping."""
    secrets = {}
    try:
        with open(secrets_env_path(), "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                secrets[key.strip()] = value.strip()
    except FileNotFoundError:
        print(f"ERROR: secrets.env not found at {secrets_env_path()}", file=sys.stderr)
        sys.exit(1)
    return secrets


def classify_secret(name: str) -> str:
    """
    Classify a secret into: provider-key, telegram-token, no-rotate.

    Returns 'no-rotate' for unclassified secrets (fail-closed).
    """
    # Check no-rotate patterns first (security-first)
    for pattern in NO_ROTATE_PATTERNS:
        if name == pattern or name.startswith(pattern + "_"):
            return "no-rotate"

    # Check telegram token
    if name == TELEGRAM_TOKEN_PATTERN:
        return "telegram-token"

    # Check provider keys
    for pattern in PROVIDER_KEY_PATTERNS:
        if name == pattern or name.startswith(pattern + "_"):
            return "provider-key"

    # Fail-closed: anything else is no-rotate
    return "no-rotate"


def init_manifest() -> Dict[str, Any]:
    """
    Initialize manifest from current secrets.env.

    Returns manifest dict with entries:
    {
        "<name>": {
            "name": "<name>",
            "class": "provider-key|telegram-token|no-rotate",
            "cadence_days": <int>,
            "last_rotated": "<ISO-8601 timestamp or null>",
            "no_rotate_reason": "<reason string or null>"
        }
    }
    """
    secrets = read_secrets_env()
    manifest = {}

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    for name in sorted(secrets.keys()):
        cls = classify_secret(name)

        if cls == "no-rotate":
            # Determine reason
            if any(pattern in name for pattern in ["OAUTH", "GOOGLE_AUTH"]):
                reason = "Google OAuth tokens require full reauth flow via /auth command"
            elif name == "PA_BACKUP_PASSPHRASE":
                reason = "Backup encryption passphrase - manual rotation required"
            elif any(pattern in name for pattern in ["PASSWORD", "REFRESH_TOKEN"]):
                reason = "Personal credential or OAuth token - manual rotation required"
            elif any(pattern in name for pattern in ["CHAT_ID", "THREAD_ID", "FOLDER_ID", "URL", "EMAIL"]):
                reason = "Configuration constant, not a rotatable secret"
            else:
                reason = "Unclassified secret - manual review required"
        else:
            reason = None

        entry = {
            "name": name,
            "class": cls,
            "cadence_days": DEFAULT_CADENCE_DAYS.get(cls, 90),
            "last_rotated": None,  # Never rotated
            "no_rotate_reason": reason if cls == "no-rotate" else None,
        }

        manifest[name] = entry

    return manifest


def load_manifest() -> Dict[str, Any]:
    """Load existing manifest or return empty dict."""
    try:
        with open(manifest_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_manifest(manifest: Dict[str, Any]) -> None:
    """Save manifest to disk atomically."""
    tmp_path = manifest_path() + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    os.replace(tmp_path, manifest_path())


def is_due_for_rotation(entry: Dict[str, Any]) -> bool:
    """Check if a secret is due for rotation."""
    if entry.get("class") == "no-rotate":
        return False

    last_rotated = entry.get("last_rotated")
    if not last_rotated:
        # Never rotated = due
        return True

    cadence_days = entry.get("cadence_days", 90)
    last_date = datetime.fromisoformat(last_rotated.replace("Z", "+00:00"))
    due_date = last_date + timedelta(days=cadence_days)

    return datetime.now(timezone.utc) >= due_date


def check_due() -> List[Dict[str, Any]]:
    """
    Check which secrets are due for rotation.

    Returns list of manifest entries that are due.
    """
    manifest = load_manifest()
    if not manifest:
        print("ERROR: Manifest not initialized. Run --init first.", file=sys.stderr)
        sys.exit(1)

    due = []
    for name, entry in manifest.items():
        if is_due_for_rotation(entry):
            due.append(entry)

    return due


def rotate_secret(name: str) -> bool:
    """
    Rotate a secret using OWASP workflow: CREATE → SET → TEST → FINISH.

    Returns True on success, False on failure (with rollback applied).
    """
    manifest = load_manifest()
    if not manifest or name not in manifest:
        print(f"ERROR: Secret '{name}' not found in manifest. Run --init first.", file=sys.stderr)
        return False

    entry = manifest[name]

    # Check no-rotate class
    if entry.get("class") == "no-rotate":
        reason = entry.get("no_rotate_reason", "manual rotation required")
        print(f"ERROR: Secret '{name}' is class 'no-rotate': {reason}", file=sys.stderr)
        return False

    # Back up current secrets.env
    backup_path = secrets_env_path() + ".backup"
    shutil.copy2(secrets_env_path(), backup_path)

    try:
        # STEP 1: CREATE - Get new value from environment
        new_value = os.environ.get(f"PA_NEW_{name}")
        if not new_value:
            if entry.get("class") == "telegram-token":
                # Telegram token: manual BotFather create
                print(f"Telegram token rotation requires manual steps:")
                print(f"1. Open @BotFather in Telegram")
                print(f"2. Use /revoke old token")
                print(f"3. Use /token to get new token")
                print(f"4. Set PA_NEW_TELEGRAM_BOT_TOKEN=<new-token>")
                print(f"5. Run: python rotate_secrets.py --rotate TELEGRAM_BOT_TOKEN")
                return False
            else:
                print(f"ERROR: PA_NEW_{name} environment variable not set", file=sys.stderr)
                return False

        # STEP 2: SET - Swap into secrets.env
        secrets = read_secrets_env()
        old_value = secrets.get(name, "")
        secrets[name] = new_value

        # Atomic write
        tmp_path = secrets_env_path() + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            for key, value in sorted(secrets.items()):
                f.write(f"{key}={value}\n")
        os.replace(tmp_path, secrets_env_path())

        # STEP 3: TEST - Verify the new value works
        if entry.get("class") == "telegram-token":
            # Test Telegram API connectivity
            test_result = test_telegram_token(new_value)
        elif entry.get("class") == "provider-key":
            # For provider keys, we do a basic validation
            # (Full test would require a provider-specific API call)
            test_result = test_provider_key(name, new_value)
        else:
            test_result = True  # No test available

        if not test_result:
            print(f"ERROR: Test failed for '{name}', rolling back", file=sys.stderr)
            raise RuntimeError("Test failed")

        # STEP 4: FINISH - Update manifest
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        entry["last_rotated"] = now
        manifest[name] = entry
        save_manifest(manifest)

        print(f"SUCCESS: Rotated '{name}' (tested {now})")
        return True

    except Exception as e:
        # ROLLBACK - Restore from backup
        print(f"ERROR during rotation: {e}", file=sys.stderr)
        shutil.copy2(backup_path, secrets_env_path())
        os.remove(backup_path)
        print(f"Rolled back '{name}' to previous value", file=sys.stderr)
        return False


def test_telegram_token(token: str) -> bool:
    """
    Test Telegram bot token by calling getMe API.

    Returns True if token is valid, False otherwise.
    """
    try:
        import urllib.request
        import urllib.error

        url = f"https://api.telegram.org/bot{token}/getMe"
        req = urllib.request.Request(url, method="GET")

        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data.get("ok", False) is True

    except Exception as e:
        print(f"Telegram API test failed: {e}", file=sys.stderr)
        return False


def test_provider_key(name: str, key: str) -> bool:
    """
    Test provider API key with basic validation.

    In v1, this is a placeholder that validates the key format.
    Future versions would do a cheap live API call per provider.
    """
    # Basic validation: non-empty and reasonable length
    if not key or len(key) < 10:
        print(f"Provider key '{name}' fails basic validation", file=sys.stderr)
        return False

    # Provider-specific format checks
    if name == "GROQ_API_KEY" and not key.startswith("gsk_"):
        print(f"GROQ API key format invalid", file=sys.stderr)
        return False

    # Placeholder: In production, add live API tests per provider
    return True


def show_manifest() -> None:
    """Display current manifest state."""
    manifest = load_manifest()
    if not manifest:
        print("ERROR: Manifest not initialized. Run --init first.", file=sys.stderr)
        sys.exit(1)

    print("# Secret Rotation Manifest")
    print(f"# Generated: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')} UTC")
    print("")

    for name, entry in sorted(manifest.items()):
        cls = entry.get("class", "unknown")
        cadence = entry.get("cadence_days", "N/A")
        last = entry.get("last_rotated") or "never"
        reason = entry.get("no_rotate_reason")

        if cls == "no-rotate":
            print(f"**{name}** [{cls}]")
            print(f"  Reason: {reason}")
        else:
            due = " **DUE**" if is_due_for_rotation(entry) else ""
            print(f"**{name}** [{cls}] (every {cadence} days, last: {last}){due}")

        print("")


def main():
    parser = argparse.ArgumentParser(description="Secret Rotation Manager")
    parser.add_argument("--init", action="store_true", help="Initialize manifest from secrets.env")
    parser.add_argument("--due", action="store_true", help="Check which secrets are due for rotation")
    parser.add_argument("--rotate", metavar="NAME", help="Rotate a specific secret (OWASP workflow)")
    parser.add_argument("--manifest", action="store_true", help="Show current manifest state")

    args = parser.parse_args()

    if args.init:
        manifest = init_manifest()
        save_manifest(manifest)
        print(f"Initialized manifest with {len(manifest)} secrets")
        print(f"Manifest saved to {manifest_path()}")
        return

    if args.due:
        due = check_due()
        if not due:
            print("No secrets due for rotation.")
            return

        print(f"# Secrets Due for Rotation ({len(due)})")
        print("")
        for entry in due:
            name = entry.get("name")
            cls = entry.get("class")
            last = entry.get("last_rotated") or "never"
            print(f"- **{name}** [{cls}] (last: {last})")
        return

    if args.rotate:
        if not rotate_secret(args.rotate):
            sys.exit(1)
        return

    if args.manifest:
        show_manifest()
        return

    parser.print_help()


if __name__ == "__main__":
    main()
