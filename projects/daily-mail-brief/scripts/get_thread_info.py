
import os
import sys
from googleapiclient.discovery import build

# Add PA_HOME to sys.path
PA_HOME = os.environ.get("PA_HOME", os.path.join(os.path.expanduser("~"), ".pa"))
sys.path.insert(0, PA_HOME)

from google_auth import get_credentials

def main():
    service = build('gmail', 'v1', credentials=get_credentials())
    # Gmail search query — pass as the first CLI arg; the default is a generic example.
    q = sys.argv[1] if len(sys.argv) > 1 else 'subject:"MONTHLY REPORT" newer_than:90d'
    results = service.users().messages().list(userId='me', q=q, maxResults=1).execute()
    messages = results.get('messages', [])
    
    if not messages:
        print("No message found.")
        return

    m = service.users().messages().get(userId='me', id=messages[0]['id']).execute()
    headers = {h['name']: h['value'] for h in m['payload']['headers']}
    
    print(f"THREAD_ID: {m['threadId']}")
    print(f"MESSAGE_ID: {m['id']}")
    print(f"MSG_ID_HEADER: {headers.get('Message-ID')}")
    print(f"SUBJECT: {headers.get('Subject')}")
    print(f"TO: {headers.get('From')}")

if __name__ == '__main__':
    main()
