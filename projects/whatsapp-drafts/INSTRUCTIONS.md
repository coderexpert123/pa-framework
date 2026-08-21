# WhatsApp Drafting Protocol

Follow this protocol exactly for every message in the `whatsapp-drafts` topic.

## Addressing the message

The first line of the dictated text must specify the recipient:

- **Typed format**: `to: hema 4521` (first line, followed by the actual message)
- **Spoken format**: the user may dictate the recipient naturally — "send to mom …", "tell Hema Shah 4521 …". YOU extract the name and optional last 2-4 digits from the spoken text (transcription is literal; nothing converts it for you).

**Recipient resolution**: Recipient is a NAME (full or partial). Digits (optional, last 2-4 of phone number) disambiguate when multiple contacts share similar names.

Examples:
- `to: mom` — resolves by alias lookup
- `to: john 4521` — resolves by name "john" with phone ending in 4521
- `send to John Smith 4521` — same as above (spoken format)

If the name is unknown or ambiguous:
1. Run `python projects/whatsapp-drafts/scripts/build_link.py <name> [digits]` to resolve
2. The script will list close candidates (no match) or all matches (ambiguous)
3. Relay the script's candidate list verbatim to the user
4. The user answers with a digit-hint or full name

**Automatic Preferred Number & Alias Persistence**:
Whenever a contact is inferred, disambiguated via digit hint, or confirmed by the user (e.g. "Alex" -> "Alexander Smith 3141", "mom" -> "Jane Doe 4521"), the assistant MUST automatically persist the alias and preferred phone number immediately:
```bash
python projects/whatsapp-drafts/scripts/contacts.py add <alias> <phone> --name "<display_name>"
```
This ensures future drafts to that alias or preferred contact resolve instantly without requiring disambiguation or digit hints again.

The directory (imported from Google) supplies full names; the relationship vocabulary (mom, dad, boss, nicknames, spoken names) accumulates in aliases over time.

**Initial import**: To populate the directory from Google Contacts, run:
```bash
python projects/whatsapp-drafts/scripts/import_google.py
```
(This requires re-authentication with the new `contacts.readonly` scope — use the Telegram `/auth` flow after operator approval.)

## Polish rules

Clean up the transcribed draft:

1. **Preserve the dictated language** — Hindi, Marathi, English, or mixed. Do NOT translate unless explicitly asked.
2. **Preserve names, numbers, and amounts verbatim** — do not "correct" them.
3. **Fix disfluencies, punctuation, and paragraphing** for readability.
4. **Remove the recipient line** — the "to: mom" line is NOT part of the draft.

## Building the link

Never construct a wa.me URL by hand. Use the deterministic script:

```bash
python projects/whatsapp-drafts/scripts/build_link.py <name> [digits]
```

Pipe the FINAL polished text to STDIN. The script prints the link to STDOUT.

Example:
```bash
echo "Hi Mom, how are you?" | python projects/whatsapp-drafts/scripts/build_link.py mom
```

## Output shape

Your reply should have exactly this format:

```
<polished draft text (plain text)>

https://wa.me/...
```

- Draft on its own (plain text, no markdown)
- Blank line
- The wa.me link on its own line

If the draft was truncated for length, add a one-line note after the link: "or edit and send manually"

## Failure modes

- **Unknown name**: Run `build_link.py` to get close candidates; relay them to the user
- **Ambiguous name**: Run `build_link.py` to get all matches; relay them to the user with their masked phone suffixes
- **Scripts crash (no output/traceback)**: Tell the user the script crashed instead of hand-building any URL
- **Graceful error (exit 1 with a guidance message)**: Relay the message verbatim
- **No transcription**: The bot's existing error path already covers this

## Commands

The user may say:
- "add contact <alias> <phone>" — optionally with `--name <display_name>` for manual entries
- "list contacts" — shows display_name (if present) and masked phone
- "search contacts <substring>" — find contacts by name or alias
- "remove contact <alias>"
- "import contacts" — run the Google import (requires re-auth approval)

Execute via `python projects/whatsapp-drafts/scripts/contacts.py <command> ...` and relay the output.

## Important

- NEVER construct a wa.me URL yourself — always use the script
- NEVER invent or recall a phone number from memory — always look it up via `contacts.py list` or the resolver output
- Always invoke scripts with absolute or repo-relative paths from the repo root (LLM workers run from repo root due to the shim-cwd rule)
- Directory import (`import_google.py`) upserts into `data/contacts.json` by normalized phone, preserving manually-added entries — it's safe to re-run
