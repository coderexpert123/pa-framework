# Natural Language Reminders

Scheduled and natural-language reminder system for `pa-framework`.

## Overview

The reminders system manages due reminders stored in `~/.pa/reminders.json` and automatically delivers alerts via Telegram using the central notification substrate.

## Architecture

1. **`add_reminder.py`**: Adds a new reminder with atomic write (`reminders.json.tmp` -> `os.replace`).
2. **`process_reminders.py`**: Evaluates due items against current timestamp, deletes them from `reminders.json` first, then delivers each one through the shared `pa/src/telegram_notify.py` sender (`send_text`). Every reminder carries a ref-ID, and the **Done / 1 h / Tomorrow** keyboard renders only when the record requires a user decision (see Buttons); one failed send no longer blocks the rest of the batch.
3. **Scheduler Integration**: Polled every minute by the `reminders` lane of `pa catchup --loop`. An older install may also run the legacy `PA-Catchup-Reminders` task (`pa catchup --topic reminders`); retire it through `docs/catchup-watchdog.md`, "Retiring the legacy reminders task".
4. **Store claim lock**: every read-modify-write of `~/.pa/reminders.json` runs under `reminders_store_lock` (`add_reminder.py`), a sibling `reminders.json.lock` created exclusively and treated as abandoned after 60 s, and only when the recorded holder PID is confirmed dead (an unreadable PID falls back to a 900 s hard ceiling). `process_reminders.py` holds it only while it partitions due reminders and writes the rest back, never while sending, so concurrent processors deliver each due reminder exactly once.

## Buttons

A reminder that requires a user decision carries three inline buttons. The keyboard renders only when the record sets `requires_user_decision`; with the key absent, text-only reminders render it and executable reminders do not.

- **Done** — acknowledges the reminder; nothing is re-created, since the due entry is already gone.
- **1 h** — re-adds the same message one hour from now.
- **Tomorrow** — re-adds the same message at 9 AM the next day.

A tap re-creates the reminder through the unchanged `add_reminder.py` atomic writer above, so a snoozed reminder is just a new entry in `reminders.json`.

## CLI Usage

### Add a reminder
```bash
python projects/reminders/add_reminder.py <due_at_iso> <message> <chat_id> [thread_id] [--resume-action-json <json>] [--no-keyboard]
```
- Example:
  ```bash
  python projects/reminders/add_reminder.py "2026-08-21T18:00:00+05:30" "Call doctor" "-1001234567890" 123
  ```
- `--no-keyboard` stores `requires_user_decision: false` on the record, suppressing the Done / 1 h / Tomorrow buttons for system-executed work.

### Add an executable reminder (AI-185)
```bash
python projects/reminders/add_reminder.py <due_at_iso> <message> <chat_id> [thread_id] \
  --resume-action-json '{"type": "topic_resume", "prompt": "<single-line instruction>"}'
```
The prompt is validated at mint time (closed `topic_resume` shape: exactly the keys `type` + `prompt`; single line, <=500 chars, must not start with `/`) and stored on the record as `resume_action`; `message` remains the human label. At fire time the payload is appended to `~/.pa/pending-reminder-resume.json` for the bot's `reminder-resume-drain` job to inject as a system turn, and the operator receives a `⏰ *Reminder (dispatched to worker):*` notice with **no** inline keyboard (snoozing after the prompt is queued would be misleading). If the queue append fails, delivery is never lost: the reminder falls back to the plain text send, with the keyboard only when the record `requires_user_decision`.

### Add an executable reminder scoped to a voice-inbox conversation (AI-conversation-context reminder fix, 2026-09-12)
```bash
python projects/reminders/add_reminder.py <due_at_iso> <message> <chat_id> [thread_id] \
  --resume-action-json '{"type": "voice_inbox_resume", "conversation_id": "vi-<12 hex>", "prompt": "<single-line instruction>"}'
```
Sibling of `topic_resume` for a reminder about a pending decision that originated in a
voice-inbox UI conversation rather than a Telegram chat/topic — `topic_resume` has no
concept of a voice-inbox conversation id and can't survive that conversation's routing
moving between Telegram topics. Validated at mint time here (closed shape: exactly the
keys `type` + `conversation_id` + `prompt`; `conversation_id` must match `vi-<12 hex>`;
`prompt` single line, <=500 chars, must not start with `/` — byte-identical error strings
to the fire-time mirror in the bot's `oauth.ts` `validateVoiceInboxResumeAction`). At fire
time the drain type-branches on `resume_action.type` BEFORE the chat_id/`allowedChatIds`
check below (that check only applies to `topic_resume`'s Telegram delivery) and shells out
to `projects/voice-inbox/scripts/create_conversation_task.py --conversation-id <id> --text
<prompt>`, which looks up the conversation's CURRENT topic at fire time and appends a new
task into that same `conversation_id`. Any reminder about a pending decision must carry
one of these two resume payloads, scoped to wherever the request originated — a
plain-text-only reminder for that case is a mistake, not a valid shortcut.

### Process due reminders
```bash
python projects/reminders/process_reminders.py
```

## Storage Schema (`~/.pa/reminders.json`)
```json
[
  {
    "due_at": "2026-08-21T18:00:00+05:30",
    "message": "Call doctor",
    "chat_id": "-1001234567890",
    "thread_id": 123
  }
]
```
`requires_user_decision` is an optional key: `"requires_user_decision": false` suppresses the Done / 1 h / Tomorrow keyboard for system-executed work. When the key is absent, text-only reminders render the keyboard and executable reminders do not; all pre-AI-207 records keep that legacy default.
