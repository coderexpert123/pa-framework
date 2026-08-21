#!/usr/bin/env python3
"""
Import contacts from Google People API.

Usage:
    python import_google.py [--dry-run]

Reads contacts from Google People API and upserts them into data/contacts.json.
Existing entries (manual contacts) are preserved. Display names are updated.
"""

import argparse
import json
import os
import sys
from pathlib import Path

# Import the centralized google_auth module
# Add examples/oauth to path to import google_auth
script_dir = os.path.dirname(os.path.abspath(__file__))
# scripts/ -> whatsapp-drafts/ -> projects/ -> repo root (three levels up)
repo_root = os.path.dirname(os.path.dirname(os.path.dirname(script_dir)))
oauth_dir = os.path.join(repo_root, 'examples', 'oauth')
if oauth_dir not in sys.path:
    sys.path.insert(0, oauth_dir)

try:
    import google_auth
except ImportError:
    print("Error: Cannot import google_auth module.", file=sys.stderr)
    print("Ensure examples/oauth/google_auth.py exists.", file=sys.stderr)
    sys.exit(1)


# Constants for Google re-auth messaging
REAUTH_SCOPE = "https://www.googleapis.com/auth/contacts.readonly"
REAUTH_MESSAGE = "Re-auth needed: run the Telegram /auth reauth flow after the operator approves the new scope."


def report_reauth_error(error_prefix):
    """Print re-auth error message and exit."""
    print(f"Error: {error_prefix}", file=sys.stderr)
    print(REAUTH_MESSAGE, file=sys.stderr)
    print(f"New scope required: {REAUTH_SCOPE}", file=sys.stderr)
    sys.exit(2)


def get_contacts_file():
    """Get the contacts.json file path relative to this script."""
    if 'CONTACTS_FILE' in os.environ:
        return os.environ['CONTACTS_FILE']

    # Default: data/contacts.json in this project (whatsapp-drafts), one level above scripts/
    project_dir = os.path.dirname(script_dir)
    return os.path.join(project_dir, 'data', 'contacts.json')


def load_contacts():
    """Load contacts from file."""
    contacts_file = get_contacts_file()
    if not os.path.exists(contacts_file):
        return {'contacts': []}

    with open(contacts_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_contacts(contacts_data, dry_run=False):
    """Save contacts atomically using tmp + os.replace."""
    if dry_run:
        return

    contacts_file = get_contacts_file()
    # Ensure directory exists
    os.makedirs(os.path.dirname(contacts_file), exist_ok=True)

    # Write to temp file first
    tmp_file = contacts_file + '.tmp'
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(contacts_data, f, indent=2, ensure_ascii=False)

    # Atomic replace
    os.replace(tmp_file, contacts_file)


def normalize_phone(phone):
    """Strip non-digits from phone number (keep country code, no +)."""
    return ''.join(c for c in phone if c.isdigit())


def slugify_display_name(display_name):
    """Convert display name to a slug-like alias (lowercase, alphanumeric + spaces)."""
    if not display_name:
        return 'unknown'
    # Keep only alphanumeric and spaces, convert to lowercase
    slug = ''.join(c.lower() if c.isalnum() else ' ' for c in display_name)
    # Collapse multiple spaces
    slug = ' '.join(slug.split())
    return slug or 'unknown'


def get_phone_value(phone_entry):
    """Extract phone value from a Google People API phone entry."""
    # The canonical number is in the 'value' field
    # Format: usually includes + country code
    raw_value = phone_entry.get('value', '')
    return raw_value.strip() if raw_value else None


def fetch_all_people_contacts():
    """Fetch all contacts from Google People API with pagination."""
    try:
        # Build the People API service
        service = google_auth.build('people', 'v1', credentials=google_auth.get_credentials())
    except RuntimeError as e:
        if 'Google token is missing or invalid' in str(e):
            report_reauth_error("Google authentication failed.")
        else:
            raise
    except Exception as e:
        # Check for HttpError 403 (insufficient permissions)
        if '403' in str(e) or 'insufficient' in str(e).lower():
            report_reauth_error("Insufficient permissions for contacts.readonly scope.")
        else:
            print(f"Error: Failed to build People API service: {e}", file=sys.stderr)
            sys.exit(1)

    all_contacts = []
    page_token = None
    resource_name = 'people/me'

    # Fields to fetch: names and phoneNumbers
    person_fields = 'names,phoneNumbers'

    while True:
        try:
            # Request connections (people in 'My Contacts')
            request = service.people().connections().list(
                resourceName=resource_name,
                personFields=person_fields,
                pageSize=200,
                pageToken=page_token
            )
            response = request.execute()

            # Extract connections
            connections = response.get('connections', [])
            all_contacts.extend(connections)

            # Check for next page
            page_token = response.get('nextPageToken')
            if not page_token:
                break

        except Exception as e:
            error_str = str(e).lower()
            if '403' in error_str or 'forbidden' in error_str:
                report_reauth_error("Insufficient permissions for contacts.readonly scope.")
            else:
                print(f"Error: Failed to fetch contacts: {e}", file=sys.stderr)
                sys.exit(1)

    return all_contacts


def extract_contact_data(google_contact):
    """Extract display name and preferred phone from a Google People API contact."""
    # Extract display name
    display_name = None
    names = google_contact.get('names', [])
    if names:
        # Use the first primary name, or the first name if none marked primary
        primary_name = next((n for n in names if n.get('metadata', {}).get('primary')), None)
        name_entry = primary_name if primary_name else names[0]
        display_name = name_entry.get('displayName', '').strip()

    # Extract phone numbers (prefer mobile)
    phone_numbers = google_contact.get('phoneNumbers', [])
    if not phone_numbers:
        return None, None  # Skip contacts without phone

    # Prefer type 'mobile', else first number
    mobile_phone = next((p for p in phone_numbers if p.get('type') == 'mobile'), None)
    chosen_phone = mobile_phone if mobile_phone else phone_numbers[0]

    phone_value = get_phone_value(chosen_phone)
    if not phone_value:
        return None, None

    return display_name, phone_value


def upsert_contacts(google_contacts, dry_run=False):
    """Upsert Google contacts into existing contacts.json, preserving manual entries."""
    existing_data = load_contacts()

    # Build a map of normalized phone -> existing contact
    existing_by_phone = {}
    manual_contacts = []  # Contacts that are manual-only (no Google match)

    for contact in existing_data['contacts']:
        phone = contact.get('phone', '')
        if phone:
            norm_phone = normalize_phone(phone)
            existing_by_phone[norm_phone] = contact

    # Process Google contacts
    would_add = 0
    would_update = 0

    for google_contact in google_contacts:
        display_name, phone = extract_contact_data(google_contact)
        if not phone:
            continue  # Skip entries without phone

        norm_phone = normalize_phone(phone)
        if not norm_phone:
            continue  # Skip invalid phone

        if norm_phone in existing_by_phone:
            # Update: preserve alias, refresh display_name and phone
            existing = existing_by_phone[norm_phone]
            updated = False

            if display_name and existing.get('display_name') != display_name:
                existing['display_name'] = display_name
                updated = True

            if existing.get('phone') != phone:
                existing['phone'] = phone
                updated = True

            if updated:
                would_update += 1
        else:
            # Add new entry with slugified alias
            alias = slugify_display_name(display_name)
            # Ensure alias is unique
            base_alias = alias
            counter = 1
            while any(c.get('alias', '').lower() == alias.lower() for c in existing_data['contacts']):
                alias = f"{base_alias}{counter}"
                counter += 1

            new_contact = {
                'alias': alias,
                'phone': phone,
                'display_name': display_name
            }
            existing_data['contacts'].append(new_contact)
            would_add += 1

    if dry_run:
        print(f"Would add: {would_add} new contacts")
        print(f"Would update: {would_update} existing contacts")
        return would_add, would_update
    else:
        save_contacts(existing_data, dry_run=False)
        print(f"Added: {would_add} new contacts")
        print(f"Updated: {would_update} existing contacts")
        return would_add, would_update


def main():
    # Reconfigure stdin/stdout to use utf-8 encoding explicitly
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

    parser = argparse.ArgumentParser(description='Import contacts from Google People API')
    parser.add_argument('--dry-run', action='store_true', help='Print counts without writing')
    args = parser.parse_args()

    # Fetch all contacts from Google
    google_contacts = fetch_all_people_contacts()

    # Upsert into contacts.json
    upsert_contacts(google_contacts, dry_run=args.dry_run)

    sys.exit(0)


if __name__ == '__main__':
    main()
