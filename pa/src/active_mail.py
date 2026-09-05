import os
import json
from datetime import datetime, timedelta
from gmail_utils import get_gmail_service, get_message_body

def analyze_active_mail():
    active_threads = []
    try:
        service = get_gmail_service()
        # Look at the last 7 days of sent mail and direct personal mail
        # Excluding promotions, updates, social, and automated noreply addresses
        one_week_ago = (datetime.now() - timedelta(days=7)).strftime('%Y/%m/%d')
        query = f"(in:sent OR (to:me -category:promotions -category:updates -category:social -from:noreply)) after:{one_week_ago}"
        
        results = service.users().messages().list(userId='me', q=query, maxResults=20).execute()
        messages = results.get('messages', [])
        
        for msg in messages:
            msg_full = service.users().messages().get(userId='me', id=msg['id'], format='full').execute()
            headers = {h['name']: h['value'] for h in msg_full['payload']['headers']}
            
            subject = headers.get('Subject', 'No Subject')
            sender = headers.get('From', 'Unknown')
            to = headers.get('To', 'Unknown')
            
            # Additional filter to skip calendar invites or automated stuff that might slip through
            if 'calendar-notification' in sender.lower() or 'invite' in subject.lower():
                continue
                
            body = get_message_body(msg_full['payload'])
            
            active_threads.append({
                "subject": subject,
                "from": sender,
                "to": to,
                "body_sample": body[:1000] # Take a sample to analyze character/interests
            })
    except Exception as e:
        print(f"[active_mail] Live Gmail fetch unavailable: {e}")
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        emails_file = os.path.join(repo_root, 'projects', 'daily-mail-brief', 'emails.json')
        if os.path.exists(emails_file):
            try:
                with open(emails_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                emails = data.get('emails', [])
                for em in emails:
                    sender = em.get('from', 'Unknown')
                    subject = em.get('subject', 'No Subject')
                    to = em.get('to', 'Unknown')
                    if em.get('in_inbox') and em.get('gmail_category') != 'promotions':
                        active_threads.append({
                            "subject": subject,
                            "from": sender,
                            "to": to,
                            "body_sample": em.get('snippet', '')
                        })
            except Exception as fe:
                print(f"[active_mail] Fallback cache load failed: {fe}")
        
    print("--- ACTIVE MAIL DATA START ---")
    print(json.dumps(active_threads, indent=2))
    print("--- ACTIVE MAIL DATA END ---")

if __name__ == "__main__":
    analyze_active_mail()
