#!/usr/bin/env python3
"""
Topic brains gating/slicing/stamping script.

Deterministic Python script that manages per-topic BRAIN.md files:
- plan: pure derivation, writes workplan + slices
- finalize: stamps, folds, conflicts, audit, INDEX regeneration
- seed: explicit hand-seeded brain creation (migration primitive)

No LLM involvement — all logic is deterministic Python.
Mirror conventions from memory_consolidation.py for audit compatibility.
"""

import argparse
import json
import os
import re
import sys
from collections import deque
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Set

# IST as a real tzinfo (spec §3.2: consolidated stamps carry the +05:30 offset).
# Do NOT build IST by adding a timedelta to a UTC datetime — that shifts the wall
# clock but keeps tzinfo=+00:00, producing IST values labeled as UTC (Gate D
# finding, 2026-08-21).
IST = timezone(timedelta(hours=5, minutes=30))

# Dormant exemption threshold: 30 days (spec §3.2)
DORMANT_MS = 30 * 24 * 3600


def resolve_pa_home() -> str:
    """Resolve PA_HOME with same precedence as memory_consolidation.py."""
    return os.environ.get('PA_HOME', os.path.expanduser('~/.pa'))


def resolve_paths(pa_home: str) -> Dict[str, str]:
    """Resolve all file paths for topic brains."""
    return {
        'pa_home': pa_home,
        'conversation_history': os.path.join(pa_home, 'conversation-history.jsonl'),
        'topic_brains_dir': os.path.join(pa_home, 'topic-brains'),
        'workplan': os.path.join(pa_home, 'topic-brains', '.workplan.json'),
        'slices_dir': os.path.join(pa_home, 'topic-brains', '.slices'),
        'results_dir': os.path.join(pa_home, 'topic-brains', '.results'),
        'staged_dir': os.path.join(pa_home, 'topic-brains', '.staged'),
        'index': os.path.join(pa_home, 'topic-brains', 'INDEX.md'),
        'topic_names': os.path.join(pa_home, 'telegram-topic-names.json'),
        'review_pending': os.path.join(pa_home, 'review-digest-pending.jsonl'),
        'consolidation_audit': os.path.join(pa_home, 'consolidation-audit.jsonl'),
        'exempt_registry': os.path.join(pa_home, 'topic-brains', 'EXEMPT.json'),
    }


def enumerate_topic_states(pa_home: str) -> List[Tuple[str, int, int, Dict]]:
    """Enumerate topic-state files and parse chatId, threadId, and state.

    Returns:
        List of (filepath, chatId, threadId, state_dict) tuples.
        Skips files with corrupt JSON with warning to stderr.
    """
    pattern = re.compile(r'^telegram-bot-topic-(-?\d+)_(\d+)\.json$')
    topics = []

    for filename in os.listdir(pa_home):
        match = pattern.match(filename)
        if not match:
            continue

        filepath = os.path.join(pa_home, filename)
        chat_id = int(match.group(1))
        thread_id = int(match.group(2))

        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                state = json.load(f)
                topics.append((filepath, chat_id, thread_id, state))
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Skipping corrupt topic state file {filename}: {e}", file=sys.stderr)

    return topics


def detect_thread_id_collisions(topics: List[Tuple[str, int, int, Dict]]) -> Dict[int, List[str]]:
    """Detect thread_id collisions across different chatIds.

    Returns:
        Dict mapping threadId to list of topicKeys that collide.
    """
    thread_to_keys: Dict[int, List[str]] = {}

    for _, chat_id, thread_id, _ in topics:
        key = f"{chat_id}_{thread_id}"
        if thread_id not in thread_to_keys:
            thread_to_keys[thread_id] = []
        thread_to_keys[thread_id].append(key)

    # Keep only collisions (same threadId in different chats)
    collisions = {
        thread_id: keys
        for thread_id, keys in thread_to_keys.items()
        if len(keys) > 1 or len(set(k.split('_')[0] for k in keys)) > 1
    }

    return collisions


def stream_archive_turns(path: str) -> Dict[int, List[Dict]]:
    """Stream conversation-history.jsonl and bucket turns by thread_id.

    Returns:
        Dict mapping threadId to list of turn dicts (newest last).
        Skips unparseable lines with warning.
    """
    turns_by_thread: Dict[int, List[Dict]] = {}

    if not os.path.exists(path):
        return turns_by_thread

    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    turn = json.loads(line)
                    thread_id = turn.get('thread_id')
                    if thread_id:
                        if thread_id not in turns_by_thread:
                            turns_by_thread[thread_id] = []
                        turns_by_thread[thread_id].append(turn)
                except json.JSONDecodeError:
                    print(f"Warning: Skipping unparseable line {line_num} in archive", file=sys.stderr)
                    continue
    except IOError as e:
        print(f"Warning: Cannot read archive file: {e}", file=sys.stderr)

    return turns_by_thread


def load_exempt_registry(path: str) -> Dict[str, str]:
    """Load EXEMPT.json registry.

    Returns:
        Dict mapping topicKey to exemption class.
        Missing/malformed file → empty dict (fail-open).
    """
    if not os.path.exists(path):
        return {}

    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if not isinstance(data, dict):
                print(f"Warning: EXEMPT.json is not a dict", file=sys.stderr)
                return {}
            # Validate values are known classes
            hard_classes = {'output-only', 'duplicate', 'one-off', 'pinned-guide'}
            valid_classes = hard_classes | {'dormant'}
            result = {}
            for key, value in data.items():
                if value in valid_classes:
                    result[key] = value
                else:
                    print(f"Warning: Unknown exemption class '{value}' for {key}", file=sys.stderr)
            return result
    except (json.JSONDecodeError, IOError) as e:
        print(f"Warning: Cannot read EXEMPT.json: {e}", file=sys.stderr)
        return {}


def parse_brain_stamp(brain_path: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """Parse the topic-brain stamp line from BRAIN.md.

    Returns:
        Tuple of (consolidated_ts, covers_ts, folded_into) or (None, None, None).
        Only reads first 4096 bytes.
    """
    if not os.path.exists(brain_path):
        return None, None, None

    try:
        with open(brain_path, 'rb') as f:
            header = f.read(4096).decode('utf-8', errors='ignore')

        stamp_pattern = re.compile(
            r'<!-- topic-brain: consolidated=([^\s]+) covers=([^\s]+)(?: folded-into=([^\s]+))? -->'
        )
        match = stamp_pattern.search(header)
        if match:
            return match.group(1), match.group(2), match.group(3) or None
    except IOError:
        pass

    return None, None, None


def count_new_turns(turns: List[Dict], covers_through: Optional[str]) -> int:
    """Count turns with timestamp > coversThrough."""
    if not covers_through or covers_through == 'none':
        return len(turns)

    try:
        cutoff = datetime.fromisoformat(covers_through.replace('Z', '+00:00'))
        return sum(1 for t in turns if datetime.fromisoformat(t['timestamp'].replace('Z', '+00:00')) > cutoff)
    except (ValueError, KeyError):
        return len(turns)


def truncate_slice(turns: List[Dict], max_turns: int = 300, max_bytes: int = 150000) -> List[Dict]:
    """Truncate turns to max_turns, dropping oldest if exceeding max_bytes.

    Returns:
        List of turns (newest last), truncated to fit constraints.
    """
    if len(turns) <= max_turns:
        # Check byte cap
        total_bytes = sum(len(json.dumps(t)) for t in turns)
        if total_bytes <= max_bytes:
            return turns

    # Take last max_turns, then trim from oldest if still over byte cap
    truncated = turns[-max_turns:] if len(turns) > max_turns else turns[:]

    total_bytes = 0
    result = []
    for turn in reversed(truncated):  # Start from newest
        turn_bytes = len(json.dumps(turn))
        if total_bytes + turn_bytes > max_bytes and result:
            break
        result.insert(0, turn)  # Keep newest-first order
        total_bytes += turn_bytes

    return result


def plan(pa_home: str) -> int:
    """Generate workplan and slice files.

    Returns 0 on success, 1 on error.
    """
    paths = resolve_paths(pa_home)
    os.makedirs(paths['topic_brains_dir'], exist_ok=True)
    os.makedirs(paths['slices_dir'], exist_ok=True)
    os.makedirs(paths['staged_dir'], exist_ok=True)

    # Enumerate topics
    topics = enumerate_topic_states(pa_home)
    collisions = detect_thread_id_collisions(topics)
    collision_set: Set[str] = set()
    for keys in collisions.values():
        collision_set.update(keys)

    # Load EXEMPT registry (spec §3.1)
    exempt_registry = load_exempt_registry(paths['exempt_registry'])
    hard_exempt_keys = {k for k, v in exempt_registry.items() if v in {'output-only', 'duplicate', 'one-off', 'pinned-guide'}}

    # Load topic names
    topic_names: Dict[str, str] = {}
    try:
        with open(paths['topic_names'], 'r', encoding='utf-8') as f:
            topic_names_data = json.load(f)
            for chat_str, thread_dict in topic_names_data.items():
                for thread_str, name_info in thread_dict.items():
                    key = f"{chat_str}_{thread_str}"
                    topic_names[key] = name_info.get('name', f'topic-{thread_str}')
    except (IOError, json.JSONDecodeError):
        pass

    # Parse all brain stamps BEFORE streaming (reorder per spec §3.5)
    stamp_cache: Dict[str, Tuple[Optional[str], Optional[str], Optional[str]]] = {}
    for _, chat_id, thread_id, _ in topics:
        topic_key = f"{chat_id}_{thread_id}"
        brain_path = os.path.join(paths['topic_brains_dir'], topic_key, 'BRAIN.md')
        stamp_cache[topic_key] = parse_brain_stamp(brain_path)

    # Single archive pass with per-thread bounded state (spec §3.5)
    # Returns: {threadId: (exact_new_turns, deque(maxlen=300), newest_turn_ts)}
    def stream_with_bounds(archive_path: str) -> Dict[int, Tuple[int, deque, Optional[str]]]:
        """Stream archive once, tracking exact counts and newest turn per thread.

        Returns:
            Dict mapping threadId to (newTurns, deque of newest 300, newestTurnTs).
        """
        thread_state: Dict[int, Tuple[int, deque, Optional[str]]] = {}

        if not os.path.exists(archive_path):
            return thread_state

        try:
            with open(archive_path, 'r', encoding='utf-8') as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        turn = json.loads(line)
                        thread_id = turn.get('thread_id')
                        if not thread_id:
                            continue

                        if thread_id not in thread_state:
                            thread_state[thread_id] = (0, deque(maxlen=300), None)

                        new_turns, turns_deque, newest_ts = thread_state[thread_id]
                        new_turns += 1
                        turns_deque.append(turn)

                        # Track newest timestamp
                        try:
                            turn_ts = datetime.fromisoformat(turn['timestamp'].replace('Z', '+00:00'))
                            if newest_ts is None or turn_ts > datetime.fromisoformat(newest_ts.replace('Z', '+00:00')):
                                newest_ts = turn['timestamp']
                        except (ValueError, KeyError):
                            pass  # Unparsable timestamp counted but doesn't become newest

                        thread_state[thread_id] = (new_turns, turns_deque, newest_ts)
                    except json.JSONDecodeError:
                        print(f"Warning: Skipping unparseable line {line_num} in archive", file=sys.stderr)
                        continue
        except IOError as e:
            print(f"Warning: Cannot read archive file: {e}", file=sys.stderr)

        return thread_state

    thread_bounds = stream_with_bounds(paths['conversation_history'])

    # Build candidates
    candidates = []
    now = datetime.now(timezone.utc)

    for _, chat_id, thread_id, state in topics:
        topic_key = f"{chat_id}_{thread_id}"
        topic_name = topic_names.get(topic_key, f'topic-{thread_id}')
        brain_path = os.path.join(paths['topic_brains_dir'], topic_key, 'BRAIN.md')
        brain_exists = os.path.exists(brain_path)

        # Skip if collision
        if topic_key in collision_set:
            candidates.append({
                'topicKey': topic_key,
                'chatId': chat_id,
                'threadId': thread_id,
                'topicName': topic_name,
                'reason': 'thread-id-collision',
                'skip': True,
            })
            continue

        # Hard-exempt keys skip before any archive work (spec §3.2)
        if topic_key in hard_exempt_keys:
            candidates.append({
                'topicKey': topic_key,
                'chatId': chat_id,
                'threadId': thread_id,
                'topicName': topic_name,
                'reason': 'exempt',
                'detail': exempt_registry[topic_key],
                'skip': True,
            })
            continue

        # Get existing stamp from cache
        consolidated, covers, folded_into = stamp_cache.get(topic_key, (None, None, None))

        # Check for staged file (activity gate, spec §3.2)
        staged_path = os.path.join(paths['staged_dir'], f'{topic_key}.md')
        has_staged = os.path.exists(staged_path)

        # Get bounded state for this thread
        new_turns = 0
        turns_deque = deque(maxlen=300)
        newest_turn_ts = None

        if thread_id in thread_bounds:
            new_turns, turns_deque, newest_turn_ts = thread_bounds[thread_id]

        # Filter deque by covers timestamp (delta mode)
        # After filtering, recount new_turns (spec §3.5)
        if covers and covers != 'none':
            try:
                cutoff = datetime.fromisoformat(covers.replace('Z', '+00:00'))
                filtered_deque = deque(maxlen=300)
                for turn in turns_deque:
                    try:
                        turn_ts = datetime.fromisoformat(turn['timestamp'].replace('Z', '+00:00'))
                        if turn_ts > cutoff:
                            filtered_deque.append(turn)
                    except (ValueError, KeyError):
                        filtered_deque.append(turn)  # Unparsable counts as new
                turns_deque = filtered_deque
                # Recount after filtering (spec §3.5)
                new_turns = len(turns_deque)
            except ValueError:
                pass  # Invalid covers: use full deque

        # Dormant rule: skip if newest turn is older than 30 days (spec §3.2)
        if topic_key in exempt_registry and exempt_registry[topic_key] == 'dormant':
            if newest_turn_ts:
                try:
                    newest_dt = datetime.fromisoformat(newest_turn_ts.replace('Z', '+00:00'))
                    if (now - newest_dt).total_seconds() > DORMANT_MS:
                        candidates.append({
                            'topicKey': topic_key,
                            'chatId': chat_id,
                            'threadId': thread_id,
                            'topicName': topic_name,
                            'reason': 'exempt',
                            'detail': 'dormant',
                            'skip': True,
                        })
                        continue
                except ValueError:
                    pass  # Unparsable timestamp: don't apply dormant rule

        # Activity gate: staged file counts as activity (spec §3.2)
        if new_turns == 0 and not has_staged:
            candidates.append({
                'topicKey': topic_key,
                'chatId': chat_id,
                'threadId': thread_id,
                'topicName': topic_name,
                'reason': 'no-new-turns',
                'skip': True,
            })
            continue

        # Determine kind
        if not brain_exists:
            kind = 'seed'
        else:
            kind = 'delta'

        # Check for split
        split = False
        if brain_exists:
            try:
                brain_size = os.path.getsize(brain_path)
                split = brain_size > 8192
            except OSError:
                pass

        candidate = {
            'topicKey': topic_key,
            'chatId': chat_id,
            'threadId': thread_id,
            'topicName': topic_name,
            'kind': kind,
            'split': split,
            'brainPath': brain_path,
            'brainExists': brain_exists,
            'coversThrough': covers,
            'newTurns': new_turns,
            'skip': False,
            'turnsDeque': turns_deque,  # For slice writing (only if selected)
        }

        if has_staged:
            candidate['stagedPath'] = staged_path

        candidates.append(candidate)

    # Apply caps: sort by newTurns desc, take ≤8 tasks (≤3 seeds)
    candidates.sort(key=lambda c: c.get('newTurns', 0), reverse=True)

    tasks = []
    skipped = []
    seed_count = 0
    task_count = 0

    for c in candidates:
        if c.get('skip'):
            skip_entry = {'topicKey': c['topicKey'], 'reason': c.get('reason')}
            if 'detail' in c:
                skip_entry['detail'] = c['detail']
            skipped.append(skip_entry)
            continue

        if task_count >= 8:
            skipped.append({'topicKey': c['topicKey'], 'reason': 'deferred-cap'})
            continue

        if c['kind'] == 'seed':
            if seed_count >= 3:
                skipped.append({'topicKey': c['topicKey'], 'reason': 'deferred-cap'})
                continue
            seed_count += 1

        # Write slice ONLY for selected tasks (spec §3.5)
        slice_path = os.path.join(paths['slices_dir'], f'{c["topicKey"]}.jsonl')
        turns_deque = c.get('turnsDeque', deque(maxlen=300))

        try:
            with open(slice_path, 'w', encoding='utf-8') as f:
                for turn in turns_deque:
                    f.write(json.dumps(turn) + '\n')
        except IOError as e:
            print(f"Error: Cannot write slice file: {e}", file=sys.stderr)
            return 1

        task_entry = {
            'topicKey': c['topicKey'],
            'chatId': c['chatId'],
            'threadId': c['threadId'],
            'topicName': c['topicName'],
            'kind': c['kind'],
            'split': c['split'],
            'brainPath': c['brainPath'],
            'brainExists': c['brainExists'],
            'coversThrough': c['coversThrough'],
            'slicePath': slice_path,
            'newTurns': c['newTurns'],
        }

        if 'stagedPath' in c:
            task_entry['stagedPath'] = c['stagedPath']

        tasks.append(task_entry)
        task_count += 1

    # Detect folds (topics with mergedAt and existing brain, not yet folded)
    folds = []
    for _, chat_id, thread_id, state in topics:
        topic_key = f"{chat_id}_{thread_id}"
        ancestry = state.get('ancestry', {})
        merged_at = ancestry.get('mergedAt')

        if not merged_at:
            continue

        # Check if branch brain exists and not yet folded
        branch_brain_path = os.path.join(paths['topic_brains_dir'], topic_key, 'BRAIN.md')
        if not os.path.exists(branch_brain_path):
            continue

        _, _, folded_into = stamp_cache.get(topic_key, (None, None, None))
        if folded_into:
            continue  # Already folded

        # Get branch summary
        summary = None
        try:
            with open(branch_brain_path, 'r', encoding='utf-8') as f:
                for line in f:
                    if line.startswith('> Summary:'):
                        summary = line[len('> Summary:'):].strip()
                        break
        except IOError:
            pass

        parent_topic_key = ancestry.get('parentTopicKey')
        if not parent_topic_key:
            continue

        parent_parts = parent_topic_key.split('_')
        if len(parent_parts) != 2:
            continue

        parent_brain_path = os.path.join(paths['topic_brains_dir'], parent_topic_key, 'BRAIN.md')

        folds.append({
            'branchTopicKey': topic_key,
            'parentTopicKey': parent_topic_key,
            'branchBrainPath': branch_brain_path,
            'parentBrainPath': parent_brain_path,
            'mergedAt': merged_at,
            'branchSummary': summary,
        })

    # Write workplan
    workplan = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'tasks': tasks,
        'folds': folds,
        'skipped': skipped,
    }

    try:
        temp_path = paths['workplan'] + '.tmp'
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(workplan, f, indent=2)
        os.replace(temp_path, paths['workplan'])
    except IOError as e:
        print(f"Error: Cannot write workplan: {e}", file=sys.stderr)
        return 1

    print(f"Plan complete: {len(tasks)} tasks, {len(folds)} folds, {len(skipped)} skipped")
    return 0


def write_atomically(content: str, path: str) -> bool:
    """Write content to path atomically using temp file + os.replace."""
    try:
        temp_path = path + '.tmp'
        with open(temp_path, 'w', encoding='utf-8') as f:
            f.write(content)
        os.replace(temp_path, path)
        return True
    except IOError as e:
        print(f"Error: Cannot write {path}: {e}", file=sys.stderr)
        return False


def backfill_parent_link(brain_path: str, repo_root: str) -> bool:
    """Backfill parent-link line to BRAIN.md (idempotent, spec §3.6).

    Returns True if written (including no-op), False on error.
    """
    try:
        with open(brain_path, 'r', encoding='utf-8-sig') as f:  # -sig: strip a BOM (agy's file tool writes one; it defeated startswith('#') and left 5 brains unstamped 2026-08-22)
            content = f.read()
    except IOError:
        return False  # Brain doesn't exist or can't be read

    # Check if already has parent-link line (idempotent)
    if re.search(r'^Central brain:', content, re.MULTILINE):
        return True  # Already present, no-op

    # Find insertion point: after "Other topics:" line if present, else at end
    other_topics_match = re.search(r'^Other topics:.*$', content, re.MULTILINE)
    if other_topics_match:
        insert_pos = other_topics_match.end()
    else:
        insert_pos = len(content)

    # Normalize repo_root path (forward slashes)
    repo_root_normalized = repo_root.replace('\\', '/')
    parent_line = f"\nCentral brain: {repo_root_normalized}/CLAUDE.md — framework truths and routing; this file holds only this topic's knowledge.\n"

    # Insert parent line
    new_content = content[:insert_pos] + parent_line + content[insert_pos:]

    return write_atomically(new_content, brain_path)


def write_topic_shim(topic_dir: str, brain_path: str, topic_name: str, repo_root: str) -> bool:
    """Write/refresh per-topic CLAUDE.md shim (spec §3.7).

    Returns True if written, False on error.
    """
    # Resolve paths
    brain_normalized = brain_path.replace('\\', '/')
    repo_root_normalized = repo_root.replace('\\', '/')
    kb_line = ""
    if 'PA_KB_SOURCES_PATH' in os.environ:
        kb_path = os.environ['PA_KB_SOURCES_PATH'].replace('\\', '/')
        kb_line = f"- KB router: {kb_path} — cross-domain deterministic facts (when set)\n"

    shim_content = f"""# {topic_name} — topic workspace

Auto-generated pointer file; the nightly consolidation pass owns it. Do not edit by hand.

- Topic brain: {brain_normalized} — durable knowledge for this topic; read it before assuming prior context here
- Central brain: {repo_root_normalized}/CLAUDE.md — framework truths and routing
- Shared tree: {repo_root_normalized}/ is written by other sessions and skills while you work. Before editing a tracked file there run `pa claims`; claim multi-file work with `pa claim <paths> --session <label> --note "<what you are doing>"`; never run git commit/push/stash/checkout/reset/clean yourself; do not claim `@build` yourself — `npm run build`/`npm test` take and release it automatically, and a "waiting for @build" line means another session is building, not stuck. Full rules: {repo_root_normalized}/docs/multi-session-protocol.md
{kb_line}- Scratch: scratch/ — ephemeral files for this topic's work sessions
"""

    shim_path = os.path.join(topic_dir, 'CLAUDE.md')
    return write_atomically(shim_content, shim_path)


def finalize(pa_home: str, stamp_topic_key: Optional[str] = None) -> int:
    """Finalize results: stamp brains, perform folds, regenerate INDEX.

    Args:
        pa_home: PA_HOME path
        stamp_topic_key: If set, only stamp this topic (hand-seeded brain)

    Returns 0 on success, 1 on error.
    """
    paths = resolve_paths(pa_home)

    # Collect audit entries
    audit_entries = []

    # Load topic names
    topic_names: Dict[str, str] = {}
    try:
        with open(paths['topic_names'], 'r', encoding='utf-8') as f:
            topic_names_data = json.load(f)
            for chat_str, thread_dict in topic_names_data.items():
                for thread_str, name_info in thread_dict.items():
                    key = f"{chat_str}_{thread_str}"
                    topic_names[key] = name_info.get('name', f'topic-{thread_str}')
    except (IOError, json.JSONDecodeError):
        pass

    # --stamp mode: stamp a single hand-written brain
    if stamp_topic_key:
        brain_dir = os.path.join(paths['topic_brains_dir'], stamp_topic_key)
        brain_path = os.path.join(brain_dir, 'BRAIN.md')

        # Record brain_existed BEFORE existence check (spec §3.5 F3 fix)
        brain_existed = os.path.exists(brain_path)

        if not brain_existed:
            print(f"Error: Brain file does not exist: {brain_path}", file=sys.stderr)
            return 1

        # Read existing content
        try:
            with open(brain_path, 'r', encoding='utf-8-sig') as f:  # -sig: strip a BOM (agy's file tool writes one; it defeated startswith('#') and left 5 brains unstamped 2026-08-22)
                content = f.read()
        except IOError as e:
            print(f"Error: Cannot read brain file: {e}", file=sys.stderr)
            return 1

        # Generate stamp timestamp first (needed for covers fallback)
        # Explicit IST offset (+05:30)
        now_ist = datetime.now(IST)
        consolidated = now_ist.isoformat()

        # Get max timestamp from archive for this topic
        parts = stamp_topic_key.split('_')
        if len(parts) != 2:
            print(f"Error: Invalid topicKey format: {stamp_topic_key}", file=sys.stderr)
            return 1

        thread_id = int(parts[1])
        covers_ts = None
        try:
            turns_by_thread = stream_archive_turns(paths['conversation_history'])
            topic_turns = turns_by_thread.get(thread_id, [])
            if topic_turns:
                max_ts = max(t['timestamp'] for t in topic_turns)
                covers_ts = max_ts
            else:
                # No archive turns: covers = consolidated timestamp value
                covers_ts = consolidated
        except Exception as e:
            print(f"Warning: Cannot read archive for covers timestamp: {e}", file=sys.stderr)
            covers_ts = consolidated

        # Remove existing stamp if present
        # Match from <!-- topic-brain: to the next -->
        content = re.sub(r'<!-- topic-brain:.*?-->\n?', '', content, flags=re.DOTALL)

        # Insert stamp at top
        stamp_line = f"<!-- topic-brain: consolidated={consolidated} covers={covers_ts} -->\n\n"
        if content.startswith('#'):
            # Insert after title line
            lines = content.split('\n', 1)
            content = lines[0] + '\n' + stamp_line + (lines[1] if len(lines) > 1 else '')
        else:
            content = stamp_line + content

        # Write atomically
        if not write_atomically(content, brain_path):
            return 1

        # Audit entry: seeded vs updated (spec §3.5 F3)
        summary = None
        for line in content.split('\n'):
            if line.startswith('> Summary:'):
                summary = line[len('> Summary:'):].strip()
                break

        audit_action = 'topic-brain-seeded' if not brain_existed else 'topic-brain-updated'
        audit_entries.append({
            'ts': datetime.now(timezone.utc).isoformat(),
            'action': audit_action,
            'fact_key': stamp_topic_key,
            'fact_text': summary or '(no summary)',
            'category': 'topic-brain',
            'sink': 'topic-brain',
            'source': 'hand-migration',
            'superseded_key': None,
            'superseded_text': None,
            'conflict_detail': None,
        })

        print(f"Stamped brain: {stamp_topic_key} (covers={covers_ts})")
    else:
        # Normal finalize: read results and process
        results_dir = paths['results_dir']

        # Process results if directory exists
        if os.path.exists(results_dir):
            for filename in os.listdir(results_dir):
                if not filename.endswith('.json'):
                    continue

                result_path = os.path.join(results_dir, filename)
                try:
                    with open(result_path, 'r', encoding='utf-8') as f:
                        result = json.load(f)
                except (json.JSONDecodeError, IOError) as e:
                    print(f"Warning: Skipping unreadable result {filename}: {e}", file=sys.stderr)
                    continue

                topic_key = result.get('topicKey')
                if not topic_key:
                    continue

                brain_dir = os.path.join(paths['topic_brains_dir'], topic_key)
                brain_path = os.path.join(brain_dir, 'BRAIN.md')

                if not result.get('updated'):
                    audit_entries.append({
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': 'topic-brain-skipped',
                        'fact_key': topic_key,
                        'fact_text': 'no update from LLM',
                        'category': 'topic-brain',
                        'sink': 'topic-brain',
                        'source': 'conversation-archive',
                        'superseded_key': None,
                        'superseded_text': None,
                        'conflict_detail': None,
                    })
                    # Staged file survives for retry (spec §3.5)
                    continue

                # Route conflicts
                conflict = result.get('conflict')
                if conflict:
                    try:
                        with open(paths['review_pending'], 'a+b') as f:
                            f.seek(0, os.SEEK_END)
                            if f.tell() > 0:
                                f.seek(-1, os.SEEK_END)
                                if f.read(1) != b'\n':
                                    f.write(b'\n')

                            conflict_entry = {
                                'id': f'tb-{datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")}-{topic_key}',
                                'created_at': datetime.now(timezone.utc).isoformat(),
                                'resolved': False,
                                'resolved_at': None,
                                'resolution': None,
                                'key': topic_key,
                                'category': 'topic-brain',
                                'new_text': conflict.get('newText'),
                                'existing_text': conflict.get('existingText'),
                                'description': conflict.get('description'),
                            }
                            f.write((json.dumps(conflict_entry) + '\n').encode('utf-8'))
                            f.flush()
                            os.fsync(f.fileno())

                        audit_entries.append({
                            'ts': datetime.now(timezone.utc).isoformat(),
                            'action': 'topic-brain-conflict',
                            'fact_key': topic_key,
                            'fact_text': conflict.get('description', ''),
                            'category': 'topic-brain',
                            'sink': 'topic-brain',
                            'source': 'conversation-archive',
                            'superseded_key': None,
                            'superseded_text': None,
                            'conflict_detail': conflict,
                        })
                    except IOError as e:
                        print(f"Warning: Cannot write conflict to pending: {e}", file=sys.stderr)

                # Get summary
                summary = result.get('summary', '(no summary)')

                # Read brain content and repair/insert stamp
                os.makedirs(brain_dir, exist_ok=True)

                # Record brain_existed BEFORE stamp write (spec §3.5 F3 fix)
                brain_existed = os.path.exists(brain_path)

                if brain_existed:
                    try:
                        with open(brain_path, 'r', encoding='utf-8-sig') as f:  # -sig: strip a BOM (agy's file tool writes one; it defeated startswith('#') and left 5 brains unstamped 2026-08-22)
                            content = f.read()
                    except IOError as e:
                        print(f"Warning: Cannot read brain file: {e}", file=sys.stderr)
                        content = ''
                else:
                    content = ''

                # Get max timestamp from slice
                slice_path = os.path.join(paths['slices_dir'], f'{topic_key}.jsonl')
                max_ts = None
                try:
                    turns = []
                    with open(slice_path, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            if line:
                                turns.append(json.loads(line))
                    if turns:
                        max_ts = max(t['timestamp'] for t in turns)
                except (IOError, json.JSONDecodeError):
                    pass

                # Generate stamp
                # Explicit IST offset (+05:30)
                now_ist = datetime.now(IST)
                consolidated = now_ist.isoformat()
                covers = max_ts or 'consolidated'

                # Remove existing stamp
                content = re.sub(r'<!-- topic-brain:.*?-->\n?', '', content, flags=re.DOTALL)

                # Insert stamp at top
                stamp_line = f"<!-- topic-brain: consolidated={consolidated} covers={covers} -->\n\n"
                if content.startswith('#'):
                    lines = content.split('\n', 1)
                    content = lines[0] + '\n' + stamp_line + (lines[1] if len(lines) > 1 else '')
                else:
                    content = stamp_line + content

                # Write atomically
                if not write_atomically(content, brain_path):
                    return 1

                # Check for split
                brain_size = len(content.encode('utf-8'))
                if brain_size > 8192:
                    audit_entries.append({
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': 'topic-brain-split',
                        'fact_key': topic_key,
                        'fact_text': f'brain size {brain_size} bytes exceeds 8192',
                        'category': 'topic-brain',
                        'sink': 'topic-brain',
                        'source': 'conversation-archive',
                        'superseded_key': None,
                        'superseded_text': None,
                        'conflict_detail': None,
                    })

                # Audit entry: seeded vs updated (spec §3.5 F3)
                audit_action = 'topic-brain-seeded' if not brain_existed else 'topic-brain-updated'
                audit_entries.append({
                    'ts': datetime.now(timezone.utc).isoformat(),
                    'action': audit_action,
                    'fact_key': topic_key,
                    'fact_text': summary,
                    'category': 'topic-brain',
                    'sink': 'topic-brain',
                    'source': 'conversation-archive',
                    'superseded_key': None,
                    'superseded_text': None,
                    'conflict_detail': None,
                })

                print(f"Finalized: {topic_key} - {summary}")

                # Delete staged file after successful fold (spec §3.5)
                staged_file = os.path.join(paths['staged_dir'], f'{topic_key}.md')
                if os.path.exists(staged_file):
                    try:
                        os.remove(staged_file)
                    except OSError as e:
                        print(f"Warning: Cannot delete staged file {staged_file}: {e}", file=sys.stderr)

        # Read workplan for folds
        workplan_path = paths['workplan']
        folds = []
        if os.path.exists(workplan_path):
            try:
                with open(workplan_path, 'r', encoding='utf-8') as f:
                    workplan = json.load(f)
                    folds = workplan.get('folds', [])
            except (json.JSONDecodeError, IOError):
                pass

        # Generate consolidated timestamp for folds (IST offset)
        now_ist = datetime.now(IST)
        consolidated = now_ist.isoformat()

        # Perform folds
        for fold in folds:
            branch_key = fold.get('branchTopicKey')
            parent_key = fold.get('parentTopicKey')
            branch_brain_path = fold.get('branchBrainPath')
            parent_brain_path = fold.get('parentBrainPath')
            merged_at = fold.get('mergedAt')
            branch_summary = fold.get('branchSummary')

            if not all([branch_key, parent_key, branch_brain_path, parent_brain_path, merged_at]):
                continue

            # Read parent brain
            try:
                with open(parent_brain_path, 'r', encoding='utf-8') as f:
                    parent_content = f.read()
            except IOError:
                parent_content = ''

            # Append fold section
            merged_date = merged_at[:10] if len(merged_at) >= 10 else merged_at
            parent_topic_name = topic_names.get(parent_key, f'topic-{parent_key.split("_")[1]}')
            branch_topic_name = topic_names.get(branch_key, f'topic-{branch_key.split("_")[1]}')

            fold_section = f"\n\n## Merged branch: {branch_topic_name} (merged {merged_date})\n\n"
            if branch_summary:
                fold_section += f"Branch summary: {branch_summary}\n\n"
            fold_section += f"Branch brain: {branch_brain_path}\n"

            parent_content += fold_section

            # Write parent atomically
            if not write_atomically(parent_content, parent_brain_path):
                continue

            # Update branch stamp with folded-into
            try:
                with open(branch_brain_path, 'r', encoding='utf-8') as f:
                    branch_content = f.read()
            except IOError:
                branch_content = ''

            # Check if stamp exists and extract consolidated/covers
            stamp_pattern = re.compile(r'<!-- topic-brain: consolidated=([^\s]+) covers=([^\s]+)(?: folded-into=([^\s]+))? ?-->')
            existing_stamp = stamp_pattern.search(branch_content)

            if existing_stamp:
                # Replace existing stamp, preserving consolidated/covers, adding folded-into
                old_consolidated = existing_stamp.group(1)
                old_covers = existing_stamp.group(2)
                branch_content = re.sub(
                    r'<!-- topic-brain: .*? ?-->',
                    f'<!-- topic-brain: consolidated={old_consolidated} covers={old_covers} folded-into={parent_key} -->',
                    branch_content
                )
            else:
                # Insert new stamp with full §3.2 grammar
                # Get branch's max archive timestamp for covers
                parts = branch_key.split('_')
                branch_thread_id = int(parts[1]) if len(parts) == 2 else None
                branch_covers = consolidated  # fallback to now IST

                if branch_thread_id is not None:
                    try:
                        turns_by_thread = stream_archive_turns(paths['conversation_history'])
                        branch_turns = turns_by_thread.get(branch_thread_id, [])
                        if branch_turns:
                            max_ts = max(t['timestamp'] for t in branch_turns)
                            branch_covers = max_ts
                    except Exception:
                        pass  # use consolidated fallback

                stamp_line = f"<!-- topic-brain: consolidated={consolidated} covers={branch_covers} folded-into={parent_key} -->\n\n"
                if branch_content.startswith('#'):
                    lines = branch_content.split('\n', 1)
                    branch_content = lines[0] + '\n' + stamp_line + (lines[1] if len(lines) > 1 else '')
                else:
                    branch_content = stamp_line + branch_content

            if not write_atomically(branch_content, branch_brain_path):
                continue

            audit_entries.append({
                'ts': datetime.now(timezone.utc).isoformat(),
                'action': 'topic-brain-folded',
                'fact_key': branch_key,
                'fact_text': f'folded into {parent_key}',
                'category': 'topic-brain',
                'sink': 'topic-brain',
                'source': 'conversation-archive',
                'superseded_key': parent_key,
                'superseded_text': parent_topic_name,
                'conflict_detail': None,
            })

            print(f"Folded: {branch_key} -> {parent_key}")

    # Title refresh: rewrite first heading of each brain to current topic name (§3.9)
    # PLUS shared tail: parent-line backfill + shim refresh (spec §3.5, runs in both modes)
    topic_brains_dir = paths['topic_brains_dir']

    # Load EXEMPT registry for staged sweep and anomaly check
    exempt_registry = load_exempt_registry(paths['exempt_registry'])
    hard_exempt_keys = {k for k, v in exempt_registry.items() if v in {'output-only', 'duplicate', 'one-off', 'pinned-guide'}}

    # Re-detect collisions for staged sweep
    topics = enumerate_topic_states(pa_home)
    collisions = detect_thread_id_collisions(topics)
    collision_set: Set[str] = set()
    for keys in collisions.values():
        collision_set.update(keys)

    # Shared tail: parent-line backfill + shim refresh for every brain dir
    # Resolve repo root (central brain path, spec §3.7)
    repo_root = str(Path(__file__).resolve().parents[2])

    if os.path.exists(topic_brains_dir):
        for entry in os.listdir(topic_brains_dir):
            if entry.startswith('.'):
                continue
            brain_dir = os.path.join(topic_brains_dir, entry)
            brain_path = os.path.join(brain_dir, 'BRAIN.md')
            if os.path.exists(brain_path):
                # Check exempt-with-brain anomaly (spec §3.5)
                if entry in hard_exempt_keys:
                    audit_entries.append({
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': 'topic-brain-skipped',
                        'fact_key': entry,
                        'fact_text': 'exempt topic has a brain',
                        'category': 'topic-brain',
                        'sink': 'topic-brain',
                        'source': 'topic-staging',
                        'superseded_key': None,
                        'superseded_text': None,
                        'conflict_detail': None,
                    })

                # Parent-line backfill (spec §3.6)
                backfill_parent_link(brain_path, repo_root)

                # CLAUDE.md shim write/refresh (spec §3.7)
                topic_name = topic_names.get(entry, f'topic-{entry.split("_")[1]}')
                write_topic_shim(brain_dir, brain_path, topic_name, repo_root)

                # Title refresh (existing logic)
                try:
                    with open(brain_path, 'r', encoding='utf-8-sig') as f:  # -sig: strip a BOM (agy's file tool writes one; it defeated startswith('#') and left 5 brains unstamped 2026-08-22)
                        content = f.read()
                    lines = content.split('\n')
                    # Find first heading line
                    for i, line in enumerate(lines):
                        if line.startswith('# '):
                            # Extract topic_key from directory name
                            topic_key = entry
                            # Get current name
                            current_name = topic_names.get(topic_key, f'topic-{topic_key.split("_")[1]}')
                            # Rewrite heading with current name
                            lines[i] = f'# {current_name}'
                            break
                    # Write atomically
                    write_atomically('\n'.join(lines), brain_path)
                except IOError:
                    pass  # Skip brains that can't be read/written

    # Staged sweep at end (spec §3.5)
    staged_dir = paths['staged_dir']
    if os.path.exists(staged_dir):
        for filename in os.listdir(staged_dir):
            if not filename.endswith('.md'):
                continue

            # Extract topicKey from filename
            topic_key = filename[:-3]  # Remove .md extension

            # Delete and audit if exempt or collision
            if topic_key in hard_exempt_keys or topic_key in collision_set:
                staged_file = os.path.join(staged_dir, filename)
                try:
                    os.remove(staged_file)
                    audit_entries.append({
                        'ts': datetime.now(timezone.utc).isoformat(),
                        'action': 'topic-brain-skipped',
                        'fact_key': topic_key,
                        'fact_text': 'exempt: discarded staged learnings',
                        'category': 'topic-brain',
                        'sink': 'topic-brain',
                        'source': 'topic-staging',
                        'superseded_key': None,
                        'superseded_text': None,
                        'conflict_detail': None,
                    })
                except OSError as e:
                    print(f"Warning: Cannot delete staged file {staged_file}: {e}", file=sys.stderr)

    # Regenerate INDEX.md
    topic_dirs = []
    brains_dir = paths['topic_brains_dir']
    if os.path.exists(brains_dir):
        for entry in os.listdir(brains_dir):
            if entry.startswith('.'):
                continue
            entry_path = os.path.join(brains_dir, entry)
            if os.path.isdir(entry_path):
                brain_path = os.path.join(entry_path, 'BRAIN.md')
                if os.path.exists(brain_path):
                    topic_dirs.append((entry, brain_path))

    # Sort by topic key
    topic_dirs.sort(key=lambda x: x[0])

    index_lines = [
        '# Topic Brains Index',
        '',
        f'_Regenerated {datetime.now(timezone.utc).isoformat()} by memory-consolidation (single writer). Cross-topic access: read this INDEX, then that topic\'s BRAIN.md._',
        '',
        '| Topic | Path | Holds | Status |',
        '|---|---|---|---|',
    ]

    for topic_key, brain_path in topic_dirs:
        # Parse stamp for status
        _, _, folded_into = parse_brain_stamp(brain_path)

        if folded_into:
            status = f'merged → {folded_into}'
        else:
            # Check for split files
            topic_dir = os.path.dirname(brain_path)
            if (os.path.exists(os.path.join(topic_dir, 'DECISIONS.md')) or
                os.path.exists(os.path.join(topic_dir, 'HISTORY.md'))):
                status = 'split'
            else:
                status = 'active'

        # Get summary
        summary = '(no summary)'
        try:
            with open(brain_path, 'r', encoding='utf-8-sig') as f:  # -sig: strip a BOM (agy's file tool writes one; it defeated startswith('#') and left 5 brains unstamped 2026-08-22)
                for line in f:
                    if line.startswith('> Summary:'):
                        summary = line[len('> Summary:'):].strip()
                        break
        except IOError:
            pass

        topic_name = topic_names.get(topic_key, f'topic-{topic_key.split("_")[1]}')
        path_only = topic_key + '/BRAIN.md'

        index_lines.append(f'| {topic_name} ({topic_key}) | {path_only} | {summary} | {status} |')

    index_content = '\n'.join(index_lines) + '\n'

    if not write_atomically(index_content, paths['index']):
        return 1

    # Write audit entries
    if audit_entries:
        try:
            with open(paths['consolidation_audit'], 'a+b') as f:
                f.seek(0, os.SEEK_END)
                if f.tell() > 0:
                    f.seek(-1, os.SEEK_END)
                    if f.read(1) != b'\n':
                        f.write(b'\n')
                for entry in audit_entries:
                    f.write((json.dumps(entry) + '\n').encode('utf-8'))
                f.flush()
                os.fsync(f.fileno())
        except IOError as e:
            print(f"Warning: Cannot write audit entries: {e}", file=sys.stderr)

    # Cleanup slices and results (only in normal mode, not --stamp)
    if not stamp_topic_key:
        slices_dir = paths['slices_dir']
        results_dir = paths['results_dir']

        if os.path.exists(slices_dir):
            try:
                for filename in os.listdir(slices_dir):
                    os.remove(os.path.join(slices_dir, filename))
            except OSError as e:
                print(f"Warning: Cannot cleanup slices: {e}", file=sys.stderr)

        if os.path.exists(results_dir):
            try:
                for filename in os.listdir(results_dir):
                    os.remove(os.path.join(results_dir, filename))
            except OSError as e:
                print(f"Warning: Cannot cleanup results: {e}", file=sys.stderr)

    print(f"INDEX regenerated: {len(topic_dirs)} topics")
    return 0


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(description='Topic brains gating/slicing/stamping script')
    subparsers = parser.add_subparsers(dest='command', help='Subcommands')

    # plan subcommand
    plan_parser = subparsers.add_parser('plan', help='Generate workplan and slice files')

    # finalize subcommand
    finalize_parser = subparsers.add_parser('finalize', help='Finalize results: stamp, fold, INDEX')
    finalize_parser.add_argument(
        '--stamp',
        metavar='TOPIC_KEY',
        help='Stamp a single hand-written brain (hand-seed procedure)'
    )

    # topicKeys in this deployment start with '-' (supergroup chat IDs are
    # negative), and argparse reads a leading-dash value as another flag.
    # Normalize "--stamp -100..._7822" to "--stamp=-100..._7822" before parsing
    # so the spec's documented space-separated form works (Gate D2 finding,
    # 2026-08-21).
    argv = sys.argv[1:]
    if '--stamp' in argv:
        i = argv.index('--stamp')
        if i + 1 < len(argv) and argv[i + 1].startswith('-'):
            argv[i] = '--stamp=' + argv[i + 1]
            del argv[i + 1]
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 1

    pa_home = resolve_pa_home()

    if args.command == 'plan':
        return plan(pa_home)
    elif args.command == 'finalize':
        return finalize(pa_home, stamp_topic_key=getattr(args, 'stamp', None))
    else:
        parser.print_help()
        return 1


if __name__ == '__main__':
    sys.exit(main())
