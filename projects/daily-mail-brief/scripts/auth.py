import os
import sys
from googleapiclient.discovery import build

sys.path.insert(0, os.environ.get("PA_HOME", os.path.join(os.path.expanduser("~"), ".pa")))
from google_auth import get_credentials


def get_gmail_service():
    return build('gmail', 'v1', credentials=get_credentials())
