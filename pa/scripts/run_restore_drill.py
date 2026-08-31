#!/usr/bin/env python3
"""Monthly restore drill: verify backup integrity without touching live data.

Downloads the newest pa-secrets-*.pab from Drive, decrypts to a C: temp dir,
validates file formats (env parses, JSON parses, sqlite magic header), and
reports duration + pass/fail. Never touches ~/.pa.

Fitness blob quarterly check: pa-fitness-*.fab mtime only, verify header,
skip download if older than 90 days (report age).

Usage:
    python run_restore_drill.py --verify-only

Exit codes:
    0 = pass
    1 = fail (decrypt failed, validation failed, or missing prerequisites)
"""
import io
import os
import sys
import json
import gzip
import tarfile
import tempfile
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Reuse crypto from backup_secrets. Degrade-not-crash: without the optional
# cryptography dependency the drill reports skipped (exit 0) instead of
# crashing the maintenance job — environments that never installed
# pa/scripts/requirements.txt get a clean skip, not a failure page.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from backup_secrets import MAGIC, decrypt, _drive, _get_or_create_folder  # noqa: E402
except ImportError as _e:
    if 'cryptography' in str(_e):
        print(json.dumps({
            "status": "skipped",
            "reason": "cryptography not installed — run: pip install -r pa/scripts/requirements.txt",
        }))
        sys.exit(0)
    raise

DRIVE_ROOT_FOLDER = "PA_Backups"
DRIVE_SUB_FOLDER = "Secrets_Backups"
FITNESS_BLOB_PREFIX = "pa-fitness-"
FITNESS_HEADER_MAGIC = b"PAFIT\x01"


def _pa_home() -> Path:
    return Path(os.environ.get("PA_HOME") or (Path.home() / ".pa"))


def _secret(key: str, required: bool = True):
    """Load a secret from environment or ~/.pa/secrets.env."""
    if key in os.environ:
        return os.environ[key]

    secrets_file = _pa_home() / "secrets.env"
    try:
        for line in secrets_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == key:
                return v.strip().strip("\"'")
    except FileNotFoundError:
        pass

    if required:
        raise RuntimeError(f"{key} not set in environment or ~/.pa/secrets.env")
    return None


def download_newest_backup() -> tuple[bytes, str, datetime]:
    """Download the newest pa-secrets-*.pab from Drive.

    Returns:
        (blob_bytes, filename, created_time)
    """
    passphrase = _secret("PA_BACKUP_PASSPHRASE")
    if not passphrase or len(passphrase) < 16:
        raise RuntimeError("PA_BACKUP_PASSPHRASE missing or too short (need >=16 chars)")

    service = _drive()
    root = _get_or_create_folder(service, DRIVE_ROOT_FOLDER)
    folder_id = _get_or_create_folder(service, DRIVE_SUB_FOLDER, root)

    # List files, newest first
    res = service.files().list(
        q=f"'{folder_id}' in parents and trashed = false and name contains 'pa-secrets-'",
        orderBy="createdTime desc",
        fields="files(id,name,createdTime)"
    ).execute()

    files = res.get("files", [])
    if not files:
        raise RuntimeError("No pa-secrets-*.pab backups found in Drive")

    newest = files[0]
    filename = newest["name"]
    created_time = datetime.fromisoformat(newest["createdTime"].replace('Z', '+00:00'))

    # Download
    file_id = newest["id"]
    request = service.files().get_media(fileId=file_id)
    blob = request.execute()

    return blob, filename, created_time


def verify_extracted_members(out_dir: Path) -> list[str]:
    """Validate extracted files by format.

    Returns list of validation errors (empty = all passed).
    """
    errors = []

    for path in out_dir.rglob("*"):
        if not path.is_file():
            continue

        # Check .env files parse as KEY=VALUE
        if path.suffix == ".env":
            try:
                content = path.read_text(encoding="utf-8")
                for line in content.splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    if not k.strip():
                        errors.append(f"{path.relative_to(out_dir)}: empty key")
            except Exception as e:
                errors.append(f"{path.relative_to(out_dir)}: env parse error: {e}")

        # Check .json files parse
        elif path.suffix == ".json":
            try:
                json.loads(path.read_text(encoding="utf-8"))
            except Exception as e:
                errors.append(f"{path.relative_to(out_dir)}: JSON parse error: {e}")

        # Check .db/.sqlite files start with SQLite magic header
        elif path.suffix in (".db", ".sqlite", ".sqlite3"):
            try:
                header = path.read_bytes()[0:16]
                # SQLite magic: "SQLite format 3\0"
                if not header.startswith(b"SQLite format 3"):
                    errors.append(f"{path.relative_to(out_dir)}: missing SQLite magic header")
            except Exception as e:
                errors.append(f"{path.relative_to(out_dir)}: read error: {e}")

    return errors


def restore_and_verify(blob: bytes) -> tuple[bool, list[str]]:
    """Decrypt and verify a backup blob without touching ~/.pa.

    Returns:
        (success, error_list)
    """
    passphrase = _secret("PA_BACKUP_PASSPHRASE")
    if not passphrase or len(passphrase) < 16:
        raise RuntimeError("PA_BACKUP_PASSPHRASE missing or too short (need >=16 chars)")

    # Decrypt
    try:
        plaintext = decrypt(blob, passphrase)
    except Exception as e:
        return False, [f"Decryption failed: {e}"]

    # Extract to temp dir (C: temp, not ~/.pa)
    # System temp (honors TMP/TEMP env) — portable: a hardcoded drive root
    # breaks POSIX, and this machine's slower data drive is avoided by setting
    # TMP in the invoking environment, not in code.
    with tempfile.TemporaryDirectory(prefix="pa_restore_drill_") as temp_dir:
        out_dir = Path(temp_dir)

        # Decompress and untar
        raw = gzip.decompress(plaintext)
        extracted = []
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r") as tar:
            for member in tar.getmembers():
                # Path-traversal guard
                dest = (out_dir / member.name).resolve()
                if not str(dest).startswith(str(out_dir.resolve())):
                    continue
                tar.extract(member, out_dir, filter="data")
                extracted.append(member.name)

        # Verify formats
        errors = verify_extracted_members(out_dir)

        return len(errors) == 0, errors


def check_fitness_blob() -> dict:
    """Check the newest fitness blob age and header.

    Returns dict with status, age_days, or error.
    """
    try:
        service = _drive()
        root = _get_or_create_folder(service, DRIVE_ROOT_FOLDER)

        # Find newest pa-fitness-*.fab
        res = service.files().list(
            q=f"'{root}' in parents and trashed = false and name contains 'pa-fitness-'",
            orderBy="createdTime desc",
            fields="files(id,name,createdTime)"
        ).execute()

        files = [f for f in res.get("files", []) if f["name"].startswith(FITNESS_BLOB_PREFIX)]
        if not files:
            return {"status": "not_found"}

        newest = files[0]
        created_time = datetime.fromisoformat(newest["createdTime"].replace('Z', '+00:00'))
        age_days = (datetime.now(timezone.utc) - created_time).days

        # Download and check header only
        file_id = newest["id"]
        request = service.files().get_media(fileId=file_id)
        header = request.execute(length=8)

        if header != FITNESS_HEADER_MAGIC:
            return {"status": "invalid_header", "filename": newest["name"]}

        return {"status": "ok", "filename": newest["name"], "age_days": age_days}

    except Exception as e:
        return {"status": "error", "error": str(e)}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    if "--verify-only" not in sys.argv:
        print("Usage: python run_restore_drill.py --verify-only", file=sys.stderr)
        return 2

    started = datetime.now(timezone.utc)

    try:
        # Download and verify secrets backup
        blob, filename, created_time = download_newest_backup()
        print(f"📥 Downloaded `{filename}` (created {created_time.isoformat()})", file=sys.stderr)

        success, errors = restore_and_verify(blob)

        if success:
            print(f"✅ Restore drill passed: {filename} validated successfully")
        else:
            print(f"❌ Restore drill failed: {filename} validation errors:", file=sys.stderr)
            for err in errors:
                print(f"  - {err}", file=sys.stderr)

        # Check fitness blob (quarterly, but we run monthly and report age)
        fitness_info = check_fitness_blob()
        if fitness_info["status"] == "ok":
            age = fitness_info["age_days"]
            if age > 90:
                print(f"⚠️  Fitness blob {fitness_info['filename']} is {age} days old (stale)", file=sys.stderr)
            else:
                print(f"✅ Fitness blob {fitness_info['filename']} is {age} days old (fresh)")
        elif fitness_info["status"] == "not_found":
            print("⚠️  No fitness blob found (may not exist yet)", file=sys.stderr)
        elif fitness_info["status"] == "invalid_header":
            print(f"❌ Fitness blob {fitness_info['filename']} has invalid header", file=sys.stderr)
        else:
            print(f"⚠️  Fitness blob check failed: {fitness_info.get('error', 'unknown')}", file=sys.stderr)

        # Report duration
        duration = (datetime.now(timezone.utc) - started).total_seconds()
        print(f"⏱️  Duration: {duration:.2f}s")

        return 0 if success else 1

    except Exception as e:
        print(f"❌ Restore drill failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
