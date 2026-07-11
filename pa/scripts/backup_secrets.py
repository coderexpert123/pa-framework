#!/usr/bin/env python3
"""Weekly encrypted backup of the secret-class files to Google Drive.

The one durability gap git can't close: `~/.pa/secrets.env`, the Google
OAuth token/credentials, `pii-tripwires.txt`, and the `D:/gemini-shim`
wrappers are single-copy on local disk and (correctly) never committed to
any repo. This bundles them, encrypts with AES-256-GCM (scrypt-derived key,
pure `cryptography` — no external binary), and uploads to Drive.

Threat model — honest about what this does and doesn't do:
  - Protects against DISK FAILURE (restore the blob from Drive) and against
    DRIVE / Google-account COMPROMISE (the blob is ciphertext at rest).
  - Does NOT protect against machine compromise: the plaintext secrets and
    the passphrase both already live on this machine. Encryption only earns
    its keep off-machine.
  - PA_BACKUP_PASSPHRASE must therefore be stored in TWO places: `~/.pa/
    secrets.env` (so the weekly unattended run can encrypt) AND your password
    manager (so a total machine loss is still decryptable). Losing the
    passphrase makes every blob permanently unreadable — there is no recovery.

Restore: `python restore_secrets.py <downloaded.pab> <output-dir>`.

Blob format (all binary, concatenated):
    b"PABKUP\x01"  magic + version (7 bytes)
    salt           16 bytes  (scrypt)
    nonce          12 bytes  (AES-GCM)
    ciphertext+tag rest      (GCM tag is the trailing 16 bytes)
The plaintext is a gzip-compressed tar of the manifest, each member stored
at a repo-relative-ish arcname so restore is unambiguous.
"""
import io
import os
import sys
import gzip
import tarfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"PABKUP\x01"
SALT_LEN = 16
NONCE_LEN = 12
SCRYPT_N = 2 ** 15
SCRYPT_R = 8
SCRYPT_P = 1
KEY_LEN = 32
KEEP_LAST = 8  # ~2 months of weekly backups
DRIVE_ROOT_FOLDER = "Personal_Assistant"
DRIVE_SUB_FOLDER = "Secrets_Backups"


def _pa_home() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa"))


_SECRETS_CACHE = None


def _load_secrets() -> dict:
    path = _pa_home() / "secrets.env"
    out = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return out


def _secret(key: str, required: bool = True):
    global _SECRETS_CACHE
    if key in os.environ:
        return os.environ[key]
    if _SECRETS_CACHE is None:
        _SECRETS_CACHE = _load_secrets()
    if key in _SECRETS_CACHE:
        return _SECRETS_CACHE[key]
    if required:
        raise RuntimeError(f"{key} not set in environment or ~/.pa/secrets.env")
    return None


def build_manifest() -> list:
    """Return [(absolute_path, arcname)] of every secret-class file that exists.

    Missing files are skipped (a fresh machine may lack some) — but the caller
    checks that at least the core secrets.env was captured.
    """
    home = _pa_home()
    entries: list = []

    pa_files = [
        "secrets.env", "google-token.json", "google-credentials.json",
        "google-credentials-telegram.json", "google-telegram-auth.json",
        "google_auth.py", "reauth_google.py", "oauth_resume_hook.py",
        "pii-tripwires.txt",
    ]
    for name in pa_files:
        p = home / name
        if p.is_file():
            entries.append((p, f"pa/{name}"))

    shim = Path(os.environ.get("PA_GEMINI_SHIM_DIR", "D:/gemini-shim"))
    if shim.is_dir():
        for p in sorted(shim.iterdir()):
            if p.is_file():
                entries.append((p, f"gemini-shim/{p.name}"))

    return entries


def _pack(entries: list) -> bytes:
    """gzip(tar) the manifest deterministically (fixed mtime → reproducible)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for path, arcname in entries:
            info = tarfile.TarInfo(name=arcname)
            data = path.read_bytes()
            info.size = len(data)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def encrypt(plaintext: bytes, passphrase: str) -> bytes:
    salt = os.urandom(SALT_LEN)
    key = Scrypt(salt=salt, length=KEY_LEN, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P).derive(
        passphrase.encode("utf-8"))
    nonce = os.urandom(NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plaintext, MAGIC)
    return MAGIC + salt + nonce + ct


def decrypt(blob: bytes, passphrase: str) -> bytes:
    if blob[:len(MAGIC)] != MAGIC:
        raise ValueError("Not a PA secrets backup (bad magic) or wrong file.")
    off = len(MAGIC)
    salt = blob[off:off + SALT_LEN]; off += SALT_LEN
    nonce = blob[off:off + NONCE_LEN]; off += NONCE_LEN
    ct = blob[off:]
    key = Scrypt(salt=salt, length=KEY_LEN, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P).derive(
        passphrase.encode("utf-8"))
    # AESGCM.decrypt raises InvalidTag on wrong passphrase OR tampering — both fatal.
    return AESGCM(key).decrypt(nonce, ct, MAGIC)


def build_blob(passphrase: str) -> tuple:
    entries = build_manifest()
    arcnames = [a for _, a in entries]
    if not any(a == "pa/secrets.env" for a in arcnames):
        raise RuntimeError(
            "Refusing to back up: secrets.env not found in the manifest — "
            "nothing meaningful to protect. Check PA_HOME.")
    return encrypt(_pack(entries), passphrase), arcnames


def _drive():
    sys.path.insert(0, str(Path.home() / ".pa"))
    import google_auth  # noqa: E402
    return google_auth.get_drive_service()


def _get_or_create_folder(service, name, parent_id=None):
    q = (f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' "
         f"and trashed = false")
    if parent_id:
        q += f" and '{parent_id}' in parents"
    res = service.files().list(q=q, spaces="drive", fields="files(id)").execute()
    files = res.get("files", [])
    if files:
        return files[0]["id"]
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
    if parent_id:
        meta["parents"] = [parent_id]
    return service.files().create(body=meta, fields="id").execute()["id"]


def _upload_and_rotate(service, folder_id, filename, blob):
    from googleapiclient.http import MediaIoBaseUpload
    media = MediaIoBaseUpload(io.BytesIO(blob), mimetype="application/octet-stream")
    service.files().create(
        body={"name": filename, "parents": [folder_id]},
        media_body=media, fields="id").execute()

    res = service.files().list(
        q=f"'{folder_id}' in parents and trashed = false",
        orderBy="createdTime desc", fields="files(id,name)").execute()
    stale = res.get("files", [])[KEEP_LAST:]
    for f in stale:
        try:
            service.files().delete(fileId=f["id"]).execute()
        except Exception:  # noqa: BLE001 — best-effort rotation, never fail the backup
            pass
    return len(stale)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    passphrase = _secret("PA_BACKUP_PASSPHRASE")
    if not passphrase or len(passphrase) < 16:
        print("PA_BACKUP_PASSPHRASE missing or too short (need >=16 chars) — "
              "refusing to create a weakly-encrypted backup.", file=sys.stderr)
        return 1

    blob, arcnames = build_blob(passphrase)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    filename = f"pa-secrets-{ts}.pab"

    service = _drive()
    root = _get_or_create_folder(service, DRIVE_ROOT_FOLDER)
    folder = _get_or_create_folder(service, DRIVE_SUB_FOLDER, root)
    pruned = _upload_and_rotate(service, folder, filename, blob)

    msg = (f"🔐 *Secrets backup uploaded*\n\n`{filename}` "
           f"({len(blob):,} bytes, {len(arcnames)} files)\n"
           f"Drive: {DRIVE_ROOT_FOLDER}/{DRIVE_SUB_FOLDER}/"
           + (f"\nPruned {pruned} old backup(s), keeping {KEEP_LAST}." if pruned else ""))
    print(msg)
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
        from telegram_notify import notify  # noqa: E402
        notify(msg, chat_id=os.environ.get("PA_ALERTS_CHAT_ID") or None,
               thread_id=os.environ.get("PA_ALERTS_THREAD_ID") or None)
    except Exception as e:  # noqa: BLE001 — the backup itself succeeded; notice is best-effort
        print(f"(backup ok; Telegram notice failed: {e})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
