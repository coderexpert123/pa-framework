import unittest
import sys
import os
import re

# Add parent directory to path to import generate_analysis_pdf
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import generate_analysis_pdf

class TestGenerateAnalysisPdf(unittest.TestCase):
    def test_strip_variation_selectors(self):
        # ☀️ has VS (U+FE0F), ☀ does not
        has_vs = "☀️"
        no_vs = "☀"
        self.assertEqual(generate_analysis_pdf.strip_variation_selectors(has_vs), no_vs)
        self.assertEqual(generate_analysis_pdf.strip_variation_selectors("Text with \uFE0F VS"), "Text with  VS")

    def test_parse_section_with_variation_selector(self):
        # icon has VS, content doesn't
        content = "☀ *Needs Attention (1)*\n• *Subject* — Sender\nBody"
        items = generate_analysis_pdf.parse_section(content, "Needs Attention", "☀️")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0], ("Subject", "Sender", "Body"))

    def test_parse_section_without_variation_selector(self):
        # both bare
        content = "☀ *Needs Attention (1)*\n• *Subject* — Sender\nBody"
        items = generate_analysis_pdf.parse_section(content, "Needs Attention", "☀")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0], ("Subject", "Sender", "Body"))

    def test_parse_section_mixed(self):
        # icon has VS, content has VS
        content = "☀️ *Needs Attention (1)*\n• *Subject* — Sender\nBody"
        items = generate_analysis_pdf.parse_section(content, "Needs Attention", "☀️")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0], ("Subject", "Sender", "Body"))

if __name__ == "__main__":
    unittest.main()
