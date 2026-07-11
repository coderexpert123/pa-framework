#!/usr/bin/env python3
"""Restore a PA secrets backup blob produced by backup_secrets.py.

Usage:
    python restore_secrets.py <backup.pab> <output-dir> [--force]

Prompts for the passphrase (or reads PA_BACKUP_PASSPHRASE) — the SAME one
used at backup time, from your password manager after a machine loss.
Extracts the encrypted tar into <output-dir>/{pa,gemini-shim}/... You then
copy pa/* into ~/.pa/ and gemini-shim/* into your shim directory by hand
(deliberately manual — restoring live secrets is not something to automate
onto whatever machine happens to run this).

Refuses to overwrite a non-empty <output-dir> unless --force.
"""
import io
import os
import sys
import gzip
import tarfile
import getpass
from pathlib import Path

# Reuse the exact crypto + format from the backup writer (same directory).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backup_secrets import decrypt  # noqa: E402


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv
    if len(args) != 2:
        print(__doc__)
        return 2
    blob_path, out_dir = Path(args[0]), Path(args[1])

    if not blob_path.is_file():
        print(f"No such backup file: {blob_path}", file=sys.stderr)
        return 1
    if out_dir.exists() and any(out_dir.iterdir()) and not force:
        print(f"Output dir {out_dir} is not empty — pass --force to proceed.", file=sys.stderr)
        return 1

    passphrase = os.environ.get("PA_BACKUP_PASSPHRASE") or getpass.getpass("Backup passphrase: ")
    try:
        plaintext = decrypt(blob_path.read_bytes(), passphrase)
    except Exception as e:  # noqa: BLE001 — wrong passphrase / tampering / bad file
        print(f"Decryption failed: {e}\n(wrong passphrase, or the file is corrupt/tampered)",
              file=sys.stderr)
        return 1

    out_dir.mkdir(parents=True, exist_ok=True)
    raw = gzip.decompress(plaintext)
    extracted = []
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r") as tar:
        for member in tar.getmembers():
            # Path-traversal guard — never trust archive member names blindly.
            dest = (out_dir / member.name).resolve()
            if not str(dest).startswith(str(out_dir.resolve())):
                print(f"Skipping unsafe member path: {member.name}", file=sys.stderr)
                continue
            tar.extract(member, out_dir, filter="data")  # 3.12+ safe-extraction filter
            extracted.append(member.name)

    print(f"Restored {len(extracted)} file(s) into {out_dir}:")
    for name in extracted:
        print(f"  {name}")
    print("\nNext: copy pa/* into ~/.pa/ and gemini-shim/* into your shim dir by hand.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
