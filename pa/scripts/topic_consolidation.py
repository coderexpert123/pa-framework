#!/usr/bin/env python3
"""
Nightly topic consolidation — small overlapping topics merge into their larger home.

Deterministic companion to topic_brains.py, invoked by the memory-consolidation
skill as Step 4C (operator feature, 2026-09-14). No LLM involvement.

What it does each run:
- Censuses the day's topic activity from conversation-history.jsonl (turns per
  thread in the last WINDOW_HOURS; all roles — counting assistant turns is the
  conservative direction: more activity = fewer merges).
- Finds merge candidates: registry topics with < MIN_TURNS turns whose title
  tokens overlap a larger topic's title by >= OVERLAP_THRESHOLD (containment of
  the smaller name's token set in the larger name's).
- Merges: appends the source brain's content to the target brain under an
  'Absorbed from' header, stamps the source brain folded-into=<target> (the
  INDEX then renders 'merged -> <target>'), and removes the source topic from
  the names registry. Historical records never move — the archive is
  append-only and the voice-inbox ledger's routed_to history stays; only
  FUTURE routing changes, because route_task.py's resolve_topic and every
  other registry consumer no longer see the merged topic.
- Never merges: thread 0 (general catch-all), the top TOP_ACTIVITY_GUARD topics
  by census (among topics with actual turns — zero-turn topics never occupy
  guard slots), topics with active records (running/queued orchestrator threads,
  open or in-flight topic tasks), EXEMPT.json rows (the operator's hand flag —
  the "operator-created/renamed" guard implemented via the registry that
  exists), thread-id-collision topics, and anything without an eligible target.

Write order is fail-closed: brain writes first, registry removal LAST — a
failure partway leaves the topic registered and merely unstamped, never a
deregistered topic with orphaned brain content.

Output: human lines plus one machine-readable line
`TOPIC_CONSOLIDATION_RESULT: {json}` for the skill's report steps.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

from typing import Dict, List, Optional, Set, Tuple

# IST as a real tzinfo (same convention as topic_brains.py — never a bare
# timedelta shift on a UTC datetime).
IST = timezone(timedelta(hours=5, minutes=30))

# Frozen merge rules (operator feature, 2026-09-14).
MIN_TURNS = 3                 # K: census turns in the window below which a topic is a merge candidate
OVERLAP_THRESHOLD = 0.5       # title token containment of the smaller name required to merge
WINDOW_HOURS = 24             # census window
TOP_ACTIVITY_GUARD = 3        # the N most active topics are never merge sources

# Generic vocabulary that carries no domain meaning when two topic titles are
# compared. Without it, 'claude-support' vs 'zclaude-support' would clear the
# threshold on the shared 'support' and merge two deliberately separate
# per-worker topics.
STOPWORDS = frozenset({
    'support', 'general', 'discussion', 'discussions', 'queries', 'query',
    'misc', 'miscellaneous', 'other', 'stuff', 'things', 'talk', 'chat',
    'topics', 'topic', 'notes', 'updates', 'update', 'info', 'the', 'and',
    'for', 'about',
})

STAMP_PATTERN = re.compile(
    r'<!-- topic-brain: consolidated=([^\s]+) covers=([^\s]+)(?: folded-into=([^\s]+))? ?-->'
)
ANY_STAMP_PATTERN = re.compile(r'<!-- topic-brain: .*? ?-->\n?')
TOPIC_KEY_PATTERN = re.compile(r'^(-?\d+)_(\d+)$')

# Thread-record statuses that mean work is still live on a topic.
LIVE_THREAD_STATUSES = frozenset({'running', 'queued'})


def resolve_pa_home() -> str:
    """PA_HOME from env or ~/.pa (same precedence as topic_brains.py)."""
    return os.environ.get('PA_HOME') or os.path.join(os.path.expanduser('~'), '.pa')


def resolve_paths(pa_home: str) -> Dict[str, str]:
    """Resolve all file paths for topic consolidation."""
    return {
        'pa_home': pa_home,
        'conversation_history': os.path.join(pa_home, 'conversation-history.jsonl'),
        'topic_names': os.path.join(pa_home, 'telegram-topic-names.json'),
        'topic_brains_dir': os.path.join(pa_home, 'topic-brains'),
        'exempt_registry': os.path.join(pa_home, 'topic-brains', 'EXEMPT.json'),
        'consolidation_audit': os.path.join(pa_home, 'consolidation-audit.jsonl'),
        'topic_threads_dir': os.path.join(pa_home, 'topic-threads'),
        'topic_tasks_dir': os.path.join(pa_home, 'topic-tasks'),
    }


def load_registry(path: str) -> Dict[str, Dict[str, dict]]:
    """Load the topic-names registry. MISSING OR UNREADABLE ABORTS the run —
    a merge script that cannot see the full registry must never merge (an
    unseen topic could be the right home for a candidate)."""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError('topic-names registry is not an object')
    for chat_str, threads in data.items():
        if not isinstance(threads, dict):
            raise ValueError(f'registry chat {chat_str} is not an object')
    return data


def save_registry(path: str, data: Dict[str, Dict[str, dict]]) -> None:
    """Persist the registry atomically (tmp + rename, same shape the bot's
    saveTopicNames writes: indent=2). Unknown entry fields pass through
    untouched — only the merged topic's key is deleted."""
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, path)


def load_exempt_registry(path: str) -> Dict[str, str]:
    """EXEMPT.json rows are the operator's hand flags; any class means
    never-a-source. Missing file → no flags (same fail-open as topic_brains)."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}
    except (json.JSONDecodeError, IOError):
        return {}


def census_turns(archive_path: str, now_utc: datetime,
                 window_hours: float = WINDOW_HOURS) -> Dict[int, int]:
    """Count conversation-archive turns per thread within the window.

    Same hygiene as topic_brains.py's spooler: thread_id must be a real int > 0
    (bool excluded), timestamp present and parseable and not the epoch
    sentinel. All roles count — the census is anti-merge protection, so the
    conservative direction is MORE counted activity.
    """
    counts: Dict[int, int] = {}
    if not os.path.exists(archive_path):
        return counts
    cutoff = now_utc - timedelta(hours=window_hours)
    with open(archive_path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                turn = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(turn, dict):
                continue
            thread_id = turn.get('thread_id')
            if not isinstance(thread_id, int) or isinstance(thread_id, bool) or thread_id <= 0:
                continue
            ts_raw = turn.get('timestamp')
            if not ts_raw or not isinstance(ts_raw, str) or ts_raw.startswith('1970-01-01'):
                continue
            try:
                ts = datetime.fromisoformat(ts_raw.replace('Z', '+00:00'))
            except ValueError:
                continue
            if ts < cutoff or ts > now_utc:
                continue
            counts[thread_id] = counts.get(thread_id, 0) + 1
    return counts


def tokenize(name: str) -> Set[str]:
    """Lowercase alphanumeric tokens, stopwords and sub-3-char fragments
    dropped. Digits stay — '2' in a proliferated '-2' topic is signal."""
    raw = re.split(r'[^0-9a-z]+', name.lower())
    return {t for t in raw if len(t) >= 3 and t not in STOPWORDS} | {
        t for t in raw if t.isdigit()
    }


def title_overlap(name_a: str, name_b: str) -> float:
    """Containment of the SMALLER name's token set in the larger: how much of
    the candidate's identity the target's title already covers."""
    tokens_a = tokenize(name_a)
    tokens_b = tokenize(name_b)
    if not tokens_a or not tokens_b:
        return 0.0
    smaller = tokens_a if len(tokens_a) <= len(tokens_b) else tokens_b
    larger = tokens_b if smaller is tokens_a else tokens_a
    return len(smaller & larger) / len(smaller)


def has_active_records(topic_key: str, paths: Dict[str, str]) -> Optional[str]:
    """Reason string when the topic has live records, None when it is quiet.

    Two thread stores checked:
    - topic-threads/<key>.json: any orchestrator thread running or queued.
    - topic-tasks/<key>.json / <key>.running.json: any open or in-flight task
      record. (.notes.json operator notes are durable by design — not live
      records, and the merge never touches them.)
    """
    threads_path = os.path.join(paths['topic_threads_dir'], f'{topic_key}.json')
    if os.path.exists(threads_path):
        try:
            with open(threads_path, 'r', encoding='utf-8') as f:
                records = json.load(f)
            if isinstance(records, dict):
                for rec in records.values():
                    if isinstance(rec, dict) and rec.get('status') in LIVE_THREAD_STATUSES:
                        return f'live orchestrator thread {rec.get("id", "?")} ({rec.get("status")})'
        except (json.JSONDecodeError, IOError, OSError):
            return 'unreadable thread store (fail-closed)'
    for suffix in ('.running.json', '.json'):
        tasks_path = os.path.join(paths['topic_tasks_dir'], f'{topic_key}{suffix}')
        if os.path.exists(tasks_path):
            try:
                with open(tasks_path, 'r', encoding='utf-8') as f:
                    tasks = json.load(f)
                if isinstance(tasks, list) and tasks:
                    return f'{"in-flight" if suffix.startswith(".running") else "open"} topic task(s)'
            except (json.JSONDecodeError, IOError, OSError):
                return 'unreadable topic-task store (fail-closed)'
    return None


def plan_merges(registry: Dict[str, Dict[str, dict]],
                census: Dict[int, int],
                exempt: Dict[str, str],
                paths: Dict[str, str],
                min_turns: int = MIN_TURNS,
                overlap_threshold: float = OVERLAP_THRESHOLD,
                top_activity_guard: int = TOP_ACTIVITY_GUARD
                ) -> Tuple[List[dict], List[dict]]:
    """Pure candidate derivation. Returns (merges, skipped) — each a list of
    dicts; merges carry source/target keys+names+turns+overlap, skipped carry
    a machine-readable reason. Deterministic: sources iterate by (turns,
    threadId) ascending; a target maximises (overlap, turns, -threadId)."""
    # Flatten registry, parse keys, drop unparseable rows.
    topics: Dict[str, dict] = {}
    thread_owner: Dict[int, List[str]] = {}
    for chat_str, threads in registry.items():
        for thread_str, entry in threads.items():
            key = f'{chat_str}_{thread_str}'
            match = TOPIC_KEY_PATTERN.match(key)
            name = entry.get('name', '') if isinstance(entry, dict) else ''
            if not match or not name:
                continue
            thread_id = int(match.group(2))
            topics[key] = {
                'key': key,
                'chat_id': int(match.group(1)),
                'thread_id': thread_id,
                'name': name,
                'turns': census.get(thread_id, 0),
            }
            thread_owner.setdefault(thread_id, []).append(key)

    collisions = {k for k, owners in thread_owner.items() if len(owners) > 1}
    for key in list(topics):
        if topics[key]['thread_id'] in collisions:
            topics[key]['blocked'] = 'thread-id-collision'

    # Top-activity guard ranks topics with ACTUAL turns only — 0-turn topics
    # never occupy guard slots. Ranked over every topic (including the
    # inactive tail), a quiet day would put its few active topics AND every
    # dormant candidate "in the top 3" and the guard would silently eat the
    # whole feature on exactly the settle-down days it exists for.
    ranked_active = sorted(
        (t for t in topics.values() if t['turns'] > 0),
        key=lambda t: (-t['turns'], t['thread_id']))
    top_guarded = {t['key'] for t in ranked_active[:top_activity_guard]}

    merges: List[dict] = []
    skipped: List[dict] = []
    for topic in sorted(topics.values(), key=lambda t: (t['turns'], t['thread_id'])):
        key = topic['key']
        skip = topic.get('blocked')

        # Thread 0 is the general catch-all — never merged away.
        if skip is None and topic['thread_id'] == 0:
            skip = 'general-topic'
        # EXEMPT.json rows are the operator's hand flag (the
        # operator-created/renamed guard, implemented via the registry that
        # exists on disk).
        if skip is None and key in exempt:
            skip = f'operator-flagged ({exempt[key]})'
        # Activity floor before the activity guard: a topic at/above the floor
        # is skipped as a non-candidate regardless of rank; the guard's own
        # reason is reserved for sub-floor topics the rank protects.
        if skip is None and topic['turns'] >= min_turns:
            skip = f'activity-floor ({topic["turns"]} turns >= {min_turns})'
        if skip is None and key in top_guarded:
            skip = f'top-{top_activity_guard}-by-activity'
        if skip is None:
            active = has_active_records(key, paths)
            if active:
                skip = f'active-records ({active})'

        if skip is not None:
            skipped.append({'topic': key, 'name': topic['name'],
                            'turns': topic['turns'], 'reason': skip})
            continue

        best: Optional[dict] = None
        best_rank: Optional[tuple] = None
        for target in topics.values():
            if target['key'] == key:
                continue
            tkey = target['key']
            if tkey in exempt or target['thread_id'] in collisions:
                continue
            # A target is an established home: at the activity floor itself
            # and strictly larger than the source this run.
            if target['turns'] < min_turns or target['turns'] <= topic['turns']:
                continue
            overlap = title_overlap(topic['name'], target['name'])
            if overlap < overlap_threshold:
                continue
            rank = (overlap, target['turns'], -target['thread_id'])
            if best_rank is None or rank > best_rank:
                best_rank = rank
                best = target
        if best is None:
            skipped.append({'topic': key, 'name': topic['name'],
                            'turns': topic['turns'],
                            'reason': 'no-overlapping-larger-topic'})
            continue

        merges.append({
            'source': key,
            'source_name': topic['name'],
            'source_turns': topic['turns'],
            'target': best['key'],
            'target_name': best['name'],
            'target_turns': best['turns'],
            'overlap': round(best_rank[0], 4),
        })

    return merges, skipped


def brain_path_for(paths: Dict[str, str], topic_key: str) -> str:
    return os.path.join(paths['topic_brains_dir'], topic_key, 'BRAIN.md')


def read_brain(paths: Dict[str, str], topic_key: str) -> Optional[str]:
    path = brain_path_for(paths, topic_key)
    if not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8-sig') as f:
        return f.read()


def write_atomically(content: str, path: str) -> bool:
    """tmp + rename (same convention as topic_brains.py)."""
    try:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
        os.replace(tmp, path)
        return True
    except OSError as e:
        print(f'Warning: atomic write failed for {path}: {e}', file=sys.stderr)
        return False


def strip_stamp_lines(content: str) -> str:
    """Remove the finalize-owned stamp line from absorbed content — an
    embedded second stamp inside the target brain could later satisfy
    parse_brain_stamp's first-4096-byte search and misreport the target."""
    return ANY_STAMP_PATTERN.sub('', content, count=1)


def append_absorbed_section(paths: Dict[str, str], target_key: str,
                            source_name: str, merged_date: str,
                            source_content: Optional[str]) -> bool:
    """Append the source brain's content under an 'Absorbed from' header.
    Returns True when the target brain now carries the absorption (also True
    when there was no source brain — a one-line pointer is appended so the
    absorption is still discoverable)."""
    path = brain_path_for(paths, target_key)
    target_content = read_brain(paths, target_key)
    if target_content is None:
        target_content = ''
    section = f'\n\n## Absorbed from {source_name} ({merged_date})\n'
    if source_content:
        section += '\n' + strip_stamp_lines(source_content).strip('\n') + '\n'
    else:
        section += '\n(No topic brain existed for the absorbed topic.)\n'
    return write_atomically(target_content.rstrip('\n') + section, path)


def stamp_folded_into(paths: Dict[str, str], source_key: str,
                      target_key: str) -> bool:
    """Stamp the source brain folded-into=<target> (INDEX then renders
    'merged -> <target>'). Preserves consolidated/covers; inserts a stamp
    after the first heading when absent — the same mechanics topic_brains.py's
    fold path uses. No source brain = nothing to stamp; True (nothing to do)."""
    path = brain_path_for(paths, source_key)
    content = read_brain(paths, source_key)
    if content is None:
        return True
    match = STAMP_PATTERN.search(content)
    if match:
        updated = re.sub(
            r'<!-- topic-brain: .*? ?-->',
            f'<!-- topic-brain: consolidated={match.group(1)} covers={match.group(2)} '
            f'folded-into={target_key} -->',
            content, count=1)
        return write_atomically(updated, path)
    # Absent stamp: insert without fabricating consolidated/covers values —
    # finalize owns those; leave them empty rather than inventing timestamps.
    stamp = f'<!-- topic-brain: consolidated= covers= folded-into={target_key} -->\n\n'
    if content.startswith('#'):
        lines = content.split('\n', 1)
        content = lines[0] + '\n' + stamp + (lines[1] if len(lines) > 1 else '')
    else:
        content = stamp + content
    return write_atomically(content, path)


def append_audit_entry(paths: Dict[str, str], entry: dict) -> None:
    """One consolidation-audit row (same store and shape topic_brains.py
    uses; newline-guarded append)."""
    audit_path = paths['consolidation_audit']
    try:
        with open(audit_path, 'a+b') as f:
            f.seek(0, os.SEEK_END)
            if f.tell() > 0:
                f.seek(-1, os.SEEK_END)
                if f.read(1) != b'\n':
                    f.write(b'\n')
            f.write((json.dumps(entry, ensure_ascii=False) + '\n').encode('utf-8'))
            f.flush()
            os.fsync(f.fileno())
    except OSError as e:
        print(f'Warning: Cannot write audit entry: {e}', file=sys.stderr)


def merge_topic(merge: dict, registry: Dict[str, Dict[str, dict]],
                registry_path: str, paths: Dict[str, str],
                merged_date: str, now_utc: datetime) -> dict:
    """Execute one merge. Fail-closed order: target brain append, source
    stamp, THEN registry removal, then audit — a failure before the registry
    step leaves the topic registered (worst case: an extra absorbed section
    in the target, still correct because the topic stayed registered)."""
    source_key, target_key = merge['source'], merge['target']
    source_content = read_brain(paths, source_key)

    if not append_absorbed_section(paths, target_key, merge['source_name'],
                                   merged_date, source_content):
        return {**merge, 'ok': False, 'error': 'target brain write failed'}
    if not stamp_folded_into(paths, source_key, target_key):
        return {**merge, 'ok': False, 'error': 'source brain stamp failed'}

    chat_key = source_key.rsplit('_', 1)[0]
    thread_key = source_key.rsplit('_', 1)[1]
    registry.get(chat_key, {}).pop(thread_key, None)
    try:
        save_registry(registry_path, registry)
    except OSError as e:
        return {**merge, 'ok': False,
                'error': f'registry write failed (topic still registered): {e}'}

    append_audit_entry(paths, {
        'ts': now_utc.isoformat(),
        'action': 'topic-merged',
        'fact_key': source_key,
        'fact_text': (f"'{merge['source_name']}' ({merge['source_turns']} turns) "
                      f"merged into '{merge['target_name']}' ({target_key})"),
        'category': 'topic-brain',
        'sink': 'topic-brain',
        'source': 'conversation-archive',
        'superseded_key': target_key,
        'superseded_text': None,
        'conflict_detail': None,
    })
    return {**merge, 'ok': True}


def run(pa_home: Optional[str] = None, min_turns: int = MIN_TURNS,
        overlap_threshold: float = OVERLAP_THRESHOLD,
        window_hours: float = WINDOW_HOURS,
        top_activity_guard: int = TOP_ACTIVITY_GUARD,
        dry_run: bool = False) -> int:
    now_utc = datetime.now(timezone.utc)
    pa_home = pa_home or resolve_pa_home()
    paths = resolve_paths(pa_home)

    try:
        registry = load_registry(paths['topic_names'])
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f'ABORT: cannot read topic-names registry ({e}) — merging requires '
              'the full registry', file=sys.stderr)
        return 1

    census = census_turns(paths['conversation_history'], now_utc, window_hours)
    exempt = load_exempt_registry(paths['exempt_registry'])
    merges, skipped = plan_merges(registry, census, exempt, paths,
                                  min_turns=min_turns,
                                  overlap_threshold=overlap_threshold,
                                  top_activity_guard=top_activity_guard)

    results: List[dict] = []
    if not dry_run:
        for merge in merges:
            merged_date = now_utc.astimezone(IST).strftime('%Y-%m-%d')
            result = merge_topic(merge, registry, paths['topic_names'], paths,
                                 merged_date, now_utc)
            results.append(result)
            if result['ok']:
                print(f"merged '{result['source_name']}' ({result['source_turns']} turns) "
                      f"into '{result['target_name']}' "
                      f"(overlap {result['overlap']})")
            else:
                print(f"FAILED merge of '{result['source_name']}': {result['error']}",
                      file=sys.stderr)
    else:
        results = [{**m, 'ok': True, 'dry_run': True} for m in merges]

    summary = {
        'dry_run': dry_run,
        'census_topics': len({tid for tid in census if tid > 0}),
        'window_hours': window_hours,
        'min_turns': min_turns,
        'overlap_threshold': overlap_threshold,
        'merged': [r for r in results if r['ok']],
        'failed': [r for r in results if not r['ok']],
        'skipped': skipped,
    }
    print('TOPIC_CONSOLIDATION_RESULT: ' + json.dumps(summary, ensure_ascii=False))
    return 0 if not summary['failed'] else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Nightly topic consolidation (deterministic; no LLM)')
    parser.add_argument('--min-turns', type=int, default=MIN_TURNS,
                        help=f'activity floor K (default {MIN_TURNS})')
    parser.add_argument('--overlap-threshold', type=float, default=OVERLAP_THRESHOLD,
                        help=f'title token containment threshold (default {OVERLAP_THRESHOLD})')
    parser.add_argument('--window-hours', type=float, default=WINDOW_HOURS,
                        help=f'census window in hours (default {WINDOW_HOURS})')
    parser.add_argument('--top-activity-guard', type=int, default=TOP_ACTIVITY_GUARD,
                        help=f'most-active topics never merged (default {TOP_ACTIVITY_GUARD})')
    parser.add_argument('--dry-run', action='store_true',
                        help='report candidates without writing anything')
    parser.add_argument('--pa-home', default=None,
                        help='override PA_HOME (testing)')
    args = parser.parse_args()

    if args.pa_home:
        os.environ['PA_HOME'] = args.pa_home
    return run(min_turns=args.min_turns,
               overlap_threshold=args.overlap_threshold,
               window_hours=args.window_hours,
               top_activity_guard=args.top_activity_guard,
               dry_run=args.dry_run)


if __name__ == '__main__':
    sys.exit(main())
