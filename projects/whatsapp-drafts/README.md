# WhatsApp Drafts

Voice-to-WhatsApp drafting system with one-tap send links.

## What this does

Dictate a voice note in Telegram topic `whatsapp-drafts`, get a polished draft back with a `wa.me` deep link that pre-fills the message to your chosen contact. Tap the link, review in WhatsApp, and send manually.

The bot does NOT send on your behalf — the final Send tap is yours (show-before-send by construction).

## Adding contacts

Contacts are stored in `data/contacts.json` (gitignored). Add contacts via:

1. **In the whatsapp-drafts topic**: Say "add contact mom +001234567890"
2. **Directly via script**: `python scripts/contacts.py add mom +001234567890`

Phone format: `+` followed by 8-15 digits (full international format).

To list contacts: `python scripts/contacts.py list` (shows last 4 digits only)

## wa.me prefill caveat

The `wa.me` deep link pre-fills WhatsApp's message composer. Verify it works on your device once — some older WhatsApp versions or regions may have limited support.

If the prefill doesn't work, the polish step still gives you a clean draft you can copy-paste manually.

## Future

Auto-send/Path-1 (WhatsApp Web API integration on a secondary number) is planned — see plans/ thread 6089 for details.
