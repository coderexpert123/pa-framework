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
    # Search for examplebank alerts from April 1st to April 3rd
    query = 'from:examplebank.net OR from:examplebank.com after:2026/04/01'
    found = search_emails(query)
    print(json.dumps(found, indent=2))
