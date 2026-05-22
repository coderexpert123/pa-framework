import os
import sys
from pathlib import Path

# Add project scripts (this file's directory) to path
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# Set PA_HOME default if not already set (don't clobber)
os.environ.setdefault("PA_HOME", os.path.expanduser("~/.pa"))

from auth import get_gmail_service
import base64

def get_body(msg_id):
    service = get_gmail_service()
    msg = service.users().messages().get(userId='me', id=msg_id, format='full').execute()
    
    payload = msg.get('payload', {})
    
    def extract_text(payload):
        parts = payload.get('parts', [])
        body = ""
        if not parts:
            data = payload.get('body', {}).get('data', '')
            if data:
                return base64.urlsafe_b64decode(data).decode('utf-8', errors='ignore')
        else:
            # Prefer plain text
            for part in parts:
                if part['mimeType'] == 'text/plain':
                    data = part['body'].get('data', '')
                    if data:
                        return base64.urlsafe_b64decode(data).decode('utf-8', errors='ignore')
                elif part['mimeType'] == 'multipart/alternative':
                    res = extract_text(part)
                    if res: return res
            # Fallback to HTML if no plain text
            for part in parts:
                if part['mimeType'] == 'text/html':
                    data = part['body'].get('data', '')
                    if data:
                        return base64.urlsafe_b64decode(data).decode('utf-8', errors='ignore')
        return ""

    return extract_text(payload)

if __name__ == "__main__":
    msg_id = "19d892ce8657676b"
    body = get_body(msg_id)
    print(body)
