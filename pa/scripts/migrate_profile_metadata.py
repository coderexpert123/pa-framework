#!/usr/bin/env python3
"""
Profile metadata migration script.

Adds temporal metadata and derived keys to legacy profile.json entries.
Backward-compatible: does not remove or modify existing fields, only adds missing ones.
"""

import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict


def resolve_paths() -> Dict[str, str]:
    """Resolve profile and archive paths using PA_HOME precedence."""
    pa_home = os.environ.get("PA_HOME", os.path.expanduser("~/.pa"))
    return {
        "profile_path": os.path.join(pa_home, "data", "profile.json"),
    }


def derive_key_from_text(text: str, existing_keys: set) -> str:
    """
    Derive a deterministic key from entry text (no LLM).

    Heuristic:
    - Normalize: lowercase, strip, take first 80 chars
    - Strip common prefixes ("Active interest/trait discovered:", etc.)
    - Extract first 2-3 meaningful words
    - Form key: "<word1>-<word2>-<word3>" truncated to 80 chars
    - Dedup: append "-2", "-3", etc. if key collides

    Examples:
    - "Active interest/trait discovered: Pursuing the Procam Slam 2026-2027"
      → "procam-slam-2026-2027"
    - "Wants easiest run on Sundays to visit Lalbaug with family"
      → "sunday-easiest-run"
    - "Dietary & Fueling Constraints: ..."
      → "dietary-fueling-constraints"
    """
    if not text:
        return "unknown"

    # Normalize: lowercase and strip
    text_lower = text.lower().strip()

    # Strip common prefixes
    prefixes_to_strip = [
        "active interest/trait discovered:",
        "active interest/goal:",
        "fitness & family:",
        "dietary & fueling constraints:",
        "goal:",
        "preference:",
    ]

    for prefix in prefixes_to_strip:
        if text_lower.startswith(prefix):
            text_lower = text_lower[len(prefix):].strip()

    # Take first 80 chars for processing
    text_lower = text_lower[:80]

    # Extract meaningful words (letters, numbers, hyphens, apostrophes)
    # Filter out stop words and very short words
    stop_words = {
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
        "be", "have", "has", "had", "do", "does", "did", "will", "would",
        "could", "should", "may", "might", "must", "shall", "can", "need",
        "wants", "wanting", "when", "where", "while", "about", "into",
    }

    words = re.findall(r"[a-z0-9]+(?:[-'][a-z0-9]+)*", text_lower)
    meaningful_words = [w for w in words if w not in stop_words and len(w) > 1]

    # Form key from first 2-3 meaningful words
    if len(meaningful_words) >= 3:
        key_parts = meaningful_words[:3]
    elif len(meaningful_words) == 2:
        key_parts = meaningful_words
    elif len(meaningful_words) == 1:
        key_parts = meaningful_words
    else:
        # Fallback: use first word from original text
        all_words = re.findall(r"[a-z0-9]+", text_lower)
        key_parts = all_words[:2] if len(all_words) >= 2 else all_words[:1]

    key = "-".join(key_parts)

    # Truncate to 80 chars
    key = key[:80]

    # Dedup: append suffix if key collides
    if key in existing_keys:
        suffix = 2
        while f"{key}-{suffix}" in existing_keys:
            suffix += 1
        key = f"{key}-{suffix}"

    return key


def migrate_profile(profile_path: str, dry_run: bool = False) -> Dict[str, int]:
    """
    Migrate profile.json to add temporal metadata and derived keys.

    For each entry in history[]:
    - Adds valid_from from timestamp if missing
    - Adds valid_until=null if missing
    - Adds superseded_by=null if missing
    - Derives key from text if missing (deterministic heuristic)
    - Adds source="legacy" if missing
    - Adds source_ref=null if missing

    Args:
        profile_path: Path to profile.json
        dry_run: If True, print changes without writing

    Returns:
        Summary dict: {total, migrated, already_current, keys_derived}
    """
    with open(profile_path, "r", encoding="utf-8") as f:
        profile = json.load(f)

    history = profile.get("history", [])
    total = len(history)
    migrated = 0
    keys_derived = 0
    already_current = 0

    # Track derived keys for dedup
    derived_keys = set()

    for entry in history:
        entry_migrated = False

        # Check if already has all new fields
        if all(
            field in entry
            for field in ["valid_from", "valid_until", "superseded_by", "key", "source", "source_ref"]
        ):
            already_current += 1
            # Still add to keys set for dedup checking
            if "key" in entry:
                derived_keys.add(entry["key"])
            continue

        # Add valid_from from timestamp
        if "valid_from" not in entry:
            if "timestamp" in entry:
                entry["valid_from"] = entry["timestamp"]
            else:
                entry["valid_from"] = datetime.now().strftime("%Y-%m-%d")
            entry_migrated = True

        # Add valid_until
        if "valid_until" not in entry:
            entry["valid_until"] = None
            entry_migrated = True

        # Add superseded_by
        if "superseded_by" not in entry:
            entry["superseded_by"] = None
            entry_migrated = True

        # Derive key
        if "key" not in entry:
            text = entry.get("update", "")
            derived_key = derive_key_from_text(text, derived_keys)
            entry["key"] = derived_key
            derived_keys.add(derived_key)
            keys_derived += 1
            entry_migrated = True
        else:
            derived_keys.add(entry["key"])

        # Add source
        if "source" not in entry:
            entry["source"] = "legacy"
            entry_migrated = True

        # Add source_ref
        if "source_ref" not in entry:
            entry["source_ref"] = None
            entry_migrated = True

        if entry_migrated:
            migrated += 1
            if dry_run:
                print(f"Would migrate entry: {entry.get('update', '')[:60]}...")
                print(f"  key={entry.get('key')}, valid_from={entry.get('valid_from')}")

    if dry_run:
        print(f"\nDry run summary:")
        print(f"  Total entries: {total}")
        print(f"  Would migrate: {migrated}")
        print(f"  Already current: {already_current}")
        print(f"  Keys to derive: {keys_derived}")
        return {
            "total": total,
            "migrated": migrated,
            "already_current": already_current,
            "keys_derived": keys_derived,
        }

    # Atomic write (reuse learn_agent.py's pattern)
    profile_dir = os.path.dirname(profile_path)
    fd, tmp_path = tempfile.mkstemp(dir=profile_dir, prefix=".profile_", suffix=".json")

    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(profile, f, indent=2, ensure_ascii=False)

        # Replace atomically
        os.replace(tmp_path, profile_path)
    except Exception:
        # Clean up tmp file on error
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise

    print(f"Migration complete:")
    print(f"  Total entries: {total}")
    print(f"  Migrated: {migrated}")
    print(f"  Already current: {already_current}")
    print(f"  Keys derived: {keys_derived}")

    return {
        "total": total,
        "migrated": migrated,
        "already_current": already_current,
        "keys_derived": keys_derived,
    }


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Migrate profile.json to add temporal metadata and keys"
    )
    parser.add_argument(
        "--profile",
        default=resolve_paths()["profile_path"],
        help="Path to profile.json",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print proposed changes without writing",
    )

    args = parser.parse_args()

    if not os.path.exists(args.profile):
        print(f"Error: Profile file not found: {args.profile}", file=sys.stderr)
        sys.exit(1)

    try:
        migrate_profile(args.profile, dry_run=args.dry_run)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
