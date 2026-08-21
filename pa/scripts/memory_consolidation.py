#!/usr/bin/env python3
"""
Memory consolidation post-processor.

Deterministic Python script that processes profile candidates from the LLM
extraction staging file, applies them to profile.json via consolidate_fact(),
and routes conflicts to review-digest-pending.jsonl.

Called by the memory-consolidation skill (Step 5) after LLM extraction.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

# Add pa/src to path for learn_agent import
SCRIPT_DIR = Path(__file__).parent
SRC_DIR = SCRIPT_DIR.parent / 'src'
sys.path.insert(0, str(SRC_DIR))

import learn_agent


def resolve_paths(staging_date: Optional[str] = None) -> Dict[str, str]:
    """Resolve all file paths for the consolidation pipeline.

    Uses the same precedence as learn_agent.py:
    1. PA_PROFILE_PATH env var (if set)
    2. PA_HOME env var + data/profile.json
    3. Default ~/.pa/data/profile.json
    """
    pa_home = os.environ.get('PA_HOME', os.path.expanduser('~/.pa'))

    profile_path = os.environ.get('PA_PROFILE_PATH') or os.path.join(
        pa_home, 'data', 'profile.json'
    )

    archive_path = os.environ.get('PA_PROFILE_ARCHIVE_PATH') or os.path.join(
        os.path.dirname(profile_path), 'profile-history-archive.jsonl'
    )

    review_pending_path = os.path.join(pa_home, 'review-digest-pending.jsonl')
    consolidation_audit_path = os.path.join(pa_home, 'consolidation-audit.jsonl')

    # Staging file path: ~/.pa/consolidation-staging-YYYY-MM-DD.jsonl
    if staging_date:
        staging_path = os.path.join(pa_home, f'consolidation-staging-{staging_date}.jsonl')
    else:
        # Default to today's date if not specified
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        staging_path = os.path.join(pa_home, f'consolidation-staging-{today}.jsonl')

    return {
        'profile': profile_path,
        'archive': archive_path,
        'review_pending': review_pending_path,
        'consolidation_audit': consolidation_audit_path,
        'staging': staging_path,
        'pa_home': pa_home
    }


def read_staging_file(path: str) -> List[Dict]:
    """Read and parse JSONL staging file.

    Skips unparseable lines (same torn-line tolerance as learn_agent.py's
    archive reader). Returns list of candidate dicts.

    Args:
        path: Path to the JSONL staging file

    Returns:
        List of parsed candidate dicts (empty if file doesn't exist)
    """
    candidates = []

    if not os.path.exists(path):
        return candidates

    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    candidate = json.loads(line)
                    candidates.append(candidate)
                except json.JSONDecodeError:
                    # Skip unparseable lines (torn-line guard)
                    print(f"Warning: Skipping unparseable line {line_num} in staging file", file=sys.stderr)
                    continue
    except FileNotFoundError:
        # Empty staging file is valid (no facts extracted today)
        pass

    return candidates


def process_profile_candidates(
    candidates: List[Dict],
    audit_callback: Callable[[Dict], None],
    dry_run: bool = False
) -> Dict[str, int]:
    """Process profile candidates through consolidate_fact().

    For each candidate where sink is "profile" or "both" and resolution.type
    is not "contradiction": call consolidate_fact() and append audit entry.

    Args:
        candidates: List of candidate dicts from staging file
        audit_callback: Function to call with each audit entry
        dry_run: If True, skip all consolidate_fact calls

    Returns:
        Summary dict with counts: {added: N, superseded: N, conflict: N, skipped: N}
    """
    summary = {'added': 0, 'superseded': 0, 'conflict': 0, 'skipped': 0}

    for candidate in candidates:
        sink = candidate.get('sink')
        resolution = candidate.get('resolution', {})
        resolution_type = resolution.get('type') if isinstance(resolution, dict) else None

        # Skip KB-only candidates
        if sink == 'kb':
            continue

        # Route contradictions to conflict handling
        if resolution_type == 'contradiction':
            summary['conflict'] += 1
            audit_entry = {
                'ts': datetime.now(timezone.utc).isoformat(),
                'action': 'conflict',
                'fact_key': candidate.get('key'),
                'fact_text': candidate.get('text'),
                'category': candidate.get('category'),
                'sink': sink,
                'source': candidate.get('source'),
                'superseded_key': None,
                'superseded_text': None,
                'conflict_detail': {
                    'new_text': candidate.get('text'),
                    'existing_text': candidate.get('existing_text', ''),
                    'existing_valid_from': candidate.get('existing_valid_from')
                }
            }
            audit_callback(audit_entry)
            continue

        # Process profile or both candidates (new or supersede)
        if sink in ('profile', 'both'):
            if dry_run:
                # Dry-run mode: skip consolidate_fact call
                summary['added'] += 1
                continue

            try:
                result = learn_agent.consolidate_fact(candidate)
                action = result.get('action')

                if action in ('added', 'superseded'):
                    summary[action] += 1
                    audit_entry = {
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': action,
                        'fact_key': candidate.get('key'),
                        'fact_text': candidate.get('text'),
                        'category': candidate.get('category'),
                        'sink': sink,
                        'source': candidate.get('source'),
                        'superseded_key': result.get('archived_entry', {}).get('key') if action == 'superseded' else None,
                        'superseded_text': result.get('archived_entry', {}).get('update') if action == 'superseded' else None,
                        'conflict_detail': None
                    }
                    audit_callback(audit_entry)
                elif action == 'skipped':
                    summary['skipped'] += 1
                elif action == 'conflict':
                    summary['conflict'] += 1

            except Exception as e:
                print(f"Error processing candidate: {e}", file=sys.stderr)
                summary['skipped'] += 1

    return summary


def write_conflicts(candidates: List[Dict], path: str) -> int:
    """Write contradiction candidates to review-digest-pending.jsonl.

    Append-only, with the same torn-line guard as learn_agent.py.

    Args:
        candidates: List of candidate dicts from staging file
        path: Path to review-digest-pending.jsonl

    Returns:
        Number of conflicts written
    """
    conflicts_written = 0
    conflict_candidates = [
        c for c in candidates
        if c.get('resolution', {}).get('type') == 'contradiction'
    ]

    if not conflict_candidates:
        return 0

    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)

        # Generate conflict IDs (simple counter)
        for i, candidate in enumerate(conflict_candidates):
            conflict_entry = {
                'id': f'cf-{datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")}-{i:03d}',
                'created_at': datetime.now(timezone.utc).isoformat(),
                'resolved': False,
                'resolved_at': None,
                'resolution': None,
                'key': candidate.get('key'),
                'new_text': candidate.get('text'),
                'existing_text': candidate.get('existing_text', ''),
                'existing_valid_from': candidate.get('existing_valid_from'),
                'category': candidate.get('category'),
                'source': candidate.get('source'),
                'source_ref': candidate.get('source_ref')
            }

            # Append with torn-line guard
            with open(path, 'a+b') as f:
                f.seek(0, os.SEEK_END)
                if f.tell() > 0:
                    f.seek(-1, os.SEEK_END)
                    if f.read(1) != b'\n':
                        f.write(b'\n')
                f.write((json.dumps(conflict_entry) + '\n').encode('utf-8'))
                f.flush()
                os.fsync(f.fileno())

            conflicts_written += 1

    except Exception as e:
        print(f"Error writing conflicts to pending file: {e}", file=sys.stderr)

    return conflicts_written


def write_audit_entries(entries: List[Dict], path: str) -> int:
    """Append audit entries to consolidation-audit.jsonl.

    Args:
        entries: List of audit entry dicts
        path: Path to consolidation-audit.jsonl

    Returns:
        Number of entries written
    """
    if not entries:
        return 0

    try:
        d = os.path.dirname(path)
        if d:
            os.makedirs(d, exist_ok=True)

        with open(path, 'a+b') as f:
            f.seek(0, os.SEEK_END)
            if f.tell() > 0:
                f.seek(-1, os.SEEK_END)
                if f.read(1) != b'\n':
                    f.write(b'\n')
            for entry in entries:
                f.write((json.dumps(entry) + '\n').encode('utf-8'))
            f.flush()
            os.fsync(f.fileno())

        return len(entries)

    except Exception as e:
        print(f"Error writing audit entries: {e}", file=sys.stderr)
        return 0


def resolve_accepted_conflicts(
    pending_path: str,
    profile_callback: Callable[[Dict], Dict],
    audit_callback: Callable[[Dict], None]
) -> Dict[str, int]:
    """Read review-digest-pending.jsonl and apply accepted conflicts.

    Finds entries with resolution="accepted" and resolved=true, calls
    profile_callback to apply the now-accepted fact, and marks entry as
    processed (adds applied_at field).

    Args:
        pending_path: Path to review-digest-pending.jsonl
        profile_callback: Function to call for each accepted conflict
        audit_callback: Function to call with audit entry

    Returns:
        Summary dict: {applied: N, rejected: N, pending: N, error: N}
    """
    summary = {'applied': 0, 'rejected': 0, 'pending': 0, 'error': 0}

    if not os.path.exists(pending_path):
        return summary

    try:
        # Read all pending entries
        entries = []
        with open(pending_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    entries.append(entry)
                except json.JSONDecodeError:
                    continue

        # Process accepted conflicts
        updated_entries = []
        for entry in entries:
            if entry.get('resolved') and entry.get('resolution') == 'accepted':
                # Apply the accepted fact
                candidate = {
                    'key': entry.get('key'),
                    'text': entry.get('new_text'),
                    'valid_from': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
                    'source': entry.get('source'),
                    'source_ref': entry.get('source_ref')
                }

                try:
                    result = profile_callback(candidate)
                    entry['applied_at'] = datetime.now(timezone.utc).isoformat()
                    summary['applied'] += 1

                    # Audit the application
                    audit_entry = {
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': 'conflict_accepted',
                        'fact_key': candidate.get('key'),
                        'fact_text': candidate.get('text'),
                        'category': entry.get('category'),
                        'sink': 'profile',
                        'source': candidate.get('source'),
                        'superseded_key': None,
                        'superseded_text': None,
                        'conflict_detail': None
                    }
                    audit_callback(audit_entry)

                except Exception as e:
                    print(f"Error applying accepted conflict: {e}", file=sys.stderr)
                    summary['error'] += 1

            elif entry.get('resolved') and entry.get('resolution') == 'rejected':
                summary['rejected'] += 1
            else:
                summary['pending'] += 1

            updated_entries.append(entry)

        # Write back the updated entries
        if updated_entries:
            with open(pending_path, 'w', encoding='utf-8') as f:
                for entry in updated_entries:
                    f.write(json.dumps(entry) + '\n')
                f.flush()
                os.fsync(f.fileno())

    except Exception as e:
        print(f"Error resolving accepted conflicts: {e}", file=sys.stderr)

    return summary


def main():
    """CLI entry point for memory consolidation post-processor."""
    parser = argparse.ArgumentParser(
        description='Process memory consolidation candidates from LLM extraction'
    )
    parser.add_argument(
        '--staging',
        required=True,
        help='Path to staging JSONL file (e.g., ~/.pa/consolidation-staging-2026-08-18.jsonl)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Print summary without modifying profile.json or writing audit files'
    )

    args = parser.parse_args()

    # Extract date from staging filename for path resolution
    staging_basename = os.path.basename(args.staging)
    staging_date = None
    if staging_basename.startswith('consolidation-staging-') and staging_basename.endswith('.jsonl'):
        staging_date = staging_basename[len('consolidation-staging-'):-len('.jsonl')]

    paths = resolve_paths(staging_date)

    # Override staging path from CLI arg
    paths['staging'] = args.staging

    # Read staging file
    candidates = read_staging_file(paths['staging'])

    if not candidates:
        print("No candidates to process (staging file empty or not found)")
        return 0

    # Collect audit entries in memory
    audit_entries = []

    def audit_callback(entry: Dict):
        audit_entries.append(entry)

    # Process profile candidates
    if args.dry_run:
        print(f"DRY RUN: Would process {len(candidates)} candidates")
        summary = process_profile_candidates(candidates, audit_callback, dry_run=True)
    else:
        summary = process_profile_candidates(candidates, audit_callback, dry_run=False)

        # Write conflicts to pending file
        conflicts_written = write_conflicts(candidates, paths['review_pending'])

        # Write audit entries
        write_audit_entries(audit_entries, paths['consolidation_audit'])

        # Resolve accepted conflicts
        resolve_summary = resolve_accepted_conflicts(
            paths['review_pending'],
            learn_agent.consolidate_fact,
            audit_callback
        )

        print(f"\nConsolidation complete:")
        print(f"  Added: {summary['added']}")
        print(f"  Superseded: {summary['superseded']}")
        print(f"  Conflicts: {summary['conflict']} (written to {paths['review_pending']})")
        print(f"  Skipped: {summary['skipped']}")
        if resolve_summary['applied'] > 0:
            print(f"\nAccepted conflicts applied: {resolve_summary['applied']}")
            print(f"Rejected conflicts: {resolve_summary['rejected']}")
            print(f"Pending conflicts: {resolve_summary['pending']}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
