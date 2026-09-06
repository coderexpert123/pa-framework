import os
import base64
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from bs4 import BeautifulSoup

TOKEN_FILE = os.path.join(os.path.expanduser('~'), '.pa', 'google-token.json')
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

import json

def get_gmail_service():
    if not os.path.exists(TOKEN_FILE):
        raise FileNotFoundError(f"Token file not found: {TOKEN_FILE}")
    with open(TOKEN_FILE, 'r', encoding='utf-8') as f:
        token_data = json.load(f)
    try:
        creds = Credentials.from_authorized_user_info(token_data, SCOPES)
    except Exception:
        creds = Credentials(
            token=token_data.get('token'),
            refresh_token=token_data.get('refresh_token'),
            token_uri=token_data.get('token_uri'),
            client_id=token_data.get('client_id'),
            client_secret=token_data.get('client_secret'),
            scopes=token_data.get('scopes', SCOPES)
        )
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    if not creds or not creds.valid:
        raise RuntimeError("Google token is expired or invalid. Re-authentication required.")
    return build('gmail', 'v1', credentials=creds)

def get_message_body(payload):
    if 'parts' in payload:
        for part in payload['parts']:
            if part['mimeType'] == 'text/plain':
                data = part['body'].get('data')
                if data: return base64.urlsafe_b64decode(data).decode()
            elif part['mimeType'] == 'text/html':
                data = part['body'].get('data')
                if data:
                    html = base64.urlsafe_b64decode(data).decode()
                    return BeautifulSoup(html, 'html.parser').get_text()
    elif 'body' in payload:
        data = payload['body'].get('data')
        if data: return base64.urlsafe_b64decode(data).decode()
    return ""
