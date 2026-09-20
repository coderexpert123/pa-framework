"""
Unit tests for the reminders store claim lock (catchup-lane-wedge WP-E,
2026-09-16): reminders_store_lock() in add_reminder.py, and its use by
process_reminders.py (claim_due_reminders/process_reminders) and
add_reminder.add_reminder().
"""
import os
import sys
import json
import time
import threading
import tempfile
import collections
import subprocess
import ctypes
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

# Ensure projects/reminders is on path
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_DIR)

import add_reminder
import process_reminders


@pytest.fixture
def temp_pa_home(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        monkeypatch.setenv("PA_HOME", tmpdir)
        monkeypatch.setattr(add_reminder, "pa_home", tmpdir)
        monkeypatch.setattr(add_reminder, "REMINDERS_FILE", os.path.join(tmpdir, "reminders.json"))
        monkeypatch.setattr(process_reminders, "pa_home", tmpdir)
        monkeypatch.setattr(process_reminders, "REMINDERS_FILE", os.path.join(tmpdir, "reminders.json"))
        monkeypatch.setattr(process_reminders, "PENDING_RESUME_FILE", os.path.join(tmpdir, "pending-reminder-resume.json"))

        # Write dummy secrets.env for process_reminders
        secrets_path = os.path.join(tmpdir, "secrets.env")
        with open(secrets_path, "w", encoding="utf-8") as f:
            f.write("TELEGRAM_BOT_TOKEN=123456789:TEST_BOT_TOKEN_MOCK\n")

        yield tmpdir


class _ThreadSafeRecorder:
    """A thread-safe stand-in for process_reminders.send_text."""

    def __init__(self):
        self.calls = []
        self._lock = threading.Lock()

    def __call__(self, *args, **kwargs):
        with self._lock:
            self.calls.append((args, kwargs))
        return "s-test"


def _write_reminders(reminders_file, reminders):
    with open(reminders_file, "w", encoding="utf-8") as f:
        json.dump(reminders, f, indent=2)


def _due_reminder(message, chat_id="-100111", thread_id=None, seconds_ago=60):
    due_at = (datetime.now(timezone(timedelta(hours=5, minutes=30))) - timedelta(seconds=seconds_ago)).isoformat()
    return {
        "due_at": due_at,
        "message": message,
        "chat_id": chat_id,
        "thread_id": thread_id,
    }


def _future_reminder(message, chat_id="-100111", thread_id=None, seconds_from_now=3600):
    due_at = (datetime.now(timezone(timedelta(hours=5, minutes=30))) + timedelta(seconds=seconds_from_now)).isoformat()
    return {
        "due_at": due_at,
        "message": message,
        "chat_id": chat_id,
        "thread_id": thread_id,
    }


def test_second_processor_that_cannot_claim_sends_nothing_and_keeps_the_reminder(temp_pa_home, monkeypatch):
    reminders_file = process_reminders.REMINDERS_FILE
    _write_reminders(reminders_file, [_due_reminder("claim-1")])

    recorder = _ThreadSafeRecorder()
    monkeypatch.setattr(process_reminders, "send_text", recorder)
    monkeypatch.setattr(process_reminders, "CLAIM_WAIT_S", 0.2)

    with add_reminder.reminders_store_lock(process_reminders.REMINDERS_FILE):
        process_reminders.process_reminders()

        assert recorder.calls == []
        with open(reminders_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        assert len(data) == 1
        assert data[0]["message"] == "claim-1"

    process_reminders.process_reminders()
    process_reminders.process_reminders()

    assert len(recorder.calls) == 1
    args, kwargs = recorder.calls[0]
    assert "claim-1" in args[0]

    with open(reminders_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data == []


def test_concurrent_processors_deliver_each_due_reminder_exactly_once(temp_pa_home, monkeypatch):
    reminders_file = process_reminders.REMINDERS_FILE
    _write_reminders(reminders_file, [
        _due_reminder("c-1"),
        _due_reminder("c-2"),
        _due_reminder("c-3"),
    ])

    recorder = _ThreadSafeRecorder()
    monkeypatch.setattr(process_reminders, "send_text", recorder)

    n_threads = 8
    barrier = threading.Barrier(n_threads)

    def worker():
        barrier.wait()
        process_reminders.process_reminders()

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    labels = []
    for args, kwargs in recorder.calls:
        text = args[0]
        prefix = "*Reminder:* "
        idx = text.find(prefix)
        assert idx != -1
        labels.append(text[idx + len(prefix):])

    assert collections.Counter(labels) == {"c-1": 1, "c-2": 1, "c-3": 1}


def _dead_pid():
    """Spawn a trivial subprocess, wait for it to exit, and return its PID —
    a PID that is guaranteed unparented and dead for the test's lifetime."""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def test_dead_holder_past_stale_age_is_reclaimed(temp_pa_home, monkeypatch):
    # E-A1 (catchup-lane-wedge amendment, 2026-09-16): a lock past
    # STORE_LOCK_STALE_S is reclaimed once its recorded holder PID is
    # confirmed dead.
    reminders_file = process_reminders.REMINDERS_FILE
    _write_reminders(reminders_file, [_due_reminder("stale-1")])

    lock_path = reminders_file + add_reminder.STORE_LOCK_SUFFIX
    dead_pid = _dead_pid()
    fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(dead_pid).encode("ascii"))
    os.close(fd)
    stale_time = time.time() - 120
    os.utime(lock_path, (stale_time, stale_time))

    recorder = _ThreadSafeRecorder()
    monkeypatch.setattr(process_reminders, "send_text", recorder)

    process_reminders.process_reminders()

    assert len(recorder.calls) == 1
    assert "stale-1" in recorder.calls[0][0][0]
    assert not os.path.exists(lock_path)


def test_live_holder_past_stale_age_is_never_reclaimed(temp_pa_home, monkeypatch):
    # E-A1: age alone is not enough — a holder PID that is still alive past
    # STORE_LOCK_STALE_S must be waited on, never reclaimed.
    reminders_file = process_reminders.REMINDERS_FILE
    _write_reminders(reminders_file, [_due_reminder("live-1")])

    lock_path = reminders_file + add_reminder.STORE_LOCK_SUFFIX
    fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode("ascii"))  # our own PID — definitely alive
    os.close(fd)
    stale_time = time.time() - 120
    os.utime(lock_path, (stale_time, stale_time))

    recorder = _ThreadSafeRecorder()
    monkeypatch.setattr(process_reminders, "send_text", recorder)
    monkeypatch.setattr(process_reminders, "CLAIM_WAIT_S", 0.2)

    try:
        process_reminders.process_reminders()

        assert recorder.calls == []
        assert os.path.exists(lock_path)
        with open(reminders_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        assert len(data) == 1
        assert data[0]["message"] == "live-1"
    finally:
        os.remove(lock_path)


def test_unreadable_pid_past_hard_ceiling_is_reclaimed(temp_pa_home, monkeypatch):
    # E-A1: a lock file whose recorded PID cannot be parsed falls back to the
    # hard ceiling STORE_LOCK_HARD_STALE_S rather than being reclaimed at the
    # ordinary STORE_LOCK_STALE_S age (which would race a holder we can't
    # verify is dead), and rather than being held forever.
    reminders_file = process_reminders.REMINDERS_FILE
    _write_reminders(reminders_file, [_due_reminder("hardceiling-1")])

    lock_path = reminders_file + add_reminder.STORE_LOCK_SUFFIX
    fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, b"not-a-pid")
    os.close(fd)
    hard_stale_time = time.time() - (add_reminder.STORE_LOCK_HARD_STALE_S + 60)
    os.utime(lock_path, (hard_stale_time, hard_stale_time))

    recorder = _ThreadSafeRecorder()
    monkeypatch.setattr(process_reminders, "send_text", recorder)

    process_reminders.process_reminders()

    assert len(recorder.calls) == 1
    assert "hardceiling-1" in recorder.calls[0][0][0]
    assert not os.path.exists(lock_path)


def test_add_reminder_fails_loudly_when_the_lock_stays_held(temp_pa_home, monkeypatch, capsys):
    monkeypatch.setattr(add_reminder, "ADD_LOCK_WAIT_S", 0.2)

    with add_reminder.reminders_store_lock(add_reminder.REMINDERS_FILE):
        with pytest.raises(SystemExit) as exc_info:
            add_reminder.add_reminder("2026-09-16T15:00:00+05:30", "held", "-100", None)

    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    assert "reminders store is locked" in captured.err
    assert not os.path.exists(add_reminder.REMINDERS_FILE)


def test_write_back_leaves_no_temp_file(temp_pa_home, monkeypatch):
    reminders_file = process_reminders.REMINDERS_FILE
    _write_reminders(reminders_file, [
        _due_reminder("due-1"),
        _future_reminder("future-1"),
    ])

    recorder = _ThreadSafeRecorder()
    monkeypatch.setattr(process_reminders, "send_text", recorder)

    process_reminders.process_reminders()

    tmp_path = reminders_file + ".tmp"
    lock_path = reminders_file + add_reminder.STORE_LOCK_SUFFIX
    assert not os.path.exists(tmp_path)
    assert not os.path.exists(lock_path)

    with open(reminders_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert len(data) == 1
    assert data[0]["message"] == "future-1"


def test_store_write_happens_while_the_lock_is_held_by_the_current_pid(temp_pa_home, monkeypatch):
    # E-A3 (catchup-lane-wedge amendment, 2026-09-16): deterministic proof
    # that the write-back in claim_due_reminders() happens WHILE the claim
    # lock is held by this process — not merely "usually" (the concurrent
    # 8-thread test above only catches an unprotected write 2 times in 5).
    reminders_file = process_reminders.REMINDERS_FILE
    _write_reminders(reminders_file, [_due_reminder("locked-write-1")])
    lock_path = reminders_file + add_reminder.STORE_LOCK_SUFFIX

    real_replace = os.replace
    observed = {}

    def _spy_replace(src, dst):
        if dst == reminders_file:
            observed["lock_exists"] = os.path.exists(lock_path)
            if observed["lock_exists"]:
                try:
                    with open(lock_path, "r", encoding="ascii") as f:
                        observed["lock_pid"] = int(f.read().strip())
                except (OSError, ValueError):
                    observed["lock_pid"] = None
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", _spy_replace)

    recorder = _ThreadSafeRecorder()
    monkeypatch.setattr(process_reminders, "send_text", recorder)

    process_reminders.process_reminders()

    assert observed.get("lock_exists") is True
    assert observed.get("lock_pid") == os.getpid()
    assert len(recorder.calls) == 1


@pytest.mark.skipif(os.name != "nt", reason="Windows-only liveness path")
def test_pid_with_exit_code_259_reads_as_dead():
    # E-A4 (catchup-lane-wedge amendment, 2026-09-16): a process's own real
    # exit code can legitimately be 259 (STILL_ACTIVE). The GetExitCodeProcess
    # check this replaced would have misread that as "still running";
    # WaitForSingleObject is not fooled by the exit-code value.
    proc = subprocess.Popen([sys.executable, "-c", "import sys; sys.exit(259)"])
    proc.wait()
    assert proc.returncode == 259
    assert add_reminder._pid_is_alive(proc.pid) is False


@pytest.mark.skipif(os.name != "nt", reason="Windows-only liveness path")
def test_pid_of_a_live_process_reads_as_alive():
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert add_reminder._pid_is_alive(proc.pid) is True
    finally:
        proc.terminate()
        proc.wait()


@pytest.mark.skipif(os.name != "nt", reason="Windows-only liveness path")
def test_pid_is_alive_maps_access_denied_to_none_and_invalid_parameter_to_false():
    # A fake kernel32 whose OpenProcess fails, injected so the mapping from
    # GetLastError() code to the tri-state result is verified without
    # depending on real OS-granted/denied access to another process.
    class _FakeKernel32:
        pass

    def _make_fake(error_code):
        fake = _FakeKernel32()

        def _open_process(access, inherit, pid):
            ctypes.set_last_error(error_code)
            return 0

        def _not_called(*args, **kwargs):
            raise AssertionError("must not be called when OpenProcess fails")

        fake.OpenProcess = _open_process
        fake.WaitForSingleObject = _not_called
        fake.CloseHandle = _not_called
        return fake

    ERROR_ACCESS_DENIED = 5
    ERROR_INVALID_PARAMETER = 87

    assert add_reminder._pid_is_alive(4, kernel32=_make_fake(ERROR_ACCESS_DENIED)) is None
    assert add_reminder._pid_is_alive(4, kernel32=_make_fake(ERROR_INVALID_PARAMETER)) is False
