#!/usr/bin/env python3
"""
WhatsApp deep link builder.

Reads a draft from STDIN and builds a wa.me link for the specified contact.

Usage:
    echo "Your message" | python build_link.py <alias>
    echo "Your message" | python build_link.py <name words...> [digits]

Arguments:
- Single positional arg: exact alias lookup (case-insensitive)
- Multiple args: name query where every token must match (alias + display_name)
- Trailing 2-4 digit tokens: filter by phone suffix (e.g. "hema 4521")
"""

import argparse
import json
import os
import sys
from urllib.parse import quote


def get_contacts_file():
    """Get the contacts.json file path relative to this script."""
    if 'CONTACTS_FILE' in os.environ:
        return os.environ['CONTACTS_FILE']

    # Default: data/contacts.json relative to project root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    return os.path.join(project_dir, 'data', 'contacts.json')


def load_contacts():
    """Load contacts from file."""
    contacts_file = get_contacts_file()
    if not os.path.exists(contacts_file):
        return {'contacts': []}

    with open(contacts_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def find_contact_by_alias(alias):
    """Find contact by case-insensitive alias (exact match)."""
    contacts_data = load_contacts()
    alias_lower = alias.strip().lower()
    for contact in contacts_data['contacts']:
        if contact['alias'].lower() == alias_lower:
            return contact
    return None


def normalize_phone(phone):
    """Strip non-digits from phone number (keep country code, no +)."""
    return ''.join(c for c in phone if c.isdigit())


def mask_phone(phone):
    """Return phone with only last 4 digits visible."""
    if len(phone) >= 4:
        return f"...{phone[-4:]}"
    return phone


def match_contact_by_query(name_tokens, digit_hints):
    """Find contacts matching name query and optional digit hints.

    Args:
        name_tokens: List of lowercase strings to search for in (alias + display_name)
        digit_hints: List of 2-4 digit strings to match phone suffix

    Returns:
        List of matching contacts (empty, one, or multiple)
    """
    contacts_data = load_contacts()
    matches = []

    for contact in contacts_data['contacts']:
        alias = (contact.get('alias') or '').lower()
        display_name = (contact.get('display_name') or '').lower()
        searchable = f"{alias} {display_name}"

        # Check if every name token is a substring of the searchable text
        name_match = all(token in searchable for token in name_tokens)

        if not name_match:
            continue

        # Apply digit hint filter if provided
        if digit_hints:
            phone = contact.get('phone', '')
            norm_phone = normalize_phone(phone)

            # Check if phone ends with ALL digit hints (in order)
            phone_suffix = ''
            for hint in digit_hints:
                if norm_phone.endswith(hint):
                    phone_suffix = hint
                else:
                    phone_suffix = ''
                    break

            if not phone_suffix:
                continue

        matches.append(contact)

    return matches


def count_shared_tokens(query_tokens, contact):
    """Count how many query tokens appear in contact's searchable text."""
    alias = (contact.get('alias') or '').lower()
    display_name = (contact.get('display_name') or '').lower()
    searchable = f"{alias} {display_name}"

    return sum(1 for token in query_tokens if token in searchable)


def format_candidate(contact):
    """Format a candidate for display (display_name + masked phone)."""
    display = contact.get('display_name') or contact.get('alias', '')
    phone = mask_phone(contact.get('phone', ''))
    return f"  {display} ({phone})"


def resolve_contact(args):
    """Resolve contact from command-line arguments.

    Args:
        args: List of positional arguments from argparse

    Returns:
        (contact, error) where:
        - contact: The matched contact dict, or None
        - error: (exit_code, message) tuple or None
    """
    if not args:
        return None, (1, "Error: No contact specified")

    # Extract digit hints (trailing 2-4 digit pure-number tokens)
    digit_hints = []
    name_args = list(args)

    # Scan from the end for digit hints
    while name_args and name_args[-1].isdigit() and 2 <= len(name_args[-1]) <= 4:
        digit_hints.insert(0, name_args.pop())  # Insert at beginning to maintain order

    # Track if this was an exact alias lookup attempt
    was_exact_alias_lookup = (len(name_args) == 1 and not digit_hints)

    # If only one arg and no digit hints, try exact alias lookup first
    if was_exact_alias_lookup:
        contact = find_contact_by_alias(name_args[0])
        if contact:
            return contact, None
        # Exact alias failed - will fall through to query matching below

    # Multiple args or single-arg fallback: use query matching
    name_tokens = [arg.lower() for arg in name_args]
    matches = match_contact_by_query(name_tokens, digit_hints)

    if not matches:
        # No matches found - try to show close candidates
        contacts_data = load_contacts()
        all_contacts = contacts_data['contacts']

        if not all_contacts:
            return None, (1, "No contacts yet. Say 'add contact <alias> <phone>' to add one.")

        # Show close matches based on shared tokens
        scored = [(c, count_shared_tokens(name_tokens, c)) for c in all_contacts]
        scored.sort(key=lambda x: x[1], reverse=True)

        # Check if ANY contact has shared tokens (max score > 0)
        max_score = scored[0][1] if scored else 0

        if max_score > 0:
            # There are some shared tokens - show "Did you mean:" with top matches
            top_candidates = [c for c, score in scored if score > 0][:5]
            candidates_text = "\n".join(format_candidate(c) for c in top_candidates)
            query_str = " ".join(args)
            return None, (1, f"No contact matches '{query_str}'\nDid you mean:\n{candidates_text}")
        else:
            # No shared tokens - show "Did you mean:" with top 5 contacts
            candidates_to_show = [c for c, score in scored][:5]
            candidates_text = "\n".join(format_candidate(c) for c in candidates_to_show)
            query_str = " ".join(args)
            return None, (1, f"No contact matches '{query_str}'\nDid you mean:\n{candidates_text}")

    # Multiple args or digit hints: use query matching
    name_tokens = [arg.lower() for arg in name_args]
    matches = match_contact_by_query(name_tokens, digit_hints)

    if not matches:
        # Find close candidates (top 5 by shared token count)
        contacts_data = load_contacts()
        all_contacts = contacts_data['contacts']

        if not all_contacts:
            return None, (1, "No contacts yet. Say 'add contact <alias> <phone>' to add one.")

        scored = [(c, count_shared_tokens(name_tokens, c)) for c in all_contacts]
        scored.sort(key=lambda x: x[1], reverse=True)
        top_candidates = [c for c, score in scored if score > 0][:5]

        if top_candidates:
            candidates_text = "\n".join(format_candidate(c) for c in top_candidates)
            query_str = " ".join(args)
            return None, (1, f"No contact matches '{query_str}'\nDid you mean:\n{candidates_text}")
        else:
            query_str = " ".join(args)
            return None, (1, f"No contact matches '{query_str}'")

    if len(matches) == 1:
        return matches[0], None

    # Multiple matches: show candidates
    candidates_text = "\n".join(format_candidate(c) for c in matches)
    query_str = " ".join(args)
    return None, (2, f"Ambiguous contact '{query_str}'\n{candidates_text}")


def build_link(contact, draft_text):
    """Build a wa.me link for the given contact and draft."""
    phone_digits = normalize_phone(contact['phone'])
    if not phone_digits:
        return None

    # URL encode the draft (with safe='' to encode spaces as %20)
    encoded_text = quote(draft_text, safe='')

    # Build the link
    link = f"https://wa.me/{phone_digits}?text={encoded_text}"
    return link


def main():
    parser = argparse.ArgumentParser(
        description='Build WhatsApp deep link',
        epilog='Examples:\n  echo "Hi" | python build_link.py mom\n  echo "Hi" | python build_link.py hema 4521',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument('query', nargs='+', help='Contact alias, name query, or name with digit hints')

    args = parser.parse_args()

    # Read draft from STDIN
    # Reconfigure stdin to use utf-8 encoding explicitly
    sys.stdin.reconfigure(encoding='utf-8')
    # Strip leading/trailing whitespace: a shell pipe appends a trailing
    # newline that would otherwise ride into the URL as %0A and put an
    # invisible trailing newline in WhatsApp's compose box. Mid-draft
    # newlines (paragraph breaks) are preserved.
    draft_text = sys.stdin.read().strip()

    # Resolve contact
    contact, error = resolve_contact(args.query)

    if error:
        exit_code, message = error
        print(message, file=sys.stderr)
        sys.exit(exit_code)

    # Build the link
    link = build_link(contact, draft_text)
    if link is None:
        print(f"Error: No valid phone number for contact", file=sys.stderr)
        sys.exit(1)

    # Print the link to STDOUT
    print(link)
    sys.exit(0)


if __name__ == '__main__':
    main()
