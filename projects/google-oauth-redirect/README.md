# Google OAuth Redirect Bridge

This is a static bridge page for the Telegram/mobile Google OAuth flow.

## What it does

Google redirects the user back here with `?code=...&state=...`. The page turns
that into a Telegram-ready command:

```text
/auth <code> <state>
```

The user copies that command and pastes it into the Telegram bot. The bot then
exchanges the code for tokens and optionally resumes the blocked action.

## Deploying

Any static host works:

- GitHub Pages
- Cloudflare Pages
- Netlify
- any HTTPS web server

## Requirements

1. The deployed URL must be added to the Google OAuth client's authorized
   redirect URIs.
2. Your deployment must set `GOOGLE_AUTH_REDIRECT_URI` in `~/.pa/secrets.env`
   to that exact HTTPS URL.
3. The Telegram bot must expose the `/auth` command and have access to the
   corresponding `finish_google_telegram_reauth.py` script.

## Notes

- The page is intentionally static: no backend, no secrets, no token exchange.
- It only copies the command back to the user; all sensitive work happens on
  the local PA machine after the user pastes `/auth ...` into Telegram.
