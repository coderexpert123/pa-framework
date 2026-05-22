
import os
import sys
import base64
from googleapiclient.discovery import build

PA_HOME = os.environ.get("PA_HOME", os.path.join(os.path.expanduser("~"), ".pa"))
sys.path.insert(0, PA_HOME)
from google_auth import get_credentials

def get_body(payload):
    if 'parts' in payload:
        for part in payload['parts']:
            body = get_body(part)
            if body: return body
    if 'body' in payload and 'data' in payload['body']:
        return base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='ignore')
    return None

def main():
    service = build('gmail', 'v1', credentials=get_credentials())
    q = 'subject:"How to build a Team OS in Claude Code"'
    results = service.users().messages().list(userId='me', q=q, maxResults=1).execute()
    messages = results.get('messages', [])
    
    if not messages:
        print("No message found.")
        return

    m = service.users().messages().get(userId='me', id=messages[0]['id']).execute()
    body = get_body(m['payload'])
    print(body if body else m.get('snippet'))

if __name__ == '__main__':
    main()
