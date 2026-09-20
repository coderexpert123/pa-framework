"""
One-shot system/thread/queue status reader for the PA (Personal Assistant)
system, invoked by voice-inbox's `src/system-status.ts` (GET
/api/v1/system/status). Ported from the standalone `system-dashboard/server.py`
dashboard: reads existing PA state files directly (no new state format, no IPC
into the running bot process):

  ~/.pa/topic-threads/*.json   -> per-topic orchestrator thread records
                                   (status: running/queued/done/failed/cancelled)
  ~/.pa/worker-pids/*.json     -> live spawned CLI worker processes (claude/codex/agy/zclaude)
  ~/.pa/blackboard.json        -> active locks, incl. worker-slot-* (global concurrency slots)
  ~/.pa/telegram-bot.lock      -> bot process pid
  ~/.pa/catchup-loop.lock      -> pa catchup loop pid

Unlike the standalone dashboard (a `ThreadingHTTPServer` polled by a browser),
this script runs once per invocation and exits, printing a single JSON line
on stdout. `system-status.ts` spawns it and caches the result briefly so
rapid UI polls don't each fork a process.

Run: python system_status.py
"""

import json
import os
import tempfile
import time

import psutil

PA_HOME = os.path.expanduser("~/.pa")

DIR_SIZE_CACHE_PATH = os.path.join(tempfile.gettempdir(), "pa_dashboard_dirsize_cache.json")
# The walk is the collector's dominant cost: ~1s over ~33k files on a healthy
# machine, measured 11.5s on a degraded one (2026-09-13, uptime 2.7d) — the
# 60s TTL of the pre-fix era made a cold walk blow the server-side spawn
# timeout on roughly every other poll. 300s: an informational size gauge can
# be 5 minutes stale; the server (system-status.ts) serves last-good while a
# refresh runs, so a cold walk no longer blocks any response.
DIR_SIZE_REFRESH_SECS = 300

# ---------------------------------------------------------------------------
# PA state readers
# ---------------------------------------------------------------------------


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return default


def _read_pid_file(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return int(fh.read().strip())
    except (OSError, ValueError):
        return None


def get_threads_and_queue():
    """Sum orchestrator thread statuses across every Telegram topic's store file."""
    topic_dir = os.path.join(PA_HOME, "topic-threads")
    running = []
    queued = []
    active_topics = set()
    total_by_status = {}
    try:
        filenames = os.listdir(topic_dir)
    except OSError:
        filenames = []

    for fname in filenames:
        if not fname.endswith(".json"):
            continue
        topic_key = fname[:-5]
        data = _read_json(os.path.join(topic_dir, fname), default={})
        if not isinstance(data, dict):
            continue
        for tid, rec in data.items():
            if not isinstance(rec, dict):
                continue
            status = rec.get("status", "unknown")
            total_by_status[status] = total_by_status.get(status, 0) + 1
            entry = {
                "topic": topic_key,
                "id": tid,
                "title": rec.get("title", ""),
                "updatedAt": rec.get("updatedAt", ""),
            }
            if status == "running":
                running.append(entry)
                active_topics.add(topic_key)
            elif status == "queued":
                queued.append(entry)
                active_topics.add(topic_key)

    return {
        "running": running,
        "queued": queued,
        "by_status": total_by_status,
        "active_topic_count": len(active_topics),
        "total_topic_count": len(filenames),
    }


def get_worker_processes():
    """Live spawned CLI workers (claude/codex/agy/zclaude), one file per PID."""
    wp_dir = os.path.join(PA_HOME, "worker-pids")
    workers = []
    try:
        filenames = os.listdir(wp_dir)
    except OSError:
        filenames = []

    for fname in filenames:
        if not fname.endswith(".json"):
            continue
        rec = _read_json(os.path.join(wp_dir, fname), default=None)
        if not isinstance(rec, dict):
            continue
        pid = rec.get("pid")
        alive = isinstance(pid, int) and psutil.pid_exists(pid)
        rss = 0
        if alive:
            for check_pid in [pid] + list(rec.get("descendants") or []):
                try:
                    rss += psutil.Process(check_pid).memory_info().rss
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        workers.append(
            {
                "pid": pid,
                "alive": alive,
                "worker": rec.get("worker"),
                "skill": rec.get("skill"),
                "startedAt": rec.get("startedAt"),
                "rss_bytes": rss,
            }
        )
    return workers


def get_worker_slot_capacity():
    """Global concurrency ceiling, mirroring pa/src/lib/dynamic-slots.ts."""
    override = os.environ.get("PA_MAX_CONCURRENT_WORKERS")
    if override is not None:
        try:
            ceiling = int(override)
            derived = False
        except ValueError:
            ceiling = max(4, min(64, psutil.cpu_count() * 4))
            derived = True
    else:
        ceiling = max(4, min(64, psutil.cpu_count() * 4))
        derived = True

    blackboard = _read_json(os.path.join(PA_HOME, "blackboard.json"), default={})
    locks = blackboard.get("active_locks", []) if isinstance(blackboard, dict) else []
    used = sum(1 for lock in locks if str(lock.get("resource", "")).startswith("worker-slot-"))

    return {"used": used, "ceiling": ceiling, "derived": derived}


def get_process_health():
    bot_pid = _read_pid_file(os.path.join(PA_HOME, "telegram-bot.lock"))
    catchup_pid = _read_pid_file(os.path.join(PA_HOME, "catchup-loop.lock"))
    return {
        "bot_pid": bot_pid,
        "bot_alive": bool(bot_pid and psutil.pid_exists(bot_pid)),
        "catchup_pid": catchup_pid,
        "catchup_alive": bool(catchup_pid and psutil.pid_exists(catchup_pid)),
    }


def get_system_stats():
    vm = psutil.virtual_memory()
    disks = {}
    for drive in ["C:/", "D:/"]:
        try:
            du = psutil.disk_usage(drive)
            disks[drive] = {"total": du.total, "used": du.used, "free": du.free, "percent": du.percent}
        except OSError:
            disks[drive] = None
    return {
        # A single fresh-process call with a real interval is accurate here —
        # the background-sampler-thread trick in the standalone dashboard only
        # existed to work around ThreadingHTTPServer handing each request a
        # new thread identity (psutil.cpu_percent(interval=None) tracks "time
        # since last call" per calling thread). Irrelevant for a one-shot script.
        "cpu_percent": psutil.cpu_percent(interval=0.3),
        "cpu_count": psutil.cpu_count(),
        "mem_total": vm.total,
        "mem_used": vm.used,
        "mem_percent": vm.percent,
        "disks": disks,
        "boot_time": psutil.boot_time(),
        "uptime_secs": time.time() - psutil.boot_time(),
    }


def get_assistant_memory_bytes(bot_pid, catchup_pid, worker_procs):
    total = 0
    seen = set()
    for pid in [bot_pid, catchup_pid]:
        if pid and psutil.pid_exists(pid) and pid not in seen:
            seen.add(pid)
            try:
                total += psutil.Process(pid).memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    for w in worker_procs:
        total += w["rss_bytes"]
    return total


def _pa_dir_size():
    """File-based cache (this script has no long-lived background thread to
    hold an in-memory one): repeated invocations within DIR_SIZE_REFRESH_SECS
    skip the directory walk over ~33k files (seconds, not ~1s, on a degraded
    machine — see DIR_SIZE_REFRESH_SECS)."""
    cached = _read_json(DIR_SIZE_CACHE_PATH, default=None)
    now = time.time()
    if isinstance(cached, dict) and now - cached.get("computed_at", 0) < DIR_SIZE_REFRESH_SECS:
        return cached
    total = 0
    count = 0
    for root, _dirs, files in os.walk(PA_HOME):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
                count += 1
            except OSError:
                pass
    result = {"bytes": total, "files": count, "computed_at": now}
    try:
        with open(DIR_SIZE_CACHE_PATH, "w", encoding="utf-8") as fh:
            json.dump(result, fh)
    except OSError:
        pass
    return result


def build_status():
    threads = get_threads_and_queue()
    workers = get_worker_processes()
    slots = get_worker_slot_capacity()
    health = get_process_health()
    system = get_system_stats()
    assistant_mem = get_assistant_memory_bytes(health["bot_pid"], health["catchup_pid"], workers)

    return {
        "generated_at": time.time(),
        "threads": {
            "running_count": len(threads["running"]),
            "queued_count": len(threads["queued"]),
            "running": threads["running"][:25],
            "queued": threads["queued"][:25],
            "by_status": threads["by_status"],
            "active_topic_count": threads["active_topic_count"],
            "total_topic_count": threads["total_topic_count"],
        },
        "workers": {
            "processes": workers,
            "alive_count": sum(1 for w in workers if w["alive"]),
            "slot_used": slots["used"],
            "slot_ceiling": slots["ceiling"],
            "slot_ceiling_derived": slots["derived"],
        },
        "health": health,
        "system": system,
        "assistant_mem_bytes": assistant_mem,
        "pa_dir_size": _pa_dir_size(),
    }


if __name__ == "__main__":
    print(json.dumps(build_status()))
