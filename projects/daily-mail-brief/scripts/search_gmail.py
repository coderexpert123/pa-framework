import os
import sys
import json
from datetime import datetime, timedelta

# Add the scripts directory to path to import auth
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from auth import get_gmail_service

def search_emails(query, max_results=50):
    service = get_gmail_service()
    
    print(f"Searching for: {query}")
    results = service.users().messages().list(userId='me', q=query, maxResults=max_results).execute()
    messages = results.get('messages', [])
    
    if not messages:
        print("No messages found.")
        return []

    emails = []
    for msg in messages:
        msg_data = service.users().messages().get(userId='me', id=msg['id'], format='metadata', 
                                                 metadataHeaders=['From', 'Subject', 'Date']).execute()
        headers = {h['name']: h['value'] for h in msg_data.get('payload', {}).get('headers', [])}
        emails.append({
            'id': msg['id'],
            'from': headers.get('From', ''),
            'subject': headers.get('Subject', ''),
            'date': headers.get('Date', ''),
            'snippet': msg_data.get('snippet', '')
        })
    return emails

if __name__ == "__main__":
    # Query comes from the command line — never hardcode one here. A checked-in
    # example query names the real senders it filters on, and this file ships to
    # the public framework mirror (2026-07-21: a hardcoded bank-alert query sat
    # here and leaked the account provider; the pre-push guard missed it because
    # it only scans lines ADDED by a push, and this line was already committed).
    if len(sys.argv) < 2:
        print('Usage: python search_gmail.py "<gmail-query>" [max_results]', file=sys.stderr)
        print('  e.g. python search_gmail.py "from:example.com after:2026/04/01" 20', file=sys.stderr)
        sys.exit(2)
    query = sys.argv[1]
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 50
    found = search_emails(query, max_results)
    print(json.dumps(found, indent=2))
