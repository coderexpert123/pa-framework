"""Tests for scripts/notify.py — the pa notify CLI wrapper."""
import os
import subprocess
import sys
import unittest
from unittest.mock import patch, MagicMock

# Add scripts dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from notify import send, _resolve_pa_bin


class TestNotifySend(unittest.TestCase):
    """Test notify.send — thin wrapper around pa notify CLI."""

    @patch('subprocess.run')
    def test_posix_direct_argv(self, mock_run):
        """POSIX: argv is [pa_bin, notify, ...] with no cmd.exe wrapper."""
        mock_run.return_value = MagicMock(returncode=0)
        with patch('sys.platform', 'linux'), \
             patch('shutil.which', return_value='/usr/local/bin/pa'), \
             patch.dict(os.environ, {}, clear=True):
            send("Test subject", "Test body", "test-key")
        args = mock_run.call_args[0][0]
        self.assertEqual(args[0], '/usr/local/bin/pa')
        self.assertIn('--subject', args)
        self.assertIn('Test subject', args)
        self.assertIn('--dedup-key', args)
        self.assertIn('test-key', args)
        self.assertEqual(mock_run.call_args[1]['input'], b'Test body')

    @patch('subprocess.run')
    def test_windows_cmd_wrapper(self, mock_run):
        """Windows .cmd: argv uses cmd.exe /c wrapper."""
        mock_run.return_value = MagicMock(returncode=0)
        with patch('sys.platform', 'win32'), \
             patch('shutil.which', return_value='C:\\Users\testuser\\AppData\\Roaming\\npm\\pa.cmd'), \
             patch.dict(os.environ, {'COMSPEC': 'C:\\Windows\\System32\\cmd.exe'}, clear=False):
            send("Subj", "Body", "key")
        args = mock_run.call_args[0][0]
        self.assertEqual(args[0], 'C:\\Windows\\System32\\cmd.exe')
        self.assertEqual(args[1], '/c')
        self.assertIn('pa.cmd', args[2])

    @patch('subprocess.run')
    def test_windows_exe_no_wrapper(self, mock_run):
        """Windows .exe: direct argv, no cmd.exe wrapper."""
        mock_run.return_value = MagicMock(returncode=0)
        with patch('sys.platform', 'win32'), \
             patch('shutil.which', return_value='C:\\tools\\pa.exe'), \
             patch.dict(os.environ, {}, clear=True):
            send("Subj", "Body", "key")
        args = mock_run.call_args[0][0]
        self.assertEqual(args[0], 'C:\\tools\\pa.exe')

    @patch('subprocess.run', side_effect=FileNotFoundError("not found"))
    def test_missing_binary_no_raise(self, mock_run):
        """FileNotFoundError → logs to stderr, returns None (no raise)."""
        import io
        with patch('sys.stderr', new_callable=io.StringIO) as mock_err:
            send("S", "B", "k")
        self.assertIn("not found", mock_err.getvalue())

    @patch('subprocess.run', side_effect=subprocess.TimeoutExpired(cmd='pa', timeout=10))
    def test_timeout_no_raise(self, mock_run):
        """TimeoutExpired → logs to stderr, returns None."""
        import io
        with patch('sys.stderr', new_callable=io.StringIO) as mock_err:
            send("S", "B", "k")
        self.assertIn("timeout", mock_err.getvalue())

    @patch('subprocess.run', side_effect=OSError("CreateProcess failed"))
    def test_os_error_no_raise(self, mock_run):
        """OSError → logs to stderr, returns None."""
        import io
        with patch('sys.stderr', new_callable=io.StringIO) as mock_err:
            send("S", "B", "k")
        self.assertIn("OS error", mock_err.getvalue())

    @patch('subprocess.run', side_effect=Exception("generic"))
    def test_generic_exception_no_raise(self, mock_run):
        """Any exception → logs to stderr, returns None."""
        import io
        with patch('sys.stderr', new_callable=io.StringIO) as mock_err:
            send("S", "B", "k")
        self.assertIn("generic", mock_err.getvalue())

    def test_env_override_pa_bin(self):
        """DAILY_MAIL_BRIEF_PA_BIN env var overrides resolution."""
        with patch.dict(os.environ, {'DAILY_MAIL_BRIEF_PA_BIN': '/custom/pa'}):
            self.assertEqual(_resolve_pa_bin(), '/custom/pa')


if __name__ == '__main__':
    unittest.main()
