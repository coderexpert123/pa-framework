"""
Tests for pa/scripts/redteam_injection.py prompt-injection redteam script.

Tests fixture parsing, per-class assertions, and the three defense layers.
"""

import subprocess
import sys
from pathlib import Path
import unittest


class TestRedteamInjectionScript(unittest.TestCase):
    """Test the redteam injection regression script."""

    def setUp(self):
        """Set up test paths."""
        self.repo_root = Path(__file__).parent.parent.parent.parent
        self.script_path = self.repo_root / "pa/scripts/redteam_injection.py"

    def test_script_exists(self):
        """Script file exists and is executable."""
        self.assertTrue(self.script_path.exists(), f"Script not found: {self.script_path}")

    def test_fixture_count(self):
        """Verify we have approximately 25 fixtures (as per spec)."""
        import re
        script_content = self.script_path.read_text(encoding="utf-8")

        # Count Fixture() definitions
        fixture_matches = re.findall(r'Fixture\(', script_content)
        self.assertGreaterEqual(len(fixture_matches), 20, "Should have at least 20 fixtures")
        self.assertLessEqual(len(fixture_matches), 30, "Should have at most 30 fixtures")

    def test_all_fixture_classes_present(self):
        """Verify all adversarial classes are represented in fixtures."""
        import re
        script_content = self.script_path.read_text(encoding="utf-8")

        required_classes = [
            "COMMAND_DIRECTIVE",
            "KB_EMBEDDED_INSTRUCTION",
            "ERROR_MESSAGE_DIRECTIVE",
            "PA_META_FORGERY",
            "RUN_SKILL_GIT_WORKFLOW",
            "CREDENTIAL_ECHO",
            "LEGITIMATE_PA_META",
        ]

        for class_name in required_classes:
            self.assertIn(class_name, script_content,
                         f"Required class {class_name} not found in fixtures")

    def test_credential_fixtures_present(self):
        """Verify credential-echo probe fixtures exist."""
        import re
        script_content = self.script_path.read_text(encoding="utf-8")

        # Check for sk-, Bearer, ghp_, AIza, xoxb patterns in fixtures
        credential_patterns = [
            r'sk-[A-Za-z0-9_-]',
            r'Bearer\s+[A-Za-z0-9]',
            r'ghp_[A-Za-z0-9]',
            r'AIza[A-Za-z0-9]',
            r'xoxb[A-Za-z0-9_-]',
        ]

        for pattern in credential_patterns:
            matches = re.findall(pattern, script_content)
            self.assertGreater(len(matches), 0,
                             f"Credential pattern {pattern} not found in fixtures")

    def test_protected_skill_fixtures_present(self):
        """Verify fixtures for git-workflow protected skills exist."""
        import re
        script_content = self.script_path.read_text(encoding="utf-8")

        # Check for attempts to run protected skills
        protected_skills = ["commit", "push", "push-public", "commit-and-push",
                           "investigate-flagged", "update-brain"]

        found_skills = []
        for skill in protected_skills:
            if f'"skillToRun": "{skill}"' in script_content:
                found_skills.append(skill)

        self.assertGreater(len(found_skills), 0,
                         "No protected skill fixtures found")
        self.assertGreaterEqual(len(found_skills), 3,
                                "Should test at least 3 different protected skills")

    def test_positive_control_fixtures_present(self):
        """Verify legitimate PA_META fixtures (positive controls) exist."""
        import re
        script_content = self.script_path.read_text(encoding="utf-8")

        # Check for LEGITIMATE_PA_META class
        self.assertIn("LEGITIMATE_PA_META", script_content,
                     "Positive control class not found")

        # Verify at least one non-protected skill is tested
        non_protected_examples = [
            "daily-mail-brief",
            "oracle",
            "fitness-sync",
        ]

        found_any = False
        for skill in non_protected_examples:
            if f'"skillToRun": "{skill}"' in script_content:
                found_any = True
                break

        self.assertTrue(found_any,
                       "No legitimate (non-protected) skill fixtures found as positive controls")

    def test_script_runs_successfully(self):
        """Script executes without crashing (exit code 0 or 1, not signal)."""
        result = subprocess.run(
            [sys.executable, str(self.script_path)],
            capture_output=True,
            timeout=30,
        )

        # Should exit cleanly (0 = all pass, 1 = some failed, not a signal)
        self.assertIn(result.returncode, [0, 1],
                     f"Script exited with unexpected code: {result.returncode}")
        self.assertNotEqual(result.returncode, -15,
                           "Script timed out or was killed")

    def test_script_output_format(self):
        """Script produces structured pass/fail table output."""
        result = subprocess.run(
            [sys.executable, str(self.script_path)],
            capture_output=True,
            timeout=30,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        output = (result.stdout or "") + (result.stderr or "")

        # Check for expected output markers
        self.assertIn("Prompt-Injection Redteam", output,
                     "Missing header in output")
        self.assertIn("Summary", output, "Missing summary section")
        self.assertIn("Total:", output, "Missing total count")
        self.assertIn("Passed:", output, "Missing passed count")
        self.assertIn("Failed:", output, "Missing failed count")

    def test_all_test_classes_covered(self):
        """Verify each test class has at least one fixture."""
        import re
        script_content = self.script_path.read_text(encoding="utf-8")

        test_classes = [
            ("COMMAND_DIRECTIVE", r'class_=TestClass\.COMMAND_DIRECTIVE'),
            ("KB_EMBEDDED_INSTRUCTION", r'class_=TestClass\.KB_EMBEDDED_INSTRUCTION'),
            ("ERROR_MESSAGE_DIRECTIVE", r'class_=TestClass\.ERROR_MESSAGE_DIRECTIVE'),
            ("PA_META_FORGERY", r'class_=TestClass\.PA_META_FORGERY'),
            ("RUN_SKILL_GIT_WORKFLOW", r'class_=TestClass\.RUN_SKILL_GIT_WORKFLOW'),
            ("CREDENTIAL_ECHO", r'class_=TestClass\.CREDENTIAL_ECHO'),
            ("LEGITIMATE_PA_META", r'class_=TestClass\.LEGITIMATE_PA_META'),
        ]

        for class_name, pattern in test_classes:
            matches = re.findall(pattern, script_content)
            self.assertGreater(len(matches), 0,
                             f"Test class {class_name} has no fixtures")

    def test_fixture_id_format(self):
        """Verify all fixtures have valid IDs (class prefix + number)."""
        import re
        script_content = self.script_path.read_text(encoding="utf-8")

        # Find all fixture IDs
        id_matches = re.findall(r'id="([^"]+)"', script_content)

        self.assertGreater(len(id_matches), 0, "No fixture IDs found")

        # Check ID format: class-prefix-number
        valid_prefixes = ["cmd-", "kb-", "err-", "meta-", "gitw-", "cred-", "legit-"]

        for fixture_id in id_matches:
            has_valid_prefix = any(fixture_id.startswith(p) for p in valid_prefixes)
            self.assertTrue(has_valid_prefix,
                          f"Fixture ID {fixture_id} has invalid prefix")

    def test_deterministic_layers_only(self):
        """Verify script tests only deterministic layers (no LLM calls)."""
        script_content = self.script_path.read_text(encoding="utf-8")

        # Check that the docstring mentions "deterministic"
        self.assertIn("deterministic", script_content.lower(),
                     "Script should document it tests deterministic layers only")

        # Should not contain LLM-related imports or calls
        llm_indicators = [
            "openai",
            "anthropic",
            "claude",
            "gemini",
            "llm",
            "chatgpt",
        ]

        script_lower = script_content.lower()
        for indicator in llm_indicators:
            # Allow in comments/docstrings, but not in actual code
            if indicator in script_lower:
                # Check if it's just in comments
                lines_with_indicator = [
                    line for line in script_content.split('\n')
                    if indicator in line.lower() and not line.strip().startswith('#')
                ]
                self.assertEqual(len(lines_with_indicator), 0,
                              f"Script should not contain {indicator} in code")


if __name__ == "__main__":
    unittest.main()
