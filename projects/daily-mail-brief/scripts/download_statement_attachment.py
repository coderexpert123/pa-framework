import os
import sys
import base64
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# Add auth to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from auth import get_gmail_service

def download_attachment(msg_id, store_dir):
    service = get_gmail_service()
    try:
        msg = service.users().messages().get(userId='me', id=msg_id).execute()
    except Exception as e:
        print(f"Error fetching message {msg_id}: {e}")
        return None
    
    payload = msg.get('payload', {})
    parts = payload.get('parts', [])
    
    all_parts = []
    if parts:
        all_parts.extend(parts)
    elif payload.get('body') and payload.get('filename'):
        all_parts.append(payload)
        
    for p in all_parts:
        if p.get('mimeType') == 'multipart/related':
            all_parts.extend(p.get('parts', []))

    for part in all_parts:
        if part.get('filename') and part.get('body').get('attachmentId'):
            attachment_id = part['body']['attachmentId']
            filename = part['filename']
            print(f"Downloading {filename}...")
            
            attachment = service.users().messages().attachments().get(
                userId='me', messageId=msg_id, id=attachment_id).execute()
            file_data = base64.urlsafe_b64decode(attachment['data'].encode('UTF-8'))
            
            if not os.path.exists(store_dir):
                os.makedirs(store_dir)
                
            path = os.path.join(store_dir, filename)
            with open(path, 'wb') as f:
                f.write(file_data)
            print(f"Saved to {path}")
            return path
    
    print("No attachment found in message.")
    return None

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python download_statement_attachment.py <msg_id>")
        sys.exit(1)
        
    msg_id = sys.argv[1]
    store_dir = os.path.join(os.path.dirname(SCRIPT_DIR), "temp_statements")
    download_attachment(msg_id, store_dir)
