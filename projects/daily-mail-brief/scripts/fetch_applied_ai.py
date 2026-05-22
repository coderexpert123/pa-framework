import os
import sys
import json
from pathlib import Path

# Add project scripts (this file's directory) to path
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# Set PA_HOME default if not already set (don't clobber)
os.environ.setdefault("PA_HOME", os.path.expanduser("~/.pa"))

from search_gmail import search_emails
from auth import get_gmail_service

def get_body(msg_id):
    service = get_gmail_service()
    msg = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
    
    payload = msg.get('payload', {})
    parts = payload.get('parts', [])
    
    body = ""
    if not parts:
        body = payload.get('body', {}).get('data', '')
    else:
        # Get the first part (usually text/plain or text/html)
        for part in parts:
            if part['mimeType'] == 'text/plain':
                body = part['body'].get('data', '')
                break
            elif part['mimeType'] == 'text/html':
                body = part['body'].get('data', '')
    
    import base64
    if body:
        return base64.urlsafe_b64decode(body).decode('utf-8', errors='ignore')
    return ""

if __name__ == "__main__":
    query = 'subject:\"Applied AI\" after:2026/04/10'
    print(f"Searching for: {query}")
    emails = search_emails(query, max_results=5)
    
    if emails:
        print(f"Found {len(emails)} emails.")
        for email in emails:
            print(f"ID: {email['id']}")
            print(f"Subject: {email['subject']}")
            print(f"From: {email['from']}")
            print(f"Date: {email['date']}")
            print("-" * 20)
            # Fetch body of the first match
            body = get_body(email['id'])
            print(body[:2000] + ("..." if len(body) > 2000 else ""))
            break
    else:
        print("No emails found.")
