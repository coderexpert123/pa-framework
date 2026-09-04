"""Unit tests for worker_capability_scan — the daily worker-CLI drift watchdog.

Run: python -m unittest discover -s projects/pa-maintenance/tests

The acceptance block at the bottom replays the four real drifts that motivated
the script (scaffolded --yolo/--output-format on agy, an agy self-update, a new
effort level in --help, and the "claude has no --effort" claim that was wrong),
so a regression in classification fails here rather than in production.
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import worker_capability_scan as wcs  # noqa: E402

NOW = datetime(2026, 7, 22, 12, 0, tzinfo=timezone.utc)

# Trimmed but shape-faithful help text. Real `agy --help` (v1.1.5) has neither
# --yolo nor --output-format — that absence is the whole point of fixture 1.
AGY_HELP = """
Usage: agy [options] [command]

Options:
  -V, --version                  output the version number
  -m, --model <model>            Model for the current CLI session
      --effort <level>           Reasoning effort for the current CLI session (low, medium, high)
      --print-timeout <duration> Timeout for print mode
  -p, --print <prompt>           Run in print mode
      --dangerously-skip-permissions
                                 Skip all permission prompts
  -h, --help                     display help for command

Commands:
  models                         List available models
"""

CLAUDE_HELP = """
Usage: claude [options] [command] [prompt]

Options:
  -d, --debug [filter]                  Enable debug mode
  -p, --print                           Print response and exit
      --model <model>                   Model for the current session
      --effort <level>                  Effort level for the session (low, medium, high, xhigh, max)
      --append-system-prompt <prompt>   Append a system prompt to the default
                                        system prompt. See also
                                        --append-system-prompt[-file], --add-dir
      --exclude-dynamic-system-prompt-sections
                                        Exclude dynamic sections
      --dangerously-skip-permissions    Bypass all permission checks
      --output-format <format>          Output format
      --input-format <format>           Input format
      --verbose                         Override verbose mode
  -h, --help                            display help for command
"""

AGY_MODELS_OUTPUT = """
Available models:
  gemini-3.6-flash-high
  gemini-3.6-flash-low
  claude-sonnet-4-6
Use `agy --model <name>` to select one.
"""


def probe(help_text="", version=None, help_ok=None, values=None, errors=None,
          version_raw=""):
    return {
        "version": version,
        "versionRaw": version_raw or (version or ""),
        "help": help_text,
        "helpOk": bool(help_text) if help_ok is None else help_ok,
        "values": values or {},
        "errors": errors or [],
    }


def worker(name, command="X", args=None, tunables=None, check=None):
    w = {"name": name, "command": command, "args": args or []}
    if tunables:
        w["tunables"] = tunables
    if check:
        w["check"] = check
    return w


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------

class TestParseHelpFlags(unittest.TestCase):
    def test_long_and_short_flags_are_found(self):
        loose, strict = wcs.parse_help_flags(AGY_HELP)
        for f in ("--model", "--effort", "--print-timeout", "-p", "-m",
                  "--dangerously-skip-permissions"):
            self.assertIn(f, loose, f)
            self.assertIn(f, strict, f)

    def test_flags_the_cli_lacks_are_absent(self):
        loose, _ = wcs.parse_help_flags(AGY_HELP)
        self.assertNotIn("--yolo", loose)
        self.assertNotIn("--output-format", loose)

    def test_short_flag_is_not_extracted_from_a_long_one(self):
        loose, _ = wcs.parse_help_flags("  --model <m>\n")
        self.assertNotIn("-m", loose)

    def test_strict_ignores_prose_mentions_but_loose_keeps_them(self):
        text = "Options:\n  --real <x>   desc\n\nSee also --mentioned-in-prose.\n"
        loose, strict = wcs.parse_help_flags(text)
        self.assertIn("--mentioned-in-prose", loose)
        self.assertNotIn("--mentioned-in-prose", strict)


class TestBracketedFlagFamilies(unittest.TestCase):
    """The false-positive class caught on the first real run (2026-07-22)."""

    def test_optional_suffix_expands_to_both_members(self):
        got = wcs.expand_bracketed_flags("--append-system-prompt[-file], --add-dir")
        self.assertIn("--append-system-prompt", got)
        self.assertIn("--append-system-prompt-file", got)

    def test_no_prefix_family_expands_to_both_members(self):
        got = wcs.expand_bracketed_flags("  --[no-]cache   Toggle the cache")
        self.assertIn("--cache", got)
        self.assertIn("--no-cache", got)

    def test_documented_only_as_a_family_member_is_not_breaking(self):
        w = worker("claude", args=["--append-system-prompt-file", "bot.md"])
        findings, _ = wcs.diff_worker("claude", w, probe(CLAUDE_HELP), None)
        self.assertEqual([f for f in findings if f["severity"] == wcs.BREAKING], [])

    def test_bracket_suffix_without_its_own_hyphen_is_not_joined_with_one(self):
        """`--cache[d]` means `--cached` — the bracketed member carries no
        hyphen of its own, so joining must not insert one (unlike
        `--append-system-prompt[-file]`, where the bracket already has it)."""
        got = wcs.expand_bracketed_flags("  --cache[d]   Use a local cache")
        self.assertIn("--cache", got)
        self.assertIn("--cached", got)
        self.assertNotIn("--cache-d", got)


class TestParseVersion(unittest.TestCase):
    def test_version_is_extracted_from_a_decorated_line(self):
        self.assertEqual(wcs.parse_version("2.1.217 (Claude Code)"), "2.1.217")

    def test_bare_semver(self):
        self.assertEqual(wcs.parse_version("0.49.0"), "0.49.0")

    def test_prerelease_suffix_survives(self):
        self.assertEqual(wcs.parse_version("agy version 1.1.5-beta.2"), "1.1.5-beta.2")

    def test_no_version_is_none(self):
        self.assertIsNone(wcs.parse_version("command not found"))


class TestParseChoiceValues(unittest.TestCase):
    def test_comma_list_in_parentheses(self):
        self.assertEqual(wcs.parse_choice_values(CLAUDE_HELP, "--effort"),
                         ["low", "medium", "high", "xhigh", "max"])

    def test_pipe_list_in_angle_brackets(self):
        text = "  --effort <low|medium|high>   Reasoning effort\n"
        self.assertEqual(wcs.parse_choice_values(text, "--effort"),
                         ["low", "medium", "high"])

    def test_default_parenthetical_is_not_a_vocabulary(self):
        text = "  --effort <level>   Reasoning effort (default: medium)\n"
        self.assertEqual(wcs.parse_choice_values(text, "--effort"), [])

    def test_free_text_parenthetical_is_rejected(self):
        text = "  --model <m>   Model to use (see the docs, they change often)\n"
        self.assertEqual(wcs.parse_choice_values(text, "--model"), [])

    def test_absent_flag_yields_nothing(self):
        self.assertEqual(wcs.parse_choice_values(CLAUDE_HELP, "--nope"), [])


class TestParseModelNames(unittest.TestCase):
    def test_ids_are_kept_and_prose_dropped(self):
        self.assertEqual(wcs.parse_model_names(AGY_MODELS_OUTPUT),
                         ["gemini-3.6-flash-high", "gemini-3.6-flash-low",
                          "claude-sonnet-4-6"])

    def test_filter_gemini_only(self):
        self.assertEqual(wcs.parse_model_names(AGY_MODELS_OUTPUT, filter_kind="gemini"),
                         ["gemini-3.6-flash-high", "gemini-3.6-flash-low"])

    def test_filter_non_gemini_only(self):
        self.assertEqual(wcs.parse_model_names(AGY_MODELS_OUTPUT, filter_kind="non-gemini"),
                         ["claude-sonnet-4-6"])

    def test_empty_output_yields_nothing(self):
        self.assertEqual(wcs.parse_model_names(""), [])


class TestStaticValueDefaults(unittest.TestCase):
    def test_static_defaults_include_zclaude_claude_codex(self):
        self.assertIn("zclaude", wcs.STATIC_VALUE_DEFAULTS)
        self.assertIn("claude", wcs.STATIC_VALUE_DEFAULTS)
        self.assertIn("codex", wcs.STATIC_VALUE_DEFAULTS)
        self.assertIn("glm-5.3", wcs.STATIC_VALUE_DEFAULTS["zclaude"]["model"])
        self.assertIn("opusplan", wcs.STATIC_VALUE_DEFAULTS["claude"]["model"])
        self.assertIn("gpt-5.4", wcs.STATIC_VALUE_DEFAULTS["codex"]["model"])


# ---------------------------------------------------------------------------
# config reading
# ---------------------------------------------------------------------------

class TestDeclaredFlags(unittest.TestCase):
    def test_flags_come_from_args_and_from_tunable_templates(self):
        w = worker("agy", args=["--yolo", "-p", "{prompt}"], tunables={
            "model": {"args": ["--model", "{value}"]},
            "effort": {"args": ["--effort", "{value}"]},
        })
        got = wcs.declared_flags(w)
        self.assertEqual(got["--yolo"], ["args"])
        self.assertEqual(got["--model"], ["tunables.model.args"])
        self.assertEqual(got["--effort"], ["tunables.effort.args"])

    def test_template_placeholders_and_values_are_not_flags(self):
        w = worker("codex", args=["--color", "never", "-"], tunables={
            "effort": {"args": ["-c", "model_reasoning_effort={value}"]},
        })
        got = wcs.declared_flags(w)
        self.assertIn("-c", got)
        self.assertNotIn("never", got)
        self.assertNotIn("-", got)
        self.assertNotIn("model_reasoning_effort={value}", got)


class TestBaseArgv(unittest.TestCase):
    def test_leading_positionals_are_kept_so_subcommands_survive(self):
        w = worker("codex", command="node",
                   args=["codex.js", "exec", "--json", "-C", "D:/x"])
        self.assertEqual(wcs.base_argv(w), ["node", "codex.js", "exec"])

    def test_stops_at_the_first_flag(self):
        w = worker("gemini", command="gemini.cmd", args=["--yolo", "--output-format"])
        self.assertEqual(wcs.base_argv(w), ["gemini.cmd"])

    def test_stops_at_a_template_placeholder(self):
        w = worker("x", command="x.cmd", args=["{prompt}"])
        self.assertEqual(wcs.base_argv(w), ["x.cmd"])


class TestVersionArgv(unittest.TestCase):
    def test_check_is_used_when_it_asks_for_a_version(self):
        w = worker("codex", command="node", args=["codex.js", "exec"],
                   check="node codex.js --version")
        self.assertEqual(wcs.version_argv(w), ["node", "codex.js", "--version"])

    def test_presence_only_check_is_ignored(self):
        w = worker("gemini", command="gemini.cmd", args=["--yolo"],
                   check="where gemini.cmd")
        self.assertEqual(wcs.version_argv(w), ["gemini.cmd", "--version"])


# ---------------------------------------------------------------------------
# ACCEPTANCE — the four real drifts this script was built for
# ---------------------------------------------------------------------------

class TestAcceptanceHistoricalCases(unittest.TestCase):

    def test_case1_declared_flag_the_cli_lacks_is_breaking(self):
        """The scaffolded agy worker declared --yolo and --output-format; agy has
        NEITHER, so a fresh `pa init` produced a worker that could not run."""
        cfg = {"workers": [worker("agy", args=["--yolo", "--output-format", "stream-json"])]}
        findings, _ = wcs.scan(cfg, {"agy": probe(AGY_HELP, version="1.1.5")}, None, NOW)
        breaking = [f for f in findings if f["severity"] == wcs.BREAKING]
        self.assertEqual(sorted(f["kind"] for f in breaking),
                         ["missing-flag", "missing-flag"])
        joined = " ".join(f["message"] for f in breaking)
        self.assertIn("--yolo", joined)
        self.assertIn("--output-format", joined)

    def test_case1b_bogus_flag_in_a_tunable_template_is_breaking(self):
        cfg = {"workers": [worker("agy", tunables={
            "effort": {"args": ["--reasoning-effort", "{value}"]}})]}
        findings, _ = wcs.scan(cfg, {"agy": probe(AGY_HELP)}, None, NOW)
        self.assertEqual([f["kind"] for f in findings if f["severity"] == wcs.BREAKING],
                         ["missing-flag"])
        self.assertIn("tunables.effort.args", findings[0]["message"])

    def test_case2_version_change_is_info_not_breaking(self):
        """agy self-updated 1.0.13 -> 1.1.5 mid-session."""
        cfg = {"workers": [worker("agy", tunables={"model": {"args": ["--model", "{value}"]}})]}
        prev = {"workers": {"agy": {"version": "1.0.13", "flags": []}}}
        findings, cache = wcs.scan(cfg, {"agy": probe(AGY_HELP, version="1.1.5")}, prev, NOW)
        self.assertEqual([(f["severity"], f["kind"]) for f in findings],
                         [(wcs.INFO, "version-changed")])
        self.assertIn("1.0.13 -> 1.1.5", findings[0]["message"])
        self.assertEqual(cache["workers"]["agy"]["version"], "1.1.5")

    def test_case3_new_effort_value_in_help_is_info(self):
        """claude --help gained `max`; config still lists four levels."""
        cfg = {"workers": [worker("claude", tunables={"effort": {
            "args": ["--effort", "{value}"],
            "values": ["low", "medium", "high", "xhigh"]}})]}
        findings, _ = wcs.scan(
            cfg,
            {"claude": probe(CLAUDE_HELP, version="2.1.217",
                             values={"effort": ["low", "medium", "high", "xhigh", "max"]})},
            None, NOW)
        self.assertEqual([(f["severity"], f["kind"]) for f in findings],
                         [(wcs.INFO, "new-values")])
        self.assertIn("`max`", findings[0]["message"])

    def test_case4_effort_flag_that_does_exist_is_not_flagged(self):
        """The written brief claimed claude/zclaude have no --effort. They do —
        only reading --help caught it, and this asserts it stays caught."""
        cfg = {"workers": [worker("claude", tunables={"effort": {
            "args": ["--effort", "{value}"],
            "values": ["low", "medium", "high", "xhigh", "max"]}})]}
        findings, cache = wcs.scan(
            cfg,
            {"claude": probe(CLAUDE_HELP, version="2.1.217",
                             values={"effort": ["low", "medium", "high", "xhigh", "max"]})},
            None, NOW)
        self.assertEqual(findings, [])
        self.assertIn("--effort", cache["workers"]["claude"]["flags"])

    def test_consistent_config_produces_no_findings(self):
        cfg = {"workers": [worker(
            "agy", args=["--dangerously-skip-permissions", "--print-timeout", "65m",
                         "-p", "{prompt}"],
            tunables={"model": {"args": ["--model", "{value}"]},
                      "effort": {"args": ["--effort", "{value}"],
                                 "values": ["low", "medium", "high"]}})]}
        prev = {"workers": {"agy": {"version": "1.1.5",
                                    "flags": sorted(wcs.parse_help_flags(AGY_HELP)[1])}}}
        findings, _ = wcs.scan(
            cfg,
            {"agy": probe(AGY_HELP, version="1.1.5",
                          values={"effort": ["low", "medium", "high"]})},
            prev, NOW)
        self.assertEqual(findings, [])

    def test_no_findings_prints_the_no_output_sentinel(self):
        """Empty stdout from a skill declaring telegram_output is a HARD FAILURE
        (2026-07-21), which would fail this watchdog daily and eventually park
        it via the AI-098 backoff ladder."""
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.yaml"
            cfg_path.write_text("workers: []\n", encoding="utf-8")
            cache_path = Path(tmp) / "worker-capabilities.json"
            import io
            import contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = wcs.main(["--config", str(cfg_path), "--cache", str(cache_path),
                               "--no-send"])
            self.assertEqual(rc, 0)
            self.assertEqual(buf.getvalue().strip(), "NO_OUTPUT")


# ---------------------------------------------------------------------------
# classification edge cases
# ---------------------------------------------------------------------------

class TestClassification(unittest.TestCase):

    def test_unreadable_help_is_info_never_breaking(self):
        """A CLI that will not answer --help is a different problem from a CLI
        that lost a flag; conflating them would page on every transient hang."""
        cfg = {"workers": [worker("agy", args=["--yolo"])]}
        findings, _ = wcs.scan(
            cfg, {"agy": probe("", help_ok=False, errors=["--help: timed out after 90s"])},
            None, NOW)
        self.assertEqual([(f["severity"], f["kind"]) for f in findings],
                         [(wcs.INFO, "probe-failed")])
        self.assertIn("timed out", findings[0]["message"])

    def test_first_run_records_a_baseline_silently(self):
        cfg = {"workers": [worker("agy", tunables={"model": {"args": ["--model", "{value}"]}})]}
        findings, cache = wcs.scan(cfg, {"agy": probe(AGY_HELP, version="1.1.5")}, None, NOW)
        self.assertEqual(findings, [])
        self.assertEqual(cache["workers"]["agy"]["version"], "1.1.5")

    def test_new_flag_appearing_is_info(self):
        cfg = {"workers": [worker("agy")]}
        prev = {"workers": {"agy": {"version": "1.1.5", "flags": ["--model"]}}}
        findings, _ = wcs.scan(cfg, {"agy": probe(AGY_HELP, version="1.1.5")}, prev, NOW)
        kinds = [f["kind"] for f in findings]
        self.assertEqual(kinds, ["new-flags"])
        self.assertEqual(findings[0]["severity"], wcs.INFO)
        self.assertIn("--effort", findings[0]["message"])

    def test_undeclared_value_list_is_never_reported(self):
        """`values:` absent means deliberately undeclared (model names move
        faster than config); daily reporting on it would be pure noise."""
        cfg = {"workers": [worker("agy", tunables={"model": {"args": ["--model", "{value}"]}})]}
        findings, cache = wcs.scan(
            cfg, {"agy": probe(AGY_HELP, version="1.1.5",
                               values={"model": ["gemini-3.6-flash-high"]})}, None, NOW)
        self.assertEqual(findings, [])
        self.assertEqual(cache["workers"]["agy"]["values"]["model"],
                         ["gemini-3.6-flash-high"])

    def test_disappeared_declared_value_is_info_only(self):
        cfg = {"workers": [worker("agy", tunables={"model": {
            "args": ["--model", "{value}"],
            "values": ["gemini-3.5-flash-high", "gemini-3.6-flash-high"]}})]}
        findings, _ = wcs.scan(
            cfg, {"agy": probe(AGY_HELP, version="1.1.5",
                               values={"model": ["gemini-3.6-flash-high"]})}, None, NOW)
        self.assertEqual([(f["severity"], f["kind"]) for f in findings],
                         [(wcs.INFO, "stale-values")])
        self.assertIn("nothing is auto-removed", findings[0]["message"])

    def test_workers_dropped_from_config_keep_their_last_observation(self):
        prev = {"workers": {"gone": {"version": "9.9.9", "flags": []}}}
        _findings, cache = wcs.scan({"workers": []}, {}, prev, NOW)
        self.assertEqual(cache["workers"]["gone"]["version"], "9.9.9")


class TestCacheMergeInvariant(unittest.TestCase):
    """The cache is ADDITIVE, never a wholesale overwrite (module docstring
    invariant #2). A single transient probe failure must never wipe a
    worker's previously-known flags or values — this is the most important
    class of test in this file: get it wrong and one `--help` timeout silently
    disables every setting the user depends on for that worker."""

    def test_transient_helpOk_false_preserves_previous_flags_and_values(self):
        """Reproduces the exact defect: seed a cache with real flags/values,
        replay a probe with helpOk=False (a `--help` timeout), assert the
        cache entry for that worker is UNCHANGED from the seed rather than
        emptied to [] / {}."""
        seed_flags = sorted(wcs.parse_help_flags(AGY_HELP)[1])
        seed_values = {"model": ["gemini-3.6-flash-high", "gemini-3.6-flash-low"]}
        cfg = {"workers": [worker("agy", tunables={
            "model": {"args": ["--model", "{value}"]}})]}
        prev = {"workers": {"agy": {"version": "1.1.5", "flags": seed_flags,
                                    "values": seed_values}}}
        findings, cache = wcs.scan(
            cfg,
            {"agy": probe("", help_ok=False, errors=["--help: timed out after 90s"])},
            prev, NOW)
        self.assertEqual(cache["workers"]["agy"]["flags"], seed_flags)
        self.assertEqual(cache["workers"]["agy"]["values"], seed_values)
        # It's still reported as INFO probe-failed, not silently swallowed —
        # merging the cache is not the same as pretending the probe succeeded.
        self.assertEqual([(f["severity"], f["kind"]) for f in findings],
                         [(wcs.INFO, "probe-failed")])

    def test_values_merge_only_backfills_the_setting_this_run_missed(self):
        """One setting's discovery is present (`model`), another's is
        transiently missing (`effort`) — only the missing one should fall
        back to the previous cache value; the discovered one must reflect
        THIS run, not be blocked by the merge."""
        cfg = {"workers": [worker("agy", tunables={
            "model": {"args": ["--model", "{value}"]},
            "effort": {"args": ["--effort", "{value}"]},
        })]}
        prev = {"workers": {"agy": {
            "version": "1.1.5",
            "flags": sorted(wcs.parse_help_flags(AGY_HELP)[1]),
            "values": {"model": ["gemini-3.5-flash-high"],
                       "effort": ["low", "medium"]},
        }}}
        findings, cache = wcs.scan(
            cfg,
            {"agy": probe(AGY_HELP, version="1.1.5",
                          values={"model": ["gemini-3.6-flash-high"]})},
            prev, NOW)
        self.assertEqual(cache["workers"]["agy"]["values"]["model"],
                         ["gemini-3.6-flash-high"])
        self.assertEqual(cache["workers"]["agy"]["values"]["effort"],
                         ["low", "medium"])

    def test_first_probe_ever_has_nothing_to_merge_from(self):
        """No prev entry at all (first run) — helpOk=False must not crash on
        a missing cache, and simply records no flags/values yet."""
        cfg = {"workers": [worker("agy")]}
        findings, cache = wcs.scan(
            cfg, {"agy": probe("", help_ok=False, errors=["--help: timed out after 90s"])},
            None, NOW)
        self.assertEqual(cache["workers"]["agy"]["flags"], [])
        self.assertEqual(cache["workers"]["agy"]["values"], {})
        self.assertEqual([(f["severity"], f["kind"]) for f in findings],
                         [(wcs.INFO, "probe-failed")])


class TestRenderReport(unittest.TestCase):
    def test_breaking_section_says_nothing_was_auto_removed(self):
        text = wcs.render_report([wcs.finding(wcs.BREAKING, "agy", "missing-flag", "x")])
        self.assertIn("BREAKING", text)
        self.assertIn("never deleted automatically", text)

    def test_info_only_report_has_no_breaking_banner(self):
        text = wcs.render_report([wcs.finding(wcs.INFO, "agy", "version-changed", "x")])
        self.assertNotIn("BREAKING", text)
        self.assertIn("INFO", text)

    def test_report_is_capped(self):
        many = [wcs.finding(wcs.INFO, "w", "k", "m" * 200) for _ in range(200)]
        self.assertLessEqual(len(wcs.render_report(many)), wcs.MAX_REPORT_CHARS)


# ---------------------------------------------------------------------------
# cache + safety invariants
# ---------------------------------------------------------------------------

class TestCache(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "worker-capabilities.json"
            wcs.save_cache(p, {"updatedAt": "t", "workers": {"a": {"version": "1"}}})
            self.assertEqual(wcs.load_cache(p)["workers"]["a"]["version"], "1")

    def test_corrupt_cache_is_treated_as_first_run_not_a_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "worker-capabilities.json"
            p.write_text("{not json", encoding="utf-8")
            self.assertIsNone(wcs.load_cache(p))

    def test_wrong_shape_cache_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "worker-capabilities.json"
            p.write_text(json.dumps({"workers": []}), encoding="utf-8")
            self.assertIsNone(wcs.load_cache(p))

    def test_missing_cache_is_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(wcs.load_cache(Path(tmp) / "nope.json"))


class TestConfigIsNeverWritten(unittest.TestCase):
    def test_a_full_run_leaves_config_yaml_byte_identical(self):
        """config.yaml is hand-maintained human intent. A cron job that rewrites
        it is how intent gets lost — this asserts the script only ever reads."""
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = Path(tmp) / "config.yaml"
            original = ("workers:\n"
                        "  - name: fake\n"
                        "    command: definitely-not-a-real-binary-xyz\n"
                        "    args: [--yolo]\n")
            cfg_path.write_text(original, encoding="utf-8")
            cache_path = Path(tmp) / "worker-capabilities.json"
            import io
            import contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
                rc = wcs.main(["--config", str(cfg_path), "--cache", str(cache_path),
                               "--no-send", "--timeout", "5"])
            self.assertEqual(rc, 0)
            self.assertEqual(cfg_path.read_text(encoding="utf-8"), original)
            # A binary that does not exist cannot be verified, so: INFO, no page.
            self.assertIn("could not be read", buf.getvalue())
            self.assertNotIn("BREAKING", buf.getvalue())
            self.assertTrue(cache_path.exists())


class TestSubprocessSafety(unittest.TestCase):
    def test_run_capture_forces_utf8_replace(self):
        """Windows otherwise decodes with cp1252 and one emoji or box-drawing
        byte raises mid-read — the 2026-07-12 silent-empty-scan regression."""
        r = wcs.run_capture(
            [sys.executable, "-c",
             "import sys; sys.stdout.buffer.write('box ─ emoji ⚠️\\n'.encode('utf-8'))"],
            timeout=30)
        self.assertTrue(r["ok"])
        self.assertIn("⚠", r["out"])

    def test_run_capture_times_out_without_raising(self):
        r = wcs.run_capture([sys.executable, "-c", "import time; time.sleep(30)"], timeout=2)
        self.assertFalse(r["ok"])
        self.assertTrue(r["timedOut"])
        self.assertIn("timed out", r["err"])

    def test_missing_binary_is_a_soft_failure(self):
        r = wcs.run_capture(["definitely-not-a-real-binary-xyz"], timeout=5)
        self.assertFalse(r["ok"])
        self.assertFalse(r["timedOut"])

    def test_shim_argv_goes_through_cmd_on_windows(self):
        import os
        got = wcs.resolve_argv(["D:/gemini-shim/agy.cmd", "--help"])
        if os.name == "nt":
            self.assertEqual(got[:2], ["cmd", "/c"])
        else:
            self.assertEqual(got[0], "D:/gemini-shim/agy.cmd")

    def test_powershell_quoting_escapes_single_quotes(self):
        argv = wcs.powershell_argv("C:/it's/agy.cmd", ["models"])
        if argv:  # None only when neither pwsh nor powershell is installed
            self.assertIn("'C:/it''s/agy.cmd'", argv[-1])
            self.assertIn("'models'", argv[-1])


class TestSecrets(unittest.TestCase):
    def test_chat_id_is_parsed_by_sign_not_by_position(self):
        import os
        saved = {k: os.environ.get(k) for k in ("PA_ALERTS_CHAT_ID", "TELEGRAM_CHAT_ID")}
        try:
            os.environ.pop("PA_ALERTS_CHAT_ID", None)
            os.environ["TELEGRAM_CHAT_ID"] = "7000000001,-1001234567890"
            wcs._SECRETS_CACHE = {}
            self.assertEqual(wcs.alert_chat_id(), "-1001234567890")
            os.environ["TELEGRAM_CHAT_ID"] = "-1001234567890,7000000001"
            self.assertEqual(wcs.alert_chat_id(), "-1001234567890")
        finally:
            wcs._SECRETS_CACHE = None
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_explicit_alerts_chat_id_wins(self):
        import os
        saved = os.environ.get("PA_ALERTS_CHAT_ID")
        try:
            os.environ["PA_ALERTS_CHAT_ID"] = "-100999"
            self.assertEqual(wcs.alert_chat_id(), "-100999")
        finally:
            if saved is None:
                os.environ.pop("PA_ALERTS_CHAT_ID", None)
            else:
                os.environ["PA_ALERTS_CHAT_ID"] = saved


# ---------------------------------------------------------------------------
# worker-down detection (AI-153)
# ---------------------------------------------------------------------------

class TestWorkerDownDetection(unittest.TestCase):
    """AI-153: Detect when a worker binary is completely gone."""

    def test_both_probes_failed_with_spawn_failure_marker_is_breaking(self):
        """When both --version and --help fail AND error text contains spawn-failure
        markers (e.g., "cannot be resolved"), emit BREAKING worker-down."""
        cfg = {"workers": [worker("agy", args=["--yolo"])]}
        errors = [
            "--version: The name of the file cannot be resolved by the system.",
            "--help: The system cannot find the file specified."
        ]
        findings, _ = wcs.scan(
            cfg, {"agy": probe("", help_ok=False, errors=errors)}, None, NOW)
        breaking = [f for f in findings if f["severity"] == wcs.BREAKING]
        self.assertEqual(len(breaking), 1)
        self.assertEqual(breaking[0]["kind"], "worker-down")
        self.assertIn("Worker binary cannot be executed", breaking[0]["message"])
        self.assertIn("self-junction", breaking[0]["message"])
        self.assertIn("agy-restore", breaking[0]["message"])

    def test_timeout_without_spawn_marker_is_info_not_breaking(self):
        """A mere TIMEOUT without spawn-failure markers must stay INFO probe-failed.
        Do NOT regress the 'transient hang must not page' rule."""
        cfg = {"workers": [worker("agy")]}
        findings, _ = wcs.scan(
            cfg, {"agy": probe("", help_ok=False,
                              errors=["--help: timed out after 90s"])},
            None, NOW)
        self.assertEqual([(f["severity"], f["kind"]) for f in findings],
                         [(wcs.INFO, "probe-failed")])
        self.assertNotIn("worker-down", [f["kind"] for f in findings])

    def test_version_ok_help_ok_produces_no_worker_down_finding(self):
        """When both probes succeed, there is no worker-down finding."""
        cfg = {"workers": [worker("agy", args=["--model"])]}
        findings, _ = wcs.scan(
            cfg, {"agy": probe(AGY_HELP, version="1.1.5", help_ok=True)}, None, NOW)
        self.assertNotIn("worker-down", [f["kind"] for f in findings])

    def test_only_version_failed_is_not_worker_down(self):
        """When only --version fails but --help succeeds, not a worker-down case."""
        cfg = {"workers": [worker("agy")]}
        findings, _ = wcs.scan(
            cfg, {"agy": probe(AGY_HELP, help_ok=True,
                              errors=["--version: cannot be resolved"])},
            None, NOW)
        self.assertNotIn("worker-down", [f["kind"] for f in findings])

    def test_only_help_failed_is_not_worker_down(self):
        """When only --help fails but --version succeeds, not a worker-down case."""
        cfg = {"workers": [worker("agy")]}
        findings, _ = wcs.scan(
            cfg, {"agy": probe("", help_ok=False, version="1.1.5",
                              errors=["--help: file cannot be found"])},
            None, NOW)
        self.assertNotIn("worker-down", [f["kind"] for f in findings])

    def test_guard_banner_as_help_is_worker_down_not_missing_flags(self):
        """2026-08-15 live miss (found with the binary genuinely deleted): the
        shim's loud guard prints its missing-binary banner to stdout and exits
        1, so run_capture records ok:True and the banner becomes the "help"
        text with helpOk=True. That shape must classify as worker-down — and
        must NOT emit bogus missing-flag BREAKING findings derived from the
        banner, nor wipe the cached flags."""
        cfg = {"workers": [worker("agy", args=["--dangerously-skip-permissions", "--model"])]}
        banner = (
            "ERROR: agy.exe not found at C:\\Users\\you\\AppData\\Local\\agy\\bin\\agy.exe\r\n"
            "Known causes (2026-08-13/14, see the 2026-08-14 agy-restore record):\r\n"
            "  1. A self-junction at that path (\"file cannot be resolved\" errors) —\r\n"
            "  2. Failed auto-update emptied the dir — reinstall the official way:\r\n"
        )
        prev = {"workers": {"agy": {"version": "1.1.13", "flags": ["--model"], "helpOk": True}}}
        findings, cache = wcs.scan(
            cfg, {"agy": probe(banner, help_ok=True, version=None)}, prev, NOW)
        breaking = [f for f in findings if f["severity"] == wcs.BREAKING]
        self.assertEqual(len(breaking), 1, [f["kind"] for f in findings])
        self.assertEqual(breaking[0]["kind"], "worker-down")
        self.assertNotIn("missing-flag", [f["kind"] for f in findings])
        self.assertEqual(cache["workers"]["agy"]["flags"], ["--model"],
                         "cached flags must carry forward, not be wiped by the banner")

    def test_real_help_containing_marker_phrase_is_not_worker_down(self):
        """Anti-false-positive for the banner path: a REAL help text that merely
        mentions a marker-like phrase but yields flags and a version is a live
        worker, not a down one."""
        cfg = {"workers": [worker("agy", args=["--model"])]}
        help_text = AGY_HELP + "\n  --model   Model (error if file cannot be found in config)\n"
        findings, _ = wcs.scan(
            cfg, {"agy": probe(help_text, help_ok=True, version="1.1.13")}, None, NOW)
        self.assertNotIn("worker-down", [f["kind"] for f in findings])


# ---------------------------------------------------------------------------
# shim integrity hash (AI-154)
# ---------------------------------------------------------------------------

class TestShimIntegrity(unittest.TestCase):
    """AI-154: Detect shim file drift via SHA-256 baseline."""

    def test_no_finding_when_baseline_matches(self):
        """When current hashes match baseline, no finding is emitted."""
        with tempfile.TemporaryDirectory() as tmp:
            shim_dir = Path(tmp) / "shim"
            shim_dir.mkdir()
            (shim_dir / "agy.cmd").write_text("v1", encoding="utf-8")
            (shim_dir / "gemini.cmd").write_text("v1", encoding="utf-8")

            baseline_path = Path(tmp) / "baseline.json"
            # Pre-seed baseline with matching hashes
            hashes = wcs.compute_shim_hashes(shim_dir)
            wcs.save_shim_baseline(baseline_path, hashes)

            finding = wcs.check_shim_integrity(shim_dir, baseline_path, update_baseline=False)
            self.assertIsNone(finding)

    def test_hash_changed_emits_breaking_shim_drift(self):
        """When a file's hash differs from baseline, emit BREAKING shim-drift."""
        with tempfile.TemporaryDirectory() as tmp:
            shim_dir = Path(tmp) / "shim"
            shim_dir.mkdir()
            (shim_dir / "agy.cmd").write_text("original", encoding="utf-8")

            baseline_path = Path(tmp) / "baseline.json"
            # Save baseline with original hash
            wcs.save_shim_baseline(baseline_path, wcs.compute_shim_hashes(shim_dir))

            # Mutate the file
            (shim_dir / "agy.cmd").write_text("mutated!", encoding="utf-8")

            finding = wcs.check_shim_integrity(shim_dir, baseline_path, update_baseline=False)
            self.assertIsNotNone(finding)
            self.assertEqual(finding["severity"], wcs.BREAKING)
            self.assertEqual(finding["kind"], "shim-drift")
            self.assertIn("agy.cmd", finding["message"])
            self.assertIn("update-shim-baseline", finding["message"])
            self.assertIn("agy-restore", finding["message"])

    def test_file_vanished_emits_breaking_shim_drift(self):
        """When a file in baseline is missing, emit BREAKING shim-drift."""
        with tempfile.TemporaryDirectory() as tmp:
            shim_dir = Path(tmp) / "shim"
            shim_dir.mkdir()
            (shim_dir / "agy.cmd").write_text("content", encoding="utf-8")

            baseline_path = Path(tmp) / "baseline.json"
            wcs.save_shim_baseline(baseline_path, wcs.compute_shim_hashes(shim_dir))

            # Delete the file
            (shim_dir / "agy.cmd").unlink()

            finding = wcs.check_shim_integrity(shim_dir, baseline_path, update_baseline=False)
            self.assertIsNotNone(finding)
            self.assertEqual(finding["severity"], wcs.BREAKING)
            self.assertEqual(finding["kind"], "shim-drift")
            self.assertIn("vanished", finding["message"].lower())

    def test_update_baseline_rewrites_and_clears_finding(self):
        """--update-shim-baseline rewrites baseline and returns no finding."""
        with tempfile.TemporaryDirectory() as tmp:
            shim_dir = Path(tmp) / "shim"
            shim_dir.mkdir()
            (shim_dir / "agy.cmd").write_text("new content", encoding="utf-8")

            baseline_path = Path(tmp) / "baseline.json"
            # Baseline has old hash
            baseline_path.write_text('{"files": {"agy.cmd": "oldhash"}}', encoding="utf-8")

            finding = wcs.check_shim_integrity(shim_dir, baseline_path, update_baseline=True)
            self.assertIsNone(finding)

            # Baseline was rewritten with new hash
            new_baseline = wcs.load_shim_baseline(baseline_path)
            self.assertIsNotNone(new_baseline)
            self.assertNotEqual(new_baseline.get("agy.cmd"), "oldhash")

    def test_first_run_creates_baseline_no_finding(self):
        """When no baseline exists, it is created and no finding is emitted."""
        with tempfile.TemporaryDirectory() as tmp:
            shim_dir = Path(tmp) / "shim"
            shim_dir.mkdir()
            (shim_dir / "agy.cmd").write_text("content", encoding="utf-8")

            baseline_path = Path(tmp) / "baseline.json"
            finding = wcs.check_shim_integrity(shim_dir, baseline_path, update_baseline=False)

            self.assertIsNone(finding)
            self.assertTrue(baseline_path.exists())

            baseline = wcs.load_shim_baseline(baseline_path)
            self.assertIsNotNone(baseline)
            self.assertIn("agy.cmd", baseline)

    def test_missing_shim_dir_is_silent_no_finding(self):
        """When shim directory does not exist, silently skip (no finding)."""
        with tempfile.TemporaryDirectory() as tmp:
            shim_dir = Path(tmp) / "nonexistent_shim"
            baseline_path = Path(tmp) / "baseline.json"

            finding = wcs.check_shim_integrity(shim_dir, baseline_path, update_baseline=False)
            self.assertIsNone(finding)


if __name__ == "__main__":
    unittest.main()
