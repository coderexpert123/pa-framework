# Contacts Data Directory

This directory stores `contacts.json` — the contact registry for WhatsApp drafting.

## contacts.json format

```json
{
  "contacts": [
    {
      "alias": "mom",
      "phone": "+919876543210"
    }
  ]
}
```

- `alias`: lowercase identifier (case-insensitive lookup)
- `phone`: full international format (`+` followed by 8-15 digits)

## This file is NOT committed

`contacts.json` is gitignored — it contains personal contact information.

The operator seeds it manually via `python scripts/contacts.py add <alias> <phone>`.

## Scripts that read/write this

- `scripts/contacts.py` — add/list/remove commands (atomic writes via tmp + os.replace)
- `scripts/build_link.py` — reads to resolve alias → phone for link building

Both scripts resolve the path relative to their own location, so invocations work from the repo root AND the project directory.
