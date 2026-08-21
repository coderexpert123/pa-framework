import unittest
import os
import json
import tempfile
import shutil
import sys

# Add scripts directory to path for imports
script_dir = os.path.join(os.path.dirname(__file__), '..', 'scripts')
sys.path.insert(0, script_dir)

import contacts


class TestContacts(unittest.TestCase):
    def setUp(self):
        """Create a temp directory for each test."""
        self.test_dir = tempfile.mkdtemp()
        self.contacts_file = os.path.join(self.test_dir, 'contacts.json')
        # Set CONTACTS_FILE env var for the module
        os.environ['CONTACTS_FILE'] = self.contacts_file

    def tearDown(self):
        """Clean up temp directory."""
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)
        # Remove env var
        if 'CONTACTS_FILE' in os.environ:
            del os.environ['CONTACTS_FILE']

    # Original tests

    def test_add_contact_success(self):
        """Test adding a valid contact."""
        result = contacts.add_contact('mom', '+919876543210')
        self.assertTrue(result)
        contacts_data = contacts.load_contacts()
        self.assertEqual(len(contacts_data['contacts']), 1)
        self.assertEqual(contacts_data['contacts'][0]['alias'], 'mom')
        self.assertEqual(contacts_data['contacts'][0]['phone'], '+919876543210')

    def test_add_contact_duplicate_alias(self):
        """Test adding duplicate alias is rejected."""
        contacts.add_contact('mom', '+919876543210')
        result = contacts.add_contact('mom', '+919999999999')
        self.assertFalse(result)
        # Should still have only one contact
        contacts_data = contacts.load_contacts()
        self.assertEqual(len(contacts_data['contacts']), 1)
        self.assertEqual(contacts_data['contacts'][0]['phone'], '+919876543210')

    def test_add_contact_invalid_format_no_plus(self):
        """Test phone without + is rejected."""
        result = contacts.add_contact('dad', '919876543210')
        self.assertFalse(result)

    def test_add_contact_invalid_format_too_short(self):
        """Test phone too short is rejected (<8 digits)."""
        result = contacts.add_contact('dad', '+1234567')
        self.assertFalse(result)

    def test_add_contact_invalid_format_too_long(self):
        """Test phone too long is rejected (>15 digits)."""
        result = contacts.add_contact('dad', '+' + '1' * 16)
        self.assertFalse(result)

    def test_list_contacts_empty(self):
        """Test listing when no contacts."""
        output = contacts.list_contacts()
        self.assertIn('No contacts', output)

    def test_remove_contact_success(self):
        """Test removing a contact."""
        contacts.add_contact('mom', '+919876543210')
        result = contacts.remove_contact('mom')
        self.assertTrue(result)
        contacts_data = contacts.load_contacts()
        self.assertEqual(len(contacts_data['contacts']), 0)

    def test_remove_contact_unknown_alias(self):
        """Test removing unknown alias fails."""
        result = contacts.remove_contact('unknown')
        self.assertFalse(result)

    def test_missing_file_treated_as_empty(self):
        """Test missing contacts file is treated as empty."""
        # Delete the file if it exists
        if os.path.exists(self.contacts_file):
            os.remove(self.contacts_file)
        # Should be able to add contact
        result = contacts.add_contact('mom', '+919876543210')
        self.assertTrue(result)
        contacts_data = contacts.load_contacts()
        self.assertEqual(len(contacts_data['contacts']), 1)

    def test_case_insensitive_alias(self):
        """Test alias lookup is case-insensitive."""
        contacts.add_contact('Mom', '+919876543210')
        # Should be able to remove with different case
        result = contacts.remove_contact('MOM')
        self.assertTrue(result)
        contacts_data = contacts.load_contacts()
        self.assertEqual(len(contacts_data['contacts']), 0)

    # New tests for display_name and search

    def test_add_contact_with_display_name(self):
        """Test adding contact with display_name."""
        result = contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        self.assertTrue(result)
        contacts_data = contacts.load_contacts()
        self.assertEqual(contacts_data['contacts'][0]['display_name'], 'Jane Smith')

    def test_list_contacts_shows_display_name(self):
        """Test listing shows display_name when present."""
        contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        contacts.add_contact('dad', '+15555555555', display_name='John Smith')
        output = contacts.list_contacts()
        self.assertIn('Jane Smith', output)
        self.assertIn('John Smith', output)
        # Should show alias too
        self.assertIn('alias: mom', output)
        self.assertIn('alias: dad', output)

    def test_list_contacts_shows_alias_when_no_display_name(self):
        """Test listing shows alias when display_name absent."""
        contacts.add_contact('mom', '+919876543210')
        output = contacts.list_contacts()
        self.assertIn('mom', output)
        # Should still show the masked phone
        self.assertIn('3210', output)

    def test_list_contacts_masked_phone(self):
        """Test listing shows only last 4 digits."""
        contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        contacts.add_contact('dad', '+15555555555', display_name='John Smith')
        output = contacts.list_contacts()
        # Should show last 4 digits only
        self.assertIn('3210', output)
        self.assertIn('5555', output)
        # Should NOT show full numbers
        self.assertNotIn('+919876543210', output)
        self.assertNotIn('+15555555555', output)

    def test_search_contacts_by_alias(self):
        """Test searching by alias substring."""
        contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        contacts.add_contact('dad', '+15555555555', display_name='John Smith')
        output = contacts.search_contacts('om')
        self.assertIn('mom', output)
        self.assertNotIn('dad', output)

    def test_search_contacts_by_display_name(self):
        """Test searching by display_name substring."""
        contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        contacts.add_contact('dad', '+15555555555', display_name='John Smith')
        output = contacts.search_contacts('john')
        self.assertIn('John Smith', output)
        self.assertNotIn('Jane Smith', output)

    def test_search_contacts_no_matches(self):
        """Test search with no matches."""
        contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        output = contacts.search_contacts('xyz')
        self.assertIn('No contacts matching', output)
        self.assertIn('xyz', output)

    def test_search_contacts_multiple_matches(self):
        """Test search with multiple matches."""
        contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        contacts.add_contact('dad', '+15555555555', display_name='John Smith')
        output = contacts.search_contacts('smith')
        self.assertIn('Jane Smith', output)
        self.assertIn('John Smith', output)

    def test_search_contacts_case_insensitive(self):
        """Test search is case-insensitive."""
        contacts.add_contact('mom', '+919876543210', display_name='Jane Smith')
        output = contacts.search_contacts('JANE')
        self.assertIn('Jane Smith', output)


if __name__ == '__main__':
    unittest.main()
