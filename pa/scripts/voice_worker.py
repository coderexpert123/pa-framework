"""Persistent local worker for Telegram voice-note transcription (WP2 of
plans/2026-08-04-telegram-voice-transcription.md).

Started lazily by the bot (WP6) only when `transcription.worker_mode:
persistent` is configured and a voice note actually arrives. Holds the
`transcription` package's module-level Whisper model singleton in RAM across
notes instead of paying model-construction cost per note (see D4/D6 of the
plan). Talks the wire protocol from D5: newline-delimited JSON, one request
per TCP connection, loopback-only.

Why TCP loopback and not a named pipe / Unix socket (D5): CPython has no
stdlib named-pipe *server* on Windows, and AF_UNIX is not available on
Windows CPython either. TCP on 127.0.0.1 with an OS-assigned port is the one
transport that is genuinely the same code on Windows, Linux and macOS.

Security note on the auth token: this process binds ONLY to 127.0.0.1 and
requires a 32-byte hex token (written into the state file below) on every
request. On POSIX the state file is created 0o600. On Windows, os.chmod has
no equivalent effect -- the file's protection is whatever the containing
directory's ACLs already provide. The token is therefore defence-in-depth,
not a guaranteed security boundary, on this platform; do not represent it as
one in any user-facing text.

Why the idle-shutdown watchdog below is neither a declared maintenance job
(CLAUDE.md's AI-100 rule) nor a `pa/tests/timer-inventory.test.ts`
TIMER_ALLOWLIST entry:

  - AI-100 covers recurring work that mutates DURABLE state beyond the
    lifetime of one in-flight operation. This watchdog's only effect is
    terminating its OWN process and unlinking the state file THIS SAME
    process created -- self-cleanup within one process's lifetime, not
    retention. An orphaned state file left behind by a `kill -9` of this
    process is handled separately, by the dead-PID detection in `serve()`'s
    startup redundancy check, which simply overwrites it. There is nothing
    for a GC pass to sweep.
  - It structurally CANNOT take a TIMER_ALLOWLIST entry even if one were
    wanted: that scanner walks `.ts` files only, under pa/src, pa/bin and
    projects/telegram-bot/src (see timer-inventory.test.ts's SCAN_ROOTS). A
    Python file is never visited, and the same test also asserts that every
    allowlist entry's (file, pattern) pair actually occurs `count` times in
    that file -- an entry naming this .py file would assert a count of 0
    against an expected 1 and FAIL THE BUILD. So the justification lives
    here, in this comment, instead.

Manual shutdown one-liner (also documented in docs/TROUBLESHOOTING.md):

    python -c "import json,socket,os;s=json.load(open(os.path.expanduser('~/.pa/voice-worker.json')));c=socket.create_connection(('127.0.0.1',s['port']),5);c.sendall((json.dumps({'op':'shutdown','token':s['token']})+'\n').encode());print(c.makefile().readline())"
"""

import atexit
import json
import os
import secrets
import socket
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timezone

PROTOCOL = 1
DEFAULT_IDLE_MS = 600_000

# Single request line cap (WP2 requirement 5). Requests carry only a path and
# a handful of small scalars, never audio bytes, so 64 KiB is generous.
MAX_REQUEST_LINE_BYTES = 64 * 1024

# How often the accept loop wakes up on its own to notice stop_event (set by
# the idle watchdog or by an authorised "shutdown" request) even with no
# client connecting. Raised from 0.1 to 1.0 (WP2 requirement 6): ~600
# wakeups per idle window instead of ~6000. Shutdown latency does not
# regress because both the watchdog and an authorised shutdown now also call
# _wake_listener() to unblock accept() immediately -- this poll interval is
# only the safety-net backstop for the (never expected) case that fails.
ACCEPT_POLL_S = 1.0

# Deadline for reading one request line / writing one response on an
# already-accepted connection. Does NOT bound how long a `transcribe` op's
# handler is allowed to run (that happens between the read and the write,
# with no socket I/O in progress) -- only guards against a client that
# connects and then never sends anything.
CONNECTION_TIMEOUT_S = 5.0

# Timeout for the internal ping this process makes, at its own startup, to
# check whether an already-running worker answers before deciding to bind a
# second port. Distinct from PA_VOICE_WORKER_PING_TIMEOUT_MS (WP6, the bot's
# client-side probe of an existing worker).
STARTUP_PING_TIMEOUT_S = 2.0

# Bound on simultaneously-handled connections (WP2 requirement 2). Voice
# notes are inherently low-concurrency (one bot, a handful of topics); this
# just prevents an unbounded thread pile-up under a pathological client.
MAX_CONCURRENT_CONNECTIONS = 32
LISTEN_BACKLOG = 64

# Start-race lock (WP2 requirement 4): sibling `<state path>.lock` file,
# claimed via O_CREAT|O_EXCL. Held only across bind+listen+write_state (a
# handful of milliseconds), never across the process's whole lifetime, so a
# `kill -9` mid-start can only block future starts for up to
# _START_LOCK_STALE_S, not forever. A loser waits up to _START_LOCK_WAIT_S
# for the winner to publish a live, answering worker before concluding the
# winner crashed mid-start and force-reclaiming the lock itself.
_START_LOCK_STALE_S = 60.0
_START_LOCK_WAIT_S = 5.0
_START_LOCK_POLL_S = 0.1


def state_path(env=None):
    """${PA_HOME:-~/.pa}/voice-worker.json"""
    env = os.environ if env is None else env
    home = env.get('PA_HOME') or os.path.expanduser('~/.pa')
    return os.path.join(home, 'voice-worker.json')


def read_state(path):
    """Returns the parsed state dict, or None if missing/unparseable/not a dict."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def write_state_atomic(path, payload):
    """tmp + os.replace, 0o600 on POSIX (learn_agent.py's _atomic_write_json
    precedent) -- a readable state file must always imply a fully-written,
    consistent payload, never a torn write."""
    d = os.path.dirname(path) or '.'
    os.makedirs(d, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=d, prefix=os.path.basename(path) + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(payload, f)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            pass  # Windows: no-op beyond the read-only bit; directory ACLs govern.
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _is_pid_alive_windows(pid):
    """Windows liveness probe via OpenProcess + GetExitCodeProcess.

    Deliberately NOT `os.kill(pid, 0)`: on Windows, CPython's os.kill maps
    any signal value that isn't CTRL_C_EVENT/CTRL_BREAK_EVENT (0 included)
    onto TerminateProcess(handle, sig). A liveness probe written as
    `os.kill(pid, 0)` would not raise "process not found" for a dead PID --
    it would actually kill a LIVE target process. This function never opens
    the process for anything beyond PROCESS_QUERY_LIMITED_INFORMATION, so it
    cannot terminate what it inspects.
    """
    import ctypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return False
        return exit_code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def is_pid_alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == 'win32':
        return _is_pid_alive_windows(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just owned by someone else
    except OSError:
        return False
    return True


def _model_loaded():
    # Best-effort proxy: the local backend is only ever touched via a lazy
    # `import transcription` inside the handler, so its presence in
    # sys.modules means the local engine has run at least once in this
    # process. Checking the package's internal singleton directly would
    # require importing it ourselves just to look, defeating the point.
    return 'transcription' in sys.modules


def _check_auth(req, token):
    if not isinstance(req, dict):
        return False
    candidate = req.get('token')
    if not isinstance(candidate, str):
        return False
    return secrets.compare_digest(candidate, token)


def _default_handler_fn(audio_path, **kwargs):
    from transcribe_voice import transcribe_to_envelope  # lazy: WP1's module
    return transcribe_to_envelope(audio_path, **kwargs)


def resolve_idle_ms(env, override=None):
    """explicit kwarg (tests) > PA_VOICE_WORKER_IDLE_MS env var > DEFAULT_IDLE_MS.

    Kwarg-first is load-bearing: test harnesses that pass `idle_ms=` copy
    `os.environ` wholesale into the child env for other reasons, and must
    not have their timing-sensitive assertions perturbed by whatever a
    developer happens to have set in their real shell (WP2 requirement 7).
    A malformed or non-positive env value is warned-and-ignored rather than
    raising -- this knob was previously documented in four places and read
    by zero; a typo here must degrade to the safe default, not crash the
    worker.
    """
    if override is not None:
        return override
    raw = env.get('PA_VOICE_WORKER_IDLE_MS')
    if raw is None or raw == '':
        return DEFAULT_IDLE_MS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        print('voice_worker: ignoring malformed PA_VOICE_WORKER_IDLE_MS=%r' % (raw,), file=sys.stderr)
        return DEFAULT_IDLE_MS
    if value <= 0:
        print('voice_worker: ignoring non-positive PA_VOICE_WORKER_IDLE_MS=%r' % (raw,), file=sys.stderr)
        return DEFAULT_IDLE_MS
    return value


def handle_request(req, *, token, handler_fn=None, start_monotonic=None, idle_s_snapshot=None):
    """Validates token and `op`, dispatches. Never raises.

    `start_monotonic`/`idle_s_snapshot` are optional and only used to fill in
    the `ping` response's `uptime_s`/`idle_s` fields (D5's wire table) --
    callable directly with just (req, token=...) for a stateless check.
    """
    try:
        return _handle_request_inner(
            req, token=token, handler_fn=handler_fn,
            start_monotonic=start_monotonic, idle_s_snapshot=idle_s_snapshot,
        )
    except Exception as exc:
        return {
            'ok': False,
            'error_code': 'other',
            'error': str(exc) or repr(exc),
            'error_type': type(exc).__name__,
        }


def _handle_request_inner(req, *, token, handler_fn, start_monotonic, idle_s_snapshot):
    if not _check_auth(req, token):
        return {'ok': False, 'error_code': 'other', 'error': 'unauthorized', 'error_type': 'AuthError'}

    op = req.get('op')

    if op == 'ping':
        now = time.monotonic()
        uptime_s = (now - start_monotonic) if start_monotonic is not None else 0.0
        idle_s = idle_s_snapshot if idle_s_snapshot is not None else uptime_s
        return {
            'ok': True,
            'pid': os.getpid(),
            'protocol': PROTOCOL,
            'model_loaded': _model_loaded(),
            'uptime_s': uptime_s,
            'idle_s': idle_s,
        }

    if op == 'shutdown':
        return {'ok': True}

    if op == 'transcribe':
        fn = handler_fn if handler_fn is not None else _default_handler_fn
        envelope, _exit_code = fn(
            req.get('audio_path'),
            engine=req.get('engine') or 'auto',
            preference=req.get('engine_preference') or 'auto',
            cloud_order=req.get('cloud_order'),
            language=req.get('language'),
            max_chars=req.get('max_chars'),
        )
        result = dict(envelope)
        result['request_id'] = req.get('request_id')
        return result

    return {'ok': False, 'error_code': 'other', 'error': 'unknown op: %r' % (op,), 'error_type': 'UnknownOp'}


class _OversizeRequest(Exception):
    pass


class _ActivityClock:
    """Tracks in-flight authorised requests and idle time since the last one
    completed (WP2 requirement 1).

    idle_s() reports 0.0 whenever in_flight() > 0, instead of only ever
    being able to report time since the LAST COMPLETED request -- the old
    watchdog read a timestamp written only after a request finished, so a
    single transcription running longer than the idle threshold (measured up
    to 581.7s against a 600s default) could get killed mid-flight. Every
    authorised request must be bracketed with begin()/end(); an unauthorised
    request must call neither (a prober must not keep the worker resident).
    """

    def __init__(self, start_monotonic=None):
        self._lock = threading.Lock()
        self._last_completed_at = time.monotonic() if start_monotonic is None else start_monotonic
        self._in_flight = 0

    def begin(self):
        with self._lock:
            self._in_flight += 1

    def end(self):
        with self._lock:
            self._in_flight = max(0, self._in_flight - 1)
            self._last_completed_at = time.monotonic()

    def in_flight(self):
        with self._lock:
            return self._in_flight

    def idle_s(self):
        with self._lock:
            if self._in_flight > 0:
                return 0.0
            return time.monotonic() - self._last_completed_at


def _recv_line(conn, max_bytes):
    """Reads up to and including the first '\\n' (excluded from the return
    value), capped at max_bytes. Raises _OversizeRequest if that many bytes
    arrive with no newline yet. Returns whatever was read (possibly without a
    trailing newline) if the peer closes early."""
    buf = bytearray()
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            return bytes(buf)
        buf.extend(chunk)
        idx = buf.find(b'\n')
        if idx != -1:
            return bytes(buf[:idx])
        if len(buf) > max_bytes:
            raise _OversizeRequest()


def _send_json(conn, payload):
    try:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8') + b'\n'
        conn.sendall(data)
    except OSError:
        pass


def _ping_existing(state, timeout=STARTUP_PING_TIMEOUT_S):
    try:
        port = int(state.get('port'))
        token = state.get('token')
        if not isinstance(token, str):
            return False
    except (TypeError, ValueError):
        return False
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=timeout) as conn:
            conn.settimeout(timeout)
            conn.sendall((json.dumps({'op': 'ping', 'token': token}) + '\n').encode('utf-8'))
            raw = _recv_line(conn, MAX_REQUEST_LINE_BYTES)
        resp = json.loads(raw.decode('utf-8'))
        return bool(resp.get('ok'))
    except Exception:
        return False


def _wake_listener(port):
    """Opens and immediately closes a loopback connection to `port` to
    unblock a blocking accept() call (WP2 requirement 6), called by both the
    idle watchdog and an authorised shutdown so ACCEPT_POLL_S (now 1.0s,
    up from 0.1s) does not become the shutdown-latency bottleneck it would
    otherwise be. Best-effort: any failure is swallowed since accept()'s own
    poll timeout is still a safety net regardless.

    Rejected alternative: closing the listener socket from another thread
    while accept() is blocked on it -- a classic accept-close race that
    behaves inconsistently across platforms.
    """
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1.0):
            pass
    except OSError:
        pass


def _idle_check_interval_s(idle_ms):
    # Production default (idle_ms=600_000) resolves to 30s, matching D6's
    # "checked every 30s" text. Scaled down for smaller idle_ms so a test
    # using idle_ms in the hundreds-of-ms range doesn't have to wait 30 real
    # seconds for the watchdog to even look. The /6000 divisor (~6 checks per
    # idle window) rather than a tighter /2000 (~2 checks) leaves headroom
    # against scheduling jitter between an activity ping and the next check
    # -- important for test_activity_defers_idle_shutdown, whose 200ms ping
    # cadence against a 600ms idle_ms would otherwise have false-triggered
    # under load on a contended machine.
    return max(0.05, min(30.0, idle_ms / 6000.0))


def _lock_path(path):
    return path + '.lock'


def _acquire_start_lock(path):
    """Exclusively creates the sibling start-lock file via O_CREAT|O_EXCL.

    Returns True if acquired. A stale lock (mtime older than
    _START_LOCK_STALE_S -- e.g. left behind by a `kill -9` mid-start) is
    force-reclaimed rather than blocking every future start forever; the
    reclaim then loops back to attempt its own O_EXCL create so two stale
    lock discoveries can't both believe they've acquired it.
    """
    lock_path = _lock_path(path)
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, str(os.getpid()).encode('ascii'))
            finally:
                os.close(fd)
            return True
        except FileExistsError:
            try:
                age = time.time() - os.path.getmtime(lock_path)
            except OSError:
                continue  # lock vanished between our failed create and stat; retry
            if age < _START_LOCK_STALE_S:
                return False
            try:
                os.unlink(lock_path)
            except OSError:
                pass
            # loop back and attempt the O_EXCL create again


def _release_start_lock(path):
    try:
        os.unlink(_lock_path(path))
    except OSError:
        pass


def _await_published_worker(path, timeout=_START_LOCK_WAIT_S, poll=_START_LOCK_POLL_S):
    """Waits for a competing process to finish publishing a live worker at
    `path`. Returns True if a live, answering worker appeared within
    `timeout`; False if the wait timed out (caller should force-reclaim)."""
    deadline = time.monotonic() + timeout
    while True:
        state = read_state(path)
        if state is not None and is_pid_alive(state.get('pid')) and _ping_existing(state):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(poll)


def _claim_or_defer(path):
    """Resolves start-lock contention for this call to serve().

    Returns 'own' if this process should proceed to bind+listen+publish, or
    'defer' if a competing process already published (or published while we
    waited) a live worker -- the actual fix for the start-race KNOWN GAP:
    two processes that both observe "no worker running yet" in the same
    narrow window used to both bind their own port and write their own
    state file; now only the one that wins the O_EXCL create ever binds.
    """
    overall_deadline = time.monotonic() + _START_LOCK_WAIT_S + 5.0
    wait_budget = _START_LOCK_WAIT_S
    while True:
        if _acquire_start_lock(path):
            return 'own'
        if _await_published_worker(path, timeout=wait_budget):
            return 'defer'
        # The lock holder never published within the wait window -- crashed
        # mid-start, or stuck before writing state. Force-reclaim: treat the
        # lock as abandoned regardless of its age and try again.
        try:
            os.unlink(_lock_path(path))
        except OSError:
            pass
        wait_budget = 1.0
        if time.monotonic() >= overall_deadline:
            # Exhausted reasonable waiting (repeated contention). Claim the
            # lock unconditionally rather than contend forever.
            open(_lock_path(path), 'a').close()
            return 'own'


def _error_path(state_path_):
    d = os.path.dirname(state_path_) or '.'
    return os.path.join(d, 'voice-worker.error')


def _write_start_failure(state_path_, exc):
    """Writes <state dir>/voice-worker.error (WP2 requirement 5) so a
    crashed worker produces some diagnostics somewhere -- today it produces
    none, anywhere."""
    payload = {
        'at': datetime.now(timezone.utc).isoformat(),
        'pid': os.getpid(),
        'error': str(exc) or repr(exc),
        'error_type': type(exc).__name__,
        'traceback': traceback.format_exc(),
    }
    try:
        write_state_atomic(_error_path(state_path_), payload)
    except OSError:
        pass


def _unlink_state_if_owned(path, pid, port):
    """Unlinks `path` only if the state file currently on disk still names
    this exact (pid, port) pair (WP2 requirement 3) -- an unconditional
    unlink lets one worker's cleanup delete a DIFFERENT, newer worker's live
    state file (e.g. after a start-race force-reclaim). Not atomic (no
    portable compare-and-unlink), but shrinks the window from "always wrong"
    to microseconds.
    """
    state = read_state(path)
    if state is None:
        return
    try:
        if int(state.get('pid')) != int(pid):
            return
        if int(state.get('port')) != int(port):
            return
    except (TypeError, ValueError):
        return
    try:
        os.unlink(path)
    except OSError:
        pass


def _handle_connection(conn, *, token, handler_fn, start_monotonic, clock, transcribe_lock, stop_event, port):
    conn.settimeout(CONNECTION_TIMEOUT_S)
    try:
        raw = _recv_line(conn, MAX_REQUEST_LINE_BYTES)
    except _OversizeRequest:
        _send_json(conn, {
            'ok': False, 'error_code': 'other',
            'error': 'request line exceeds %d bytes' % MAX_REQUEST_LINE_BYTES,
            'error_type': 'RequestTooLarge',
        })
        # Drain whatever the client is still sending before the caller closes
        # this socket. Closing with unread bytes still in the receive buffer
        # makes the OS send a RST instead of a graceful FIN, which the peer
        # sees as ConnectionResetError even though it already received a
        # valid response -- a classic TCP gotcha, not a client bug. Bounded
        # by a short timeout so a peer that stops sending entirely (rather
        # than completing its oversized write) can't hang this handler.
        try:
            conn.settimeout(0.5)
            while conn.recv(65536):
                pass
        except OSError:
            pass
        return
    except (OSError, socket.timeout):
        return

    if not raw:
        return

    try:
        req = json.loads(raw.decode('utf-8'))
    except (ValueError, UnicodeDecodeError) as exc:
        _send_json(conn, {
            'ok': False, 'error_code': 'other',
            'error': 'malformed JSON request: %s' % exc,
            'error_type': 'MalformedRequest',
        })
        return

    authorized = _check_auth(req, token)
    op = req.get('op') if isinstance(req, dict) else None

    # Snapshot idle time BEFORE begin() -- begin() makes idle_s() report 0.0
    # for the duration of this request, but a ping needs to report how idle
    # the worker was up to the moment it arrived, not 0 (the snapshot is
    # this request's own contribution to "activity", not a bystander's).
    idle_s_snapshot = clock.idle_s()

    if authorized:
        clock.begin()
    try:
        if authorized and op == 'transcribe':
            # Serialised: only a transcribe op queues behind this lock.
            # ping/shutdown never do (WP2 requirement 2) -- a
            # 581.7s-measured transcription must never make a concurrent
            # ping or shutdown wait behind it.
            with transcribe_lock:
                response = handle_request(
                    req, token=token, handler_fn=handler_fn,
                    start_monotonic=start_monotonic, idle_s_snapshot=idle_s_snapshot,
                )
        else:
            response = handle_request(
                req, token=token, handler_fn=handler_fn,
                start_monotonic=start_monotonic, idle_s_snapshot=idle_s_snapshot,
            )
    finally:
        if authorized:
            clock.end()

    _send_json(conn, response)

    if authorized and op == 'shutdown':
        stop_event.set()
        _wake_listener(port)


def serve(*, env=None, idle_ms=None, handler_fn=None, ready_cb=None, socket_factory=None):
    """Bind 127.0.0.1:0, write state, accept-loop, idle watchdog, cleanup.

    Returns 0 on every normal exit path (redundant-start short-circuit,
    deferred-to-a-winning-competitor start, explicit shutdown, or idle
    timeout). Returns 3 if this process failed to actually start (bind,
    listen, or state-publish raised) -- see <state dir>/voice-worker.error
    for diagnostics. Intended use: `raise SystemExit(serve())`.
    """
    env = os.environ if env is None else env
    idle_ms = resolve_idle_ms(env, override=idle_ms)
    socket_factory = socket_factory or (lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM))
    path = state_path(env)

    existing = read_state(path)
    if existing is not None and is_pid_alive(existing.get('pid')) and _ping_existing(existing):
        return 0  # a live, answering worker already owns this state file

    claim = _claim_or_defer(path)
    if claim == 'defer':
        return 0  # a competing process published a live worker while we waited

    try:
        try:
            listener = socket_factory()
            listener.bind(('127.0.0.1', 0))
            listener.listen(LISTEN_BACKLOG)
            listener.settimeout(ACCEPT_POLL_S)
            port = listener.getsockname()[1]
            token = secrets.token_hex(32)

            state = {
                'pid': os.getpid(),
                'port': port,
                'token': token,
                'started_at': datetime.now(timezone.utc).isoformat(),
                'protocol': PROTOCOL,
            }
            write_state_atomic(path, state)
        except Exception as exc:
            _write_start_failure(path, exc)
            try:
                listener.close()
            except (NameError, OSError):
                pass
            return 3
    finally:
        _release_start_lock(path)

    cleaned_up = threading.Event()

    def _cleanup():
        if cleaned_up.is_set():
            return
        cleaned_up.set()
        _unlink_state_if_owned(path, os.getpid(), port)

    atexit.register(_cleanup)

    start_monotonic = time.monotonic()
    clock = _ActivityClock(start_monotonic)
    stop_event = threading.Event()
    transcribe_lock = threading.Lock()
    conn_semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_CONNECTIONS)
    active_threads = []
    active_threads_lock = threading.Lock()
    check_interval = _idle_check_interval_s(idle_ms)

    def _watchdog():
        while not stop_event.wait(check_interval):
            if clock.idle_s() * 1000.0 >= idle_ms:
                stop_event.set()
                _wake_listener(port)
                return

    watchdog = threading.Thread(target=_watchdog, daemon=True)
    watchdog.start()

    if ready_cb is not None:
        ready_cb(port, token)

    def _run_connection(conn):
        try:
            _handle_connection(
                conn, token=token, handler_fn=handler_fn,
                start_monotonic=start_monotonic, clock=clock,
                transcribe_lock=transcribe_lock, stop_event=stop_event,
                port=port,
            )
        except Exception as exc:  # a malformed client must not kill the loop
            print('voice_worker: connection handler error: %r' % (exc,), file=sys.stderr)
        finally:
            try:
                conn.close()
            except OSError:
                pass
            conn_semaphore.release()

    try:
        while not stop_event.is_set():
            try:
                conn, _addr = listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            if not conn_semaphore.acquire(blocking=False):
                # At the concurrent-connection ceiling -- refuse rather than
                # queue unbounded threads; the peer sees a closed connection
                # and can retry.
                try:
                    conn.close()
                except OSError:
                    pass
                continue
            t = threading.Thread(target=_run_connection, args=(conn,), daemon=True)
            with active_threads_lock:
                active_threads[:] = [th for th in active_threads if th.is_alive()]
                active_threads.append(t)
            t.start()
    finally:
        stop_event.set()
        try:
            listener.close()
        except OSError:
            pass
        # Shutdown joins outstanding per-connection threads with a 2s total
        # budget, then exits regardless (WP2 requirement 2) -- correctness
        # does not depend on every handler finishing (each already sent its
        # response before this point except, at worst, one in-flight
        # transcribe whose client will see a connection close).
        with active_threads_lock:
            threads_to_join = list(active_threads)
        join_deadline = time.monotonic() + 2.0
        for th in threads_to_join:
            remaining = join_deadline - time.monotonic()
            if remaining <= 0:
                break
            th.join(timeout=remaining)
        _cleanup()
        try:
            atexit.unregister(_cleanup)
        except Exception:
            pass

    return 0


if __name__ == '__main__':
    raise SystemExit(serve())
