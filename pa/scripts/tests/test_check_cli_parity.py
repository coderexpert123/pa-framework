"""Unit tests for pa/scripts/check_cli_parity.py"""
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import check_cli_parity as ccp


class TestCheckTarget(unittest.TestCase):
    def test_clean_target_returns_zero_and_report(self):
        with mock.patch.object(ccp.scp, "run", return_value=0) as mock_run:
            name, code, report, error = ccp.check_target("gemini")
        mock_run.assert_called_once()
        called_target = mock_run.call_args[0][0]
        self.assertEqual(called_target, "gemini")
        self.assertEqual(name, "gemini")
        self.assertEqual(code, 0)
        self.assertIsNone(error)

    def test_drift_target_returns_nonzero_and_captures_report(self):
        def fake_run(target_name, apply, out=sys.stdout):
            out.write(f"{target_name}: drift detected\n")
            return 1

        with mock.patch.object(ccp.scp, "run", side_effect=fake_run):
            name, code, report, error = ccp.check_target("agy")
        self.assertEqual(name, "agy")
        self.assertEqual(code, 1)
        self.assertIn("drift detected", report)
        self.assertIsNone(error)

    def test_skills_target_routes_to_run_skill_mirror_not_run(self):
        with mock.patch.object(ccp.scp, "run_skill_mirror", return_value=0) as mock_mirror, \
             mock.patch.object(ccp.scp, "run") as mock_run:
            name, code, report, error = ccp.check_target("skills")
        mock_mirror.assert_called_once()
        mock_run.assert_not_called()
        self.assertEqual(name, "skills")
        self.assertEqual(code, 0)

    def test_exception_is_captured_not_raised(self):
        with mock.patch.object(ccp.scp, "run", side_effect=FileNotFoundError("no such file")):
            name, code, report, error = ccp.check_target("gemini")
        self.assertEqual(code, 1)
        self.assertIsInstance(error, FileNotFoundError)


class TestRun(unittest.TestCase):
    def test_all_clean_exit_zero(self):
        out = io.StringIO()
        with mock.patch.object(ccp.scp, "run", return_value=0), \
             mock.patch.object(ccp.scp, "run_skill_mirror", return_value=0):
            code = ccp.run(out=out)
        self.assertEqual(code, 0)
        text = out.getvalue()
        self.assertIn("All targets clean", text)
        self.assertIn("[gemini] clean", text)
        self.assertIn("[agy] clean", text)
        self.assertIn("[skills] clean", text)

    def test_one_drifted_target_yields_nonzero_and_names_it(self):
        out = io.StringIO()

        def fake_run(target_name, apply, out=sys.stdout):
            if target_name == "agy":
                out.write("agy: drift\n")
                return 1
            return 0

        with mock.patch.object(ccp.scp, "run", side_effect=fake_run), \
             mock.patch.object(ccp.scp, "run_skill_mirror", return_value=0):
            code = ccp.run(out=out)
        self.assertEqual(code, 1)
        text = out.getvalue()
        self.assertIn("[agy] DRIFT", text)
        self.assertIn("[gemini] clean", text)
        self.assertIn("[skills] clean", text)
        self.assertIn("Drift detected in: agy", text)

    def test_multiple_drifted_targets_all_named(self):
        out = io.StringIO()
        with mock.patch.object(ccp.scp, "run", return_value=1), \
             mock.patch.object(ccp.scp, "run_skill_mirror", return_value=1):
            code = ccp.run(out=out)
        self.assertEqual(code, 1)
        text = out.getvalue()
        self.assertIn("Drift detected in: gemini, agy, skills", text)

    def test_error_in_one_target_reported_and_treated_as_drift(self):
        out = io.StringIO()

        def fake_run(target_name, apply, out=sys.stdout):
            if target_name == "gemini":
                raise ValueError("boom")
            return 0

        with mock.patch.object(ccp.scp, "run", side_effect=fake_run), \
             mock.patch.object(ccp.scp, "run_skill_mirror", return_value=0):
            code = ccp.run(out=out)
        self.assertEqual(code, 1)
        text = out.getvalue()
        self.assertIn("[gemini] DRIFT", text)
        self.assertIn("ERROR: boom", text)

    def test_run_checks_all_three_targets_by_default(self):
        seen = []

        def fake_run(target_name, apply, out=sys.stdout):
            seen.append(target_name)
            return 0

        with mock.patch.object(ccp.scp, "run", side_effect=fake_run), \
             mock.patch.object(ccp.scp, "run_skill_mirror", return_value=0) as mock_mirror:
            ccp.run(out=io.StringIO())
        self.assertEqual(sorted(seen), ["agy", "gemini"])
        mock_mirror.assert_called_once()


class TestMain(unittest.TestCase):
    def test_main_returns_runs_exit_code(self):
        with mock.patch.object(ccp, "run", return_value=0) as mock_run:
            code = ccp.main()
        mock_run.assert_called_once()
        self.assertEqual(code, 0)

    def test_main_propagates_nonzero_exit_code(self):
        with mock.patch.object(ccp, "run", return_value=1):
            code = ccp.main()
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
