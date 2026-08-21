"""
Tests for rotate_secrets.py

Tests:
- Manifest initialization from secrets.env
- Classification logic (provider-key, telegram-token, no-rotate)
- Due computation from cadence_days and last_rotated
- Swap + rollback flow with fake secret file
- No-rotate classes refuse rotation
"""

import json
import os
import sys
import tempfile
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path

# Add pa/scripts to path
SCRIPT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(SCRIPT_DIR))

import rotate_secrets


class FakeSecretsEnv:
    """Context manager to temporarily use a fake secrets.env."""

    def __init__(self, secrets: dict):
        self.temp_dir = None
        self.secrets = secrets

    def __enter__(self):
        self.temp_dir = tempfile.mkdtemp()
        fake_secrets_path = os.path.join(self.temp_dir, "secrets.env")

        with open(fake_secrets_path, "w", encoding="utf-8") as f:
            for key, value in sorted(self.secrets.items()):
                f.write(f"{key}={value}\n")

        # Monkey-patch rotate_secrets to use temp dir as PA_HOME
        self.original_pa_home = rotate_secrets.pa_home
        rotate_secrets.pa_home = lambda: self.temp_dir
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        rotate_secrets.pa_home = self.original_pa_home
        shutil.rmtree(self.temp_dir)


def test_manifest_init():
    """Test manifest initialization from secrets.env."""
    secrets = {
        "GROQ_API_KEY": "gsk_test123",
        "TELEGRAM_BOT_TOKEN": "bot123:ABC",
        "GEMINI_OAUTH_CLIENT_ID": "client-id",
        "PA_BACKUP_PASSPHRASE": "backup-pass",
        "STRAVA_REFRESH_TOKEN": "refresh-token",
        "ANTHROPIC_API_KEY": "sk-ant-test",
    }

    with FakeSecretsEnv(secrets):
        manifest = rotate_secrets.init_manifest()

        # Check total count
        assert len(manifest) == 6, f"Expected 6 entries, got {len(manifest)}"

        # Check provider-key classification
        groq_entry = manifest.get("GROQ_API_KEY")
        assert groq_entry is not None, "GROQ_API_KEY missing"
        assert groq_entry["class"] == "provider-key", f"Expected provider-key, got {groq_entry['class']}"
        assert groq_entry["cadence_days"] == 90, f"Expected 90 days, got {groq_entry['cadence_days']}"
        assert groq_entry["last_rotated"] is None, "Expected last_rotated to be None"

        # Check telegram-token classification
        telegram_entry = manifest.get("TELEGRAM_BOT_TOKEN")
        assert telegram_entry is not None, "TELEGRAM_BOT_TOKEN missing"
        assert telegram_entry["class"] == "telegram-token", f"Expected telegram-token, got {telegram_entry['class']}"

        # Check no-rotate classification (Google OAuth)
        oauth_entry = manifest.get("GEMINI_OAUTH_CLIENT_ID")
        assert oauth_entry is not None, "GEMINI_OAUTH_CLIENT_ID missing"
        assert oauth_entry["class"] == "no-rotate", f"Expected no-rotate, got {oauth_entry['class']}"
        assert "OAuth" in oauth_entry["no_rotate_reason"], f"Expected OAuth in reason, got {oauth_entry['no_rotate_reason']}"

        # Check no-rotate classification (backup passphrase)
        backup_entry = manifest.get("PA_BACKUP_PASSPHRASE")
        assert backup_entry is not None, "PA_BACKUP_PASSPHRASE missing"
        assert backup_entry["class"] == "no-rotate", f"Expected no-rotate, got {backup_entry['class']}"

        # Check no-rotate classification (refresh token)
        strava_entry = manifest.get("STRAVA_REFRESH_TOKEN")
        assert strava_entry is not None, "STRAVA_REFRESH_TOKEN missing"
        assert strava_entry["class"] == "no-rotate", f"Expected no-rotate, got {strava_entry['class']}"

        # Check another provider-key
        anthropic_entry = manifest.get("ANTHROPIC_API_KEY")
        assert anthropic_entry is not None, "ANTHROPIC_API_KEY missing"
        assert anthropic_entry["class"] == "provider-key", f"Expected provider-key, got {anthropic_entry['class']}"

    print("[OK] test_manifest_init passed")


def test_classification():
    """Test classification logic for various secret patterns."""
    # Test provider-key patterns
    assert rotate_secrets.classify_secret("GROQ_API_KEY") == "provider-key"
    assert rotate_secrets.classify_secret("ANTHROPIC_API_KEY") == "provider-key"
    assert rotate_secrets.classify_secret("OPENAI_API_KEY") == "provider-key"

    # Test telegram token
    assert rotate_secrets.classify_secret("TELEGRAM_BOT_TOKEN") == "telegram-token"

    # Test no-rotate (Google OAuth)
    assert rotate_secrets.classify_secret("GEMINI_OAUTH_CLIENT_ID") == "no-rotate"
    assert rotate_secrets.classify_secret("GEMINI_OAUTH_CLIENT_SECRET") == "no-rotate"

    # Test no-rotate (backup passphrase)
    assert rotate_secrets.classify_secret("PA_BACKUP_PASSPHRASE") == "no-rotate"

    # Test no-rotate (refresh tokens)
    assert rotate_secrets.classify_secret("STRAVA_REFRESH_TOKEN") == "no-rotate"

    # Test no-rotate (configuration constants)
    assert rotate_secrets.classify_secret("TELEGRAM_CHAT_ID") == "no-rotate"
    assert rotate_secrets.classify_secret("PA_ALERTS_CHAT_ID") == "no-rotate"

    # Test fail-closed for unknown
    assert rotate_secrets.classify_secret("UNKNOWN_SECRET") == "no-rotate"

    print("[OK] test_classification passed")


def test_due_computation():
    """Test due computation from cadence_days and last_rotated."""
    # Never rotated = due
    entry_never = {
        "name": "TEST_KEY",
        "class": "provider-key",
        "cadence_days": 90,
        "last_rotated": None,
        "no_rotate_reason": None,
    }
    assert rotate_secrets.is_due_for_rotation(entry_never) is True, "Never rotated should be due"

    # Rotated recently = not due
    recent_date = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat().replace("+00:00", "Z")
    entry_recent = {
        "name": "TEST_KEY",
        "class": "provider-key",
        "cadence_days": 90,
        "last_rotated": recent_date,
        "no_rotate_reason": None,
    }
    assert rotate_secrets.is_due_for_rotation(entry_recent) is False, "Recently rotated should not be due"

    # Rotated 91 days ago (90-day cadence) = due
    old_date = (datetime.now(timezone.utc) - timedelta(days=91)).isoformat().replace("+00:00", "Z")
    entry_old = {
        "name": "TEST_KEY",
        "class": "provider-key",
        "cadence_days": 90,
        "last_rotated": old_date,
        "no_rotate_reason": None,
    }
    assert rotate_secrets.is_due_for_rotation(entry_old) is True, "Old rotation should be due"

    # No-rotate class = never due
    entry_no_rotate = {
        "name": "TEST_KEY",
        "class": "no-rotate",
        "cadence_days": 90,
        "last_rotated": None,
        "no_rotate_reason": "Manual rotation required",
    }
    assert rotate_secrets.is_due_for_rotation(entry_no_rotate) is False, "No-rotate should never be due"

    print("[OK] test_due_computation passed")


def test_swap_and_rollback():
    """Test swap + rollback flow with fake secret file."""
    secrets = {
        "GROQ_API_KEY": "old-key-value",
        "OTHER_SECRET": "unchanged",
    }

    with FakeSecretsEnv(secrets):
        # Initialize manifest
        manifest = rotate_secrets.init_manifest()
        rotate_secrets.save_manifest(manifest)

        # Set PA_NEW_GROQ_API_KEY environment variable (valid GROQ format)
        os.environ["PA_NEW_GROQ_API_KEY"] = "gsk_new_key_value_12345678"

        # Perform rotation
        success = rotate_secrets.rotate_secret("GROQ_API_KEY")

        # Check success
        assert success is True, "Rotation should succeed"

        # Verify secrets.env was updated
        updated_secrets = rotate_secrets.read_secrets_env()
        assert updated_secrets.get("GROQ_API_KEY") == "gsk_new_key_value_12345678", "Secret should be updated"
        assert updated_secrets.get("OTHER_SECRET") == "unchanged", "Other secrets should be unchanged"

        # Verify manifest was updated
        updated_manifest = rotate_secrets.load_manifest()
        groq_entry = updated_manifest.get("GROQ_API_KEY")
        assert groq_entry is not None, "GROQ_API_KEY should be in manifest"
        assert groq_entry["last_rotated"] is not None, "last_rotated should be set"

        # Clean up env var
        del os.environ["PA_NEW_GROQ_API_KEY"]

    print("[OK] test_swap_and_rollback passed")


def test_swap_rollback_on_failure():
    """Test rollback when rotation fails (test failure)."""
    secrets = {
        "GROQ_API_KEY": "old-key-value",
    }

    with FakeSecretsEnv(secrets):
        # Initialize manifest
        manifest = rotate_secrets.init_manifest()
        rotate_secrets.save_manifest(manifest)

        # Set invalid new key (too short, will fail test)
        os.environ["PA_NEW_GROQ_API_KEY"] = "short"

        # Perform rotation (should fail and rollback)
        success = rotate_secrets.rotate_secret("GROQ_API_KEY")

        # Check failure
        assert success is False, "Rotation should fail with short key"

        # Verify rollback - secrets.env should have old value
        updated_secrets = rotate_secrets.read_secrets_env()
        assert updated_secrets.get("GROQ_API_KEY") == "old-key-value", "Secret should be rolled back"

        # Verify manifest was NOT updated
        updated_manifest = rotate_secrets.load_manifest()
        groq_entry = updated_manifest.get("GROQ_API_KEY")
        assert groq_entry is not None, "GROQ_API_KEY should be in manifest"
        assert groq_entry["last_rotated"] is None, "last_rotated should still be None"

        # Clean up env var
        del os.environ["PA_NEW_GROQ_API_KEY"]

    print("[OK] test_swap_rollback_on_failure passed")


def test_no_rotate_refuses():
    """Test that no-rotate classes refuse rotation."""
    secrets = {
        "PA_BACKUP_PASSPHRASE": "backup-value",
        "GEMINI_OAUTH_CLIENT_ID": "oauth-id",
    }

    with FakeSecretsEnv(secrets):
        # Initialize manifest
        manifest = rotate_secrets.init_manifest()
        rotate_secrets.save_manifest(manifest)

        # Try to rotate backup passphrase (should refuse)
        os.environ["PA_NEW_PA_BACKUP_PASSPHRASE"] = "new-backup"
        success = rotate_secrets.rotate_secret("PA_BACKUP_PASSPHRASE")
        assert success is False, "Backup passphrase rotation should be refused"
        del os.environ["PA_NEW_PA_BACKUP_PASSPHRASE"]

        # Try to rotate OAuth client ID (should refuse)
        os.environ["PA_NEW_GEMINI_OAUTH_CLIENT_ID"] = "new-oauth-id"
        success = rotate_secrets.rotate_secret("GEMINI_OAUTH_CLIENT_ID")
        assert success is False, "OAuth client ID rotation should be refused"
        del os.environ["PA_NEW_GEMINI_OAUTH_CLIENT_ID"]

    print("[OK] test_no_rotate_refuses passed")


def test_telegram_token_manual_flow():
    """Test that telegram token rotation requires manual BotFather flow."""
    secrets = {
        "TELEGRAM_BOT_TOKEN": "old-bot-token",
    }

    with FakeSecretsEnv(secrets):
        # Initialize manifest
        manifest = rotate_secrets.init_manifest()
        rotate_secrets.save_manifest(manifest)

        # Try to rotate without PA_NEW_TELEGRAM_BOT_TOKEN (should print manual steps)
        success = rotate_secrets.rotate_secret("TELEGRAM_BOT_TOKEN")
        assert success is False, "Should fail without new token"

        # Even with new token, v1 doesn't auto-rotate telegram tokens
        os.environ["PA_NEW_TELEGRAM_BOT_TOKEN"] = "new-bot-token"
        success = rotate_secrets.rotate_secret("TELEGRAM_BOT_TOKEN")
        assert success is False, "v1 should not auto-rotate telegram tokens"
        del os.environ["PA_NEW_TELEGRAM_BOT_TOKEN"]

    print("[OK] test_telegram_token_manual_flow passed")


def test_provider_key_validation():
    """Test provider key format validation."""
    # Test GROQ API key format
    assert rotate_secrets.test_provider_key("GROQ_API_KEY", "gsk_valid_key_123") is True
    assert rotate_secrets.test_provider_key("GROQ_API_KEY", "invalid_format") is False
    assert rotate_secrets.test_provider_key("GROQ_API_KEY", "short") is False

    # Test basic validation for other keys
    assert rotate_secrets.test_provider_key("ANTHROPIC_API_KEY", "sk-ant-valid-key-123") is True
    assert rotate_secrets.test_provider_key("ANTHROPIC_API_KEY", "") is False

    print("[OK] test_provider_key_validation passed")


def main():
    """Run all tests."""
    print("Running rotate_secrets tests...")
    print("")

    test_classification()
    test_due_computation()
    test_manifest_init()
    test_provider_key_validation()
    test_swap_and_rollback()
    test_swap_rollback_on_failure()
    test_no_rotate_refuses()
    test_telegram_token_manual_flow()

    print("")
    print("All tests passed!")


if __name__ == "__main__":
    main()
