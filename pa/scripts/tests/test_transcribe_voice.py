"""Unit tests for pa/scripts/transcribe_voice.py"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import transcribe_voice as tv


class FakeHTTPError(Exception):
    def __init__(self, status_code):
        self.status_code = status_code
        super().__init__(f"HTTP {status_code}")


class FakeTranscriptResult:
    def __init__(self, text, turns=1):
        self.text = text
        self.turns = list(range(turns))


def make_temp_audio_file(size_bytes=16):
    fd, path = tempfile.mkstemp(suffix=".oga", prefix="pa_voice_test_")
    with os.fdopen(fd, "wb") as fh:
        fh.write(b"\x00" * size_bytes)
    return path


class TranscribeVoiceTestCase(unittest.TestCase):
    def setUp(self):
        self.audio_path = make_temp_audio_file()
        self.addCleanup(lambda: os.path.exists(self.audio_path) and os.remove(self.audio_path))

    def run_capturing_stdout(self, argv, **injections):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = tv.run(argv, **injections)
        return code, buf.getvalue()


class TestModuleImports(TranscribeVoiceTestCase):
    def test_module_imports_without_optional_dependencies(self):
        stub = lambda *a, **kw: FakeTranscriptResult("hello world")
        code, out = self.run_capturing_stdout(
            [self.audio_path], env={}, transcribe_fn=stub
        )
        self.assertEqual(code, 0)
        envelope = json.loads(out)
        self.assertTrue(envelope["ok"])
        self.assertNotIn("transcription", sys.modules)
        self.assertNotIn("faster_whisper", sys.modules)


class TestResolvePlanTable(unittest.TestCase):
    """Parameterised table test covering every row of D3."""

    ORDER = ["groq", "openai", "deepgram"]

    def _env(self, keys_set):
        env = {}
        for k in keys_set:
            env[tv._KEY_ENV_VAR[k]] = "secret"
        return env

    def test_table(self):
        cases = [
            # (engine, preference, keys_set) -> expected plan (list) or "error"
            ("groq", "auto", {"groq"}, ["groq"]),
            ("groq", "auto", set(), "error"),
            ("openai", "cloud", {"openai"}, ["openai"]),
            ("deepgram", "local", set(), "error"),
            ("local", "auto", set(), ["whisper_local"]),
            ("whisper_local", "cloud", {"groq"}, ["whisper_local"]),
            ("cloud", "auto", {"groq", "deepgram"}, ["groq", "deepgram"]),
            ("cloud", "auto", set(), "error"),
            ("auto", "cloud", {"groq", "deepgram"}, ["groq", "deepgram"]),
            ("auto", "cloud", set(), "error"),
            ("auto", "local", {"groq", "openai", "deepgram"}, ["whisper_local"]),
            ("auto", "auto", {"groq", "deepgram"}, ["groq", "deepgram", "whisper_local"]),
            ("auto", "auto", set(), ["whisper_local"]),
        ]
        for engine, preference, keys_set, expected in cases:
            with self.subTest(engine=engine, preference=preference, keys=keys_set):
                env = self._env(keys_set)
                if expected == "error":
                    with self.assertRaises(tv.EngineUnavailable):
                        tv.resolve_plan(engine, preference, self.ORDER, env)
                else:
                    plan = tv.resolve_plan(engine, preference, self.ORDER, env)
                    self.assertEqual(plan, expected)


class TestResolvePlanErrors(unittest.TestCase):
    def test_resolve_plan_cloud_only_with_no_keys_raises_no_engine(self):
        with self.assertRaises(tv.EngineUnavailable) as ctx:
            tv.resolve_plan("cloud", "auto", ["groq", "openai", "deepgram"], {})
        self.assertEqual(str(ctx.exception), tv.NO_ENGINE_HELP)
        self.assertEqual(tv.classify_error(ctx.exception), "no-engine")

    def test_preference_local_never_attempts_cloud(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append((url, kwargs))
            return {"text": "unused"}

        env = {"GROQ_API_KEY": "k", "OPENAI_API_KEY": "k", "DEEPGRAM_API_KEY": "k"}
        plan = tv.resolve_plan("auto", "local", ["groq", "openai", "deepgram"], env)
        self.assertEqual(plan, ["whisper_local"])
        # confirm post_fn is genuinely never touched in a full envelope run
        audio_path = make_temp_audio_file()
        try:
            transcribe_fn = lambda *a, **kw: FakeTranscriptResult("hi")
            envelope, code = tv.transcribe_to_envelope(
                audio_path,
                engine="auto",
                preference="local",
                cloud_order=["groq", "openai", "deepgram"],
                env=env,
                post_fn=post_fn,
                transcribe_fn=transcribe_fn,
            )
        finally:
            os.remove(audio_path)
        self.assertTrue(envelope["ok"])
        self.assertEqual(calls, [])


class TestEnvelopeBehaviour(TranscribeVoiceTestCase):
    def test_auto_auto_falls_back_to_local_after_all_cloud_fail(self):
        def post_fn(url, **kwargs):
            raise RuntimeError("cloud down")

        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("local text")
        env = {"GROQ_API_KEY": "k", "OPENAI_API_KEY": "k"}
        envelope, code = tv.transcribe_to_envelope(
            self.audio_path,
            engine="auto",
            preference="auto",
            cloud_order=["groq", "openai", "deepgram"],
            env=env,
            post_fn=post_fn,
            transcribe_fn=transcribe_fn,
        )
        self.assertEqual(code, 0)
        self.assertTrue(envelope["ok"])
        self.assertEqual(envelope["engine"], "whisper_local")
        self.assertEqual(envelope["fallback_from"], "groq")

    def test_preference_cloud_does_not_fall_back_to_local(self):
        def post_fn(url, **kwargs):
            raise RuntimeError("cloud down")

        local_calls = []

        def transcribe_fn(*a, **kw):
            local_calls.append((a, kw))
            return FakeTranscriptResult("should not run")

        env = {"GROQ_API_KEY": "k", "OPENAI_API_KEY": "k"}
        envelope, code = tv.transcribe_to_envelope(
            self.audio_path,
            engine="auto",
            preference="cloud",
            cloud_order=["groq", "openai", "deepgram"],
            env=env,
            post_fn=post_fn,
            transcribe_fn=transcribe_fn,
        )
        self.assertEqual(code, 1)
        self.assertFalse(envelope["ok"])
        self.assertEqual(local_calls, [])

    def test_success_envelope_single_json_line(self):
        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("hello there")
        code, out = self.run_capturing_stdout(
            [self.audio_path], env={}, transcribe_fn=transcribe_fn
        )
        lines = out.splitlines()
        self.assertEqual(len(lines), 1)
        envelope = json.loads(lines[0])
        self.assertEqual(code, 0)
        self.assertTrue(envelope["ok"])
        self.assertEqual(envelope["text"], "hello there")
        self.assertEqual(envelope["engine"], "whisper_local")
        self.assertEqual(envelope["turns"], 1)
        self.assertFalse(envelope["truncated"])

    def test_truncation_sets_flag_and_caps_length(self):
        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("x" * 5000)
        envelope, code = tv.transcribe_to_envelope(
            self.audio_path,
            engine="local",
            env={},
            max_chars=100,
            transcribe_fn=transcribe_fn,
        )
        self.assertEqual(len(envelope["text"]), 100)
        self.assertTrue(envelope["truncated"])

    def test_engine_failure_returns_error_envelope(self):
        def transcribe_fn(*a, **kw):
            raise RuntimeError("boom")

        envelope, code = tv.transcribe_to_envelope(
            self.audio_path, engine="local", env={}, transcribe_fn=transcribe_fn
        )
        self.assertEqual(code, 1)
        self.assertFalse(envelope["ok"])
        self.assertEqual(envelope["error_type"], "RuntimeError")
        self.assertEqual(envelope["error_code"], "other")
        self.assertTrue(envelope["error"])

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            print(json.dumps(envelope))
        self.assertEqual(len(buf.getvalue().splitlines()), 1)
        json.loads(buf.getvalue())

    def test_missing_file_never_invokes_any_engine(self):
        flags = {"cloud": False, "local": False}

        def post_fn(url, **kwargs):
            flags["cloud"] = True
            return {"text": "x"}

        def transcribe_fn(*a, **kw):
            flags["local"] = True
            return FakeTranscriptResult("x")

        envelope, code = tv.transcribe_to_envelope(
            "D:/nonexistent/path/does-not-exist.oga",
            engine="auto",
            env={"GROQ_API_KEY": "k"},
            post_fn=post_fn,
            transcribe_fn=transcribe_fn,
        )
        self.assertEqual(code, 1)
        self.assertEqual(envelope["error_code"], "missing-file")
        self.assertFalse(flags["cloud"])
        self.assertFalse(flags["local"])

    def test_empty_transcript_is_success(self):
        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("", turns=0)
        envelope, code = tv.transcribe_to_envelope(
            self.audio_path, engine="local", env={}, transcribe_fn=transcribe_fn
        )
        self.assertEqual(code, 0)
        self.assertTrue(envelope["ok"])
        self.assertEqual(envelope["text"], "")


class TestLocalEngine(TranscribeVoiceTestCase):
    def test_local_passes_whisper_local_and_reconcile_off_and_out_dir(self):
        captured = {}

        def transcribe_fn(audio_path, **kwargs):
            captured.update(kwargs)
            self.assertTrue(os.path.isdir(kwargs["out_dir"]))
            return FakeTranscriptResult("ok")

        tv.transcribe_local(self.audio_path, transcribe_fn=transcribe_fn)
        self.assertEqual(captured["engine"], "whisper_local")
        self.assertEqual(captured["reconcile"], "off")
        self.assertTrue(captured["out_dir"])

    def test_whisper_workers_forced_to_one(self):
        os.environ.pop("TRANSCRIBE_WHISPER_WORKERS", None)
        seen = {}

        def transcribe_fn(audio_path, **kwargs):
            seen["value"] = os.environ.get("TRANSCRIBE_WHISPER_WORKERS")
            return FakeTranscriptResult("ok")

        tv.transcribe_local(self.audio_path, transcribe_fn=transcribe_fn)
        self.assertEqual(seen["value"], "1")

        os.environ["TRANSCRIBE_WHISPER_WORKERS"] = "3"
        try:
            tv.transcribe_local(self.audio_path, transcribe_fn=transcribe_fn)
            self.assertEqual(seen["value"], "3")
        finally:
            os.environ.pop("TRANSCRIBE_WHISPER_WORKERS", None)


class TestCloudEngine(TranscribeVoiceTestCase):
    def test_groq_request_shape(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append((url, kwargs))
            return {"segments": [{"text": "hi"}]}

        tv.transcribe_cloud(
            "groq", self.audio_path, env={"GROQ_API_KEY": "abc123"}, post_fn=post_fn
        )
        self.assertEqual(len(calls), 1)
        url, kwargs = calls[0]
        self.assertEqual(url, "https://api.groq.com/openai/v1/audio/transcriptions")
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer abc123")
        self.assertEqual(kwargs["data"]["model"], tv.GROQ_MODEL)
        self.assertEqual(kwargs["data"]["response_format"], "verbose_json")

    def test_deepgram_request_shape(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append((url, kwargs))
            return {"results": {"utterances": [{"transcript": "hi"}]}}

        tv.transcribe_cloud(
            "deepgram", self.audio_path, env={"DEEPGRAM_API_KEY": "xyz"}, post_fn=post_fn
        )
        url, kwargs = calls[0]
        self.assertEqual(kwargs["headers"]["Authorization"], "Token xyz")
        self.assertEqual(kwargs["params"]["diarize"], "true")
        self.assertEqual(kwargs["params"]["punctuate"], "true")
        self.assertEqual(kwargs["params"]["utterances"], "true")

    def test_cloud_response_without_segments_uses_flat_text(self):
        def post_fn(url, **kwargs):
            return {"text": "flat text here"}

        result = tv.transcribe_cloud(
            "groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn
        )
        self.assertEqual(result["text"], "flat text here")

    def test_cloud_retry_policy(self):
        with mock.patch.object(tv.time, "sleep"):
            calls = {"n": 0}

            def post_fn_500_then_ok(url, **kwargs):
                calls["n"] += 1
                if calls["n"] < 3:
                    raise FakeHTTPError(500)
                return {"text": "ok"}

            result = tv.transcribe_cloud(
                "groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn_500_then_ok
            )
            self.assertEqual(calls["n"], 3)
            self.assertEqual(result["text"], "ok")

            calls_401 = {"n": 0}

            def post_fn_401(url, **kwargs):
                calls_401["n"] += 1
                raise FakeHTTPError(401)

            with self.assertRaises(tv.CloudAuthError):
                tv.transcribe_cloud(
                    "groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn_401
                )
            self.assertEqual(calls_401["n"], 1)

    def test_401_classifies_as_cloud_auth(self):
        def post_fn(url, **kwargs):
            raise FakeHTTPError(401)

        with mock.patch.object(tv.time, "sleep"):
            envelope, code = tv.transcribe_to_envelope(
                self.audio_path,
                engine="auto",
                preference="cloud",
                cloud_order=["groq"],
                env={"GROQ_API_KEY": "k"},
                post_fn=post_fn,
            )
        self.assertEqual(code, 1)
        self.assertEqual(envelope["error_code"], "cloud-auth")

    def test_ffmpeg_error_classifies_as_ffmpeg_missing(self):
        def transcribe_fn(*a, **kw):
            raise RuntimeError("ffmpeg not found on PATH")

        envelope, code = tv.transcribe_to_envelope(
            self.audio_path, engine="local", env={}, transcribe_fn=transcribe_fn
        )
        self.assertEqual(envelope["error_code"], "ffmpeg-missing")

    def test_oversize_file_rejected_before_post(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append(1)
            return {"text": "unused"}

        with mock.patch.object(tv.os.path, "getsize", return_value=30 * 1024 * 1024):
            with self.assertRaises(tv.OversizeError) as ctx:
                tv.transcribe_cloud(
                    "groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn
                )
        self.assertIn("25 MiB", str(ctx.exception))
        self.assertEqual(calls, [])
        self.assertEqual(tv.classify_error(ctx.exception), "oversize")


class TestNoEngineHelpText(unittest.TestCase):
    def test_no_engine_help_text_leads_with_the_cloud_recipe(self):
        text = tv.NO_ENGINE_HELP
        self.assertIn("console.groq.com/keys", text)
        self.assertIn("GROQ_API_KEY", text)
        self.assertIn("pa bot restart", text)
        self.assertLess(text.index("GROQ_API_KEY"), text.index("pip install"))
        self.assertIn("docs/BOT_GUIDE.md", text)
        self.assertIn("docs/TROUBLESHOOTING.md", text)


class TestErrorCodeVocabulary(TranscribeVoiceTestCase):
    def test_every_error_code_is_in_the_closed_vocabulary(self):
        cases = []

        # no-engine
        cases.append(tv.format_error(tv.EngineUnavailable(tv.NO_ENGINE_HELP)))
        # cloud-auth
        cases.append(tv.format_error(tv.CloudAuthError("bad key")))
        # ffmpeg-missing
        cases.append(tv.format_error(RuntimeError("ffmpeg not found on PATH")))
        # oversize
        cases.append(tv.format_error(tv.OversizeError("too big")))
        # missing-file
        cases.append(tv.format_error(FileNotFoundError("nope")))
        # other
        cases.append(tv.format_error(RuntimeError("something else")))

        for envelope in cases:
            self.assertIn("error_code", envelope)
            self.assertIn(envelope["error_code"], tv.ERROR_CODES)


class TestEncoding(TranscribeVoiceTestCase):
    def test_non_ascii_survives_round_trip(self):
        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("\u0928\u092e\u0938\u094d\u0924\u0947 caf\u00e9")
        envelope, code = tv.transcribe_to_envelope(
            self.audio_path, engine="local", env={}, transcribe_fn=transcribe_fn
        )
        dumped = json.dumps(envelope, ensure_ascii=False)
        parsed = json.loads(dumped)
        self.assertEqual(parsed["text"], "\u0928\u092e\u0938\u094d\u0924\u0947 caf\u00e9")


class TestMaxCharsDefault(TranscribeVoiceTestCase):
    def test_max_chars_default_is_40000_not_4000(self):
        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("y" * 45000)
        envelope, code = tv.transcribe_to_envelope(
            self.audio_path, engine="local", env={}, transcribe_fn=transcribe_fn
        )
        self.assertEqual(len(envelope["text"]), tv.DEFAULT_MAX_CHARS)
        self.assertEqual(tv.DEFAULT_MAX_CHARS, 40000)
        self.assertTrue(envelope["truncated"])

        transcribe_fn2 = lambda *a, **kw: FakeTranscriptResult("z" * 30000)
        envelope2, code2 = tv.transcribe_to_envelope(
            self.audio_path, engine="local", env={}, transcribe_fn=transcribe_fn2
        )
        self.assertEqual(len(envelope2["text"]), 30000)
        self.assertFalse(envelope2["truncated"])


class FakeClock:
    """Deterministic stand-in for time.monotonic() -- advances only when
    told to (by a sleep_fn), so retry/deadline math is exactly reproducible."""

    def __init__(self, start=0.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class TestErrorPrecedence(TranscribeVoiceTestCase):
    def test_cloud_auth_beats_local_import_error(self):
        def post_fn(url, **kwargs):
            raise FakeHTTPError(401)

        def transcribe_fn(*a, **kw):
            raise ImportError("no transcription package")

        with mock.patch.object(tv.time, "sleep"):
            envelope, code = tv.transcribe_to_envelope(
                self.audio_path,
                engine="auto",
                preference="auto",
                cloud_order=["groq"],
                env={"GROQ_API_KEY": "k"},
                post_fn=post_fn,
                transcribe_fn=transcribe_fn,
            )
        self.assertEqual(code, 1)
        self.assertEqual(envelope["error_code"], "cloud-auth")
        self.assertEqual(len(envelope["attempts"]), 2)
        self.assertEqual(envelope["attempts"][0], {"engine": "groq", "error_code": "cloud-auth", "error_type": "CloudAuthError"})
        self.assertEqual(envelope["attempts"][1], {"engine": "whisper_local", "error_code": "no-engine", "error_type": "EngineUnavailable"})

    def test_ties_break_to_earliest_attempt(self):
        def post_fn(url, **kwargs):
            if "groq" in url:
                raise RuntimeError("groq broke")
            raise RuntimeError("openai broke")

        envelope, code = tv.transcribe_to_envelope(
            self.audio_path,
            engine="auto",
            preference="cloud",
            cloud_order=["groq", "openai"],
            env={"GROQ_API_KEY": "k", "OPENAI_API_KEY": "k"},
            post_fn=post_fn,
        )
        self.assertEqual(code, 1)
        self.assertEqual(envelope["error"], "groq broke")
        self.assertEqual(envelope["error_code"], "other")
        self.assertEqual([a["engine"] for a in envelope["attempts"]], ["groq", "openai"])

    def test_import_error_rewrite_is_unconditional_even_when_local_is_not_the_only_attempt(self):
        # Before this fix, an ImportError only became EngineUnavailable when
        # local was the SOLE plan entry; now it always does, and the priority
        # table (not the plan shape) decides what gets reported.
        def post_fn(url, **kwargs):
            raise RuntimeError("cloud down, not auth-related")

        def transcribe_fn(*a, **kw):
            raise ImportError("transcription package missing")

        envelope, code = tv.transcribe_to_envelope(
            self.audio_path,
            engine="auto",
            preference="auto",
            cloud_order=["groq"],
            env={"GROQ_API_KEY": "k"},
            post_fn=post_fn,
            transcribe_fn=transcribe_fn,
        )
        self.assertEqual(code, 1)
        codes = {a["engine"]: a["error_code"] for a in envelope["attempts"]}
        self.assertEqual(codes, {"groq": "other", "whisper_local": "no-engine"})
        # "no-engine" outranks "other" in _ERROR_CODE_PRIORITY.
        self.assertEqual(envelope["error_code"], "no-engine")


class TestCloudBudget(TranscribeVoiceTestCase):
    def test_retry_stops_once_a_sleep_would_cross_the_deadline(self):
        clock = FakeClock(0.0)
        sleeps = []

        def sleep_fn(seconds):
            sleeps.append(seconds)
            clock.advance(seconds)

        def attempt():
            raise FakeHTTPError(500)

        with mock.patch.object(tv.time, "monotonic", clock):
            with self.assertRaises(FakeHTTPError):
                tv._call_with_retry(attempt, deadline=5.0, sleep_fn=sleep_fn)

        self.assertNotIn(8, sleeps)  # the 8s tier would cross the deadline
        self.assertEqual(sleeps, [1, 3])

    def test_deadline_already_passed_before_any_attempt_raises_timeout_not_none(self):
        def attempt():
            self.fail("attempt_fn must never be called once the deadline has passed")

        with self.assertRaises(TimeoutError):
            tv._call_with_retry(attempt, deadline=-1.0, sleep_fn=lambda s: None)

    def test_deadline_none_retries_unbounded_by_wall_clock(self):
        # Direct calls (no deadline passed) must behave exactly as before.
        calls = {"n": 0}

        def attempt():
            calls["n"] += 1
            if calls["n"] < 3:
                raise FakeHTTPError(500)
            return "ok"

        with mock.patch.object(tv.time, "sleep"):
            result = tv._call_with_retry(attempt, deadline=None)
        self.assertEqual(result, "ok")
        self.assertEqual(calls["n"], 3)

    def test_cloud_budget_shared_across_providers_in_one_envelope_call(self):
        seen_deadlines = []

        def spy(provider, audio_path, **kwargs):
            seen_deadlines.append(kwargs.get("deadline"))
            raise RuntimeError("boom")

        with mock.patch.object(tv, "transcribe_cloud", side_effect=spy):
            tv.transcribe_to_envelope(
                self.audio_path,
                engine="auto",
                preference="cloud",
                cloud_order=["groq", "openai"],
                env={"GROQ_API_KEY": "k", "OPENAI_API_KEY": "k"},
            )

        self.assertEqual(len(seen_deadlines), 2)
        self.assertIsNotNone(seen_deadlines[0])
        self.assertEqual(seen_deadlines[0], seen_deadlines[1])


class TestMakePostFn(unittest.TestCase):
    class _FakeResp:
        def __init__(self, status_code, text="", body=None):
            self.status_code = status_code
            self.text = text
            self._body = body or {}

        def json(self):
            return self._body

    def test_uses_injected_requests_module_and_the_new_timeout_constant(self):
        calls = []

        class FakeRequests:
            def post(self, url, **kwargs):
                calls.append((url, kwargs))
                return TestMakePostFn._FakeResp(200, body={"text": "hi"})

        post_fn = tv._make_post_fn(FakeRequests())
        result = post_fn("http://x", data={"a": 1})
        self.assertEqual(result, {"text": "hi"})
        self.assertEqual(calls[0][1]["timeout"], tv.CLOUD_HTTP_TIMEOUT_S)
        self.assertEqual(tv.CLOUD_HTTP_TIMEOUT_S, 45.0)

    def test_raises_cloud_http_error_on_4xx(self):
        class FakeRequests:
            def post(self, url, **kwargs):
                return TestMakePostFn._FakeResp(404, text="not found")

        post_fn = tv._make_post_fn(FakeRequests())
        with self.assertRaises(tv.CloudHTTPError) as ctx:
            post_fn("http://x")
        self.assertEqual(ctx.exception.status_code, 404)


class TestWhitespaceApiKeys(TranscribeVoiceTestCase):
    def test_whitespace_only_key_is_not_configured_for_explicit_engine(self):
        with self.assertRaises(tv.EngineUnavailable):
            tv.resolve_plan("groq", "auto", ["groq"], {"GROQ_API_KEY": "   "})

    def test_available_list_excludes_whitespace_only_keys(self):
        env = {"GROQ_API_KEY": "  ", "OPENAI_API_KEY": "real-key"}
        plan = tv.resolve_plan("cloud", "auto", ["groq", "openai"], env)
        self.assertEqual(plan, ["openai"])

    def test_transmitted_key_is_stripped(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append(kwargs["headers"]["Authorization"])
            return {"text": "hi"}

        tv.transcribe_cloud(
            "groq", self.audio_path, env={"GROQ_API_KEY": "  abc123  "}, post_fn=post_fn
        )
        self.assertEqual(calls[0], "Bearer abc123")


class TestDeepgramSizeGuard(TranscribeVoiceTestCase):
    def test_deepgram_oversize_rejected_before_post(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append(1)
            return {"results": {"utterances": []}}

        with mock.patch.object(tv.os.path, "getsize", return_value=3 * tv.GiB):
            with self.assertRaises(tv.OversizeError) as ctx:
                tv.transcribe_cloud(
                    "deepgram", self.audio_path, env={"DEEPGRAM_API_KEY": "k"}, post_fn=post_fn
                )
        self.assertIn("2 GiB", str(ctx.exception))
        self.assertEqual(calls, [])
        self.assertEqual(tv.classify_error(ctx.exception), "oversize")

    def test_deepgram_under_ceiling_is_not_rejected(self):
        def post_fn(url, **kwargs):
            return {"results": {"utterances": []}}

        with mock.patch.object(tv.os.path, "getsize", return_value=30 * tv.MiB):
            tv.transcribe_cloud(
                "deepgram", self.audio_path, env={"DEEPGRAM_API_KEY": "k"}, post_fn=post_fn
            )  # should not raise


class TestFfmpegMisclassification(unittest.TestCase):
    def test_ffmpeg_mentioned_in_cloud_error_body_is_not_ffmpeg_missing(self):
        exc = tv.CloudHTTPError(400, "our ffmpeg-based pipeline could not decode this file")
        self.assertEqual(tv.classify_error(exc), "other")

    def test_posix_missing_ffmpeg_file_not_found_classifies_as_ffmpeg_missing(self):
        exc = FileNotFoundError("[Errno 2] No such file or directory: 'ffmpeg'")
        self.assertEqual(tv.classify_error(exc), "ffmpeg-missing")

    def test_generic_file_not_found_still_classifies_as_missing_file(self):
        exc = FileNotFoundError("No such audio file: /tmp/gone.oga")
        self.assertEqual(tv.classify_error(exc), "missing-file")

    def test_cloud_http_error_401_classifies_cloud_auth_never_text_sniffed(self):
        exc = tv.CloudHTTPError(401, "unauthorized, ffmpeg mentioned here too")
        self.assertEqual(tv.classify_error(exc), "cloud-auth")


class TestUploadPart(unittest.TestCase):
    def test_openai_oga_normalized_to_ogg(self):
        filename, mime = tv._upload_part("openai", "/tmp/foo.oga")
        self.assertEqual(filename, "foo.ogg")
        self.assertEqual(mime, "audio/ogg")

    def test_openai_opus_normalized_to_ogg(self):
        filename, mime = tv._upload_part("openai", "/tmp/bar.opus")
        self.assertEqual(filename, "bar.ogg")
        self.assertEqual(mime, "audio/ogg")

    def test_groq_keeps_real_basename_and_extension(self):
        filename, mime = tv._upload_part("groq", "/tmp/foo.oga")
        self.assertEqual(filename, "foo.oga")
        self.assertEqual(mime, "audio/ogg")

    def test_mp4_mime_recognized(self):
        filename, mime = tv._upload_part("groq", "/tmp/clip.mp4")
        self.assertEqual(filename, "clip.mp4")
        self.assertEqual(mime, "audio/mp4")

    def test_unknown_extension_falls_back_to_octet_stream(self):
        filename, mime = tv._upload_part("groq", "/tmp/clip.xyz")
        self.assertEqual(mime, "application/octet-stream")


class TestLanguageThreading(TranscribeVoiceTestCase):
    def test_groq_language_uses_iso_part_before_region(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append(kwargs["data"].get("language"))
            return {"text": "hi"}

        tv.transcribe_cloud(
            "groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn, language="en-US"
        )
        self.assertEqual(calls[0], "en")

    def test_openai_language_uses_iso_part_before_region(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append(kwargs["data"].get("language"))
            return {"text": "hi"}

        tv.transcribe_cloud(
            "openai", self.audio_path, env={"OPENAI_API_KEY": "k"}, post_fn=post_fn, language="hi-IN"
        )
        self.assertEqual(calls[0], "hi")

    def test_deepgram_language_is_region_qualified(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append(kwargs["params"].get("language"))
            return {"results": {"utterances": []}}

        tv.transcribe_cloud(
            "deepgram", self.audio_path, env={"DEEPGRAM_API_KEY": "k"}, post_fn=post_fn, language="en-US"
        )
        self.assertEqual(calls[0], "en-US")

    def test_language_key_omitted_when_not_set(self):
        calls = []

        def post_fn(url, **kwargs):
            calls.append(kwargs["data"])
            return {"text": "hi"}

        tv.transcribe_cloud("groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn)
        self.assertNotIn("language", calls[0])

    def test_local_language_hint_still_threaded(self):
        captured = {}

        def transcribe_fn(audio_path, **kwargs):
            captured.update(kwargs)
            return FakeTranscriptResult("ok")

        tv.transcribe_local(self.audio_path, language="fr", transcribe_fn=transcribe_fn)
        self.assertEqual(captured["language_hint"], "fr")


class TestSpeakerLabels(TranscribeVoiceTestCase):
    def test_single_speaker_deepgram_output_byte_identical_to_today(self):
        def post_fn(url, **kwargs):
            return {"results": {"utterances": [{"transcript": "hello"}, {"transcript": "world"}]}}

        result = tv.transcribe_cloud(
            "deepgram", self.audio_path, env={"DEEPGRAM_API_KEY": "k"}, post_fn=post_fn
        )
        self.assertEqual(result["text"], "hello world")
        self.assertEqual(result["speakers"], 1)

    def test_multi_speaker_deepgram_output_gets_labelled_lines(self):
        def post_fn(url, **kwargs):
            return {
                "results": {
                    "utterances": [
                        {"transcript": "hi there", "speaker": 0},
                        {"transcript": "hello back", "speaker": 1},
                        {"transcript": "how are you", "speaker": 0},
                    ]
                }
            }

        result = tv.transcribe_cloud(
            "deepgram", self.audio_path, env={"DEEPGRAM_API_KEY": "k"}, post_fn=post_fn
        )
        self.assertEqual(
            result["text"],
            "Speaker 1: hi there\nSpeaker 2: hello back\nSpeaker 1: how are you",
        )
        self.assertEqual(result["speakers"], 2)

    def test_groq_openai_local_always_report_one_speaker(self):
        def post_fn(url, **kwargs):
            return {"text": "hi"}

        result = tv.transcribe_cloud("groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn)
        self.assertEqual(result["speakers"], 1)

        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("hi")
        local_result = tv.transcribe_local(self.audio_path, transcribe_fn=transcribe_fn)
        self.assertEqual(local_result["speakers"], 1)

    def test_envelope_carries_speakers_field(self):
        def post_fn(url, **kwargs):
            return {
                "results": {
                    "utterances": [
                        {"transcript": "hi", "speaker": 0},
                        {"transcript": "yo", "speaker": 1},
                    ]
                }
            }

        envelope, code = tv.transcribe_to_envelope(
            self.audio_path,
            engine="deepgram",
            env={"DEEPGRAM_API_KEY": "k"},
            post_fn=post_fn,
        )
        self.assertEqual(code, 0)
        self.assertEqual(envelope["speakers"], 2)


class TestDurationParsing(TranscribeVoiceTestCase):
    def test_groq_duration_parsed_from_verbose_json(self):
        def post_fn(url, **kwargs):
            return {"text": "hi", "duration": 12.5}

        result = tv.transcribe_cloud("groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn)
        self.assertEqual(result["duration_s"], 12.5)

    def test_deepgram_duration_parsed_from_metadata(self):
        def post_fn(url, **kwargs):
            return {"results": {"metadata": {"duration": 30.0}, "utterances": []}}

        result = tv.transcribe_cloud(
            "deepgram", self.audio_path, env={"DEEPGRAM_API_KEY": "k"}, post_fn=post_fn
        )
        self.assertEqual(result["duration_s"], 30.0)

    def test_duration_absent_is_none_not_an_error(self):
        def post_fn(url, **kwargs):
            return {"text": "hi"}

        result = tv.transcribe_cloud("groq", self.audio_path, env={"GROQ_API_KEY": "k"}, post_fn=post_fn)
        self.assertIsNone(result["duration_s"])

    def test_local_duration_none_when_result_lacks_it(self):
        transcribe_fn = lambda *a, **kw: FakeTranscriptResult("hi")
        result = tv.transcribe_local(self.audio_path, transcribe_fn=transcribe_fn)
        self.assertIsNone(result["duration_s"])

    def test_local_duration_used_when_result_exposes_it(self):
        class ResultWithDuration(FakeTranscriptResult):
            def __init__(self, text):
                super().__init__(text)
                self.duration_s = 42.0

        transcribe_fn = lambda *a, **kw: ResultWithDuration("hi")
        result = tv.transcribe_local(self.audio_path, transcribe_fn=transcribe_fn)
        self.assertEqual(result["duration_s"], 42.0)


class TestUnknownCloudOrderEntry(unittest.TestCase):
    def test_unknown_cloud_order_entry_warns_and_drops(self):
        with self.assertLogs(level="WARNING") as cm:
            plan = tv.resolve_plan("cloud", "auto", ["groq", "bogus"], {"GROQ_API_KEY": "k"})
        self.assertEqual(plan, ["groq"])
        self.assertTrue(any("bogus" in msg for msg in cm.output))

    def test_all_unknown_cloud_order_entries_falls_back_to_no_engine(self):
        with self.assertLogs(level="WARNING"):
            with self.assertRaises(tv.EngineUnavailable):
                tv.resolve_plan("cloud", "auto", ["bogus1", "bogus2"], {})


class TestNoEngineHelpNoTodoPlaceholder(unittest.TestCase):
    def test_no_engine_help_contains_no_todo_placeholder(self):
        self.assertNotIn("TODO", tv.NO_ENGINE_HELP)

    def test_no_engine_help_still_offers_the_editable_install_recipe(self):
        self.assertIn("pip install -e <path to your", tv.NO_ENGINE_HELP)


if __name__ == "__main__":
    unittest.main()
