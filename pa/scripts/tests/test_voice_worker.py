"""Unit tests for pa/scripts/voice_worker.py (WP2).

Every test that needs a live server starts voice_worker.serve() on a
background thread with a `ready_cb` used to synchronise (never a
sleep-and-hope), points PA_HOME at a private tempdir so nothing touches the
operator's real ~/.pa/voice-worker.json, and tears the server down via a
`shutdown` request in addCleanup. No test imports `transcription`, and no
test touches the network beyond loopback.
"""
import json
import os
import queue
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import voice_worker as vw


def _send(port, token, payload_without_token, timeout=5.0):
    req = dict(payload_without_token)
    req['token'] = token
    return _send_raw(port, (json.dumps(req) + '\n').encode('utf-8'), timeout=timeout)


def _send_raw(port, raw_bytes, timeout=5.0, read=True):
    with socket.create_connection(('127.0.0.1', port), timeout=timeout) as conn:
        conn.settimeout(timeout)
        conn.sendall(raw_bytes)
        if not read:
            return None
        buf = b''
        while b'\n' not in buf:
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
    if not buf:
        return None
    line = buf.split(b'\n', 1)[0]
    return json.loads(line.decode('utf-8'))


class _BlockingHandler:
    """A fake WP1 handler_fn that blocks until released. Used to exercise
    the idle-watchdog-must-not-fire-mid-transcription fix (item 1) and the
    ping-must-not-queue-behind-a-transcribe fix (item 2): `entered` lets a
    test know the handler is actually running (not just dispatched), and
    `gate`/`release()` let the test control exactly when it finishes.
    """

    def __init__(self):
        self.entered = threading.Event()
        self.gate = threading.Event()
        self.calls = 0

    def __call__(self, audio_path, **kwargs):
        self.calls += 1
        self.entered.set()
        self.gate.wait(timeout=10.0)
        return ({'ok': True, 'text': 'blocked-result'}, 0)

    def release(self):
        self.gate.set()


class _ServerHarness:
    """Runs voice_worker.serve() on a background thread."""

    def __init__(self, *, idle_ms=None, handler_fn=None, env=None):
        self._owns_tmpdir = env is None
        if env is None:
            self.tmpdir = tempfile.TemporaryDirectory()
            self.env = dict(os.environ)
            self.env['PA_HOME'] = self.tmpdir.name
        else:
            self.tmpdir = None
            self.env = env
        self.idle_ms = idle_ms
        self.handler_fn = handler_fn
        self._ready = queue.Queue(maxsize=1)
        self.port = None
        self.token = None
        self.thread = None
        self.result = queue.Queue(maxsize=1)

    def _ready_cb(self, port, token):
        self._ready.put((port, token))

    def start(self):
        def _run():
            rc = vw.serve(
                env=self.env, idle_ms=self.idle_ms,
                handler_fn=self.handler_fn, ready_cb=self._ready_cb,
            )
            self.result.put(rc)

        self.thread = threading.Thread(target=_run, daemon=True)
        self.thread.start()
        self.port, self.token = self._ready.get(timeout=5.0)
        return self

    def send(self, payload, timeout=5.0):
        return _send(self.port, self.token, payload, timeout=timeout)

    def state_path(self):
        return vw.state_path(self.env)

    def shutdown(self):
        if self.thread is None or not self.thread.is_alive():
            return
        try:
            self.send({'op': 'shutdown'}, timeout=5.0)
        except OSError:
            pass
        self.thread.join(timeout=5.0)

    def cleanup(self):
        self.shutdown()
        if self._owns_tmpdir and self.tmpdir is not None:
            self.tmpdir.cleanup()


class TestStateFileHelpers(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.env = {'PA_HOME': self.tmpdir.name}

    def test_state_path_uses_pa_home(self):
        p = vw.state_path(self.env)
        self.assertEqual(p, os.path.join(self.tmpdir.name, 'voice-worker.json'))

    def test_state_path_defaults_to_home_pa(self):
        p = vw.state_path({})
        self.assertTrue(p.endswith(os.path.join('.pa', 'voice-worker.json')))

    def test_read_state_missing_file_returns_none(self):
        self.assertIsNone(vw.read_state(os.path.join(self.tmpdir.name, 'nope.json')))

    def test_read_state_malformed_json_returns_none(self):
        path = os.path.join(self.tmpdir.name, 'bad.json')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('{not json')
        self.assertIsNone(vw.read_state(path))

    def test_read_state_non_dict_json_returns_none(self):
        path = os.path.join(self.tmpdir.name, 'list.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump([1, 2, 3], f)
        self.assertIsNone(vw.read_state(path))

    def test_write_state_atomic_round_trip_and_no_leftovers(self):
        path = vw.state_path(self.env)
        payload = {'pid': 123, 'port': 4567, 'token': 'ab', 'started_at': 'x', 'protocol': 1}
        vw.write_state_atomic(path, payload)
        self.assertEqual(vw.read_state(path), payload)
        leftovers = [n for n in os.listdir(self.tmpdir.name) if n != 'voice-worker.json']
        self.assertEqual(leftovers, [])


class TestIsPidAlive(unittest.TestCase):
    def test_current_process_is_alive(self):
        self.assertTrue(vw.is_pid_alive(os.getpid()))

    def test_bogus_pid_is_not_alive(self):
        self.assertFalse(vw.is_pid_alive(99999999))

    def test_zero_and_negative_pid_is_not_alive(self):
        self.assertFalse(vw.is_pid_alive(0))
        self.assertFalse(vw.is_pid_alive(-1))

    def test_non_numeric_pid_is_not_alive(self):
        self.assertFalse(vw.is_pid_alive(None))
        self.assertFalse(vw.is_pid_alive('not-a-pid'))

    def test_liveness_check_does_not_kill_the_process(self):
        # Regression guard: on Windows, os.kill(pid, 0) actually terminates
        # the target process (TerminateProcess under the hood) rather than
        # just probing it. Calling is_pid_alive on our own pid twice must
        # leave this very process running both times.
        self.assertTrue(vw.is_pid_alive(os.getpid()))
        self.assertTrue(vw.is_pid_alive(os.getpid()))


class TestModuleImports(unittest.TestCase):
    def test_module_does_not_import_transcription_or_transcribe_voice_at_top_level(self):
        self.assertNotIn('transcription', sys.modules)
        src_path = os.path.join(os.path.dirname(os.path.abspath(vw.__file__)), 'voice_worker.py')
        with open(src_path, 'r', encoding='utf-8') as f:
            top_level_lines = [line for line in f if line and not line[0].isspace()]
        import_lines = [line for line in top_level_lines if line.startswith(('import ', 'from '))]
        joined = ''.join(import_lines)
        self.assertNotIn('transcription', joined)
        self.assertNotIn('transcribe_voice', joined)


class TestResolveIdleMs(unittest.TestCase):
    def test_override_wins_over_env(self):
        self.assertEqual(vw.resolve_idle_ms({'PA_VOICE_WORKER_IDLE_MS': '999'}, override=42), 42)

    def test_env_var_used_when_no_override(self):
        self.assertEqual(vw.resolve_idle_ms({'PA_VOICE_WORKER_IDLE_MS': '12345'}, override=None), 12345)

    def test_default_when_neither_set(self):
        self.assertEqual(vw.resolve_idle_ms({}, override=None), vw.DEFAULT_IDLE_MS)

    def test_malformed_env_var_falls_back_to_default(self):
        self.assertEqual(
            vw.resolve_idle_ms({'PA_VOICE_WORKER_IDLE_MS': 'not-a-number'}, override=None),
            vw.DEFAULT_IDLE_MS,
        )

    def test_non_positive_env_var_falls_back_to_default(self):
        self.assertEqual(vw.resolve_idle_ms({'PA_VOICE_WORKER_IDLE_MS': '0'}, override=None), vw.DEFAULT_IDLE_MS)
        self.assertEqual(vw.resolve_idle_ms({'PA_VOICE_WORKER_IDLE_MS': '-5'}, override=None), vw.DEFAULT_IDLE_MS)


class TestUnlinkStateIfOwned(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.path = os.path.join(self.tmpdir.name, 'voice-worker.json')

    def test_cleanup_does_not_unlink_another_workers_state_file(self):
        vw.write_state_atomic(self.path, {
            'pid': 111, 'port': 1111, 'token': 'a', 'started_at': 'x', 'protocol': 1,
        })
        # A different (newer) worker's identity now owns the file --
        # unlinking on behalf of the OLD (pid, port) must be a no-op.
        vw._unlink_state_if_owned(self.path, 222, 2222)
        self.assertTrue(os.path.exists(self.path))
        self.assertEqual(vw.read_state(self.path)['pid'], 111)

    def test_unlink_state_if_owned_removes_matching_state(self):
        vw.write_state_atomic(self.path, {
            'pid': 111, 'port': 1111, 'token': 'a', 'started_at': 'x', 'protocol': 1,
        })
        vw._unlink_state_if_owned(self.path, 111, 1111)
        self.assertFalse(os.path.exists(self.path))

    def test_unlink_state_if_owned_missing_file_is_a_noop(self):
        vw._unlink_state_if_owned(self.path, 111, 1111)  # must not raise


class TestServeProtocol(unittest.TestCase):
    def test_binds_loopback_only(self):
        h = _ServerHarness().start()
        self.addCleanup(h.cleanup)

        resp = h.send({'op': 'ping'})
        self.assertTrue(resp['ok'])
        state = vw.read_state(h.state_path())
        self.assertEqual(state['port'], h.port)

        try:
            host_ip = socket.gethostbyname(socket.gethostname())
        except OSError:
            host_ip = None
        if host_ip and host_ip != '127.0.0.1':
            with self.assertRaises(OSError):
                with socket.create_connection((host_ip, h.port), timeout=1.0):
                    pass

    def test_state_file_written_atomically_with_expected_fields(self):
        h = _ServerHarness().start()
        self.addCleanup(h.cleanup)
        state = vw.read_state(h.state_path())
        self.assertEqual(state['pid'], os.getpid())
        self.assertEqual(state['port'], h.port)
        self.assertEqual(state['token'], h.token)
        self.assertEqual(len(state['token']), 64)
        int(state['token'], 16)  # raises ValueError if not hex
        self.assertIn('started_at', state)
        self.assertEqual(state['protocol'], vw.PROTOCOL)

    def test_state_file_removed_on_clean_shutdown(self):
        h = _ServerHarness().start()
        self.addCleanup(h.tmpdir.cleanup)
        path = h.state_path()
        self.assertTrue(os.path.exists(path))
        h.shutdown()
        self.assertFalse(os.path.exists(path))

    def test_ping_round_trip(self):
        h = _ServerHarness().start()
        self.addCleanup(h.cleanup)
        resp = h.send({'op': 'ping'})
        self.assertTrue(resp['ok'])
        self.assertEqual(resp['pid'], os.getpid())
        self.assertFalse(resp['model_loaded'])
        self.assertEqual(resp['protocol'], vw.PROTOCOL)
        self.assertIn('uptime_s', resp)
        self.assertIn('idle_s', resp)

    def test_transcribe_round_trip_returns_wp1_envelope_plus_request_id(self):
        canned = {
            'ok': True, 'text': 'hello world', 'engine': 'groq', 'engine_reason': 'x',
            'turns': 1, 'duration_s': 1.2, 'elapsed_s': 0.5, 'truncated': False,
            'fallback_from': None,
        }

        def fake_handler(audio_path, **kwargs):
            return (dict(canned), 0)

        h = _ServerHarness(handler_fn=fake_handler).start()
        self.addCleanup(h.cleanup)
        resp = h.send({'op': 'transcribe', 'audio_path': '/tmp/x.oga', 'request_id': 'req-1'})
        expected = dict(canned)
        expected['request_id'] = 'req-1'
        self.assertEqual(resp, expected)

    def test_error_envelope_preserves_error_code(self):
        canned = {'ok': False, 'error_code': 'no-engine', 'error': 'nope', 'error_type': 'EngineUnavailable'}

        def fake_handler(audio_path, **kwargs):
            return (dict(canned), 1)

        h = _ServerHarness(handler_fn=fake_handler).start()
        self.addCleanup(h.cleanup)
        resp = h.send({'op': 'transcribe', 'audio_path': '/tmp/x.oga', 'request_id': 'r'})
        self.assertFalse(resp['ok'])
        self.assertEqual(resp['error_code'], 'no-engine')
        self.assertEqual(resp['request_id'], 'r')

    def test_bad_token_rejected_and_does_not_reset_idle_clock(self):
        h = _ServerHarness(idle_ms=100000).start()
        self.addCleanup(h.cleanup)
        resp1 = h.send({'op': 'ping'})
        self.assertTrue(resp1['ok'])
        time.sleep(0.3)
        bad = _send(h.port, 'x' * 64, {'op': 'ping'})
        self.assertFalse(bad['ok'])
        self.assertEqual(bad['error_code'], 'other')
        self.assertEqual(bad['error_type'], 'AuthError')
        resp2 = h.send({'op': 'ping'})
        self.assertTrue(resp2['ok'])
        # idle_s reflects time since resp1 (the last AUTHORISED request); the
        # bad-token ping in between must not have reset it, so it should read
        # roughly >= the sleep, not near-zero.
        self.assertGreaterEqual(resp2['idle_s'], 0.25)

    def test_unknown_op_returns_error_not_crash(self):
        h = _ServerHarness().start()
        self.addCleanup(h.cleanup)
        resp = h.send({'op': 'frobnicate'})
        self.assertFalse(resp['ok'])
        self.assertEqual(resp['error_type'], 'UnknownOp')
        resp2 = h.send({'op': 'ping'})
        self.assertTrue(resp2['ok'])

    def test_oversize_request_line_rejected(self):
        h = _ServerHarness().start()
        self.addCleanup(h.cleanup)
        huge = b'{"op":"ping","token":"' + b'a' * (70 * 1024) + b'"}\n'
        resp = _send_raw(h.port, huge)
        self.assertIsNotNone(resp)
        self.assertFalse(resp['ok'])
        resp2 = h.send({'op': 'ping'})
        self.assertTrue(resp2['ok'])

    def test_requests_are_serialised(self):
        window = {'active': 0, 'max_active': 0}
        lock = threading.Lock()

        def fake_handler(audio_path, **kwargs):
            with lock:
                window['active'] += 1
                window['max_active'] = max(window['max_active'], window['active'])
            time.sleep(0.2)
            with lock:
                window['active'] -= 1
            return ({'ok': True, 'text': 'x'}, 0)

        h = _ServerHarness(handler_fn=fake_handler).start()
        self.addCleanup(h.cleanup)
        results = queue.Queue()

        def _client(i):
            results.put(h.send({'op': 'transcribe', 'audio_path': '/a', 'request_id': str(i)}))

        threads = [threading.Thread(target=_client, args=(i,)) for i in range(2)]
        start = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5.0)
        elapsed = time.monotonic() - start

        self.assertEqual(window['max_active'], 1)
        self.assertGreaterEqual(elapsed, 0.35)
        self.assertEqual(results.qsize(), 2)
        while not results.empty():
            self.assertTrue(results.get()['ok'])

    def test_malformed_json_does_not_kill_the_loop(self):
        h = _ServerHarness().start()
        self.addCleanup(h.cleanup)
        resp = _send_raw(h.port, b'{not json\n')
        self.assertIsNotNone(resp)
        self.assertFalse(resp['ok'])
        resp2 = h.send({'op': 'ping'})
        self.assertTrue(resp2['ok'])

    def test_idle_shutdown_exits(self):
        h = _ServerHarness(idle_ms=300).start()
        self.addCleanup(h.tmpdir.cleanup)
        path = h.state_path()
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and os.path.exists(path):
            time.sleep(0.05)
        self.assertFalse(os.path.exists(path))
        h.thread.join(timeout=5.0)
        self.assertFalse(h.thread.is_alive())

    def test_activity_defers_idle_shutdown(self):
        h = _ServerHarness(idle_ms=600).start()
        self.addCleanup(h.cleanup)
        deadline = time.monotonic() + 1.2
        while time.monotonic() < deadline:
            resp = h.send({'op': 'ping'})
            self.assertTrue(resp['ok'])
            time.sleep(0.2)
        self.assertTrue(h.thread.is_alive())
        self.assertTrue(os.path.exists(h.state_path()))

    def test_redundant_start_exits_zero(self):
        h = _ServerHarness().start()
        self.addCleanup(h.cleanup)
        original_port = vw.read_state(h.state_path())['port']
        rc = vw.serve(env=h.env, ready_cb=lambda p, t: None)
        self.assertEqual(rc, 0)
        self.assertEqual(vw.read_state(h.state_path())['port'], original_port)

    def test_stale_state_file_is_overwritten(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        env = dict(os.environ)
        env['PA_HOME'] = tmpdir.name
        path = vw.state_path(env)
        vw.write_state_atomic(path, {
            'pid': 99999999, 'port': 1, 'token': 'deadbeef', 'started_at': 'x', 'protocol': 1,
        })
        h = _ServerHarness(env=env).start()
        self.addCleanup(h.cleanup)
        state = vw.read_state(path)
        self.assertNotEqual(state['pid'], 99999999)
        self.assertEqual(state['pid'], os.getpid())
        resp = h.send({'op': 'ping'})
        self.assertTrue(resp['ok'])

    def test_cloud_only_request_never_imports_transcription(self):
        self.assertNotIn('transcription', sys.modules)
        called = {'n': 0}

        def fake_handler(audio_path, **kwargs):
            called['n'] += 1
            return ({'ok': True, 'text': 'hi', 'engine': 'groq'}, 0)

        h = _ServerHarness(handler_fn=fake_handler).start()
        self.addCleanup(h.cleanup)
        resp = h.send({'op': 'transcribe', 'audio_path': '/a', 'request_id': '1'})
        self.assertTrue(resp['ok'])
        self.assertEqual(called['n'], 1)
        self.assertNotIn('transcription', sys.modules)


class TestIdleWatchdogDoesNotKillInFlight(unittest.TestCase):
    def test_in_flight_request_defers_idle_shutdown(self):
        blocker = _BlockingHandler()
        h = _ServerHarness(idle_ms=200, handler_fn=blocker).start()
        self.addCleanup(h.cleanup)

        result_q = queue.Queue()

        def _send_transcribe():
            result_q.put(h.send({'op': 'transcribe', 'audio_path': '/a', 'request_id': '1'}, timeout=10.0))

        t = threading.Thread(target=_send_transcribe)
        t.start()

        self.assertTrue(blocker.entered.wait(timeout=5.0))
        # idle_ms=200 has now elapsed several times over while the handler
        # is still blocked -- the watchdog must not have fired mid-flight.
        time.sleep(0.8)
        self.assertTrue(h.thread.is_alive())
        self.assertTrue(os.path.exists(h.state_path()))

        blocker.release()
        t.join(timeout=5.0)
        resp = result_q.get(timeout=5.0)
        self.assertTrue(resp['ok'])
        self.assertEqual(resp['text'], 'blocked-result')

    def test_ping_is_answered_while_a_transcribe_is_in_flight(self):
        blocker = _BlockingHandler()
        h = _ServerHarness(handler_fn=blocker).start()
        self.addCleanup(h.cleanup)

        def _send_transcribe():
            h.send({'op': 'transcribe', 'audio_path': '/a', 'request_id': '1'}, timeout=10.0)

        t = threading.Thread(target=_send_transcribe)
        t.start()
        self.assertTrue(blocker.entered.wait(timeout=5.0))

        start = time.monotonic()
        resp = h.send({'op': 'ping'}, timeout=5.0)
        elapsed = time.monotonic() - start
        self.assertTrue(resp['ok'])
        self.assertLess(elapsed, 1.0)

        blocker.release()
        t.join(timeout=5.0)


class TestStartRaceAcrossThreads(unittest.TestCase):
    def test_concurrent_serve_calls_produce_exactly_one_listener(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        env = dict(os.environ)
        env['PA_HOME'] = tmpdir.name

        n = 6
        barrier = threading.Barrier(n)
        ready_ports = queue.Queue()
        results = queue.Queue()

        def _run():
            barrier.wait(timeout=5.0)
            rc = vw.serve(env=env, idle_ms=400, ready_cb=lambda p, t: ready_ports.put(p))
            results.put(rc)

        threads = [threading.Thread(target=_run) for _ in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10.0)

        published = []
        while not ready_ports.empty():
            published.append(ready_ports.get())
        self.assertEqual(len(published), 1, 'more than one serve() call bound a listener: %r' % (published,))

        all_rc = []
        while not results.empty():
            all_rc.append(results.get())
        self.assertEqual(all_rc, [0] * n)

        # Let the winner's own idle watchdog clean up before tmpdir teardown.
        deadline = time.monotonic() + 5.0
        path = vw.state_path(env)
        while time.monotonic() < deadline and os.path.exists(path):
            time.sleep(0.05)


class TestStartRaceAcrossProcesses(unittest.TestCase):
    def test_concurrent_processes_produce_exactly_one_listener(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        env = dict(os.environ)
        env['PA_HOME'] = tmpdir.name
        env['PA_VOICE_WORKER_IDLE_MS'] = '1000'
        script = os.path.join(os.path.dirname(os.path.abspath(vw.__file__)), 'voice_worker.py')

        procs = [
            subprocess.Popen(
                [sys.executable, script], env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            for _ in range(3)
        ]

        def _kill_stragglers():
            for p in procs:
                if p.poll() is None:
                    p.kill()
                    p.wait(timeout=5.0)

        self.addCleanup(_kill_stragglers)

        state_path_ = vw.state_path(env)
        publish_deadline = time.monotonic() + 5.0
        state = None
        while time.monotonic() < publish_deadline:
            state = vw.read_state(state_path_)
            if state is not None:
                break
            time.sleep(0.05)
        self.assertIsNotNone(state, 'no worker process ever published a state file')
        winner_pid = state['pid']

        exit_codes = {}
        hard_deadline = time.monotonic() + 15.0
        for p in procs:
            remaining = max(0.1, hard_deadline - time.monotonic())
            try:
                rc = p.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                p.kill()
                rc = p.wait(timeout=5.0)
            exit_codes[p.pid] = rc

        self.assertTrue(all(rc == 0 for rc in exit_codes.values()), 'exit codes: %r' % (exit_codes,))
        self.assertIn(winner_pid, exit_codes)
        error_path = os.path.join(tmpdir.name, 'voice-worker.error')
        self.assertFalse(os.path.exists(error_path))
        self.assertFalse(os.path.exists(state_path_))


class TestBindFailure(unittest.TestCase):
    def test_bind_failure_writes_a_start_failure_file_and_returns_nonzero(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        env = dict(os.environ)
        env['PA_HOME'] = tmpdir.name

        class _FailingSocket:
            def bind(self, addr):
                raise OSError(99, 'simulated bind failure')

            def close(self):
                pass

        def _ready_cb_must_not_fire(port, token):
            self.fail('ready_cb must not fire on a start failure')

        rc = vw.serve(env=env, ready_cb=_ready_cb_must_not_fire, socket_factory=lambda: _FailingSocket())
        self.assertEqual(rc, 3)

        error_path = os.path.join(tmpdir.name, 'voice-worker.error')
        self.assertTrue(os.path.exists(error_path))
        payload = vw.read_state(error_path)
        self.assertEqual(payload['error_type'], 'OSError')
        self.assertIn('simulated bind failure', payload['error'])
        self.assertIn('traceback', payload)
        self.assertEqual(payload['pid'], os.getpid())
        self.assertIn('at', payload)

        self.assertFalse(os.path.exists(vw.state_path(env)))
        self.assertFalse(os.path.exists(vw._lock_path(vw.state_path(env))))


class TestEnvIdleMsEndToEnd(unittest.TestCase):
    def test_env_idle_ms_end_to_end_shuts_the_worker_down(self):
        tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(tmpdir.cleanup)
        env = dict(os.environ)
        env['PA_HOME'] = tmpdir.name
        env['PA_VOICE_WORKER_IDLE_MS'] = '300'

        h = _ServerHarness(env=env).start()  # idle_ms kwarg left None -> env var must apply
        path = h.state_path()
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and os.path.exists(path):
            time.sleep(0.05)
        self.assertFalse(os.path.exists(path))
        h.thread.join(timeout=5.0)
        self.assertFalse(h.thread.is_alive())


if __name__ == '__main__':
    unittest.main()
