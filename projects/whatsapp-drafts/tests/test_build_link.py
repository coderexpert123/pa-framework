# pii-scan:ignore-start
import unittest
import os
import json
import tempfile
import shutil
import sys
import subprocess

script_dir = os.path.join(os.path.dirname(__file__), '..', 'scripts')


class TestBuildLink(unittest.TestCase):
    def setUp(self):
        """Create a temp directory for each test."""
        self.test_dir = tempfile.mkdtemp()
        self.contacts_file = os.path.join(self.test_dir, 'contacts.json')
        # Create a test contacts file with display_name
        with open(self.contacts_file, 'w', encoding='utf-8') as f:
            json.dump({'contacts': [
                {'alias': 'mom', 'phone': '+919876543210', 'display_name': 'Jane Smith'},
                {'alias': 'dad', 'phone': '+15555555555', 'display_name': 'John Smith'},
                {'alias': 'helen1', 'phone': '+919876543211', 'display_name': 'Helen Shaw'},
                {'alias': 'helen2', 'phone': '+919876543212', 'display_name': 'Helen Price'}
            ]}, f)
        self.script_path = os.path.join(script_dir, 'build_link.py')

    def tearDown(self):
        """Clean up temp directory."""
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def run_build_link(self, query, draft_text):
        """Helper to run build_link.py with given query and draft."""
        env = os.environ.copy()
        env['CONTACTS_FILE'] = self.contacts_file
        result = subprocess.run(
            [sys.executable, self.script_path] + query,
            input=draft_text,
            capture_output=True,
            text=True,
            encoding='utf-8',
            env=env
        )
        return result

    # Original tests for backward compatibility

    def test_exact_alias_lookup_single_arg(self):
        """Test exact alias lookup with single positional arg works."""
        draft = "Hi Mom"
        result = self.run_build_link(['mom'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('wa.me', output)
        self.assertIn('919876543210', output)

    def test_unknown_alias_single_arg(self):
        """Test unknown alias returns error."""
        draft = "Hello"
        result = self.run_build_link(['unknown'], draft)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unknown', result.stderr.lower())
        self.assertIn('Did you mean', result.stderr)  # Changed from 'Known contacts'

    # New resolver tests

    def test_unique_partial_name_match(self):
        """Test unique partial name match works."""
        draft = "Hello"
        result = self.run_build_link(['jane'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('wa.me', output)
        self.assertIn('919876543210', output)

    def test_multiple_word_name_query(self):
        """Test multiple word name query works."""
        draft = "Hello"
        result = self.run_build_link(['helen', 'shaw'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('wa.me', output)
        self.assertIn('919876543211', output)

    def test_digit_hint_disambiguation(self):
        """Test digit hint disambiguates between similar names."""
        draft = "Hello"
        result = self.run_build_link(['helen', '3211'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('wa.me', output)
        self.assertIn('919876543211', output)

    def test_digit_hint_trailing_position(self):
        """Test digit hint can be in trailing position."""
        draft = "Hello"
        result = self.run_build_link(['helen', 'shaw', '3211'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('wa.me', output)
        self.assertIn('919876543211', output)

    def test_ambiguous_contact_exit_2(self):
        """Test ambiguous contact returns exit code 2 and lists candidates."""
        draft = "Hello"
        result = self.run_build_link(['helen'], draft)
        self.assertEqual(result.returncode, 2)
        self.assertIn('Ambiguous', result.stderr)
        self.assertIn('Helen Shaw', result.stderr)
        self.assertIn('Helen Price', result.stderr)

    def test_no_match_exit_1_with_candidates(self):
        """Test no match returns exit 1 and lists close candidates."""
        draft = "Hello"
        result = self.run_build_link(['xyz'], draft)
        self.assertEqual(result.returncode, 1)
        self.assertIn('No contact matches', result.stderr)
        # Should show some candidates based on shared tokens
        self.assertIn('Did you mean', result.stderr)

    def test_case_insensitive_name_query(self):
        """Test name query is case-insensitive."""
        draft = "Hello"
        result = self.run_build_link(['JANE'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('919876543210', output)

    def test_digit_hint_filters_by_phone_suffix(self):
        """Test digit hint filters by phone suffix."""
        draft = "Hello"
        result = self.run_build_link(['john', '5555'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('15555555555', output)

    def test_empty_contacts_list(self):
        """Test behavior with empty contacts list."""
        # Create empty contacts file
        with open(self.contacts_file, 'w', encoding='utf-8') as f:
            json.dump({'contacts': []}, f)

        draft = "Hello"
        result = self.run_build_link(['someone'], draft)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No contacts yet', result.stderr)

    # Original tests continued

    def test_phone_normalization_strips_non_digits(self):
        """Test phone normalization strips non-digits."""
        draft = "Test"
        result = self.run_build_link(['dad'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('15555555555', output)
        self.assertNotIn('+', output)

    def test_urlencoding_spaces(self):
        """Test spaces are URL encoded."""
        draft = "Hello world with spaces"
        result = self.run_build_link(['mom'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('Hello%20world%20with%20spaces', output)

    def test_urlencoding_ampersand(self):
        """Test ampersand is URL encoded."""
        draft = "Hello & goodbye"
        result = self.run_build_link(['mom'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('Hello%20%26%20goodbye', output)

    def test_urlencoding_newlines(self):
        """Test newlines are URL encoded."""
        draft = "Line 1\nLine 2"
        result = self.run_build_link(['mom'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('Line%201%0ALine%202', output)

    def test_urlencoding_emoji(self):
        """Test emoji are URL encoded."""
        draft = "Hello 👋 world"
        result = self.run_build_link(['mom'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertNotIn('👋', output)

    def test_urlencoding_hindi_text(self):
        """Test Hindi text is URL encoded."""
        draft = "नमस्ते दुनिया"
        result = self.run_build_link(['mom'], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertNotIn('नमस्ते', output)

    def test_alias_with_whitespace(self):
        """Test alias with surrounding whitespace is trimmed."""
        draft = "Hello"
        result = self.run_build_link(['  mom  '], draft)
        self.assertEqual(result.returncode, 0)
        output = result.stdout.strip()
        self.assertIn('919876543210', output)


if __name__ == '__main__':
    unittest.main()
# pii-scan:ignore-end
