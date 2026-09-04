#!/usr/bin/env python3
"""
Memory consolidation post-processor engine.

Deterministic pipeline that processes profile candidates from the LLM
extraction staging file, applies them to profile.json via an INJECTED
store, and routes conflicts to review-digest-pending.jsonl.

The engine is store-agnostic: `run(argv, store=...)` (or main(argv,
store=...)) receives the profile store as a dependency. The store supplies
`consolidate_fact(candidate)` — the write side of profile.json. Running
this file bare (no injected store) prints a pointer to the deployment
wrapper and exits 2; the deployment's wrapper (memory_consolidation_ops.py)
injects the real store.

Called by the memory-consolidation skill (Step 5) after LLM extraction,
through the deployment wrapper.
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional


def normalize_source_ref(value):
    """Coerce a candidate's source_ref into the canonical list-of-turn-pointers
    shape. Returns (normalized_list_or_None, has_user_evidence: bool).

    Accepts: the canonical list; a single dict (wrapped); a legacy string
    (kept verbatim as [{"legacy": "<string>"}], never discarded — older
    profiles may carry free-text pointers and destroying them would lose the
    only pointer they have). Anything else -> (None, False).
    A pointer counts as user evidence iff its role == 'user'.
    """
    if isinstance(value, list):
        if not all(isinstance(item, dict) for item in value):
            return None, False
        has_user_evidence = any(item.get('role') == 'user' for item in value)
        return value, has_user_evidence
    if isinstance(value, dict):
        return [value], value.get('role') == 'user'
    if isinstance(value, str):
        return [{'legacy': value}], False
    return None, False


def _atomic_write_json(path, data):
    """Write JSON atomically: unique same-directory tmp file + os.replace().
    A crash mid-write leaves the ORIGINAL file untouched (os.replace is atomic
    within one filesystem) instead of a truncated/corrupted JSON file. mkstemp
    (unique name) avoids two concurrent invocations colliding on a shared
    fixed tmp path; fsync flushes data before the rename so the replace can't
    land an empty file after a power loss."""
    d = os.path.dirname(path) or '.'
    fd, tmp_path = tempfile.mkstemp(dir=d, prefix=os.path.basename(path) + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def resolve_paths(staging_date: Optional[str] = None) -> Dict[str, str]:
    """Resolve all file paths for the consolidation pipeline.

    Path precedence:
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


def load_kb_authoritative_keys(pa_home: str) -> set[str]:
    """Load KB-authoritative key prefixes from registry.

    Missing file → empty set; malformed/non-JSON → empty set + one stderr line
    (fail-open, mirrors EXEMPT.json discipline).

    Args:
        pa_home: PA_HOME directory path

    Returns:
        Set of key prefixes (empty if registry missing/malformed)
    """
    registry_path = os.path.join(pa_home, 'kb-authoritative-keys.json')

    if not os.path.exists(registry_path):
        return set()

    try:
        with open(registry_path, 'r', encoding='utf-8') as f:
            registry = json.load(f)

        prefixes = registry.get('key_prefixes', [])
        if not isinstance(prefixes, list):
            print(f"Warning: kb-authoritative-keys.json key_prefixes is not a list", file=sys.stderr)
            return set()

        return set(prefixes)

    except (json.JSONDecodeError, IOError) as e:
        print(f"Warning: Failed to load kb-authoritative-keys.json: {e}", file=sys.stderr)
        return set()


def read_staging_file(path: str) -> List[Dict]:
    """Read and parse JSONL staging file.

    Skips unparseable lines (torn-line tolerance, matching the profile
    store's archive reader). Returns list of candidate dicts.

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
    dry_run: bool = False,
    kb_authoritative_registry: Optional[set[str]] = None,
    review_pending_path: Optional[str] = None,
    store: Optional[object] = None
) -> Dict[str, int]:
    """Process profile candidates through the injected store.

    For each candidate where sink is "profile" or "both" and resolution.type
    is not "contradiction": call store.consolidate_fact() and append audit
    entry.

    Args:
        candidates: List of candidate dicts from staging file
        audit_callback: Function to call with each audit entry
        dry_run: If True, skip all consolidate_fact calls
        kb_authoritative_registry: Set of KB-authoritative key prefixes (loaded in main)
        review_pending_path: Path to review-digest-pending.jsonl, needed to
            hold an assistant-originated candidate as unconfirmed (F2/AI-166,
            2026-08-24). None is tolerated (an agent_output candidate is then
            still counted and audited, just not durably written) so existing
            callers that never pass it do not crash.
        store: The injected profile store supplying consolidate_fact(candidate)
            (deployment wrapper supplies it; the real one is private). Required
            for any non-dry-run pass that reaches the apply path.

    Returns:
        Summary dict with counts: {added: N, superseded: N, conflict: N, skipped: N, adopted: N, folded: N, suppressed: N, unconfirmed: N}
    """
    summary = {'added': 0, 'superseded': 0, 'conflict': 0, 'skipped': 0, 'adopted': 0, 'folded': 0, 'suppressed': 0, 'unconfirmed': 0}

    for candidate in candidates:
        sink = candidate.get('sink')
        resolution = candidate.get('resolution', {})
        resolution_type = resolution.get('type') if isinstance(resolution, dict) else None

        # Skip KB-only candidates
        if sink == 'kb':
            continue

        # KB-authoritative suppression (AI-151)
        candidate_key = candidate.get('key', '')
        if kb_authoritative_registry and sink in ('profile', 'both'):
            matched_prefix = None
            for prefix in kb_authoritative_registry:
                if candidate_key.startswith(prefix):
                    matched_prefix = prefix
                    break

            if matched_prefix:
                summary['suppressed'] += 1
                audit_entry = {
                    'ts': datetime.now(timezone.utc).isoformat(),
                    'action': 'suppressed',
                    'fact_key': candidate_key,
                    'fact_text': candidate.get('text'),
                    'category': candidate.get('category'),
                    'sink': 'kb',
                    'source': candidate.get('source'),
                    'superseded_key': None,
                    'superseded_text': None,
                    'conflict_detail': {
                        'matched_prefix': matched_prefix,
                        'original_sink': sink
                    }
                }
                audit_callback(audit_entry)
                continue

        # Assistant-originated facts do not reach profile.json (F2, AI-166,
        # 2026-08-24 recall-traces wave). Only a candidate whose source_ref
        # evidence is PRESENT and exclusively non-user is held back; a
        # candidate with no source_ref at all keeps today's behaviour
        # (applied, counted by the validator as 'legacy' — D4.3/R8).
        normalized_ref, has_user_evidence = normalize_source_ref(candidate.get('source_ref'))
        provenance = 'agent_output' if (normalized_ref and not has_user_evidence) else 'user_stated'
        if provenance == 'agent_output':
            summary['unconfirmed'] += 1
            # Gated on dry_run (unlike the KB-suppression/contradiction
            # branches, which only append to the in-memory audit list): this
            # branch is the one place in this function that performs an
            # immediate disk write, and a --dry-run run must never mutate
            # ~/.pa/review-digest-pending.jsonl (spec gate 5.2 step 13 runs
            # dry-run against the REAL PA_HOME) — judgment call, flagged in
            # the WP-F report since §3.6's snippet does not show a dry_run
            # guard.
            if not dry_run and review_pending_path:
                write_unconfirmed(candidate, review_pending_path)
            audit_entry = {
                'ts': datetime.now(timezone.utc).isoformat(),
                'action': 'unconfirmed',
                'fact_key': candidate.get('key'),
                'fact_text': candidate.get('text'),
                'category': candidate.get('category'),
                'sink': 'review-pending',
                'source': candidate.get('source'),
                'superseded_key': None,
                'superseded_text': None,
                'conflict_detail': None
            }
            audit_callback(audit_entry)
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
                if store is None:
                    raise ValueError(
                        'memory_consolidation: store not injected '
                        '(deployment wrapper supplies it)'
                    )
                result = store.consolidate_fact(candidate)
                action = result.get('action')

                if action in ('added', 'superseded'):
                    summary[action] += 1
                    conflict_detail = None
                    if action == 'superseded' and result.get('note'):
                        conflict_detail = {'note': result.get('note')}

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
                        'conflict_detail': conflict_detail
                    }
                    audit_callback(audit_entry)
                elif action == 'adopted':
                    summary['adopted'] += 1
                    audit_entry = {
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': 'adopted',
                        'fact_key': candidate.get('key'),
                        'fact_text': result.get('adopted_entry', {}).get('update', candidate.get('text')),
                        'category': candidate.get('category'),
                        'sink': 'profile',
                        'source': 'learn',
                        'superseded_key': None,
                        'superseded_text': None,
                        'conflict_detail': None
                    }
                    audit_callback(audit_entry)
                elif action == 'folded':
                    summary['folded'] += 1
                    audit_entry = {
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': 'folded',
                        'fact_key': candidate.get('key'),
                        'fact_text': result.get('folded_entry', {}).get('update', candidate.get('text')),
                        'category': candidate.get('category'),
                        'sink': 'profile',
                        'source': 'learn',
                        'superseded_key': None,
                        'superseded_text': None,
                        'conflict_detail': {'folded_into': candidate.get('key')}
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

    Append-only, with the same torn-line guard as the profile store's
    archive writer.

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


def _read_pending_entries(path: str) -> List[Dict]:
    """Read every entry (cf- and uf- share this one file) from
    review-digest-pending.jsonl, skipping unparseable/torn lines. Missing
    file -> empty list, not an error."""
    entries = []
    if not os.path.exists(path):
        return entries
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return entries


def _write_all_pending(entries: List[Dict], path: str) -> None:
    """Rewrite review-digest-pending.jsonl from an in-memory entry list —
    read-all/write-all, matching resolve_accepted_conflicts's write-back
    (:549-555 in the pre-wave file). A full rewrite also normalizes away any
    torn trailing line from a previous crash."""
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        for entry in entries:
            f.write(json.dumps(entry) + '\n')
        f.flush()
        os.fsync(f.fileno())


def write_unconfirmed(candidate: Dict, path: str) -> bool:
    """Write (or refresh) one assistant-originated candidate into
    review-digest-pending.jsonl as an unconfirmed fact (F2/F3, AI-166,
    2026-08-24 recall-traces wave — no new ledger file, C25).

    Idempotent with refresh: if an unresolved 'uf-' entry with the same key
    AND the same new_text already exists, its created_at is rewritten to now
    instead of appending a duplicate — this is what keeps a persistently-
    inferred fact inside weekly_digest.py's frozen 7-day created_at cutoff
    (C25/R19). A different new_text for the same key appends a new entry.

    Returns True on success, False on any failure (mirrors write_conflicts).
    """
    try:
        key = candidate.get('key')
        new_text = candidate.get('text')
        now_iso = datetime.now(timezone.utc).isoformat()
        normalized_ref, _has_user_evidence = normalize_source_ref(candidate.get('source_ref'))

        entries = _read_pending_entries(path)

        for entry in entries:
            if (str(entry.get('id', '')).startswith('uf-')
                    and not entry.get('resolved', False)
                    and entry.get('key') == key
                    and entry.get('new_text') == new_text):
                entry['created_at'] = now_iso
                _write_all_pending(entries, path)
                return True

        existing_uf_count = sum(1 for e in entries if str(e.get('id', '')).startswith('uf-'))
        entry = {
            'id': f'uf-{datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")}-{existing_uf_count:03d}',
            'created_at': now_iso,
            'resolved': False,
            'resolved_at': None,
            'resolution': None,
            'key': key,
            'category': f"unconfirmed:{candidate.get('category')}",
            'new_text': new_text,
            'existing_text': '(assistant-originated — awaiting a user turn to confirm)',
            'existing_valid_from': None,
            'source': candidate.get('source'),
            'source_ref': normalized_ref,
            'provenance': 'agent_output',
            'valid_from': candidate.get('valid_from'),
        }
        entries.append(entry)
        _write_all_pending(entries, path)
        return True

    except Exception as e:
        print(f"Error writing unconfirmed fact to pending file: {e}", file=sys.stderr)
        return False


def read_unconfirmed_entries(path: str) -> List[Dict]:
    """Return every unresolved 'uf-' entry in review-digest-pending.jsonl —
    the cf- contradiction rows sharing the file are excluded."""
    entries = _read_pending_entries(path)
    return [
        e for e in entries
        if str(e.get('id', '')).startswith('uf-') and not e.get('resolved', False)
    ]


def promote_unconfirmed_facts(
    candidates: List[Dict],
    path: str,
    audit_callback: Callable[[Dict], None]
) -> Dict[str, int]:
    """Deterministically resolve any unconfirmed ('uf-') entry whose key is
    also present, WITH user evidence, in today's candidate list — the
    C25/R19 manual-confirmation-by-a-later-user-turn path. No LLM call.

    Never writes profile.json itself: the matching candidate proceeds through
    process_profile_candidates normally (its own source_ref carries user
    evidence, so it is not intercepted by F2) and lands the fact via the
    ordinary path — exactly one write, no double-apply.

    resolution is 'superseded-by-user-turn', not 'accepted', so
    resolve_accepted_conflicts's applied-again-on-a-later-run loop (which
    matches only resolution == 'accepted') can never re-apply it.

    Returns {'promoted': N}.
    """
    summary = {'promoted': 0}

    entries = _read_pending_entries(path)
    if not entries:
        return summary

    user_evidence_keys = set()
    for c in candidates:
        _normalized_ref, has_user_evidence = normalize_source_ref(c.get('source_ref'))
        if has_user_evidence and c.get('key'):
            user_evidence_keys.add(c['key'])

    if not user_evidence_keys:
        return summary

    changed = False
    now_iso = datetime.now(timezone.utc).isoformat()
    for entry in entries:
        if (str(entry.get('id', '')).startswith('uf-')
                and not entry.get('resolved', False)
                and entry.get('key') in user_evidence_keys):
            entry['resolved'] = True
            entry['resolution'] = 'superseded-by-user-turn'
            entry['resolved_at'] = now_iso
            changed = True
            summary['promoted'] += 1

            audit_entry = {
                'ts': now_iso,
                'action': 'promoted',
                'fact_key': entry.get('key'),
                'fact_text': entry.get('new_text'),
                'category': entry.get('category'),
                'sink': 'profile',
                'source': entry.get('source'),
                'superseded_key': None,
                'superseded_text': None,
                'conflict_detail': {'resolution': 'superseded-by-user-turn'}
            }
            audit_callback(audit_entry)

    if changed:
        _write_all_pending(entries, path)

    return summary


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


def validate_history_windows(
    profile_path: str,
    audit_callback: Callable[[Dict], None],
    dry_run: bool = False
) -> Dict[str, int]:
    """Validate and repair inverted validity windows in profile.json.

    Reads profile.json and checks each history entry for valid_from > valid_until.
    For inverted windows, collapses valid_until to valid_from (minimal repair).
    Writes back via _atomic_write_json only when repairs occurred.

    Args:
        profile_path: Path to profile.json
        audit_callback: Function to call with each audit entry
        dry_run: If True, check only without writing

    Returns:
        Dict with 'checked', 'repaired' and 'legacy' (no-source_ref orphan
        count, D4.3/F4 — counted only, never repaired) counts
    """
    counts = {'checked': 0, 'repaired': 0, 'legacy': 0}

    if not os.path.exists(profile_path):
        print(f"Warning: Profile file not found: {profile_path}", file=sys.stderr)
        return counts

    try:
        with open(profile_path, 'r', encoding='utf-8') as f:
            profile = json.load(f)

        history = profile.get('history', [])
        counts['checked'] = len(history)
        # Orphan count only (D4.3/F4) — no repair, no write, no audit entry.
        counts['legacy'] = sum(1 for entry in history if not entry.get('source_ref'))

        repairs_needed = []
        for entry in history:
            valid_from = entry.get('valid_from')
            valid_until = entry.get('valid_until')

            if valid_from and valid_until and valid_from > valid_until:
                repairs_needed.append(entry)

        if repairs_needed:
            counts['repaired'] = len(repairs_needed)

            for entry in repairs_needed:
                fact_key = entry.get('key')
                old_until = entry.get('valid_until')
                entry['valid_until'] = entry.get('valid_from')

                # Audit the repair
                audit_entry = {
                    'ts': datetime.now(timezone.utc).isoformat(),
                    'action': 'repaired',
                    'fact_key': fact_key,
                    'fact_text': entry.get('update', ''),
                    'category': entry.get('category'),
                    'sink': 'profile',
                    'source': entry.get('source', 'unknown'),
                    'superseded_key': None,
                    'superseded_text': None,
                    'conflict_detail': {
                        'field': 'valid_until',
                        'old': old_until,
                        'new': entry.get('valid_from'),
                        'surface': 'history'
                    }
                }
                audit_callback(audit_entry)

            # Write back only if repairs were made and not in dry-run mode
            if not dry_run:
                _atomic_write_json(profile_path, profile)

    except (json.JSONDecodeError, IOError) as e:
        print(f"Error reading profile for validation: {e}", file=sys.stderr)

    return counts


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


def main(argv=None, store=None):
    """CLI entry point for the memory consolidation post-processor.

    `store` supplies consolidate_fact(candidate) — the deployment wrapper
    (memory_consolidation_ops.py) injects it. Without a store the engine is
    a bare library: print the pointer and exit 2 rather than guess a default
    store path.
    """
    if store is None:
        print(
            'memory_consolidation: store not injected '
            '(deployment wrapper supplies it)',
            file=sys.stderr
        )
        return 2

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

    args = parser.parse_args(argv)

    # Extract date from staging filename for path resolution
    staging_basename = os.path.basename(args.staging)
    staging_date = None
    if staging_basename.startswith('consolidation-staging-') and staging_basename.endswith('.jsonl'):
        staging_date = staging_basename[len('consolidation-staging-'):-len('.jsonl')]

    paths = resolve_paths(staging_date)

    # Override staging path from CLI arg
    paths['staging'] = args.staging

    # Collect audit entries in memory
    audit_entries = []

    def audit_callback(entry: Dict):
        audit_entries.append(entry)

    # Run validity window validator FIRST (before staging read; runs even when staging is empty)
    validator_counts = validate_history_windows(
        paths['profile'],
        audit_callback,
        dry_run=args.dry_run
    )
    print(f"Validity windows: checked {validator_counts['checked']}, repaired {validator_counts['repaired']}, legacy {validator_counts['legacy']} (no source_ref)")

    # Read staging file
    candidates = read_staging_file(paths['staging'])

    if not candidates:
        print("No candidates to process (staging file empty or not found)")
        # Still write audit entries for any repairs made by validator
        if not args.dry_run and audit_entries:
            write_audit_entries(audit_entries, paths['consolidation_audit'])
        return 0

    # Load KB-authoritative registry once
    kb_authoritative_registry = load_kb_authoritative_keys(paths['pa_home'])

    # Process profile candidates
    if args.dry_run:
        print(f"DRY RUN: Would process {len(candidates)} candidates")
        summary = process_profile_candidates(
            candidates,
            audit_callback,
            dry_run=True,
            kb_authoritative_registry=kb_authoritative_registry,
            review_pending_path=paths['review_pending'],
            store=store
        )
    else:
        # Deterministic, no-LLM promotion pass (F3): resolves any unconfirmed
        # 'uf-' entry whose key now has user-turn evidence in today's
        # candidates, BEFORE process_profile_candidates runs so the matching
        # candidate lands its fact exactly once through the ordinary path.
        promote_summary = promote_unconfirmed_facts(
            candidates, paths['review_pending'], audit_callback
        )

        summary = process_profile_candidates(
            candidates,
            audit_callback,
            dry_run=False,
            kb_authoritative_registry=kb_authoritative_registry,
            review_pending_path=paths['review_pending'],
            store=store
        )

        # Write conflicts to pending file
        conflicts_written = write_conflicts(candidates, paths['review_pending'])

        # Write audit entries
        write_audit_entries(audit_entries, paths['consolidation_audit'])

        # Resolve accepted conflicts
        resolve_summary = resolve_accepted_conflicts(
            paths['review_pending'],
            store.consolidate_fact,
            audit_callback
        )

        print(f"\nConsolidation complete:")
        print(f"  Added: {summary['added']}")
        print(f"  Superseded: {summary['superseded']}")
        print(f"  Conflicts: {summary['conflict']} (written to {paths['review_pending']})")
        print(f"  Skipped: {summary['skipped']}")
        if summary.get('adopted', 0) > 0:
            print(f"  Adopted: {summary['adopted']}")
        if summary.get('folded', 0) > 0:
            print(f"  Folded: {summary['folded']}")
        if summary.get('suppressed', 0) > 0:
            print(f"  Suppressed: {summary['suppressed']}")
        if summary.get('unconfirmed', 0) > 0:
            print(f"  Unconfirmed (assistant-originated): {summary['unconfirmed']}")
        if promote_summary.get('promoted', 0) > 0:
            print(f"  Promoted from unconfirmed: {promote_summary['promoted']}")
        if resolve_summary['applied'] > 0:
            print(f"\nAccepted conflicts applied: {resolve_summary['applied']}")
            print(f"Rejected conflicts: {resolve_summary['rejected']}")
            print(f"Pending conflicts: {resolve_summary['pending']}")

    return 0


def run(argv: List[str], *, store) -> int:
    """Public engine entry: parse `argv` and run the pipeline with the
    injected `store` (supplies consolidate_fact). The deployment wrapper
    calls this as engine.run(sys.argv[1:], store=<real store>)."""
    return main(list(argv), store=store)


if __name__ == '__main__':
    sys.exit(main())
