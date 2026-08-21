# pii-scan:ignore-start
import unittest
import json
import os
import sys
import tempfile
import shutil
from unittest.mock import Mock, patch, MagicMock

# Add scripts directory to path for imports
script_dir = os.path.join(os.path.dirname(__file__), '..', 'scripts')
sys.path.insert(0, script_dir)

# Mock the google_auth module before importing import_google
mock_google_auth = MagicMock()
sys.modules['google_auth'] = mock_google_auth
sys.modules['google_auth.build'] = MagicMock()

import import_google


class TestImportGoogle(unittest.TestCase):
    def setUp(self):
        """Create a temp directory for each test."""
        self.test_dir = tempfile.mkdtemp()
        self.contacts_file = os.path.join(self.test_dir, 'contacts.json')
        os.environ['CONTACTS_FILE'] = self.contacts_file

    def tearDown(self):
        """Clean up temp directory."""
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)
        if 'CONTACTS_FILE' in os.environ:
            del os.environ['CONTACTS_FILE']

    def create_mock_service(self, contacts_list):
        """Create a mock Google People API service with given contacts."""
        mock_service = Mock()

        # Mock the connections().list() method
        mock_connections = Mock()
        mock_connections.list.return_value = Mock(
            execute=lambda: {
                'connections': contacts_list,
                'nextPageToken': None  # No pagination for simple tests
            }
        )
        mock_service.people.return_value.connections.return_value = mock_connections

        return mock_service

    def test_normalize_phone(self):
        """Test phone normalization strips non-digits."""
        self.assertEqual(import_google.normalize_phone('+1 (555) 123-4567'), '15551234567')
        self.assertEqual(import_google.normalize_phone('+91-98765-43210'), '919876543210')

    def test_slugify_display_name(self):
        """Test display name slugification."""
        self.assertEqual(import_google.slugify_display_name('Jane Smith'), 'jane smith')
        self.assertEqual(import_google.slugify_display_name('Hema Shah'), 'hema shah')
        self.assertEqual(import_google.slugify_display_name(''), 'unknown')
        self.assertEqual(import_google.slugify_display_name('John-Doe'), 'john doe')

    def test_extract_contact_data_with_name_and_phone(self):
        """Test extracting display name and phone from Google contact."""
        google_contact = {
            'names': [{'displayName': 'Jane Smith', 'metadata': {'primary': True}}],
            'phoneNumbers': [{'value': '+1-555-123-4567', 'type': 'mobile'}]
        }

        display_name, phone = import_google.extract_contact_data(google_contact)
        self.assertEqual(display_name, 'Jane Smith')
        self.assertEqual(phone, '+1-555-123-4567')

    def test_extract_contact_data_prefers_mobile(self):
        """Test mobile phone type is preferred over other types."""
        google_contact = {
            'names': [{'displayName': 'Jane Smith'}],
            'phoneNumbers': [
                {'value': '+1-555-111-1111', 'type': 'home'},
                {'value': '+1-555-222-2222', 'type': 'mobile'},
                {'value': '+1-555-333-3333', 'type': 'work'}
            ]
        }

        display_name, phone = import_google.extract_contact_data(google_contact)
        self.assertEqual(phone, '+1-555-222-2222')  # mobile preferred

    def test_extract_contact_data_skips_no_phone(self):
        """Test contacts without phone are skipped."""
        google_contact = {
            'names': [{'displayName': 'Jane Smith'}],
            'phoneNumbers': []
        }

        display_name, phone = import_google.extract_contact_data(google_contact)
        self.assertIsNone(display_name)
        self.assertIsNone(phone)

    def test_extract_contact_data_uses_first_name(self):
        """Test first name is used when none marked primary."""
        google_contact = {
            'names': [
                {'displayName': 'Jane Smith', 'metadata': {'primary': False}},
                {'displayName': 'Jane A Smith', 'metadata': {'primary': False}}
            ],
            'phoneNumbers': [{'value': '+1-555-123-4567'}]
        }

        display_name, phone = import_google.extract_contact_data(google_contact)
        self.assertEqual(display_name, 'Jane Smith')  # First name used

    def test_upsert_new_contact(self):
        """Test upsert adds new contact."""
        google_contacts = [
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '+1-555-123-4567'}]
            }
        ]

        with patch('import_google.fetch_all_people_contacts', return_value=google_contacts):
            added, updated = import_google.upsert_contacts(google_contacts, dry_run=False)

        self.assertEqual(added, 1)
        self.assertEqual(updated, 0)

        # Verify contact was added
        contacts_data = import_google.load_contacts()
        self.assertEqual(len(contacts_data['contacts']), 1)
        self.assertEqual(contacts_data['contacts'][0]['display_name'], 'Jane Smith')
        self.assertEqual(contacts_data['contacts'][0]['phone'], '+1-555-123-4567')

    def test_upsert_existing_contact_updates_display_name(self):
        """Test upsert updates existing contact's display_name."""
        # Create initial contact
        with open(self.contacts_file, 'w', encoding='utf-8') as f:
            json.dump({
                'contacts': [
                    {'alias': 'jane', 'phone': '+1-555-123-4567', 'display_name': 'Jane'}
                ]
            }, f)

        google_contacts = [
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '+1-555-123-4567'}]
            }
        ]

        with patch('import_google.fetch_all_people_contacts', return_value=google_contacts):
            added, updated = import_google.upsert_contacts(google_contacts, dry_run=False)

        self.assertEqual(added, 0)
        self.assertEqual(updated, 1)

        # Verify display_name was updated
        contacts_data = import_google.load_contacts()
        self.assertEqual(contacts_data['contacts'][0]['display_name'], 'Jane Smith')
        # Alias should be preserved
        self.assertEqual(contacts_data['contacts'][0]['alias'], 'jane')

    def test_upsert_preserves_manual_contacts(self):
        """Test upsert preserves manually-added contacts not in Google."""
        # Create manual contact
        with open(self.contacts_file, 'w', encoding='utf-8') as f:
            json.dump({
                'contacts': [
                    {'alias': 'mom', 'phone': '+1-555-999-9999', 'display_name': 'Mom'}
                ]
            }, f)

        google_contacts = [
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '+1-555-123-4567'}]
            }
        ]

        with patch('import_google.fetch_all_people_contacts', return_value=google_contacts):
            added, updated = import_google.upsert_contacts(google_contacts, dry_run=False)

        # Manual contact should still exist
        contacts_data = import_google.load_contacts()
        self.assertEqual(len(contacts_data['contacts']), 2)
        self.assertTrue(any(c['alias'] == 'mom' for c in contacts_data['contacts']))

    def test_upsert_dry_run(self):
        """Test dry-run mode doesn't write to file."""
        google_contacts = [
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '+1-555-123-4567'}]
            }
        ]

        with patch('import_google.fetch_all_people_contacts', return_value=google_contacts):
            added, updated = import_google.upsert_contacts(google_contacts, dry_run=True)

        self.assertEqual(added, 1)
        self.assertEqual(updated, 0)

        # File should not exist or be empty
        if os.path.exists(self.contacts_file):
            with open(self.contacts_file, 'r') as f:
                data = json.load(f)
                self.assertEqual(len(data['contacts']), 0)

    def test_upsert_creates_unique_alias(self):
        """Test upsert creates unique alias when duplicates exist."""
        google_contacts = [
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '+1-555-111-1111'}]
            },
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '+1-555-222-2222'}]
            }
        ]

        with patch('import_google.fetch_all_people_contacts', return_value=google_contacts):
            added, updated = import_google.upsert_contacts(google_contacts, dry_run=False)

        self.assertEqual(added, 2)

        contacts_data = import_google.load_contacts()
        aliases = [c['alias'] for c in contacts_data['contacts']]
        # Should have created unique aliases
        self.assertEqual(len(set(aliases)), 2)
        # First should be 'jane smith', second should be 'jane smith1'
        self.assertIn('jane smith', aliases)
        self.assertIn('jane smith1', aliases)

    def test_upsert_phone_normalization(self):
        """Test upsert normalizes phone numbers for matching."""
        # Create contact with phone in different format
        with open(self.contacts_file, 'w', encoding='utf-8') as f:
            json.dump({
                'contacts': [
                    {'alias': 'jane', 'phone': '+1-555-123-4567', 'display_name': 'Jane'}
                ]
            }, f)

        # Google returns same phone without formatting
        google_contacts = [
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '15551234567'}]  # No plus, no dashes
            }
        ]

        with patch('import_google.fetch_all_people_contacts', return_value=google_contacts):
            added, updated = import_google.upsert_contacts(google_contacts, dry_run=False)

        # Should update existing contact (phones normalize to same)
        self.assertEqual(added, 0)
        self.assertEqual(updated, 1)

    def test_upsert_pagination(self):
        """Test upsert handles paginated results."""
        # Create mock service with pagination
        page1_contacts = [
            {
                'names': [{'displayName': 'Jane Smith'}],
                'phoneNumbers': [{'value': '+1-555-111-1111'}]
            }
        ]
        page2_contacts = [
            {
                'names': [{'displayName': 'John Doe'}],
                'phoneNumbers': [{'value': '+1-555-222-2222'}]
            }
        ]

        mock_service = Mock()
        mock_request_page1 = Mock()
        mock_request_page1.execute.return_value = {
            'connections': page1_contacts,
            'nextPageToken': 'page2_token'
        }

        mock_request_page2 = Mock()
        mock_request_page2.execute.return_value = {
            'connections': page2_contacts,
            'nextPageToken': None  # End of pagination
        }

        mock_connections = Mock()
        mock_connections.list.side_effect = [mock_request_page1, mock_request_page2]
        mock_service.people.return_value.connections.return_value = mock_connections

        with patch('import_google.google_auth.build', return_value=mock_service):
            contacts = import_google.fetch_all_people_contacts()

        # Should have fetched both pages
        self.assertEqual(len(contacts), 2)
        self.assertEqual(contacts[0]['names'][0]['displayName'], 'Jane Smith')
        self.assertEqual(contacts[1]['names'][0]['displayName'], 'John Doe')


if __name__ == '__main__':
    unittest.main()
# pii-scan:ignore-end
