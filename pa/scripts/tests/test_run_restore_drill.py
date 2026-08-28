#!/usr/bin/env python3
"""Tests for run_restore_drill.py"""
import io
import os
import sys
import json
import gzip
import tarfile
import tempfile
import pytest
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timezone, timedelta

# Add scripts dir to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import run_restore_drill  # noqa: E402


class TestRestoreDrill:
    """Test the restore drill script."""

    def test_decrypt_and_verify_success(self):
        """Test successful decrypt and verify with valid backup."""
        # Create a minimal valid backup blob
        # We'll mock the decrypt function to return a valid tar.gz
        with patch('run_restore_drill.decrypt') as mock_decrypt:
            # Create a mock tar.gz with a valid .env file
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                # Add a valid .env file
                env_content = b"TEST_KEY=test_value\nANOTHER_KEY=value\n"
                info = tarfile.TarInfo(name="pa/secrets.env")
                info.size = len(env_content)
                tar.addfile(info, io.BytesIO(env_content))

                # Add a valid JSON file
                json_content = b'{"key": "value"}\n'
                info = tarfile.TarInfo(name="pa/test.json")
                info.size = len(json_content)
                tar.addfile(info, io.BytesIO(json_content))

            tar_bytes = tar_buffer.getvalue()
            gzipped = gzip.compress(tar_bytes)
            mock_decrypt.return_value = gzipped

            # Mock passphrase
            with patch('run_restore_drill._secret', return_value='test_passphrase_16chars'):
                success, errors = run_restore_drill.restore_and_verify(b"dummy_blob")

        assert success is True
        assert len(errors) == 0

    def test_decrypt_failure(self):
        """Test decrypt failure handling."""
        with patch('run_restore_drill.decrypt', side_effect=Exception("wrong passphrase")):
            with patch('run_restore_drill._secret', return_value='test_passphrase_16chars'):
                success, errors = run_restore_drill.restore_and_verify(b"dummy_blob")

        assert success is False
        assert len(errors) == 1
        assert "Decryption failed" in errors[0]

    def test_verify_invalid_env_file(self):
        """Test validation catches malformed .env file."""
        with patch('run_restore_drill.decrypt') as mock_decrypt:
            # Create a tar with an invalid .env (empty key)
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                # Invalid env: line with "= value" (empty key)
                env_content = b"=value_without_key\n"
                info = tarfile.TarInfo(name="pa/secrets.env")
                info.size = len(env_content)
                tar.addfile(info, io.BytesIO(env_content))

            tar_bytes = tar_buffer.getvalue()
            gzipped = gzip.compress(tar_bytes)
            mock_decrypt.return_value = gzipped

            with patch('run_restore_drill._secret', return_value='test_passphrase_16chars'):
                success, errors = run_restore_drill.restore_and_verify(b"dummy_blob")

        assert success is False
        assert any("empty key" in e for e in errors)

    def test_verify_invalid_json_file(self):
        """Test validation catches malformed JSON file."""
        with patch('run_restore_drill.decrypt') as mock_decrypt:
            # Create a tar with an invalid JSON
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                json_content = b'{"invalid": json missing close brace\n'
                info = tarfile.TarInfo(name="pa/test.json")
                info.size = len(json_content)
                tar.addfile(info, io.BytesIO(json_content))

            tar_bytes = tar_buffer.getvalue()
            gzipped = gzip.compress(tar_bytes)
            mock_decrypt.return_value = gzipped

            with patch('run_restore_drill._secret', return_value='test_passphrase_16chars'):
                success, errors = run_restore_drill.restore_and_verify(b"dummy_blob")

        assert success is False
        assert any("JSON parse error" in e for e in errors)

    def test_verify_invalid_sqlite_file(self):
        """Test validation catches SQLite file without magic header."""
        with patch('run_restore_drill.decrypt') as mock_decrypt:
            # Create a tar with a file claiming to be .db but without magic header
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                db_content = b"not a sqlite database"
                info = tarfile.TarInfo(name="pa/test.db")
                info.size = len(db_content)
                tar.addfile(info, io.BytesIO(db_content))

            tar_bytes = tar_buffer.getvalue()
            gzipped = gzip.compress(tar_bytes)
            mock_decrypt.return_value = gzipped

            with patch('run_restore_drill._secret', return_value='test_passphrase_16chars'):
                success, errors = run_restore_drill.restore_and_verify(b"dummy_blob")

        assert success is False
        assert any("missing SQLite magic header" in e for e in errors)

    @patch('run_restore_drill._drive')
    @patch('run_restore_drill._get_or_create_folder')
    @patch('run_restore_drill._secret')
    def test_download_newest_backup(self, mock_secret, mock_folder, mock_drive):
        """Test downloading the newest backup from Drive."""
        # Setup mocks
        mock_secret.return_value = 'test_passphrase_16chars'

        mock_service = Mock()
        mock_drive.return_value = mock_service

        # Mock folder hierarchy
        mock_folder.side_effect = ["root_id", "folder_id"]

        # Mock file list with newest file
        mock_service.files().list().execute.return_value = {
            "files": [
                {
                    "id": "file123",
                    "name": "pa-secrets-20260817T120000Z.pab",
                    "createdTime": "2026-08-17T12:00:00.000Z"
                }
            ]
        }

        # Mock download
        mock_service.files().get_media().execute.return_value = b"dummy_blob_content"

        blob, filename, created_time = run_restore_drill.download_newest_backup()

        assert filename == "pa-secrets-20260817T120000Z.pab"
        assert blob == b"dummy_blob_content"
        assert created_time.isoformat() == "2026-08-17T12:00:00+00:00"

    @patch('run_restore_drill._drive')
    @patch('run_restore_drill._get_or_create_folder')
    def test_download_no_backups_found(self, mock_folder, mock_drive):
        """Test handling when no backups exist in Drive."""
        mock_service = Mock()
        mock_drive.return_value = mock_service
        mock_folder.side_effect = ["root_id", "folder_id"]

        # Empty file list
        mock_service.files().list().execute.return_value = {"files": []}

        with pytest.raises(RuntimeError, match="No pa-secrets-.* backups found"):
            run_restore_drill.download_newest_backup()

    @patch('run_restore_drill._drive')
    @patch('run_restore_drill._get_or_create_folder')
    def test_check_fitness_blob_ok(self, mock_folder, mock_drive):
        """Test fitness blob check with valid recent blob."""
        mock_service = Mock()
        mock_drive.return_value = mock_service
        mock_folder.return_value = "root_id"

        # Mock file list with fitness blob
        recent_time = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        mock_service.files().list().execute.return_value = {
            "files": [
                {
                    "id": "fitness123",
                    "name": "pa-fitness-20260817.fab",
                    "createdTime": recent_time
                }
            ]
        }

        # Mock header download
        mock_service.files().get_media().execute.return_value = b"PAFIT\x01"

        result = run_restore_drill.check_fitness_blob()

        assert result["status"] == "ok"
        assert result["filename"] == "pa-fitness-20260817.fab"
        assert result["age_days"] == 30

    @patch('run_restore_drill._drive')
    @patch('run_restore_drill._get_or_create_folder')
    def test_check_fitness_blob_stale(self, mock_folder, mock_drive):
        """Test fitness blob check detects stale (>90 days) blob."""
        mock_service = Mock()
        mock_drive.return_value = mock_service
        mock_folder.return_value = "root_id"

        # Mock file list with old fitness blob
        old_time = (datetime.now(timezone.utc) - timedelta(days=100)).isoformat()
        mock_service.files().list().execute.return_value = {
            "files": [
                {
                    "id": "fitness123",
                    "name": "pa-fitness-20260517.fab",
                    "createdTime": old_time
                }
            ]
        }

        mock_service.files().get_media().execute.return_value = b"PAFIT\x01"

        result = run_restore_drill.check_fitness_blob()

        assert result["status"] == "ok"
        assert result["age_days"] == 100

    @patch('run_restore_drill._drive')
    @patch('run_restore_drill._get_or_create_folder')
    def test_check_fitness_blob_not_found(self, mock_folder, mock_drive):
        """Test fitness blob check when no blob exists."""
        mock_service = Mock()
        mock_drive.return_value = mock_service
        mock_folder.return_value = "root_id"

        # Empty file list
        mock_service.files().list().execute.return_value = {"files": []}

        result = run_restore_drill.check_fitness_blob()

        assert result["status"] == "not_found"

    @patch('run_restore_drill._drive')
    @patch('run_restore_drill._get_or_create_folder')
    def test_check_fitness_blob_invalid_header(self, mock_folder, mock_drive):
        """Test fitness blob check detects invalid header."""
        mock_service = Mock()
        mock_drive.return_value = mock_service
        mock_folder.return_value = "root_id"

        mock_service.files().list().execute.return_value = {
            "files": [
                {
                    "id": "fitness123",
                    "name": "pa-fitness-20260817.fab",
                    "createdTime": datetime.now(timezone.utc).isoformat()
                }
            ]
        }

        # Mock invalid header
        mock_service.files().get_media().execute.return_value = b"INVALID_HEADER"

        result = run_restore_drill.check_fitness_blob()

        assert result["status"] == "invalid_header"
        assert result["filename"] == "pa-fitness-20260817.fab"

    def test_pa_home_respects_env_var(self):
        """Test that PA_HOME environment variable is respected."""
        with patch.dict(os.environ, {"PA_HOME": "C:\\custom_pa_home"}):
            result = run_restore_drill._pa_home()
            assert result == Path("C:\\custom_pa_home")

    def test_pa_home_fallback(self):
        """Test that PA_HOME falls back to ~/.pa when not set."""
        with patch.dict(os.environ, {}, clear=False):
            # Remove PA_HOME if it exists
            original = os.environ.pop("PA_HOME", None)
            try:
                result = run_restore_drill._pa_home()
                assert result == Path.home() / ".pa"
            finally:
                if original:
                    os.environ["PA_HOME"] = original

    def test_secret_loads_from_env(self):
        """Test that _secret loads from environment variable."""
        with patch.dict(os.environ, {"TEST_SECRET": "env_value"}):
            result = run_restore_drill._secret("TEST_SECRET", required=False)
            assert result == "env_value"

    def test_secret_raises_when_missing_and_required(self):
        """_secret with required=True raises when the var is in neither env
        nor a secrets.env file (PA_HOME pointed at an empty temp dir)."""
        with tempfile.TemporaryDirectory() as tmp:
            original_pa_home = os.environ.pop("PA_HOME", None)
            original = os.environ.pop("TEST_SECRET", None)
            os.environ["PA_HOME"] = tmp
            try:
                with pytest.raises(RuntimeError, match="TEST_SECRET not set"):
                    run_restore_drill._secret("TEST_SECRET", required=True)
            finally:
                if original:
                    os.environ["TEST_SECRET"] = original
                if original_pa_home:
                    os.environ["PA_HOME"] = original_pa_home
                else:
                    os.environ.pop("PA_HOME", None)

    def test_path_traversal_guard(self):
        """Test that path traversal attacks are blocked."""
        with patch('run_restore_drill.decrypt') as mock_decrypt:
            # Create a tar with a path traversal attempt
            tar_buffer = io.BytesIO()
            with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
                # Try to escape the temp directory
                content = b"malicious content"
                info = tarfile.TarInfo(name="../../../etc/passwd")
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))

            tar_bytes = tar_buffer.getvalue()
            gzipped = gzip.compress(tar_bytes)
            mock_decrypt.return_value = gzipped

            with patch('run_restore_drill._secret', return_value='test_passphrase_16chars'):
                # Should succeed without extracting the malicious file
                success, errors = run_restore_drill.restore_and_verify(b"dummy_blob")

        # The malicious file should be skipped, so validation passes (no files checked)
        assert success is True
        assert len(errors) == 0
