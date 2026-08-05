"""Transcription bridge script for Telegram voice notes.

Resolves which transcription engine to use (cloud REST API or local Whisper)
and prints exactly one JSON envelope to stdout. This is the ONLY place engine
resolution happens -- the bot passes config-derived preferences down as flags
and never decides the engine itself.

Why the cloud path does not import the `transcription` package: that package's
pyproject.toml declares faster-whisper, yt-dlp and google-genai as
UNCONDITIONAL dependencies, so importing it at all -- even just to reach a
30-line REST helper -- drags a multi-hundred-MB local-inference stack onto a
machine that only wants to call a hosted cloud ASR API. The Groq/OpenAI/
Deepgram callers below are therefore a small, deliberate duplication of a
plain multipart POST, not a reimplementation of any STT logic. Only the local
engine path lazily imports `transcription`, because it needs the heavy stack
regardless of how it is packaged. Do not "simplify" this by importing the
package unconditionally.
"""
import argparse
import json
import logging
import os
import sys
import tempfile
import time

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

CLOUD_PROVIDERS = ("groq", "openai", "deepgram")
ERROR_CODES = ("no-engine", "cloud-auth", "ffmpeg-missing", "oversize", "missing-file", "other")

# Priority order used by select_reported_error when several attempts in one
# plan fail with different classifications -- lowest index wins, ties break
# to the earliest attempt. "no-engine" ranks below the other specific codes
# because it is a rewrite of ImportError (see the attempt loop below) and a
# real cloud failure (bad key, oversize file, ...) is always more actionable
# to report than "nothing is installed".
_ERROR_CODE_PRIORITY = ("cloud-auth", "oversize", "ffmpeg-missing", "missing-file", "no-engine", "other")

# Guards against Whisper hallucination loops (silence/noise repeating a short
# phrase indefinitely), NOT a duration-derived cap -- a full 30-minute note at
# normal speech is ~27,000 chars, well under this. Do not tie this back to
# PA_VOICE_MAX_DURATION_S. See plan D11.
DEFAULT_MAX_CHARS = 40000

RETRY_DELAYS = (1, 3, 8)
MiB = 1024 * 1024
GiB = 1024 * 1024 * 1024
_MAX_UPLOAD_BYTES = {"groq": 25 * MiB, "openai": 25 * MiB, "deepgram": 2 * GiB}

# Shared across every cloud attempt within a single transcribe_to_envelope
# call (not per-provider) -- a request that fails over groq -> openai ->
# deepgram must not be able to cost 3x this budget against the bot's own
# client-side timeout.
CLOUD_TOTAL_BUDGET_S = 90.0
CLOUD_HTTP_TIMEOUT_S = 45.0

GROQ_MODEL = "whisper-large-v3-turbo"
OPENAI_MODEL = "whisper-1"
DEEPGRAM_MODEL = "nova-2"

_KEY_ENV_VAR = {
    "groq": "GROQ_API_KEY",
    "openai": "OPENAI_API_KEY",
    "deepgram": "DEEPGRAM_API_KEY",
}

_EXT_MIME = {
    ".oga": "audio/ogg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".amr": "audio/amr",
}

# OpenAI's documented accepted-extension list does not include .oga/.opus --
# this only ever changes the TRANSMITTED filename, never touches the file on
# disk. Groq accepts .oga fine and keeps the real basename.
_OPENAI_EXT_ALIAS = {".oga": ".ogg", ".opus": ".ogg"}

NO_ENGINE_HELP = """No transcription engine is available yet.

FASTEST FIX (about a minute, no install): get a free API key at
https://console.groq.com/keys, add this line to ~/.pa/secrets.env

    GROQ_API_KEY=<your key>

and restart the bot (pa bot restart). Voice notes then transcribe in the cloud in
a few seconds. OPENAI_API_KEY and DEEPGRAM_API_KEY work the same way.

FULLY OFFLINE INSTEAD (nothing leaves your machine, but slower and heavier):
install the `transcription` Python package -- pip install -e <path to your
checkout> -- plus ffmpeg on PATH, then set `transcription: {engine_preference:
local}` in ~/.pa/config.yaml. Expect roughly a gigabyte of dependencies and one
to several minutes per voice note on CPU.

Details: docs/BOT_GUIDE.md "Voice messages (speech to text)".
Stuck: docs/TROUBLESHOOTING.md "No transcription engine is set up yet"."""


class EngineUnavailable(RuntimeError):
    """Raised when NO engine can run. Carries error_code == 'no-engine'."""


class CloudAuthError(RuntimeError):
    """Raised when a cloud provider rejects the API key (401/403)."""


class OversizeError(RuntimeError):
    """Raised when a file exceeds a provider's upload ceiling."""


class CloudHTTPError(RuntimeError):
    """Raised by the default (non-injected) post_fn on a non-2xx HTTP response."""

    def __init__(self, status_code, message=""):
        self.status_code = status_code
        super().__init__(message or f"HTTP {status_code}")


def build_parser():
    parser = argparse.ArgumentParser(
        description="Transcribe a Telegram voice note via cloud or local Whisper."
    )
    parser.add_argument("audio_path")
    parser.add_argument(
        "--engine",
        default="auto",
        choices=["auto", "cloud", "local", "whisper_local", "groq", "openai", "deepgram"],
    )
    parser.add_argument(
        "--engine-preference", default="auto", choices=["auto", "cloud", "local"]
    )
    parser.add_argument("--cloud-order", default="groq,openai,deepgram")
    parser.add_argument("--language", default=None)
    parser.add_argument("--max-chars", type=int, default=None)
    return parser


def _key_for(provider, env):
    """Stripped API key for `provider`. A key is 'configured' iff this is
    non-empty, and this stripped value is what gets transmitted -- a
    whitespace-only secrets.env value must not count as configured."""
    raw = (env or {}).get(_KEY_ENV_VAR.get(provider, ""), "") or ""
    return raw.strip()


def resolve_plan(engine, preference, cloud_order, env):
    """Pure function. Returns the ORDERED list of engine attempts implied by D3's
    decision table, e.g. ["groq", "openai", "whisper_local"] or ["whisper_local"].
    Raises EngineUnavailable with the NO_ENGINE_HELP text when the table says
    'error' (a cloud-only request with no key configured)."""
    env = env or {}
    order = list(cloud_order) if cloud_order else list(CLOUD_PROVIDERS)

    valid_order = []
    for provider in order:
        if provider in CLOUD_PROVIDERS:
            valid_order.append(provider)
        else:
            logging.warning(
                "transcribe_voice: cloud_order entry %r is not one of %s; dropping it",
                provider,
                "|".join(CLOUD_PROVIDERS),
            )
    order = valid_order

    available = [p for p in order if _key_for(p, env)]

    if engine in CLOUD_PROVIDERS:
        if not _key_for(engine, env):
            raise EngineUnavailable(NO_ENGINE_HELP)
        return [engine]

    if engine in ("local", "whisper_local"):
        return ["whisper_local"]

    if engine == "cloud":
        if available:
            return list(available)
        raise EngineUnavailable(NO_ENGINE_HELP)

    # engine == "auto"
    if preference == "cloud":
        if available:
            return list(available)
        raise EngineUnavailable(NO_ENGINE_HELP)
    if preference == "local":
        return ["whisper_local"]
    # preference == "auto"
    if available:
        return list(available) + ["whisper_local"]
    return ["whisper_local"]


def _looks_like_missing_ffmpeg(exc):
    """True only for a genuine 'ffmpeg/ffprobe binary not found' shape.
    CloudHTTPError bodies are NEVER text-sniffed here -- a cloud 400 response
    that happens to mention "ffmpeg" in its error body is not a local
    ffmpeg-missing condition, and must not be misreported as one."""
    if isinstance(exc, CloudHTTPError):
        return False
    text = str(exc).lower()
    if "ffmpeg" not in text and "ffprobe" not in text:
        return False
    return (
        isinstance(exc, FileNotFoundError)
        or "not found" in text
        or "no such file" in text
        or "cannot find" in text
        or "not recognized" in text
    )


def classify_error(exc):
    """Map an exception to one of ERROR_CODES, in this exact precedence:
    EngineUnavailable -> no-engine
    CloudAuthError -> cloud-auth
    OversizeError -> oversize
    _looks_like_missing_ffmpeg(exc) -> ffmpeg-missing     (BEFORE FileNotFoundError)
    FileNotFoundError -> missing-file
    CloudHTTPError -> cloud-auth if status in (401,403) else other (never text-sniffed)
    otherwise -> other
    """
    if isinstance(exc, EngineUnavailable):
        return "no-engine"
    if isinstance(exc, CloudAuthError):
        return "cloud-auth"
    if isinstance(exc, OversizeError):
        return "oversize"
    if _looks_like_missing_ffmpeg(exc):
        return "ffmpeg-missing"
    if isinstance(exc, FileNotFoundError):
        return "missing-file"
    if isinstance(exc, CloudHTTPError):
        status = getattr(exc, "status_code", None)
        return "cloud-auth" if status in (401, 403) else "other"
    return "other"


def select_reported_error(attempt_errors):
    """attempt_errors: ordered list of (engine, exc) tuples, in attempt order.
    Returns the exc whose classify_error() code has the lowest index in
    _ERROR_CODE_PRIORITY (i.e. the most actionable failure); ties keep the
    earliest attempt."""
    best_exc = None
    best_rank = None
    for _engine, exc in attempt_errors:
        rank = _ERROR_CODE_PRIORITY.index(classify_error(exc))
        if best_rank is None or rank < best_rank:
            best_exc = exc
            best_rank = rank
    return best_exc


def _make_post_fn(requests_module):
    """Build the default post_fn from an injected `requests` module, without
    touching sys.modules -- keeps test_module_imports_without_optional_dependencies
    valid while still being directly testable."""

    def post_fn(url, **kwargs):
        resp = requests_module.post(url, timeout=CLOUD_HTTP_TIMEOUT_S, **kwargs)
        if resp.status_code >= 400:
            raise CloudHTTPError(resp.status_code, resp.text)
        return resp.json()

    return post_fn


def _upload_ceiling(provider):
    return _MAX_UPLOAD_BYTES.get(provider)


def _format_size(num_bytes):
    if num_bytes >= GiB and num_bytes % GiB == 0:
        return f"{num_bytes // GiB} GiB"
    return f"{num_bytes // MiB} MiB"


def _upload_part(provider, audio_path):
    """Return (filename, mime) to transmit for `provider`. Groq keeps the real
    basename; OpenAI gets its extension normalized via _OPENAI_EXT_ALIAS
    (transmitted filename only -- never touches the file on disk)."""
    basename = os.path.basename(audio_path)
    stem, ext = os.path.splitext(basename)
    ext = ext.lower()

    if provider == "openai":
        alias_ext = _OPENAI_EXT_ALIAS.get(ext)
        if alias_ext:
            return f"{stem}{alias_ext}", _EXT_MIME.get(alias_ext, "application/octet-stream")

    return basename, _EXT_MIME.get(ext, "application/octet-stream")


def _call_with_retry(attempt_fn, *, deadline=None, sleep_fn=time.sleep):
    """Delays (0, 1, 3, 8)s; retries on 429/5xx; re-raises immediately on any
    other 4xx. `attempt_fn` is a zero-arg callable so each retry reopens its own
    file handle rather than reusing one positioned at EOF.

    `deadline` (a time.monotonic() timestamp) is optional; when given, retrying
    stops (raising the last exception) once the next sleep or attempt would
    cross it -- rather than always exhausting RETRY_DELAYS -- so several cloud
    providers can share one wall-clock budget (CLOUD_TOTAL_BUDGET_S)."""
    last_exc = None
    for delay in (0,) + RETRY_DELAYS:
        if deadline is not None:
            now = time.monotonic()
            if (now + delay if delay else now) > deadline:
                break
        if delay:
            sleep_fn(delay)
        try:
            return attempt_fn()
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            if status in (401, 403):
                raise CloudAuthError(str(exc)) from exc
            if status == 429 or (isinstance(status, int) and 500 <= status < 600):
                last_exc = exc
                continue
            raise
    if last_exc is None:
        # Only reachable when the deadline had already passed before the
        # first attempt ever ran.
        raise TimeoutError("cloud retry budget exhausted before any attempt completed")
    raise last_exc


def _parse_cloud_response(provider, body):
    """Returns (text, turns, speakers)."""
    if provider in ("groq", "openai"):
        segments = body.get("segments")
        if segments:
            pieces = [s.get("text", "") for s in segments if s.get("text")]
            return " ".join(pieces), len(pieces), 1
        flat = body.get("text") or ""
        return flat, (1 if flat else 0), 1

    if provider == "deepgram":
        utterances = (body.get("results") or {}).get("utterances") or []
        speaker_ids = sorted({u.get("speaker") for u in utterances if u.get("speaker") is not None})
        speaker_count = len(speaker_ids) if speaker_ids else 1

        if speaker_count > 1:
            display_number = {}
            next_number = 1
            pieces = []
            for u in utterances:
                transcript = u.get("transcript", "")
                if not transcript:
                    continue
                speaker = u.get("speaker")
                if speaker not in display_number:
                    display_number[speaker] = next_number
                    next_number += 1
                pieces.append(f"Speaker {display_number[speaker]}: {transcript}")
            return "\n".join(pieces), len(pieces), speaker_count

        # Single (or unlabelled) speaker: byte-identical to the pre-diarization
        # output -- this is a hard regression gate, do not change the join.
        pieces = [u.get("transcript", "") for u in utterances if u.get("transcript")]
        return " ".join(pieces), len(pieces), 1

    raise ValueError(f"unknown cloud provider: {provider}")


def _parse_duration(provider, body):
    """Best-effort duration_s extraction. Never raises."""
    try:
        if provider in ("groq", "openai"):
            value = body.get("duration")
        elif provider == "deepgram":
            value = ((body.get("results") or {}).get("metadata") or {}).get("duration")
        else:
            value = None
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def transcribe_cloud(provider, audio_path, *, env, post_fn=None, deadline=None, language=None):
    """Self-contained REST call. post_fn=None -> lazy `import requests` INSIDE
    this function. Returns {"text","turns","engine","duration_s","speakers"};
    raises on failure."""
    if post_fn is None:
        import requests

        post_fn = _make_post_fn(requests)

    size = os.path.getsize(audio_path)
    ceiling = _upload_ceiling(provider)
    if ceiling is not None and size > ceiling:
        raise OversizeError(
            f"{provider} rejects files over {_format_size(ceiling)}; this file is {size} bytes."
        )

    api_key = _key_for(provider, env)

    if provider == "groq":
        url = "https://api.groq.com/openai/v1/audio/transcriptions"
        headers = {"Authorization": f"Bearer {api_key}"}
        data = {"model": GROQ_MODEL, "response_format": "verbose_json"}
        if language:
            data["language"] = language.split("-")[0]
        filename, mime = _upload_part(provider, audio_path)

        def attempt():
            with open(audio_path, "rb") as fh:
                return post_fn(
                    url,
                    headers=headers,
                    files={"file": (filename, fh, mime)},
                    data=data,
                )

        body = _call_with_retry(attempt, deadline=deadline)
    elif provider == "openai":
        url = "https://api.openai.com/v1/audio/transcriptions"
        headers = {"Authorization": f"Bearer {api_key}"}
        data = {"model": OPENAI_MODEL, "response_format": "verbose_json"}
        if language:
            data["language"] = language.split("-")[0]
        filename, mime = _upload_part(provider, audio_path)

        def attempt():
            with open(audio_path, "rb") as fh:
                return post_fn(
                    url,
                    headers=headers,
                    files={"file": (filename, fh, mime)},
                    data=data,
                )

        body = _call_with_retry(attempt, deadline=deadline)
    elif provider == "deepgram":
        url = "https://api.deepgram.com/v1/listen"
        headers = {"Authorization": f"Token {api_key}", "Content-Type": "audio/*"}
        params = {
            "model": DEEPGRAM_MODEL,
            "diarize": "true",
            "punctuate": "true",
            "utterances": "true",
        }
        if language:
            params["language"] = language

        def attempt():
            with open(audio_path, "rb") as fh:
                return post_fn(url, headers=headers, data=fh, params=params)

        body = _call_with_retry(attempt, deadline=deadline)
    else:
        raise ValueError(f"unknown cloud provider: {provider}")

    text, turns, speakers = _parse_cloud_response(provider, body)
    return {
        "text": text,
        "turns": turns,
        "engine": provider,
        "duration_s": _parse_duration(provider, body),
        "speakers": speakers,
    }


def transcribe_local(audio_path, *, language=None, transcribe_fn=None):
    """transcribe_fn=None -> os.environ.setdefault('TRANSCRIBE_WHISPER_WORKERS','1')
    then lazy `from transcription.pipeline import transcribe` INSIDE this function."""
    # transcription/config.py reads the environment at import time, so this
    # must run before the lazy import below. setdefault (not assignment) so an
    # operator override in the real process environment survives.
    os.environ.setdefault("TRANSCRIBE_WHISPER_WORKERS", "1")

    if transcribe_fn is None:
        from transcription.pipeline import transcribe as transcribe_fn

    with tempfile.TemporaryDirectory(prefix="pa_voice_") as work_dir:
        result = transcribe_fn(
            audio_path,
            engine="whisper_local",
            out_dir=work_dir,
            language_hint=language,
            reconcile="off",
            progress=None,
        )
        duration_s = getattr(result, "duration_s", None)
        if duration_s is None:
            duration_s = getattr(result, "duration", None)
        return {
            "text": result.text,
            "turns": len(result.turns),
            "engine": "whisper_local",
            "duration_s": duration_s,
            "speakers": 1,
        }


def format_error(exc):
    """{"ok": False, "error_code": classify_error(exc), "error": str(exc) or repr(exc),
        "error_type": type(exc).__name__}"""
    return {
        "ok": False,
        "error_code": classify_error(exc),
        "error": str(exc) or repr(exc),
        "error_type": type(exc).__name__,
    }


def _engine_reason(attempt_engine, preference, requested_engine, plan):
    if requested_engine != "auto":
        return f"explicit --engine {requested_engine}"
    if attempt_engine == "whisper_local":
        if preference == "local":
            return "engine_preference=local; cloud never attempted"
        if len(plan) > 1:
            return "cloud candidates failed; fell back to local Whisper"
        return "no cloud API key configured; used local Whisper"
    return f"cloud preferred; {_KEY_ENV_VAR[attempt_engine]} set"


def transcribe_to_envelope(
    audio_path,
    *,
    engine="auto",
    preference="auto",
    cloud_order=None,
    language=None,
    max_chars=None,
    env=None,
    post_fn=None,
    transcribe_fn=None,
):
    """The whole decision + execution + envelope path. Returns (envelope, exit_code).
    NEVER raises. This is the function voice_worker.py reuses (WP2)."""
    env = env if env is not None else os.environ
    cloud_order = list(cloud_order) if cloud_order else list(CLOUD_PROVIDERS)
    max_chars = DEFAULT_MAX_CHARS if max_chars is None else max_chars

    if not os.path.isfile(audio_path):
        return format_error(FileNotFoundError(f"No such audio file: {audio_path}")), 1

    try:
        plan = resolve_plan(engine, preference, cloud_order, env)
    except EngineUnavailable as exc:
        return format_error(exc), 1

    # One shared retry budget across every cloud attempt in THIS call -- see
    # CLOUD_TOTAL_BUDGET_S's docstring. Harmless (unused) when plan is
    # local-only.
    cloud_deadline = time.monotonic() + CLOUD_TOTAL_BUDGET_S

    attempt_errors = []
    for idx, attempt_engine in enumerate(plan):
        attempt_start = time.monotonic()
        try:
            if attempt_engine == "whisper_local":
                result = transcribe_local(audio_path, language=language, transcribe_fn=transcribe_fn)
            else:
                result = transcribe_cloud(
                    attempt_engine,
                    audio_path,
                    env=env,
                    post_fn=post_fn,
                    deadline=cloud_deadline,
                    language=language,
                )
        except Exception as exc:
            # A missing `transcription` package only means "nothing is
            # installed" -- unconditional now, so the priority table (not the
            # shape of the plan) decides whether it's actually reported when
            # a cloud attempt also failed (requirement 3 / D1).
            if isinstance(exc, ImportError) and attempt_engine == "whisper_local":
                exc = EngineUnavailable(NO_ENGINE_HELP)
            attempt_errors.append((attempt_engine, exc))
            continue

        elapsed_s = time.monotonic() - attempt_start
        text = result["text"]
        truncated = False
        if len(text) > max_chars:
            text = text[:max_chars]
            truncated = True

        return {
            "ok": True,
            "text": text,
            "engine": attempt_engine,
            "engine_reason": _engine_reason(attempt_engine, preference, engine, plan),
            "turns": result.get("turns", 1),
            "duration_s": result.get("duration_s"),
            "elapsed_s": elapsed_s,
            "truncated": truncated,
            "fallback_from": plan[0] if idx > 0 else None,
            "speakers": result.get("speakers", 1),
        }, 0

    reported = select_reported_error(attempt_errors)
    envelope = format_error(reported)
    envelope["attempts"] = [
        {"engine": eng, "error_code": classify_error(exc), "error_type": type(exc).__name__}
        for eng, exc in attempt_errors
    ]
    return envelope, 1


def run(argv=None, **injections):
    parser = build_parser()
    args = parser.parse_args(argv)
    cloud_order = [p.strip() for p in args.cloud_order.split(",") if p.strip()]

    env = injections.pop("env", None)
    post_fn = injections.pop("post_fn", None)
    transcribe_fn = injections.pop("transcribe_fn", None)

    envelope, code = transcribe_to_envelope(
        args.audio_path,
        engine=args.engine,
        preference=args.engine_preference,
        cloud_order=cloud_order,
        language=args.language,
        max_chars=args.max_chars,
        env=env,
        post_fn=post_fn,
        transcribe_fn=transcribe_fn,
    )

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(envelope, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(run())
