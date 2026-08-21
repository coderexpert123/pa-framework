#!/usr/bin/env python3
"""
WhatsApp contact registry management.

Usage:
    python contacts.py add <alias> <phone> [--name <display_name>]
    python contacts.py list
    python contacts.py search <substring>
    python contacts.py remove <alias>
"""

import argparse
import json
import os
import sys


def get_contacts_file():
    """Get the contacts.json file path relative to this script."""
    if 'CONTACTS_FILE' in os.environ:
        return os.environ['CONTACTS_FILE']

    # Default: data/contacts.json relative to project root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    return os.path.join(project_dir, 'data', 'contacts.json')


def load_contacts():
    """Load contacts from file, treating missing file as empty."""
    contacts_file = get_contacts_file()
    if not os.path.exists(contacts_file):
        return {'contacts': []}

    with open(contacts_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_contacts(contacts_data):
    """Save contacts atomically using tmp + os.replace."""
    contacts_file = get_contacts_file()
    # Ensure directory exists
    os.makedirs(os.path.dirname(contacts_file), exist_ok=True)

    # Write to temp file first
    tmp_file = contacts_file + '.tmp'
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(contacts_data, f, indent=2, ensure_ascii=False)

    # Atomic replace
    os.replace(tmp_file, contacts_file)


def find_contact(alias):
    """Find contact by case-insensitive alias."""
    contacts_data = load_contacts()
    alias_lower = alias.lower()
    for contact in contacts_data['contacts']:
        if contact['alias'].lower() == alias_lower:
            return contact
    return None


def validate_phone(phone):
    """Validate phone format: + followed by 8-15 digits."""
    if not phone.startswith('+'):
        return False
    digits = phone[1:]
    if not digits.isdigit():
        return False
    if len(digits) < 8 or len(digits) > 15:
        return False
    return True


def add_contact(alias, phone, display_name=None):
    """Add a new contact. Returns True on success, False on failure."""
    # Validate phone
    if not validate_phone(phone):
        print(f"Error: Invalid phone format '{phone}'. Must be + followed by 8-15 digits.", file=sys.stderr)
        return False

    # Check for duplicate alias (case-insensitive)
    if find_contact(alias) is not None:
        print(f"Error: Alias '{alias}' already exists.", file=sys.stderr)
        return False

    contacts_data = load_contacts()
    contact_entry = {
        'alias': alias.lower(),
        'phone': phone
    }
    if display_name:
        contact_entry['display_name'] = display_name

    contacts_data['contacts'].append(contact_entry)
    save_contacts(contacts_data)
    return True


def list_contacts():
    """List all contacts with display_name (if present) and masked phone numbers (last 4 digits only)."""
    contacts_data = load_contacts()
    if not contacts_data['contacts']:
        return "No contacts yet. Say 'add contact <alias> <phone>' to add one."

    lines = ["Contacts:"]
    for contact in contacts_data['contacts']:
        # Use display_name if present, otherwise alias
        name = contact.get('display_name') or contact.get('alias', '')

        # Mask phone: show only last 4 digits
        phone = contact.get('phone', '')
        last_four = phone[-4:] if len(phone) >= 4 else phone
        lines.append(f"  {name} (alias: {contact['alias']}, ...{last_four})")
    return '\n'.join(lines)


def search_contacts(substring):
    """Search contacts by substring in alias or display_name."""
    contacts_data = load_contacts()
    substring_lower = substring.lower()

    matches = []
    for contact in contacts_data['contacts']:
        alias = (contact.get('alias') or '').lower()
        display_name = (contact.get('display_name') or '').lower()
        searchable = f"{alias} {display_name}"

        if substring_lower in searchable:
            # Use display_name if present, otherwise alias
            name = contact.get('display_name') or contact.get('alias', '')

            # Mask phone
            phone = contact.get('phone', '')
            last_four = phone[-4:] if len(phone) >= 4 else phone

            matches.append(f"  {name} (alias: {contact['alias']}, ...{last_four})")

    if not matches:
        return f"No contacts matching '{substring}'"

    lines = [f"Contacts matching '{substring}':"]
    lines.extend(matches)
    return '\n'.join(lines)


def remove_contact(alias):
    """Remove a contact by alias. Returns True on success, False on failure."""
    contacts_data = load_contacts()
    alias_lower = alias.lower()

    original_count = len(contacts_data['contacts'])
    contacts_data['contacts'] = [
        c for c in contacts_data['contacts']
        if c['alias'].lower() != alias_lower
    ]

    if len(contacts_data['contacts']) == original_count:
        print(f"Error: Unknown alias '{alias}'", file=sys.stderr)
        return False

    save_contacts(contacts_data)
    return True


def main():
    parser = argparse.ArgumentParser(description='WhatsApp contacts registry')
    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    # add command
    add_parser = subparsers.add_parser('add', help='Add a contact')
    add_parser.add_argument('alias', help='Contact alias (case-insensitive)')
    add_parser.add_argument('phone', help='Phone number in +XXXXXXXXXX format')
    add_parser.add_argument('--name', dest='display_name', help='Display name (optional)')

    # list command
    list_parser = subparsers.add_parser('list', help='List contacts')

    # search command
    search_parser = subparsers.add_parser('search', help='Search contacts by substring')
    search_parser.add_argument('substring', help='Substring to search for in alias or display_name')

    # remove command
    remove_parser = subparsers.add_parser('remove', help='Remove a contact')
    remove_parser.add_argument('alias', help='Contact alias to remove')

    args = parser.parse_args()

    if args.command == 'add':
        if add_contact(args.alias, args.phone, args.display_name):
            display = f" ({args.display_name})" if args.display_name else ""
            print(f"Added contact: {args.alias}{display}")
            sys.exit(0)
        else:
            sys.exit(1)
    elif args.command == 'list':
        print(list_contacts())
        sys.exit(0)
    elif args.command == 'search':
        print(search_contacts(args.substring))
        sys.exit(0)
    elif args.command == 'remove':
        if remove_contact(args.alias):
            print(f"Removed contact: {args.alias}")
            sys.exit(0)
        else:
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()
