# Google OAuth setup for pa-framework

> Audience: anyone running a skill that needs Gmail / Drive / Docs access (e.g., the `daily-mail-brief` sample).

The framework ships scripts that depend on Google OAuth at `~/.pa/google_auth.py`. This directory provides those scripts as templates you copy into your `PA_HOME` (`~/.pa/`).

## What's here

| File | Purpose |
|---|---|
| `google_auth.py` | Shared module — exposes `get_credentials()`, `get_gmail_service()`, `get_drive_service()`, `get_docs_service()`. Auto-refreshes tokens with retry on transient errors. |
| `reauth_google.py` | One-time browser-based desktop authentication. Run when token is missing or revoked. |
| `telegram_oauth_resume_hook.example.py` | Example private resume hook for the Telegram/mobile auth flow. |
| `requirements.txt` | Python dependencies (`google-auth`, `google-auth-oauthlib`, `google-api-python-client`). |

## One-time setup

### 1. Create an OAuth Client ID in Google Cloud Console

1. Visit https://console.cloud.google.com and create a new project (or pick an existing one).
2. **APIs & Services → Library** — enable the APIs you need: Gmail API, Google Drive API, Google Docs API (and Google Chat API if using chat-related scopes).
3. **APIs & Services → OAuth consent screen**:
   - User Type: **External**
   - Publishing status: **Testing** is fine for personal use (no review needed).
   - Add yourself as a Test User in the consent screen settings.
4. **APIs & Services → Credentials → Create Credentials → OAuth Client ID**:
   - Application type: **Desktop app**
   - Name: anything (e.g., `pa-framework-personal`)
   - Click **Create** → on the popup, click **Download JSON**.
5. Save the downloaded file as `~/.pa/google-credentials.json`.

### 2. Install Python dependencies + copy scripts

From the pa-framework root:

```
pip install -r examples/oauth/requirements.txt
```

```powershell
# PowerShell (Windows)
Copy-Item examples/oauth/google_auth.py $HOME/.pa/google_auth.py
Copy-Item examples/oauth/reauth_google.py $HOME/.pa/reauth_google.py
```

```bash
# Bash / POSIX
cp examples/oauth/google_auth.py ~/.pa/google_auth.py
cp examples/oauth/reauth_google.py ~/.pa/reauth_google.py
```

If you're running the `daily-mail-brief` sample, its `projects/daily-mail-brief/requirements.txt` already includes the OAuth deps — `pip install -r projects/daily-mail-brief/requirements.txt` also works.

### 3. Run the auth flow

```powershell
python ~/.pa/reauth_google.py
```

A browser window opens. Sign in with your Google account. Approve the requested scopes. The token is written to `~/.pa/google-token.json`.

### 4. Verify

```powershell
# Should print the expiry timestamp:
python -c "from pathlib import Path; import sys; sys.path.insert(0, str(Path.home() / '.pa')); from google_auth import get_credentials; print('Token expires:', get_credentials().expiry)"
```

Or just try running a sample skill that uses OAuth (e.g., `daily-mail-brief`).

## Scopes

`google_auth.py`'s `ALL_SCOPES` list covers 7 scopes (Chat read, Drive, Gmail send/read/compose, Docs). To narrow:

1. Edit `~/.pa/google_auth.py` — remove unwanted entries from `ALL_SCOPES`.
2. Delete `~/.pa/google-token.json` to force re-auth.
3. Re-run `python ~/.pa/reauth_google.py`.

The new token will be limited to your edited scope set.

## Optional: Telegram/mobile re-auth flow

Use this when you want a blocked Google-backed skill to recover from your phone
through Telegram instead of running `reauth_google.py` locally.

### Files involved

- `pa/scripts/start_google_telegram_reauth.py`
- `pa/scripts/finish_google_telegram_reauth.py`
- `projects/google-oauth-redirect/index.html`
- `projects/telegram-bot/src/main.ts` (`/auth` handling)
- `telegram_oauth_resume_hook.example.py` → copy to `~/.pa/oauth_resume_hook.py`

### One-time setup

1. Create a **Web application** OAuth client in Google Cloud Console.
2. Save that JSON as `~/.pa/google-credentials-telegram.json`.
3. Deploy `projects/google-oauth-redirect/` to a public HTTPS URL.
4. Add that exact URL to the OAuth client's authorized redirect URIs.
5. Set `GOOGLE_AUTH_REDIRECT_URI=<your deployed URL>` in `~/.pa/secrets.env`.
6. Copy this example hook:

```powershell
Copy-Item examples/oauth/telegram_oauth_resume_hook.example.py $HOME/.pa/oauth_resume_hook.py
```

7. Customize `~/.pa/oauth_resume_hook.py` so it understands your own
   `resume_action` payloads.

### Runtime flow

1. A project detects expired/revoked Google auth and calls
   `start_google_telegram_reauth.py` with:
   - the deployed redirect URI
   - destination chat/thread
   - an opaque `resume_action` JSON object
2. The script generates the Google consent URL and stores pending auth state in
   `~/.pa/google-telegram-auth.json`.
3. After the user authorizes, Google redirects to the static bridge page.
4. The bridge page renders a full Telegram command:

```text
/auth <code> <state>
```

5. The user pastes that command into Telegram.
6. The bot exchanges the code via `finish_google_telegram_reauth.py`.
7. If `~/.pa/oauth_resume_hook.py` exists (or `PA_TELEGRAM_OAUTH_RESUME_HOOK`
   is configured), the bot passes the saved `resume_action` to that hook.

### Contract

- The public framework treats `resume_action` as opaque metadata.
- Your private hook decides what action types exist and how to resume them.
- Storage paths stay private under `~/.pa/` by default, but can be overridden
  via:
  - `GOOGLE_TELEGRAM_CREDENTIALS_FILE`
  - `GOOGLE_TELEGRAM_TOKEN_FILE`
  - `GOOGLE_TELEGRAM_STATE_FILE`

## Token rotation (when the client is compromised)

If your OAuth client ID is exposed (e.g., committed to a repo by accident):

1. Visit https://console.cloud.google.com/apis/credentials.
2. Select the compromised OAuth Client ID → **Delete**.
3. Create a new Desktop OAuth Client ID (step 1 above).
4. Download the new JSON → overwrite `~/.pa/google-credentials.json`.
5. Delete `~/.pa/google-token.json` (the old token is now bound to a dead client).
6. Re-run `python ~/.pa/reauth_google.py`.

All existing skills resume working without code changes — they read the new credentials/token automatically.

## Overwriting existing setup

If you already have `~/.pa/google_auth.py` or `~/.pa/reauth_google.py` from a previous installation, the copy commands above will overwrite them. To preserve your customized version first:

```powershell
# PowerShell
Copy-Item $HOME/.pa/google_auth.py $HOME/.pa/google_auth.py.bak
Copy-Item $HOME/.pa/reauth_google.py $HOME/.pa/reauth_google.py.bak
```

```bash
# Bash / POSIX
cp ~/.pa/google_auth.py ~/.pa/google_auth.py.bak
cp ~/.pa/reauth_google.py ~/.pa/reauth_google.py.bak
```

## Troubleshooting

- **"Missing credentials file"** at startup → you haven't completed step 1 above. Download the JSON from Cloud Console and save as `~/.pa/google-credentials.json`.
- **"invalid_grant" or "refresh_token failure"** → token revoked or scope changed. Delete `~/.pa/google-token.json` and re-run `reauth_google.py`.
- **Browser doesn't open during `reauth_google.py`** → ensure you're running on a machine with a GUI browser. For headless servers, see Google's `run_console()` alternative (requires `google-auth-oauthlib >= 0.4`).
- **403 errors on API calls** → check the OAuth consent screen has the right scopes added, and that you're a Test User on the consent screen.

## See also

- `examples/skills/daily-mail-brief/` — sample skill that uses these helpers
- `projects/daily-mail-brief/scripts/auth.py` — thin wrapper that imports `google_auth.get_credentials` after adding `PA_HOME` to `sys.path`
- `docs/CONFIGURATION.md` — `secrets.env` reference (for non-OAuth secrets like `TELEGRAM_BOT_TOKEN`)
