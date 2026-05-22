#!/usr/bin/env python3
"""
Upload a plan Markdown file to Google Drive (Personal Assistant/Plans folder)
and return the shareable view link.

Usage:
    python upload_plan.py <path_to_plan.md>

Prints the Google Drive view link to stdout.
"""
import sys
import os
import re
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path.home() / '.pa'))
from google_auth import get_drive_service

PLANS_FOLDER_ID = os.environ.get('PA_PLANS_DRIVE_FOLDER_ID')
if not PLANS_FOLDER_ID:
    print(
        'Error: PA_PLANS_DRIVE_FOLDER_ID env var not set.\n'
        'Create a Google Drive folder for plans, copy its ID from the URL '
        '(the part after /folders/), and set it in ~/.pa/secrets.env:\n'
        '  PA_PLANS_DRIVE_FOLDER_ID=<your-folder-id>',
        file=sys.stderr,
    )
    sys.exit(1)


def upload_plan(file_path: str) -> str:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f'Plan file not found: {file_path}')

    svc = get_drive_service()

    # Upload as plain text (Markdown), not converted to Google Doc
    # so the .md content is preserved exactly
    from googleapiclient.http import MediaFileUpload
    media = MediaFileUpload(str(path), mimetype='text/plain', resumable=False)

    file_meta = {
        'name': path.name,
        'parents': [PLANS_FOLDER_ID],
    }

    uploaded = svc.files().create(
        body=file_meta,
        media_body=media,
        fields='id,webViewLink'
    ).execute()

    file_id = uploaded['id']

    # Set permission: anyone with link can view
    svc.permissions().create(
        fileId=file_id,
        body={'type': 'anyone', 'role': 'reader'}
    ).execute()

    return uploaded['webViewLink']


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <plan_file.md>', file=sys.stderr)
        sys.exit(1)

    link = upload_plan(sys.argv[1])
    print(link)
