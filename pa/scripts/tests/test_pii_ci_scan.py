"""Unit tests for pa/scripts/pii_ci_scan.py — the server-side PII backstop.

Planted-secret discipline: every fixture secret in this file is ASSEMBLED AT
RUNTIME from fragments. A literal token here would be a hit in the scanner's
own repository scan (this file is tracked in the public mirror), and "the test
suite is the exception" is exactly the reasoning that leaks things.
"""
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

SCANNER_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "pii_ci_scan.py",
)
_spec = importlib.util.spec_from_file_location("pii_ci_scan", SCANNER_PATH)
scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan)


# --- fixture builders (assembled, never literal) --------------------------

def fake_telegram_token() -> str:
    return "1234567" + "890:" + "A" * 20 + "b" * 15


def fake_anthropic_key() -> str:
    return "sk-" + "ant-" + "api03-" + "Zz9" * 8


def fake_institution() -> str:
    """A member of the committed generic institution dictionary. Assembled so
    this file is not itself a finding."""
    return "bar" + "clays"


def make_tree(files: dict) -> tempfile.TemporaryDirectory:
    tmp = tempfile.TemporaryDirectory()
    for rel, content in files.items():
        full = os.path.join(tmp.name, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8") as f:
            f.write(content)
    return tmp


def run_scan(root: str, personal=None, hist=None):
    paths = scan.walk_paths(root)
    return scan.scan_repo(root, paths, personal or [], hist)


class TestStructuralCredentials(unittest.TestCase):
    def test_planted_telegram_token_is_caught(self):
        token = fake_telegram_token()
        with make_tree({"src/config.py": f'TOKEN = "{token}"\n'}) as root:
            findings, _ = run_scan(root)
        classes = {f.pattern_class for f in findings}
        self.assertIn("telegram-bot-token", classes)
        hit = next(f for f in findings if f.pattern_class == "telegram-bot-token")
        self.assertEqual(hit.where, "content")
        self.assertEqual(hit.path, "src/config.py")
        self.assertEqual(hit.line, 1)

    def test_planted_api_key_is_caught_on_the_right_line(self):
        key = fake_anthropic_key()
        with make_tree({"a.py": f"x = 1\ny = 2\nKEY = '{key}'\n"}) as root:
            findings, _ = run_scan(root)
        hit = next(f for f in findings if f.pattern_class == "anthropic-api-key")
        self.assertEqual(hit.line, 3)

    def test_private_key_block_is_caught(self):
        body = "-----BEGIN RSA PRIVATE " + "KEY-----\nabc\n"
        with make_tree({"id_rsa": body}) as root:
            findings, _ = run_scan(root)
        self.assertIn("private-key-block", {f.pattern_class for f in findings})

    def test_secret_assignment_with_real_looking_value(self):
        val = "Qk9" + "x" * 30
        with make_tree({"s.py": f'api_key = "{val}"\n'}) as root:
            findings, _ = run_scan(root)
        self.assertIn("secret-assignment", {f.pattern_class for f in findings})

    def test_placeholder_secret_assignment_is_not_flagged(self):
        with make_tree({"s.py": 'api_key = "your-api-key-goes-here"\n'
                                'password = "changeme-changeme-changeme"\n'}) as root:
            findings, _ = run_scan(root)
        self.assertEqual([f.pattern_class for f in findings], [])

    def test_private_home_path_is_caught_but_placeholders_are_not(self):
        # The sentinel comments sit on the PYTHON source lines, outside the
        # string literals, so the fixture text the test scans is unchanged
        # while the scanner's own repo sweep skips these invented-but-
        # realistic values.
        content = (
            "real = 'C:/Users/jsmithers/AppData/pa.cmd'\n"  # pii-scan:ignore-line
            "tpl  = 'C:/Users/you/AppData/pa.cmd'\n"
            "ci   = '/home/runner/work/repo'\n"
            "esc  = 'C:\\\\Users\\n'\n"
            "var  = '/home/${USER}/x'\n"
        )
        with make_tree({"p.py": content}) as root:
            findings, _ = run_scan(root)
        hits = [f for f in findings if f.pattern_class == "private-absolute-path"]
        self.assertEqual([h.line for h in hits], [1])

    def test_real_email_caught_placeholder_and_role_addresses_not(self):
        content = (
            "real = 'jane.q.smithers@somecorp.io'\n"  # pii-scan:ignore-line
            "ph1  = 'you@example.com'\n"
            "ph2  = 'alerts@economic-times.com'\n"
            "ph3  = 'a@b.com'\n"
            "ph4  = 'noreply@example-broker.test'\n"
            "ph5  = 'git@github.com:owner/repo.git'\n"  # SSH remote, not an email
        )
        with make_tree({"e.py": content}) as root:
            findings, _ = run_scan(root)
        hits = [f for f in findings if f.pattern_class == "email-address"]
        self.assertEqual([h.line for h in hits], [1])

    def test_bot_handle_needs_context_so_code_identifiers_do_not_fire(self):
        content = (
            "if (action === 'restart_bot') {}\n"          # ordinary identifier
            "const u = { username: 'Jsmithers_pa_bot' };\n"  # real handle  pii-scan:ignore-line
            "assert(parse('/stop@Example_pa_bot'));\n"    # sanitized fixture
        )
        with make_tree({"b.ts": content}) as root:
            findings, _ = run_scan(root)
        hits = [f for f in findings if f.pattern_class == "telegram-bot-handle"]
        self.assertEqual([h.line for h in hits], [2])

    def test_canonical_placeholder_supergroup_id_is_not_flagged(self):
        content = "a = -1001234567890\nb = -1009182736450\n"  # pii-scan:ignore-line
        with make_tree({"g.py": content}) as root:
            findings, _ = run_scan(root)
        hits = [f for f in findings if f.pattern_class == "telegram-supergroup-id"]
        self.assertEqual([h.line for h in hits], [2])


class TestPathScanning(unittest.TestCase):
    """Leak class 3 (2026-07-21): the PII was the FILENAME. Contents were
    entirely generic and every content-only layer passed it."""

    def test_planted_bad_path_is_caught_by_a_structural_class(self):
        bad = f"projects/mail/scripts/download_{fake_institution()}_statement.py"
        with make_tree({bad: "# entirely generic contents\nimport os\n"}) as root:
            findings, _ = run_scan(root)
        path_hits = [f for f in findings if f.where == "path"]
        self.assertEqual(len(path_hits), 1)
        self.assertEqual(path_hits[0].pattern_class, "financial-institution")
        self.assertEqual(path_hits[0].path, bad)
        self.assertIsNone(path_hits[0].line)

    def test_planted_bad_path_is_caught_by_a_personal_term(self):
        import re
        personal = [re.compile(r"jsmithers", re.IGNORECASE)]
        with make_tree({"docs/jsmithers-notes.md": "nothing to see\n"}) as root:
            findings, _ = run_scan(root, personal=personal)
        self.assertEqual([f.pattern_class for f in findings], ["personal-term#1"])
        self.assertEqual(findings[0].where, "path")

    def test_clean_path_with_generic_name_passes(self):
        with make_tree({"projects/mail/scripts/download_statement.py": "import os\n"}) as root:
            findings, _ = run_scan(root)
        self.assertEqual(findings, [])

    def test_history_paths_are_scanned_and_deduped_against_head(self):
        bad = f"scripts/{fake_institution()}_dump.py"
        with make_tree({"scripts/dump.py": "import os\n"}) as root:
            findings, _ = run_scan(root, hist=[bad, "scripts/dump.py"])
        hist_hits = [f for f in findings if f.where == "history-path"]
        self.assertEqual(len(hist_hits), 1)
        self.assertEqual(hist_hits[0].path, bad)
        # the live path must not be double-reported by the history pass
        self.assertEqual([f for f in findings if f.path == "scripts/dump.py"], [])


class TestCleanTreePasses(unittest.TestCase):
    def test_realistic_clean_tree_produces_no_findings(self):
        files = {
            "README.md": "# project\n\nSee docs/. Contact you@example.com.\n",
            "src/main.ts": "export const CHAT = -1001234567890;\n"
                           "if (a.type === 'restart_bot') stop();\n",
            "src/util.py": "HOME = 'C:/Users/you/.pa'\nAPI_KEY = os.environ['API_KEY']\n",
            "tests/fixtures.json": '{"from": "alerts@example-bank.test"}\n',
        }
        with make_tree(files) as root:
            findings, read = run_scan(root)
        self.assertEqual([f.format() for f in findings], [])
        self.assertEqual(read, 4)

    def test_main_exits_zero_on_a_clean_tree(self):
        with make_tree({"a.py": "print('hi')\n"}) as root:
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                with patch.dict(os.environ, {}, clear=False):
                    os.environ.pop("PA_PII_TRIPWIRES", None)
                    rc = scan.main(["--root", root, "--no-git"])
        self.assertEqual(rc, 0)
        self.assertIn("OK: no findings", out.getvalue())

    def test_main_exits_one_when_a_finding_exists(self):
        token = fake_telegram_token()
        with make_tree({"a.py": f'T = "{token}"\n'}) as root:
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                rc = scan.main(["--root", root, "--no-git"])
        self.assertEqual(rc, 1)
        self.assertIn("FAIL: 1 finding", out.getvalue())

    def test_main_exits_two_when_the_scan_cannot_run(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            rc = scan.main(["--root", os.path.join(tempfile.gettempdir(), "no-such-dir-xyz"), "--no-git"])
        self.assertEqual(rc, 2)


class TestReporterNeverLeaksTheMatch(unittest.TestCase):
    """CI logs on a public repo are public. A reporter that printed the string
    it caught would publish the exact secret it exists to stop."""

    def test_report_contains_location_and_class_but_not_the_value(self):
        token = fake_telegram_token()
        key = fake_anthropic_key()
        email = "jane.q.smithers@somecorp.io"  # pii-scan:ignore-line
        files = {"cfg.py": f'T="{token}"\nK="{key}"\nE="{email}"\n'}
        with make_tree(files) as root:
            findings, read = run_scan(root)
            report = scan.render_report(findings, 1, read, 0, "off", 0)
        self.assertNotIn(token, report)
        self.assertNotIn(key, report)
        self.assertNotIn(email, report)
        self.assertNotIn("smithers", report.lower())
        self.assertIn("cfg.py:1", report)
        self.assertIn("[telegram-bot-token]", report)

    def test_end_to_end_stdout_never_contains_the_planted_value(self):
        token = fake_telegram_token()
        with make_tree({"deep/nested/cfg.py": f'T="{token}"\n'}) as root:
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                scan.main(["--root", root, "--no-git"])
        combined = out.getvalue() + err.getvalue()
        self.assertNotIn(token, combined)
        self.assertIn("deep/nested/cfg.py:1", combined)

    def test_personal_pattern_and_its_match_are_never_printed(self):
        import re
        secret_pattern = r"Jsmithers\s+Quibble"
        personal = [re.compile(secret_pattern, re.IGNORECASE)]
        with make_tree({"notes.md": "report by Jsmithers Quibble\n"}) as root:
            findings, read = run_scan(root, personal=personal)
            report = scan.render_report(findings, 1, read, 1, "env:PA_PII_TRIPWIRES", 0)
        self.assertIn("personal-term#1", report)
        self.assertNotIn(secret_pattern, report)
        self.assertNotIn("Jsmithers", report)
        self.assertNotIn("Quibble", report)

    def test_finding_object_cannot_hold_matched_text(self):
        # Structural guarantee: there is no field a future edit could stuff the
        # matched value into and have it printed by accident.
        self.assertEqual(set(scan.Finding.__slots__),
                         {"where", "path", "line", "pattern_class"})
        f = scan.Finding("content", "a.py", 3, "telegram-bot-token")
        with self.assertRaises(AttributeError):
            f.matched = "secret"  # type: ignore[attr-defined]


class TestSuppressionSentinels(unittest.TestCase):
    def test_ignore_block_and_ignore_line_suppress_content_matches(self):
        token = fake_telegram_token()
        content = (
            f"# {scan.IGNORE_START}\n"
            f'PATTERN_SAMPLE = "{token}"\n'
            f"# {scan.IGNORE_END}\n"
            f'INLINE = "{token}"  # {scan.IGNORE_LINE}\n'
            f'REAL = "{token}"\n'
        )
        with make_tree({"defs.py": content}) as root:
            findings, _ = run_scan(root)
        self.assertEqual([f.line for f in findings], [5])

    def test_paths_are_never_suppressible(self):
        # A path has no line to hang a sentinel on; suppression must not be
        # reachable for the path layer at all.
        bad = f"{fake_institution()}_export.csv"
        with make_tree({bad: f"# {scan.IGNORE_START}\nx\n"}) as root:
            findings, _ = run_scan(root)
        self.assertEqual([f.where for f in findings], ["path"])


class TestPersonalTermLoading(unittest.TestCase):
    def test_env_value_wins_over_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "tw.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("fromfile\n")
            patterns, source = scan.load_personal_terms("fromenv", path)
        self.assertEqual(source, "env:PA_PII_TRIPWIRES")
        self.assertEqual(len(patterns), 1)
        self.assertTrue(patterns[0].search("xxfromenvxx"))

    def test_file_used_when_env_absent_and_comments_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "tw.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("# a comment\n\nalpha\nbeta\n")
            patterns, source = scan.load_personal_terms(None, path)
        self.assertEqual(source, "file")
        self.assertEqual(len(patterns), 2)

    def test_malformed_regex_is_dropped_not_echoed(self):
        patterns, _ = scan.load_personal_terms("valid\n[unclosed", None)
        self.assertEqual(len(patterns), 1)

    def test_layer_off_when_no_source(self):
        patterns, source = scan.load_personal_terms(None, None)
        self.assertEqual((patterns, source), ([], "off"))

    def test_report_states_loudly_when_the_personal_layer_is_off(self):
        report = scan.render_report([], 5, 5, 0, "off", 0)
        self.assertIn("personal-terms OFF", report)
        self.assertIn("cannot catch person-specific identifiers", report)


class TestEnumeration(unittest.TestCase):
    def test_walk_skips_vcs_and_dependency_directories(self):
        files = {
            "src/a.py": "x\n",
            "node_modules/pkg/index.js": "x\n",
            ".git/config": "x\n",
            "dist/bundle.js": "x\n",
        }
        with make_tree(files) as root:
            paths = scan.walk_paths(root)
        self.assertEqual(paths, ["src/a.py"])

    def test_binary_and_oversized_files_are_not_read(self):
        with make_tree({"logo.png": "not really a png\n", "ok.txt": "hi\n"}) as root:
            self.assertIsNone(scan.read_text(root, "logo.png"))
            self.assertEqual(scan.read_text(root, "ok.txt"), "hi\n")
            with patch.object(scan.os.path, "getsize", return_value=scan.MAX_FILE_BYTES + 1):
                self.assertIsNone(scan.read_text(root, "ok.txt"))

    def test_unreadable_file_is_skipped_but_its_path_still_scanned(self):
        bad = f"data/{fake_institution()}.png"
        with make_tree({bad: "binary-ish\n"}) as root:
            findings, read = run_scan(root)
        self.assertEqual(read, 0)  # contents never read (skipped extension)
        self.assertEqual([f.where for f in findings], ["path"])


class TestSubprocessEncodingInvariant(unittest.TestCase):
    """Do-not-regress (2026-07-12 class): every subprocess call site must pass
    encoding="utf-8", errors="replace". Without it Windows decodes with cp1252
    and one emoji variation-selector byte raises inside the call — in the
    pre-push guard that emptied the scan input and vetted nothing, silently."""

    def test_every_subprocess_run_in_the_scanner_sets_utf8(self):
        with open(SCANNER_PATH, encoding="utf-8") as f:
            src = f.read()
        occurrences = src.count("subprocess.run(")
        self.assertGreaterEqual(occurrences, 1)
        for chunk in src.split("subprocess.run(")[1:]:
            window = chunk[:400]
            self.assertIn('encoding="utf-8"', window)
            self.assertIn('errors="replace"', window)

    def test_git_helper_passes_utf8(self):
        with patch.object(scan.subprocess, "run") as mock_run:
            scan._git(["git", "status"])
        _, kwargs = mock_run.call_args
        self.assertEqual(kwargs.get("encoding"), "utf-8")
        self.assertEqual(kwargs.get("errors"), "replace")

    def test_utf8_content_does_not_break_scanning(self):
        token = fake_telegram_token()
        content = f"# warn ⚠️ em — dash\nT = \"{token}\"\n"
        with make_tree({"u.py": content}) as root:
            findings, _ = run_scan(root)
        self.assertEqual([f.line for f in findings], [2])

    def test_git_helpers_return_empty_when_git_is_unavailable(self):
        with patch.object(scan.subprocess, "run", side_effect=OSError("no git")):
            self.assertEqual(scan.git_tracked_paths(".", None), [])
            self.assertEqual(scan.history_paths(".", None), [])


class TestClassInventory(unittest.TestCase):
    def test_list_classes_prints_names_only(self):
        out = io.StringIO()
        with redirect_stdout(out):
            rc = scan.main(["--list-classes"])
        self.assertEqual(rc, 0)
        names = out.getvalue().split()
        self.assertIn("telegram-bot-token", names)
        self.assertIn("financial-institution", names)
        self.assertIn("private-absolute-path", names)

    def test_scanner_does_not_flag_its_own_definitions(self):
        """The pattern definitions necessarily contain the shapes they hunt
        for; the ignore sentinels must keep the scanner itself clean."""
        root = os.path.dirname(os.path.dirname(os.path.dirname(SCANNER_PATH)))
        rel = os.path.relpath(SCANNER_PATH, root).replace(os.sep, "/")
        findings, _ = scan.scan_repo(root, [rel], [])
        self.assertEqual([f.format() for f in findings], [])


if __name__ == "__main__":
    unittest.main()
